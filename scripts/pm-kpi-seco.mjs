// ═══════════════════════════════════════════════════════════════════
// scripts/pm-kpi-seco.mjs — la cosecha de rangos de KPI EN SECO, fuera de
// Vercel: descubre, hidrata, filtra y cuenta contra Polymarket real, y NO
// escribe a Postgres (no recibe `db`, así que no puede).
//
//   node scripts/pm-kpi-seco.mjs            → markdown a stdout
//   node scripts/pm-kpi-seco.mjs --json     → el reporte completo en JSON
//   node scripts/pm-kpi-seco.mjs --clob     → además prueba /prices-history
//                                             en los cajones abiertos
//
// Existe porque las sesiones de desarrollo no siempre llegan a
// gamma-api.polymarket.com; el workflow `pm-kpi-seco.yml` lo corre desde un
// runner de GitHub y deja el reporte en el resumen del job.
// ═══════════════════════════════════════════════════════════════════

import { gamma, clob } from '../api/_lib/polymarket.js';
import { cosechaKpi, markdownSeco } from '../api/_lib/earnings-kpi-cosecha.js';

const args = new Set(process.argv.slice(2));
const r = await cosechaKpi({
  gamma, clob, db: null, ahora: new Date(),
  // Sin el tope de 300 s de Vercel: acá el presupuesto es el timeout del job.
  presupuestoMs: 20 * 60 * 1000,
  clobEnSeco: args.has('--clob'),
});

if (args.has('--json')) console.log(JSON.stringify(r, null, 2));
else console.log(markdownSeco(r));

// Falla de frontera: se GRITA (anotación), pero no es un veredicto ni un error
// del código — exit 0. El reporte dice qué pasó.
if (r.frontera && r.frontera.estado !== 'ok') {
  console.error(`::warning title=frontera Polymarket::${r.frontera.motivo}`);
}
