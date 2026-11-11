// Event Agent · reglas del prompt (Lety, 2026-11-11): nada de órdenes de
// operar ("scale shorts", "reduce core holdings") ni motivos inventados de
// insiders ("management had forward visibility"). Sin red.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../api/event-agent.js', import.meta.url), 'utf8');
let failures = 0;
const ok = (c, n) => { if (c) console.log('  PASS', n); else { failures++; console.error('  FAIL', n); } };
ok(/NEVER tell the reader to buy, sell, short/.test(src), 'prohíbe instrucciones de operar');
ok(/NEVER attribute knowledge, intent or motive to insiders/.test(src), 'prohíbe motivos de insiders');
ok(/10b5-1/.test(src), 'menciona ventas programadas');
ok(!/actionable consideration/.test(src), 'ya no pide "actionable considerations"');
ok(!/IV crush risk into earnings makes long-vol/.test(src), 'ya no trae un ejemplo de operación');
if (failures) process.exit(1); console.log('\nOK');
