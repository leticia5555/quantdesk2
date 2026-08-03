# Crons — dónde vive cada uno

> **Futuro-yo:** si un cron no corre, revisa **primero** `GET /api/cron-status`
> (marca en rojo lo que lleva demasiado sin latir). Luego busca el cron en el
> lugar correcto según la tabla de abajo — **no todos están en `vercel.json`.**

## Por qué están partidos

El plan **Hobby de Vercel limita cada cron a correr 1×/día** (el tope de
*cantidad* es 100/proyecto en todos los planes desde enero 2026 — ese nunca fue
el problema; el problema es la **frecuencia**). Por eso los crons **sub-diarios**
no pueden vivir en `vercel.json`: se agendan en **GitHub Actions**, que sí
permite cadencia sub-diaria gratis. Los crons **diarios** siguen en Vercel.

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

## Nota para cuando haya ingresos: subir a Vercel Pro

Pro no es solo por los crons (con Actions ya quedan cubiertos). El upgrade
también sube `maxDuration` de **60s → 300s**, lo que destraba:

- **Goteo PEAD:** más símbolos por corrida (hoy `PER_RUN=5` cabe en 60s; con
  300s se puede subir sin partir el batch) → cosecha más rápida.
- **Deep dive del Arena:** más aire para las llamadas de análisis que hoy
  pelean contra el límite de 60s.

Si se sube a Pro, se pueden regresar estos dos crons a `vercel.json` y retirar
el workflow — pero no es obligatorio; Actions funciona igual.
