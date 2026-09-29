# T3 · PLAN DE APERTURA

Escrito el **2026-09-29**, ANTES de ejecutar nada. Lo verificado está marcado
como verificado; lo que no pude correr (producción) está marcado como comando
para Lety.

**El reset NO se aprieta hasta que los seis puntos estén en verde, y se
aprieta el MISMO día de la recarga.**

> ## LA PUERTA DEL HUMO, POR ESCRITO Y ANTES
>
> **Si UNO de los siete aborta, la temporada NO abre.** Se arregla y se vuelve
> a correr, aunque la apertura se empuje al miércoles.
>
> «Ese ya casi pasaba» es literalmente lo que hicimos con la T2, y costó nueve
> días y una temporada entera. Un agente con `reloj_pct ≥ 90` **no pasó**:
> llegó justo, y va a abortar el primer día malo.
>
> Empujar la apertura un día cuesta una sesión de 24. Abrir con un agente roto
> costó 24 de 24.

---

## 0 · LA PAUSA: `ARENA_ENABLED=0`, Y POR QUÉ NO ALCANZA `pauseWatch`

**Sí, el scheduler puede disparar en la ventana entre deploy y reset.** Los
crons del arena, en UTC:

| cron | UTC | ET | qué hace |
|---|---|---|---|
| `/api/arena-watch` | `*/5 13-21 * * 1-5` | **cada 5 min, 09:00–17:00** | despierta agentes por disparador |
| `/api/arena-run?phase=reconcile` | `40 14` | 10:40 | concilia fills |
| `/api/arena-run?phase=morning` | `50 14` | 10:50 | ronda matutina por evento |
| `/api/arena-run` | `40 22` | 18:40 | la ronda de decide |
| `/api/arena-universe` | `0 13` | 09:00 | refresca el universo |

El de las **:05 es el peligroso**: dispara 96 veces al día. Cualquier paso que
se pase de las 09:00 ET cae adentro.

**`pauseWatch` NO sirve para esto**, y conviene saber por qué antes de
confiarle la noche:

- solo frena `/api/arena-watch`. **`/api/arena-run` no la consulta** — el
  decide de las 18:40 y la matutina de las 10:50 corren igual;
- tiene un **tope duro de 120 minutos** (`Math.min(120, …)`), así que no cubre
  un plan que puede dormirse y seguir en la mañana;
- vence sola, que es una virtud durante un aplanado de diez minutos y un
  defecto para una pausa de doce horas.

**`ARENA_ENABLED=0` sí.** Verificado leyendo los gates de cada endpoint:

| endpoint | ¿lo frena `ARENA_ENABLED=0`? | |
|---|---|---|
| `/api/arena-run` | **sí** (`arena-run.js:3601`) | la liga no decide |
| `/api/arena-watch` | **sí** | el vigilante no despierta a nadie |
| `/api/arena-reset` | **no**, a propósito | *"el reset es justamente lo que se corre con el Arena apagado"* |
| `/api/arena-shadow` | **no**, a propósito | *"la sombra es lo que se corre ANTES de encender nada"* |
| `/api/arena-smoke` | **no**, a propósito | el smoke es la compuerta |

O sea: la pausa frena exactamente lo que hay que frenar y deja pasar
exactamente los tres endpoints del plan. No hace falta nada más.

**Ojo con una cosa:** `ARENA_ENABLED` es una env var de Vercel, y una env var
nueva **no la ven las funciones ya desplegadas** — hace falta un redeploy para
que tome efecto. Por eso (a) y (b) son el mismo deploy.

---

## 0 · EL ORDEN, QUE ES LA PARTE QUE MÁS FÁCIL SE ROMPE

```
a. ARENA_ENABLED=0 en Vercel   ← LA PAUSA. Mata arena-run Y arena-watch
b. deploy (lleva la pausa + ARENA_SEASON=T3 + el fix del phase)
c. §1.3 · verificar los baselines de la T2 en Neon        ← Lety
d. /api/arena-reset?confirm=1        solo si (c) salió limpio
e. /api/arena-smoke?catalog=1        siete `exact`
f. /api/arena-shadow?agent=<id> × 7  secuencial, sin abortar, reloj_pct < 90
g. lectura de cache_read por agente  (la medición de caché ES el humo)
h. ARENA_ENABLED=1 + deploy          ← la despausa, y la apertura
```

**LA PAUSA ES `ARENA_ENABLED=0`, NO `pauseWatch`.** Ver §0: la pausa que
escribe el reset en Neon solo frena al vigilante y tiene un tope de 120
minutos.

**La pausa y el deploy de la T3 van JUNTOS, en el mismo deploy.** No es
apuro: es que así los dos cambios entran atómicamente. Si el deploy falla,
todo sigue como está (T2, encendido) y no queda un estado intermedio donde la
temporada dice T3 y la liga corre.

---

## 1 · QUÉ SE RE-BASA Y QUÉ SE CONSERVA

Verificado leyendo `api/arena-reset.js` y las funciones que llama, no de
memoria. **El reset no tiene un solo `DELETE`.** Ni un `truncate`. Todo lo que
existe hoy va a seguir existiendo mañana.

### 1.1 · Lo que el reset ESCRIBE (cuatro sitios, y nada más)

| tabla | qué le hace | vía |
|---|---|---|
| `arena_state` | UPSERT por agente: `baseline_at`, `baseline_equity`, `baseline_id`, y limpia el halt | `setBaseline()` |
| `arena_flags` | pausa y despausa el vigilante | `pauseWatch()` / `resumeWatch()` |
| `arena_journal` | **UNA** fila `rules_changed` con `agent_id='league'`, idempotente por id | insert directo |
| `arena_benchmark` | abre el SPY **de la temporada nueva** | `abrirBenchmark()` |

Y afuera de la base, en Alpaca: cancela órdenes abiertas y liquida posiciones a
mercado (`DELETE /v2/positions`) en las siete cuentas.

### 1.2 · Lo que el reset NO TOCA

Verificado con un barrido de `update` / `delete from` / `insert into` sobre
`api/arena-reset.js`: la única escritura literal es el `insert` del anuncio.

| tabla | qué guarda | queda |
|---|---|---|
| `arena_journal` | las 200+ corridas de la T2, con su plan, sus órdenes, su libro y su motivo de fallo | **intacto** (solo se le SUMA una fila) |
| `arena_shadow_journal` | las corridas de sombra | intacto |
| `arena_equity_intraday` | la serie de equity minuto a minuto de la T2 | intacto |
| `arena_aperturas` | las aperturas de posición reconstruidas | intacto |
| `arena_noise_floor` | el piso de ruido diario (coseno) | intacto |
| `arena_spend` | el gasto acumulado | intacto |
| `arena_watch*` (4 tablas) | disparadores, marcas y niveles del vigilante | intacto |
| `arena_universe`, `arena_screener*`, `arena_market_cap`, `arena_buffet_cache` | el universo y sus cachés | intacto |
| `arena_benchmark` | **el SPY de la T2**, reetiquetado con su temporada | **intacto, con su precio y su fecha** |

### 1.3 · EL ÚNICO LUGAR DONDE SE PISA ALGO — y dónde queda la copia

`arena_state` es un UPSERT: **los baselines de la T2 se sobrescriben.** Es la
única pérdida del reset, y no es una pérdida real porque cada reset **sella los
suyos en su propio anuncio**, como dato estructurado y no como prosa:

```
context.accounts[] = { agent, flat, positions_sold, orders_canceled,
                       equity_before, equity_after, baseline_equity,
                       starting_drawdown_pct }
context.season, context.baseline_at, context.baseline_modo
```

O sea: los baselines de la T2 viven en la fila del reset del **2026-09-16**, y
los de la T3 van a vivir en la del reset nuevo.

> **COMPROBACIÓN PREVIA, gratis y obligatoria.** Antes de apretar nada, hay que
> confirmar que esa fila existe y trae los baselines. **Son DOS consultas, y
> el orden importa.**

### PRIMERO: ¿qué filas hay? (sin filtro de id)

La versión anterior filtraba con `id like 'arena-t2-%'`. Si ése no es el
prefijo real, sale vacío — y **vacío ahí son tres cosas distintas que llevan a
acciones opuestas**: no hay fila / hay fila sin baselines / el filtro está mal.
Un `like` que yo escribí de memoria no puede ser lo que decide si hay respaldo.

```sql
-- DESCUBRIMIENTO. Sin filtro de id: mostrá lo que REALMENTE hay.
select id,
       run_date,
       created_at,
       context->>'season'       as temporada,
       context->>'reset_id'     as reset_id,
       context->>'baseline_at'  as baseline_at,
       -- coalesce: si `accounts` no existe, `jsonb_array_length` TRUENA, y
       -- eso es exactamente la falla que esta consulta busca detectar. Una
       -- consulta que revienta ante el caso que investiga no sirve.
       jsonb_array_length(coalesce(context->'accounts', '[]'::jsonb)) as cuentas,
       left(coalesce(plan, ''), 80)                                   as plan
  from arena_journal
 where agent_id = 'league' and status = 'rules_changed'
 order by created_at;
```

**Qué mirar:** la fila del reset del 16-sep, con `cuentas = 7`. Ahí se lee el
`id` REAL, que es lo que se pega en la segunda consulta.

### DESPUÉS: los baselines de esa fila

```sql
-- Reemplazá <ID> por el id que devolvió la consulta de arriba.
select a->>'agent'                      as agente,
       (a->>'baseline_equity')::numeric as baseline,
       (a->>'equity_before')::numeric   as equity_antes,
       (a->>'equity_after')::numeric    as equity_despues,
       a->>'flat'                       as quedo_plana
  from arena_journal j,
       jsonb_array_elements(coalesce(j.context->'accounts', '[]'::jsonb)) a
 where j.id = '<ID>'
 order by 1;
```

**Verde = siete filas, todas con `baseline` no nulo.**

**Rojo —cualquiera de los tres casos— no se aprieta el reset.** El respaldo es
una línea y tarda un segundo:

```sql
create table if not exists arena_state_t2 as select * from arena_state;
select count(*) as filas, count(baseline_equity) as con_baseline from arena_state_t2;
```

### 1.4 · CÓMO SE SELLA LA T2

La T2 no se borra: **se cierra por fecha.** `ARENA_SEASON` ya tiene `start` y
`end`, y todas las consultas de `/liga` filtran por `run_date >=
ARENA_SEASON.start`. Al mover `id`/`start`/`end` a la T3:

- las corridas de la T2 quedan **fuera de la ventana** del leaderboard — no se
  mezclan con las nuevas, que es lo que haría inútil la tabla;
- **siguen en la base y siguen consultables** por fecha;
- el benchmark de la T2 queda en `arena_benchmark` con `season = 'T2'`.

Y el registro (`docs/arena.md`, B40–B45) es la explicación de por qué hubo T3.
Eso es lo que Lety pidió: sellada y etiquetada, no borrada.

---

## 2 · EL SPY Y EL CONTROL SE RE-BASAN EL MISMO DÍA

### 2.1 · El Control ya estaba bien

`control` es uno de los siete de `activeAgents()`, así que el reset lo aplana y
lo re-basa **en el mismo bucle y el mismo instante** que a los otros seis. No
hacía falta nada.

### 2.2 · El SPY **no** estaba bien — era un bloqueador real

`abrirBenchmark()` era idempotente contra una clave global, `benchmark:spy`:

```js
const ya = await leerBenchmark();
if (ya) return { ok: true, ya_estaba: true, ...ya };   // ← salía por acá
```

La T3 habría arrancado midiendo contra un SPY comprado el **16 de septiembre a
$759.42** (131.679439 acciones). Agentes desde un día, referencia desde otro —
exactamente lo que dijo Lety. Y **en silencio**, porque `ya_estaba: true` es un
camino de éxito.

**La idempotencia no se tocó: se le cambió el alcance.** Ahora la clave lleva
la temporada (`benchmark:spy:T3`). Adentro de una temporada sigue siendo
imposible re-abrir a un precio nuevo —que es la garantía que existe para que el
benchmark no mida "desde el último reset"— y una temporada nueva abre su propia
fila.

La fila vieja **migra** a `benchmark:spy:T2` con una migración idempotente que
no recalcula nada: mueve la clave y le pone la temporada. Su `entry`, sus
`shares` y su `opened_at` quedan como están. Es la evidencia de contra qué
corrió la T2.

Y el reset ahora **dice de qué temporada abrió el benchmark**, y si ya existía
lo sube a `warnings` con el remedio escrito:

> `BENCHMARK: ya existía uno para la temporada T2 […]. NO se re-abrió, así que
> las siete cuentas arrancan HOY contra una referencia de ESE día. Si esto es
> una temporada NUEVA, pará: hay que mover ARENA_SEASON.id […] y desplegar
> ANTES del reset.`

Verificado por `tests/arena-benchmark.test.mjs` (sección «la clave lleva la
temporada»).

**Qué mirar en la salida del reset (paso 7):**

```
benchmark.temporada  == 'T3'
benchmark.ya_estaba  == false
benchmark.opened_at  ≈ hoy
warnings             sin la línea de BENCHMARK
```

---

## 3 · CORRIDA DE HUMO, DESPUÉS DE LA RECARGA Y ANTES DE ABRIR

Dos pasos: el catálogo es gratis, el humo cuesta.

### 3.1 · Catálogo (0 tokens)

```bash
curl -s -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://quantdesk2.vercel.app/api/arena-smoke?catalog=1" | jq '.agents[] | {id, slug, match}'
```

**Verde:** los siete con `match: "exact"`. Un `suggested` o un `missing` trae el
`ARENA_MODEL_<ID>=...` listo para pegar en Vercel.

### 3.2 · Humo real, uno por uno (cuesta tokens, NO toca ninguna cuenta)

`/api/arena-shadow` corre **la misma función** que la liga viva
(`runAgenteObjetivo`), con el broker de sombra, cuyas escrituras **lanzan**. Es
de punta a punta —prompt real, tablero real, loop de herramientas real, rieles
reales, órdenes calculadas— y no puede mandar una orden ni por accidente.

```bash
for a in claude control openai grok gemini deepseek qwen; do
  echo "── $a ──"
  curl -s -H "x-admin-key: $ARENA_ADMIN_KEY" \
    "https://quantdesk2.vercel.app/api/arena-shadow?agent=$a" \
  | jq '{agente: .agent, estado: .status,
         herramientas: .context.tools.used, vueltas: .context.tools.turns,
         corto_por: .context.tools.stopped_by,
         reloj_pct: .context.tools.limites.reloj_ms.pct,
         ordenes: (.context.ejecucion.ordenes_calculadas | length),
         costo: .cost_usd, error: .error,

         # ── LA MEDICIÓN, que es la mitad del humo ──────────────────
         # Cuánto tardó CADA vuelta en devolver un cuerpo. Es el número del
         # que depende elegir el techo por llamada, y hasta el 2026-09-29 no
         # se guardaba salvo que el proveedor viniera con nombre — o sea
         # nunca en Anthropic y nunca en un cuerpo vacío.
         lecturas_ms: [.context.tools.vueltas_medidas[]?.ms],
         lectura_max_ms: ([.context.tools.vueltas_medidas[]?.ms] | max),
         techo_ms: ([.context.tools.vueltas_medidas[]?.techo_ms] | max),
         vueltas_vacias: ([.context.tools.vueltas_medidas[]? | select(.vacio)] | length),
         cortes_nuestros: ([.context.tools.vueltas_medidas[]? | select(.reloj_nuestro)] | length)}'
done
```

**La tabla que sale de ahí es la que decide el techo.** No es información de
color: si `lectura_max_ms` de un agente roza el `techo_ms` en una corrida
limpia, ese agente va a morir el primer día lento. Y si lo roza por debajo con
holgura, el techo se puede apretar.

**Criterio de apertura, los siete a la vez:**

| campo | verde | rojo |
|---|---|---|
| `estado` | empieza con `ok_` o es `rejected_rails` | **cualquier `aborted_*`** |
| `error` | `null` | cualquier texto |
| `corto_por` | `end_turn` · `no_tools` · `call_budget` | `cuerpo_vacio` · `error` · `time_budget` |
| `reloj_pct` | < 90 | ≥ 90 (llegó justo, va a abortar un día malo) |
| `costo` | un número | `null` (no sabemos qué gastó) |
| `lectura_max_ms` | **< 60.000** | ≥ 70.000 (a un pelo del techo de 90s) |
| `cortes_nuestros` | 0 | ≥ 1 (nuestro reloj lo cortó aun en una corrida limpia) |

**Si UNO aborta, la temporada no abre.** Se arregla y se vuelve a correr ese
agente. Esto es exactamente lo que no hicimos con la T2 y costó nueve días.

Un agente que aborta con `requires more credits` o `credit balance is too low`
después de la recarga significa que la recarga no llegó a esa cuenta — se mira
el saldo, no el código.

Y un detalle que sale de B43, porque acá aplica: **los siete corren al mismo
tiempo si se lanzan en paralelo.** El `for` de arriba es secuencial a propósito.
Si los siete fallan en el mismo minuto, eso es la cuenta, no los modelos —
esperar cinco minutos y repetir ANTES de tocar nada.

---

## 4 · LAS CUATRO VERIFICACIONES, CON SU COMMIT

Los cuatro están en `main`. Verificado con `git merge-base --is-ancestor`.

| # | qué | commit |
|---|---|---|
| 4a | `minimoParaOtraVuelta() = RESERVA + PISO` — cierra la banda de 70–80s que regalaba vueltas impagables | **`be7c849`** |
| 4b | `client_order_id` con el minuto, en el camino del PM **y** en `submitRiskExits` | **`b309a36`** |
| 4c | La asimetría llave/búsqueda de `liga-libros.js` (`client_order_id \|\| symbol`) — precios visibles | **`9ea5858`** |
| 4d | `COLUMNAS_CORRIDA` importado por los dos escritores, con la prueba que nombra la columna faltante | **`95b7a2c`** |

Pruebas que los cubren, todas en verde:

```
tests/arena-reparto-reloj.test.mjs      (4a) barre la frontera ms a ms
tests/arena-client-order-id.test.mjs    (4b) los dos caminos
tests/arena-pareo-ordenes.test.mjs      (4c) contra legsAOrdenes, no contra un fixture inventado
tests/arena-journal-columnas.test.mjs   (4d) nombra la columna que falta
```

**Comprobación en producción antes de abrir** (después del deploy, gratis):

```bash
curl -s "https://quantdesk2.vercel.app/api/arena-audit?key=$ARENA_ADMIN_KEY" | jq '.build'
```

El `build` tiene que traer el SHA de `main` con los cuatro adentro.

---

## 5 · LA QUERY 4 — `cuerpo_vacio` POR PROVEEDOR

Nunca se corrió y es gratis. Está en
`docs/sql/arena-abortos-2026-09-26.sql`, consulta 4.

**Por qué importa para la T3 y no es arqueología:** en OpenRouter un mismo slug
lo sirven **varias empresas**, y no rinden igual. B23 ya documentó a `Alibaba`
colgándose tres veces seguidas con Qwen mientras las vueltas 1-3 del mismo
modelo habían contestado en 23s, 13s y 32s. Con los datos que publicamos hoy,
**«Qwen es lento» y «el proveedor que le tocó a Qwen es lento» se ven
idénticos** — y se arreglan al revés: el segundo con routing, el primero no se
arregla.

Si la consulta muestra que los `cuerpo_vacio` se concentran en un proveedor, la
T3 tiene que **fijar proveedor por slug** o vamos a volver a medir ruido de
routing y llamarlo modelo. Las perillas ya existen y no necesitan deploy:

```
ARENA_PROVIDER_ORDER_<AGENTE>    preferencia, en orden
ARENA_PROVIDER_IGNORE_<AGENTE>   lista por comas
```

**Lo que me desmentiría:** que los 23 se repartan parejo entre proveedores, o
que el proveedor venga `null` en la mayoría (OpenRouter lo manda dentro del
cuerpo, y el cuerpo es justo lo que no llegó). En ese caso fijar proveedor no
compra nada y no hay que tocarlo.

---

## 6 · CACHÉ DE PREFIJO EN OPENROUTER

Ver `docs/arena-cache-openrouter.md`. Resumen: **no es una sola palanca, son
tres mecanismos distintos**, y aplicar el de Anthropic a los cinco sería
contraproducente en al menos uno.

---

## LO QUE FALTA ANTES DE APRETAR

- [x] `ARENA_SEASON` → T3 · `2026-09-29` → `2026-10-30` · 24 sesiones · **hecho**
- [x] el `phase` hardcodeado de `recordRunSpend` · **hecho**
- [x] Lety recargó las dos cuentas
- [ ] `ARENA_ENABLED=0` + deploy (§0)
- [ ] §1.3 · la fila del reset de la T2 trae los siete baselines
- [ ] §3.1 · catálogo: siete `exact`
- [ ] §3.2 · humo: siete sin abortar
- [ ] §5 · consulta 4 corrida, y decisión sobre fijar proveedor
- [ ] §4 · el `build` de producción trae los cuatro commits
