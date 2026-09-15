// ═══════════════════════════════════════════════════════════════
// tests/arena-liga-libros.test.mjs — B11: /api/liga/libros.
//
// Lo que se blinda:
//
//   1. LA FUENTE NUNCA SE INFIERE. Cada libro dice si vino de la liga VIVA o de
//      la SOMBRA. Confundir una decisión de sombra con una real es exactamente
//      el error que las tablas separadas existen para impedir — publicarlas
//      juntas sin etiqueta sería re-crear el problema en la capa de arriba.
//   2. EL CONTROL VA MARCADO. Es el piso de ruido: leer su resultado como el de
//      un competidor más invalida la única referencia que hace significativo
//      cualquier delta entre modelos.
//   3. LA ETIQUETA DE MODELO, no el slug. El slug cambia con un override de env
//      var; publicarlo haría que la tabla dijera cosas distintas según qué env
//      vars estuvieran puestas ese día.
//   4. LA SECUENCIA ES UNA HISTORIA, no ocho volcados: viaja el resumen, nunca
//      el resultado completo.
//   5. SOLO LECTURA, como /eventos y /audit.
//
// Correr con `node tests/arena-liga-libros.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { identidad, secuenciaPublicable, libroDeFila } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 2) y 3) LA IDENTIDAD ─────────────────────────────────────────────
console.log('\n── el control va MARCADO, y el modelo va con su etiqueta ──');
{
  const c = identidad('control');
  ok(c.control === true, 'el control se marca');
  ok(/piso de ruido/.test(c.control_nota || ''),
    'y se explica QUÉ significa: su resultado no es el de un competidor, es cuánto varía el mismo modelo consigo mismo', c.control_nota);

  const cl = identidad('claude');
  ok(cl.control === false, 'claude no es control');
  ok(cl.modelo && !/^claude-/.test(cl.modelo),
    'el modelo sale como ETIQUETA legible, no como slug de API — el slug cambia con un override de env var', cl.modelo);
  ok(cl.nombre === 'Claude', 'con su nombre de liga', cl.nombre);

  ok(identidad('control').modelo === identidad('claude').modelo,
    'claude y control comparten modelo: es lo que los hace comparables');

  const raro = identidad('no-existe');
  ok(raro.id === 'no-existe' && raro.control === false,
    'un agente desconocido no revienta ni se marca como control por accidente');
}

// ── 4) LA SECUENCIA ──────────────────────────────────────────────────
console.log('\n── la secuencia es una historia, no ocho volcados ──');
{
  const ctx = {
    tools: {
      budget: 8, used: 3, turns: 3, stopped_by: 'end_turn',
      summary: [
        { n: 1, tool: 'screener', args: { sector: 'XLK', min_rvol: 3 }, rows: 12, truncated: false, ms: 40 },
        { n: 2, tool: 'noticias', args: { ticker: 'NVDA' }, rows: 5, truncated: false, ms: 320 },
        { n: 3, tool: 'ficha', args: { ticker: 'AMD' }, rows: 9, truncated: true, ms: 800 },
      ],
      // El resultado COMPLETO existe en el journal para el replay…
      sequence: [{ n: 1, tool: 'screener', result: 'X'.repeat(5000) }],
    },
  };
  const s = secuenciaPublicable(ctx);
  ok(s.usó_herramientas === true && s.pasos.length === 3, 'los tres pasos', String(s.pasos.length));
  ok(s.pasos[0].herramienta === 'screener' && s.pasos[1].herramienta === 'noticias' && s.pasos[2].herramienta === 'ficha',
    '"buscó semis → leyó noticias de NVDA → pidió la ficha de AMD" — eso es una historia');
  ok(s.pasos[2].truncado === true, 'y se ve cuál resultado vino truncado');
  ok(JSON.stringify(s).length < 600,
    '…pero el RESULTADO COMPLETO no viaja: mover megabytes por un feed público que no los usa sería pagarlos en cada carga',
    String(JSON.stringify(s).length));
  ok(!/XXXX/.test(JSON.stringify(s)), 'literalmente: el volcado no está en la respuesta');

  const sin = secuenciaPublicable({ tools: { enabled: false, reason: 'ARENA_TOOLS=0' } });
  ok(sin.usó_herramientas === false && sin.motivo === 'ARENA_TOOLS=0', 'y cuando no hubo herramientas, se dice por qué');
  ok(secuenciaPublicable({}) === null, 'sin bloque de herramientas, null');
}

// ── 1) LA FUENTE ─────────────────────────────────────────────────────
console.log('\n── 1) la fuente NUNCA se infiere ──');
{
  const fila = {
    run_date: '2026-09-17', created_at: '2026-09-17T14:05:00Z', agent_id: 'claude',
    status: 'ok_target', plan: 'Roto hacia semis.',
    target: { weights: { NVDA: 0.12, ZM: -0.08 }, cash: 0.8, theses: { NVDA: 'la demanda sigue' } },
    rebalance: { legs: [1, 2], turnover: 0.2, rail_trims: [], cancel: [1] },
    context: { lens: 'momentum', tools: { budget: 8, used: 2, summary: [{ n: 1, tool: 'screener', args: {}, rows: 3 }] } },
  };
  const sombra = libroDeFila(fila, 'sombra');
  ok(sombra.fuente === 'sombra', 'una fila de sombra viaja etiquetada como sombra');
  const viva = libroDeFila(fila, 'viva');
  ok(viva.fuente === 'viva', 'y una de la liga viva, como viva');

  ok(sombra.portafolio.pesos.ZM === -0.08, 'el portafolio objetivo, con el signo del corto', String(sombra.portafolio.pesos.ZM));
  ok(sombra.portafolio.tesis.NVDA === 'la demanda sigue', 'y la tesis por posición');
  ok(sombra.rebalanceo.ordenes === 2 && sombra.rebalanceo.turnover === 0.2, 'qué habría hecho el motor', JSON.stringify(sombra.rebalanceo));

  ok(sombra.lente === 'momentum', 'la lente del día');
  ok(/confound DELIBERADO/.test(sombra.lente_nota || ''),
    'publicada CON su advertencia: dos agentes con lentes distintas el mismo día no son comparables ese día');

  // Una corrida del contrato VIEJO no tiene portafolio, y eso también informa.
  const vieja = libroDeFila({ ...fila, target: null, rebalance: null }, 'viva');
  ok(vieja.portafolio === null && vieja.rebalanceo === null,
    'una corrida del contrato viejo sale con portafolio null — eso dice QUÉ contrato corrió ese día, no es un hueco');
}

// ── 5) SOLO LECTURA ──────────────────────────────────────────────────
console.log('\n── solo lectura, como /eventos y /audit ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/ensureSchema/.test(codigo), 'no llama ensureSchema (hace CREATE/ALTER)');
  ok(!/\bbeat\(/.test(codigo), 'no late: latir acá enmascararía un cron muerto');
  ok(!/insert into|update |delete from|create table|alter table/i.test(codigo), 'cero escrituras');
  ok(!/arena-run|arena-guard|arena-exits/.test(codigo), 'no importa nada del camino de decisión');
  ok(!/prompt/.test(codigo.toLowerCase()) || !/context->'(dive|scan)'/.test(codigo),
    'no proyecta los prompts completos: son material para reconstruir la corrida, no material de show');
}

console.log('\n── la tabla de sombra puede no existir todavía ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(/no corrió nunca, o la tabla no existe/.test(src),
    'y eso NO es un error del endpoint: es un estado, y se dice como tal');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
