# SCOPE — Backtest PEAD (Post-Earnings Announcement Drift)

> **Estado:** DISEÑO. Nada construido todavía. Esto es el plan de validación
> estadística que decide si el PEAD merece convertirse en el Agente #7 del
> Arena. Filosofía: **validación primero, agente después.** Si el drift
> capturable neto de costos no existe, se descarta y no se escribe una línea
> de agente.

## Hipótesis

Después de una sorpresa de EPS fuerte **confirmada por una reacción de precio
positiva el día 1**, el precio sigue derivando en la misma dirección durante
los días/semanas siguientes lo suficiente para operarlo — es decir, existe un
retorno **capturable** (entrando *después* de que la reacción del día 1 ya
ocurrió) por encima del mercado y neto de costos.

**Hipótesis nula (H0):** casi todo el movimiento post-earnings ocurre el día 1
(gap incapturable). El drift posterior es ≈ 0 neto de costos → no hay negocio.

El experimento se diseña explícitamente para **poder matar la hipótesis en la
Fase 2** antes de gastar esfuerzo en barrer parámetros.

---

## 1. DATOS

### 1.1 Earnings — ¿Finnhub free tier alcanza?

Finnhub ya está integrado en el proyecto (`api/earnings.js`, key en
`FINNHUB_API_KEY`, free tier = **60 req/min**). Hay **dos** endpoints y elegir
mal es la trampa principal:

| Endpoint | Da | NO da | Uso en el repo hoy |
|---|---|---|---|
| `stock/earnings?symbol=X` (surprise) | `actual`, `estimate`, `period`, `quarter`, `year`, `surprise`, `surprisePercent` | **la fecha del anuncio real** y **la hora BMO/AMC** | `earnings.js:82`, se hace `.slice(0,8)` → ~4-8 trimestres |
| `calendar/earnings?from=&to=&symbol=X` | **`date` (fecha del anuncio)**, `epsActual`, `epsEstimate`, **`hour` (bmo/amc/dmh)**, `quarter`, `year`, `revenueActual`, `revenueEstimate` | — | `earnings.js:88`, solo para el *próximo* earnings |

**Conclusión de datos #1 — usar el calendario, no el surprise.**
Para PEAD la fecha y la hora del anuncio son *load-bearing*: definen cuál es
"el día 1" y cuándo el dato de sorpresa estuvo realmente disponible. Solo
`calendar/earnings` trae `date` + `hour` + `epsActual`/`epsEstimate` en una
sola llamada, y se puede pedir **por rango de fechas sobre todo el mercado**
(no símbolo por símbolo). Ése es el origen correcto del dataset.

**Conclusión de datos #2 — NO reutilizar el cálculo de reacción existente.**
`earnings.js:176-184` calcula `stock_reaction_pct` usando `q.period` (el
**fin del trimestre fiscal**, p.ej. 31-ene) como fecha del evento. La fecha
real del anuncio suele ser ~3-6 semanas *después* (p.ej. 21-feb). Ese cálculo
está desalineado y es inservible para PEAD — hay que anclar el evento a
`calendar/earnings.date` + `hour`.

**⚠️ RIESGO GO/NO-GO — profundidad histórica del calendario en free tier.**
El punto que decide el proyecto entero: el free tier de Finnhub **restringe el
rango histórico de `calendar/earnings`** y la cobertura/calidad del campo
`hour` degrada hacia atrás. No se puede asumir 2-3 años; hay reportes de
ventanas limitadas y de datos "off" en años viejos
([issue #437](https://github.com/finnhubio/Finnhub-API/issues/437)). **Antes de
cualquier otra cosa (Fase 0) hay que verificarlo empíricamente con la key
real**: pedir `calendar/earnings` para una semana de hace ~2.5 años y confirmar
que devuelve filas con `epsActual` **y** `hour` poblados. Si falla → fallback.

Rate limit 60/min: el cuello de botella es la ingesta. El calendario se pide
por semana (no por símbolo), así que ~150 semanas para 3 años ≈ 150 llamadas
= trivial dentro del límite. Cachear el resultado (ver §1.3).

### 1.2 Precios diarios — reuso de Yahoo

Sí, se reutiliza Yahoo (sin key), pero con un matiz:

- Loader canónico `fetchDailySeries()` (`api/_lib/sim.js:76`) devuelve **solo
  closes**. Para "entrada al **open** del día 2" hace falta el **open**, que
  ese loader no expone.
- El extractor de OHLCV completo (o/h/l/c/v) es `extractYahooCandles`
  (`api/candles.js:44`). **Ése** es el que da `open`. → El backtest usa
  `candles.js` para el precio de entrada y `sim.js` para closes/marcado.
- Reutilizar `completedSlice()` (`api/_lib/sim.js:98`) como guard de
  look-ahead — es la convención de la casa.

### 1.3 Almacenamiento

**No existe store de precios** (todo es fetch en vivo con cache de CDN). Para
un backtest que itera muchas veces sobre los mismos datos hay que construir un
**cache propio** del dataset de eventos (JSON/parquet en disco o tabla Neon).
Ingesta una vez, backtest N veces offline. Sin esto cada corrida re-pega a
Yahoo/Finnhub y es lento + toca rate limits.

### 1.4 Si Finnhub no alcanza — alternativas gratis/baratas

En orden de preferencia:

1. **Alpha Vantage `EARNINGS`** — **ya tenemos key** (`ALPHAVANTAGE_API_KEY`,
   usado en `movers.js`). Una llamada por símbolo devuelve el historial
   trimestral completo con **`reportedDate` (fecha real del anuncio)**,
   `reportedEPS`, `estimatedEPS`, `surprise`, `surprisePercentage`, muchos años
   hacia atrás. Es potencialmente **mejor que Finnhub para historia**. Contra:
   free tier ~25 req/día → 500 símbolos = ~20 días de ingesta (scriptable en
   background) o el tier de pago (~$50/mo). **No** trae BMO/AMC — se cruza con
   Finnhub o SEC para la hora.
2. **SEC EDGAR 8-K** — ya integrado (`api/sec-edgar.js`). Timestamp de
   presentación del 8-K = *ground truth* de fecha+hora del anuncio, gratis e
   ilimitado. Ideal como fuente de verdad para la hora (BMO/AMC) y para
   auditar look-ahead. No trae EPS/estimate → complementa, no reemplaza.
3. Financial Modeling Prep / Nasdaq earnings CSVs — free tiers limitados,
   solo si lo anterior no cierra.

**Plan de datos recomendado:** Finnhub `calendar/earnings` como primario
(date+hour+actual+estimate en una fuente). Fallback si el free tier no da
profundidad: Alpha Vantage `EARNINGS` (historia + reportedDate) cruzado con
SEC 8-K (hora). Precios de entrada/salida siempre Yahoo (`candles.js` para
open, `sim.js` para closes).

---

## 2. DISEÑO DEL EXPERIMENTO

### 2.1 Universo (con la lección de micro-caps)

No existe lista de S&P 500 en el repo. Lo más cercano es
`SCREENER_UNIVERSE.us` (~150 large caps curados, pero está en el frontend
`app.html:1956`). En vez de casarse con la membresía del índice, se define el
universo por **filtros de liquidez** (que además ataca survivorship, §3.3):

- Equity común US únicamente → reusar `getSymbolMap()` (`earnings.js:30`) +
  regex `WARRANT_LIKE` de `arena-guard.js:27` para excluir warrants/units.
- Precio > **$5** (fuera penny/micro-caps — la lección de hoy).
- Volumen dólar promedio 20d (ADV) > **$10M** (operable con órdenes límite).
- Market cap > **$2B** (proxy: se puede aproximar con precio×ADV o metric de
  Finnhub).

Resultado: ~500-800 nombres líquidos, sin el ruido de micro-caps. Filtro
aplicado **en la fecha del evento** (point-in-time), no hoy.

### 2.2 Periodo y conteo de eventos

- Periodo objetivo: **3 años** (sujeto a la profundidad que dé la fuente en
  Fase 0). Piso aceptable: 2 años.
- Conteo bruto: ~600 nombres × 4 trimestres × 3 años ≈ **7.000 eventos**.
- Tras el gate de sorpresa+reacción (p.ej. decil superior): del orden de
  **algunos cientos a ~1.500 eventos** → suficiente para potencia estadística,
  incluso partiendo train/test.

### 2.3 Definición de evento (parámetros a barrer)

Gate de **dos factores** (formulación PEAD moderna — sorpresa fundamental
*confirmada* por precio, estilo Bernard–Thomas con confirmación de reacción):

- **Sorpresa EPS** `surprise_pct = (actual − estimate) / |estimate| · 100 > X`
- **Reacción día 1** `ret_dia1 > Y`

Barrido: `X ∈ {5, 10, 20} %` y `Y ∈ {2, 3, 5} %`. **v1 es long-only** (sorpresa
y reacción positivas); el lado short queda fuera de v1 (ver "Fuera de v1").

**Definición de "día 1" según `hour` — el detalle de corrección más
importante:**

- **AMC** (anuncio *después* del cierre del día T): la reacción se ve al día
  siguiente. `ret_dia1 = close(T+1)/close(T) − 1`. **Entrada = open(T+2).**
- **BMO** (anuncio *antes* de la apertura del día T): la reacción es ese mismo
  día. `ret_dia1 = close(T)/close(T−1) − 1`. **Entrada = open(T+1).**

Alinear cada evento por su `hour` es innegociable; mezclarlos mete look-ahead
o desalinea el día 1. Los `dmh`/desconocidos se descartan o se tratan como AMC
(decisión a documentar).

### 2.4 Entrada

**Open del día siguiente a que la reacción del día 1 quedó completamente
observada** (T+2 para AMC, T+1 para BMO). Coincide con la infraestructura del
Arena (opera al open siguiente) → si valida, el agente hereda el timing sin
cambios.

### 2.5 Salida

Barrer horizonte de tenencia `N ∈ {5, 10, 20, 40, 60}` días de trading,
**hold-to-horizon sin stops intermedios**. En la fase de *validación* se
mantiene limpio: stops y trailing son decisiones de *diseño de agente*, no de
la hipótesis. Introducirlos ahora contamina la medición del drift.

### 2.6 Métrica clave — descomposición del retorno

El corazón del experimento. Por evento, en log-returns:

```
R_total = ln(exit / close_pre_anuncio)          ← todo el movimiento
R_dia1  = ln(entry_ref / close_pre_anuncio)      ← gap/reacción  (INCAPTURABLE)
R_drift = ln(exit / entry_open)                  ← lo que SÍ operas (CAPTURABLE)
```

donde `close_pre_anuncio` = close(T) para AMC / close(T−1) para BMO, y
`entry_open` = el open del día de entrada (§2.4).

Se reporta, por cada horizonte `N`:

- media y mediana de **R_drift**, su t-stat y su Sharpe (anualizado ×√252,
  como `sharpeRatio` en `signal-backtester.js:288`),
- **R_drift como % de R_total** (la pregunta central: ¿cuánto del movimiento
  es capturable vs día 1?),
- curva de drift acumulado por N (half-life del drift: ¿a los cuántos días se
  agota?).

**Kill switch (Fase 2):** si `R_drift ≈ 0` neto de costos → H0 no se rechaza →
**se descarta el proyecto**, sin barrer parámetros.

---

## 3. RIGOR

### 3.1 Benchmark — vs mercado, no vs el propio ticker

El backtester existente compara vs buy&hold del *mismo ticker*
(`signal-backtester.js:532`). PEAD necesita **vs mercado**, porque el drift
podría ser solo beta. Trabajo **net-new**:

- Métrica académica estándar: **CAR (cumulative abnormal return)** =
  retorno del evento − retorno de SPY sobre la **misma ventana N** (ajustado
  por beta si se quiere ser fino). Esto aísla el alfa del drift del movimiento
  general del mercado.
- Reportar además el contraste simple: cartera de eventos vs **SPY
  buy&hold** en el mismo periodo (Sharpe, retorno total, max DD).

### 3.2 Costos de transacción y slippage

Portar el modelo de la casa (`ASSUMPTIONS` en `api/_lib/sim.js:40`): **0.10%
slippage + 0.05% comisión por lado** ≈ **0.30% round-trip**, aplicado sobre
R_drift. Declarar el *hurdle* explícito: un drift de +1.5% en 20d sobrevive;
uno de +0.4% no. Órdenes límite (como el Arena) reducen slippage pero añaden
riesgo de no-fill → modelar fill al open con el slippage adverso.

### 3.3 Survivorship bias

Usar los constituyentes de *hoy* sesga hacia arriba (los que salieron del
índice por quebrar no están). Mitigación adoptada: **universo por filtro de
liquidez point-in-time** (§2.1) en vez de membresía de índice — el filtro se
evalúa en la fecha del evento con los datos vivos de entonces, así que un
nombre que luego murió sigue presente en sus eventos previos. Si más adelante
se quiere pureza de índice, conseguir un CSV de constituyentes point-in-time
del S&P 500 (datasets públicos en GitHub); se documenta el bias residual.

### 3.4 Look-ahead bias

- **Disponibilidad del dato de sorpresa:** con AMC día T, `epsActual` es
  público tras el cierre de T; entrada open(T+2) → OK. Con BMO día T, público
  antes del open de T; entrada open(T+1) → OK. El campo `hour` es justamente
  lo que hace esto riguroso. Reusar `completedSlice()` para no incluir barras
  en progreso.
- **Estimate = consenso *previo* al anuncio**, no revisado a posteriori.
  Verificar que Finnhub/AV entregan el estimate pre-anuncio y no un valor
  restated (point-in-time).
- No usar precios posteriores al horizonte para nada del gate de entrada.

### 3.5 Train/test — no sobreajustar X, Y, N

- **Convención de la casa:** split cronológico **70/30**
  (`IN_SAMPLE_FRACTION = 0.70`, `signal-backtester.js:77`), barrer `X,Y,N`
  **solo en in-sample**, congelar el mejor set, y emitir veredicto **solo en
  OOS**. Corregir el p-value por **Bonferroni** según el número de
  combinaciones `(X,Y,N)` probadas (patrón de `signal-backtester.js:544`).
- **Recomendado como primario: walk-forward** (ventana expansiva, re-selección
  de parámetros por fold). Es más honesto para series temporales que un solo
  corte 70/30; el 70/30 queda como piso de sanidad.
- Reusar las etiquetas de veredicto de la casa: **VENTAJA REAL / FRÁGIL / SIN
  VENTAJA** (`signal-backtester.js:379`), juzgadas solo en OOS.

### 3.6 Rigor extra — clustering de eventos (no naive t-stats)

Los earnings se **agrupan en el tiempo** (earnings season) y por sector; los
retornos de eventos simultáneos están correlacionados cross-sectionalmente, así
que un t-stat naive **sobreestima** la significancia. Mitigación: agrupar
errores estándar por semana-de-earnings, o mejor, usar el enfoque de
**cartera calendar-time** (Fama-French): formar una cartera diaria de todas las
posiciones abiertas y medir el alfa de la *serie de la cartera*, no de eventos
individuales. Esto es lo que separa una validación real de una ilusión
estadística por eventos solapados.

---

## Fases (con kill switches)

| Fase | Qué | Salida / gate |
|---|---|---|
| **0 — Spike de datos** (~1 día) | Verificar con la key real la profundidad histórica de `calendar/earnings` + cobertura de `hour`. Script listo: `scripts/pead-phase0-probe.mjs` (correr **fuera** del entorno remoto — su política de red bloquea finnhub/alphavantage/yahoo/sec). | **GO/NO-GO.** Si free tier no da ≥2y con `hour` poblado → fallback a Alpha Vantage `EARNINGS` + SEC 8-K. |
| **1 — Dataset de eventos** | Ingesta universo × calendario, alineado por `hour`, cacheado (§1.3). Precios de entrada (open) y salida vía `candles.js`. | Dataset de ~7k eventos crudos, auditado contra look-ahead. |
| **2 — Descomposición + test de H0** | Medir R_dia1 vs R_drift neto de costos, todos los eventos (sin gate aún). | **KILL SWITCH.** Si R_drift ≈ 0 neto de costos → descartar. |
| **3 — Barrido + validación** | Barrer X,Y,N (long-only) en in-sample; walk-forward; costos; CAR vs SPY. | Métricas OOS con Bonferroni. |
| **4 — Veredicto** | VENTAJA REAL / FRÁGIL / SIN VENTAJA en OOS neto de costos. | Si VENTAJA REAL → luz verde para **Agente #7**. Si no → se descarta. |

---

## Fuera de v1 / backlog

Decisiones tomadas para acotar v1. Documentado aquí para no re-litigarlo y para
retomarlo si v1 valida.

- **Lado short (backlog).** Espejo de la hipótesis: sorpresa negativa (`< −X`) +
  reacción día 1 negativa (`< −Y`), drift esperado a la baja. Se deja fuera de
  v1 por dos razones: (1) el Arena hoy es **long-only** (`arena-guard.js`), así
  que un agente short requeriría cambios en el guard — es asunto de fase de
  agente, no de esta validación; (2) el PEAD short es **asimétrico y más caro**
  (borrow, hard-to-borrow, riesgo de recall), lo que exige modelar costo de
  borrow y tratar long/short como libros separados. Si v1 long valida, el short
  se retoma como estudio aparte con su propio libro y su propio costo.
- **Membresía S&P 500 point-in-time (backlog).** v1 usa filtro de liquidez
  (§2.1). Si se quisiera pureza de índice más adelante, conseguir el CSV de
  constituyentes históricos y medir el bias residual.

---

## Reuso vs net-new

**Reutilizable del repo:**
- `completedSlice()` (look-ahead) — `sim.js:98`
- split 70/30 + Bonferroni + `verdict()` + `sharpeRatio` — `signal-backtester.js`
- modelo de costos `ASSUMPTIONS` — `sim.js:40`
- `getSymbolMap()` + `WARRANT_LIKE` (limpieza de universo) — `earnings.js:30`, `arena-guard.js:27`
- plumbing de Finnhub — `earnings.js` (**pero NO su cálculo de reacción**, §1.1)
- extractor de open (OHLCV) — `candles.js:44`

**Net-new (no existe):**
- Benchmark relativo al mercado (CAR vs SPY) — hoy solo hay vs-ticker
- Constructor + cache del dataset de eventos
- Alineación de evento por BMO/AMC
- Agregación calendar-time portfolio para SE robustos ante clustering
- Ingesta/cruce Alpha Vantage `EARNINGS` + SEC 8-K (si Fase 0 lo exige)

---

## Decisiones — resueltas

1. **Fuente primaria de earnings:** la define la **Fase 0** (Finnhub primario,
   Alpha Vantage `EARNINGS` + SEC 8-K como fallback si el free tier no da ≥2y
   con `hour`). El script `scripts/pead-phase0-probe.mjs` produce el veredicto.
2. **Universo:** **filtro de liquidez** (§2.1), no membresía S&P 500. Ataca
   survivorship y saca micro-caps.
3. **Profundidad:** lo que den los datos, **piso 2 años o no-go** (regla de
   decisión de la Fase 0).
4. **Short:** **fuera de v1** — long-only como el Arena. Ver "Fuera de v1".

Pendiente: correr la Fase 0 y confirmar la fuente primaria según el tier real.
