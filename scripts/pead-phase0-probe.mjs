#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// FASE 0 — Spike de datos PEAD (GO / NO-GO)
//
// Objetivo: decidir si el free tier de una fuente de earnings da la
// profundidad histórica que el backtest PEAD necesita, con la fecha del
// anuncio Y la hora (BMO/AMC) pobladas. Ver docs/pead-backtest-scope.md.
//
// Regla de decisión (del scope): GO si hay >= 2 AÑOS de historia con
// epsActual y hour (bmo/amc) poblados de forma consistente. Si no -> NO-GO
// para esa fuente (fallback a Alpha Vantage EARNINGS + SEC 8-K).
//
// USO:
//   FINNHUB_API_KEY=xxxx node scripts/pead-phase0-probe.mjs
//   # opcional, prueba tambien el fallback:
//   FINNHUB_API_KEY=xxx ALPHAVANTAGE_API_KEY=yyy node scripts/pead-phase0-probe.mjs
//
// No tiene dependencias (usa fetch global de Node >= 18). ~10 llamadas,
// muy por debajo del limite de 60/min de Finnhub.
// ═══════════════════════════════════════════════════════════════════════

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || '';

// Ventanas de sondeo: cuantos dias hacia atras, cada una una semana.
const LOOKBACKS = [
  { label: '~6 meses', days: 180 },
  { label: '~1 ano',   days: 365 },
  { label: '~2 anos',  days: 730 },
  { label: '~2.5 anos', days: 913 },
  { label: '~3 anos',  days: 1095 },
  { label: '~4 anos',  days: 1460 },
  { label: '~5 anos',  days: 1825 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().split('T')[0];

function windowFor(days) {
  const from = new Date(Date.now() - days * 86400_000);
  const to = new Date(from.getTime() + 6 * 86400_000);
  return { from: iso(from), to: iso(to) };
}

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'quantdesk-pead-phase0' } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, body: null };
    if (!ct.includes('application/json')) {
      const text = await res.text();
      return { ok: false, status: res.status, body: null, note: `non-JSON (${text.slice(0, 80)})` };
    }
    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, body: null, note: String(e.message || e) };
  }
}

// ── Sonda Finnhub: calendar/earnings por semana, todo el mercado US ──
async function probeFinnhub() {
  console.log('\n═══ FINNHUB — calendar/earnings (fuente primaria) ═══');
  if (!FINNHUB_KEY) {
    console.log('  SALTADO: FINNHUB_API_KEY no seteada.\n');
    return null;
  }

  const rows = [];
  let deepestGoodDays = 0;

  for (const lb of LOOKBACKS) {
    const { from, to } = windowFor(lb.days);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const r = await getJson(url);

    if (!r.ok) {
      rows.push({ lb, from, to, total: `ERR ${r.status}${r.note ? ' ' + r.note : ''}`, withEps: '-', withHour: '-' });
      await sleep(1200);
      continue;
    }

    const list = (r.body && r.body.earningsCalendar) || [];
    const total = list.length;
    const withEps = list.filter((e) => e && e.epsActual != null).length;
    const withHour = list.filter((e) => e && (e.hour === 'bmo' || e.hour === 'amc')).length;

    rows.push({ lb, from, to, total, withEps, withHour });

    // "Bueno" = hay filas, la mayoria con epsActual, y la hora poblada de forma util.
    const good = total > 0 && withEps >= Math.max(1, total * 0.5) && withHour >= Math.max(1, total * 0.4);
    if (good && lb.days > deepestGoodDays) deepestGoodDays = lb.days;

    await sleep(1200); // holgado; el limite es 60/min
  }

  // Tabla
  console.log('\n  lookback     ventana                 filas  c/epsActual  c/hour(bmo|amc)');
  console.log('  ' + '─'.repeat(74));
  for (const row of rows) {
    const win = `${row.from}→${row.to}`;
    console.log(
      '  ' +
        String(row.lb.label).padEnd(11) + ' ' +
        win.padEnd(24) + ' ' +
        String(row.total).padStart(5) + '  ' +
        String(row.withEps).padStart(10) + '  ' +
        String(row.withHour).padStart(14)
    );
  }

  // Muestra concreta de la ventana mas profunda que respondio con filas
  const sampleRow = [...rows].reverse().find((r) => typeof r.total === 'number' && r.total > 0);
  if (sampleRow) {
    const { from, to } = windowFor(sampleRow.lb.days);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const r = await getJson(url);
    const ex = ((r.body && r.body.earningsCalendar) || []).slice(0, 3);
    if (ex.length) {
      console.log(`\n  Muestra @ ${sampleRow.lb.label} (${from}→${to}):`);
      for (const e of ex) {
        console.log(`    ${e.symbol}  date=${e.date}  hour=${e.hour}  epsActual=${e.epsActual}  epsEstimate=${e.epsEstimate}`);
      }
    }
  }

  const years = (deepestGoodDays / 365).toFixed(1);
  console.log('\n  ── VEREDICTO FINNHUB ──');
  if (deepestGoodDays >= 730) {
    console.log(`  ✅ GO — datos con epsActual + hour hasta ~${years} anos hacia atras (>= 2 anos).`);
  } else if (deepestGoodDays > 0) {
    console.log(`  ⚠️  NO-GO — solo ~${years} anos utiles (< 2 anos). Usar fallback Alpha Vantage.`);
  } else {
    console.log('  ❌ NO-GO — ninguna ventana devolvio datos utiles (¿restriccion de plan?). Usar fallback.');
  }
  return { deepestGoodDays };
}

// ── Sonda fallback Alpha Vantage EARNINGS: profundidad por simbolo ──
async function probeAlphaVantage() {
  console.log('\n═══ ALPHA VANTAGE — EARNINGS (fallback) ═══');
  if (!AV_KEY) {
    console.log('  SALTADO: ALPHAVANTAGE_API_KEY no seteada. (Free = 25 req/dia; NO trae BMO/AMC.)\n');
    return null;
  }
  const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=MSFT&apikey=${AV_KEY}`;
  const r = await getJson(url);
  if (!r.ok) {
    console.log(`  ERROR ${r.status}${r.note ? ' ' + r.note : ''}`);
    return null;
  }
  const q = (r.body && r.body.quarterlyEarnings) || [];
  if (r.body && r.body.Note) console.log(`  Aviso AV: ${r.body.Note}`); // rate limit
  if (!q.length) {
    console.log('  Sin quarterlyEarnings (revisa Note/limite diario).');
    return null;
  }
  const oldest = q[q.length - 1];
  const newest = q[0];
  const spanYears = (
    (new Date(newest.reportedDate) - new Date(oldest.reportedDate)) / (365 * 86400_000)
  ).toFixed(1);
  console.log(`  MSFT: ${q.length} trimestres, de ${oldest.reportedDate} a ${newest.reportedDate} (~${spanYears} anos).`);
  console.log(`  Campos por trimestre: reportedDate=${newest.reportedDate} reportedEPS=${newest.reportedEPS} estimatedEPS=${newest.estimatedEPS} surprisePercentage=${newest.surprisePercentage}`);
  console.log('  Nota: reportedDate = fecha del anuncio (usable), pero NO hay hora BMO/AMC → cruzar con SEC 8-K.');
  return { quarters: q.length };
}

(async () => {
  console.log('FASE 0 — Spike de datos PEAD');
  console.log('Fecha:', iso(new Date()));
  await probeFinnhub();
  await probeAlphaVantage();
  console.log('\nFin. Regla del scope: GO si Finnhub da >= 2 anos con epsActual + hour.');
})();
