// ═══════════════════════════════════════════════════════════════
// tests/arena-abortos-saldo.test.mjs — UN ABORTO POR FALTA DE SALDO NO
// ES UN ABORTO DEL MODELO.
//
// EL DATO (producción, 2026-09-26). Los 52 abortos con `terminó_por: error`,
// por mensaje literal del proveedor:
//
//     "This request requires more credits…"        33   OpenRouter
//     "Your credit balance is too low…"            13   Anthropic
//     "This request would exceed your available…"   2   OpenRouter
//     "This request's maximum cost exceeds…"        1
//     "OpenRouter could not verify avail…"          1
//     "The operation was aborted"                   1
//     "se pasó de 10s (abortado a los 10002ms)"     1
//
// **48 de 52 son falta de saldo.** Sobre los 84 abortos de la temporada, el
// 57% son las dos cuentas sin crédito, en días distintos. Los racimos que
// encontramos no eran "el proveedor falló": era que se acabó el dinero.
//
// Y hasta hoy `/liga` los contaba junto con "el modelo no contestó". Es el
// mismo error de categoría que contar `ok_no_actions` como aborto, en la
// dirección opuesta: **le carga al modelo una falla de la cuenta.** Si Qwen
// tiene 31 abortos y la mitad son saldo, sus manos jugadas no son culpa suya,
// y la tabla que las publica al lado del retorno atribuye mal.
//
// Lo que este archivo fija:
//   1. LAS FIRMAS REALES SE RECONOCEN, con el texto literal de producción.
//   2. NO SE CLASIFICA DE MÁS. Un falso positivo BORRA un fallo real del
//      modelo de la columna que lo tiene que mostrar — es peor que no separar.
//   3. LAS DOS COLUMNAS SUMAN EL TOTAL. El total sigue siendo el total.
//   4. EL TECHO DE MANOS ES UNA COTA, NO UNA ESTIMACIÓN, y se llama así.
//   5. LA PANTALLA LAS PINTA DISTINTO, y la fila del agente solo muestra la
//      que habla de él.
//
// Correr con `node tests/arena-abortos-saldo.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { esAbortoDeSaldo, manosPorAgente, manosDeLaLiga, comparabilidad } from '../api/_lib/arena-manos.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const ab = (error, extra = {}) => ({ agent_id: 'x', status: 'aborted_llm_error', error, ...extra });

// ── 1) LAS SIETE FIRMAS DE PRODUCCIÓN ────────────────────────────────
// Los textos son los literales que devolvió cada proveedor, no paráfrasis.
console.log('\n── los mensajes reales de las 84 corridas ──');
{
  const SALDO = [
    ['This request requires more credits, or fewer max_tokens. You requested up to 6000 tokens', 'OpenRouter, 33 casos'],
    ['Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing', 'Anthropic, 13 casos'],
    ['This request would exceed your available credit balance', 'OpenRouter, 2 casos'],
    ["This request's maximum cost exceeds your remaining balance", 'OpenRouter, 1 caso'],
    ['OpenRouter could not verify available credits for this request', 'OpenRouter, 1 caso'],
  ];
  for (const [txt, origen] of SALDO) {
    ok(esAbortoDeSaldo(ab(txt)), `se reconoce: ${origen}`, txt.slice(0, 40));
  }

  // Las DOS que NO son saldo, de la misma tabla. Son las que tienen que
  // sobrevivir en la columna del modelo.
  ok(!esAbortoDeSaldo(ab('The operation was aborted')),
    'y "The operation was aborted" NO es saldo: es un fallo real que queda en la columna del modelo');
  ok(!esAbortoDeSaldo(ab('se pasó de 10s (abortado a los 10002ms)')),
    'ni el corte de 10s — ése es NUESTRO reparto de reloj, ni del modelo ni de la cuenta');
}

// ── 2) NO SE CLASIFICA DE MÁS ────────────────────────────────────────
// Un falso positivo acá saca un fallo del modelo de la vista. Es el error más
// caro de los dos, porque el que borra es el dato que la tabla existe para
// mostrar.
console.log('\n── lo que NO se cuenta como saldo ──');
{
  ok(!esAbortoDeSaldo(ab('HTTP 500: internal server error')), 'un 500 no es saldo');
  ok(!esAbortoDeSaldo(ab('cuerpo_vacio: el proveedor cerró el stream sin cuerpo')), 'un cuerpo vacío tampoco');
  ok(!esAbortoDeSaldo(ab('rate limit exceeded, please retry')), 'ni un rate limit: es otra cosa y se arregla distinto');
  ok(!esAbortoDeSaldo(ab(null)) && !esAbortoDeSaldo(ab('')),
    'sin texto NO se adivina: un aborto sin motivo cuenta como del modelo, que es la lectura conservadora');
  ok(!esAbortoDeSaldo({ agent_id: 'x', status: 'ok_target', error: 'requires more credits' }),
    'y una corrida VIVA nunca es un aborto, diga lo que diga su texto');

  // El texto puede venir en la columna o en el detalle del proveedor: las
  // filas viejas de la temporada tienen `error` en null (se perdía hasta el
  // 2026-09-26) y solo traen `context.llm_error`.
  ok(esAbortoDeSaldo({ agent_id: 'x', status: 'aborted_llm_error', error: null,
    context: { llm_error: { provider_error: 'This request requires more credits' } } }),
    'se mira también dentro de context.llm_error: las filas viejas no tienen la columna');
}

// ── 3) LAS DOS COLUMNAS SUMAN EL TOTAL ───────────────────────────────
console.log('\n── el corte no cambia el total ──');
{
  const m = manosPorAgente([
    { agent_id: 'qwen', status: 'ok_target' },
    ...Array(15).fill(ab('This request requires more credits')).map((f) => ({ ...f, agent_id: 'qwen' })),
    ...Array(8).fill(ab('cuerpo_vacio: el proveedor cerró el stream')).map((f) => ({ ...f, agent_id: 'qwen' })),
  ]);
  const q = m.get('qwen');
  ok(q.abortadas === 23 && q.abortadas_saldo === 15 && q.abortadas_modelo === 8,
    'saldo + modelo = abortadas', JSON.stringify([q.abortadas_saldo, q.abortadas_modelo, q.abortadas]));
  ok(q.corridas === 24 && q.pct_abortos === 95.8,
    'el total y su porcentaje no se movieron: sigue habiendo 23 abortos', String(q.pct_abortos));
  ok(q.pct_abortos_modelo === 33.3,
    'y aparece el porcentaje ATRIBUIBLE, que es el que va al lado del retorno', String(q.pct_abortos_modelo));
}

// ── 4) EL TECHO ES UNA COTA ──────────────────────────────────────────
// `techo_de_manos` = vivas + abortos de saldo. NO es "las manos que habría
// jugado": un modelo puede abortar por su cuenta en una corrida que el saldo
// le impidió intentar. Es una cota superior, y el nombre lo dice.
console.log('\n── una cota, y se llama cota ──');
{
  const m = manosPorAgente([
    { agent_id: 'a', status: 'ok_target' }, { agent_id: 'a', status: 'ok_no_actions' },
    ab('Your credit balance is too low'), ab('HTTP 500'),
  ].map((f) => ({ ...f, agent_id: 'a' })));
  const a = m.get('a');
  ok(a.techo_de_manos === 3, 'techo = vivas + saldo, no vivas + todos los abortos', String(a.techo_de_manos));
  ok(a.techo_de_manos >= a.vivas, 'y nunca es menor que las manos reales');

  const src = readFileSync(new URL('../api/_lib/arena-manos.js', import.meta.url), 'utf8');
  ok(/es una COTA, no una estimación/.test(src),
    'el código dice que es una cota, para que nadie la reporte como "las manos que le faltaron"');
}

// ── 5) EL RESUMEN DE LIGA DICE DE QUIÉN ES LA FALLA ──────────────────
console.log('\n── la liga, con la culpa separada ──');
{
  const filas = [];
  const meter = (id, vivas, saldo, modelo) => {
    for (let i = 0; i < vivas; i++) filas.push({ agent_id: id, status: 'ok_target' });
    for (let i = 0; i < saldo; i++) filas.push({ ...ab('This request requires more credits'), agent_id: id });
    for (let i = 0; i < modelo; i++) filas.push({ ...ab('cuerpo_vacio'), agent_id: id });
  };
  meter('control', 37, 0, 0); meter('qwen', 3, 16, 6);
  const r = comparabilidad(manosPorAgente(filas));

  ok(r.abortadas_saldo === 16 && r.abortadas_modelo === 6, 'el resumen trae las dos', JSON.stringify([r.abortadas_saldo, r.abortadas_modelo]));
  ok(/LA CUENTA SIN SALDO, no el modelo/.test(r.culpa || ''),
    'y lo dice con todas las letras', r.culpa);
  ok(/no jugó menos manos por ser peor/.test(r.culpa || ''),
    'incluyendo por qué eso cambia la lectura de la tabla');

  // `culpa` es un campo APARTE de `lectura`: son dos objeciones distintas y
  // juntarlas en un párrafo hace que se lea una sola.
  ok(!/SIN SALDO/.test(r.lectura), 'la lectura sigue hablando solo de comparabilidad: son dos objeciones, no una');
  // Sin abortos de saldo no se inventa el bloque.
  const limpio = comparabilidad(manosPorAgente([
    ...Array(10).fill({ agent_id: 'a', status: 'ok_target' }),
    ...Array(9).fill({ agent_id: 'b', status: 'ok_target' }),
  ]));
  ok(limpio.culpa === null, 'y sin abortos de saldo el bloque no aparece');
}

// ── 6) LA PANTALLA ───────────────────────────────────────────────────
console.log('\n── /liga las pinta distinto ──');
{
  const api = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');

  ok(/left\(error, 300\) as error/.test(api),
    'la consulta trae el texto del error: sin él no hay nada que clasificar');
  ok(/'provider_error', left\(context->'llm_error'->>'provider_error', 300\)/.test(api),
    'y el detalle del proveedor, para las filas viejas sin la columna');

  ok(/abortadas_saldo/.test(page) && /abortadas_modelo/.test(page), 'la página lee las dos');
  ok(/sin saldo/.test(page) && /del modelo/.test(page), 'y las nombra distinto');
  ok(/var\(--amber\)/.test(page.slice(page.indexOf('function manosHtml'), page.indexOf('function manosHtml') + 1600)),
    'con color distinto: solo una de las dos habla del agente');
  ok(/culpa-saldo/.test(page), 'y el bloque de la liga tiene su lugar propio');

  // En la FILA del agente solo va el aborto del modelo: es el único que dice
  // algo del puesto que se está leyendo.
  const fila = page.slice(page.indexOf('const manosTag'), page.indexOf('const manosTag') + 900);
  ok(/abModelo\?' · '\+abModelo\+' abortos'/.test(fila),
    'la fila cuenta solo los abortos del modelo en el conteo principal');
  ok(/no jugó menos manos por ser peor/.test(fila),
    'y los de saldo se explican en el title, sin cargárselos al agente');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
