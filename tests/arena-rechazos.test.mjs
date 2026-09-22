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

import { bloqueDeRechazos, rechazosPrevios, MAX_NOMBRES, CORRIDAS_ATRAS, DIAS_ATRAS } from '../api/_lib/arena-rechazos.js';

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
  ok(/rejected ENTIRELY/.test(b) && /positions you meant to exit/.test(b),
    'dice LA CONSECUENCIA: el objetivo entero se rechazó y el libro sigue con lo que quería cerrar. Sin eso, el modelo puede leerlo como una nota de color');
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

console.log('\n── el caso de claude: ZM y XENE, y el fin de semana ──');
{
  // Reportado el 2026-09-19: claude pasó el viernes rechazado pidiendo ZM y
  // XENE una y otra vez, el mismo patrón de deepseek con OKTA.
  const f = [corrida({ pedido: 'ZM', motivo: 'no está en el universo de hoy' }, { pedido: 'XENE', motivo: 'no está en el universo de hoy' }),
    corrida({ pedido: 'ZM', motivo: 'no está en el universo de hoy' })];
  const b = bloqueDeRechazos(f);
  ok(/ZM/.test(b) && /XENE/.test(b), 'el aviso cubre los DOS tickers de una misma corrida, no solo el primero', b);
  ok(/asked for it 2 times/.test(b), 'y cuenta ZM dos veces, que es lo que lo vuelve un patrón');

  // LA VENTANA. Del viernes al lunes hay TRES días: con la de 2 días, el
  // aprendizaje se borraba justo cuando más falta hacía.
  ok(DIAS_ATRAS >= 4, `la ventana cruza el fin de semana (${DIAS_ATRAS} días): viernes → lunes son tres`, String(DIAS_ATRAS));
}

console.log('\n── un ticker que VOLVIÓ al universo no se menciona ──');
{
  // Ampliar la ventana solo es seguro por esto: el universo se reconstruye
  // cada día y los movers cambian. Decir "no pidas ZM" cuando ZM SÍ está hoy
  // sería enseñarle algo falso al PM.
  const f = [corrida({ pedido: 'ZM', motivo: 'x' }, { pedido: 'XENE', motivo: 'x' })];
  const conZm = bloqueDeRechazos(f, { universo: ['NVDA', 'ZM'] });
  ok(!/ZM/.test(conZm.split('\n').filter((l) => l.startsWith('- ')).join()) && /XENE/.test(conZm),
    'ZM volvió al universo → se calla; XENE sigue afuera → se nombra', conZm.split('\n').filter((l) => l.startsWith('- ')).join(' '));
  ok(bloqueDeRechazos(f, { universo: ['ZM', 'XENE'] }) === '',
    'si los dos volvieron no hay nada que enseñar y el bloque desaparece entero');
  ok(/ZM/.test(bloqueDeRechazos(f)) , 'sin universo no filtra: degrada al comportamiento anterior en vez de callarse');

  // La forma normalizada también cuenta: el modelo escribió una y el universo
  // conoce la otra.
  const norm = [corrida({ pedido: 'SUPER MICRO', normalizado: 'SMCI', motivo: 'x' })];
  ok(bloqueDeRechazos(norm, { universo: ['SMCI'] }) === '',
    'y si lo que volvió es la forma NORMALIZADA, tampoco se menciona');
}

console.log('\n── una EJECUCIÓN PARCIAL también alimenta la memoria ──');
{
  // Desde el reglamento v4.2 un objetivo con UNA pata mala no se rechaza: se
  // descarta esa pata y el resto se ejecuta. La corrida no se cae, así que el
  // agente no se entera — pero la decisión sobre ESE nombre sí se perdió.
  const parcial = (...d) => ({ status: 'ejecutado_parcial', tickers: { desconocidos: d } });
  const b = bloqueDeRechazos([parcial({ pedido: 'XENE', motivo: 'x' }), parcial({ pedido: 'XENE', motivo: 'x' })]);
  ok(/XENE/.test(b), 'un nombre descartado en una ejecución parcial entra a la memoria igual');
  ok(!/rejected ENTIRELY/.test(b),
    'pero NO se le dice que el libro quedó congelado: sí se ejecutó, y decirle la consecuencia equivocada le haría dejar de creerle al aviso');
  // La frase decía "you never will while the name stays out of the universe",
  // que enseñaba la misma regla falsa que el prompt: el universo NO decide lo
  // que se puede tener. Se cambió el 2026-09-22 por el hecho, que es el mismo
  // y no arrastra la regla: la pata se descartó y su peso quedó en cash.
  ok(/WAS executed/.test(b) && /stayed in cash/.test(b),
    'se le dice lo que de verdad pasó: el resto se ejecutó y ese peso quedó en cash', b.split('\n').slice(-2)[0]);
  ok(!/you never will while the name stays out of the universe/.test(b),
    'y ya no se le enseña que el universo expira posiciones — era la regla que hacía liquidar un nombre bueno');

  // Mezcla: una rechazada entera y una parcial. Son consecuencias distintas y
  // las dos tienen que aparecer.
  const mix = bloqueDeRechazos([
    { status: 'rejected_tickers', tickers: { desconocidos: [{ pedido: 'ZM', motivo: 'x' }] } },
    parcial({ pedido: 'XENE', motivo: 'x' }),
  ]);
  ok(/rejected ENTIRELY/.test(mix) && /WAS executed/.test(mix),
    'con las dos clases de corrida se dicen las dos consecuencias, no una sola promediada', mix.split('\n').slice(-2)[0]);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
