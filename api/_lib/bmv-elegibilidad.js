// ═══════════════════════════════════════════════════════════════════
// api/_lib/bmv-elegibilidad.js — ¿el backtest puede concluir algo?
//
// Lógica PURA, cero I/O. Simula los rebalanceos mensuales y cuenta, en cada
// fecha, cuántos nombres sobreviven a las dos puertas del universo: tener
// financieros disponibles con el rezago de 65 días, y operar lo suficiente.
//
// Esto NO es el backtest. No mira un solo retorno. Su trabajo es contestar,
// ANTES de correr nada, la pregunta que decide si el resultado va a poder
// leerse: ¿hay universo? Porque con un universo elegible chico el "quintil
// superior" no es un quintil —lo dice §4.1 del doc— y el veredicto se etiqueta
// «no probó un quintil» pase lo que pase con el t y el Sharpe.
//
// Que se pueda calcular sin tocar un retorno es lo que permite RECALIBRAR el
// umbral de liquidez sin contaminarse: no hay resultados que mirar todavía.
// ═══════════════════════════════════════════════════════════════════

// Los tres números congelados en docs/bmv-rotation.md §3.1 y §3.3. Se importan
// desde aquí para que el reporte y la Fase B no puedan divergir.
const LAG_DIAS = 65;                  // el rezago que elimina el look-ahead

// EN RECALIBRACIÓN (17-sep-2026). El tripwire del §3.1 se disparó con este
// valor: excluyó 69.2% del universo en promedio, muy por encima del tercio
// acordado. 5 millones era intuición de mercado estadounidense, no de BMV, y el
// propósito del filtro es excluir lo NO OPERABLE, no partir el universo.
//
// El valor nuevo se elige con la tabla de `?job=elegibilidad&umbrales=…`, que
// no mira un solo retorno — es lo que hace legítimo recalibrar ahora.
const UMBRAL_IMPORTE = 5_000_000;     // pesos, mediana de 3 meses
const PISO_CANASTA = 8;
const TECHO_CANASTA = 15;
const FRACCION_QUINTIL = 0.20;
const TRIMESTRES_TTM = 4;

// Si el filtro de liquidez se lleva más de esto en promedio, el umbral está mal
// calibrado para BMV y se baja ANTES de la Fase B (§3.1, tripwire).
const TRIPWIRE_EXCLUSION = 1 / 3;

/**
 * Series ICS que NO tienen precios disponibles en `/v2/historicos`.
 *
 * Verificado (17-sep-2026): `VISTAC` da HTTP 400 también con una ventana corta
 * de 2026-06-01, así que **no era el rango** — el identificador sencillamente
 * no es válido para ese endpoint. `GAVB` presenta el mismo patrón.
 *
 * Se excluyen del universo en vez de dejarlas fallando: una serie sin precios
 * no puede rankearse ni operarse, así que su lugar correcto es fuera, contado y
 * con nombre. Son 2 de 185 — 1.1% del universo, sin efecto material.
 *
 * NO se reintentan: un 400 no se arregla martillando, y cada reintento gasta un
 * crédito en el mismo error.
 */
const SERIES_SIN_PRECIOS = new Set(['VISTAC', 'GAVB']);

/** Suma días naturales a 'AAAA-MM-DD'. */
function sumaDias(fecha, dias) {
  const t = Date.parse(`${fecha}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + dias * 86400000).toISOString().slice(0, 10);
}

/**
 * El tamaño de canasta y QUÉ regla lo decidió.
 *
 * `clamp(0.20 × E, 8, 15)`, con una salvedad que no es cosmética: el piso no
 * puede sacar nombres de donde no hay. Con menos de 8 elegibles la canasta es
 * el universo completo y el rebalanceo se marca `insuficiente` — se reporta
 * aparte en vez de fingir que el piso se cumplió.
 */
function tamanoCanasta(elegibles) {
  const quintil = FRACCION_QUINTIL * elegibles;
  if (elegibles < PISO_CANASTA) return { canasta: elegibles, regimen: 'insuficiente' };
  if (quintil < PISO_CANASTA) return { canasta: PISO_CANASTA, regimen: 'piso' };
  if (quintil > TECHO_CANASTA) return { canasta: TECHO_CANASTA, regimen: 'techo' };
  return { canasta: Math.round(quintil), regimen: 'quintil' };
}

/** Mediana de una lista de números. Devuelve null si está vacía. */
function mediana(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * El reporte de elegibilidad, fecha por fecha.
 *
 * Entradas (todas ya agregadas por SQL, para no traerse 569,589 filas):
 *   · `fechas`            — las fechas de rebalanceo, en orden.
 *   · `cierresPorEmisora` — Map emisora → array de fecha_cierre CON EPS.
 *   · `medianas`          — Map `${fecha}|${emisora_serie}` → mediana 3m del
 *                           importe operado, o null si no operó.
 *   · `series`            — [{emisora_serie, emisora}] de las ICS.
 *
 * Reporta DOS universos a propósito. El encargo pedía "financieros disponibles
 * (cierre + 65 días ≤ fecha)", que es tener AL MENOS UNO. Pero el value es
 * EPS TTM, y el TTM necesita CUATRO trimestres: contar con uno solo
 * sobreestimaría el universo que el backtest puede usar de verdad. Van los dos,
 * y el que manda para la canasta es el de TTM.
 */
function analizarElegibilidad({
  fechas, cierresPorEmisora, medianas, series,
  umbralImporte = UMBRAL_IMPORTE, lagDias = LAG_DIAS,
  excluidas = SERIES_SIN_PRECIOS,
} = {}) {
  // Las series sin precios se quitan del universo ANTES de contar: dejarlas
  // dentro inflaría el denominador del tripwire con nombres que nunca podrían
  // pasar el filtro, y haría ver el umbral peor de lo que es.
  const universoSeries = series.filter((s) => !excluidas.has(s.emisora_serie));
  const porFecha = [];

  for (const fecha of fechas) {
    // Un cierre está disponible si `cierre + lag <= fecha`. Equivale a pedir
    // `cierre <= fecha - lag`, que es una comparación de cadenas ISO.
    const corte = sumaDias(fecha, -lagDias);

    let conAlguno = 0;
    let conTtm = 0;
    let conPrecio = 0;
    let universo = 0;
    let elegibles = 0;
    let sinImporte = 0;

    for (const s of universoSeries) {
      const cierres = cierresPorEmisora.get(s.emisora) || [];
      const disponibles = cierres.filter((c) => c <= corte).length;
      if (disponibles >= 1) conAlguno += 1;
      if (disponibles >= TRIMESTRES_TTM) conTtm += 1;

      const clave = `${fecha}|${s.emisora_serie}`;
      const tieneMediana = medianas.has(clave);
      if (tieneMediana) conPrecio += 1;

      // El universo del backtest: TTM completo Y precio operado en la ventana.
      if (disponibles < TRIMESTRES_TTM || !tieneMediana) continue;
      universo += 1;

      const med = medianas.get(clave);
      if (med === null || med === undefined) { sinImporte += 1; continue; }
      if (med >= umbralImporte) elegibles += 1;
    }

    const { canasta, regimen } = tamanoCanasta(elegibles);
    porFecha.push({
      fecha,
      con_algun_financiero: conAlguno,
      con_ttm: conTtm,
      con_precio: conPrecio,
      universo,
      elegibles,
      excluidos_liquidez: universo - elegibles,
      pct_excluido: universo ? (universo - elegibles) / universo : null,
      sin_importe: sinImporte,
      canasta,
      regimen,
    });
  }

  const conUniverso = porFecha.filter((r) => r.universo > 0);
  const n = porFecha.length;
  const cuenta = (r) => porFecha.filter((x) => x.regimen === r).length;

  const pctExcluido = conUniverso.length
    ? conUniverso.reduce((a, r) => a + r.pct_excluido, 0) / conUniverso.length
    : null;

  return {
    rebalanceos: n,
    por_fecha: porFecha,
    resumen: {
      mediana_universo: mediana(porFecha.map((r) => r.universo)),
      mediana_elegibles: mediana(porFecha.map((r) => r.elegibles)),
      minimo_elegibles: porFecha.length ? Math.min(...porFecha.map((r) => r.elegibles)) : null,
      maximo_elegibles: porFecha.length ? Math.max(...porFecha.map((r) => r.elegibles)) : null,
      mediana_canasta: mediana(porFecha.map((r) => r.canasta)),
      regimenes: {
        quintil: cuenta('quintil'),
        piso: cuenta('piso'),
        techo: cuenta('techo'),
        insuficiente: cuenta('insuficiente'),
      },
      pct_fechas_piso: n ? (cuenta('piso') + cuenta('insuficiente')) / n : null,
      pct_excluido_liquidez: pctExcluido,
    },
    // Las tres puertas del §3.4, evaluadas con los números de arriba. Ninguna
    // mira un retorno: se pueden leer antes de correr la Fase B sin
    // contaminar nada.
    veredicto: veredictoPrevio(porFecha, pctExcluido),
    series_excluidas: {
      motivo: 'sin precios en /v2/historicos (HTTP 400 también con ventana corta)',
      lista: series.filter((s) => excluidas.has(s.emisora_serie)).map((s) => s.emisora_serie),
    },
    criterios: {
      lag_dias: lagDias,
      umbral_importe: umbralImporte,
      piso: PISO_CANASTA,
      techo: TECHO_CANASTA,
      fraccion_quintil: FRACCION_QUINTIL,
      trimestres_ttm: TRIMESTRES_TTM,
      min_rebalanceos: 30,
      min_universo_mediano: 16,
      tripwire_exclusion: TRIPWIRE_EXCLUSION,
    },
    // Lo que cada puerta EXIGE en número de elegibles, dado el universo
    // observado. Sin esto, "falla el tripwire" no dice qué tan lejos está ni
    // cuál de las dos puertas manda.
    exigencias: exigenciasDeLasPuertas(porFecha),
  };
}

/**
 * Las tres puertas que se pueden juzgar SIN correr el backtest, con la
 * respuesta en los términos ya congelados — no en una escala nueva inventada
 * para la ocasión.
 */
function veredictoPrevio(porFecha, pctExcluido) {
  const n = porFecha.length;
  const medUniverso = mediana(porFecha.map((r) => r.elegibles));
  const pisos = porFecha.filter((r) => r.regimen === 'piso' || r.regimen === 'insuficiente').length;
  const pctPiso = n ? pisos / n : 0;

  const puertas = [];
  puertas.push({
    puerta: 'rebalanceos ≥ 30',
    valor: n,
    pasa: n >= 30,
    consecuencia: n >= 30 ? null : 'INCONCLUSO por muestra insuficiente',
  });
  puertas.push({
    puerta: 'universo elegible mediano ≥ 16',
    valor: medUniverso,
    pasa: medUniverso !== null && medUniverso >= 16,
    consecuencia: medUniverso !== null && medUniverso >= 16
      ? null : 'INCONCLUSO por universo insuficiente — la Fase B NO se corre',
  });
  puertas.push({
    puerta: 'el piso manda en ≤ 50% de las fechas',
    valor: pctPiso,
    pasa: pctPiso <= 0.5,
    consecuencia: pctPiso <= 0.5 ? null
      : 'el veredicto se etiqueta «no probó un quintil», pase lo que pase con |t| y Sharpe',
  });
  puertas.push({
    puerta: `el filtro de liquidez excluye ≤ ${Math.round(TRIPWIRE_EXCLUSION * 100)}% en promedio`,
    valor: pctExcluido,
    pasa: pctExcluido === null || pctExcluido <= TRIPWIRE_EXCLUSION,
    consecuencia: pctExcluido === null || pctExcluido <= TRIPWIRE_EXCLUSION ? null
      : 'TRIPWIRE: el umbral está mal calibrado para BMV; se baja ANTES de correr la Fase B',
  });

  const bloqueantes = puertas.filter((p) => !p.pasa && /INCONCLUSO|TRIPWIRE/.test(p.consecuencia || ''));
  return {
    puede_correrse_fase_b: bloqueantes.length === 0,
    puertas,
    bloqueantes: bloqueantes.map((p) => p.consecuencia),
  };
}

/**
 * Traduce las puertas a un número de elegibles, que es lo accionable.
 *
 * Con el universo observado, el tripwire (≤33% excluido) exige **muchos más**
 * elegibles que la puerta del piso (≥40): son 2/3 del universo contra 40 a
 * secas. O sea que la puerta que manda es el tripwire, y conviene saberlo antes
 * de elegir umbral — si no, uno cree que basta con rozar los 40.
 */
function exigenciasDeLasPuertas(porFecha) {
  const universoMediano = mediana(porFecha.map((r) => r.universo));
  if (universoMediano === null) return null;
  const paraTripwire = Math.ceil(universoMediano * (1 - TRIPWIRE_EXCLUSION));
  const paraQuintil = Math.ceil(PISO_CANASTA / FRACCION_QUINTIL);   // 8 / 0.20 = 40
  return {
    universo_mediano: universoMediano,
    elegibles_para_que_mande_el_quintil: paraQuintil,
    elegibles_para_pasar_el_tripwire: paraTripwire,
    puerta_que_manda: paraTripwire > paraQuintil ? 'tripwire' : 'piso',
    // Con tantos elegibles el quintil se pasaría del techo, y el régimen
    // dominante sería `techo` y no `quintil`. No es un problema — pero es un
    // dato distinto del que uno espera al leer "el quintil por fin manda".
    regimen_resultante_en_el_tripwire: tamanoCanasta(paraTripwire).regimen,
  };
}

export {
  LAG_DIAS, UMBRAL_IMPORTE, PISO_CANASTA, TECHO_CANASTA, FRACCION_QUINTIL,
  TRIMESTRES_TTM, TRIPWIRE_EXCLUSION, SERIES_SIN_PRECIOS,
  analizarElegibilidad, exigenciasDeLasPuertas, mediana, sumaDias, tamanoCanasta,
  veredictoPrevio,
};
