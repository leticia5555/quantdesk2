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

## Plan de temporadas (qué entra cuándo, y qué no)

La liga corre por **temporadas acotadas** (`ARENA_SEASON` en
`_lib/arena-registry.js`): 4 semanas de mercado, apertura en lunes, cierre en
**viernes** —para que exista la corrida que declara al ganador— y ranking por
equity con el return vs. baseline al lado. Una liga sin final es una foto sin
consecuencia: el "líder" de hoy no significa nada si la ventana nunca se cierra.

| Temporada | Qué habilita | Estado |
|---|---|---|
| **T2** | **Long-only + el reglamento de 9 reglas** de abajo. Liga completa (7 agentes) desde el día 1. | **En curso** (2026-09-14 → 2026-10-09) |
| **T3** | **El octavo agente europeo (Mistral, `house: 'eu'`)**. Los cortos ya NO son de la T3: entraron a la T2 el 2026-09-18 por la decisión D8, que estaba cerrada desde el 2026-09-15 y que el reglamento v4 contradijo por un error de redacción. Ver el anuncio `arena-cortos-t2-2026-09-18`. | Planeada |
| **T4 — o nunca** | **Opciones.** Condición previa e innegociable: **una fuente de datos real** (cadena, griegas, IV, vencimientos). Sin esa fuente NO se hace: un libro de opciones sobre precios inventados no es un experimento, es una demo. | Condicional |

**Por qué el orden importa.** Cada temporada cambia el reglamento, y un cambio
de reglamento parte la serie: por eso `PROMPT_VERSION` sube con la temporada y
el cambio se anuncia en el journal con fecha. Meter short y opciones dentro de
la misma temporada haría imposible atribuir un resultado a nada.

### Pendiente T3 · El octavo agente: Mistral, `house: 'eu'`

Decidido el 2026-09-17: **entra en la T3, no en la T2.** La razón no es técnica.
Un agente que arranca a mitad de temporada no corre la misma ventana que los
siete, así que su return no es comparable con el de ellos — y un ranking que los
pone en la misma tabla sin decirlo miente. O entra con la temporada, o `/liga`
tiene que publicar "entró el día N" al lado de su número para siempre.

Lo que hace falta cuando llegue el momento, además de la cuenta paper:

1. **Entrada en el registry** (`_lib/arena-registry.js`): id, nombre,
   `provider: 'openrouter'`, slug, `model_label`, `phase`, y **`house: 'eu'`**.
2. **`house: 'eu'` toca más que el registry.** Hoy la casa es `us`/`china` y de
   ahí salen la etiqueta del tablero (`leaderboard.html`), la descripción
   pública ("IAs chinas vs americanas") y la narrativa entera. Agregar una
   tercera casa **cambia el titular del experimento**, y eso es una decisión de
   producto antes que de código.
3. **`ALPACA_MISTRAL_KEY` / `_SECRET`** en Vercel.
4. **La sombra primero**, como los siete: nadie entra a la liga sin una corrida
   en sombra que pase los rieles.
5. **El costo**: un octavo agente es ~14% más de gasto diario contra el mismo
   techo de `ARENA_DAILY_BUDGET_USD`. O sube el techo, o los ocho corren con un
   presupuesto por cabeza más chico — y eso, si no se declara, se lee como que
   un modelo investigó menos porque quiso.
6. **El slug exacto** hay que leerlo del catálogo de OpenRouter en su momento
   (familia `mistralai/…`). No se escribe de memoria: un slug inventado es
   justamente lo que el candado de `modelSlugResolved` existe para frenar.

### Pendiente · `YOUR LENS TODAY` → `YOUR FOCUS TODAY` en el prompt

Decidido el 2026-09-16, al cambiar el término viejo por **enfoque** en toda la UI y
los reportes: el prompt de los agentes **no** se tocó en ese PR. Dice
`YOUR LENS TODAY`, está en inglés y no contenía la palabra en español, así que
cambiarlo no era parte del renombre — habría sido cambiar el experimento por un
motivo de traducción, y la víspera del encendido del contrato objetivo.

**Cuándo:** cuando el contrato nuevo lleve varias rondas vivas estables. No
antes.

**Qué toca, y por qué no es una sola línea:**

1. La línea en `_lib/arena-herding.js` (`YOUR LENS TODAY: ${enfoque.prompt}`).
2. **Es un cambio de prompt, o sea del experimento.** Viaja en la cola NO
   cacheada, así que no invalida el prefijo de caché — pero sí cambia el texto
   que los siete leen. Los libros de antes y los de después no son estrictamente
   la misma condición.
3. Por eso se anuncia como `rules_changed` con fecha, como cualquier cambio de
   reglamento, aunque sean dos palabras. Un cambio de prompt sin anuncio es
   exactamente lo que hace inatribuible un cambio de resultado.
4. `tests/vocabulario-mx.test.mjs` fija hoy que `YOUR LENS TODAY` siga ahí. Esa
   aserción se actualiza en el mismo PR, con el motivo escrito — no se borra.

> **El cambio de cadencia (2026-09-15) NO es una temporada nueva.** Las 9 reglas
> de la T2 siguen vigentes, completas, en cada corrida; lo único que cambió es
> **cuándo** se corre. Por eso se anuncia como `rules_changed` dentro de la T2 y
> no consume la etiqueta **T3**, que sigue reservada para el short. Ver la
> sección de abajo.

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

### Addendum de la liga (2026-09-14): voz, crónica y temporada

Tres piezas de **datos** — sin UI ni notificaciones todavía, a propósito:
primero el backend estable y auditable, el resto después sin rehacerlo.

**1. El titular (`_lib/arena-voice.js`).** Cada agente publica por corrida UNA
línea en español con la voz de su **arquetipo** (fijo por modelo, en el
registry; el control es *el escéptico que no cree en nadie*).

> **EL CANDADO:** el arquetipo **JAMÁS** entra al prompt que DECIDE. El titular
> se genera en una llamada APARTE y POSTERIOR, que recibe el plan y las órdenes
> ya decididas y solo las narra. El motivo no es estético: `claude` y `control`
> son el mismo modelo con el mismo prompt y distinta cuenta, y ese prompt
> byte-idéntico es lo único que hace del control un piso de ruido válido
> (decisión #5 del scope). Meter *"eres el escéptico"* en el DIVE del control lo
> convertiría en otro agente y borraría la única medición que dice cuánto del
> delta entre modelos es ruido. `tests/arena-voice.test.mjs` lo blinda.

El titular vive en `context.headline`, **no** en la columna `plan` — que es la
que alimenta el `PREVIOUS PLAN` de la corrida siguiente. Narrar no puede
contaminar el próximo juicio. Best-effort: si la llamada falla, `headline: null`
y la corrida sigue igual. Apagable con `ARENA_HEADLINES=0`.

**2. `/api/liga/eventos`** (`api/liga-eventos.js`, reescritura en `vercel.json`;
el archivo va plano porque el glob `api/*.js` de `functions` no alcanza a los
anidados). Feed público de solo lectura con cuatro tipos: `compra`, `venta`
(del PM o de la red determinista, con su `origen`), `rechazo` (con la razón
verbatim y el motivo clasificado: `guard` / `precedencia_riesgo` / `supresion`)
y `cambio_lider`. Mismas restricciones que `/api/arena-audit`: puros `SELECT`,
sin `ensureSchema()`, sin `beat()`, y del `context` se proyecta **solo** el
titular. Params: `?dias` `?agente` `?tipo` `?limit`.

Un día con **un solo** agente reportando equity no genera cambio de líder
—sería un liderazgo falso— y el primer día medible se marca `arranque`, no
"cambio".

**3. La temporada (`ARENA_SEASON` en el registry).** Ventana con `start`, `end`
y `weeks`; el **último día** el orquestador journalea el cierre
(`status='season_winner'`, `agent_id='league'`, id idempotente) con el ranking
por equity, el return vs. baseline y los caveats de siempre. Un agente sin
equity no se rankea ni recibe un cero: sale aparte, nombrado. Sin nadie con
equity, **no se declara un ganador inventado**.

## Cambio de cadencia: del cron nocturno al modelo POR EVENTO (2026-09-15)

Hasta el 14 de septiembre el Arena era un experimento de **una decisión al día**:
el cron de las 22:40 UTC corría la liga con el mercado ya cerrado, las órdenes
descansaban hasta la apertura siguiente, y si NVDA se caía 9% a las 10:15 el PM
se enteraba doce horas después. Desde el **martes 15** eso se invierte: un
**vigilante sin LLM** mira el mercado cada 5 minutos y despierta al agente
**solo cuando pasa algo que le concierne**.

**El lunes 14 queda del lado viejo del corte, a propósito:** es el día 1 de la
Temporada 2 y la única corrida end-to-end de las siete cuentas Alpaca, de
OpenRouter y del reglamento v3-t2 completo antes de estrenar el vigilante.
Estrenar la cadencia nueva encima de un harness que nunca corrió entero
mezclaría dos estrenos — si algo fallara, no se sabría cuál de los dos fue.

El corte se anuncia en el journal con `status='rules_changed'`,
`agent_id='league'` e id `arena-cadencia-evento-2026-09-15` — idempotente, con la
**fecha del corte y no la del deploy**. Sin ese corte el post-mortem compararía
una decisión diaria post-cierre contra N decisiones intradía como si fueran la
misma población.

**Lo que NO cambia:** las 9 reglas de la T2, el guard, el registry, la
temporada, el control como piso de ruido, y el hecho de que los **siete corran
el mismo harness**. El vigilante no distingue entre agentes: mismos umbrales,
mismos topes, mismo camino — si tratara al control distinto, la liga perdería su
única referencia.

| # | Regla de cadencia | Dónde vive |
|---|---|---|
| 1 | **Se retira el cron nocturno** (y la matutina post-earnings) | gate por fecha ET en `runArenaLeague` / `runArenaMorning` → fila `skipped_superseded_by_watch` |
| 2 | **Vigilante sin LLM cada 5 min** en horario de mercado, vía Alpaca | `/api/arena-watch` + `_lib/arena-watch.js` (JS puro) |
| 3 | **Seis disparadores** despiertan al dueño de la posición | `evaluateTriggers` |
| 4 | **Todo disparador se journalea** con su razón, dispare o no | tabla `arena_watch` + feed `/api/liga/eventos?tipo=disparador` |
| 5 | **Corrida acotada** al ticker que disparó, reglamento completo, órdenes **marketable que ejecutan ya** | `eventPolicy('watch_trigger')` + `validateActions({intraday:true})` |
| 6 | **Revisión de piso** a la apertura +30 min para el que nadie tocó | `floorReviewDue` + `eventPolicy('watch_floor')` |
| 7 | **Topes**: 12 corridas/agente/día y 20 min de cooldown por ticker | `applyCaps` |
| 8 | **La red determinista no se mueve**: sigue decidiendo con cierres completos, 1×/día | `runArenaRiskNet` (sin LLM) |

### Los seis disparadores

| Disparador | Umbral | Re-armado |
|---|---|---|
| `move_since_pronouncement` | ≥ **±3%** desde el último pronunciamiento del agente sobre ese nombre | **Contra la marca**: se re-fija cada vez que el agente habla, así hacen falta otros 3% |
| `near_trailing` | a **≤2 puntos** del nivel del trailing **armado** | Sticky: 1×/nombre/día |
| `near_catastrophic` | a **≤2 puntos** del stop catastrófico | Sticky: 1×/nombre/día |
| `event_earnings` | reporta **hoy** (BMO o AMC) | Sticky: 1×/nombre/día |
| `event_8k` | **8-K** con fecha de aceptación de hoy (SEC EDGAR) | Sticky: 1×/nombre/día |
| `volume_spike` | volumen del día ≥ **3×** el promedio de 20 sesiones | Sticky: 1×/nombre/día |
| `buffet_move` | un **candidato del buffet** (que NO tiene) se movió ≥ **±5%** | Contra la marca |

**La MARCA (`arena_watch_mark`)** es el ancla del ±3%. Si el agente todavía no se
pronunció sobre ese nombre, el ancla es el **cierre anterior** — que es
exactamente el número que tuvo enfrente en su última corrida. Así el disparador
funciona desde el primer tick del primer día, sin un periodo ciego de "sembrando
marcas" y sin inventar un precio.

**Sticky vs. re-armable** es el candado anti-quema de tokens. Un hecho del día
(earnings, 8-K, volumen, cercanía a un stop) sigue siendo verdad todos los ticks
que quedan de la sesión: si disparara libre, un día loco consumiría las 12
corridas en una hora. Los dos de precio no son sticky porque su condición se
consume al pronunciarse.

**`buffet_move` es el único disparador sin dueño.** Un candidato que no está en
ningún libro no le pertenece a nadie, así que despierta a **todos** los agentes
que no lo tengan — la oportunidad es de la liga. Si un agente sí lo tiene, es una
posición y manda el #1, con su umbral más bajo.

### Agrupación: un tick, una corrida

Si en el mismo tick disparan dos nombres del mismo agente, se corre **una sola**
corrida acotada a los dos, no dos corridas. Sigue siendo "acotada a los tickers
que dispararon" —el slate del evento son exactamente ellos, y toda acción fuera
de él se descarta y se journalea— pero cuesta un prompt y **una** de las 12
corridas. Lo contrario premiaría la volatilidad con gasto, que es justo lo que
los topes existen para evitar.

### Ejecución intradía: la compra TAMBIÉN se re-precia

La T2 #5 ya mandaba las ventas a marketable limit. Con el mercado abierto y la
orden obligada a ejecutar **en el momento**, la compra tiene el mismo problema al
revés: un límite pasivo por debajo del mercado no ejecuta, **descansa** hasta que
expira. Así que en una corrida del vigilante:

- **compra** → referencia × (1 + `intraday_buy_band`, 4%), por **arriba**;
- **venta** → referencia × (1 − `discretionary_sell_band`, 4%), por **abajo**;
- **referencia = el precio VIVO de Alpaca**, no el cierre de ayer — y el mismo
  número en los tres lugares: lo que ve el PM, lo que valida la banda ±2% del
  guard, y lo que precia el envío. Sin eso, un nombre que ya subió 4% desde el
  cierre tendría toda orden descartada por "fuera de banda": el guard rechazaría
  precisamente las corridas que esta cadencia existe para producir.

Sigue siendo una orden **LÍMITE day** (cicatriz Polymarket: jamás market
orders). La banda no es el precio esperado del fill —el libro llena en el NBBO—
es el **tope de deslizamiento** aceptado. Todo queda journaleado por orden:
`limit_price_proposed`, `repriced: 'marketable_buy'|'marketable_sell'`,
`exit_band`.

### Costo en el peor caso — CALCULADO, no estimado a mano

`GET /api/arena-watch?estimate=1` lo publica y `tests/arena-watch.test.mjs` lo
verifica, así que no puede envejecer en un doc. El peor caso **absoluto** es que
los siete quemen sus 12 corridas todos los días y toda respuesta llegue al techo
de tokens:

| | |
|---|---|
| Corridas/agente/día | 12 (tope duro) |
| Llamadas al LLM por corrida | **2** (DIVE + titular). El SCOUT **no** corre: el disparador ya eligió el slate |
| Tokens por corrida (techo) | ~6,600 in / ~3,100 out |
| Llamadas al LLM del vigilante | **0** |
| **Peor caso, los 7** | **≈ $0.91/día · ≈ $19/mes** (21 sesiones) |

Un día normal son 1-3 corridas por agente, así que el gasto real esperado ronda
**$0.10-0.25/día** — comparable al del cron nocturno que sustituye, que gastaba
3 llamadas (SCAN + DIVE + titular) × 7 agentes todos los días corriera o no algo.
El tope de 12 es lo que convierte "podría dispararse mucho" en un número acotado
que se puede presupuestar.

### La red determinista NO se volvió nerviosa

Breaker, stop catastrófico y trailing **siguen decidiendo con cierres completos,
una vez al día**, ahora en el **primer tick de la sesión** (`runArenaRiskNet`,
cero tokens). En el primer tick y no en el de la revisión de piso porque el dato
con el que deciden es el cierre de **ayer** —exactamente el que tenía la corrida
nocturna—, así que esperar media hora solo retrasaría el fill sin mejorar la
decisión: un stop que disparó se ejecuta ~9:35 ET, tan cerca de la apertura como
la orden `day` de la cadencia vieja llenaba a las 9:30. No es una limitación pendiente de arreglar: **es la regla** (ver
`_lib/arena-exits.js` — sistemas de fin de día, el gap es costo inevitable). Un
stop intradía sería un stop *apretado*, justo lo que Kaminski & Lo desaconsejan
y lo que este libro decidió no usar. Lo intradía es que el **PM** pueda
reaccionar **antes** que la red (disparadores `near_trailing` /
`near_catastrophic`), no que la red opine más seguido.

> Extraer la red de la corrida nocturna era **obligatorio**, no una mejora: vivía
> dentro de `runArenaDecide`, y retirar ese cron se la habría llevado con él. El
> libro se habría quedado sin stops y nadie lo habría notado hasta el primer
> desastre.

### Freno de mano

Dos variables de Vercel, sin deploy: `ARENA_WATCH_START` mueve (o retrasa) el
corte de cadencia, y `ARENA_WATCH_ENABLED=0` apaga solo el vigilante sin apagar
el Arena. Los crons nocturnos siguen desplegados y latiendo: volver al modelo
viejo es cambiar una fecha.

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

## B13 · LA SOMBRA · B10 · EL PROMPT DEL CONTRATO NUEVO

`_lib/arena-shadow.js` · `/api/arena-shadow` · el prompt en
`buildTargetSystemPrompt` · tests en `tests/arena-sombra.test.mjs`

El contrato nuevo (B5: portafolio objetivo) **no puede estrenarse contra siete
libros reales**. La sombra lo corre con el mismo tablero, las mismas
herramientas y el mismo mercado — y **cero órdenes**.

```bash
# El reporte del día — gratis, cero tokens.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-shadow?report=1" | jq

# La corrida en sombra (esto SÍ gasta).
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-shadow" \
  | jq '{verdict, cost_usd, orders_placed, agents: [.agents[] | {agent, status, lens, tools_used, would_place, turnover, cost_usd}]}'
```

### Las dos condiciones, y las dos son estructurales

**1 · Tablas aparte, no una columna.** `arena_shadow_journal`, no un `shadow
boolean` en `arena_journal`. Una bandera en la misma tabla está a **una consulta
mal escrita** de contaminar el post-mortem: basta que alguien olvide un
`where shadow = false` **una vez** y las métricas de la temporada quedan
mezcladas para siempre, sin que nada falle a la vista.

Con tablas separadas esa consulta no devuelve datos de sombra — devuelve nada.
El modo de falla pasa de *silencioso y permanente* a *ruidoso e inmediato*.

**2 · La sombra gasta dinero de verdad.** Son llamadas reales a siete
proveedores. Va contra el **mismo** `ARENA_DAILY_BUDGET_USD` y se registra con
`phase='shadow'`. "La sombra es gratis" sería una creencia que se desmiente con
la factura.

### El candado de las órdenes

No alcanza con *no llamar* a `createLimitOrder`: alcanza con que **no se pueda**.
`shadowBroker()` devuelve un objeto con la misma forma que el cliente de Alpaca
donde **toda escritura lanza**. Las **lecturas sí pasan** — sin el libro real, un
rebalanceo contra un libro inventado no prueba nada.

Si algún camino intentara mandar una orden en sombra, la corrida falla
**ruidosamente** en vez de operar en silencio sobre una cuenta real. Hay lints
que verifican que el endpoint solo use el cliente envuelto y que nunca escriba
en la tabla real.

### La metadata por nombre que los rieles leen (`_lib/arena-meta.js`)

Durante un tiempo la sombra le pasó `meta = {}` a `validateTarget`, y con el mapa
vacío pasaban dos cosas — una dicha y otra no:

- **R9 rechazaba todos los cortos.** Correcto como regla (fail closed), pero como
  estado *permanente* convertía el riel en una mordaza: la sombra no podía decir
  nada sobre cómo cortan los siete modelos.
- **R6 rechazaba casi todo, y eso no saltaba a la vista.** Sin sector, los
  nombres caen al bucket `UNKNOWN`, que suma el bruto entero: cualquier cartera
  de más del 50% bruto violaba un tope de concentración sectorial calculado sobre
  un único sector que la ausencia de datos había inventado.

Ahora los cuatro campos se resuelven sobre **los símbolos que el objetivo nombra**
(unidades, no centenas):

| Campo | Fuente | Por qué ésa |
|---|---|---|
| `shortable` · `easy_to_borrow` | Alpaca `/v2/assets/{symbol}` | Es la **misma** fuente que va a aceptar o rechazar la orden. Preguntarle a otro sería validar contra una opinión distinta de la que manda |
| `price` | snapshots de Alpaca | Una llamada multi-símbolo |
| `sector` | `finnhubIndustry` → los 11 ETFs del tablero | — |

**El mapeo de industria a sector es por reglas, no por tabla cerrada.** La
taxonomía de `finnhubIndustry` no es GICS y no está congelada. Una tabla exacta
se desactualiza en silencio y manda todo lo nuevo a `UNKNOWN` sin que nadie lo
note. Es una lista **ordenada** de reglas, y el orden es el test: `Biotechnology`
tiene que ganarle a `Technology` aunque contenga `technolog` — la misma familia
de bug que *"Broker upgrades NVDA to Buy"* cayendo en el patrón de fusiones.

**Nada de esto afloja un riel.** Un nombre sin fila de Alpaca llega **sin** los
campos, R9 lo lee como "sin dato" y lo rechaza igual. Lo que cambió es que dejó
de rechazarlos a *todos* por igual. Y un nombre que falló **no se cachea como "no
shortable"**: eso volvería permanente un fallo de red.

**Caché por día** (`assets:borrow`, `assets:sector`, misma tabla que los canales
lentos del buffet): `easy_to_borrow` lo recalcula Alpaca una vez al día a la
apertura, y la industria de una empresa cambia cada varios años. Sin caché serían
21 consultas diarias (3 rondas × 7 agentes) por un dato que cambia una vez.

`diagnostics` viaja con el resultado: cuántos nombres tienen cada campo, **cuáles**
quedaron sin borrow y **cuáles** sin sector. Sin eso, una cartera rechazada por R6
no se distingue de una cartera concentrada de verdad.

### B10 · El prompt

Mismo prompt, mismos parámetros por familia, mismo tablero y mismas herramientas
para los siete. Lo único que varía es la `persona`, y `claude`/`control` la
comparten byte a byte — que es lo que hace válido al control.

Reusa `STABLE_BLOCKS`: la mitad del prompt es el **mismo texto** que el del
contrato viejo, y es deliberado. Lo que cambia es el **mandato** (equity a cuatro
semanas) y el **formato de salida**; cómo leer el tablero no tiene por qué
cambiar, y duplicar esos bloques sería crear dos versiones de la misma
explicación que después divergen.

Los rieles del prompt salen de `RAILS`, el mismo objeto que el validador hace
cumplir. Dos fuentes para el mismo tope es cómo el prompt termina prometiendo
algo que el harness rechaza.

**La omisión se dice tres veces**, en tres lugares distintos. No es nerviosismo:
es la regla cuya incomprensión **liquida un libro entero en la primera corrida**,
y el único costo de repetirla son ~40 tokens del lado cacheado.

Y `pesos: {}` vs el campo ausente se distingue explícitamente: `{}` es
"liquidar todo e irme a cash", una decisión real; la ausencia es una respuesta
malformada y la corrida se aborta sin colocar nada.

---

## B8 · ANTI-HERDING · B9 · PRESUPUESTO

`_lib/arena-herding.js` · `_lib/arena-budget.js` · tests en
`tests/arena-antiherding.test.mjs` y `tests/arena-presupuesto.test.mjs`

### B8 · Por qué hace falta

Siete modelos mirando el **mismo** tablero pueden terminar con el mismo libro, y
si eso pasa el experimento deja de medir modelos y pasa a medir el tablero.

**Cola aleatorizada.** El orden de los top-30 cambia por agente. Suena menor y
no lo es: un modelo que lee una lista tiende a pesar más lo de arriba, así que
un orden común es una **preferencia común disfrazada de coincidencia**. La cola
avisa explícitamente que el orden no es un ranking.

**Enfoque primario rotativo** (momentum / catalizador / valor / reversión), dicho
como *"hoy mirá primero por…"*. No prohíbe nada: cambia por dónde empieza.

**Todo determinista, y no es un detalle.** Semilla `hash(agent_id + run_id)`,
enfoque `ENFOQUES[(hash(agent) + día) % 4]`. Un `Math.random()` acá haría el journal
**irreproducible** y el replay —que existe justamente para reconstruir qué vio
cada agente— sería inútil. Hay un lint que lo verifica sobre el código (no sobre
los comentarios, que explican precisamente por qué no se usa).

El día es el del **Este**: con UTC el enfoque cambiaría a las 20:00 ET, o sea a
mitad de sesión.

**Dónde vive la aleatorización (D2):** en la **cola no cacheada**, nunca en el
prefijo. Si el orden cambiara dentro del bloque cacheado, los siete tendrían
prefijos distintos y la caché no serviría para nada. La cola tiene su propio
techo (≤2K tokens) y, al recortarse, **el enfoque sobrevive**: son 40 tokens y es
la mitad del mecanismo.

> **Advertencia honesta:** el enfoque rotativo es un **confound deliberado**. Dos
> agentes con enfoques distintos el mismo día **no son comparables ese día**. Mide
> diversidad a costa de comparabilidad diaria; a lo largo de la temporada se
> promedia, pero va dicho en el post-mortem en vez de dejar que alguien lo
> descubra.

**Las métricas.** Con portafolio objetivo el herding deja de ser una
aproximación: la coincidencia par a par es el **coseno** entre los vectores de
peso, un número directo. Largo contra corto del mismo nombre da **−1**: la
dirección cuenta, no solo el nombre. Y un libro vacío devuelve **null**, no 0 ni
1 — no se parece ni se diferencia, simplemente no hay con qué comparar.

La tercera métrica, `toolVsBoardOrigin`, es la que dice si las herramientas
sirvieron para algo o si el PM decide igual con lo que ya tenía enfrente. Un
nombre que no vino **ni** de una herramienta **ni** del tablero se cuenta
aparte: lo trajo de su memoria, no de los datos de hoy.

### B9 · El presupuesto, en escalones

Hace falta **ahora** y no antes por una razón concreta: con herramientas una
corrida dejó de ser dos llamadas al LLM y pasó a ser hasta diez. El gasto por
corrida se multiplicó y el techo que sobraba puede quedar corto en un día
volátil, sin que nadie se entere hasta la factura.

| Escalón | Umbral | Qué hace |
|---|---|---|
| 0 | < $30 | normal: 8 herramientas, effort medium, 3 rondas fijas |
| 1 | ≥ $30 | herramientas 8→3, effort → low. **Sigue decidiendo**, más barato |
| 2 | ≥ $45 | solo la red de riesgo y los disparadores del **propio libro** |

**Por qué el diseño obvio era peor.** *"Si te pasás, apagá las rondas fijas"*
deja vivos los **disparadores**, que en un día volátil son **más caros** que las
rondas que se apagaron: el breaker ahorraría plata solo los días tranquilos, que
son justo los días en que no hacía falta.

El escalón 2 apaga los disparadores del **buffet** (oportunidades que se pueden
dejar pasar) pero **no** los del propio libro: eso es una posición suya
moviéndose.

**La red de riesgo no se apaga en ningún escalón.** No consume LLM, y un
presupuesto de tokens que apaga la protección del libro estaría cambiando plata
por riesgo sin decirlo.

**El costo no se inventa.** Gana lo que cobró el proveedor, después la tabla de
la casa, después una estimación **marcada** como tal, y si no hay ninguna →
`null`. Un costo ausente es un dato; uno inventado es una mentira que después
alguien usa para presupuestar. Y un total que ignora corridas sin precio
**subestima** el gasto — un breaker que subestima no dispara cuando debería, así
que `partial: true` viaja en el reporte.

**Sin contador, fail OPEN** (escalón 0) y declarado: frenar la liga porque Neon
no contesta cambiaría un problema de observabilidad por uno de producto.

Cada transición se journalea **una vez por (día, escalón)**: sin esa
idempotencia, un día en escalón 1 llenaría el journal con la misma fila doce
veces.

#### Dónde aprieta: el camino VIVO, no solo la sombra

El escalón lo resuelve el **orquestador**, una vez por tick o por ronda, y viaja
hacia abajo:

| Quién lo resuelve | Qué gobierna |
|---|---|
| `runArenaWatch` (cada 5 min) | las tres rondas fijas, la revisión de piso, los disparadores del buffet y el techo de cada corrida que despacha |
| `runArenaLeague` (nocturna) | la ronda de los siete |
| `runArenaMorning` (post-earnings) | las corridas por evento |
| `runArenaDecide` (si no le pasaron ninguno) | se lo resuelve solo — una corrida sin techo *porque entró por otra puerta* sería el agujero que este bloque tapa |

**Una vez por tick y no una por agente**, por dos razones: el gasto acumulado es
de la liga y no de nadie en particular (siete consultas para el mismo número), y
así los siete corren bajo el **mismo** escalón. Si el agente 1 corriera en
escalón 0 y el 7 en escalón 1 porque el gasto cruzó el umbral en el medio, la
ronda mezclaría dos regímenes y dejaría de ser comparable.

**El techo de herramientas es el MENOR de dos:** el del tipo de corrida (8 en una
ronda fija, 3 por disparador) y el del escalón. El mínimo y no el del escalón a
secas — el breaker puede **apretar, nunca aflojar**. Si algún día un escalón
permitiera más que el tipo de corrida, tomar el del escalón haría que el breaker
*regalara* llamadas: un freno que acelera.

**El `effort` del escalón viaja en el payload.** La perilla de profundidad de
esta liga es `effort`, no la temperatura, así que baja a `low` dentro de
`output_config` (Anthropic) o `reasoning.effort` (OpenRouter). En el escalón 0
viaja `null`, que **no** pisa el default del registry. `effectiveParams` reporta
el effort **real** de la corrida, no el del reglamento.

**Lo que el escalón 2 apaga se journalea.** Una ronda fija saltada deja su fila
con el escalón que la causó, y un disparador de buffet apagado deja su
`skip_reason` — igual que los que caen por tope. Un día con menos corridas tiene
que poder explicarse sin adivinar.

#### El estimador de costo se había quedado corto ~4×

`estimateWorstCaseCost` se escribió cuando una corrida eran **dos** llamadas al
LLM. Desde B3 el DIVE es un loop y desde B4 hay tres rondas fijas, así que el
número que publicaba el vigilante estaba mal por un factor de cuatro — y es
justo el número que uno mira para dimensionar el presupuesto.

**Lo que no se veía no era el número de llamadas: era que el PROMPT CRECE.** Cada
resultado de herramienta (hasta 1.500 tokens) se queda en la conversación y
vuelve a viajar en **todas** las vueltas siguientes. Con 8 herramientas el input
de la última vuelta es el de la primera más ~8.000 tokens, y la suma sobre el
loop es **cuadrática**. Un estimador que multiplica `corridas × tokens_por_corrida`
no puede verlo. El prefijo cacheado descuenta parte (a 1/40 del precio de entrada
en Fable 5.1) y también entra en la cuenta: sin restarlo el número se pasa para
el otro lado.

| | antes | ahora |
|---|---|---|
| llamadas al LLM por agente/día (peor caso) | 24 | **93** |
| peor caso diario, los 2 agentes de Anthropic | ~$5 | **$20.85** |

El peor caso absoluto de la liga entera pasa de `ARENA_DAILY_BUDGET_USD`. Eso no
es un problema: **es el breaker haciendo su trabajo** — aprieta a mitad de día
(8→3 herramientas, effort `low`) en vez de dejarlo llegar.

#### Dos bugs del contador que habrían dejado al breaker ciego

**1 · El loop de herramientas descartaba el `usage` de todas las llamadas menos
la última.** `runToolLoop` devuelve el último turno del modelo, y con él su
`usage`. Pero con 8 herramientas el prompt entero viaja en **cada** vuelta: el
gasto real es varias veces el de esa última llamada. Contarlo así alimentaba al
breaker con **un noveno** del gasto — un breaker que dispara cuando ya no sirve.
Ahora el loop devuelve `usage_total` y `cost_usd_total` acumulados.

**2 · El scan y el dive compartían id en `arena_spend`.** El id es clave primaria
con `on conflict do nothing`, así que el dive chocaba con el scan de la misma
corrida y su gasto se descartaba **en silencio**: la mitad del gasto real,
invisible. El id lleva la fase (`<run>:scan`, `<run>:dive`).

**Lo que se sacó a propósito:** el fallback de costo por catálogo de OpenRouter
no corre en el camino vivo. `openRouterPrices` cachea en el proceso, pero los
cinco agentes de OpenRouter corren en paralelo y los cinco fallan la caché a la
vez — cinco requests simultáneas a `openrouter.ai` por ronda, justo en el camino
que decide si la liga sigue gastando. El costo real ya viene en la respuesta
(`usage.cost`, que se pide con `usage: {include: true}`); si el proveedor no lo
manda, queda `null` y el total se marca `partial`. La estimación por catálogo
vive en el smoke, que corre solo y puede pagar esa llamada.

---

## B41 · UNA REGLA EN DOS CAMINOS NO ES UNA REGLA (2026-09-25)

**LA NORMA, primero, porque lo demás es la evidencia:**

> Cuando una regla tiene que valer en dos caminos, se vuelve **UNA función
> compartida**, y existe una prueba que **falla si divergen**. No es ahorro de
> código: es la única forma de que los dos signifiquen lo mismo.

La segunda mitad es la que hace trabajo. Una función compartida sin prueba se
vuelve a bifurcar el día que alguien necesita "una variante chiquita" y copia.
La prueba es lo que convierte la norma en algo que se rompe ruidosamente.

**Y la norma se aplica hacia adelante, no de golpe hacia atrás.** Inventariar
no es refactorizar. Lo que ya está duplicado se anota con su costo y se arregla
cuando se lo toca; lo que se escribe de hoy en adelante nace compartido.

### Por qué es norma y no reacción

Cinco bugs en una semana, uno por día, con la misma forma:

| | qué pasó | factura |
|---|---|---|
| 1 | el `client_order_id` sin corrida: arreglado en el contrato de acciones, no en el del objetivo | 180 de 204 órdenes rechazadas — **39% de la semana** |
| 2 | el ladder de escalamiento del stop: correcto el 30-jul, roto el 14-sep en un solo camino | la red de seguridad apagada **diez días** |
| 3 | el pareo de fills: mapa por id, consulta por símbolo | 462 órdenes **sin precio** en pantalla |
| 4 | los cortos en las salidas (`arena-exits-short.js`) | cerrado: hoy lo importan los dos |
| 5 | `ARENA_AGENTS` como sinónimo de "la liga" | cinco pruebas rotas y la apertura de la T3 **nunca anunciada** |

Cinco veces la misma causa deja de ser mala suerte. El patrón ES el hallazgo:
dos motores que hacen el mismo trabajo —el camino del **contrato objetivo** y
el de la **red determinista de riesgo**— comparten la mitad de sus reglas por
copia en vez de por referencia. Un arreglo entra por un camino y el otro sigue
con la versión vieja hasta que produce una factura.

El quinto lo produjo el barrido mismo, el mismo día que se escribió la norma.
Eso no debilita la norma: es la prueba de que el patrón sigue vivo cuando uno
ya lo está buscando.

### El modelo a copiar

`minutoDeCorrida` (`_lib/arena-objetivo-vivo.js`). Cuando se arregló el id
colisionante, el minuto NO se calculó dos veces: el camino del PM y el de los
stops importan la misma función, y `tests/arena-client-order-id.test.mjs`
verifica que `arena-run.js` la importe en vez de tener la suya. Si mañana
alguien escribe un `slice(11,16)` a mano, la prueba lo dice.

El otro precedente es el verificador literal de HISTORIA, y el argumento ahí
fue el mismo: no es ahorro de código, es que las dos citas signifiquen lo
mismo.

Aplicado hoy en el quinto caso: `competidores()` en `_lib/arena-registry.js`,
y **no** se reusó `activeAgents()` para eso. Son dos preguntas distintas —
"quién está inscrito" y "quién corre hoy"— y una función que contesta dos
preguntas es la misma bifurcación con otra ropa. Compartir la regla no es
fusionar conceptos.

### Lo que la norma NO dice

No dice que dos cosas parecidas tengan que unificarse. La red determinista
precia con el último cierre completo y el objetivo con el snapshot vivo; un
stop preciado con el tick de ahora se dispararía con ruido intradía. Esa
diferencia es una decisión, no una divergencia, y el inventario la lista
aparte para que nadie la "arregle".

El criterio: si las dos versiones tuvieran que cambiar juntas ante el mismo
hecho del mundo, es UNA regla. Si pueden cambiar por separado y seguir siendo
correctas, son dos.

### El inventario

Qué vive hoy en dos caminos, con archivo y línea, qué cuesta arreglar cada
cosa y qué rompe si se deja: **`docs/arena-dos-caminos.md`**. Verificado
leyendo el árbol el 2026-09-25, no de memoria — incluyendo una afirmación que
tuve que corregir después de correrla.

---

## B40 · ESTAMOS RANKEANDO 37 MANOS CONTRA 3 (2026-09-25)

Contado sobre siete días:

| agente | vivas | abortadas | | agente | vivas | abortadas |
|---|---:|---:|---|---|---:|---:|
| control | **37** | 0 | | gemini | 13 | 10 |
| claude | 30 | 0 | | deepseek | 9 | **25** |
| grok | 18 | 7 | | **qwen** | **3** | **22** |
| ChatGPT | 13 | 13 | | **liga** | **123** | **77** |

**Qwen decidió tres veces en la semana. Control decidió 37.** Y el ranking los
ponía en la misma tabla, publicando la diferencia como si midiera al modelo.

### Por qué esto es peor que el piso de ruido

No es la misma objeción. **El piso dice cuánta de la distancia entre dos puestos
es azar. Esto dice que dos agentes no jugaron el mismo juego.**

Un modelo que decide tres veces en cinco sesiones tiene una cartera que es sobre
todo **deriva de precio**: sus posiciones las eligió otro día y el mercado hizo
el resto. Su retorno mide al mercado con su cartera vieja encima — no mide al
modelo. Ponerlo en una tabla ordenada al lado de uno que decidió 37 veces no es
un caveat: es comparar dos experimentos distintos.

### Lo que NO se afirma

**La dirección del sesgo no se insinúa, porque no se sabe.** Abortar puede
ahorrarle a un agente una decisión mala tanto como impedirle una buena. Lo único
afirmable es que **no midieron lo mismo**, y eso es exactamente lo que dice la
pantalla — ni "a qwen lo perjudicaron los abortos" ni lo contrario.

### Una abortada no es una decisión de no operar

`ok_no_actions` (miró y decidió quedarse quieto) y `aborted_cuerpo_vacio` (el
proveedor no contestó) son opuestos: el primero es el modelo actuando, el
segundo es el modelo ausente. Contarlos juntos **haría parecer prudente lo que
es una falla de infraestructura**. Por eso `vivas` incluye `ok_no_actions`,
`rejected_rails` y `ejecutado_parcial` —en las tres el modelo llegó y decidió— y
solo `aborted_*` cuenta como ausencia.

### El criterio es el cociente, no la diferencia

37 contra 3 y 370 contra 30 son el mismo problema; 40 contra 37 no lo es aunque
la diferencia sea parecida. El corte está en **2×** (`RATIO_INCOMPARABLE`) y se
declara como lo que es: **elegido, no derivado**. A partir de ahí uno tuvo el
doble de oportunidades de corregir que el otro.

Y **cero corridas vivas es el caso más grave, no un hueco**: un cociente con
denominador cero no existe, y si saliera como `null` que la pantalla ignora, el
agente más roto sería el único sin advertencia.

---

## B39 · LA RED DE SEGURIDAD ESTUVO APAGADA DIEZ DÍAS (2026-09-25)

Salió como nota al pie del `client_order_id` y **no es una nota al pie**. El
resto de ese incidente son órdenes que no salieron; esto es **una red de
seguridad que no podía reintentar**.

### El mecanismo

`submitRiskExits` usaba `arena:<fecha>:<símbolo>:exit`. Sin la corrida adentro,
un stop sobre el mismo nombre solo podía salir **una vez por día**.

Y eso no es un inconveniente: **desarma la escalera de escalamiento.**
`escalationFromRiskRows` cuenta los stops catastróficos que NO llenaron para
ensanchar la banda en el intento siguiente. Ese intento reusaba el id, Alpaca lo
rechazaba con un 422, y **la banda ensanchada nunca llegaba al broker**. Un stop
que no llenaba a la primera no tenía segunda.

### Desde cuándo — y la fecha no es la que parece

El literal nació el **2026-07-30** (`86bcba4`, el commit que introdujo la regla
de salida determinista). **Y ahí era correcto**: con UNA corrida por día, la
fecha hacía el id único por construcción, y un reintento al día siguiente usaba
otra fecha. La escalera funcionaba, a un escalón por día.

Se rompió el **2026-09-14**, con `6b96b66` — *"cadencia POR EVENTO: vigilante
sin LLM, disparadores y topes"*. Ese commit introdujo `runArenaRiskNet`, que
hace correr la red **varias veces dentro del mismo día**, y ahí el id empezó a
chocar consigo mismo.

**El mismo commit contiene el arreglo, aplicado al otro camino.** `6b96b66`
agregó `const orderTag` al camino del PM con este comentario:

> Con la cadencia por evento un agente puede pronunciarse dos veces sobre el
> mismo nombre el mismo día, y **Alpaca rechaza el id repetido** […] El tag de
> corrida + el minuto ET la desambiguan.

Tocó `exit` nueve veces en el diff y **no le llevó el arreglo**. Diez días, del
14 al 24 de septiembre: la T2 entera en su cadencia vigente.

### La lección, que ya es un patrón con nombre

Es la cuarta vez esta temporada que **una regla entra por un camino y no por el
otro**: el corte por temporada (en `decide` y no en la red determinista), el
halt (después de la bandera y no antes), el pareo del P0, y ahora el id. En los
cuatro casos el autor del arreglo **estaba mirando el camino correcto** — y el
otro camino existía, hacía lo mismo, y quedó atrás.

Por eso el arreglo de hoy no duplica la lógica: los dos caminos llaman al
**mismo** `minutoDeCorrida`. Un helper compartido no garantiza que alguien se
acuerde del segundo camino, pero sí garantiza que cuando se acuerde no tenga que
volver a decidir el formato.

### Lo que no se puede saber

**Cuántos stops se quedaron sin segundo intento en esos diez días no se puede
reconstruir del journal con certeza.** Un stop cuyo reintento murió por 422 dejó
una fila `submit_failed` con su motivo, y ésas sí se cuentan. Pero un stop que
no llenó y del que la red **nunca volvió a intentar nada** —porque el objetivo
del PM ya había cerrado la posición por otro lado, o porque el precio se
recuperó— no dejó rastro de un intento que no ocurrió. Se cuenta el piso, no el
total, y se dice cuál de los dos es.

---

## B38 · EL ID QUE COLISIONABA CONSIGO MISMO (2026-09-24)

Destapado por la consulta que confirmaba el P0. **525 órdenes calculadas del 21
al 24; ~216 nunca llegaron a Alpaca.** Y no fallan parejo — en la muestra que
Lety contó a mano:

| lado | intentos | fallaron | |
|---|---:|---:|---:|
| compras | 8 | 2 | 25% |
| **ventas** | 6 | **5** | **83%** |

Dos filas reales, mismo agente, mismo día, mismo ticker, mismo lado:

```
control 19:31 GDDY buy → approved, filled 29 @ 101.81
control 19:36 GDDY buy → submit_failed
```

```js
`arena-${agentId}-${runTag}-${runDate}-${o.symbol}-${o.side}`.slice(0, 48)
//  arena-control-f-2026-09-24-GDDY-buy   ← las 19:31
//  arena-control-f-2026-09-24-GDDY-buy   ← las 19:36, byte a byte el mismo
```

Agente, fecha, ticker y lado. **La corrida no está.** Alpaca rechaza un
`client_order_id` repetido, así que cada agente podía tocar cada nombre **una
vez por día por lado** y todo lo demás moría con un 422.

### Por qué las ventas y no las compras

Una compra se pide una vez y llena. **Una venta se repite**: se trimea, no
llena, y la ronda siguiente vuelve a pedir el mismo trim del mismo nombre — o
el PM baja el peso otra vez. La segunda petición es la que se cae.

Y eso cierra el hueco que quedaba abierto en el inflado de los libros: **los
agentes sí vendían; sus ventas se caían antes de salir.** Compran, no pueden
deshacerse de nada, y el libro crece. De 68 posiciones el lunes a 95 el jueves,
con Control y Claude en 22.

### El arreglo ya existía, en el camino que se retiró

`runArenaDecide` —el contrato de ACCIONES— chocó con esto cuando entró la
cadencia por evento, y lo resolvió. Su propio comentario:

> El `client_order_id` nació con la cadencia de UNA corrida por día […] Con la
> cadencia por evento un agente puede pronunciarse dos veces sobre el mismo
> nombre el mismo día, y **Alpaca rechaza el id repetido** — la segunda orden,
> la que el disparador produjo, **moriría con un 422**. El tag de corrida + el
> minuto ET la desambiguan.

El contrato OBJETIVO se escribió después y **no se llevó el arreglo**. Peor:
dejó `runTag: 'f'` escrito a mano en el llamador, así que todas sus órdenes
salían estampadas como "revisión de piso" vinieran de donde vinieran.

**Es el patrón de la casa, por enésima vez: una regla entra por un camino y no
por el otro.** Ya pasó con el corte por temporada (en `decide` y no en la red),
con el halt (después de la bandera y no antes), y con el pareo del P0.

### Y en los stops cuesta más

`submitRiskExits` usaba `arena:<fecha>:<símbolo>:exit`, sin corrida. Mismo
choque, con una consecuencia peor: **desarma la escalera de escalamiento.**
`escalationFromRiskRows` cuenta los stops catastróficos que NO llenaron para
ensanchar la banda en el intento siguiente — y ese intento reusaba el id, se lo
rechazaba Alpaca, y la banda ensanchada nunca llegaba al broker. **Un stop que
no llenaba a la primera no tenía segunda.**

### Qué idempotencia se conserva y cuál no

Se conserva la que importa: dos invocaciones de la MISMA corrida (un cron que se
repite, un reintento de la lambda) caen en el mismo minuto y producen el mismo
id. Lo que deja de estar bloqueado es lo que nunca tuvo que estarlo: **una ronda
posterior pidiendo el mismo nombre.** Que dos rondas distintas no se pisen lo
garantiza el vigilante con sus marcadores de "ya se hizo hoy", que es la capa
donde vive esa decisión.

### Sin recorte ciego

El `.slice(0, 48)` recortaba **por la cola, y la cola es el lado**: dos ids
truncados al mismo largo serían el mismo, y una compra cancelaría una venta.
Ahora el largo está acotado por construcción —lo único de largo variable es el
agente, capado a 10— y un test lo verifica **contra el registry entero**, con
todos los símbolos y los dos lados. Si entra un octavo agente con un id largo,
falla el test en vez de colisionar en vivo.

### El motivo SIEMPRE estuvo guardado

`enviarOrdenes` journalea `error: String(e.message)`, y `alpacaFetch` compone el
mensaje con el cuerpo de la respuesta (`Alpaca 422: client_order_id must be
unique`). O sea: **el motivo está en la base desde el lunes, dos veces** — en
`context.ejecucion.enviadas[].error` y en `actions[].error`.

Lo que fallaba era mostrarlo: `ejecucionPublicable` lo copiaba con
`...(r && r.error ? { error: r.error } : {})`, y `r` era siempre `null` **por el
mismo pareo roto del P0**. Un bug tapando la evidencia de otro. Con el P0
mergeado, una orden que no salió aparece como `no_enviada` con el texto de
Alpaca al lado.

---

## B37 · TRES COSAS QUE LA PRUEBA SINTÉTICA NO PODÍA VER (2026-09-23)

Los precios se verificaron contra payloads armados a mano. Releyendo el camino
real contra la forma que de verdad journalea el motor aparecieron tres huecos
que un fixture inventado no toca, porque el fixture se escribe con la forma que
uno CREE que tiene el dato.

### 1. `ordenes_calculadas` no lleva `client_order_id`

Lo pone `enviarOrdenes` **después**, al mandar. Así que el pareo entre la orden
calculada y su resultado de envío se hacía con una clave que un lado no tiene:

```js
enviadas.get(String(o.client_order_id || o.symbol || ''))   // → 'PGR', y el mapa
                                                            //   está llaveado por
                                                            //   'arena-claude-f-…'
```

**Falla en TODA corrida viva**, y de la peor forma: sin excepción y sin hueco
visible. `resultado` y `estado_alpaca` salen `null`, y la página escribe
"calculada" sobre órdenes que sí se mandaron y sí llenaron.

**Medido en producción el 2026-09-24: 462 órdenes del 21 al 24, las 462 con
`resultado: null` y `estado_alpaca: null`.** Cero excepciones.

> ### CORRECCIÓN DE UNA CORRECCIÓN (2026-09-24)
>
> El 23 anoté acá que "B34 ya lo había tapado sin querer" y que esto arreglaba
> un **respaldo** y no el camino principal. **Estaba mal, y el error de método
> importa más que el error:** razoné sobre el estado de la RAMA y lo escribí
> como si fuera el estado de PRODUCCIÓN. La rama no está mergeada. Producción
> corre `main`, `main` no tiene el pareo por fill de B34, y por lo tanto esta
> expresión **es** el camino principal allá — es la causa única de que las 462
> órdenes no tengan precio.
>
> La regla que sale de esto: **una afirmación sobre el comportamiento
> observable dice contra qué árbol se verificó, o no se escribe.** "Ya estaba
> tapado" sin decir *dónde* convirtió un bug de producción en una nota al pie.

### 2. Las salidas de riesgo escriben `reference`, no `referencia`

`attributeRiskExit` es más vieja que el contrato objetivo y usa el nombre en
inglés. Son el mismo dato; leer solo uno dejaba sin deslizamiento justo a las
órdenes de los stops.

### 3. Una fila `risk_exit` no tiene `context.ejecucion`

La escribe la red determinista, no el contrato objetivo — pero **sí tiene
`actions`**, y el reconcile les pone su precio como a cualquier otra. Sin un
respaldo, las ventas que dispara un stop eran las únicas que seguían sin decir a
cuánto se vendieron, **y son las que más importan**: una venta que el PM decidió
tiene una tesis al lado; una que disparó un stop solo tiene su precio.

`ordenesSueltas` arma la misma forma desde `actions` sola, y la nota dice de
dónde salió: *"RED DETERMINISTA: estas ventas las disparó un stop, no el PM"*.
Vale igual para las filas del contrato viejo.

### La lección

Las tres son la misma: **un fixture se escribe con la forma que uno cree que
tiene el dato, así que confirma la creencia en vez de comprobarla.**

Y el caso 1 lo demuestra dos veces. El fixture de `tests/arena-fills.test.mjs`
le ponía `client_order_id` a la orden calculada — un campo que la función que
las produce NUNCA escribe. El test pasaba en verde **sobre el caso que no
existe**, mientras producción fallaba en el 100% de las filas.

`tests/arena-pareo-ordenes.test.mjs` cierra ese hueco de otra forma: **no
escribe las formas, llama a las funciones que las producen.** `legsAOrdenes`
genera la orden, se le pega encima lo que le pega `enviarOrdenes`, se proyecta a
`actions` como lo hace `journalObjetivoVivo`, y recién ahí se parea. Un test que
afirma sobre un dato que él mismo inventó no prueba nada sobre el dato real.

---

## B36 · DOS CONTEOS QUE DECIDEN, EN LA MISMA RESPUESTA (2026-09-23)

Dos preguntas abiertas, las dos contestables con datos que YA se journalean.
Ninguna necesitaba una tabla nueva ni una consulta más: salen de las mismas
filas que `/api/liga/libros` ya carga.

```bash
curl -sS "$BASE/api/liga/libros?dias=7&fuente=viva" | jq '{herramientas, deslizamiento}'
```

### 1. ¿Hace falta el universo completo en el tablero?

**Decisión: NO, por ahora** (Lety, 2026-09-23). El tablero es una MUESTRA del
universo —top-30 por cambio, top-20 por RVOL, extremos de 52 semanas— y el
universo entero está **a una llamada de `screener`**. Meterlo en el tablero
cuesta **+3,200–4,300 tokens** por agente y por corrida, y con el tope actual
(`ARENA_BOARD_TOKENS`, 5,000) el recorte por la cola se llevaría titulares,
earnings y los extremos de 52 semanas — que son justo los campos que aparecen
citados en los razonamientos. **No se cambian tres secciones que el PM cita por
una lista de nombres que puede pedir.**

Lo que queda por medir antes de tocar el prompt: **si casi no llaman al
screener, no les falta acceso — les falta saber que lo tienen**, y eso se
arregla con una línea de ~20 tokens en vez de 4,000.

`herramientas` cuenta tres cosas distintas a propósito:

| campo | contesta |
|---|---|
| `screener_llamadas` | cuántas veces la llamó en total |
| `screener_corridas` | en cuántas corridas la tocó **al menos una vez** |
| `screener_pct_corridas` | el decisivo: si está o no en su repertorio |

Un agente que la llama seis veces en una corrida y ninguna en las otras cinco
**no la usa**, y un conteo de llamadas sola diría que sí. Y una corrida
**abortada no entra al denominador**: no decidió no investigar, no llegó.

### 2. ¿Alguno paga más que los otros por el mismo mecanismo?

`deslizamiento` agrega el `deslizamiento_pp` que ya viaja por orden. Si un
agente desliza sistemáticamente más, **eso no es el modelo: es el límite
marketable trabajando mal para él**, y se arregla en el motor.

Tres decisiones que hacen legible el número:

- **Positivo siempre es peor**, de los dos lados (pagar de más comprando,
  cobrar de menos vendiendo). Sin normalizar el signo, promediar compras y
  ventas las cancela.
- **La media y la ponderada por monto, juntas.** Un agente que desliza 0.4pp en
  una orden de $200 y 0.01pp en una de $20,000 tiene una media horrible y un
  costo real ínfimo: la media dice cómo ejecuta, la ponderada cuánto costó.
- **El piso claude↔control**, igual que en el ranking. Los dos corren el mismo
  modelo con el mismo prompt, así que lo que los separa ACÁ es el mecanismo.
  Una diferencia menor que ese piso no se le puede cobrar a ningún modelo.

Y `en_el_tope`: un fill no puede pasar su límite, así que un agente cuyos fills
se pegan al límite **no está deslizando más — está tocando el techo todas las
veces**, que es la firma de una banda mal calibrada y no de mala ejecución. Se
cuenta comparando el precio de ejecución con el límite de esa orden, sin
necesitar conocer la banda.

**El mínimo honesto es una semana de sesiones.** Con dos o tres fills un nombre
ilíquido mueve el promedio entero, y la nota del bloque lo dice.

---

## B35 · EL AGENTE NO ESTABA FALLANDO, ESTABA OBEDECIENDO (2026-09-22)

> **El agente no estaba fallando, estaba obedeciendo.**
>
> Tres textos en imperativo le decían que no podía tener lo que tenía, y un
> validador leía un nombre de su propio libro como un ticker inventado.

DeepSeek compró NKE al **25%** por la mañana y lo liquidó por la tarde. El
motivo que escribió: *"el universo admisible de hoy fuerza la salida"*.

**No estaba alucinando. Estaba leyendo bien el sistema.** El universo del día
era a la vez lo que el agente podía MIRAR y lo que podía TENER, y el prompt se
lo decía con todas las letras.

### Por qué esto es más grande que un caso

Es el error más caro que se puede cometer contra un experimento de comparación
de modelos, y no por el dinero: **un sistema que le ordena a un agente hacer
algo, y después publica ese algo como la decisión del agente, no está midiendo
al modelo.** Está midiendo su propia instrucción, con siete etiquetas distintas
encima.

El churn de DeepSeek —comprar al 25% y salir el mismo día— es el caso que se
vio. Lo que hay que asumir es que **no fue el único**: cualquier venta cuyo
nombre hubiera salido del universo ese día tiene esta explicación disponible
antes que cualquier tesis. Y una cartera que rota por una lista que se
reconstruye todas las mañanas **se ve exactamente igual que una cartera
aleatoria**, que es como se venían viendo los libros.

No se puede cuantificar hacia atrás con lo que hay: la mitad de los casos no
dejó rastro estructurado (el agente que obedeció y OMITIÓ el nombre no genera
una fila de rechazo, genera una venta que parece decidida). Queda dicho como
límite, no estimado a ojo — y desde el 2026-09-22 `admitidos_por_tenencia`
cuenta el caso directamente, así que hacia adelante sí es medible.

### La lección, para el próximo

Los tres textos eran **correctos sobre el universo** y **falsos sobre el libro**,
y la diferencia entre esas dos cosas no existía en el código: había UN conjunto
donde hacían falta dos. Cuando un prompt y un validador dicen lo mismo, no se
confirman entre sí — comparten la misma suposición, y una suposición repetida
en dos lugares se lee como una verificación.

### El texto que lo causaba

Tres lugares enseñaban la misma regla falsa, y los tres salieron hoy:

| dónde | decía |
|---|---|
| `buildTargetSystemPrompt` | *"You CANNOT hold them today"* |
| `marcarNoAdmitidos`, en la fila de cada nombre | *"you CANNOT hold this name today"* |
| `bloqueDeRechazos`, la memoria de rechazos | *"you never will while the name stays out of the universe"* |

La respuesta a *"¿se lo decimos o lo infiere?"* es **se lo decíamos**, en
imperativo, en el prefijo cacheado que los siete leen en cada corrida.

### Y el cableado hacía lo mismo

No era solo el texto. `normalizarTickersObjetivo` validaba el objetivo contra
`universe_raw.symbols` y **nada más**, así que un nombre en el libro cuyo ticker
no estuviera en la lista de hoy era, para el validador, un ticker inventado. De
ahí salían **dos finales, los dos malos**, y por eso el bug no se veía como un
bug: había un camino "sano" para cada caso.

- **Si lo descartado cabía bajo el tope del rescate** (⅓ del bruto): se
  ejecutaba el resto del libro **sin** ese nombre. Y en el contrato objetivo,
  "sin ese nombre" **es venderlo**. Liquidación que nadie decidió.
- **Si pesaba más que el tope**: el objetivo se rechazaba entero y el libro
  quedaba **congelado** en el de ayer, con las posiciones que el PM acababa de
  decidir cerrar.

### La regla, ahora en dos

- **Lo que puede ABRIR o AGRANDAR** → el universo del día. Ahí viven las reglas
  de admisión (liquidez, tipo de instrumento, precio mínimo), y existen para no
  abrir una posición de la que después no se pueda salir.
- **Lo que puede TENER** → todo lo que YA TIENE, más el universo. Una posición
  abierta sale por un **RIEL**, por un **STOP**, o porque el **agente decide**
  venderla. Nunca por rotación de una lista.

La rotación es constante **por construcción**: el universo se arma antes de la
apertura, capa los movers del día a los 50 de mayor volumen y ajusta el piso de
liquidez al feed que contestó. Un nombre entra y sale de esa lista por razones
que no tienen nada que ver con la tesis del PM.

### El único límite que queda: no se puede AGRANDAR

Si tener bastara para comprar, una acción heredada sería la llave para meter el
30% del libro en un nombre que el universo rechazó por liquidez. Así que un
nombre que se tiene y no está en el universo se puede **mantener o reducir**, no
aumentar.

**Y el corte no es un epsilon: es `no_trade_band` (2pp).** Por debajo de la
banda el motor no manda una orden, así que "aumentar" menos que la banda no es
aumentar nada — y descartar esa pata por 0.3pp de drift mandaría la posición
ENTERA a cash, que es la liquidación forzada volviendo por la puerta de atrás.

`admitidos_por_tenencia` journalea qué nombres vivieron SOLO por estar en el
libro. Sin ese campo el arreglo sería invisible, y es el que contesta cuántas
salidas estaba forzando la rotación.

### Lo que NO se tocó, y es la otra mitad del encargo

Que el agente VEA todo el universo en el tablero es un cambio distinto y cuesta
tokens. La medición está abajo (B34). Éste no cuesta ninguno.

---

## B34 · A CUÁNTO SE COMPRÓ Y A CUÁNTO SE VENDIÓ (2026-09-22)

La pantalla decía **"PGR buy · filled"** y nada más. Eso dice que pasó algo, no
QUÉ pasó: ni a qué precio, ni cuántas acciones, ni a qué hora, ni si la venta
ganó o perdió. **Es el punto ciego del viernes en otra forma** — un estado que
se lee como si fuera una explicación.

### El dato estaba, en dos mitades que nadie juntaba

| qué | dónde | quién lo escribe |
|---|---|---|
| lo que se PIDIÓ (cantidad, límite, intención, delta de peso) | `context.ejecucion.ordenes_calculadas` | la corrida, una vez |
| lo que PASÓ (precio de ejecución, cantidad llenada, hora) | la columna **`actions`** | `runArenaReconcile`, después |
| el costo de la posición ANTES de operar | la columna **`account`** | la corrida |

`context.ejecucion.enviadas` se escribe cuando la orden SALE: ahí el estado es
`accepted` y todavía no hay precio. La única estructura que se **re-escribe**
es `actions`, y la proyección de `/api/liga/libros` no la miraba. El precio
estaba en el journal y no llegaba a la pantalla.

`_lib/arena-fills.js` las junta, en UN lugar: dos implementaciones del mismo
cálculo terminan difiriendo, y ésta produce un número de dinero.

### Las cinco situaciones se nombran distinto

`llena` · `parcial` · `sin_llenar` (terminal y no llenó) · `pendiente` (viva, o
el reconcile no pasó) · `no_enviada` / `sin_enviar`. Llevan a mirar cosas
distintas, y una parcial que solo muestra lo llenado **se lee como una orden
completa más chica**. Ahora dice cuánto se llenó *y* cuánto no.

### El resultado de una salida, con una sola fórmula

```
P&L = (salida − entrada) × cantidad      para un largo
P&L = (entrada − salida) × cantidad      para un corto
%   = P&L / (entrada × cantidad)         para los dos
```

Escribirlo así evita la trampa clásica de invertir el cociente para el corto y
publicar un porcentaje que no corresponde al dinero de al lado. Un `cover` es
`side: 'buy'` para Alpaca, así que **`intencion` ahora viaja en `actions`**: sin
ella, una venta de cierre y la apertura de un corto son indistinguibles.

**Lo que este número NO es**, dicho en la pantalla y no en la letra chica:
`avg_entry_price` es un **promedio** (una posición armada en tres compras no
tiene "el" precio de entrada); es **bruto**, sin comisiones y **sin dividendos**;
y **solo las salidas realizan** — una compra devuelve `null`, no cero.

**Y un ausente no es un cero.** Una venta cuya entrada no se pudo leer NO entra
al realizado como 0: se cuenta aparte (`salidas_sin_base`) y el resumen dice
cuántas quedaron fuera del total.

### El deslizamiento, gratis

La referencia que aprobó el riel ya viajaba. Al lado del precio real de
ejecución dice si el límite marketable está haciendo su trabajo — es el único
número que lo contesta, y costaba una resta.

### La hora es de MERCADO

`15:58 ET`, no la del teléfono de quien mira. Un fill cerca del cierre dice
algo; el mismo fill en hora local de Madrid se lee como si el mercado operara de
noche.

### El precio no aparecía el mismo día, y eso era la mitad del encargo

Publicar el precio no sirve si llega mañana. El reconcile del vigilante estaba
condicionado a **que además hubiera a quién despertar**:

```js
if (!dry && (runs.length || floorAgents.length)) {   // ← la condición
```

O sea: en un día en que la última ronda fija opera y después nadie se despierta
—lo normal—, los fills de la tarde se quedaban sin precio hasta el cron de las
**14:40 del día siguiente**. El precio existía en Alpaca y la pantalla decía
"filled" a secas toda la tarde y toda la noche.

Soltar la condición cuesta poco **por construcción**: `runArenaReconcile` solo
TRAE filas con alguna orden no terminal (el `exists` de su consulta), así que
una sesión sin órdenes vivas es una consulta a Neon y **cero** llamadas a
Alpaca. El freno de 30 minutos no se toca. El vigilante corre hasta las 21:55
UTC, después del cierre en los dos husos, así que los fills del cierre se
true-ean el mismo día.

---

## B33 · EL MARGEN DE ERROR DE LA TABLA, DECLARADO ARRIBA DEL RANKING (2026-09-21)

El ranking del 2026-09-21, leído como lo publicaba `/liga`:

| puesto | agente | retorno |
|---|---|---:|
| 1 | Grok | **+1.42%** |
| 2 | **Control · Haiku-B** | +1.06% |
| … | … | … |
| 6 | **Claude** | +0.07% |
| 7 | Qwen | −0.29% |

`claude` y `control` son el **mismo modelo**, el **mismo prompt** byte a byte, la
**misma temperatura** y el **mismo tablero**. Terminaron a **0.99 puntos** uno
del otro, y del 2º al 7º hay **1.35 puntos**: el **73%** del spread entre modelos
es el sistema difiriendo consigo mismo. Ninguna brecha entre puestos consecutivos
alcanza el piso — solo Grok se despega, y apenas.

### Por qué el piso que ya existía no servía para esto

Había DOS pisos de ruido y los dos en **coseno** (`_lib/arena-herding.js`): entre
LIBROS y entre DELTAS. Los dos contestan *"¿deciden parecido dos corridas
idénticas?"*. **Ninguno contesta la pregunta que hace cualquiera que abre
`/liga`:** el 2º, ¿le ganó de verdad al 6º? Esa se mide en **puntos de retorno**,
y un coseno **no se convierte** a puntos porcentuales — `_lib/arena-benchmark.js`
ya lo decía con todas las letras y por eso publicaba el coseno *al lado* del
exceso sin mezclarlos.

Lo que faltaba no era una conversión. Era el piso **medido en la unidad del
ranking**, y estaba a una resta de distancia porque los dos números ya estaban en
la misma respuesta:

```
piso = | retorno(claude) − retorno(control) |
```

Cuesta **cero consultas y cero red**, así que va en el camino por defecto de
`/api/leaderboard` (`margen_de_la_tabla`) y **no** detrás de `?postmortem=1`,
donde vive el bloque en coseno que sí paga una consulta al journal de la sombra.

### Lo que la pantalla dice ahora, arriba y antes del ranking

- El **piso** (0.99 pp), el **spread** (1.71 pp completo · 1.35 pp sin el líder) y
  qué **fracción** del segundo es el primero.
- **Qué puestos no significan nada.** Una brecha menor que el piso es un empate
  técnico, y se marca **en la fila**, al lado del número — no en la letra chica
  del pie.
- **Cuántos pierden contra el índice**, contado: *6 de 7*. Se decía en el pie que
  el SPY estaba "para contestar si los siete le ganan al índice" y después no se
  contestaba: el lector tenía que restar fila por fila.

**Un ranking que no declara su propio margen de error es una tabla de posiciones
inventada.** Ese es el motivo entero de este bloque.

### Las tres cosas que este número NO es

1. **No es un coseno y no se compara con los otros dos pisos.** Puntos de retorno
   acumulado contra parecido entre vectores de peso: unidades distintas, escalas
   distintas. Por eso viaja con `metodo: 'retorno'` y su unidad pegada, igual que
   los otros dos viajan con el suyo.
2. **No es una desviación estándar.** Es **una** observación de **un** par: dice a
   qué distancia terminaron dos corridas idénticas, no qué tan seguido terminan
   así. Con siete agentes y una sola réplica no hay con qué estimar lo segundo, y
   fingir que sí lo hay sería el invento que esto existe para impedir.
3. **No es un número del día.** `return_pct` se mide desde el baseline del reset,
   así que el piso es **acumulado**. El spread sale de exactamente los mismos
   retornos, así que el cociente entre los dos es legítimo: mismo origen, misma
   unidad, misma ventana.

### Un `null` que se leía como un 0.00%

Encontrado por el test, no por lectura: `Number(null)` es `0` y `0` es finito, así
que un agente **sin** retorno (cuenta caída, baseline ilegible) entraba a la tabla
como un `0.00%` perfectamente creíble, y el piso, el spread y el conteo contra el
índice se calculaban sobre un número que nadie midió. Es la misma trampa que el
RVOL con `dayVolume == null` y la que `filaBenchmark` evita con `abierto`.

### La coincidencia se calcula sobre los que TERMINARON

`/liga/libros` decía *"entre 4 libros"* el día que Grok, DeepSeek y Qwen abortaron
su última corrida. El número no estaba mal: estaba mal **rotulado**. Se lee como
un hecho del día y es el de un **subconjunto que cambia solo** — el denominador se
mueve sin que nada lo diga y la serie deja de ser comparable consigo misma.

Ahora la etiqueta dice **"entre 4 de 7 libros"** y debajo va quién quedó fuera con
su estado. **Un rechazo por rieles cuenta como FUERA pero no como ABORTO**: llevan
a arreglar cosas distintas y sumarlos mandaría a buscar el problema al proveedor
cuando está en el libro que pidió el modelo.

### El `/8` de la pantalla era un tope que no existe

`/liga` mostraba `13/8 posiciones`, `12/8`, `11/8`, `10/8`. **No eran cuatro
violaciones: era un denominador muerto.** El 8 es del **contrato de ACCIONES**
(el guard viejo), que el contrato de portafolio objetivo sustituyó el 2026-09-17
— ya estaba dicho en la sección *Reglas del PM*, y la pantalla no se enteró.

Los rieles vigentes (R1-R12) acotan **PESOS**, no cantidad. El propio prompt del
contrato lo dice: *"There is NO cap on the NUMBER of positions"*, y el comentario
de R1 deja escrita la reserva de que no lo haya. El único techo es indirecto y es
**R8** (mínimo 2% por posición → a lo sumo 50 nombres), que no es 8.

Un denominador que el motor no aplica convierte *"13 posiciones"* en *"13 de 8"* y
manda a buscar un bug al lugar equivocado — el mismo error que el rechazo con el
motivo equivocado de `_lib/arena-instrumento.js`.

### Y "RIELES ✕" ahora dice CUÁL

El detalle (riel, ticker, motivo) ya viajaba en `/api/liga/libros`, pero en la
página vivía detrás de *"ver la investigación"*: para saber qué riel frenó una
corrida había que abrir la tarjeta y bajar cuatro bloques. **"Rechazado" sin el
riel es la mitad de un diagnóstico** — la diferencia entre *"el agente falló"* y
*"pidió 60% en un sector con tope de 50%"*. El badge de la cabecera lo nombra.

```bash
# el riel de una corrida puntual, sin abrir la página
curl -sS "$BASE/api/liga/libros?dias=1&agente=claude" \
  | jq '.libros[] | {fecha, estado, rieles}'
```

---

## B32 · CERRADO: la liga no operaba el viernes (el veredicto de feed era global)

**Cerrado el 2026-09-21 con fills reales** (PGR, ADBE, MPC). La corrida en vivo
mandó órdenes y llenaron: es la confirmación que faltaba, porque el arreglo se
había verificado contra el código y con un escenario reproducido, no contra una
sesión de mercado.

**La causa, que fue un error de diseño nuestro.** El Arena usa OCHO cuentas de
Alpaca: la maestra (`ALPACA_PAPER_*`, que arma el tablero y el universo) y una
por agente. **La suscripción a SIP es por cuenta**: la maestra la tiene, las de
los agentes no necesariamente. El veredicto de feed vivía en UNA variable de
módulo compartida por las ocho, y encima **restringía** los intentos en vez de
**ordenarlos**: `[feedResuelto]` era la lista completa, sin IEX detrás.

1. El tablero corre con la maestra → SIP contesta → se recuerda `'sip'`.
2. Cada agente pide precios con SU cuenta → **403**.
3. Sin IEX detrás, el 403 no tiene a dónde caer y la llamada **lanza**.
4. `arena-meta.js` traga el error y devuelve `{}` → el objetivo llega a la
   ejecución **sin un solo precio de referencia**.
5. Cada pata se descarta con *"sin precio de referencia para X"* → **cero
   órdenes**, siete agentes, todo el viernes. *"Pasa los rieles"* era verdad; lo
   que fallaba estaba después.

**Los dos arreglos, porque uno solo deja el filo puesto** (`_lib/alpaca.js`,
`feedPorCuenta`): la clave es la **cuenta** (el id de la key, nunca el secreto), y
un veredicto guardado **ordena** los intentos sin quitar la alternativa. Aunque la
clave fuera perfecta, una suscripción que caduque volvería a dejar una cuenta sin
salida. **Un caché que quita la alternativa no es un caché: es un candado.**

**Lo que entró junto y NO es lo mismo:** el tope diario del vigilante estaba
muerto de antes. Contaba las corridas del día con
`context->'event'->>'type' in ('watch_trigger','watch_floor')` y el contrato
objetivo **nunca escribía `context.event`**, así que `runsToday` era `{}` para
todos los agentes todos los días y el tope de 12 corridas/agente/día no frenaba
nada (claude corrió ~20). El evento ahora se journalea y **sigue sin usarse para
decidir**: el objetivo es el libro entero venga de donde venga. Lo que cambia es
que el registro dice qué despertó la corrida, que es lo que el tope necesita para
contar.

---

## B31 · LA CORRIDA SECA TIENE QUE PODER REVISARSE

```bash
curl -sS "$BASE/api/arena-audit?agent=todos&limit=7&format=md&secret=$CRON_SECRET"
```

La auditoría estaba construida entera sobre el contrato de **acciones**:
`scout`, `slate`, `acciones`, `guard`. Una corrida del contrato nuevo salía como
una fila casi vacía — el objetivo, los rieles y las órdenes viven en `context` y
nadie los leía.

Y la corrida **seca** es el peor caso: por definición no tiene `actions` porque
no se mandó nada. O sea que lo único que hay para revisar antes de encender era
justamente lo que no se veía.

`objetivo` entra en cada fila del contrato nuevo (y es `null` en las del viejo —
un bloque vacío en cada fila de septiembre sería ruido en el post-mortem):

- **`modo`** primero de todo. Confirmar que no se mandó nada es lo primero que
  hay que poder ver; si dice `enviado` cuando se esperaba seco, la bandera no
  era la que se creía.
- **`pesos_pct`** en porcentaje, no en fracción: leer `0.12` como "12%" es el
  error de un cero de diferencia.
- **`rieles`** con las violaciones nombradas por riel y símbolo.
- **`ordenes[]`** con símbolo, lado, cantidad, límite y **el monto ya hecho**.
  Obligar a multiplicar `qty × límite` a mano es donde se cuela un error de
  lectura.
- **`descartadas[]`** con su motivo: un peso que desaparece sin explicación es
  peor que uno rechazado.
- **`tickers.reparados`**, que es la señal de que algo se está corrompiendo
  aguas arriba.

En `?format=md` sale como tablas legibles en una terminal **sin `jq`**, con un
**NADA SE MANDÓ** en el encabezado cuando el modo es seco.

## B30 · EL ENCENDIDO DEL CONTRATO OBJETIVO (v4)

`api/_lib/arena-objetivo-vivo.js` · tests en `tests/arena-contrato-vivo.test.mjs`

```
ARENA_CONTRATO = objetivo        ← manda órdenes
ARENA_CONTRATO = objetivo_dry    ← decide y calcula las órdenes, NO manda
ARENA_CONTRATO = 0   (o sin poner) ← contrato viejo, el de ayer
```

En Vercel, **sin deploy**. Apagarla vuelve al contrato de acciones sin tocar
nada más.

### Tres estados, no dos

El escalón `objetivo_dry` existe porque **el código que manda órdenes es el
único del Arena que no se pudo probar contra la realidad**: la sombra prueba la
decisión, no la ejecución. `dry` decide, calcula las órdenes, las journalea
completas y no manda ninguna. Cuesta una ronda y convierte "confío en que las
órdenes están bien" en "vi las órdenes que iba a mandar".

Y un valor que no se reconoce cae al contrato **viejo**: un typo no puede
encender el contrato nuevo.

### Una sola función, no una copia

`runShadowAgent` pasó a ser un envoltorio de `runAgenteObjetivo({ vivo: false })`,
y el camino vivo llama a **la misma función** con `vivo: true`. Tres cosas
cambian: el broker (real en vez del que lanza en toda escritura), la tabla del
journal, y que al final se mandan las órdenes.

No es por ahorrar líneas. Una copia para producción empezaría idéntica y
divergiría en el primer arreglo que alguien aplicara a una sola de las dos — y lo
que llegó a 7/7 en sombra tiene que ser **ese** código, no uno que se le parece.
Es la misma razón por la que hay un solo loop de herramientas para los dos
proveedores. Hay un test que afirma que el prompt del contrato nuevo se
construye en un solo lugar.

La rama va **primero** en `runArenaDecide`, con `return`: con la bandera apagada
no se ejecuta ni una línea nueva.

### Patas → órdenes

Cada pata se precia con el snapshot que **ya validó los rieles** — pedir precios
otra vez abriría la puerta a que la orden se precie con un número distinto del
que aprobó el riel. Una pata solo se convierte en orden si:

- Alpaca confirma `tradable` (fail closed, igual que R11),
- hay precio de referencia,
- el movimiento alcanza para **una acción entera** (`floor`, no `round`:
  redondear hacia arriba compra más de lo que el peso pedía),
- y, si es un corto, los cortos están habilitados (lo están desde el
  2026-09-18; `ARENA_CORTOS=0` los apaga en vivo sin deploy, y entonces una
  pata `short` se descarta nombrando el motivo en vez de mandarse).

Lo que no pasa se **nombra** con su motivo. Y el límite es **marketable en los
dos lados** —vender por debajo, comprar por encima, redondeado a centavos— nunca
a mercado: la regla de la casa no cambia con el contrato.

### El candado

> *"Si el motor manda una orden que no corresponde a ningún peso, apago la
> bandera esa misma ronda."*

Eso no puede depender de que alguien lo note leyendo el journal. Se verifica
**antes de mandar**, y si falla **no se manda ninguna orden de esa corrida**: un
motor que inventa una orden no se corrige mandando las otras bien.

Dos cosas se comprueban: que cada orden corresponda a un peso del objetivo **o**
a una posición del libro (una venta de algo que está en el libro y no en el
objetivo es un cierre, que es la regla del contrato), y que el **lado sea
coherente** con el movimiento del peso — una compra que baja el peso significa
que el signo se invirtió en algún lado, y eso es peor que una orden de más.

### El envío

Secuencial y en el orden que trae el rebalanceo: lo que libera capacidad
primero. Paralelo ahorraría segundos y dejaría al **broker** decidiendo qué orden
llega primero, que es justo lo que ese orden existe para controlar.

`client_order_id` determinista (`arena-<agente>-<tag>-<fecha>-<símbolo>-<lado>`):
el mismo símbolo en la misma corrida no puede mandarse dos veces aunque el cron
se repita.

Una orden que falla **no aborta las siguientes**: media cartera puesta es un
estado real que el próximo rebalanceo corrige; abortar a la mitad deja el mismo
estado sin registro de qué faltó.

### El anuncio

`arena-contrato-objetivo-2026-09-17`, una fila `rules_changed` de liga,
idempotente por id, que **solo se escribe con la bandera encendida** — anunciarlo
apagada sería declarar un cambio que no ocurrió. Lleva el reglamento v4 completo
y, en el contexto, el criterio de aborto y cómo se apaga: si hay que apagar a
mitad de ronda, eso tiene que estar donde se está mirando y no en un chat de
ayer.

## B29 · EL CATÁLOGO DE UNA FAMILIA: `?buscar=`

```bash
curl -sS -H "x-admin-key: $KEY" \
  "$BASE/api/arena-smoke?catalog=1&buscar=qwen"
```

Gratis, cero tokens. Nace de un callejón: `ARENA_PROVIDER_IGNORE_QWEN=Alibaba`
devolvió **"All providers have been ignored"**, y el catálogo dijo por qué —
`qwen3.8-max` tiene **`endpoint_count: 1`**. Alibaba es el único que lo sirve.

Eso **cierra la hipótesis del routing**: un modelo con un solo proveedor no
tiene ruta alternativa. Si ese proveedor tarda 110s, el modelo tarda 110s, y no
hay `provider.ignore` que lo arregle. El timeout no era de Alibaba: era del
modelo.

Y deja ver que el diagnóstico anterior miraba el slug configurado en vez de la
familia. Para elegir reemplazo hace falta el catálogo entero.

Por modelo: `slug`, `nombre`, `contexto`, `max_salida`, precios en USD/millón,
`endpoint_count`, `proveedores[]` y —la columna que decide—
**`ruta_alternativa`**: `endpoint_count > 1`.

`busqueda.candidatos` aplica la regla sobre los datos y no sobre la memoria de
nadie: **un "max" servido por más de un proveedor**, con el
`ARENA_MODEL_<AGENTE>=<slug>` ya escrito para pegar en Vercel. Si no hay
ninguno, lo dice — y entonces la elección deja de ser técnica: otro tamaño de la
misma casa declarando el cambio de tier, o correr sin ese agente.

**Dos honestidades del diseño:**

- Los proveedores viven en un endpoint **aparte** de la lista de modelos, así que
  cuesta una llamada por modelo. Se piden para los 14 más relevantes (vendor
  exacto primero, "max" arriba) y se **declara** cuáles quedaron sin consultar.
- **La forma de esa respuesta no se pudo verificar al escribirla** — el sandbox
  no alcanza openrouter.ai (403 en el CONNECT). Se leen varios nombres de campo
  posibles y, si ninguno matchea, salen las claves crudas en `campos_vistos` /
  `campos_crudos_de_ejemplo` en vez de un cero inventado. Un `endpoint_count: 0`
  que en realidad significa "no supe leerlo" es peor que no traerlo.

## B27 · R11 · EL OBJETIVO TIENE QUE NOMBRAR SÍMBOLOS REALES

`tests/arena-tickers.test.mjs`

Sombra del 2026-09-17: deepseek devolvió `{"EO G": 0.15, "FS LR": 0.1}` — EOG y
FSLR con un espacio adentro. El JSON era válido, los pesos eran válidos, y **los
diez rieles lo aprobaron entero**. `rail_meta` lo vio ("2 nombres sin fila de
/v2/assets") y eso no frenaba nada. En vivo, el motor habría mandado una orden
sobre un ticker inexistente.

Lo que faltaba no era un riel más estricto: **era la pregunta**. Los rieles
juzgan una CARTERA —pesos, concentración, cortos— y ninguno preguntaba si el
NOMBRE existe.

### De dónde sale el espacio: no de nuestro código

Descartado, y con un test que lo congela:

- todos los `join` del camino de salida son `join('')` — ninguno mete
  separadores;
- la compactación reescribe mensajes `tool`, **nunca** el contenido del
  asistente;
- el turno de cierre no se compacta;
- `parseTarget` hace `trim()`, que no toca los espacios internos.

El JSON llegó **bien formado con el espacio DENTRO de la clave**, así que el
modelo lo emitió así. Es un artefacto de deepseek y contra eso no hay arreglo
aguas arriba: solo defensa.

### La defensa, en dos capas y en este orden

**1. Normalizar y validar contra el universo, ANTES de los rieles.**

Quitar espacios no es adivinar: un ticker **no puede** contener uno — eso es un
hecho sobre los tickers, no una interpretación de la intención. Lo que sí sería
adivinar es aceptar el resultado sin verificarlo, y eso no pasa: el símbolo
canonicalizado tiene que estar en el universo del día.

Si alguno no está, **se rechaza el objetivo ENTERO** (`rejected_tickers`, estado
propio, distinto de `rejected_rails`). No la posición suelta: una cartera a la
que se le saca una pata ya no es la que el PM decidió.

Toda reparación se **reporta**. Si un modelo empieza a corromper tickers de
forma sistemática, esconderlo detrás de un arreglo silencioso es cómo se deja de
notar. Y dos claves que colapsan al mismo símbolo se rechazan en vez de sumarse:
sumarlas inventaría un peso que el modelo no escribió.

**2. R11 — el símbolo tiene que ser operable.** El universo dice que el nombre
existe; Alpaca dice si se puede operar hoy. Son dos preguntas. `tradable !== true`
(no hay fila, o la hay y no es operable) es violación, para largos **y** cortos.
Fail closed, igual que R9.

### Y la lección de R6, aplicada

Si **ningún** símbolo trajo fila de Alpaca, eso no es un objetivo malo: es que
`/v2/assets` no contestó. R11 sigue rechazando —una orden que no se puede
verificar no se manda— pero como **una** falla nuestra
(`es_falla_nuestra: true`), no como ocho del PM.

La diferencia con R6 importa y está declarada: un sector que falta **no impide
ejecutar**; una fila de asset que falta **sí**. Por eso R6 avisa y R11 rechaza —
pero los dos dicen de quién es la falla.

### El lint que protege el encendido

El camino VIVO (`arena-run.js`) todavía corre el contrato viejo, así que hoy esto
solo vive en la sombra. Hay un test estructural que exige que **cualquier**
archivo que llame a `validateTarget` llame también a
`normalizarTickersObjetivo`. Cuando el contrato nuevo se encienda en producción,
ese test se pone rojo si alguien conecta los rieles sin este paso — que es
exactamente el momento en que el bug pasaría de la sombra a una orden real.

## B28 · EL RELOJ DEL CIERRE MEDÍA CONTRA EL PRESUPUESTO EQUIVOCADO

`"quedan -70s"` en el reporte de qwen. La aritmética era correcta sobre el
presupuesto **equivocado**: `restante()` mide contra el presupuesto de
INVESTIGACIÓN, y el cierre corre por fuera de él (la reserva se descontó al
calcularlo). Después de un cierre de 110s, `restante()` da −70.

Peor que el número feo: en un **segundo** intento de cierre, `RESERVA + sobrante`
volvía a sumar la reserva entera, dándole un techo que ya no existía. Así es como
el total se pasaba del deadline sin que la cuenta lo delatara.

Ahora el cierre mide contra el total y el techo cierra exacto en los tres casos:

| loop usó | cierre recibe | total |
|---|---|---|
| 40s | 215s | 255s |
| 145s | 110s | 255s |
| 180s | 75s | 255s |

## B26 · SOMBRA DE LOS SIETE: 5/7, y grok SÍ cerró

`2026-09-16 19:00 UTC`, commit `289453f`, costo **$1.01**.

| agente | resultado |
|---|---|
| claude | `ok_target` · 11 herramientas · 6 posiciones · enfoque `catalizador` |
| control | `ok_target` · 9 herramientas · 7 posiciones · enfoque `catalizador` |
| **grok** | **`ok_target`** · 20/20 herramientas · 4 posiciones |
| gemini | `ok_target` · 11 herramientas · 5 posiciones (2 cortos) |
| deepseek | `ok_target` · 20/20 herramientas · 3 posiciones |
| openai | `aborted_llm_error` — **429 rate limit upstream** |
| qwen | `aborted_cuerpo_vacio` — **timeout nuestro, proveedor desconocido** |

**El reparto del reloj funcionó**: grok gastó sus 20 herramientas y cerró. Los
rieles también — `with_sector` en 6/6, 7/7, 4/4, 5/5, 3/3 y
`sector_unknown_bucket: 0` en todos, contra los ceros de hace dos días.

### openai: un 429 no es una pared

```
openai/gpt-6-astra is temporarily rate-limited upstream.
Please retry shortly (code 429)
```

Murió en la vuelta 2 con **cuatro herramientas ya pagadas**. El proveedor decía
literalmente que se reintentara, y el loop lo trataba igual que a un contexto
excedido: salida inmediata, corrida perdida.

Una **cola** se espera; una **pared** no. `esTransitorio()` separa las dos con
una lista corta a propósito —429, 502, 503, 529, más un respaldo por texto— y
excluye explícitamente lo que no se mueve solo (contexto excedido, moderación).
Un reintento por corrida, con 6s de espera: volver a los 2 segundos es ponerse al
final de la misma cola.

Si vuelve a fallar, sale por el camino de siempre con `murio_en.transitorio` y
`reintentado: true`, para que no se confunda con un fallo nuevo. Y
`errores_transitorios[]` se journalea **aunque la corrida se recupere**: un
proveedor en cola es un dato sobre el proveedor, no solo sobre la corrida que
falló.

### qwen, y el hueco de mi propio diseño

```json
{"vuelta":5,"intento":1,"proveedor":null,"timeout_nuestro":true,"ms":34678}
{"vuelta":5,"intento":2,"proveedor":null,"timeout_nuestro":true,"ms":32984}
{"vuelta":"cierre","intento":1,"proveedor":null,"timeout_nuestro":true,"ms":104985}
```

**La exclusión automática de proveedor no se disparó, y no podía.** OpenRouter
manda el proveedor **dentro del cuerpo** — así que en el caso exacto en el que
hace falta saber quién colgó, el dato no llega. El diseño de B23 esperaba un
nombre que por construcción no iba a existir.

El hueco no se cierra desde acá. Lo que sí se arregla es que deje de ser un
callejón sin salida:

- `politica_pedida` viaja con la respuesta: qué routing se **pidió**, que es lo
  único que se sabe con certeza cuando el proveedor no se puede leer.
- El error dice la salida concreta —`ARENA_PROVIDER_IGNORE_<AGENTE>`, sin
  deploy— **en el mensaje**, no en un campo que hay que ir a buscar.
- El cierre omitido reporta las **dos** condiciones (`sin_proveedor`,
  `sin_reloj`). El reporte decía solo "no se sabe qué proveedor atendió" cuando
  además el reloj estaba agotado a los 105s, y eso manda a arreglar media cosa.

**Y el segundo dato importa más que el primero: 105 segundos y sin cuerpo.** Más
reloj no es la respuesta para qwen — el cierre ya recibió el doble de lo que
recibía antes. La salida es el routing, y eso se configura con evidencia: el
trace de una corrida que **sí** contestó dice quién atendía.

## B24 · EL REPARTO ENTRE INVESTIGAR Y DECIDIR

Sombra de los siete, 2026-09-17: **6/7**. El único que cayó fue `grok`, y con el
diagnóstico ya correcto: *"TIMEOUT NUESTRO leyendo el cuerpo"*, 45.003 ms, en el
**cierre**, después de gastar sus 20 herramientas (`stopped_by: call_budget`).

No era el proveedor. Le dimos 45 segundos para redactar el libro final sobre un
payload enorme — y el resto del presupuesto del loop, **minutos en ese caso**, se
tiró sin usar.

**La reserva del cierre pasa a ser un piso, no un techo:**

- Sube de **45s a 70s**. Un modelo que razona mucho sobre un libro de ocho
  posiciones no redacta el JSON en 45 segundos. Sale del presupuesto del loop,
  que es tiempo de *investigar* — y de nada sirve investigar si después no se
  alcanza a decidir.
- **El cierre se lleva además todo lo que sobró.** `restante()` es presupuesto de
  investigación que ya no se va a usar: el loop terminó. Si el loop corta a los
  40s de un presupuesto de 185, el cierre recibe 70 + 145 = **215 segundos** en
  vez de 45.

El techo total no se mueve — `relojDisponible` ya descuenta la reserva, así que
`reparto + cierre ≤ presupuesto + reserva` pase lo que pase. Lo único que cambia
es **quién usa el tiempo que sobra**.

```
arena-run:  scan 90s + loop 95s + cierre 70s = 255s < 270s de deadline
sombra:                loop 185s + cierre 70s (mínimo)
```

`limites.reparto_ms` journalea los cuatro números: investigación usada,
sobrante, mínimo del cierre y **cuánto se le concedió de verdad**. Sin ese
desglose, "grok se pasó de tiempo" no distingue *le faltó reloj* de *le sobraba y
no se lo dimos*, que es lo que pasaba.

Lleva también `reparto_en_ms`: el instante exacto del reparto. `limites()` lee el
reloj más tarde, así que sin él el invariante no se puede verificar — se estaría
sumando un `usado` posterior contra un techo calculado antes. Lo encontró el
test al ponerse rojo con un reloj falso.

## B25 · EL RVOL INTRADÍA VACIABA LOS FILTROS DE MOMENTO

`ret_1d_min: 2` + `min_rvol` → **0 filas**. Las mismas llamadas sin `min_rvol` →
**5 filas**.

El RVOL es el volumen **parcial** de hoy contra sesiones **completas**. A las
10:30 la sesión lleva ~15%, así que un nombre con volumen 3× lo normal lee
**0.46** — y cualquier umbral de "volumen inusual" lo descarta. El tablero ya lo
etiquetaba en el prompt, pero **un filtro no lee etiquetas**.

**No se "corrige" el número.** El volumen intradía tiene forma de U —pesado en el
open y en el cierre— así que dividir por la fracción de reloj sobreestimaría el
RVOL temprano tanto como la medición cruda lo subestima. Cambiar un sesgo
conocido por otro inventado no es un arreglo.

Lo que se hace:

1. **`rvol_top: true`** — el TOP 20 por RVOL del día. Un **rango** no se
   distorsiona con la hora, porque todos los nombres se miden al mismo tiempo. Es
   la forma interpretable de preguntar "¿está operando raro?" antes del cierre, y
   la descripción de la herramienta lo dice.
2. **El cero explica la hora**: cuánto lleva la sesión, que el sesgo es
   estructural, **el RVOL más alto de todo el tablero ahora mismo** (para que el
   modelo vea la escala real), y la alternativa. Más `sesgo_intradia`
   estructurado al lado del texto.
3. **Con la sesión cerrada, el aviso desaparece**: un cero de RVOL a las 16:00 es
   un cero de verdad y no se disculpa. El aviso no puede volverse una excusa
   permanente.

`board.sesion_pct` publica la fracción transcurrida, que es lo que vuelve
interpretable cualquier RVOL: un `rv0.3` a las 10:30 y uno a las 15:45 significan
cosas opuestas.

## B23 · CORRECCIÓN: el "cuerpo vacío" era NUESTRO timeout

El trace de qwen del 2026-09-17 trajo el número que cerró el caso:

| vuelta | duración | cuerpo |
|---|---|---|
| 1-3 | 23s / 13s / 32s | OK, hasta 28 KB |
| 4 | **10.000 ms** | vacío |
| cierre | **45.002 ms** | vacío |
| reintento | **45.002 ms** | vacío |

**45.000 es `RESERVA_CIERRE_MS`.** 10.000 es el piso de `Math.max(10000, …)`
cuando ya casi no quedaba presupuesto. Los dos son **techos nuestros**, no del
proveedor.

### El mecanismo, reproducido

```js
const r = await fetch(url, { signal: AbortSignal.timeout(300) });
// → resuelve con 200 a los 31 ms (los HEADERS ya llegaron)
const texto = await r.text().catch(() => '');
// → r.text() lanza TimeoutError a los 304 ms; el .catch lo convierte en ''
// → se reporta "HTTP 200 con el cuerpo vacío"
```

`fetch` resuelve en cuanto llegan los **headers**. OpenRouter manda el 200 al
instante y después keepalives de espacios mientras el proveedor de abajo piensa.
El cuerpo se lee en `r.text()` — y el `AbortSignal` cubre **también** esa
lectura. Cuando nuestro reloj vencía a mitad del cuerpo, `r.text()` lanzaba y el
`.catch(() => '')` lo borraba.

**Un timeout tragado se ve idéntico a una falla del otro lado, y lleva a
arreglar lo que no está roto.** Esto invalida el diagnóstico de B19 ("el
proveedor cierra el stream"): el que cortaba éramos nosotros.

El mismo `.catch` estaba en el camino de **Anthropic**. Ahí importa incluso más:
claude y control son el par que mide el piso de ruido, y un timeout mal
etiquetado en cualquiera de los dos contamina la única referencia contra la que
vale un delta entre modelos. Los dos caminos distinguen ahora `abortadoLeyendo`
—nuestro corte— de un cuerpo que el proveedor cerró de verdad.

### Routing de proveedor

Un mismo modelo en OpenRouter lo sirven varios proveedores, y **no rinden
igual**: las vueltas 1-3 de qwen contestaron en 23s, 13s y 32s, y después el
mismo `Alibaba` se colgó tres veces hasta nuestro techo.

**OpenRouter no hace fallback por lentitud**, solo por error. Un proveedor que
tarda 200s y uno que devuelve 500 se ven distinto desde su lado e idéntico desde
el nuestro.

```
ARENA_PROVIDER_IGNORE_<AGENTE>   lista por comas   ("Alibaba,Novita")
ARENA_PROVIDER_ORDER_<AGENTE>    preferencia, en orden
```

Por agente y **sin deploy**, porque cuál proveedor se cuelga cambia con el día y
la hora. **El default no ignora a nadie**: apagar un proveedor a ciegas puede
dejar a un modelo sin quien lo sirva, y el que se cuelga hoy es el que anda
mañana. `allow_fallbacks: true` siempre — un orden es una preferencia, no un
candado.

Lo que **sí** es automático: cuando un proveedor nos cuelga, se acumula en
`proveedores_colgados` y **todas las llamadas siguientes de esa corrida lo
excluyen**, el turno de cierre incluido. Eso aplica igual a los tres agentes de
OpenRouter sin que haya que saber de antemano cuál falla — no hace falta haber
visto el trace de grok o deepseek para que los cubra.

`proveedores[]` journalea quién atendió cada vuelta, **también las buenas**:
"Alibaba se cuelga" solo significa algo si se sabe quién contestó las tres que sí
anduvieron.

### El reparto del reloj

El trace mostró el orden exactamente invertido: la vuelta 4 se saltó su reintento
por "sin reloj", y después el cierre quemó **90 segundos en dos intentos
idénticos al mismo proveedor colgado**.

- El reintento de una vuelta útil puede **morder la reserva del cierre** hasta
  dejarle lo mínimo para uno. Un cierre alcanza si además se le cambia el
  proveedor.
- El cierre pide **lo que queda**, no 45s que ya no existen.
- El segundo cierre va a **otro proveedor**, o no va: si no se sabe a quién
  excluir, un intento idéntico sería el mismo error otra vez, y es mejor cerrar
  sin él.

### El trace, a 16 KB

Con 4096 los payloads reales (28-36 KB) se recortaban **todos al mismo largo**,
así que el diff entre vueltas reportaba `delta 0` siempre: el recorte destruía
justo el número que más importaba. Ahora son 16 KB (`ARENA_TRACE_BYTES`) y el
diff mide sobre el **tamaño real** guardado aparte, así que sigue siendo útil
aunque el cuerpo venga recortado. El diff publica además el proveedor y los ms
de cada vuelta, que es donde se vio el patrón.

## B22 · LOS TRES HUECOS DE DATOS QUE ENCONTRÓ EL DIAG

`tests/arena-universo-datos.test.mjs`

Los tres tienen la misma forma, y por eso eran fáciles de no ver: **nada falla,
nada lanza**, y el síntoma aparece lejos del origen como "la herramienta X
devuelve 0 filas".

### 1. Los sectores no sobrevivían a la escritura

El diag del 2026-09-16 mostró `sectores: 0`, con DELL y COP marcados
`origen: "indice"` y `sector_gics: null`. La explicación natural —y la que
dimos los dos— era que la foto guardada en Neon (del 15 a las 23:53) era
**anterior** a que se leyera la columna `Sector`, y que el refresco semanal la
releía vieja.

**No era eso.** `writeStored` guardaba esto:

```js
JSON.stringify({ symbols: snapshot.symbols })
```

Los sectores GICS se bajaban bien del CSV, viajaban bien, y se **tiraban ahí**.
Una foto recién bajada tenía sectores; la misma foto leída de vuelta, no —
siempre, sin importar la fecha. `readStored` tampoco los devolvía.

Lo que lo hacía invisible: `symbols` **sí** se guardaba, así que el universo se
construía con sus 502 nombres correctos y nada fallaba. El hueco aparecía tres
capas más allá, como tres bugs distintos: `sector(XLE)` sin filas,
`with_sector: 0` en los rieles, y el screener con `sector:XLK` vacío.

Si solo se hubiera arreglado el refresco, el bug habría quedado **enmascarado**:
se re-bajaría el CSV todos los días, obteniendo sectores frescos cada vez, y la
copia guardada seguiría vacía para siempre.

**Dos arreglos, y los dos hacen falta:**

- `writeStored` persiste `sectores` y `readStored` los lee. Escribir sin leer
  sería el mismo hueco con otra cara.
- Un snapshot **sin sectores se refresca solo**, sin esperar los 7 días: la
  ventana de edad contesta "¿cambió la lista?", no "¿esta foto trae lo que hoy
  necesitamos?". `refrescado_por: 'sin_sectores'` lo deja escrito.

**Las dos condiciones son independientes, a propósito.** `sin_sectores` habilita
solo el reintento del **CSV** (gratis); `vencido` o `forzado` habilitan también
**FMP**. Si se mezclaran, una lista de FMP —que nunca va a traer clasificación
GICS— quedaría en `sin_sectores` para siempre y el refresco semanal **dejaría de
dispararse**. Se reintenta donde el reintento puede arreglar algo.

Y si el refresco falla con la lista sin sectores, la nota **nombra los tres
síntomas** que eso produce, para que no vuelvan a diagnosticarse por separado.

```bash
curl -s "$BASE/api/arena-universe?refresh=1&force_constituents=1&key=<KEY>"
```

`?force_constituents=1` es una perilla **aparte** de `?refresh=1`: reconstruir el
universo del día (precios, volumen, admisión) y re-bajar los CSV de tenencias
son dos costos con dos cadencias distintas.

### 2. `ret_1m` era null para todos, por construcción

`barsPorFeed` recortaba las velas con `.slice(-days)`, y `days` es **20** — la
ventana del promedio de **volumen**. El retorno a 1 mes mira 21 sesiones atrás:

```
cerradas[20 − 1 − 21] = cerradas[−2] = undefined → null
cerradas[20 − 1 −  5] = cerradas[14]            → OK
```

`ret_5d` funcionaba, y eso hacía que el bug se leyera como *"a veces no hay
dato"* en vez de *"nunca lo hubo"*. Por eso el screener con `ret_1m_min` devolvía
0 filas — y el modelo lo leía como "ningún nombre subió 5% en el mes".

**Dos ventanas se estaban pisando.** Ahora se conservan `max(days, 22)` velas y
el promedio de volumen sigue usando **solo sus 20**: ensanchar la ventana de
liquidez de rebote cambiaría en silencio a quién admite el universo. La ventana
de calendario también creció (22 sesiones necesitan ~31 días hábiles, más margen
para festivos). Y `sessions` / `sessions_volumen` se reportan: un `ret_1m: null`
con 22 sesiones sería un bug nuestro, con 8 es una acción que cotiza hace ocho
sesiones.

### 3. `market_cap` exactamente $1B era una cota, no una medida

A los nombres de índice se les **asume** el piso de $1B por pertenecer al índice,
en vez de gastar 500 llamadas de Finnhub para confirmar lo que el comité del
S&P ya garantiza. Para **admitir** está perfecto: el criterio es "≥ $1B" y la
pertenencia lo prueba.

Pero ese número se guardaba igual que uno medido. Con `min_mcap_b: 10`, los 502
del índice quedaban fuera —**Apple y Microsoft incluidas**— y el modelo leía
"ningún nombre grande cumple".

**El filtro no cambia**: una cota de $1B no alcanza para un umbral de $10B, igual
que no alcanzaría una medición de $1B. Fail-closed, como el resto de los rieles.
Lo que cambia es el **reporte**: el cero ahora dice que el cap **no se midió**,
desmiente explícitamente la lectura falsa, y sugiere qué hacer. Son dos
respuestas distintas y llevan a decisiones distintas.

El encabezado de la admisión ya decía que la suposición se declaraba "nombre por
nombre". No era cierto: solo se guardaba un **conteo**. Ahora el universo publica
`market_caps_asumidos` con los símbolos.

## B21 · EL PRESUPUESTO DE INVESTIGACIÓN: tres techos, ninguno redondo

`api/_lib/arena-tools.js` · `api/_lib/arena-tool-loop.js` ·
tests en `tests/arena-presupuesto-investigacion.test.mjs`

Eran **8 llamadas y punto**. Ocho no sale del costo, ni del reloj, ni del
contexto: es un número redondo, y cortaba la investigación a la mitad de una
tesis con presupuesto de sobra.

Ahora son **tres techos simultáneos** y gana el que se agote primero:

| techo | valor | qué mide |
|---|---|---|
| llamadas | **20** (`ARENA_TOOLS_MAX`) | el tope grosero: veinte no es investigar, es un bucle |
| contexto | **30K tokens** (`ARENA_TOOL_CONTEXT_TOKENS`) | el que de verdad aprieta |
| reloj | **derivado** (`ARENA_TOOL_LOOP_MS`) | 120s en arena-run, 210s en la sombra |

**Los tres cortan igual: se cierra con lo que haya. Ninguno aborta.** Lo que
cambia entre ellos es el **nombre** — `stopped_by` es `call_budget`,
`context_budget`, `time_budget` o `max_turns`, y el mensaje de cierre dice cuál
se agotó. "Se acabó el presupuesto" sin decir cuál de los tres no dice nada, y
los tres se arreglan distinto.

`limites` viaja al journal con **los tres al lado** y su porcentaje de consumo:
saber cuál ganó no alcanza, hace falta ver si ganó por poco o por lejos. Un
corte por contexto con las llamadas en 6/20 dice que el techo de llamadas está
de adorno y que lo que hay que mover es el otro.

### El reloj se deriva, y los 240s no caben

Era una constante de 120s escrita a mano. Un número fijo no sigue al deadline:
si alguien lo sube, el loop no se entera y se corta igual aunque sobre tiempo.

```
arena-run:  deadline 270s − scan 90s − cierre 45s − margen 15s = 120s
sombra:     deadline 270s            − cierre 45s − margen 15s = 210s
```

(Que la fórmula reproduzca exactamente los 120s que antes estaban escritos a
mano es la señal de que deriva lo mismo, no algo nuevo.)

La sombra tiene más reloj porque el contrato nuevo **no tiene fase de scan**: es
una sola cadena que arranca directo en el loop. Usar el default le regalaría 90
segundos de investigación por una fase que no corre.

**Los 240s pedidos no caben**, y la resta es corta:

```
  función  300s   cap del plan Pro, en vercel.json
− margen    30s   para que una corrida que se pasa alcance a ESCRIBIR que se pasó
= deadline 270s
− cierre    45s   la llamada que convierte una corrida perdida en una decisión
− margen    15s   Alpaca + journal
= loop     210s   ← el máximo honesto en la sombra
```

Los 30s que faltan solo salen de comerse uno de los dos márgenes, o sea de pagar
un número redondo con la evidencia de los fallos: un timeout que no se journalea
es indistinguible de una corrida que nunca ocurrió. Hay un test que deja la
resta escrita para que 240 no se cuele después sin ella.

### La compactación, que es lo que hace real el techo de 20

El payload crece de forma **cuadrática**: cada resultado se queda en la
conversación y vuelve a viajar en todas las vueltas siguientes. La vuelta 3 de
qwen ya pesaba 36 KB **con 8 llamadas**.

Los resultados de vueltas anteriores se resumen a **cabecera + primeras filas**.
Las listas vienen ordenadas por relevancia (el screener por magnitud del
movimiento, las noticias por fecha), así que las últimas filas son, por
construcción, las menos informativas. Lo que se acaba de traer queda **entero**:
el modelo está razonando sobre eso ahora mismo, y compactarlo sería cobrarle la
llamada sin darle el resultado.

Medido con resultados del tamaño real del tope (`ficha`, `noticias` a ~1.5K
tokens):

| | llamadas | pico de contexto | qué cortó |
|---|---|---|---|
| sin compactar | 20/20 | **30.387 tok** | `context_budget` |
| compactando | 20/20 | **7.887 tok** | `call_budget` |

Sin compactación el techo de contexto corta primero y las últimas llamadas no se
podrían usar nunca — el techo de 20 sería decorativo. Y el pico es lo que se
paga **en cada vuelta**, así que 3,9× menos contexto es también 3,9× menos
tokens de entrada.

**La regla que no se negocia**: el modelo tiene que **saber** que se compactó.
Cada resultado compactado lleva `[COMPACTADO]`, cuántas líneas se omitieron, y
que **no significa que no existan**. Un recorte en silencio hace que razone
sobre una lista que cree completa y después afirme "no hay ningún nombre que
cumpla" — el mismo error que `truncateRows` ya evita una capa más arriba.

Y se compacta **solo lo que se re-envía**. `executor.sequence` —el registro que
alimenta el journal y el replay— queda entero: compactar la evidencia sería
perder de qué miró el modelo para decidir. Hay un test que lo verifica.

### El cupo agotado ya no gasta vueltas

Con 8 llamadas casi no se notaba. Con 20 sí: un modelo que quemaba su cupo en la
vuelta 6 se comía las 16 vueltas restantes pidiendo herramientas que solo podían
devolverle "presupuesto agotado" — y **cada una de esas vueltas es una llamada
al LLM con la conversación entera adentro**. Se pagaba el contexto completo
dieciséis veces para cosechar dieciséis rechazos.

Ahora, sin cupo no hay nada que investigar: se va derecho al cierre.

## B19 · RESUELTO: los abortos eran HTTP 200 CON EL CUERPO VACÍO

El trace de qwen del 2026-09-16 cerró el caso que llevaba cuatro sombras y tres
hipótesis fallidas:

| | |
|---|---|
| dónde | `loop`, vuelta 3 (la posterior al techo de herramientas) |
| status | **200** |
| duración | **41.5 s** |
| cuerpo | **`""` — cero bytes** |
| request | 36.489 caracteres |
| herramientas | 8/8 usadas, 9 pedidas |

Las vueltas 1 y 2 completaron bien, con keepalive de espacios al inicio que
`JSON.parse` tolera sin problema.

### Por qué se veía como "HTTP 200 y todo lo demás en null"

```js
error_detail: first.netError || (first.bodySample ? `cuerpo no-JSON: …` : null),
raw_body: first.bodySample || null,
```

Con el cuerpo vacío, `bodySample` es `''` — **falsy**. Así que `error_detail` y
`raw_body` salían `null`. **Los nulls no eran datos faltantes: eran la firma del
cuerpo vacío.** Leerlos como "no capturamos nada" fue lo que mandó tres rondas
de diagnóstico a buscar el problema en la capa equivocada.

### Es transporte, no formato

OpenRouter abre la conexión, manda el 200, manda keepalives durante ~40 s y
cierra el stream **sin cuerpo**. Un payload mal armado no hace eso: vuelve 400 o
200 con un `error` adentro, y los dos ya se manejaban. **Por eso ninguna
hipótesis sobre la forma del payload sobrevivía a la corrida siguiente** — no
había nada malo en la forma.

### Los tres arreglos

**1. `cuerpo_vacio` es una clase de error propia.** `emptyBody: true`, con los
bytes y un `error_detail` que dice qué pasó. En el journal es
`aborted_cuerpo_vacio`, no `aborted_llm_error`, y `llm_error.motivo` lo repite.
Un motivo que se confunde con otro es un diagnóstico que no existe.

**2. Se reintenta y, si falla, se CIERRA — no se aborta.** La misma vuelta, una
vez, tras 2 s (no 20: la vuelta que falló ya se comió ~40 s del presupuesto del
loop). Si el segundo intento también vuelve vacío, el loop **salta al turno de
cierre** con `tool_choice: none`: un PM que investigó ocho veces y no puede
escribir su JSON es peor que uno que cierra con lo que tiene. El mensaje de
cierre dice la verdad —*"hubo un corte de conexión"*— en vez de culpar al
presupuesto. El turno de cierre tiene el mismo reintento.

`cuerpos_vacios[]` viaja al journal **aunque la corrida termine bien**: un corte
que el reintento recuperó sigue siendo un corte, y perderlo dejaría como única
evidencia de inestabilidad del proveedor las corridas que además fracasaron — la
mitad del cuadro.

**3. El eco del asistente va limpio** (camino OpenAI únicamente). Antes se
ecoaba `_raw_message` tal cual, con `reasoning` y `reasoning_details`. Ahora solo
los campos del contrato: `role`, `content`, `tool_calls`, `name`, `refusal`.

- **No son del contrato**: el mensaje `assistant` de la API de OpenAI no declara
  `reasoning`; son extensiones de OpenRouter **para la respuesta**.
- **El payload crecía sin necesidad**: 5.173 → 128 bytes por vuelta en el caso
  medido, y se acumula en cada vuelta siguiente.

**Lo que cuesta, declarado**: algunos proveedores usan `reasoning_details` para
preservar la cadena de razonamiento entre turnos, así que quitarlo *puede*
degradar la continuidad. Se acepta: hoy tres de siete abortan todas las
corridas, y una posible pérdida de calidad le gana a una pérdida segura.
`ARENA_ECHO_REASONING=1` vuelve al comportamiento viejo sin deploy, para poder
**medir** la diferencia en vez de discutirla.

Anthropic **no se toca**: exige el eco verbatim con los bloques de thinking en su
orden original.

### El diff entre vueltas

`trace.diff_entre_turnos[]` compara cada vuelta con la anterior y reporta lo
estructural: cuántos mensajes, de qué roles, **qué claves aparecieron en los
`assistant`** (ahí se ve si viaja `reasoning` de vuelta), cuánto creció el
cuerpo, y un `descuadre_tool` si hay `tool_calls` sin su mensaje `tool`.

Ese último detecta solo la hipótesis de los cupos, sin que nadie tenga que
suponerla. Con payloads de 36.000 caracteres recortados a 4 KB, comparar a ojo en
una terminal no es viable — y es la comparación que decide el diagnóstico.

## B20 · QUÉ BUILD CONTESTÓ

`api/_lib/build-info.js` — cada endpoint del Arena devuelve `build.commit`.

El `?diag=DELL,COP` del 2026-09-16 devolvió una corrida normal, sin la sección de
diagnóstico, y la pregunta razonable fue *"¿se ignora el parámetro?"*. No: el PR
se mergeó a las **16:24:36 UTC** y la consulta salió a las **16:24**. El
parámetro llegó a un build que no lo conocía.

Eso costó una ronda entera para una pregunta que la propia respuesta podía
contestar. Ahora la contesta: si el commit no es el que esperabas, el deploy no
salió — no es un parámetro ignorado. Observabilidad pura, nunca lanza, y sin las
env vars de Vercel devuelve nulls en vez de inventar.

## B16 · EL TRACE: la conversación entera, turno por turno

`api/_lib/arena-trace.js` · tests en `tests/arena-trace.test.mjs`

```bash
curl -s "$BASE/api/arena-shadow?agent=qwen&trace=1&key=<ARENA_ADMIN_KEY>"
```

Tres agentes de OpenRouter (grok, qwen, deepseek) abortaron cuatro sombras
seguidas y llevábamos **tres rondas de hipótesis**: que el cierre iba sin
`tools` declaradas, que la captura estaba en la capa del fetch, que estaba en la
capa de lectura. Cada una explicaba los síntomas y ninguna sobrevivió a la
corrida siguiente.

El problema no era la hipótesis: **no se veía el payload**. Todo lo journaleado
eran resúmenes —status, 800 caracteres de la *respuesta*, la secuencia de
herramientas— y ninguno incluía lo único que decide el caso: **qué le mandamos
al proveedor en la vuelta que falló**.

Por vuelta: el cuerpo HTTP exacto que salió, el texto crudo que volvió (4 KB cada
uno, con el recorte declarado), status, tiempo, y el stack si algo lanzó. Exige
`?agent=<uno>` — el trace de una vuelta lleva el prompt entero más todos los
resultados de herramientas acumulados, y siete no caben en una respuesta. No se
cachea y el trace **no altera el payload**: hay un test que compara byte a byte
lo que sale con trace y sin trace.

### `cierre: null` significaba dos cosas opuestas

El hallazgo que salió de mirar el código en vez de los síntomas. El loop tiene
una salida temprana cuando el proveedor devuelve algo inusable:

```js
if (llm.status !== 200 || !llm.data || …) return { …, stopped_by: 'error' };
```

Esa salida **no pasa por el bloque de cierre**, así que `cierre_diagnostico`
queda en `undefined` y el journal muestra `cierre: null`. Leído desde afuera eso
parece *"el cierre no falló"*; lo que significa es *"el cierre **nunca
ocurrió**: el loop murió antes"*. Son cosas opuestas y se veían idénticas — por
eso tres rondas de diagnóstico apuntaron al turno de cierre, que en esas
corridas ni se ejecutó.

Ahora la salida se nombra: `murio_en` con la vuelta exacta, cuántas herramientas
llevaba contra el techo, el status, el cuerpo crudo del proveedor y el stack. Un
`cierre: null` con `murio_en` poblado ya no se puede leer al revés.

### La hipótesis de los cupos, falsificada en el código

Lety propuso: *"cuando el modelo pide más herramientas de las que quedan, las
rechazadas no reciben un mensaje `tool` con su `tool_call_id`; Anthropic y OpenAI
lo toleran pero los otros tres no"*. Es una hipótesis buena —ese payload sí
rompería a varios proveedores— y es **falsificable sin esperar otra corrida**.

`tests/arena-trace.test.mjs` ejercita el caso exacto (3 pedidos, 1 de cupo):

- `executor.call` devuelve **texto** para las rechazadas, no `undefined`;
- `buildToolTurn` emite **3 mensajes `tool`**, uno por `tool_call_id`, las
  rechazadas incluidas;
- ninguno va con `content` vacío, que es la otra forma de romper el mismo payload.

**El payload sale bien formado en el caso descrito.** Lo que el test *no* puede
descartar es que rompa otra cosa dentro del mismo mensaje — el eco de
`_raw_message`, que para los modelos de razonamiento incluye `reasoning` /
`reasoning_details`, es el siguiente sospechoso. Eso solo se ve con el cuerpo
real de la vuelta que falló, que es exactamente lo que el trace captura.

## B17 · LOS TRES CEROS: qué dato falta y dónde

### El embudo del screener

`screener` encadena hasta diez filtros y devolvía `0 filas` sin decir cuál los
dejó en cero. Con seis criterios activos, eso obliga al modelo a probar de a uno
— y cada prueba cuesta una llamada del presupuesto.

Ahora el cero nombra al culpable y publica el embudo completo:

```
Ningún nombre del universo cumple esos criterios hoy. (El screener filtra sobre
los 118 nombres que el tablero cubre, no sobre el universo entero…)
EL FILTRO QUE SE LLEVÓ LOS ÚLTIMOS NOMBRES: `sector=XLK` (118 → 0). Aflojá ESE
criterio, no los otros.
Embudo completo: sector=XLK: 118→0 · ret_1d_min=3: 0→0.
```

Y sigue distinguiendo los dos ceros que ya distinguía: *nadie cumple* vs. *no
tenemos el dato* (`datos_faltantes`), ahora con `sector` entre los datos que se
reportan como faltantes.

**Sobre los nombres de campo**: se verificaron contra `_lib/arena-board.js`. Las
cinco listas del tablero (`gainers`, `losers`, `rvol`, `breakouts.high`,
`breakouts.low`) salen todas del mismo array `filas`, con la misma forma
(`symbol`, `price`, `change_pct`, `rvol`, `pct_from_high`, `pct_from_low`), y el
screener lee exactamente esos nombres. **No hay desalineación de campos** — que
`near_52w_low` devolviera filas y el resto cero ya lo indicaba: si los nombres
estuvieran mal, ese también habría dado cero.

### El diagnóstico del universo

```bash
curl -s "$BASE/api/arena-universe?diag=DELL,COP&key=<ARENA_ADMIN_KEY>"
```

Gratis, cero construcción, cero llamadas a Alpaca: lee lo **guardado**. Existe
porque los tres ceros (`sector(XLE)`, `with_sector=0`, el screener) tienen la
misma pregunta debajo y no había forma de contestarla sin entrar a Neon a mano.

Devuelve los cuatro contadores que deciden todo —`sectores`, `retornos`,
`market_caps`, `fifty_two_week`— y, por nombre: si está en el universo, si vino
del índice o del canal del día, su sector GICS, su ETF de sector, sus retornos y
su market cap. Más `indices`, que dice de qué foto salieron los constituyentes y
cuándo.

Separa las **tres** cosas que se confunden y que exigen arreglos distintos:

1. el nombre **no está** en el universo → ninguna herramienta lo va a encontrar;
2. está **sin ese campo** → si vino del canal del día es esperado (los sectores
   salen del CSV del índice); si vino del índice, el CSV no trajo la columna
   `Sector` **o el snapshot de constituyentes guardado es anterior al soporte de
   esa columna** — el refresco es semanal, así que una foto vieja se relee tal
   cual sin que nada falle a la vista;
3. el campo **está** y el consumidor no lo lee → el bug está en el consumidor.

Sin separarlas, cualquier arreglo es a ciegas. `sectores_count: 0` en la salida
significa (2) y no (3): no hay nada que arreglar en los rieles ni en la
herramienta `sector`.

## B18 · EL PISO DE RUIDO SE ARCHIVA

`arena_noise_floor` — una fila por día: `cosine`, `lens`, las posiciones de
arranque y la fecha.

El piso se calculaba recorriendo el journal de la sombra de **un** día. Eso sirve
para mirar hoy y no sirve para el post-mortem de la temporada: el piso del
2026-09-17 es un **hecho de ese día**, y reconstruirlo en noviembre exige que las
filas de septiembre sigan ahí con la misma forma.

- Se archiva **solo si es comparable** (mismo enfoque **y** mismo libro de
  arranque). Un piso que no cumple las dos condiciones no es un piso bajo: no es
  un piso, y archivarlo contaminaría el post-mortem con un número que mide
  herencia o enfoque.
- **No se pisa**: el primero del día gana. Correr la sombra tres veces no puede
  cambiar retroactivamente el piso de un día ya registrado.
- Se archiva **en el punto de cálculo** (`shadowReport`), no en el endpoint, para
  que quede guardado la primera vez que alguien lo mira, venga por donde venga.

`/api/leaderboard?postmortem=1` lee del archivo y publica además la **serie**:
un piso de 0.77 no significa lo mismo si los tres días previos dieron 0.93 — lo
primero es un día raro, lo segundo es el sistema.

## B15 · EL BASELINE ES EL EQUITY REAL, NO UN $100k DECLARADO

`api/_lib/arena-baseline.js` · tests en `tests/arena-baseline-real.test.mjs`

### El bug, con los números del 2026-09-16

El dry run del reset reportó que, con `baseline = $100,000` declarado, la
temporada arrancaría así:

| agente | equity tras aplanar | return el día 0 |
|---|---|---|
| `control` | $98,550 | **−1.45%** |
| `claude` | $99,590 | **−0.41%** |

Ninguno de los dos había perdido un centavo. Aplanar a mercado deja un residuo
distinto en cada libro (spread, fills parciales, lo que valía la cartera vieja),
y un denominador compartido le cobra ese residuo a cada agente como si fuera
pérdida.

No es cosmético, y menos en **ese par**: `claude` y `control` corren el mismo
modelo con el mismo prompt precisamente para medir el **piso de ruido** entre sí.
El sesgo del denominador entre los dos era de **1.04 pp** — más grande que el
ruido que están ahí para medir, y **indistinguible de él**.

### El arreglo: tres piezas que se mueven juntas

Arreglar una sola es peor que el bug, porque deja a la misma cuenta arrancando
en **0% para el breaker y en −1.45% en la tabla pública**, y ninguno de los dos
números se ve mal por sí solo.

**1. El reset escribe el equity real por agente.** `?baseline=` ya no es
necesario: sin él, cada cuenta se re-basa a su propio equity después de aplanar
y los siete arrancan en 0.00%. `?baseline=<n>` sigue disponible para forzar un
número declarado. El anuncio del corte **lista los siete denominadores** uno por
uno: el denominador es lo que hace comparable (o no) un retorno, así que tiene
que quedar escrito en el corte y no reconstruirse después.

**2. Los cuatro consumidores dividen por ese número.** Había tres que tenían su
propio `ARENA_BASELINE_EQUITY` global cada uno, y escribir el baseline sin
tocarlos no habría cambiado nada de lo que se ve:

| dónde | qué usaba | qué usa |
|---|---|---|
| `arena-run` (pico del breaker) | `arena_state.baseline_equity` | igual — era el único bien cableado |
| `leaderboard` (`return_pct`, `exceso_pp`) | $100k global | baseline del agente |
| `liga-eventos` (líder de la crónica) | $100k global | baseline del agente |
| `arena-run` (cierre de temporada) | $100k global | baseline del agente |

**3. El ranking ordena por RETORNO, no por equity bruto.** Esto **no** revierte
la decisión #6: mientras las cuentas arranquen del mismo capital, ordenar por
retorno da **exactamente el mismo orden** que ordenar por equity — es una
transformación monótona, y hay un test que lo afirma. Los dos órdenes solo se
separan cuando el capital de arranque difiere, que es justo donde el equity
bruto deja de ser justo: con `control` arrancando $1,040 por debajo de `claude`,
el orden por equity lo deja atrás **para siempre aunque los dos rindan
idéntico** — y ese par existe para rendir idéntico. El equity se sigue
mostrando; lo que cambia es qué decide el puesto. Empate de retorno → desempata
el equity.

### El cero con autoridad

`Number(null)`, `Number('')` y `Number([])` son todos `0`. Con `Number` a secas,
un agente al que no se le pudo leer la cuenta habría salido publicado en
**−100%** en vez de en "no se sabe". `returnPct` y `startingDrawdown` usan un
`num()` que distingue **ausente** de **cero** — lo encontró un test escrito para
otra cosa.

### La alternativa que NO se tomó

Igualar el capital de verdad: resetear las siete cuentas paper en el panel de
Alpaca para que las siete tengan $100,000.00 exactos. Es la única opción donde
`baseline = $100k` es **literalmente cierto** y el orden por equity vuelve a ser
justo sin más. Se descartó como default porque son siete resets manuales fuera
del repo y porque no se puede disparar desde la API de trading — pero sigue
siendo compatible: hecho eso, los siete baselines quedan iguales, el modo `real`
escribe $100,000.00 en los siete, y todo lo de arriba converge al caso simple.

## B14 · EL BENCHMARK PASIVO: $100k en SPY, y nada más

`api/_lib/arena-benchmark.js` · tests en `tests/arena-benchmark.test.mjs`

La pregunta que contesta es la única que le importa a alguien de afuera: **¿los
siete le ganan a comprar el índice y no hacer nada?** Sin este número, "claude
subió 3%" no significa nada — puede ser un mercado que subió 4%.

$100,000 en SPY comprados en la **apertura del día del reset**, a la misma hora
que se aplanan las siete cuentas, y sin tocar en toda la temporada. Cero modelo,
cero LLM, cero herramientas: solo el precio de SPY.

### Por qué es una línea calculada y NO una octava cuenta Alpaca

Lety la prefería real "si no complica". Complica, y de una forma que lo vuelve
**peor** benchmark:

1. **Una orden puede no llenar.** La regla de la casa prohíbe órdenes a mercado
   (cicatriz Polymarket), así que sería una límite marketable — y una límite
   puede no ejecutarse, o llenar parcial. Un benchmark cuyo valor depende de si
   una orden llenó no es un benchmark: es un octavo agente con riesgo de
   ejecución.
2. **Es de un solo tiro.** Si no llena el miércoles a la apertura, no hay
   segunda oportunidad de arrancar la temporada al precio correcto.
3. **No se puede auditar desde afuera.** `acciones × precio` lo verifica
   cualquiera contra datos públicos; el equity de una cuenta paper, no. En un
   experimento cuyo entregable es la credibilidad, eso pesa.

El precio sale de **Alpaca**, la misma fuente que alimenta a los siete. Lo único
que no existe es el envoltorio de la cuenta. Si algún día se quiere la cuenta
real igual, el camino queda abierto (`ALPACA_BENCH_KEY`/`SECRET`).

**Acciones fraccionarias**, a propósito: con acciones enteras sobrarían ~$340 de
efectivo, y ese efectivo haría rendir menos al benchmark por una razón que no
tiene nada que ver con la comparación. El benchmark tiene que ser el **retorno
del índice**, no el de una cartera que casi lo replica.

**Dividendos: no se cuentan, y se declara.** SPY paga ~1.2% anual que este
cálculo no incluye, así que el benchmark queda levemente **subestimado**. Un
ajuste a ojo sería un número inventado justo en la línea que existe para no
inventar números.

### Se abre en el reset, una sola vez

`/api/arena-reset?confirm=1` lo abre como **paso 7**, con el mismo `now` que el
corte de las siete cuentas. Va ahí y no en un endpoint aparte porque si arranca
un día después, mide otra temporada.

- **Idempotente**: si ya hay entrada, **no se pisa**. Volver a correr el reset no
  mueve el precio de entrada — un benchmark que se re-abre deja de medir la
  temporada y pasa a medir desde el último reset, en silencio.
- **Relee después de insertar**: dos resets en paralelo reportan la **misma**
  entrada, no dos precios distintos.
- **`?dry=1` no escribe nada**, ni la migración de la tabla (`leerBenchmark({
  migrar: false })`): `create table if not exists` es una escritura aunque no
  cambie nada.
- **`?agent=claude` NO lo abre**: eso es arreglar una cuenta, no arrancar una
  temporada.
- **Si Alpaca no da precio, el reset NO falla.** Las siete cuentas igual quedan
  planas y re-basadas; el benchmark sale sin abrir y con su motivo en
  `warnings`. Aplanar siete libros importa más que una línea de comparación.

El `season_started` del reset lo **nombra** en el mismo anuncio: si la
comparación aparece recién en el post-mortem, se lee como inventada después.

### En el ranking: ordenado por equity, sin puesto

`/api/leaderboard` devuelve el benchmark **fuera** de `agents` (los consumidores
que cuentan modelos siguen contando siete, no ocho) y publica el orden visual en
`ranking`, que la página usa tal cual.

La distinción que vale toda la funcionalidad:

- **El ORDEN es por equity e incluye al índice.** Si el S&P va arriba de los
  siete, eso tiene que verse en la primera fila.
- **El RANGO (1, 2, 3…) es solo para los que compiten.** El benchmark no decidió
  nada: no puede ganar, así que no toma número. Si lo tomara, "claude va 2º"
  sería falso de una forma difícil de ver — 2º de ocho filas, una de las cuales
  no jugó.

```bash
curl -s "$BASE/api/leaderboard" | jq '{benchmark: .benchmark.return_pct, orden: [.ranking[] | {id, rank, equity}]}'
```

Cada agente lleva además `exceso_pp` = su return menos el del índice. Es la
única cifra que contesta "¿le ganó al mercado?" y cuesta una resta: no merece una
bandera.

### El post-mortem: el exceso contra el PISO DE RUIDO

```bash
curl -s "$BASE/api/leaderboard?postmortem=1" | jq .post_mortem
```

Detrás de bandera porque exige leer el journal de la sombra, y `/api/leaderboard`
es público y cacheado.

Lo que publica no es solo el exceso: es el exceso **leído contra el piso de
ruido claude↔control**. `claude` y `control` corren el mismo modelo con el mismo
prompt, así que lo que los separa a *ellos* es el ruido del sistema. **Un exceso
que no supera esa distancia no es habilidad.**

Y la línea que no se cruza: el piso es un **coseno entre libros**, no una
diferencia de retorno. No se convierte a puntos porcentuales — son unidades
distintas, y fingir lo contrario sería inventar el número justo donde no se
puede. Cuando el piso no es comparable (enfoques distintos, libros de arranque
distintos), el bloque lo dice y avisa que sin piso no se distingue habilidad de
azar.

### La regla estructural

Si `arena-benchmark.js` algún día importa el camino de decisión (`arena-run`,
`arena-model`, `arena-tools`, los rieles) o toca `createLimitOrder`, el benchmark
dejó de ser pasivo. Hay un test que lo prohíbe.

## B11 · `/api/liga/libros` — el libro de cada agente, y cómo llegó a él

`api/liga-libros.js` · tests en `tests/arena-liga-libros.test.mjs`

Hermano de `/api/liga/eventos`. Aquel cuenta lo que **pasó** (órdenes, rechazos,
cambios de líder); éste cuenta lo que el agente **decidió** y, sobre todo, **cómo
investigó** — que es lo más publicable de todo el proyecto y lo que nadie más
está mostrando.

```bash
curl -s "$BASE/api/liga/libros?dias=1" | jq '.libros[0] | {fuente, agente, enfoque, portafolio, investigacion}'
```

Por agente: **portafolio objetivo** · **tesis por posición** · **secuencia de
investigación** · **enfoque del día**.

### La secuencia es una historia, no ocho volcados

> *"buscó semis con RVOL alto → leyó las noticias de NVDA → pidió la ficha de
> AMD → no compró ninguna"*

Eso es una historia. Ocho volcados de datos no lo son. Acá viaja el **resumen**
de cada llamada (herramienta, argumentos ya acotados, cuántas filas, si se
truncó), **nunca** el resultado completo. El completo sí se journalea —el replay
lo necesita— pero moverlo por un feed público que no lo usa sería pagarlo en
cada carga.

### La fuente nunca se infiere

Lee `arena_journal` **y** `arena_shadow_journal`, y **cada libro dice de cuál
vino**. Confundir una decisión de sombra con una real es exactamente el error
que las tablas separadas existen para impedir; publicarlas juntas sin etiqueta
sería re-crear el problema una capa más arriba.

Mientras el contrato nuevo corra solo en sombra, éste es el **único** lugar
donde se puede ver un portafolio objetivo.

### Lo que encontró la TERCERA sombra (5/7)

#### El 0.68 del piso de ruido no era ruido

`control` arrancó con **6 posiciones heredadas** y `claude` con **1**. Dos PMs
idénticos que parten de carteras distintas producen libros distintos **por
herencia**, no por ruido del modelo.

El piso solo significa algo cuando se cumplen **las dos** condiciones: misma
enfoque **y** mismo libro de arranque. Ahora el reporte exige las dos, marca
`comparable: false` cuando falla alguna, y **no publica el número como piso** —
lo publica como `cosine_observado` para que se vea que existe sin que se lea
como lo que no es. Y dice cómo arreglarlo: un reset iguala las cuentas.

`posiciones_iniciales` de los siete sale al lado, porque es la otra mitad de la
pregunta: una coincidencia alta entre dos agentes que heredaron la misma cartera
no dice nada sobre cómo piensan.

#### Tres filtros del screener se declaraban al modelo y no existían

| Filtro | Qué pasaba |
|---|---|
| `ret_5d_min` | declarado en el schema, **sin implementar** en `runScreener` |
| `ret_1m_min` | ídem |
| `min_mcap_b` | implementado `if (ctx.marketCapOf)` — que la sombra **nunca pasaba** |

**Eso es peor que devolver cero.** Un filtro que se ignora en silencio hace que
el modelo construya su tesis creyendo que filtró: pide *"los que subieron +5% en
el mes"* y recibe **todos**, con la etiqueta de que cumplen.

Los tres se implementaron con datos que la corrida **ya pagaba**: los retornos a
5 días y a 1 mes salen de las mismas velas que el promedio de volumen (~35
sesiones), y el market cap de la admisión. El universo los guarda.

Y **un nombre sin el dato no pasa el filtro**: dejarlo pasar sería el mismo error
con otra cara. Cuando el dato falta para *todos*, la respuesta es **"no se puede
contestar"**, no "ninguno cumple" — son dos respuestas distintas que llevan a
decisiones distintas.

#### La captura del fallo estaba en la capa equivocada

Los abortos llegaron con `status: 200` y `raw_body`, `detail` y `provider_error`
**todos en null**. Eso significa que el fetch fue bien y la falla está al **leer**
la respuesta — una capa más abajo de donde estaba puesta la captura.

Ahora el turno de cierre guarda su propio diagnóstico pase lo que pase: el
`choices[0]` **entero** (content, `reasoning`, `tool_calls`, `finish_reason`), y
también el `stack` si algo lanza.

Más los dos casos probables:

- **`content` vacío con la respuesta en `reasoning`:** se leía `reasoning` pero
  no `reasoning_content`, que es el campo que usan varios proveedores.
- **`tool_calls` pese a `tool_choice: none`:** un reintento, uno solo, con la
  instrucción más corta posible. Reintentar en bucle sería gastar el reloj
  contra la misma pared.

---

### Lo que encontró la SEGUNDA sombra (4/7, $1.04)

#### El control corrió con otro enfoque que claude — el piso de ruido no medía nada

`claude` con `momentum`, `control` con `catalizador`. Los dos corren el **mismo
modelo con el mismo prompt byte a byte**; ésa es toda la razón por la que el
control existe: mide el **ruido** del sistema, el delta entre dos corridas
idénticas.

Con enfoques distintos dejan de ser idénticos. El delta entre ellos pasa a mezclar
ruido con *"mirar el mercado por otro lado"*, y el piso deja de ser un piso:
cualquier diferencia entre dos modelos distintos se vuelve incomparable porque no
hay contra qué medirla.

La rotación hashea el id del agente, así que caían en enfoques distintos casi
siempre. Ahora **el control hereda el enfoque de su insignia** (`ENFOQUE_HEREDADO`,
declarado en un solo lugar). La rotación sigue viva: el control recorre las
cuatro enfoques, los de claude.

Y el reporte publica **`piso_de_ruido` como línea propia**, con la condición
explícita: si los enfoques difieren, **no publica el número** — dice que ese par
mide el enfoque, no el ruido.

#### `sector({etf})` devolvía 0 filas porque estaba conectada a nada

La sombra le pasaba al ejecutor `deps: { sectorOf: () => null }` — **literal**.
Ningún nombre del tablero podía coincidir con ningún sector porque la función
decía que nadie tiene sector. La herramienta no estaba rota: estaba conectada a
una constante.

En el camino vivo era casi lo mismo por otro motivo: mapeaba la industria de
Finnhub al ETF comparando los **primeros seis caracteres** del nombre del sector.
`"Information Technology"` vs `"Technology"` no coinciden.

Los dos ahora leen los sectores **GICS del universo**, que vienen del CSV de IVV
— el mismo dato que arregló R6. Una vez cargado, sirve para los dos.

#### `noticias({tema})` miraba 50 titulares y decía "no hay"

Buscaba el tema sobre **una sola página** del feed (50 items) y **solo en el
titular**. Después contestaba *"sin titulares para el tema Hormuz"*, que se lee
como *"no hay noticias de Hormuz"* cuando lo que pasaba era *"no estaba entre los
50 más recientes"*. Una afirmación fuerte sobre una muestra chica — justo la
clase de error que el resto del sistema evita.

Ahora una búsqueda por tema **pagina 4 páginas** (200 titulares), busca en
**titular y resumen**, y el cero es honesto: dice **sobre cuántos** se buscó.

#### grok y deepseek mueren justo al llegar a 8/8

`qwen`, con 6/8, pasó. La correlación es **tocar el techo**, y lo único que pasa
solo entonces es el **turno de cierre forzado**.

Ese turno se llamaba con `tools: null`, lo que **quita el parámetro `tools`** del
payload — sobre una conversación que ya contiene `tool_calls` (OpenAI) o bloques
`tool_use` (Anthropic). Los dos proveedores esperan que el esquema siga declarado
cuando el historial lo menciona, y vía OpenRouter un payload incoherente vuelve
como **HTTP 200 con un `error` adentro**.

La forma correcta de pedir *"contestá sin llamar nada"* es declarar las
herramientas y prohibirlas con `tool_choice: none`. Eso es lo que hace ahora.

> **Es una hipótesis, no una confirmación.** No tengo acceso al journal ni a los
> proveedores desde el entorno de desarrollo, así que no pude reproducirlo. Lo
> que sí es cierto en cualquier caso: quitar el esquema de un payload cuyo
> historial lo menciona es incoherente, y `tool_choice` es la forma correcta.

---

### Lo que encontró la primera sombra real (2026-09-15, $1.11, 2/7 en verde)

#### 1 · `tools_max: 8` y 11, 15, 10 llamadas — dos causas, no una

**El techo se aplicaba, pero se contaba mal Y se chequeaba mal.**

**(a) `used` contaba los rechazos.** Un intento que rebotaba por presupuesto
agotado incrementaba el mismo contador que las ejecuciones. Con techo 8 y 15
pedidos, `tools_used` decía 15 — y parecía que el techo no existía cuando en
realidad 8 se ejecutaron y 7 se rechazaron. Ahora hay dos contadores: `used`
(ejecutadas, nunca pasa del techo) e `intentos` (todo lo pedido). Los intentos
importan —un modelo que sigue pidiendo después de quedarse sin cupo está
diciendo algo— pero mezclarlos hacía ilegible el techo.

**(b) La reserva del cupo no era atómica.** Entre el `if (used >= budget)` y el
`used++` había **dos `await`** (la caché y el runner), y el loop ejecuta las
herramientas de una vuelta **en paralelo** con `Promise.all`. Con `used` en 7,
techo 8 y cinco pedidos simultáneos, los cinco evaluaban `7 >= 8` → false antes
de que ninguno incrementara: pasaban los cinco.

La cura es reservar el cupo **en el mismo tick** del chequeo. JavaScript es de un
solo hilo: mientras no haya un `await` entre el `if` y el `++`, la reserva es
atómica.

#### 2 · R6 rechazó por una falla nuestra

La sombra rechazó a `openai` y a `gemini` por R6 con `sector: UNKNOWN`. **No
estaban concentrados**: ningún nombre tenía sector, los catorce cayeron al mismo
bucket y la suma dio 100% "en un sector".

Rechazar el objetivo entero por eso le carga al PM un error que no cometió — el
mismo problema que tenía `data_unavailable` en el canal del día. Ahora el bucket
`UNKNOWN` sale como **`warning`** (`es_falla_nuestra: true`), no como violación,
y el objetivo pasa. **Los sectores reales siguen aplicando el tope igual.**

> El test que cubría esto **estaba en contra de su propio comentario**: decía
> *"prohibir operar sin sector castigaría al PM por eso"* y a la vez verificaba
> que R6 violara.

**Y el dato estaba a mano todo el tiempo:** el CSV de IVV trae una columna
`Sector` con la clasificación **GICS oficial** para los 502 nombres, y se estaba
tirando. Ahora se carga con la lista, se guarda en el universo y **gana sobre la
heurística de Finnhub** — no es una regla por palabra clave, es la clasificación
del índice. Los nombres del día, que no están en ningún índice, siguen cayendo a
`profile2` cacheado por día.

#### 3 · Tres agentes abortaron con "HTTP 200"

`grok`, `deepseek` y `qwen`. El error decía el status y nada más, así que no
había forma de saber qué había contestado el proveedor.

**OpenRouter devuelve HTTP 200 con un `error` adentro** — es su forma de reportar
fallas del proveedor de abajo (rate limit del modelo, contexto excedido,
moderación). El código leía `choices[0]`, no lo encontraba, y armaba un turno
**vacío** que moría más adelante como si el modelo no hubiera respetado el
formato. Ahora un 200 con `error` se reporta como error, con el mensaje del
proveedor.

**Y el cuerpo crudo se journalea** (`llm_error.raw_body`, acotado a 800
caracteres) en los dos proveedores. `r.json()` que fallaba devolvía `null` y ahí
se perdía la única evidencia.

> **Un bug aparte que apareció leyendo esto:** `guardedOpenRouterCall` aceptaba
> `effort` y **no se lo pasaba** a `openRouterFetch` en ninguna de sus dos
> llamadas. El escalón 1 del breaker bajaba el effort en Anthropic y no en
> OpenRouter — cinco de los siete agentes seguían caros.

---

### El reporte gratis (`?report=1`) contesta lo que la corrida no

La corrida en vivo devuelve `agents[].tools_used` —un **número**— y no calcula
coincidencia. Las dos cosas ya estaban en el journal o eran computables desde él,
así que salen por el reporte, que **no gasta un token** y lee las mismas filas
que la corrida acabó de escribir. No hay que pagar otra corrida en siete
proveedores para verlas.

| Campo | Qué contesta |
|---|---|
| `por_agente[].ultimo.herramientas` | la **secuencia**: qué herramienta, con qué filtros, cuántas filas, si se truncó |
| `por_agente[].ultimo.herramientas_corte` | por qué paró el loop (presupuesto, vueltas, reloj) |
| `coincidencia.pairs` | coseno **par a par** entre los 7 portafolios objetivo |
| `coincidencia.lectura` | qué significa ese número, en una línea |
| `coincidencia.nombre_mas_compartido` | el ticker que más libros tienen |
| `costo.total_usd` | el costo del día, con `sin_costo` si algún agente no reportó |

**`pairwiseOverlap` estaba escrito y probado desde B8 y ningún endpoint lo
llamaba** — código muerto, igual que las rondas fijas antes de conectarlas. Un
test que ejercita la función exportada no prueba que alguien la use.

Y es la métrica que decide la pregunta entera del experimento: si la liga está
midiendo **siete opiniones o una opinión repetida siete veces**. Por eso el
número viaja con su lectura: un coseno de 0.9 entre siete modelos distintos no es
"la liga funciona".

**El caveat del enfoque viaja al lado.** Dos agentes con enfoques distintos el
mismo día **no son comparables ese día** — el confound es deliberado (B8), así
que `por_agente[].ultimo.enfoque` se lee antes que el par.

### El control va marcado, y el modelo va con su etiqueta

El control es el **piso de ruido**: leer su resultado como el de un competidor
más invalida la única referencia que hace significativo cualquier delta entre
modelos. Va con una nota que explica qué significa, no solo una bandera.

El modelo sale como **etiqueta legible** (`model_label`), nunca como slug de
API: el slug cambia con un override de env var, y publicarlo haría que la tabla
de la liga dijera cosas distintas según qué env vars estuvieran puestas ese día.

### El enfoque viaja con su advertencia

No basta con publicar `lens: "momentum"`. Va con la nota de que es un **confound
deliberado**: dos agentes con enfoques distintos el mismo día **no son comparables
ese día**.

### Una corrida del contrato viejo sale con `portafolio: null`

Y eso **no es un hueco**: dice qué contrato corrió ese día.

Mismas restricciones que `/eventos` y `/audit`: cero writes, sin `ensureSchema`,
sin `beat` (latir acá enmascararía un cron muerto), sin importar nada del camino
de decisión, y sin proyectar los prompts completos — son material para
reconstruir la corrida, no material de show.

---

## B4 · CADENCIA: tres rondas fijas y la nocturna a reporte

`_lib/arena-watch.js` (`FIXED_ROUNDS`, `fixedRoundDue`, `riskNetDue`) ·
despacho en `api/arena-watch.js` · tests en `tests/arena-cadencia.test.mjs` y
`tests/arena-watch.test.mjs`

> **Corrección.** Las tres rondas fijas se entregaron como módulo y tests pero
> **el endpoint nunca las llamaba**: `fixedRoundDue` estaba exportada y probada,
> y ningún camino de producción la importaba. Eran código muerto. Ya están
> despachadas desde el tick del vigilante. Un test que ejercita la función
> exportada no prueba que alguien la use — el que lo agarró fue el de
> `arena-watch.test.mjs`, que corre el tick entero.

| Pieza | Cuándo |
|---|---|
| Vigilante | cada 5 min, con los seis disparadores de siempre |
| **Red de riesgo** | **el PRIMER tick** de la sesión (antes: apertura+30) |
| **Rondas fijas** | apertura+30 · 12:00 ET · cierre−30 |
| Corridas por disparador | acotadas al nombre + tablero, **máx 3 herramientas** |
| Nocturna | **solo reporte**, sin decisiones |

### Por qué las rondas viven en el vigilante y no en tres crons

Tres crons de Vercel serían tres **horas UTC fijas**, y el horario del mercado
no es fijo: cambia con el horario de verano. Un cron a las 14:00 UTC es la
apertura+30 en EDT y la apertura+90 en EST. Peor: un festivo, una **media
sesión** o una apertura retrasada dejarían los tres apuntando a momentos que no
existen esa sesión.

El vigilante ya corre cada 5 minutos **y ya sabe en qué minuto de la sesión
está** (`sessionPhase`, derivado del calendario **real** de Alpaca). Las rondas
se derivan de ahí: *"cuando lleven 30 minutos de sesión"*, no *"a las 14:00
UTC"*. Con media sesión, el cierre−30 cae donde tiene que caer sin tocar nada.

### Qué es una ronda fija, en concreto

Un `runArenaDecide` **completo** —con buffet y con el presupuesto de 8
herramientas—, no una corrida acotada: es el momento en que el PM mira el mercado
entero y no un nombre que se movió. Los siete corren en paralelo, cada uno con su
deadline, compartiendo un buffet que se pide **una vez** por ronda.

**Idempotencia por `round:<día>:<id>`.** El tick es de 5 minutos y la ventana de
una ronda dura media hora: sin la marca, los seis ticks siguientes dispararían
seis rondas — siete agentes × seis = 42 corridas donde tenía que haber siete.

**El presupuesto manda.** En el escalón 2 las rondas fijas no corren, y la
decisión de no correrlas se marca como hecha igual (si no, cada tick de la media
hora siguiente volvería a evaluarla y a journalear el mismo salto) con el escalón
que la causó. La **revisión de piso** sigue la misma regla: es una corrida
programada, no un disparador.

**La ventana no es un instante.** El tick es de 5 minutos, así que "a los 30
exactos" casi nunca cae en un tick: la ronda dispara en el **primer tick que
pasa el umbral**, y la idempotencia por día es lo que evita que los seis ticks
restantes de esa media hora disparen seis rondas.

**La deuda se paga en orden.** Si el vigilante estuvo caído y vuelve a las
12:30 sin haber corrido la de apertura, corre **esa primero**: son rondas
distintas con propósitos distintos, no un cupo que se descarta.

### La red de riesgo, al primer tick

Antes corría en el tick de la apertura+30, junto con la revisión de piso. Eso
son **30 minutos de sesión** en los que un stop que ya disparó con el cierre de
ayer no se ejecutaba — y un **gap de apertura** es exactamente cuando más falta
hace.

No cambia **qué** decide (sigue decidiendo con cierres completos, una vez al
día): cambia **cuándo se ejecuta** lo ya decidido. Moverla a decidir con precios
intradía la volvería un stop de tick, que es otro producto.

### El cambio de contrato de la nocturna (el que no salta a la vista)

Al volverse reporte, el **"plan anterior"** que se le reinyecta al PM dejó de
ser el de la nocturna y pasó a ser el de la **última ronda fija**.

Sin ese filtro, el PM de la apertura+30 recibiría como *su plan anterior* el
**reporte de anoche** — un texto que describe el día que pasó y no decide nada.
Construir sobre eso es construir sobre una crónica. `report` y `nightly_report`
se excluyen junto a las filas operativas, por el mismo motivo por el que están
ellas: llevan `plan` sin ser una decisión del PM.

---

## B5 · SALIDA = PORTAFOLIO OBJETIVO · B6 · RIELES · B7 · RED PARA CORTOS

`_lib/arena-rails.js` (rieles) · `_lib/arena-rebalance.js` (el motor) ·
`_lib/arena-exits-short.js` (la red del corto) · tests en
`tests/arena-portafolio.test.mjs`

El cambio de contrato más grande de la temporada. Antes el PM entregaba
**órdenes** ("compro 50 de NVDA"); ahora entrega un **libro** ("quiero estar 12%
en NVDA"). Y de paso hace imposible el bug de la omisión silenciosa.

### Las cuatro decisiones de B5

**1 · Omisión = 0% = SALIDA.** Un ticker que el PM no menciona **se cierra**. La
alternativa ("lo que no menciono se queda") deja que la omisión pase por
decisión, que es exactamente la amnesia que la T2 vino a arreglar. Con omisión =
salida, **todo el libro se re-afirma en cada corrida o desaparece**: el
pronunciamiento obligatorio hecho **estructura**, no hecho instrucción.

> **El riesgo es real:** un modelo que no lo entienda se liquida solo en su
> primera corrida. Va dicho tres veces en el prompt, y hay un test que verifica
> que un objetivo vacío produce la liquidación completa — no un no-op silencioso.

**2 · Banda de no-negociación: 2pp.** Sin banda, el motor negocia contra el
drift de precios todos los días: una posición que el PM quiere al 12% y cerró en
11.6% generaría una orden que no expresa ninguna decisión. **Excepción:** un
cierre completo nunca se frena — "salir del 1.5%" es una decisión aunque el
movimiento sea chico.

**3 · Orden de ejecución:** ventas → coberturas → compras → cortos nuevos. Lo
que **libera** capacidad va primero; lo que la **consume**, después. Si no, una
rotación completa viola el riel de bruto a mitad de secuencia o se queda sin
cash. Un **cruce de signo son dos patas** (cerrar el largo, abrir el corto):
tratarlo como una orden sola pasaría por plano sin pasar por plano.

**4 · Descarta entero, no escala.** Escalar un objetivo para que quepa lo
convierte en uno que el PM nunca propuso, y el journal publicaría como suya una
tesis que no corresponde a las posiciones. Y se reportan **todas** las
violaciones, no la primera: un PM que recibe "violaste R3" arregla R3 y choca
con R6 mañana.

### La asimetría del corto — el eje de B6 y B7

> **Un largo que sale mal SE ENCOGE. Un corto que sale mal CRECE.**

Un largo del 25% que cae 50% pasa a pesar ~14%: el error se auto-limita y el
riel se respeta solo. Un corto del 25% cuyo subyacente **sube** 50% pasa a ~37%
y sigue creciendo — **viola su propio riel sin que nadie haga nada**, y la
pérdida no tiene techo teórico. De ahí salen el tope a la mitad, los rieles que
solo existen para cortos, y el recorte.

| # | Riel | Valor |
|---|---|---|
| R1 | largo por nombre | 30% |
| R2 | corto por nombre | **15%** (la mitad) |
| R3 | exposición bruta | ≤ 100% |
| R4 | exposición neta | −50% a +100% *(asumido)* |
| R5 | corto total | ≤ 50% |
| R6 | por sector | 50%, con `UNKNOWN` como un bucket más |
| R7 | cash | 0-100% |
| R8 | mínimo por posición | 2% |
| R9 | `shortable` **y** `easy_to_borrow` | **fail closed** |
| R10 | precio mínimo para cortos | $10 (contra $5 del universo) |
| R11 | `forced_buy_in` journaleado aparte | — |
| R12 | **el motor RECORTA** | — |

**R9 falla cerrado y eso es deliberado:** un campo ausente **no es un permiso**.
Un buy-in forzado cierra la posición sin que el PM decida — eso es ruido del
broker metido en el resultado del experimento.

**R6 con `UNKNOWN`:** prohibir operar un nombre sin sector castigaría al PM por
una falla de cobertura **nuestra**. El bucket comparte el tope y el journal lo
dice.

**R12 · El motor recorta.** Una posición que creció por encima de su riel se
recorta al riel **aunque el PM no lo haya pedido y aunque su objetivo la deje
donde está**. Rechazar entradas nuevas no sirve de nada contra una posición que
se infla sola. Es **determinista** —va con la red, no con la decisión del PM—,
se journalea como `rail_trim` con el peso antes y después, y el PM lo ve en su
siguiente prompt como un hecho consumado, igual que un stop que disparó.

Un nombre recortado que el PM **ni menciona** queda **en el riel, no en cero**:
el recorte es de la red, no una salida que alguien decidió.

### B7 · La red del corto, con el pico invertido

`_lib/arena-exits-short.js` es un **hermano** de `arena-exits.js`, no un
reemplazo: aquel lleva meses corriendo sobre libros largos y no se toca. Podría
haber sido un `if (esCorto)` adentro; no lo es a propósito — la red es la única
pieza que no se puede apagar, y meterle ramas a un módulo que ya funciona es la
forma más barata de romper el lado que andaba.

| Red | Largo (vigente) | Corto |
|---|---|---|
| Stop catastrófico | −22% desde la entrada | **+20% en contra** |
| Trailing: ARMA | pico +15% a favor | **el piso llegó a −15%** |
| Trailing: DISPARA | −8% desde el pico | **+8% desde el piso** |
| Time stop | 45 días | 45 días (es atención, no riesgo) |

**+20% y no +22%** por la asimetría: a 20% en contra la posición ya creció de
15% a ~18% del libro, y los dos puntos extra cuestan más en un corto.

**El espejo del pico.** En un largo se recuerda el **máximo** desde la entrada y
el trailing protege contra la caída. En un corto la dirección favorable es
**hacia abajo**, así que lo que se recuerda es el **mínimo** y el trailing
protege contra el rebote. Guardar el máximo acá daría un trailing que dispara
**cuando la posición va bien** — un bug perfectamente silencioso, y por eso
tiene su propio test.

El mínimo se **techa a la entrada**: un corto que nunca bajó de donde se abrió
tiene piso = entrada. Sin ese techo, el trailing armaría por aritmética en vez
de por haber ganado algo.

Y como el largo: **por construcción cubre con ganancia**.
`entrada × 0.85 × 1.08 = entrada × 0.918` — el techo del trailing está siempre
por debajo de la entrada, que en un corto es ganancia.

### Sin slippage simulado (D6)

Estas son órdenes **reales** en Alpaca paper: el fill ya trae su propia
fricción, y cobrar bps sintéticos encima sería contar el costo dos veces. Se
mide **turnover** como métrica de churn — un número que ya existe y no inventa
nada.

---

## B3 · LAS HERRAMIENTAS

`_lib/arena-tools.js` (las cuatro + presupuesto) · `_lib/arena-tool-loop.js` (el
loop multi-proveedor) · tests en `tests/arena-herramientas.test.mjs`

El tablero le muestra el mercado; esto le deja **investigarlo**.

| Herramienta | Qué contesta |
|---|---|
| `screener({sector?, min_rvol?, min_mcap_b?, ret_*, near_52w_high\|low, has_news, limit≤25})` | "¿qué nombres se parecen a X?" |
| `noticias({ticker?\|tema?, days≤5, limit≤8})` | titulares de un nombre o de un tema |
| `ficha({ticker})` | la hoja completa de UN nombre — la cara, para nombres que ya está considerando |
| `sector({etf})` | un sector por dentro |

### El tope es del harness, no del prompt

Un tope que solo vive en el prompt es una **sugerencia** que el modelo cumple
casi siempre, y "casi siempre" en un presupuesto es un presupuesto roto. La
llamada 9 **no se ejecuta** y devuelve un `tool_result` que dice *"presupuesto
agotado, decidí con lo que tenés"*. El modelo se entera en lugar de descubrirlo
por silencio, y el intento rechazado **se journalea igual**: es parte de cómo
investigó.

8 llamadas en ronda fija, 3 en corrida por disparador (está acotada a un nombre
— no necesita explorar).

### El truncamiento viaja dentro del resultado

Cada resultado se corta a ~1.5K tokens y el corte se **declara adentro**:
`…(N filas más, TRUNCADO por presupuesto de tokens — no es que no existan, es
que no cupieron)`. Un modelo al que le cortaron los datos sin avisarle razona
sobre una lista que cree completa, y después escribe *"no hay ningún nombre de
energía con RVOL alto"* cuando lo que pasó es que no cupo.

La misma disciplina en los vacíos: el screener distingue *"ninguno cumple"* de
*"no hay tablero sobre el que filtrar"*, y `noticias` distingue *"no hubo
titulares"* de *"la fuente falló"*.

### Los argumentos se acotan, no se rechazan

`limit: 500` es el modelo pidiendo "dame todo", no un error: se le dan 25 y se
le **dice** que se acotó. Rechazar la llamada le gastaría una del presupuesto
sin darle nada.

### La caché es por contenido, no por agente

Si dos agentes piden lo mismo, se paga una vez. Eso **no es herding**: es el
mismo dato, y el tablero ya es común para los siete. Lo que mide el experimento
es **qué decidieron mirar**, y eso queda intacto — la secuencia de cada uno se
journalea entera.

### El loop multi-proveedor (el trabajo que el scope marcó como subestimado)

Anthropic y OpenAI no difieren solo en nombres de campo; difieren en la **forma
del turno que hay que devolver**:

| | Anthropic | OpenAI / OpenRouter |
|---|---|---|
| pide | `content:[{type:'tool_use', id, name, input}]` | `message.tool_calls:[{id, function:{name, arguments}}]` — `arguments` es un **string JSON** |
| se responde | **un** mensaje `user` con todos los `tool_result` | **un mensaje `tool` POR CADA** llamada |
| eco | el turno del asistente **verbatim**, con los bloques de thinking | el objeto `message` **crudo**, con su `tool_calls` |

Los dos detalles que rompen si se hacen "parecido" en vez de exacto:

1. **Anthropic exige el eco verbatim.** Reconstruirlo como texto plano es lo que
   el chequeo de *preserved thinking* de Fable 5.1 no perdona — la misma
   cicatriz que ya estaba documentada en el guard de fechas.
2. **OpenAI exige un mensaje `tool` por cada `tool_call`.** Si el modelo pidió
   tres y se responde con uno, la API rechaza el turno entero. Agrupar (como
   hace Anthropic) *parece* equivalente y no lo es.

### El guard de fechas y el tool use no se llevan

El retry del guard appendea un turno de **usuario** después del turno del
asistente. Cuando ese turno pidió herramientas, eso es un payload **inválido en
los dos proveedores**, y el retry devolvería un 400 que no tiene nada que ver
con fechas. Así que en un turno con herramientas el guard **no reintenta** — y
no se pierde nada: el turno que pide una herramienta casi no tiene prosa, y el
turno **final**, que trae el JSON y la narrativa (donde una fecha alucinada sí
importa), llega sin herramientas y pasa por el guard completo.

### Dos topes distintos

El presupuesto cuenta **llamadas**; el loop cuenta **vueltas**. Un modelo puede
pedir tres herramientas en una vuelta, y sin el tope de vueltas uno que se queda
en bucle gasta el reloj de la lambda aun con el presupuesto agotado. Al
agotarse las vueltas hay **una vuelta final sin herramientas** para que pueda
cerrar con su JSON: sin ella, un modelo en bucle produce una corrida abortada
teniendo todo lo que necesitaba.

### B12 · Los relojes: la cuenta cambió con las herramientas

Antes de B3 una corrida eran **dos** llamadas y la cuenta cerraba sola:

```
scan (≤90s) + dive (≤90s) + Alpaca/journal ≈ 200s  <  240s  <  300s
```

Con el loop, el DIVE puede ser **hasta 10** llamadas. A 90s de techo cada una,
el peor caso no es 200s — es **más de 900**. Con el deadline en 240s la corrida
moría a mitad del loop **perdiendo todo lo que el modelo ya había investigado**,
y el journal decía "timeout" sin decir en qué vuelta se quedó.

La respuesta **no es solo subir el deadline**: un loop que no sabe qué hora es
choca contra cualquier número que se le ponga. El loop lleva **su propio
presupuesto de tiempo** y, cuando se le acaba, hace lo mismo que cuando se le
acaban las vueltas — una última llamada **sin herramientas** para que cierre con
lo que tiene.

> Un cierre con menos investigación de la que quería es una **decisión**.
> Un timeout es una **corrida perdida**.

La cuenta nueva:

```
scan          ≤  90s
loop del dive ≤ 120s   (ARENA_TOOL_LOOP_MS — el loop se AUTO-CORTA)
cierre        ≤  45s   (última llamada, sin herramientas, con su tiempo apartado)
──────────────────────
total         ≈ 255s  <  270s (deadline)  <  300s (función)
```

Tres topes, y cuentan cosas distintas: **llamadas** (el presupuesto de
herramientas), **vueltas** (el loop) y **tiempo** (éste). El del tiempo es el
que de verdad manda, porque el reloj que mata no es el nuestro sino el de
Vercel. Y el techo de cada llamada individual se acota contra lo que queda: sin
eso, una llamada colgada de 90s se come el reloj de las vueltas siguientes.

Los 30s entre el deadline y el cap de la función son para **escribir** el
timeout. Un timeout que no se journalea es indistinguible de una corrida que
nunca ocurrió — y ese margen lo exige un lint, no es un número que se pueda
achicar para hacer caber un presupuesto más grande.

`tests/arena-timeouts.test.mjs` verifica **la resta**, así que si alguien sube
un presupuesto sin bajar otro se pone rojo antes de que una corrida real muera.

---

### Determinismo para el replay

La secuencia se journalea con los argumentos y el **resultado completo**, no
solo el resumen: sin él, un replay no puede reproducir la corrida — el modelo
decidió mirando algo que no guardamos. Lo que se **publica** en `/liga` es la
secuencia **sin** los volcados: *"buscó semis con RVOL alto → leyó las noticias
de NVDA → pidió la ficha de AMD → no compró ninguna"* es una historia; ocho
volcados de datos no lo son.

---

## B2 · EL TABLERO

`_lib/arena-board.js` · tests en `tests/arena-tablero.test.mjs`

Lo que los siete miran, **idéntico para todos**, en el prefijo cacheado. Cambia
qué es el prompt: el buffet era *una lista de candidatos que nosotros elegimos*;
el tablero es *el mercado*, y quién es candidato lo decide el PM.

| Sección | Reloj | De dónde sale |
|---|---|---|
| Índices + VIX | **vivo** (% vs cierre anterior) | snapshots de Alpaca |
| Calor por sector (11 ETFs GICS) 1d/5d/1m | **velas cerradas** | barras diarias |
| Top 30 gainers / losers **del universo** | **vivo** | snapshots |
| Top 20 por RVOL | **vivo** (sesgado, ver abajo) | volumen del día / promedio 20d |
| Breakouts de 52 semanas | **barras semanales cerradas** | precomputado por el cron |
| Earnings, próximos 5 días | — | el canal de siempre |
| Titulares M&A / upgrades / downgrades | hoy | Alpaca News |

Once sectores y no trece: `/api/sectors` agrega SOXX e IBIT porque son los dos
movers de titular de una audiencia retail, pero **no son sectores GICS**. Un
"calor por sector" con dos filas que no son sectores mide otra cosa.

El **libro** de cada agente y sus últimas 3 decisiones **no** están acá: son lo
único que varía entre agentes y van del lado volátil del corte. Si entraran, los
siete tendrían prefijos distintos y la caché no serviría para nada.

### El presupuesto de tokens es una regla, no una esperanza

3-4K. El renderizador es **tabular, no JSON**, y ésa es la decisión que lo hace
caber: `NVDA 189.2 +8.1 rv3.2` son ~12 tokens; el mismo dato como
`{"symbol":"NVDA","price":189.2,...}` son ~30. Sobre 100 filas, eso es la
diferencia entre caber y no caber. Se **mide** por sección y se journalea.

Cuando no cabe, se recorta **por la cola** y se **dice** cuál sección se cayó —
nunca en el medio. Una sección a medias es una lista que el PM lee como
completa. Y el recorte tiene **piso**: nunca baja de índices + calor por sector,
porque un tablero sin encuadre es peor que uno recortado. Si el piso deja el
texto por encima del presupuesto, `budget_respected: false` lo declara en vez de
devolver un número pasado en silencio.

### Tres relojes, etiquetados

Mezclar relojes sin decirlo es publicar un número correcto con la semántica
equivocada. El tablero etiqueta cada columna:

- **RVOL intradía lee bajo** y el tablero lo avisa: a las 10:30 el volumen lleva
  una hora contra un promedio de sesiones **completas**, así que un RVOL de 1.0
  a esa hora ya es mucho volumen. No se "corrige" con una curva intradía
  inventada — se declara.
- El **calor por sector** y el **rango de 52 semanas** salen de velas cerradas.
- El **precio del día** es vivo, a propósito: el PM decide ahora.

### Lo que no se paga por corrida

El universo y su rango de 52 semanas los precomputa el cron pre-apertura. El
tablero solo agrega lo intradía. Sin eso, cada corrida pagaría ~600 símbolos ×
52 barras **tres veces al día** por un dato que no cambia dentro del día.

### Cobertura, reportada

Un tablero que cubre 120 de 600 nombres **no es el mismo tablero**.
`coverage_pct` lo dice sin que haya que reconstruirlo. Un nombre sin precio vivo
no entra: no se inventa una fila.

### El clasificador de titulares es tonto y explicable a propósito

El tablero no clasifica noticias: elige cuáles de los titulares de hoy caben en
el espacio que tiene. Un falso positivo cuesta una línea; un clasificador que
nadie puede auditar cuesta la confianza en el tablero entero.

**El orden de las reglas importa** y fue el primer bug: `"Broker upgrades NVDA
to Buy"` contiene `to buy` y caía en M&A — el tablero publicaba una fusión que
no existía. Las acciones de rating van **antes**: `upgrade`/`downgrade` son
inequívocas, `to buy` no.

Y solo entran titulares de nombres **del universo**: uno sobre una empresa que
el PM no puede comprar es ruido que paga tokens.

**Freno de mano:** `ARENA_BOARD=0`, sin deploy.

---

## B1 · EL UNIVERSO (~600 nombres)

`_lib/arena-universe.js` · cron `/api/arena-universe` · tests en
`tests/arena-universo.test.mjs`

S&P 500 + Nasdaq 100 + hasta 100 movers/most-actives del día. La diferencia con
el buffet v1.5 **no es de tamaño, es de pregunta**: con solo los movers, lo que
el PM puede elegir está determinado por lo que se movió — un nombre que lleva
tres semanas construyendo una base no existe para él. Con el universo, los
movers pasan a ser una **bandera** sobre nombres que ya estaban ahí.

### Los tres escalones (D1: el tablero NUNCA se bloquea)

```
1. FMP        /api/v3/sp500_constituent · /nasdaq_constituent   (refresco SEMANAL)
2. Neon       el último bueno que se bajó — sobrevive a un deploy
3. data/universe/*.json                  arranque en frío
   ↓
   movers_only — sin ninguna lista, el universo es el día y el journal lo dice
```

Refresco **semanal** y no diario porque la composición de un índice cambia unas
pocas veces al año; pedirla todos los días es gastar cuota para recibir el mismo
archivo. Y la ventana se mide por **edad de lo guardado**, no por calendario: si
el cron no corrió el lunes, el martes refresca igual.

### No corromper al degradar

Una lista de FMP con 12 nombres para el S&P 500 es cuota agotada o un error de
la API, no el índice. **Se rechaza** en vez de pisar la buena que ya estaba
(`MIN_SANE`). Degradar es servir la lista de la semana pasada diciéndolo;
corromper es guardar basura encima de la buena.

### Los índices también pasan por admisión

Un constituyente que cayó bajo $5 o bajo $1B **sigue en el índice** hasta que el
comité lo saque. El universo del Arena no hereda esa demora: el mismo filtro de
siempre (`_lib/arena-admission.js`) corre sobre los ~600, y lo que sale queda
nombrado con el número que lo sacó.

### El costo de admitir 600 nombres (y por qué no son 1200 requests)

`_lib/arena-admission.js` se escribió para el buffet: su propio encabezado dice
"~26 llamadas a Finnhub profile2 + ~8 series de Yahoo por corrida". B1 le pasa
~600. Tal cual, eso es **600 series de Yahoo + 600 profile2**, y los 600
profile2 contra el tier gratis de Finnhub (60/min) son **10 minutos** dentro de
una función de 300s: no termina, y desde el primer minuto empieza a comer 429s.

Dos cambios, ninguno de los cuales afloja el criterio:

**Precio y volumen se miden en lote por Alpaca.** `getPriceAndDollarVolume`
(`_lib/alpaca.js`) pide velas diarias de 100 símbolos por request al mismo
`/v2/stocks/bars` que ya usa el tablero: **6 requests en vez de 600**. Excluye
la vela de hoy (point-in-time, igual que antes) y **omite** el símbolo que no
tiene velas en vez de emitir ceros — un cero se leería como "no operó" y lo
rechazaría por criterio en vez de por falta de dato.

**La pertenencia a un índice acredita el piso de market cap.** Un nombre del
S&P 500 o del Nasdaq 100 tiene market cap ≥ $1B por construcción del índice: no
hay miembro de $800M. Eso se prellena en `known` en vez de pedirlo. Es un
**supuesto**, así que viaja declarado en el journal —
`market_cap_assumed_by_index` (cuántos), `market_cap_measured` (cuántos se
midieron de verdad) y `market_cap_note` — no escondido en un default. Los ≤100
nombres del día, que no están en ningún índice, **sí** pagan su profile2 real.

El resultado, para un universo de ~600:

| | requests a Yahoo | requests a Finnhub | requests a Alpaca | Finnhub a 60/min |
|---|---|---|---|---|
| antes | 600 | 600 | 0 | 10.0 min |
| ahora | 0 | ≤100 | 6 | 1.7 min |

Lo que **no** cambió: el fail-closed. Un nombre sin precio o sin volumen sigue
sin entrar, con `reason: 'data_unavailable'` — el test lo fija pasando 300
nombres sin velas y exigiendo que los 300 queden afuera.

### El tope de 100 se gasta solo en nombres NUEVOS

Un mover que ya está en el S&P 500 no consume cupo — sería gastar el presupuesto
de nombres nuevos en nombres que ya estaban.

### Survivorship bias — dicho, no disimulado

La composición es la de **hoy**. No existe un endpoint gratis y confiable de
"constituyentes del S&P 500 en tal fecha", así que un backtest sobre esta lista
arrastra survivorship bias. El `caveat` viaja **con el dato** (no en un doc que
nadie abre) y cada corrida journalea `source` y `built_at` de la lista con la
que operó.

Lo que sí es point-in-time es el resto: los precios y volúmenes de la admisión
salen de velas **cerradas**.

### Por qué vive en un cron

~600 nombres × (precio + volumen + market cap) no cabe dentro de una corrida.
Se reconstruye a las **9:00 ET**, media hora antes de la apertura, y la corrida
solo **lee**. Si el cron no corrió, se usa el de ayer **y se dice**
(`is_today: false`) — no se reconstruye a medias, que daría un universo mitad
fresco y mitad viejo sin manera de saber cuál nombre es cuál.

### La fuente D1: las tenencias de IVV y QQQ, no FMP

**FMP cobra por los constituyentes.** `/stable` devuelve `402 Restricted Endpoint`
y `/api/v3` un `403 Legacy`: la lista del S&P 500 estaba detrás de una
suscripción.

Los ETFs que replican esos índices publican sus tenencias **completas, a diario,
gratis y sin registro**, porque están obligados:

| Índice | ETF | Proveedor | Estado |
|---|---|---|---|
| S&P 500 | **IVV** | iShares | URL **verificada** |
| Nasdaq 100 | **QQQ** | Invesco | **opcional** — sin URL verificada |

#### El Nasdaq 100 arranca OPCIONAL, y eso es una decisión

La URL de descarga de Invesco devolvió HTML, y desde el entorno donde se escribe
esto no se puede probar otra: `invesco.com` está bloqueado por el proxy de
egress, igual que `ishares.com`. Inventar variantes de la que ya falló sería
cargo-cult.

Así que si el Nasdaq 100 no contesta: **no bloquea, no cuenta como error y no
degrada la fuente a `partial`.** Esto último importa más de lo que parece — con
el índice opcional fallando todos los días, `partial` estaría siempre encendido y
dejaría de leerse. Una bandera que está siempre encendida no es una bandera, y el
día que de verdad se caiga el S&P 500 nadie lo notaría entre el ruido. Por eso
`universe_source` se calcula **solo sobre los índices obligatorios**.

Queda visible igual (`indices.nasdaq100.opcional: true`), con la nota de cómo
activarlo. Y `indices.solo_en` mide **cuántos nombres aportaría** que el S&P 500
no tiene: la mayoría de sus miembros están en los dos, así que *"nos falta el
100"* no significa *"nos faltan 100 nombres"*. Cuando aparezca una URL, la
decisión se toma con ese número.

#### Varias URLs candidatas por índice

Cada índice lleva una **lista** de URLs que se prueban en orden; gana la primera
que devuelva un CSV parseable, y se reporta cuál fue (`indices[].url_host`). Los
intentos fallidos no se pierden: quedan en `intentos` con su motivo. El override
por env var va siempre primero, así que una URL nueva entra **sin deploy**.

Es la misma información con un día de latencia como mucho, y con una ventaja
sobre FMP: es el **replicante** diciendo qué tiene, no un tercero diciendo qué
cree que tiene el índice. FMP queda como respaldo y **solo se intenta si hay
`FMP_API_KEY`** — pegarle sin plan solo produce un 402 que hay que explicar.

#### Lo que no se pudo verificar, y cómo se compensa

El entorno donde se escribió esto **no tiene salida a `ishares.com` ni a
`invesco.com`**, así que no se pudo mirar un CSV real. Los nombres exactos de las
columnas y el largo del preámbulo son lo único no confirmado. El diseño se apoya
en eso en vez de ignorarlo:

1. **El parser no exige un formato.** Busca la fila de encabezado escaneando, y
   mapea columnas por alternativas (`Ticker` / `Holding Ticker` / `Symbol`…).
   Pide **dos** columnas reconocibles: con una sola, una fila de *datos* que
   dijera "ticker" se tomaba por encabezado y el parseo quedaba corrido un
   renglón, devolviendo cero símbolos con cara de "el CSV vino vacío". Lo agarró
   el test.
2. **No depende de la columna de tipo.** El que decide qué es una acción es el
   **catálogo de Alpaca**, que es autoritativo y que ya hace falta para el canal
   del día. El CSV solo tiene que aportar tickers.
3. **Las URLs son env vars**, para corregir un archivo movido sin un deploy.

Y el CSV se parsea de verdad, no con `split(',')`: los nombres llevan comas
(`"Berkshire Hathaway Inc, Class B"`) y partir por coma corre las columnas justo
en las filas que más importan.

---

### El piso de volumen se medía sobre el feed equivocado

**Lo reportado:** 218 rechazos por volumen, con **AIG a "$8.7M/día"** entre
ellos. AIG negocia cientos de millones. También BIIB, ALGN, AES — large caps.

**La causa:** las velas salían del feed **IEX**, que es *una* bolsa — ~2-3% del
volumen consolidado. El piso de $10M se estaba aplicando sobre el 2-3% del
volumen real: en la práctica pedía **~$400M consolidados**. El filtro no estaba
midiendo liquidez; estaba midiendo **cuota de mercado de IEX**.

Lo traicionero es que el **precio** de IEX está bien. Solo el volumen es una
fracción, así que todo se veía correcto salvo el número que decidía.

#### SIP primero, IEX de respaldo, y el piso se ajusta al feed

| Feed | Piso | Qué es |
|---|---|---|
| `sip` / `delayed_sip` | **$10M/día** | consolidado: el piso real |
| `iex` | **$0.3M/día** | ≈ $10M consolidados asumiendo ~3% |
| desconocido | **$10M/día** | no se afloja sin saber sobre qué se mide |

Se intenta SIP primero y se cae a IEX si la cuenta no tiene el plan — **nunca en
silencio**: el feed que contestó viaja en el resultado, porque el umbral depende
de él. Un `403` justifica el fallback; un `500` **no**, porque reintentar con otro
feed taparía una caída de Alpaca.

**El factor es una aproximación y se declara como tal.** La cuota de IEX no es
constante: varía por nombre y por día. $0.3M usa el extremo *generoso* del rango
(~3%) a propósito — errar hacia dejar entrar un nombre algo menos líquido es más
barato que volver a tirar a la mitad del S&P 500. Y el piso sigue existiendo: un
nombre que de verdad negocia $0.2M sobre IEX sigue afuera. Se corrigió la
**unidad**, no se apagó el filtro.

`admission.rules` publica ahora las reglas **efectivas**, no las nominales:
decir "$10M/día" mientras el piso aplicado era otro fue justo lo que hizo
ilegible el rechazo de AIG.

---

### El canal del día: 100 candidatos, 0 admitidos

**Lo reportado:** de 100 candidatos del día se admitieron **cero**. 69 salieron
`data_unavailable` y eran warrants, rights, preferentes y unidades.

Dos bugs en uno, y el segundo es el que costó tiempo:

1. Entraban instrumentos que no son el universo del Arena.
2. Al rebotar se veían como falla de **cobertura** ("no pudimos resolver el
   market cap") en vez de "no es una acción". **Un rechazo con el motivo
   equivocado manda a buscar el problema al lugar equivocado** — y así fue: se
   sospechó de Finnhub cuando el problema estaba en el universo de entrada.

#### Los ETFs no son acciones, y `class` no los distingue

**Lo reportado:** 21 de los 50 cupos del canal del día se los llevaron ETFs —SPY,
QQQ, SOXL, GLD, XLE— que después rebotaban por market cap. Ocupaban lugar de
acciones y encima gastaban una llamada a Finnhub cada uno.

**El dato que cambia el diseño:** en Alpaca un ETF es `class: "us_equity"`, igual
que una acción. La prueba está en el reporte mismo — SPY y QQQ pasaron el filtro
de instrumento, que exige exactamente esa clase. Así que `class` no sirve para
esto, y hacen falta **dos señales**:

| Señal | Fuente | Alcance |
|---|---|---|
| `type` del symbol map | Finnhub, **una** llamada cacheada para todo el mercado | autoritativo (97,6% de cobertura en prod) |
| nombre del activo | catálogo de Alpaca, sin key | emisores y frases de fondo |

El `type` reusa `EXCLUDED_SECURITY_TYPES` del guard —**se importa, no se
redefine**: una segunda lista de "qué es un fondo" es una lista que se va a
desincronizar de la primera.

**Las reglas de nombre son angostas a propósito.** La tentación es `/\btrust\b/`
o `/\bshares\b/`, y las dos están mal: *Northern Trust Corporation* es un banco
del S&P 500, y BlackRock, Franklin Resources y State Street son gestoras que
cotizan como cualquier otra acción. Es la misma trampa que `ANDW` con los
warrants — una palabra genérica se come compañías de verdad. Por eso las reglas
son **emisores** (SPDR, iShares, ProShares…) y frases que solo aparecen en
fondos; lo que se escape por nombre lo agarra el `type`.

**Dónde sí van los ETFs sectoriales:** al **calor por sector del tablero**, que
ya los lleva. No compitiendo por un cupo de acción en el canal del día.

El motivo se journalea aparte (`es_fondo`, distinto de `no_es_comun`) y
`counts.del_dia_fondos` cuenta cuántos cupos se recuperaron: un ETF no es un
warrant y el post-mortem tiene que poder separarlos.

#### Por qué el sufijo no alcanzaba

`arena-guard.js` ya tenía `/[.\-+](WS|WT|W|U|R|RT)$/`. Exige un **separador**, y
Alpaca escribe muchos warrants pegados: `ABCDW`, no `ABCD.W`. La mitad pasaba de
largo. Y al revés, un sufijo sin separador es ambiguo de verdad: **`ANDW` no es
un warrant de `AND`**.

La fuente autoritativa es el catálogo de Alpaca (`/v2/assets`, ~11.000 filas en
**una** request, cacheado por día). El `name` resuelve la ambigüedad: un warrant
se llama *"… Warrant"*. Eso no es heurística sobre el ticker — es lo que el
broker dice que es el instrumento. El sufijo queda como filtro barato y como
respaldo, no como criterio.

#### El orden importa, y es el punto

El filtro corre **antes** de gastar el tope y **antes** de pedirle a Finnhub el
market cap de un warrant. Antes, los cupos se iban en ~30 acciones reales.

Y el corte dejó de ser arbitrario: **primero se mide el volumen en dólares**
—una llamada por lotes, que no cuesta cuota de Finnhub— y el tope se gasta en los
más líquidos. "Los primeros N" no quería decir nada: era el orden en que el
screener los devolvió.

**El tope bajó de 100 a 50, y el número sale de una cuota, no de un gusto.** Cada
nombre del día que no está en un índice paga un `profile2`, y el tier gratis de
Finnhub corta a 60/min (el deep dive del mismo run gasta ~20). Con 100, la mitad
del canal recibía 429 y salía marcada como si no tuviera datos. No es una pérdida
de cobertura equivalente: ahora los 50 son los **50 de mayor volumen**, no los
primeros 50 que llegaron.

Y como de cada 3 nombres del screener ~2 no son acciones, se ensanchó la entrada
bruta: movers (50 por lado, el máximo del endpoint) + most-actives por **volumen**
+ most-actives por **número de operaciones** — un ranking distinto del mismo
endpoint, que trae nombres que el de volumen no trae. ~300 brutos → ~100 comunes.

**Sin catálogo, el canal del día se apaga entero** (fail closed, igual que la
admisión) pero los índices siguen entrando: el tablero no se queda vacío por
esto. Y se journalea que la falla es **nuestra**, no de los nombres.

---

### Finnhub: "0 admitidos" tiene que decir de quién es la culpa

`fetchMarketCap` devolvía `null` en cinco situaciones —sin key, HTTP de error,
**429 por rate limit**, cuerpo sin el campo, timeout— y las cinco terminaban en
`data_unavailable`.

**El 429 es el que más importa.** El tier gratis corta a 60 llamadas por minuto.
Un lote de 100 nombres del día cruza ese techo a la mitad: los primeros ~60
resuelven y el resto recibe 429. Visto desde afuera eso se lee como *"Finnhub no
tiene estos nombres"* — una conclusión falsa sobre el **dato** cuando en realidad
es un límite **nuestro**.

Ahora hay un techo explícito (`ARENA_FINNHUB_CALL_BUDGET`, 40) y cuatro motivos
distintos donde antes había uno:

| Motivo | Qué significa |
|---|---|
| `rate_limit` | Finnhub nos frenó (429) |
| `rate_budget` | no se pidió: el lote ya gastó su cupo |
| `sin_cobertura` | Finnhub contestó `{}`: no tiene el nombre |
| `sin_market_cap` | contestó, pero sin ese campo |

Los dos primeros son nuestros y se arreglan subiendo el plan o bajando el lote;
los dos últimos son del nombre. `admission.finnhub` trae el reparto y lo dice.

---

### Cuando dice "Sin FMP", tiene que decir POR QUÉ

**El reporte que lo originó:** la key llevaba dos horas puesta en Vercel y el
endpoint seguía diciendo *"Sin FMP"*. No había forma de saber cuál de estas cosas
pasaba, porque `fetchConstituents` devolvía `null` pelado en **seis** situaciones
distintas y **ninguna llegaba a `errors`**:

| Qué pasó de verdad | Qué se veía |
|---|---|
| la env var no llegó a ese entorno | `null` |
| HTTP 401 / 403 / 429 / 5xx | `null` |
| HTTP **200** con `{"Error Message": ...}` — FMP hace esto | `null` |
| el JSON no parsea | `null` |
| timeout o red caída | `null` |
| lista más corta que `MIN_SANE` | `null` |

Un fallo que no se puede distinguir de otros cinco no es un fallo: es un agujero.
Ahora cada intento deja una fila en `fmp_diagnostics` con la API, el status, el
motivo y los **primeros 200 bytes del cuerpo** — que es exactamente donde FMP
explica el rechazo, y lo hace tanto en un 403 como en un 200.

**La key nunca se journalea**, ni truncada: viaja en la query string, así que la
URL que se guarda es la del path sin el `?apikey=`. Lo único que se publica de
ella es `fmp_key_present`, un booleano — la pregunta más barata de todas y la que
no se podía contestar.

#### Y se prueban las DOS APIs de FMP

FMP tiene dos generaciones vivas: la vieja (`/api/v3`, guiones bajos) y la nueva
(`/stable`, guiones). Cuál acepta una key depende de **cuándo se creó la key** y
de su plan: una key nueva suele recibir `403 Legacy Endpoint` en v3, y una vieja
puede no tener acceso a stable.

Adivinar cuál corresponde es justo lo que el código no puede hacer. Se prueban
las dos y se reporta **cuál contestó** (`indices[].fmp_api`) — son como mucho dos
requests por índice, una vez por semana. Lo que se gana es que *"la key no
sirve"* deje de ser indistinguible de *"le estás pegando al endpoint
equivocado"*.

### La lista se guarda sola. Nadie commitea nada

El arranque de B1 **no depende de que alguien corra `jq` en su terminal y suba
dos archivos**. Eso convertiría un cron en un ritual manual, y un ritual manual
que nadie hace es una fuente que no existe.

Cuando los constituyentes se bajan de FMP, `resolveConstituents` los escribe en
Neon (`arena_universe`, clave `constituents:<índice>`) **en el mismo paso**. El
ciclo cierra sin intervención:

| Día | Qué pasa |
|---|---|
| 1 | Neon vacío → el cron baja de FMP y **guarda** |
| 2…7 | se lee de Neon: cero cuota de FMP para recibir el mismo archivo |
| 8+ | vencida por **edad** → se refresca sola y vuelve a guardar |

El refresco es por edad y no por calendario, así que un cron que no corrió el
lunes refresca el martes en vez de esperar al lunes siguiente.

`indices[].persisted` dice, por índice, si la lista quedó guardada. Si una lista
vino fresca de FMP pero la escritura falló, la corrida de hoy sirve igual y sale
un `persistence_warning`: no se rompe nada, pero mañana se vuelve a pagar la
cuota y eso conviene que se vea.

**`data/universe/constituents.js` está vacío a propósito y no hace falta
llenarlo.** Es solo el escalón 3 —arranque en frío, con Neon vacío **y** FMP
caído el mismo día—, y el seed vacío no cuenta como respaldo.

> Era un par de `.json` leídos del disco con `import.meta.url`, y eso **tumbó
> producción el 2026-09-15**: sin `package.json`, un `.js` de `/api` se
> transpila a CommonJS, donde `import.meta` no existe. Ahora es un módulo que se
> importa estáticamente — el bundler lo incluye por definición. Ver
> `tests/arena-carga-vercel.test.mjs`. Con cualquiera de las dos fuentes
de arriba viva, el escalón 3 no se consulta nunca. Sin ninguna de las tres, el
universo cae a `movers_only` y el journal lo dice.

---

## BUFFET v1.5 — el universo del día con ojos propios (2026-09-15)

`_lib/arena-buffet.js` · tests en `tests/arena-buffet-v15.test.mjs`

v1 le daba al PM ~24 nombres de UNA fuente (`/api/movers`, top-8 por lado).
v1.5 le da ~100, de **tres preguntas distintas** que el screener de Alpaca
contesta sin una llamada por símbolo:

| Pregunta | Fuente | Tope |
|---|---|---|
| ¿Qué se **movió**? | `/v1beta1/screener/stocks/movers` | 50 por lado |
| ¿Qué se **negoció**? | `/v1beta1/screener/stocks/most-actives` | 100 |
| ¿Qué **rompió su rango**? | barras semanales cerradas, 52 semanas | — |

Las tres no son la misma pregunta, y ahí está el punto: un nombre puede mover
8% con volumen de nada, o negociar $2.000M sin moverse. v1 solo veía la primera.

**Dedupe con banderas, no con prioridad.** Un nombre que aparece en gainers Y en
most-actives Y marcando máximo de 52 semanas es **una** entrada con las **tres**
banderas — no tres entradas, ni una con el canal que llegó primero. La
coincidencia de canales ES la señal, y perderla al deduplicar sería tirar justo
lo que hace interesante al nombre. El conteo de banderas es lo que ordena la
lista cuando hay que recortar a ~100.

**Un solo filtro de admisión** (`_lib/arena-admission.js`, el mismo de siempre:
precio ≥ $5, mcap ≥ $1B, volumen $ ≥ $10M/día, fail closed) para los tres
canales. El bug de DDDX fue exactamente lo contrario — tres canales con tres
criterios y el más flojo mandando.

**El orden importa por costo:** la admisión corre ANTES del 52w, y el rango se
pide solo para los nombres que ya pasaron. Al revés se pagarían barras de
nombres que quedan afuera igual.

**Point-in-time.** El máximo y el mínimo de 52 semanas salen de barras
**semanales cerradas** — la semana en curso se excluye. Si no, un nombre
"marca nuevo máximo" contra un máximo que ya incluye el precio de este momento,
o sea contra sí mismo. Las barras semanales no pierden precisión: el `high` de
una semana ES el máximo de sus cinco días. Lo que cambian es el costo, 52 barras
por símbolo en vez de ~250.

**Orden total.** El ranking desempata por banderas → magnitud → volumen →
símbolo. El símbolo al final no es decorativo: sin un desempate total, dos
corridas con los mismos datos pueden devolver órdenes distintas y el replay deja
de reproducir la corrida.

**Va APARTE de `movers`, no lo reemplaza.** Son fuentes distintas y el
post-mortem tiene que poder comparar qué aportó cada una antes de que alguien
decida apagar la vieja. El canal nuevo entra al índice de atribución como
`universe` con sus banderas, así que una acción sobre un nombre que solo llegó
por ahí no se journalea como pick sin anclar.

**Freno de mano:** `ARENA_BUFFET_V15=0` lo apaga sin deploy. Prendido por
default. Una caída ya está cubierta — sale en `unavailable` con su error, como
cualquier canal.

Es el escalón hacia el universo de ~600 de B1: la misma forma (reconstruir,
filtrar por admisión, deduplicar con banderas, publicar point-in-time) a una
escala que ya cabe hoy.

---

## Caché de prompt: el corte, y por qué `cache_read` salía en 0 (2026-09-15)

El smoke reportó `cache_read: 0` **y** `cache_write: 0` en los dos agentes de
Anthropic, con `cache_control` viajando correctamente en el payload desde
siempre. La causa no era la configuración:

> **Por debajo del mínimo cacheable del modelo (1.024 tokens), el proveedor
> IGNORA el marcador EN SILENCIO.** No escribe caché, no cobra de más, y no
> avisa. Cero ahorro, cero error, cero pista.

El system del SCAN medía ~330 tokens. El arreglo no fue inflar el prompt: fue
poner cada cosa de su lado del corte.

```
system   → reglamento + "cómo leer cada campo"   (estable siempre)
shared   → el contexto de mercado de la corrida  (idéntico para los siete)
[BREAKPOINT — un solo cache_control, al final del bloque estable]
user     → la fecha + el libro del agente + su plan anterior   (volátil)
```

**La regla de oro:** estable antes del último `cache_control`, volátil después.
La directiva de fecha va SIEMPRE afuera; adentro invalidaría la caché todos los
días y el ahorro sería exactamente cero.

**Un solo breakpoint, al final.** El marcador cachea el prefijo ACUMULADO hasta
donde está. El reglamento del SCAN marcado solo (~980 tokens) seguiría por
debajo del piso; marcado junto con el contexto compartido, pasa. El system del
DIVE (~1.940) pasa el piso solo, así que cachea todos los días y no solo dentro
de una corrida.

**Dos ahorros distintos, no uno:** el reglamento se reusa entre corridas y entre
días; el contexto compartido hace que los siete agentes paguen **una** vez por
el mismo buffet en lugar de siete.

**Para que el silencio no vuelva:** `cachePrefixReport` mide el prefijo ANTES de
llamar, el smoke lo publica y el runner lo journalea (`context.scan.cache_prefix`).
Un prefijo corto no se bloquea — se **declara**. El smoke además separa las tres
causas de un `cache_read: 0` que antes salían con la misma nota: prefijo corto ·
fue el primero y por eso lee 0 (lo esperado) · pasa el piso pero ni escribió ni
leyó (eso sí es un problema).

**El candado del prefijo compartido:** nada que dependa del agente puede entrar
al bloque cacheado. Si entrara, cada agente tendría un prefijo distinto y la
caché no serviría para nada. Por eso el contexto compartido es **allowlist**
(`SHARED_BUFFET_FIELDS`), no denylist: un campo de diagnóstico nuevo se queda
afuera por default.

---

## Caché por día de los canales lentos (`insiders`)

`_lib/arena-buffet-cache.js`

El canal `insiders` le pega a `/api/stock-tracker?cat=insider`, que baja el feed
Atom de Form 4 de SEC EDGAR y después inspecciona hasta 60 XML sueltos. Con la
caché en memoria fría —o sea, en cada lambda nueva— son ~61 requests a un
servidor que throttlea. El techo de 12s no alcanzaba y subirlo a 30s fue un
torniquete: seguía costando 30 segundos de wall-clock y seguía cayéndose.

La cura es no volver a pedirlo. Los Form 4 son un hecho del **día**: el mismo
contenido para la corrida de las 14:00 y la de las 20:00. Una tabla en Neon con
clave `(canal, día de mercado)` convierte 84 corridas del día (12 × 7 agentes)
en **una** llamada a EDGAR.

Tres cosas que esta caché NO hace, a propósito:

- **No sirve rancio.** Una entrada de otro día no es un hit: se vuelve a pedir.
  La clave es el día de **mercado** (ET), no UTC — a las 22:40 UTC de la
  nocturna, UTC ya cambió de día pero el mercado no.
- **No cachea vacíos.** Guardar "no había nada" convertiría un hipo de 30
  segundos en un canal muerto hasta la medianoche.
- **No tapa una caída.** Sin entrada de hoy y con la fuente caída, el canal sale
  como no disponible con su error, igual que antes.

Con Neon caído se degrada a pedirlo como antes: la caché acelera, no sustituye.
`ARENA_BUFFET_DAY_CACHE` (default `insiders`) controla qué canales entran;
`movers` y `earnings` NO están y no deben estar — cambian dentro del día, y
cachearlos le daría al PM de la tarde el mercado de la mañana.

---

## RESET de libros (`/api/arena-reset`)

El único endpoint del repo que cierra posiciones a **mercado** (la excepción
declarada en `_lib/alpaca.js`) y el único que escribe `arena_state.baseline_*`.
Lo dispara una persona con `ARENA_ADMIN_KEY`, nunca un cron ni un LLM.

```bash
# 1. PLAN — no toca nada. Siempre mirar esto primero.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-reset?dry=1" | jq

# 2. EJECUTAR. Sin confirm=1 es dry run.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/arena-reset?confirm=1&id=arena-t2-2026-09-15" | jq '{verdict, summary, warnings, accounts: [.accounts[] | {agent, flat, before: .before.position_count, after: .after.position_count, starting_drawdown_pct}]}'
```

Seis pasos: **pausa el vigilante** (en Neon, no una env var — apagar una env var
pide redeploy, y un redeploy en medio de un aplanado es lo último que uno quiere
tocar; la pausa vence sola) → **foto de antes** cuenta por cuenta → **cancela
órdenes** → **liquida a mercado** → **verifica releyendo** → **re-basa y
reactiva**.

### El fix del pico, que es la mitad del trabajo

Aplanar las cuentas sin re-basar el pico del breaker es el footgun: `max(equity)`
arrastra el pico de ANTES del aplanado, un libro que vuelve a $100k desde un
pico de $130k arranca en **−23% de drawdown**, y los siete quedan HALTED en su
primera corrida.

El corte por temporada arreglaba esto para el arranque declarado, pero salía de
una **constante del registry**: un reset a mitad de temporada no tenía dónde
anotarse. Ahora el corte es por agente y con fecha real:

```
corte efectivo = MAX(arranque de temporada, baseline del último reset)
pico del breaker = MAX(máximo journaleado post-corte, equity de hoy, baseline)
```

Y llegó a la **red determinista**, que no lo tenía. Ese era el lado con dientes:
la única pieza que no se puede apagar era la que seguía midiendo el drawdown
contra un libro que ya no existía.

### El otro lado del piso, que se avisa en vez de taparse

Si el equity que queda tras liquidar está por DEBAJO del baseline declarado, el
piso mete un drawdown de arranque real. No es un bug del piso — es el baseline
diciendo la verdad sobre una cuenta que no vale lo que se declaró. Sale por
cuenta en `starting_drawdown_pct` y en `warnings`, y se corrige con `&baseline=`
o `ARENA_RESET_BASELINE_USD` sin deploy.

> **Con el mercado cerrado** las ventas a mercado se **encolan** al próximo open
> y no llenan. El baseline se escribe igual y el reporte lo dice; hay que volver
> a correr el reset con el mercado abierto para confirmar que quedaron planas.
> Es idempotente.

Verificación en `docs/sql/arena-diagnostico-2026-09-15.sql` §3.

---

## Piezas

| Pieza | Archivo |
|---|---|
| Cliente Alpaca (limit-only hardcodeado, creds override para smoke) | `api/_lib/alpaca.js` |
| Smoke + health · **smoke de VENTA** (cuenta paper aparte) | `api/alpaca.js` (`GET ?smoke=1` · `?smoke=sell`) |
| Estado del agente (HALT del breaker −20%, resume manual) | tabla `arena_state` (`api/_lib/db.js`) |
| Risk guard determinista (post-LLM, fail closed) + FLOOR del screener + **venta marketable (T2 #5)** | `api/_lib/arena-guard.js` |
| **Regla de salida** determinista (circuit breaker + stop catastrófico + **trailing stop T2 #3**) | `api/_lib/arena-exits.js` |
| **MEMORIA (T2)** — compromisos con fecha, historia de la posición, auditoría del pronunciamiento | `api/_lib/arena-memory.js` |
| **VOZ** — titular de una línea por corrida, con el arquetipo del agente | `api/_lib/arena-voice.js` |
| **Crónica de la liga** (solo lectura: compras, ventas, rechazos, cambios de líder, **disparadores**) | `api/liga-eventos.js` → `/api/liga/eventos` |
| **VIGILANTE** — disparadores, topes, cooldown, piso, costo (JS puro, cero I/O) | `api/_lib/arena-watch.js` |
| **VIGILANTE** — eventos del día (earnings + 8-K de SEC), cacheados en Neon | `api/_lib/arena-watch-events.js` |
| **VIGILANTE** — el tick (cron `*/5`, cero tokens) | `api/arena-watch.js` → `/api/arena-watch` |
| **VIGILANTE** — estado: disparos, marcas, eventos del día | tablas `arena_watch`, `arena_watch_mark`, `arena_watch_events`, `arena_watch_meta` |
| **RED DETERMINISTA sola** (sin LLM, 1×/día, extraída de la corrida nocturna) | `runArenaRiskNet` en `api/arena-run.js` |
| Deep dive Finnhub por candidato (fundamentales/recommendation/news) | `api/_lib/finnhub-dive.js` |
| Cron decide (22:40 UTC L-V) + reconcile (14:40 UTC L-V) + matutina por evento (14:50 UTC L-V, T2 #7) — **decide y matutina RETIRADAS desde 2026-09-15**, ver el cambio de cadencia | `api/arena-run.js` + `vercel.json` |
| **Cron del vigilante** (`*/5 13-21 * * 1-5`, cubre EDT y EST) | `api/arena-watch.js` + `vercel.json` (ver `docs/crons.md`) |
| **Canal SCREENER** — screens deterministas (value/momentum) | `api/_lib/screens.js` |
| **Canal SCREENER** — capa de datos Neon (tabla + ledger) | `api/_lib/screener-db.js` |
| **Canal SCREENER** — universo (~150 nombres, extraído de app.html) | `api/_lib/screener-universe.js` |
| **Canal SCREENER** — cron de precompute (cada 4h) | `api/arena-screener.js` + `.github/workflows/external-crons.yml` (GitHub Actions, **no vercel.json** — ver `docs/crons.md`) |
| Datos para la UI | `api/arena.js` |
| **Auditoría del run** (solo lectura, JSON/markdown + `?view=resumen`) | `api/arena-audit.js` + `api/_lib/arena-audit.js` |
| Journal | tabla `arena_journal` (`api/_lib/db.js`) |
| UI (sección en MIS AGENTES) | `app.html` (`qdArenaLoad`/`qdArenaHtml`) |
| Tests | `tests/arena-guard.test.mjs` · `tests/arena-exits.test.mjs` · `tests/alpaca.test.mjs` · `tests/arena-run.test.mjs` · `tests/screens.test.mjs` · `tests/arena-audit.test.mjs` · **T2:** `tests/arena-memory.test.mjs` · `tests/arena-t2.test.mjs` · `tests/arena-morning.test.mjs` · **cadencia:** `tests/arena-watch.test.mjs` (día sintético volátil, de punta a punta) |

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
- `season_started` — arranque de temporada, **UNA fila de liga**
  (`agent_id='league'`), automática e idempotente: la emite el orquestador en su
  primera corrida con los siete activos (`announceSeasonOpen`).
- `rules_changed` — cambio de reglamento, también fila de liga (`announceT2Rules`).
- `season_winner` — cierre de temporada con el ranking final, el último día.
- `season_start` (LEGADO) — el mecanismo manual `?action=announce` que insertaba
  una fila por agente se **retiró** al consolidar en uno solo. El status se
  conserva en la lista de exclusión del plan anterior porque las filas que
  alcanzó a escribir siguen en el journal: borrar el código no borra el rastro.

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

> **Esta sección describe el CONTRATO DE ACCIONES (el guard), que el contrato de
> portafolio objetivo sustituyó el 2026-09-17.** Sus números —8 posiciones, 15%
> por posición, long-only— son los del guard y siguen siendo ciertos EN ESE
> camino, que ya no es el que corre en vivo. Los límites vigentes son los rieles
> (R1-R12, `api/_lib/arena-rails.js`): 30% por nombre largo, 15% por nombre
> corto, y cortos habilitados desde el 2026-09-18. Se deja por historia, no como
> referencia.

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

**Addendum de la liga:** `ARENA_HEADLINES` (opc; `0` apaga los titulares sin
tocar código) · `ARENA_BASELINE_EQUITY` (ya existía, 100000: el baseline del
return que publica el leaderboard y el cierre de temporada).

**Vigilante / cadencia por evento** (todas opcionales; el default está entre
paréntesis y un valor inválido cae al default en silencio, como el resto):

| Var | Default | Qué hace |
|---|---|---|
| `ARENA_WATCH_ENABLED` | `1` | `0` apaga **solo** el vigilante, sin apagar el Arena. El freno de mano. |
| `ARENA_WATCH_START` | `2026-09-15` | Fecha ET del corte de cadencia. Moverla hacia adelante **devuelve** el cron nocturno sin un deploy. El id, la fecha y el texto del `rules_changed` la siguen — si no, la env var movería la compuerta sin mover el registro del corte. |
| `ARENA_WATCH_MOVE_PCT` | `0.03` | Umbral del ±% desde el último pronunciamiento. |
| `ARENA_WATCH_BUFFET_PCT` | `0.05` | Umbral del candidato del buffet. |
| `ARENA_WATCH_STOP_POINTS` | `2` | Puntos porcentuales de cercanía a un stop. |
| `ARENA_WATCH_VOL_MULT` | `3` | Múltiplo del volumen promedio de 20 días. |
| `ARENA_WATCH_MAX_RUNS_DAY` | `12` | Tope de corridas por agente por día (la de piso cuenta). |
| `ARENA_WATCH_COOLDOWN_MIN` | `20` | Cooldown por (agente, ticker). |
| `ARENA_WATCH_MAX_RUNS_TICK` | `7` | Tope por tick (la lambda tiene 300s). Lo diferido vuelve al tick siguiente. |
| `ARENA_WATCH_FLOOR_AFTER_OPEN_MIN` | `30` | Apertura + N min → revisión de piso. |
| `ARENA_WATCH_EVENTS_TTL_MIN` | `30` | Cada cuánto se re-escanea SEC por 8-K del día. |
| `ARENA_INTRADAY_BUY_BAND` | `0.04` | Banda del marketable limit de **compra** intradía (la de venta sigue siendo `ARENA_EXIT_BAND_DISCRETIONARY`). |
| `ALPACA_DATA_FEED` | `iex` | Feed de la Market Data API. `sip` el día que haya suscripción — pedirlo sin ella devuelve 403 y deja al vigilante ciego. |

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

### Env vars nuevas (2026-09-15)

| Var | Default | Qué hace |
|---|---|---|
| `ARENA_ADMIN_KEY` | — | **Obligatoria** para `/api/arena-smoke` y `/api/arena-reset`. Sin ella los dos dan 503. |
| `ARENA_RESET_BASELINE_USD` | `100000` | Baseline declarado de la temporada: denominador del return **y** piso del pico del breaker. |
| `ARENA_RESET_WATCH_PAUSE_MIN` | `15` | Cuánto dura la pausa del vigilante durante el aplanado. Vence sola. |
| `ARENA_CACHE_MIN_TOKENS` | `1024` | Mínimo cacheable del proveedor. Lo fija el proveedor, no nosotros — se corrige con env var, no con deploy. |
| `ARENA_BUFFET_V15` | `1` | Freno de mano del universo del día (screener de Alpaca). `0` lo apaga sin deploy. |
| `ARENA_BUFFET_V15_TARGET` | `100` | Cuántos candidatos ve el PM. |
| `ARENA_BUFFET_DAY_CACHE` | `insiders` | Canales que se piden una vez por día y se leen de Neon. **No** poner `movers` ni `earnings`: cambian dentro del día. |
| `FMP_API_KEY` | — | **Respaldo opcional** de constituyentes. Los endpoints de índices de FMP son de **pago** (402/403 sin plan), así que la fuente viva son las tenencias de ETFs. Sin esta key ni se intenta. |
| `ARENA_HOLDINGS_URL_SP500` | URL de IVV | Override de las tenencias del S&P 500. Existe para corregir una URL movida **sin deploy**. |
| `ARENA_HOLDINGS_URL_NASDAQ100` | URL de QQQ | Ídem para el Nasdaq 100. |
| `ARENA_FINNHUB_CALL_BUDGET` | `40` | Techo de `profile2` por lote de admisión. El tier gratis corta a 60/min y el deep dive gasta ~20. Lo que queda afuera se journalea `rate_budget`, **no** como falta de datos. |
| `ARENA_UNIVERSE_REFRESH_DAYS` | `7` | Cada cuánto se vuelve a pedir la composición de los índices. |
| `ARENA_UNIVERSE_MOVERS_MAX` | `100` | Tope de nombres del día que se AGREGAN al universo (los que ya están en un índice no gastan cupo). |
| `ARENA_BOARD` | `1` | Freno de mano del tablero (B2). `0` lo apaga sin deploy. |
| `ARENA_BOARD_TOKEN_CAP` | `5000` | Techo DURO del tablero. El objetivo declarado son 3-4K; pasarse se journalea. |
| `ARENA_TOOLS_MAX` | `8` | Llamadas a herramientas por ronda fija. Tope DURO del harness. |
| `ARENA_TOOLS_MAX_TRIGGER` | `3` | Ídem en una corrida por disparador. |
| `ARENA_TOOL_RESULT_TOKENS` | `1500` | Techo de cada resultado. El corte se declara adentro. |
| `ARENA_TOOL_TURNS_MAX` | `10` | Tope de VUELTAS del loop (distinto del de llamadas). |
| `ARENA_TOOL_LOOP_MS` | `120000` | Tope de TIEMPO del loop. El que de verdad manda. Ver B12. |
| `ARENA_AGENT_DEADLINE_MS` | `270000` | Techo del trabajo completo de un agente. **Si se toca, tocar `vercel.json` también.** |
| `ARENA_TOOLS` | `1` | Freno de mano de las herramientas. `0` vuelve al DIVE de una sola llamada. |
| `ARENA_RAIL_MAX_LONG` / `_SHORT` | `0.30` / `0.15` | Rieles por nombre (B6). |
| `ARENA_RAIL_MAX_GROSS` / `_SECTOR` / `_MAX_SHORT_GROSS` | `1.00` / `0.50` / `0.50` | Rieles de cartera. |
| `ARENA_RAIL_MIN_POSITION` / `_MIN_SHORT_PRICE` | `0.02` / `10` | Mínimo por posición y precio mínimo de corto. |
| `ARENA_RAIL_NO_TRADE_BAND` | `0.02` | Banda de no-negociación (2pp). |
| `ARENA_SHORT_CATASTROPHIC_PCT` | `0.20` | Stop del corto (+20%, no +22%). |
| `ARENA_SHORT_TRAILING_ARM` / `_GIVE_BACK` | `0.15` / `0.08` | Trailing del corto, con el pico invertido. |
| `ARENA_DAILY_BUDGET_USD` | `30` | Presupuesto diario de la liga (B9). |
| `ARENA_BUDGET_TIER2_MULT` | `1.5` | Múltiplo del escalón 2. |
| `ARENA_TAIL_TOKEN_CAP` | `2000` | Techo de la cola NO cacheada (enfoque + orden aleatorizado). |


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
