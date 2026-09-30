// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-registry.js — la LIGA multi-modelo del Arena.
//
// El Arena nació como UN agente ("Claude PM · Agente #6", Haiku por API
// directa). Esta liga lo generaliza a N modelos corriendo el MISMO harness
// (SCAN → DEEP DIVE → guard → orden límite) sobre CADA UNO su propio libro
// Alpaca paper, para poder comparar el MODELO — no el prompt, ni el
// presupuesto. UN solo lugar define quién compite, con qué modelo, contra
// qué cuenta y con qué identidad de prompt.
//
// ── DISEÑO (las 7 decisiones, doc: docs/arena-liga-scope.md) ──────────
//
// 1. MODELOS. Claude Haiku (API directa de Anthropic) + OpenAI/Grok/Gemini/
//    DeepSeek/Qwen (OpenRouter) + Haiku-B como CONTROL. Siete agentes. El
//    Claude que compite es HAIKU a propósito (preserva el historial del
//    Agente #6; Haiku vs Sonnet vs Opus es otro experimento). Criterio de
//    tier: modelos COMPARABLES en capacidad/costo (la clase "rápida/eficiente"
//    de cada casa), NO el más caro — si los tiers son dispares medimos
//    presupuesto, no modelo. Los slugs son env-overridables (ARENA_MODEL_<ID>):
//    un slug retirado se corrige con una env var, no con un deploy (misma
//    filosofía que _lib/model.js).
//
// 2. TEMPERATURA. Fija, idéntica para todos, no-cero (0.7). Los proveedores
//    interpretan `temperature` distinto — es un límite conocido del
//    experimento, no algo que resolvamos (ver ARENA_TEMPERATURE + el scope).
//
// 3. CUENTAS. Multi-login: 7 agentes = 3 logins × 3 cuentas paper. Cada agente
//    tiene su par de keys, nombrado por su `alpaca` (ALPACA_<ALPACA>_KEY/SECRET).
//    `claude` REUSA ALPACA_PAPER_* (la cuenta del Agente #6) para no perder su
//    historial. Mapa login→agente documentado en el scope.
//
// 4. CADENCIA. La Fase A encendió `claude` + `openai` + `control` (ese trío
//    ejercitó TODAS las rutas: Anthropic directo, OpenRouter, multi-cuenta,
//    identidad de prompt y el control) con el radio de explosión mínimo. Con esa
//    base verde y las 7 cuentas de Alpaca + OPENROUTER_API_KEY cargadas, la
//    TEMPORADA 2 enciende la liga COMPLETA: Grok/Gemini/DeepSeek/Qwen pasan a
//    `enabled:true` y los siete corren el mismo harness desde el mismo día.
//    `ARENA_LEAGUE=<ids>` sigue disponible para recortar la parrilla en Vercel
//    (p. ej. apagar a uno que rompa) sin tocar código ni redeployar.
//
// 5. CONTROL. `control` es Haiku-B: MISMO modelo, MISMO prompt (persona
//    IDÉNTICA a `claude`), MISMA temperatura, DISTINTA cuenta. Es el piso de
//    ruido — sin él, ningún delta entre modelos significa nada. Por eso su
//    `persona` es byte-idéntica a la de `claude`: cualquier diferencia de
//    prompt lo invalidaría como control.
//
// 6. IDENTIDAD DE PROMPT. `persona` viaja al system prompt del DIVE ("You are
//    {persona}…"). claude/control comparten persona (control válido); los demás
//    difieren solo por el nombre (confound conocido, documentado como el de la
//    temperatura). El resto del harness es idéntico entre todos.
//
// 7. ARQUETIPO (`archetype`, 2026-09-14) — LA VOZ, NO EL CRITERIO. Cada modelo
//    tiene un arquetipo fijo con el que narra su titular de una línea (el
//    control es "el escéptico que no cree en nadie"). CANDADO: el arquetipo
//    NUNCA entra al prompt que DECIDE. Vive en una llamada aparte, posterior,
//    que solo NARRA lo ya decidido — si entrara al DIVE, claude y control
//    dejarían de compartir prompt byte-idéntico y el control se caería como
//    piso de ruido, que es el único motivo por el que existe (decisión #5).
//    Hay un test que lo blinda. Ver `_lib/arena-voice.js`.
//
// ENV VARS: OPENROUTER_API_KEY (los 5 de OpenRouter) · ANTHROPIC_API_KEY
//           (claude + control) · ALPACA_<ALPACA>_KEY/SECRET por agente ·
//           ARENA_TEMPERATURE (opc, default 0.7) · ARENA_MODEL_<ID> (opc,
//           override de slug) · ARENA_LEAGUE (opc, lista de ids a correr).
// ═══════════════════════════════════════════════════════════════

import { ARENA_ANTHROPIC_MODEL, ARENA_OPENROUTER_CLAUDE_MODEL, ANTHROPIC_PRICES } from './model.js';

export { ANTHROPIC_PRICES };

// LÍMITE NUEVO (2026-09-15): la temperatura ya NO es idéntica para todos,
// porque dejó de ser universal. Claude Fable 5.1 RECHAZA `temperature` con 400
// (junto con top_p/top_k): en esa familia el sampling no es configurable. Así
// que `claude` y `control` corren SIN temperatura y los cinco de OpenRouter con
// 0.7. La decisión #2 de la liga ("misma temperatura para todos") queda
// PARCIALMENTE ROTA y se declara — no se finge igualada. Lo que sí se preserva
// es lo que hacía válido al control: `claude` y `control` corren con parámetros
// byte-idénticos entre ellos, que es donde se mide el ruido.
//
// Temperatura FIJA e idéntica para todos (decisión #2). No-cero: 0 colapsaría
// a los modelos a su moda y borraría justo la variabilidad que queremos medir.
// Override por env (validada a [0,2]); inválida → 0.7.
export const ARENA_TEMPERATURE = (() => {
  const n = Number(process.env.ARENA_TEMPERATURE);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 0.7;
})();

// ── EFFORT y TECHO DE SALIDA (relanzamiento 2026-09-15) ──────────────
// `effort` medio para todos: es la perilla que sustituye a la temperatura como
// control de "cuánto piensa" en los modelos de razonamiento. Medio y no alto
// porque el encargo del PM es un JSON de decisión, no una demostración — y
// porque alto multiplica el costo de una liga de 7 que corre todos los días.
export const ARENA_EFFORT = (() => {
  const v = String(process.env.ARENA_EFFORT || 'medium').toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? v : 'medium';
})();

// Techo de salida ÚNICO para ambas fases. Antes eran 500 (scan) y 3000 (dive):
// 500 tokens es un techo escrito para un modelo que responde sin razonar, y en
// un modelo de razonamiento los tokens de pensamiento se cuentan contra el
// MISMO techo — la respuesta se corta antes de emitir el JSON y la corrida
// muere en `aborted_scan_malformed_json`. Es la causa raíz candidata #1 de los
// abortos de grok (ver docs/arena-modelos-2026-09-15.md).
export const ARENA_MAX_TOKENS = (() => {
  const n = Number(process.env.ARENA_MAX_TOKENS);
  return Number.isFinite(n) && n >= 500 && n <= 64000 ? Math.floor(n) : 6000;
})();

// ── MÍNIMO CACHEABLE DE PROMPT ───────────────────────────────────────
// Piso del PROVEEDOR, no una preferencia nuestra: por debajo de este número de
// tokens, Anthropic IGNORA `cache_control` en silencio — no escribe caché, no
// cobra de más y no avisa. Eso es exactamente lo que pasaba con el system del
// SCAN (~760 tokens contra un piso de 1.024): el smoke reportaba `cache_read: 0`
// y `cache_write: 0` sin ninguna pista de por qué.
//
// Vive en el registry y no en arena-run.js porque _lib/arena-model.js lo
// necesita para el chequeo del piso, y arena-run ya importa de arena-model:
// definirlo allá crearía el ciclo model → run → model.
//
// Env-overridable porque el piso lo fija el proveedor y puede cambiar sin
// avisarnos; la corrección tiene que poder ser una env var, no un deploy.
export const ANTHROPIC_CACHE_MIN_TOKENS = (() => {
  const n = Number(process.env.ARENA_CACHE_MIN_TOKENS);
  return Number.isFinite(n) && n >= 128 ? Math.floor(n) : 1024;
})();

// ── PRESUPUESTO DE TIEMPO ────────────────────────────────────────────
// Techo de UNA llamada al proveedor. Existe porque el reloj que manda no es el
// de la API sino el de Vercel: si el fetch tarda más que el `maxDuration` de la
// función, no hay error de LLM que journalear — la función entera muere con
// FUNCTION_INVOCATION_TIMEOUT y se pierde el resultado de TODOS los agentes,
// incluidos los que ya habían contestado.
//
// Por eso este número tiene que ser MENOR que el maxDuration del endpoint que
// llama, con margen para el resto (buffet, Alpaca, escritura al journal).
// Con maxDuration=300 y agentes en paralelo, 90s deja aire de sobra.
//
// Antes esto estaba hardcodeado y ASIMÉTRICO: 45s para OpenRouter y 180s para
// Anthropic. Los 180s eran directamente imposibles de honrar — triplicaban el
// cap real de 60s que vercel.json imponía, así que el fetch nunca llegaba a
// abortar por su cuenta: lo mataba la función antes, sin dejar rastro.
export const ARENA_LLM_TIMEOUT_MS = (() => {
  const n = Number(process.env.ARENA_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 && n <= 280000 ? Math.floor(n) : 90000;
})();

// ── DE DÓNDE SALIÓ EL TECHO ──────────────────────────────────────────
// Un timeout journaleado como "se pasó de 15s" no dice CUÁL reloj puso ese 15.
// Y las respuestas son opuestas: si lo puso una env var, se arregla en Vercel
// en diez segundos; si lo puso el reparto del loop, el modelo llegó al cierre
// sin reloj y lo que hay que mover es el presupuesto, no la variable.
//
// Sin esta línea, las dos se ven idénticas en el journal — y la primera vez que
// pasó costó una ronda viva averiguarlo a mano.
export const ARENA_LLM_TIMEOUT_ORIGEN = (() => {
  const crudo = process.env.ARENA_LLM_TIMEOUT_MS;
  const n = Number(crudo);
  if (crudo == null || crudo === '') return 'default del código (90s)';
  if (Number.isFinite(n) && n >= 5000 && n <= 280000) return `env ARENA_LLM_TIMEOUT_MS=${crudo}`;
  return `env ARENA_LLM_TIMEOUT_MS=${crudo} IGNORADA (fuera del rango 5s-280s) → default del código (90s)`;
})();

// ── Y SI ESE TECHO ES DEMASIADO CHICO PARA PENSAR ────────────────────
// El piso no es una opinión de estilo: una llamada del DIVE con razonamiento
// alto y un prompt de decenas de miles de tokens no cabe en 15 segundos, y el
// resultado no es "una corrida más lenta" sino una corrida ABORTADA — o sea,
// un agente que no opera ese día.
//
// No se corrige sola a la fuerza: la env var es de Lety y sobrescribirla desde
// el código convertiría "puse 15s" en "puse 15s y el código decidió otra cosa",
// que es peor que el bug. Se DECLARA, y el smoke y el journal la muestran.
export const ARENA_LLM_TIMEOUT_PISO_SANO_MS = 30000;
export function techoLlmSospechoso(ms = ARENA_LLM_TIMEOUT_MS) {
  if (ms >= ARENA_LLM_TIMEOUT_PISO_SANO_MS) return null;
  return `El techo de UNA llamada al proveedor es ${Math.round(ms / 1000)}s (${ARENA_LLM_TIMEOUT_ORIGEN}). Una llamada del dive, con razonamiento y el tablero entero en el prompt, no cabe ahí: el agente no sale lento, sale ABORTADO. Por debajo de ${ARENA_LLM_TIMEOUT_PISO_SANO_MS / 1000}s esto casi siempre es una env var de prueba que quedó puesta.`;
}

// Techo del TRABAJO COMPLETO de un agente. Es otro número que
// ARENA_LLM_TIMEOUT_MS porque cubre otra cosa: aquel limita UNA conexión, éste
// limita la cadena.
//
// ── LA CUENTA CAMBIÓ CON LAS HERRAMIENTAS (B3/B12) ───────────────────
// ANTES, una corrida eran DOS llamadas:
//   scan (≤90s) + dive (≤90s) + Alpaca/journal ≈ 200s  <  240s  <  300s
//
// AHORA el DIVE es un LOOP: el modelo pide herramientas, el harness ejecuta, el
// modelo vuelve a pedir. Con hasta 10 vueltas a 90s de techo, el peor caso no
// es 200s — es más de 900. Con el deadline en 240s, la corrida moría a mitad
// del loop PERDIENDO todo lo que el modelo ya había investigado, y el journal
// decía "timeout" sin decir en qué vuelta se quedó.
//
// La cuenta nueva, y por qué cierra:
//   scan            ≤ 90s   (una llamada, sin herramientas)
//   loop del dive   ≤ 120s  (ARENA_TOOL_LOOP_MS — el loop se AUTO-CORTA)
//   cierre          ≤ 45s   (la última llamada, sin herramientas)
//   ──────────────────────
//   total           ≈ 255s  <  270s de deadline  <  300s de función
//
// Los 270s son deliberados y el orden importa: el loop se corta SOLO antes de
// llegar (ver LOOP_BUDGET_MS en _lib/arena-tool-loop.js), así que este deadline
// es la red de la red. Los 30s que quedan contra los 300s de la función existen
// para que, cuando un agente igual se pase, la función siga viva lo suficiente
// para ESCRIBIR que se pasó. Un timeout que no se journalea es indistinguible
// de una corrida que nunca ocurrió — y 30s es el margen que el lint exige, no
// un número que se pueda achicar para hacer caber un presupuesto más grande.
//
// SI SE TOCA ESTE NÚMERO hay que tocar `vercel.json` también: el `maxDuration`
// del glob es el que manda de verdad, y el lint de tests/arena-timeouts lo
// verifica. Subir uno sin el otro no cambia nada.
export const ARENA_AGENT_DEADLINE_MS = (() => {
  const n = Number(process.env.ARENA_AGENT_DEADLINE_MS);
  return Number.isFinite(n) && n >= 10000 && n <= 290000 ? Math.floor(n) : 270000;
})();

// Slug de OpenRouter con override por env (ARENA_MODEL_<ID>). Un slug que el
// proveedor retire se corrige en Vercel sin redeploy — igual que ANTHROPIC_MODEL.
const slug = (id, fallback) => process.env['ARENA_MODEL_' + id] || fallback;

// El agente insignia: su historial (Agente #6) se preserva y las vistas
// single-agent (app.html · /api/arena) lo muestran a él.
// ── LA VERSIÓN DEL PROMPT, FUERA DEL CICLO (2026-09-30) ─────────────
// Vivía en `api/arena-run.js`, que está en un ciclo de imports con
// `api/arena-shadow.js`: arena-shadow importa `gatherContext`,
// `buildSharedContext`, `buildTargetSystemPrompt`, `resolveBaseUrl` y esto;
// arena-run importa `runAgenteObjetivo` de vuelta.
//
// Los otros cuatro son `function` declarations: hoistean, y en un ciclo eso es
// benigno — el binding existe antes de que se evalúe el cuerpo del módulo.
// **Esto era `export const`, que NO hoistea**, y era la única arista del ciclo
// con riesgo real.
//
// Hoy no tronaba porque se lee DENTRO de `runAgenteObjetivo`, y cuando esa
// función corre los dos módulos ya terminaron de evaluarse. O sea: seguro por
// USO, no por estructura. Y el modo de falla no es un crash: bajo un
// transpilado a CJS, un `const` leído en un ciclo antes de su inicialización
// da `undefined` en vez de lanzar. Eso habría escrito
// `prompt_version: undefined` en el journal del camino que DECIDE — un hueco
// de datos silencioso, en la tabla del post-mortem.
//
// Es una constante de texto: no tiene por qué vivir en un archivo de 3.600
// líneas que está en un ciclo. Acá es hoja (este módulo no importa ninguno de
// los dos) y el ciclo queda con puras declarations.
//
// v3 = las tres rondas fijas + la matutina por evento. v2 era el flujo de DOS
// fases (SCAN → DEEP DIVE); v1, un solo LLM call sobre el buffet. El bump
// permite cortar el post-mortem por temporada: las métricas de T1, T2 y T3 NO
// son comparables porque cambió el reglamento.
export const PROMPT_VERSION = 'arena-pm-v3-t2';

export const FLAGSHIP_AGENT_ID = 'claude';

// ── LAS COMPUERTAS, EN UN SOLO LUGAR (2026-09-29) ────────────────────
// `ARENA_ENABLED !== '1'` estaba escrito a mano en `arena-run` y en
// `arena-watch`. Dos copias del mismo predicado, que es B41 otra vez — pero lo
// que lo hizo urgente fue otra cosa: **no había forma de PREGUNTAR si la liga
// estaba apagada sin arriesgarse a prenderla.**
//
// El único modo de comprobar la pausa era pegarle a `/api/arena-run` o a
// `/api/arena-watch`: si la compuerta funcionaba contestaban `disabled`, y si
// NO funcionaba corrían una ronda. O sea que el chequeo costaba exactamente el
// accidente que estaba tratando de descartar. Para una pausa que se aprieta de
// noche y se verifica antes de dormir, eso no sirve.
//
// Ahora el predicado vive acá, los dos lo importan, y `/api/arena-audit`
// —que es SOLO LECTURA— lo reporta. La respuesta no puede divergir de la
// compuerta porque es la misma función, no una copia que describe lo que la
// compuerta "debería" hacer.
export function ligaApagada(env = process.env) {
  return env.ARENA_ENABLED !== '1';
}
export function vigilanteApagado(env = process.env) {
  return ligaApagada(env) || env.ARENA_WATCH_ENABLED === '0';
}

// El estado completo, para reportarlo. Devuelve las razones ya redactadas: un
// `false` sin motivo obliga a ir a leer el código para saber qué mover.
export function estadoDeCompuertas(env = process.env) {
  const liga = !ligaApagada(env);
  const vig = !vigilanteApagado(env);
  return {
    liga_habilitada: liga,
    vigilante_habilitado: vig,
    // El valor CRUDO de la env var, no solo el booleano: la diferencia entre
    // "está en 0" y "no existe" importa cuando uno acaba de desplegar y quiere
    // saber si la variable llegó.
    ARENA_ENABLED: env.ARENA_ENABLED === undefined ? null : String(env.ARENA_ENABLED),
    ARENA_WATCH_ENABLED: env.ARENA_WATCH_ENABLED === undefined ? null : String(env.ARENA_WATCH_ENABLED),
    ARENA_LEAGUE: env.ARENA_LEAGUE ? String(env.ARENA_LEAGUE) : null,
    lectura: liga
      ? 'LA LIGA CORRE: arena-run decide y arena-watch dispara.'
      : 'LA LIGA ESTÁ APAGADA: ni arena-run ni arena-watch hacen nada. arena-reset, arena-shadow y arena-smoke SÍ funcionan — no consultan esta compuerta, a propósito.',
  };
}

// ── LA LIGA ───────────────────────────────────────────────────────────
// `enabled` = la parrilla de la TEMPORADA 2: los SIETE.
//
// OJO CON LOS TIERS — la parrilla NO es pareja y conviene saberlo al leer la
// tabla. El scope original (docs/arena-liga-scope.md) elegía la clase
// RÁPIDA/EFICIENTE de cada casa para medir el modelo y no el presupuesto; el
// relanzamiento del 2026-09-15 se fue al tope de gama (GPT-6 Astra a $10/$50
// por MTok, Grok 4.6, DeepSeek V4 Pro, Qwen Max) y `gemini` se quedó en FLASH
// porque Google no publica su Pro de esa generación en OpenRouter. O sea: seis
// flagship y un flash. Cualquier lectura de la tabla que compare a `gemini`
// contra los demás carga ese confound — no es el modelo, es el peso.
// ── MODELOS DE LA TEMPORADA (relanzamiento 2026-09-15) ────────────────
// Slug efectivo por agente. `ARENA_MODEL_<ID>` SIEMPRE gana: es el tornillo con
// el que Lety corrige un slug sin redeploy, y el mecanismo por el que los slugs
// que /api/arena-smoke resuelva contra el catálogo entran en vigor.
//
// `slug_verified` dice si el default de ABAJO está confirmado contra el
// catálogo del proveedor:
//   - anthropic: SÍ. El slug de Fable 5.1 (ARENA_ANTHROPIC_MODEL, definido en
//     _lib/model.js) está en el catálogo vigente.
//   - openrouter · gemini: SÍ. `google/gemini-3.8-flash` salió del catálogo
//     vivo en la corrida de /api/arena-smoke?catalog=1 del 2026-09-15.
//   - openrouter · los otros cuatro: NO. Siguen la convención `vendor/modelo`
//     de OpenRouter pero NO se verificaron contra
//     https://openrouter.ai/api/v1/models (egress bloqueado desde el entorno
//     donde se escribieron). Son CANDIDATOS, no hechos. El smoke del
//     2026-09-15 ya devolvió `exact` para openai/grok/deepseek: falta bajar
//     ese resultado acá, y qwen todavía espera decisión (`qwen/qwen3.8-max`
//     no existe; el catálogo ofrece `qwen/qwen3.8-max-0902`).
//
// El candado: un agente con `slug_verified:false` y SIN `ARENA_MODEL_<ID>`
// puesta NO corre — `runArenaDecide` journalea `aborted_unverified_model` y no
// gasta un token. `/api/arena-smoke` es quien resuelve el slug real contra el
// catálogo y te dice exactamente qué env var poner. Preferimos una liga que no
// arranca a una liga que le pega a un slug inventado.
// Desactivable con ARENA_ALLOW_UNVERIFIED_SLUGS=1 (para un smoke a mano).

// El modelo de Anthropic del Arena y la tabla de precios viven en _lib/model.js
// (regla de la casa: un ID de modelo, un solo archivo — ver el lint de
// tests/claude-model.test.mjs y el porqué en el encabezado de ese archivo).

// Capacidades por familia — lo que la API ACEPTA, no lo que nos gustaría.
//   sampling: ¿acepta `temperature`? Fable 5.1 la RECHAZA con 400 (junto con
//             top_p/top_k). Ver el candado de temperatura más abajo.
//   effort:   ¿acepta `output_config.effort` (anthropic) o `reasoning.effort`
//             (openrouter)?
//   cache:    ¿soporta caché de prompt explícita (`cache_control`)?
const CAPS_FABLE = { sampling: false, effort: 'anthropic', cache: 'anthropic' };
const CAPS_OR = { sampling: true, effort: 'openrouter', cache: null };
const CAPS_OR_OPENAI = { sampling: true, effort: 'openrouter', cache: 'auto' };

export const ARENA_AGENTS = [
  {
    id: 'claude', name: 'Claude', model_label: 'Claude Fable 5.1',
    provider: 'anthropic', model: slug('CLAUDE', ARENA_ANTHROPIC_MODEL), persona: 'Claude PM',
    slug_verified: true, caps: CAPS_FABLE,
    archetype: { name: 'el analista prudente', voice: 'Mides dos veces y cortas una. Hablas de riesgo antes que de premio, sin dramatizar.' },
    alpaca: 'PAPER',            // reusa la cuenta del Agente #6 → preserva historial
    house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'openai', name: 'ChatGPT', model_label: 'GPT-6 Astra',
    provider: 'openrouter', model: slug('OPENAI', 'openai/gpt-6-astra'), persona: 'GPT PM',
    slug_verified: false, caps: CAPS_OR_OPENAI,
    archetype: { name: 'el optimista de producto', voice: 'Ves la tesis grande y la cuentas con entusiasmo, pero sin prometer números.' },
    alpaca: 'OPENAI', house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'control', name: 'Control · Fable-B', model_label: 'Claude Fable 5.1',
    provider: 'anthropic', model: slug('CONTROL', ARENA_ANTHROPIC_MODEL),
    persona: 'Claude PM',       // IDÉNTICA a `claude` a propósito: es el piso de ruido
    slug_verified: true, caps: CAPS_FABLE,
    archetype: { name: 'el escéptico que no cree en nadie', voice: 'No te crees ninguna tesis, ni la tuya. Señalas lo que puede salir mal y desconfías del consenso.' },
    alpaca: 'CONTROL', house: 'control', control: true, phase: 'A', enabled: true,
  },
  {
    id: 'grok', name: 'Grok', model_label: 'Grok 4.6',
    provider: 'openrouter', model: slug('GROK', 'x-ai/grok-4.6'), persona: 'Grok PM',
    slug_verified: false, caps: CAPS_OR,
    archetype: { name: 'el provocador', voice: 'Dices en voz alta lo que los demás callan. Irreverente y directo, nunca grosero.' },
    alpaca: 'GROK', house: 'us', control: false, phase: 'B', enabled: true,
  },
  {
    id: 'gemini', name: 'Gemini', model_label: 'Gemini 3.8 Flash',
    // FLASH, no Pro, y es una decisión de Lety (2026-09-15), no un descuido:
    // `google/gemini-3.8-pro` NO EXISTE en el catálogo de OpenRouter. El tope
    // de gama de Google que sí está es 3.1 y en preview, así que la elección
    // real era "una generación atrás en preview" o "la generación correcta un
    // tier abajo". Ganó la generación. Costo: Gemini corre en otro peso que los
    // otros cinco (ver la nota de tiers arriba) — se sabe y se acepta.
    provider: 'openrouter', model: slug('GEMINI', 'google/gemini-3.8-flash'), persona: 'Gemini PM',
    slug_verified: true, caps: CAPS_OR,
    archetype: { name: 'el ordenado', voice: 'Todo cabe en un marco limpio. Clasificas y ordenas; tu titular suena a conclusión bien archivada.' },
    alpaca: 'GEMINI', house: 'us', control: false, phase: 'B', enabled: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek', model_label: 'DeepSeek V4 Pro',
    provider: 'openrouter', model: slug('DEEPSEEK', 'deepseek/deepseek-v4-pro'), persona: 'DeepSeek PM',
    slug_verified: false, caps: CAPS_OR,
    archetype: { name: 'el frío de los números', voice: 'Solo datos. Cero épica, cero adjetivos: el titular es una medición.' },
    alpaca: 'DEEPSEEK', house: 'china', control: false, phase: 'B', enabled: true,
  },
  {
    // 2026-09-17: se cambió de `qwen3.8-max` a `qwen3.8-2.4t-a95b`. El `max`
    // tenía UN SOLO proveedor (Alibaba, `endpoint_count: 1`), así que no había
    // ruta alternativa y el turno de cierre se pasaba de 110s corrida tras
    // corrida — el timeout era del endpoint único, no del modelo. Éste tiene 7
    // proveedores, mismo precio y misma generación: la clase del agente NO
    // cambia, que es lo que hace que el resultado siga siendo comparable.
    id: 'qwen', name: 'Qwen', model_label: 'Qwen3.8 2.4T A95B',
    provider: 'openrouter', model: slug('QWEN', 'qwen/qwen3.8-2.4t-a95b'), persona: 'Qwen PM',
    slug_verified: false, caps: CAPS_OR,
    archetype: { name: 'el paciente', voice: 'Juegas el largo plazo. El ruido de hoy te interesa poco; hablas en trimestres.' },
    alpaca: 'QWEN', house: 'china', control: false, phase: 'B', enabled: true,
  },

  // ── SONDA DE RUTA: PREGUNTA CONTESTADA, SONDA RETIRADA (2026-09-26) ──
  // Acá vivieron tres brazos (Fable por Anthropic con caché, sin caché, y por
  // OpenRouter) para separar "es el modelo" de "es la ruta". Nunca corrieron:
  // los datos contestaron la pregunta antes, y por ~$6 de diferencia.
  //
  // 84 abortos en diez días, repartidos así: `error` 52, `cuerpo_vacio` 23,
  // `time_budget` 3. **El reloj eran 3 de 84**, y la mediana de vueltas en las
  // abortadas era 1 — morían ANTES de la primera herramienta, no agotadas.
  // Y 28 de los 52 caían en siete racimos multi-agente que se parten
  // exactamente por proveedor y nunca se mezclan: el 24-sep los CINCO de
  // OpenRouter a la misma hora, el 25-sep claude y control (los dos de
  // Anthropic) a la misma hora. Cinco modelos de cinco empresas no fallan
  // solos en el mismo minuto: falla la cuenta.
  //
  // O sea: la ruta SÍ causa abortos, en las DOS rutas, en días distintos y a
  // nivel CUENTA. La sonda habría medido con cinco corridas por brazo algo que
  // siete racimos ya mostraban — y peor, un brazo que cayera en un racimo
  // habría parecido un fallo de esa ruta.
  //
  // Lo que SE QUEDA de este trabajo, porque no dependía de la sonda:
  //   · `competidores()` (abajo) y el `probe: true` que lo motivó. Destapó que
  //     `announceSeasonOpen` comparaba contra `ARENA_AGENTS` y la apertura de
  //     la T3 no se habría anunciado nunca. Ver B41.
  //   · `ARENA_OPENROUTER_CLAUDE_MODEL` en `_lib/model.js`, que el lint cazó
  //     acá y tenía razón.
  // Si algún día hace falta reponerlos: git log de este archivo, 2026-09-25.

  // ── PENDIENTE T3 · EL OCTAVO AGENTE, EUROPEO ─────────────────────────
  // Mistral, `house: 'eu'`. Decidido el 2026-09-17 que entra en la T3 y NO en
  // la T2, y la razón no es técnica: un agente que arranca a mitad de temporada
  // no corre la misma ventana que los siete, así que su return no es comparable
  // con el de ellos. Un ranking que los pone en la misma tabla sin decirlo
  // miente.
  //
  // OJO con `house: 'eu'`: hoy la casa es `us`/`china` y de ahí salen la
  // etiqueta del tablero, la descripción pública ("IAs chinas vs americanas") y
  // la narrativa entera. Una tercera casa cambia el TITULAR del experimento —
  // es una decisión de producto antes que una entrada en este array.
  //
  // El resto de lo que hace falta (keys de Alpaca, sombra previa, el efecto en
  // el presupuesto diario, y por qué el slug se lee del catálogo en vez de
  // escribirse de memoria) está en docs/arena.md → "Pendiente T3".
];

// ¿Puede este agente gastar tokens? Un slug no verificado sin override es un
// disparo a ciegas contra la API de un proveedor: se frena acá.
export function modelSlugResolved(agent) {
  if (!agent) return false;
  if (agent.slug_verified) return true;
  if (process.env.ARENA_ALLOW_UNVERIFIED_SLUGS === '1') return true;
  return !!process.env['ARENA_MODEL_' + agent.id.toUpperCase()];
}

// Los agentes que corren esta liga. `ARENA_LEAGUE` (lista de ids separada por
// comas) gana sobre las banderas `enabled`: con los siete ya en `true`, su uso
// hoy es RECORTAR la parrilla en Vercel sin redeploy (sacar a uno que rompa, o
// volver al trío de la Fase A). OJO: si quedó puesta de la Fase A, MANDA ELLA y
// la liga sigue corriendo 3. Sin override: las banderas `enabled` (los 7).
export function activeAgents() {
  const override = String(process.env.ARENA_LEAGUE || '').trim();
  if (override) {
    const want = new Set(override.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    return ARENA_AGENTS.filter((a) => want.has(a.id));
  }
  return ARENA_AGENTS.filter((a) => a.enabled);
}

// ═══ TEMPORADA (season) ════════════════════════════════════════════
// La liga corre por TEMPORADAS acotadas, no para siempre. Una ventana cerrada
// con fecha de inicio y de fin es lo que convierte el experimento en algo que
// se puede GANAR y contar: sin un final, el "líder" de hoy es una foto sin
// consecuencia y el post-mortem nunca tiene una población cerrada que analizar.
//
// CUATRO SEMANAS DE MERCADO (20 sesiones), de lunes a viernes: `end` cae en
// VIERNES a propósito. Un cierre en sábado o domingo no tendría corrida —el
// cron solo dispara L-V y el gate de mercado cerrado frena la liga— y el
// ganador no se declararía nunca.
//
// Las fechas se comparan en horario del ESTE (el del mercado), no en UTC: la
// corrida de decide es 22:40 UTC, que en ET sigue siendo el mismo día hábil.
// ── T3 (2026-09-29). POR QUÉ SE TIRÓ EL MARCADOR DE LA T2 ────────────
// De 84 abortos de la T2, ~48 fueron las cuentas sin saldo, ~13 nuestro bug
// del reparto de reloj (B45), 4 cortes de proveedor y 3 `time_budget`. **Como
// mucho 10 eran de los modelos.** La T2 no midió modelos: midió un sistema sin
// dinero que además se robaba el tiempo a sí mismo. El detalle está en B44.
//
// La T2 NO se borra. Queda entera en `arena_journal`, en
// `arena_shadow_journal`, en `arena_equity_intraday` y en
// `arena_benchmark` (con `season = 'T2'`, su SPY del 16-sep a $759.42
// intacto). Sale de la ventana del leaderboard por FECHA, que es lo que la
// sella: `start` es el corte de todas las consultas de /liga.
export const ARENA_SEASON = {
  id: 'T3',
  name: 'Temporada 3',
  // ── EL 29 NO CUENTA, Y SE DICE POR QUÉ ────────────────────────────
  // El start era 2026-09-29. Ese día la liga CORRIÓ EN VIVO etiquetada T3
  // contra los libros heredados de la T2: `ARENA_ENABLED=0` no llegó al
  // deployment, el reset nunca se apretó, no hubo humo, y el SPY siguió
  // anclado al 16 de septiembre. Hubo órdenes reales desde las 13:33 UTC.
  //
  // Correr el start al 30 no tapa nada: el 29 queda registrado como día
  // contaminado, con su motivo, en `TEMPORADA_DIAS_CONTAMINADOS` y en B47. Un
  // hueco declarado es dato; uno callado es el bug de la próxima semana.
  start: /* date-lint-ok: fecha declarada de apertura de la temporada, un hecho fijo, no una referencia a "hoy" */ '2026-10-01',
  end: /* date-lint-ok: cierre declarado de la temporada (VIERNES: un cierre en fin de semana no tendría corrida y el ganador no se declararía nunca) */ '2026-10-30',
  // 22 sesiones L-V, contadas: 4.4 semanas. Se escribe el número real y no el
  // redondo — este campo sale publicado en el anuncio de apertura, y una
  // temporada que dice "4 semanas" y corre 22 sesiones miente en la primera
  // línea que alguien lee.
  weeks: 4.4,
  // Qué se mide para declarar al ganador. Equity, igual que el leaderboard:
  // `claude` arrastra días de ventaja de la T1, así que el return vs. baseline
  // viaja al lado — el caveat de ranking del scope sigue vigente y se publica.
  metric: 'equity',
};

// Fecha de HOY en horario del Este ('YYYY-MM-DD'). Duplica tres líneas de
// arena-run.js a propósito: importarlo desde acá crearía un ciclo
// registry → arena-run → registry.
function easternToday(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// 'pending' (aún no arranca) · 'running' · 'ended' (ya pasó el cierre).
// ── DÍAS CONTAMINADOS: FUERA DE LA SERIE, DENTRO DEL REGISTRO ───────
// Un día en que la liga corrió pero sus datos NO miden lo que la temporada
// dice medir. No se borra la fila —es la evidencia— pero no entra en el
// ranking ni en el piso de ruido.
//
// El motivo va acá, al lado de la fecha, y no en un doc aparte: quien lea
// `/liga` y vea un hueco tiene que poder saber por qué sin buscar.
export const TEMPORADA_DIAS_CONTAMINADOS = [
  {
    fecha: /* date-lint-ok: día contaminado, un hecho fijo */ '2026-09-29',
    temporada: 'T3',
    clase: 'corrio_contaminado',
    motivo: 'La liga corrió EN VIVO etiquetada T3 contra los libros heredados de la T2. `ARENA_ENABLED=0` no llegó al deployment, el reset nunca se ejecutó, no hubo corrida de humo y el benchmark siguió anclado al 16-sep. Hubo órdenes reales a Alpaca desde las 13:33 UTC. Los retornos de ese día miden HERENCIA de la T2, no decisiones de la T3.',
  },
  {
    fecha: /* date-lint-ok: día sin corrida, un hecho fijo */ '2026-09-30',
    temporada: 'T3',
    // ── DOS HUECOS, DOS MOTIVOS ─────────────────────────────────────
    // Éste NO es el mismo caso que el 29 y por eso lleva `clase` propia. El 29
    // corrió y sus datos mienten; el 30 no corrió. Un post-mortem que los
    // mezcle va a buscar en el 30 unas órdenes que nunca existieron, o va a
    // leer el hueco del 30 como una falla del sistema.
    clase: 'detenida_a_proposito',
    motivo: 'La liga estuvo DETENIDA por el halt manual (los siete en `halted = true` desde las 17:12 UTC del 29) mientras se diagnosticaba por qué `ARENA_ENABLED=0` no llegaba al deployment. No corrió: no hay decisiones, no hay órdenes y no hay abortos. El hueco es deliberado, no una falla.',
  },
];

export const esDiaContaminado = (fecha, season = ARENA_SEASON.id) =>
  TEMPORADA_DIAS_CONTAMINADOS.some((d) => d.fecha === String(fecha).slice(0, 10) && d.temporada === season);

export function seasonStatus(now = new Date(), season = ARENA_SEASON) {
  const today = easternToday(now);
  if (today < season.start) return 'pending';
  if (today > season.end) return 'ended';
  return 'running';
}

// ¿Hoy es el ÚLTIMO día de la temporada? Es el único día en que se declara al
// ganador (y la declaración es idempotente por id, así que un festivo o una
// corrida repetida no la duplican ni la mueven).
export function isSeasonFinalDay(now = new Date(), season = ARENA_SEASON) {
  return easternToday(now) === season.end;
}

// Día de temporada (1 = el de apertura). null fuera de la ventana — nunca un
// número negativo que se lea como si la temporada ya hubiera empezado.
export function seasonDay(now = new Date(), season = ARENA_SEASON) {
  if (seasonStatus(now, season) !== 'running') return null;
  const a = Date.parse(season.start + 'T00:00:00Z');
  const b = Date.parse(easternToday(now) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

export function agentById(id) {
  return ARENA_AGENTS.find((a) => a.id === id) || null;
}

// ── LAS SONDAS NO SON COMPETIDORES ───────────────────────────────────
// Corren el mismo harness para medir la INFRAESTRUCTURA, no para competir. Ya
// quedan fuera de la liga por `enabled: false`; esto las saca además de las
// pantallas y de los agregados públicos, donde una fila suya sería un agente
// que nadie inscribió.
export const PROBE_IDS = ARENA_AGENTS.filter((a) => a.probe).map((a) => a.id);
export const esProbe = (id) => PROBE_IDS.includes(String(id || '').toLowerCase());

// LOS QUE COMPITEN. Hasta el 2026-09-25 `ARENA_AGENTS` y "la liga" eran lo
// mismo, así que medio repo usaba el array crudo para decir "los siete": el
// lint de voces, el peor caso de costo de arena-watch, el conteo del anuncio de
// apertura. La primera entrada que NO era un competidor —las sondas de ruta—
// rompió cinco pruebas a la vez, todas por la misma causa.
//
// `activeAgents()` NO sirve para esto: contesta "quién corre HOY" y la respuesta
// cambia con `ARENA_LEAGUE` y con las banderas `enabled`. Un agente sacado de la
// parrilla por un día sigue siendo un competidor, y una sonda apagada nunca lo
// fue. Son dos preguntas distintas y ahora tienen dos funciones distintas.
export function competidores() {
  return ARENA_AGENTS.filter((a) => !a.probe);
}

// Creds Alpaca del agente: ALPACA_<ALPACA>_KEY / ALPACA_<ALPACA>_SECRET.
// null si faltan (el caller journalea aborted_no_alpaca_keys, sin romper la red).
export function agentAlpacaCreds(agent) {
  if (!agent || !agent.alpaca) return null;
  const key = process.env['ALPACA_' + agent.alpaca + '_KEY'];
  const secret = process.env['ALPACA_' + agent.alpaca + '_SECRET'];
  return key && secret ? { key, secret } : null;
}
