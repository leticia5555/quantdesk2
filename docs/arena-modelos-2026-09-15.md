# Arena — cambio de modelos del 2026-09-15 (runbook + diagnóstico de grok)

> Qué cambió, qué tenés que hacer vos antes de las 22:40 UTC de hoy, y por qué
> grok abortó el 14 y el 15.

## 0. Lo que NO pude verificar, y qué hice al respecto

El entorno donde se escribió esto **no tiene salida a `openrouter.ai`** (el proxy
de egress responde 403 al CONNECT) ni keys de ningún proveedor. Así que de los
siete slugs:

| Agente | Modelo | Slug por default | ¿Verificado? |
|---|---|---|---|
| claude | Claude Fable 5.1 | `ARENA_CLAUDE_MODEL` (ver `_lib/model.js`) | **Sí** — está en el catálogo vigente de Anthropic |
| control | Claude Fable 5.1 | el mismo | **Sí** |
| openai | GPT-6 Astra | `openai/gpt-6-astra` | **NO** |
| gemini | Gemini 3.8 Pro | `google/gemini-3.8-pro` | **NO** |
| grok | Grok 4.6 | `x-ai/grok-4.6` | **NO** |
| deepseek | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | **NO** |
| qwen | Qwen3.8 Max | `qwen/qwen3.8-max` | **NO** |

Los cinco de OpenRouter siguen la convención `vendor/modelo` del proveedor, pero
**son candidatos, no hechos**. Escribirlos como si fueran ciertos habría sido
inventar un dato, así que el registry los marca `slug_verified:false` y

> **un agente con slug no verificado y sin `ARENA_MODEL_<ID>` NO CORRE.**
> Journalea `aborted_unverified_model` y no gasta un token.

`/api/arena-smoke?catalog=1` es quien los resuelve: corre **desde Vercel**, que
sí llega a OpenRouter, compara contra el catálogo vivo y te devuelve el
`ARENA_MODEL_<ID>=...` exacto para pegar. Ese paso **no cuesta tokens**.

## 1. Runbook de hoy

```bash
BASE=https://quantdesk2.vercel.app
AUTH="Authorization: Bearer $CRON_SECRET"

# ── PASO 1 — GRATIS. Resolver los cinco slugs. ───────────────────────
curl -sS -H "$AUTH" "$BASE/api/arena-smoke?catalog=1" | jq '.slugs[] | {agent, resolution, slug, candidates, fix}'
```

- `resolution: "exact"` → ese agente está listo.
- `resolution: "suggested"` → copiá el `fix` que corresponda a Vercel
  (Settings → Environment Variables), redeployá, y repetí el paso 1.
- `resolution: "missing"` → ese modelo no existe en OpenRouter con ese nombre.
  Decidime vos con qué reemplazarlo; yo no lo adivino.

```bash
# ── PASO 2 — CUESTA TOKENS. El prompt real contra los siete. ─────────
curl -sS -H "$AUTH" "$BASE/api/arena-smoke" | jq '{verdict, total_cost_usd, probes: [.probes[] | {agent, ok, failure, json_ok, stop_reason, truncated, tokens, cost_usd, ms}]}'
```

Verde = los siete con `ok: true` (JSON válido **y** sin truncarse). Ese es el
criterio para dejar correr la nocturna.

Si algo sale rojo, `probes[].failure` te dice cuál de estas siete cosas fue:
`missing_api_key` · `unverified_slug` · `http_<código>` · `refusal` ·
`stale_dates` · `truncated_at_max_tokens` · `malformed_json`. No hay un
"abortó" genérico.

**El smoke usa un portafolio ficticio** ($100k en efectivo, cero posiciones) y
**no lee las cuentas de Alpaca**. El prompt es el real en todo menos ese bloque.
Está declarado en la respuesta (`portfolio: "stand_in"`) para que nadie lea el
resultado como si fuera una corrida.

### Variables de entorno

| Var | Para qué | ¿Hace falta hoy? |
|---|---|---|
| `ARENA_MODEL_OPENAI` … `_QWEN` | el slug real de cada uno | **Sí**, salvo que el smoke diga `exact` |
| `ARENA_CLAUDE_MODEL` | override del modelo de Anthropic del Arena | No (el default ya es Fable 5.1) |
| `ARENA_MAX_TOKENS` | techo de salida, ambas fases | No (default 6000) |
| `ARENA_EFFORT` | profundidad de razonamiento | No (default `medium`) |
| `ARENA_ALLOW_UNVERIFIED_SLUGS` | levanta el candado de slug | **No lo pongas.** Existe para un smoke a mano |

> ⚠️ **No toques `ANTHROPIC_MODEL`.** Es el modelo de TODA la app (sim, earnings,
> Smart $, los 6 agentes de la flota) y sigue en Haiku a propósito. Apuntarlo a
> Fable 5.1 subiría la app entera de $1/$5 a $10/$50 por MTok. El Arena tiene su
> propia perilla (`ARENA_CLAUDE_MODEL`) justamente para eso.

## 2. El bloqueante que había: la temperatura

`callArenaLLM` mandaba `temperature: 0.7` en el payload de Anthropic. **Claude
Fable 5.1 responde HTTP 400 a `temperature`** (y a `top_p`/`top_k`): en esa
familia el sampling no es configurable, la profundidad se controla con
`output_config.effort`.

Sin este arreglo, `claude` y `control` habrían abortado en la **primera llamada
de la primera corrida**, todos los días, con cero órdenes — y el journal habría
dicho `aborted_llm_error: HTTP 400`, que no le dice a nadie que la culpa era de
un parámetro nuestro.

**Consecuencia que hay que declarar:** la decisión #2 de la liga —"misma
temperatura para los siete"— **ya no se puede cumplir**. No es algo que
elegimos: es que el parámetro dejó de existir en esa familia. Queda así:

- `claude` y `control`: **sin** temperatura, `effort: medium`.
- los cinco de OpenRouter: `temperature: 0.7` + `reasoning.effort: medium`.

Lo que **sí** se preserva es lo único que hacía válido al control: `claude` y
`control` mandan parámetros byte-idénticos **entre ellos**. El piso de ruido
sigue midiendo ruido. Comparar `claude` contra `gemini` ahora carga un confound
más, y va anunciado en el journal (`arena-modelos-2026-09-15`) para que el
post-mortem no lo olvide.

## 3. Otros dos cambios de contrato con Fable 5.1

El Arena deja de usar `guardedClaudeCall` (que sigue siendo el camino de toda la
app sobre Haiku, **sin tocar**) y replica el guard de fechas en
`_lib/arena-model.js`. Además de la temperatura:

- **Retry del guard de fechas.** El retry de `ai-guard` reconstruye el turno del
  asistente como texto plano. En un modelo con thinking eso descarta los bloques
  de pensamiento del turno original, que es justo lo que el chequeo de historia
  de Fable 5.1 no perdona. Ahora el eco es `data.content` **verbatim**.
- **`stop_reason: "refusal"`.** Un rechazo del clasificador llega como HTTP 200
  sin JSON. Por el camino viejo se journaleaba como `aborted_malformed_json` —
  el post-mortem leería "no supo formatear" cuando la verdad es "se negó". Ahora
  tiene su propio status: `aborted_llm_refusal`.

## 4. Caché de prompt

Encendida donde el proveedor la soporta: explícita en Anthropic
(`cache_control`), automática en los modelos de OpenAI vía OpenRouter.

El detalle que la hace funcionar: el system del Arena es largo y **congelado**
(el reglamento no cambia entre corridas ni entre agentes), pero el recordatorio
de fecha cambia todos los días. Se parten en **dos bloques** con el breakpoint en
medio, así el reglamento queda cacheable y la fecha cae fuera del prefijo. Al
revés —un solo bloque con la fecha adentro— la caché se invalidaría cada día y
el ahorro sería exactamente cero.

**No cambia ni una palabra de lo que el modelo lee.** Verificalo en el smoke:
`probes[].tokens.cache_read` debe ser 0 en la primera corrida y > 0 en la
segunda.

## 5. El costo subió, y bastante

El estimador del peor caso (`estimateWorstCaseCost`) estaba mal en tres formas y
se arregló:

1. cobraba a Anthropic a precio de **Haiku** (`$1/$5`) cuando el modelo real
   cuesta `$10/$50`;
2. usaba los precios de cinco modelos de OpenRouter **que ya no corren**;
3. asumía un techo de salida de 3000 cuando ahora es 6000 — y en un modelo de
   razonamiento **los tokens de pensamiento se cobran como salida**.

| | antes | ahora |
|---|---|---|
| peor caso diario, los 2 de Anthropic | ~$0.53 | **$8.90** |
| ~mensual (21 sesiones) | ~$11 | **~$187** |
| los 5 de OpenRouter | (precios viejos) | **sin precio** hasta el smoke |

Ese es el **peor caso absoluto**: los 12 topes de corridas por agente todos los
días y toda respuesta llegando al techo. Un día normal son 1-3 corridas. Pero es
un salto de ~17× en la parte de Anthropic y merece tu visto bueno antes de dejar
el cron corriendo un mes.

El total ahora se marca `partial: true` mientras falten precios, en vez de
publicar un número que parece cubrir a los siete y cubre a dos.

## 6. Diagnóstico: por qué abortó grok el 14 y el 15

**Sin acceso a Neon no puedo leer las filas.** Lo que sigue son las hipótesis
ordenadas por cómo encajan con "2 de 2, determinista", el SQL que las distingue,
y los dos arreglos de causa raíz que ya entraron.

### El SQL que lo cierra

```sql
select run_date, status, error,
       context -> 'scan' ->> 'stop_reason'   as scan_stop,
       length(context -> 'scan' ->> 'response') as scan_chars,
       left(context -> 'scan' ->> 'response', 600) as scan_head,
       context -> 'dive' ->> 'stop_reason'   as dive_stop,
       context -> 'dive' ->> 'truncated'     as dive_trunc,
       model
from arena_journal
where agent_id = 'grok' and phase = 'decide'
  and run_date in ('2026-09-14','2026-09-15')
order by run_date;
```

### Hipótesis, en orden

**#1 — El techo de 500 tokens del SCAN, contra un modelo que razona.** *(la que
más encaja)*
El SCAN corría con `maxTokens: 500`. Ese número se escribió para un modelo que
contesta sin pensar. En un modelo de razonamiento los tokens de pensamiento
salen del **mismo** presupuesto: 500 se consumen antes de emitir el primer
`{`, `finish_reason` vuelve `length`, el texto llega vacío o cortado, y
`parseScanResponse` falla → `aborted_scan_malformed_json`. Es determinista —
explica el 2 de 2 — y es exactamente el síntoma que produce un modelo nuevo que
razona más que el anterior.
**Firma en el SQL:** `status = 'aborted_scan_malformed_json'` y `scan_chars`
chico o 0.
**Arreglado:** techo único de 6000 para ambas fases.

**#2 — La respuesta viene en `message.reasoning`, no en `message.content`.**
`normalizeOpenRouter` leía **solo** `msg.content`. Varios modelos de
razonamiento en OpenRouter dejan el texto en `message.reasoning` y `content`
vacío, sobre todo cuando el techo los cortó. Eso se volvía `''` → JSON inválido,
con el journal culpando al formato de un modelo que nunca llegó a contestar.
**Firma:** igual que #1 pero con `usage.completion_tokens` alto. Las dos suelen
ir juntas: son la misma falla vista desde dos lados.
**Arreglado:** si `content` viene vacío y hay `reasoning`, se usa ése.

**#3 — El slug se retiró.** `x-ai/grok-4-fast` dejó de existir en el catálogo →
HTTP 404 → `aborted_llm_error`. También determinista.
**Firma:** `status = 'aborted_llm_error'`, `error` con `HTTP 404`.
**Cubierto:** el paso 1 del smoke resuelve el slug contra el catálogo, y el
candado impide correr con uno no verificado. Además el error de HTTP ahora viaja
con el mensaje del proveedor, no como un "HTTP 404" mudo.

**#4 — El guard anti-fechas.** Si el modelo narra fechas prospectivas rotas dos
veces seguidas, devuelve `stale` → `aborted_llm_error: fechas rotas tras retry`.
Posible, pero sería raro que fuera determinista 2 de 2.
**Firma:** `error` contiene `fechas rotas tras retry`.

### El arreglo de observabilidad que faltaba

El DIVE journaleaba `stop_reason`, `truncated` y `response_chars` desde siempre.
**El SCAN no.** Por eso un aborto de fase 1 era indistinguible entre "el modelo
parloteó fuera del JSON" y "se quedó sin tokens" — y por eso este diagnóstico
tiene que ser una lista de hipótesis en vez de una respuesta. Ya journalea
`stop_reason`, `truncated`, `max_tokens`, `effort` y `usage`. El próximo aborto
se lee en una consulta, no en un doc.

## 7. Qué NO cambió

- `arena-guard.js`, `arena-exits.js`, `arena-memory.js`: intactos.
- El prompt: ni una palabra. Mismo reglamento T2, misma cadencia por evento.
- Las cuentas de Alpaca, los libros, el historial.
- `_lib/ai-guard.js`: intacto — lo usa toda la app.
- El titular del arquetipo (`arena-voice.js`) sigue en Haiku vía
  `ANTHROPIC_MODEL`: es una llamada corta que no decide nada, y dejarla barata
  es deliberado. Si algún día `ANTHROPIC_MODEL` apunta a Fable, esa llamada
  hereda el problema de la temperatura — está anotado acá para ese día.
