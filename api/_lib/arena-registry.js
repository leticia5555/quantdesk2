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
// 4. CADENCIA. Fase A enciende `claude` + `openai` + `control` (ese trío
//    ejercita TODAS las rutas: Anthropic directo, OpenRouter, multi-cuenta,
//    identidad de prompt y el control). Fase B agrega Grok/Gemini/DeepSeek/Qwen
//    — ya son filas aquí con `enabled:false`: encenderlas es flip de bandera +
//    sus keys, o un solo `ARENA_LEAGUE=<ids>` en Vercel para lanzar los 7 de
//    golpe sin tocar código.
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
// `enabled` = Fase A (los 3 primeros). Los slugs de OpenRouter apuntan a la
// clase RÁPIDA/EFICIENTE de cada casa (comparable a Haiku), no al tope de
// gama — así se mide el modelo y no el presupuesto (justificación en el scope).
export const ARENA_AGENTS = [
  {
    id: 'claude', name: 'Claude', model_label: 'Haiku 4.5',
    provider: 'anthropic', model: ANTHROPIC_MODEL, persona: 'Claude PM',
    alpaca: 'PAPER',            // reusa la cuenta del Agente #6 → preserva historial
    house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'openai', name: 'ChatGPT', model_label: 'GPT-5 mini',
    provider: 'openrouter', model: slug('OPENAI', 'openai/gpt-5-mini'), persona: 'GPT PM',
    alpaca: 'OPENAI', house: 'us', control: false, phase: 'A', enabled: true,
  },
  {
    id: 'control', name: 'Control · Haiku-B', model_label: 'Haiku 4.5',
    provider: 'anthropic', model: ANTHROPIC_MODEL,
    persona: 'Claude PM',       // IDÉNTICA a `claude` a propósito: es el piso de ruido
    alpaca: 'CONTROL', house: 'control', control: true, phase: 'A', enabled: true,
  },

  // ── Fase B: la liga completa. Filas presentes, apagadas. Encender =
  //    `enabled:true` (o `ARENA_LEAGUE`) + las keys de Alpaca de cada una. ──
  {
    id: 'grok', name: 'Grok', model_label: 'Grok 4 Fast',
    provider: 'openrouter', model: slug('GROK', 'x-ai/grok-4-fast'), persona: 'Grok PM',
    alpaca: 'GROK', house: 'us', control: false, phase: 'B', enabled: false,
  },
  {
    id: 'gemini', name: 'Gemini', model_label: 'Gemini 2.5 Flash',
    provider: 'openrouter', model: slug('GEMINI', 'google/gemini-2.5-flash'), persona: 'Gemini PM',
    alpaca: 'GEMINI', house: 'us', control: false, phase: 'B', enabled: false,
  },
  {
    id: 'deepseek', name: 'DeepSeek', model_label: 'DeepSeek V3.1',
    provider: 'openrouter', model: slug('DEEPSEEK', 'deepseek/deepseek-chat-v3.1'), persona: 'DeepSeek PM',
    alpaca: 'DEEPSEEK', house: 'china', control: false, phase: 'B', enabled: false,
  },
  {
    id: 'qwen', name: 'Qwen', model_label: 'Qwen Plus',
    provider: 'openrouter', model: slug('QWEN', 'qwen/qwen-plus'), persona: 'Qwen PM',
    alpaca: 'QWEN', house: 'china', control: false, phase: 'B', enabled: false,
  },
];

// Los agentes que corren esta liga. `ARENA_LEAGUE` (lista de ids separada por
// comas) gana sobre las banderas `enabled` — así el salto Fase A → liga completa
// es UNA env var en Vercel, sin redeploy. Sin override: las banderas `enabled`.
export function activeAgents() {
  const override = String(process.env.ARENA_LEAGUE || '').trim();
  if (override) {
    const want = new Set(override.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    return ARENA_AGENTS.filter((a) => want.has(a.id));
  }
  return ARENA_AGENTS.filter((a) => a.enabled);
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
