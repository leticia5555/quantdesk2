# SCOPE — Snapshot versionado del buffet + REPLAY multi-modelo del Arena

> **Estado:** FASE 0 (censo) hecha sobre el CÓDIGO; los conteos reales de Neon
> los corre Lety con el SQL de §1.1 (este sandbox no llega a Neon ni a
> vercel.app). FASE 1 = este documento. **Nada de código todavía** — al final,
> en §11, están las decisiones que necesito antes de escribir la primera línea.
>
> Referencia de diseño: el *algorithm-ready dataset* y el flag `jump-to-date`
> de AlgoTraders/stock-analysis-engine — **la idea, no el stack**. Aquí no entra
> Redis, ni S3S, ni Docker: Neon + Node 24 + los módulos que ya existen.

## Por qué

Hoy comparar dos modelos en el Arena cuesta **semanas de cron**: cada agente
necesita su cuenta Alpaca, su corrida nocturna y su ventana de temporada. Y aun
así los modelos no ven el mismo mercado — cada corrida trae su propio buffet.

El journal ya guarda lo que hace falta para romper esa dependencia: desde el
arreglo del post-mortem ciego, `arena_journal.context` trae el **prompt completo
de ambas fases**, el `sha256`, la respuesta verbatim del LLM, el resultado por
orden y —tras el reconcile de las 14:40 UTC— los fills reales. Falta darle dos
formas: un **SNAPSHOT** versionado del mercado del día, y un **REPLAY** que corra
cualquier modelo sobre esos snapshots con el mismo prompt, el mismo guard y el
mismo capital.

**Lo que esto NO es.** No es un backtest con validación estadística: son ~decenas
de días, un solo régimen de mercado y un fill simulado optimista (§6.3). Sirve
para **ordenar modelos entre sí sobre el mismo input**, no para afirmar que
alguno "gana dinero". La etiqueta de la casa aplica igual que en `docs/arena.md`.

## Reglas de la casa, aplicadas a este scope

| Regla | Cómo se cumple aquí |
|---|---|
| Nada de datos inventados | Los días ciegos (context NULL/parcial) se marcan `blind`/`partial` y **no se rellenan**. Cero re-fetch de fundamentales pasados. §2.3 |
| `arena-guard.js` NO se toca | El replay hace `import { validateActions, parsePlanResponse, parseScanResponse, applyScreenerFloor, ARENA_RULES } from '../api/_lib/arena-guard.js'` y lo llama tal cual. Un test lo verifica byte a byte (§9.2) |
| El replay NUNCA escribe en `arena_journal` ni toca Alpaca | Tablas nuevas (`arena_snapshot`, `arena_replay_runs`, `arena_replay_journal`). Test de escrituras (§9.3). Cero import de `_lib/alpaca.js` en el runner |
| Haiku es el baseline del cron real | El cron no cambia de modelo. Lo único que cambia hacia adelante es el **orden** de escritura: snapshot primero, PM después (§3) |
| Corre desde el Mac de Lety | `scripts/replay-arena.mjs`, Node 24, sin dependencias nuevas, con las env vars locales. El smoke lo corre ella |

---

# 1. FASE 0 — CENSO

## 1.1 Qué columnas tiene `arena_journal` hoy

Fuente autoritativa: `api/_lib/db.js:150-176` (DDL idempotente que corre
`ensureSchema`).

| Columna | Tipo | Qué trae |
|---|---|---|
| `id` | `text` PK | `arena:<agent>:<fecha>` (+ sufijos `:risk`, ids de anuncio de liga) |
| `run_date` | `date not null` | fecha de la corrida |
| `phase` | `text not null` | `decide` · `reconcile` · marcadores de liga |
| `status` | `text not null` | ver §1.3 |
| `prompt_version` | `text` | `arena-pm-v3-t2` hoy (`PROMPT_VERSION`, `api/arena-run.js:120`) |
| `prompt_hash` | `text` | sha256 del prompt **del DIVE** (la fase que produce órdenes) |
| `model` | `text` | slug del modelo del agente |
| `plan` | `text` | la prosa del PM |
| `llm_response` | `text` | respuesta **completa** del DIVE, verbatim |
| `actions` | `jsonb` | órdenes aprobadas/descartadas + `order_status`/`filled_avg_price`/`filled_at` (los escribe el reconcile) |
| `account` | `jsonb` | `{equity, cash, positions}` |
| `error` | `text` | razón del abort |
| `context` | `jsonb` | **la caja negra** — ver §1.2 |
| `created_at` | `timestamptz` | default `now()` |
| `agent_id` | `text` | liga multi-modelo; filas legadas migradas a `'claude'` |

Índice: `arena_journal_agent_idx (agent_id, phase, created_at desc)`.

**No hay tabla de snapshot.** El buffet solo existe embebido dentro del texto del
prompt en `context.scan.prompt.user` y, parcialmente, en campos sueltos.

## 1.2 Qué trae `context` hoy, llave por llave

Construido a lo largo de `runArenaDecide` (`api/arena-run.js:1089-1333`):

| Llave | Origen | ¿Es "mercado del día"? |
|---|---|---|
| `risk` | `{peak, drawdown, stage, escalation, bands, approved, discarded}` | **No** — portafolio |
| `positions_meta` | `buildPositionMeta` (T2) | **No** — portafolio |
| `commitments` | `{open, dropped}` del fold del journal | **No** — portafolio |
| `event` | corrida por evento/vigilante | Mixto |
| `unavailable` | endpoints caídos del buffet | **Sí** |
| `fetch_errors` | status HTTP/timeout real por endpoint | **Sí** |
| `scan.prompt.{system,user}` | texto completo del SCAN | Mixto (el buffet va **serializado adentro**) |
| `scan.hash`, `scan.model`, `scan.response` | | — |
| `scan.thesis`, `scan.candidates` | picks crudos del scout | Dependiente del modelo |
| `scan.floor` | `{applied, reserved, reason, floor}` | **Sí** (determinista) |
| `scan.screener_state` | `vacía/apagada/rancia/caída/fresh` | **Sí** |
| `scan.slate` | `[{symbol, origin}]` final | Dependiente del modelo |
| `dive.prompt.{system,user}` | texto completo del DIVE | Mixto |
| `dive.hash`, `dive.model` | | — |
| `dive.finnhub` | deep-dive por candidato | **Sí, pero solo de ≤5 tickers** — §2.4 |
| `dive.finnhub_errors` | | **Sí** |
| `dive.shown_closes` | cierre mostrado por candidato | **Sí**, mismos ≤5 |
| `dive.stop_reason`, `.response_chars`, `.truncated` | | — |
| `intraday.prices` | solo corridas por evento | **Sí** |
| `plan_number_audit` | `auditPlanPercentages` | — |
| `positions_review`, `position_review_audit` | T2 | **No** |
| `headline` | voz del arquetipo (llamada aparte) | **No** |

**Hallazgo clave:** el buffet estructurado (`movers`, `earnings_this_week`,
`recently_reported`, `notable_insider_buys`, `screener`) **no está como objeto en
`context`** — solo como JSON incrustado dentro del string
`context.scan.prompt.user`. El backfill tiene que **parsearlo de ahí** (§2.2).
`channelsByTicker` tampoco se journalea (se excluye del prompt a propósito,
`api/arena-run.js:563`) → se **recomputa** con `buildChannels`, que es puro.

## 1.3 Días completos vs ciegos vs parciales — el SQL del censo

No tengo acceso a Neon desde aquí, así que **no invento conteos**. Este bloque
se corre tal cual (psql o `node -e` con `DATABASE_URL`) y su salida se pega en
§1.4 de este mismo doc antes de escribir código.

```sql
-- (a) RANGO y volumen por agente
select agent_id,
       min(run_date) as desde, max(run_date) as hasta,
       count(*) as filas,
       count(distinct run_date) as dias
from arena_journal
where phase = 'decide'
group by agent_id order by agent_id;

-- (b) CENSO DE COMPLETITUD por fecha (solo el insignia; el buffet es
--     compartido por corrida, así que una fecha basta para clasificarla)
select run_date,
       status,
       (context is not null)                                  as tiene_context,
       (context -> 'scan' -> 'prompt' ? 'user')               as tiene_prompt_scan,
       (context ? 'fetch_errors')                             as tiene_fetch_errors,
       coalesce(jsonb_array_length(context -> 'unavailable'), 0) as endpoints_caidos,
       coalesce(array_length(akeys(hstore(context -> 'fetch_errors')), 1), 0) as n_fetch_errors,
       context -> 'scan' ->> 'screener_state'                 as screener_state,
       coalesce(jsonb_array_length(context -> 'scan' -> 'slate'), 0) as n_candidatos,
       length(context -> 'scan' -> 'prompt' ->> 'user')       as chars_prompt_scan
from arena_journal
where phase = 'decide' and agent_id = 'claude'
order by run_date;

-- (b') variante sin la extensión hstore, si no está instalada:
--   (select count(*) from jsonb_object_keys(context->'fetch_errors')) as n_fetch_errors

-- (c) RESUMEN de clasificación (lo que va a la tabla de §1.4)
select
  count(*) filter (where context -> 'scan' -> 'prompt' ? 'user')                   as completos,
  count(*) filter (where context is not null
                     and not (context -> 'scan' -> 'prompt' ? 'user'))             as parciales,
  count(*) filter (where context is null)                                          as ciegos
from arena_journal
where phase = 'decide' and agent_id = 'claude';

-- (d) DÍAS CON FALLA DE FUENTE (el buffet llegó incompleto ese día — se
--     snapshotea igual, marcado; NO se re-fetchea)
select run_date, context -> 'unavailable' as caidos, context -> 'fetch_errors' as errores
from arena_journal
where phase = 'decide' and agent_id = 'claude'
  and coalesce(jsonb_array_length(context -> 'unavailable'), 0) > 0
order by run_date;

-- (e) DISTRIBUCIÓN de status (cuáles NO producen snapshot utilizable)
select status, count(*), min(run_date), max(run_date)
from arena_journal
where phase = 'decide'
group by status order by count(*) desc;

-- (f) VERSIONES de plantilla presentes (¿cuántos reglamentos distintos hay
--     en la ventana? — decide si un replay puede cruzar el corte T1/T2)
select prompt_version, count(*), min(run_date), max(run_date)
from arena_journal
where phase = 'decide'
group by prompt_version order by min(run_date);
```

**Clasificación que usa el backfill:**

- **`full`** — `context.scan.prompt.user` existe y parsea → buffet completo.
- **`partial`** — `context` existe pero sin `scan.prompt.user` (aborts tempranos:
  `aborted_no_api_key` antes del SCAN, `risk_broad_cut`, filas de liga), o con
  `unavailable` no vacío → hay mercado del día, pero con huecos **declarados**.
- **`blind`** — `context is null`. Son los días anteriores al arreglo del
  post-mortem ciego. **Se quedan ciegos.** Se inserta una fila de snapshot con
  `buffet = null`, `snapshot_source = 'blind'` y `sha256 = null`, para que el
  rango de fechas del replay **no mienta por omisión**: si pides `--from` en zona
  ciega, el runner aborta nombrando los días que no puede reconstruir.

Statuses que **no** producen buffet utilizable (van a `partial`/`blind`):
`aborted_no_api_key` (si cayó antes del SCAN), `risk_broad_cut`, `risk_exit`,
`season_start`, `season_started`, `rules_changed`, `season_winner`. Los de
`agent_id = 'league'` se excluyen del censo por definición.

## 1.4 Resultados del censo

> **PENDIENTE — lo llena Lety** corriendo §1.3 contra Neon. Formato:
>
> | métrica | valor |
> |---|---|
> | rango de fechas (`decide`, `claude`) | `____ → ____` |
> | días totales | `__` |
> | `full` | `__` |
> | `partial` | `__` |
> | `blind` (pre-arreglo) | `__` |
> | días con ≥1 endpoint caído | `__` |
> | versiones de plantilla en la ventana | `____` |
>
> **Ningún número de esta tabla se escribe sin haber corrido el SQL.** El scope
> queda bloqueado en la decisión D4 (§11) hasta tenerla.

---

# 2. FASE 0 — La separación MERCADO vs PORTAFOLIO

Esta es la pregunta que decide el diseño entero: **qué guarda el snapshot y qué
genera cada replay**.

## 2.1 MERCADO DEL DÍA → va al snapshot

Todo lo que produce `gatherContext({baseUrl, now})` (`api/arena-run.js:430-518`)
**sin mirar la cuenta**:

| Campo | Fuente | Determinismo |
|---|---|---|
| `movers` | `/api/movers?universe=market` → `trimMovers` (filtra apalancados/inversos con `symbolTypes`) | Foto del día, irreproducible después |
| `earnings_this_week` | `/api/earnings?from=…&to=…` → `trimEarnings` | El calendario cambia poco, pero `when` (la etiqueta relativa) se computa contra `now` |
| `recently_reported` | mismo endpoint, ventana −5d → `trimEarnings` | Trae `eps_est`, `eps_actual`, `eps_surprise_pct`, `sessions_since_report` |
| `notable_insider_buys` | `/api/stock-tracker?cat=insider` → `trimInsiders` | Foto del día |
| `screener` `{value, momentum}` | `readScreenerRows()` de Neon → `computeScreens` | Precomputado por el cron `arena-screener` |
| `screener_state` | `screenerDataState(rows, {now, enabled})` | `fresh/vacía/apagada/rancia/caída` |
| `unavailable[]`, `fetch_errors{}` | diagnóstico por endpoint | **Se snapshotea**: un día con `movers` caído tiene que replayearse caído |
| `channelsByTicker` | `buildChannels(...)` — **puro**, sin I/O | Se recomputa en el replay; no hace falta guardarlo (se guarda igual, por costo cero y para auditar) |

**Todo esto es idéntico para los 7 agentes de la liga** — `runArenaLeague`
memoiza `getBuffet()` una vez por corrida. Por eso el snapshot es **una fila por
fecha**, no una por agente.

## 2.2 PORTAFOLIO → lo genera CADA replay, desde su propio libro

Nada de esto entra al snapshot. El replay lo construye con **su** estado:

| Pieza | Función real | En el replay |
|---|---|---|
| `portfolioSnapshot({account, positions, openOrders, meta})` | `api/arena-run.js:532` | `account`/`positions`/`openOrders` salen del libro **simulado** del run, no de Alpaca |
| `positions_meta` | `buildPositionMeta({positions, opens, seriesBySymbol, now})` | igual, con `opens` reconstruidos de `arena_replay_journal` |
| `previous` (plan anterior reinyectado) | query `order by created_at desc limit 1` | la fila `date−1` **del propio run**, no del journal real |
| `commitments` abiertos | `foldCommitments` sobre el journal | fold sobre `arena_replay_journal` del mismo `run_id` |
| `risk` / `riskContext` | `buildRiskExits` + `escalationFromRiskRows` | mismo módulo (`_lib/arena-exits.js`), sobre el equity simulado |
| `heldCloses` | serie diaria por holding | Yahoo truncado a la fecha (§2.3) — **los símbolos** dependen del libro |
| `peak` / high-water-mark | `max(account->>'equity')` del journal | `max(equity)` del `arena_replay_journal` del run |

> **Esta separación es la razón por la que Haiku-replay ≠ Haiku-real** aunque el
> mercado sea idéntico. Ver §8.2.

## 2.3 La zona gris: precios. Reconstruibles, y por qué eso NO viola la regla

La regla de la casa es *no inventar datos* y *no re-fetchear para rellenar*. Una
serie diaria de Yahoo **no es un relleno**: el cierre de AAPL del 3-sep es el
mismo número hoy que esa noche. Y el repo ya tiene el mecanismo exacto:

```js
completedSlice(series, now)   // api/_lib/sim.js:98
```

Corta la serie a las velas **cerradas** respecto de `now` (`includeToday` solo si
`now.getUTCHours() >= 22`). Pasándole un `now` sintético = **la fecha del snapshot
a las 22:40 UTC** devuelve la serie tal como existía esa noche. Es el mismo
código que usa el cron real, con otro reloj — el `jump-to-date` de la referencia,
sin stack nuevo.

- ✅ `last_close` y `limit_range` de **cualquier** ticker en **cualquier** fecha:
  exactamente reconstruibles, cero look-ahead, cero invención.
- ✅ Barra diaria (OHLC) de la sesión siguiente, para los fills: `extractYahooCandles`
  (`api/candles.js:63`) da `o/h/l/c/v`, que `fetchDailySeries` no expone (solo
  closes). El runner usa ese extractor directo contra Yahoo — **no** necesita
  llegar a `vercel.app`.
- ⚠️ Ojo con el `range`: `fetchDailySeries(symbol, '1y')` es relativo a **hoy**.
  Para replay de fechas viejas el runner pide `'2y'` y trunca. Se ajusta en el
  runner, **no** en `sim.js`.
- ❌ **Fundamentales, recommendations y titulares de Finnhub: NO reconstruibles.**
  `metric`/`profile2`/`recommendation` devuelven el valor de **hoy**, sin `as-of`.
  Re-fetchearlos para una fecha pasada **es exactamente el look-ahead que la
  regla prohíbe**. Ver §2.4.

## 2.4 El problema que decide el scope: el deep-dive es dependiente del modelo

El pipeline real es SCAN → deep-dive **de los ≤5 candidatos que el scout eligió**
→ DIVE. Por lo tanto `context.dive.finnhub` de un día solo cubre **los tickers que
Haiku eligió ese día**.

Un modelo distinto en el replay va a elegir tickers distintos — ése es el punto
del experimento — y para ésos **no hay deep-dive en el snapshot** y **no se puede
fabricar** (§2.3). Tres salidas, ninguna gratis:

| | Qué hace | Costo | Honestidad |
|---|---|---|---|
| **A. Restringir** | El replay solo permite candidatos ∩ deep-dive capturado. Lo demás se descarta con razón `no_snapshot_data`, journaleada | Cero | Honesta pero **sesga a todos los modelos hacia los picks de Haiku** — degrada el experimento a "dado el slate de Haiku, ¿quién decide mejor?" |
| **B. Ampliar hacia adelante** | El cron nuevo (snapshot-first) captura deep-dive de **todo el universo del buffet** (~60-120 tickers), no solo de 5 | ~4×N req a Finnhub/día (free tier: 60/min → burst de ~2 min, dentro del cap) | Honesta y completa — pero **solo para días futuros**. No arregla el histórico |
| **C. Híbrido** (mi recomendación) | Histórico = A, con el sesgo **documentado y medido** (`%` de acciones descartadas por `no_snapshot_data` en la tabla de salida). Futuro = B | El de B, desde el día que se encienda | Honesta en ambos tramos, y la métrica de descartes dice cuánto pesó el sesgo en cada run |

**Con A/C, el DIVE de un modelo que se sale del slate capturado no queda mudo:**
recibe `last_close` + `limit_range` (reconstruibles) y una nota explícita
`"deep_dive: null — no research was captured for this ticker on this date"`. El
modelo decide con menos contexto, **nunca con contexto inventado** — el mismo
principio que ya gobierna `unavailable` en el buffet real.

→ **Decisión D1 (§11).**

## 2.5 Qué más falta para reconstruir el prompt tal cual

Auditado contra `buildScanUserPrompt` / `buildDiveUserPrompt` / `validateActions`:

| Falta | Por qué importa | Cómo se resuelve |
|---|---|---|
| **SHA del código de la plantilla** | `prompt_version` (`arena-pm-v3-t2`) es una etiqueta gruesa: el texto de `buildDiveSystemPrompt` cambió varias veces **sin** bumpear la versión. Dos snapshots con el mismo `prompt_version` pueden venir de plantillas distintas | `arena_snapshot.prompt_template_version` = `PROMPT_VERSION` **+** `code_sha` (git SHA corto del deploy). El runner lo journalea también por run, y **avisa** si el SHA del replay ≠ el del snapshot |
| **Universo del screener de ese día** | `context` guarda las screens **computadas** (`value`/`momentum`) y `screener_state`, pero no cuántas filas tenía `arena_screener` ni de qué universo salieron. El prompt solo muestra lo computado → para el replay alcanza, pero no se puede auditar por qué un día trajo 2 nombres y otro 40 | Guardar en el snapshot `screener_meta = {state, rows_read, universe_size, computed_at}` hacia adelante. Para el backfill queda `state` y nada más — **marcado como incompleto**, no adivinado |
| **`symbolMap` / `symbolTypes` de Finnhub** | Los usa `trimMovers` (buffet) y `validateActions` (guard). **No se journalean.** Un replay valida el universo contra el symbol map de **hoy**: un ticker deslistado desde entonces se descartaría ahora y no entonces | Opción (i): snapshotear el subconjunto del map para los tickers del buffet (barato, N entradas). Opción (ii): usar el de hoy y documentar la divergencia. → **Decisión D3** |
| **Constantes efectivas del reglamento** | `ARENA_RULES.discretionary_sell_band` e `intraday_buy_band` son **env-overridables** (`ARENA_EXIT_BAND_DISCRETIONARY`, `ARENA_INTRADAY_BUY_BAND`); `ARENA_TEMPERATURE` también. Ninguna se journalea | El snapshot guarda `rules_effective = {...ARENA_RULES, temperature, max_tokens:{scan:500, dive:3000}, max_candidates:5, screener_floor:2}`. El replay usa **las del snapshot**, no las del `.env` del Mac |
| **El `now` exacto del prompt** | `when`, `sessionsAgo`, `relativeDayLabel` se computan contra `now`. `created_at` es el insert (minutos después) | Suficiente en la práctica: el snapshot guarda `captured_at = created_at` y el replay usa `fecha 22:40 UTC` como reloj sintético. La diferencia es de minutos y **no cruza un cierre** |
| **Órdenes abiertas heredadas** | El prompt real muestra `open_orders` de Alpaca | El replay las deriva de sus propios fills no ejecutados — no del journal real |

---

# 3. La tabla `arena_snapshot`

```sql
create table if not exists arena_snapshot (
  snapshot_date           date primary key,
  snapshot_version        int  not null default 1,
  prompt_template_version text,           -- PROMPT_VERSION del día
  code_sha                text,           -- git SHA corto (null en backfill)
  buffet                  jsonb,          -- SOLO mercado (§2.1); null si blind
  fetch_errors            jsonb,          -- {endpoint: "HTTP 401" | "timeout (12s)"}
  unavailable             jsonb,          -- ["movers", ...]
  screener_meta           jsonb,          -- {state, rows_read, universe_size, computed_at}
  rules_effective         jsonb,          -- ARENA_RULES + temperature + max_tokens…
  snapshot_source         text not null,  -- 'live' | 'backfill' | 'blind'
  completeness            text not null,  -- 'full' | 'partial' | 'blind'
  sha256                  text,           -- sha256 del jsonb canónico de `buffet`
  created_at              timestamptz not null default now()
);
create index if not exists arena_snapshot_date_idx on arena_snapshot (snapshot_date desc);
```

**`snapshot_version`** sube cuando cambia la **forma** del buffet (un canal nuevo,
un campo que se va). El replay compara la versión del snapshot contra la que su
código espera y **aborta** si no coinciden, en vez de leer un campo que ya no
significa lo mismo.

**`sha256`** se calcula sobre una serialización **canónica** (llaves ordenadas
recursivamente) — si no, `JSON.stringify` de dos objetos equivalentes da hashes
distintos y el "mismo snapshot" deja de ser verificable.

## 3.1 Backfill desde `arena_journal.context`

Script aparte, `scripts/backfill-arena-snapshot.mjs`, **idempotente**
(`on conflict (snapshot_date) do nothing`, salvo `--force`):

1. Lee `phase='decide'`, `agent_id='claude'`, ordenado por `run_date`.
2. Clasifica `full` / `partial` / `blind` (§1.3).
3. Para `full`: **parsea** el buffet del string `context.scan.prompt.user`. El
   prompt lo incrusta con `JSON.stringify(buffetForLlm)` en una línea propia
   (`api/arena-run.js:562-586`), entre el bloque `MARKET CONTEXT` y la línea
   final `Pick up to 5 tickers…`. El parser **verifica que las llaves esperadas
   estén** (`movers`, `earnings_this_week`, `recently_reported`,
   `notable_insider_buys`, `screener`, `screener_state`, `unavailable`); si
   falta alguna, la fila baja a `partial` con la razón — **no se completa a mano**.
4. Reinyecta `fetch_errors` desde `context.fetch_errors` (que **sí** está suelto,
   se excluye del prompt a propósito).
5. Recomputa `channelsByTicker` con `buildChannels` (puro) y lo guarda.
6. `snapshot_source='backfill'`, `code_sha=null` (no se puede saber a posteriori
   qué deploy corrió ese día — **null honesto**, no un SHA inventado).
7. Para `blind`: fila con `buffet=null`, `completeness='blind'`, `sha256=null`.

Modo `--dry-run` que imprime la clasificación por fecha sin escribir nada.

## 3.2 Hacia adelante: snapshot PRIMERO, el PM lee del snapshot

Una sola fuente. En `runArenaLeague`, antes del fan-out de agentes:

```
getBuffet()  →  writeSnapshot(date, buffet)  →  cada agente lee DEL SNAPSHOT
```

- Si la escritura del snapshot falla, la corrida **sigue** con el buffet en
  memoria y journalea `snapshot_write_failed`. El Arena real **no se cae** por la
  tabla nueva — el replay puede esperar un día, el libro no.
- El PM lee del snapshot → lo que ve el modelo en producción es **exactamente**
  lo que el replay le da después. Sin esa inversión, snapshot y prompt divergen
  en silencio.
- Es el **único** cambio a `api/arena-run.js` en toda la Fase 2, y es de
  fontanería: mismo objeto, otro origen.

---

# 4. Las tablas del replay

```sql
create table if not exists arena_replay_runs (
  id            text primary key,          -- replay:<modelo>:<from>:<to>:<hash8>
  model         text not null,
  provider      text not null,             -- 'anthropic' | 'openrouter'
  label         text,                      -- 'haiku-A', 'haiku-B'…
  date_from     date not null,
  date_to       date not null,
  capital       numeric not null,
  fill_rule     text not null,             -- 'next_session_daily_bar_v1'
  cost_est_usd  numeric,                   -- estimado ANTES de llamar
  cost_real_usd numeric,                   -- acumulado real
  snapshot_versions jsonb,                 -- versiones vistas en el rango
  code_sha      text,
  rules_effective jsonb,
  status        text not null,             -- running|done|aborted_cost_cap|aborted_blind_dates|error
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create table if not exists arena_replay_journal (
  run_id        text not null references arena_replay_runs(id) on delete cascade,
  run_date      date not null,
  phase         text not null,             -- 'scan' | 'dive'
  status        text not null,             -- mismos statuses que el real
  prompt        jsonb,                     -- {system, user} de la fase
  sha256        text,
  llm_response  text,                      -- COMPLETA, verbatim
  plan          text,
  actions       jsonb,                     -- aprobadas + descartadas CON motivo del guard
  fills         jsonb,                     -- simulados: {symbol, side, qty, price, costs, filled|cancelled}
  equity        numeric,
  cash          numeric,
  positions     jsonb,
  commitments   jsonb,
  context       jsonb,                     -- risk, positions_meta, floor, plumbing_fixes…
  tokens        jsonb,                     -- {input, output}
  cost_usd      numeric,
  created_at    timestamptz not null default now(),
  primary key (run_id, run_date, phase)
);
create index if not exists arena_replay_journal_run_idx on arena_replay_journal (run_id, run_date);
```

Ninguna de las dos tiene FK hacia `arena_journal` ni hacia `arena_state`. El
`on delete cascade` deja borrar un run entero sin residuo.

---

# 5. El runner

```bash
node scripts/replay-arena.mjs \
  --model claude-haiku-4-5-20251001 \
  --from 2026-08-04 --to 2026-09-12 \
  --capital 100000 \
  [--provider anthropic|openrouter] \
  [--label haiku-A] \
  [--cost-cap 8.00] \
  [--dry-run]            # estima costo y sale, sin llamar al LLM
  [--allow-partial]      # permite días `partial`; sin el flag, aborta nombrándolos
```

Bucle por fecha (solo sesiones de mercado presentes en `arena_snapshot`):

1. **Lee el snapshot** de la fecha. `blind` → aborta con la lista de días ciegos
   (nunca los salta en silencio). `partial` → aborta salvo `--allow-partial`.
2. **Estado del portafolio DEL REPLAY** — `account`/`positions`/`openOrders`
   derivados de `arena_replay_journal` del mismo `run_id`; día 1 = 100% cash.
3. **Memoria DEL REPLAY** — `previous` = la fila `dive` anterior del run;
   `commitments` = `foldCommitments` sobre el propio run; `positions_meta` =
   `buildPositionMeta` con series truncadas a la fecha.
4. **Red determinista** — `buildRiskExits` (`_lib/arena-exits.js`, sin tocar) con
   el `peak` del propio run. Si dispara `broadcut`, el run **se detiene** igual
   que el agente real, y se journalea. Sin esa simetría no se está replayeando el
   mismo experimento.
5. **SCAN** — `buildScanSystemPrompt()` + `buildScanUserPrompt({...})`, importados
   **del mismo `api/arena-run.js`**. Sin fork de plantilla: si la plantilla cambia,
   el replay cambia con ella (y el `code_sha` lo delata).
6. `callArenaLLM({agent: agenteAdHoc, ...})` → `parseScanResponse` →
   `applyScreenerFloor`.
7. **Deep-dive** del snapshot (§2.4) + `last_close`/`limit_range` reconstruidos.
8. **DIVE** — `buildDiveSystemPrompt(persona)` + `buildDiveUserPrompt({...})` →
   `callArenaLLM` → `parsePlanResponse`.
9. **Guard** — `validateActions({...})` tal cual. Aprobadas y descartadas **con su
   motivo** van al journal del replay.
10. **Fills simulados** (§6) contra la barra diaria de la sesión siguiente.
11. **Journal** en `arena_replay_journal`. Cero escrituras fuera de las tablas
    `arena_replay_*`.

## 5.1 El agente ad-hoc

`callArenaLLM` ya acepta cualquier `{id, provider, model, persona}`
(`api/_lib/arena-model.js:127`). El runner arma uno desde los flags:

```js
const agent = { id: label || model, provider, model, persona: 'Claude PM' };
```

**`persona` fija por default**, e igual a la del insignia. Es el mismo candado
que hace válido al control `Haiku-B` en la liga: si la persona varía entre
modelos, el delta ya no mide al modelo. `--persona` existe como override
explícito, y queda journaleado en el run.

---

# 6. Fills simulados

## 6.1 La regla

Barra diaria **de la sesión siguiente** (`extractYahooCandles`, §2.3):

| Lado | Llena si | Precio |
|---|---|---|
| compra límite | `low ≤ limit` | **el límite** |
| venta límite | `high ≥ limit` | **el límite** |
| cualquiera | no se cumple | **cancelada** (igual que la orden `day` real expira) |

Una sola sesión. La orden `day` del Arena real se cancela al cierre siguiente;
el replay hace lo mismo. Sin barra para ese símbolo/sesión → **cancelada**
(fail-closed, igual que el guard).

## 6.2 Costos — idénticos a `sim.js`

`ASSUMPTIONS` (`api/_lib/sim.js:42-43`), **importadas, no copiadas**:

- `slippage_per_side = 0.001` (0.10%), **siempre en contra**.
- `commission_per_side = 0.0005` (0.05%) sobre el nocional.

## 6.3 Por qué es OPTIMISTA vs Alpaca paper, y por cuánto

Hay que decirlo con nombre y apellido, porque es la limitación que más fácil se
olvida al leer la tabla de resultados:

1. **Llena al límite, no al precio de cruce.** Si el open abre debajo del límite
   de compra, Alpaca llena al **open** (mejor para el comprador); si el precio
   toca el límite intradía, llena **en** el límite. La regla de la barra llena
   siempre en el límite → **subestima** las mejoras y **no modela** el peor caso.
2. **`low ≤ limit` no implica ejecutable.** Que la barra haya tocado el precio no
   dice que hubiera tamaño en el libro a ese nivel, ni que la cola del límite se
   hubiera llenado. En nombres líquidos es casi cierto; en small-caps del screener,
   no. **Sesgo al alza en el fill rate.**
3. **Sin fills parciales.** Todo o nada; Alpaca paper sí parte.
4. **La barra diaria no distingue el orden intradía.** Un `low` alcanzado a las
   9:35 y un `high` a las 15:50 son la misma barra: una venta stop y una compra
   límite del mismo día pueden "llenarse" ambas en un orden imposible.
5. **Sin gaps adversos entre decisión y apertura** más allá de lo que trae la barra.

**Magnitud:** no se estima a ojo. El run de control **Haiku-replay vs Haiku-real**
en las mismas fechas (§8.2) mide el delta observado de fill rate y precio medio de
ejecución, y ese número —no una intuición— es el que se reporta. Hasta tenerlo,
la tabla de salida lleva la nota `fills simulados, optimistas vs Alpaca paper
(magnitud sin medir)`.

---

# 7. Look-ahead

## 7.1 El candado

Un dato con timestamp posterior a las **22:40 UTC de su fecha** es futuro
respecto de la decisión, y no puede estar en el snapshot.

**Test `tests/arena-replay-lookahead.test.mjs`** — falla si:

- cualquier fecha dentro de `snapshot.buffet` (recursivo: `date`, `filedAt`,
  `datetime`, `transactionDate`, `updated`, timestamps epoch de news) es **> la
  fecha del snapshot**, o **== la fecha** con hora **> 22:40 UTC**;
- una serie de precios usada por el replay contiene una vela con fecha **>** la
  del snapshot (verifica que `completedSlice` recibió el reloj sintético y no
  `new Date()`);
- la barra de fills es de una sesión **anterior o igual** a la del snapshot (la
  barra de fills **debe** ser posterior — es la única cosa del futuro que el
  replay puede usar, y solo para ejecutar, **jamás** para decidir);
- el prompt del DIVE contiene el string de una fecha posterior a la del snapshot.

## 7.2 Look-ahead que NO se puede cerrar, y que se declara

- **`symbolMap` de Finnhub** — el guard valida contra el universo de hoy (§2.5).
  Divergencia conocida. Depende de **D3**.
- **Conocimiento del modelo.** Un modelo entrenado después de la fecha del
  snapshot puede "saber" qué pasó. El guard anti-fechas de `ai-guard.js` atrapa
  la alucinación temporal, **no** esto. **Es la limitación más seria del replay
  para comparar modelos con cutoffs distintos** y se escribe en cada reporte, no
  en una nota al pie.
- **El `arena_screener` de Neon** es una tabla viva; el backfill lee las screens
  **ya computadas** del prompt, no las filas. Bien así: las filas de hoy no son
  las de entonces.

---

# 8. Controles obligatorios

Sin estos dos, ningún delta entre modelos significa nada.

## 8.1 Haiku-A vs Haiku-B — el piso de ruido

Mismo modelo, mismo prompt, misma persona, misma temperatura (0.7), mismos
snapshots, dos `run_id` distintos. **Mide el ruido del sampling.**

Regla de lectura: **una diferencia entre dos modelos menor que |A−B| no es una
diferencia** — es ruido. Va impresa arriba de la tabla comparativa, no escondida
en el doc. Con 0.7 y un JSON de decisión, espero que A y B diverjan pronto: basta
un ticker distinto el día 3 para que los libros no vuelvan a coincidir.

## 8.2 Haiku-replay vs Haiku-real — sanidad, no igualdad

Mismas fechas, mismo modelo, mismo prompt. **No van a coincidir, y está bien.**
Por qué, en orden de peso:

1. **El portafolio diverge desde el primer fill distinto.** El replay arranca
   100% cash; el real llegó a esa fecha con posiciones y con su historia. Prompt
   distinto desde el día 1 → decisión distinta → libro distinto. **La divergencia
   es exponencial, no un error.**
2. **Fills distintos** (§6.3): el real ejecutó en Alpaca paper, el replay simula.
3. **Temperatura 0.7**: aun con prompt idéntico la respuesta varía (es justo lo
   que mide §8.1).
4. **El deep-dive del snapshot es el que capturó el run real** — aquí a favor:
   si el replay elige los mismos candidatos, ve exactamente la misma research.

**Qué valida entonces:** que el plumbing sea correcto. Se compara el **día 1** del
replay contra el día 1 del real **con el mismo estado inicial forzado**
(`--seed-from-journal <fecha>`, que arranca el libro del replay con las
posiciones reales de esa fecha): ahí el prompt del SCAN debe salir **byte a byte
idéntico** salvo el reloj, y su `sha256` coincidir. Ése es el smoke real del
replay. Si el día 1 no reproduce, nada de lo demás vale.

---

# 9. Tests

| # | Test | Qué asegura |
|---|---|---|
| 9.1 | `arena-replay-determinism.test.mjs` | Con respuestas de LLM **mockeadas** (mismo patrón que `tests/arena-run.test.mjs`: fake a nivel `fetch`, branch por `system`), dos corridas sobre los mismos snapshots dan **el mismo** journal: mismos hashes de prompt, mismas órdenes, mismos fills, mismo equity final |
| 9.2 | `arena-replay-guard.test.mjs` | El replay llama **el mismo** `validateActions` importado de `_lib/arena-guard.js`: mismo set de acciones + mismo estado → mismas aprobadas/descartadas con **el mismo string de motivo** que el harness real. Y un lint que falla si `scripts/replay-arena.mjs` define cualquier función con nombre de export del guard (prohíbe el fork silencioso) |
| 9.3 | `arena-replay-no-writes.test.mjs` | Con `sql` mockeado, **ninguna** sentencia del replay toca `arena_journal`, `arena_state`, `arena_watch` ni `arena_screener` (esta última: solo `select`). Y ningún módulo del runner importa `_lib/alpaca.js` (chequeo estático del árbol de imports) |
| 9.4 | `arena-replay-lookahead.test.mjs` | §7.1 |
| 9.5 | `arena-replay-fills.test.mjs` | Casos borde del fill: `low == limit` (llena), `low > limit` (cancela), barra ausente (cancela), costos exactos contra `ASSUMPTIONS` importadas |
| 9.6 | `arena-replay-cost-cap.test.mjs` | La estimación aborta **antes** de la primera llamada al LLM si supera el cap; y aborta a mitad si el costo real lo rebasa, dejando el run en `aborted_cost_cap` con los días ya corridos íntegros |
| 9.7 | `arena-snapshot-backfill.test.mjs` | El parser del buffet: un prompt `full` reconstruye el objeto; uno al que le falta una llave cae a `partial`; `context is null` cae a `blind`. Idempotencia del backfill |
| 9.8 | lints existentes | `period-label-lint` y `no-hardcoded-dates` deben pasar sobre lo nuevo si alguna salida pinta un `%` o escribe una fecha. La tabla comparativa pinta retornos → **entra al lint del period-label** |

Todos con `node tests/<archivo>.test.mjs`, descubiertos por `tests/index.js`
(que barre `*.test.mjs`), sin dependencias nuevas.

---

# 10. Salida y cap de gasto

## 10.1 Tabla comparativa por run (CLI)

```
RUN                  RET     MDD    TRADES  DESC/GUARD  FILL%   COSTO
haiku-A              +2.1%  -3.4%      14      3 (18%)   71%    $1.42
haiku-B              +0.4%  -4.1%      17      5 (23%)   65%    $1.39
gpt-5-mini           -1.2%  -5.8%      22      7 (24%)   68%    $2.10
SPY (mismo rango)    +1.7%  -2.9%       —          —      —        —

  ruido medido (|A−B|): 1.7 pp de retorno, 0.7 pp de MDD
  → una diferencia menor a eso NO es una diferencia
  fills simulados, optimistas vs Alpaca paper (magnitud sin medir, §6.3)
  descartes por `no_snapshot_data`: haiku-A 1, gpt-5-mini 4   ← sesgo del slate (§2.4)
```

- **Retorno** = equity final / capital − 1. Etiqueta de periodo **obligatoria**
  (`period-label-lint`): la cabecera dice el rango y los días de mercado.
- **MDD** sobre la curva de equity diaria del run.
- **DESC/GUARD** = órdenes descartadas por el guard / órdenes propuestas.
- **FILL%** = llenadas / aprobadas.
- **SPY** en el mismo rango, misma serie truncada — el baseline que ya usa el
  resto del repo.
- **Nada en `/hoy` todavía.** Primero CLI + Neon. La vista sale cuando haya al
  menos un run de cada control y el número de ruido esté medido.

## 10.2 Cap de gasto

Antes de la primera llamada:

```
costo_est = días × (tokens_scan + tokens_dive) × precio_modelo
tokens_scan ≈ len(prompt_scan)/3.5 + 500        (max_tokens del SCAN)
tokens_dive ≈ len(prompt_dive)/3.5 + 3000       (max_tokens del DIVE)
```

Los prompts se construyen **de verdad** para 2-3 fechas de muestra del rango y se
extrapola — no se adivina la longitud. `--dry-run` imprime la estimación y sale.

Si `costo_est > cap` → **aborta antes de gastar un centavo**, nombrando la
estimación y el cap. Durante la corrida, el costo real se acumula por día y si
rebasa el cap el run se detiene en `aborted_cost_cap` **conservando los días ya
journaleados** (un run truncado y honesto vale más que uno perdido).

Precios por modelo en una tabla del runner, con la fecha de la última
actualización al lado. Modelo sin precio conocido → el cap **no puede evaluarse**
→ el runner exige `--cost-cap` explícito y avisa que la estimación es nula.
→ **Decisión D2** para el valor del cap.

## 10.3 Correcciones de plumbing por modelo

Legítimas y **journaleadas** en `context.plumbing_fixes` de la fila:

- JSON envuelto en ```` ```json ```` → se desenvuelve (`parsePlanResponse` ya lo
  hace; si un modelo trae una variante nueva, se agrega **ahí**, no en el runner).
- Respuesta con prosa antes/después del objeto → se extrae el primer objeto
  balanceado.
- `finish_reason: 'length'` → se journalea `truncated: true`, **no** se reintenta
  con más tokens (eso cambiaría el presupuesto entre modelos).

**Lo que NO es plumbing:** reintentar con un prompt distinto, aflojar el guard,
cambiar `max_tokens` por modelo, o "ayudar" al modelo a formatear con un
few-shot. Eso es cambiar la estrategia y **invalida la comparación**. Cada fix de
plumbing queda contado por modelo en la tabla de salida: un modelo que necesita
20 fixes y otro 0 **no son comparables sin decirlo**.

---

# 11. DECISIONES — lo que necesito de vos antes de codear

> Ninguna de éstas la puedo tomar yo: cambian qué mide el experimento.

**D1 — Deep-dive fuera del slate capturado (§2.4). La más importante.**
¿A (restringir), B (ampliar hacia adelante) o C (híbrido)? Mi recomendación es
**C**: histórico restringido con el sesgo **medido** en la tabla, y el cron nuevo
capturando el universo completo del buffet desde el día que lo enciendas. B solo
aplica a días futuros — el histórico no tiene arreglo.

**D2 — El cap de gasto.** ¿Cuántos USD por run? ¿Y el comportamiento por default
sin `--cost-cap`: abortar, o correr sin tope? Mi sugerencia: default **$5** y
`--cost-cap 0` para desactivarlo explícitamente.

**D3 — El symbol map del guard (§2.5).** ¿Snapshoteamos el subconjunto del symbol
map de los tickers del buffet (barato, cierra el hueco hacia adelante pero no en
el backfill), o usamos el de hoy y lo documentamos como divergencia conocida?

**D4 — Ventana del backfill.** Depende del censo (§1.4). Cuando tengas los
números: ¿desde qué fecha arranca el dataset, y los días `partial` entran por
default o solo con `--allow-partial`?

**D5 — T1 vs T2.** El reglamento cambió el **2026-09-13** y `PROMPT_VERSION` subió
a `arena-pm-v3-t2`. Un replay que cruce ese corte usa la plantilla de **hoy** para
fechas que se decidieron bajo T1. Tres opciones: (i) prohibir runs que crucen el
corte; (ii) permitirlos con una advertencia grande; (iii) versionar las
plantillas en código y que el replay use la del día. La (iii) es la correcta y la
más cara. Mi recomendación para empezar: **(i)**, y (iii) cuando duela.

**D6 — Estado inicial.** ¿El replay arranca siempre 100% cash con `--capital`, o
`--seed-from-journal` (arrancar con las posiciones reales de esa fecha) es parte
del alcance desde el día 1? Lo pido porque §8.2 —el control de sanidad— **lo
necesita** para valer.

**D7 — Modelos del primer barrido.** Además de Haiku-A/Haiku-B, ¿cuáles? El
registry ya tiene 7 con sus slugs de OpenRouter; el replay puede usar esos
mismos, o los que vos elijas.

**D8 — Dónde viven las tablas.** ¿La misma base de Neon (tablas separadas, como
está escrito aquí), o una base/schema aparte? Mismo DB es más simple y el
aislamiento ya está en el test 9.3; base aparte es un candado físico en vez de
uno por test.

---

# 12. Lo que NO entra

- Nada en `/hoy`, `app.html` ni `leaderboard.html`. CLI + Neon primero.
- Ningún cambio a `arena-guard.js`, `arena-exits.js`, `arena-memory.js`,
  `arena-model.js` ni `sim.js` — se **importan**.
- El único cambio a `api/arena-run.js` es la inversión snapshot-first (§3.2).
- No se re-fetchea **nada** para rellenar un snapshot pasado.
- No se toca ninguna cuenta de Alpaca, ni paper.
- Sin dependencias npm nuevas (el repo no tiene `package.json` y así se queda).
- El adapter de OpenRouter **ya existe** (`api/_lib/arena-model.js`): el replay lo
  reusa con un agente ad-hoc (§5.1). No se escribe uno nuevo.
