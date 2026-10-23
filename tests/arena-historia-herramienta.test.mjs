// ═══════════════════════════════════════════════════════════════
// tests/arena-historia-herramienta.test.mjs — historia(ticker) y el inventario.
//
// Lo que se blinda:
//   1. LA NARRACIÓN EXISTENTE, acotada a 2 párrafos, con hash y fecha. El
//      recorte se marca. Cero llamadas a modelos: solo un SELECT.
//   2. "sin_cobertura" EXPLÍCITO: no ingerido y sin narración son dos
//      sin_cobertura distintos; la base caída es OTRA cosa (error, no cero).
//   3. APAGADA POR DEFECTO, como `eventos`.
//   4. EL INVENTARIO: cubiertas / faltan / costo, con el origen de cada número.
//
// Sin base: el SQL se inyecta.
// Correr con `node tests/arena-historia-herramienta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { runHistoria, resumenDeSecciones, acotarParrafo, CONSULTA_HISTORIA } from '../api/_lib/arena-tools-historia.js';
import { inventario, costoPorNarracion, ESCENARIOS } from '../api/_lib/historia-inventario.js';
import { createToolExecutor, herramientasActivas, toolsForProvider } from '../api/_lib/arena-tools.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const LARGO = 'Primera oración con una cita [0000950170-26-000123]. ' + 'Relleno que sigue y sigue. '.repeat(60);
const SECCIONES = [
  { id: 'direccion', texto: 'El CEO lleva diez años [0001-26-1].' },
  { id: 'catalizador', texto: 'Firmó un acuerdo de suministro de HBM [0001-26-2].' },
  { id: 'prometido_vs_entregado', texto: LARGO },
  { id: 'propiedad', texto: 'Sin 13D.' },
];
const FILA = { cik: '0000723125', ticker: 'MU', nombre: 'MICRON TECHNOLOGY INC', estado_ingesta: 'ok',
  hash: 'abcdef0123456789abcdef', secciones: SECCIONES, creado_en: '2026-10-11T03:00:00Z', modelo: 'x', prompt_version: 1 };
const sqlDe = (filas, espia = []) => async (q, p) => { espia.push({ q, p }); return filas; };

console.log('\n── 1) la narración existente, acotada, con hash y fecha ──');
{
  const espia = [];
  const r = await runHistoria({ ticker: 'mu' }, { deps: { historiaSql: sqlDe([FILA], espia) } });
  const lineas = r.text.split('\n');
  ok(r.rows === 2 && !r.error, 'dos párrafos', r.text);
  ok(/narración del 2026-10-11, hash abcdef012345\b/.test(lineas[0]), 'la cabecera trae fecha y hash', lineas[0]);
  ok(/no de hoy/.test(lineas[0]), 'y dice que es la lectura de esa fecha, no de hoy');
  ok(/^Lo prometido vs\. lo entregado: Primera oración/.test(lineas[1]) && /^Catalizador: Firmó/.test(lineas[2]),
    'el orden: lo prometido vs. lo entregado, y después el catalizador', lineas.slice(1).join(' | '));
  ok(!/El CEO lleva/.test(r.text), 'solo dos: dirección y propiedad quedan fuera');
  ok(/\[…recortado\]$/.test(lineas[1]) && lineas[1].length < 800, 'un párrafo largo se recorta en una oración y se MARCA', String(lineas[1].length));
  ok(r.text.length < 2000, 'el resultado entero es chico (~2 párrafos)', String(r.text.length));
  ok(espia.length === 1 && espia[0].p[0] === 'MU' && /^select/i.test(espia[0].q.trim()), 'una sola consulta, de lectura, con el ticker normalizado');
  ok(/estado = 'ok'/.test(CONSULTA_HISTORIA) && /order by creado_en desc limit 1/.test(CONSULTA_HISTORIA),
    'la consulta toma la última narración SERVIBLE (estado ok)');
  const src = readFileSync(new URL('../api/_lib/arena-tools-historia.js', import.meta.url), 'utf8');
  ok(!/fetch\(|narrar\(|callArenaLLM|anthropic/i.test(src.replace(/\/\/.*$/gm, '')), 'el código no llama a ningún modelo ni a la red');

  ok(acotarParrafo('corto.') === 'corto.', 'un párrafo corto no se toca');
  ok(resumenDeSecciones([{ id: 'propiedad', texto: 'a' }]).length === 1, 'si hay una sola sección, va una');
}

console.log('\n── 2) sin_cobertura explícito, y la falla no es un cero ──');
{
  const no = await runHistoria({ ticker: 'ZZZ' }, { deps: { historiaSql: sqlDe([]) } });
  ok(no.rows === 0 && /^historia: sin_cobertura/.test(no.text) && no.sin_cobertura === 'no_ingerido' && !no.error,
    'no ingerido → "sin_cobertura", explícito', no.text);
  const sinN = await runHistoria({ ticker: 'MU' }, { deps: { historiaSql: sqlDe([{ ...FILA, hash: null, secciones: null }]) } });
  ok(sinN.sin_cobertura === 'sin_narracion' && /^historia: sin_cobertura/.test(sinN.text) && /ingerido/.test(sinN.text),
    'ingerido pero sin narración → también sin_cobertura, con el motivo', sinN.text);
  const sinHash = await runHistoria({ ticker: 'MU' }, { deps: { historiaSql: sqlDe([{ ...FILA, hash: null }]) } });
  ok(sinHash.sin_cobertura === 'sin_narracion', 'secciones SIN hash no se sirven: una narración que no se puede identificar no se puede citar');
  const vacia = await runHistoria({ ticker: 'MU' }, { deps: { historiaSql: sqlDe([{ ...FILA, secciones: [] }]) } });
  ok(vacia.sin_cobertura === 'sin_narracion', 'una narración sin secciones con texto no se sirve como si hubiera');
  const caida = await runHistoria({ ticker: 'MU' }, { deps: { historiaSql: async () => { throw new Error('relation "company_narracion" does not exist'); } } });
  ok(caida.error === true && caida.rows === null && /sin datos hoy/.test(caida.text) && !/sin_cobertura/.test(caida.text),
    'la base caída es un ERROR con filas null, no un sin_cobertura', caida.text);
  ok((await runHistoria({}, { deps: { historiaSql: sqlDe([]) } })).error === true, 'sin ticker es error');
}

console.log('\n── 3) apagada por defecto ──');
{
  ok(!herramientasActivas({}).includes('historia'), 'por defecto nadie la ve');
  ok(herramientasActivas({ ARENA_TOOLS_EXTRA: 'eventos, historia' }).join(',') === 'screener,noticias,ficha,sector,eventos,historia',
    'ARENA_TOOLS_EXTRA=eventos,historia enciende las dos');
  ok(toolsForProvider('anthropic', null, { ARENA_TOOLS_EXTRA: 'historia' }).some((t) => t.name === 'historia'), 'y viaja su schema');
  const ex = createToolExecutor({ cache: false, herramientas: herramientasActivas({ ARENA_TOOLS_EXTRA: 'historia' }), deps: { historiaSql: sqlDe([FILA]) } });
  const r = await ex.call('historia', { ticker: 'mu' });
  ok(r.rows === 2 && ex.summary()[0].tokens > 0, 'encendida: corre por el ejecutor y journalea sus tokens');
  const apagada = createToolExecutor({ cache: false, herramientas: herramientasActivas({}), deps: { historiaSql: sqlDe([FILA]) } });
  ok((await apagada.call('historia', { ticker: 'MU' })).unknown_tool === true, 'apagada: no existe para el agente');
}

console.log('\n── 4) el inventario ──');
{
  const inv = inventario({
    universo: ['MU', 'AAPL', 'brk.b', 'WDC', 'STX', 'MU'],
    emisores: [
      { cik: '723125', ticker: 'MU', estado: 'ok' },
      { cik: '320193', ticker: 'AAPL', estado: 'ok' },
      { cik: '1067983', ticker: 'BRK-B', estado: 'pendiente' },
      { cik: '106040', ticker: 'WDC', estado: 'error' },
      { cik: '1', ticker: 'NOESTA', estado: 'ok' },
    ],
    narradas: [{ cik: '723125', usd_total: '0.20' }, { cik: '320193', usd_total: 0.1 }],
  });
  ok(inv.universo === 5, 'el universo se deduplica y normaliza', String(inv.universo));
  ok(inv.cubiertas === 2, 'MU y AAPL cubiertas');
  ok(JSON.stringify(inv.ingeridas_sin_narracion) === '["BRK.B"]', 'BRK.B se encuentra como BRK-B y está sin narración', JSON.stringify(inv.ingeridas_sin_narracion));
  ok(JSON.stringify(inv.con_error_de_ingesta) === '["WDC"]', 'WDC con error de ingesta');
  ok(JSON.stringify(inv.faltan) === '["STX"]', 'STX falta', JSON.stringify(inv.faltan));
  ok(inv.por_narrar === 3, 'tres por narrar');
  ok(inv.costo.por_empresa_medido_usd === 0.15 && inv.costo.medido_sobre === 2, 'el costo MEDIDO es el promedio de las narraciones guardadas', String(inv.costo.por_empresa_medido_usd));
  ok(inv.costo.backfill_usd.medido === 0.45, 'backfill medido = 3 × 0.15');
  const tip = costoPorNarracion(ESCENARIOS.tipico);
  ok(tip > 0.1 && tip < 0.2 && inv.costo.por_empresa_supuesto_usd.tipico === tip, 'típico: ~$0.14 por empresa con Opus 5 a $5/$25', String(tip));
  ok(inv.costo.por_empresa_supuesto_usd.peor > tip, 'el peor caso es mayor');
  ok(/medida/.test(inv.costo.supuestos.tipico) && /techo/.test(inv.costo.supuestos.peor), 'cada supuesto dice de dónde sale');
  ok(costoPorNarracion(ESCENARIOS.tipico, 'modelo-sin-precio') === null, 'sin precio en la tabla, costo null — nunca uno inventado');
  const sinMedir = inventario({ universo: ['A'], emisores: [], narradas: [] });
  ok(sinMedir.costo.por_empresa_medido_usd === null && sinMedir.costo.backfill_usd.medido === null, 'sin narraciones, el medido es null y no cero');

  const script = readFileSync(new URL('../scripts/historia-inventario.mjs', import.meta.url), 'utf8');
  const consultas = script.match(/await sql\(\s*`[^`]*`/g) || [];
  ok(consultas.length === 3 && consultas.every((q) => /^await sql\(\s*`\s*select/i.test(q)),
    'el script de inventario son tres SELECT y nada más', String(consultas.length));
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
