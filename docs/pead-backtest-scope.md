# SCOPE — Backtest PEAD (Post-Earnings Announcement Drift)

> **Estado:** FASE 1 (cosecha de datos) IMPLEMENTADA. El **backtest** en sí
> sigue sin construirse — primero se llena el dataset. **Fase 0** resuelta →
> fuente definitiva **Alpha Vantage `EARNINGS` + SEC 8-K** (Finnhub free
> descartado, §1.1). La cosecha (cron de goteo + tablas Neon + job SEC) está
> codeada y testeada; falta desplegar y prenderla (§"Arranque"). Filosofía:
> **validación primero, agente después.** Si el drift capturable neto de costos
> no existe, se descarta y no se escribe una línea de agente.

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

### 1.1 Earnings — qué se evaluó y qué ganó

Finnhub ya estaba integrado (`api/earnings.js`, `FINNHUB_API_KEY`, free =
60 req/min) y fue el candidato inicial. Tiene **dos** endpoints y elegir mal era
la trampa principal:

| Endpoint | Da | NO da | Uso en el repo hoy |
|---|---|---|---|
| `stock/earnings?symbol=X` (surprise) | `actual`, `estimate`, `period`, `quarter`, `year`, `surprise`, `surprisePercent` | **la fecha del anuncio real** y **la hora BMO/AMC** | `earnings.js:82`, se hace `.slice(0,8)` → ~4-8 trimestres |
| `calendar/earnings?from=&to=&symbol=X` | **`date` (fecha del anuncio)**, `epsActual`, `epsEstimate`, **`hour` (bmo/amc/dmh)**, `quarter`, `year`, `revenueActual`, `revenueEstimate` | — | `earnings.js:88`, solo para el *próximo* earnings |

**Lección de datos que sobrevive (aplica a cualquier fuente).** Para PEAD la
fecha y la hora del anuncio son *load-bearing*: definen cuál es "el día 1" y
cuándo el dato de sorpresa estuvo realmente disponible. Y **NO se reutiliza el
cálculo de reacción existente**: `earnings.js:176-184` usa `q.period` (el **fin
del trimestre fiscal**, p.ej. 31-ene) como fecha del evento, que está ~3-6
semanas *antes* del anuncio real (p.ej. 21-feb) — desalineado e inservible para
PEAD. Hay que anclar el evento a la **fecha del anuncio** (`reportedDate` de AV)
+ la **hora** (BMO/AMC, vía SEC 8-K, §1.5).

**✅ RESUELTO — Fase 0 (con las keys reales).**

- **Finnhub `calendar/earnings` free tier → NO-GO.** Devolvió **0 filas en
  todas las ventanas históricas** (6 meses a 5 años atrás). El historial de ese
  endpoint está detrás del paywall. Descartado como fuente.
- **Alpha Vantage `EARNINGS` free tier → GO.** Una llamada por símbolo devolvió
  **121 trimestres de MSFT, 1996-2026 (~30 años)**, con `reportedDate`,
  `reportedEPS`, `estimatedEPS` y `surprisePercentage` ya calculado. Profundidad
  de sobra (el piso era 2 años).

→ **Fuente primaria definitiva: Alpha Vantage `EARNINGS`** (§1.4), cruzada con
SEC 8-K para la hora BMO/AMC (§1.5). Finnhub queda fuera.

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
**cache propio** del dataset de eventos en **Neon** (tablas, §"Plan de
cosecha"). Ingesta una vez, backtest N veces offline.

### 1.4 Fuente primaria definitiva — Alpha Vantage `EARNINGS`

Confirmada en Fase 0. `ALPHAVANTAGE_API_KEY` ya está en el repo (la usa
`movers.js`).

- **Una llamada por símbolo** (`function=EARNINGS&symbol=X`) devuelve el
  historial **completo** en un solo request: `quarterlyEarnings[]` con
  `fiscalDateEnding`, **`reportedDate` (fecha del anuncio)**, `reportedEPS`,
  `estimatedEPS`, `surprise`, `surprisePercentage`. ~30 años de profundidad.
- **Restricción dura: free tier = 25 requests/día** (y ~5/min). Como EARNINGS
  es 1 request = 1 símbolo con toda su historia, el harvest es un **goteo
  único** de 25 símbolos/día, y una vez bajado un símbolo **no hay que volver a
  pedirlo** (solo un refresh liviano del último trimestre cada quarter). Todo el
  plan de cosecha (§"Plan de cosecha") gira alrededor de este único cuello de
  botella.
- **No trae la hora BMO/AMC** → se cruza con SEC 8-K (§1.5).

### 1.5 Hora del anuncio (BMO/AMC) — cruce con SEC 8-K

AV da la *fecha* del anuncio pero no la *hora*, y la hora define el día 1
(§2.3). Fuente de verdad: el **timestamp de aceptación del 8-K** en SEC EDGAR
(ya hay plumbing en `api/sec-edgar.js`), **gratis e ilimitado** (fair-use ~10
req/s + `User-Agent` obligatorio), así que **no compite por el presupuesto de
AV** y corre en paralelo. Detalle de implementación y cobertura esperada en la
sección "Cruce SEC 8-K" del plan de cosecha (§3 de ese plan).

Precios de entrada/salida: siempre Yahoo (`candles.js:44` para `open`,
`sim.js` para closes) — tampoco compiten con AV.

---

## PLAN DE COSECHA DE DATOS (v0)

El único recurso con límite es **AV EARNINGS = 25 req/día, 1 req/símbolo**.
SEC 8-K (hora) y Yahoo (precios) son gratis/ilimitados y corren **en paralelo**,
sin competir por ese presupuesto. Todo el plan gira alrededor del goteo de AV.

### 1. Goteo idempotente y reanudable — cron + Neon

**Dos tablas nuevas en Neon** (más una de presupuesto):

**Precisión de almacenamiento:** la tabla guarda **TODA la historia que AV
devuelva** (los ~30 años vienen gratis en la misma llamada), aunque el v0 solo
analice ~3 años. **La tabla nunca recorta** — el recorte temporal es una
cláusula del *query* de análisis, no de la ingesta. Bajar una vez, guardar todo,
decidir la ventana en tiempo de backtest.

```sql
-- Un renglón por evento. La PK hace el upsert idempotente (sin duplicados).
-- Se guardan TODOS los trimestres que devuelva AV (sin recorte temporal).
CREATE TABLE pead_earnings (
  symbol              text NOT NULL,
  fiscal_date_ending  date NOT NULL,
  reported_date       date NOT NULL,          -- fecha del anuncio (AV)
  reported_eps        numeric,
  estimated_eps       numeric,
  surprise            numeric,
  surprise_pct        numeric,
  source              text DEFAULT 'alphavantage',
  ingested_at         timestamptz DEFAULT now(),
  PRIMARY KEY (symbol, reported_date)
);

-- Registro de qué símbolos ya bajamos. ESTO es lo que hace el goteo reanudable.
CREATE TABLE pead_harvest_ledger (
  symbol           text PRIMARY KEY,
  priority         int  NOT NULL DEFAULT 100,  -- 0 = v0 (se baja primero)
  status           text NOT NULL DEFAULT 'pending', -- pending|done|error|delisted
  quarters_fetched int  DEFAULT 0,
  attempts         int  DEFAULT 0,
  last_attempt_at  timestamptz,
  error_msg        text
);

-- Guard de presupuesto diario, robusto a cron doble-disparo / corridas manuales.
CREATE TABLE pead_api_budget (
  day   date PRIMARY KEY,
  calls int NOT NULL DEFAULT 0
);
```

**Cron** (`api/pead-harvest.js`), respetando Vercel `maxDuration=60s` + AV
~5/min: cada invocación procesa **≤5 símbolos** con ~11s de espacio (~55s).
Se programan **5 invocaciones/día = 25 símbolos/día** exactos. Lógica por
invocación:

1. Leer `pead_api_budget` de hoy (UTC). Si `calls >= 25` → salir (no-op).
2. `SELECT symbol FROM pead_harvest_ledger WHERE status='pending' ORDER BY
   priority ASC, symbol LIMIT min(5, 25-calls)`.
3. Por símbolo: llamar AV EARNINGS → **validar que `quarterlyEarnings.length>0`**
   (AV devuelve un JSON con `Note`/`Information`, HTTP 200, cuando te
   rate-limita; si no validás, grabás un símbolo vacío como `done`). Si OK:
   `UPSERT` los trimestres en `pead_earnings`, marcar ledger `status='done',
   quarters_fetched=n`. Si rate-limit/errores: `attempts++`, dejar `pending`
   (se reintenta solo). Incrementar `pead_api_budget.calls`.
4. Un símbolo bajado **no se vuelve a pedir** (histórico completo en 1 request).

**Idempotente:** upsert por PK → reprocesar no duplica. **Reanudable:** el
ledger es la fuente de verdad; un crash a mitad deja el símbolo `pending` y el
próximo cron lo retoma. **Auditable:** `pead_api_budget` te dice el gasto real
por día. Mantenimiento post-harvest: un cron ligero semanal que refresca solo
el trimestre más reciente de los símbolos `done` (1 req c/u, dentro del mismo
presupuesto).

### 2. Universo v0 (~100) para backtest en ~4 días, y expansión en paralelo

- **v0 = ~100 nombres más líquidos** → `priority=0` en el ledger. A 25/día se
  cosechan en **4 días** → dataset v0 completo, backtest andando.
- Selección: derivar de `SCREENER_UNIVERSE.us` (`app.html:1956`, ~150 large
  caps) recortado a los **top 100 por ADV en dólares** (mega-cap tech + líderes
  sectoriales). Todos domésticos y líquidos → maximiza además la cobertura de
  SEC 8-K (§3).
- **Expansión sin trabajo extra:** el resto del universo (§2.1, ~500-800
  nombres) entra al ledger con `priority=1+` (por bucket de ADV). El **mismo
  cron** sigue drenando por prioridad después del v0 → universo completo en
  ~24 días, sin tocar nada. SEC 8-K y Yahoo rellenan cada símbolo apenas
  aterrizan sus filas (son ilimitados), así que la expansión no tiene cuello de
  botella secundario.

### 3. Cruce SEC 8-K para BMO/AMC — trabajo, cobertura, y regla de respaldo

**¿Cuánto trabajo real?** BAJO-MODERADO (~1-2 días), y **sin espera de rate
limit** (SEC es gratis/ilimitado, solo pide `User-Agent` y ~10 req/s). Pasos:

1. Mapa ticker→CIK: un archivo, `sec.gov/files/company_tickers.json`.
2. Por símbolo: `data.sec.gov/submissions/CIK##########.json` → `filings.recent`
   (`form`, `filingDate`, `acceptanceDateTime`, `items`). Historia profunda: los
   archivos extra en `filings.files[]` (la paginación de filings viejos es la
   única parte fiddly).
3. Filtrar `form=='8-K'` **con `items` que incluya `2.02`** (Results of
   Operations — el 8-K de earnings).
4. Casar con cada `reported_date` de AV (mismo día ±1 día hábil).
5. Clasificar por `acceptanceDateTime` (ya viene en hora del Este): `<09:30` →
   **BMO**; `>=16:00` → **AMC**; en medio → **DMH**.

Se guarda en una tabla aparte `pead_event_hour (symbol, reported_date, hour,
source, accepted_at_et, accession)` para que el job de SEC sea independiente del
de AV.

**¿Qué % vamos a poder etiquetar?** Para un universo de **equity común US
líquido** —sobre todo el v0, todo doméstico y large-cap— estimo **~90%+**
(85-95%). La gran mayoría de earnings se presentan el mismo día como 8-K Item
2.02. Los huecos: ADRs/emisores extranjeros que presentan 6-K en vez de 8-K
(pero el filtro de "equity común US" ya los excluye en gran parte),
desajustes ocasionales de fecha/ítem, y formato de filings muy viejos
(irrelevante, queremos años recientes).

**¿Qué hacemos con los que queden sin hora? — Regla de respaldo escalonada, NO
descarte ciego:**

1. **SEC 8-K** (verdad de campo) — primaria.
2. **Heurística de gap overnight** (respaldo, *causal / sin look-ahead*):
   comparar `|open(D)/close(D-1)−1|` (gap **hacia** el día D del anuncio) contra
   `|open(D+1)/close(D)−1|` (gap hacia D+1). Gap mayor hacia D ⇒ **BMO**; mayor
   hacia D+1 ⇒ **AMC**. Ambos precios ya se conocen en el punto de entrada de
   cada rama (entrada BMO = open(D+1); entrada AMC = open(D+2)), así que **no
   hay look-ahead**. Solo puede confundir eventos de reacción chica — que el
   gate `Y` descarta igual.
3. **Cola ambigua** (ambos gaps minúsculos, sin reacción fuerte): no pasa el
   gate `Y` → descartarlos es inocuo.

Además, **chequeo de sensibilidad**: para el subconjunto sin etiqueta SEC,
correr el backtest también asumiendo todo-AMC y todo-BMO; si el veredicto v0 es
estable entre eso y la heurística, la incertidumbre de hora no está manejando el
resultado. El audit del dataset reporta el % etiquetado por cada método.

### 4. Criterio para AV premium (~$50/mo) — decidir DESPUÉS del v0

Premium = **75 req/min, sin tope diario** → el harvest del universo completo pasa
de ~24 días a **~10 minutos**, y habilita iterar/refrescar rápido.

**Regla de decisión (explícita, post-v0):** pagar **solo si**
1. el backtest **v0 (100 nombres) rechaza H0** — muestra drift capturable real
   neto de costos (R_drift claramente > 0, prometedor en in-sample), **Y**
2. necesitás el universo completo para potencia estadística / robustez OOS
   (walk-forward), o querés dejar de esperar los ~24 días del goteo.

- Si el v0 **mata la hipótesis** (R_drift ≈ 0) → **nunca pagás**; se descarta el
  proyecto en la Fase 2.
- Si el v0 **promete** → $50 para comprimir 24 días→minutos y desbloquear el
  universo completo es trivialmente rentable; pagás ahí.

En una línea: **no pagás para OBTENER el v0; pagás solo para ESCALAR un v0 que
ya mostró señal.** El v0 (gratis, 4 días) es la opción que de-riesga los $50.

### Implementación (ya en el repo)

| Archivo | Qué |
|---|---|
| `api/_lib/pead-db.js` | Schema (4 tablas) + helpers: ledger, upsert de earnings (toda la historia), event-hour, budget. |
| `api/_lib/av-earnings.js` | Fetch + parse de AV EARNINGS. Detecta la trampa de rate-limit (HTTP 200 + `Note`) y el sentinela `'None'`. |
| `api/_lib/pead-hour.js` | Clasificador BMO/AMC del 8-K (Item 2.02) + heurística de gap + recolección con paginación de filings viejos. Reusa `sec-edgar.js`. |
| `api/_lib/pead-universe.js` | Universo v0 (~100 nombres líquidos, priority 0). |
| `api/pead-harvest.js` | Cron: `?job=earnings\|hour\|seed\|status`. Gated por `CRON_SECRET` + `PEAD_HARVEST_ENABLED`. |
| `tests/pead-harvest.test.mjs` | 30+ asserts de lógica pura (parse, clasificación, matching, gap, universo). |
| `vercel.json` | 5 crons/día de goteo + 1 de etiquetado SEC. |

### Arranque (cuando quieras prenderla)

1. `DATABASE_URL` y `ALPHAVANTAGE_API_KEY` ya están; setear **`PEAD_HARVEST_ENABLED=1`**.
2. Sembrar el ledger v0: `GET /api/pead-harvest?job=seed` (idempotente).
3. Los crons hacen el resto: ~4 días para los 100 nombres. Monitorear con
   `GET /api/pead-harvest?job=status` (gasto del día + estado del ledger).
4. El job SEC (`?job=hour`) etiqueta BMO/AMC en paralelo, sin gastar presupuesto AV.

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
- Market cap > **$2B** (proxy: precio×ADV, o el `stock/metric` de AV/Yahoo).

Resultado: ~500-800 nombres líquidos, sin el ruido de micro-caps. Filtro
aplicado **en la fecha del evento** (point-in-time), no hoy.

### 2.2 Periodo y conteo de eventos

- Periodo de **análisis** v0: **~3 años** (decisión tomada). Aunque la tabla
  guarde 30 años, el v0 analiza solo ~3.
- Conteo bruto: ~600 nombres × 4 trimestres × 3 años ≈ **7.000 eventos**
  (v0: ~100 nombres × 4 × 3 ≈ **1.200 eventos** — ya suficiente para un primer
  test de H0).

> **⚠️ REGLA DURA — profundidad vs survivorship (que quede escrito).**
> El universo está definido por liquidez **de hoy**. Cuanto más atrás se
> analiza, más survivorship bias: estaríamos midiendo earnings de empresas que
> *sabemos* que sobrevivieron y siguen líquidas — sesgo hacia arriba.
> **Cualquier análisis más profundo que ~3-5 años exige un universo
> point-in-time** (membresía/liquidez reconstruida a la fecha del evento), o los
> resultados **no son válidos**. Los 30 años en la tabla son tentadores pero
> NO se pueden analizar con el universo de hoy. Al expandir la ventana, primero
> se cambia el universo. Sin excepción.
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

**El filtro point-in-time solo mitiga survivorship dentro de la ventana en que
el universo actual sigue siendo representativo (~3-5 años).** Para v0 (~3 años)
está OK. Ir más atrás sin reconstruir el universo a la fecha invalida los
resultados — ver la regla dura en §2.2.

### 3.4 Look-ahead bias

- **Disponibilidad del dato de sorpresa:** con AMC día T, `epsActual` es
  público tras el cierre de T; entrada open(T+2) → OK. Con BMO día T, público
  antes del open de T; entrada open(T+1) → OK. El campo `hour` es justamente
  lo que hace esto riguroso. Reusar `completedSlice()` para no incluir barras
  en progreso.
- **Estimate = consenso *previo* al anuncio**, no revisado a posteriori.
  Verificar que el `estimatedEPS` de AV es el pre-anuncio y no un valor
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
| **0 — Spike de datos** ✅ HECHA | `scripts/pead-phase0-probe.mjs`. Resultado: Finnhub free **NO-GO** (0 filas históricas); Alpha Vantage `EARNINGS` **GO** (~30 años). | **Fuente definitiva: AV `EARNINGS` + SEC 8-K.** |
| **1 — Cosecha del dataset v0** ✅ IMPLEMENTADA | Goteo AV 25/día → **100 nombres en ~4 días** (ver "Plan de cosecha" + "Implementación"). SEC 8-K (hora) + Yahoo (precios open/close) en paralelo. Falta: desplegar + `PEAD_HARVEST_ENABLED=1` + seed. | Dataset v0 (~1.200 eventos) en Neon, auditado contra look-ahead + % de hora etiquetada. |
| **2 — Descomposición + test de H0** | Medir R_dia1 vs R_drift neto de costos, todos los eventos v0 (sin gate aún). | **KILL SWITCH.** Si R_drift ≈ 0 neto de costos → descartar. Decide también el gasto de AV premium. |
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
- key + patrón de fetch de Alpha Vantage — `movers.js` (`ALPHAVANTAGE_API_KEY`)
- plumbing de SEC EDGAR — `api/sec-edgar.js`
- extractor de open (OHLCV) — `candles.js:44`
- **NO** reusar el cálculo de reacción de `earnings.js:176` (usa período fiscal, §1.1)

**Net-new (no existe):**
- Cron de goteo AV + tablas Neon (`pead_earnings`, `pead_harvest_ledger`, `pead_api_budget`) — ver "Plan de cosecha"
- Cruce SEC 8-K → BMO/AMC (`pead_event_hour`) + heurística de gap de respaldo
- Benchmark relativo al mercado (CAR vs SPY) — hoy solo hay vs-ticker
- Alineación de evento por BMO/AMC y descomposición R_dia1/R_drift
- Agregación calendar-time portfolio para SE robustos ante clustering

---

## Decisiones — resueltas

1. **Fuente primaria de earnings:** **Alpha Vantage `EARNINGS`** (Fase 0:
   Finnhub free NO-GO con 0 filas; AV GO con ~30 años), cruzada con **SEC 8-K**
   para la hora BMO/AMC. Finnhub descartado.
2. **Universo:** **filtro de liquidez** (§2.1), no membresía S&P 500. Ataca
   survivorship y saca micro-caps. **v0 = ~100 más líquidos** primero.
3. **Profundidad:** AV da ~30 años → no limita; el tope real es cuántos símbolos
   se cosechen (goteo 25/día).
4. **Short:** **fuera de v1** — long-only como el Arena. Ver "Fuera de v1".
5. **AV premium ($50/mo):** decisión **post-v0** — pagar solo para *escalar* un
   v0 que ya mostró señal, nunca para obtenerlo (ver "Plan de cosecha" §4).

**Próximo paso:** desplegar y prender la Fase 1 (`PEAD_HARVEST_ENABLED=1` +
seed, ver "Arranque"), dejar cosechar ~4 días, y recién entonces construir el
**backtest** (Fase 2: descomposición R_dia1/R_drift + test de H0). El backtest
NO está construido — es el próximo bloque de trabajo tras tener datos.
