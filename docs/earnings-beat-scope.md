# SCOPE — Experimento "earnings-beat": ¿QuantDesk le gana a Polymarket?

> **Estado: FASE 0 (censo + smoke).** Entregado: este documento y
> `/api/earnings-beat?smoke=1`. **Cero código de modelo** — no hay una línea de
> regresión en el repo y no la va a haber hasta que la Fase 0 pase. Los
> criterios de la Fase 2 ya están **congelados en código**
> (`CRITERIOS` en `api/_lib/earnings-beat.js`, fijados sin haber visto un solo
> dato) y **pineados por test** (`tests/earnings-beat.test.mjs`): mover una
> portería después rompe un test y se ve en el diff.
>
> Mismo patrón que el PEAD (`docs/pead-backtest-scope.md`): validación primero,
> agente después. Si no hay ventaja, se descarta y no se escribe el agente.

## Hipótesis

Para un reporte trimestral de EPS, un modelo simple alimentado con el historial
de sorpresas de la empresa (y de sus pares del mismo sector que ya reportaron
esta temporada) predice **beat/miss** mejor que el precio que Polymarket le
pone al mismo evento 24 horas antes de que resuelva.

**Hipótesis nula (H0):** el precio de Polymarket a T-24h ya incorpora todo lo
que sabe un modelo de historial + pares. El Brier del modelo no le gana al del
mercado, y cualquier diferencia se la come el costo de operar (3% por apuesta).
→ No hay negocio.

Las dos preguntas se miden **por separado** y en este orden, porque son dos
cosas distintas y se pueden fallar independientemente:

1. **Lectura** — ¿el modelo le gana al baseline barato ("tasa histórica de
   beats de esta empresa")? Si no, el modelo no aporta nada aunque el mercado
   sea malo.
2. **Ventaja (edge)** — ¿el modelo le gana al **mercado**, y ese margen
   sobrevive al costo? Ésta es la que decide GO.

---

## FASE 0 — Censo + smoke

### 0.1 Lo que NO se pudo verificar desde acá, dicho de frente

El censo de la API de Polymarket **no se corrió desde el sandbox del agente**:
la política de egreso del entorno contesta `403` al CONNECT hacia
`gamma-api.polymarket.com` (registrado en el proxy como
`connect_rejected … policy denial`). O sea que **ningún campo, endpoint ni
límite de esta sección está verificado desde acá**.

Eso no es un obstáculo del encargo: el encargo pedía explícitamente que el
smoke corriera **desde Vercel y no desde el sandbox**, por la misma razón por
la que el G3 del Congreso se midió desde el runner de GitHub y no desde una
laptop — una IP de datacenter puede recibir otro trato que una residencial, y
la pregunta útil es "¿se ve desde donde va a vivir el cron?".

Consecuencia de diseño, y es la decisión central de esta fase: **el endpoint
del smoke no asume el esquema de la API, lo descubre y lo reporta.**

- Sondea **varias** estrategias de consulta y publica lo que contestó cada una
  (`status`, `http`, `ms`, filas, y **las claves reales de la primera fila**).
- Publica `esquema_observado.claves_mas_frecuentes`: los nombres de campo que
  Polymarket manda de verdad, con su frecuencia.
- Un endpoint que contesta 404 es un **hecho del censo**, no un crash.

Lo que sigue en §1.1 son por lo tanto **hipótesis a verificar por el smoke**,
marcadas como tales. Fuente caída = declarada, nunca inventada.

### 0.2 Las cuatro preguntas de la Fase 0

| # | Pregunta | Quién la contesta |
|---|---|---|
| 1 | ¿Se pueden listar mercados de earnings **resueltos** con símbolo, fecha de resolución, consenso EPS y outcome? | `?smoke=1` → `conteos` + `muestras` |
| 2 | ¿Se puede bajar el **historial de precios del token "Yes"** y leer el precio a T-24h? | `?smoke=1` → `ejemplos[].yes_t24h` |
| 3 | ¿Cuántos de esos mercados **cruzan** con `pead_earnings` (símbolo + fecha ±1 día) y cuántos caen en nuestro universo? | `?smoke=1` → `cruce` |
| 4 | ¿Existe fuente **gratis y point-in-time** de revisiones de estimados? | `?smoke=1` → `revisiones` |

### 1.1 Censo de la API pública de Polymarket (hipótesis del smoke)

Son **dos** APIs distintas y confundirlas es la trampa principal:

| API | Base | Para qué | Qué se le pide |
|---|---|---|---|
| **Gamma** | `gamma-api.polymarket.com` | catálogo: qué mercados existen | `/markets`, `/events` |
| **CLOB** | `clob.polymarket.com` | precios: serie del token | `/prices-history` |

**Hipótesis de esquema (Gamma `/markets`)** — lo que el smoke va a confirmar o
desmentir campo por campo:

| Campo esperado | Para qué lo necesita el estudio | Si no viene |
|---|---|---|
| `question` / `slug` | detectar que es de earnings y sacar el símbolo | sin símbolo no hay cruce → NO-GO |
| `description` | **el consenso EPS que Polymarket declara** | el consenso queda solo como proxy de AV (§2.3) |
| `endDate` / `closedTime` | fecha de resolución (ancla del T-24h y del cruce) | sin fecha no hay T-24h → NO-GO |
| `outcomes` + `outcomePrices` | outcome resuelto (1/0) | sin outcome no hay etiqueta → NO-GO |
| `clobTokenIds` | token del "Yes" para pedirle la serie al CLOB | sin token no hay precio de mercado → NO-GO |
| `closed` / `umaResolutionStatus` | separar resuelto de en disputa | se infiere de `outcomePrices` |

**Trampa de formato ya contemplada:** Gamma manda varios de esos campos como
**string con JSON adentro** (`outcomes: "[\"Yes\", \"No\"]"`). `normalizaMercado()`
tolera las dos formas y hay test con fixture para eso. Si llegara ya como array,
no cambia nada.

**Auth:** hipótesis = los dos endpoints de lectura son **públicos** (la firma
L1/L2 es para operar, no para leer). El smoke clasifica `401/403` como status
`auth` y lo reporta: si aparece, es un hallazgo de Fase 0, no un error.

**Rate limits:** no se asume ninguno. El smoke captura **todos** los headers
que matcheen `x-ratelimit*` / `retry-after`, cuenta los `429` del barrido y los
publica en `rate_limit`. Si Polymarket no publica presupuesto, la Fase 1 fija
cadencia conservadora y la mide con 429s — no con un número inventado.

**Cobertura del barrido:** Gamma se pagina (`limit`/`offset`). El smoke corta
por tope de páginas o por presupuesto de tiempo y **declara `truncado` con su
motivo**. Un barrido truncado da un **piso**, no un total, y el markdown lo dice
en letras. Esto importa para el candado de ≥100 mercados: un piso de 60 no es
"hay 60", es "vi 60".

**Corte temprano por fecha:** solo si el orden descendente se sostuvo página a
página (`orden_desc_confirmado`). Si el servidor ignora `order`, cortar por
fecha se comería mercados buenos en silencio.

**Dos conteos que se cuidan aparte**, porque los dos pueden falsear un candado:
`duplicados_descartados` (el mismo mercado en dos páginas, si la paginación se
corre mientras cierran mercados — inflaría el total) y
`sin_fecha_de_resolucion` (mercados de earnings cuya fecha no se pudo leer:
**no se descartan** —se verían como inexistentes— pero quedan fuera del cruce y
de los ejemplos por su cuenta).

### 1.2 Precio del "Yes" a T-24h (CLOB)

`/prices-history` por token, con dos formas de parámetros probadas en orden
(`startTs`/`endTs`/`fidelity` y, si falla, `interval=max`); el smoke reporta
**cuál funcionó**.

La regla de lectura es la única parte que no se negocia:

> Se toma el **último tick con `t ≤ resolución − 24h`**. Nunca uno posterior.

Un tick posterior sería el precio del futuro y mata el estudio entero. Está
testeado con fixture (`precioEnT24h`: un historial donde el tick de 23h es más
atractivo y **no** se elige). Dos casos más, reportados y no barridos:

- `sin_ticks_antes_de_t24h` → ese mercado **no entra**. Un mercado que recién
  abrió el día del reporte no tiene precio a T-24h, y rellenarlo sería inventar.
- `rancio` → hay tick previo pero es mucho más viejo que T-24h
  (> 24h + 12h de tolerancia). **Sí entra**, marcado: en un mercado ilíquido el
  "precio a 24h" existe pero no dice lo que uno cree.

### 1.3 Cruce con la cosecha del PEAD

**Corrección de nomenclatura:** el encargo dice `pead_events`; esa tabla no
existe. La tabla real es **`pead_earnings`** (`api/_lib/pead-db.js`), con PK
`(symbol, reported_date)`. Y el universo v0 del PEAD tiene **99** símbolos, no
98 (`api/_lib/pead-universe.js` — contados, no estimados).

El cruce es por **símbolo + fecha ±1 día** (`CRITERIOS.tolerancia_dias_cruce`),
con el candidato más cercano cuando hay varios. La tolerancia no es cosmética:
la **fecha de resolución del mercado no es la fecha del reporte** — un mercado
AMC suele resolver al día siguiente.

Se reportan tres números distintos, que responden tres preguntas distintas:

- `mercados_de_earnings_en_ventana` — cuántos hay (piso, si truncó).
- `cruzados` — cuántos casan con una fila de `pead_earnings`.
- `en_universo_v0` — cuántos de ésos caen en nuestros 99 símbolos.

**Dependencia declarada:** si la cosecha del PEAD no corrió, `pead_earnings`
está vacía y el cruce da 0 **por falta de datos nuestros, no de Polymarket**.
El smoke publica `cruce.filas_pead` justamente para que esa distinción sea
visible y no se lea como un NO-GO de la fuente externa.

**Resolución de símbolo — limitación conocida.** Hoy sale del texto
(`$TICKER` / `(TICKER)` explícito → alias de nombre comercial → symbol map de
Finnhub recortado al universo). Un nombre corto adentro de uno largo
("Meta" dentro de "Meta Materials") no se puede desambiguar desde el texto, así
que esos mercados salen marcados `symbol_ambiguo` y se cuentan aparte. Si el
`esquema_observado` del smoke revela un campo de ticker en Gamma, la Fase 1 lo
usa y esta heurística se retira.

### 1.4 Revisiones de estimados: la regla se fijó ANTES de probar

Regla dura, congelada en `evaluaFuentePIT()` y testeada:

> Una fuente sirve para revisiones **solo si** da (a) una **fecha de corte por
> estimado** y (b) **más de un valor para el mismo período** con fechas de corte
> distintas.

Un endpoint que devuelve "el estimado de **hoy**" para trimestres futuros **no
es point-in-time**: no permite saber qué se creía *antes* del reporte, que es
exactamente lo que el modelo usaría. Aceptarlo sería meter look-ahead por la
puerta de atrás.

El smoke sondea Finnhub (`/stock/eps-estimate`, `/stock/revision`) y Alpha
Vantage (`EARNINGS_ESTIMATES`) con las keys reales del entorno y reporta
`status` / `http` / `pit` / motivo. Detecta además la trampa conocida de AV:
rate-limit y premium vienen como **HTTP 200** con `{"Note"|"Information"}`, no
como 429 (`api/_lib/av-earnings.js`).

> **Si ninguna fuente cumple la regla, las revisiones quedan FUERA de v1** y se
> documenta acá con el resultado de la sonda. **No se inventa proxy**: "cambio
> del estimado actual contra el reportado" no es una revisión, es aritmética
> contaminada con el resultado.

### 1.5 Uso del smoke

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://quantdesk2.vercel.app/api/earnings-beat?smoke=1" | jq
# resumen en español, se abre directo en el navegador:
#   /api/earnings-beat?smoke=1&format=md&secret=<CRON_SECRET>
# opcionales: &meses=12 · &desde=YYYY-MM-DD · &paginas=20 · &ejemplos=3
```

La ventana por defecto es **12 meses hacia atrás calculados en runtime**, que
cubre "desde septiembre del año pasado" sin tatuar la fecha en el código (lint
`tests/no-hardcoded-dates.test.mjs`). Para la fecha exacta del encargo:
`&desde=2025-09-01`.

**Garantías del endpoint** (mismo patrón que `/api/pead-analyze`):

- **Cero writes a Neon.** Un solo `SELECT` sobre `pead_earnings`. **No** llama a
  `ensurePeadSchema()` (haría `CREATE TABLE`) ni a `beat()` — latir acá
  enmascararía un cron muerto, y todavía no hay cron.
- **Gate `CRON_SECRET`** por header o por `?secret=` (para abrir el markdown en
  el navegador). Respuesta `no-store`.
- **`maxDuration = 300`** + presupuesto interno de 240s: si se acaba, **trunca y
  lo declara**; no muere en 504.
- El lib de lectura (`_lib/earnings-beat.js`) es **puro**: sin `fetch`, sin DB.
  Los tests corren con fixtures, **nunca con red**.

### 1.6 Compuerta de la Fase 0 (GO / NO-GO / INCONCLUSO)

Se lee el censo contra esto. **El censo reporta; no se auto-aprueba.**

| Resultado | Condición |
|---|---|
| **GO a Fase 1** | Gamma y CLOB contestan sin auth, hay mercados de earnings resueltos en la ventana con outcome legible y token del Yes, **y** al menos un ejemplo trae precio del Yes a T-24h. |
| **INCONCLUSO** | El barrido truncó y el piso de mercados no alcanza para proyectar ≥100 cruzados; o `pead_earnings` está vacía (cruce no medible todavía). → se re-corre con `&paginas` mayor o después de la cosecha del PEAD. |
| **NO-GO** | Falta estructuralmente algo: sin `clobTokenIds`, sin fecha de resolución, sin outcome, o la lectura exige auth de pago. |

Las revisiones PIT **no** deciden esta compuerta: su resultado define si el
feature entra a v1 o queda fuera documentado.

---

## FASE 1 — Cosecha (solo tras GO de Fase 0)

Cron diario, gate `CRON_SECRET` + `EARNINGS_BEAT_ENABLED=1`, heartbeat
`beat('earnings-beat:harvest')` — igual que `pead-harvest`, para que
`/api/cron-status` marque en rojo un cron muerto.

```sql
-- Un renglón por mercado de earnings resuelto. La PK hace el upsert idempotente.
create table if not exists pm_earnings_markets (
  market_id      text primary key,       -- id de Gamma
  slug           text,
  symbol         text,                   -- resuelto en la cosecha, con su vía
  symbol_via     text,                   -- 'ticker' | 'alias' | 'symbol_map'
  report_date    date,                   -- reported_date de pead_earnings al cruzar
  resolved_date  date,                   -- fecha de resolución del mercado
  consensus_pm   numeric,                -- el consenso que Polymarket DECLARA
  outcome        text,                   -- 'yes' | 'no'
  yes_price_t24h numeric,                -- último tick ≤ resolución − 24h
  yes_price_ts   timestamptz,            -- CUÁNDO fue ese tick (rancio auditable)
  volume         numeric,
  question       text,
  raw            jsonb,                  -- el mercado crudo: el esquema cambia
  ingested_at    timestamptz not null default now()
);
```

Reglas de la cosecha:

- **Idempotente**: upsert por `market_id`; re-correr no duplica ni pisa un
  precio ya capturado con uno peor.
- **Solo mercados resueltos**: un mercado vivo no tiene outcome y no entra.
- **`yes_price_t24h` se guarda con su timestamp**: sin el `ts`, "precio a 24h"
  no es auditable y no hay forma de detectar el rancio después.
- **`raw` completo**: el esquema de Gamma puede cambiar; guardar el crudo evita
  re-cosechar cuando aparezca un campo que hoy no miramos.
- **Cadencia**: conservadora y medida con 429s, según lo que reporte `rate_limit`
  en el censo.

---

## FASE 2 — Análisis (criterios congelados ANTES de ver los datos)

Endpoint `/api/earnings-beat-analyze?format=md&secret=…`, **SELECT-only**,
`maxDuration = 300`. Mismo contrato que `/api/pead-analyze`.

### Modelo v1

Logística simple. **Solo features calculables con datos anteriores a
`report_date`** — ésa es la regla que hace válido todo lo demás:

| Feature | Fuente | Nota |
|---|---|---|
| Tasa de beats de los últimos 8 trimestres | `pead_earnings` | solo trimestres con `reported_date < report_date` |
| Racha actual de beats/misses | `pead_earnings` | idem |
| Sorpresa % promedio | `pead_earnings` | idem |
| Pares: % de beats de empresas del **mismo sector Finnhub** que ya reportaron antes en la misma temporada (mismo mes calendario) | `pead_earnings` + sector de Finnhub | solo empresas con `reported_date < report_date` |
| Revisiones de estimados | — | **solo si la Fase 0 encontró fuente PIT.** Si no: fuera, documentado |

### Partición temporal

- Entrena: eventos con `reported_date ≤ 2023-08-31`.
- Prueba (OOS): `> 2023-08-31` → hoy.

Ese corte es, a propósito, el mismo punto donde arranca la ventana de ~3 años
del PEAD (`docs/pead-backtest-scope.md` §FASE 2). **Precisión honesta:** el PEAD
no usa partición entrena/prueba —usa una ventana de ~3 años—, así que "mismo
corte que PEAD" significa *el mismo instante de calendario*, no la misma
mecánica.

**Consecuencia estructural que conviene ver desde ahora:** los mercados de
Polymarket son recientes, así que **todos** los eventos cruzados caen del lado
OOS del corte. La comparación contra el mercado es out-of-sample por
construcción — y el candado de ≥100 mercados es el que decide si esa muestra
alcanza.

### Baselines obligatorios

1. **"Siempre sí"** — predice beat con probabilidad = tasa base global.
2. **"Tasa histórica por empresa"** — la tasa de beats de esa empresa hasta
   `report_date`. Éste es el que el modelo tiene que batir para que la Fase 2
   tenga "lectura".

### Consenso y la etiqueta "frontera"

Nuestra etiqueta de beat/miss sale de `estimatedEPS` de Alpha Vantage.
**Polymarket resuelve contra SU consenso**, declarado en la descripción del
mercado. No son la misma cosa y no se van a fingir iguales:

- Cuando el mercado declara consenso, se guarda en `consensus_pm` y se reporta
  la **discrepancia** contra AV.
- Los beats/misses de **≤ $0.01** se etiquetan **"frontera"** y se reportan
  **aparte**: ahí es donde las dos definiciones se separan y un "acierto" puede
  ser un artefacto de qué consenso usó cada quien.
- La especificación principal los **incluye** (sacarlos sería elegir la muestra
  después de verla); el corte sin ellos va como sensibilidad obligatoria.

### Criterios de éxito (CONGELADOS — `CRITERIOS` en `api/_lib/earnings-beat.js`)

**Candados (si no, INCONCLUSO, no "casi"):**

1. **≥ 100 mercados cruzados con precio del Yes a T-24h.** No es "≥100
   mercados": es ≥100 con las dos cosas (cruce **y** precio), porque un mercado
   sin precio a T-24h no puede comparar contra el mercado.
2. **≥ 30 apuestas** en la simulación. Con menos, el neto es ruido con forma de
   resultado.

**Lectura:**

3. Brier del modelo **<** Brier de "tasa histórica por empresa", **en OOS**.

**Ventaja (edge) — las dos, no una:**

4. Brier del modelo **<** Brier del precio de Polymarket a T-24h, **en OOS**.
5. Simulación: se apuesta **solo** cuando `|modelo − mercado| ≥ 15 pts`, costo
   **3% por apuesta**, ≥30 apuestas, **neto > 0**.

**Veredicto: GO / NO-GO / INCONCLUSO** contra esos umbrales, con **una sola
especificación principal**. Todo corte extra va etiquetado **EXPLORATORIO** y
**no cuenta** para el veredicto.

**Lo que se reporta pero NO decide:** intervalo bootstrap de la diferencia de
Brier, curva de calibración, y el desglose frontera / no-frontera. Sirven para
interpretar el resultado; no lo cambian. Con ~100 eventos, una diferencia de
Brier chica puede ser ruido, y el intervalo está justamente para que eso se vea
en vez de celebrarse.

---

## Reuso vs net-new

**Reutilizable del repo:**

- `pead_earnings` + el goteo de AV — `api/_lib/pead-db.js`, `api/pead-harvest.js`
- universo v0 (99 símbolos) — `api/_lib/pead-universe.js`
- symbol map de Finnhub (nombre por ticker) — `api/earnings.js` (`getSymbolMap`)
- sector de Finnhub para los pares — `api/_lib/finnhub-dive.js`
- patrón de endpoint SELECT-only + gate + `format=md` — `api/pead-analyze.js`
- heartbeat de crons — `api/_lib/heartbeat.js`
- la trampa de AV (200 + `Note` = rate limit) — `api/_lib/av-earnings.js`

**Net-new (no existía):**

- frontera de red con Polymarket — `api/_lib/polymarket.js`
- lectura pura del censo — `api/_lib/earnings-beat.js`
- censo/smoke — `api/earnings-beat.js`
- tabla `pm_earnings_markets` + su cron (Fase 1)
- `/api/earnings-beat-analyze` (Fase 2)

## Fuera de v1 / backlog

- **Revisiones de estimados**, salvo que la sonda de la Fase 0 encuentre fuente
  PIT gratis. Sin proxy inventado.
- **Mercados de earnings fuera de nuestro universo**: se cuentan en el censo,
  pero el modelo v1 solo puede opinar de símbolos con historial cosechado.
- **Operar de verdad.** Esto es validación. Si hay GO, el paso siguiente es otra
  discusión (y otro libro), no un agente automático.
- **Múltiples horizontes de precio** (T-1h, T-7d). v1 mide T-24h porque es el
  encargo; el resto sería barrido de parámetros y aquí todavía no se barre nada.

---

## Archivos

| Archivo | Qué |
|---|---|
| `api/_lib/polymarket.js` | Frontera de red: Gamma + CLOB. Clasifica respuestas, no lanza. |
| `api/_lib/earnings-beat.js` | Lógica pura: `CRITERIOS` congelados, normalización, símbolo, consenso, T-24h, cruce, regla PIT, resumen en español. |
| `api/earnings-beat.js` | Endpoint del censo (`?smoke=1`): sondas, barrido, ejemplos, cruce, sondas de revisiones. |
| `tests/earnings-beat.test.mjs` | Fixtures, **sin red**. Incluye el pineo de los `CRITERIOS`. |
