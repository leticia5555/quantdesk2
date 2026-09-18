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
>    (§3.1). *El valor quedó en 1,000,000 de pesos el 17-sep-2026, fijado por
>    operabilidad y todavía antes de cualquier resultado; ver §5.8.*
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
| **Fecha ex aproximada en ~88% de los repartos** | La API sólo trae `fechaexcupon` en el bloque `reciente`. El resto es pago − 3 días. **El número vivo lo da `?job=cobertura`**; éste es una copia y puede quedar atrás. |
| **Repartos en moneda extranjera** | `{USD: 12, EUR: 2}` sobre **todas** las series; el encabezado del reporte cuenta sólo las **ICS**, que son menos. **Excluidos** del retorno total de la v1, con los bp no contados por serie (§3.3). |
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
importe operado de los últimos 3 meses ≥ 1,000,000 de pesos**, calculada en
**cada** rebalanceo.

> **Umbral congelado el 17-sep-2026, antes de ver un solo retorno.** Se fija por
> su **propósito**: que una canasta de 8-15 nombres con capital personal entre y
> salga sin mover el precio. A 1 MM de importe mediano diario, una posición de
> ~$80,000 pesos es **menos del 10% del volumen del día**, que es el estándar
> razonable de participación.
>
> El valor anterior (5 MM) era intuición de mercado estadounidense trasplantada
> a BMV sin recalcular el tamaño de posición que la motiva. **No se eligió
> mirando cuál umbral daba mejores números de elegibles** — se eligió por el
> cálculo de arriba, que no depende de cuántas emisoras sobrevivan.

> ### ⚠️ Hubo una discrepancia, y se resolvió a favor de lo decidido
> **18-sep-2026.** La constante en el código decía `1_000_000` desde el
> principio, pero el reporte de `?job=elegibilidad&umbrales=…` imprimía
> «**El umbral congelado es 500,000**» — y debajo, la justificación de 1 MM.
> El argumento no correspondía al valor.
>
> **Causa:** el bloque comparativo tomaba `criterios` de `corridas[0]`, o sea
> de la **primera corrida de la lista**, que con
> `&umbrales=500000,1000000,2000000` es la de 500 mil. Nunca fue una decisión;
> fue un índice.
>
> **Por qué no era un detalle cosmético:** 500,000 es justo el umbral que da
> los mejores números de la tabla (quintil en 95.5% de las fechas contra
> 78.4%). Dejarlo habría sido **indistinguible de haber elegido mirando
> resultados**, que es exactamente lo que todo este documento existe para
> impedir. Un lector futuro no tiene forma de saber que fue un bug.
>
> **Resuelto a favor de lo decidido antes de ver la tabla: 1,000,000.** El
> umbral congelado ahora sale de la constante y nunca de una corrida, la fila
> vigente va marcada en la tabla, y hay un test que falla si el reporte vuelve
> a imprimir el primero de la lista como si fuera el congelado.

**Umbral absoluto, no mediana del universo.** El propósito es **excluir lo no
operable**, no partir el universo en dos. Un filtro por mediana tira siempre la
mitad: con un universo líquido descarta emisoras perfectamente negociables, y
con uno ilíquido deja pasar la mitad menos mala. El umbral absoluto contesta la
pregunta que importa —**¿se puede comprar esto?**— en vez de una relativa que
cambia de significado según con quién se compare.

Se reportan los elegibles, **las exclusiones por motivo** en cada rebalanceo, y
**cuántas caen por el filtro de liquidez en cada fecha**. Una exclusión sin
motivo es un universo que nadie puede auditar.

> ### ~~Tripwire de calibración~~ — RETIRADO el 17-sep-2026
> La regla decía: si el filtro excluye **más de un tercio del universo en
> promedio**, el umbral está mal calibrado y se baja antes de correr el
> backtest. **Se retiró por insatisfacible**, y se retiró sin ver un solo
> retorno. El detalle está en §5.8; el argumento, en tres líneas:
>
> Pasar el tripwire exigía ≥ 2/3 de elegibles, o sea **≥ 86** con el universo
> mediano observado (128). Pero el régimen `quintil` sólo existe **entre 40 y 75
> elegibles** —`0.20 × E` entre el piso de 8 y el techo de 15—, así que
> cualquier umbral que pasara el tripwire garantizaba régimen `techo`. **El
> tripwire y el régimen quintil pedían cosas incompatibles.**
>
> El error de fondo: el tripwire suponía que el universo de partida era **todo
> operable**, de modo que una exclusión alta sólo podía significar umbral mal
> calibrado. En BMV el universo de partida **no** es todo operable, así que una
> exclusión alta puede ser **la verdad sobre el mercado**.
>
> **No se sustituye por otro porcentaje.** El filtro se calibra por
> **operabilidad**, no por cuánto excluye. El % excluido se sigue reportando
> como **diagnóstico** en cada rebalanceo — es informativo — pero ya no es una
> puerta.

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

4. **Etiqueta de régimen** *(endurecida el 17-sep-2026)*. El reporte dice **qué
   régimen decidió el tamaño de la canasta** —`piso` / `quintil` / `techo`— y
   **en qué porcentaje de las fechas mandó cada uno**. Si el **piso** o el
   **techo** mandaron en **más del 50%** de las fechas, el veredicto se etiqueta
   **«no probó un quintil, probó top-N fijo»** — pase lo que pase, y aunque los
   umbrales 2 y 3 se cumplan con holgura.

   **Sigue siendo un experimento válido**, y se corre: midió algo real. Lo que
   la etiqueta impide es que se lea como otra cosa.

   > **El techo entró en la regla porque produce el mismo problema por el otro
   > lado.** La versión original sólo miraba el piso, y eso dejaba un hueco: con
   > muchos elegibles, `0.20 × E` se pasa de 15 y la canasta vuelve a ser un
   > top-N fijo. Salió a la luz al calcular qué exigía el tripwire —86 elegibles
   > ⇒ canasta 15 ⇒ régimen `techo`— y es el mismo hallazgo que lo retiró.

   Esto no es un cuarto umbral: no puede convertir un GO en NO-GO ni al revés.
   Es una etiqueta sobre **qué se probó**, y existe porque un GO obtenido con un
   top 40% no autoriza a operar un quintil — son estrategias distintas con el
   mismo nombre.

   > **La ventana del quintil es estrecha, y conviene tenerlo presente al leer
   > el resultado:** `quintil` sólo manda con **40 a 75 elegibles**. Por debajo
   > manda el piso; por encima, el techo.
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

**137 ICS es holgado.** Si el filtro se llevara la mitad, el universo elegible
rondaría 68 y el quintil daría ~14 nombres: **dentro del rango 8-15, o sea un
quintil de verdad**, con el piso sin mandar y la etiqueta «no probó un quintil»
sin dispararse. La preocupación del tamaño de canasta queda **resuelta**.

> **Lo que esta proyección no anticipó** (17-sep-2026): el filtro con 5 MM se
> llevó **69.2%**, no la mitad, y el elegible mediano fue **37**, no 68. La
> conclusión de arriba se sostiene —el universo alcanza— pero el margen era
> menor de lo supuesto, y la ventana donde el quintil manda de verdad resultó
> más estrecha de lo que sugiere este párrafo. Ver §5.8.

Que 76 de las 185 series ICS estén **SUSPENDIDAS** es la otra mitad de la buena
noticia: son exactamente las emisoras que un universo "lista de hoy mirada
hacia atrás" habría perdido. Están, con su rango, y por eso el point-in-time es
real y no una promesa.

**Lo que sigue sin saberse es cuántas sobreviven al filtro de liquidez** — para
eso existe, y con 137 emisoras es esperable que se lleve una fracción grande.
La regla no se mueve:

> Con universo elegible mediano por debajo de 16, la Fase B **no se corre**.

Con cientos de emisoras en el censo, muchas serán ilíquidas de verdad, así que
**es esperable que el filtro excluya una fracción grande**.

> **Aquí estaba el error que se corrigió el 17-sep-2026.** El párrafo original
> decía que si el filtro excluía más de un tercio se recalibraba el umbral
> (el tripwire del §3.1). Pero «el filtro excluye mucho» y «el umbral está mal
> calibrado» no son lo mismo cuando el universo de partida **no es todo
> operable** — y la frase de arriba, escrita antes de ver un número, ya
> anticipaba justamente eso. El tripwire se retiró por insatisfacible; el
> umbral se fija por **qué es operable en BMV**, que sigue siendo lo correcto.
> Ver §5.8.

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

##### Y salió a prod roto, por probar sólo las funciones puras

`?job=inspect` murió en su primera llamada con `parseClavePeriodo is not
defined`: la función existía en `databursatil.js` pero **no estaba importada**.
`node --check` pasó —valida sintaxis, no resolución de nombres— y los tests sólo
tocaban `describirCrudo` **aislado**, así que la línea que la llamaba nunca se
ejecutó.

Es el mismo caso de la colisión del parámetro `fila` en Fase 1a. La lección se
repite y conviene escribirla de una vez: **un módulo que no se EJECUTA no está
probado.**

La protección que quedó: cada job se llama **directamente** en un test, sin
`DATABASE_URL`, y se exige que la falla sea la de la base y **no** un
`ReferenceError`. Verificado al revés — con el bug puesto, el test se pone rojo
y `node --check` sigue pasando.

> **Lo que ese test NO cubre, dicho para que nadie lea de más:** el handler
> corre `ensureBmvSchema()` antes del despacho, así que sin base muere ahí y
> nunca entra al cuerpo del job. Se comprobó: con el bug puesto, el test del
> handler **pasaba**. La protección real son los tests que llaman a cada job
> directamente.

Intenté además un lint general de nombres no definidos sobre los tres módulos.
**No se mandó:** produjo 12 falsos positivos (cadenas, métodos abreviados), y un
chequeo con ese ruido es uno que la gente aprende a ignorar — peor que no
tenerlo.

##### Un hallazgo de paso: el auth iba después de la base

Al escribir el test de que un job protegido sin secret devuelve 401, salió que
devolvía **500**: `ensureBmvSchema()` corría **antes** del chequeo de
autorización, así que una petición sin credenciales abría conexión a Neon y
disparaba las migraciones antes de recibir su 401.

Las DDL son idempotentes y el daño era acotado, pero el orden contradecía el
fail-closed que este endpoint dice tener: **no se hace trabajo para quien
todavía no demostró que puede pedirlo.** Ahora el auth va primero.

### La causa raíz: DOS periodos por respuesta

El inspector cerró el caso: **una sola forma de crudo** en las 4,174 filas, y el
dato completo — WALMEX 2T_2017 con `revenue` 135,723,675,000 y EPS 0.77
guardados correctamente.

Lo que pasa es que **cada respuesta trae dos periodos**: el solicitado y el
comparativo del año anterior.

```
posicion:            { "2017-06-30", "2016-12-31" }
resultado_trimestre: { "2017-04-01_2017-06-30", "2016-04-01_2016-06-30" }
```

`resolverCampo` veía dos valores bajo el mismo nombre, los declaraba **AMBIGUO**
y fallaba cerrado. **Como default está bien** —dos valores distintos bajo el
mismo nombre sí son ambiguos— pero aquí no hay ambigüedad que resolver: hay que
**seleccionar por fecha**.

#### La regla, congelada

| bloque | forma de la llave | criterio |
|---|---|---|
| `posicion` | `AAAA-MM-DD` | la fecha **es** el cierre del trimestre |
| `resultado_trimestre` | `inicio_fin` | el **fin** es ese mismo cierre |

Y la parte que no es opcional:

> **Si ninguna llave corresponde al periodo solicitado, eso SÍ es un fallo:**
> `null` con motivo `sin periodo correspondiente`. Tomar "la única que hay" es
> exactamente cómo se cuela el dato del año pasado en la serie.

La selección queda **auditable**: se guarda en `bloques` qué llave se usó por
bloque, en vez de pedir fe en que el parser eligió bien.

#### Los 65 que "sí funcionaron" eran falsos positivos

ACCELSA guardó EPS 0.39 porque **los dos periodos traían 0.39 por
coincidencia**: `resolverCampo` los vio idénticos, no marcó ambigüedad y guardó
el valor. Quedaba bien por casualidad — y en otra emisora el mismo mecanismo
pudo haber guardado un número sin que nadie supiera de qué periodo venía.

**Son peores que las 4,109 que fallaron**, porque las fallas se reportaron y
éstas no.

`?job=reparse-fin` los sobreescribe, y se puede afirmar mirando el código:
`financierosCrudos` **no filtra por nulos** —lee todas las filas— y
`actualizarFinancieros` asigna con `=`, no con `coalesce`. Re-parsear tiene que
poder **corregir**, no sólo rellenar huecos.

#### El comparativo se guarda, con sus fechas

Columna `comparativo`, para momentum de fundamentales más adelante. Con una
advertencia que evita leerlo mal: en `resultado_trimestre` el comparativo es el
**mismo trimestre del año pasado**, pero en `posicion` es el **cierre fiscal
anterior** (31-dic), no junio del año pasado. Por eso viaja con sus propias
fechas en vez de llamarse "hace un año".

### El paginado en bucle: memoria de lambda para un estado que sobrevive

La primera tanda de `?job=reparse-fin` salió perfecta —1,000 filas, 1,000
arregladas, EPS y comparativo al 100%— y las **~55 siguientes devolvieron
exactamente lo mismo**, con `continuar_desde` clavado en CHDRAUI 2020-4.

La causa cabe en una línea:

```js
let cursor = null;   // se reinicia en CADA invocación
```

Cada llamada al endpoint es una lambda nueva y la memoria se va con ella. El job
**devolvía** `continuar_desde` y esperaba que quien llamara lo reenviara — y eso
no es un contrato, es una suposición. Nadie lo reenviaba, y el job no tenía cómo
enterarse.

**Ahora el avance vive en `bmv_meta`.** Cada llamada continúa donde quedó la
anterior sin que nadie pase nada. `&reiniciar=1` fuerza empezar de cero.

#### Y un segundo bug, más silencioso que el bucle

```js
if (filas.length < 200) { … }      // contra la CONSTANTE
```

Se comparaba contra el tamaño de página fijo, no contra lo **pedido**. Con
`&max=150` se piden 150, llegan 150, y `150 < 200` se leía como *"ya no quedan
filas"*: **`hay_mas: false` con filas pendientes**.

Ese es peor que el bucle. El bucle se ve —55 llamadas idénticas son difíciles de
ignorar— y éste habría dejado la mitad de la tabla sin re-parsear mientras el
job reportaba éxito.

#### Lo que descarté, para que no siga bajo sospecha

La comparación de tupla `(emisora, anio, trimestre) > ($2, $3, $4)` **sí** es
lexicográfica en Postgres, y el `ORDER BY` **sí** coincide con el cursor. Las
dos estaban bien.

#### El test corre la función de verdad

Tres llamadas seguidas sobre una tabla falsa de 7 filas con páginas de 3, y se
exige que la unión cubra **todas** sin repetir ninguna, que `hay_mas` sea `false`
sólo al final, y que el cursor sobreviva **sin que el test reenvíe nada**.

Las dependencias se inyectan para que el test recorra `jobReparseFinancieros`
—la de verdad— y no una reimplementación del paginado, que podría pasar mientras
la real falla. Verificado al revés: con el bucle reintroducido caen 4 tests; con
el `< 200`, cae el de la página corta.

El output trae ahora **`avance: "3/7"`** acumulado entre llamadas, que es
justamente lo que habría delatado el bucle a la segunda corrida en vez de a la
cincuenta y cinco.

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

## 5.6 Fase A cerrada

| | |
|---|---|
| Financieros | **4,174 filas**, "Con EPS" = 4,174 en los 11 años y las 116 emisoras |
| Ledger | `financieros: hecho` |
| Precios | **569,589 filas** con importe operado |
| Benchmark | **4,207 días**, 62 distribuciones |
| Censo | `deriva.estable: true` |

### Lo que queda anotado y no resuelto

**VISTAC y GAVB** siguen en 400, y **el cuerpo del error todavía no está
guardado**: esas filas llegaron a `MAX_INTENTOS` **antes** del cambio que lo
captura, así que su `error_msg` es el viejo (`400: HTTP 400`, sin cuerpo) y
ahora el cosechador las salta. Para obtenerlo hace falta un reintento explícito,
2 créditos:

```
?job=historicos&emisora=VISTAC&desde=2026-06-01&reintentar=1
?job=historicos&emisora=GAVB&desde=2026-06-01&reintentar=1
```

La ventana corta separa las dos hipótesis de una vez: si con ella **sí**
devuelve, el problema era el rango (la serie no vivía en 2016); si falla igual,
el `emisora_serie` está mal construido. Y en cualquier caso el cuerpo queda en
el ledger, visible en `?job=cobertura`.

**Los dos números del encabezado** cuentan poblaciones distintas, y eso
explicaba la confusión: `requieren_conversion` viene de una consulta unida a
`tipo_valor_id = '1'` —**sólo ICS**— mientras que `dividendos_por_divisa` cuenta
**todas** las series. Ahora el encabezado lo dice con todas sus letras en vez de
dejar dos cifras que parecen contradecirse.

---

## 5.7 La última puerta antes de la Fase B: `?job=elegibilidad`

SELECT-only, **cero créditos, cero retornos**. Simula los rebalanceos mensuales
de 2017-07 a 2026-09 y reporta, por fecha:

| Columna | Qué es |
|---|---|
| `con_algun_financiero` | emisoras con **al menos un** cierre + 65 días ≤ fecha |
| `con_ttm` | con los **cuatro** trimestres disponibles — es el que manda |
| `universo` | con TTM **y** precio en la ventana |
| `elegibles` | los que pasan la mediana de importe de 3 meses ≥ 5 M |
| `canasta` / `regimen` | `clamp(0.20 × E, 8, 15)` y quién lo decidió |

**Se reportan dos universos a propósito.** El encargo pedía "financieros
disponibles (cierre + 65 días ≤ fecha)", que es tener **al menos uno**. Pero el
value es EPS **TTM** y el TTM necesita **cuatro** trimestres: contar con uno
solo sobreestimaría el universo que el backtest puede usar de verdad. Van los
dos, y el que decide la canasta es el de TTM.

Al final, las **tres puertas** que se pueden juzgar sin correr nada *(eran
cuatro hasta el 17-sep-2026; el tripwire se retiró, §5.8)*:

| Puerta | Si no pasa |
|---|---|
| Rebalanceos ≥ 30 | INCONCLUSO por muestra |
| **Universo elegible mediano ≥ 16** | **INCONCLUSO — la Fase B no se corre** |
| El piso **o el techo** mandan en ≤ 50% de las fechas | el veredicto se etiqueta «no probó un quintil, probó top-N fijo» |

Que nada de esto mire un retorno es lo que permitió **corregir los criterios del
universo sin contaminarse**: todavía no hay resultados que mirar.

La fecha de rebalanceo es el **primer día con precio** de cada mes, tomado de
`bmv_precios` — el calendario real de la BMV, con sus puentes y asuetos, en vez
de un "primer día hábil" calculado aparte que agregaría una fuente de error
donde ya hay un dato.

---

## 5.8 El tripwire se retiró por insatisfacible

Primera corrida de `?job=elegibilidad` con el umbral de 5 MM:

| | Resultado | Límite acordado |
|---|---:|---:|
| Rebalanceos | 111 | ≥ 30 ✅ |
| Universo mediano (TTM + precio) | 128 | ≥ 16 ✅ |
| Elegibles mediano | 37 | |
| **Excluido por liquidez** | **69.2%** | ≤ 33% ❌ |
| **Fechas donde manda el piso** | **76.6%** | ≤ 50% ❌ |

Leído sin haber visto **un solo retorno**, que es la condición que hace legítimo
tocar los criterios en este punto.

### La aritmética que mostró que la regla era imposible

Con universo mediano de **128**:

| Puerta | Exige |
|---|---:|
| Que **mande el quintil** (y no el piso) | **≥ 40** elegibles (`8 / 0.20`) |
| Que **no se pase del techo** | **≤ 75** elegibles (`15 / 0.20`) |
| **Pasar el tripwire** (≤33% excluido) | **≥ 86** elegibles (2/3 de 128) |

El régimen `quintil` sólo existe **entre 40 y 75 elegibles**. El tripwire exigía
**86**, que está del otro lado del techo. O sea: **cualquier umbral que pasara
el tripwire garantizaba régimen `techo`**, y el reporte habría dicho a la vez
«el filtro está bien calibrado» y «no probó un quintil». Las dos reglas pedían
cosas incompatibles.

**Una regla insatisfacible no es una regla.** Se retira, con fecha.

### Por qué estaba mal desde el principio

El tripwire suponía que el universo de partida era **todo operable**, de modo
que una exclusión alta sólo podía significar **umbral mal calibrado**. En BMV
el universo de partida **no** es todo operable: buena parte de las 185 series
ICS genuinamente no opera. Ahí una exclusión alta puede ser **la verdad sobre el
mercado**.

Calibrar por «cuánto excluye» habría sido ajustar el filtro **a la métrica** en
vez de a la operabilidad, que invierte el propósito que le dimos. Dicho de otro
modo: que a 500 mil pesos diarios el filtro siguiera excluyendo dos tercios no
sería un obstáculo que rodear — sería **un hallazgo sobre la BMV**.

**No se sustituye por otro porcentaje.** El % excluido queda como diagnóstico.

### El umbral, fijado por su propósito

**1,000,000 de pesos**, congelado el **17-sep-2026**, antes de ver un retorno.

No se eligió mirando cuál valor daba mejores números de elegibles. Se eligió por
el cálculo que motiva el filtro: a 1 MM de importe mediano diario, una posición
de **~$80,000 pesos** es **menos del 10% del volumen del día** — el estándar
razonable de participación para entrar y salir sin mover el precio. Ese cálculo
no depende de cuántas emisoras sobrevivan, que es exactamente lo que lo hace
inmune a la tentación de ajustarlo a un resultado.

`?job=elegibilidad&umbrales=500000,1000000,2000000` sigue produciendo la tabla
comparativa en una sola llamada —la parte cara, las medianas de 3 meses sobre
569,589 filas, se calcula una vez y se reutiliza—, pero ahora es **documentación
de qué habría pasado con cada valor**, no un menú para elegir. La elección ya
está tomada, y por una razón que no está en la tabla.

### La puerta del régimen se queda, y se endurece

Se le agregó el **techo**, que es el mismo problema por el otro lado y que sólo
se hizo visible con la aritmética de arriba. El reporte dice ahora qué régimen
mandó —`piso` / `quintil` / `techo`— y en qué porcentaje de las fechas. Si el
piso o el techo mandan en más del 50%, el veredicto se etiqueta **«no probó un
quintil, probó top-N fijo»**.

**No bloquea la Fase B.** El experimento es válido y se corre; lo que la
etiqueta impide es que se lea como otra cosa.

### Lo que esto implica para la Fase B

Las dos puertas bloqueantes ya se pueden dar por pasadas **sin correr nada más**:

- **Rebalanceos = 111 ≥ 30.** No depende del umbral: son las fechas del
  calendario real de la BMV.
- **Elegibles mediano ≥ 16.** Con 5 MM ya eran **37**. Bajar el umbral a 1 MM
  sólo puede **agregar** nombres —el conjunto elegible a 1 MM contiene al de 5
  MM—, así que la mediana a 1 MM es **≥ 37**. No hace falta correr el job para
  saber que pasa; es una propiedad del filtro, no una medición.

Lo que sí queda abierto es **el régimen**: a 37 elegibles manda el piso, y la
ventana del quintil (40-75) está cerca por abajo. Con 1 MM los elegibles suben,
pero hacia dónde —quintil o techo— sólo lo dice la corrida.

### VISTAC y GAVB: resueltas como exclusiones

Con ventana corta (2026-06-01) **también** dan HTTP 400, así que **no era el
rango**: el identificador `VISTAC` sencillamente no es válido para
`/v2/historicos`. `GAVB` presenta el mismo patrón.

Quedan **excluidas del universo**, contadas y con nombre, y **no se
reintentan**. Son 2 de 185 — **1.1%**, sin efecto material. Una serie sin
precios no puede rankearse ni operarse: su lugar correcto es fuera, dicho, no
fallando en silencio cada corrida.

Se excluyen **antes** de contar: dejarlas dentro ensuciaría todos los conteos
—universo, elegibles, % excluido— con nombres que nunca podrían entrar.

---

---

## 5.9 Fase B autorizada, y construida

**18-sep-2026.** Con el umbral en 1,000,000 las cuatro puertas previas pasan,
todas leídas **sin tocar un retorno**:

| Puerta | Valor | Límite |
|---|---:|---:|
| Rebalanceos | 111 | ≥ 30 ✅ |
| Elegibles mediano | 44 | ≥ 16 ✅ |
| Fechas donde manda el piso | 21.6% | ≤ 50% ✅ |
| Fechas donde manda el techo | 0% | ≤ 50% ✅ |
| Fechas donde manda el **quintil** | **78.4%** | — |

Con 44 elegibles el quintil da 8.8, apenas dentro de la ventana 40-75 que
§5.8 identificó. O sea que **esta corrida sí prueba un quintil** en la gran
mayoría de las fechas, que era justo lo que el diseño quería y lo que el
tripwire, de haberse quedado, habría hecho imposible.

### `/api/bmv-rotation-analyze`

SELECT-only, `ADMIN_SECRET`, `?format=md`, **0 créditos**. No llama a
`ensureBmvSchema()` —eso hace `CREATE TABLE` y `ALTER`— ni toca el ledger ni el
presupuesto. `tests/bmv-rotation.test.mjs` captura toda consulta que cruce la
frontera y falla si alguna no empieza con `SELECT` o `WITH`.

Los criterios **no se definen en el endpoint**: viven en
`_lib/bmv-rotation.js` y `_lib/bmv-elegibilidad.js` como constantes que copian,
número por número, lo congelado en §3. El endpoint trae filas y las pasa por
esas funciones; no tiene un solo umbral propio.

#### Por qué no se traen 569,589 filas

El ranking sólo necesita el **cierre del día anterior** al rebalanceo y **dos
anclas de momentum**. Los tres caben en los **cierres mensuales** (~22,000
filas): para un rebalanceo en el primer día operado del mes M, el cierre del
día anterior **es** el último cierre de M−1. Los precios diarios se piden sólo
para los nombres que la canasta llegó a tener y sólo durante los días que los
tuvo, con los intervalos de una misma serie **fusionados** — un nombre que
sobrevive doce rebalanceos vale un intervalo, no doce.

#### El bug del ancla, que se delató solo

La primera versión derivaba el precio del ranking como «fecha − 1 día». El 1 de
julio de 2017 cayó en **sábado**, así que el primer día operado fue el lunes 3;
«fecha − 1 día» daba el 2 de julio, que **sigue siendo julio**, y en julio el
único cierre mensual es el del 31 — un precio del **futuro**.

El guardia de «el precio del ranking tiene que ser anterior al rebalanceo» lo
atrapó: el nombre quedaba fuera y el universo salía **vacío**. Es la forma
barata de equivocarse —un error que hace ruido en vez de callarse— pero error
al fin. Ahora el ancla se toma por **índice de mes** (`mes(fecha) − 1`), que es
lo que el dato de verdad significa, y el guardia se quedó: si algún día los
rebalanceos dejan de ser el primer día del mes, esto falla cerrado.

Hay dos tests: uno sobre julio de 2017 en particular, y otro que recorre
**todos** los rebalanceos exigiendo que ningún precio de ranking sea del mismo
día ni posterior.

#### Lo que el reporte pone ARRIBA

Los cuatro caveats van en el encabezado, no enterrados: **pct_ex_aproximada**,
el **régimen que mandó**, los **puntos base no contados** por los repartos en
moneda extranjera (con su umbral de revisión de 50 bp por serie), y **GAVB y
VISTAC** excluidas. Son lo que cambia cómo se lee todo lo demás.

#### La advertencia de signo, con test

Un `|t|` alto sólo dice que el exceso no es ruido — **no dice de qué lado
está**. El veredicto evalúa el signo **antes** de decidir, y hay una prueba que
construye un mercado donde la canasta pierde de forma significativa y exige que
el dictamen sea **NO-GO FUERTE**. Si algún día alguien reordena las ramas del
`if`, truena.

## 6. Estado

| Pieza | Estado |
|---|---|
| `api/_lib/databursatil.js` | Hecho. Cliente + parseo tolerante + distribuciones (todas las emisoras) + presupuesto. |
| `api/_lib/bmv-db.js` | Hecho. **7 tablas nuevas**, `xbrl_reports` intacta. |
| `api/bmv-harvest.js` | Hecho. 10 jobs (`reparse`, `reparse-fin` e `inspect` son de cero créditos), idempotente, con parada limpia. |
| `tests/bmv-harvest.test.mjs` | Hecho. **176 tests**, en verde. |
| `api/_lib/bmv-rotation.js` | Hecho. Lógica pura de la Fase B: TTM, momentum, ranks, canastas, simulación, veredicto. |
| `api/bmv-rotation-analyze.js` | Hecho. SELECT-only, `ADMIN_SECRET`, `?format=md`, 0 créditos. |
| `tests/bmv-rotation.test.mjs` | Hecho. **43 tests**, en verde. |
| `docs/sql/bmv-harvest.sql` | Hecho. Generado del schema real. |
| **El contrato de la API** | **VERIFICADO**: `periodo=1T_2020`, `emisora_serie=WALMEX*`, precios como `[precio, importe]`, benchmark `NAFTRACISHRS`. |
| **El censo** | **Cerrado.** `deriva.estable: true` — 0 aparecieron, 0 desaparecieron. **185 series ICS**, 165 con cobertura (las 20 sin ella son bancos y casas de bolsa, fuera de la v1 por decisión de Fase 0). 1,641 repartos: 1,520 efectivo, 121 reembolso, 0 desconocido. |
| **Fase A, diseño** | **Cerrado.** |
| **La cosecha** | **Corrida**: 4,174 financieros, 182 series de precios. |
| **Normalización** | Arreglada y **verificada en prod**: 4,174/4,174 con EPS (§5.5). |
| **Elegibilidad** | **Corrida.** Con 1 MM: 111 rebalanceos, elegibles mediano 44, piso 21.6%, techo 0%, **quintil 78.4%**. Las cuatro puertas pasan (§5.9). |
| **Fase B** | **Construida, sin correr.** `/api/bmv-rotation-analyze` (§5.9). |
| **Umbral de liquidez** | **Congelado en 1,000,000** (17-sep-2026), por operabilidad (§3.1, §5.8). |
| **La cosecha** | **Completa.** 4,174 financieros, 569,589 filas de precio, 182 series. |
| **Cobertura real** | **Reportada.** EPS en 4,174/4,174 filas; benchmark 4,207 días con 62 distribuciones. |
| `/api/bmv-rotation-analyze` | **Construido y probado, sin correr** — este sandbox no alcanza Neon. |

El backtest se corre **desde prod**. Nada de lo que produzca puede mover un
criterio: todos están congelados arriba, con fecha, y el diff contra este
documento es la verificación.
