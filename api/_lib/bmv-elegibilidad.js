// ═══════════════════════════════════════════════════════════════════
// api/_lib/bmv-elegibilidad.js — ¿el backtest puede concluir algo?
//
// Lógica PURA, cero I/O. Simula los rebalanceos mensuales y cuenta, en cada
// fecha, cuántos nombres sobreviven a las dos puertas del universo: tener
// financieros disponibles con el rezago de 65 días, y operar lo suficiente.
//
// Esto NO es el backtest. No mira un solo retorno. Su trabajo es contestar,
// ANTES de correr nada, dos preguntas: ¿hay universo suficiente para que el
// resultado signifique algo, y qué regla acabó decidiendo el tamaño de la
// canasta? Porque si el tamaño lo fijó el piso (8) o el techo (15) en más de la
// mitad de las fechas, lo que se probó no es un quintil superior sino un top-N
// fijo —lo dice §4.1— y el veredicto se etiqueta así pase lo que pase con el t
// y el Sharpe.
//
// Que se pueda calcular sin tocar un retorno es lo que permitió corregir los
// criterios del universo —el umbral de liquidez y el tripwire retirado— sin
// contaminarse: no había resultados que mirar todavía.
// ═══════════════════════════════════════════════════════════════════

// Los tres números congelados en docs/bmv-rotation.md §3.1 y §3.3. Se importan
// desde aquí para que el reporte y la Fase B no puedan divergir.
const LAG_DIAS = 65;                  // el rezago que elimina el look-ahead

// CONGELADO el 17-sep-2026, antes de ver un solo retorno.
//
// El umbral se fija por su PROPÓSITO, no por cuántos nombres deja pasar: que
// una canasta de 8-15 nombres con capital personal entre y salga sin mover el
// precio. A 1 MM de importe mediano diario, una posición de ~$80,000 pesos es
// menos del 10% del volumen del día, que es el estándar razonable de
// participación. Ese cálculo no depende de cuántas emisoras sobrevivan.
//
// El valor anterior (5 MM) era intuición de mercado estadounidense trasplantada
// a BMV sin recalcular el tamaño de posición que la motiva. Se corrigió antes
// de la Fase B y sin mirar retornos — lo que hace legítimo el cambio.
const UMBRAL_IMPORTE = 1_000_000;     // pesos, mediana de 3 meses
const PISO_CANASTA = 8;
const TECHO_CANASTA = 15;
const FRACCION_QUINTIL = 0.20;
const TRIMESTRES_TTM = 4;

// RETIRADO el 17-sep-2026: el tripwire del tercio (§3.1) era insatisfacible.
//
// Exigía que el filtro de liquidez excluyera ≤ 1/3 del universo, o sea ≥ 2/3 de
// elegibles. Con el universo mediano observado (128) eso son ≥ 86 elegibles; y
// con 86 elegibles el quintil da 17.2, que topa contra el techo de 15. Es
// decir: cualquier umbral que pasara el tripwire garantizaba régimen `techo`, y
// el régimen `quintil` sólo existe entre 40 y 75 elegibles. Las dos reglas
// pedían cosas incompatibles, y una regla insatisfacible no es una regla.
//
// El error de fondo: el tripwire suponía que el universo de partida era todo
// operable, de modo que una exclusión alta sólo podía significar umbral mal
// calibrado. En BMV el universo de partida NO es todo operable, así que una
// exclusión alta puede ser la verdad sobre el mercado. Calibrar por «cuánto
// excluye» habría sido ajustar el filtro a la métrica en vez de a la
// operabilidad.
//
// NO se sustituye por otro porcentaje. El % excluido se sigue reportando como
// diagnóstico —es informativo— pero ya no es una puerta.

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
  // Las series sin precios se quitan del universo ANTES de contar: una serie
  // que no puede rankearse ni operarse no es universo, y dejarla dentro
  // ensuciaría todos los conteos con nombres que nunca podrían entrar.
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
      pct_fechas_techo: n ? cuenta('techo') / n : null,
      pct_fechas_quintil: n ? cuenta('quintil') / n : null,
      // Diagnóstico, ya no puerta: el tripwire del tercio se retiró el
      // 17-sep-2026 por insatisfacible (ver arriba). El número sigue siendo
      // informativo —dice qué tan selectivo es el filtro— pero no decide nada.
      pct_excluido_liquidez: pctExcluido,
      regimen: etiquetaDeRegimen(porFecha),
    },
    // Las tres puertas del §3.4, evaluadas con los números de arriba. Ninguna
    // mira un retorno: se pueden leer antes de correr la Fase B sin
    // contaminar nada.
    veredicto: veredictoPrevio(porFecha),
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
      tripwire_exclusion: null,  // retirado el 17-sep-2026 por insatisfacible
    },
    // En qué rango de elegibles el quintil manda de verdad. Sin esto, "mandó
    // el piso" no dice qué tan lejos quedó ni si el techo estaba al otro lado.
    exigencias: exigenciasDeLasPuertas(porFecha),
  };
}

/**
 * Qué régimen mandó y en qué proporción de las fechas.
 *
 * La puerta del §4.1 no bloquea nada: etiqueta. Un backtest donde el tamaño de
 * canasta lo decidió el piso (8) o el techo (15) en más de la mitad de las
 * fechas sigue siendo un experimento válido —midió algo real— pero NO midió un
 * quintil superior, y el veredicto tiene que decirlo con todas sus letras en
 * vez de dejar que el lector suponga.
 *
 * Endurecida el 17-sep-2026: antes sólo miraba el piso. El techo produce
 * exactamente el mismo problema por el otro lado, y salió a la luz al calcular
 * qué exigía el tripwire (≥86 elegibles ⇒ canasta 15 ⇒ techo).
 */
function etiquetaDeRegimen(porFecha) {
  const n = porFecha.length;
  if (!n) return null;
  const cuenta = (r) => porFecha.filter((x) => x.regimen === r).length;
  // `insuficiente` (< 8 elegibles) cuenta como piso: tampoco probó un quintil,
  // y encima ni siquiera alcanzó el piso. Se reporta aparte, pero del lado del
  // piso, no como un cuarto régimen neutral.
  const pctPiso = (cuenta('piso') + cuenta('insuficiente')) / n;
  const pctTecho = cuenta('techo') / n;
  const pctQuintil = cuenta('quintil') / n;

  let dominante = null;
  if (pctPiso > 0.5) dominante = 'piso';
  else if (pctTecho > 0.5) dominante = 'techo';

  // El caso mixto: ni el piso ni el techo pasan de la mitad por separado, pero
  // entre los dos dejan al quintil en minoría. La regla congelada habla de cada
  // uno por separado, así que esto NO dispara la etiqueta — se reporta como
  // observación para que nadie lea "el quintil mandó" donde mandó 40% del
  // tiempo.
  const mixto = !dominante && pctQuintil <= 0.5;

  return {
    pct_piso: pctPiso,
    pct_techo: pctTecho,
    pct_quintil: pctQuintil,
    dominante,
    etiqueta: dominante
      ? `no probó un quintil, probó top-N fijo (${dominante === 'piso' ? `piso de ${PISO_CANASTA}` : `techo de ${TECHO_CANASTA}`})`
      : null,
    observacion: mixto
      ? `régimen mixto: el quintil mandó en ${(100 * pctQuintil).toFixed(1)}% de las fechas, sin que el piso ni el techo pasaran de la mitad por separado`
      : null,
  };
}

/**
 * Las puertas que se pueden juzgar SIN correr el backtest, con la respuesta en
 * los términos ya congelados — no en una escala nueva inventada para la
 * ocasión.
 *
 * Son tres desde el 17-sep-2026: se retiró el tripwire del tercio por
 * insatisfacible (ver el bloque de constantes). Dos bloquean la Fase B; la
 * tercera sólo etiqueta el veredicto.
 */
function veredictoPrevio(porFecha) {
  const n = porFecha.length;
  const medElegibles = mediana(porFecha.map((r) => r.elegibles));
  const reg = etiquetaDeRegimen(porFecha) || { etiqueta: null, pct_piso: 0, pct_techo: 0 };

  const puertas = [];
  puertas.push({
    puerta: 'rebalanceos ≥ 30',
    valor: n,
    pasa: n >= 30,
    consecuencia: n >= 30 ? null : 'INCONCLUSO por muestra insuficiente',
  });
  puertas.push({
    puerta: 'universo elegible mediano ≥ 16',
    valor: medElegibles,
    pasa: medElegibles !== null && medElegibles >= 16,
    consecuencia: medElegibles !== null && medElegibles >= 16
      ? null : 'INCONCLUSO por universo insuficiente — la Fase B NO se corre',
  });
  puertas.push({
    puerta: 'el piso o el techo mandan en ≤ 50% de las fechas',
    valor: Math.max(reg.pct_piso, reg.pct_techo),
    pasa: !reg.dominante,
    // No bloquea: el experimento se corre igual y se reporta como lo que es.
    consecuencia: reg.etiqueta
      ? `ETIQUETA: «${reg.etiqueta}», pase lo que pase con |t| y Sharpe`
      : null,
  });

  const bloqueantes = puertas.filter((p) => !p.pasa && /INCONCLUSO/.test(p.consecuencia || ''));
  return {
    puede_correrse_fase_b: bloqueantes.length === 0,
    etiqueta_veredicto: reg.etiqueta,
    puertas,
    bloqueantes: bloqueantes.map((p) => p.consecuencia),
  };
}

/**
 * En qué rango de elegibles manda el quintil, dado el universo observado.
 *
 * El quintil sólo decide el tamaño cuando `0.20 × E` cae entre el piso y el
 * techo, o sea entre **40 y 75** elegibles. Por debajo manda el piso, por
 * encima el techo. Es una ventana estrecha, y saberlo antes evita leer
 * «mandó el piso» como si bastara con un empujoncito al umbral: por el otro
 * lado está el techo esperando.
 *
 * Esta función ya no evalúa el tripwire — se retiró el 17-sep-2026. Fue
 * justamente esta aritmética la que mostró que era insatisfacible: pasarlo
 * exigía ≥ 2/3 del universo mediano (86 elegibles), y 86 está muy por encima
 * de 75, o sea del otro lado del techo.
 */
function exigenciasDeLasPuertas(porFecha) {
  const universoMediano = mediana(porFecha.map((r) => r.universo));
  if (universoMediano === null) return null;
  const minQuintil = Math.ceil(PISO_CANASTA / FRACCION_QUINTIL);    // 8  / 0.20 = 40
  const maxQuintil = Math.floor(TECHO_CANASTA / FRACCION_QUINTIL);  // 15 / 0.20 = 75
  const medElegibles = mediana(porFecha.map((r) => r.elegibles));
  return {
    universo_mediano: universoMediano,
    elegibles_mediano: medElegibles,
    ventana_del_quintil: { min: minQuintil, max: maxQuintil },
    regimen_en_la_mediana: medElegibles === null ? null : tamanoCanasta(medElegibles).regimen,
  };
}

export {
  LAG_DIAS, UMBRAL_IMPORTE, PISO_CANASTA, TECHO_CANASTA, FRACCION_QUINTIL,
  TRIMESTRES_TTM, SERIES_SIN_PRECIOS,
  analizarElegibilidad, etiquetaDeRegimen, exigenciasDeLasPuertas, mediana,
  sumaDias, tamanoCanasta, veredictoPrevio,
};
