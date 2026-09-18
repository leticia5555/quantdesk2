// ═══════════════════════════════════════════════════════════════
// tests/arena-rechazos.test.mjs — que un rechazo ENSEÑE algo.
//
// EL CASO (2026-09-18): deepseek no operó en todo el día. Cuatro corridas, un
// malformed y TRES rejected_tickers seguidas, las tres por el MISMO ticker. Su
// libro quedó congelado desde el día anterior, y no por decisión suya.
//
// La raíz no es que el modelo sea terco: cada corrida arrancaba sin memoria de
// la anterior. Sin saber que ya lo pidió y se lo rechazaron, insistir es la
// única conducta posible. Correr con `node tests/arena-rechazos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { bloqueDeRechazos, rechazosPrevios, MAX_NOMBRES, CORRIDAS_ATRAS } from '../api/_lib/arena-rechazos.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const corrida = (...desconocidos) => ({ status: 'rejected_tickers', tickers: { desconocidos } });

console.log('\n── sin nada que enseñar, el prompt no cambia ──');
{
  ok(bloqueDeRechazos([]) === '', 'sin corridas previas el bloque es vacío');
  ok(bloqueDeRechazos([{ status: 'ok', tickers: null }]) === '', 'una corrida buena tampoco genera bloque');
  ok(bloqueDeRechazos([corrida()]) === '', 'una fila sin desconocidos tampoco');
  ok(bloqueDeRechazos(null) === '', 'ni null');
  // Un prompt no lleva secciones vacías que el modelo tenga que aprender a
  // ignorar: si no hay nada, no se dice nada.
}

console.log('\n── el caso de deepseek ──');
{
  const b = bloqueDeRechazos([corrida({ pedido: 'OKTA', motivo: 'no está en el universo de hoy' }),
    corrida({ pedido: 'OKTA', motivo: 'no está en el universo de hoy' }),
    corrida({ pedido: 'OKTA', motivo: 'no está en el universo de hoy' })]);
  ok(/OKTA/.test(b), 'nombra el ticker');
  ok(/3 times/.test(b), 'y dice cuántas veces lo pidió: una vez es un error, tres es un patrón', b.split('\n')[1]);
  ok(/rejected ENTIRELY/.test(b) && /book is unchanged/.test(b),
    'dice LA CONSECUENCIA: el objetivo entero se rechazó y el libro no cambió. Sin eso, el modelo puede leerlo como una nota de color');
  ok(/positions you meant to exit/.test(b),
    'incluido que las posiciones que quería cerrar SIGUEN ahí — que es lo que de verdad le pasó');
  ok(/Do not ask for it again/.test(b), 'y qué hacer en su lugar');
}

console.log('\n── un ticker corrompido dice las DOS formas ──');
{
  const b = bloqueDeRechazos([corrida({ pedido: 'SUPER MICRO', normalizado: 'SUPERMICRO', motivo: 'se normalizó y ese tampoco está' })]);
  ok(/SUPER MICRO/.test(b), 'el que el MODELO escribió, que es el que tiene que dejar de escribir');
  ok(/SUPERMICRO/.test(b), 'y al que se normalizó: son dos errores distintos y confundirlos no enseña nada', b);
}

console.log('\n── un objetivo corrupto no se lleva medio prompt ──');
{
  const muchos = corrida(...Array.from({ length: 20 }, (_, i) => ({ pedido: 'FAKE' + i, motivo: 'no existe' })));
  const b = bloqueDeRechazos([muchos]);
  const lineas = b.split('\n').filter((l) => l.startsWith('- '));
  ok(lineas.length === MAX_NOMBRES,
    `si el modelo emitió 20 símbolos inventados, viajan ${MAX_NOMBRES}: eso no se arregla listándoselos, se arregla mirando el llm_response`,
    String(lineas.length));
}

console.log('\n── se ordena por insistencia, no por orden de llegada ──');
{
  const b = bloqueDeRechazos([
    corrida({ pedido: 'UNAVEZ', motivo: 'x' }, { pedido: 'TRESVECES', motivo: 'x' }),
    corrida({ pedido: 'TRESVECES', motivo: 'x' }),
    corrida({ pedido: 'TRESVECES', motivo: 'x' }),
  ]);
  const primera = b.split('\n').find((l) => l.startsWith('- '));
  ok(/TRESVECES/.test(primera), 'el más repetido va primero: es el que está bloqueando al agente', primera);
}

console.log('\n── leer el journal nunca puede tumbar la corrida ──');
{
  const caido = await rechazosPrevios('deepseek', { deps: { sql: async () => { throw new Error('Neon no contesta'); } } });
  ok(Array.isArray(caido) && caido.length === 0,
    'si la DB falla se devuelve vacío: el peor caso es el comportamiento de hoy, no una corrida menos');

  let capturado = null;
  const filas = await rechazosPrevios('deepseek', { deps: { sql: async (q, args) => { capturado = { q, args }; return [
    { status: 'rejected_tickers', created_at: '2026-09-18T15:00:00Z', tickers: '{"desconocidos":[{"pedido":"OKTA","motivo":"no está"}]}' },
  ]; } } });
  ok(filas.length === 1 && filas[0].tickers.desconocidos[0].pedido === 'OKTA',
    'un `context` que vuelve como STRING se parsea: Neon devuelve jsonb de las dos formas según el driver',
    JSON.stringify(filas[0].tickers));
  ok(/arena_journal/.test(capturado.q) && !/arena_shadow/.test(capturado.q), 'en vivo lee el journal de la liga');
  ok(capturado.args[0] === 'deepseek' && capturado.args[1] === CORRIDAS_ATRAS, 'con el agente y el tope de corridas');

  await rechazosPrevios('deepseek', { vivo: false, deps: { sql: async (q) => { capturado = { q }; return []; } } });
  ok(/arena_shadow_journal/.test(capturado.q),
    'y la sombra lee el SUYO: una bandera en la misma tabla está a una consulta mal escrita de contaminar el post-mortem');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
