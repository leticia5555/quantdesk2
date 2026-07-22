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

Universo equities US (sin warrants/units, sin sub-$1, long-only) · máx 8
posiciones · máx 15% del equity por posición · mín 10% de cash · SOLO
órdenes límite (day, fill al open siguiente) · limit_price a ±2% del último
cierre. Violación → orden descartada y journaleada con razón, jamás ajustada
en silencio. JSON malformado → run abortado honesto, cero órdenes.

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

## Nota de horario

Los crons están en UTC fijo: decide 22:40 (post-cierre NYSE todo el año),
reconcile 14:40 ≈ una hora tras el open de verano y 10 min tras el de
invierno. Si el fill entra tarde un día de invierno, el reconcile del día
siguiente lo recoge — el estado no terminal se re-chequea hasta 7 días.
