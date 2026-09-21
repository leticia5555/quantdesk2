// ═══════════════════════════════════════════════════════════════════
// api/_lib/mercado-r0.js — R0: cimientos del mapa. Lógica PURA.
//
// R0 existe para abrir las dos compuertas que la Fase 0 dejó rojas y que sí
// dependen de datos nuestros (docs/mercado-r0.md):
//
//   G1 — universo US con sector y cap precomputados.
//   G2 — capitalización MX correcta, o sea: la trampa de las unidades.
//
// G9 (Form 4) NO se toca acá: sigue siendo el pipeline de R5.
//
// Todo lo de este archivo es puro —sin fetch, sin DB, sin Date.now()— por la
// misma razón que el medidor de la Fase 0: el sandbox donde se escribe no
// llega a Neon ni a DataBursatil, y un medidor sin probar es cómo la Fase 0
// del Congreso perdió dos corridas.
// ═══════════════════════════════════════════════════════════════════

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const up = (s) => String(s || '').trim().toUpperCase();

// ═══════════════════════════════════════════════════════════════════
// R0(b) — la trampa de las unidades, resuelta con un divisor
// ═══════════════════════════════════════════════════════════════════

/**
 * La fórmula del encargo:
 *
 *   cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
 *
 * `acciones_circulacion` (del XBRL) cuenta ACCIONES. El precio de la BMV es
 * el de un TÍTULO COTIZADO, que en varias emisoras es una UNIDAD VINCULADA
 * (un paquete de N acciones). Dividir entre N pone las dos mitades en la
 * misma unidad, que era todo el problema de la Fase 0 §3.2.
 *
 * `acciones_por_unidad = 1` es el caso normal (una acción = un título) y NO
 * es un caso especial: la fórmula es la misma.
 *
 * Devuelve `null` con motivo, nunca un cero ni un estimado.
 */
export function capConUnidades({ clave, acciones_circulacion, precio, serie_liquida, acciones_por_unidad = 1 }) {
  const acciones = num(acciones_circulacion);
  const p = num(precio);
  const apu = num(acciones_por_unidad);
  const base = { clave, serie_liquida: serie_liquida || null, acciones_por_unidad: apu };

  if (acciones == null || acciones <= 0) return { ...base, cap: null, motivo: 'sin acciones_circulacion' };
  if (p == null || p <= 0) return { ...base, cap: null, motivo: `sin precio de la serie líquida (${serie_liquida || '—'})` };
  if (apu == null || apu <= 0) return { ...base, cap: null, motivo: 'acciones_por_unidad inválido' };

  return { ...base, cap: (acciones * p) / apu, precio: p, acciones, motivo: null };
}

/**
 * EL VERIFICADOR DEL DIVISOR — y la parte de R0(b) que no depende de que yo
 * haya leído bien un prospecto.
 *
 * Este contenedor no llega a la BMV ni a un prospecto, así que los cuatro
 * divisores del encargo (FEMSA UBD=5, KOF UBL=8, CEMEX CPO=3, TLEVISA
 * CPO=117) entran como **declarados por el operador**, no como verificados
 * por mí. Decir otra cosa sería inventar una fuente.
 *
 * Pero un divisor sí se puede MEDIR, y contra el dato mismo: si el divisor es
 * correcto, `acciones × precio / apu` tiene que cuadrar con la cap pública. Y
 * si NO cuadra, el cociente entre lo calculado y la referencia da el divisor
 * IMPLÍCITO, que es la respuesta empírica.
 *
 * Tres desenlaces, y los tres se reportan distinto:
 *   · `cuadra`           — el divisor declarado produce la cap correcta.
 *   · `divisor_corregido`— el implícito es otro ENTERO limpio: el declarado
 *                          está mal y el dato dice cuál es. Accionable.
 *   · `no_es_de_unidad`  — el implícito no es un entero limpio, así que el
 *                          error NO viene del empaquetado. Puede ser acciones
 *                          en circulación mal extraídas, una serie sin
 *                          cotizar, o recompras. Es el caso que hay que mirar
 *                          a mano, y el que un "redondeá al entero más
 *                          cercano" escondería.
 *
 * `tolerancia_pct` es el 5% del encargo. `max_divisor` acota el redondeo: un
 * implícito de 117 es real (TLEVISA CPO), uno de 4,812 es un error de unidades
 * (miles vs unidades) disfrazado de divisor.
 */
// Un divisor es un entero ESTRUCTURAL: o la unidad empaqueta 5 acciones o no.
// La tolerancia para declararlo "entero limpio" NO puede ser la misma que la
// del error de capitalización — esa es de 5% porque un precio y un conteo de
// acciones de fuentes distintas se mueven. Un divisor no se mueve.
//
// Y no es una sutileza: FEMSA salió con implícito 4.200, que contra el 5% da
// |4.2−4|/4 = 0.050000000000000044 — se salvó por un ULP de coma flotante, no
// por diseño. Con 1% no hay suerte que valga: 4.2 no es 4, y el problema de
// FEMSA está en el conteo de acciones, no en el empaquetado.
export const MAX_DESVIO_ENTERO_PCT = 1;

export function verificaDivisor({ capCalculada, capReferencia, acciones_por_unidad = 1, tolerancia_pct = 5, max_divisor = 500, max_desvio_entero_pct = MAX_DESVIO_ENTERO_PCT }) {
  const c = num(capCalculada), r = num(capReferencia), apu = num(acciones_por_unidad);
  if (c == null || r == null || r === 0) {
    return { estado: 'sin_referencia', error_pct: null, divisor_declarado: apu, divisor_implicito: null };
  }
  const errorPct = ((c - r) / Math.abs(r)) * 100;
  if (Math.abs(errorPct) <= tolerancia_pct) {
    return { estado: 'cuadra', error_pct: errorPct, divisor_declarado: apu, divisor_implicito: apu };
  }

  // El implícito: por cuánto MÁS habría que dividir para llegar a la
  // referencia. Se compone con el declarado, porque `capCalculada` ya lo
  // aplicó — olvidarse de eso daba divisores al cuadrado.
  const factor = c / r;
  const implicito = (apu || 1) * factor;
  const redondeado = Math.round(implicito);
  const limpio = redondeado >= 1 && redondeado <= max_divisor
    && Math.abs(implicito - redondeado) / redondeado <= max_desvio_entero_pct / 100;

  if (limpio && redondeado !== apu) {
    return {
      estado: 'divisor_corregido', error_pct: errorPct,
      divisor_declarado: apu, divisor_implicito: redondeado,
      exacto: implicito,
      motivo: `el divisor declarado (${apu}) no cuadra; el dato implica ${redondeado}`,
    };
  }
  return {
    estado: 'no_es_de_unidad', error_pct: errorPct,
    divisor_declarado: apu, divisor_implicito: null, exacto: implicito,
    motivo: `error ${errorPct.toFixed(1)}% y el divisor implícito (${implicito.toFixed(3)}) no es un entero limpio: el problema NO es el empaquetado`,
  };
}

/**
 * EL NÚMERO QUE EXPLICA A FEMSA.
 *
 * Cuando el implícito NO es un entero, la pregunta "¿cuál es el divisor?" es
 * la equivocada. La buena es: **¿cuántas acciones cree la referencia que hay?**
 *
 *   unidades que implica la referencia = capReferencia / precio
 *   acciones que implica               = unidades × acciones_por_unidad
 *
 * Con FEMSA eso da 20,161,874,250 contra las 16,935,974,370 del XBRL: **+19%
 * de diferencia de CONTEO**, no de empaquetado. El divisor 5 puede estar
 * perfecto y la discrepancia venir de que Yahoo cuenta las acciones de otra
 * forma (otra fecha de corte, series que nosotros no contamos, su propio
 * ajuste). Reformularlo así convierte "no cuadra" en algo accionable.
 */
export function conteoImplicito({ capReferencia, precio, acciones_por_unidad = 1, acciones_circulacion }) {
  const cr = num(capReferencia), p = num(precio), apu = num(acciones_por_unidad) || 1;
  const acc = num(acciones_circulacion);
  if (cr == null || p == null || p <= 0) return null;
  const unidades = cr / p;
  const accionesImp = unidades * apu;
  return {
    unidades_implicitas: unidades,
    acciones_implicitas: accionesImp,
    acciones_xbrl: acc,
    delta_pct: acc != null && acc > 0 ? ((accionesImp - acc) / acc) * 100 : null,
  };
}

/** Estado de render de una emisora: lo que el mapa pinta, y con qué etiqueta. */
export function estadoEmisora(verificacion, { cap, fuente_cap = 'calc' } = {}) {
  if (!verificacion || verificacion.estado === 'sin_referencia') {
    return { estado: 'gris_punteado', etiqueta: null, motivo: 'sin capitalización de referencia para verificar' };
  }
  if (verificacion.estado === 'cuadra' && num(cap) != null) {
    return { estado: 'verificada', etiqueta: `cap: ${fuente_cap}`, motivo: null };
  }
  return {
    estado: 'gris_punteado', etiqueta: null,
    motivo: verificacion.motivo || `error ${Number(verificacion.error_pct).toFixed(1)}%`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(c) — ¿de dónde sale la capitalización de referencia?
// ═══════════════════════════════════════════════════════════════════

// Llaves que, en un JSON de estados financieros, pueden estar hablando de
// acciones o de capitalización. Se buscan NORMALIZADAS (sin mayúsculas ni
// separadores) porque cada fuente las escribe distinto.
//
// Esto NO adivina cuál es la buena: las encuentra TODAS y las reporta con su
// ruta y su valor, para que la decisión la tome quien mira los números. Es el
// mismo criterio del `?job=diagnostico&que=eps` de bmv-rotation, que saca
// todas las llaves de acciones y marca cuál reproduce el EPS guardado.
export const PISTAS_ACCIONES = [
  'numberofshares', 'numberofsharesoutstanding', 'sharesoutstanding',
  'numerodeaccionesencirculacion', 'accionesencirculacion', 'acciones',
  'issuedcapital', 'ordinarysharesissued', 'weightedaverageshares',
  'weightedaveragenumberofordinarysharesoutstanding',
];
export const PISTAS_CAP = [
  'marketcap', 'marketcapitalization', 'capitalizacion', 'capitalizacionbursatil',
  'valordemercado', 'valorcapitalizacion',
];

const normLlave = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Recorre un JSON crudo y devuelve TODA llave que parezca acciones o cap, con
 * su ruta y su valor numérico.
 *
 * Por qué importa para R0(c): el censo de Fase 1b ya midió que las acciones en
 * circulación **no están en `ifrs-full`** de DataBursatil (docs/bmv-rotation.md
 * §4.4: "sin acciones no hay capitalización"). Eso hace que la instrucción
 * "referencia de cap vía DataBursatil" necesite una verificación antes de
 * construir sobre ella — y la verificación puede correrse **sobre el crudo ya
 * guardado en `bmv_financieros`, sin gastar un solo crédito**.
 *
 * Si encuentra llaves: la referencia existe y R0(c) procede.
 * Si no encuentra ninguna en ninguna emisora: está medido que no está, y ahí
 * hay que elegir otra referencia — decisión del operador, no mía.
 */
export function buscarPistas(raw, { pistas = [...PISTAS_ACCIONES, ...PISTAS_CAP], maxProfundidad = 8 } = {}) {
  const objetivo = new Set(pistas.map(normLlave));
  const hallazgos = [];
  const visto = new Set();

  const caminar = (nodo, ruta) => {
    if (!nodo || typeof nodo !== 'object' || visto.has(nodo) || ruta.length > maxProfundidad) return;
    visto.add(nodo);
    for (const [k, v] of Object.entries(nodo)) {
      const aqui = [...ruta, k];
      const nk = normLlave(k);
      if (objetivo.has(nk)) {
        hallazgos.push({
          ruta: aqui.join('.'), llave: k, llave_normalizada: nk,
          valor: num(v && typeof v === 'object' ? (v.valor ?? v.value ?? v.monto) : v),
          // Un hallazgo con valor null es igual de informativo: dice que la
          // llave EXISTE y viene vacía, que no es lo mismo que no existir.
          crudo: typeof v === 'object' ? undefined : v,
        });
      }
      if (v && typeof v === 'object') caminar(v, aqui);
    }
  };
  caminar(raw, []);
  return {
    hallazgos,
    con_valor: hallazgos.filter((h) => h.valor != null).length,
    llaves_distintas: [...new Set(hallazgos.map((h) => h.llave))].sort(),
  };
}

/**
 * La referencia MANUAL: lee el JSON de referencias y devuelve la cap vigente
 * de una emisora, o null con motivo.
 *
 * Por qué existe: la corrida del 2026-09-20 cerró las dos fuentes
 * automáticas a la vez. Yahoo `quoteSummary` devolvió **401 Invalid Crumb**
 * para las cinco emisoras Y para el precio objetivo de AAPL — o sea que no es
 * el símbolo `.MX`, es el endpoint entero. Y el censo de Fase 1b ya había
 * medido que DataBursatil no trae acciones en circulación.
 *
 * Una referencia capturada a mano y FECHADA es más auditable que una API que
 * contesta 401: se sabe quién la vio y cuándo. Lo que no puede pasar es que se
 * use sin decir que es manual — de ahí que `fuente` y `capturada_en` sean
 * obligatorias y que una fila sin ellas se rechace.
 *
 * `vigencia_dias` acota cuánto vale: una cap de referencia envejece con el
 * precio, y arrastrar un verde viejo es peor que volver a gris punteado.
 */
/**
 * TODAS las referencias de una emisora, no la primera.
 *
 * FEMSA necesita dos de fuentes distintas y las dos tienen que verse: si una
 * cuadra y la otra no, eso NO es "verificada" — es una discrepancia entre
 * fuentes, y esconderla quedándose con la que conviene sería exactamente lo
 * que este proyecto no hace.
 */
export function referenciasManuales(registro, clave, ahora) {
  const filas = (registro && registro.referencias) || [];
  const mias = filas.filter((f) => up(f && f.clave) === up(clave));
  const vigentes = [], descartadas = [];
  for (const fila of mias) {
    const r = referenciaManual({ ...registro, referencias: [fila] }, clave, ahora);
    if (r.cap != null) vigentes.push(r);
    else descartadas.push({ fuente: fila.fuente || null, capturada_en: fila.capturada_en || null, motivo: r.motivo });
  }
  return { vigentes, descartadas, total: mias.length };
}

export function referenciaManual(registro, clave, ahora) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const filas = (registro && registro.referencias) || [];
  const vigenciaDias = num(registro && registro.vigencia_dias) ?? 14;
  const fila = filas.find((f) => up(f && f.clave) === up(clave));
  if (!fila) return { cap: null, motivo: 'sin referencia manual para esta emisora' };

  const cap = num(fila.market_cap);
  if (cap == null || cap <= 0) return { cap: null, motivo: 'la referencia no trae market_cap numérico' };
  // Las tres cosas que separan una referencia de un número suelto.
  if (!fila.fuente) return { cap: null, motivo: 'la referencia no dice de dónde salió (`fuente`)' };
  if (!fila.capturada_en) return { cap: null, motivo: 'la referencia no dice cuándo se capturó (`capturada_en`)' };

  const t = Date.parse(fila.capturada_en);
  if (!Number.isFinite(t)) return { cap: null, motivo: `\`capturada_en\` no es una fecha: ${fila.capturada_en}` };
  const dias = (now.getTime() - t) / 86400000;
  if (dias < 0) return { cap: null, motivo: 'la referencia está fechada en el futuro' };
  if (dias > vigenciaDias) {
    return {
      cap: null, dias: Math.round(dias),
      motivo: `referencia vencida: ${Math.round(dias)} días (vigencia ${vigenciaDias})`,
      vencida: true,
    };
  }
  return {
    cap, motivo: null, dias: Math.round(dias),
    fuente: fila.fuente, capturada_en: fila.capturada_en,
    capturada_por: fila.capturada_por || null,
    // Lo que viaja al render: la etiqueta dice que el número que se PINTA es
    // calc, y que lo que vino de afuera fue solo el verificador.
    etiqueta_verificacion: `verificada vs ${fila.fuente} (${fila.capturada_en})`,
  };
}

/**
 * Parsea `?job=...&manual=CLAVE:CAP,CLAVE:CAP` para una verificación puntual
 * sin redeploy. `fuente` y `capturada_en` se pasan aparte y valen para todas
 * las de esa corrida — porque si vinieron en la misma sesión, vinieron del
 * mismo lado y el mismo día.
 */
export function parseManualParam(raw, { fuente, capturada_en } = {}) {
  const txt = String(raw || '').trim();
  if (!txt) return { referencias: [], invalidas: [] };
  const referencias = [], invalidas = [];
  for (const parte of txt.split(',')) {
    const t = parte.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i <= 0) { invalidas.push({ entrada: t, motivo: 'falta el ":" entre clave y capitalización' }); continue; }
    const clave = up(t.slice(0, i));
    const cap = num(t.slice(i + 1).replace(/[\s,_]/g, ''));
    if (cap == null || cap <= 0) { invalidas.push({ entrada: t, motivo: 'la capitalización no es un número positivo' }); continue; }
    referencias.push({
      clave, market_cap: cap,
      fuente: fuente || 'manual (sin fuente declarada)',
      capturada_en: capturada_en || null,
    });
  }
  return { referencias, invalidas };
}

// ═══════════════════════════════════════════════════════════════════
// R0(b ter) — VERIFICAR EL MÉTODO, no cada emisora
//
// El problema, con los números de la corrida: con 4 referencias manuales
// cuadraron 3 (WALMEX 1.7%, AMX 1.0%, GMEXICO 0.3%) y G2 pedía 15
// verificadas. Juntar 15 referencias a mano para desbloquear un mapa de 30
// cuadros no compra precisión: compra papeleo, y deja 26 emisoras grises por
// falta de trámite, no por falta de dato.
//
// LA DISTINCIÓN QUE LO ORDENA: validar un INSTRUMENTO no es validar cada
// MEDICIÓN. La fórmula
//
//     cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
//
// no tiene ningún parámetro libre cuando la emisora tiene UNA serie y apu=1:
// no hay serie que elegir ni divisor que acertar. Si el instrumento cuadra
// tres veces contra referencias independientes, lo que queda por verificar en
// esas emisoras es ARITMÉTICA, y la aritmética no falla distinto según la
// empresa.
//
// Donde SÍ hay parámetros libres —varias series, o un divisor— la validación
// del método no dice nada: puede fallar por la serie equivocada sin que la
// fórmula tenga nada de malo. Esas nueve siguen necesitando referencia
// individual, y sin ella van gris punteadas.
//
// EL RIESGO, DICHO: las tres muestras son emisoras grandes y líquidas. Una
// chica puede fallar por un motivo que estas tres no ejercitan (precio
// rancio, acciones de un trimestre viejo). Por eso el umbral del método es
// MÁS ESTRICTO que el individual —2% contra 5%—: lo que se extrapola tiene
// que medirse mejor que lo que se mide una sola vez. Y por eso el reporte
// lista una por una las que heredan sin control propio.
// ═══════════════════════════════════════════════════════════════════

/**
 * SERIE SIN MERCADO — una serie que no opera no es un precio, es un rótulo.
 *
 * Una cotización sin volumen no es una opinión del mercado sobre esa serie:
 * es el último número que quedó pegado, o un valor de referencia. Meterla en
 * la dispersión hace que una serie muerta mande a gris a una emisora cuyo
 * capital, en los hechos, cotiza entero en otra serie.
 *
 * Regla: **volumen acumulado 0 en la ventana → la serie no cuenta**, ni para
 * la dispersión ni para el cálculo. Y se REPORTA: "no cuenta" no es lo mismo
 * que "no existe".
 *
 * ── EL MODO DE FALLA QUE ESTA FUNCIÓN EXISTE PARA CERRAR ─────────────
 * Si la ventana se ancla en `now()` y la cosecha de precios está atrasada,
 * TODAS las series dan volumen cero, toda la dispersión desaparece y FEMSA,
 * AMX y PINFRA se ponen verdes **solas**. Un verde por falta de datos es
 * peor que un gris: el gris se ve, el verde falso no.
 *
 * Dos anclas lo impiden:
 *
 *   1. La ventana se ancla en `max(fecha)` DE LA TABLA, no en el reloj. Así
 *      se mide "los últimos 30 días de datos que tenemos", y el atraso de la
 *      cosecha se reporta aparte en vez de disfrazarse de series muertas.
 *   2. **La serie líquida nunca se puede declarar sin mercado.** Si ELLA no
 *      operó en la ventana, el problema son los datos, no la serie: se
 *      devuelve `datos_rancios` y NO se excluye nada. Fail closed.
 *
 * Y el volumen `null` (columna vacía) cuenta como CON mercado: no saber no
 * es saber que no. Mantener la serie en la dispersión empuja hacia el gris,
 * que es el lado seguro.
 */
export function clasificaSeries({ series = [], serie_liquida } = {}) {
  const vivas = series
    .map((x) => ({
      serie: String((x && x.emisora_serie) || ''),
      precio: num(x && x.cierre),
      // null ≠ 0: sin dato de volumen la serie se conserva (fail closed).
      volumen_ventana: x && x.volumen_ventana === undefined ? null : num(x.volumen_ventana),
      filas_ventana: num(x && x.filas_ventana),
    }))
    .filter((x) => x.serie && x.precio != null && x.precio > 0);

  const esLiquida = (x) => x.serie === serie_liquida;
  const sinMercado = (x) => x.volumen_ventana != null && x.volumen_ventana <= 0;

  const liquida = vivas.find(esLiquida) || null;
  // Ancla 2: si la líquida no operó, esto es atraso de cosecha, no una serie
  // muerta. No se excluye NADA.
  if (liquida && sinMercado(liquida)) {
    return {
      con_mercado: vivas,
      sin_mercado: [],
      datos_rancios: true,
      motivo_rancio: `la serie líquida (${serie_liquida}) no registra volumen en la ventana: eso es atraso de la cosecha de precios, no una serie sin mercado — no se excluye ninguna`,
    };
  }

  const conMercado = vivas.filter((x) => esLiquida(x) || !sinMercado(x));
  const muertas = vivas.filter((x) => !esLiquida(x) && sinMercado(x));

  return {
    con_mercado: conMercado,
    sin_mercado: muertas.map((x) => ({
      serie: x.serie, precio: x.precio, filas_ventana: x.filas_ventana,
      motivo: x.filas_ventana ? 'cotiza pero con volumen 0 en la ventana' : 'sin operaciones en la ventana',
    })),
    datos_rancios: false,
    motivo_rancio: null,
  };
}

/**
 * LA PRUEBA DE FEMSA — y por qué el cálculo de una emisora multi-serie puede
 * estar mal aunque el divisor sea correcto.
 *
 * `cap = acciones_TOTALES × precio_de_UNA_serie / apu` le aplica el precio de
 * la serie líquida a **todas** las acciones. Eso es correcto solo si las demás
 * series valen lo mismo, o si no pesan.
 *
 * FEMSA lo rompe: UB cotiza a 165 y UBD a 207.66 — las dos son unidades de 5
 * acciones, o sea **comparables**, y difieren 21%. Aplicarle el precio de UBD
 * a todo el capital infla la cap. La correcta sería
 *
 *     cap = Σ (acciones_de_la_serie × precio_de_la_serie) / apu
 *
 * y el XBRL **no desglosa acciones por serie**: reporta un total. Sin ese
 * desglose la cap de FEMSA no se puede calcular, y ningún ajuste la arregla.
 * Las tres cifras de la corrida lo confirman: Yahoo 837B, Google 628B,
 * nuestro cálculo 703B — tres números distintos, ninguno cuadra, y la
 * dispersión entre fuentes públicas es justo lo que se espera cuando la
 * estructura de capital confunde a todo el mundo.
 *
 * ── QUÉ CUENTA COMO "PRECIOS DISTINTOS" ─────────────────────────────
 * Dos trampas que hay que esquivar para no marcar a todas:
 *
 * 1. **Cotizaciones de referencia idénticas.** CEMEXA = CEMEXB = 3.8 exacto,
 *    KOFA = KOFD = 16.270452 a seis decimales, TLEVISAB = D = L = 0.205. Eso
 *    no es un mercado: es un valor puesto a mano. Un grupo de precios
 *    idénticos cuenta como UN solo precio.
 * 2. **Unidad contra acción suelta.** CEMEXCPO a 17.56 y CEMEXA a 3.8 no
 *    están en desacuerdo: una es un paquete de tres. Solo se comparan series
 *    del MISMO tipo de instrumento, y el proxy —sin saber cuál es unidad y
 *    cuál no— es la razón de precios: dentro de [0.5, 2] son comparables;
 *    fuera, casi seguro son instrumentos distintos y no se comparan.
 *
 * Devuelve `requiere_desglose: true` cuando quedan ≥2 precios comparables que
 * difieren más que la tolerancia. Esas emisoras van gris punteadas hasta
 * tener el desglose por serie, venga de donde venga.
 */
export function dispersionPrecios({ series = [], serie_liquida, tolerancia_pct = 5, banda = [0.5, 2] } = {}) {
  const vivas = series
    .map((x) => ({ serie: String((x && x.emisora_serie) || ''), precio: num(x && x.cierre) }))
    .filter((x) => x.serie && x.precio != null && x.precio > 0);
  if (vivas.length <= 1) {
    return { requiere_desglose: false, motivo: null, comparables: vivas.length, grupos_identicos: [] };
  }

  const liquida = vivas.find((x) => x.serie === serie_liquida) || vivas[0];

  // Trampa 1: colapsar los grupos de precio IDÉNTICO a un representante.
  const porPrecio = new Map();
  for (const v of vivas) {
    const k = String(v.precio);
    if (!porPrecio.has(k)) porPrecio.set(k, []);
    porPrecio.get(k).push(v.serie);
  }
  const gruposIdenticos = [...porPrecio.entries()]
    .filter(([, ss]) => ss.length > 1)
    .map(([precio, ss]) => ({ precio: Number(precio), series: ss }));
  const representantes = [...porPrecio.entries()].map(([k, ss]) => ({ precio: Number(k), serie: ss[0], n: ss.length }));

  // Trampa 2: solo las que están en la misma banda que la líquida.
  const comparables = representantes.filter((r) => {
    const razon = r.precio / liquida.precio;
    return razon >= banda[0] && razon <= banda[1];
  });

  if (comparables.length <= 1) {
    return {
      requiere_desglose: false, comparables: comparables.length,
      grupos_identicos: gruposIdenticos,
      motivo: null,
      nota: representantes.length > 1
        ? 'las otras series no son comparables con la líquida (razón fuera de [0.5, 2]): son otro instrumento, no otro precio'
        : null,
    };
  }

  const precios = comparables.map((c) => c.precio);
  const max = Math.max(...precios), min = Math.min(...precios);
  const spreadPct = ((max - min) / min) * 100;
  const material = spreadPct > tolerancia_pct;

  return {
    requiere_desglose: material,
    comparables: comparables.length,
    series_comparables: comparables.map((c) => ({ serie: c.serie, precio: c.precio })),
    grupos_identicos: gruposIdenticos,
    spread_pct: spreadPct,
    motivo: material
      ? `series con precio distinto, sin desglose: ${comparables.map((c) => `${c.serie} ${c.precio}`).join(' vs ')} (${spreadPct.toFixed(1)}% de diferencia). El XBRL da un total de acciones, no un desglose por serie, así que aplicarle el precio de una a todas infla o desinfla la cap`
      : null,
  };
}

export const METODO = {
  min_muestras: 3,
  // Muestras LIMPIAS (una serie, divisor 1) que tienen que cuadrar. El método
  // se aplica a emisoras limpias, así que tiene que estar respaldado por
  // emisoras limpias — extrapolar desde casos que no se parecen al destino no
  // es validar.
  min_muestras_limpias: 2,
  max_error_pct: 2,   // más estricto que el 5% individual, a propósito
};

/**
 * ¿Esta emisora puede heredar la validación del método?
 *
 * Solo si la fórmula no tiene nada que elegir: UNA serie de precio y divisor
 * 1. Con varias series hay que acertar cuál; con divisor > 1 hay que acertar
 * cuánto. El método no valida ninguna de las dos cosas.
 */
export function elegibleMetodo({ n_series, acciones_por_unidad } = {}) {
  return num(n_series) === 1 && (num(acciones_por_unidad) ?? 1) === 1;
}

/**
 * Valida el instrumento con las emisoras que SÍ tienen referencia individual.
 *
 * `muestras` = [{ clave, error_pct, n_series, acciones_por_unidad }].
 *
 * Una muestra que NO cuadra no se ignora: si el instrumento falla en una
 * emisora que tiene referencia, extrapolarlo a veinte que no la tienen sería
 * elegir los datos que convienen. Con una sola que falle, el método queda
 * marcado como NO uniforme y el reporte la nombra.
 */
export function validaMetodo(muestras = [], {
  min = METODO.min_muestras, maxPct = METODO.max_error_pct,
  minLimpias = METODO.min_muestras_limpias,
} = {}) {
  const conError = muestras.filter((m) => m && num(m.error_pct) != null);
  const cuadran = conError.filter((m) => Math.abs(num(m.error_pct)) <= maxPct);
  const noCuadran = conError.filter((m) => Math.abs(num(m.error_pct)) > maxPct);
  const limpias = cuadran.filter((m) => elegibleMetodo(m));

  // UNA FALLA NO ES IGUAL QUE OTRA, y confundirlas hacía imposible validar
  // nada. Si falla una emisora LIMPIA —sin serie que elegir ni divisor que
  // acertar— eso es evidencia contra la ARITMÉTICA y tumba el método. Si
  // falla una con parámetros libres, lo que está mal son SUS parámetros (la
  // serie, el divisor, el desglose), y no dice nada de la aritmética.
  //
  // Sin esta distinción, TLEVISA (5.6%, divisor 117) y FEMSA (sin desglose)
  // habrían tumbado el método para las 20 emisoras de una sola serie, que no
  // tienen nada que ver con el problema de esas dos.
  const fallanLimpias = noCuadran.filter((m) => elegibleMetodo(m));
  const fallanConParametros = noCuadran.filter((m) => !elegibleMetodo(m));

  const razones = [];
  if (cuadran.length < min) razones.push(`${cuadran.length} muestras cuadran a ≤${maxPct}% (piso ${min})`);
  if (limpias.length < minLimpias) {
    // El método se extrapola a emisoras limpias: hacen falta muestras limpias
    // que lo respalden, no solo muestras.
    razones.push(`solo ${limpias.length} de las que cuadran son limpias (una serie, divisor 1; piso ${minLimpias}): extrapolar desde casos que no se parecen al destino no es validar`);
  }
  if (fallanLimpias.length) {
    razones.push(`${fallanLimpias.length} emisoras LIMPIAS con referencia NO cuadran (${fallanLimpias.map((m) => `${m.clave} ${num(m.error_pct).toFixed(1)}%`).join(', ')}): la aritmética falla, no los parámetros`);
  }

  return {
    muestras_con_referencia: conError.length,
    cuadran: cuadran.length,
    no_cuadran: noCuadran.length,
    claves_que_cuadran: cuadran.map((m) => m.clave),
    claves_que_no: noCuadran.map((m) => m.clave),
    // Cuántas de las que cuadran son del MISMO tipo al que se extrapola.
    // Tres muestras que cuadran son tres muestras; si ninguna es limpia, el
    // método se extrapola desde casos que no se parecen a su destino.
    limpias_entre_las_que_cuadran: limpias.length,
    fallan_limpias: fallanLimpias.map((m) => m.clave),
    fallan_con_parametros_libres: fallanConParametros.map((m) => ({ clave: m.clave, error_pct: num(m.error_pct) })),
    peor_error_pct: cuadran.length ? Math.max(...cuadran.map((m) => Math.abs(num(m.error_pct)))) : null,
    umbral_pct: maxPct, min_muestras: min,
    valido: razones.length === 0,
    razones,
  };
}

/**
 * Verifica una emisora contra TODAS sus referencias y devuelve el consenso.
 *
 * Con dos fuentes distintas hay tres desenlaces y los tres importan:
 *   · las dos cuadran  → verificada, y el acuerdo entre fuentes lo refuerza;
 *   · las dos fallan   → el problema es nuestro;
 *   · una sí y una no  → DISCREPANCIA ENTRE FUENTES. No es "verificada": es
 *                        que dos fuentes públicas no coinciden, y el reporte
 *                        lo dice en vez de quedarse con la cómoda.
 */
export function verificaConReferencias({
  capCalculada, referencias = [], acciones_por_unidad = 1,
  precio, acciones_circulacion, tolerancia_pct = 5,
}) {
  if (!referencias.length) {
    return { estado: 'sin_referencia', por_referencia: [], motivo: 'sin referencia individual vigente' };
  }
  const porRef = referencias.map((ref) => ({
    fuente: ref.fuente, capturada_en: ref.capturada_en, cap: ref.cap,
    ...verificaDivisor({ capCalculada, capReferencia: ref.cap, acciones_por_unidad, tolerancia_pct }),
    conteo: conteoImplicito({ capReferencia: ref.cap, precio, acciones_por_unidad, acciones_circulacion }),
  }));

  const cuadran = porRef.filter((r) => r.estado === 'cuadra');
  if (cuadran.length === porRef.length) {
    return { estado: 'verificada', por_referencia: porRef, motivo: null, referencias_usadas: porRef.length };
  }
  if (cuadran.length === 0) {
    return {
      estado: 'no_cuadra', por_referencia: porRef, referencias_usadas: porRef.length,
      motivo: porRef.length === 1 ? porRef[0].motivo : `ninguna de las ${porRef.length} referencias cuadra`,
    };
  }
  return {
    estado: 'discrepancia_entre_fuentes', por_referencia: porRef, referencias_usadas: porRef.length,
    motivo: `${cuadran.length} de ${porRef.length} referencias cuadran: las fuentes no coinciden entre sí, así que el problema puede no ser nuestro`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(a bis) — el RITMO, y el presupuesto de una corrida
//
// LA CORRIDA DEL 2026-09-21 LO DEJÓ CLARO: 553 `profile2` + 508 `metric` en
// 150 s, con 433 y 448 errores. No eran datos faltantes: era el techo de
// Finnhub free (60 req/min) devolviendo 429.
//
// El error era aritmético y estaba escrito en un comentario que decía lo
// contrario: 8 en vuelo con 1.1 s entre tandas son **436 req/min**, no 55.
// "Concurrencia con pausa entre tandas" no es un limitador — es una ráfaga
// con intervalos. Un limitador espacia CADA arranque.
// ═══════════════════════════════════════════════════════════════════

/**
 * El espaciador, como función PURA de estado → estado.
 *
 * Se modela así, y no como un `await sleep` escondido, para poder probar el
 * ritmo sin esperar minutos de reloj: se le pasa el instante y devuelve
 * cuánto hay que esperar y el estado siguiente. El envoltorio asíncrono vive
 * en el endpoint y no tiene lógica que probar.
 *
 * `proxima` es el instante en que se puede ARRANCAR la próxima llamada. Se
 * reserva la ranura al pedirla, no al terminar: así una llamada lenta no
 * corre las de atrás, y una rápida tampoco adelanta el cupo.
 */
export function proximaRanura(estado, ahoraMs, intervaloMs) {
  const prev = (estado && Number.isFinite(estado.proxima)) ? estado.proxima : 0;
  const cuando = Math.max(ahoraMs, prev);
  return {
    espera: Math.max(0, cuando - ahoraMs),
    estado: { proxima: cuando + intervaloMs },
  };
}

/** req/min → ms entre arranques. 55/min = 1091 ms. */
export function intervaloDe(porMinuto) {
  const n = num(porMinuto);
  if (n == null || n <= 0) return 60000;
  return Math.ceil(60000 / n);
}

/**
 * Un 429 significa que el techo real está por debajo del que creíamos —
 * casi siempre porque OTRO proceso nuestro también está pegándole a Finnhub
 * (el Arena tiene sus propios crons). La respuesta no es reintentar en el
 * acto: es correr la ranura y dejar que el símbolo caiga en la próxima
 * corrida, que es justo lo que el diseño reanudable permite.
 */
export function penalizarPor429(estado, ahoraMs, castigoMs = 5000) {
  const prev = (estado && Number.isFinite(estado.proxima)) ? estado.proxima : 0;
  return { proxima: Math.max(ahoraMs, prev) + castigoMs };
}

/**
 * ¿Cuánto entra en ESTA corrida, y cuántas faltan?
 *
 * `maxDuration` de Vercel es 300 s. El presupuesto se deja por debajo para
 * que quepan la escritura en Neon y la respuesta: una corrida que muere por
 * timeout pierde TODO lo que juntó, porque el upsert va al final.
 *
 * Devuelve también `corridas_estimadas`, que es el número que decide si el
 * cron diario alcanza o hace falta uno más frecuente. Con 1061 pendientes a
 * 55/min y 270 s de presupuesto, son 5 corridas — o sea que un cron diario
 * tardaría cinco días en sembrar la tabla.
 */
export function planCorrida({ pendientes, presupuesto_ms = 270000, por_minuto = 55 }) {
  const n = Math.max(0, Math.floor(num(pendientes) ?? 0));
  const intervalo = intervaloDe(por_minuto);
  const caben = Math.max(0, Math.floor(presupuesto_ms / intervalo));
  const enEsta = Math.min(n, caben);
  return {
    pendientes: n,
    caben_por_corrida: caben,
    en_esta_corrida: enEsta,
    restantes_despues: n - enEsta,
    corridas_estimadas: caben > 0 ? Math.ceil(n / caben) : null,
    intervalo_ms: intervalo,
    por_minuto,
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(a) — la fila del universo US
// ═══════════════════════════════════════════════════════════════════

/**
 * Normaliza lo que va a `mercado_universo_us`. Un símbolo entra a la tabla
 * aunque le falte algo: la fila dice QUÉ le falta, y el render decide. Lo que
 * NO se hace es dejarlo fuera en silencio — un símbolo ausente y uno sin cap
 * se ven igual en un `select count(*)` y son problemas distintos.
 */
export function filaUniversoUs({ symbol, nombre, industria, sector_etf, market_cap, cap_fuente, ahora }) {
  const sym = up(symbol);
  const cap = num(market_cap);
  const faltan = [];
  if (!sector_etf) faltan.push('sector');
  if (cap == null || cap <= 0) faltan.push('cap');
  if (!nombre) faltan.push('nombre');
  return {
    symbol: sym,
    nombre: nombre || null,
    industria: industria || null,
    sector_etf: sector_etf || null,
    market_cap: cap != null && cap > 0 ? cap : null,
    cap_fuente: cap != null && cap > 0 ? (cap_fuente || null) : null,
    actualizado: (ahora instanceof Date ? ahora : new Date(ahora)).toISOString(),
    completa: faltan.length === 0,
    faltan,
  };
}

/**
 * El recorte del mapa: top N por capitalización + el cuadro "+N más = X%".
 *
 * El "+N más" no es decoración. Sin él, un mapa de 300 nombres se lee como si
 * fuera el mercado entero. Y el X% se calcula sobre la suma de caps de los que
 * quedaron fuera — **nunca estimado**. Los que no tienen cap no pueden entrar
 * en esa suma, así que se cuentan aparte: decir "+200 más = 12%" cuando 40 de
 * esos 200 no tienen cap sería afirmar un porcentaje que no se midió.
 */
export function recorteMapa(filas, n = 300) {
  const conCap = filas.filter((f) => num(f.market_cap) != null && f.market_cap > 0);
  const sinCap = filas.length - conCap.length;
  const ordenadas = conCap.slice().sort((a, b) => b.market_cap - a.market_cap);
  const dentro = ordenadas.slice(0, n);
  const fuera = ordenadas.slice(n);
  const capTotal = conCap.reduce((a, f) => a + f.market_cap, 0);
  const capFuera = fuera.reduce((a, f) => a + f.market_cap, 0);
  return {
    dentro,
    resto: {
      n: fuera.length,
      cap: capFuera,
      pct: capTotal > 0 ? (capFuera / capTotal) * 100 : null,
      // La honestidad del porcentaje: sobre cuántos se pudo medir.
      sin_cap_excluidos: sinCap,
      nota: sinCap
        ? `${sinCap} nombres quedan fuera del porcentaje porque no tienen capitalización medida`
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(e) — el parser de fechas del feed, revisado
// ═══════════════════════════════════════════════════════════════════

// Zonas alfabéticas que `Date.parse` NO resuelve, con su offset en minutos.
//
// MEDIDO, no supuesto: en Node 22, `Date.parse` SÍ resuelve EST, EDT, CST,
// CDT, MST, MDT, PST, PDT, GMT, UT y Z — el parser heredado de V8 los conoce.
// Lo que NO resuelve son las europeas y las asiáticas (CET, CEST, BST, JST,
// IST…), que devuelven NaN. La tabla cubre eso y nada más: agregar una
// entrada para EST sería código muerto que disimula que ya funcionaba.
export const ZONAS_EXTRA = {
  CET: 60, CEST: 120, WET: 0, WEST: 60, EET: 120, EEST: 180,
  BST: 60, IST: 330, JST: 540, KST: 540, HKT: 480, SGT: 480,
  AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
  // BRT/BRST: Brasil. ART: Argentina. CLT/CLST: Chile. Nos importan porque
  // Valor (BR) y La República (CO) están en el registro de noticias.
  BRT: -180, BRST: -120, ART: -180, CLT: -240, CLST: -180, COT: -300,
};

/**
 * Fecha de un item de feed → epoch ms, o null CON MOTIVO.
 *
 * El motivo es el punto. La versión anterior devolvía solo "parseable o no",
 * así que un feed sin fechas se reportaba igual estuviera vacío el campo,
 * tuviera una zona rara o mandara basura. Con el motivo, la próxima corrida
 * dice **por qué** en vez de dejarnos adivinar — que es justo lo que pasó con
 * el feed de la Fed.
 */
export function parseFechaFeed(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ms: null, motivo: 'campo de fecha vacío o ausente' };

  // ¿La cadena trae HORA? `Date.parse` acepta muchas formas sin hora y las
  // aterriza en medianoche sin chistar — incluido "17 septiembre 2026", que
  // V8 resuelve por el prefijo "sep". El resultado es correcto como FECHA y
  // mudo como HORA, y "lo de hoy" ordena por hora: un feed entero a las 00:00
  // se ordena al azar mientras se ve perfecto. Se marca, no se rechaza.
  const viaSegunHora = (txt, via) => (/\d{1,2}:\d{2}/.test(txt)
    ? via
    : `${via} — SIN HORA en el feed: se aterriza a medianoche y el orden por hora no es real`);

  // La fecha SOLA va primero, antes del Date.parse genérico. `Date.parse`
  // resuelve '2026-09-17' sin chistar (medianoche UTC), así que si se lo
  // dejáramos atender él, el aviso de "la hora no viene" no se emitiría
  // nunca — y "lo de hoy" ordena por hora. Lo cazó un test.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return {
      ms: Date.parse(s + 'T00:00:00Z'), motivo: null,
      via: 'fecha sin hora → medianoche UTC (la hora del titular no viene en el feed)',
    };
  }

  const directo = Date.parse(s);
  if (Number.isFinite(directo)) return { ms: directo, motivo: null, via: viaSegunHora(s, 'Date.parse') };

  // Zona alfabética al final que Date.parse no conoce → se cambia por su
  // offset numérico y se reintenta. No se ADIVINA la zona: solo se traduce una
  // que el texto declara.
  const m = /\s([A-Z]{2,5})$/.exec(s);
  if (m && Object.prototype.hasOwnProperty.call(ZONAS_EXTRA, m[1])) {
    const off = ZONAS_EXTRA[m[1]];
    const signo = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const t = Date.parse(s.replace(/\s[A-Z]{2,5}$/, ` ${signo}${hh}${mm}`));
    if (Number.isFinite(t)) return { ms: t, motivo: null, via: viaSegunHora(s, `zona ${m[1]} traducida a ${signo}${hh}${mm}`) };
  }
  if (m) return { ms: null, motivo: `zona horaria desconocida: "${m[1]}"` };

  return { ms: null, motivo: `formato no reconocido: ${s.slice(0, 40)}` };
}

/**
 * Diagnóstico de por qué un feed no trae fechas usables: junta las CADENAS
 * CRUDAS que no se pudieron parsear, agrupadas por motivo.
 *
 * Sin esto, "0% con fecha" es un callejón sin salida. Con esto, la corrida
 * entrega las tres cadenas que fallaron y el motivo se ve a simple vista.
 */
export function diagnosticoFechas(crudas = []) {
  const porMotivo = {};
  let ok = 0;
  for (const c of crudas) {
    const r = parseFechaFeed(c);
    if (r.ms != null) { ok++; continue; }
    if (!porMotivo[r.motivo]) porMotivo[r.motivo] = [];
    if (porMotivo[r.motivo].length < 3) porMotivo[r.motivo].push(String(c).slice(0, 60));
  }
  return {
    total: crudas.length, parseadas: ok, fallidas: crudas.length - ok,
    por_motivo: porMotivo,
  };
}
