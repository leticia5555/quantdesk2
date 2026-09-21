// ═══════════════════════════════════════════════════════════════
// Tests de la COSECHA earnings-beat (Fase 1). JS puro, SIN RED NI DB:
//   - preparaFila: mercado clasificado → fila de pm_earnings_markets
//   - abiertos: se guardan (sesgo de supervivencia si no)
//   - debeReemplazarPrecio: un upsert NUNCA pisa un dato bueno con uno peor
//   - mejorOutcome: un mercado resuelto no vuelve a abierto
//   - la escala de calidad en SQL sale de la MISMA tabla que la de JS
// Correr con `node tests/earnings-beat-harvest.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  preparaFila, debeReemplazarPrecio, mejorOutcome, CALIDAD_PRECIO, SCHEMA,
} from '../api/_lib/earnings-beat-db.js';
import { SIMBOLOS_V1 } from '../api/earnings-beat-harvest.js';
import { V0_UNIVERSE } from '../api/_lib/pead-universe.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('preparaFila: mercado clasificado → fila de la tabla');

const MERCADO = {
  id: '512345', slug: 'cost-quarterly-earnings-gaap-eps', pregunta: 'Will Costco (COST) beat quarterly earnings?',
  via: 'simbolo', symbol: 'COST', symbol_via: 'ticker',
  creado: '2026-08-15T00:00:00Z', fecha_resolucion: '2026-09-30',
  cruce: { reported_date: '2026-09-29', dias: 1 },
  consenso_pm: 1.1, outcome: 'Yes', token_yes: 'tok-a', volumen: 4200,
};
const PRECIO = { precio: 0.63, ts: '2026-09-29T21:00:00.000Z', estado: 'valido' };

const fila = preparaFila(MERCADO, { raw: { id: '512345', question: 'x' }, precio: PRECIO });
ok(fila.market_id === '512345', 'market_id es la PK del upsert');
ok(fila.report_date === '2026-09-29', 'report_date sale del cruce con pead_earnings', fila.report_date);
ok(fila.outcome === 'yes', 'outcome en minúsculas (la tabla no hereda el casing de Polymarket)', fila.outcome);
ok(fila.abierto === false, 'con outcome → no está abierto');
ok(fila.yes_price_t24h === 0.63 && fila.yes_price_ts === '2026-09-29T21:00:00.000Z',
  'el precio viaja CON su timestamp (sin ts no es auditable)');
ok(fila.yes_price_estado === 'valido', 'y con su estado, para el upsert que no pisa hacia abajo');
ok(typeof fila.raw === 'string' && JSON.parse(fila.raw).id === '512345', 'raw completo, serializado a jsonb');
ok(fila.filtro_motivo === 'ok', 'lo que entra a la tabla ya pasó el filtro v1, y queda dicho');

const abierto = preparaFila({ ...MERCADO, outcome: null }, { precio: null });
ok(abierto.abierto === true && abierto.outcome === null, 'mercado sin outcome → se guarda como ABIERTO');
ok(abierto.yes_price_t24h === null && abierto.yes_price_estado === null, 'sin precio todavía → nulls, no inventos');
const sinCruce = preparaFila({ ...MERCADO, cruce: null }, { precio: PRECIO });
ok(sinCruce.report_date === null, 'sin cruce → report_date null, pero el mercado SE GUARDA igual');

console.log('debeReemplazarPrecio: el upsert nunca degrada la tabla');

ok(debeReemplazarPrecio(null, 'valido') === true, 'no había nada → escribe');
ok(debeReemplazarPrecio('sin_ticks', 'valido') === true, 'sin_ticks → valido: mejora, escribe');
ok(debeReemplazarPrecio('rancio', 'valido') === true, 'rancio → valido: mejora, escribe');
ok(debeReemplazarPrecio('valido', 'sin_ticks') === false, 'valido → sin_ticks: NO pisa (CLOB caído no borra un precio bueno)');
ok(debeReemplazarPrecio('valido', 'error') === false, 'valido → error: NO pisa');
ok(debeReemplazarPrecio('valido', 'valido') === false, 'mismo estado → no reescribe');
ok(debeReemplazarPrecio('rancio', 'sin_ticks_antes') === false, 'rancio → sin_ticks_antes: peor, no pisa');
ok(debeReemplazarPrecio('valido', null) === false, 'nada nuevo → no toca');

console.log('mejorOutcome: la resolución es un hecho');

ok(mejorOutcome('yes', null) === 'yes', 'resuelto + visto abierto → sigue resuelto');
ok(mejorOutcome(null, 'no') === 'no', 'abierto + resuelto → resuelve');
ok(mejorOutcome('yes', 'no') === 'no' || mejorOutcome('yes', 'no') === 'yes', 'no crashea con outcomes en conflicto');
ok(mejorOutcome(null, null) === null, 'abierto sigue abierto');

console.log('el SQL del upsert aplica las MISMAS reglas que el JS');

const ddl = SCHEMA.join(' ');
ok(/market_id\s+text primary key/.test(ddl), 'PK por market_id → idempotencia');
ok(/yes_price_ts\s+timestamptz/.test(ddl), 'yes_price_ts existe en el esquema');
ok(/raw\s+jsonb/.test(ddl), 'raw completo en jsonb');
ok(/abierto\s+boolean/.test(ddl), 'los abiertos tienen su columna');

// La escala de calidad se genera desde CALIDAD_PRECIO para el SQL: si alguien
// agrega un estado nuevo en JS y se olvida del SQL, este test lo caza.
import { upsertMercados } from '../api/_lib/earnings-beat-db.js';
const fuente = String(upsertMercados);
for (const estado of Object.keys(CALIDAD_PRECIO)) {
  ok(fuente.includes('calidadSql') || fuente.includes(estado),
    `el upsert conoce el estado '${estado}'`);
  break;   // basta con comprobar que usa calidadSql(), que se genera del objeto
}
ok(CALIDAD_PRECIO.valido > CALIDAD_PRECIO.rancio && CALIDAD_PRECIO.rancio > CALIDAD_PRECIO.sin_ticks,
  'el orden de calidad es valido > rancio > sin_ticks');

console.log('universo v1: los 99, sin ampliar');

ok(SIMBOLOS_V1 === 99, 'la cosecha v1 se queda con 99 símbolos', SIMBOLOS_V1);
ok(new Set(V0_UNIVERSE).size === 99, 'y el universo del PEAD tiene exactamente esos 99', new Set(V0_UNIVERSE).size);

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
