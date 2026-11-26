// ═══════════════════════════════════════════════════════════════════════
// api/_lib/alertas-fuentes.js — DE DÓNDE SALE cada dato de las alertas.
//
// Sólo lectura. Cada función lee UNA fuente que ya existía en QuantDesk y la
// entrega en la forma que `alertas.js` espera. Ninguna inventa: si la fuente
// no contesta, lanza o devuelve vacío, y el mensaje omite esa parte.
//
//   · futuros e índices ........ Yahoo (el mismo quote que la cinta, /api/tape)
//   · sesión de hoy ............ calendario de Alpaca
//   · cierres, sectores, 5% .... snapshots de Alpaca (con la FECHA de la barra)
//   · universo ................. neon:mercado_universo_us
//   · calendario macro ......... neon:macro_events + _lib/macro-oficial.js
//   · reportes de hoy .......... /api/earnings?mega=1, en proceso
//   · insiders ................. neon:mercado_form4_tx (lo llena stock-tracker)
//   · noticias ................. neon:mercado_noticias (lo llena /api/noticias)
//   · avisos 8-K ............... data.sec.gov/submissions
// ═══════════════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { getCalendar, getSnapshots } from './alpaca.js';
import { oficialesEntre, unirMacro, horaCdmx } from './macro-oficial.js';
import { crearCliente, bajarTickerMap, urlSubmissions } from './edgar.js';
import { tickersDeFila, tituloNormalizado } from './noticias.js';
import { leeConfig, guardaConfig } from './telegram.js';
import { extractQuote } from '../tape.js';
import earningsHandler from '../earnings.js';
import {
  MIS_ACCIONES, SECTORES, fechaNuevaYork, avisosDeSubmissions, accionDeNoticia,
} from './alertas.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const sumaDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ── YAHOO: futuros e índices ─────────────────────────────────────────
export const FUTUROS = [
  { symbol: 'ES=F', nombre: 'S&P 500' },
  { symbol: 'NQ=F', nombre: 'Nasdaq' },
];
export const INDICES = [
  { symbol: '^GSPC', nombre: 'S&P 500' },
  { symbol: '^IXIC', nombre: 'Nasdaq' },
];

/**
 * El quote de la cinta (precio contra cierre previo) + la FECHA del precio.
 * Devuelve sólo los que contestaron; el que falla se omite.
 */
export async function cotizaYahoo(lista, { fetchImpl = globalThis.fetch } = {}) {
  const out = await Promise.all(lista.map(async ({ symbol, nombre }) => {
    try {
      const r = await fetchImpl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
        { headers: UA, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      const q = extractQuote(j);
      const t = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta
        && j.chart.result[0].meta.regularMarketTime;
      if (!q) return null;
      return {
        symbol, nombre, precio: q.price, pct: q.changePct,
        fecha: Number.isFinite(t) ? fechaNuevaYork(new Date(t * 1000)) : null,
      };
    } catch (e) { return null; }
  }));
  return out.filter(Boolean);
}

// ── ALPACA: la sesión ────────────────────────────────────────────────
/**
 * ¿Hoy abre el mercado? Y cuál es la sesión que sigue.
 * `hoy` es la fecha de Nueva York. Las horas de apertura y cierre se entregan
 * en hora de Monterrey (la misma que la de la Ciudad de México).
 */
export async function sesionDe(ahora = new Date(), { calendario = getCalendar } = {}) {
  const hoy = fechaNuevaYork(ahora);
  const dias = await calendario(hoy, sumaDias(hoy, 10));
  const filas = (Array.isArray(dias) ? dias : []).map((d) => ({ ...d, date: String(d.date).slice(0, 10) }));
  const fila = filas.find((d) => d.date === hoy) || null;
  const proxima = filas.find((d) => d.date > hoy) || null;
  const instante = (hhmm) => {
    for (const desfase of [5, 4]) {
      const [h, m] = String(hhmm).split(':').map(Number);
      const d = new Date(`${hoy}T00:00:00Z`);
      d.setUTCHours(h + desfase, m);
      const ny = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
      if (ny === String(hhmm).padStart(5, '0')) return d;
    }
    return null;
  };
  const abre = fila ? instante(fila.open) : null;
  const cierra = fila ? instante(fila.close) : null;
  return {
    hoy,
    habil: !!fila,
    proxima: proxima ? proxima.date : null,
    abre_hora: fila ? horaCdmx(hoy, String(fila.open).padStart(5, '0')) : null,
    ya_abrio: !!(abre && ahora >= abre),
    abierto: !!(abre && cierra && ahora >= abre && ahora < cierra),
    ya_cerro: !!(cierra && ahora >= cierra),
  };
}

// ── ALPACA: precios con la fecha de su barra ─────────────────────────
export async function fotos(symbols, { snapshots = getSnapshots } = {}) {
  const crudo = await snapshots(symbols);
  const out = {};
  for (const [sym, s] of Object.entries(crudo || {})) {
    out[sym] = { ...s, day_fecha: s.day_t ? fechaNuevaYork(new Date(s.day_t)) : null };
  }
  return out;
}

// Las empresas GRANDES del universo de QuantDesk. El piso de capitalización
// existe porque el universo incluye hasta 100 "movidas del día", que son
// justo las chiquitas que suben 40% con cuatro operaciones: sin piso, el top 3
// del cierre sería una lista de acciones de centavos.
export const PISO_CAP_USD = 10e9;
export async function universoGrande(piso = PISO_CAP_USD) {
  return sql(
    `select symbol, nombre, sector_etf from mercado_universo_us
      where market_cap >= $1 order by market_cap desc`, [piso]);
}
export const ETFS_DE_SECTOR = Object.keys(SECTORES);

// ── EL CALENDARIO ────────────────────────────────────────────────────
/** Lo curado a mano + las fechas oficiales (Fed y BLS), entre dos fechas. */
export async function calendarioMacro(desde, hasta) {
  const oficiales = oficialesEntre(desde, hasta);
  const curadas = await sql(
    `select to_char(event_date,'YYYY-MM-DD') as event_date, title, category, importance, note
       from macro_events
      where event_date >= $1::date and event_date <= $2::date
      order by event_date asc, importance desc, title asc limit 100`, [desde, hasta])
    .catch(() => []);
  return unirMacro(curadas, oficiales);
}

/** Las empresas grandes que reportan resultados ese día. Llama al handler en proceso. */
export async function reportesDe(fecha, { handler = earningsHandler } = {}) {
  let code = 200;
  let body = null;
  const res = {
    setHeader() {}, getHeader() { return undefined; },
    status(c) { code = c; return this; }, json(o) { body = o; return this; },
    send(o) { body = o; return this; }, end() { return this; },
  };
  let reloj = null;
  try {
    await Promise.race([
      Promise.resolve(handler({ method: 'GET', query: { mega: '1', from: fecha, to: fecha }, headers: {}, url: '/' }, res)),
      new Promise((_, no) => { reloj = setTimeout(() => no(new Error('tardó demasiado')), 8000); }),
    ]);
  } catch (e) { return []; } finally { if (reloj) clearTimeout(reloj); }
  if (code !== 200 || !body) return [];
  return (body.earnings || []).filter((e) => e && e.date === fecha);
}

// ── INSIDERS ─────────────────────────────────────────────────────────
/** Las filas de Form 4 de mis acciones, de los últimos `dias`. */
export async function insidersRecientes(simbolos, dias = 5) {
  const filas = await sql(
    `select accession, filas from mercado_form4_tx
      where filing_fecha >= current_date - $1::int
        and exists (select 1 from jsonb_array_elements(filas) f
                     where upper(f->>'ticker') = any($2::text[]))
      order by filing_fecha asc limit 200`, [dias, simbolos]);
  return filas.flatMap((r) => (Array.isArray(r.filas) ? r.filas : [])
    .map((f) => ({ ...f, accession: f.accession || r.accession })));
}

// ── NOTICIAS ─────────────────────────────────────────────────────────
/** Los titulares de las últimas `horas` que hablan de mis acciones. */
export async function noticiasRecientes(acciones = MIS_ACCIONES, horas = 18) {
  const simbolos = acciones.map((a) => a.symbol);
  const patrones = acciones.flatMap((a) => a.alias.map((al) => `%${al}%`));
  const filas = await sql(
    `select url, titular, titulo_norm, fuente_nombre, publicado_en, tickers
       from mercado_noticias
      where publicado_en >= now() - ($1 || ' hours')::interval
        and (tickers && $2::text[] or titular ilike any($3::text[]))
      order by publicado_en asc limit 100`, [String(horas), simbolos, patrones]);
  return filas
    .map((n) => ({ ...n, tickers: tickersDeFila(n.tickers) }))
    .map((n) => ({ ...n, symbol: accionDeNoticia(n, acciones), titulo_norm: n.titulo_norm || tituloNormalizado(n.titular) }))
    .filter((n) => n.symbol);
}

// ── AVISOS 8-K ───────────────────────────────────────────────────────
// El CIK de cada emisora no cambia: se busca una vez en el mapa de la SEC
// (~1 MB) y se guarda en `alertas_config`, para no bajar ese archivo cada 10
// minutos.
async function cikDe(symbol, cli) {
  const clave = `cik:${symbol}`;
  const guardado = await leeConfig(clave).catch(() => null);
  if (guardado) return guardado;
  const { map } = await bajarTickerMap(cli);
  const hallado = map[symbol] && map[symbol].cik;
  if (hallado) await guardaConfig(clave, hallado).catch(() => {});
  return hallado || null;
}

export async function avisosRecientes(simbolos, { desde, cliente = null } = {}) {
  const cli = cliente || crearCliente({ timeoutMs: 8000, reintentos: 1 });
  const out = [];
  const fallas = [];
  for (const symbol of simbolos) {
    try {
      const cik = await cikDe(symbol, cli);
      if (!cik) { fallas.push({ symbol, motivo: 'sin CIK en el mapa de la SEC' }); continue; }
      const { json } = await cli.json(urlSubmissions(cik), { kind: 'submissions' });
      out.push(...avisosDeSubmissions(json, { symbol, cik, desde }));
    } catch (e) {
      fallas.push({ symbol, motivo: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return { avisos: out, fallas };
}
