// ═══════════════════════════════════════════════════════════════════
// api/_lib/pead-hour.js — hora del anuncio (BMO/AMC) para el backtest PEAD.
//
// AV da la FECHA del anuncio pero no la HORA, y la hora define "el día 1"
// (docs/pead-backtest-scope.md §2.3). Fuente de verdad: el timestamp de
// aceptación del 8-K Item 2.02 (Results of Operations) en SEC EDGAR — gratis
// e ilimitado, corre en paralelo al goteo de AV.
//
// Regla escalonada de respaldo (§ "Cruce SEC 8-K"):
//   1) 8-K Item 2.02 (verdad de campo) → classifyHourFromET
//   2) sin 8-K → heurística de gap overnight (causal, sin look-ahead)
//   3) ambiguo (sin reacción) → se deja null; el gate Y lo descarta igual
//
// Las funciones de clasificación son JS puro y testeable (sin red).
// ═══════════════════════════════════════════════════════════════════

import { SEC_UA, loadTickerMap, loadSubmissions } from '../sec-edgar.js';

const MARKET_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const MARKET_CLOSE_MIN = 16 * 60;    // 16:00 ET

// El acceptanceDateTime de SEC representa hora del Este. Extraemos HH:MM del
// string directamente (sin construir Date) para no aplicar zona horaria local.
function classifyHourFromET(acceptanceDateTime) {
  if (!acceptanceDateTime || typeof acceptanceDateTime !== 'string') return null;
  const m = acceptanceDateTime.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (minutes < MARKET_OPEN_MIN) return 'bmo';
  if (minutes >= MARKET_CLOSE_MIN) return 'amc';
  return 'dmh';
}

function dayDiff(a, b) {
  const da = Date.parse(a + 'T00:00:00Z');
  const db = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.round((da - db) / 86400000);
}

// Índice de 8-K Item 2.02 a partir de un objeto de arrays paralelos de EDGAR
// (recent o un archivo de overflow): {form[], items[], acceptanceDateTime[],
// filingDate[], accessionNumber[]}.
function build8KIndex(recentLike) {
  const out = [];
  if (!recentLike || !Array.isArray(recentLike.form)) return out;
  const { form, items, acceptanceDateTime, filingDate, accessionNumber } = recentLike;
  for (let i = 0; i < form.length; i++) {
    if ((form[i] || '').toUpperCase() !== '8-K') continue;
    const itemStr = (items && items[i]) || '';
    if (!itemStr.split(/[,;]/).map((s) => s.trim()).includes('2.02')) continue;
    out.push({
      filingDate: filingDate ? filingDate[i] : null,
      acceptanceDateTime: acceptanceDateTime ? acceptanceDateTime[i] : null,
      accession: accessionNumber ? accessionNumber[i] : null,
    });
  }
  return out;
}

// Casa un evento (reportedDate) con el 8-K más cercano dentro de ±tolerancia.
function match8K(index, reportedDate, toleranceDays = 1) {
  let best = null;
  let bestAbs = Infinity;
  for (const f of index) {
    if (!f.filingDate) continue;
    const d = Math.abs(dayDiff(f.filingDate, reportedDate));
    if (d <= toleranceDays && d < bestAbs) {
      best = f;
      bestAbs = d;
    }
  }
  return best;
}

// Heurística de respaldo (causal): compara el gap overnight HACIA el día del
// anuncio D vs hacia D+1. Gap mayor hacia D ⇒ BMO; mayor hacia D+1 ⇒ AMC.
// Ambos precios ya se conocen en el punto de entrada de cada rama → sin
// look-ahead. `eps` = umbral mínimo para considerar que hubo reacción.
function gapHeuristic({ closePrev, openD, closeD, openD1 }, eps = 0.005) {
  if (![closePrev, openD, closeD, openD1].every((x) => typeof x === 'number' && x > 0)) return null;
  const gapIntoD = Math.abs(openD / closePrev - 1);
  const gapIntoD1 = Math.abs(openD1 / closeD - 1);
  if (gapIntoD < eps && gapIntoD1 < eps) return null; // sin reacción → ambiguo
  if (gapIntoD === gapIntoD1) return null;
  return gapIntoD > gapIntoD1 ? 'bmo' : 'amc';
}

// ─────────────────── I/O: recolección de 8-Ks de un emisor ───────────────────

async function fetchFilingFile(name) {
  const r = await fetch(`https://data.sec.gov/submissions/${name}`, {
    headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// Junta todos los 8-K Item 2.02 de un emisor desde `sinceDate`, caminando
// `recent` + los archivos de overflow (historia profunda) sólo mientras hagan
// falta. SEC es ilimitado, pero acotamos por fecha para no traer 20 años.
async function collect8Ks(paddedCik, sinceDate) {
  const submissions = await loadSubmissions(paddedCik);
  const filings = submissions && submissions.filings;
  if (!filings) return [];
  let index = build8KIndex(filings.recent);

  // Overflow: archivos extra con filings viejos. Solo los que solapan la ventana.
  const files = (filings.files || []).filter((f) => !f.filingTo || dayDiff(f.filingTo, sinceDate) >= 0);
  for (const f of files) {
    const extra = await fetchFilingFile(f.name);
    if (extra) index = index.concat(build8KIndex(extra));
  }
  return index;
}

export {
  classifyHourFromET,
  build8KIndex,
  match8K,
  gapHeuristic,
  dayDiff,
  collect8Ks,
  loadTickerMap,
};
