# Backtest: rotación Value + Momentum sobre la BMV

> **Estado: Fase A construida, sin correr.** El cosechador existe y está
> probado; los datos todavía no. Los criterios de GO/NO-GO de la Fase B están
> **congelados en este documento antes de ver un solo número** — que es el único
> momento en que congelarlos significa algo.

> ### Corrección del 16-sep-2026, antes de cualquier resultado
> Cuatro cambios al diseño, los cuatro pedidos cuando la Fase A **todavía no
> había corrido** y no existía ni un número del backtest:
>
> 1. El filtro de liquidez pasa de **mediana del universo** a **umbral absoluto**
>    de 5 millones de pesos (§3.1).
> 2. La canasta gana **piso de 8 y techo de 15** nombres, y la puerta de
>    INCONCLUSO se muda al **universo elegible** (§3.3, §3.4).
> 3. El benchmark queda **NAFTRAC ISHRS** y es de **retorno total**, no de
>    precio (§3.3).
> 4. **Los dos lados** pasan a retorno total: la canasta reinvierte los
>    dividendos de cada emisora en su fecha ex-cupón, igual que el benchmark
>    (§3.3). Se reportan **cuatro series** y el veredicto se lee **total vs
>    total**.
>
> La fecha y el orden se anotan a propósito. Un criterio que se mueve **después**
> de los números deja de ser un criterio, y la única prueba de que éstos no se
> movieron así es que los números todavía no existen.
>
> **Los umbrales de GO no se tocaron en ninguno de los cuatro cambios**: |t| ≥ 2
> y Sharpe ≥ NAFTRAC + 0.15 siguen donde estaban desde el principio.

> ### El probe corrió: el contrato ya no es una suposición
> 14 requests, 14 créditos. La API **dijo por su nombre** lo que faltaba, y el
> diseño de fallar barato se pagó solo:
>
> | | Lo que este doc suponía | Lo VERIFICADO |
> |---|---|---|
> | `/v2/financieros` | `periodo=2026-2` | **`periodo=1T_2020`** — trimestre, T, guion bajo, año |
> | `/v2/historicos` | `emisora=WALMEX` | **`emisora_serie=WALMEX*`** — otro parámetro, y con la serie pegada |
>
> Ninguna de las 8 grafías probadas era la buena, y el cuerpo del error traía el
> ejemplo literal. Costó **14 créditos de 200,000** averiguarlo, que es
> exactamente para lo que existía el probe.
>
> Y un hallazgo que cambia el presupuesto entero: **el censo devolvió 441,543
> caracteres** — cientos de emisoras, no 30 (§2.1, §4.1).

> ### El censo corrió: 137 ICS, y cuatro bugs de la misma clase
> **595 filas · 185 series ICS · 137 emisoras ICS únicas** (109 ACTIVA,
> 76 SUSPENDIDA). **El universo alcanza de sobra** (§4.1).
>
> Los cuatro bugs eran todos la misma falla: **el dato llegaba bien y el código
> lo tiraba.** Vale la pena nombrarla, porque es la que este proyecto más
> repite.
>
> | # | Qué pasó | Por qué |
> |---|---|---|
> | 1 | Las **137 ICS** salieron con cobertura **CERO** | `rango_financieros` llega como lista (`"1T_2017, 1T_2018, …, 2T_2016, …"`) y el parser rechazaba el formato **bueno** |
> | 2 | `distribuciones_guardadas: 0`, WALMEX "sin reparto" | los dividendos cuelgan de la **serie**, y llegan como arreglo — el parser sólo miraba objetos con llaves |
> | 3 | 7 de 7 filas de precios descartadas | el formato real es `{"2026-06-22": [50.57, 1313556324.33]}` — un **arreglo**, no un objeto |
> | 4 | El benchmark daba 400 | el identificador va **pegado**: `NAFTRACISHRS`, no `NAFTRAC ISHRS` |
>
> **Fallar cerrado protege de inventar datos; no sirve de nada si además tira
> los que llegan bien.** Los cuatro tienen test con la forma **real** que la API
> mandó, no una inventada — que es la única manera de que un fail-closed
> demasiado estricto se note antes y no después.
>
> Dos que el arreglo destapó de paso:
>
> - La lista de trimestres viene en orden **lexicográfico** (`1T_2017` antes que
>   `2T_2016`), así que tomar el primero y el último daba el arranque **un año
>   tarde**. Se ordena cronológicamente.
> - Extraer dividendos del objeto de la emisora le daba a cada serie los
>   repartos de **todas sus hermanas** — LIVEPOL `C-1` se llevaba los de
>   LIVEPOL `1`. Ahora sale del sub-objeto de cada serie.

Espejo estructural de `/api/rotation-analyze`, el backtest gringo que en agosto
salió **NO-GO** con t=0.49 y Sharpe por debajo del SPY. Se reutiliza lo que
sirve de allá —la aritmética de percentiles, el turnover real, el t en
calendar-time— y se cambia lo que tiene que cambiar: **los precios vienen de
DataBursatil, no de Yahoo**, y el benchmark es NAFTRAC, no el SPY.

---

## 0.0 Los tres caveats que van en el encabezado del reporte de Fase B

**No al pie.** Un caveat que hay que ir a buscar no es un caveat, es una
coartada. Estos tres cambian cómo se lee cualquier número del backtest, así que
van **arriba**, antes de los resultados que califican — y lo mismo hace
`?job=cobertura&format=md`.

| Caveat | Estado medido |
|---|---|
| **Fecha ex aproximada en ~91% de los repartos** | La API sólo trae `fechaexcupon` en el bloque `reciente`. El resto es pago − 3 días. |
| **14 repartos en moneda extranjera** | 12 USD + 2 EUR, en 10 series ICS. **Excluidos** del retorno total de la v1, con los bp no contados reportados por serie (§3.3). |
| **121 reembolsos de capital** | **Excluidos** del caso base: devolver principal no es rendimiento. Disponibles como sensibilidad (§3.3). |

El 91% no es un detalle de implementación: significa que **la fecha de
reinversión de casi toda la serie es una estimación**, no un dato. Se aplica
igual a la canasta y al benchmark, así que se cancela a primer orden en el
exceso — pero el lector tiene derecho a saberlo antes de leer un Sharpe, no
después.

---

## 0. Lo primero, porque cambia cómo se lee todo lo demás

**Este sandbox no alcanza `api.databursatil.com`.** El proxy de egress de la
organización contesta **403 al CONNECT** — una denegación de política, no una
falla transitoria, así que no se reintenta: se reporta. `databursatil.com`
tampoco, o sea que **ni la API ni su documentación se pudieron leer**.

Consecuencia honesta y con nombre propio: **el contrato exacto de la API no
está verificado**. No sé con certeza cómo se llama el parámetro del periodo,
ni si la respuesta viene anidada por bloque o plana, ni cuánto cuesta cada
request. Todo eso va marcado `[NO VERIFICADO]` donde aparece.

Lo que se hizo en vez de adivinar:

| | |
|---|---|
| **`?job=probe`** | Gasta ≤18 requests y **descubre** el contrato: prueba 8 grafías del periodo, 5 del rango de fechas y 2 del identificador del benchmark, y guarda la que funcione en `bmv_meta`. Si falla, falla **barato** y devuelve el cuerpo crudo del error — que es donde las APIs suelen decir exactamente qué parámetro falta. |
| **Crudo siempre** | Cada respuesta de financieros se guarda completa en `jsonb`. Si la normalización quedó mal, se corrige con un `UPDATE` sobre lo guardado, **sin gastar un crédito más**. |
| **Fail-closed** | Un campo que no resuelve es `null` **con motivo**, nunca un cero ni un proxy. Misma regla que el XBRL. |

Es el mismo movimiento que el descubrimiento de tags del smoke de Fase 0:
nunca asumir, medir. La diferencia es que aquí medir cuesta créditos, así que
se mide con tope.

---

## 1. Fase A — la cosecha

`/api/bmv-harvest`. Tablas nuevas, todas con prefijo `bmv_`. **`xbrl_reports`
no se toca**: es la serie de Fase 1a y lo único que produce la **fecha real de
publicación**, que es justo lo que DataBursatil no tiene
(`docs/historico-censo.md` §2.1). Las dos series conviven y se cruzan por
`(clave, año, trimestre)`.

| Tabla | Qué guarda |
|---|---|
| `bmv_emisoras` | El censo. `rango_financieros` → `fin_desde`/`fin_hasta`. |
| `bmv_financieros` | Emisora × trimestre: crudo completo + 7 campos normalizados + `faltantes`. |
| `bmv_precios` | Cierre diario e importe operado, **por `emisora_serie`**. |
| `bmv_distribuciones` | Repartos de **todas** las emisoras por fecha **ex-cupón** — canasta y benchmark. Llegan con el censo: no cuestan un request. |
| `bmv_harvest_ledger` | Qué se pidió y cómo salió. La idempotencia vive aquí. |
| `bmv_api_budget` | Créditos por mes **CDMX**. |
| `bmv_meta` | El contrato descubierto por el probe. |

Migración legible en `docs/sql/bmv-harvest.sql` (generada del schema real, así
que no puede desfasarse).

### 1.1 El censo es el dato que evita el sesgo de supervivencia

`rango_financieros` no es metadata: **es el universo point-in-time**. Define en
qué trimestre existía cada emisora, y por lo tanto quién puede entrar al
ranking de cada rebalanceo. Por eso las **SUSPENDIDAS se guardan con su rango
completo**, no se filtran: ELEKTRA con financieros hasta 4T2025 es exactamente
el caso que un universo "lista de hoy mirada hacia atrás" perdería, y perderlo
infla el resultado.

Una ICS **sin** `rango_financieros` parseable se reporta aparte y en voz alta
(`ics_sin_rango_financieros`): no se le inventa una fecha de nacimiento.

### 1.2 Idempotencia y parada limpia

El ledger guarda cada `(job, emisora, clave)` resuelto. Lo que está `hecho` o
`vacio` **no se vuelve a pedir**. Correr el job dos veces no cuesta créditos de
más; correrlo veinte veces termina la cosecha.

Los precios además son **incrementales**: cada corrida arranca desde el día
siguiente al último guardado. Sin eso, como el rango del censo termina en
"hoy", la clave del ledger se movería **cada día** y lo ya cosechado dejaría de
reconocerse — una fuga de idempotencia que bajo un costo por dato se paga con
el presupuesto entero.

`vacio` ≠ `error`, y la distinción importa: un trimestre en el que la emisora
no reportó es un **hecho del mundo**, se marca resuelto y no se re-pide. Un
error sí se re-pide.

Tres cosas paran una corrida, y las tres devuelven **dónde se quedó**:

| Razón | Qué significa |
|---|---|
| `presupuesto_mensual_agotado` | Se corta **antes** de pasarse, no después. |
| `tope_de_la_corrida` | El `&max=N` de esa invocación. |
| `reloj_de_la_lambda` | 240s de 300s, para devolver un reporte en vez de un 504. |

---

## 2. El presupuesto de créditos, **antes** de correr

200,000 al mes, se reponen el **día 1 a las 00:01 CDMX**. El contador usa el mes
en hora de **CDMX, no UTC**: con el mes UTC, las primeras 6 horas del día 1
caerían en el mes anterior y el mes nuevo arrancaría contado como gastado.

La forma del gasto, con la cobertura declarada 2T2016→2T2026 (41 trimestres):

| Concepto | Requests |
|---|---|
| Censo de emisoras | 1 |
| Financieros | **emisoras × 41** (por emisora, no por serie) |
| Históricos | **1 por serie**, más el benchmark |

Con el censo **real** cerrado —185 series ICS, 137 emisoras únicas, 20 series
sin cobertura (bancos y casas de bolsa)— el gasto queda así:

| Concepto | Requests |
|---|---:|
| Censo | 1 |
| Financieros: **117 emisoras** (137 − 20 sin cobertura) × sus trimestres | 3,400 – 4,700 |
| Históricos: **185 series ICS + benchmark** | 186 |
| **Total** | **≈ 3,600 – 4,900** |

**Entre 1.8% y 2.4% del presupuesto mensual.** El rango depende de cuántos
trimestres traiga cada emisora en su enumeración (39 para una que reporta desde
2T2016, menos para las que listaron después).

> Este número es **aritmética sobre el censo reportado**, no una corrida:
> `?job=estimate` contra la base da el exacto, porque lee la enumeración real de
> cada emisora. Los financieros salen de `pendientesFinancieros`, la misma
> función que usa la cosecha — así que el estimado y lo que se pide no pueden
> discrepar.

### 2.1 El modelo de costo, resuelto con evidencia

Este documento traía tres modelos de costo porque no se sabía cuál usaba la API,
y la diferencia entre ellos decidía si la cosecha cabía en un mes. **El probe lo
resolvió, y sin proponérselo.**

| | |
|---|---|
| Requests que hizo el probe | 1 censo + 8 grafías de financieros + 5 de históricos = **14** |
| Créditos que gastó | **14** |
| Tamaño de la respuesta del censo | **441,543 caracteres** |

**Un request de 441 KB costó lo mismo que uno que devolvió un error.** O sea que
el cobro es **por request**, no por dato: el modelo A es el real y los modelos B
y C quedan descartados **con evidencia, no con una suposición cómoda**.

Es una inferencia de una sola corrida, así que no se declara verdad revelada:
`bmv_api_budget` guarda requests y créditos por separado en cada corrida, de
modo que si la relación deja de ser 1:1 se ve en el propio contador.

### 2.2 Con eso, el presupuesto deja de ser una restricción

Con el censo **real** ya corrido — 137 emisoras ICS, 185 series, 39 trimestres
reportados por emisora:

| Concepto | Requests |
|---|---:|
| Censo | 1 |
| Financieros (137 × ~39) | ~5,343 |
| Históricos (1 por serie + benchmark) | ~138 |
| **Total** | **~5,482** |

**2.7% del presupuesto mensual.** Y la frontera está en ~4,700 emisoras ICS, o
sea que ni multiplicando el universo por 30 se llegaría al tope. **La cosecha
cabe con margen de sobra**, y la pregunta de cómo partirla deja de ser urgente.

Los financieros salen de la **enumeración** de trimestres del censo, no del
rango: `rango_financieros` lista los trimestres que la emisora sí reportó, y
puede tener huecos. Pedir min..max rellenaría esos huecos con requests que
vuelven vacíos —y, peor, metería a la emisora al universo en trimestres que no
reportó.

Los financieros se cuentan **por emisora** y los precios **por serie**: una
emisora con dos series (LIVEPOL `C-1` y `1`) cuesta dos rangos de precios pero
**un solo** juego de 41 trimestres. Contarlos juntos habría inflado el
presupuesto justo donde más filas hay.

#### Y si algún día no cabe

`?job=estimate` devuelve el plan en `plan_si_no_cabe`, y el orden es lo único
que importa: **primero financieros, después precios**. Los financieros son el
dato escaso y point-in-time —sin ellos no hay ranking—, mientras que los precios
se piden por rango y llegan completos cuando toque.

No hay que hacer nada especial para partirla: la cartera para sola en
`presupuesto_mensual_agotado`, el ledger guarda dónde quedó, y el día 1 a las
00:01 CDMX se retoma **con el mismo job**. Eso ya estaba construido; lo único
que faltaba era decir en qué orden. Por eso el piso de precios por defecto es 2016-01-01 y no 2010, y
por eso `?job=probe` corre primero: si la API publica el saldo en headers, el
cosechador lo guarda y el presupuesto deja de ser una estimación.

Si resulta ser el modelo C, la cosecha se parte en dos meses (financieros el
primero, precios el segundo) o se recorta el rango de precios. **El ledger hace
que partirla no cueste nada**: el segundo mes retoma donde paró el primero.

> 2016-01-01 no es un recorte arbitrario. El primer rebalanceo con un TTM
> completo cae a mediados de **2017** (§3.2), y el momentum 12-1 necesita los 12
> meses previos: mediados de 2016. El piso los cubre con holgura.

### Orden de ejecución

```
?job=estimate                    # público, sin red ni créditos
?job=probe                       # ≤18 requests: descubre el contrato (ya verificado)
?job=emisoras                    # 1 request: el censo
?job=estimate                    # otra vez, ya con el censo REAL
?job=financieros&max=60          # repetir hasta restantes=0
?job=historicos&max=30           # repetir hasta restantes=0
?job=reparse-fin                 # CERO créditos: re-normaliza desde el crudo
?job=cobertura&format=md         # el reporte
```

Los cuatro jobs que escriben van protegidos con `Authorization: Bearer
<ADMIN_SECRET>`. Sin secret configurado **no se escribe**: fail closed.

---

## 3. Fase B — los criterios, congelados

**Nada de esto se mueve después de ver los números.** Lo que ya toca código —el
identificador del benchmark, el filtro del universo, el rezago— está fijado ahí
y con test. El resto vive en esta sección y se fijará en código al construir la
Fase B: **el diff contra este documento es la verificación**.

### 3.1 Universo en cada rebalanceo

Emisoras **ICS** (`tipo_valor_id=1`) con financieros disponibles a esa fecha
—**incluidas las SUSPENDIDAS mientras tuvieron precios**— y con **mediana del
importe operado de los últimos 3 meses ≥ 5 millones de pesos**, calculada en
**cada** rebalanceo.

**Umbral absoluto, no mediana del universo.** El propósito es **excluir lo no
operable**, no partir el universo en dos. Un filtro por mediana tira siempre la
mitad: con un universo líquido descarta emisoras perfectamente negociables, y
con uno ilíquido deja pasar la mitad menos mala. El umbral absoluto contesta la
pregunta que importa —**¿se puede comprar esto?**— en vez de una relativa que
cambia de significado según con quién se compare.

Se reportan los elegibles, **las exclusiones por motivo** en cada rebalanceo, y
**cuántas caen por el filtro de liquidez en cada fecha**. Una exclusión sin
motivo es un universo que nadie puede auditar.

> ### Tripwire de calibración, entre la Fase A y la Fase B
> Si el filtro de 5 millones excluye **más de un tercio del universo en
> promedio**, el umbral está mal calibrado para BMV y **se baja antes de correr
> el backtest**, no después.
>
> Que esto pueda hacerse sin contaminar nada no es casualidad: el porcentaje
> excluido se calcula con **censo y precios solamente**, sin tocar un solo
> retorno de la estrategia. O sea que recalibrar el umbral es imposible de
> sesgar con resultados — todavía no hay resultados que mirar.

### 3.2 Value — y los 65 días

**Value = EPS TTM ÷ precio.** El TTM es la suma de `basicearningslosspershare`
de los **4 trimestres cuya fecha de cierre + 65 días ≤ fecha de rebalanceo**.

Se pide `resultado_trimestre`, **no** `resultado_acumulado`: el TTM es la suma
de cuatro trimestres sueltos. Con acumulados, el 1T se contaría cuatro veces.

##### El EPS es el TOTAL, no el de operaciones continuas

La API devuelve tres EPS básicos, y WALMEX 2T2017 los muestra bien:

| campo | valor |
|---|---:|
| `basicearningslosspersharefromcontinuingoperations` | 0.39 |
| `basicearningslosspersharefromdiscontinuedoperations` | 0.38 |
| **`basicearningslosspershare`** | **0.77** |

> **Decisión congelada: se usa `basicearningslosspershare`, el total.**

Dos razones, y la segunda pesa más:

1. Es **lo que le tocó al accionista** en el periodo. El de continuas es una
   medida más limpia del poder de generación *futuro*, pero deja fuera economía
   real que sí ocurrió.
2. Es el **único campo que todas las emisoras traen**. El desglose
   continuas/discontinuadas sólo aparece cuando **hubo** operaciones
   discontinuadas — usarlo obligaría a caer al total en la mayoría de los casos,
   y entonces el TTM mezclaría dos definiciones según la emisora y el trimestre.
   **Una serie con dos definiciones no es una serie.**

El costo, dicho: el total incluye ganancias y pérdidas de una sola vez, así que
el value queda **más ruidoso** de lo que estaría con el de continuas. Es ruido,
no sesgo: ensancha la dispersión del ranking sin empujarlo en una dirección.

**Los 65 días son deliberados y no son un lag de conveniencia.** DataBursatil
indexa por **cierre**, no por publicación. Con nuestras fechas reales de Fase
1a, el rezago observado va de **23 a 59 días**:

| Emisora | Cierre | Publicado | Lag |
|---|---|---|---:|
| WALMEX | 2026-06-30 | 2026-07-23 | 23 días |
| PE&OLES | 2026-06-30 | 2026-07-23 | 23 días |
| MEGA | 2026-06-30 | 2026-08-28 | **59 días** |

65 > 59, el máximo observado. Eso **elimina** el look-ahead en vez de
repartirlo. El costo es información rancia —se descarta lo que ya era público
para las que reportan pronto— y ese costo **sesga en contra de encontrar
alfa**, que es el lado correcto en el que equivocarse.

Un lag fijo de 45 días, en cambio, dejaría a WALMEX 22 días tarde y a MEGA 14
días **temprano**: no corrige el sesgo, lo **reparte** — y lo reparte
correlacionado con características de la empresa, que es justo lo que un
backtest puede confundir con alfa.

> El rezago observado son 3 emisoras de **un** trimestre. No es una
> distribución, es una cota inferior de la dispersión. 65 días cubre lo
> observado; no garantiza cubrir lo no observado. Cuando el capturador de Fase
> 1a acumule más trimestres, este número se revisa **con datos, no con ganas**.

### 3.3 Momentum, score y cartera

| | |
|---|---|
| Momentum | **12-1** sobre precios diarios (de t−12m a t−1m). |
| Score | **Promedio de los dos ranks percentiles** dentro del rebalanceo. |
| Precio del ranking | **Cierre del día anterior** — la canasta tiene que quedar armada antes de la apertura en que se ejecuta, o el backtest no es replicable en vivo. |
| Cartera | **Quintil superior con piso 8 y techo 15**, equal-weight. Si el quintil da menos de 8 → los **8 mejores**; si da más de 15 → los **15 mejores**. |
| Rebalanceo | **Mensual**. |
| Costos | **10 bp por lado** sobre el turnover real. |
| Benchmark | **NAFTRAC ISHRS** (emisora NAFTRAC, serie ISHRS, `tipo_valor_id` **1B**), de **RETORNO TOTAL**. |

#### Retorno total **de los dos lados**, y eso no es un detalle

NAFTRAC reparte. Compararse contra su **precio pelón** le resta ~3% anual al
benchmark — o sea que nos **regala** un exceso de ~3%/año que nunca existió. Con
un umbral económico de Sharpe + 0.15, un regalo de ese tamaño no es ruido: es
suficiente para **fabricar un GO**.

Pero las emisoras de la canasta **también reparten**. Medirla a precio contra un
benchmark de retorno total sería **el mismo error con el signo volteado**, y por
un monto del mismo orden: en vez de regalarnos un exceso, nos cobraría uno.

Así que **los dos lados** son **precio + distribuciones reinvertidas en la fecha
ex-cupón**: la canasta reinvierte los dividendos de cada emisora en la fecha ex
de esa emisora, exactamente como el benchmark reinvierte los suyos. La fecha
**ex**, no la de pago: reinvertir en la de pago adelantaría el flujo y metería
look-ahead por la puerta de atrás — justo lo que los 65 días cierran del otro
lado.

Los montos se toman **brutos**, de los dos lados. El ISR sobre dividendos aplica
igual a la canasta y al benchmark, así que a primer orden se cancela en el
exceso; aplicarlo a un solo lado sí sería un sesgo.

##### Se reportan CUATRO series

| Serie | Qué deja ver |
|---|---|
| **Canasta — total** | **El numerador del veredicto.** |
| **NAFTRAC — total** | **El denominador del veredicto.** |
| Canasta — precio | Cuánto aportaron los dividendos de las emisoras. |
| NAFTRAC — precio | Cuánto aportaron los del benchmark — el ~3%/año que motivó todo esto. |

**El veredicto se lee total vs total.** Las otras dos existen para que la
asimetría sea **auditable**: con las cuatro a la vista, cualquiera puede medir
cuánto valían los dividendos de cada lado y comprobar que la corrección no
fabricó el resultado. Una diferencia que se asume no se puede revisar; una que
se reporta, sí.

Y de paso queda medido si el ~3%/año era de verdad ~3%: es una cifra que este
documento venía citando de oído, y con las cuatro series deja de hacer falta
creerla.

Las distribuciones vienen dentro de la respuesta de `/v2/emisoras`, así que no
cuestan un request extra: llegan con el censo, **para cada emisora**, y se
guardan en `bmv_distribuciones`.

#### La fecha ex: contestado, y con una aproximación que hay que contar

**[VERIFICADO sobre el crudo de NAFTRAC]** La llave de fecha que manda la API es
la de **PAGO**. La ex viene en un campo aparte, `fechaexcupon` — **y sólo en el
bloque `reciente`**:

```json
"reciente":  {"2026-08-31": {"pago": 0.01387504835, "tipo": "DISTRIBUCION DE EFECTIVO",
                             "divisa": "MXN", "fechaexcupon": "2026-08-28"}}
"historico": {"2025-12-31": {"pago": 0.56096644127, "tipo": "DISTRIBUCION DE EFECTIVO"}}
```

Nótese que **`pago` es el MONTO**, no una fecha, pese al nombre.

La regla queda así:

| Caso | Qué se hace |
|---|---|
| Viene `fechaexcupon` | Se usa **ésa**. El dato real gana siempre. |
| No viene (todo el histórico) | **ex = pago − 3 días naturales**, y la fila se marca `ex_aproximada`. |

**Los 3 días no son un número inventado:** es el delta observado en NAFTRAC
(pago 31-ago → ex 28-ago) y encaja con T+2 más un fin de semana.

**Y se cuenta.** `?job=emisoras`, `?job=reparse` y `?job=cobertura` reportan
`pct_ex_aproximada` — el **porcentaje**, no sólo el conteo, porque "12
aproximadas" no dice nada sin saber si son 12 de 15 o 12 de 4,000. Una
aproximación que no se cuenta se vuelve un dato a los dos días.

Como la aproximación se aplica **igual a la canasta y al benchmark**, el error
se cancela a primer orden en el exceso. Se espera que la enorme mayoría de las
filas del histórico salgan aproximadas; eso no es un problema mientras esté
**dicho y medido**.

#### El traslape entre `reciente` e `historico`

Los dos bloques **se traslapan**: NAFTRAC trae `2022-07-29` en ambos con el
mismo pago, y `2026-08-31` en ambos también. Concatenarlos y mandarlos al insert
reventó una corrida entera de `?job=reparse`:

```
ON CONFLICT DO UPDATE command cannot affect row a second time
```

Postgres se niega a tocar la misma fila dos veces en una sentencia, y **hace
bien**: no hay forma de que la base sepa cuál de las dos gana. Así que se decide
**antes** del insert, donde se puede mirar el grupo completo:

| Caso | Qué se hace |
|---|---|
| Mismo día, **mismo monto** | Una sola fila. Gana la que traiga `fechaexcupon` **real** — es justo lo que hace valioso al bloque `reciente`. |
| Mismo día, **montos distintos** | **Se suman** (dos repartos el mismo día son raros pero posibles) y la fila queda marcada `pago_consolidado`. |
| Mezcla efectivo / no-efectivo | Sólo se suma el efectivo; lo que no es dinero no entra al retorno total. |

**Nunca se elige uno en silencio**, porque eso pierde dinero sin dejar rastro. Y
el duplicado exacto **no se suma**: mismo monto en los dos bloques es la misma
distribución vista dos veces, y sumarla duplicaría el reparto.

El reporte dice **cuántas filas se colapsaron** y **cuántas se sumaron**. Hay,
además, una red de seguridad en `insertarDistribuciones` que deduplica por fecha
de pago justo antes del `INSERT`: la lógica de verdad vive arriba, pero ninguna
ruta futura debería poder volver a tumbar una corrida por esto.

#### Moneda extranjera: DECISIÓN CONGELADA para la v1

El censo real trae `{MXN: 134, EUR: 2, USD: 12}`. Los **14** repartos en moneda
extranjera tocan **10 series ICS** —GISSAA, PENOLES\*, HOTEL\*, ORBIA\*,
PINFRA\*, PINFRAL, VESTA\*, VITROA, ALFAA, ALPEKA— con **un solo reparto cada
una** en ~10 años, más BBVA, ANB, TS y FIBRAUP, que no son ICS.

> **Decisión congelada (16-sep-2026, antes de cualquier resultado): los 12
> repartos en USD y los 2 en EUR se EXCLUYEN del retorno total de la v1.** No se
> convierten con el tipo de cambio de hoy ni se asumen MXN.

**La razón es la dirección del error, no su tamaño.** Un reparto por serie en
una década es poco, y excluirlo **le quita retorno a la canasta** — o sea que
el error va **en contra** de encontrar alfa, que es el lado seguro y el mismo
en el que van los 65 días y el piso de 8. Convertirlos mal, en cambio, sería un
error de **dirección desconocida**: con el tipo de cambio de hoy estaríamos
mirando el futuro desde 2016, y tratándolos como pesos subestimaríamos el
reparto ~17×, que no es conservador, es simplemente incorrecto.

Mecánicamente: un reparto con divisa presente y distinta de MXN se marca
**`requiere_conversion`** y **no entra** al retorno total.

##### Y se reporta cuánto retorno quedó sin contar

Excluir en silencio convertiría una decisión defendible en un hueco invisible.
El reporte de Fase B da, **por serie y en total**, los **puntos base de retorno
no contados**:

```
bp no contados (serie) = Σ ( monto_excluido / precio_en_fecha_ex ) × 10,000
```

Se divide entre el precio de la **fecha ex** porque eso es lo que el reparto
habría valido como rendimiento ese día — el mismo instante en que se habría
reinvertido.

> **Umbral de revisión: 50 bp acumulados por serie.** Si alguna serie pasa de
> ahí, la exclusión deja de ser inmaterial y hay que resolverla con
> `/v2/divisas` en la fecha ex **antes de leer el veredicto**, no después. El
> umbral se fija aquí, sin números a la vista, para que no se pueda mover
> después de verlos.

Y la marca **se propaga dentro del grupo consolidado**: el bloque `historico` no
trae divisa, así que si sólo se mirara la fila que gana, un reparto en USD cuya
versión histórica viene sin divisa quedaría sin marcar y se reinvertiría como
pesos. Si cualquiera del grupo la necesita, el grupo la necesita.

**Lo que decide si esto se puede dejar así:** `?job=cobertura` y `?job=reparse`
listan **qué series** están afectadas y si son ICS.

- Si **ninguna es ICS**, ninguna entra al universo elegible y excluirlas no le
  quita nada al backtest.
- Si **alguna es ICS**, hay que resolverlo bien: tipo de cambio en la **fecha
  ex** (`/v2/divisas`), no una conversión a ojo.

#### `REEMBOLSO`: excluido por decisión, no por accidente

El censo trae **121 reembolsos de capital** (de 1,641 repartos: `{efectivo:
1520, reembolso: 121}`, sin ningún `desconocido`). Un reembolso **no es un dividendo**:
es la empresa devolviendo principal. Contarlo como rendimiento inflaría el
retorno total con dinero que no es ganancia.

Antes quedaba fuera **por casualidad** —el regex pedía "efectivo" y "REEMBOLSO"
no lo dice—, y eso no es una decisión, es un efecto colateral. Ahora hay una
clasificación explícita:

| categoría | qué es | ¿entra al retorno total v1? |
|---|---|---|
| `efectivo` | distribución de efectivo | **sí** |
| `reembolso` | devolución de principal | **no** |
| `especie` | acciones, derechos, splits | **no** |
| `desconocido` | un tipo que no reconocemos | **no**, y sale en el reporte |

**El orden de evaluación importa, y ahí había un bug latente:** `reembolso` se
evalúa **antes** que `efectivo`. Si algún día llega `"REEMBOLSO DE CAPITAL EN
EFECTIVO"`, el regex viejo lo habría contado como rendimiento. Hay test.

> **Decisión congelada:** los 121 reembolsos quedan **fuera del retorno total
> en el caso base**, y **disponibles como sensibilidad de atribución**.

La bandera `categoria` se guarda en la tabla, así que incluirlos es un `where`
de una línea. Como toda sensibilidad (§3.5): **es atribución, no promoción** —
si el caso base sale NO-GO y la versión con reembolsos sale bonita, el veredicto
sigue siendo NO-GO.

#### Los pagos de centésimas de centavo

NAFTRAC trae varios repartos de **1e-07 pesos**. Casi seguro son placeholders de
la fuente y no dinero, y reinvertir un placeholder mete ruido al retorno.

**No se filtran** — esa es una decisión de producto, no del parser. Se **cuentan
aparte**: `repartos_bajo_umbral` dice cuántos caen por debajo de 0.0001 pesos,
para decidirlo **antes** de la Fase B y no después de ver resultados.

#### Dos campos más que viajan, para no asumirlos

**`divisa`.** Se guarda tal cual, y el reporte lista las que no son MXN. Si
alguna emisora reparte en USD hay que convertir antes de reinvertir, y asumir
MXN en silencio sería exactamente la clase de bug que este proyecto lleva varias
rondas cazando. El histórico no trae divisa: esas filas quedan en `null`, **no
en "MXN"**.

**`tipo`.** El observado es `"DISTRIBUCION DE EFECTIVO"`, pero puede haber otros
—en especie, splits, reembolsos de capital— que **no son dinero que nadie
recibió**. Contarlos como efectivo sumaría retorno inexistente. Se guarda el
tipo, se marca `es_efectivo`, y lo que no dice "efectivo" queda en `false`:
subestimar es el lado barato de equivocarse, y el conteo por tipo lo deja a la
vista en vez de enterrarlo.

> Esto casi se nos va: la primera versión de `es_efectivo` aceptaba cualquier
> tipo que contuviera "dividendo", así que **"DIVIDENDO EN ACCIONES" contaba
> como efectivo**. Lo atrapó el test que se escribió para impedirlo.

> **Un hueco aquí no es un hueco cualquiera.** Una ICS sin reparto puede ser que
> de verdad no reparta, o que el dato no venga — y lo segundo la mide a precio
> contra un benchmark que sí trae distribuciones, o sea que **rompe la simetría
> justo donde no se ve**. Por eso `?job=emisoras` y `?job=cobertura` reportan
> cuántas ICS traen reparto y **listan por nombre las que no**.

**El benchmark no puede colarse a su propia canasta, y la razón es estructural.**
Es `tipo_valor_id` **1B**; el universo filtra por `= '1'`, igualdad exacta de
texto, y el censo guarda el tipo **sin coerción**: `'1B'` nunca empata con `'1'`.
No hace falta una excepción escrita a mano para excluirlo, y hay un test que se
cae si alguien cambia ese filtro por un `LIKE` o un `Number()`.

### 3.4 Los criterios de GO

1. **Muestra** — ≥ **30 rebalanceos**, y **universo elegible ≥ 16 en la mediana
   de los rebalanceos**. Si el universo elegible mediano queda por debajo de 16
   → **INCONCLUSO por universo insuficiente, y la Fase B no se corre.** No es
   NO-GO: NO-GO afirma que la estrategia no sirve, y sin universo no se afirma
   nada.

   > El piso de 8 no puede sacar nombres de donde no hay. Si en algún rebalanceo
   > el universo elegible fuera menor a 8, la canasta es el universo completo y
   > **ese rebalanceo se reporta aparte, con su fecha**. Con la puerta del
   > universo mediano ≥ 16 debería ser raro; si resulta frecuente, es una señal
   > sobre el dato, no un detalle de implementación.

4. **Etiqueta de régimen.** El reporte dice **en qué porcentaje de los
   rebalanceos mandó el piso** y en cuáles el quintil. Si el piso mandó en
   **más del 50%** de las fechas, el veredicto se etiqueta
   **«no probó un quintil»** — pase lo que pase, y aunque los umbrales 2 y 3 se
   cumplan con holgura.

   Esto no es un cuarto umbral: no puede convertir un GO en NO-GO ni al revés.
   Es una etiqueta sobre **qué se probó**, y existe porque un GO obtenido con un
   top 40% no autoriza a operar un quintil — son estrategias distintas con el
   mismo nombre.
2. **Señal** — **|t| ≥ 2** del exceso diario vs NAFTRAC, en **calendar-time**.
3. **Economía** — **Sharpe neto ≥ Sharpe de NAFTRAC + 0.15**.

**GO = 2 y 3.** **GO FRÁGIL si |t| < 2.5.**

> ### ⚠️ Advertencia de signo, obligatoria en el reporte
> **Un t significativo con exceso NEGATIVO no es GO: es un NO-GO fuerte.**
> Un |t| alto sólo dice que el exceso no es ruido — no dice de qué lado está.
> Esta advertencia existe porque en agosto el backtest gringo estuvo a un
> descuido de leerse al revés, y se queda aunque nunca vuelva a hacer falta.

### 3.5 Sensibilidades — para atribución, **no** para promoción

Decil · sólo value · sólo momentum · y una con **lag de 90 días**. Todas
comparten la **misma población elegible**.

El piso y techo de 8-15 son una regla de **construcción de cartera**, no un
criterio, así que aplican también a las variantes: si no, no serían comparables.
Eso tiene una consecuencia que conviene anticipar — el decil da `0.10 × E`
nombres, así que **con un universo elegible menor a 40, decil y quintil producen
exactamente la misma canasta de 8**. En ese caso la sensibilidad de decil no
dice nada, y se reporta como **vacía**, no como una diferencia de cero.

**Ninguna promueve un NO-GO a GO.** Sirven para entender de dónde viene (o no
viene) el resultado. Si la principal sale NO-GO y una sensibilidad sale
bonita, el veredicto sigue siendo NO-GO y la sensibilidad es una nota al pie.

---

## 4. Caveats, declarados antes de correr

### 4.1 El universo es chico, y el piso de 8 tiene un costo que hay que decir

La versión anterior de este documento partía el universo por la mediana, así que
la canasta era `0.10 × N` y hacían falta ~80 emisoras para llegar a 8 nombres.
El umbral absoluto más el piso cambian la aritmética, pero **no hacen
desaparecer el problema: lo mueven de sitio y lo vuelven visible**.

La canasta ahora es `clamp(0.20 × E, 8, 15)` sobre el universo elegible `E`:

| Universo elegible `E` | Canasta | Qué fracción del universo resulta |
|---:|---:|---|
| 16 | 8 | **50%** — manda el piso |
| 20 | 8 | 40% |
| 30 | 8 | 27% |
| **40** | **8** | **20% — aquí el quintil por fin es un quintil** |
| 60 | 12 | 20% |
| 75 | 15 | 20% |
| 100 | 15 | 15% — manda el techo |

**Entre 16 y 40 elegibles manda el piso, y la "canasta del quintil superior" es
en realidad un top 27-50%.** Eso no es un error: es el intercambio que el piso
compra a propósito — estabilidad estadística a cambio de selectividad.

Pero tiene una **dirección**, y vale decirla: menos selectividad **diluye** la
señal. Si hay alfa en el quintil verdadero, este diseño la **subestima**. O sea
que sesga **en contra** de un GO — el mismo lado que los 65 días. Consecuencia
práctica: **un GO bajo estas reglas es más creíble, y un NO-GO es más ambiguo.**

Por eso el reporte dice, en cada rebalanceo, **cuál de los tres regímenes estuvo
activo** (piso, quintil puro, techo) y **en qué porcentaje de las fechas mandó
cada uno**. Y por eso existe la etiqueta del §3.4 criterio 4: **si el piso mandó
en más del 50% de las fechas, el veredicto se etiqueta «no probó un quintil»**,
pase lo que pase con los umbrales.

Un backtest donde el piso mandó el 90% del tiempo no probó un quintil: probó un
top 40%. Son estrategias distintas con el mismo nombre, y un GO de una no
autoriza a operar la otra.

### El censo tiene que ser el mismo dos veces

Dos corridas sobre el **mismo crudo guardado** dieron 595 filas / 185 ICS y
597 / 183, con los tipos `(null)` pasando de 2 a 4. Nadie bajó datos nuevos:
`?job=reparse` re-deriva de lo que ya está en Neon.

**El no-determinismo era nuestro**, y la causa concreta vale anotarla:

```js
const pareceEnvoltorio = llaves.length <= 3 && …
```

`?job=emisoras` pasa **cientos** de llaves de golpe, así que el heurístico de
envoltorio nunca se disparaba. `?job=reparse` pasaba **una emisora a la vez**,
así que se disparaba en cuanto la pizarra no matchara el regex — y **Quálitas
cotiza como `Q`**, de un solo carácter. Esa fila salía como `*` en vez de `Q*`:
una emisora que se pierde y otra que aparece de la nada, sobre datos idénticos.

Dos arreglos, porque uno solo dejaría la trampa armada:

1. **La regla mira la forma, no el tamaño.** Es envoltorio sólo si el valor de
   una llave contiene, él mismo, dos o más llaves con pinta de pizarra. Eso da
   lo mismo se pase una emisora o quinientas.
2. **`?job=reparse` pasa el censo completo de una vez**, que es literalmente lo
   que hace `?job=emisoras`. Los dos caminos tienen que ser el **mismo** camino,
   no dos que casualmente coincidan.

Y para no volver a descubrirlo comparando dos corridas a ojo, `?job=reparse`
ahora reporta la **deriva**: qué `emisora_serie` aparecieron y cuáles
desaparecieron respecto de lo guardado. `deriva.estable: true` es la afirmación
que el censo tiene que poder hacer de sí mismo.

> Un censo que cambia solo no sirve para un universo point-in-time. El punto
> entero de `rango_financieros` es decir qué existía cuándo; si la respuesta
> depende de en qué orden se leyó el archivo, no dice nada.

### Lo que el censo resolvió

Esta sección se escribió suponiendo un universo del tamaño de las **30** ICS
curadas de Fase 1a, y con esas la canasta habría dado 3 nombres: INCONCLUSO sin
discusión. El censo real dice otra cosa:

| | |
|---|---:|
| Filas en el censo | 595 |
| Series ICS | 185 |
| **Emisoras ICS únicas** | **137** |
| ACTIVA / SUSPENDIDA | 109 / 76 |

**137 ICS es holgado.** Aunque el filtro de 5 millones se llevara la mitad, el
universo elegible rondaría 68 y el quintil daría ~14 nombres: **dentro del
rango 8-15, o sea un quintil de verdad**, con el piso sin mandar y la etiqueta
«no probó un quintil» sin dispararse. La preocupación del tamaño de canasta
queda **resuelta**.

Que 76 de las 185 series ICS estén **SUSPENDIDAS** es la otra mitad de la buena
noticia: son exactamente las emisoras que un universo "lista de hoy mirada
hacia atrás" habría perdido. Están, con su rango, y por eso el point-in-time es
real y no una promesa.

**Lo que sigue sin saberse es cuántas sobreviven al filtro de liquidez** — para
eso existe, y con 137 emisoras es esperable que se lleve una fracción grande.
La regla no se mueve:

> Con universo elegible mediano por debajo de 16, la Fase B **no se corre**.

Y el tripwire del §3.1 pasa a ser más importante, no menos: con cientos de
emisoras en el censo, muchas serán ilíquidas de verdad, así que **es esperable
que el filtro excluya una fracción grande**. Si excluye más de un tercio, se
recalibra antes de la Fase B — y con un universo así de grande, esa
recalibración es una decisión sobre **qué es operable en BMV**, no un ajuste
para que salgan los números.

### 4.2 Los financieros son de un tercero sin SLA

DataBursatil es un proyecto **sin fines de lucro** sostenido por colaboración
de usuarios. No hay SLA, no hay garantía de continuidad y no hay contrato. La
serie es reproducible mientras el servicio exista. Guardar el **crudo completo**
en Neon es parte de la respuesta a eso: si mañana desaparece, lo cosechado
sigue aquí.

Para lo cosechado tampoco hay validación contra cita como la de Fase 0b. Lo que
sí queda vivo es el **auditor**: `scripts/pdf-extract.mjs` puede contrastar una
muestra de 20-30 trimestres contra los PDFs originales por ~$0.60. Eso no está
hecho todavía, y hasta que lo esté, **la exactitud de los financieros es
confianza en un tercero, no una medición nuestra**.

### 4.3 La ventana 2016-2026 en México son regímenes muy distintos

Reforma energética, el peso de 2016-2017, la cancelación de Texcoco, el T-MEC,
la pandemia, el ciclo de tasas de Banxico, el nearshoring. Diez años de BMV no
son diez años de la misma economía, y una estrategia que funcione en el
promedio de eso puede no haber funcionado en ningún régimen en particular.

### 4.4 Lo que DataBursatil no trae y este backtest no usa

Del censo de Fase 1b (§2.2 y §2.3): **acciones en circulación** históricas y el
**desglose `ifrs_mx` de deuda con costo** son de la extensión mexicana, no de
`ifrs-full`. Sin acciones no hay capitalización, y por eso **este backtest usa
EPS/precio y no book-to-market ni un filtro de tamaño**. No es una preferencia
metodológica: es lo que los datos permiten, y conviene no leerlo como otra cosa.

---

## 5. Por qué esta corrección es pre-registro y no mover la portería

La simetría de retorno total se decidió **después** de que este documento ya
existía, así que merece justificarse en vez de aparecer sin más. Tres razones,
y una precisión que conviene hacer para no venderla mejor de lo que es.

**1. Se hizo antes de ver un solo número.** La Fase A no ha corrido. No hay
cobertura, no hay serie de precios, no hay un retorno calculado. No existe el
resultado contra el cual se podría haber sintonizado la regla — y esa es la
única garantía dura, porque las otras dos dependen de un juicio.

**2. Corrige una asimetría de MEDICIÓN, no un umbral.** Ésta es la distinción
que hace la diferencia. Bajar |t| de 2 a 1.7, o el margen de Sharpe de 0.15 a
0.05, sería mover la portería: cambia **qué tan bien hay que salir** para pasar.
Lo que se cambió aquí es **cómo se mide cada lado**, para que los dos se midan
igual. **Los umbrales de GO no se tocaron** — |t| ≥ 2 y Sharpe ≥ NAFTRAC + 0.15
siguen exactamente donde estaban.

Dicho de otro modo: la regla nueva se puede escribir sin mencionar el resultado
que produce. Una regla que sólo se justifica por el número que arroja es una
portería movida; una que se justifica por la definición de la medición, no.

**3. Es auditable por construcción.** Las cuatro series (§3.3) dejan ver cuánto
aportaron los dividendos de cada lado. Si la corrección hubiera fabricado el
resultado, se vería ahí.

### La precisión, para no venderla mejor de lo que es

El argumento de que **el efecto es de signo desconocido a priori** vale para el
paquete completo —volver total los dos lados desde un mundo donde los dos eran
precio— y ahí sí depende de algo que no sabemos: si el rendimiento por dividendo
de la canasta supera al de NAFTRAC. Como la canasta es **value** (EPS/precio
alto) y los nombres value suelen repartir más que el índice, es plausible que sí,
pero plausible no es sabido.

**Este cambio en particular, en cambio, sí tiene signo conocido: nos favorece.**
Sumarle dividendos a la canasta sube su retorno medido, y el benchmark ya los
traía desde el cambio anterior. Conviene decirlo con todas sus letras en vez de
apoyarse en el "signo desconocido", porque un cambio que favorece a quien lo
propone es justo el que merece más escrutinio — y aquí lo que lo sostiene no es
la ignorancia del signo, sino que **la regla se justifica sola**: dos series que
se comparan tienen que medirse igual, y eso era cierto antes de saber a quién
beneficiaba.

La prueba que este documento se aplica: **la asimetría la señalé cuando jugaba
en contra de la estrategia** (§5 de la versión anterior, con el benchmark ya en
total y la canasta en precio). Corregirla ahora que juega a favor es la misma
regla aplicada dos veces, no una excepción conveniente.

---

## 5.5 La cosecha corrió, y el crudo pagó su póliza

**4,174 financieros y 182 series de precios.** Y un bloqueante: la columna
"Con EPS" salía **0** en los 11 años y en las 116 emisoras.

**El alcance era mayor que el EPS: los 7 campos salieron `null` en las 4,174
filas.** El valor llega así:

```json
"basicearningslosspershare": ["utilidad (pérdida) básica por acción", 0.77]
```

Un **arreglo `[etiqueta, valor]`**, no un número suelto. `aNumero` devuelve
`null` para un arreglo, así que nada normalizó. El crudo, en cambio, estaba
completo y correcto en `raw jsonb` — que es exactamente para lo que se guardaba
desde el primer día.

> **Arreglarlo costó 0 créditos**: `?job=reparse-fin` re-normaliza desde lo
> guardado. Sin el crudo, esto habría costado otra cosecha completa.

### El `["etiqueta", valor]` era real, pero NO era la causa raíz

El re-parseo de las primeras 1,000 filas arregló **65**. `faltantes_por_campo`
dijo el resto: 993/1000 sin `assets`, `liabilities`, `equity` ni
`cashandcashequivalents`, y 992 sin `revenue`. O sea que **casi ninguna fila
tiene ningún campo** — y las 65 que sí, prueban que en la tabla conviven **dos
formas distintas de crudo**.

Arreglar el arreglo era necesario y no suficiente. Lo que seguía faltando no era
otra hipótesis mejor: era **mirar el dato**.

#### `?job=inspect` — cero créditos, cero interpretación

```
?job=inspect&emisora=WALMEX&periodo=2T_2017
```

Devuelve, **sin normalizar nada**:

| | |
|---|---|
| `formas_del_crudo` | Cuántas filas hay de cada combinación de llaves de primer nivel, con `con_eps` al lado. **El discriminador**: una sola forma ⇒ el problema es el parser; varias ⇒ la cosecha guardó cosas distintas. |
| `solicitada` | La fila pedida: tipo de la raíz, llaves de nivel 1 y 2, y `assets` / `revenue` / `basicearningslosspershare` con su **ruta, tipo y valor literales**. |
| `ejemplo_que_si_sirvio` | Lo mismo para una de las filas que **sí** normalizó, para compararlas lado a lado. |

Está escrito a propósito **sin usar `resolverCampo` ni `valorDeCampo`**: el punto
es ver qué hay, no qué entiende el parser. **Si el parser y el inspector no
coinciden, el desacuerdo es el hallazgo.**

Los tests lo fijan contra las cuatro hipótesis que tiene que poder separar:
envoltura extra (se ve en la ruta), un solo bloque pedido (el otro campo sale
`NO APARECE`), llaveado por fecha contra campo directo (se ve en `nivel_2`), y
dos formas conviviendo (se ve en `nivel_1`).

### El ledger lo dijo, y yo le puse un nombre que lo escondió

Las 4,174 filas quedaron en el estado que significa "ningún campo se pudo
normalizar". Ese estado se llamaba **`vacio`**.

`vacio` suena a *"la respuesta no traía nada"* — un hecho del mundo, benigno. Lo
que de verdad decía era *"no le entendí a la respuesta"* — un bug nuestro. El
reporte estaba gritando el problema con la voz equivocada.

Ahora se llama **`sin_campos`**. El nombre de un estado de error tiene que
doler, porque su único trabajo es que alguien lo mire.

> Para el otro `vacio`, el de `historicos`, el nombre sí es correcto: ahí
> significa que la serie no devolvió filas de precio, que es un hecho de la
> fuente y no una falla de lectura nuestra.

### Las dos series que fallan: VISTAC y GAVB

HTTP **400** en el rango completo, 6 y 10 intentos. Un 400 —y no un 404— apunta
a **parámetro mal formado** antes que a "no hay datos", pero **no lo sé**: el
cosechador guardaba `"HTTP 400"` sin el cuerpo, y el cuerpo es donde esta API
dice qué no le gustó (así se descubrió el formato `1T_2020`).

Dos arreglos:

1. **El cuerpo del error se guarda** en el ledger. La próxima corrida trae la
   respuesta y la pregunta se contesta con el dato, no con una hipótesis.
2. **Se dejan de reintentar a los 3 intentos.** Un 400 no se arregla
   martillando, y cada reintento gasta un crédito en el mismo error. Las claves
   agotadas siguen saliendo en el reporte (`agotadas`) para que no desaparezcan
   del radar sólo porque el cosechador dejó de pedirlas.

Para separar las dos hipótesis sin gastar la cosecha entera, una ventana corta
contra el rango completo:

```
?job=historicos&emisora=VISTAC&desde=2026-06-01&reintentar=1
```

Si con la ventana corta **sí** devuelve, el problema era el rango: la serie no
vivía en 2016. Si falla igual, el identificador `emisora_serie` está mal
construido para esas dos.

---

## 6. Estado

| Pieza | Estado |
|---|---|
| `api/_lib/databursatil.js` | Hecho. Cliente + parseo tolerante + distribuciones (todas las emisoras) + presupuesto. |
| `api/_lib/bmv-db.js` | Hecho. **7 tablas nuevas**, `xbrl_reports` intacta. |
| `api/bmv-harvest.js` | Hecho. 10 jobs (`reparse`, `reparse-fin` e `inspect` son de cero créditos), idempotente, con parada limpia. |
| `tests/bmv-harvest.test.mjs` | Hecho. **125 tests**, en verde. |
| `docs/sql/bmv-harvest.sql` | Hecho. Generado del schema real. |
| **El contrato de la API** | **VERIFICADO**: `periodo=1T_2020`, `emisora_serie=WALMEX*`, precios como `[precio, importe]`, benchmark `NAFTRACISHRS`. |
| **El censo** | **Cerrado.** `deriva.estable: true` — 0 aparecieron, 0 desaparecieron. **185 series ICS**, 165 con cobertura (las 20 sin ella son bancos y casas de bolsa, fuera de la v1 por decisión de Fase 0). 1,641 repartos: 1,520 efectivo, 121 reembolso, 0 desconocido. |
| **Fase A, diseño** | **Cerrado.** |
| **La cosecha** | **Corrida**: 4,174 financieros, 182 series de precios. |
| **Normalización** | **Abierta.** El `["etiqueta", valor]` era real pero no la causa raíz: 65 de 1,000. `?job=inspect` es el siguiente paso (§5.5). |
| **La cosecha** | **Sin correr** — este sandbox no alcanza la API. |
| **Cobertura real** | **Sin reportar** — depende de la cosecha. |
| `/api/bmv-rotation-analyze` | **Fase B. No empezado, a propósito.** |

El backtest **no se corre** hasta que la Fase A esté completa y la cobertura
real esté reportada.
