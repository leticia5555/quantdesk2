// ═══════════════════════════════════════════════════════════════════════
// api/_lib/alertas.js — QUÉ DICE cada alerta de Telegram. Todo PURO.
//
// Acá no hay red ni base de datos: entran datos ya leídos y sale el texto del
// mensaje (o `null` cuando no hay nada que decir). Los datos los trae
// `alertas-fuentes.js`, el envío lo hace `telegram.js` y el orden lo pone
// `api/alertas.js`.
//
// ── LAS TRES REGLAS DE LETY ──────────────────────────────────────────
//   1. NUNCA LA MISMA ALERTA DOS VECES. Cada alerta tiene una CLAVE estable
//      (`clave*` abajo) que se aparta en `alertas_enviadas` antes de mandar.
//   2. NADA DE MENSAJES VACÍOS. Cada `texto*` devuelve `null` si no tiene con
//      qué armar el mensaje, y una sección sin datos se omite: jamás se
//      escribe "no hay nada".
//   3. CADA MENSAJE CON SU LINK a QuantDesk. Lo pone `cierra()`, que es por
//      donde sale todo texto.
//
// Español sencillo: sin siglas sin explicar y sin jerga de mesa de dinero.
// ═══════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { escapaHtml, linkQuantDesk } from './telegram.js';

// Las acciones de Lety. `alias` es cómo las nombran los titulares.
export const MIS_ACCIONES = [
  { symbol: 'SPCX', nombre: 'SpaceX', alias: ['SpaceX', 'Space Exploration Technologies'] },
  { symbol: 'NVDA', nombre: 'Nvidia', alias: ['Nvidia'] },
  { symbol: 'SMMT', nombre: 'Summit Therapeutics', alias: ['Summit Therapeutics'] },
  { symbol: 'ANT', nombre: 'Anthropic', alias: ['Anthropic'] },
];
export const UMBRAL_MOVIMIENTO_PCT = 5;
export const ZONA = 'America/Monterrey';

// Los once sectores del S&P 500, por su ETF de State Street.
export const SECTORES = {
  XLK: 'Tecnología', XLF: 'Financiero', XLV: 'Salud', XLY: 'Consumo discrecional',
  XLP: 'Consumo básico', XLE: 'Energía', XLI: 'Industrial', XLB: 'Materiales',
  XLU: 'Servicios públicos', XLRE: 'Bienes raíces', XLC: 'Comunicaciones',
};

// ── FECHAS Y NÚMEROS ─────────────────────────────────────────────────
const fechaEn = (zona) => (instante = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instante));
/** 'YYYY-MM-DD' de un instante, en Monterrey. */
export const fechaMonterrey = fechaEn(ZONA);
/** 'YYYY-MM-DD' de un instante, en Nueva York (la fecha de la SESIÓN). */
export const fechaNuevaYork = fechaEn('America/New_York');

/** '2026-12-09' → 'miércoles 9 de diciembre'. */
export function fechaLarga(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
    .format(d).replace(',', '');
}
const diaDeLaSemana = (iso) => fechaLarga(iso).split(' ')[0];
const mayuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** '13:00' → '1:00 pm'. */
export function hora12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

export function numero(v, decimales = 2) {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}
export function pct(v) {
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}
const flecha = (v) => (Number(v) >= 0 ? '🟢' : '🔴');

/** Un monto en dólares dicho como se dice: 'US$1.5 millones'. */
export function dinero(v) {
  const n = Math.abs(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n >= 1e9) return `US$${numero(n / 1e9, 1)} mil millones`;
  if (n >= 1e6) return `US$${numero(n / 1e6, 1)} millones`;
  return `US$${numero(n, 0)}`;
}

const cambioPct = (ahora, antes) => (Number.isFinite(ahora) && Number.isFinite(antes) && antes > 0
  ? ((ahora - antes) / antes) * 100 : null);

/** Todo mensaje sale por acá: líneas no vacías + el link a QuantDesk. */
function cierra(lineas, ruta, env) {
  const cuerpo = lineas.filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cuerpo) return null;
  return `${cuerpo}\n\n${linkQuantDesk(ruta, 'Ver más en QuantDesk', env)}`;
}

const huella = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

// ═══════════════════════════════════════════════════════════════════════
// 1. LA MAÑANA
// ═══════════════════════════════════════════════════════════════════════
export const claveManana = (fecha) => `manana:${fecha}`;

/** El evento macro como renglón: la hora sale de la nota ("7:30 hora de CDMX"). */
export function horaDeEvento(e) {
  const m = /(\d{1,2}:\d{2})\s*hora de CDMX/i.exec(String((e && e.note) || ''));
  return m ? hora12(m[1]) : null;
}

const CUANDO_REPORTA = { BMO: 'antes de que abra el mercado', AMC: 'después del cierre' };

function lecturaDeFuturos(futuros) {
  const p = futuros.map((f) => f.pct).filter(Number.isFinite);
  if (!p.length) return null;
  if (p.every((x) => Math.abs(x) < 0.15)) return 'El mercado apunta a abrir casi sin cambios.';
  if (p.every((x) => x > 0)) return 'El mercado apunta a abrir al alza.';
  if (p.every((x) => x < 0)) return 'El mercado apunta a abrir a la baja.';
  return 'Las señales están mixtas: uno sube y otro baja.';
}

/**
 * futuros: [{ nombre, precio, pct }] · apertura: { hora: '8:30', ya_abrio }
 * macro: eventos de HOY · reportes: [{ ticker, time }] de HOY
 */
export function textoManana({ fecha, futuros = [], apertura = null, macro = [], reportes = [], env } = {}) {
  const fut = futuros.filter((f) => f && Number.isFinite(f.precio) && Number.isFinite(f.pct));
  const eventos = macro.filter((e) => e && e.title);
  const rep = reportes.filter((r) => r && r.ticker);
  if (!fut.length && !eventos.length && !rep.length) return null;

  const l = [`☀️ <b>Buenos días</b> · ${escapaHtml(fechaLarga(fecha))}`, ''];
  if (fut.length) {
    const yaAbrio = !!(apertura && apertura.ya_abrio);
    l.push(yaAbrio ? '<b>Futuros</b> (el mercado ya abrió)' : '<b>Futuros</b> (antes de que abra el mercado)');
    for (const f of fut) l.push(`${flecha(f.pct)} ${escapaHtml(f.nombre)}: ${numero(f.precio)} (${pct(f.pct)})`);
    if (!yaAbrio) l.push(lecturaDeFuturos(fut));
    if (apertura && apertura.hora) {
      l.push(yaAbrio ? `El mercado abrió a las ${hora12(apertura.hora)}.` : `El mercado abre a las ${hora12(apertura.hora)}.`);
    }
    l.push('');
  }
  if (eventos.length || rep.length) {
    l.push('<b>Hoy en el calendario</b>');
    for (const e of eventos) {
      const h = horaDeEvento(e);
      l.push(`• ${h ? h + ' · ' : ''}${escapaHtml(e.title)}`);
    }
    if (rep.length) {
      const grupos = new Map();
      for (const r of rep) {
        const k = CUANDO_REPORTA[r.time] || '';
        grupos.set(k, [...(grupos.get(k) || []), r.ticker]);
      }
      for (const [cuando, tickers] of grupos) {
        l.push(`• Reportan resultados${cuando ? ' ' + cuando : ''}: ${escapaHtml(tickers.join(', '))}`);
      }
    }
  }
  return cierra(l, '/mercado', env);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. EL CIERRE
// ═══════════════════════════════════════════════════════════════════════
export const claveCierre = (fecha) => `cierre:${fecha}`;

/**
 * Las que más subieron y más bajaron, SÓLO CON DATOS AL DÍA.
 *
 * "Al día" quiere decir que la barra diaria que trae Alpaca es de LA SESIÓN DE
 * HOY. Una emisora suspendida, deslistada o que simplemente no operó trae la
 * barra de su último día (PSKY traía la de hace un mes): su "cambio" compara
 * dos cierres viejos y no es un movimiento de hoy. Esas se cuentan en
 * `atrasadas` y no entran a la lista.
 */
export function eligeMovimientos(universo = [], snaps = {}, sesion, n = 3) {
  const alDia = [];
  const atrasadas = [];
  for (const u of universo) {
    const s = snaps[u.symbol];
    if (!s) continue;
    if (!s.day_fecha || s.day_fecha !== sesion) { atrasadas.push(u.symbol); continue; }
    const p = cambioPct(Number(s.day_close), Number(s.prev_close));
    if (p == null) continue;
    alDia.push({ symbol: u.symbol, nombre: u.nombre || null, pct: p, precio: Number(s.day_close) });
  }
  const orden = [...alDia].sort((a, b) => b.pct - a.pct);
  return {
    suben: orden.filter((x) => x.pct > 0).slice(0, n),
    bajan: orden.filter((x) => x.pct < 0).slice(-n).reverse(),
    al_dia: alDia.length,
    atrasadas,
  };
}

/** El mejor y el peor sector del día, con la misma regla de "al día". */
export function eligeSectores(snaps = {}, sesion) {
  const filas = Object.keys(SECTORES).map((etf) => {
    const s = snaps[etf];
    if (!s || s.day_fecha !== sesion) return null;
    const p = cambioPct(Number(s.day_close), Number(s.prev_close));
    return p == null ? null : { etf, nombre: SECTORES[etf], pct: p };
  }).filter(Boolean).sort((a, b) => b.pct - a.pct);
  if (filas.length < 2) return { mejor: null, peor: null, medidos: filas.length };
  return { mejor: filas[0], peor: filas[filas.length - 1], medidos: filas.length };
}

const nombreCorto = (n) => String(n || '')
  .replace(/[,.]?\s+(Inc|Corp|Corporation|Co|Company|Ltd|PLC|plc|N\.?V\.?|S\.?A\.?|Holdings?|Group|PBC|Class [A-C])\.?(?=\s|$)/g, '')
  .replace(/[,.\s]+$/, '').trim();

function renglonEmisora(x, i) {
  const nombre = nombreCorto(x.nombre);
  return `${i + 1}. <b>${escapaHtml(x.symbol)}</b>${nombre ? ' · ' + escapaHtml(nombre) : ''}  ${pct(x.pct)}`;
}

/**
 * indices: [{ nombre, precio, pct }] · suben/bajan: de `eligeMovimientos`
 * sectores: de `eligeSectores`
 */
export function textoCierre({ fecha, indices = [], suben = [], bajan = [], sectores = {}, env } = {}) {
  const idx = indices.filter((f) => f && Number.isFinite(f.precio) && Number.isFinite(f.pct));
  if (!idx.length && !suben.length && !bajan.length) return null;
  const l = [`🔔 <b>Cierre del mercado</b> · ${escapaHtml(fechaLarga(fecha))}`, ''];
  for (const f of idx) l.push(`${flecha(f.pct)} ${escapaHtml(f.nombre)}: ${numero(f.precio)} (${pct(f.pct)})`);
  if (idx.length) l.push('');
  if (suben.length) { l.push('<b>Las que más subieron</b>', ...suben.map(renglonEmisora), ''); }
  if (bajan.length) { l.push('<b>Las que más bajaron</b>', ...bajan.map(renglonEmisora), ''); }
  if (sectores && sectores.mejor && sectores.peor) {
    l.push('<b>Sectores</b>',
      `Mejor: ${escapaHtml(sectores.mejor.nombre)} (${pct(sectores.mejor.pct)})`,
      `Peor: ${escapaHtml(sectores.peor.nombre)} (${pct(sectores.peor.pct)})`);
  }
  return cierra(l, '/mercado', env);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. MIS ACCIONES
// ═══════════════════════════════════════════════════════════════════════
const accion = (symbol) => MIS_ACCIONES.find((a) => a.symbol === symbol) || { symbol, nombre: symbol, alias: [] };
const titulo = (symbol) => {
  const a = accion(symbol);
  return a.nombre && a.nombre !== symbol ? `${escapaHtml(symbol)} (${escapaHtml(a.nombre)})` : escapaHtml(symbol);
};

// ── 3a. Se movió más de 5% ───────────────────────────────────────────
export const claveMovimiento = (symbol, fecha, sube) => `mov:${symbol}:${fecha}:${sube ? 'sube' : 'baja'}`;

/**
 * ¿Se movió más del umbral HOY? Devuelve el movimiento o null.
 *
 * Con el mercado abierto se usa el último precio; ya cerrado, el cierre del
 * día. Y la barra tiene que ser de la sesión de hoy: sin eso, un lunes
 * temprano estaría midiendo el viernes.
 */
export function movimientoDelDia(symbol, snap, { sesion, abierto, umbral = UMBRAL_MOVIMIENTO_PCT } = {}) {
  if (!snap || snap.day_fecha !== sesion) return null;
  const precio = abierto ? Number(snap.price) : Number(snap.day_close);
  const p = cambioPct(precio, Number(snap.prev_close));
  if (p == null || Math.abs(p) < umbral) return null;
  return { symbol, pct: p, precio, previo: Number(snap.prev_close), abierto: !!abierto, sube: p > 0 };
}

export function textoMovimiento(m, { env } = {}) {
  if (!m) return null;
  const verbo = m.sube ? 'sube' : 'baja';
  return cierra([
    `${m.sube ? '🚀' : '📉'} <b>${escapaHtml(m.symbol)} ${verbo} ${Math.abs(m.pct).toFixed(1)}% hoy</b>`,
    `${accion(m.symbol).nombre !== m.symbol ? escapaHtml(accion(m.symbol).nombre) + ' ' : ''}${m.abierto ? 'va en' : 'cerró en'} US$${numero(m.precio)}. Ayer cerró en US$${numero(m.previo)}.`,
  ], `/analiza/${encodeURIComponent(m.symbol)}`, env);
}

// ── 3b. Un insider compró o vendió ───────────────────────────────────
export const claveInsider = (accession, tipo) => `insider:${accession}:${tipo}`;

/**
 * Las filas de un Form 4 → un resumen por (filing, compra|venta).
 *
 * SÓLO compras y ventas en el mercado (códigos P y S) de acciones comunes.
 * Otorgamientos, ejercicios de opciones y acciones retenidas para impuestos
 * no son alguien decidiendo comprar o vender, y no avisan.
 */
export function resumenesDeInsider(filas = [], simbolos = MIS_ACCIONES.map((a) => a.symbol)) {
  const quiero = new Set(simbolos);
  const grupos = new Map();
  for (const f of filas || []) {
    const ticker = String((f && f.ticker) || '').toUpperCase();
    if (!quiero.has(ticker) || f.derivada) continue;
    if (f.tipo !== 'compra' && f.tipo !== 'venta') continue;
    if (!(Number(f.acciones) > 0)) continue;
    const k = `${f.accession}|${f.tipo}`;
    const g = grupos.get(k) || {
      accession: f.accession, symbol: ticker, tipo: f.tipo, quien: f.quien || null, cargo: f.cargo || null,
      acciones: 0, valor: 0, con_valor: true, fecha: f.fecha || null,
      programada: f.plan_estado === 'programada', link: f.link || null,
    };
    g.acciones += Number(f.acciones);
    if (Number.isFinite(Number(f.valor)) && f.valor != null) g.valor += Number(f.valor); else g.con_valor = false;
    if (f.fecha && (!g.fecha || f.fecha > g.fecha)) g.fecha = f.fecha;
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => ({
    ...g,
    valor: g.con_valor && g.valor > 0 ? g.valor : null,
    precio: g.con_valor && g.valor > 0 ? g.valor / g.acciones : null,
  }));
}

export function textoInsider(r, { env } = {}) {
  if (!r || !r.symbol || !(r.acciones > 0)) return null;
  const compra = r.tipo === 'compra';
  const quien = r.quien ? escapaHtml(r.quien) + (r.cargo ? ` (${escapaHtml(r.cargo)})` : '') : 'Un directivo de la empresa';
  const monto = r.valor ? `, unos ${dinero(r.valor)}${r.precio ? ` (a US$${numero(r.precio)} cada una en promedio)` : ''}` : '';
  return cierra([
    `${compra ? '🟢' : '🔴'} <b>Alguien de adentro ${compra ? 'compró' : 'vendió'} ${titulo(r.symbol)}</b>`,
    `${quien} ${compra ? 'compró' : 'vendió'} ${numero(r.acciones, 0)} acciones${monto}.`,
    r.fecha ? `Fecha de la operación: ${escapaHtml(fechaLarga(r.fecha))}.` : null,
    r.programada && !compra ? 'Era una venta programada con anticipación, no una decisión de último momento.' : null,
    r.link ? `<a href="${escapaHtml(r.link)}">Ver el aviso oficial en la SEC</a>` : null,
  ], '/mercado/insiders', env);
}

// ── 3c. Salió una noticia importante ─────────────────────────────────
export const claveNoticia = (symbol, tituloNorm) => `noticia:${symbol}:${huella(tituloNorm)}`;

/** ¿De cuál de mis acciones habla esta nota? Por ticker etiquetado o por nombre. */
export function accionDeNoticia(nota, acciones = MIS_ACCIONES) {
  const tickers = new Set((nota.tickers || []).map((t) => String(t).toUpperCase()));
  const titular = String(nota.titular || '');
  for (const a of acciones) {
    if (tickers.has(a.symbol)) return a.symbol;
    if (a.alias.some((al) => new RegExp(`(?<![\\p{L}\\d])${al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'iu').test(titular))) return a.symbol;
  }
  return null;
}

export function textoNoticia({ symbol, titular, fuente, url } = {}, { env } = {}) {
  if (!symbol || !String(titular || '').trim()) return null;
  return cierra([
    `📰 <b>Noticia de ${titulo(symbol)}</b>`,
    escapaHtml(String(titular).trim()),
    fuente ? `Fuente: ${escapaHtml(fuente)}` : null,
    url ? `<a href="${escapaHtml(url)}">Leer la nota</a>` : null,
  ], `/analiza/${encodeURIComponent(symbol)}`, env);
}

// ── 3d. La empresa le avisó algo importante a la SEC (8-K) ───────────
// Un 8-K es el aviso que una empresa está OBLIGADA a presentar cuando pasa
// algo relevante. Es la definición más objetiva de "noticia importante" que
// hay, y se puede decir en español sin traducir nada: cada número de sección
// significa una cosa.
export const AVISOS_8K = {
  '1.01': 'firmó un acuerdo importante',
  '1.02': 'terminó un acuerdo importante',
  '1.03': 'entró en proceso de quiebra',
  '1.05': 'reportó un incidente de ciberseguridad',
  '2.01': 'completó la compra o venta de un negocio',
  '2.02': 'publicó sus resultados financieros',
  '2.03': 'tomó una deuda nueva',
  '2.05': 'anunció recortes o una reestructura',
  '2.06': 'reconoció una pérdida de valor en sus activos',
  '3.01': 'recibió un aviso de que podría salir de la bolsa',
  '3.02': 'vendió acciones nuevas de forma privada',
  '4.01': 'cambió de auditor',
  '4.02': 'avisó que sus estados financieros anteriores ya no son confiables',
  '5.01': 'cambió de dueño o de control',
  '5.02': 'anunció cambios en sus directivos o consejeros',
  '5.03': 'cambió sus estatutos',
  '5.07': 'publicó cómo votaron sus accionistas',
  '7.01': 'compartió información nueva con los inversionistas',
  '8.01': 'reportó otro evento que considera relevante',
};
export const clave8K = (accession) => `8k:${accession}`;

/** `submissions.json` de la SEC → los 8-K desde `desde`, con lo que avisan. */
export function avisosDeSubmissions(sub, { symbol, cik, desde } = {}) {
  const r = sub && sub.filings && sub.filings.recent;
  if (!r || !Array.isArray(r.form)) return [];
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    if (String(r.form[i]) !== '8-K') continue;
    const fecha = String((r.filingDate || [])[i] || '');
    if (desde && fecha < desde) continue;
    const items = String((r.items || [])[i] || '').split(',').map((x) => x.trim()).filter((c) => AVISOS_8K[c]);
    if (!items.length) continue;      // sólo anexos, o secciones sin lectura clara
    const accession = String((r.accessionNumber || [])[i] || '');
    const doc = String((r.primaryDocument || [])[i] || '');
    if (!accession) continue;
    const carpeta = `https://www.sec.gov/Archives/edgar/data/${parseInt(String(cik), 10)}/${accession.replace(/-/g, '')}`;
    out.push({ symbol, accession, fecha, items, url: doc ? `${carpeta}/${doc}` : `${carpeta}/` });
  }
  return out;
}

export function texto8K(a, { env } = {}) {
  if (!a || !a.symbol || !(a.items || []).length) return null;
  const que = a.items.map((c) => AVISOS_8K[c]).filter(Boolean);
  if (!que.length) return null;
  const lista = que.length === 1 ? que[0] : `${que.slice(0, -1).join(', ')} y ${que[que.length - 1]}`;
  return cierra([
    `📣 <b>Aviso oficial de ${titulo(a.symbol)}</b>`,
    `La empresa le avisó al regulador de EE.UU. (la SEC) que ${lista}.`,
    a.url ? `<a href="${escapaHtml(a.url)}">Leer el aviso</a>` : null,
  ], `/analiza/${encodeURIComponent(a.symbol)}`, env);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. LA VÍSPERA: Fed, inflación, empleo
// ═══════════════════════════════════════════════════════════════════════
export const VISPERAS = {
  fed: {
    nombre: 'decisión de la Fed',
    que: 'La Reserva Federal (el banco central de Estados Unidos) anuncia si sube, baja o deja igual la tasa de interés.',
    porque: 'Cuando la tasa baja, pedir prestado cuesta menos y las acciones suelen subir; cuando sube o se queda alta más tiempo, suelen bajar. También mueve al dólar y al peso.',
  },
  inflacion: {
    nombre: 'dato de inflación de EE.UU.',
    que: 'Sale el dato que mide cuánto subieron los precios en Estados Unidos el mes pasado.',
    porque: 'Si la inflación sale más alta de lo esperado, la Fed tiene menos espacio para bajar las tasas y el mercado suele caer. Si sale más baja, suele subir.',
  },
  empleo: {
    nombre: 'reporte de empleo de EE.UU.',
    que: 'Sale el reporte de cuántos empleos se crearon en Estados Unidos el mes pasado y cómo quedó el desempleo.',
    porque: 'Dice qué tan fuerte está la economía. Un dato muy débil asusta por riesgo de recesión; uno muy fuerte puede retrasar las bajas de tasas. En los dos casos el mercado se mueve.',
  },
};

/** fed | inflacion | empleo | null. Por categoría, y por título para lo curado a mano. */
export function categoriaDeEvento(e) {
  const c = String((e && e.category) || '').trim().toLowerCase();
  if (VISPERAS[c]) return c;
  const t = String((e && e.title) || '');
  if (/\b(fomc|fed|reserva federal)\b/i.test(t) && /decisi[oó]n|tasa|fomc/i.test(t)) return 'fed';
  if (/\b(cpi|inflaci[oó]n)\b/i.test(t) && /ee\.?\s?uu|estados unidos|\bcpi\b/i.test(t)) return 'inflacion';
  if (/n[oó]minas|nonfarm|payrolls?|empleo de ee/i.test(t)) return 'empleo';
  return null;
}
export const claveVispera = (categoria, fechaEvento) => `vispera:${categoria}:${fechaEvento}`;

/**
 * Los eventos que tocan ANTES de la próxima sesión: después de hoy y hasta el
 * siguiente día hábil inclusive. Un viernes avisa lo del lunes; un día normal,
 * lo de mañana. Uno por categoría y fecha.
 */
export function eventosDeVispera(eventos = [], hoy, proximaSesion) {
  const vistos = new Set();
  const out = [];
  for (const e of eventos || []) {
    const fecha = String((e && e.event_date) || '').slice(0, 10);
    const categoria = categoriaDeEvento(e);
    if (!categoria || !(fecha > hoy) || !(fecha <= proximaSesion)) continue;
    const k = claveVispera(categoria, fecha);
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ categoria, fecha, evento: e });
  }
  return out;
}

const DIA_MS = 86400000;
export function textoVispera({ categoria, fecha, evento = null, hoy } = {}, { env } = {}) {
  const v = VISPERAS[categoria];
  if (!v || !fecha) return null;
  const dias = Math.round((Date.parse(`${fecha}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / DIA_MS);
  const cuando = dias === 1 ? 'Mañana' : `El ${diaDeLaSemana(fecha)}`;
  const h = horaDeEvento(evento);
  return cierra([
    `⏰ <b>${cuando}: ${escapaHtml(v.nombre)}</b>`,
    `${escapaHtml(mayuscula(fechaLarga(fecha)))}${h ? ', ' + h : ''}`,
    '',
    `<b>Qué es:</b> ${escapaHtml(v.que)}`,
    `<b>Por qué importa:</b> ${escapaHtml(v.porque)}`,
  ], '/mercado', env);
}
