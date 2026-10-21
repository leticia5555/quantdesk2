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
import { puertaDeCorrida, puertaPorCorrida, libroDeFila, PUERTA_RELOJ_PCT, PUERTA_LECTURA_MS, FUENTE_PRUEBA } from '../api/liga-libros.js';
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

// ── 5) LIBROS REALES DEL 20-OCT (arena_shadow_journal) ────────────────
// Las filas las pegó Lety el 21-oct; el fixture copia tal cual lo que lee la
// puerta. La 13 es la corrida de deepseek que nuestro reloj cortó a 255 s; la
// 17 es una sana con el tope nuevo (165 s); la 12 es qwen, cortado DENTRO del
// loop.
console.log('\n── 5) libros reales del 20-oct ──');
{
  const { filas } = JSON.parse(readFileSync(new URL('./fixtures/libros-shadow-2026-10-20.json', import.meta.url), 'utf8'));
  const libros = filas.map((f) => libroDeFila(f, FUENTE_PRUEBA));
  const [l13, l17, l12] = libros;

  ok(l13.puerta.reloj_pct === 137.8 && l13.puerta.puertas.reloj === false,
    'fila 13 (deepseek, 255 s): reloj 137.8% → ROJO', JSON.stringify(l13.puerta));
  ok(l13.puerta.lectura_max_ms === 49032 && l13.puerta.puertas.lectura === true,
    'fila 13: la vuelta más larga fue 49 s → esa puerta sí pasa (lo que se pasó fue el total, no una lectura)');
  // LO QUE ESTE LIBRO NO DICE: el corte de la 13 fue en el CIERRE, que no es
  // una vuelta del loop. `vueltas_medidas` no lo registra, así que
  // `cortes_nuestros` da 0. El rojo lo pone el reloj; esto lo deja escrito
  // para que nadie lea el verde de cortes como "nuestro reloj no cortó".
  ok(l13.puerta.cortes_nuestros === 0 && l13.puerta.puertas.cortes_nuestros === true,
    'fila 13: el corte fue en el cierre, fuera de vueltas_medidas → cortes_nuestros no lo ve (el rojo viene del reloj)');
  ok(l13.estado === 'aborted_cuerpo_vacio' && l13.corrida_id === 'shadow-deepseek-2026-10-20T15:23:39.381Z', 'y la fila se nombra por su id');

  ok(l17.puerta.reloj_pct === 75.6 && l17.puerta.lectura_max_ms === 42579 && l17.puerta.cortes_nuestros === 0,
    'fila 17 (deepseek, tope 165 s): 75.6% · 42.6 s · sin cortes', JSON.stringify(l17.puerta));
  ok(l17.puerta.puertas.reloj === true && l17.puerta.puertas.lectura === true && l17.puerta.puertas.cortes_nuestros === true,
    'fila 17: VERDE en las tres');

  ok(l12.puerta.reloj_pct === 110.1 && l12.puerta.puertas.reloj === false
    && l12.puerta.cortes_nuestros === 1 && l12.puerta.puertas.cortes_nuestros === false && l12.puerta.vacias === 1,
    'fila 12 (qwen): reloj 110.1% y un corte de nuestro reloj DENTRO del loop → rojo en las dos', JSON.stringify(l12.puerta));

  // La misma cuenta que la puerta, sobre datos reales.
  for (const [i, f] of filas.entries()) {
    const t = f.context.tools;
    const r = resumenDelLoop({ turns: t.turns, stopped_by: t.stopped_by, limites: t.limites, vueltas_medidas: t.vueltas_medidas }, { used: t.used });
    ok(r.reloj_pct === libros[i].puerta.reloj_pct && r.lectura_max_ms === libros[i].puerta.lectura_max_ms && r.cortes_nuestros === libros[i].puerta.cortes_nuestros,
      `fila ${f.id}: igual que resumenDelLoop`);
  }

  // Lo que se filtra con jq: `.puerta_por_corrida[] | select(.puertas.reloj == false)`.
  const rojas = puertaPorCorrida(libros).filter((p) => p.puertas.reloj === false).map((p) => p.corrida_id);
  ok(rojas.length === 2 && rojas.includes(l13.corrida_id) && rojas.includes(l12.corrida_id) && !rojas.includes(l17.corrida_id),
    'el filtro de jq devuelve la 13 y la 12, no la 17', JSON.stringify(rojas));
  ok(puertaPorCorrida(libros).every((p) => p.fuente === 'prueba'), 'y las marca como de prueba (sombra), no en vivo');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
