// ═══════════════════════════════════════════════════════════════
// tests/arena-js-tiempos.test.mjs — /api/arena mide cuánto tarda.
//
// Lo que se blinda:
//   1. CADA RESPUESTA TRAE SU DESGLOSE (`tiempos_ms` + `Server-Timing`):
//      sin eso, "¿cuánto tarda de verdad?" no se puede contestar desde afuera.
//   2. MEDIR NO CAMBIA LO QUE HACE: mismas llamadas, mismo orden, mismos
//      campos de respuesta.
//   3. LA ESTRUCTURA que motiva el ticket (docs/arena-js-60s.md): en frío,
//      DDL → SELECTs → Alpaca, en serie; en caliente, sin DDL.
//
// Sin red: el handler real con la red simulada (scripts/arena-js-medir.mjs).
// Correr con `node tests/arena-js-tiempos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { medirLocal } from '../scripts/arena-js-medir.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const L = { neonMs: 20, schemaMs: 60, alpacaMs: 40 };
const r = await medirLocal(L);

console.log('\n── 1) cada respuesta trae su desglose ──');
{
  const t = r.fria.tiempos;
  ok(t && ['schema_ms', 'journal_ms', 'alpaca_ms', 'total_ms'].every((k) => Number.isFinite(t[k])), 'tiempos_ms con los cuatro tramos', JSON.stringify(t));
  ok(/schema;dur=\d+, journal;dur=\d+, alpaca;dur=\d+, total;dur=\d+/.test(r.fria.server_timing || ''), 'y la cabecera Server-Timing', r.fria.server_timing);
  ok(t.schema_ms >= L.schemaMs - 2 && t.journal_ms >= L.neonMs - 2 && t.alpaca_ms >= L.alpacaMs - 2, 'cada tramo mide lo que tardó su parte');
  ok(t.total_ms >= t.schema_ms + t.journal_ms + t.alpaca_ms - 3, 'y el total es la SUMA: los tres tramos van en serie', JSON.stringify(t));
}

console.log('\n── 2) y 3) la estructura: fría vs. caliente ──');
{
  const f = r.llamadas_fria;
  ok(f.length === 5 && f[0].a === 'neon:schema' && f[0].sentencias >= 20, 'en frío: primero un lote de DDL (ensureSchema)', JSON.stringify(f[0]));
  ok(f[1].a === 'neon:select' && f[2].a === 'neon:select' && f[1].inicio >= L.schemaMs - 2, 'después los dos SELECT, en paralelo, cuando terminó el DDL');
  ok(f[3].a.startsWith('alpaca:') && f[4].a.startsWith('alpaca:') && f[3].inicio >= f[1].inicio + L.neonMs - 2, 'y Alpaca recién cuando terminaron los SELECT');
  ok(r.llamadas_caliente === 4 && r.caliente.tiempos.schema_ms <= 2, 'en caliente, sin DDL: 4 llamadas', `${r.llamadas_caliente} / ${r.caliente.tiempos.schema_ms}`);
}

console.log('\n── medir no cambió lo que hace ──');
{
  const src = readFileSync(new URL('../api/arena.js', import.meta.url), 'utf8');
  ok(/await ensureSchema\(\);/.test(src) && /Promise\.all\(\[getAccount\(flagshipCreds\), getPositions\(flagshipCreds\)\]\)/.test(src),
    'las mismas llamadas de siempre (el ticket propone cambiarlas; esta rama no)');
  ok(/out\.tiempos_ms = tiempos;/.test(src) && /res\.setHeader\('Server-Timing'/.test(src), 'solo se agregó la medición');
  ok(/s-maxage=60/.test(src), 'el caché del CDN sigue igual (el script de medición lo esquiva con ?_m=)');
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  ok(!vercel.functions['api/arena.js'] && vercel.functions['api/*.js'].maxDuration === 60, 'vercel.json no se tocó: arena.js sigue en el comodín de 60s');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
