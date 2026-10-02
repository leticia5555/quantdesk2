# reaccion — ¿qué parte de un reporte explica el movimiento de la acción?

**PRE-REGISTRO.** Todo lo que sigue se escribió y se congeló en código ANTES de
correr una sola consulta. Los umbrales viven en `CRITERIOS_REACCION`
(`api/_lib/reaccion.js`) y están pineados por test: mover una portería rompe un
test y se ve en el diff.

---

## La pregunta

> Dado un reporte de resultados, ¿cuál de estas señales explica mejor el
> movimiento cierre(T-1) → apertura(T+1)?
>
> - **A)** sorpresa de EPS (reportado vs estimado) — ya está en `pead_earnings`
> - **B)** sorpresa de INGRESOS (reportado vs estimado) — hay que conseguirla
> - **C)** GUÍA de la empresa (rango prometido vs consenso del trimestre
>   siguiente) — hay que conseguirla

**El caso que lo motiva:** Nike, 2026-10-01. Superó EPS +9%, falló ingresos −1%,
dio guía floja, y la acción cayó 5%. Tres resultados distintos del mismo
reporte. ¿Cuál movió el precio?

## Lo que esto NO contesta, escrito antes del resultado

1. **El PEAD ya demostró que el movimiento ocurre de noche.** Aunque algo
   explique la reacción, **operarla es otra pregunta y NO está contestada acá**:
   explicar el gap después de que pasó no es poder capturarlo antes.
2. **Sesgo de selección.** Si los datos de ingresos o de guía cubren solo parte
   del universo, un resultado sobre esa señal vale para **esas empresas**, y el
   veredicto dice cuáles (`advertencia_seleccion`, calculada por señal con los
   números de la corrida).

Las dos van en el veredicto. Hay test.

---

## La unidad es el REPORTE, no el mercado

Los eventos salen de `pm_earnings_markets` (los ~240 resueltos de los
experimentos anteriores), pero esa tabla puede tener **varios mercados del mismo
reporte** — umbrales distintos sobre el mismo resultado, lo aprendimos con la
tarjeta de desacuerdo. Contar un reporte tres veces inflaría la n y **fabricaría
significancia**.

Se deduplica por `(símbolo, fecha)` y se publican los dos conteos (`mercados` y
`total`). Hay test con dos mercados del mismo reporte.

---

## La variable dependiente

```
retorno_ajustado = [apertura(T+1) / cierre(T-1) − 1]_acción − [ídem]_SPY
```

- **T-1** = la última sesión **estrictamente anterior** a la fecha del reporte.
- **T+1** = la primera sesión **estrictamente posterior**.
- El calendario de sesiones es el de **SPY**, como en el PEAD.
- Una vela que le falta a la acción **no se rellena** con la de al lado: el
  evento se descarta con su motivo (`sin_vela_cierre_previo`,
  `sin_vela_apertura_siguiente`). Rellenarla movería la ventana sin decirlo.
- Las velas son las de `api/_lib/yahoo-daily.js`, donde el **open lleva el mismo
  factor de ajuste que el close**: un día ex-dividendo no inventa un retorno del
  tamaño del dividendo.
- Sin el ajuste por SPY se estaría midiendo el mercado, no el reporte.

### El costo de la ventana, dicho antes

La ventana no depende de si el reporte fue antes de la apertura (BMO) o después
del cierre (AMC), y **por eso se eligió**: no exige saber la hora. El costo es
que incluye **una sesión completa, el día T**:

- si el reporte fue **AMC**, esa sesión es ruido **previo** al reporte;
- si fue **BMO**, es la reacción del día más la deriva.

Ese ruido **baja** las correlaciones; no las sube. Así que un "no explica" puede
ser en parte la ventana — y un "explica" sobrevivió a pesar de ella.

La alternativa (el gap puro, usando la hora de `pead_event_hour`) es **otra
variable dependiente** y se decide ANTES de correr, no después de ver cuál da
mejor. Esta versión usa la ventana del encargo; el censo cuenta cuántos eventos
tienen la hora conocida, para que la decisión de cambiarla — si se toma — se tome
con ese número y no con el resultado.

---

## Las señales

### A) Sorpresa de EPS

`(reportado − estimado) / |estimado| × 100`, calculada **local** (la de Alpha
Vantage trae el signo mal con estimados negativos) y **winsorizada a ±100%** — la
decisión que ya estaba congelada por INTC. Se **importa** de
`CRITERIOS_F2.winsor_sorpresa_pct`, no se copia: si alguien la moviera en un lado
y no en el otro, los dos experimentos medirían cosas distintas sin decirlo. Hay
test de que son el mismo número.

### B) Sorpresa de ingresos

Misma fórmula, **sin winsorizar**: un estimado de ingresos de estas empresas son
miles de millones, el denominador no puede rondar el cero. Por eso una sorpresa
de **más de ±50% no es un dato**: es un error de unidad o de período entre el
estimado y el real, y se **descarta** con su motivo
(`sorpresa_de_ingresos_implausible`) en vez de recortarse.

**El real y el estimado salen de la MISMA fuente.** Mezclar el real de EDGAR con
el estimado de otra fuente compararía dos definiciones de "ingresos".

### C) Guía

**No entra al análisis en esta versión, y el motivo es fijo:** la guía como
VARIABLE necesita dos piezas que hoy no existen —

1. el número de la guía extraído del texto **sin LLM**, y
2. el consenso del trimestre siguiente **con fecha anterior al reporte**.

El censo devuelve los párrafos crudos para ver si la primera pieza es factible.
Como variable, la cobertura es 0%, y por la regla del 50% no entra.

---

## La regla de estimados (la misma de siempre)

> Un estimado sirve **solo si es anterior al reporte**. "El estimado de hoy" no
> sirve.

Ninguna fuente lo dice en letras, así que la regla mira la **forma** de lo que
devuelve (`clasificaFuenteEstimado`, pura y testeada). Tres clases, y solo dos
sirven:

| Clase | Qué es | ¿Sirve? |
|---|---|---|
| `pit_con_fecha` | cada estimado trae una fecha de corte **anterior** al reporte | **sí** — el mejor caso |
| `estimado_del_evento` | el estimado viene **guardado junto al real del mismo reporte** | **sí** — ver abajo |
| `estimado_de_hoy` | una fila por período fiscal con el número vigente, sin real al lado, con filas para períodos futuros (la forma de `analyst-estimates` de FMP) | **NO** |

### Por qué `estimado_del_evento` sirve — y lo que eso implica

Es **exactamente la misma clase de dato** que el `estimatedEPS` de Alpha Vantage
que usa la señal A: el consenso con el que se llegó al reporte, guardado con el
resultado. **Si esta clase no sirviera, la A tampoco.** Lo dejo escrito porque es
una decisión con consecuencias: si se rechaza para B, hay que rechazarla también
para A, y el experimento entero no tiene señales.

### Dos cicatrices en una regla

- **La del PIT de Alpha Vantage**: una clave con nombre de revisión que era un
  conteo. Por eso la fecha de corte tiene que **ser** una fecha.
- **La de FMP**: `/stable/earnings` trae `lastUpdated`, que es cuándo FMP tocó la
  fila por última vez — **después** del reporte, cuando llegó el real. Tomarla
  como fecha de corte llamaría "point-in-time" a lo contrario. Así que una fecha
  de corte solo cuenta si es **estrictamente anterior** al reporte **en todas** las
  filas que la traen. Cuando una clave con pinta de corte se descarta, la
  respuesta dice cuál y por qué (`clave_de_corte_descartada`): es exactamente el
  dato que alguien va a querer "aprovechar".

### La regla se aplica a la forma CRUDA

Las filas normalizadas siempre traen fecha + real + estimado; clasificarlas a
ellas haría que **cualquier** fuente "sirviera". El barrido guarda la respuesta
cruda de la primera llamada buena y la regla mira esa. Esto lo agarré releyendo
el diff, antes de los tests.

### La elección de fuente (congelada)

Si califica más de una: **la de mayor cobertura**; empate → la que trae fecha de
corte. **Nunca se mezclan**: cada fuente define "consenso" a su manera, y
mezclarlas inventa una serie que no existe en ningún lado. La Fase 1 vuelve a
medir y aplica esta misma regla, así que usa la fuente que el censo habría
elegido sin que nadie tenga que pasársela a mano.

---

## FASE 0 — el censo de datos

`?fase=0` (o `&frente=precios|ingresos|guia`, cada uno con sus 300 s). **Sin
análisis y sin veredicto de señal.**

**Regla congelada: un frente con menos de 50% de cobertura sobre los eventos NO
entra al análisis, y se dice por qué.** La aplica el código en la Fase 1, no la
memoria de quien lee el censo.

### 1. Ingresos

**Estimados** — lo que se prueba, y cómo:

| Fuente | Cómo | Por qué así |
|---|---|---|
| FMP `analyst-estimates?period=quarter` | sonda, hasta 3 símbolos | el encargo dice que es de pago: se **confirma**. Si el 402 nombra `symbol` (empresa fuera del plan) eso no dice nada de `period`, y se prueba la siguiente. Aunque contestara, su forma es "el estimado de hoy". |
| FMP `/stable/earnings` | **barrido** de todos los símbolos | trae `revenueActual` + `revenueEstimated` del mismo reporte |
| Finnhub `calendar/earnings` | **barrido**, 1 hilo, 1.1 s entre pedidos | trae `revenueActual` + `revenueEstimate`; Finnhub gratis corta a 60/min |
| Alpha Vantage `EARNINGS_ESTIMATES` | **UNA** sonda | la cuota de AV es de 25/día y la usa el PEAD (`docs/wheel-fase0.md` §4.3). Si la forma no sirve, barrerla gastaría la cuota del PEAD para confirmar lo mismo 75 veces. |

Las dos fuentes con forma de "estimado del evento" se **barren** en vez de
gatearse con una sonda de un símbolo: el barrido **es** la medición. Gatearlas
con un solo dato repetiría el error del censo de Polymarket — concluir sobre una
fuente por una sola respuesta. Con FMP eso importa: si el símbolo de la sonda
cae fuera del plan (35 de 75 en la tanda de grades), la fuente parecería muerta.

**Reportados en EDGAR (XBRL, sin LLM):** `companyconcept` por tag us-gaap,
probados en orden (`RevenueFromContractWithCustomerExcludingAssessedTax`,
`Revenues`, `SalesRevenueNet`, `…IncludingAssessedTax`) — el orden cubre el
cambio de ASC 606. Trimestral = duración de 75–105 días. **El Q4 casi nunca viene
suelto**: se **deriva** como año − nueve meses, mecánicamente, y se marca
`derivado`. Un período repetido en varios filings se queda con el **más viejo**.

Los ingresos reportados **solos no hacen una sorpresa**: sin el estimado anterior,
no hay contra qué compararlos. Por eso este conteo es una **auditoría** de la
fuente elegida (¿su ingreso real coincide con el de EDGAR, ±1%?), no la señal.

### 2. Guía

10 símbolos (NKE primero si está entre los eventos — es el caso que lo motiva —,
después alfabético; `?simbolos_guia=` lo reemplaza, porque es un censo y elegir a
quién leer no mueve ninguna portería). Por símbolo, los **4 8-K más recientes
con Item 2.02** desde 2019. Del Exhibit 99.1 (encontrado por **nombre**; si
ninguno calza, el `.htm` más grande que no es el documento primario, y se dice qué
regla lo encontró) se devuelven los párrafos que calzan con **patrones fijos**:

- `palabra_guia` — *outlook*, *guidance*
- `verbo_futuro_con_metrica` — *expects / anticipates / projects / sees …* + ingresos/ventas/EPS/margen
- `periodo_futuro_con_metrica` — *fiscal 2027*, *full-year*, *next quarter* + métrica
- `rango_monetario` — *$45.0 billion to $46.0 billion*
- `rango_porcentual` — *mid-single digits*, *3% to 5%*

**El párrafo va crudo.** Nada de "la guía fue floja". El safe harbor ("forward-
looking statements…") calza con casi todo, y se **marca** por regex
(`parece_safe_harbor`) pero **no se borra**: decidir que no es guía sería
interpretar. **CERO llamadas a LLM** — hay un test que lee el código y lo
verifica.

### 3. Precios

Velas de Yahoo (`yahoo-daily.js`, la frontera de precios de los backtests) para
cada símbolo y SPY. Cobertura = eventos con la ventana completa. Si queda bajo
50%, **no hay variable dependiente** y la Fase 1 sale INCONCLUSO entera.

---

## FASE 1 — el análisis, criterios congelados

| Criterio | Valor |
|---|---|
| Eventos mínimos por señal y para el conjunto | **100** — si no, INCONCLUSO para esa parte |
| Una señal "explica" si | **\|r\| ≥ 0.20 y p < 0.05** (Pearson, dos colas, t de Student con n−2) |
| R² conjunto bajo el que la reacción es "mayormente impredecible" | **10%** |
| Cobertura mínima de un frente | **50%** |

- **Cada señal por separado**: r, n, p, y su R² sola (= r²).
- **Juntas**: mínimos cuadrados con las señales que **entraron**, sobre los
  eventos que las tienen todas. Si el R² conjunto queda bajo 10%, el veredicto es
  **"la reacción es mayormente impredecible con datos públicos del reporte" — y
  eso es un HALLAZGO, no un fracaso.**
- **"Las tres juntas" solo se dice si son las tres.** Con menos, el texto nombra
  con cuáles se midió ("solo con EPS", "con A + B, 1 no entró"). Mentir con el
  plural sería fácil.
- **"≥100 eventos con las tres piezas, o INCONCLUSO para la parte que falte"**: se
  reporta `tres_piezas` con su n, y como la C no entra, esa parte sale INCONCLUSO
  nombrando la señal que falta.

### El p-valor, contra tabla

La t de Student se calcula con la **beta incompleta regularizada** (Numerical
Recipes), no con la aproximación normal: con n ≈ 100 la diferencia es chica, pero
con un subconjunto de 30 no lo es, y el p-valor se compara contra un umbral. Los
tests lo comparan contra valores de **tabla** — la lección del `erf` del backtest
de grades, que daba `p(z=1.96) = 0.061`. Salieron bien a la primera; el test queda
igual.

### Comparaciones múltiples, dicho antes

Se prueban hasta dos señales a p < 0.05 cada una. Bajo la hipótesis nula, la
probabilidad de que **al menos una** salga "explica" por azar es ~10%, no 5%. Los
umbrales son los del encargo y no se corrigen — pero el `|r| ≥ 0.20` además del
p-valor es justamente lo que impide que una correlación chica y significativa
pase por hallazgo.

### EXPLORATORIO, etiquetado aparte

**Tasa de acierto direccional**: ¿beat de EPS → la acción sube? Es el número para
contenido. Va **fuera del veredicto**, con dos versiones: sobre el retorno
**ajustado** (la variable del análisis) y sobre el **crudo** (lo que "subió la
acción" significa en una nota). No controla el tamaño de la sorpresa ni del
movimiento: no es una prueba.

---

## Una regresión que este experimento encontró en código ya mergeado

`mencionaParametro` (`api/_lib/fmp-grades.js`) buscaba el nombre del parámetro
como **palabra suelta**. Pero `to`, `from`, `page` y `period` son palabras comunes
del inglés, y el mensaje **real** de plan de FMP termina en *"…please visit our
subscription **page** **to** upgrade your plan"*. Con la palabra suelta, ese
mensaje salía como **"parámetro `to` fuera de rango, NO es un problema de plan"**
— el espejo exacto del diagnóstico falso que esa misma función vino a corregir dos
tandas atrás.

Ahora el nombre tiene que aparecer **en contexto de parámetro**: entre comillas
(`'period'`, que es como FMP los nombra), con `=`, o pegado a una frase que solo
se usa para parámetros (*must*, *is required*, *invalid …*). Hay tests de
regresión con el mensaje real de plan y con *"from 2019 to 2026"*.

---

## Uso

```bash
# FASE 0, un frente por corrida (lo más seguro con 300 s):
/api/reaccion-analyze?fase=0&frente=precios&format=md&secret=<CRON_SECRET>
/api/reaccion-analyze?fase=0&frente=ingresos&format=md&secret=<CRON_SECRET>
/api/reaccion-analyze?fase=0&frente=guia&format=md&secret=<CRON_SECRET>

# FASE 1:
/api/reaccion-analyze?fase=1&format=md&secret=<CRON_SECRET>
#   &eventos=1   el detalle evento por evento
```

**Cuota por corrida:** el frente de ingresos hace ~1 request por símbolo a FMP y
otro a Finnhub (más 3 sondas a FMP y **1** a AV), y hasta 4 a EDGAR por símbolo.
Finnhub a 1.1 s por pedido son ~80 s con 75 símbolos. La Fase 1 repite FMP y
Finnhub (para elegir la fuente con la regla), pero **no** las sondas caras ni
EDGAR ni los 8-K.

**Garantías:** cero writes a Neon (SELECT a `pm_earnings_markets`,
`pead_earnings` y `pead_event_hour`), sin `ensureSchema()` ni `beat()`, gate
`CRON_SECRET`, `maxDuration = 300` **con su entrada en `vercel.json`**. Ninguna
URL publicada lleva una key. El lib es **puro**.

**Perilla:** `REACCION_FINNHUB_PAUSA_MS` (default 1100) — si el plan de Finnhub
cambia, se ajusta sin tocar código.

---

## Archivos

| Archivo | Qué |
|---|---|
| `api/_lib/reaccion.js` | Lógica PURA: `CRITERIOS_REACCION`, la ventana, las sorpresas, la regla de estimados, XBRL con Q4 derivado, los párrafos de guía, Pearson/t/OLS, el veredicto, los resúmenes. |
| `api/_lib/reaccion-fuentes.js` | Frontera de red: FMP, Finnhub, AV, EDGAR. No lanza; status y cuerpo siempre; 402 por el cuerpo. |
| `api/reaccion-analyze.js` | Endpoint: gate, la deduplicación por reporte, los tres frentes, la elección de fuente, la Fase 1. |
| `api/_lib/pead-hour.js` | Cambio **aditivo**: `build8KIndex` devuelve también `primaryDocument`. |
| `api/_lib/fmp-grades.js` | El arreglo de `mencionaParametro`. |
| `tests/reaccion.test.mjs` | Lib: criterios, ventana, regla de estimados, XBRL, guía, estadística contra tabla, veredicto. |
| `tests/reaccion-e2e.test.mjs` | Endpoint con TODA la red simulada. |

## Fuera de esta versión / backlog

- **Extraer el número de la guía sin LLM**, a partir de los párrafos que devuelve
  el censo. Si los patrones de rango (`$X to $Y`) cubren la mayoría, puede salir
  con regex; si no, es otra discusión.
- **El consenso del trimestre siguiente con fecha anterior al reporte**: la otra
  pieza que falta para la C. Ninguna fuente gratis lo tiene hoy.
- **El gap puro con la hora del reporte** como variable dependiente alternativa —
  a decidir ANTES de correr, nunca después de comparar.
- **Más eventos desde `pead_earnings`** en lugar de los mercados de Polymarket: el
  experimento no necesita Polymarket. Si la Fase 1 sale INCONCLUSO por n, ese es
  el camino.
