# ARENA — LIGA multi-modelo

Fecha: 2026-08-03. Generaliza el Arena (Agente #6 "Claude PM · Haiku") a una
LIGA de N modelos corriendo el **mismo harness** (SCAN → DEEP DIVE → guard →
orden límite) sobre **cada uno su propio libro Alpaca paper**. El objetivo es
comparar el **MODELO** — no el prompt, ni el presupuesto. Base: `docs/arena.md`
(el harness de un agente no cambia; esto lo hace por-agente).

Ángulo de contenido: **IAs chinas vs americanas** (DeepSeek fue #1 en Rallies
en enero; Qwen es parte de la historia de nof1). El **control** (piso de ruido)
es el diferenciador que ningún arena famoso tiene y cuesta centavos.

## Piezas nuevas

| Pieza | Archivo |
|---|---|
| Registry de la liga (quién compite, modelo/cuenta/persona) | `api/_lib/arena-registry.js` |
| Dispatch de proveedor (Anthropic directo · OpenRouter, forma normalizada) | `api/_lib/arena-model.js` |
| Runner multi-agente (orquestador + decide por-agente) | `api/arena-run.js` (`runArenaLeague`) |
| Columna `agent_id` (journal + state re-llaveado) | `api/_lib/db.js` |
| Datos públicos de la liga (ranking por equity) | `api/leaderboard.js` |
| Página pública de la liga | `leaderboard.html` (rewrites `/leaderboard`, `/liga`) |
| Embed compacto en la página del día | `hoy.html` (grid N-ready → `/api/leaderboard`) |
| Vista single-agent del insignia (app.html / MIS AGENTES) | `api/arena.js` (scoped a `claude`) |
| Tests | `tests/arena-liga.test.mjs` (+ `tests/arena-run.test.mjs` intacto) |

## Las 7 decisiones

### 1. Modelos — la liga (7 agentes)

| id | nombre | proveedor | slug (default, env-overridable) | casa | cuenta |
|---|---|---|---|---|---|
| `claude` | Claude | anthropic (directo) | `ANTHROPIC_MODEL` (`claude-haiku-4-5`) | 🇺🇸 | `PAPER` |
| `openai` | ChatGPT | openrouter | `openai/gpt-5-mini` | 🇺🇸 | `OPENAI` |
| `control` | Control · Haiku-B | anthropic (directo) | `ANTHROPIC_MODEL` (`claude-haiku-4-5`) | control | `CONTROL` |
| `grok` | Grok | openrouter | `x-ai/grok-4-fast` | 🇺🇸 | `GROK` |
| `gemini` | Gemini | openrouter | `google/gemini-2.5-flash` | 🇺🇸 | `GEMINI` |
| `deepseek` | DeepSeek | openrouter | `deepseek/deepseek-chat-v3.1` | 🇨🇳 | `DEEPSEEK` |
| `qwen` | Qwen | openrouter | `qwen/qwen-plus` | 🇨🇳 | `QWEN` |

**El Claude que compite es HAIKU, por API directa** — NO Sonnet ni Opus. El
Agente #6 ya lleva días de historial con Haiku y se preserva esa continuidad
(la cuenta `PAPER` existente + el historial del journal, re-llaveado a `claude`).
La comparación Haiku vs Sonnet vs Opus es un experimento SEPARADO, después.

**Criterio de tier (por qué estos slugs):** que sean **comparables en
capacidad/costo entre sí** — la clase **rápida/eficiente** de cada casa, la que
compite con Haiku 4.5 —, **NO el tope de gama**. Si los tiers son dispares se
deja de medir "modelo" y se mide presupuesto. Justificación por elección:

- **`openai/gpt-5-mini`** — el "mini" de GPT-5: rápido y barato, el análogo
  directo de Haiku. `gpt-5` (full) sería el tope → se evita.
- **`x-ai/grok-4-fast`** — la variante *fast* de Grok 4 (bajo costo, baja
  latencia). `grok-4` full es el caro; `grok-code-fast` es específico de código
  → se evitan ambos.
- **`google/gemini-2.5-flash`** — el tier *Flash* (rápido/eficiente). *Pro* es
  el tope de gama → se evita para no medir presupuesto.
- **`deepseek/deepseek-chat-v3.1`** — el chat general de DeepSeek (V3.1), barato;
  NO el *reasoner* (R1), que es el tier caro de razonamiento.
- **`qwen/qwen-plus`** — el tier *Plus* (balanceado) de Alibaba. `qwen-max` es el
  tope; `qwen-turbo` el más chico → *Plus* queda en la clase comparable.

**Slugs env-overridables** (`ARENA_MODEL_<ID>`, p.ej. `ARENA_MODEL_GROK`): un
slug que OpenRouter retire o renombre se corrige con una env var en Vercel, sin
redeploy — misma filosofía que `_lib/model.js` (nunca más un grep de 26 sitios).

### 2. Temperatura

**Fija, idéntica para todos, no-cero: `0.7`** (`ARENA_TEMPERATURE`, override a
[0,2]; inválida → 0.7). 0 colapsaría cada modelo a su moda y borraría justo la
variabilidad que se quiere observar. **Límite conocido (no resoluble):** cada
proveedor interpreta `temperature` distinto (rango, sampling) — se documenta,
no se iguala. Es un caveat del experimento al nivel del de la persona (#6).

### 3. Cuentas Alpaca — multi-login

7 agentes = **3 logins × 3 cuentas paper** (gratis, tres correos distintos).
Cada agente tiene su par de keys, nombrado por su columna `alpaca`:
**`ALPACA_<ALPACA>_KEY` / `ALPACA_<ALPACA>_SECRET`**. Sin confusión entre 7
pares: el nombre de la env var ES el del agente.

| agente | env vars | login sugerido |
|---|---|---|
| `claude` | `ALPACA_PAPER_KEY` / `ALPACA_PAPER_SECRET` | Login 1 · cuenta A (la del Agente #6, **ya existe** → preserva historial) |
| `openai` | `ALPACA_OPENAI_KEY` / `ALPACA_OPENAI_SECRET` | Login 1 · cuenta B |
| `control` | `ALPACA_CONTROL_KEY` / `ALPACA_CONTROL_SECRET` | Login 1 · cuenta C |
| `grok` | `ALPACA_GROK_KEY` / `ALPACA_GROK_SECRET` | Login 2 · cuenta A |
| `gemini` | `ALPACA_GEMINI_KEY` / `ALPACA_GEMINI_SECRET` | Login 2 · cuenta B |
| `deepseek` | `ALPACA_DEEPSEEK_KEY` / `ALPACA_DEEPSEEK_SECRET` | Login 2 · cuenta C |
| `qwen` | `ALPACA_QWEN_KEY` / `ALPACA_QWEN_SECRET` | Login 3 · cuenta A |

El mapa login→agente es **bookkeeping** (Lety decide qué cuenta va en qué env
var); el código solo lee `ALPACA_<ALPACA>_*`. Broker API queda para si algún día
crece más. La cuenta del **smoke de venta** (`ALPACA_SMOKE_*`) sigue aparte, sin
cambios. Un agente sin sus keys se journalea `aborted_no_alpaca_keys` y **no
tumba a los demás** — radio de explosión mínimo.

### 4. Cadencia — construir por etapas, lanzar de una vez

**Fase A (esta):** `enabled:true` para **`claude` + `openai` + `control`**. Ese
trío ejercita TODAS las rutas de la liga completa:

- **Anthropic directo** (`claude`, `control`) · **OpenRouter** (`openai`),
- **multi-cuenta** (3 cuentas, 1 login),
- **identidad de prompt** (persona por agente),
- **el control** (Haiku-B),
- **`agent_id`** (columna, journal + state + reconcile + leaderboard).

Con el mínimo radio de explosión: un bug de adapter revienta en 3 agentes, no en 7.

**Fase B (después, cuando A esté verde unos días):** Grok, Gemini, DeepSeek, Qwen
ya son **filas del registry** con `enabled:false`. Encenderlas es:
- flip `enabled:true` + cargar sus `ALPACA_*` (y `OPENROUTER_API_KEY` ya está), **o**
- una sola env var **`ARENA_LEAGUE=claude,openai,control,grok,gemini,deepseek,qwen`**
  en Vercel (gana sobre las banderas `enabled`), para lanzar los 7 de golpe sin
  redeploy.

**No se publica hasta que los siete corran.** El lanzamiento público (TikTok) es
con la liga completa desde el día 1 — la comparación se ve en el primer video.

### 5. Control al lanzamiento — sí, día 1

`control` es **Haiku-B**: MISMO modelo (`claude-haiku-4-5`), MISMO prompt
(persona byte-idéntica a `claude`), MISMA temperatura, **DISTINTA cuenta**.
Es el **piso de ruido**: sin él, ningún delta entre modelos significa nada
(dos corridas del mismo modelo divergen solo por el orden de fills y el estado
del libro). Cuesta centavos y ningún arena famoso lo tiene.

### 6. Leaderboard — ruta pública nueva

**`/leaderboard`** (y alias `/liga`): página standalone, móvil-primero (como
`/hoy`), sin login, que **abre rápido en un teléfono y se entiende sin contexto**
— es lo que se comparte en TikTok. **Ranking por equity**; por cada agente su
**último plan** (verbatim, patrón nof1) y sus **trades**. Datos de
`/api/leaderboard` (equity/cash/posiciones por cuenta + última decisión +
halt + return vs. baseline + cambio del día).

- **NO** es el tab MIS AGENTES: ese (`app.html` → `/api/arena`) sigue mostrando
  solo al **insignia** (`claude`), scopeado por `agent_id='claude'` — su card y
  su historial intactos.
- **`/hoy` embebe una versión compacta:** su grid Arena ya era N-ready → ahora
  lee `/api/leaderboard`, renderea las N cards rankeadas (badge #1/#2/#3 +
  return) y enlaza a `/leaderboard`. Cero rehacer.

### 7. `agent_id` COLUMNA, no tabla por agente

Una tabla por agente forkearía el schema y duplicaría cada query del reconcile
y del post-mortem. En su lugar:

- `arena_journal.agent_id` (+ índice `(agent_id, phase, created_at desc)`). El
  historial del Agente #6 (filas sin `agent_id`) se **backfillea a `claude`** →
  continuidad preservada.
- `arena_state` re-llaveada por `agent_id` (índice único): halt por agente, no
  global. La PK vieja de `id` se suelta (queda vestigial). La fila legada →
  `claude`; las de agentes nuevos se siembran en cada corrida (`ensureAgentStateRows`).
- Todo query del runner/leaderboard/reconcile/arena filtra por `agent_id`.

## Env vars (resumen de encendido)

1. **Keys de proveedor:** `ANTHROPIC_API_KEY` (claude + control), `OPENROUTER_API_KEY`
   (todos los de OpenRouter — una sola key para las 5).
2. **Keys de Alpaca por agente:** `ALPACA_<ALPACA>_KEY/SECRET` (tabla de #3).
   `claude` reusa `ALPACA_PAPER_*` (no cambiar).
3. **Gate global:** `ARENA_ENABLED=1` (igual que hoy; el handler no opera sin él).
4. **Opcionales:** `ARENA_TEMPERATURE` (0.7), `ARENA_MODEL_<ID>` (override de slug),
   `ARENA_LEAGUE` (lista de ids a correr → Fase B sin redeploy),
   `ARENA_BASELINE_EQUITY` (100000, para el return del leaderboard).
5. **Ya existentes:** `FINNHUB_API_KEY`, `DATABASE_URL`, `CRON_SECRET`,
   `PUBLIC_BASE_URL`, `ARENA_SCREENER_ENABLED`.

Los crons de `vercel.json` no cambian: `/api/arena-run` (decide) ahora corre la
LIGA (todos los agentes activos en paralelo, buffet/deep-dive/cierres
compartidos por corrida → wall-clock ≈ un agente); `?phase=reconcile` reconcilia
cada fila con las creds de SU agente; `?action=resume&agent=<id>` /
`?action=status` son por-agente.

## Notas de diseño

- **Trabajo compartido por corrida.** El buffet (self-fetch), los cierres de
  Yahoo y los deep-dives de Finnhub son datos de MERCADO idénticos para todos →
  se piden UNA vez por símbolo (cache con in-flight promise), no una por agente.
  El burst a Finnhub queda acotado a la **unión** de candidatos, no a la suma.
- **Aislamiento entre agentes.** El índice de canales del buffet se **clona** por
  agente antes de marcar `portfolio` (cada libro difiere). Un agente que truena
  (sin keys, error de proveedor) sale con su propio status; los demás siguen.
- **Ranking justo (caveat).** Se rankea por equity (decisión #6). `claude` arrastra
  unos días de ventaja (su cuenta ya operaba); las cuentas nuevas arrancan en el
  baseline de Alpaca. El leaderboard muestra también `return_pct` vs. baseline
  para leer el desempeño relativo. Resetear las cuentas al mismo capital antes
  del lanzamiento público es opción de Lety.
