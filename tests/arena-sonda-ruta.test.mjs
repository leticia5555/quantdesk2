// ═══════════════════════════════════════════════════════════════
// tests/arena-sonda-ruta.test.mjs — ¿ES EL MODELO O ES EL TRANSPORTE?
//
// EL DATO (2026-09-25, siete días): los dos agentes de Anthropic DIRECTO llevan
// 0 abortos en 67 corridas; los cinco de OpenRouter concentran los 77. Eso NO
// concluye — esos cinco son además modelos distintos, corren sin caché de
// prompt y comparten el reparto de reloj de esa ruta. Tres cosas cambiadas a
// la vez.
//
// La sonda fija el MODELO y mueve la ruta, que es la lógica de la cuenta de
// control aplicada al transporte. Tres brazos, porque con dos el resultado
// sería ambiguo:
//
//   A · ruta_directo      Fable por Anthropic, CON caché
//   B · ruta_directo_nc   Fable por Anthropic, SIN caché  → aísla la caché
//   C · ruta_or           Fable por OpenRouter            → aísla la ruta
//
// Lo que este archivo fija:
//   1. LOS TRES BRAZOS SON EL MISMO MODELO. Si uno deriva, la sonda mide otra
//      cosa y nadie se entera.
//   2. SOLO CAMBIA UNA VARIABLE ENTRE BRAZOS CONSECUTIVOS.
//   3. NO TOCAN LA LIGA NI NINGUNA CUENTA.
//   4. EL BRAZO DE OPENROUTER NO CORRE CON UN SLUG ADIVINADO.
//
// Correr con `node tests/arena-sonda-ruta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { ARENA_AGENTS, agentById, activeAgents, competidores, PROBE_IDS, esProbe } from '../api/_lib/arena-registry.js';
import { enfoqueDelDia } from '../api/_lib/arena-herding.js';
import { ARENA_ANTHROPIC_MODEL } from '../api/_lib/model.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const A = agentById('ruta_directo');
const B = agentById('ruta_directo_nc');
const C = agentById('ruta_or');
const CLAUDE = agentById('claude');

// ── 1) EL MISMO MODELO EN LOS TRES ───────────────────────────────────
console.log('\n── los tres brazos son el mismo modelo ──');
{
  ok(A && B && C, 'existen los tres brazos');
  ok(A.model_label === CLAUDE.model_label && B.model_label === CLAUDE.model_label && C.model_label === CLAUDE.model_label,
    'los tres declaran el MISMO modelo que el `claude` de la liga', JSON.stringify([A.model_label, C.model_label]));
  ok(A.model === ARENA_ANTHROPIC_MODEL && B.model === ARENA_ANTHROPIC_MODEL,
    'los dos brazos directos usan el slug de Anthropic del repo, no una copia', JSON.stringify([A.model, B.model]));
  ok(A.persona === CLAUDE.persona && B.persona === CLAUDE.persona && C.persona === CLAUDE.persona,
    'y la MISMA persona: el system prompt sale byte a byte igual', C.persona);
}

// ── 2) UNA VARIABLE POR SALTO ────────────────────────────────────────
// Es lo que hace interpretable el resultado. Si A→B cambiara dos cosas, un
// aborto en B no diría cuál.
console.log('\n── entre brazos consecutivos cambia UNA sola cosa ──');
{
  ok(A.provider === 'anthropic' && B.provider === 'anthropic',
    'A y B comparten ruta…');
  ok(A.caps.cache === 'anthropic' && B.caps.cache === null,
    '…y difieren SOLO en la caché de prompt: eso es lo que A→B aísla',
    JSON.stringify([A.caps.cache, B.caps.cache]));
  ok(A.caps.sampling === B.caps.sampling && A.caps.effort === B.caps.effort,
    'lo demás de A y B es idéntico');

  ok(B.caps.cache === null && C.caps.cache === null,
    'B y C comparten la ausencia de caché…');
  ok(B.provider !== C.provider,
    '…y difieren SOLO en la ruta: eso es lo que B→C aísla', JSON.stringify([B.provider, C.provider]));

  // Fable RECHAZA `temperature` con 400. Mandarla solo por el brazo de
  // OpenRouter haría que los brazos difirieran en algo más que la ruta — y
  // encima produciría un aborto que sería NUESTRO, no de la ruta.
  ok(C.caps.sampling === false && CLAUDE.caps.sampling === false,
    'el brazo de OpenRouter tampoco manda temperature: Fable la rechaza, y un 400 nuestro se leería como un fallo de la ruta');
}

// ── 3) EL ENFOQUE DEL DÍA TIENE QUE SER EL MISMO ─────────────────────
// Si cada brazo mirara un enfoque distinto, la sonda mediría el enfoque.
console.log('\n── los tres miran lo mismo ──');
{
  const dia = new Date('2026-09-25T18:00:00Z');
  const e = enfoqueDelDia('claude', dia);
  ok(enfoqueDelDia('ruta_directo', dia).id === e.id
    && enfoqueDelDia('ruta_directo_nc', dia).id === e.id
    && enfoqueDelDia('ruta_or', dia).id === e.id,
    'los tres heredan el enfoque de claude, igual que la cuenta de control', e.id);

  // Y que siga siendo cierto cualquier día, no solo el que elegí.
  const otros = ['2026-09-26', '2026-10-01', '2026-10-09'].every((d) => {
    const n = new Date(d + 'T18:00:00Z');
    return enfoqueDelDia('ruta_or', n).id === enfoqueDelDia('claude', n).id;
  });
  ok(otros, 'y en cualquier día de la temporada: el enfoque rota, la herencia no');
}

// ── 4) FUERA DE LA LIGA Y SIN TOCAR NINGUNA CUENTA ───────────────────
console.log('\n── no compiten y no operan ──');
{
  const activos = activeAgents().map((a) => a.id);
  ok(!activos.includes('ruta_directo') && !activos.includes('ruta_or'),
    'ninguna sonda entra en `activeAgents()`: la liga corre sin ellas', activos.join(','));
  ok(activos.length === 7, 'y la liga sigue siendo de siete', String(activos.length));

  ok(PROBE_IDS.length === 3 && esProbe('ruta_or') && !esProbe('claude'),
    'las sondas están marcadas como tales', PROBE_IDS.join(','));
  ok(ARENA_AGENTS.filter((a) => a.probe).every((a) => a.enabled === false),
    'y ninguna está habilitada: que no compitan no depende de que nadie las llame');

  // La garantía de que no operan NO es la bandera: es que el camino de sombra
  // usa un broker cuyas escrituras LANZAN.
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  ok(/const broker = vivo \? alpaca : \(deps\.shadowBroker \|\| shadowBroker\)\(alpaca\)/.test(shadow),
    'la sonda corre por el camino de sombra, donde el broker lanza en cualquier escritura');

  // Y no aparecen en las pantallas públicas.
  const libros = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok((libros.match(/agent_id <> all\(\$2::text\[\]\)/g) || []).length === 2,
    'las DOS consultas de /liga/libros (viva y sombra) las excluyen: una sola dejaría la mitad a la vista');
  ok(/PROBE_IDS/.test(libros), 'y usan la lista del registry, no una copia de los ids');
}

// ── 5) EL SLUG DE OPENROUTER NO SE ADIVINA ───────────────────────────
// Un slug inventado produce un aborto que es NUESTRO, y la sonda lo reportaría
// como si fuera de la ruta — o sea, exactamente la conclusión falsa que existe
// para evitar.
console.log('\n── el candado del slug ──');
{
  ok(C.slug_verified === false,
    'el brazo de OpenRouter se declara NO verificado: el candado lo frena hasta que ARENA_MODEL_RUTA_OR tenga el slug real');
  ok(A.slug_verified === true && B.slug_verified === true,
    'los dos directos sí están verificados: su slug sale de _lib/model.js');

  const reg = readFileSync(new URL('../api/_lib/arena-registry.js', import.meta.url), 'utf8');
  ok(/ARENA_MODEL_RUTA_OR/.test(reg), 'y el registry dice qué env var hay que poner');
  ok(/arena-smoke\?catalog=1/.test(reg), 'y quién resuelve el slug real');
}

// ── 6) EL PADRÓN NO SE PREGUNTA AL ARRAY CRUDO ───────────────────────
// B41 en el registro. Hasta que entraron estas sondas, `ARENA_AGENTS` y "la
// liga" eran lo mismo, así que medio repo preguntaba por el array crudo. La
// primera entrada que NO era un competidor rompió cinco pruebas — y, más caro,
// apagó `announceSeasonOpen`: 7 < 10, la apertura de la T3 no salía nunca. El
// id es idempotente y la T2 ya está sellada, así que nadie se habría enterado
// hasta noviembre.
//
// Esto es la MITAD que hace trabajo de la norma: la función compartida sin una
// prueba que falle al divergir se vuelve a bifurcar en el próximo copy-paste.
console.log('\n── el padrón es una función, no un array ──');
{
  ok(competidores().length === 7 && !competidores().some((a) => a.probe),
    'competidores() son los siete inscritos, sin sondas', String(competidores().length));

  // Y es la pregunta que NO contesta activeAgents(). Un agente recortado por
  // ARENA_LEAGUE deja de correr hoy y sigue inscrito; una sonda nunca lo
  // estuvo. Fusionar las dos habría sido la misma bifurcación con otra ropa.
  const antes = process.env.ARENA_LEAGUE;
  process.env.ARENA_LEAGUE = 'claude,control';
  ok(activeAgents().length === 2 && competidores().length === 7,
    'con la parrilla recortada a dos, el padrón sigue siendo siete: son dos preguntas distintas',
    JSON.stringify([activeAgents().length, competidores().length]));
  if (antes === undefined) delete process.env.ARENA_LEAGUE; else process.env.ARENA_LEAGUE = antes;

  // El sitio que costaba caro, verificado en el fuente: la guarda de apertura
  // compara contra el padrón, no contra el array.
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const guarda = run.slice(run.indexOf('export async function announceSeasonOpen'));
  ok(/const padron = competidores\(\);/.test(guarda.slice(0, 900))
    && !/agents\.length < ARENA_AGENTS\.length/.test(guarda.slice(0, 900)),
    'announceSeasonOpen cuenta contra competidores(), no contra ARENA_AGENTS');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
