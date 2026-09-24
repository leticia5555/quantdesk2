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
export function referenciasManuales(registro, clave, ahora, ctx = {}) {
  const filas = (registro && registro.referencias) || [];
  const mias = filas.filter((f) => up(f && f.clave) === up(clave));
  const vigentes = [], descartadas = [];
  for (const fila of mias) {
    const r = referenciaManual({ ...registro, referencias: [fila] }, clave, ahora, ctx);
    if (r.cap != null) vigentes.push(r);
    else descartadas.push({ fuente: fila.fuente || null, capturada_en: fila.capturada_en || null, motivo: r.motivo });
  }
  return { vigentes, descartadas, total: mias.length };
}

// ═══════════════════════════════════════════════════════════════════
// LA VIGENCIA, ATADA A LO QUE DE VERDAD LA INVALIDA
//
// La referencia arrancó con 14 días de vigencia contra el reloj, y eso
// convertía la captura manual en una tarea QUINCENAL: el 2026-10-04 vencían
// las 11 juntas y G2 pasaba de 26 a 0 sin que nadie tocara nada.
//
// Pero una referencia de capitalización NO valida el precio de hoy: valida
// el DIVISOR (`acciones_por_unidad`) y el CONTEO de acciones. Las dos cosas
// son estructurales — cambian cuando la emisora publica un trimestre nuevo,
// no cuando el mercado se mueve.
//
// Así que la comparación se hace EN LA FECHA DE CAPTURA:
//
//     acciones_del_periodo_vigente_entonces × precio_de_ese_día / apu
//
// contra la cap que se capturó ese día. Los dos lados quedan fechados igual,
// y el precio deja de ser una fuente de error. `bmv_precios` tiene ese
// cierre: no hay que pedirle nada a nadie.
//
// Y la vigencia deja de contar días: **caduca cuando entra un trimestre
// nuevo de acciones para esa emisora**, con días de gracia para re-capturar.
// La captura manual pasa a ser trimestral y AVISADA, no quincenal y por
// sorpresa.
// ═══════════════════════════════════════════════════════════════════

/** Días de gracia tras un trimestre nuevo, antes de que la referencia caiga. */
export const GRACIA_PERIODO_DIAS = 3;
/**
 * Tope duro, por si una emisora deja de reportar y su trimestre nunca cambia.
 * No es el instrumento: es el freno de mano. 120 días = un trimestre y pico.
 */
export const TOPE_REFERENCIA_DIAS = 120;

const clavePeriodoXbrl = (p) => (p && p.anio != null && p.trimestre != null ? `${p.anio}T${p.trimestre}` : null);

/** Cuándo pasó a ser el trimestre vigente: publicación, o captura si falta. */
function vigenteDesde(p) {
  const t = Date.parse((p && (p.fecha_publicacion || p.fecha_captura)) || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * El trimestre que estaba vigente en una fecha: el último publicado en o
 * antes de ella. Devuelve también con qué campo se fechó, porque
 * `fecha_publicacion` es nullable y caer a `fecha_captura` mide otra cosa
 * (cuándo lo bajamos, no cuándo salió).
 */
export function periodoEn(periodos = [], fechaIso) {
  const t = Date.parse(`${String(fechaIso || '').slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(t)) return null;
  let mejor = null, mejorT = null;
  for (const p of periodos) {
    const d = vigenteDesde(p);
    if (d == null || d > t) continue;
    if (mejorT == null || d > mejorT) { mejor = p; mejorT = d; }
  }
  if (!mejor) return null;
  return {
    periodo: clavePeriodoXbrl(mejor),
    acciones_circulacion: num(mejor.acciones_circulacion),
    vigente_desde: new Date(mejorT).toISOString().slice(0, 10),
    fechado_con: mejor.fecha_publicacion ? 'fecha_publicacion' : 'fecha_captura',
  };
}

/** El cierre de una serie en una fecha, o el último anterior (findes, asuetos). */
export function precioEn(cierres = [], fechaIso) {
  const f = String(fechaIso || '').slice(0, 10);
  if (!f) return null;
  let mejor = null;
  for (const c of cierres) {
    const d = String((c && c.fecha) || '').slice(0, 10);
    if (!d || d > f) continue;
    if (!mejor || d > mejor.fecha) mejor = { fecha: d, cierre: num(c.cierre) };
  }
  return mejor && mejor.cierre != null && mejor.cierre > 0 ? mejor : null;
}

/**
 * ¿Sigue valiendo esta referencia? La pregunta ya no es "cuántos días tiene"
 * sino "¿cambió el conteo de acciones desde que se capturó?".
 */
export function vigenciaPorPeriodo({
  capturada_en, periodos = [], ahora = new Date(),
  gracia_dias = GRACIA_PERIODO_DIAS, tope_dias = TOPE_REFERENCIA_DIAS,
} = {}) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const t = Date.parse(capturada_en);
  if (!Number.isFinite(t)) return { estado: 'sin_fecha', motivo: `\`capturada_en\` no es una fecha: ${capturada_en}` };
  // FLOOR, no round: "30 días después" tiene que leerse 30, no 31. Medio día
  // de más no debería adelantar un vencimiento.
  const dias = Math.floor((now.getTime() - t) / 86400000);
  if (dias < 0) return { estado: 'futuro', dias, motivo: 'la referencia está fechada en el futuro' };

  const enCaptura = periodoEn(periodos, capturada_en);
  const actual = periodoEn(periodos, now.toISOString().slice(0, 10));

  // Sin trimestres que mirar, el único freno es el tope duro. Se DICE, para
  // que no parezca que la regla del periodo la aprobó.
  if (!enCaptura || !actual) {
    return dias > tope_dias
      ? { estado: 'vencida', dias, motivo: `referencia vencida: ${dias} días y sin trimestres XBRL contra qué atarla (tope duro ${tope_dias})` }
      : { estado: 'vigente', dias, sin_periodo: true, periodo_en_captura: null, periodo_actual: null,
          motivo: null, nota: 'sin trimestres XBRL: la vigencia sólo se apoya en el tope duro' };
  }

  if (dias > tope_dias) {
    return { estado: 'vencida', dias, periodo_en_captura: enCaptura.periodo, periodo_actual: actual.periodo,
             motivo: `referencia vencida: ${dias} días, pasó el tope duro de ${tope_dias} aunque el trimestre no haya cambiado` };
  }

  if (enCaptura.periodo === actual.periodo) {
    return {
      estado: 'vigente', dias,
      periodo_en_captura: enCaptura.periodo, periodo_actual: actual.periodo,
      acciones_en_captura: enCaptura.acciones_circulacion,
      fechado_con: enCaptura.fechado_con,
      motivo: null,
    };
  }

  // Trimestre nuevo: el conteo de acciones que el mapa pinta HOY no es el que
  // esta referencia validó. Se dan `gracia_dias` para re-capturar.
  const desde = Date.parse(`${actual.vigente_desde}T00:00:00Z`);
  const diasDesdeTrimestre = Math.floor((now.getTime() - desde) / 86400000);
  const restantes = gracia_dias - diasDesdeTrimestre;
  if (restantes >= 0) {
    return {
      estado: 'en_gracia', dias,
      periodo_en_captura: enCaptura.periodo, periodo_actual: actual.periodo,
      acciones_en_captura: enCaptura.acciones_circulacion,
      dias_de_gracia_restantes: restantes,
      fechado_con: actual.fechado_con,
      motivo: `entró ${actual.periodo} (el ${actual.vigente_desde}) y la referencia es de ${enCaptura.periodo}: quedan ${restantes} días para re-capturarla`,
    };
  }
  return {
    estado: 'vencida', dias,
    periodo_en_captura: enCaptura.periodo, periodo_actual: actual.periodo,
    acciones_en_captura: enCaptura.acciones_circulacion,
    motivo: `el conteo de acciones cambió de ${enCaptura.periodo} a ${actual.periodo} el ${actual.vigente_desde}: la referencia ya no valida el número que se pinta`,
  };
}

export function referenciaManual(registro, clave, ahora, ctx = {}) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const filas = (registro && registro.referencias) || [];
  const fila = filas.find((f) => up(f && f.clave) === up(clave));
  if (!fila) return { cap: null, motivo: 'sin referencia manual para esta emisora' };

  const cap = num(fila.market_cap);
  if (cap == null || cap <= 0) return { cap: null, motivo: 'la referencia no trae market_cap numérico' };
  // Las tres cosas que separan una referencia de un número suelto.
  if (!fila.fuente) return { cap: null, motivo: 'la referencia no dice de dónde salió (`fuente`)' };
  if (!fila.capturada_en) return { cap: null, motivo: 'la referencia no dice cuándo se capturó (`capturada_en`)' };

  const vig = vigenciaPorPeriodo({
    capturada_en: fila.capturada_en,
    periodos: ctx.periodos || [],
    ahora: now,
    gracia_dias: num(registro && registro.gracia_dias) ?? GRACIA_PERIODO_DIAS,
    tope_dias: num(registro && registro.tope_dias) ?? num(registro && registro.vigencia_dias) ?? TOPE_REFERENCIA_DIAS,
  });
  if (vig.estado === 'vencida' || vig.estado === 'futuro' || vig.estado === 'sin_fecha') {
    return { cap: null, dias: vig.dias, motivo: vig.motivo, vencida: vig.estado === 'vencida', vigencia: vig };
  }

  // El precio DE ESE DÍA. Si la cosecha no lo tiene, se dice: comparar contra
  // el precio de hoy mide otra cosa, y "no se pudo" no es "no cuadra".
  const px = precioEn(ctx.cierres || [], fila.capturada_en);

  return {
    cap, motivo: null, dias: vig.dias,
    fuente: fila.fuente, capturada_en: fila.capturada_en,
    capturada_por: fila.capturada_por || null,
    vigencia: vig,
    en_gracia: vig.estado === 'en_gracia',
    // Los dos lados de la comparación, fechados igual.
    acciones_en_captura: vig.acciones_en_captura ?? null,
    precio_en_captura: px ? px.cierre : null,
    fecha_precio_captura: px ? px.fecha : null,
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

/**
 * CUÁNDO SE APAGA ESTO SOLO.
 *
 * Una referencia manual envejece con el precio: `vigencia_dias` la acota, y
 * pasada esa fecha `referenciaManual` la descarta por vencida. Con las 11
 * capturadas el mismo día, TODAS vencen el mismo día — y ese día G2 se cae
 * de golpe: sin referencias individuales no hay muestras que validen el
 * método, así que se van también las que verificaban por método.
 *
 * Que se caiga está bien: es la regla de caducidad funcionando, y arrastrar
 * un verde viejo sería peor. Lo que no puede pasar es que se caiga **por
 * sorpresa**, así que la fecha viaja en cada corrida.
 */
export function vigenciaDelRegistro(registro, ahora = new Date(), { periodos = [] } = {}) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const filas = (registro && registro.referencias) || [];
  const gracia = num(registro && registro.gracia_dias) ?? GRACIA_PERIODO_DIAS;
  const tope = num(registro && registro.tope_dias) ?? num(registro && registro.vigencia_dias) ?? TOPE_REFERENCIA_DIAS;

  const porClave = new Map();
  for (const p of periodos) {
    const k = up(p && p.clave);
    if (!k) continue;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(p);
  }

  const porEmisora = filas.map((f) => {
    const clave = up(f && f.clave);
    const v = vigenciaPorPeriodo({
      capturada_en: f && f.capturada_en,
      periodos: porClave.get(clave) || [],
      ahora: now, gracia_dias: gracia, tope_dias: tope,
    });
    return {
      clave, fuente: (f && f.fuente) || null, capturada_en: (f && f.capturada_en) || null,
      estado: v.estado, dias: v.dias ?? null,
      periodo_en_captura: v.periodo_en_captura ?? null,
      periodo_actual: v.periodo_actual ?? null,
      dias_de_gracia_restantes: v.dias_de_gracia_restantes ?? null,
      sin_periodo: !!v.sin_periodo,
      motivo: v.motivo || null,
    };
  });

  const cuenta = (e) => porEmisora.filter((x) => x.estado === e).length;
  const vencidas = cuenta('vencida');
  const enGracia = cuenta('en_gracia');
  const sinPeriodo = porEmisora.filter((x) => x.sin_periodo).length;
  // La que menos días de gracia le quedan: es la que hay que re-capturar ya.
  const urgentes = porEmisora.filter((x) => x.estado === 'en_gracia')
    .sort((a, b) => (a.dias_de_gracia_restantes ?? 0) - (b.dias_de_gracia_restantes ?? 0));

  return {
    filas: filas.length,
    regla: 'la referencia caduca cuando entra un trimestre nuevo de acciones para esa emisora, no a los N días',
    gracia_dias: gracia,
    tope_dias: tope,
    vigentes: cuenta('vigente'),
    en_gracia: enGracia,
    vencidas,
    sin_periodo_xbrl: sinPeriodo,
    por_emisora: porEmisora,
    // Lo que hay que hacer, si hay algo que hacer.
    a_recapturar: [...new Set(porEmisora.filter((x) => x.estado === 'vencida' || x.estado === 'en_gracia').map((x) => x.clave))],
    alerta: vencidas > 0 || enGracia > 0,
    lectura: vencidas
      ? `${vencidas} referencias vencieron (trimestre nuevo de acciones o tope duro): esas emisoras están en gris hasta re-capturarlas`
      : enGracia
        ? `${enGracia} referencias quedaron atrás de su trimestre; a la más urgente (${urgentes[0].clave}) le quedan ${urgentes[0].dias_de_gracia_restantes} días de gracia`
        : null,
  };
}

/**
 * `?manual=` es un OVERRIDE, no una fuente más.
 *
 * Mientras el registro estuvo vacío daba igual: concatenar era lo mismo que
 * reemplazar. Con las 11 referencias persistidas ya no, y la diferencia
 * cambia veredictos: por la regla `varias_por_emisora`, una emisora con dos
 * referencias que no coinciden sale `discrepancia_entre_fuentes`, o sea
 * GRIS. Sumando, probar una cap corregida en prod pondría gris a una emisora
 * ya verificada — el ensayo cambiaría el resultado en vez de medirlo.
 *
 * Así que para cada clave que `?manual=` nombra, sus filas del archivo se
 * APARTAN. Y se reportan: un override silencioso es una referencia que
 * desapareció sin que nadie lo dijera.
 */
export function registroConOverride(registro, manuales = []) {
  const base = (registro && registro.referencias) || [];
  const claves = [...new Set(manuales.map((m) => up(m && m.clave)).filter(Boolean))];
  if (!claves.length) {
    return { registro: registro || { referencias: [] }, claves: [], desplazadas: [] };
  }
  const set = new Set(claves);
  const desplazadas = base.filter((f) => set.has(up(f && f.clave)))
    .map((f) => ({ clave: up(f.clave), fuente: f.fuente || null, market_cap: num(f.market_cap), capturada_en: f.capturada_en || null }));
  return {
    registro: {
      ...registro,
      referencias: [...base.filter((f) => !set.has(up(f && f.clave))), ...manuales],
    },
    claves,
    desplazadas,
  };
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
 *   1. La ventana se ancla en `max(fecha)` DE LA TABLA, no en el reloj, y el
 *      atraso de la cosecha lo decide el llamador EN SESIONES (`bmv-frescura`)
 *      y lo pasa en `cosecha_atrasada`. En días de calendario, un lunes
 *      siempre da dos o tres y la bandera se prendía sola.
 *   2. **La serie líquida nunca se puede declarar sin mercado.** Si ELLA no
 *      operó en la ventana, el problema son los datos, no la serie: se
 *      devuelve `datos_rancios` y NO se excluye nada. Fail closed.
 *
 * Y "no medido" cuenta como CON mercado: no saber no es saber que no.
 * Mantener la serie en la dispersión empuja hacia el gris, que es el lado
 * seguro.
 *
 * ── LO QUE LA CORRIDA DEL 2026-09-21 ENSEÑÓ ──────────────────────────
 * Estas pruebas pasaban con fixtures que traían `volumen_ventana` con
 * números. La tabla real NO: `/v2/historicos` devuelve [cierre, importe] y
 * `bmv_precios.volumen` está vacía para las ~570,000 filas. Un instrumento
 * probado contra una columna que la cosecha nunca llena mide otra cosa.
 * Por eso la actividad se mide con `volumen` O con `importe`, y "no medido"
 * no se convierte en cero en ninguna parte del camino.
 */
export function clasificaSeries({
  series = [], serie_liquida, cosecha_atrasada = false, sesiones_atraso = null,
} = {}) {
  const vivas = series
    .map((x) => ({
      serie: String((x && x.emisora_serie) || ''),
      precio: num(x && x.cierre),
      // `undefined` (la consulta no lo trajo) y `null` (la columna está
      // vacía) son lo mismo acá: NO MEDIDO.
      volumen_ventana: x && x.volumen_ventana === undefined ? null : num(x.volumen_ventana),
      importe_ventana: x && x.importe_ventana === undefined ? null : num(x.importe_ventana),
      filas_ventana: num(x && x.filas_ventana),
    }))
    .filter((x) => x.serie && x.precio != null && x.precio > 0);

  // ── Ancla 1 (ahora explícita): la cosecha atrasada se decide FUERA ───
  // El llamador pasa el veredicto en SESIONES (bmv-frescura), no en días de
  // calendario. Un domingo son dos o tres días y cero sesiones.
  if (cosecha_atrasada) {
    return {
      con_mercado: vivas,
      sin_mercado: [],
      datos_rancios: true,
      causa_rancio: 'cosecha_atrasada',
      actividad_medida: null,
      motivo_rancio: `la cosecha de precios lleva ${sesiones_atraso ?? '?'} sesiones de atraso: con la tabla vieja no se puede concluir que una serie no opera`,
    };
  }

  // ── Con qué se mide que una serie opera ─────────────────────────────
  // `volumen` PRIMERO, `importe` si no hay volumen. No es un adorno: la
  // cosecha de /v2/historicos devuelve [cierre, importe] y NADA más, así que
  // `bmv_precios.volumen` está vacía para toda la tabla. Medir con ella —y
  // peor, con un `coalesce(volumen, 0)` que convierte "no medido" en "cero"—
  // declaraba sin mercado a las 27 emisoras, incluida su serie líquida, y
  // mandaba G2 a 2 de 15 con la cosecha AL DÍA.
  const actividadDe = (x) => (
    x.volumen_ventana != null ? { valor: x.volumen_ventana, medida: 'volumen' }
      : x.importe_ventana != null ? { valor: x.importe_ventana, medida: 'importe' }
        : { valor: null, medida: null });

  const esLiquida = (x) => x.serie === serie_liquida;
  const sinMercado = (x) => { const a = actividadDe(x); return a.valor != null && a.valor <= 0; };
  const medidas = [...new Set(vivas.map((x) => actividadDe(x).medida).filter(Boolean))];

  // Ninguna serie se pudo medir: no hay con qué excluir a nadie. NO es
  // "rancio" —la tabla puede estar al día— es que la columna no existe. Se
  // reporta y todas siguen contando, que es el lado seguro: la dispersión
  // empuja hacia el gris.
  if (!medidas.length) {
    return {
      con_mercado: vivas,
      sin_mercado: [],
      datos_rancios: false,
      causa_rancio: null,
      actividad_medida: null,
      actividad_no_medible: true,
      motivo_rancio: null,
    };
  }

  const liquida = vivas.find(esLiquida) || null;
  // Ancla 2: si la líquida no operó CON LA COSECHA AL DÍA, o la serie del
  // registro está mal o la emisora dejó de cotizar. En cualquier caso no se
  // excluye NADA: el cálculo usa justo ese precio.
  if (liquida && sinMercado(liquida)) {
    return {
      con_mercado: vivas,
      sin_mercado: [],
      datos_rancios: true,
      causa_rancio: 'serie_liquida_sin_actividad',
      actividad_medida: actividadDe(liquida).medida,
      motivo_rancio: `la serie líquida (${serie_liquida}) no registra actividad en la ventana y la cosecha está al día: o la serie del registro está mal, o la emisora dejó de cotizar — no se excluye ninguna`,
    };
  }

  const conMercado = vivas.filter((x) => esLiquida(x) || !sinMercado(x));
  const muertas = vivas.filter((x) => !esLiquida(x) && sinMercado(x));

  return {
    con_mercado: conMercado,
    sin_mercado: muertas.map((x) => ({
      serie: x.serie, precio: x.precio, filas_ventana: x.filas_ventana,
      medida: actividadDe(x).medida,
      motivo: x.filas_ventana ? `cotiza pero con ${actividadDe(x).medida} 0 en la ventana` : 'sin operaciones en la ventana',
    })),
    datos_rancios: false,
    causa_rancio: null,
    actividad_medida: medidas.length === 1 ? medidas[0] : medidas.join('+'),
    motivo_rancio: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// G2 — UN SOLO EVALUADOR, para el que construye y para el que mide
// ═══════════════════════════════════════════════════════════════════

/**
 * La ventana de actividad. 30 días de DATOS (anclados a `max(fecha)` de la
 * tabla, no al reloj).
 */
export const VENTANA_DIAS_G2 = 30;

/**
 * LAS CUATRO CONSULTAS, exportadas para que no haya dos versiones.
 *
 * Mismo problema que G1 tuvo hasta #241: `/api/mercado-r0?job=unidades`
 * evaluaba con el registro de referencias y la regla de series, y
 * `/api/mercado-censo?job=censo` lo hacía por su cuenta contra Yahoo —que
 * devuelve 401 desde Vercel—, así que el mismo día daba `verificadas: 26,
 * verde: true` en un endpoint y `sin_referencia: 30` en el otro.
 */
export const SQL_G2 = {
  acciones: `select distinct on (clave) clave, anio, trimestre, acciones_circulacion,
                    acciones_circulacion_tag, acciones_circulacion_motivo
               from xbrl_reports order by clave, anio desc, trimestre desc`,
  // TODOS los trimestres, no sólo el último: la vigencia de una referencia se
  // ata al trimestre que estaba vigente CUANDO SE CAPTURÓ, y para saber cuál
  // era hay que poder mirar atrás. Son ~30 emisoras × ~40 trimestres.
  periodos: `select clave, anio, trimestre, acciones_circulacion,
                    fecha_publicacion, fecha_captura
               from xbrl_reports order by clave, anio, trimestre`,
  // Los cierres alrededor de las fechas de captura. El rango lo pone el
  // llamador ($1 = desde, $2 = hasta) a partir de las fechas del registro:
  // traerse la tabla entera para leer 11 cierres sería mover el problema.
  cierres_captura: `select emisora, emisora_serie, fecha::text as fecha, cierre
                      from bmv_precios
                     where fecha >= $1::date and fecha <= $2::date`,
  precios: `select distinct on (emisora_serie) emisora, emisora_serie, fecha, cierre, importe
              from bmv_precios order by emisora_serie, fecha desc`,
  corte: 'select max(fecha) hasta from bmv_precios',
  // $1 = días de ventana. SIN `coalesce`: la suma de una columna toda nula
  // es NULL, que es "no medido", y ese es justo el dato que importa.
  ventana: `with corte as (select max(fecha) hasta from bmv_precios)
            select p.emisora_serie,
                   sum(p.volumen)::numeric   volumen_ventana,
                   sum(p.importe)::numeric   importe_ventana,
                   count(p.volumen)::int     filas_con_volumen,
                   count(p.importe)::int     filas_con_importe,
                   count(*)::int             filas_ventana
              from bmv_precios p, corte c
             where p.fecha > c.hasta - ($1::int * interval '1 day')
             group by 1`,
};

/**
 * El rango de fechas que hay que pedirle a `bmv_precios` para poder fechar
 * las referencias. Se saca del propio registro: pedir la tabla entera para
 * leer 11 cierres sería mover el problema de lugar.
 *
 * Se estira 10 días hacia atrás porque una captura puede caer en domingo y
 * el cierre bueno es el del viernes.
 */
export function rangoDeCapturas(registro, { margen_dias = 10 } = {}) {
  const fechas = ((registro && registro.referencias) || [])
    .map((f) => String((f && f.capturada_en) || '').slice(0, 10))
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort();
  if (!fechas.length) return null;
  const desde = new Date(Date.parse(`${fechas[0]}T00:00:00Z`) - margen_dias * 86400000)
    .toISOString().slice(0, 10);
  return { desde, hasta: fechas[fechas.length - 1] };
}

/**
 * EL VEREDICTO DE G2, entero y puro.
 *
 * Recibe filas y devuelve estados. No abre Neon ni pide red: los dos
 * endpoints corren `SQL_G2`, le pasan lo que salió, y obtienen el MISMO
 * resultado. Los umbrales entran por parámetro (`criterios`) en vez de
 * importarse, para no cerrar un ciclo con `mercado-fase0.js`; los dos
 * llamadores pasan el mismo objeto congelado y la salida lo declara.
 *
 * Dos caminos a verificada, que NO se colapsan en uno:
 *   · `verificada`            — referencia pública individual que cuadra.
 *   · `verificada_por_metodo` — serie única y divisor 1: la fórmula no tiene
 *                               nada que elegir, y el instrumento está
 *                               validado con ≥N muestras limpias. La etiqueta
 *                               dice que no hay control propio.
 */
export function evaluaG2({
  emisoras = [], acciones = [], precios = [], volumenes = [],
  // `periodos` = todos los trimestres XBRL; `cierres_captura` = los cierres
  // de las fechas en que se capturaron las referencias. Los dos entran por
  // parámetro para que esto siga siendo puro y probable con fixtures.
  periodos = [], cierres_captura = [],
  referencias = { referencias: [] }, frescura = null, ahora = new Date(),
  criterios = {}, ventana_dias = VENTANA_DIAS_G2,
} = {}) {
  const C = {
    g2_max_error_pct: 5,
    g2_min_emisoras_verificadas: 15,
    g2_metodo_min_muestras: METODO.min_muestras,
    g2_metodo_max_error_pct: METODO.max_error_pct,
    ...criterios,
  };
  const reloj = ahora instanceof Date ? ahora : new Date(ahora);

  const accPor = new Map(acciones.map((a) => [up(a.clave), a]));
  const periodosPor = new Map();
  for (const p of periodos) {
    const k = up(p && p.clave);
    if (!k) continue;
    if (!periodosPor.has(k)) periodosPor.set(k, []);
    periodosPor.get(k).push(p);
  }
  const cierresPor = new Map();
  for (const c of cierres_captura) {
    const k = String((c && c.emisora_serie) || '');
    if (!k) continue;
    if (!cierresPor.has(k)) cierresPor.set(k, []);
    cierresPor.get(k).push(c);
  }
  const volPor = new Map(volumenes.map((v) => [v.emisora_serie, v]));
  const preciosPor = new Map();
  for (const p of precios) {
    const k = up(p.emisora);
    if (!preciosPor.has(k)) preciosPor.set(k, []);
    preciosPor.get(k).push(p);
  }

  // ── PASO 1: calcular, y verificar SOLO las que tienen referencia ─────
  const base = emisoras.map((em) => {
    const clave = up(em.clave);
    const a = accPor.get(clave);
    const series = preciosPor.get(clave) || [];
    const elegida = series.find((x) => x.emisora_serie === em.serie_liquida) || null;
    const masOperada = series.slice().sort((x, y) => (num(y.importe) || 0) - (num(x.importe) || 0))[0] || null;

    const conVol = series.map((x) => {
      const v = volPor.get(x.emisora_serie) || null;
      return {
        ...x,
        volumen_ventana: v ? v.volumen_ventana : null,
        importe_ventana: v ? v.importe_ventana : null,
        filas_ventana: v ? v.filas_ventana : 0,
      };
    });
    // El atraso entra como VEREDICTO EN SESIONES, no como días de calendario:
    // un lunes son dos o tres días y cero sesiones, y la bandera se prendía
    // sola cada fin de semana.
    const clases = clasificaSeries({
      series: conVol, serie_liquida: em.serie_liquida,
      cosecha_atrasada: !!(frescura && frescura.alerta),
      sesiones_atraso: frescura ? frescura.dias_habiles_atraso : null,
    });

    // La dispersión se mide SOLO entre series que operan. Una serie muerta no
    // es un precio en desacuerdo: es el último número que quedó pegado.
    const disp = dispersionPrecios({
      series: clases.con_mercado.map((x) => ({ emisora_serie: x.serie, cierre: x.precio })),
      serie_liquida: em.serie_liquida, tolerancia_pct: C.g2_max_error_pct,
    });

    const calc = capConUnidades({
      clave, acciones_circulacion: a ? a.acciones_circulacion : null,
      precio: elegida ? elegida.cierre : null,
      serie_liquida: em.serie_liquida, acciones_por_unidad: em.acciones_por_unidad,
    });
    const refs = referenciasManuales(referencias, clave, reloj, {
      periodos: periodosPor.get(clave) || [],
      cierres: cierresPor.get(em.serie_liquida) || [],
    });
    const verif = verificaConReferencias({
      capCalculada: calc.cap, referencias: refs.vigentes,
      acciones_por_unidad: em.acciones_por_unidad,
      precio: elegida ? elegida.cierre : null,
      acciones_circulacion: a ? a.acciones_circulacion : null,
      tolerancia_pct: C.g2_max_error_pct,
    });

    return {
      clave, nombre: em.nombre, sector: em.sector,
      serie_liquida: em.serie_liquida,
      n_series: series.length,
      n_series_con_mercado: clases.con_mercado.length,
      series_sin_mercado: clases.sin_mercado,
      datos_rancios: clases.datos_rancios,
      causa_rancio: clases.causa_rancio,
      motivo_rancio: clases.motivo_rancio,
      actividad_medida: clases.actividad_medida,
      actividad_no_medible: !!clases.actividad_no_medible,
      acciones_circulacion: a ? num(a.acciones_circulacion) : null,
      acciones_por_unidad: em.acciones_por_unidad,
      unidad_fuente: em.unidad_fuente,
      periodo_xbrl: a ? `${a.anio}T${a.trimestre}` : null,
      tag_acciones: a ? (a.acciones_circulacion_tag || null) : null,
      // La FECHA del precio usado. Sin ella, un 5.6% de error no se distingue
      // de un precio rancio — que es justo la duda que dejó TLEVISA.
      fecha_precio: elegida ? String(elegida.fecha).slice(0, 10) : null,
      dias_precio: elegida && elegida.fecha
        ? Math.round((reloj - new Date(elegida.fecha)) / 86400000) : null,
      cap_calculada: calc.cap, motivo_calculo: calc.motivo,
      dispersion: disp,
      serie_mas_operada: masOperada ? masOperada.emisora_serie : null,
      serie_discrepa: !!(masOperada && em.serie_liquida && masOperada.emisora_serie !== em.serie_liquida),
      referencias: { vigentes: refs.vigentes.length, descartadas: refs.descartadas },
      verificacion: verif,
      error_pct: verif.por_referencia.length
        ? verif.por_referencia.reduce((mejor, r) => (mejor == null || Math.abs(num(r.error_pct) ?? Infinity) < Math.abs(mejor) ? (num(r.error_pct) ?? mejor) : mejor), null)
        : null,
      // Elegible para heredar el método: una serie CON MERCADO, divisor 1.
      elegible_metodo: elegibleMetodo({
        n_series: clases.con_mercado.length, acciones_por_unidad: em.acciones_por_unidad,
      }),
    };
  });

  // ── PASO 2: ¿el INSTRUMENTO quedó validado? ──────────────────────────
  const metodo = validaMetodo(
    base.filter((b) => b.error_pct != null).map((b) => ({
      clave: b.clave, error_pct: b.error_pct,
      n_series: b.n_series, acciones_por_unidad: b.acciones_por_unidad,
    })),
    { min: C.g2_metodo_min_muestras, maxPct: C.g2_metodo_max_error_pct },
  );

  // ── PASO 3: el estado final de cada emisora ──────────────────────────
  const detalle = base.map((b) => {
    let estado, etiqueta = null, motivo = null, via = null;

    if (b.cap_calculada == null) {
      estado = 'gris_punteado'; motivo = b.motivo_calculo;
    } else if (b.datos_rancios) {
      // Dos causas distintas y el motivo las distingue: la cosecha viene
      // atrasada (en SESIONES), o la serie líquida no operó con la tabla al
      // día. En las dos, un verde sacado de ahí es peor que un gris.
      estado = 'gris_punteado'; via = b.causa_rancio || 'datos_rancios';
      motivo = b.motivo_rancio;
    } else if (b.dispersion.requiere_desglose) {
      // Manda sobre la verificación individual A PROPÓSITO: si las series
      // cotizan distinto, el número está estructuralmente mal aunque una
      // referencia coincida — y una referencia que coincide con un cálculo
      // mal hecho puede estar haciendo el mismo cálculo mal.
      estado = 'gris_punteado'; via = 'requiere_desglose'; motivo = b.dispersion.motivo;
    } else if (b.verificacion.estado === 'verificada') {
      estado = 'verificada'; via = 'individual';
      etiqueta = `cap: calc · verificada vs ${b.verificacion.por_referencia.map((r) => r.fuente).join(' + ')}`;
    } else if (b.verificacion.estado === 'discrepancia_entre_fuentes') {
      // NO es verificada: dos fuentes públicas no coinciden entre sí.
      estado = 'gris_punteado'; via = 'discrepancia'; motivo = b.verificacion.motivo;
    } else if (b.verificacion.estado === 'no_cuadra') {
      estado = 'gris_punteado'; via = 'individual'; motivo = b.verificacion.motivo;
    } else if (b.elegible_metodo && metodo.valido) {
      estado = 'verificada_por_metodo'; via = 'metodo';
      etiqueta = `cap: calc · método validado (${metodo.cuadran} muestras ≤${metodo.umbral_pct}%)`;
    } else if (b.elegible_metodo) {
      estado = 'gris_punteado'; via = 'metodo';
      motivo = `el método no está validado: ${metodo.razones.join(' · ')}`;
    } else {
      estado = 'gris_punteado'; via = 'individual_obligatoria';
      motivo = b.n_series > 1
        ? `${b.n_series} series: la serie líquida es una elección, y el método no la valida — hace falta referencia individual`
        : `divisor ${b.acciones_por_unidad}: el empaquetado es una elección, y el método no lo valida — hace falta referencia individual`;
    }
    return { ...b, estado, etiqueta, motivo_estado: motivo, via };
  });

  const porEstado = (x) => detalle.filter((d) => d.estado === x);
  const individuales = porEstado('verificada');
  const porMetodo = porEstado('verificada_por_metodo');
  const verificadas = individuales.length + porMetodo.length;

  // Las que exigen referencia individual y todavía no la tienen: es la lista
  // de lo que falta, nombre por nombre.
  const requierenDesglose = detalle.filter((d) => d.dispersion.requiere_desglose)
    .map((d) => ({
      clave: d.clave,
      series: d.dispersion.series_comparables,
      spread_pct: +d.dispersion.spread_pct.toFixed(1),
      verificaba_igual: d.verificacion.estado === 'verificada',
    }));
  const faltanReferencia = detalle
    .filter((d) => !d.elegible_metodo && d.estado === 'gris_punteado' && d.referencias.vigentes === 0)
    .map((d) => ({ clave: d.clave, n_series: d.n_series, apu: d.acciones_por_unidad, motivo: d.motivo_estado }));

  const razones = [];
  if (verificadas < C.g2_min_emisoras_verificadas) {
    razones.push(`solo ${verificadas} emisoras verificadas (piso ${C.g2_min_emisoras_verificadas}): ${individuales.length} con referencia individual + ${porMetodo.length} por método`);
  }
  // El atraso no es una compuerta aparte —ya se manifiesta en el conteo,
  // porque deja a todas en gris— pero decir POR QUÉ cayó el conteo evita
  // que alguien busque el problema en las referencias.
  if (frescura && frescura.alerta) {
    razones.push(`la cosecha de precios lleva ${frescura.dias_habiles_atraso} sesiones de atraso: ninguna emisora puede verificarse con la tabla vieja`);
  }
  if (!metodo.valido && porMetodo.length === 0) {
    razones.push(`el método no está validado: ${metodo.razones.join(' · ')}`);
  }
  const vig = vigenciaDelRegistro(referencias, reloj, { periodos });
  if (vig.vencidas) {
    razones.push(`${vig.vencidas} referencias caducaron —trimestre nuevo de acciones o tope duro— y hay que re-capturarlas: ${vig.a_recapturar.join(', ')}`);
  }

  return {
    detalle,
    metodo: {
      ...metodo,
      heredan_sin_control_propio: porMetodo.map((d) => d.clave),
      lectura: metodo.valido
        ? `instrumento validado con ${metodo.cuadran} muestras (peor ${metodo.peor_error_pct?.toFixed(1)}%); ${porMetodo.length} emisoras lo heredan`
        : `instrumento NO validado — ninguna emisora hereda: ${metodo.razones.join(' · ')}`,
    },
    resumen: {
      emisoras: detalle.length,
      verificadas_individual: individuales.length,
      verificadas_por_metodo: porMetodo.length,
      verificadas_total: verificadas,
      gris_punteado: porEstado('gris_punteado').length,
      con_cap_calculada: detalle.filter((d) => d.cap_calculada != null).length,
      con_referencia_vigente: detalle.filter((d) => d.referencias.vigentes > 0).length,
      discrepancias_entre_fuentes: detalle.filter((d) => d.via === 'discrepancia').map((d) => d.clave),
      requieren_desglose: requierenDesglose.length,
    },
    requieren_desglose: requierenDesglose,
    faltan_referencia_individual: faltanReferencia,
    verificadas,
    piso: C.g2_min_emisoras_verificadas,
    verde: verificadas >= C.g2_min_emisoras_verificadas,
    razones,
    ventana_dias,
    // Cuándo se apaga esto solo. Las referencias manuales caducan, y cuando
    // caducan se lleva puesto también al método: sin muestras no hay
    // instrumento validado.
    vigencia_referencias: vigenciaDelRegistro(referencias, reloj, { periodos }),
    criterios: {
      max_error_pct: C.g2_max_error_pct,
      min_emisoras_verificadas: C.g2_min_emisoras_verificadas,
      metodo_min_muestras: C.g2_metodo_min_muestras,
      metodo_max_error_pct: C.g2_metodo_max_error_pct,
    },
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
  const porRef = referencias.map((ref) => {
    // ── LOS DOS LADOS, FECHADOS IGUAL ─────────────────────────────────
    // Se compara la cap que se habría calculado EL DÍA DE LA CAPTURA
    // —acciones de ese trimestre × cierre de ese día / apu— contra la cap
    // capturada ese día. Comparar contra el cálculo de HOY metía el
    // movimiento del precio adentro del error, y eso no es lo que la
    // referencia valida: valida el divisor y el conteo de acciones.
    const acc = num(ref.acciones_en_captura) ?? num(acciones_circulacion);
    const px = num(ref.precio_en_captura);
    const apu = num(acciones_por_unidad) || 1;
    const capEnCaptura = (acc != null && px != null && acc > 0 && px > 0) ? (acc * px) / apu : null;
    const base = capEnCaptura != null ? 'precio_y_acciones_de_la_captura' : 'cálculo de hoy (sin cierre guardado de esa fecha)';
    const usada = capEnCaptura != null ? capEnCaptura : capCalculada;
    return {
      fuente: ref.fuente, capturada_en: ref.capturada_en, cap: ref.cap,
      base_de_comparacion: base,
      cap_en_captura: capEnCaptura,
      precio_en_captura: px ?? null,
      fecha_precio_captura: ref.fecha_precio_captura || null,
      acciones_en_captura: acc ?? null,
      periodo_en_captura: ref.vigencia ? ref.vigencia.periodo_en_captura : null,
      en_gracia: !!ref.en_gracia,
      ...verificaDivisor({ capCalculada: usada, capReferencia: ref.cap, acciones_por_unidad, tolerancia_pct }),
      conteo: conteoImplicito({ capReferencia: ref.cap, precio: px ?? precio, acciones_por_unidad, acciones_circulacion: acc ?? acciones_circulacion }),
    };
  });

  const cuadran = porRef.filter((r) => r.estado === 'cuadra');
  const enGracia = porRef.filter((r) => r.en_gracia);
  if (cuadran.length === porRef.length) {
    return {
      estado: 'verificada', por_referencia: porRef, motivo: null, referencias_usadas: porRef.length,
      // Verificada SÍ, pero el conteo que se pinta hoy es de un trimestre
      // que esta referencia no vio. El divisor sigue validado; el conteo
      // nuevo, no. Se dice en vez de disolverse en el verde.
      en_gracia: enGracia.length > 0,
      aviso: enGracia.length
        ? `el conteo de acciones cambió de trimestre y la referencia todavía es del anterior: el divisor sigue validado, el conteo nuevo no. Quedan ${Math.min(...enGracia.map((r) => r.dias_de_gracia_restantes ?? 0))} días de gracia`
        : null,
    };
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
export function filaUniversoUs({ symbol, nombre, industria, sector_etf, market_cap, cap_fuente, ahora, cap_moneda, acciones_millones }) {
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
    // La moneda y las acciones viajan SIEMPRE, tenga cap o no: son lo que
    // permite dudar de la cap, así que no pueden depender de que la cap esté.
    cap_moneda: cap_moneda ? String(cap_moneda).toUpperCase() : null,
    acciones_millones: num(acciones_millones) != null && num(acciones_millones) > 0 ? num(acciones_millones) : null,
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
