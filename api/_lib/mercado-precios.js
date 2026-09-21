// ═══════════════════════════════════════════════════════════════════
// api/_lib/mercado-precios.js — la SERIE, que es lo que YTD necesitaba.
//
// PURA: no abre Neon, no pide red. Recibe payloads y filas, devuelve filas y
// planes. Se prueba con fixtures.
//
// POR QUÉ EXISTE. La Fase 0 midió el hueco y lo dejó escrito (§2 de
// docs/mercado-r1-encargo.md): `/api/price` da 30 cierres SIN FECHA y
// `/api/macro-markets` 70 puntos de 3 meses. Ninguna de las dos alcanza para
// YTD, porque **YTD no es un número de sesiones: es una fecha** — el último
// cierre del año pasado— y cuántas sesiones hay hasta ahí depende del día en
// que se pregunte. Sin timestamps no hay forma de encontrar ese ancla.
//
// Con una serie sin fechas, el toggle YTD pintaría un número corto con una
// etiqueta larga: exactamente el bug del % de periodo que `qdPctTag` existe
// para hacer imposible. Así que la serie viene PRIMERO y el toggle después.
//
// MX ya la tenía: `bmv_precios` guarda (emisora_serie, fecha). EE.UU. no
// tenía ninguna tabla de precios, y por eso esta rebanada empieza acá.
// ═══════════════════════════════════════════════════════════════════

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const up = (s) => String(s || '').trim().toUpperCase();

/** Cuánta historia se siembra. YTD necesita el cierre del 31-dic anterior. */
export const RANGO_SIEMBRA = '1y';
/** Mínimo de puntos para que una serie sirva de algo. */
export const MIN_PUNTOS_SERIE = 30;

export const SCHEMA_PRECIOS_US = [
  `create table if not exists mercado_precios_us (
     symbol           text not null,
     fecha            date not null,
     cierre           numeric,
     cierre_ajustado  numeric,
     primary key (symbol, fecha)
   )`,
  `create index if not exists mercado_precios_us_symbol_idx
     on mercado_precios_us (symbol, fecha desc)`,
];

/**
 * El payload de Yahoo `v8/finance/chart` → filas fechadas.
 *
 * Se guardan `close` Y `adjclose`. No es redundancia: el % de un periodo
 * largo con `close` pelado ignora dividendos y splits, y un split de 4:1
 * pinta un −75% que no existió. `adjclose` es la serie de RETORNO; `close`
 * es el precio que la gente ve en pantalla. Cada uno sirve para algo y
 * mezclarlos es cómo se inventa un número.
 *
 * Una fila sin fecha o sin cierre se DESCARTA y se cuenta, con el motivo:
 * "no llegó" y "llegó mal" no son lo mismo.
 */
export function aplanarChartYahoo(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) {
    const err = json && json.chart && json.chart.error;
    return { filas: [], descartadas: 0, motivo: err ? `la fuente devolvió error: ${err.code || err.description || 'sin código'}` : 'sin chart.result en la respuesta' };
  }
  const ts = r.timestamp;
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0]
    && r.indicators.adjclose[0].adjclose;
  if (!Array.isArray(ts) || !q) return { filas: [], descartadas: 0, motivo: 'sin timestamp/quote' };

  const filas = [];
  let descartadas = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    const c = num(q.close && q.close[i]);
    if (t == null || c == null || c <= 0) { descartadas++; continue; }
    const a = Array.isArray(adj) ? num(adj[i]) : null;
    filas.push({
      fecha: new Date(t * 1000).toISOString().slice(0, 10),
      t,
      cierre: c,
      cierre_ajustado: a != null && a > 0 ? a : null,
    });
  }
  // Yahoo manda el día en curso como último punto con el precio VIVO. Para
  // una tabla de cierres eso es una fila que va a cambiar: se marca para que
  // el llamador decida, en vez de guardarla como si fuera definitiva.
  const hoy = filas.length ? filas[filas.length - 1] : null;
  return {
    filas, descartadas,
    motivo: filas.length ? null : 'la respuesta no traía ningún cierre utilizable',
    sin_adjclose: !Array.isArray(adj),
    ultima_fecha: hoy ? hoy.fecha : null,
  };
}

// El mercado de EE.UU. cierra a las 16:00 DEL ESTE. En UTC eso son las 20:00
// media parte del año (EDT) y las 21:00 la otra (EST), así que un número fijo
// se equivoca seis meses al año.
//
// La versión anterior usaba 21 UTC —el valor de invierno, elegido como el
// "más tardío con margen"— y en septiembre eso deja la barra del día marcada
// como provisional entre las 20:00 y las 21:00 UTC, con el mercado ya
// cerrado hace una hora. Ahora se pregunta la hora local con `Intl`, que es
// quien sabe de cambios de horario.
export const CIERRE_ET_H = 16;
export const MARGEN_CIERRE_MIN = 10;
const TZ_US = 'America/New_York';

/** La hora local de una zona y el día que es allá. Sin tablas de offsets. */
export function horaEnZona(ahora, tz = TZ_US) {
  const d = ahora instanceof Date ? ahora : new Date(ahora);
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    const h = Number(g('hour')) % 24, m = Number(g('minute'));
    return { fecha: `${g('year')}-${g('month')}-${g('day')}`, hora: h + m / 60, ok: Number.isFinite(h) };
  } catch (e) {
    return { fecha: null, hora: null, ok: false };
  }
}

/**
 * ¿La barra de esta fecha ya es un CIERRE, o todavía es el precio vivo?
 *
 * Guardar la barra del día en curso como si fuera cierre mete un número que
 * va a cambiar en una tabla que se lee como definitiva — y el % del día
 * siguiente se calcularía contra un precio de media sesión.
 */
export function esCierreDefinitivo(fechaIso, ahora = new Date()) {
  const f = String(fechaIso || '').slice(0, 10);
  if (!f) return false;
  const t = horaEnZona(ahora, TZ_US);
  // Sin zona resuelta se falla CERRADO: no se guarda una barra que no se
  // pudo fechar contra el cierre de su propio mercado.
  if (!t.ok) return false;
  if (f < t.fecha) return true;
  if (f > t.fecha) return false;                   // barra futura: no existe
  return t.hora >= CIERRE_ET_H + MARGEN_CIERRE_MIN / 60;
}

/** Filtra las barras que todavía no son cierre, y dice cuántas quitó. */
export function soloCierresDefinitivos(filas = [], ahora = new Date()) {
  const buenas = [], provisionales = [];
  for (const f of filas) (esCierreDefinitivo(f && f.fecha, ahora) ? buenas : provisionales).push(f);
  return { filas: buenas, provisionales: provisionales.length, fechas_provisionales: provisionales.map((f) => f && f.fecha) };
}

/**
 * Serie para los helpers de periodo: `{ t, c }` en orden cronológico.
 *
 * `base` elige qué columna es `c`:
 *   · 'ajustado' (default) → retorno total; es lo que un % de periodo debe usar.
 *   · 'cierre'             → el precio de pantalla.
 * Si se pide ajustado y una fila no lo tiene, cae a `cierre` y lo REPORTA:
 * una serie medio ajustada y medio no es un % inventado.
 */
export function serieDesdeFilas(filas = [], { base = 'ajustado' } = {}) {
  const pts = [];
  let sinAjuste = 0;
  for (const f of filas) {
    const t = num(f && f.t) ?? (f && f.fecha ? Math.floor(Date.parse(`${f.fecha}T00:00:00Z`) / 1000) : null);
    const aj = num(f && f.cierre_ajustado);
    const cl = num(f && f.cierre);
    let c = base === 'cierre' ? cl : (aj ?? cl);
    if (base !== 'cierre' && aj == null && cl != null) sinAjuste++;
    if (t == null || c == null || c <= 0) continue;
    pts.push({ t, c });
  }
  pts.sort((a, b) => a.t - b.t);
  return { serie: pts, puntos: pts.length, puntos_sin_ajuste: sinAjuste, base };
}

/**
 * QUÉ PEDIR Y A QUIÉN. Siembra completa para lo que no tiene serie; cola
 * corta para lo que ya la tiene.
 *
 * Mismo criterio que `?job=precios` de la BMV: la cota de abajo es
 * `max(fecha)` real por símbolo, así que correrlo dos veces el mismo día no
 * pide nada la segunda vez.
 */
export function planPreciosUs({
  simbolos = [], yaTengo = new Map(), hasta, min_puntos = MIN_PUNTOS_SERIE, cuenta = new Map(),
} = {}) {
  const siembra = [], cola = [];
  const alDia = [];
  for (const raw of simbolos) {
    const sym = up(raw);
    if (!sym) continue;
    const ultima = yaTengo.get(sym) || null;
    const n = num(cuenta.get(sym)) ?? 0;
    // Sin serie, o con una demasiado corta para anclar YTD: se siembra entera.
    if (!ultima || n < min_puntos) { siembra.push({ symbol: sym, motivo: !ultima ? 'sin serie' : `serie corta (${n} puntos)` }); continue; }
    if (hasta && ultima >= hasta) { alDia.push(sym); continue; }
    cola.push({ symbol: sym, desde: ultima, hasta: hasta || null });
  }
  return { siembra, cola, al_dia: alDia.length, al_dia_simbolos: alDia.slice(0, 20) };
}

/**
 * ¿Alcanza esta serie para anclar YTD? La respuesta con su motivo, que es lo
 * que viaja al render cuando la respuesta es no.
 *
 * `ahora` se INYECTA: el ancla es una comparación contra un calendario, y un
 * reloj escondido haría que el test midiera la hora en que corrió.
 */
export function cubreYtd(serie = [], ahora = new Date()) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const anio = now.getUTCFullYear();
  const pts = serie.filter((p) => p && Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.t));
  if (pts.length < 2) return { cubre: false, puntos: pts.length, motivo: 'serie de menos de 2 puntos' };
  for (let i = pts.length - 1; i >= 0; i--) {
    if (new Date(pts[i].t * 1000).getUTCFullYear() < anio) {
      return { cubre: true, puntos: pts.length, ancla_fecha: new Date(pts[i].t * 1000).toISOString().slice(0, 10), motivo: null };
    }
  }
  const primera = new Date(pts[0].t * 1000).toISOString().slice(0, 10);
  return {
    cubre: false, puntos: pts.length,
    motivo: `la serie empieza en ${primera} y no llega al año anterior: no hay cierre de fin de año contra el cual anclar`,
  };
}
