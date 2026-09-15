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
| **T3** | **Short habilitado.** El guard se adapta: hoy es long-only por diseño (`no hay posición larga que vender` es un descarte duro) y abrir cortos toca sizing, margen, el borrow y toda la regla de salida —un stop en un corto es al revés—. **PR aparte**, no un flag. | Planeada |
| **T4 — o nunca** | **Opciones.** Condición previa e innegociable: **una fuente de datos real** (cadena, griegas, IV, vencimientos). Sin esa fuente NO se hace: un libro de opciones sobre precios inventados no es un experimento, es una demo. | Condicional |

**Por qué el orden importa.** Cada temporada cambia el reglamento, y un cambio
de reglamento parte la serie: por eso `PROMPT_VERSION` sube con la temporada y
el cambio se anuncia en el journal con fecha. Meter short y opciones dentro de
la misma temporada haría imposible atribuir un resultado a nada.

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

**Lente primaria rotativa** (momentum / catalizador / valor / reversión), dicha
como *"hoy mirá primero por…"*. No prohíbe nada: cambia por dónde empieza.

**Todo determinista, y no es un detalle.** Semilla `hash(agent_id + run_id)`,
lente `LENTES[(hash(agent) + día) % 4]`. Un `Math.random()` acá haría el journal
**irreproducible** y el replay —que existe justamente para reconstruir qué vio
cada agente— sería inútil. Hay un lint que lo verifica sobre el código (no sobre
los comentarios, que explican precisamente por qué no se usa).

El día es el del **Este**: con UTC la lente cambiaría a las 20:00 ET, o sea a
mitad de sesión.

**Dónde vive la aleatorización (D2):** en la **cola no cacheada**, nunca en el
prefijo. Si el orden cambiara dentro del bloque cacheado, los siete tendrían
prefijos distintos y la caché no serviría para nada. La cola tiene su propio
techo (≤2K tokens) y, al recortarse, **la lente sobrevive**: son 40 tokens y es
la mitad del mecanismo.

> **Advertencia honesta:** la lente rotativa es un **confound deliberado**. Dos
> agentes con lentes distintas el mismo día **no son comparables ese día**. Mide
> diversidad a costa de comparabilidad diaria; a lo largo de la temporada se
> promedia, pero va dicho en el post-mortem en vez de dejar que alguien lo
> descubra.

**Las métricas.** Con portafolio objetivo el herding deja de ser una
aproximación: el solapamiento par a par es el **coseno** entre los vectores de
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

### Lo que falta y necesita tus ojos

`data/universe/sp500.json` y `nasdaq100.json` están **vacíos a propósito**. Se
generan corriendo el refresco contra FMP, y el entorno donde se escribió este
código no tiene salida a `financialmodelingprep.com` (la política de red
responde 403). Una lista de 500 tickers escrita de memoria estaría
desactualizada de formas que nadie puede auditar. Con `FMP_API_KEY` puesta:

```bash
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/arena-universe?refresh=1&emit=1" > /tmp/u.json
jq '.constituents.sp500'     /tmp/u.json > data/universe/sp500.json
jq '.constituents.nasdaq100' /tmp/u.json > data/universe/nasdaq100.json
```

Mientras estén vacíos, el escalón 3 no existe y el universo depende de FMP o de
Neon. **Nada se rompe** — sin ninguno de los dos, cae a `movers_only`.

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
| `FMP_API_KEY` | — | Constituyentes del S&P 500 / Nasdaq 100. Sin ella el universo cae a Neon → JSON del repo → `movers_only`. Nada se rompe. |
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
| `ARENA_TAIL_TOKEN_CAP` | `2000` | Techo de la cola NO cacheada (lente + orden aleatorizado). |


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
