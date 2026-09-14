// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-watch-events.js — los EVENTOS DEL DÍA del vigilante.
//
// Dos de los seis disparadores (cadencia #2) no son de precio sino de HECHO: la
// empresa reporta HOY, o presentó un 8-K hoy. Este módulo los resuelve, y es la
// única parte del vigilante que sale a la red por algo que no es una cotización.
//
// ── POR QUÉ CACHEADO EN NEON Y NO POR TICK ───────────────────────────
// El vigilante corre cada 5 minutos: resolver earnings + 8-K de ~40 símbolos en
// CADA tick serían ~4,700 requests a SEC por sesión, para una respuesta que
// cambia como mucho un puñado de veces al día. Se refresca cada
// ARENA_WATCH_EVENTS_TTL_MIN (default 30) y se guarda en Neon, así que:
//   - una lambda FRÍA no re-escanea (el cache vive en la DB, no en memoria);
//   - un 8-K presentado a media mañana se detecta dentro de la media hora;
//   - la carga contra SEC queda en ~13 refrescos por sesión.
//
// ── FUENTES ──────────────────────────────────────────────────────────
//   earnings → /api/earnings (nuestro propio endpoint, ya cacheado en el edge).
//              Solo cuenta el reporte de HOY: BMO (repreció en el open) o AMC
//              (repreciará en el cierre, y el PM puede querer salir ANTES).
//   8-K      → SEC EDGAR, submissions por CIK. Es la fuente autoritativa y
//              gratis; el mismo camino que ya usa _lib/pead-hour.js. Se cuenta
//              un 8-K cuyo acceptanceDateTime cae HOY en horario del Este.
//
// TODO es BEST-EFFORT: una fuente caída devuelve vacío y el disparador
// simplemente no pega. Jamás inventa un evento — el resto del vigilante (precio,
// stops, volumen) sigue funcionando sin esto.
//
// ENV VARS: ARENA_WATCH_EVENTS_TTL_MIN (opc, default 30)
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { SEC_UA, loadTickerMap } from '../sec-edgar.js';

const up = (s) => String(s || '').trim().toUpperCase();

export function eventsTtlMinutes() {
  const v = Number(process.env.ARENA_WATCH_EVENTS_TTL_MIN);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

// ── EARNINGS DE HOY ──────────────────────────────────────────────────
// Se pide la ventana de un solo día a nuestro endpoint. `time` viaja tal cual
// (BMO/AMC/TBD): el PM decide distinto si el número ya salió o si sale al
// cierre, y esa distinción es suya, no nuestra.
export async function fetchEarningsToday(baseUrl, today) {
  try {
    const r = await fetch(`${baseUrl}/api/earnings?from=${today}&to=${today}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return {};
    const data = await r.json();
    const out = {};
    for (const e of (data && data.earnings) || []) {
      const sym = up(e && e.ticker);
      if (!sym || String(e.date || '').slice(0, 10) !== today) continue;
      out[sym] = {
        date: today, time: e.time || null,
        eps_est: e.eps_est ?? null, eps_actual: e.eps_actual ?? null,
        revenue_est: e.revenue_est ?? null, revenue_actual: e.revenue_actual ?? null,
      };
    }
    return out;
  } catch (err) { return {}; }
}

// ── 8-K DE HOY ───────────────────────────────────────────────────────
// Fetch DIRECTO a submissions (no se reusa `loadSubmissions` de sec-edgar.js a
// propósito: su cache en memoria es de 6 horas, pensado para 10-K/10-Q, y con
// él un 8-K presentado a media mañana podría no verse hasta la tarde. Acá la
// frescura es el punto, y el cache que corresponde es el de Neon, de 30 min).
async function submissionsFor(paddedCik) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, {
    headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('SEC submissions HTTP ' + r.status);
  return r.json();
}

// Concurrencia acotada: SEC tolera 10 req/s, pero el vigilante comparte la
// lambda con las corridas que despierta. 5 en paralelo resuelve ~40 símbolos en
// un par de segundos sin acercarse al límite.
const SEC_CONCURRENCY = 5;

// ¿Presentó un 8-K con fecha de aceptación de HOY (ET)? Devuelve
// { SYMBOL: { filed_at, items, accession } } solo para los que sí.
export async function fetch8KToday(symbols = [], today) {
  const wanted = [...new Set(symbols.map(up).filter(Boolean))];
  if (!wanted.length) return {};
  let tickerMap = null;
  try { tickerMap = await loadTickerMap(); } catch (err) { return {}; }
  if (!tickerMap) return {};

  const out = {};
  const queue = [...wanted];
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      const hit = tickerMap[sym];
      if (!hit || !hit.cik) continue;
      try {
        const data = await submissionsFor(String(hit.cik).padStart(10, '0'));
        const recent = (data && data.filings && data.filings.recent) || null;
        if (!recent || !Array.isArray(recent.form)) continue;
        for (let i = 0; i < recent.form.length; i++) {
          if (String(recent.form[i] || '').toUpperCase() !== '8-K') continue;
          // `acceptanceDateTime` ya viene en horario del Este: se compara el
          // prefijo de fecha directamente, sin construir un Date (que aplicaría
          // la zona local de la lambda y correría el día).
          const accepted = String((recent.acceptanceDateTime && recent.acceptanceDateTime[i]) || '');
          const filed = String((recent.filingDate && recent.filingDate[i]) || '');
          if (accepted.slice(0, 10) !== today && filed.slice(0, 10) !== today) continue;
          out[sym] = {
            filed_at: accepted || filed || null,
            items: (recent.items && recent.items[i]) || null,
            accession: (recent.accessionNumber && recent.accessionNumber[i]) || null,
          };
          break; // el más reciente manda; las `recent` vienen ordenadas
        }
      } catch (err) { /* un símbolo que falla no tumba al resto */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEC_CONCURRENCY, wanted.length) }, worker));
  return out;
}

// ── CACHE EN NEON ────────────────────────────────────────────────────
// Lee lo guardado para HOY. Devuelve { events, refreshed_at } con la forma que
// consume `evaluateTriggers`: { SYMBOL: { earnings, filing_8k } }.
export async function readDayEvents(today) {
  const rows = await sql(
    `select symbol, kind, detail, seen_at from arena_watch_events where run_date = $1`, [today]);
  const events = {};
  let refreshed_at = null;
  for (const r of rows) {
    const sym = up(r.symbol);
    if (!events[sym]) events[sym] = { earnings: null, filing_8k: null };
    if (r.kind === 'earnings') events[sym].earnings = r.detail;
    if (r.kind === '8k') events[sym].filing_8k = r.detail;
    if (!refreshed_at || r.seen_at > refreshed_at) refreshed_at = r.seen_at;
  }
  return { events, refreshed_at };
}

// ¿Toca refrescar? Se guarda una marca aparte (y no se deduce de `seen_at` de
// los eventos) porque un día SIN ningún earnings ni 8-K no deja filas — y sin
// marca propia se re-escanearía SEC en cada tick justo los días tranquilos.
export async function eventsRefreshDue(today, now = new Date()) {
  const rows = await sql(`select value from arena_watch_meta where key = $1`, ['events_refreshed:' + today]);
  const at = rows[0] && rows[0].value && rows[0].value.at ? Date.parse(rows[0].value.at) : null;
  if (!Number.isFinite(at)) return true;
  return (now.getTime() - at) >= eventsTtlMinutes() * 60000;
}

// Refresca y persiste. Idempotente por (run_date, symbol, kind): un evento que
// sigue vigente se re-escribe con el mismo contenido, no se duplica.
export async function refreshDayEvents({ baseUrl, symbols = [], today, now = new Date() } = {}) {
  const [earnings, filings] = await Promise.all([
    fetchEarningsToday(baseUrl, today),
    fetch8KToday(symbols, today),
  ]);
  const writes = [];
  for (const [sym, detail] of Object.entries(earnings)) {
    // El calendario trae TODO el mercado; solo interesan los nombres vigilados.
    if (!symbols.includes(sym)) continue;
    writes.push([sym, 'earnings', detail]);
  }
  for (const [sym, detail] of Object.entries(filings)) writes.push([sym, '8k', detail]);

  for (const [symbol, kind, detail] of writes) {
    try {
      await sql(
        `insert into arena_watch_events (run_date, symbol, kind, detail, seen_at)
         values ($1,$2,$3,$4,$5)
         on conflict (run_date, symbol, kind) do update set detail = excluded.detail`,
        [today, symbol, kind, JSON.stringify(detail), now.toISOString()]);
    } catch (err) { /* best-effort: un evento perdido no frena al vigilante */ }
  }
  try {
    await sql(
      `insert into arena_watch_meta (key, value, updated_at) values ($1,$2,$3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      ['events_refreshed:' + today, JSON.stringify({ at: now.toISOString(), symbols: symbols.length }), now.toISOString()]);
  } catch (err) { /* ídem */ }

  return { earnings: Object.keys(earnings).length, filings_8k: Object.keys(filings).length, scanned: symbols.length };
}
