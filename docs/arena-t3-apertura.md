# T3 · PLAN DE APERTURA

Escrito el **2026-09-29**, ANTES de ejecutar nada. Lo verificado está marcado
como verificado; lo que no pude correr (producción) está marcado como comando
para Lety.

**El reset NO se aprieta hasta que los seis puntos estén en verde, y se
aprieta el MISMO día de la recarga.**

> ## LA PUERTA DEL HUMO, POR ESCRITO Y ANTES
>
> ### LO QUE EL HUMO **NO** PRUEBA — un hueco declarado
>
> `/api/arena-smoke` corre con `"portfolio": "stand_in"`: **$100k en efectivo,
> cero posiciones, sin leer Alpaca.** Es el caso LIGERO, no el pesado.
>
> Yo había dicho que correría con los libros de la T2 cargados. Era al revés.
>
> **No lo invalida, y por una razón concreta:** después del reset, el día 1 ES
> una cartera vacía. El humo representa el día 1 exacto.
>
> **Pero no representa el día 10 con 26 posiciones**, que es un prompt bastante
> más pesado: el libro entra en el contexto, y el contexto es lo que hace
> lentas a las llamadas. Si un agente va a morir por tamaño de prompt, el humo
> no lo va a ver.
>
> **Criterio de apertura, con el hueco adentro:** *verificado para el día 1; la
> carga de un libro lleno NO está probada.* Lo que sí hay para cuando llegue
> ese día: `vueltas_medidas` journalea el tiempo de lectura de cada vuelta en
> cada corrida viva, así que la degradación se ve venir en vez de aparecer como
> un aborto.
>
> *(La corrida de SOMBRA, `/api/arena-shadow`, sí lee el libro real — pero
> después del reset ese libro está vacío, así que tampoco cubre el caso
> pesado.)*

> **El humo NO necesita que se levante el halt.** Verificado en el código y
fijado en `tests/arena-halt-sombra.test.mjs`: el chequeo vive dentro de
`runAgenteObjetivo` pero **atado a `vivo`**, y `/api/arena-shadow` fuerza
`vivo: false` de forma literal. Un freno que existe para que no salgan órdenes
no le aplica a un camino cuyo broker lanza en toda escritura — si le aplicara,
verificar el sistema exigiría desprotegerlo.

**Si UNO de los siete aborta, la temporada NO abre.** Se arregla y se vuelve
> a correr, aunque la apertura se empuje al miércoles.
>
> «Ese ya casi pasaba» es literalmente lo que hicimos con la T2, y costó nueve
> días y una temporada entera. Un agente con `reloj_pct ≥ 90` **no pasó**:
> llegó justo, y va a abortar el primer día malo.
>
> Empujar la apertura un día cuesta una sesión de 24. Abrir con un agente roto
> costó 24 de 24.

---

## 0-bis · CUANDO `ARENA_ENABLED` NO LLEGA: DIAGNÓSTICO PASO A PASO

Escrito el 2026-09-29, después de que la variable no llegara y la liga corriera
un día entero contra los libros de la T2.

### EL ORDEN: CAPTURAR LA EVIDENCIA ANTES DE ARREGLAR

La primera versión de este plan decía *arreglar → redeploy → curl → ver "0"*.
**Estaba mal, y por mi propia norma (B47).** Si la causa era el scope, al
arreglarla el audit dice `"0"` y **ya nunca se sabe cuál de las tres era**:
el testigo se destruye en el mismo acto que lo corrige. La próxima vez que
pase estamos igual de ciegos.

```
1. deploy del código como está          ← trae ?compuertas=1
2. curl ?compuertas=1  →  ANOTAR el valor crudo, tal como venga
3. recién ahí arreglar lo que ese valor señale
4. redeploy sin cache → curl otra vez → "0" y liga_habilitada: false
```

**El paso 2 es el único momento en que existe la evidencia.** Anotarlo no es
burocracia: es la diferencia entre "se arregló" y "sabemos qué falló".

### Lo primero: el juez es el runtime, no el panel

El panel de *Settings* de Vercel dice **qué se guardó**, no **qué ve el código
que está atendiendo**. Son dos cosas distintas y la segunda es la que importa.
Vercel no muestra los valores resueltos de un deployment (por diseño: son
secretos), así que el único testigo confiable es un endpoint.

```bash
curl -s "https://quantdesk2.vercel.app/api/arena-audit?compuertas=1&key=$ARENA_ADMIN_KEY" | jq
```

```jsonc
{
  "build": { "sha": "…" },              // ← ¿es el commit que subiste?
  "compuertas": {
    "liga_habilitada": false,           // ← lo que decide
    "ARENA_ENABLED": "0",               // ← el valor CRUDO
    "lectura": "LA LIGA ESTÁ APAGADA…"
  }
}
```

**`ARENA_ENABLED` crudo distingue las dos fallas**, y por eso se publica el
string y no solo el booleano:

| lo que ves | qué significa | qué hacer |
|---|---|---|
| `"0"` | llegó. Está apagada | nada, seguí |
| `null` | **la variable NO EXISTE en este deployment** | el scope, paso 1 |
| `"1"` | existe con el valor viejo | el deployment, paso 2 |

Sin `?compuertas=1` desplegado todavía, `curl -s .../api/arena` da `enabled`
(el booleano) y alcanza para saber si está frenada, pero no distingue `null`
de `"1"`.

### Paso 1 · El valor crudo YA te dijo cuál es — ahora se arregla

Con el valor del paso 2 anotado, cada rama tiene UNA causa y UN arreglo. No
hace falta recorrer los tres pasos: se va directo al que el valor señala.

#### Si dio `null` → el SCOPE (la causa más probable)

En Vercel una variable existe **por entorno**: Production, Preview,
Development. Se marcan con casillas al crearla, y es fácil guardar una en
Preview creyendo que es global.

1. **Project → Settings → Environment Variables**
2. buscá `ARENA_ENABLED`
3. mirá la columna **Environments** de esa fila

**Tiene que decir `Production`.** Si dice solo `Preview` o `Development`, ésa
es la causa: la producción nunca la tuvo. Se edita la fila, se marca
Production, se guarda — **y hace falta redesplegar**, porque el valor se
resuelve cuando el deployment se construye.

#### Si dio `"1"` → el DEPLOYMENT o el build cache

La variable existe con el valor viejo, así que el scope está bien y la
pregunta es si el deployment que responde es posterior al guardado.

1. **Project → Deployments**
2. el que tiene la etiqueta **Current** / **Production** es el que contesta
3. mirá su **hora** y comparala con la hora en que guardaste la variable

**Si el deployment es ANTERIOR al guardado, ésa es la causa.** Un valor
guardado después de que el build arrancó no entra en ese build. El arreglo es
**Redeploy** — y con la casilla *"Use existing Build Cache"* **desmarcada**, o
el build puede reusar artefactos con el valor viejo.

#### Si el `build.sha` no es el tuyo → es otro deployment

Poco frecuente pero pasa, y es el que más tiempo cuesta:

- el dominio `quantdesk2.vercel.app` puede estar apuntando a otro proyecto o a
  otro deployment promovido a mano;
- **Project → Settings → Domains** dice a qué apunta;
- el `build.sha` de la respuesta del curl contra el SHA de `main` lo confirma
  de un lado y del otro. Si el SHA no es el que subiste, estás mirando otro
  deployment y todo lo demás es ruido.

### Y el orden, una vez arreglada

```
guardar la variable (con Production marcado)
  → Redeploy SIN cache
  → curl ?compuertas=1
  → ARENA_ENABLED: "0" y liga_habilitada: false
  → recién ahí, quitar el halt
```

> **Nunca al revés.** El halt de la base es hoy el único freno que funcionó, y
> es el único que no depende de que un deploy llegue: vive en Neon y lo lee la
> función que decide. Quitarlo antes de que la compuerta de arriba conteste
> `false` es quedarse sin ningún freno verificado.

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

### HOY MIÉRCOLES 30, DESPUÉS DEL CIERRE (16:00 ET / 14:00 MTY)

**El halt se queda puesto TODO el tiempo.** El humo no lo necesita levantado
(§3).

```
a. deploy del código como está       ← trae ?compuertas=1 y la key rotada
b. curl ?compuertas=1 → ANOTAR el valor crudo    ← la evidencia, §0-bis
c. arreglar lo que ese valor señale → redeploy sin cache → curl → "0"
d. §1.3 · los baselines de la T2 en Neon
e. /api/arena-smoke?catalog=1        siete `exact`
f. /api/arena-shadow?agent=<id> × 7  secuencial, CON la tabla de lecturas
g. lectura de cache_read por agente
```

### MAÑANA JUEVES 1-OCT, EN LA APERTURA

```
h. /api/arena-reset?confirm=1        aplana, re-basa y compra el SPY
i. quitar el halt                    update arena_state set halted = false
j. abre
```

El reset y el SPY van juntos por construcción, y los dos en el mismo instante
que se levanta el halt: es lo único del plan que no se puede partir.

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

> #### ESTA TABLA ES EL DIAGNÓSTICO DE **UNA** CORRIDA, NO LA PUERTA (2026-10-02)
>
> Las dos tandas del 1 y del 2 de octubre dieron 5 de 7 y 5 de 7 — y **no los
> mismos cinco por las mismas razones**. Con una corrida por agente no hay
> forma de separar "este modelo no sirve" de "este minuto no sirvió".
>
> **La puerta es `scripts/arena-humo.sh` (§3.3): tres corridas por agente, con
> el criterio sobre las tres.** Los umbrales de abajo siguen valiendo —son los
> que se leen fila por fila— pero el veredicto por agente sale de las tres.
>
> Y el `jq` de arriba lee `.context.*`, que sólo existe en las corridas que
> salieron bien. Desde el 2026-10-02 las **tres** salidas (éxito y los dos
> abortos) devuelven el bloque `loop` con las mismas claves:
> `.agents[0].loop.vueltas`, `.cortó_por`, `.reloj_pct`, `.lectura_max_ms`,
> `.vacias`, `.cortes_nuestros` — más `.agents[0].lectura_cierre`, que es el
> campo que separa un JSON **cortado** de un JSON **malo**. Usá ésos: son los
> que el script lee, y existen también cuando el agente abortó.

**Criterio por corrida (los umbrales que lee cada fila):**

| campo | verde | rojo |
|---|---|---|
| `estado` | empieza con `ok_` o es `rejected_rails` | **cualquier `aborted_*`** |
| `error` | `null` | cualquier texto |
| `corto_por` | `end_turn` · `no_tools` · `call_budget` | `cuerpo_vacio` · `error` · `time_budget` |

> #### `call_budget` CUENTA COMO COMPLETA — y por qué no es lo mismo que `end_turn`
>
> En la tanda del 1-oct, grok y ChatGPT cortaron por `call_budget` con 20/20
> fichas usadas. **Los dos entregaron libro, así que pasan la puerta.**
>
> Pero no es el mismo hecho que `end_turn`, y conviene saber la diferencia
> porque se leen igual en `estado: ok_target`:
>
> | corte | qué significa |
> |---|---|
> | `end_turn` | el modelo **decidió** que ya tenía suficiente |
> | `call_budget` | el modelo **seguía trabajando** y lo cortó nuestro tope de 20 fichas |
> | `time_budget` | seguía trabajando y lo cortó el reloj |
>
> `end_turn` es una decisión del modelo; los otros dos son topes nuestros. Un
> agente que corta siempre por `call_budget` está diciendo que 20 herramientas
> no le alcanzan — es un dato sobre el tope, no sobre el agente, y vale
> mirarlo si se repite varios días.
>
> **Lo que sí sería rojo:** `call_budget` SIN libro (`rejected_rails` o un
> `aborted_*`). Ahí el tope se comió la corrida.
| `reloj_pct` | < 90 | ≥ 90 (llegó justo, va a abortar un día malo) |
| `costo` | un número | `null` (no sabemos qué gastó) |
| `lectura_max_ms` | **< 90.000 en TODAS las vueltas** | ≥ 90.000 en cualquiera |
| `cortes_nuestros` | 0 | ≥ 1 (nuestro reloj lo cortó aun en una corrida limpia) |

> ### EL TERCER CRITERIO, Y QUÉ SE HACE SI FALLA
>
> **Ningún agente con una lectura de cuerpo arriba de 90s en ninguna de sus
> vueltas.** No es el promedio ni la mediana: **el máximo**, porque una sola
> vuelta que se pasa mata la corrida entera.
>
> Con el techo ahora aplicado en 90s, un agente que tarda más **muere
> sistemáticamente** — bien etiquetado como corte nuestro, pero muerto. Y eso
> no se descubre en el humo si el humo solo dice pasó/falló.
>
> **Si DeepSeek falla este criterio, la decisión NO es "abrimos igual".** Es
> una de estas dos, y las dos se declaran:
>
> | opción | cómo | costo |
> |---|---|---|
> | **subirle el techo a él** | `ARENA_LLM_TIMEOUT_MS` más alto — **sin deploy** (acepta 5s–280s) | deja de ser el mismo parámetro para los siete: es un confound y va al anuncio |
> | **abrir con seis** | sacarlo de `activeAgents()` | la liga no es de siete y el tablero lo dice desde el día 1 |
>
> Un techo distinto por agente **no es trampa si está declarado** — es lo mismo
> que ya hacemos con `caps.cache` y con `sampling`, que difieren por familia y
> salen publicados. Lo que no se puede es que difiera y no se diga.

**Si UNO aborta las tres veces, la temporada no abre.** Se arregla y se vuelve
a correr ese agente. Esto es exactamente lo que no hicimos con la T2 y costó
nueve días.

Un agente que aborta con `requires more credits` o `credit balance is too low`
después de la recarga significa que la recarga no llegó a esa cuenta — se mira
el saldo, no el código.

Y un detalle que sale de B43, porque acá aplica: **los siete corren al mismo
tiempo si se lanzan en paralelo.** El `for` de arriba es secuencial a propósito.
Si los siete fallan en el mismo minuto, eso es la cuenta, no los modelos —
esperar cinco minutos y repetir ANTES de tocar nada.

---

### 3.3 · LA PUERTA: TRES CORRIDAS POR AGENTE

```bash
set -a && . ./.env.local && set +a      # ARENA_ADMIN_KEY, que nunca viaja en la URL
bash scripts/arena-humo.sh              # 21 corridas, ~50 min, secuencial
```

**El criterio, fijado antes de medir** (y el script lo imprime antes de la
primera fila — un umbral que aparece junto al resultado es un umbral que se
puede haber elegido mirándolo):

| libros entregados | puerta |
|---|---|
| 3 de 3 | **VERDE** |
| 2 de 3 | **ÁMBAR** — no abre sola: la decide Lety mirando el error de esa corrida |
| ≤ 1 de 3 | **ROJO** |

**"Entrega libro" = el `status` NO empieza con `aborted`.** Eso incluye
`rejected_rails`: un objetivo que los rieles rechazan es un modelo que SÍ
entregó un portafolio parseable y un riel que hizo su trabajo. La puerta
pregunta si el harness saca una decisión del modelo, no si la decisión gustó.

**Abre sólo con los siete en VERDE** y las cuatro puertas físicas en verde
(`reloj_pct < 90`, `lectura < 90.000 ms`, cero cortes nuestros, cierre sin
truncar). Esas cuatro **no se votan**: un solo desborde en una corrida de 21 es
un desborde que puede repetirse cualquier día de la temporada.

**Ronda, no ráfaga.** Las tres de un agente no van seguidas: ronda completa de
los siete y después la siguiente. B43 al revés — si las tres de qwen cayeran
dentro del mismo apagón de Alibaba, qwen saldría ROJO por un minuto malo, que
es justo lo que las tres corridas existen para separar.

**Dos columnas nuevas, y las dos mandan a lugares distintos:**

| columna | qué leer |
|---|---|
| `TRUNC` | `SÍ` = el cierre se **cortó** (nuestro `ARENA_MAX_TOKENS`). `no` = el modelo cerró el turno solo, así que un JSON roto es del modelo. `?` = **no se sabe**: el proveedor no mandó `finish_reason`. Un `?` no es un "no". |
| `REINT` | `—` sin reintento · `RESCATÓ:corte` (nuestro techo lo salvó: subir `ARENA_MAX_TOKENS`) · `RESCATÓ:formato` (hallazgo del agente) · `falló` · `omitido` (no le quedó reloj — se lee junto con el veredicto, ver abajo) |

En el veredicto, **`SIN_AYUDA`** es cuántos de los 3 entregaron sin reintento.
Un `3/3 VERDE` con `SIN_AYUDA 2/3` se lee distinto de un `3/3` limpio, y el
criterio **no cambia** por eso: lo decide quien mira.

**Reimprimir sin volver a gastar:**

```bash
REUSAR=./humo-20261002T140000Z bash scripts/arena-humo.sh
```

Rearma la tabla y los veredictos desde las respuestas ya guardadas, sin pedir
una sola llamada. 21 corridas son ~50 minutos y dinero: si el formato de la
tabla está mal, arreglarlo no puede costar otra tanda.

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

## ROTAR `ARENA_ADMIN_KEY` — y por qué no me la pasás

La key vieja está pegada en el chat varias veces. Vamos a dejar endpoints de
administración vivos un mes, así que se rota en el deploy de hoy.

**Nadie la escribe en ningún lado, y yo no la necesito.** Los comandos de este
runbook usan `$ARENA_ADMIN_KEY`, nunca el valor.

```bash
# 1 · generala en TU terminal (el espacio inicial la deja fuera del historial
#     en bash/zsh con HIST_IGNORE_SPACE; si no, borrá la línea después)
 openssl rand -hex 32

# 2 · Vercel → Settings → Environment Variables → ARENA_ADMIN_KEY
#     pegar · marcar Production · Save
# 3 · Redeploy (sin build cache)

# 4 · bajarla a tu máquina sin volver a escribirla
vercel env pull .env.local       # queda ignorada por git (se agregó hoy)
set -a && . ./.env.local && set +a
curl -s "$BASE/api/arena-audit?compuertas=1" -H "x-admin-key: $ARENA_ADMIN_KEY" | jq
```

**Usá el header `x-admin-key`, no `?key=`.** Los tres métodos son
equivalentes para el endpoint, pero un query param queda en los access logs de
Vercel, en el historial del shell y en el Referer si el link se comparte. El
header no. (El endpoint nunca imprime la key: el 401 dice qué llegó y por
dónde, nunca el valor — verificado en `_lib/arena-admin.js`.)

**`.gitignore` ya cubre `.env*`** — se agregó hoy, antes de la rotación, porque
`vercel env pull` escribe ahí y un secreto commiteado no se borra con un
`git rm`.

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
