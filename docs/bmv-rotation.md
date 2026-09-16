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

Con las 30 ICS de Fase 1a eso daba **1,262 requests**. Pero el censo real trae
**cientos** de emisoras, así que el número de verdad sale de `?job=estimate`
corrido **después** de `?job=emisoras` — y por eso ese paso está en el orden de
ejecución dos veces.

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

> **¿La fecha del censo es la EX o la de PAGO?** [ABIERTO] Son días distintos,
> y el retorno total se arma con la **ex** — es cuando el precio cae. Si lo que
> el censo trae es la de pago, el crédito llega tarde y el retorno total queda
> ligeramente **subestimado**; como pasa en los dos lados, se cancela casi
> entero en el exceso, pero "casi" no es "sí". `?job=emisoras` reporta
> `dividendos_campos_vistos` con los nombres de campo que trajo el reparto,
> justamente para poder contestarlo mirando el dato en vez de suponerlo.

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

## 6. Estado

| Pieza | Estado |
|---|---|
| `api/_lib/databursatil.js` | Hecho. Cliente + parseo tolerante + distribuciones (todas las emisoras) + presupuesto. |
| `api/_lib/bmv-db.js` | Hecho. **7 tablas nuevas**, `xbrl_reports` intacta. |
| `api/bmv-harvest.js` | Hecho. 8 jobs (con `reparse`, de cero créditos), idempotente, con parada limpia. |
| `tests/bmv-harvest.test.mjs` | Hecho. **81 tests**, en verde. |
| `docs/sql/bmv-harvest.sql` | Hecho. Generado del schema real. |
| **El contrato de la API** | **VERIFICADO**: `periodo=1T_2020`, `emisora_serie=WALMEX*`, precios como `[precio, importe]`, benchmark `NAFTRACISHRS`. |
| **El censo** | **Corrido**: 595 filas, 185 series ICS, **137 emisoras ICS**. |
| **La cosecha** | **Sin correr** — este sandbox no alcanza la API. |
| **Cobertura real** | **Sin reportar** — depende de la cosecha. |
| `/api/bmv-rotation-analyze` | **Fase B. No empezado, a propósito.** |

El backtest **no se corre** hasta que la Fase A esté completa y la cobertura
real esté reportada.
