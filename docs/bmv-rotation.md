# Backtest: rotación Value + Momentum sobre la BMV

> **Estado: Fase A construida, sin correr.** El cosechador existe y está
> probado; los datos todavía no. Los criterios de GO/NO-GO de la Fase B están
> **congelados en este documento y en código antes de ver un solo número** —
> que es el único momento en que congelarlos significa algo.

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
| **`?job=probe`** | Gasta ≤15 requests y **descubre** el contrato: prueba 8 grafías del periodo y 5 del rango de fechas, y guarda la que funcione en `bmv_meta`. Si falla, falla **barato** y devuelve el cuerpo crudo del error — que es donde las APIs suelen decir exactamente qué parámetro falta. |
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
| Históricos (rango completo, 1 por emisora) | 30 | ~80,940 días |
| **Total** | **1,261** | |

**No sé cómo cobra DataBursatil**, así que el reporte da **tres modelos** — y la
diferencia entre ellos no es cosmética, decide si la cosecha cabe en un mes:

| Modelo | Costo | ¿Cabe en 200,000? |
|---|---:|---|
| **A** · por request | 1,261 | **Sí**, con muchísimo margen (0.6%) |
| **B** · por dato devuelto | 154,740 | **Sí**, con 23% de margen |
| **C** · por campo × día (cierre **e** importe) | 235,680 | **NO** |

**El hallazgo que vale la pena decir en voz alta: bajo el modelo C la cosecha
no cabe en un mes.** Y si se pidieran los precios desde 2010 —el rango completo
que la API ofrece— el modelo B sube a **200,100**: se pasa por **100
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
?job=probe                       # ≤15 requests: descubre el contrato
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

**Nada de esto se mueve después de ver los números.** Están escritos aquí y
fijados en código para que, si alguien los cambia, el diff lo delate.

### 3.1 Universo en cada rebalanceo

Emisoras **ICS** (`tipo_valor_id=1`) con financieros disponibles a esa fecha
—**incluidas las SUSPENDIDAS mientras tuvieron precios**— y con **mediana del
importe operado de los últimos 3 meses por arriba de la mediana del universo**.

Se reportan los elegibles y **las exclusiones por motivo** en cada rebalanceo.
Una exclusión sin motivo es un universo que nadie puede auditar.

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
| Cartera | **Quintil superior**, equal-weight. |
| Rebalanceo | **Mensual**. |
| Costos | **10 bp por lado** sobre el turnover real. |
| Benchmark | **NAFTRAC** (ETF del IPC, invertible, misma API). |

### 3.4 Los criterios de GO

1. **Muestra** — ≥ **30 rebalanceos** y ≥ **8 nombres** por canasta. Si no se
   cumple → **INCONCLUSO**, que no es NO-GO: NO-GO afirma que la estrategia no
   sirve, y sin muestra no se afirma nada.
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

**Ninguna promueve un NO-GO a GO.** Sirven para entender de dónde viene (o no
viene) el resultado. Si la principal sale NO-GO y una sensibilidad sale
bonita, el veredicto sigue siendo NO-GO y la sensibilidad es una nota al pie.

---

## 4. Caveats, declarados antes de correr

### 4.1 El universo es chico, y hay una aritmética que decide si esto puede concluir

El filtro de liquidez parte el universo por la **mediana**, o sea que deja
~50%. El quintil de eso es el 20%. Entonces:

```
nombres por canasta ≈ 0.20 × 0.50 × N  =  0.10 × N
```

**Para llegar a los 8 nombres del criterio 1 hacen falta N ≥ 80 emisoras ICS
con financieros a esa fecha.** Con las **30** ICS curadas de Fase 1a la canasta
daría **3 nombres**: INCONCLUSO, sin discusión.

Por eso el reporte de `?job=emisoras` dice **cuántas ICS salieron**, y por eso
ese número es lo primero que hay que mirar: **decide si el backtest puede
concluir algo antes de correrlo**. Si el censo real de DataBursatil trae ~140
ICS locales, la canasta ronda 14 nombres y el criterio se cumple con holgura.
Si trae 60, no.

Y si el quintil da menos de 8, **es INCONCLUSO, no "casi"**. No se baja el
umbral a 6 ni se ensancha el quintil para que alcance. Ese es el punto entero
de congelar los criterios antes.

> La sensibilidad de **decil** necesitaría N ≥ 160 para los mismos 8 nombres.
> Es esperable que salga con canastas chicas — otra razón por la que las
> sensibilidades son atribución y no promoción.

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

**¿NAFTRAC está en `/v2/historicos`?** Es el benchmark y es invertible. Si no
está, **hay que preguntar antes de sustituirlo por el índice IPC**: el IPC no
es invertible, así que cambiar a él no cambia el dato, **cambia el criterio** —
el exceso pasaría a medirse contra algo que nadie puede comprar. `?job=emisoras`
y `?job=cobertura` lo reportan explícitamente, con esa advertencia escrita.

---

## 6. Estado

| Pieza | Estado |
|---|---|
| `api/_lib/databursatil.js` | Hecho. Cliente + parseo tolerante + presupuesto. |
| `api/_lib/bmv-db.js` | Hecho. 6 tablas nuevas, `xbrl_reports` intacta. |
| `api/bmv-harvest.js` | Hecho. 7 jobs, idempotente, con parada limpia. |
| `tests/bmv-harvest.test.mjs` | Hecho. 47 tests, en verde. |
| `docs/sql/bmv-harvest.sql` | Hecho. Generado del schema real. |
| **La cosecha** | **Sin correr** — este sandbox no alcanza la API. |
| **Cobertura real** | **Sin reportar** — depende de la cosecha. |
| `/api/bmv-rotation-analyze` | **Fase B. No empezado, a propósito.** |

El backtest **no se corre** hasta que la Fase A esté completa y la cobertura
real esté reportada.
