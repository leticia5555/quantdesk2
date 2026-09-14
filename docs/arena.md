# ARENA — Agente #6 "Claude PM"

> **Liga multi-modelo (2026-08-03):** este doc describe el harness de UN agente.
> La generalización a N modelos (Claude/OpenAI/Grok/Gemini/DeepSeek/Qwen +
> control) vive en `docs/arena-liga-scope.md` — el harness de aquí no cambia,
> se corre por-agente con `agent_id`. La cuenta y el historial del Agente #6 se
> preservan como el agente insignia `claude`.

Fecha: 2026-07-22. Independiente de la migración de la flota (el doc de Fase 1,
`docs/alpaca-paper-scope.md`, queda como está): el Arena usa la cuenta paper
existente (PA3VOJ7VTZHW) como su libro EXCLUSIVO — la flota validada sigue en
el simulador (`agents-run` + `sim.js`), sin colisión y sin pregunta de
multi-cuentas todavía.

**Qué es:** un LLM portfolio manager estilo Rallies/nof1 con la etiqueta
honesta de la casa: experimento sin validación estadística, paper trading,
no es asesoría. El razonamiento de cada decisión se publica verbatim junto
al trade (tabla `arena_journal`, card en el tab MIS AGENTES).

> **TEMPORADA 2 — vigente desde 2026-09-13.** El reglamento de abajo
> (§ *Reglamento de la Temporada 2*) aplica **igual a los siete agentes** de la
> liga y se ANUNCIA en el journal con fecha (fila `status='rules_changed'`,
> `agent_id='league'`, idempotente). `PROMPT_VERSION` sube a `arena-pm-v3-t2`:
> las métricas de T1 y T2 **no son comparables** y el corte queda explícito para
> el post-mortem.

## Reglamento de la Temporada 2 (2026-09-13)

Sale de lo que la T1 dejó ver en vivo. **El objetivo declarado es que el agente
venda cuando debe y recuerde lo que prometió — NO que opere más seguido.**
Ninguna de las nueve reglas premia la frecuencia; dos la limitan explícitamente.

| # | Regla | Dónde vive |
|---|---|---|
| 1 | **Memoria de compromisos** con fecha: lo que el PM promete vuelve en la corrida siguiente con obligación de pronunciarse | `_lib/arena-memory.js` (fold del journal) + prompt del DIVE |
| 2 | **Recién-reportados** permanecen 2 sesiones en el buffet, con la cifra real y la sorpresa ya calculada | `trimEarnings` / `gatherContext` (`arena-run.js`) |
| 3 | **Trailing stop**: pico ≥ +15% desde la entrada ARMA un trailing del 8% | `_lib/arena-exits.js` (`planTrailingStops`) |
| 4 | **Time stop a 45 días** → pronunciamiento obligado (NO vende) | `_lib/arena-exits.js` (`timeStopState`) + auditoría en `arena-memory` |
| 5 | **Salidas a marketable limit**, no límite pasivo | `_lib/arena-guard.js` (`validateActions`) |
| 6 | **Flag de ratios outlier** "posible artefacto contable" | `_lib/finnhub-dive.js` (`flagRatioOutliers`) |
| 7 | **Corrida matutina por evento** post-earnings | `runArenaMorning` + cron `?phase=morning` |
| 8 | **NO breaker SMA200** (NO-GO del dualmom) | decisión: ausencia protegida por lint (`tests/arena-t2.test.mjs`) |
| 9 | **Pronunciamiento obligatorio por posición** cada corrida | prompt del DIVE + `auditPositionReview` |

### 1. Memoria de compromisos (el fix de la amnesia NVDA/CRM)

**El síntoma:** el PM escribía *"reservo efectivo para la dislocación
post-earnings de NVDA"* y a los dos días ni NVDA ni CRM volvían a aparecer en su
prosa. La promesa moría con la corrida que la escribió; nadie —ni él, ni el
post-mortem— podía decir si la cumplió.

El DIVE ahora emite `commitments: [{symbol, text, due}]`. Se journalean con id
determinista (`YYYY-MM-DD:<tag>#<n>`, donde el tag distingue la corrida de
decide de la matutina) y la corrida siguiente se los devuelve **abiertos, con su
edad y si están vencidos**, exigiendo un `commitment_updates` por cada id:
`cumplido` / `vigente` / `cancelado`. Un `vigente` es respuesta válida —pero hay
que decir qué se está esperando—; el silencio queda contado como incumplimiento
(`context.commitments.audit`).

**Sin tabla nueva:** el estado abierto se DERIVA del journal con un fold
(`foldCommitments`), el mismo criterio con el que el pico de equity del breaker
sale de `max(account.equity)`. Un compromiso sin resolver a los 30 días caduca
(marcado `caducado`, no borrado): el prompt no se llena de ruido viejo.

### 2. Recién-reportados: 2 sesiones más en el buffet

La T1 solo miraba hacia adelante (`/api/earnings?from=hoy`): **el día que NVDA
reportaba, NVDA salía del buffet.** El PM había escrito "espero el reporte para
decidir", el reporte llegaba, y el nombre ya no estaba en su contexto.

Ahora la ventana del calendario se abre 5 días hacia atrás y `trimEarnings`
devuelve DOS listas con **slots propios** — `earnings_this_week` (12) y
`recently_reported` (8) —, para que una semana cargada no vuelva a expulsar a
los reportados. Cada reportado viaja con `sessions_since_report`, el EPS real y
la **sorpresa vs. estimado ya calculada** (la casa no delega aritmética al
modelo). `sessionsAgo` cuenta sesiones L-V y **no descuenta festivos** a
propósito: errar por ese lado mantiene un nombre un día MÁS en el buffet, que es
la dirección segura para una regla cuyo propósito es no olvidar.

### 3. Trailing stop — y por qué NO contradice a Kaminski & Lo

La regla de salida de la T1 nace del hallazgo de que un stop **apretado** sobre
una posición que revierte a la media destruye valor (MU: −13.1% y al día
siguiente +3.9%). El trailing de la T2 es el caso **opuesto**: protege ganancia,
no corta pérdida.

- **Arma** solo cuando el pico desde la entrada llegó a **+15%**.
- Armado, un cierre **8% por debajo de ese pico** liquida la posición entera con
  marketable limit en la apertura siguiente.
- **Por construcción nunca vende en pérdida:** `entrada × 1.15 × 0.92 = entrada ×
  1.058`. El piso del trailing está SIEMPRE arriba de la entrada.

El caso que arregla es el que la T1 estaba perdiendo: una ganadora que sube 25%,
vuelve a plano, y nadie decide nada. El **pico** se deriva de la serie diaria
acotada por la fecha de apertura, y la fecha de apertura se reconstruye de los
**fills del propio journal** (`reconstructPositionOpens`) — sin tabla nueva, y
auto-reparable. Si no se puede reconstruir, **el trailing NO arma**: fail-safe
explícito, una regla nueva no liquida sobre un dato que no existe.

### 4. Time stop a 45 días — obliga a hablar, no a vender

A los 45 días calendario una tesis que no se movió es una tesis muerta o una que
el PM ya no recuerda. La regla **no genera ninguna orden**: marca la posición
`time_stop.due` en el contexto y exige un hold/trim/exit con razón. Lo que se
mide es el incumplimiento: `position_review_audit.time_stop_missing` cuenta las
posiciones VENCIDAS que ni así fueron nombradas.

### 5. Salidas a marketable limit (cicatriz GOOGL)

GOOGL: el PM decidió vender, puso un límite "justo" dentro de la banda ±2%, la
orden `day` se quedó descansando arriba del mercado y **expiró sin llenar**. Al
día siguiente la posición seguía ahí y el plan la narraba como *"pending order,
monitor"*. **Una venta que no llena no es una venta.**

La banda ±2% sigue siendo el sanity check del **anclaje de precio** del modelo
(fuera de banda → descartada, como siempre), pero el precio que se ENVÍA es
`cierre × (1 − ARENA_EXIT_BAND_DISCRETIONARY)` (4% por default), por debajo del
mercado. **No es un ajuste silencioso** de los que la casa prohíbe: es política
declarada de la capa de salida, journaleada por orden (`limit_price_proposed`,
`repriced`, `exit_band`). La **compra no se toca**: un límite agresivo de compra
paga de más, y ahí el precio del modelo sí es la decisión.

### 6. Ratios outlier — "posible artefacto contable" (caso LYFT)

Un P/E de 900, un ROE de 4,000% o un **debt/equity negativo** (equity contable
negativo) no describen el negocio: son un renglón de una sola vez. El PM los
citaba como fundamentales limpios. `flagRatioOutliers` compara contra límites de
**plausibilidad** (no de calidad: un P/E de 60 es caro pero real) y cuelga
`fundamentals_quality` al lado del número — **que sigue viajando tal cual**,
porque borrarlo sería inventar un hueco. El prompt le dice qué hacer: o lo omite,
o dice que puede ser un artefacto. Un dato ausente NO se marca: `null ≠ outlier`.

### 7. Corrida matutina por evento post-earnings

Cron aparte (`?phase=morning`, 14:50 UTC L-V, 10 min después del reconcile).
**No es una segunda corrida diaria:** solo gasta LLM si una posición del libro de
algún agente acaba de reportar. Qué cuenta como evento, medido contra el decide
de las 22:40 de anoche:

- **hoy BMO** → ningún decide lo vio. Entra.
- **sesión anterior AMC/TBD** → el decide de anoche vio el número, pero el precio
  recién reacciona en el open de hoy. Entra.
- **ayer BMO** → ya repreció ayer y el decide de anoche cerró con ese precio
  adentro. **No entra.**

En esa corrida: **se salta el SCOUT** (el evento ya define el slate), **no se
re-evalúa la red determinista** (trailing y stop catastrófico deciden con cierres
COMPLETOS; a media mañana no hay uno nuevo y repetirlos duplicaría las órdenes de
anoche) y **las compras se suprimen** — existe para decidir sobre lo que ya se
tiene. Sin evento: una fila marcadora de liga
(`skipped_no_post_earnings_event`) y cero tokens.

### 8. NO hay breaker SMA200

Descartado **explícitamente**: el backtest dual-momentum cerró el gate de
tendencia en NO-GO (`docs/dualmom-backtest-scope.md`), así que no entra al Arena
por la puerta de atrás. Es una decisión, no un olvido — por eso hay un lint
(`tests/arena-t2.test.mjs`) que falla si alguien introduce una regla de salida
por SMA200 en el guard, los exits, la memoria o el runner sin volver a decidirlo.

### 9. Pronunciamiento obligatorio por posición

Cada corrida, `positions_review: [{symbol, stance, reason}]` con **una entrada
por posición** — `hold` / `trim` / `exit` — y una razón que cite los números
dados. Para que pueda hacerlo, cada holding llega al prompt con su historia YA
CALCULADA: `days_in_position`, `peak_since_entry`, `from_peak_pct`,
`trailing_stop` (armado y su nivel) y `time_stop`.

**La auditoría mide, no censura** (mismo patrón que `_lib/prose-audit.js`): una
posición no mencionada NO aborta el run ni frena una orden — queda contada en
`context.position_review_audit`, comparable entre los siete agentes de la liga,
que es justo lo que el experimento quiere medir. Lo que sí fuerza una venta es el
trailing determinista; la memoria le pone al PM la obligación de **hablar**, no
de obedecer.

Por la misma razón, los tres campos nuevos (`positions_review`, `commitments`,
`commitment_updates`) son **tolerados, no contrato duro**: ausentes o
malformados no abortan el run. La regla de "JSON malformado = cero órdenes"
sigue cubriendo `plan` y `actions`; endurecerla con tres campos más solo subiría
la tasa de aborts.

### `aborted_malformed_json`: ahora dice POR QUÉ

Ese status tenía dos causas muy distintas —el modelo parloteó fuera del JSON, o
**se quedó sin tokens a mitad del objeto**— y el journal no las distinguía. Ahora
la fila guarda `context.dive.stop_reason`, `response_chars` y `truncated`, y el
`error` lo dice en prosa. Además el cupo del DIVE sube de **1500 → 3000 tokens**:
con el contrato de la T2 (pronunciamiento por posición + uno por compromiso), una
respuesta de 8 holdings ya no cabía en 1500 — y una respuesta cortada es JSON
inválido, o sea una corrida entera perdida. `stop_reason` se normaliza también
para OpenRouter (`finish_reason: 'length'` → `max_tokens`), así el diagnóstico
existe para los siete agentes y no solo para los de Anthropic.

## Piezas

| Pieza | Archivo |
|---|---|
| Cliente Alpaca (limit-only hardcodeado, creds override para smoke) | `api/_lib/alpaca.js` |
| Smoke + health · **smoke de VENTA** (cuenta paper aparte) | `api/alpaca.js` (`GET ?smoke=1` · `?smoke=sell`) |
| Estado del agente (HALT del breaker −20%, resume manual) | tabla `arena_state` (`api/_lib/db.js`) |
| Risk guard determinista (post-LLM, fail closed) + FLOOR del screener + **venta marketable (T2 #5)** | `api/_lib/arena-guard.js` |
| **Regla de salida** determinista (circuit breaker + stop catastrófico + **trailing stop T2 #3**) | `api/_lib/arena-exits.js` |
| **MEMORIA (T2)** — compromisos con fecha, historia de la posición, auditoría del pronunciamiento | `api/_lib/arena-memory.js` |
| Deep dive Finnhub por candidato (fundamentales/recommendation/news) | `api/_lib/finnhub-dive.js` |
| Cron decide (22:40 UTC L-V) + reconcile (14:40 UTC L-V) + **matutina por evento (14:50 UTC L-V, T2 #7)** | `api/arena-run.js` + `vercel.json` |
| **Canal SCREENER** — screens deterministas (value/momentum) | `api/_lib/screens.js` |
| **Canal SCREENER** — capa de datos Neon (tabla + ledger) | `api/_lib/screener-db.js` |
| **Canal SCREENER** — universo (~150 nombres, extraído de app.html) | `api/_lib/screener-universe.js` |
| **Canal SCREENER** — cron de precompute (cada 4h) | `api/arena-screener.js` + `.github/workflows/external-crons.yml` (GitHub Actions, **no vercel.json** — ver `docs/crons.md`) |
| Datos para la UI | `api/arena.js` |
| **Auditoría del run** (solo lectura, JSON/markdown + `?view=resumen`) | `api/arena-audit.js` + `api/_lib/arena-audit.js` |
| Journal | tabla `arena_journal` (`api/_lib/db.js`) |
| UI (sección en MIS AGENTES) | `app.html` (`qdArenaLoad`/`qdArenaHtml`) |
| Tests | `tests/arena-guard.test.mjs` · `tests/arena-exits.test.mjs` · `tests/alpaca.test.mjs` · `tests/arena-run.test.mjs` · `tests/screens.test.mjs` · `tests/arena-audit.test.mjs` · **T2:** `tests/arena-memory.test.mjs` · `tests/arena-t2.test.mjs` · `tests/arena-morning.test.mjs` |

## Flujo de dos fases (SCAN → DEEP DIVE)

El tick `?phase=decide` corre en **dos llamadas al LLM**, ambas con el MISMO
modelo (`ANTHROPIC_MODEL`, Haiku por defecto) para no contaminar la línea base
del agente #6 (la liga Haiku vs Sonnet vs Opus necesita harness idéntico):

1. **Contexto** — cuenta/posiciones/órdenes de Alpaca + el buffet
   (movers market, earnings de la semana, insider buys, **canal screener**) +
   el plan anterior reinyectado (estilo nof1).
2. **SCAN** (LLM #1, el SCOUT) — sobre el buffet, nombra hasta `MAX_CANDIDATES`
   (5) tickers a investigar. No decide órdenes, solo triage. Lista vacía es
   válida. Malformado → `aborted_scan_malformed_json`, cero órdenes.
3. **FLOOR del screener** (determinista) — reserva slots para el canal screener
   (ver abajo) → **slate final** con `origin` por candidato.
4. **DEEP DIVE** (determinista, `_lib/finnhub-dive.js`) — por cada candidato del
   slate trae de Finnhub (free tier, best-effort) fundamentales (P/E, market cap,
   márgenes, deuda), analyst recommendations y titulares recientes (top-5, 7 días).
   Price targets son Premium → **no se traen**; el rating sale del reparto
   buy/hold/sell de las recommendations.
5. **DIVE** (LLM #2, el PM) — con esos datos + el último cierre por candidato
   decide → JSON `{plan, actions[]}`. Malformado → `aborted_malformed_json`,
   cero órdenes.
6. **Risk guard** (`_lib/arena-guard.js`) — descarta las órdenes que violan las
   reglas, no las ajusta. Ver abajo.

**Estados "ok sin órdenes"** (se distinguen a propósito):
- `ok_no_candidates` — ni el scout ni el screener produjeron candidatos → no se
  gasta el DIVE ni se pega a Finnhub.
- `ok_no_actions` — hubo candidatos y deep dive, pero el DIVE decidió holdear.

**Filas OPERATIVAS** (no son decisiones del PM: `model` null, cero órdenes; van
con `phase='decide'` para que el leaderboard las publique, pero quedan FUERA del
plan anterior que se le reinyecta al PM):
- `resumed` — reactivación manual tras un halt del breaker.
- `season_start` — arranque de temporada de la liga, una fila por agente.
  Se dispara a mano con `GET /api/arena-run?action=announce` (CRON_SECRET) y es
  idempotente: repetir el curl no duplica el rastro.

## Canal SCREENER (value + momentum, precomputado en Neon)

Un canal del buffet **estado-driven, no del LLM**: surface empresas sólidas a
buen precio aunque no hayan hecho noticia hoy. El screen es **determinista**
(`_lib/screens.js`); el LLM solo recibe los candidatos ya calificados con sus
números.

**Arquitectura (por qué precomputar):** el arena-run corre en una lambda de 60s
y NO alcanza para pegarle a Finnhub/Yahoo por ~150 símbolos en cada corrida. Un
cron aparte (`api/arena-screener.js`, cada 4h) llena la tabla `arena_screener`
en Neon con fundamentales (Finnhub `stock/metric`) + precio/MA50/MA200 (Yahoo),
drenando por antigüedad (ledger reanudable, mismo patrón que `pead-harvest`).
**El arena-run SOLO LEE esa tabla** (`readScreenerRows`) y computa las screens en
código → cero llamadas extra en la corrida. Gate: `ARENA_SCREENER_ENABLED=1`.

**Las dos screens** (top-5 cada una, `computeScreens`):
- **VALUE** — `P/E ∈ (0,20)`, `ROE > 15%`, `deuda/equity < 1.0`; rankeado por
  `ROE/PE`. Qualifiers: `pe_ttm`, `roe_ttm`, `debt_to_equity`.
- **MOMENTUM** — `cierre > MA50 > MA200`, sin blowoffs (`≤30%` sobre MA50);
  rankeado por `% sobre MA50`. Qualifiers: `above_ma50_pct`, `above_ma200`.

**CANDADO de precio:** el precio del screener tiene 1-2 días de lag. Ese precio
**NUNCA** llega a `limit_price`. Los qualifiers son **solo ratios/%** (jamás un
precio absoluto — hay tests que lo aseguran), y el `last_close` que ve el PM en
el DIVE + la banda ±2% que valida el guard salen SIEMPRE de `lastCompletedclose`
(Yahoo, fresco), no del screener.

### FLOOR del screener (`applyScreenerFloor`, time-boxed del trial)

`SCREENER_FLOOR = 2` (constante en `arena-run.js`, **documentada como time-boxed
~30 días**; con datos baja a 0 → free-choice puro). Reserva hasta 2 de los 5
slots de candidatos para el screener **solo cuando alguna screen realmente
dispara** — nada de rellenar con basura. Razón: sin floor, un scout sesgado a lo
noticioso podría no elegir screener en semanas → mediríamos su sesgo, no la
calidad del canal. `floor.reason` se journalea SIEMPRE y distingue los casos:
- `no_qualifying_candidates` — HABÍA datos frescos pero ninguna screen disparó.
- `screener_disabled` — la tabla `arena_screener` está vacía **y** el cron del
  screener está apagado (`ARENA_SCREENER_ENABLED` ≠ `1`). El canal nunca corrió.
- `screener_empty` — tabla vacía con el cron **prendido** (aún no llenó).
- `screener_stale` — hay filas pero rancias (la más fresca supera ~24 h: el cron
  dejó de refrescar y la tabla quedó congelada).
- `screener_unavailable` — la lectura de la tabla falló (DB caída).
- `scout_met_floor` — el scout ya tenía ≥floor picks de screener.
- `screener_already_picked` — los picks del screener ya estaban en el scan.
- `floor_applied` — se reservaron slots.

Los cuatro `screener_*` (disabled/empty/stale/unavailable) **no** significan
"ninguna acción calificó" — significan "el canal no tenía datos que evaluar".
Antes se colapsaban en `no_qualifying_candidates`: un `ARENA_SCREENER_ENABLED`
faltante en Vercel dejaba la tabla vacía y el post-mortem lo leía como "el PM
descartó todo", cuando la verdad era "el screener nunca corrió". El estado sale
de `screenerDataState(rows)` (`_lib/screens.js`) y también viaja aparte en
`context.scan.screener_state`.

### Atribución de canal (`origin` + `channels`)

Cada candidato y cada acción journalea de qué canal salió, para el post-mortem a
30 días (GROUP BY channel → qué canal produjo decisiones y cuál fue ruido):
- `channels` — `movers`/`earnings`/`insider`/`screener`/`portfolio` (índice
  determinista de qué fuente contenía el ticker; no confía en el LLM). El scout
  también nombra candidatos del LIBRO (holdings a recortar/salir, u órdenes
  abiertas a re-anclar); esos no están en el buffet y se marcan `portfolio`
  (`addPortfolioChannels`). Un array vacío `[]` significa entonces "pick sin
  anclar" (ni buffet ni libro) — señal legítima, no un canal perdido. Antes del
  fix del 2026-07-27, los candidatos del libro salían con `[]` y el post-mortem
  los perdía.
- `origin` — `scout_picked` (lo eligió el scout, incl. screener orgánico) vs
  `floor_reserved` (lo forzó el floor). Separa "el PM eligió el canal" de "se lo
  reservamos".
- `screens` + `screener_qualifiers` — si vino del screener, qué screen y con qué
  números.

El índice de atribución (`channelsByTicker`) **NO viaja al prompt del SCAN** (el
scout ve el buffet, no de dónde salió cada nombre): se journalea, y en el DIVE
se usa para adjuntarle a cada candidato su procedencia (`channel`, `screen`,
`screener_qualifiers`, `earnings`).

### Fechas de earnings con días relativos (`when`)

Cada entrada de `earnings_this_week` viaja con **la distancia a hoy ya
calculada**: `when: "in 2 days (Wed Aug 26, AMC)"` junto a la fecha absoluta
(`date`, `time`). Lo produce `relativeDayLabel()` (`_lib/ai-guard.js`, el mismo
archivo que ancla la fecha de hoy en el system prompt), en UTC — el mismo huso
con el que `dateDirective()` define "hoy", así que ambos lados dicen lo mismo.

**El bug (ago 2026):** los earnings llegaban como fecha absoluta pelada y el PM
hacía la aritmética de calendario de memoria. El 24-ago escribió *"NVDA earnings
post-market today (8/26 AMC)"* — el paréntesis correcto, la palabra "today"
mal — en el MISMO párrafo donde fechaba bien las noticias, que sí traen
antigüedad e instrucción de recencia. Y la conclusión del plan (reservar 28% de
cash para dislocaciones post-earnings) quedaba anclada al día equivocado. La
aritmética de fechas **no se delega al modelo**: sale resuelta del contexto.

El label cruza a la fase 2 pegado al canal: un candidato del canal earnings
llega al prompt del DIVE con `earnings: {date, time, when}` — antes el PM sabía
que el ticker venía de earnings pero **no qué día**, y rellenaba el hueco. Un
candidato sin ese campo no tiene fecha de reporte en sus datos, y el prompt le
prohíbe explícitamente inventar una.

**VC fuera del buffet:** las VC headlines salieron del contexto del PM (son
empresas privadas que no puede comprar; el espacio le sirve más al screener). El
endpoint `/api/vc-feed` sigue vivo para el resto de la app.

## Reglas del PM (deterministas, fuera del LLM)

Universo equities US (sin warrants/units, sin sub-$1, **sin ETFs
apalancados/inversos**, long-only) · máx 8 posiciones · máx 15% del equity por
posición · mín 10% de cash · SOLO órdenes límite (day, fill al open siguiente)
· limit_price a ±2% del último cierre. Violación → orden descartada y
journaleada con razón, jamás ajustada en silencio. JSON malformado → run
abortado honesto, cero órdenes.

**ETFs apalancados/inversos** (`LEVERAGED_INVERSE_ETFS` / `isLeveragedInverseETF`
en `_lib/arena-guard.js`) se excluyen con doble barrera: (1) filtro del buffet
por ticker (`trimMovers`, best-effort — el feed de AV no trae nombres) y (2)
el guard, que además de la lista aplica una heurística por **nombre** del symbol
map (multiplicador `2X/3X`, `Ultra`, `Leveraged`, `Inverse`) — esta atrapa los
leveraged nuevos que aún no están en la lista. El guard es la barrera real: la
lista sola no es exhaustiva (salen leveraged cada mes) y el resto de las reglas
no los frena (están en el symbol map US, >$1, sin sufijo de warrant).

**Universo por tipo de instrumento** (`EXCLUDED_SECURITY_TYPES` + `NON_EQUITY_TYPES`
en el guard): solo **equity común, ADR y REIT**. El `type` sale del symbol map de
Finnhub (`getSymbolTypes`, mismo fetch/cache que el name map) — cobertura **97.6%**
confirmada en prod. Se excluyen:
- **Fondos** (`EXCLUDED_SECURITY_TYPES`): `ETP` (ETFs/ETNs, incluye índices tipo
  SPY/QQQ), `Closed-End Fund` y `Open-End Fund`.
- **No-equity** (`NON_EQUITY_TYPES`): `Unit`, `Equity WRT` (warrant), `Right`,
  `Preference` — señal autoritativa que refuerza el filtro por sufijo del ticker
  (`WARRANT_LIKE`, que queda como respaldo para símbolos sin `type`) — más
  `PUBLIC` (ver abajo).

Los **ADR se mantienen** a propósito (NU/MELI/ITUB son ADRs LATAM, el corazón de
la audiencia). Es regla de **producto, no de seguridad**: con `type`
vacío/desconocido se **permite** y se journalea (`security_type` en la orden
aprobada; null = el free tier no lo trajo) — lo peligroso ya lo cubre la doble
barrera de leveraged. El tipo **`PUBLIC`** (catch-all de Finnhub, 3ª categoría
por tamaño) se **excluye**: las muestras en prod fueron puras preferentes y baby
bonds (no-equity), así que entró a `NON_EQUITY_TYPES`. Diag de cobertura +
muestras por tipo en prod: `GET /api/earnings?diag=symboltypes` (total, % poblado,
distribución, `samples` por tipo —default 30, configurable con `&sample=N`—,
`would_exclude`).

## REGLA DE SALIDA (determinista, fuera del LLM) — `_lib/arena-exits.js`

**Hallazgo que define el diseño:** un stop APRETADO por posición (p.ej. 10%) es
la PEOR opción para este libro. Kaminski & Lo (*Journal of Financial Markets*,
2014) muestran que los stops solo agregan valor cuando los retornos tienen
momentum; en posiciones que revierten a la media DESTRUYEN valor — sacan justo
cuando la ventaja es mayor. Caso en vivo: MU tocó −13.1% y al día siguiente
estaba en +3.9%; un stop del 10% habría vendido en el fondo. Así que el libro
**NO usa stops apretados**. Usa tres capas, todas DETERMINISTAS (no del LLM,
porque el LLM no es confiable para disparar una venta mecánica bajo estrés):

1. **CIRCUIT BREAKER de portafolio** (escalonado, desde el PICO de equity):
   - a **−15%** del pico → `delever`: recorta una fracción
     (`ARENA_BREAKER_DELEVER_TRIM`, ~33%) **PRO-RATA de CADA posición** — la misma
     fracción de todas. **NO vende "los perdedores"**: seleccionar los mayores
     P&L negativos es una apuesta direccional que la evidencia (Kaminski & Lo)
     dice que sale mal en un libro de reversión, y que MU refutó en vivo (−13% →
     +19% al día siguiente). El objetivo del delever es BAJAR EXPOSICIÓN, no
     adivinar cuál rebota: menos de todo, sin apostar a nada. Además **suprime
     las compras del PM** esa corrida (está subiendo efectivo).
   - a **−20%** del pico → `broadcut`: liquida TODAS las posiciones, **se salta
     el LLM** y **DETIENE al agente** (ver *Halt* abajo). Análogo del `DEATH -20%`
     de la flota, mejor soportado para un libro de 8 posiciones que los stops por
     nombre.
   - El **pico** (high-water-mark) se deriva del journal (`max(account.equity)`),
     sin schema nuevo — el `equity_peak` de la DB es de la FLOTA del simulador,
     otra tabla. En el primer run el pico = equity → drawdown 0. Tras un `resume`
     el pico se **re-basa** (se mide desde `resumed_at`, ver *Halt*).

2. **STOP CATASTRÓFICO ANCHO por posición** (~`ARENA_CATASTROPHIC_STOP_PCT`, 22%,
   FIJO desde la entrada). Regla de ejecución (sistemas de fin de día): CIERRE
   completo por DEBAJO del nivel `entrada×(1−pct)` → vender la posición ENTERA en
   la apertura siguiente (el gap es costo inevitable). Existe para que un desastre
   de un solo nombre no destruya el libro, **NO para gestionar caídas normales**.
   El `close` que evalúa es el último cierre COMPLETO (misma fuente que valida el
   guard). Nivel `override`-able (mapa symbol→nivel) para un modo vol-escalado
   (~3× ATR) en una capa futura — el plumbing de high/low aún no existe, así que
   esta capa envía el modo FIJO.

**DOS bandas de salida — no una, y ninguna es el ±2%.** El guard valida ENTRADAS
(y ventas DISCRECIONALES del PM) con la banda **±2%** (`ARENA_RULES.price_band`):
sanity check sobre el anclaje de precio del LLM. Una venta PROTECTORA la genera
este módulo, NO el LLM — su límite no busca buen precio, evita un fill absurdo
tipo flash crash. Por eso son ANCHAS y hay DOS (`limit = referencia × (1 − banda)`,
marketable, por DEBAJO del mercado):
- **`ARENA_EXIT_BAND_BREAKER`** (~12%) para delever/broadcut — desapalancamiento
  de portafolio, gap por-nombre menor.
- **`ARENA_EXIT_BAND_CATASTROPHIC`** (~32%) para el stop catastrófico —
  emergencia de UN nombre, **TIENE que llenar**: un límite 32% abajo del cierre
  llena en cualquier gap realista. Un nombre con stop+delever usa la banda ancha.

**ESCALAMIENTO del stop.** Si un stop catastrófico NO llenó (el gap fue peor que
la banda → la orden `day` expiró), la corrida siguiente lo re-emite MÁS abajo
(`banda += ARENA_EXIT_ESCALATION_STEP` por cada intento fallido, tope
`ARENA_EXIT_BAND_MAX` ~70%). El conteo sale de las filas `risk_exit` recientes
(órdenes catastróficas con `order_status` terminal-no-llenado). Cada acción
journalea `exit_band` y `exit_attempt` — para medir con qué frecuencia no llena.
Sigue siendo una orden LÍMITE → respeta la regla de la casa (cicatriz Polymarket:
JAMÁS market orders). La referencia de precio prioriza cierre completo →
`current_price` de Alpaca → `avg_entry` (así un delisted/ilíquido IGUAL se cierra);
sin ninguna → descartado y journaleado (fail closed, ruidoso).

**HALT tras el corte amplio (`arena_state`).** El −20% ES el resultado del
experimento: si el agente se reiniciara solo, se borraría el hallazgo. Por eso el
broadcut, además de liquidar, **DETIENE al agente** (flag persistente en la tabla
`arena_state`): la muerte se journalea UNA vez (`status = risk_broad_cut`), y las
corridas siguientes salen por el gate de halt **sin journalear** (nada de filas
diarias en el limbo). El panel lo muestra explícito ("⛔ AGENTE DETENIDO"). La
reactivación es **MANUAL** (`GET /api/arena-run?action=resume`, con `CRON_SECRET`)
y queda documentada con una fila `status = resumed`; al reactivar se sella
`resumed_at`, que re-basa el pico del breaker (si no, re-dispararía el broadcut
sobre una cuenta ya liquidada). Estado: `?action=status`.

**Precedencia y journaling.** Las salidas de riesgo se computan y ejecutan ANTES
del LLM, en su **propia fila** de journal (`status = risk_exit`, o
`risk_broad_cut` para el corte amplio) — así un stop que disparó se ejecuta
AUNQUE el LLM luego aborte (sin API key, error, o "nada que investigar" son
resultados normales que NO deben frenar la red). Una salida determinista GANA
sobre la acción del PM del mismo nombre (no se ejecutan las dos). Cada venta
journalea `channels:['risk_exit']`, `origin` (`breaker_broadcut`/`catastrophic_stop`/
`breaker_delever`) y `reasoning` sintético — el post-mortem a 30 días las agrupa
igual que las decisiones del PM. El `client_order_id` lleva el segmento **`:exit`**
(distinto de `:buy`/`:sell`), así una salida determinista no colisiona con una
venta del PM del mismo símbolo el mismo día.

**Camino de venta (reparado en esta capa).** El guard aplicaba a las ventas
reglas de ENTRADA que romperían un exit legítimo (banda ±2%, sub-$1, universo,
fail-closed por symbol map / cierre faltante). Las salidas de riesgo NO pasan por
esas reglas: van por su propio path con la banda de exit ancha y solo validan lo
que aplica a cerrar un largo (posición existe, `qty ≤` lo que hay, referencia de
precio). Las ventas DISCRECIONALES del PM sí conservan el guard ±2% a propósito.

## Env vars y orden de encendido

1. `ALPACA_PAPER_KEY` / `ALPACA_PAPER_SECRET` — las agrega Lety en Vercel.
2. **Gate:** `GET /api/alpaca?smoke=1` desde el Vercel real → los 6 pasos
   `ok:true` (auth, clock, calendar, orden límite imposible, lookup, cancel).
   El sandbox de desarrollo tiene `*.alpaca.markets` bloqueado; el smoke en
   prod es el único que cuenta.
3. `ARENA_ENABLED=1` — el switch. Los crons ya están en `vercel.json` pero el
   handler no opera sin este flag (responde `{disabled:true}`).
4. **Dependencia pendiente:** la primera corrida real necesita créditos de
   Anthropic (`ANTHROPIC_API_KEY`). El smoke de Alpaca y toda la infra NO los
   necesitan. Sin key, el run queda journaleado como `aborted_no_api_key`
   con cero órdenes — el cron puede quedar prendido sin gastar.

También usa (ya existentes): `FINNHUB_API_KEY` (symbol map del guard + deep dive
de candidatos + fundamentales del cron screener), `DATABASE_URL`, `CRON_SECRET`,
`ANTHROPIC_MODEL` (default haiku).

**Regla de salida** (todas opcionales, con defaults en `_lib/arena-exits.js`;
fracciones en (0,1), time-boxed del trial): `ARENA_BREAKER_DELEVER_DD` (0.15),
`ARENA_BREAKER_BROADCUT_DD` (0.20), `ARENA_BREAKER_DELEVER_TRIM` (0.33),
`ARENA_CATASTROPHIC_STOP_PCT` (0.22), y las DOS bandas de salida +
escalamiento: `ARENA_EXIT_BAND_BREAKER` (0.12), `ARENA_EXIT_BAND_CATASTROPHIC`
(0.32), `ARENA_EXIT_ESCALATION_STEP` (0.13), `ARENA_EXIT_BAND_MAX` (0.70). Un
valor inválido (≤0 o ≥1) cae al default en silencio.

**Temporada 2** (mismas reglas de validación; defaults entre paréntesis):
`ARENA_TRAILING_ARM_GAIN` (0.15) y `ARENA_TRAILING_GIVE_BACK` (0.08) — el
trailing de la regla #3 —, `ARENA_EXIT_BAND_TRAILING` (0.12) — su banda de
marketable limit, sin escalamiento —, `ARENA_TIME_STOP_DAYS` (45, entero
positivo; inválido → default) y `ARENA_EXIT_BAND_DISCRETIONARY` (0.04, en
`_lib/arena-guard.js`) — la banda con la que se envía la VENTA del PM.
Ninguna requiere tocarse para que la T2 corra: todas traen default.

**Smoke de venta** (cuenta paper SEPARADA, para ejercitar el path REAL de venta
sin ensuciar el libro del Agente #6): `ALPACA_SMOKE_KEY` / `ALPACA_SMOKE_SECRET`
(una de las 3 cuentas paper del login, dedicada al smoke; mismo host paper) y
opcional `ALPACA_SMOKE_SYMBOL` (default `F` — algo líquido y barato).
`GET /api/alpaca?smoke=sell`: con mercado ABIERTO hace un round-trip (compra 1
acción con marketable limit y la vende); con mercado CERRADO cae a resting
(venta límite imposible sobre una posición → confirma → cancela).

**Canal screener:** `ARENA_SCREENER_ENABLED=1` prende el cron de precompute
(`api/arena-screener?job=refresh`, cada 4h vía GitHub Actions —
`.github/workflows/external-crons.yml`, no `vercel.json`; ver `docs/crons.md`). Es independiente de
`ARENA_ENABLED`: mientras el cron no haya corrido (o esté apagado) la tabla
`arena_screener` está vacía → el canal screener llega vacío al PM, no es error.
El arena-run lee `ARENA_SCREENER_ENABLED` en la misma corrida (es del proyecto
Vercel): tabla vacía **con el flag apagado** se journalea como `screener_disabled`
(el canal nunca corrió), distinto de `screener_empty` (flag prendido, aún sin
llenar) — así el post-mortem no confunde "falta el flag" con "nada calificó".
Sembrar el ledger: `GET /api/arena-screener?job=seed` (o siembra perezosa en el
primer `refresh`); estado: `?job=status` (incluye el conteo `not_found`).

**Tickers muertos (delisted/renombrados).** El universo se cura a mano y con el
tiempo acumula símbolos que dejan de cotizar: HES (Hess, absorbida por Chevron)
o SQ→XYZ (rebrand de Block). El refresh los reintentaba cada ciclo y fallaba. El
ledger ahora distingue el tipo de fallo por `status`:
- `error` — fallo **transitorio** (rate limit, timeout, sin-datos-hoy): se
  reintenta en la rotación normal.
- `not_found` — el símbolo **no está en el symbol map US de Finnhub** (delisted o
  cambió de ticker): estado **terminal**, `pickStaleSymbols` lo excluye de la
  rotación (no se le gasta ni una llamada más). El refresh lo detecta con el
  symbol map que ya carga (0 requests extra) y lo marca sin pegar a Finnhub/Yahoo.
  Fail-safe: si el map no cargó (Finnhub caído) NO delistea a ciegas — trata todo
  como transitorio.

Auditar el universo contra el symbol map en vivo: `GET /api/arena-screener?job=audit`
(read-only) → `{ total, present, missing }`, donde `missing` son los tickers del
universo ausentes del map (los muertos). Es la fuente autoritativa y siempre
actual; el fix del universo en código (`_lib/screener-universe.js`) resuelve los
ya conocidos, y `job=audit` descubre los nuevos a medida que aparezcan.

5. `PUBLIC_BASE_URL` — dominio público estable del deploy (p.ej.
   `https://quantdesk2.vercel.app`) para el **self-fetch del buffet**. Es
   OBLIGATORIA en prod: sin ella el Arena cae a `VERCEL_URL`, que es la URL
   *generada* del deployment y está detrás de **Vercel Deployment Protection**
   → el self-fetch de la lambda a sus propios endpoints recibe **401** y los 4
   se marcan "no disponibles" (bug del 24-jul: 0 posiciones, 100% cash). El
   alias público no está protegido. Resolución en `resolveBaseUrl()`.

## Self-fetch del buffet: causa raíz 24-jul y observabilidad

El 24-jul la corrida journaleó los endpoints del buffet como caídos y el PM se
quedó 100% cash. Los handlers **nunca devuelven 5xx** (degradan a 200), así que
el fallo estaba una capa arriba: el self-fetch a `VERCEL_URL` daba 401 por
Deployment Protection. Fix: `PUBLIC_BASE_URL`. (El self-fetch cubre
movers/earnings/insiders; el canal screener se lee de Neon, no por HTTP.)

Además, `gatherContext` calculaba el error real por endpoint pero lo tiraba:
solo journaleaba `unavailable: [nombres]`. Ahora la columna
`arena_journal.context` guarda, por fase (`scan`/`dive`):
- `fetch_errors` — status HTTP / timeout real por endpoint caído.
- `prompt` — el **prompt completo** (system + user) de AMBAS fases, no solo el
  `prompt_hash`. Post-mortem sin arqueología: se ve exactamente qué contexto
  tenía el PM al decidir.
- `scan.candidates` / `scan.floor` / `scan.slate` — picks crudos del scout, el
  resultado del floor y el slate final con `origin`.
- `dive.finnhub` / `dive.shown_closes` — el deep dive por candidato y el cierre
  fresco que se le mostró al PM (auditar desfases contra lo que valida el guard).

El `context` NO viaja al prompt del LLM (`buildScanUserPrompt` excluye
`fetch_errors` y `channelsByTicker`).

### Cobertura de `movers` en el buffet

`trimMovers` le pasa al PM **gainers, losers Y actives** (`symbol/price/changePct`),
gainers/losers a **top-5** y actives a **top-8**. Antes solo pasaba
gainers+losers a top-5, y `actives` —donde caen las mega-caps con movimiento
fuerte— se descartaba: TSLA a -14.5% en actives nunca llegó al PM (24-jul).

Filtros aplicados ANTES del recorte, en las tres listas:
- **micro-caps <$5** — el top_losers de AV está dominado por small caps a
  -30/-40% que sepultaban a las mega-caps (el guard igual las descartaría).
- **ETFs apalancados/inversos** (`LEVERAGED_INVERSE_ETFS` / `isLeveragedInverseETF`).
  AV free no da nombre ni tipo → no hay flag ni nombre para clasificar; la
  detección limpia y sin falsos positivos es una **lista curada** por ticker
  (un regex confundiría NU/AAL/NOK). Importa porque **el guard NO los rechaza**
  (están en el symbol map US, >$1, sin sufijo de warrant): sin este filtro el PM
  podría comprar un 3x apalancado, y por volumen desplazan al subyacente real
  del top de actives. La lista no es exhaustiva: un leveraged nuevo pasa hasta
  que se agregue al Set.

**Refactor pendiente (A1):** eliminar el self-fetch HTTP y llamar a los
builders (`buildMarketMovers`, calendario de earnings, `buildInsider`,
`buildRounds`) **in-process**. Cero hops, cero protección de por medio, sin
env var de URL. `PUBLIC_BASE_URL` es el fix inmediato de bajo riesgo; A1 es la
solución definitiva que elimina la clase entera de bug.

## Nota de horario

Los crons están en UTC fijo: decide 22:40 (post-cierre NYSE todo el año),
reconcile 14:40 ≈ una hora tras el open de verano y 10 min tras el de
invierno. Si el fill entra tarde un día de invierno, el reconcile del día
siguiente lo recoge — el estado no terminal se re-chequea hasta 7 días.

## Días no hábiles (mercado cerrado)

Antes de correr la liga, `runArenaLeague` pregunta **una sola vez** si el
mercado abrió hoy (`marketClosedReason`, en `api/arena-run.js`). Es un chequeo
**global** —un hecho de mercado, no por-agente— que va **antes** del loop de
agentes: si está cerrado, ningún agente toca el buffet, el LLM ni Alpaca.

- **Festivos = el valor real.** El cron de decide ya dispara solo entre semana
  (`40 22 * * 1-5`), así que el fin de semana no necesita una rama de código
  aparte (sería redundante). Lo que este chequeo agrega es el **festivo entre
  semana**: el cron sí dispara un 4 de julio o un Thanksgiving, y ahí es donde
  se evita correr contra un mercado cerrado.
- **Fuente: el calendario de Alpaca.** `getCalendar(hoy, hoy)` en horario del
  Este (`America/New_York`, robusto a UTC/DST). Sin sesión hoy → cerrado. La
  fecha "de hoy" se calcula en ET porque el cron corre 22:40 UTC.
- **Fila marcadora global, no silencio.** Se journalea **una sola** fila
  `status='skipped_market_closed'` con `agent_id='league'` (sentinela, no un
  agente real: no aparece en ninguna card por-agente), cero órdenes y
  `context.market_check` (`reason` = `weekend` | `holiday` + fecha ET). Mercado
  cerrado es un hecho de la liga entera, no de cada agente. Fila presente = *la
  liga decidió no operar*; que el cron **sí** corrió lo distingue el latido
  (`beat('arena:decide')`), no las filas del journal. La etiqueta
  `weekend`/`holiday` es informativa: el control de flujo es uno solo (cerrado ⇒
  skip).
- **Calendario caído → fail-OPEN.** Si la consulta de festivos falla, la corrida
  **sigue** (`reason='calendar_error'`). El costo de correr de más son centavos y
  órdenes que se encolan al siguiente open; el de no correr es perder un día del
  experimento. El fail-closed del Arena aplica a la validez de **órdenes** (el
  guard), no a la detección de calendario.
- **El reconcile NO se skipea:** es idempotente y barato — en un festivo
  simplemente no hay fills nuevos.

## Auditoría del run (`/api/arena-audit`) — solo lectura

Neon no se alcanza desde el sandbox de Claude Code, pero la app en Vercel sí.
Este endpoint es la ventana de auditoría: reconstruye, **corrida por corrida**,
todo lo que el agente vio y decidió desde el arranque, sin abrir una sesión de
SQL y sin tocar nada.

| Query | Qué devuelve |
|---|---|
| `/api/arena-audit` | JSON, una entrada por corrida (agrupada por `run_date`) |
| `?format=md` | El mismo detalle en **markdown en español**, una sección por corrida, ordenado por fecha |
| `?view=resumen` | Métricas agregadas de todo el run |
| `?view=resumen&format=md` | El resumen en markdown |
| `?agent=openai` · `?agent=todos` | Otro competidor de la liga, o todas las filas |
| `?desde=YYYY-MM-DD` · `?limit=N` | Recorte (default 500 filas; `truncado:true` avisa si no cupo todo) |
| `?deploy=<ISO>` | Re-corta el antes/después de `buffet-quality` sin re-deploy |

**Por corrida:** status y fecha · canales del buffet que llegaron y **cuántos
ítems reales** traía cada uno (movers con su desglose gainers/losers/actives,
earnings, insiders, screener con value/momentum) más el error real del canal
caído · `scout_picks` crudos y la tesis · **slate final** con `origin`
(`scout_picked`/`floor_reserved`) y el estado del floor · acciones propuestas
(símbolo/lado/qty/límite) con el **veredicto del guard** (aprobada/descartada y
la razón textual) · fills (precio y timestamp reales) · la prosa del plan
verbatim · el resultado del **detector de fabricación (#93)** con sus tokens sin
ancla · la etapa del breaker y el libro que el PM tenía enfrente.

**`?view=resumen`** agrega: corridas totales y desglose por status ·
aprobadas/descartadas/fills (total y solo del PM) · **ventas voluntarias**
(esperado 0 — la red determinista no cuenta) · **`scout_picks` por corrida antes
vs después del deploy de `buffet-quality`** (la predicción medible que quedó
registrada; corte por defecto `BUFFET_QUALITY_DEPLOY`, el merge del PR #108) ·
**posiciones que cruzaron −5%** y en cuántas corridas posteriores la prosa las
nombró por su nombre, con las frases citadas (métrica de atención a posiciones
heridas) · **cambios de veredicto sobre el mismo símbolo** entre corridas (el
caso LYFT: descartado el 05-ago, aprobado el 13/14-ago) con las frases del plan
de cada corrida.

**Restricciones que el endpoint respeta (y que los tests blindan):**

- **Cero writes.** Puros `SELECT`. En particular **no** llama a `ensureSchema()`
  (hace CREATE/ALTER/UPDATE de migración) ni a `beat()`: latir aquí
  enmascararía un cron muerto, porque el latido dejaría de significar "el cron
  corrió". Tampoco importa `arena-run`, el guard ni el prompt del PM — el camino
  de decisión no se toca ni de lectura.
- **Gate de `CRON_SECRET`**, mismo patrón de `arena-run`/`ai-usage`. Se acepta
  por header (`Authorization: Bearer <secret>`) **o** por query
  (`?secret=<secret>`): el caso de uso es abrir el markdown directo en el
  navegador, donde no hay forma de mandar headers. Respuesta con `no-store`.
- **`maxDuration = 300`** (el journal ya es largo: semanas de corridas con el
  contexto completo por fila).
- **El buffet se reconstruye del prompt journaleado** (`context.scan.prompt.user`,
  que es donde vive): si esa fila no lo trae, `reconstruido:false` y los conteos
  quedan en `null` — hueco honesto, nunca un cero inventado. Los textos de los
  prompts **no** se re-emiten: solo lo destilado.
