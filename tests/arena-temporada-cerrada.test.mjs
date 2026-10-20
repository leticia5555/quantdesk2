// ═══════════════════════════════════════════════════════════════
// tests/arena-temporada-cerrada.test.mjs — UNA TEMPORADA QUE NO ARRANCÓ
// NO TIENE RENDIMIENTO.
//
// LA INCOHERENCIA, dentro de UNA sola respuesta de /api/leaderboard
// (Lety, 2026-10-18):
//
//   temporada: { abierta: false, corrida_dias: 0 }
//   benchmark: { abierto: false, return_pct: null, detalle: "…" }
//   agents:    los siete CON rendimiento y CON puesto (deepseek +2.79 … control −5.26)
//
// «La fila del índice se niega a dar un número y las filas de los agentes no.
// Dentro de la misma respuesta.»
//
// Esos +2.79 y −5.26 son los libros HEREDADOS de la T2, medidos contra el
// baseline del último reset y publicados como si fueran el rendimiento de una
// temporada que no empezó. Es lo primero que se mira el día 1.
//
// Y lo que lo hace peor: la regla ya existía, aplicada a UNA fila de ocho.
// `filaBenchmark` devuelve `abierto: false`, `return_pct: null` y un `detalle`
// con el motivo desde que se escribió. Las siete filas que faltaban usaban el
// mismo campo `return_pct` y no la misma regla.
//
// LO QUE ESTE ARCHIVO FIJA:
//   1. CON LA TEMPORADA CERRADA se niega todo lo que se mide contra el
//      baseline de la temporada, y NO se niega lo que es un hecho de hoy.
//   2. EL ORDEN TAMBIÉN SE NIEGA. `rank: null` mientras se sigue ordenando por
//      equity publica un ranking sin llamarlo ranking.
//   3. CON LA TEMPORADA ABIERTA no se toca NADA. Una negación que se dispara
//      cuando no debe apagaría la tabla el día 1 por la mañana.
//   4. LA MISMA FORMA QUE EL BENCHMARK: el campo se llama `detalle`, igual que
//      el de la fila del índice, para que la pantalla lea uno solo.
//   5. UNA LISTA VACÍA NO ES UNA AUSENCIA. El post-mortem filtra por
//      `Number.isFinite(return_pct)`, así que con las filas negadas devolvería
//      `[]` — y `[]` se lee como "ningún agente le ganó al índice".
//
// Correr con `node tests/arena-temporada-cerrada.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { negarSiTemporadaCerrada, ordenarRanking, DETALLE_TEMPORADA_CERRADA } from '../api/leaderboard.js';
import { filaBenchmark } from '../api/_lib/arena-benchmark.js';
import { temporadaEfectiva, ARENA_SEASON } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Las filas reales que Lety vio, con los números que vio.
const filas = () => [
  { id: 'deepseek', name: 'DeepSeek', model: 'ds', has_keys: true, control: false,
    account: { equity: 102790 }, baseline_equity: 100000,
    return_pct: 2.79, day_change_pct: 0.41, exceso_pp: 1.2, rank: 1, margen: { empate_con: ['grok'] } },
  { id: 'claude', name: 'Claude', model: 'cl', has_keys: true, control: false,
    account: { equity: 99120 }, baseline_equity: 98500,
    return_pct: 0.63, day_change_pct: -0.08, exceso_pp: -0.9, rank: 4, margen: null },
  { id: 'control', name: 'Control · Fable-B', model: 'cl', has_keys: true, control: true,
    account: { equity: 94740 }, baseline_equity: 100000,
    return_pct: -5.26, day_change_pct: -0.12, exceso_pp: -6.8, rank: 7, margen: null },
];

// El estado que de verdad devolvió producción.
const CERRADA = temporadaEfectiva(null);

// ── 1) QUÉ SE NIEGA Y QUÉ NO ─────────────────────────────────────────
console.log('\n── sin temporada no hay desde dónde medir ──');
{
  ok(CERRADA.abierta === false, 'sin fila de arranque, `temporadaEfectiva` dice abierta:false', JSON.stringify({ abierta: CERRADA.abierta, dias: CERRADA.corrida_dias }));

  const n = negarSiTemporadaCerrada(filas(), CERRADA);

  // SE NIEGA: todo lo que se mide CONTRA el baseline de la temporada.
  for (const campo of ['return_pct', 'exceso_pp', 'rank', 'margen']) {
    ok(n.every((r) => r[campo] === null), `\`${campo}\` se niega en las tres filas`,
      JSON.stringify(n.map((r) => r[campo])));
  }
  ok(!n.some((r) => r.return_pct === 0),
    'y se niega con null, NO con cero: "no existe" y "no se movió" son cosas opuestas');

  // SE QUEDA: lo que es un hecho de HOY.
  ok(n[0].account.equity === 102790, '`equity` se queda: la cuenta tiene ese dinero', String(n[0].account.equity));
  ok(n[0].day_change_pct === 0.41, '`day_change_pct` se queda: es lo que se movió hoy, no una afirmación sobre la temporada');
  ok(n[1].baseline_equity === 98500,
    '`baseline_equity` se queda: es lo que escribió el último reset, y el dato con el que se verifica el próximo');
  ok(n.every((r) => r.id && r.name), 'y la identidad de la fila no se toca');
}

// ── 2) EL ORDEN TAMBIÉN AFIRMA ───────────────────────────────────────
console.log('\n── un ranking sin llamarlo ranking sigue siendo un ranking ──');
{
  const n = negarSiTemporadaCerrada(filas(), CERRADA);
  const bench = filaBenchmark(null, null);
  const r = ordenarRanking({ agentes: n, bench, rankear: false });

  ok(r.every((x) => x.rank === null), 'ningún puesto', JSON.stringify(r.map((x) => x.rank)));
  // EL ORDEN ES EL DEL REGISTRO, no el de equity. Si fuera por equity,
  // deepseek (102.790) seguiría primero y control (94.740) último — que es
  // exactamente la lectura que se quiere apagar. Acá el orden es el de entrada.
  ok(r.map((x) => x.id).join(',') === 'deepseek,claude,control,' + bench.id,
    'el orden es el de entrada (registro), con el índice al final', r.map((x) => x.id).join(','));
  ok(/NO un ranking/.test(r[0].orden_nota || ''), 'y la fila lo DICE, no hay que deducirlo', r[0].orden_nota);

  // El contraejemplo: con `rankear: true` sobre las MISMAS filas negadas, el
  // orden se decide por equity y vuelve a afirmar. Por eso hace falta la
  // bandera y no alcanza con negar los campos.
  const afirma = ordenarRanking({ agentes: n, bench, rankear: true });
  ok(afirma[0].id === 'deepseek' && afirma[afirma.length - 1].equity === null,
    'y con rankear:true las mismas filas negadas SÍ se ordenan por equity — por eso la bandera existe',
    afirma.map((x) => x.id).join(','));
}

// ── 3) CON LA TEMPORADA ABIERTA NO SE TOCA NADA ──────────────────────
console.log('\n── una negación que se dispara cuando no debe apaga la tabla el día 1 ──');
{
  const originales = filas();
  const abierta = { ...CERRADA, abierta: true, corrida_dias: 3 };
  const r = negarSiTemporadaCerrada(originales, abierta);
  ok(r === originales, 'devuelve el MISMO array, sin copiar ni tocar');
  ok(r[0].return_pct === 2.79 && r[0].rank === 1, 'y los números siguen ahí', JSON.stringify({ ret: r[0].return_pct, rank: r[0].rank }));

  const rk = ordenarRanking({ agentes: r, bench: filaBenchmark(null, null), rankear: true });
  ok(rk[0].id === 'deepseek' && rk[0].rank === 1, 'el ranking se calcula normal', JSON.stringify(rk.map((x) => ({ id: x.id, rank: x.rank }))));
  ok(rk.every((x) => x.orden_nota === undefined), 'y no aparece la nota del orden neutro');
}

// ── 4) LA MISMA FORMA QUE EL BENCHMARK ───────────────────────────────
console.log('\n── el campo tiene que ser el mismo que ya lee la pantalla ──');
{
  const bench = filaBenchmark(null, null);
  const n = negarSiTemporadaCerrada(filas(), CERRADA);
  ok(typeof bench.detalle === 'string' && bench.detalle.length > 10, 'el benchmark cerrado trae `detalle`', bench.detalle);
  ok(n.every((r) => typeof r.detalle === 'string' && r.detalle.length > 10),
    'y las filas de agentes traen el MISMO campo `detalle`');
  ok(n.every((r) => r.temporada_abierta === false),
    'más la bandera explícita, para no tener que parsear la prosa');
  ok(bench.return_pct === null && n.every((r) => r.return_pct === null),
    'y las ocho filas se niegan igual: ninguna da número');

  // La constante se exporta para que la prosa viva en UN lugar. Si se duplicara
  // en la pantalla, los dos textos divergirían — es el patrón de B41.
  ok(DETALLE_TEMPORADA_CERRADA === n[0].detalle, '`DETALLE_TEMPORADA_CERRADA` es exactamente lo que sale en la fila');
  ok(/reset/.test(DETALLE_TEMPORADA_CERRADA), 'y nombra la causa real: el reset no corrió', DETALLE_TEMPORADA_CERRADA);
}

// ── 5) EL POST-MORTEM NO PUEDE DEVOLVER UNA LISTA VACÍA ──────────────
console.log('\n── [] se lee como "ninguno le ganó al índice", que es una afirmación ──');
{
  const FUENTE = readFileSync('api/leaderboard.js', 'utf8');
  // Estructural: el guard tiene que estar ANTES de armar `body.post_mortem`
  // con `excesoVsBenchmark`, o el `[]` sale igual.
  const iGuard = FUENTE.indexOf('body.post_mortem = {\n        disponible: false');
  const iCalc = FUENTE.indexOf('body.post_mortem = excesoVsBenchmark(');
  ok(iGuard > 0, 'hay un post_mortem con `disponible: false`');
  ok(iCalc > 0 && iGuard < iCalc, 'y está ANTES del cálculo, no después', `guard@${iGuard} calc@${iCalc}`);
  ok(/aviso: DETALLE_TEMPORADA_CERRADA/.test(FUENTE),
    'y la cabecera lleva el aviso, para el consumidor que no baja a las filas');
}

// ── 6) LA NEGACIÓN VIVE EN UN SOLO LUGAR ─────────────────────────────
console.log('\n── negar en tres consumidores es tener la regla escrita tres veces ──');
{
  const FUENTE = readFileSync('api/leaderboard.js', 'utf8');
  const llamadas = (FUENTE.match(/negarSiTemporadaCerrada\(/g) || []).length;
  // Una en la definición, una en el handler. Si aparece una tercera, alguien
  // la está aplicando otra vez en un consumidor.
  ok(llamadas === 2, 'se llama UNA vez en el handler (más la definición)', String(llamadas));
  ok(/if \(!temporada\.abierta\) \{\n    const negadas = negarSiTemporadaCerrada/.test(FUENTE),
    'y se aplica sobre `rows`, que es lo que leen el ranking, el margen y el post-mortem');
  // Y la temporada se lee del arranque REAL, no de la constante planeada: una
  // `ARENA_SEASON.start` que ya pasó volvería `abierta` sola con el tiempo.
  ok(/temporadaEfectiva\(await leerInicioTemporada\(/.test(FUENTE),
    'la temporada sale del arranque que escribió el reset, no de la fecha planeada');
  ok(ARENA_SEASON.id === 'T3', 'y la temporada declarada sigue siendo la T3', ARENA_SEASON.id);
}

// ── 7) Y LA PANTALLA TIENE QUE DECIR LA CAUSA CORRECTA ───────────────
// `armaArena` ya publicaba un motivo por cada rendimiento ausente — y con las
// filas negadas caía en el genérico "el leaderboard no trajo el rendimiento de
// este agente", que manda a revisar el leaderboard cuando el leaderboard está
// bien. Es el mismo error que esa función vino a arreglar, un escalón arriba.
console.log('\n── un null con la causa equivocada manda a buscar el bug donde no está ──');
{
  const { armaArena } = await import('../api/_lib/mercado-paneles.js');

  const negadas = negarSiTemporadaCerrada(filas(), CERRADA);
  const t = armaArena({ agents: negadas });
  ok(t.agentes.every((f) => f.pct === null), 'la tarjeta no pinta ningún %', JSON.stringify(t.agentes.map((f) => f.pct)));
  // `/i`: la frase que se PINTA empieza en mayúscula —"Temporada nueva sin
  // arrancar · el reset no ha corrido"— porque es una línea de tarjeta, no un
  // campo de API. Lo que esta prueba fija es que nombre la temporada y no al
  // leaderboard, y eso no cambia. El párrafo largo del leaderboard sigue
  // viajando, en `pct_detalle` (2026-10-20).
  ok(t.agentes.every((f) => /temporada/i.test(f.pct_motivo || '')),
    'y el motivo nombra la TEMPORADA, no el leaderboard', t.agentes[0].pct_motivo);
  ok(t.agentes.every((f) => (f.pct_motivo || '').length < 70),
    'y cabe en UNA línea: el detalle técnico no se pinta', String((t.agentes[0].pct_motivo || '').length));
  ok(t.agentes.every((f) => f.pct_detalle && /baseline/.test(f.pct_detalle)),
    'pero el detalle no se pierde: viaja aparte', String(t.agentes[0].pct_detalle || '').slice(0, 40));
  ok(!t.agentes.some((f) => /no trajo el rendimiento/.test(f.pct_motivo || '')),
    'el genérico no aparece: las llaves y el baseline están bien');

  // Las otras tres causas siguen funcionando — esto se mete ADELANTE, no en
  // lugar de ellas.
  const sinLlaves = armaArena({ agents: [{ id: 'x', name: 'X', has_keys: false, return_pct: null }] });
  ok(/llaves de Alpaca/.test(sinLlaves.agentes[0].pct_motivo || ''),
    'un agente sin llaves sigue diciendo que le faltan las llaves', sinLlaves.agentes[0].pct_motivo);

  // Y con la temporada ABIERTA el campo no viaja: un `undefined` no puede
  // disparar la causa nueva.
  const abiertaSinRet = armaArena({ agents: [{ id: 'y', name: 'Y', has_keys: true, account: { equity: 1 }, baseline_equity: 1, return_pct: null }] });
  ok(!/temporada/.test(abiertaSinRet.agentes[0].pct_motivo || ''),
    'sin el campo `temporada_abierta`, la causa nueva NO se dispara', abiertaSinRet.agentes[0].pct_motivo);
}

console.log(failures ? `\n${failures} FALLARON\n` : '\nTODO VERDE\n');
process.exit(failures ? 1 : 0);
