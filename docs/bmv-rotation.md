# Backtest: rotación Value + Momentum sobre la BMV

> **Estado: Fase A construida, sin correr.** El cosechador existe y está
> probado; los datos todavía no. Los criterios de GO/NO-GO de la Fase B están
> **congelados en este documento antes de ver un solo número** — que es el único
> momento en que congelarlos significa algo.

> ### Corrección del 16-sep-2026, antes de cualquier resultado
> Tres cambios al diseño, los tres pedidos cuando la Fase A **todavía no había
> corrido** y no existía ni un número del backtest:
>
> 1. El filtro de liquidez pasa de **mediana del universo** a **umbral absoluto**
>    de 5 millones de pesos (§3.1).
> 2. La canasta gana **piso de 8 y techo de 15** nombres, y la puerta de
>    INCONCLUSO se muda al **universo elegible** (§3.3, §3.4).
> 3. El benchmark queda **NAFTRAC ISHRS** y es de **retorno total**, no de
>    precio (§3.3).
>
> La fecha y el orden se anotan a propósito. Un criterio que se mueve **después**
> de los números deja de ser un criterio, y la única prueba de que éstos no se
> movieron así es que los números todavía no existen.

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
| `bmv_precios` | Cierre diario e importe operado. |
| `bmv_distribuciones` | Repartos del benchmark por fecha **ex-cupón**. Llegan con el censo: no cuestan un request. |
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

El volumen, con las 30 ICS de Fase 1a y la cobertura declarada 2T2016→2T2026
(41 trimestres) como **peor caso razonable**:

| Concepto | Requests | Datos |
|---|---:|---:|
| Censo de emisoras | 1 | — |
| Financieros (30 × 41) | 1,230 | ~73,800 campos |
| Históricos (rango completo, 1 por emisora **+ el benchmark**) | 31 | ~83,638 días |
| **Total** | **1,262** | |

**No sé cómo cobra DataBursatil**, así que el reporte da **tres modelos** — y la
diferencia entre ellos no es cosmética, decide si la cosecha cabe en un mes:

| Modelo | Costo | ¿Cabe en 200,000? |
|---|---:|---|
| **A** · por request | 1,262 | **Sí**, con muchísimo margen (0.6%) |
| **B** · por dato devuelto | 157,438 | **Sí**, con 21% de margen |
| **C** · por campo × día (cierre **e** importe) | 241,076 | **NO** |

**El hallazgo que vale la pena decir en voz alta: bajo el modelo C la cosecha
no cabe en un mes.** Y si se pidieran los precios desde 2010 —el rango completo
que la API ofrece— el modelo B sube a **204,310**: se pasa por **4,310
créditos**. Por eso el piso de precios por defecto es 2016-01-01 y no 2010, y
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
?job=probe                       # ≤18 requests: descubre el contrato
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

#### El benchmark es de retorno total, y eso no es un detalle

NAFTRAC reparte. Compararse contra su **precio pelón** le resta ~3% anual al
benchmark — o sea que nos **regala** un exceso de ~3%/año que nunca existió. Con
un umbral económico de Sharpe + 0.15, un regalo de ese tamaño no es ruido: es
suficiente para **fabricar un GO**.

Así que el benchmark es **precio + distribuciones reinvertidas en la fecha
ex-cupón**. La fecha **ex**, no la de pago: reinvertir en la de pago adelantaría
el flujo y metería look-ahead por la puerta de atrás — justo lo que los 65 días
cierran del otro lado.

**Se reportan las dos series**, precio y retorno total, para que la diferencia
quede **medida y no asumida**.

Las distribuciones vienen dentro de la respuesta de `/v2/emisoras`, así que no
cuestan un request extra: llegan con el censo y se guardan en
`bmv_distribuciones`.

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

Por eso el reporte debe decir, en cada rebalanceo, **cuál de los tres regímenes
estuvo activo** (piso, quintil puro, techo). Un backtest donde el piso mandó en
el 90% de las fechas **no probó un quintil: probó un top 40%**, y merece leerse
así.

Y sigue siendo cierto lo que ya decía esta sección: el número de ICS que
devuelva `?job=emisoras` es **lo primero que hay que mirar**, porque con un
universo elegible mediano por debajo de 16 la Fase B **no se corre**.

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

## 5. Lo que falta preguntar

NAFTRAC quedó **confirmado** (§3.3), así que la pregunta abierta es otra — y es
consecuencia directa de haberlo puesto en retorno total.

### ¿La estrategia también debe ser de retorno total?

Tal como quedan congelados los criterios, el **benchmark** incluye
distribuciones y la **canasta no**: se compara precio contra retorno total.

Eso corrige el sesgo señalado —dejar de regalarnos ~3%/año— pero **abre el
simétrico**: ahora el arrastre de los dividendos de las emisoras juega en contra
nuestra, y ese arrastre es **más grande que el margen económico entero**
(Sharpe + 0.15). No es "conservador": es potencialmente **decisivo**, y podría
convertir un GO real en NO-GO.

Lo correcto metodológicamente es que **los dos lados sean retorno total**.
DataBursatil trae dividendos (censo de Fase 1b §1), así que es cosechable con el
mismo mecanismo que ya existe para las distribuciones del benchmark.

**Mi recomendación es hacerlo así.** No lo cambié por mi cuenta porque mover un
criterio congelado es exactamente lo que este documento existe para impedir,
aunque el cambio parezca obviamente bueno — y porque la simetría se puede añadir
igual de limpio antes de correr la Fase B.

Mientras no se decida, el backtest queda **como está congelado**: canasta a
precio contra benchmark de retorno total, **con esa asimetría escrita en el
reporte** y la nota de que sesga en contra de la estrategia.

---

## 6. Estado

| Pieza | Estado |
|---|---|
| `api/_lib/databursatil.js` | Hecho. Cliente + parseo tolerante + distribuciones + presupuesto. |
| `api/_lib/bmv-db.js` | Hecho. **7 tablas nuevas**, `xbrl_reports` intacta. |
| `api/bmv-harvest.js` | Hecho. 7 jobs, idempotente, con parada limpia. |
| `tests/bmv-harvest.test.mjs` | Hecho. **57 tests**, en verde. |
| `docs/sql/bmv-harvest.sql` | Hecho. Generado del schema real. |
| **La cosecha** | **Sin correr** — este sandbox no alcanza la API. |
| **Cobertura real** | **Sin reportar** — depende de la cosecha. |
| `/api/bmv-rotation-analyze` | **Fase B. No empezado, a propósito.** |

El backtest **no se corre** hasta que la Fase A esté completa y la cobertura
real esté reportada.
