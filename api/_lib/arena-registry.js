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

import { ANTHROPIC_MODEL } from './model.js';

// Temperatura FIJA e idéntica para todos (decisión #2). No-cero: 0 colapsaría
// a los modelos a su moda y borraría justo la variabilidad que queremos medir.
// Override por env (validada a [0,2]); inválida → 0.7.
export const ARENA_TEMPERATURE = (() => {
  const n = Number(process.env.ARENA_TEMPERATURE);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 0.7;
})();

// Slug de OpenRouter con override por env (ARENA_MODEL_<ID>). Un slug que el
// proveedor retire se corrige en Vercel sin redeploy — igual que ANTHROPIC_MODEL.
const slug = (id, fallback) => process.env['ARENA_MODEL_' + id] || fallback;

// El agente insignia: su historial (Agente #6) se preserva y las vistas
// single-agent (app.html · /api/arena) lo muestran a él.
export const FLAGSHIP_AGENT_ID = 'claude';

// ── LA LIGA ───────────────────────────────────────────────────────────
// `enabled` = la parrilla de la TEMPORADA 2: los SIETE. Los slugs de OpenRouter
// apuntan a la clase RÁPIDA/EFICIENTE de cada casa (comparable a Haiku), no al
// tope de gama — así se mide el modelo y no el presupuesto (ver el scope).
export const ARENA_AGENTS = [
  {
    id: 'claude', name: 'Claude', model_label: 'Haiku 4.5',
    provider: 'anthropic', model: ANTHROPIC_MODEL, persona: 'Claude PM',
    archetype: { name: 'el analista prudente', voice: 'Mides dos veces y cortas una. Hablas de riesgo antes que de premio, sin dramatizar.' },
    alpaca: 'PAPER',            // reusa la cuenta del Agente #6 → preserva historial
    house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'openai', name: 'ChatGPT', model_label: 'GPT-5 mini',
    provider: 'openrouter', model: slug('OPENAI', 'openai/gpt-5-mini'), persona: 'GPT PM',
    archetype: { name: 'el optimista de producto', voice: 'Ves la tesis grande y la cuentas con entusiasmo, pero sin prometer números.' },
    alpaca: 'OPENAI', house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'control', name: 'Control · Haiku-B', model_label: 'Haiku 4.5',
    provider: 'anthropic', model: ANTHROPIC_MODEL,
    persona: 'Claude PM',       // IDÉNTICA a `claude` a propósito: es el piso de ruido
    archetype: { name: 'el escéptico que no cree en nadie', voice: 'No te crees ninguna tesis, ni la tuya. Señalas lo que puede salir mal y desconfías del consenso.' },
    alpaca: 'CONTROL', house: 'control', control: true, phase: 'A', enabled: true,
  },

  // ── Los cuatro que entran en la TEMPORADA 2 (eran la Fase B). Encendidos:
  //    sus `ALPACA_<ID>_*` ya están cargadas y comparten OPENROUTER_API_KEY. ──
  {
    id: 'grok', name: 'Grok', model_label: 'Grok 4 Fast',
    provider: 'openrouter', model: slug('GROK', 'x-ai/grok-4-fast'), persona: 'Grok PM',
    archetype: { name: 'el provocador', voice: 'Dices en voz alta lo que los demás callan. Irreverente y directo, nunca grosero.' },
    alpaca: 'GROK', house: 'us', control: false, phase: 'B', enabled: true,
  },
  {
    id: 'gemini', name: 'Gemini', model_label: 'Gemini 2.5 Flash',
    provider: 'openrouter', model: slug('GEMINI', 'google/gemini-2.5-flash'), persona: 'Gemini PM',
    archetype: { name: 'el ordenado', voice: 'Todo cabe en un marco limpio. Clasificas y ordenas; tu titular suena a conclusión bien archivada.' },
    alpaca: 'GEMINI', house: 'us', control: false, phase: 'B', enabled: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek', model_label: 'DeepSeek V3.1',
    provider: 'openrouter', model: slug('DEEPSEEK', 'deepseek/deepseek-chat-v3.1'), persona: 'DeepSeek PM',
    archetype: { name: 'el frío de los números', voice: 'Solo datos. Cero épica, cero adjetivos: el titular es una medición.' },
    alpaca: 'DEEPSEEK', house: 'china', control: false, phase: 'B', enabled: true,
  },
  {
    id: 'qwen', name: 'Qwen', model_label: 'Qwen Plus',
    provider: 'openrouter', model: slug('QWEN', 'qwen/qwen-plus'), persona: 'Qwen PM',
    archetype: { name: 'el paciente', voice: 'Juegas el largo plazo. El ruido de hoy te interesa poco; hablas en trimestres.' },
    alpaca: 'QWEN', house: 'china', control: false, phase: 'B', enabled: true,
  },
];

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
export const ARENA_SEASON = {
  id: 'T2',
  name: 'Temporada 2',
  start: /* date-lint-ok: fecha declarada de apertura de la temporada, un hecho fijo, no una referencia a "hoy" */ '2026-09-14',
  end: /* date-lint-ok: cierre declarado de la temporada (viernes, 4 semanas de mercado) */ '2026-10-09',
  weeks: 4,
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

// Creds Alpaca del agente: ALPACA_<ALPACA>_KEY / ALPACA_<ALPACA>_SECRET.
// null si faltan (el caller journalea aborted_no_alpaca_keys, sin romper la red).
export function agentAlpacaCreds(agent) {
  if (!agent || !agent.alpaca) return null;
  const key = process.env['ALPACA_' + agent.alpaca + '_KEY'];
  const secret = process.env['ALPACA_' + agent.alpaca + '_SECRET'];
  return key && secret ? { key, secret } : null;
}
