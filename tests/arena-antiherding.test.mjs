// ═══════════════════════════════════════════════════════════════
// tests/arena-antiherding.test.mjs — B8: anti-herding y sus métricas.
//
// Siete modelos mirando el MISMO tablero pueden terminar con el mismo libro, y
// si eso pasa el experimento deja de medir modelos y pasa a medir el tablero.
//
// Lo que se blinda:
//
//   1. TODO DETERMINISTA. Un `Math.random()` acá haría el journal
//      IRREPRODUCIBLE y el replay —que existe justamente para reconstruir qué
//      vio cada agente— sería inútil.
//   2. LA ROTACIÓN CIERRA: en 4 días cada agente pasa por las cuatro lentes.
//   3. LA ALEATORIZACIÓN VIVE EN LA COLA, no en el prefijo cacheado. Si el
//      orden cambiara dentro del bloque cacheado, los siete tendrían prefijos
//      distintos y la caché no serviría para nada (D2).
//   4. LAS MÉTRICAS miden lo que dicen medir, incluidos los casos degenerados
//      (un libro vacío no se "parece" a otro: se devuelve null, no 0 ni 1).
//
// Correr con `node tests/arena-antiherding.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  LENTES, lenteDelDia, dayIndex, shuffleDeterministic, buildTail,
  sharedTopTicker, pairwiseOverlap, toolVsBoardOrigin, TAIL_TOKEN_CAP,
} from '../api/_lib/arena-herding.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const AGENTES = ['claude', 'openai', 'control', 'grok', 'gemini', 'deepseek', 'qwen'];

// ── 1) DETERMINISMO ──────────────────────────────────────────────────
console.log('\n── 1) todo determinista: el journal tiene que poder reproducirse ──');
{
  const dia = new Date('2026-09-16T14:00:00Z');
  ok(lenteDelDia('claude', dia).id === lenteDelDia('claude', dia).id, 'la lente es estable para el mismo agente y día');
  const a = shuffleDeterministic(['A', 'B', 'C', 'D', 'E'], 'claude|run1');
  const b = shuffleDeterministic(['A', 'B', 'C', 'D', 'E'], 'claude|run1');
  ok(a.join(',') === b.join(','), 'la misma semilla da el mismo orden — sin esto el replay no reconstruye qué vio el agente', a.join(','));
  const c = shuffleDeterministic(['A', 'B', 'C', 'D', 'E'], 'grok|run1');
  ok(a.join(',') !== c.join(','), 'y agentes distintos ven órdenes distintas, que es el punto', `${a.join(',')} vs ${c.join(',')}`);
  const d = shuffleDeterministic(['A', 'B', 'C', 'D', 'E'], 'claude|run2');
  ok(a.join(',') !== d.join(','), 'y la misma lista en otra corrida también cambia');
  ok(shuffleDeterministic(['A', 'B', 'C'], 's').sort().join(',') === 'A,B,C', 'el barajado no pierde ni duplica elementos');

  // El candado explícito: nada de Math.random en el módulo.
  const { readFileSync } = await import('node:fs');
  // Se miran las líneas de CÓDIGO, no los comentarios: el encabezado del módulo
  // explica justamente por qué NO se usa Math.random, y un lint que lee prosa
  // se rompe con su propia documentación.
  const src = readFileSync(new URL('../api/_lib/arena-herding.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/Math\.random/.test(src),
    'CANDADO: el CÓDIGO no usa Math.random en ninguna parte — un journal irreproducible vuelve inútil al replay');
}

// ── 2) LA ROTACIÓN CIERRA ────────────────────────────────────────────
console.log('\n── 2) en 4 días cada agente pasa por las CUATRO lentes ──');
{
  ok(LENTES.length === 4, 'son cuatro lentes', String(LENTES.length));
  for (const ag of AGENTES) {
    const vistas = new Set();
    for (let d = 0; d < 4; d++) {
      vistas.add(lenteDelDia(ag, new Date(Date.UTC(2026, 8, 16 + d, 14))).id);
    }
    ok(vistas.size === 4, `${ag}: las cuatro en cuatro días`, [...vistas].join(','));
  }
  // Y en un día dado, los agentes NO tienen todos la misma (que es el punto).
  const hoy = new Date('2026-09-16T14:00:00Z');
  const delDia = new Set(AGENTES.map((a) => lenteDelDia(a, hoy).id));
  ok(delDia.size > 1, 'y en un mismo día hay más de una lente en juego', [...delDia].join(','));
}

console.log('\n── el día es el del ESTE, no UTC ──');
{
  // 20:00 ET del 16 son las 00:00 UTC del 17. Con UTC, la lente cambiaría a
  // mitad de la sesión.
  const tarde = new Date('2026-09-17T00:30:00Z');   // 20:30 ET del 16
  const mediodia = new Date('2026-09-16T16:00:00Z'); // 12:00 ET del 16
  ok(dayIndex(tarde) === dayIndex(mediodia),
    'las 20:30 ET siguen siendo el mismo día de mercado: con UTC la lente cambiaría a mitad de sesión',
    `${dayIndex(tarde)} vs ${dayIndex(mediodia)}`);
  ok(lenteDelDia('claude', tarde).id === lenteDelDia('claude', mediodia).id, 'y la lente no cambia dentro de la sesión');
}

// ── 3) LA COLA ───────────────────────────────────────────────────────
console.log('\n── 3) la cola: la lente sobrevive al recorte, la lista no ──');
{
  const movers = Array.from({ length: 30 }, (_, i) => ({ symbol: 'SYM' + i }));
  const t = buildTail({ agentId: 'claude', runId: 'r1', movers, now: new Date('2026-09-16T14:00:00Z') });
  ok(t.tokens_est <= TAIL_TOKEN_CAP, `la cola cabe en el techo (${t.tokens_est} ≤ ${TAIL_TOKEN_CAP})`, String(t.tokens_est));
  ok(/YOUR LENS TODAY/.test(t.text), 'lleva la lente');
  ok(/carries no ranking/.test(t.text),
    'y AVISA que el orden no es un ranking — si no, el modelo leería la aleatorización como una señal');
  ok(/where to START, not a restriction/.test(t.text), 'la lente se presenta como punto de partida, no como prohibición');
  ok(t.order.length === 30 && new Set(t.order).size === 30, 'con todos los nombres, sin duplicar');

  const enorme = buildTail({ agentId: 'claude', runId: 'r1', movers: Array.from({ length: 5000 }, (_, i) => ({ symbol: 'X' + i })), now: new Date() });
  ok(enorme.truncated === true && enorme.tokens_est <= TAIL_TOKEN_CAP * 1.1,
    'una lista enorme se recorta al techo', `${enorme.tokens_est} tokens`);
  ok(/YOUR LENS TODAY/.test(enorme.text),
    'y la LENTE sobrevive al recorte: son 40 tokens y es la mitad del mecanismo');
  ok(/truncado/.test(enorme.text), 'el recorte se declara');
}

// ── 4) LAS MÉTRICAS ──────────────────────────────────────────────────
console.log('\n── 4) las métricas del post-mortem ──');
{
  const libros = {
    claude: { NVDA: 0.20, AAPL: 0.10 },
    openai: { NVDA: 0.20, MSFT: 0.10 },
    grok: { NVDA: 0.15, TSLA: 0.10 },
    qwen: { KO: 0.10 },
  };
  const top = sharedTopTicker(libros);
  ok(top.ticker === 'NVDA' && top.books === 3 && top.pct === 75, 'el ticker más común y en cuántos libros', JSON.stringify(top));
  ok(sharedTopTicker({}).ticker === null, 'sin libros, null y no un ticker inventado');

  const ov = pairwiseOverlap(libros);
  ok(ov.pairs.length === 6, 'seis pares para cuatro agentes', String(ov.pairs.length));
  ok(ov.mean != null && ov.max != null, 'con promedio y máximo');
  const cq = ov.pairs.find((p) => p.a === 'claude' && p.b === 'qwen');
  ok(cq.cosine === 0, 'dos libros sin nombres en común dan coseno 0', String(cq.cosine));
  const co = ov.pairs.find((p) => p.a === 'claude' && p.b === 'openai');
  ok(co.cosine > 0.7, 'dos libros que comparten la posición grande dan coseno alto', String(co.cosine));

  // El caso degenerado que importa.
  const conVacio = pairwiseOverlap({ a: { NVDA: 0.2 }, b: {} });
  ok(conVacio.pairs[0].cosine === null,
    'un libro VACÍO devuelve null, no 0 ni 1: no se parece ni se diferencia, simplemente no hay con qué comparar');
  ok(conVacio.mean === null, 'y no contamina el promedio');

  // Idénticos → 1.
  ok(pairwiseOverlap({ a: { NVDA: 0.2 }, b: { NVDA: 0.2 } }).pairs[0].cosine === 1, 'dos libros idénticos dan 1');
  // La dirección importa: largo vs corto del mismo nombre NO es solapamiento.
  ok(pairwiseOverlap({ a: { NVDA: 0.2 }, b: { NVDA: -0.2 } }).pairs[0].cosine === -1,
    'largo contra corto del mismo nombre da −1: la dirección cuenta, no solo el nombre');
}

console.log('\n── herramienta vs tablero: ¿sirvieron las herramientas? ──');
{
  const r = toolVsBoardOrigin(
    { NVDA: 0.2, KO: 0.1, XYZ: 0.05 },
    { toolSymbols: new Set(['KO']), boardSymbols: new Set(['NVDA']) },
  );
  ok(r.from_tool.join() === 'KO' && r.from_board.join() === 'NVDA', 'separa por procedencia', JSON.stringify(r));
  ok(r.pct_from_tool === 33.3, 'con el porcentaje que dice si las herramientas aportaron algo', String(r.pct_from_tool));
  ok(r.unanchored === 1 && r.from_neither.join() === 'XYZ',
    'y un nombre que no vino de ninguno de los dos se cuenta APARTE: lo trajo de su memoria, no de los datos de hoy');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
