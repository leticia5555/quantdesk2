// ═══════════════════════════════════════════════════════════════
// tests/arena-rescate.test.mjs — descartar la pata mala, no el objetivo entero.
//
// EL CASO (2026-09-18): deepseek no operó en todo el día. Tres objetivos
// rechazados ENTEROS por un solo ticker inexistente, y el libro congelado desde
// el día anterior con las posiciones que había decidido cerrar todavía abiertas.
//
// EL ARGUMENTO QUE SE CAYÓ: "una cartera a la que se le saca una pata ya no es
// la que el PM decidió" — cierto, pero asume que RECHAZAR es neutral. No lo es:
// rechazar deja el libro de AYER, que es justo la cartera que el PM acaba de
// revocar. Las dos opciones ejecutan algo que nadie eligió hoy.
// Correr con `node tests/arena-rescate.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { rescatarObjetivo, RESCATE, normalizarTickersObjetivo } from '../api/_lib/arena-rails.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const tick = (desconocidos, weights, colisiones = []) => ({ desconocidos, colisiones, weights });

console.log('\n── el caso de deepseek: una pata chica se descarta ──');
{
  const r = rescatarObjetivo(tick([{ pedido: 'OKTA', peso: 0.08, motivo: 'no está en el universo de hoy' }],
    { ADBE: 0.15, CRM: 0.15, DVA: 0.10, LULU: 0.10, NKE: 0.10, TMUS: 0.10 }));
  ok(r.rescatable === true, 'una pata del 8% sobre un libro del 78% se rescata', JSON.stringify(r.motivo));
  ok(r.descartados[0].symbol === 'OKTA' && r.descartados[0].peso === 0.08, 'y se dice qué se descartó y cuánto pesaba');
  ok(Object.keys(r.pesos).length === 6 && r.pesos.OKTA === undefined, 'el libro que queda son las otras seis, sin OKTA');
}

console.log('\n── NO SE REESCALA: ésa es la mitad de la regla ──');
{
  const original = { NVDA: 0.30, AMD: 0.20 };
  const r = rescatarObjetivo(tick([{ pedido: 'OKTA', peso: 0.10 }], { ...original }));
  ok(r.pesos.NVDA === 0.30 && r.pesos.AMD === 0.20,
    'los pesos que quedan son EXACTAMENTE los que el modelo escribió: subirlos para que sumen lo mismo sería inventar números',
    JSON.stringify(r.pesos));
  ok(Math.abs(r.peso_descartado - 0.10) < 1e-9, 'el 10% huérfano queda en cash, que no es una apuesta', String(r.peso_descartado));
}

console.log('\n── TOPE POR PESO: un tercio del bruto ──');
{
  // 0.5 desconocido sobre 1.0 bruto = 50% > 1/3.
  const gordo = rescatarObjetivo(tick([{ pedido: 'OKTA', peso: 0.5 }], { NVDA: 0.3, AMD: 0.2 }));
  ok(gordo.rescatable === false && gordo.motivo === 'demasiado_peso',
    'lo desconocido al 50% del bruto NO se rescata: lo que queda ya no se parece al libro pedido', JSON.stringify(gordo.motivo));
  ok(/50\.0%/.test(gordo.detalle), 'y el motivo trae el número, no un "demasiado"', gordo.detalle);

  // Justo POR DEBAJO del tope pasa; justo por encima no. El borde importa.
  const justo = rescatarObjetivo(tick([{ pedido: 'X', peso: 0.30 }], { A: 0.70 }));
  ok(justo.rescatable === true, '30% del bruto (bajo el tercio) sí pasa', String(justo.fraccion));
  const pasado = rescatarObjetivo(tick([{ pedido: 'X', peso: 0.40 }], { A: 0.60 }));
  ok(pasado.rescatable === false, 'y 40% no', String(pasado.fraccion));
}

console.log('\n── TOPE POR CANTIDAD: más de dos nombres es otra cosa ──');
{
  const tres = rescatarObjetivo(tick(
    [{ pedido: 'A', peso: 0.01 }, { pedido: 'B', peso: 0.01 }, { pedido: 'C', peso: 0.01 }],
    { NVDA: 0.9 }));
  ok(tres.rescatable === false && tres.motivo === 'demasiados_nombres',
    'tres nombres desconocidos NO se rescatan aunque pesen 3% — no es un tipeo, es el modelo corrompiendo símbolos');
  ok(/tapar/.test(tres.detalle) || /taparía/.test(tres.detalle),
    'y el motivo dice por qué importa: rescatarlo escondería la falla detrás de una ejecución que se ve normal', tres.detalle);

  const dos = rescatarObjetivo(tick([{ pedido: 'A', peso: 0.01 }, { pedido: 'B', peso: 0.01 }], { NVDA: 0.9 }));
  ok(dos.rescatable === true, 'dos sí, que es el tope', String(RESCATE.max_nombres));
}

console.log('\n── LOS DOS TOPES HACEN FALTA: uno solo deja pasar el otro caso ──');
{
  // Poco peso, muchos nombres → solo el tope por CANTIDAD lo atrapa.
  const muchos = rescatarObjetivo(tick(
    Array.from({ length: 5 }, (_, i) => ({ pedido: 'F' + i, peso: 0.005 })), { NVDA: 0.9 }));
  ok(muchos.rescatable === false && muchos.fraccion < RESCATE.max_fraccion_bruto,
    'cinco nombres que pesan 2.7% pasan el tope de PESO y los frena el de CANTIDAD', String(muchos.fraccion));

  // Un nombre, mucho peso → solo el tope por PESO lo atrapa.
  const gordo = rescatarObjetivo(tick([{ pedido: 'X', peso: 0.6 }], { A: 0.4 }));
  ok(gordo.rescatable === false && gordo.nombres <= RESCATE.max_nombres,
    'y un solo nombre del 60% pasa el tope de CANTIDAD y lo frena el de PESO', String(gordo.nombres));
}

console.log('\n── una COLISIÓN no se rescata nunca ──');
{
  const c = rescatarObjetivo(tick([], { NVDA: 0.5 }, [{ simbolo: 'NVDA', pesos: [0.3, 0.2] }]));
  ok(c.rescatable === false && c.motivo === 'colision',
    'dos claves que normalizan al mismo símbolo no dejan un hueco que se pueda poner en cash');
  ok(/ambigüedad/.test(c.detalle),
    'dejan una AMBIGÜEDAD sobre qué peso quiso el modelo: elegir uno sería adivinar y sumarlos inventar', c.detalle);
}

console.log('\n── un objetivo que queda vacío no es un libro parcial ──');
{
  const vacio = rescatarObjetivo(tick([{ pedido: 'OKTA', peso: 0.10 }], {}));
  ok(vacio.rescatable === false,
    'si descartar deja el objetivo VACÍO no se ejecuta: "vendé todo" no es lo que el PM escribió');
  ok(vacio.motivo === 'demasiado_peso',
    'lo atrapa el tope de peso (sin libro, la fracción es 1) — por eso NO hay un tercer tope para este caso: sería código inalcanzable',
    vacio.motivo);
}

console.log('\n── nada que rescatar ──');
{
  const nada = rescatarObjetivo(tick([], { NVDA: 0.5 }));
  ok(nada.rescatable === false && nada.motivo === 'nada_que_rescatar',
    'sin desconocidos no hay rescate que hacer — el camino normal no pasa por acá');
}

console.log('\n── el peso VIAJA con el desconocido (sin eso nada de esto se puede medir) ──');
{
  const t = normalizarTickersObjetivo({ NVDA: 0.3, OKTA: 0.08, 'SUPER MICRO': 0.05 }, { universo: ['NVDA'] });
  ok(t.ok === false, 'el objetivo no pasa como está');
  const okta = t.desconocidos.find((d) => d.pedido === 'OKTA');
  ok(okta && okta.peso === 0.08, 'el desconocido lleva su peso, que es lo que permite medir cuánto del libro se descartaría', JSON.stringify(okta));
  // 0.08 + 0.05 = 0.13 desconocido sobre 0.43 de bruto = 30.2%, por DEBAJO del
  // tercio, y dos nombres es justo el tope: se rescata. (La primera versión de
  // este test afirmaba que NO, y la aritmética le dio la razón al código.)
  const r = rescatarObjetivo(t);
  ok(r.rescatable === true && r.nombres === 2,
    'de punta a punta: dos desconocidos que suman 30.2% del bruto se rescatan', JSON.stringify({ n: r.nombres, f: r.fraccion }));
  ok(Math.abs(r.fraccion - 0.3023) < 0.001,
    'y la fracción se mide sobre el bruto REAL (vivo + descartado), no sobre el que sobrevivió', String(r.fraccion));
  ok(Object.keys(r.pesos).join(',') === 'NVDA' && r.pesos.NVDA === 0.3,
    'queda solo NVDA, con su peso intacto', JSON.stringify(r.pesos));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
