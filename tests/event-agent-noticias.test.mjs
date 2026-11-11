// ═══════════════════════════════════════════════════════════════
// Event Agent · clasificación de noticias (Lety, 2026-11-11).
// Casos reales que salían mal:
//   • FUN: "Six Flags Reports $366 Million in Losses…" como merger
//     (el resumen recordaba la fusión con Cedar Fair).
//   • FUN: "Big Banks Earn Billions, Bumble Soars on Buyout" como
//     M&A de Six Flags (nota de mercado general).
//   • NVDA: "…Doesn't Settle It" como regulatorio por 'settle'.
// Sin red. Correr con `node tests/event-agent-noticias.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { categorizeNews, hablaDeLaEmpresa, palabrasDeEmpresa } from '../api/event-agent.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const AHORA = Date.parse('2026-11-11T16:00:00Z');
const nota = (headline, summary = '', dia = '2026-11-07') =>
  ({ headline, summary, datetime: Date.parse(dia + 'T12:00:00Z') / 1000 });

// ── FUN ──────────────────────────────────────────────────────────
{
  const FUN = { ticker: 'FUN', company: 'Six Flags Entertainment Corp', ahora: AHORA };
  const r = categorizeNews([
    nota('Six Flags Reports $366 Million in Losses After Goliath Coaster Death and Ride Closures',
         'The company, formed by the 2024 merger of Cedar Fair and Six Flags, …', '2026-11-05'),
    nota('Stock Market Today: Big Banks Earn Billions, Bumble Soars on Buyout', '… Six Flags …', '2026-10-14'),
    nota('Six Flags Stock Price Focuses On Fatal Ride Accident Review And Legal Probe'),
    nota('Six Flags plans to sell more parks as $5-billion debt, fatal Georgia accident and brain injury lawsuits pummel stock'),
    nota('Six Flags agrees to divest three parks to private buyer'),
  ], FUN);
  ok(r.ma.deals_mentioned === 1, 'FUN: sólo la desinversión es M&A', JSON.stringify(r.ma.top_news.map(n => n.headline)));
  ok(r.ma.top_news[0].keyword === 'divestiture', 'FUN: etiqueta divestiture', r.ma.top_news[0].keyword);
  ok(!r.ma.top_news.some(n => /Losses/.test(n.headline)), 'FUN: el reporte de pérdidas ya no es merger');
  ok(!r.ma.top_news.some(n => /Bumble/.test(n.headline)), 'FUN: la nota de Bumble ya no es M&A');
  ok(r.unrelated_dropped === 1, 'FUN: la nota de mercado general se descarta', r.unrelated_dropped);
  ok(r.regulatory.active_concerns === 2, 'FUN: probe + lawsuits siguen siendo regulatorio', r.regulatory.active_concerns);
}

// ── NVDA: 'settle' ───────────────────────────────────────────────
{
  const NVDA = { ticker: 'NVDA', company: 'NVIDIA Corporation', ahora: AHORA };
  const r = categorizeNews([
    nota('A Short Seller Says China Drove "Over 20%" of Nvidia’s Compute Sales. Why Nvidia’s "Under 1%" Doesn’t Settle It'),
    nota('Nvidia could face fines, lawsuits, and lost markets: Baird strategist'),
    nota('Nvidia agrees to settle shareholder suit for $50 million'),
  ], NVDA);
  const hs = r.regulatory.top_news.map(n => n.headline);
  ok(!hs.some(h => /Short Seller/.test(h)), "NVDA: \"Doesn't Settle It\" ya no es regulatorio", JSON.stringify(hs));
  ok(r.regulatory.active_concerns === 2, 'NVDA: lawsuits + settlement sí', r.regulatory.active_concerns);
}

// ── ¿Habla de la empresa? ────────────────────────────────────────
{
  ok(palabrasDeEmpresa('Six Flags Entertainment Corp').join() === 'flags', 'nombre → "flags"', palabrasDeEmpresa('Six Flags Entertainment Corp'));
  ok(hablaDeLaEmpresa('Disney beats on parks', { ticker: 'DIS', company: 'Walt Disney Co.' }), 'Disney por nombre');
  ok(hablaDeLaEmpresa('Why FUN stock is falling', { ticker: 'FUN', company: 'Six Flags Entertainment Corp' }), 'FUN por ticker');
  ok(!hablaDeLaEmpresa('Kids have fun at the fair', { ticker: 'FUN', company: 'Six Flags Entertainment Corp' }), '"fun" en minúsculas no es el ticker');
  ok(!hablaDeLaEmpresa('U.S. stocks rise', { ticker: 'S', company: 'SentinelOne Inc' }), 'ticker de 1 letra no casa con "U.S."');
  ok(hablaDeLaEmpresa('SentinelOne (S) jumps', { ticker: 'S', company: 'SentinelOne Inc' }), 'ticker de 1 letra sí con "(S)"');
}

// ── 'consolidation' ya no es M&A ─────────────────────────────────
{
  const r = categorizeNews([nota('Nvidia shares enter consolidation phase')],
    { ticker: 'NVDA', company: 'NVIDIA Corporation', ahora: AHORA });
  ok(r.ma.deals_mentioned === 0, 'consolidación de precio no es M&A');
}

if (failures) { console.error(`\n${failures} fallo(s)`); process.exit(1); }
console.log('\nOK');
