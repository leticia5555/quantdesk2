#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/historia-inventario.mjs — ¿cuánto del universo de la liga cubre
// HISTORIA hoy, cuáles faltan, y cuánto costaría el backfill?
//
// SOLO LECTURA: tres SELECT contra Neon. No ingiere, no narra, no escribe,
// no llama a ningún modelo. El costo es una ESTIMACIÓN que se imprime; para
// gastarlo hay que correr /api/historia-harvest y /api/historia-narrar, que
// es otra decisión.
//
//   DATABASE_URL=postgres://… node scripts/historia-inventario.mjs           # resumen
//   DATABASE_URL=postgres://… node scripts/historia-inventario.mjs --json    # todo, en JSON
//
// El universo es el ÚLTIMO snapshot de `arena_universe` (key 'universe:*'),
// que es exactamente la lista que vieron los agentes ese día.
// ═══════════════════════════════════════════════════════════════

import { sql } from '../api/_lib/db.js';
import { inventario } from '../api/_lib/historia-inventario.js';

const comoJson = process.argv.includes('--json');

const [uni] = await sql(
  `select key, payload->'symbols' as symbols from arena_universe
    where key like 'universe:%' order by key desc limit 1`,
);
if (!uni) {
  console.error('No hay ningún snapshot `universe:*` en arena_universe: no hay universo contra el cual medir.');
  process.exit(2);
}
const emisores = await sql(`select cik, ticker, estado from company_emisor`);
// La última narración servible por emisor, con su costo real si se guardó.
const narradas = await sql(
  `select distinct on (cik) cik, (costo->>'usd_total')::numeric as usd_total
     from company_narracion where estado = 'ok'
    order by cik, creado_en desc`,
);

const inv = inventario({ universo: uni.symbols || [], emisores, narradas });
inv.universo_snapshot = uni.key;

if (comoJson) {
  console.log(JSON.stringify(inv, null, 2));
} else {
  const c = inv.costo;
  console.log(`universo (${uni.key}): ${inv.universo} nombres`);
  console.log(`emisores en HISTORIA: ${inv.emisores_en_historia}`);
  console.log(`cubiertas (con narración servible): ${inv.cubiertas}`);
  console.log(`ingeridas sin narración: ${inv.ingeridas_sin_narracion.length}`);
  console.log(`con error de ingesta: ${inv.con_error_de_ingesta.length}`);
  console.log(`faltan (ni ingeridas): ${inv.faltan.length}`);
  console.log(`por narrar: ${inv.por_narrar}`);
  console.log(`costo por empresa — medido: ${c.por_empresa_medido_usd ?? 'sin narraciones con costo'} (n=${c.medido_sobre}) · supuesto típico: $${c.por_empresa_supuesto_usd.tipico} · peor: $${c.por_empresa_supuesto_usd.peor}`);
  console.log(`backfill — medido: ${c.backfill_usd.medido ?? '—'} · típico: $${c.backfill_usd.tipico} · peor: $${c.backfill_usd.peor}  (modelo ${c.modelo})`);
  console.log(`ingesta de las que faltan: ~${c.ingesta_minutos} min de goteo`);
  console.log(`\nfaltan: ${inv.faltan.join(' ')}`);
}
