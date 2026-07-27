# ARENA — Agente #6 "Claude PM"

Fecha: 2026-07-22. Independiente de la migración de la flota (el doc de Fase 1,
`docs/alpaca-paper-scope.md`, queda como está): el Arena usa la cuenta paper
existente (PA3VOJ7VTZHW) como su libro EXCLUSIVO — la flota validada sigue en
el simulador (`agents-run` + `sim.js`), sin colisión y sin pregunta de
multi-cuentas todavía.

**Qué es:** un LLM portfolio manager estilo Rallies/nof1 con la etiqueta
honesta de la casa: experimento sin validación estadística, paper trading,
no es asesoría. El razonamiento de cada decisión se publica verbatim junto
al trade (tabla `arena_journal`, card en el tab MIS AGENTES).

## Piezas

| Pieza | Archivo |
|---|---|
| Cliente Alpaca (limit-only hardcodeado) | `api/_lib/alpaca.js` |
| Smoke + health | `api/alpaca.js` (`GET ?smoke=1`) |
| Risk guard determinista (post-LLM, fail closed) + FLOOR del screener | `api/_lib/arena-guard.js` |
| Deep dive Finnhub por candidato (fundamentales/recommendation/news) | `api/_lib/finnhub-dive.js` |
| Cron decide (22:40 UTC L-V) + reconcile (14:40 UTC L-V) | `api/arena-run.js` + `vercel.json` |
| **Canal SCREENER** — screens deterministas (value/momentum) | `api/_lib/screens.js` |
| **Canal SCREENER** — capa de datos Neon (tabla + ledger) | `api/_lib/screener-db.js` |
| **Canal SCREENER** — universo (~150 nombres, extraído de app.html) | `api/_lib/screener-universe.js` |
| **Canal SCREENER** — cron de precompute (cada 4h) | `api/arena-screener.js` + `vercel.json` |
| Datos para la UI | `api/arena.js` |
| Journal | tabla `arena_journal` (`api/_lib/db.js`) |
| UI (sección en MIS AGENTES) | `app.html` (`qdArenaLoad`/`qdArenaHtml`) |
| Tests | `tests/arena-guard.test.mjs` · `tests/alpaca.test.mjs` · `tests/arena-run.test.mjs` · `tests/screens.test.mjs` |

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
- `channels` — `movers`/`earnings`/`insider`/`screener` (índice determinista de
  qué sección del buffet contenía el ticker; no confía en el LLM).
- `origin` — `scout_picked` (lo eligió el scout, incl. screener orgánico) vs
  `floor_reserved` (lo forzó el floor). Separa "el PM eligió el canal" de "se lo
  reservamos".
- `screens` + `screener_qualifiers` — si vino del screener, qué screen y con qué
  números.

El índice de atribución (`channelsByTicker`) **NO viaja al prompt del LLM** — es
solo para journaling.

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

**Canal screener:** `ARENA_SCREENER_ENABLED=1` prende el cron de precompute
(`api/arena-screener?job=refresh`, cada 4h en `vercel.json`). Es independiente de
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
