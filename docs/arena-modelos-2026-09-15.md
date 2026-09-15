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
| openai | GPT-6 Astra | `openai/gpt-6-astra` | `exact` en el smoke del 15-09, falta bajarlo al registry |
| gemini | Gemini 3.8 **Flash** | `google/gemini-3.8-flash` | **Sí** — salió del catálogo vivo el 15-09 |
| grok | Grok 4.6 | `x-ai/grok-4.6` | `exact` en el smoke del 15-09, falta bajarlo al registry |
| deepseek | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | `exact` en el smoke del 15-09, falta bajarlo al registry |
| qwen | Qwen3.8 Max | `qwen/qwen3.8-max` | **NO existe** — el catálogo ofrece `qwen/qwen3.8-max-0902` |

> **`gemini` corre en FLASH, no en Pro.** `google/gemini-3.8-pro` no existe en
> OpenRouter: el tope de gama de Google que sí está es 3.1 y en preview. La
> elección real era "una generación atrás en preview" contra "la generación
> correcta un tier abajo", y ganó la generación (decisión de Lety, 15-09). La
> consecuencia hay que tenerla presente al leer el leaderboard: son **seis
> flagship y un flash**, así que comparar a `gemini` contra el resto mide
> también el peso, no solo el modelo.

Los **cuatro** de OpenRouter que siguen sin verificar respetan la convención
`vendor/modelo` del proveedor, pero **son candidatos, no hechos**. Escribirlos
como si fueran ciertos habría sido inventar un dato, así que el registry los
marca `slug_verified:false` y

> **un agente con slug no verificado y sin `ARENA_MODEL_<ID>` NO CORRE.**
> Journalea `aborted_unverified_model` y no gasta un token.

`/api/arena-smoke?catalog=1` es quien los resuelve: corre **desde Vercel**, que
sí llega a OpenRouter, compara contra el catálogo vivo y te devuelve el
`ARENA_MODEL_<ID>=...` exacto para pegar. Ese paso **no cuesta tokens**.

## 1. Runbook de hoy

```bash
BASE=https://quantdesk2.vercel.app
# Las tres formas son equivalentes; elegí una:
AUTH="x-admin-key: $ARENA_ADMIN_KEY"             # header simple
# AUTH="Authorization: Bearer $ARENA_ADMIN_KEY"  # el clásico
# ...o sin header: "$BASE/api/arena-smoke?key=$ARENA_ADMIN_KEY"

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
| `ARENA_ADMIN_KEY` | protege `/api/arena-smoke` | **Sí.** Sin ella el endpoint responde 503 |
| `ARENA_ALLOW_UNVERIFIED_SLUGS` | levanta el candado de slug | **No lo pongas.** Existe para un smoke a mano |

`/api/arena-smoke` tiene su **propia** llave y no comparte `CRON_SECRET`: lo
dispara una persona a mano y gasta dinero real en siete proveedores. Sin
`ARENA_ADMIN_KEY` configurada el endpoint **no queda abierto** — responde 503.
El default "si no hay llave, dejá pasar" es cómo un endpoint que gasta se
convierte en la factura de otro.

### Si te da `{"error":"No autorizado."}`

La key se lee de **tres** lugares, todos equivalentes, y se prueban **todos**
(que uno venga mal no invalida a los otros):

| Forma | Ejemplo |
|---|---|
| `Authorization: Bearer` | `curl -H "Authorization: Bearer $ARENA_ADMIN_KEY" "$BASE/api/arena-smoke?catalog=1"` |
| header `x-admin-key` | `curl -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-smoke?catalog=1"` |
| query `?key=` | `curl "$BASE/api/arena-smoke?catalog=1&key=$ARENA_ADMIN_KEY"` |

> El `?key=` existe para pegarlo en el browser, pero una URL viaja a los logs
> de acceso y al historial. Para la terminal, preferí el header.

Se hace **`trim()` de los dos lados**: el `\n` o el espacio que se cuela al
pegar el valor en Vercel ya no cuesta una hora de debug. Lo que el trim **no**
perdona son las comillas (`"abc"`): Vercel guarda el valor literal, no lo
desescapa.

El 401 ya no es una pared. Trae `hint` con qué falta, `recibido[]` con **por
dónde** llegó la key, cuántos chars traía, si el largo coincide con el de la env
y su `huella_sha256_12`, y `headers_con_pinta_de_key` — que es lo que caza el
caso "la mandaste por `x-api-key`, que este endpoint no lee". **La key nunca
viaja en la respuesta**: la huella es de lo *recibido*, no de la esperada, así
que un 401 no le regala material a nadie. Para comparar del lado tuyo:

```bash
printf %s "$ARENA_ADMIN_KEY" | shasum -a 256 | cut -c1-12   # printf %s, no echo
```

Si `recibido` viene `null`, la key no llegó por ninguna de las tres formas. Si
viene con `mismo_largo_que_la_env: true` pero igual rebota, es **otra** key:
casi siempre se regeneró en Vercel sin redeployar, o es la de Preview contra la
de Production.

### Si te da `FUNCTION_INVOCATION_TIMEOUT`

Antes de sospechar del modelo, mirá **`vercel.json`**. El techo de una función
se declara en DOS lugares y el que manda no es el obvio:

```js
export const maxDuration = 300;   // api/arena-smoke.js
```
```json
"functions": { "api/*.js": { "maxDuration": 60 } }   // vercel.json
```

Ese glob tapaba el `export` de **nueve** endpoints — `arena-run` y `arena-watch`
incluidos. Todos creían tener 300s y tenían 60. No falla en build, ni en deploy,
ni en import: solo se ve como una función muerta en producción. Ahora cada
endpoint pesado tiene su entrada propia en `vercel.json`, y
`tests/arena-timeouts.test.mjs` verifica que los dos lugares digan lo mismo.

**Los tres relojes, uno dentro del otro:**

| Reloj | Default | Env var | Cubre |
|---|---|---|---|
| una conexión al proveedor | 90s | `ARENA_LLM_TIMEOUT_MS` | un `fetch` a Anthropic/OpenRouter |
| el trabajo de un agente | 240s | `ARENA_AGENT_DEADLINE_MS` | scan + dive + retries del guard |
| la función | 300s | `vercel.json` + el `export` | todo, incluido escribir al journal |

El margen final (240 → 300) existe para que, cuando un agente se pase, la
función siga viva lo suficiente para **escribir que se pasó**. Un timeout que no
se journalea es indistinguible de una corrida que nunca ocurrió.

Antes de esto los timeouts de conexión estaban hardcodeados y asimétricos: 45s
para OpenRouter y **180s** para Anthropic. Los 180s eran imposibles de honrar
—triplicaban el cap real de 60s—, así que el `fetch` nunca llegaba a abortar por
su cuenta: lo mataba la función antes, sin dejar rastro.

**Los siete corren en paralelo**, cada uno con su reloj. Un agente colgado sale
como una fila `failure: "timeout"` y los otros seis reportan normal; antes eran
secuenciales y 7 × ~60s no cabían en ningún `maxDuration`.

```bash
# Un solo agente (ya existía, sirve para aislar al lento):
curl -sS -H "$AUTH" "$BASE/api/arena-smoke?agent=openai" | jq '.probes[0]'

# En vivo: cada agente sale apenas termina, en NDJSON.
# Sirve de red de seguridad — si la función igual se pasa, lo ya escrito llegó.
curl -sN -H "$AUTH" "$BASE/api/arena-smoke?stream=1" | jq -c 'select(.type=="probe") | {agent, ok, failure, ms}'
```

> `?stream=1` es opt-in porque `jq` no come NDJSON sin `-s`: sin el flag la
> respuesta sigue siendo un JSON entero y el runbook de arriba no cambia. Ojo
> que con los siete en paralelo terminan casi juntos, así que el streaming es
> una red, no un chorro de progreso.

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

> **Listo para pegar en Neon: `docs/sql/arena-diagnostico-2026-09-15.sql` §1.**
> Incluye cómo leer cada resultado contra las cuatro hipótesis.

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


---

# 8. A4 — los tres fixes del journal del 14

## (a) El prompt ya no arrastra temporadas anteriores

**Ninguna** de las cuatro consultas de memoria que alimentan el prompt tenía
corte por temporada:

| Consulta | Ventana que tenía | Ahora |
|---|---|---|
| plan anterior reinyectado | el último `decide`, de la temporada que fuera | `run_date >= ARENA_SEASON.start` |
| fills (reconstruir aperturas) | 180 días | + el mismo corte |
| compromisos abiertos | 60 días | + el mismo corte |
| **pico de equity del breaker** | **sin corte ninguno** | + el mismo corte |

**Sobre el "ZM filled at $95.5" de claude:** encaja con este bug y no puedo
confirmarlo sin leer Neon. El 14 fue el primer día de la T2, y con estas
ventanas el PM recibía el plan de cierre de la T1 más 180 días de fills sobre un
libro ya aplanado. Un fill real, de otra temporada, narrado como si fuera del
libro actual tiene exactamente esa forma. La consulta que lo confirma:

```sql
-- ¿De qué corrida salió ese fill, y de qué temporada es esa corrida?
select run_date, agent_id, status,
       jsonb_path_query_array(actions, '$[*] ? (@.symbol == "ZM")') as zm
from arena_journal
where agent_id = 'claude' and phase = 'decide'
  and actions @> '[{"symbol":"ZM"}]'
order by run_date desc limit 10;

-- Y qué plan se le reinyectó el 14 (si su run_date < el arranque de la T2,
-- es este bug, confirmado):
select run_date, left(plan, 300)
from arena_journal
where agent_id = 'claude' and phase = 'decide' and plan is not null
  and status not in ('season_start','season_started','rules_changed','season_winner')
  and run_date < '2026-09-14'
order by created_at desc limit 1;
```

### El bug más grave que esto destapó: el breaker mataba a los siete el lunes 21

El pico de equity (`max(account->>'equity')`) solo estaba acotado por
`resumed_at`, que existe para el halt/resume manual — **no** por la temporada.
Con el reset del lunes 21 a $100k, el pico de la T2 habría seguido contando:

> pico $130k contra equity $100k = **−23% de drawdown** → `risk_broad_cut` →
> liquidación y **HALT en la primera corrida de la temporada**, para los siete.

Y el halt es persistente y se revive a mano. El relanzamiento habría durado una
corrida. Está arreglado y cubierto por `tests/arena-season-cutoff.test.mjs`.

## (b) El equity dice que incluye el cash

`equity` → **`equity_total_incl_cash`**, y `cash` → `cash_included_in_equity`,
más una línea explícita en **ambas** fases del prompt:

> `equity_total_incl_cash` is the TOTAL value of the book: your positions PLUS
> your cash. `cash_included_in_equity` is the part of that same total that is
> not invested — it is NOT an extra amount on top.

Mismo criterio que `pnl_since_entry_pct`: el **nombre del campo** carga la
semántica, para que el PM no tenga que inferirla. Un PM que cree tener
equity + cash de pólvora sobredimensiona todas sus posiciones.

## (c) Filtro de admisión del universo — y de dónde venía DDDX

**No vino del canal movers.** `trimMovers` filtra precio ≥ $5 desde julio. Vino
del canal **insider**: `trimInsiders` tomaba los Form 4 de la SEC tal cual, sin
un solo filtro. Y la SEC no distingue entre un director de Apple comprando $2M y
el dueño de una shell OTC comprándose $3,000 de su propia empresa.

El problema de fondo no era que faltara un filtro: era que **cada canal tenía un
criterio distinto** (movers estricto, insider y screener inexistentes) y **el más
flojo decidía qué veía el PM**. Ahora hay uno solo, en
`_lib/arena-admission.js`, que aplican los tres:

> **precio ≥ $5 · market cap ≥ $1B · volumen en dólares ≥ $10M/día (20 sesiones)**

Cuatro decisiones de diseño que vale la pena conocer:

1. **FAIL CLOSED.** Un ticker cuyos datos de admisión no se pueden resolver
   **no entra**. "Si no sé, que pase" es literalmente cómo entró DDDX.
2. **`data_unavailable` se cuenta aparte** de los rechazos por criterio. Son
   problemas distintos: uno es el filtro funcionando, el otro es cobertura rota.
   Si ese contador se dispara, el filtro está tirando nombres buenos y hay que
   arreglar la fuente, no el umbral.
3. **Point-in-time**: el volumen promedio se calcula sobre velas **cerradas**.
   La vela viva no cuenta — si contara, un nombre seco parecería líquido justo
   el día del pico de volumen, que es justo el día en que se lo intentaría
   operar.
4. **El guard sube su piso de $1 a $5** para coincidir. Las dos barreras tienen
   que decir lo mismo, o el PM recibe un "no" que no puede predecir. Hay un test
   que falla si alguien mueve una sin la otra.

Los rechazos van al journal en `context.admission` (motivo + canal por nombre) y
**no** al prompt: el PM no necesita la lista de lo que no vio.

**Costo:** ~26 llamadas a Finnhub `profile2` + ~8 series de Yahoo por corrida,
con caché por día en memoria, y reusando el precio que los movers ya traen.
Sumado al deep-dive (~20) queda bajo el cap de 60/min del tier gratis. En B1 esto
se reemplaza por el universo precomputado en KV y el costo por corrida baja a ~0.

## Lo que sigue necesitando tus ojos

| Qué | Por qué |
|---|---|
| `ARENA_ADMIN_KEY` en Vercel | sin ella el smoke responde 503 |
| `ARENA_MODEL_<ID>` × 5 | lo que devuelva el paso 1 del smoke |
| el salto de costo (§5) | ~$187/mes de peor caso solo en Anthropic |
| confirmar el origen del "ZM" | el SQL de arriba; yo no llego a Neon |
