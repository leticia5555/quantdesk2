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
| Risk guard determinista (post-LLM, fail closed) | `api/_lib/arena-guard.js` |
| Cron decide (22:40 UTC L-V) + reconcile (14:40 UTC L-V) | `api/arena-run.js` + `vercel.json` |
| Datos para la UI | `api/arena.js` |
| Journal | tabla `arena_journal` (`api/_lib/db.js`) |
| UI (sección en MIS AGENTES) | `app.html` (`qdArenaLoad`/`qdArenaHtml`) |
| Tests | `tests/arena-guard.test.mjs` · `tests/alpaca.test.mjs` · `tests/arena-run.test.mjs` |

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
  (`WARRANT_LIKE`, que queda como respaldo para símbolos sin `type`).

Los **ADR se mantienen** a propósito (NU/MELI/ITUB son ADRs LATAM, el corazón de
la audiencia). Es regla de **producto, no de seguridad**: con `type`
vacío/desconocido se **permite** y se journalea (`security_type` en la orden
aprobada; null = el free tier no lo trajo) — lo peligroso ya lo cubre la doble
barrera de leveraged. El tipo **`PUBLIC`** (3ª categoría por tamaño) queda por
ahora **permitido**, pendiente de revisar ejemplos. Diag de cobertura + muestras
por tipo en prod: `GET /api/earnings?diag=symboltypes` (total, % poblado,
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

También usa (ya existentes): `FINNHUB_API_KEY` (symbol map del guard),
`DATABASE_URL`, `CRON_SECRET`, `ANTHROPIC_MODEL` (default haiku).

5. `PUBLIC_BASE_URL` — dominio público estable del deploy (p.ej.
   `https://quantdesk2.vercel.app`) para el **self-fetch del buffet**. Es
   OBLIGATORIA en prod: sin ella el Arena cae a `VERCEL_URL`, que es la URL
   *generada* del deployment y está detrás de **Vercel Deployment Protection**
   → el self-fetch de la lambda a sus propios endpoints recibe **401** y los 4
   se marcan "no disponibles" (bug del 24-jul: 0 posiciones, 100% cash). El
   alias público no está protegido. Resolución en `resolveBaseUrl()`.

## Self-fetch del buffet: causa raíz 24-jul y observabilidad

El 24-jul la corrida journaleó los 4 endpoints (movers/earnings/insiders/vc)
como caídos y el PM se quedó 100% cash. Los handlers **nunca devuelven 5xx**
(degradan a 200), así que el fallo estaba una capa arriba: el self-fetch a
`VERCEL_URL` daba 401 por Deployment Protection. Fix: `PUBLIC_BASE_URL`.

Además, `gatherContext` calculaba el error real por endpoint pero lo tiraba:
solo journaleaba `unavailable: [nombres]`. Ahora la columna
`arena_journal.context` guarda:
- `fetch_errors` — status HTTP / timeout real por endpoint caído.
- `prompt` — el **prompt completo** (system + user) que se le mandó al LLM,
  no solo el `prompt_hash`. Post-mortem sin arqueología: se ve exactamente qué
  contexto tenía el PM al decidir.

El `context` NO viaja al prompt del LLM (`buildUserPrompt` excluye `fetch_errors`).

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
