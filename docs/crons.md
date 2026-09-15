# Crons — dónde vive cada uno

> **Futuro-yo:** si un cron no corre, revisa **primero** `GET /api/cron-status`
> (marca en rojo lo que lleva demasiado sin latir). Luego busca el cron en el
> lugar correcto según la tabla de abajo — **no todos están en `vercel.json`.**

## Por qué están partidos

Históricamente: el plan **Hobby de Vercel limitaba cada cron a 1×/día** (el
tope de *cantidad* es 100/proyecto en todos los planes desde enero 2026 — ese
nunca fue el problema; el problema era la **frecuencia**). Por eso los crons
**sub-diarios** se agendaron en **GitHub Actions**, que permite cadencia
sub-diaria gratis. Los crons **diarios** siguen en Vercel.

**La cuenta ya es Pro**, así que la frecuencia dejó de ser un límite: los dos
crons sub-diarios (`pead:earnings`, `screener:refresh`) *podrían* volver a
`vercel.json`. Por ahora **siguen en GitHub Actions** (el workflow los corre
tal cual) — migrarlos de vuelta es limpieza opcional, no urgente; ver la nota
al final.

## Mapa

| Job (heartbeat)    | Endpoint                              | Cadencia (UTC)         | Vive en |
|--------------------|---------------------------------------|------------------------|---------|
| `agents:run`       | `/api/agents-run`                     | `30 22 * * 1-5`        | **vercel.json** |
| `arena:decide`     | `/api/arena-run`                      | `40 22 * * 1-5`        | **vercel.json** |
| `arena:reconcile`  | `/api/arena-run?phase=reconcile`      | `40 14 * * 1-5`        | **vercel.json** |
| `arena:morning`    | `/api/arena-run?phase=morning`        | `50 14 * * 1-5`        | **vercel.json** |
| `pead:hour`        | `/api/pead-harvest?job=hour`          | `30 21 * * *`          | **vercel.json** |
| `arena:universe`   | `/api/arena-universe`                 | `0 13 * * 1-5`         | **vercel.json** |
| `arena:watch`      | `/api/arena-watch`                    | `*/5 13-21 * * 1-5`    | **vercel.json** |
| `screener:refresh` | `/api/arena-screener?job=refresh`     | `0 */4 * * *` (cada 4h) | **GitHub Actions** → `.github/workflows/external-crons.yml` |

El endpoint **`/api/liga/eventos`** (crónica de la liga) NO es un cron: es
solo-lectura, público y cacheado en el edge, como `/api/leaderboard`.

## `arena:universe` — el UNIVERSO, ANTES de la apertura (desde 2026-09-15)

`0 13 * * 1-5` = **9:00 ET**, media hora antes de la apertura. Reconstruye los
~600 nombres (S&P 500 + Nasdaq 100 + hasta 100 del día), los pasa por el filtro
de admisión y guarda el resultado en Neon. La corrida del PM solo **lee** — el
mismo patrón que `screener:refresh`.

**Por qué no a demanda:** ~600 nombres × (precio + volumen + market cap) no cabe
dentro de una corrida. Y por qué **antes** de la apertura: el universo tiene que
estar armado con velas cerradas del día anterior, no con la vela viva del día
que se opera.

**Si este cron no corre**, la corrida usa el universo de **ayer** y lo dice
(`loaded_from`, `is_today: false`). No se reconstruye a medias: un universo
mitad fresco y mitad viejo no se puede auditar.

**Cero tokens.** Es datos de mercado y una lista de constituyentes.

Se puede disparar a mano con `ARENA_ADMIN_KEY` (además del `CRON_SECRET`):
`?peek=1` muestra qué hay guardado sin construir nada, `?dry=1` construye sin
guardar, `?refresh=1` fuerza el refresco semanal de constituyentes contra FMP y
`?emit=1` devuelve los constituyentes listos para commitear en
`data/universe/`.

## `arena:watch` — el VIGILANTE (cadencia por evento, desde 2026-09-15)

Es el cron más frecuente del proyecto y el único que corre **cada 5 minutos**.
Lee precios vía Alpaca, evalúa seis disparadores y despierta al agente dueño de
la posición solo cuando algo pasa. **Cero tokens** en el tick: el gasto está del
otro lado de la puerta, en las corridas que despierta. Reglamento completo en
`docs/arena.md` §"Cambio de cadencia (T3)".

**Por qué Vercel y no otra cosa.** La cuenta es **Pro**, y Pro no limita la
*frecuencia* de los crons (el tope de 1×/día era de Hobby — ver arriba), así que
un `*/5` cabe sin trucos y sin un runtime nuevo. Las alternativas se evaluaron:

| Opción | Veredicto |
|---|---|
| **Vercel cron** (elegida) | Cadencia confiable, mismo deploy, mismas env vars, cero infraestructura nueva. |
| GitHub Actions | ❌ Sus `schedule` son **best-effort** y se retrasan de minutos a decenas de minutos con la cola cargada. Para `screener:refresh` cada 4h da igual; para un vigilante de mercado, un tick que llega 20 min tarde es un disparador que no existió. |
| Worker chico (Fly/Railway/Cloudflare) | ❌ Cadencia buena, pero agrega un runtime, un deploy y un juego de secretos MÁS que mantener para correr código que ya vive en este repo. No compra nada que Pro no dé. |

**La ventana `13-21` UTC** cubre la sesión en EDT (13:30–20:00) *y* en EST
(14:30–21:00), así que no hay que tocar el cron dos veces al año. Los ticks que
caen fuera de sesión cuestan **una** llamada al calendario de Alpaca y salen
(`skipped_market_closed`) — el handler se auto-gatea, el cron no sabe de DST.

**Ventana de `stale`: 72h, gruesa a propósito.** La manda el fin de semana
(último tick viernes ~21:00 UTC, primero lunes ~13:00 UTC = 64h de hueco
legítimo), no la cadencia. Detecta "el cron murió", no "se perdieron unos
ticks" — para eso el instrumento es `run_count`, que debería subir **~108 por
día hábil**.

### Los dos crons RETIRADOS por este cambio

`arena:decide` (22:40) y `arena:morning` (14:50) **siguen en `vercel.json` y
siguen latiendo**, pero desde `2026-09-15` (ET) journalean una fila de liga
`skipped_superseded_by_watch` y salen sin gastar un token.

El corte se hace **en código, por fecha ET**, y no borrando la entrada del cron.
Borrarla haría que el cambio dependiera del *minuto* del deploy: si el PR sale un
lunes a las 19:00 UTC, la corrida de esa misma noche desaparece sin que nadie lo
pidiera, y el corte del post-mortem queda en una fecha que no es la anunciada.
Con el gate por fecha, el deploy puede caer cuando sea. Las entradas se quitan
cuando el vigilante lleve una semana en verde.

`ARENA_WATCH_START` (env var de Vercel) mueve el corte sin deploy, y
`ARENA_WATCH_ENABLED=0` apaga solo el vigilante: entre las dos, volver al cron
nocturno es un cambio de variables, no un revert.

**`arena:reconcile` (14:40) NO se retira**: los fills siguen necesitando
true-up. El vigilante además corre un reconcile oportuno (máx. 1 cada 30 min)
antes de despertar a alguien, porque con órdenes que llenan en minutos el plan
reinyectado se queda viejo dentro del mismo día.

**`arena:morning` (Temporada 2, regla #7)** corre 10 minutos DESPUÉS del
reconcile a propósito: primero se true-ean los fills de la apertura y recién
después el PM decide. Es una corrida **por evento**, no una segunda corrida
diaria — solo gasta LLM si una posición del libro de algún agente reportó
(AMC de la sesión anterior o BMO de hoy). Si no hay evento, journalea una fila
marcadora de liga (`skipped_no_post_earnings_event`) y sale. El latido late
igual todos los días hábiles: distingue "el cron corrió" de "el cron operó".

> ⚠️ `vercel.json` es JSON estricto: **no admite comentarios** (una key extra
> como `//` rompe el build con *"should NOT have additional properties"*). Por
> eso esta nota vive aquí y no dentro de `vercel.json`.

## Setup de GitHub Actions (una vez)

En GitHub → **Settings → Secrets and variables → Actions**:

1. Pestaña **Secrets** → **New repository secret**
   - Nombre: **`CRON_SECRET`**
   - Valor: **el mismo string** que la env var `CRON_SECRET` en Vercel
     (Project → Settings → Environment Variables). Es lo que los handlers
     validan como `Authorization: Bearer <CRON_SECRET>`.
2. Pestaña **Variables** → **New repository variable** *(opcional)*
   - Nombre: **`APP_BASE_URL`**
   - Valor: URL de producción (p.ej. `https://quantdesk2.vercel.app`).
   - Si no la pones, el workflow usa `https://quantdesk2.vercel.app` por default.
     La URL no es secreta → va como *variable*, no como *secret*.

Sin `CRON_SECRET`, cada run fallará con `401` (rojo, ruidoso) — que es justo lo
que queremos: nada de fallos silenciosos.

## Cómo se ve un fallo

- **En Actions:** el run sale en rojo. `curl --fail-with-body` corta en HTTP
  >=400 (401/500) y además revisamos el body por fallos lógicos que el handler
  devuelve como HTTP 200 (`error` / `disabled`).
- **En el heartbeat:** `GET /api/cron-status` marca el job `stale:true` y
  `ok:false` global. Cada cron llama a `beat()` al terminar; un cron que no
  corre no actualiza `last_run_at` y envejece hasta ponerse en rojo.

## Probar a mano

- **Actions:** pestaña Actions → *external-crons* → **Run workflow**
  (`workflow_dispatch` corre ambos jobs).
- **Directo:**
  ```bash
  curl -sS -H "Authorization: Bearer $CRON_SECRET" \
    "https://quantdesk2.vercel.app/api/pead-harvest?job=earnings" | jq
  curl -sS "https://quantdesk2.vercel.app/api/cron-status" | jq
  ```

## Vercel Pro (activo): qué destraba

La cuenta corre en **Pro**. Además de quitar el límite de frecuencia de los
crons (arriba), Pro sube `maxDuration` de **60s → 300s**. Los handlers que
peleaban contra los 60s ya lo declaran (`export const maxDuration = 300`):

- **`arena-run` (decide):** N agentes en paralelo, cada uno con buffet +
  deep dive Finnhub + dos llamadas LLM, más el reconcile pre-decide.
- **Goteo PEAD (`pead-harvest`):** margen para subir símbolos por corrida sin
  partir el batch (hoy `PER_RUN=5`).
- **`arena-screener`:** aire para el refresh.

Pendiente opcional: regresar `screener:refresh` a `vercel.json` y retirar el
workflow de Actions — ya no hace falta el split, pero Actions funciona igual,
así que no es urgente.

**Retirado: `pead:earnings`.** El backtest PEAD cerró con NO-GO (ledger 99/99).
El goteo de AlphaVantage se apaga en dos lugares y hacen cosas distintas:
`PEAD_HARVEST_ENABLED != 1` (env var de Vercel) **corta el gasto de la key**, y
quitar el schedule de Actions **evita el rojo diario** — el job trataba
`disabled:true` como fallo duro. Se quitó también de `EXPECTED` en
`api/cron-status.js` para que no quede `stale` para siempre. `pead:hour`
(`vercel.json`, SEC 8-K) sigue como estaba: no gasta cupo de AV. Detalle en
`docs/wheel-fase0.md` §4.3.
