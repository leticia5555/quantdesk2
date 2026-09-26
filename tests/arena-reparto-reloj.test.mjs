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

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
