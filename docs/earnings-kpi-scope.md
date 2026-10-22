# Cosecha de mercados KPI de Polymarket (`pm_kpi_markets`)

Cosecha **paralela** a la de beat/miss (`pm_earnings_markets`, ver
`earnings-beat-scope.md`). No toca esa tabla, ni el filtro v1, ni
`api/_lib/earnings-beat.js` (de ahí solo se importan utilidades puras).

## Qué guarda

- `pm_kpi_markets` — una fila por **cajón** (mercado hijo de un evento de
  rangos: "<22%", "22% to 24%", "28%+"). PK `market_id` = `conditionId`.
  `range_low`/`range_high` son NULL en los extremos abiertos; `range_unit` es
  `%`, `$`, `bps`, `pp` o NULL (número absoluto: "400k" → 400000).
- `pm_kpi_prices` — historial del Yes por cajón (`fuente` = `gamma` para el
  snapshot diario, `clob` para `/prices-history`). De acá sale `price_yes_t24h`:
  el último punto con `ts ≤ end_date − 24h`, solo cuando T-24h ya pasó, con su
  `price_yes_t24h_ts` y `price_yes_t24h_estado` (`rancio` si el punto es > 36 h
  antes del cierre).
- `reported_value` lo carga una persona (o una API futura). El cron no lo toca.

Migración: `docs/sql/earnings-kpi.sql` (= `SCHEMA` de `api/_lib/earnings-kpi-db.js`;
el test exige que no diverjan).

## Endpoints

| | |
|---|---|
| `GET /api/earnings-beat-harvest?job=kpi` | cron 23:20 UTC: descubre, upsert, snapshot, backfill CLOB, T-24h. Requiere `EARNINGS_KPI_HARVEST_ENABLED=1` |
| `…?job=kpi&dry=1` | en seco: descubre y cuenta, no escribe |
| `…?job=kpi&format=md` | lectura: eventos con cajones abiertos, por `end_date` |

Corrida en seco fuera de Vercel: `node scripts/pm-kpi-seco.mjs [--clob] [--json]`,
o el workflow `pm-kpi-seco` (Actions → manual, o automático en PRs que tocan la cosecha).

## Descubrimiento

`/public-search?q=<semilla>` por cada una de las 15 semillas de
`SEMILLAS_KPI`, dedupe por `event_slug`, y luego `/events?slug=` para traer el
evento completo. Cada corrida re-hidrata también los eventos abiertos ya
conocidos, aunque la búsqueda ya no los devuelva (así se captura la resolución).

Exclusiones (con motivo, contadas): `beat … quarterly earnings` (tiene su
cosecha), menciones ("Will X say…"), títulos sin periodo fiscal (Q1–Q4 /
quarter / FY: deja fuera "Elon Musk Net Worth on …", que la semilla `net adds`
traía), y eventos con menos de 2 cajones legibles.

`range_kind`: `cajon` (rangos excluyentes, los Yes suman ~1) o `umbral`
(escaleras "Will X be above __?": cada hijo es "más de X", no suman 1).

## Candados

- Gamma 422 → se para el descubrimiento entero, sin reintentar, y no se escribe.
- Cero datos de la frontera → `frontera.estado = 'falla_de_frontera'`, latido
  `error`, no se escribe. Nunca se lee como "no hay mercados".
- Un error de CLOB no marca el backfill como hecho: se reintenta al día siguiente.
