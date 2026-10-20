// ═══════════════════════════════════════════════════════════════
// tests/liga-puerta-por-corrida.test.mjs — reloj_pct y lectura máxima por
// vuelta, leíbles desde /api/liga/libros por corrida.
//
// Lo que se blinda:
//   1. LA MISMA CUENTA que `resumenDelLoop` (arena-shadow), que es la que lee
//      la puerta: si una de las dos cambia, esta prueba lo dice.
//   2. LOS MISMOS UMBRALES que scripts/arena-humo.sh (90% y 90.000 ms).
//   3. "NO MEDIDO" NO ES CERO NI VERDE: sin dato, null.
//   4. VIAJA en cada libro y aplanado en `puerta_por_corrida`.
//
// Correr con `node tests/liga-puerta-por-corrida.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { puertaDeCorrida, puertaPorCorrida, libroDeFila, PUERTA_RELOJ_PCT, PUERTA_LECTURA_MS } from '../api/liga-libros.js';
import { resumenDelLoop } from '../api/arena-shadow.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const tools = {
  turns: 4, stopped_by: 'call_budget', used: 20,
  limites: { reloj_ms: { usado: 150000, tope: 185000, pct: 81.1 } },
  vueltas_medidas: [
    { vuelta: 1, ms: 12000, vacio: false, reloj_nuestro: false },
    { vuelta: 2, ms: 41000, vacio: false, reloj_nuestro: false },
    { vuelta: 3, ms: 9000, vacio: true, reloj_nuestro: false },
    { vuelta: 4, ms: 23000, vacio: false, reloj_nuestro: false },
  ],
};

console.log('\n── 1) la misma cuenta que la puerta ──');
{
  const p = puertaDeCorrida(tools);
  const loop = { turns: tools.turns, stopped_by: tools.stopped_by, limites: tools.limites, vueltas_medidas: tools.vueltas_medidas };
  const r = resumenDelLoop(loop, { used: 20 });
  ok(p.reloj_pct === r.reloj_pct && p.reloj_pct === 81.1, 'reloj_pct igual al de resumenDelLoop', `${p.reloj_pct} vs ${r.reloj_pct}`);
  ok(p.lectura_max_ms === r.lectura_max_ms && p.lectura_max_ms === 41000, 'lectura máxima igual', `${p.lectura_max_ms} vs ${r.lectura_max_ms}`);
  ok(p.vacias === r.vacias && p.vacias === 1, 'vacías igual');
  ok(p.cortes_nuestros === r.cortes_nuestros && p.cortes_nuestros === 0, 'cortes nuestros igual');
  ok(p.vueltas === r.vueltas && p.cortó_por === r.cortó_por, 'vueltas y corte igual');
  ok(p.puertas.reloj === true && p.puertas.lectura === true && p.puertas.cortes_nuestros === true, 'esta corrida pasa las tres');
}

console.log('\n── 2) los mismos umbrales que arena-humo.sh ──');
{
  const humo = readFileSync(new URL('../scripts/arena-humo.sh', import.meta.url), 'utf8');
  ok(humo.includes(`reloj>=${PUERTA_RELOJ_PCT}`) && humo.includes(`lect>=${PUERTA_LECTURA_MS}`),
    `el script de humo corta en ${PUERTA_RELOJ_PCT}% y ${PUERTA_LECTURA_MS} ms, igual que acá`);
  const pasada = puertaDeCorrida({ ...tools, limites: { reloj_ms: { pct: 90 } }, vueltas_medidas: [{ ms: 90000 }, { ms: 5000, reloj_nuestro: true }] });
  ok(pasada.puertas.reloj === false && pasada.puertas.lectura === false, 'en el umbral exacto ya es rojo (el script usa >=)');
  ok(pasada.cortes_nuestros === 1 && pasada.puertas.cortes_nuestros === false, 'un corte de nuestro reloj es rojo');
  const justo = puertaDeCorrida({ limites: { reloj_ms: { pct: 89.9 } }, vueltas_medidas: [{ ms: 89999 }] });
  ok(justo.puertas.reloj === true && justo.puertas.lectura === true, 'un pelo abajo es verde');
}

console.log('\n── 3) no medido no es cero ni verde ──');
{
  ok(puertaDeCorrida(null) === null && puertaDeCorrida({ summary: [] }) === null, 'sin limites ni vueltas journaleadas: null');
  const sinMs = puertaDeCorrida({ limites: {}, vueltas_medidas: [{ vuelta: 1, ms: null }, { vuelta: 2 }] });
  ok(sinMs.lectura_max_ms === null && sinMs.puertas.lectura === null,
    'vueltas sin tiempo medido → lectura null y puerta null (resumenDelLoop diría 0)', JSON.stringify(sinMs));
  ok(sinMs.reloj_pct === null && sinMs.puertas.reloj === null, 'sin reloj journaleado, null');
  const sinVueltas = puertaDeCorrida({ limites: { reloj_ms: { pct: 10 } } });
  ok(sinVueltas.puertas.cortes_nuestros === null, 'sin vueltas medidas, "cero cortes" no se puede afirmar');
}

console.log('\n── 4) viaja por corrida ──');
{
  const l = libroDeFila({ id: 'r1', created_at: '2026-10-20T14:00:00Z', agent_id: 'grok', status: 'ok_target', context: { tools } }, 'en_vivo');
  ok(l.puerta && l.puerta.reloj_pct === 81.1 && l.puerta.lectura_max_ms === 41000, 'cada libro trae su puerta');
  const sin = libroDeFila({ id: 'r2', agent_id: 'qwen', status: 'aborted_llm_threw', context: {} }, 'en_vivo');
  ok(sin.puerta === null, 'una corrida que no journaleó el loop trae null');
  const plano = puertaPorCorrida([l, sin]);
  ok(plano.length === 1 && plano[0].corrida_id === 'r1' && plano[0].agente === 'grok' && plano[0].reloj_pct === 81.1 && plano[0].fuente === 'en_vivo',
    '`puerta_por_corrida` aplana id, agente, fuente y los números', JSON.stringify(plano[0]));
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(/puerta_por_corrida: puertaPorCorrida\(libros\)/.test(src), 'y la respuesta del endpoint la publica');
  ok(!/from '\.\/arena-shadow\.js'|from '\.\.\/arena-shadow\.js'|from '\.\/arena-run\.js'/.test(src), 'el endpoint sigue sin importar el camino que decide');
  const html = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  ok(/l\.puerta\.reloj_pct/.test(html) && /l\.puerta\.lectura_max_ms/.test(html), 'la tarjeta los muestra en "La corrida"');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
