# BETA DE EVENTO — sección "LO QUE SÍ HAY" del Pairs Validator

**Estudio PRE-REGISTRADO.** Los umbrales del veredicto se fijaron **antes** de
correr nada sobre datos reales (aprobados en la propuesta previa a este doc),
viven congelados en `CRITERIOS` (`api/_lib/event-beta.js`) y salen en cada
respuesta del endpoint. Si alguien los mueve después de ver los números, el
diff lo delata. Mismo playbook que `/api/pead-analyze` y `/api/rotation-analyze`.

Endpoint: `GET /api/event-beta?y=MU&x=NVDA&range=2y` (solo lectura, cero Claude).

---

## 1. La pregunta

El Pairs Validator es un escéptico: sus 3 Puertas (cointegración → vida media OU
→ re-test OOS) están diseñadas para decir **NO**. Y dicen NO casi siempre, con
razón. El problema es que un `RUIDO` deja al usuario con las manos vacías: se
llevó un veredicto correcto y cero información sobre la relación que sí
existe entre los dos nombres.

> **¿Y se mueve con X en eventos?**

Esa es la pregunta que esta sección responde, **exista o no cointegración**. Es
deliberadamente una pregunta distinta a la de las Puertas:

| | Puertas A/B/C | Beta de evento |
|---|---|---|
| Objeto | **niveles** (log-precios) | **retornos** |
| Hipótesis | el spread revierte a una media | Y reacciona cuando X salta |
| Uso | par de stat-arb | cobertura / lectura direccional |
| Si falla A | no hay par | **la sección sigue siendo válida** |

Dos nombres pueden no cointegrar jamás (dos caminatas aleatorias con drifts
distintos) y aun así moverse juntos el día que uno reporta. Eso no es un par,
pero tampoco es nada.

**Regla de la sección: siempre visible.** Se pinta para `VENTAJA REAL`,
`MARGINAL`, `RUIDO`, `SOBREAJUSTADO` y `DATOS INSUFICIENTES` por igual. Si los
datos no llegan, se pinta con *"no disponible — {razón}"*. Nunca desaparece:
una sección que se esconde cuando el resultado es feo es una sección que miente
por omisión.

---

## 2. Aviso de honestidad: el sondeo en vivo NO se pudo hacer

Se pidió un smoke de AV `EARNINGS` para NVDA desde Vercel antes de diseñar.
**No fue posible desde el entorno de desarrollo** y no se rodeó el bloqueo:

```
$ curl "https://www.alphavantage.co/query?function=EARNINGS&symbol=NVDA&apikey=..."
curl: (56) CONNECT tunnel failed, response 403
$ curl "https://quantdesk2.vercel.app/api/config"              → 403
$ curl "https://query1.finance.yahoo.com/v8/finance/chart/NVDA" → 403

$ curl "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.alphavantage.co:443" },
  { … "host": "quantdesk2.vercel.app:443" },
  { … "host": "query1.finance.yahoo.com:443" } ]
```

Es **el precedente ya documentado en la casa**: `docs/wheel-fase0.md` §0 (mismo
403 a AV) y `docs/alpaca-paper-scope.md:195` — *"el sandbox de desarrollo no
puede pegar a Alpaca (proxy 403) — el smoke en Vercel es el único gate real"*.
Tampoco hay `ALPHAVANTAGE_API_KEY` ni `DATABASE_URL` en el sandbox: viven en
Vercel.

**Entregable que cierra el hueco:** `scripts/event-beta-probe.mjs` (sin
dependencias, mismo ritual que `scripts/pead-phase0-probe.mjs` y
`scripts/wheel-phase0-probe.mjs`). Gasta **1 request** de las 25/día.

```bash
ALPHAVANTAGE_API_KEY=xxx node scripts/event-beta-probe.mjs        # default NVDA
ALPHAVANTAGE_API_KEY=xxx node scripts/event-beta-probe.mjs KO PEP # otros símbolos
```

### 2.1 Qué SÍ está verificado (y dónde)

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿AV `EARNINGS` trae **hora** BMO/AMC? | **No.** | `scripts/pead-phase0-probe.mjs:164`; `docs/pead-backtest-scope.md` §1.4-1.5 (*"No trae la hora BMO/AMC → se cruza con SEC 8-K"*) |
| ¿Campos por trimestre? | `fiscalDateEnding`, `reportedDate`, `reportedEPS`, `estimatedEPS`, `surprise`, `surprisePercentage` | `docs/pead-backtest-scope.md` §1.4; el parser real en `api/_lib/av-earnings.js` |
| ¿Profundidad? | ~30 años, **1 request = 1 símbolo con toda su historia** | `docs/pead-backtest-scope.md` §1.4 (medido sobre MSFT en Fase 0) |
| ¿Trampa de rate limit? | Sí: te limita con **HTTP 200** + `{"Note"…}` / `{"Information"…}` y cero datos | `api/_lib/av-earnings.js` (`parseEarnings` ya lo distingue: `ok` / `rate_limited` / `empty`) |

**Lo NO verificado y marcado como tal:** cuántos trimestres devuelve AV
**para NVDA específicamente**. El diseño no depende del número — depende del
formato de `reportedDate`, que `parseEarnings()` ya valida contra
`^\d{4}-\d{2}-\d{2}$` y descarta los `None`/`''` que AV usa como sentinela.

### 2.2 El hallazgo que abarata todo

**NVDA, MU, KO y PEP ya están cosechados en Neon.** Los cuatro están en
`V0_UNIVERSE` (99 nombres, `api/_lib/pead-universe.js`) y el ledger de PEAD
**cerró en 99/99** (`docs/wheel-fase0.md` §4.3). `pead_earnings` guarda **toda**
la historia que AV devolvió, sin recorte temporal (regla explícita del scope de
PEAD: *"la tabla nunca recorta"*).

Consecuencias:
- Los **dos pares del e2e cuestan 0 llamadas a AV**.
- Los ~99 nombres más líquidos de US equity ya responden sin gastar cupo.
- PEAD está retirado (`PEAD_HARVEST_ENABLED ≠ 1`), así que las 25/día están
  libres. El único otro candidato a ese cupo es el wheel (`docs/wheel-fase0.md`
  §4.3) — por eso el guard de presupuesto de §6.2 **no es opcional**.

---

## 3. Fuentes de datos

| Dato | Fuente | Por qué |
|---|---|---|
| Precios diarios **ajustados** (open + close) | `api/_lib/yahoo-daily.js` → `bajaSerie(sym, '10y')` | única frontera de precios de los backtests; ajusta por splits **y** dividendos |
| Fechas de earnings de X | `pead_earnings` (Neon) → fallback AV `EARNINGS` | `api/_lib/av-earnings.js` + `api/_lib/pead-db.js`, ya probados |
| Hora del anuncio | **no existe** → supuesto AMC parejo | §4.2 |

### 3.1 Por qué `api/candles.js` queda DESCARTADO

El encargo original decía "precios ajustados de `api/candles.js`". **No lo son,
y no alcanza la ventana.** Dos problemas duros:

1. **No están ajustados por dividendos.** `extractYahooCandles()`
   (`api/candles.js:63`) lee `indicators.quote[0]` — que Yahoo ajusta **solo por
   splits** — e **ignora `indicators.adjclose`**. En un día ex-dividendo, un
   `close(E)/close(E−1)` sobre esa serie inventa un retorno del tamaño del
   dividendo. **KO y PEP pagan dividendo trimestral y el día ex suele caer cerca
   del reporte** — justo el par del e2e. Sería un número falso en el caso de
   prueba.
2. **Tope de 1 año.** `INTERVALS['1d'].yahoo.range = '1y'` (`api/candles.js:17`).
   Con eso X tiene ~4 earnings y el estudio nace con N<10 en **todos** los pares,
   siempre. La sección no diría nada nunca.

`api/_lib/yahoo-daily.js` resuelve exactamente esto y su cabecera documenta la
trampa: deriva `f = adjclose/close` del día y **lo aplica también al open**,
*"así open y close quedan en la misma escala y el retorno intradía/overnight es
el real"*. Mezclar un open sin ajustar contra un close ajustado es el bug que
esa librería existe para prevenir.

**No se toca `candles.js`.** Alimenta el chart modal de toda la app; agregarle
`adjclose` es un cambio con radio de explosión mucho mayor que el de esta
feature, y el chart no lo necesita (muestra precios como los ve el usuario).

---

## 4. Especificación pre-registrada

### 4.1 Correlación de retornos

| Pieza | Definición |
|---|---|
| Retornos | **log**: `r_t = ln(P_t / P_{t−1})` sobre closes **ajustados** |
| Alineación | intersección de fechas con precio válido en **ambos** símbolos |
| Estadístico | Pearson sobre los retornos alineados |
| Ventana corta | últimas **252 sesiones** de la intersección |
| Ventana completa | el `range` que eligió el usuario en el validador (1y / 2y / 5y) |
| Mínimo | **30 pares** de retornos; por debajo → `null` + razón, no un número frágil |

**Nota honesta obligatoria:** con `range=1y` las dos ventanas son la misma serie.
La respuesta marca `same_window: true` y la UI pinta **un solo** número en vez
de repetir el mismo valor dos veces con etiquetas distintas.

### 4.2 Día de evento

`reported_date = D` (AV, fecha del anuncio, sin hora).

**Supuesto congelado: AMC parejo.** Todos los eventos se tratan como
*after-close*, así que el **día de evento `E` = la primera sesión posterior a D
con precio válido en ambos símbolos**.

Por qué AMC y no BMO, citando la regla ya congelada de la casa
(`docs/pead-backtest-scope.md:498`):

> *"Tratados como AMC. Tratarlos como BMO metería look-ahead si en realidad
> fueron AMC (mediríamos una reacción **anterior** al anuncio); AMC nunca lo
> mete — a lo sumo se mide un día tarde."*

El error es asimétrico: BMO puede medir una reacción que ocurrió **antes** de que
existiera la noticia, lo que es lisa y llanamente inventar el resultado. AMC como
mucho mide un día después. Cuando hay que elegir sin dato, se elige el sesgo que
no fabrica evidencia.

La respuesta lleva `hour_source: 'assumed_amc'` en cada evento, para que el día
que se conecte la hora real (§10) el cambio sea de una línea y la diferencia sea
auditable.

**Casos borde, todos explícitos:**

| Caso | Regla |
|---|---|
| D es la última sesión disponible (no hay `E`) | evento **descartado**, contado en `dropped.no_next_session` |
| No hay precio de Y ese día (halt, ticker joven) | evento **descartado**, `dropped.no_price` |
| `E−1` no existe (evento al inicio de la serie) | evento **descartado**, `dropped.no_prior_close` |
| Dos `reported_date` iguales | ya colapsados por `dedupeByReportedDate()` (`api/_lib/pead-db.js`) |
| `reported_date` fuera de la ventana de precios de 10 años | **descartado**, `dropped.out_of_window` |

`dropped` sale **siempre** en la respuesta y se muestra en el pie de la sección.
Un evento silenciosamente ausente es una muestra distinta a la que dice el JSON.

### 4.3 Retornos del día de evento

Para **Y y X**, sobre precios ajustados, el mismo día `E`:

```
c2c = close(E) / close(E−1) − 1      close-to-close
o2c = close(E) / open(E)   − 1       open-to-close
```

El `c2c` captura el gap overnight (donde vive la reacción de un anuncio AMC) más
la sesión. El `o2c` captura **solo** la sesión: si el arrastre está en el `c2c`
pero no en el `o2c`, la reacción ya estaba en el precio a la apertura y no era
operable en el día. Por eso se reportan los dos, no uno.

### 4.4 Grupos

Clasificados por el **`c2c` de X** (el que reporta):

| Grupo | Condición | Nota |
|---|---|---|
| `UP` | `c2c_X ≥ +3.0%` | frontera **inclusiva** |
| `DOWN` | `c2c_X ≤ −3.0%` | frontera **inclusiva** |
| `ALL` | todos los eventos | sin filtro de magnitud |
| `BASELINE` | **todos los días** de la ventana, solo Y | el contrafáctico |

Los umbrales `±3.0%` se aplican con tolerancia de punto flotante
(`>= 0.03 - 1e-9`), no con `>` a secas: un `c2c` de exactamente `0.03` entra en
`UP`, y qué lado de la frontera toca no puede depender de un error de redondeo.

**Por qué `ALL` y `BASELINE` no son opcionales:**
- Sin `BASELINE`, un "64% de hit rate" no significa nada. Si Y sube el 62% de
  todos los días, ese 64% es ruido. El contrafáctico es lo que convierte un
  número en evidencia.
- Sin `ALL`, un par de nombres de baja volatilidad sale **vacío**: PEP rara vez
  mueve ±3% en earnings, así que `UP` y `DOWN` pueden ser N=0 y la sección no
  diría nada. `ALL` garantiza que siempre hay algo que reportar.

### 4.5 Métricas por grupo

| Métrica | Definición |
|---|---|
| `n` | eventos en el grupo, **después** de los descartes de §4.2 |
| `hit_rate` | fracción con **`sign(r_Y) == sign(r_X)`** — "¿Y se movió en la misma dirección que X ese día?" |
| `avg` | media aritmética de `r_Y` en el grupo |

Se calculan **por separado para `c2c` y `o2c`**. Un retorno exactamente 0 en
cualquiera de los dos **no cuenta como hit** (`sign(0) = 0 ≠ ±1`) y se cuenta en
`n_zero` para que el denominador no mienta.

Para `BASELINE` no hay `hit_rate` (no hay X con qué comparar): solo `n` y `avg`
de Y sobre todos los días. Se pinta como `—`, nunca como 0% — que son cosas
distintas.

---

## 5. Veredicto — umbrales CONGELADOS

Plantilla + números. **Cero llamadas a Claude**, en el servidor y en el cliente.
Un test lo hace cumplir (§9).

Se evalúa sobre el **`c2c` del grupo `UP`** cuando tiene datos; si `UP` está
vacío y `DOWN` no, sobre `DOWN`; si los dos están vacíos, sobre `ALL`. El grupo
elegido sale en `verdict.basis` — nunca se elige "el que salió mejor".

```js
const CRITERIOS = Object.freeze({
  UMBRAL_SALTO: 0.03,      // ±3% en c2c de X define UP / DOWN
  HIT_FUERTE:   0.60,      // hit rate >= 60%  → beta de evento
  HIT_DEBIL:    0.50,      // 50-60%           → arrastre débil
  MULT_BASE:    2.0,       // |avg_Y| >= 2x |baseline| exigido para "fuerte"
  N_MIN:        10,        // N < 10           → descriptivo, no significativo
  MIN_RET_CORR: 30,        // pares mínimos para reportar correlación
  VENTANA_CORTA: 252,      // sesiones de la ventana de 1 año
  RANGE_PRECIOS: '10y',    // ventana de precios del event study
});
```

| Condición sobre el grupo base | Tier | `verdict.tier` |
|---|---|---|
| `hit_rate ≥ 0.60` **y** `\|avg_Y\| ≥ 2 × \|avg_baseline\|` | hay beta de evento | `beta_evento` |
| `hit_rate ≥ 0.60` pero falla el múltiplo | arrastre débil | `arrastre_debil` |
| `0.50 ≤ hit_rate < 0.60` | arrastre débil | `arrastre_debil` |
| `hit_rate < 0.50` | no se mueve con X en eventos | `sin_beta` |
| `n = 0` en todos los grupos | no disponible | `sin_datos` |

**Modificador `N < 10`:** si el grupo base tiene `n < 10`, se **antepone**
`descriptivo, no significativo (N=7)` a la línea. No cambia el tier — cambia lo
que el lector puede hacer con él. El modificador se calcula por grupo, así que
una tabla puede tener `UP` significativo y `DOWN` descriptivo a la vez; cada
fila lleva su propia marca.

**Los umbrales no se mueven después de ver datos reales.** Están en `CRITERIOS`,
salen en cada respuesta bajo `config`, y este párrafo existe para que mover uno
sea un acto visible en el diff, no un ajuste silencioso.

### 5.1 Línea de veredicto (i18n)

Una línea, dos idiomas, mismos números. Vía `smL(es, en)` (`app.html:3556`) — el
helper que la casa ya usa para strings **dinámicos**; el diccionario `i18n{}`
(`app.html:10196`) es solo para `data-i18n` **estático** y no sirve acá porque
las cifras se interpolan.

> **ES** — *"En los 14 earnings de NVDA con salto ≥ +3%, MU cerró en la misma
> dirección 9 de 14 veces (64%) y promedió +1,8% contra +0,05% de un día
> cualquiera. Hay beta de evento, aunque no haya cointegración."*

> **EN** — *"Across NVDA's 14 earnings with a ≥ +3% move, MU closed the same way
> 9 of 14 times (64%), averaging +1.8% against +0.05% on an ordinary day. There
> is event beta, even without cointegration."*

Variante `sin_beta`:

> **ES** — *"En los 12 earnings de PEP con salto ≥ +3%, KO cerró en la misma
> dirección 5 de 12 veces (42%): no se distingue de un día cualquiera. No se
> mueve con PEP en eventos."*

Variante con `N` chico:

> **ES** — *"Descriptivo, no significativo (N=6): en los 6 earnings de PEP con
> salto ≥ +3%, KO cerró en la misma dirección 4 de 6 veces (67%)."*

Las cuatro plantillas (`beta_evento`, `arrastre_debil`, `sin_beta`,
`sin_datos`) × 2 idiomas × el modificador de N viven en `api/_lib/event-beta.js`
como funciones puras y tienen test directo (§9).

---

## 6. Caché y presupuesto

### 6.1 Earnings: reusar `pead_earnings`

Cero schema nuevo. La tabla tiene la forma exacta que hace falta, PK
`(symbol, reported_date)`, upsert idempotente ya probado, y está poblada.

| Paso | Regla |
|---|---|
| 1 | `select reported_date from pead_earnings where symbol = $X order by reported_date desc` |
| 2 | **Hit** si hay filas **y** `max(reported_date) > hoy − 100 días` → **0 llamadas a AV** |
| 3 | **Miss / stale** → `budgetUsed(hoy)` vs cap 25 → `fetchEarnings()` → `upsertEarnings()` → `budgetAdd(hoy, 1)` |
| 4 | **Cap agotado, hay caché** → sirve el caché con `stale: true` y `cached_through: 'YYYY-MM-DD'` |
| 5 | **Cap agotado, sin caché** → `no disponible — presupuesto de Alpha Vantage agotado hoy` |
| 6 | **Sin `DATABASE_URL`** → `no disponible — caché no configurado` (nunca revienta) |

**Los 100 días** salen de que un trimestre son ~91: con 100 se tolera un reporte
tardío sin re-pedir el símbolo en cada validación. Las fechas pasadas no cambian
—- lo único que expira es "¿ya reportó el trimestre nuevo?".

**Deuda de nombre, declarada:** la tabla se llama `pead_earnings` y PEAD está
retirado. Se reusa igual porque su semántica es exactamente *"historial de AV
`EARNINGS` por símbolo"*, no *"tabla del backtest PEAD"* — el `source` incluso es
`'alphavantage'`, no `'pead'`. Renombrarla exigiría migrar 99 símbolos de
historia por cosmética. Queda documentado acá y en la cabecera de
`api/_lib/event-beta.js` para que el siguiente que la lea no se confunda.

### 6.2 Caché CDN

```
Cache-Control: public, s-maxage=3600, stale-while-revalidate=21600
```

Una hora. La respuesta solo cambia cuando cierra una sesión nueva o entra un
trimestre nuevo; con 1h, un par consultado por varios usuarios cuesta **una**
bajada de Yahoo y **cero** consultas a Neon. Mismo idiom que `api/candles.js`
(`s-maxage` + `stale-while-revalidate` por perfil de frescura).

**Nota aparte:** `api/pairs-validator.js` hoy **no manda ningún header de
caché**. Se le agrega el mismo (`s-maxage=3600`) en este PR: mismos datos de
Yahoo, misma frescura, y no tiene sentido que la mitad de la pantalla se cachee
y la otra no.

### 6.3 Presupuesto de validaciones del usuario

La sección es una **segunda llamada dentro de la misma validación**, no una
validación nueva. El contador free (3/día) es del cliente y envuelve
`runPairsValidator()`, así que un `fetch` adicional dentro de esa corrida **no
descuenta**. El e2e lo verifica (`S4e` ya asserta `1/3` tras una corrida; la
nueva fase confirma que sigue siendo `1/3` con la sección activa).

---

## 7. Contrato del endpoint

`GET /api/event-beta?y=MU&x=NVDA&range=2y`

```jsonc
{
  "pair": { "y": "MU", "x": "NVDA" },
  "correlation": {
    "r_1y":   { "value": 0.62, "n": 252 },
    "r_full": { "value": 0.58, "n": 502, "range": "2y" },
    "same_window": false,              // true si range=1y → la UI pinta uno solo
    "unavailable": null                // o { reason: "…" }
  },
  "event_study": {
    "x_events_total": 41,              // eventos usables tras los descartes
    "window": { "from": "2016-08-27", "to": "2026-08-26", "range": "10y" },
    "hour_source": "assumed_amc",
    "dropped": { "no_next_session": 1, "no_price": 0,
                 "no_prior_close": 0, "out_of_window": 3 },
    "groups": [
      { "key": "UP",   "n": 14, "n_zero": 0, "significant": true,
        "c2c": { "hit_rate": 0.64, "avg": 0.018 },
        "o2c": { "hit_rate": 0.57, "avg": 0.009 } },
      { "key": "DOWN", "n": 9,  "n_zero": 0, "significant": false, "…": "…" },
      { "key": "ALL",  "n": 41, "…": "…" },
      { "key": "BASELINE", "n": 502, "significant": true,
        "c2c": { "hit_rate": null, "avg": 0.0005 },
        "o2c": { "hit_rate": null, "avg": 0.0002 } }
    ],
    "earnings_source": { "from": "cache", "cached_through": "2026-08-14",
                         "stale": false, "av_calls_spent": 0 },
    "unavailable": null
  },
  "verdict": { "tier": "beta_evento", "basis": "UP", "significant": true,
               "es": "En los 14 earnings de NVDA…", "en": "Across NVDA's 14…" },
  "config": { "…": "CRITERIOS congelados de §5" },
  "generated_at": "2026-08-27T03:24:00.000Z"
}
```

Los dos bloques (`correlation`, `event_study`) fallan **por separado**: Yahoo
puede responder y AV no, y entonces sale la correlación con el event study en
`unavailable`. La sección se pinta igual, con la mitad que sí hay.

---

## 8. Degradación — cada "no disponible" y su razón

Nunca un `500` genérico, nunca una sección vacía. Cada fallo tiene texto propio:

| Situación | `unavailable.reason` (ES) |
|---|---|
| Yahoo no devuelve serie de X o Y | `sin precios para {SÍMBOLO} (Yahoo no respondió)` |
| Menos de 30 retornos alineados | `solo {n} días en común; muy poco para una correlación honesta` |
| Sin `DATABASE_URL` | `caché de earnings no configurado` |
| Símbolo sin caché y cupo AV agotado | `presupuesto de Alpha Vantage agotado hoy ({used}/25)` |
| AV responde `rate_limited` | `Alpha Vantage rate-limitó la llamada; reintenta más tarde` |
| AV responde `empty` | `Alpha Vantage no tiene historial de earnings para {X}` |
| 0 eventos tras los descartes | `ningún earnings de {X} cae en la ventana de precios` |

Todas con su espejo en inglés. La razón se pinta en `var(--text3)` bajo el
encabezado de la sección — el usuario ve **por qué** no hay número, que es
información distinta de "no hay número".

---

## 9. Tests

### 9.1 Suite existente (`tests/event-beta.test.mjs`)

`tests/index.js` descubre los `*.test.mjs` solos. JS puro, sin red, sin DB.

- `logReturns()` — incluye el caso de precio no positivo.
- `pearson()` — contra un caso calculado a mano; `null` bajo `MIN_RET_CORR`.
- `alignReturns()` — intersección de fechas, huecos de sesión.
- `eventDay()` — la siguiente sesión; **D es la última sesión** → descartado;
  `E−1` inexistente → descartado; fin de semana / feriado entre D y E.
- `classifyEvent()` — frontera **exacta** en `±3.00%` (inclusiva, con la
  tolerancia de punto flotante de §4.4) y en `±2.999%`.
- `groupStats()` — `n`, `hit_rate`, `avg`; retorno 0 **no** cuenta como hit y
  suma a `n_zero`; `hit_rate = null` en `BASELINE`.
- `verdictLine()` — los 4 tiers × 2 idiomas, la selección de `basis` (UP → DOWN
  → ALL) y el modificador `N<10` antepuesto.
- `CRITERIOS` — congelado (`Object.isFrozen`) y con los valores de §5, para que
  moverlos rompa el test y no pase inadvertido.
- Regla de staleness de 100 días — hit / miss / borde exacto.
- Las 7 formas de `unavailable` de §8, en los dos idiomas.
- **Cero Claude**: el módulo no importa `./claude.js` ni menciona `anthropic`.

Gratis por herencia: `tests/no-hardcoded-dates.test.mjs` escanea `api/*.js` y
`api/_lib/*.js`, así que el módulo nuevo queda cubierto contra fechas tatuadas
sin tocar ese lint.

### 9.2 e2e (`e2e/run.mjs`)

Todo stubbeado en el router `**/api/**` (sin red, sin claves), como el resto.

| Check | Qué prueba |
|---|---|
| `MU / NVDA` → `RUIDO` + event-beta poblado | **la sección aparece aunque la Puerta A falle** — el punto entero de la feature |
| `KO / PEP` → `VENTAJA REAL` + grupo con N chico | aparece `descriptivo, no significativo` en esa fila |
| `BASELINE` presente en ambos | el contrafáctico se pinta, con `—` en hit rate |
| stub devuelve `{error:…}` | la sección **sigue presente** con "no disponible" + razón |
| contador free | sigue en `1/3` tras una validación con la sección activa |
| móvil 390×844 | `document.body.scrollWidth <= clientWidth` en los dos pares |

Los dos pares se eligieron a propósito: MU/NVDA da `RUIDO` con beta de evento
plausible (dos semis que reaccionan al mismo ciclo sin cointegrar), y KO/PEP da
un par válido cuyos saltos de ±3% son raros — ejercita el camino de N chico.

---

## 10. Limitaciones — lo que esta sección NO dice

Se pintan en el pie, no se esconden en este doc:

1. **No es causalidad.** Que Y se mueva con X el día del reporte de X no dice
   que X mueva a Y: pueden compartir un factor (ciclo de semis, tasas, el mismo
   ETF sectorial). La sección mide co-movimiento condicionado a un evento, nada
   más.
2. **Sin hora real, el día de evento puede estar corrido.** Un reporte BMO
   tratado como AMC mide la sesión siguiente a la reacción. El sesgo es
   conservador (§4.2) pero existe: diluye la señal, no la infla.
3. **Sin ajuste por múltiples comparaciones.** Se miran 2 grupos × 2 métricas.
   Con `N` chico, un 67% de hit rate en 6 eventos es folklore; por eso el
   modificador `N<10` es parte del veredicto y no una nota al pie.
4. **Ambos símbolos existen hoy.** Hay sesgo de supervivencia: nadie valida un
   par contra un ticker que ya no cotiza. Con un par elegido **a mano por el
   usuario** pesa mucho menos que en un backtest de universo, pero es real.

   **Por qué 10 años acá y ~3 en PEAD.** La regla dura de
   `docs/pead-backtest-scope.md` §2.2 exige un universo **point-in-time** para
   ir más atrás de ~3 años. Esa regla protege contra survivorship **de sección
   cruzada**: PEAD elige ~100 nombres por liquidez de HOY y los proyecta al
   pasado, así que la muestra misma está contaminada. Acá **no hay selección de
   universo**: el usuario escribe dos tickers y el estudio mide esos dos, sin
   ranking, sin filtro, sin canasta. El único residuo es el de arriba — que el
   usuario tiende a preguntar por nombres vivos — y no crece con la ventana.
   La regla §2.2 no aplica porque su mecanismo no está presente; **10 años es
   una decisión de potencia estadística (§4), no un rodeo a esa regla**, y se
   deja escrito acá para que nadie tenga que deducirlo del diff.
5. **No hay costos.** Los retornos son brutos. Esto es una lectura descriptiva,
   no un backtest de una estrategia operable — y la sección no promete otra cosa.
6. **10 años cruzan varios regímenes.** Un par de semis en 2016 no es el mismo
   negocio que en 2026. La ventana larga compra `N` a costa de homogeneidad; se
   eligió `N` porque sin él no hay nada que reportar.

### 10.1 Puerta abierta: la hora real

Existe `pead_event_hour` (BMO/AMC del 8-K Item 2.02, vía `api/_lib/pead-hour.js`).
**No se pudo verificar su cobertura sin acceso a Neon**, así que v1 va con AMC
parejo. El campo `hour_source: 'assumed_amc'` está en la respuesta desde el día
uno para que conectar la hora real sea un `left join` y un `if`, y para que la
diferencia entre las dos versiones sea medible en vez de invisible.

---

## 11. UI

### 11.1 Dónde

En `renderPairsResult()` (`app.html:1316`), **después** del bloque
`gateA + gateB + gateC` y **antes** del pie de `spread = Y − (α + β·X)…` —
o sea entre `app.html:1384` y `app.html:1385`. Encabezado con el mismo
`.section-header` / `.section-title` que `// El porqué · las 3 puertas`.

El front dispara `/api/event-beta` **en paralelo** con `/api/pairs-validator`:
las Puertas se pintan apenas llegan y la sección arranca con su esqueleto y un
`.loading`, que se rellena o se convierte en "no disponible". Ninguna de las dos
llamadas bloquea a la otra.

```
┌────────────────────────────────────────────────────────────┐
│ // LO QUE SÍ HAY · BETA DE EVENTO   ───────────────────────│
│                                                            │
│  ▎En los 14 earnings de NVDA con salto ≥ +3%, MU cerró en  │  var(--sans) 13px
│  ▎la misma dirección 9 de 14 veces (64%) y promedió +1,8%  │  borde acento por tier
│  ▎contra +0,05% de un día cualquiera. Hay beta de evento,  │
│  ▎aunque no haya cointegración.                            │
│                                                            │
│  ρ retornos 1a: 0.62      ρ ventana (2a): 0.58             │  flex-wrap, como β/α/z
│                                                            │
│  GRUPO             N   hit c2c  avg c2c  hit o2c  avg o2c  │
│  X sube ≥ +3%     14     64%    +1.8%     57%     +0.9%    │
│  X cae ≤ −3%       9*    67%    −2.1%     56%     −1.1%    │
│  Todos los evts   41     61%    +0.3%     54%     +0.1%    │
│  ─ Y, día cualq. 502      —     +0.05%     —      +0.02%   │  fila baseline, atenuada
│  * descriptivo, no significativo (N<10)                    │
│                                                            │
│  Supuesto: Alpha Vantage no da hora → after-close; día de  │  9px var(--text3)
│  evento = sesión siguiente. Precios ajustados por splits   │
│  y dividendos. La correlación es de RETORNOS; la           │
│  cointegración es de NIVELES — por eso esta sección vale   │
│  aunque falle la Puerta A. 3 eventos fuera de ventana.     │
│  Earnings AV, caché al 2026-08-14.                         │
└────────────────────────────────────────────────────────────┘
```

La fila `BASELINE` va visualmente separada (borde superior + `var(--text3)`): no
es un grupo de eventos, es la vara contra la que se leen los otros tres.

### 11.2 Móvil (390px) — la trampa real

**`body` tiene `overflow-x:hidden`.** El comentario de `app.html:1527` lo dice
sin rodeos: *"un grid que desborda deja el botón inalcanzable"*. Acá desbordar no
produce scroll — **borra contenido**.

Una tabla de 5 columnas numéricas no cabe: 5 × ~60px + etiqueta ~110px ≈ 410px
contra 390px de viewport.

| Problema | Fix |
|---|---|
| Tabla de 5 columnas a 390px | A `≤600px` **colapsa a tarjeta por grupo**: nombre + N arriba, mini-grid **2×2** debajo (hit c2c / avg c2c / hit o2c / avg o2c). Cero scroll horizontal. Sigue el idiom de la casa (`.sb-input-grid` **colapsa**, no scrollea) |
| El `row()` de las Puertas | **No se copia.** Usa `grid-template-columns:210px 1fr` inline; a 390px deja 180px para el valor. La sección nueva usa clase + media query |
| Franja de correlación | Ya es `flex-wrap:wrap` igual que la línea β/α/z → sirve tal cual |
| ≥601px | Tabla completa, con el look de `.sb-metric-table` (que ya tiene el idiom de resaltar una columna) |

### 11.3 Bug preexistente que se corrige en este PR

El grid de inputs de PARES es `grid-template-columns:1fr 1fr 110px auto`
**inline y sin media query** (`app.html:1198`): a 390px el botón `VALIDAR PAR` se
aplasta. SEÑALES ya tiene el fix. Se replica el idiom exacto de `.sb-input-grid`
(`app.html:1530`) como `.pv-input-grid`:

```css
.pv-input-grid{display:grid;grid-template-columns:1fr 1fr 110px auto;gap:8px;align-items:end;max-width:640px;}
@media(max-width:720px){
  .pv-input-grid{grid-template-columns:1fr 1fr;max-width:100%;}
  .pv-input-grid>div:last-child{grid-column:1 / -1;}
  .pv-input-grid>div:last-child button{width:100%;padding:10px 14px;}
}
```

Entra en el alcance por decisión explícita: la sección nueva obliga a probar la
página en móvil, y dejar el input roto al lado de una sección responsive nueva
sería raro.

---

## 12. Archivos

| Archivo | Qué |
|---|---|
| `api/_lib/event-beta.js` | **nuevo** — matemática pura + `CRITERIOS` + plantillas i18n. Sin I/O, todo testeable |
| `api/event-beta.js` | **nuevo** — handler: Yahoo + caché de earnings + presupuesto AV + shaping + `Cache-Control` |
| `api/pairs-validator.js` | + header `Cache-Control` (§6.2). La matemática de las Puertas **no se toca** |
| `app.html` | `renderPairsResult()` + sección; `.pv-ev-*` CSS; `.pv-input-grid` (§11.3); fetch paralelo |
| `tests/event-beta.test.mjs` | **nuevo** — §9.1 |
| `e2e/run.mjs` | stub de `/api/event-beta` + las fases MU/NVDA y KO/PEP (§9.2) |
| `scripts/event-beta-probe.mjs` | **nuevo** — el smoke de §2, 1 request de AV |
| `docs/pairs-event-beta-scope.md` | este doc |

**Nada nuevo en Neon:** se reusan `pead_earnings` y `pead_api_budget`
(`api/_lib/pead-db.js`). Cero migraciones.

---

## 13. Referencias

- `api/pairs-validator.js` — las 3 Puertas (Engle-Granger + ADF, OU, re-test OOS)
- `api/_lib/yahoo-daily.js` — precios ajustados (splits **y** dividendos); la
  cabecera documenta la trampa del open sin ajustar
- `api/_lib/av-earnings.js` — `parseEarnings()` / `fetchEarnings()`, incluida la
  trampa del rate limit con HTTP 200
- `api/_lib/pead-db.js` — `pead_earnings`, `pead_api_budget`, `budgetUsed/Add`,
  `upsertEarnings`, `dedupeByReportedDate`
- `api/_lib/pead-universe.js` — los 99 nombres ya cosechados
- `docs/pead-backtest-scope.md` §1.4-1.5 (AV: campos, profundidad, sin hora),
  §2.2 (universo de hoy), :498 (regla AMC congelada)
- `docs/wheel-fase0.md` §0 (precedente del 403), §4.3 (ledger 99/99, cupo libre)
- `docs/alpaca-paper-scope.md:195` (*"el smoke en Vercel es el único gate real"*)
- `app.html:3556` (`smL`), `app.html:10196` (`t`), `app.html:1530`
  (`.sb-input-grid`, el idiom móvil)
