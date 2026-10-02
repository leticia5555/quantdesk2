// ═══════════════════════════════════════════════════════════════
// tests/arena-reparto-reloj.test.mjs — LA BANDA DONDE EL LOOP EMPEZABA
// UNA VUELTA QUE NO PODÍA PAGAR.
//
// EL DATO (producción, 2026-09-26): de los 23 abortos por `cuerpo_vacio` de la
// temporada, 17 traían datos y **13 eran NUESTRO reloj**. El número que
// aparecía era **10.002 ms**.
//
// Yo había predicho 70.002 —la reserva de cierre— razonando desde B23, donde
// el número fue 45.002 y era `RESERVA_CIERRE_MS` de entonces. El mecanismo era
// el correcto (un techo NUESTRO cortando la lectura del cuerpo) y la constante
// la equivocada: era el PISO de la vuelta, no la reserva. **Por eso este
// archivo fija el mecanismo y deriva los números, en vez de clavarlos: el
// número ya se movió una vez.**
//
// LA CAUSA, que es aritmética y se resuelve antes del prompt:
//
//   guarda:  cortar si  restante < RESERVA
//   techo:   max(PISO, restante − RESERVA)
//
// Dos reglas sobre el MISMO presupuesto, escritas por separado, que se
// contradicen en una banda de exactamente el ancho del piso:
//
//     restante 80s → techo 10s   ok, el borde
//     restante 79s → techo 10s   ← el piso levanta un techo de 9s
//     restante 71s → techo 10s   ← …y de 1s, comiéndose la reserva
//     restante 70s → techo 10s
//     restante 69s → corta
//
// Ahí adentro el loop arrancaba una vuelta con diez segundos —por debajo de
// CUALQUIER vuelta exitosa observada (13s, 23s, 32s en B23)— y se los sacaba
// al cierre. La vuelta moría leyendo el cuerpo: `cuerpo_vacio`,
// `timeout_nuestro: true`, `ms ≈ 10002`.
//
// Lo que este archivo fija:
//   1. LA GUARDA SE DERIVA DEL PISO. No es un número al lado del otro.
//   2. LA BANDA ESTÁ CERRADA, barrida milisegundo a milisegundo en su entorno.
//   3. LA RESERVA DEL CIERRE NUNCA SE TOCA. Es lo que garantiza que una
//      corrida perdida igual decida.
//   4. Y SIGUE ENTRANDO TRABAJO: cerrar la banda no puede costar las vueltas
//      que sí se podían pagar.
//
// Correr con `node tests/arena-reparto-reloj.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  RESERVA_CIERRE_MS, PISO_VUELTA_MS, MARGEN_MS, minimoParaOtraVuelta, relojDisponible,
} from '../api/_lib/arena-tool-loop.js';
import { ARENA_LLM_TIMEOUT_MS, ARENA_AGENT_DEADLINE_MS } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// El techo de una vuelta, tal cual lo calcula el loop.
const techoDe = (restante) => Math.max(PISO_VUELTA_MS, restante - RESERVA_CIERRE_MS);
// Y si el loop la arranca.
const arranca = (restante) => restante >= minimoParaOtraVuelta();

// ── 1) LA GUARDA SALE DEL PISO ───────────────────────────────────────
console.log('\n── las dos reglas salen del mismo número ──');
{
  ok(minimoParaOtraVuelta() === RESERVA_CIERRE_MS + PISO_VUELTA_MS,
    'el mínimo para otra vuelta es reserva + piso, derivado', String(minimoParaOtraVuelta()));

  // Y se deriva de verdad: si el piso cambia, la guarda lo sigue. Un número
  // escrito al lado del otro pasaría esta línea solo por casualidad.
  ok(minimoParaOtraVuelta(60000, 25000) === 85000,
    'y sigue al piso cuando el piso cambia: es una derivación, no dos constantes que hoy coinciden',
    String(minimoParaOtraVuelta(60000, 25000)));

  const src = readFileSync(new URL('../api/_lib/arena-tool-loop.js', import.meta.url), 'utf8');
  ok(/restante\(\) < minimoParaOtraVuelta\(\)/.test(src),
    'el loop usa la derivación en la guarda, no `< RESERVA_CIERRE_MS`');
  ok(!/restante\(\) < RESERVA_CIERRE_MS/.test(src),
    'y la guarda vieja ya no está: era la mitad de la contradicción');
  ok(/Math\.max\(PISO_VUELTA_MS,/.test(src) && !/Math\.max\(10000,/.test(src),
    'el techo usa la constante y no un 10000 escrito a mano — el otro medio');
}

// ── 2) LA BANDA, BARRIDA ─────────────────────────────────────────────
// No tres casos elegidos: todo el entorno de la frontera, de a un
// milisegundo. Una banda de ancho 1 sobreviviría a tres muestras.
console.log('\n── la banda de contradicción está cerrada ──');
{
  const malos = [];
  for (let r = RESERVA_CIERRE_MS - 5000; r <= minimoParaOtraVuelta() + 5000; r++) {
    if (!arranca(r)) continue;
    // Si arranca, el techo NO puede venir del piso: tiene que salir de la
    // resta. Que el `max` no muerda nunca es la definición de banda cerrada.
    if (r - RESERVA_CIERRE_MS < PISO_VUELTA_MS) malos.push(r);
  }
  ok(malos.length === 0,
    `barrido de ${RESERVA_CIERRE_MS - 5000} a ${minimoParaOtraVuelta() + 5000} ms: el piso no levanta ningún techo`,
    malos.length ? `${malos.length} ms donde todavía arranca sin poder pagar (p.ej. ${malos[0]})` : undefined);

  // Y la frontera exacta, por si el barrido se rompiera algún día.
  ok(!arranca(minimoParaOtraVuelta() - 1), 'un milisegundo por debajo del mínimo NO arranca');
  ok(arranca(minimoParaOtraVuelta()), 'y justo en el mínimo sí, con el techo igual al piso');
  ok(techoDe(minimoParaOtraVuelta()) === PISO_VUELTA_MS,
    'en el borde el techo es exactamente el piso: ni un ms de la reserva', String(techoDe(minimoParaOtraVuelta())));
}

// ── 3) LA RESERVA DEL CIERRE ES INTOCABLE ────────────────────────────
// Es lo que convierte una corrida perdida en una decisión. Si una vuelta se la
// come, el cierre arranca con menos reloj del que se le prometió — y el cierre
// es la llamada que produce el JSON.
console.log('\n── el cierre siempre cobra su reserva completa ──');
{
  const robos = [];
  for (let r = minimoParaOtraVuelta(); r <= relojDisponible({ scanMs: 0 }); r += 137) {
    const queda = r - techoDe(r);
    if (queda < RESERVA_CIERRE_MS) robos.push({ r, queda });
  }
  ok(robos.length === 0,
    'ninguna vuelta le deja al cierre menos que su reserva',
    robos.length ? `${robos.length} casos, p.ej. restante ${robos[0].r} → cierre con ${robos[0].queda}` : undefined);

  // El caso exacto que producía los 10.002 en producción.
  ok(!arranca(71000),
    'con 71s restantes ya NO se arranca una vuelta: antes le daba 10s y le robaba 9 al cierre');
  ok(71000 >= RESERVA_CIERRE_MS,
    'y 71s superaba la guarda VIEJA, que es por qué el bug existía', `guarda vieja: ${RESERVA_CIERRE_MS}`);
}

// ── 4) CERRAR LA BANDA NO COSTÓ VUELTAS ÚTILES ───────────────────────
// El arreglo barato habría sido subir la reserva, y habría comido
// investigación. Esto solo saca las vueltas que no se podían pagar.
console.log('\n── y el trabajo que sí entraba sigue entrando ──');
{
  const presupuesto = relojDisponible({ scanMs: 0 });
  ok(arranca(presupuesto), 'la primera vuelta arranca con el presupuesto entero');
  ok(techoDe(presupuesto) === presupuesto - RESERVA_CIERRE_MS,
    'y se lleva todo menos la reserva', `${techoDe(presupuesto)} de ${presupuesto}`);

  // Una vuelta de 15s —por encima de la más rápida observada en B23 (13s)—
  // sigue entrando. Si esto fallara, el arreglo habría sido demasiado caro.
  ok(arranca(RESERVA_CIERRE_MS + 15000) && techoDe(RESERVA_CIERRE_MS + 15000) === 15000,
    'una vuelta de 15s sigue cabiendo: el arreglo saca las condenadas, no las viables');

  // El presupuesto no se movió: esto es un reparto distinto, no menos reloj.
  ok(presupuesto === 270000 - RESERVA_CIERRE_MS - MARGEN_MS,
    'el presupuesto total del loop es el mismo de antes', String(presupuesto));
}

// ── 5) EL DIAGNÓSTICO DICE SI EL PISO ACTUÓ ──────────────────────────
// Con la guarda derivada, llegar al piso solo puede venir de un `timeoutMs`
// chico. Si vuelve a aparecer un 10.002, el journal tiene que decir de dónde.
console.log('\n── y si el piso vuelve a actuar, se sabe por qué ──');
{
  const src = readFileSync(new URL('../api/_lib/arena-tool-loop.js', import.meta.url), 'utf8');
  ok(/TECHO EN EL PISO/.test(src),
    'el `origenTecho` marca cuando el techo quedó en el piso');
  ok(/solo puede venir de un timeoutMs chico, no del reparto/.test(src),
    'y dice dónde mirar: con la guarda derivada el reparto ya no puede producirlo');
}

// ── 6) EL TERCER RELOJ: EL TECHO POR LLAMADA LLEGA AL LOOP ───────────
// EL CASO (2026-09-29): arreglamos la banda de 70-80s y abajo había OTRO
// reloj. Los cortes de ese día: 57.163ms, 32.992ms y un cierre con
// **104.984ms** de techo, los tres con `reloj_nuestro: true`.
//
// 104.984 no es una constante que alguien escribió: es `(185s + 70s) − 150s`
// de lo ya usado. `ARENA_LLM_TIMEOUT_MS` (90s) existe, está documentado y
// tiene hasta un campo `origen` para diagnosticarlo — y NO se le pasaba al
// loop. Adentro las dos aritméticas lo tratan como opcional
// (`|| Infinity`, `: disponible`), así que sin él el techo queda SIN TAPA.
//
// Es la misma forma que la banda: no un número mal elegido, sino un límite
// real que no alcanza al camino que corre.
console.log('\n── el techo por llamada, que no llegaba ──');
{
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  ok(/timeoutMs: ARENA_LLM_TIMEOUT_MS/.test(shadow),
    'el camino del objetivo le pasa el techo por llamada al loop');
  ok(/ARENA_LLM_TIMEOUT_MS \}? from '\.\/_lib\/arena-registry\.js'|ARENA_MAX_TOKENS, ARENA_LLM_TIMEOUT_MS/.test(shadow),
    'y lo importa del registry, no lo copia');

  // La aritmética del cierre, reproducida con el caso real.
  const B = relojDisponible({ scanMs: 0 });
  const cierre = (usado, tm) => {
    const d = Math.max(0, (B + RESERVA_CIERRE_MS) - usado);
    return Math.max(PISO_VUELTA_MS, tm ? Math.min(tm, d) : d);
  };
  ok(cierre(150016, undefined) === 104984,
    'el caso real reproduce: sin techo, el cierre recibía 104.984ms', String(cierre(150016, undefined)));
  ok(cierre(150016, ARENA_LLM_TIMEOUT_MS) === ARENA_LLM_TIMEOUT_MS,
    'con el techo, queda en 90s', String(cierre(150016, ARENA_LLM_TIMEOUT_MS)));

  // Y NINGÚN reparto puede superar el techo, barrido de punta a punta.
  const excedidos = [];
  for (let u = 0; u <= B + RESERVA_CIERRE_MS; u += 971) {
    if (cierre(u, ARENA_LLM_TIMEOUT_MS) > ARENA_LLM_TIMEOUT_MS) excedidos.push(u);
  }
  ok(excedidos.length === 0, 'y ningún reparto del cierre supera el techo', excedidos.slice(0, 3).join(', '));

  // La vuelta normal, lo mismo.
  const vuelta = (rest, tm) => Math.max(PISO_VUELTA_MS, Math.min(tm || Infinity, rest - RESERVA_CIERRE_MS));
  ok(vuelta(B, undefined) === B - RESERVA_CIERRE_MS && vuelta(B, ARENA_LLM_TIMEOUT_MS) === ARENA_LLM_TIMEOUT_MS,
    'la primera vuelta pasaba de 115s y ahora queda en 90s',
    `${vuelta(B, undefined)} → ${vuelta(B, ARENA_LLM_TIMEOUT_MS)}`);
}

// ── 7) EL INVENTARIO DE RELOJES, COMPLETO ────────────────────────────
// Lety: "ya nos pasó que el piso estaba escrito cuatro veces en un archivo, no
// quiero arreglar el tercero la semana que viene". Esto fija la lista: si
// aparece un reloj nuevo que no está acá, alguien lo agrega A ESTA LISTA o
// esta prueba no lo cubre — y el que no está en la lista es el próximo.
console.log('\n── todos los relojes de una corrida, enumerados ──');
{
  const RELOJES = {
    ARENA_AGENT_DEADLINE_MS: ARENA_AGENT_DEADLINE_MS,   // la corrida entera
    RESERVA_CIERRE_MS,                                   // el turno de cierre
    MARGEN_MS,                                           // Alpaca + journal
    PISO_VUELTA_MS,                                      // mínimo por vuelta
    ARENA_LLM_TIMEOUT_MS,                                // UNA llamada al LLM
  };
  for (const [n, v] of Object.entries(RELOJES)) {
    ok(Number.isFinite(v) && v > 0, `${n} está declarado y es un número`, String(v));
  }

  // LA DESIGUALDAD QUE TIENE QUE VALER: el techo de una llamada no puede
  // superar lo que el loop tiene para gastar, o el techo no acota nada.
  ok(ARENA_LLM_TIMEOUT_MS <= relojDisponible({ scanMs: 0 }),
    'el techo por llamada cabe dentro del presupuesto del loop',
    `${ARENA_LLM_TIMEOUT_MS} <= ${relojDisponible({ scanMs: 0 })}`);
  // Y la suma no puede pasarse del deadline del agente, o el `withDeadline`
  // mata la corrida antes de que el cierre alcance a escribir.
  ok(relojDisponible({ scanMs: 0 }) + RESERVA_CIERRE_MS + MARGEN_MS <= ARENA_AGENT_DEADLINE_MS,
    'presupuesto + reserva + margen cabe en el deadline del agente',
    `${relojDisponible({ scanMs: 0 }) + RESERVA_CIERRE_MS + MARGEN_MS} <= ${ARENA_AGENT_DEADLINE_MS}`);
}

// ── 8) EL CIERRE NO LLEVA EL TECHO POR LLAMADA ───────────────────────
// CORRECCIÓN DE B45, con evidencia de la corrida de humo del 1-oct 2026.
//
// En B45 leí un cierre con 104.984ms de techo y lo llamé "un límite real que
// no alcanzaba al camino que corre". **Era al revés.** El cierre sin techo
// está acotado POR CONSTRUCCIÓN:
//
//     usado + disponible = budgetMs + RESERVA = 255s, siempre
//     255s + MARGEN 15s  = 270s = el deadline, exacto
//
// Los 104.984ms no eran un techo suelto: eran el cierre tomando lo que le
// quedaba, que es su trabajo.
//
// Y ponerle el techo MATÓ A UN AGENTE: qwen se cortó en el cierre a 92.500ms
// exactos —el techo— con `reloj_nuestro: true`, habiendo usado 238s de 270.
// Sin techo ese cierre habría tenido ~109s.
//
// LA REGLA: el techo por llamada existe para que UNA llamada colgada no se
// coma el presupuesto de las SIGUIENTES. Después del cierre no hay siguientes.
console.log('\n── el cierre toma lo que queda, sin techo ──');
{
  const B = relojDisponible({ scanMs: 0 });
  const cierre = (usado) => Math.max(PISO_VUELTA_MS, Math.max(0, (B + RESERVA_CIERRE_MS) - usado));

  // El caso de qwen, reproducido.
  ok(cierre(146000) > ARENA_LLM_TIMEOUT_MS,
    'con 146s usados el cierre toma ~109s, MÁS que el techo por llamada: es lo que salvó a qwen',
    `${cierre(146000) / 1000}s > ${ARENA_LLM_TIMEOUT_MS / 1000}s`);
  ok(cierre(146000) === 109000, 'y el número exacto', String(cierre(146000)));

  // LA COTA, barrida: mientras el piso no muerda, total + margen == deadline.
  const desbordes = [];
  for (let u = 0; u <= (B + RESERVA_CIERRE_MS) - PISO_VUELTA_MS; u += 977) {
    if (u + cierre(u) + MARGEN_MS !== ARENA_AGENT_DEADLINE_MS) desbordes.push(u);
  }
  ok(desbordes.length === 0,
    'y para todo reparto donde el piso no manda, usado + cierre + margen == deadline EXACTO',
    desbordes.slice(0, 3).join(', '));

  // El único caso en que el piso empuja por encima: el loop desbordado. Se
  // declara en vez de pretender que la cota es absoluta.
  const extremo = (B + RESERVA_CIERRE_MS) - 1000;
  ok(extremo + cierre(extremo) + MARGEN_MS > ARENA_AGENT_DEADLINE_MS,
    'con el loop desbordado el piso de 10s empuja hasta 15s por encima: lo absorbe el MARGEN, y es lo que permite ESCRIBIR que se pasó',
    `${(extremo + cierre(extremo) + MARGEN_MS) / 1000}s vs ${ARENA_AGENT_DEADLINE_MS / 1000}s`);

  // Y que el código no vuelva a meterle el techo.
  const src = readFileSync(new URL('../api/_lib/arena-tool-loop.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const relojDeCierre'));
  ok(/return Math\.max\(PISO_VUELTA_MS, disponible\);/.test(fn.slice(0, 2500)),
    'el cierre devuelve `disponible` sin pasarlo por el techo');
  ok(!/timeoutMs \? Math\.min\(timeoutMs, disponible\)/.test(src),
    'y la versión con techo ya no está: fue la que mató a qwen');

  // La vuelta de investigación SÍ lo lleva: ahí el techo protege a las
  // siguientes, que es su razón de existir.
  const vuelta = (rest) => Math.max(PISO_VUELTA_MS, Math.min(ARENA_LLM_TIMEOUT_MS, rest - RESERVA_CIERRE_MS));
  ok(vuelta(B) === ARENA_LLM_TIMEOUT_MS,
    'la vuelta de investigación sigue acotada: ahí sí hay llamadas siguientes que proteger',
    String(vuelta(B)));
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
