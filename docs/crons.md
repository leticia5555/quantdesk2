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
| `pead:hour`        | `/api/pead-harvest?job=hour`          | `30 21 * * *`          | **vercel.json** |
| `pead:earnings`    | `/api/pead-harvest?job=earnings`      | `0 12,14,16,18,20 * * *` (5×/día) | **GitHub Actions** → `.github/workflows/external-crons.yml` |
| `screener:refresh` | `/api/arena-screener?job=refresh`     | `0 */4 * * *` (cada 4h) | **GitHub Actions** → `.github/workflows/external-crons.yml` |

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

Pendiente opcional: regresar `pead:earnings` y `screener:refresh` a
`vercel.json` y retirar el workflow de Actions — ya no hace falta el split, pero
Actions funciona igual, así que no es urgente.
