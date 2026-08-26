# FASE 0 — Wheel / Covered Calls: viabilidad de datos

> **Alcance de este documento:** SOLO viabilidad de datos. No hay diseño de
> backtest acá — si el veredicto habilita seguir, la Fase 1 arranca de la lista
> de decisiones a congelar (§7). Nada de libs compartidas fue tocado.
>
> **Veredicto: VIABLE CON RECORTE**, con **una compuerta binaria abierta (G0)**
> que se cierra con 3 requests reales — ver §0 y §6.

**Pregunta única.** ¿Existe una fuente accesible de cadenas de opciones
**históricas** (strikes, expiraciones, bid/ask o premiums, idealmente con
volumen/OI) suficiente para backtestear covered calls **semanales** sobre
acciones US líquidas?

**Respuesta corta.** Sí, existe y es barata en requests — pero **no** con la
holgura que sugiere el free tier de Alpha Vantage. Las dos candidatas reales
(AV `HISTORICAL_OPTIONS` y Market Data `options/chain?date=`) tienen cada una un
techo distinto: AV puede estar **cerrada por paywall** en free (G0, sin
verificar), y Market Data free tiene un **techo duro de 12 meses** de lookback.
El presupuesto de requests **no** es el cuello de botella que parecía: lo es la
**ventana histórica**, y con ella la **cobertura de regímenes**, que es lo que
decide si el backtest dice algo o no (§5).

---

## 0. Aviso de honestidad: el sondeo en vivo NO se pudo hacer

Se pidió sondear AV de verdad con 2-3 requests y documentar payloads reales.
**No fue posible desde este entorno** y no se rodeó el bloqueo:

```
$ curl "https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=IBM&apikey=demo"
curl: (56) CONNECT tunnel failed, response 403

$ curl "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.alphavantage.co:443" } ]
```

Mismo 403 para `query2.finance.yahoo.com`, `www.marketdata.app` y
`www.dolthub.com`. Es **exactamente el precedente ya documentado en la casa**:
`docs/alpaca-paper-scope.md:195` — *"Verificado hoy que el sandbox de desarrollo
no puede pegar a Alpaca (proxy 403) — el smoke en Vercel es el único gate
real"*. Además, la key de AV vive en Vercel (`ALPHAVANTAGE_API_KEY`, la usa
`api/movers.js:181`), no en este sandbox.

**Consecuencia para este memo:** todo lo que sigue sobre *campos y profundidad*
de AV/Market Data es **esquema documentado, no verificado en vivo**, y está
marcado como tal. Lo que **sí** es duro y no depende de ningún sondeo es la
matemática de presupuesto (§4) y el análisis de potencia (§5) — que es donde se
decide el veredicto.

**Entregable que cierra el hueco:** `scripts/wheel-phase0-probe.mjs` (sin
dependencias, mismo patrón que `scripts/pead-phase0-probe.mjs`). Corre 3-6
requests, guarda los payloads crudos en disco e imprime el veredicto de G0.
Se corre donde haya egress y key:

```
ALPHAVANTAGE_API_KEY=xxx node scripts/wheel-phase0-probe.mjs
# opcional, la candidata #2:
MARKETDATA_TOKEN=yyy node scripts/wheel-phase0-probe.mjs
```

El probe gasta 3-4 requests de las 25/día de la key. Con PEAD retirado (§4.3)
el cupo está libre, así que no compite con nada — pero conviene correrlo el
mismo día que arranque la cosecha, no en medio de ella.

---

## 1. Fuente (1) — Alpha Vantage `HISTORICAL_OPTIONS`

### 1.1 Qué promete la documentación

| Ítem | Lo documentado |
|---|---|
| Unidad de request | **1 request = 1 símbolo × 1 fecha = la cadena COMPLETA de ese día** (todas las expiraciones, todos los strikes, calls y puts) |
| Parámetro de fecha | `date=YYYY-MM-DD`; sin él devuelve la sesión previa. Acepta cualquier fecha desde 2008-01-01 |
| Profundidad | **15+ años** |
| Campos | strike, expiration, type, bid, ask, last, mark, volume, open interest, **implied volatility y greeks (delta, gamma, theta, vega, rho)** |
| Orden | por expiración cronológica; dentro de cada una, strike de menor a mayor |
| Letra chica conocida | la `implied_volatility` **no es confiable con DTE ≤ 3 días** |

Si eso es cierto en free, es la fuente ideal para este backtest: **una sola
llamada por fecha te da todos los strikes y todas las expiraciones**, así que
un mismo snapshot sirve para probar Δ0.20 y Δ0.30, 7 DTE y 30 DTE, sin gastar
un request extra. El presupuesto se cuenta en **símbolo-fecha**, no en contrato.

### 1.2 G0 — la compuerta binaria abierta (riesgo #1 del proyecto)

Las fuentes secundarias **se contradicen** sobre si `HISTORICAL_OPTIONS` está
disponible en el free tier:

- Una lectura: *"el free tier tiene acceso a datos históricos de opciones;
  premium es para realtime"* (consistente con que `REALTIME_OPTIONS` sí está
  marcado premium).
- La otra: *"`HISTORICAL_OPTIONS` requiere premium de 600 o 1200 req/min; las
  cuentas free reciben **datos placeholder** en vez de datos reales"*, con
  centinelas del tipo `XXYYZZ` / `2099-99-99`.

**No se puede resolver leyendo. Se resuelve con 1 request.** Y ojo con la trampa
que la casa ya tiene documentada en `api/_lib/av-earnings.js:6-10`: **AV no
devuelve 429 cuando te corta — devuelve HTTP 200 con `{"Note"...}` /
`{"Information"...}`**. Si además ahora devuelve placeholders con forma de
cadena válida, un harvest ingenuo **cosecharía basura durante dos semanas sin
enterarse**. Por eso el probe valida tres cosas por separado: (a) no es
`Note`/`Information`; (b) `data[]` tiene largo > 0; (c) **los valores no son
centinelas** (`contractID` con `XXYYZZ`, `expiration` en 2099, bid/ask todos en
0, strikes idénticos).

**Regla de decisión de G0** (pre-registrada, la aplica el probe):

| Resultado del probe | Lectura |
|---|---|
| `data[]` poblado, bid/ask > 0, strikes plausibles alrededor del spot, ≥2 expiraciones semanales | **G0 PASA** → AV free es fuente primaria |
| `Note`/`Information` con las 25 diarias sin gastar | rate-limit o **paywall disfrazado** → reintentar 1 vez al día siguiente; si repite, **G0 FALLA** |
| `data[]` con centinelas / bid=ask=0 / 1 sola expiración fantasma | **G0 FALLA** — placeholder. AV free queda descartada |
| HTTP 200 con `{}` o `data: []` para fechas hábiles conocidas | **G0 FALLA** |

### 1.3 Payloads

**PENDIENTES — no se pudieron capturar (§0).** El probe los deja en
`.wheel-phase0/av-<symbol>-<fecha>.json` y este es el hueco exacto que hay que
pegar acá antes de dar la Fase 0 por cerrada:

```jsonc
// docs/wheel-fase0.md §1.3 — PEGAR AQUÍ el payload real (primeros 2 contratos)
{
  "endpoint": "Historical Options",
  "message":  "success",
  "data": [ /* ← 1 objeto por contrato; copiar 2 verbatim */ ]
}
```

La forma **documentada** de cada elemento de `data[]` (esquema, **no**
verificado) es un objeto plano por contrato con: `contractID`, `symbol`,
`expiration`, `strike`, `type`, `last`, `mark`, `bid`, `bid_size`, `ask`,
`ask_size`, `volume`, `open_interest`, `date`, `implied_volatility`, `delta`,
`gamma`, `theta`, `vega`, `rho`. **Los campos que el backtest necesita de
verdad son 6**: `expiration`, `strike`, `type`, `bid`, `ask`, `date`. Volumen,
OI y greeks son deseables (filtro de liquidez y selección por delta), pero
**no son load-bearing**: si faltan greeks, se selecciona strike por moneyness
fija en vez de por delta (§7, decisión D3).

---

## 2. Fuente (2) — Yahoo: confirmado, **solo cadena actual**

No hace falta salir del repo para confirmarlo: **ya tenemos la integración**.
`api/options.js` pega a `https://queryN.finance.yahoo.com/v7/finance/options/{ticker}`
y su propio encabezado lo dice (`api/options.js:12-14`):

> *"Honestidad: es la **EXPIRACIÓN MÁS CERCANA** (front expiry), no todo el
> tablero. (…) **Sin histórico de IV no inventamos "IV percentile"**."*

El endpoint v7 acepta `?date=<epoch>` pero eso selecciona **una expiración
futura**, no una **fecha de observación pasada**: devuelve siempre la foto de
**hoy**. No hay parámetro de as-of. El ecosistema (yfinance y derivados)
confirma lo mismo: solo snapshot de la cadena vigente, y bid/ask solo poblados
en horario de mercado.

**Veredicto Yahoo: NO SIRVE como fuente de cadenas históricas.** Sospecha
confirmada. Sigue siendo la fuente de **subyacente** (ver §7, D8: `api/candles.js`
para OHLC crudo — cuidado con el ajuste por dividendos).

Lo único que Yahoo habilitaría es **construir historia hacia adelante**
(snapshot diario a Neon desde hoy). Eso es un año de espera antes del primer
backtest: **no es una opción para la Fase 0**, es un plan B de fondo que
conviene arrancar igual si el proyecto sigue vivo (cuesta un cron y cero
requests de presupuesto).

---

## 3. Fuente (3) — alternativas, con la letra chica

Ordenadas por qué tan cerca están de resolver el problema hoy.

### 3.1 Market Data (`marketdata.app`) — **la candidata que puede reemplazar a AV**

| Ítem | Dato |
|---|---|
| Endpoint | `GET /v1/options/chain/{symbol}/?date=YYYY-MM-DD` — cadena histórica as-of |
| Free tier | **"Free Forever" = 100 créditos/día** (contador resetea 9:30 ET) |
| Costo en créditos (histórico) | **1 crédito por cada 1000 contratos devueltos** ← clave |
| Profundidad del dataset | cadenas hasta **2005** |
| **Techo del free tier** | ⚠️ **no se puede pedir data de más de 1 año de antigüedad** |
| Delay | ≥24 h (irrelevante para backtest) |
| Campos | bid, ask, mid, last, volumen, OI, IV y greeks |

**Por qué importa el modelo de créditos:** si pedís la cadena completa sin
filtrar de un nombre líquido podés pasar los 1000 contratos y gastar 2-3
créditos; si filtrás por expiración + `side=call` + ventana de strikes, un
snapshot cuesta **1 crédito**. Es decir: **~100 snapshots/día**, 4× el
presupuesto de AV. El presupuesto de requests deja de ser un problema.

**Pero el techo de 12 meses es duro**: no hay forma de estirar la ventana hacia
atrás sin pagar, y lo que hoy tiene 11 meses de antigüedad, en dos meses ya no
se puede bajar. Si se elige esta fuente, **la cosecha es urgente**: cada semana
de demora es una semana de historia que se cae por el borde. (Los planes pagos
amplían el lookback; el precio exacto hay que verificarlo al registrarse.)

### 3.2 Alpaca — **credenciales ya en casa, presupuesto independiente**

La casa ya tiene el plumbing (`api/_lib/alpaca.js`, `ALPACA_PAPER_KEY/SECRET`,
`docs/alpaca-paper-scope.md`). Los datos de opciones **no compiten con el
presupuesto de AV** y el plan Basic es **200 req/min sin tope diario**.

Letra chica, y es gruesa:
- **La historia arranca en febrero de 2024** (~2.5 años hoy) — alcanza para 2
  años, no para más.
- Free/Basic = feed **"indicative"** (derivado de OPRA, 15 min de delay);
  OPRA completo exige *Algo Trader Plus*.
- **No hay endpoint de "cadena as-of"**: el `option chain` es actual. Para
  reconstruir una cadena pasada hay que (a) listar contratos —incluidos
  expirados— por `/v2/options/contracts`, y (b) pedir barras/quotes históricas
  por contrato (batch multi-símbolo). Es más plomería que AV/Market Data.
- Reportes de usuarios de **404 en quotes históricos** de contratos expirados;
  las **barras** son de operaciones ejecutadas, así que un strike OTM poco
  operado puede no tener barra ese día — justo los strikes que el wheel vende.

**Veredicto Alpaca:** plan B legítimo y gratis, pero con **más riesgo de
implementación y de huecos** que las dos primeras. Vale 20 minutos de probe
(el script incluye un bloque opcional) antes que dos días de plomería.

### 3.3 El resto (mención honesta, sin recomendación)

| Fuente | Qué da | Letra chica |
|---|---|---|
| **DoltHub `post-no-preference/options`** | cadenas EOD US gratis, mantenidas por la comunidad, con SQL API | volumen enorme para clonar; cobertura/continuidad no garantizada; **no se pudo verificar** (dominio bloqueado, §0) |
| **CBOE** (`cdn.cboe.com/api/global/delayed_quotes/...`) | cadena actual gratis con greeks | **sin historia**; la historia es CBOE DataShop, **pago por archivo** |
| **ThetaData / ORATS / Polygon / Intrinio / Tradier** | historia profunda y confiable, EOD y/o intradía, greeks | **$30-100+/mes**. ORATS llega a 2007. No es "costo trivial" |
| **AV Premium** | el mismo `HISTORICAL_OPTIONS` sin tope diario | desde **$49.99/mes** (EOD options). Es la salida si G0 falla y el proyecto igual se quiere |

---

## 4. La matemática de presupuesto (el corazón del memo)

### 4.1 La unidad de costo

**1 request = 1 símbolo × 1 fecha de observación = la cadena entera de ese día.**
De ahí salen dos consecuencias que cambian el cálculo:

1. **Las especificaciones son gratis.** Un mismo snapshot del viernes contiene
   todos los strikes y todas las expiraciones → probar Δ0.20 vs Δ0.30, o 7 DTE
   vs 30 DTE, **no cuesta requests adicionales**. Barrer parámetros es gratis;
   agregar símbolos o fechas es lo que cuesta.
2. **Hold-to-expiry cuesta 1 request por trade; los rolls cuestan 2-3.** Si el
   call se mantiene hasta el vencimiento, el desenlace se calcula con el
   **precio del subyacente** al vencimiento (Yahoo, gratis, ya en el repo): no
   hace falta volver a pedir la cadena. Pero si el v0 quiere modelar *cerrar al
   50% de ganancia* o *rollear el miércoles*, hace falta el precio **de ese
   mismo contrato en otra fecha** → otro snapshot. **Los rolls duplican el
   presupuesto de datos** (§7, D6).

### 4.2 Escenarios — Alpha Vantage free (25 req/día), key dedicada

Muestreo semanal = 52 viernes por año. Trades brutos = símbolos × fechas.

| Alcance | Requests | Días de goteo @25/día | Trades brutos | ¿≤3 semanas? |
|---|---:|---:|---:|:--:|
| 3 símbolos × 52 viernes × 1 año | 156 | **~7 días** | 156 | ✅ |
| 5 × 52 × 1 año | 260 | **~11 días** | 260 | ✅ |
| 3 × 104 × 2 años | 312 | **~13 días** | 312 | ✅ |
| **5 × 104 × 2 años** | **520** | **~21 días** | 520 | ⚠️ **justo en el borde** |
| 8 × 104 × 2 años | 832 | ~34 días | 832 | ❌ |
| 10 × 104 × 2 años | 1.040 | ~42 días | 1.040 | ❌ |
| 5 × 156 × 3 años | 780 | ~32 días | 780 | ❌ |
| *Solo mensuales:* 5 × 24 × 2 años | 120 | **~5 días** | 120 | ✅✅ |
| *Solo mensuales:* 5 × 36 × 3 años | 180 | **~8 días** | 180 | ✅ |
| *Con roll mid-week:* 5 × 52 × 1 año × 2 snapshots | 520 | ~21 días | 260 | ⚠️ borde |

**Lectura:** el techo de 3 semanas a 25/día es **525 requests**. Eso compra
exactamente **5 nombres × 2 años semanales**, o **3 nombres × 2 años** con
holgura cómoda, o **5 nombres × 3 años si se baja a mensuales**.

### 4.3 El presupuesto está libre: **PEAD murió, las 25/día son del wheel**

PEAD cerró con **NO-GO** y su ledger quedó en **99/99** — el goteo no tiene nada
más que bajar. La key de AV (`ALPHAVANTAGE_API_KEY`, la misma para los dos
proyectos) queda **entera para el wheel: 25 requests/día**.

Pero **no se libera sola**: el cron sigue programado y el gate sigue apagado
por env var. Qué hay que apagar, y qué apaga qué:

| # | Qué | Dónde | Qué logra |
|:-:|---|---|---|
| **1** | `PEAD_HARVEST_ENABLED` ≠ `1` | env var de **Vercel** (producción) | **Lo único que corta el gasto de AV.** El gate (`api/pead-harvest.js:160`) devuelve `{disabled:true}` **antes** de `ensurePeadSchema()` y antes de cualquier llamada a AV. Con esto solo, el cupo ya es del wheel |
| **2** | Schedule + job `pead-earnings` | `.github/workflows/external-crons.yml` | **No hace falta para el cupo — sí para el ruido.** El job trata `disabled:true` como **fallo duro** (`jq -e '(.disabled == true)'` → `::error::` + `exit 1`). Dejándolo, la pestaña Actions queda **roja 5 veces por día para siempre**, y un cron realmente caído (`screener:refresh`) se pierde en el ruido |
| **3** | `pead:earnings` en `EXPECTED` | `api/cron-status.js:24` | Consecuencia de (2): sin schedule no hay heartbeat, y a las 8 h el job entra en `stale` → `/api/cron-status` devuelve **`ok:false` permanente** |

**(2) y (3) están hechos en este branch.** **(1) queda del lado de Vercel** — es
la única de las tres que efectivamente corta el gasto, así que **es la que
habilita el presupuesto del wheel**.

> **Sobra suelta, fuera de este alcance:** `pead:hour` (`vercel.json:43`, SEC 8-K
> diario) **no gasta cupo de AV** — SEC es gratis — así que no bloquea nada.
> Con el gate apagado devuelve `disabled` y sigue latiendo, así que tampoco
> ensucia el monitor. Retirarlo es parte de jubilar PEAD del todo, no de liberar
> el presupuesto: se deja como estaba.

**Presupuesto efectivo del wheel: 25/día, sin competencia.** El alcance de
5 nombres × 2 años (520 req) tarda **~21 días** — dentro del techo de 3 semanas,
sin trucos de convivencia.

### 4.4 El mismo alcance en Market Data free (100 créditos/día)

| Alcance | Créditos (1-2 por snapshot filtrado) | Días de goteo |
|---|---:|---:|
| 5 × 52 × **1 año** (el máximo que permite el free) | 260-520 | **3-6 días** ✅ |
| 10 × 52 × 1 año | 520-1.040 | 6-11 días ✅ |
| 20 × 52 × 1 año | 1.040-2.080 | 11-21 días ⚠️ |
| 5 × 104 × 2 años | — | ❌ **imposible en free**: el techo es 12 meses |

**Lectura:** Market Data invierte el problema. El presupuesto deja de importar
(se pueden cosechar 10-20 nombres en una semana) pero **la ventana queda
clavada en 12 meses**. Y no es simétrico con AV: la ventana de AV se puede
recuperar más tarde; la de Market Data **se cae por el borde y no vuelve**.

---

## 5. ¿Qué alcance mínimo hace el backtest estadísticamente digno?

### 5.1 El conteo de trades no es el problema

Estándar de la casa (`docs/pead-backtest-scope.md:516`): *"GO exige además ≥30
trades ejecutados (…) por debajo → INCONCLUSO **sin importar los números**"*.

Un covered call semanal genera **1 trade por símbolo-semana**, así que:

| Alcance | Trades brutos | ¿≥30? |
|---|---:|:--:|
| 3 × 52 × 1 año | 156 | ✅ 5× el piso |
| 5 × 104 × 2 años | 520 | ✅ 17× el piso |
| 5 × 24 mensuales × 2 años | 120 | ✅ 4× el piso |

El candado de 30 trades **se cumple con margen en todos los escenarios que
caben en presupuesto**. Ese no es el criterio que muerde acá.

### 5.2 Lo que sí muerde: solapamiento transversal y **cobertura de regímenes**

**(a) Los 260 trades no son 260 observaciones independientes.** Las 5 posiciones
de la misma semana comparten el mismo shock de mercado; con nombres líquidos la
correlación es alta. El **n efectivo se parece más al número de semanas (52 o
104) que al número de trades**. Es el mismo problema que PEAD resolvió con la
**cartera calendar-time** (`pead-backtest-scope.md` §3.6): el t-stat sale de la
serie temporal de la cartera, no del promedio por trade. **Acá hay que hacer lo
mismo** (§7, D11) o el t-stat sale inflado por construcción.

**(b) El test correcto es pareado, y eso salva la potencia.** La pregunta del
wheel no es "¿el covered call tiene Sharpe alto?" sino "¿captura prima **por
encima de tener la acción**?". La diferencia semanal es
`prima_recibida − max(0, S_T − K)`: las dos ramas comparten el movimiento del
subyacente hasta el strike, así que **la varianza del spread es mucho menor que
la de cualquiera de las dos ramas**. Con 52-104 semanas pareadas, la potencia
para detectar la captura de prima es **razonable**.

**(c) Pero un año es UN régimen, y el covered call es la estrategia más
régimen-dependiente que hay.** En un año alcista te tapan (el spread es
negativo y grande); en un año lateral gana; en un crash pierde menos que
buy & hold. Un backtest de 12 meses no responde "¿esto sirve?" — responde
**"¿cómo le fue en este régimen?"**, que es una pregunta distinta y mucho más
chica. **La restricción que manda no es el tamaño de muestra: es la cobertura
de regímenes.**

### 5.3 Alcance mínimo digno — pre-registrado

| Nivel | Alcance | Requests (AV) | Goteo | Qué se puede afirmar |
|---|---|---:|---:|---|
| **Piso digno** | 5 nombres × **2 años** semanales | 520 | ~21 días | Captura de prima neta vs buy & hold pareado, con **al menos un tramo no-alcista** dentro |
| **Mínimo publicable con recorte** | 5 nombres × **1 año** semanales | 260 | ~11 días AV / **~4 días Market Data** | Solo **"cómo le fue en este régimen"**. Etiquetado régimen-específico, sin claim de edge |
| **Recorte barato** | 5 nombres × 2-3 años **mensuales** | 120-180 | ~5-8 días | Responde por el wheel **mensual**, no por el semanal (menos trades, distinta prima/theta) |
| ❌ Fuera de presupuesto | ≥8 nombres o ≥3 años semanales | 780+ | 32+ días | — |

**El piso digno (5 × 2 años) cabe — justo, pero cabe**: 520 requests a 25/día
son ~21 días, y con PEAD retirado el cupo está entero (§4.3). La única condición
que queda es **que G0 pase** (§1.2).

---

## 6. VEREDICTO

### **VIABLE CON RECORTE**

Se cumple el criterio pre-registrado —*≥1 año de cadenas muestreables para ≥3-5
nombres líquidos con campos de premium utilizables, dentro de ≤3 semanas de
goteo*— por **dos caminos independientes**, y sobra presupuesto en ambos:

- **AV free (si G0 pasa):** 5 nombres × 2 años semanales = 520 req ≈ **21 días**.
- **Market Data free (sin G0 que resolver):** 5 nombres × 1 año = **3-6 días**.

**El recorte, explícito:**

1. **Ventana: 1-2 años, no 5.** Con Market Data free, **exactamente 12 meses**
   (techo duro). Con AV free, 2 años es el máximo que entra en 3 semanas.
2. **Nombres: 5, no 20.** Mega-caps líquidos con weeklies profundos.
3. **Una sola especificación principal** para el veredicto (delta objetivo, DTE,
   regla de asignación). Barrer variantes es gratis en requests pero cada corte
   extra va etiquetado **EXPLORATORIO** — convención de la casa.
4. **Sin rolls ni cierre anticipado en el v0**: hold-to-expiry puro. Modelarlos
   duplica el presupuesto de datos (§4.1) y se decide después, con los datos ya
   en casa.
5. **Con 1 año, el claim se degrada explícitamente**: no "el wheel tiene edge"
   sino "el wheel capturó/no capturó prima neta vs buy & hold **en este
   régimen**". Con 2 años que incluyan un tramo no-alcista, el claim sube a
   evidencia preliminar de captura de prima.

**Qué pregunta responde el recorte, textual:** *"Vendiendo sistemáticamente
calls semanales ~Δ0.30 sobre 5 mega-caps líquidos, ¿la prima cobrada neta de
costos superó al costo de oportunidad de las subidas tapadas, comparado contra
tener las mismas acciones, durante la ventana cosechada?"* — y **nada más que
eso**.

### Lo que falta para cerrar la Fase 0 (no es opcional)

**G0 — 3 requests, 10 minutos.** Correr `scripts/wheel-phase0-probe.mjs` donde
haya egress y key, pegar los payloads en §1.3 y anotar el resultado acá:

| Resultado de G0 | Acción |
|---|---|
| **AV free devuelve datos reales** | Fuente primaria = AV. Alcance = **5 nombres × 2 años semanales**, ~21 días de goteo con el cupo entero (§4.3) |
| **AV free devuelve placeholder / paywall** | Fuente primaria = **Market Data free**, recorte a **12 meses**, y la cosecha arranca **ya** (la ventana se cae por el borde). AV queda como opción paga ($49.99/mo) si el v0 promete |
| **Ambas fallan** y Alpaca no da quotes históricos utilizables | **NO VIABLE en gratis** → el wheel se estaciona con acta. Reabrir solo con decisión explícita de pagar $30-50/mes |

**Regla anti-desperdicio (el espíritu de la Fase 0):** **no se escribe una línea
de harvester hasta que G0 esté cerrado y pegado en §1.3.** Mejor matarlo acá que
descubrirlo tras dos semanas de goteo — que es exactamente lo que la trampa de
los placeholders de AV haría si nadie la valida (§1.2).

---

## 7. Si es viable: decisiones que la Fase 1 tiene que CONGELAR

No se diseña acá — es la lista de lo que no puede quedar implícito, en orden de
cuánto mueven el resultado.

**Precio y entrada**

- **D1 — Asignación de premium al entrar.** ¿`bid`, `mid` o `last`?
  Recomendación: **`bid`** (vendés: te pagan el bid) y `mid` solo como
  sensibilidad. Congelar además el descarte por spread ancho
  (p.ej. `(ask−bid)/mid > 20%` → snapshot inválido) y qué hacer con `bid = 0`.
- **D2 — Momento del snapshot.** AV/Market Data son **EOD**: la venta se marca
  al **cierre** del día de muestreo, no al open. Congelar si se aplica slippage
  adicional o si el bid ya lo representa.
- **D3 — Selección de strike.** ¿Por **delta objetivo** (Δ0.20/Δ0.30, depende de
  que la fuente traiga greeks) o por **moneyness fija** (+2%/+5% OTM, no depende
  de nada)? Congelar cuál manda, el desempate cuando no hay strike exacto, y el
  fallback si faltan greeks.
- **D4 — DTE y calendario.** ¿"exactamente 7 días" o "el weekly más cercano con
  ≥5 días"? Qué pasa en semanas con feriado, y qué pasa si el nombre no tiene
  weekly esa semana (¿se saltea el trade o se usa el siguiente vencimiento?).

**Ciclo de vida de la posición**

- **D5 — Asignación / ejercicio.** `S_T > K` al vencimiento → asignado. Congelar:
  ¿se recompra el subyacente en el open del lunes (el wheel sigue) o se cierra
  el trade? Y **el ejercicio temprano por dividendo**: call ITM con ex-div antes
  del vencimiento se asigna anticipadamente — es el error clásico que infla el
  retorno de un backtest de covered calls. Congelar la regla (mínimo: marcar los
  eventos con ex-div dentro de la vida del contrato y correr la sensibilidad).
- **D6 — Rolls y cierre anticipado.** Recomendación: **fuera del v0** (duplican
  el presupuesto, §4.1). Si entran, congelar el trigger (¿50% de ganancia?, ¿ITM
  al miércoles?) **antes** de ver resultados, y presupuestar el segundo snapshot.
- **D7 — Dividendos del subyacente.** La pata long stock los cobra: entran en el
  retorno de **ambas** ramas (wheel y benchmark).

**Datos y contabilidad**

- **D8 — Precio del subyacente: escala cruda, no ajustada.** Los strikes están
  en precios **no ajustados**. Usar `adjclose` de Yahoo para moneyness o
  settlement rompe el emparejamiento con el strike. Congelar: **close crudo**
  para moneyness/settlement + tratamiento explícito de **splits** (un split
  reajusta los contratos). Es primo del bug de escala ya documentado en PEAD.
- **D9 — Costos.** Comisión por contrato (~$0.65), fee de asignación, comisión
  de la pata de acciones, y el spread (implícito si se vende al bid). Congelar
  el modelo completo — el resultado de un covered call semanal vive o muere en
  los costos.
- **D10 — Capital y tamaño.** 100 acciones por contrato. ¿1 contrato por nombre,
  equiponderado por capital, o escalado? Cómo se contabiliza el capital
  inmovilizado (afecta cualquier Sharpe).

**Método y criterios**

- **D11 — Unidad estadística.** **Cartera calendar-time semanal** (convención de
  la casa) para que el solapamiento transversal no infle el t-stat (§5.2a).
- **D12 — Benchmark: buy & hold del mismo subyacente. NUNCA cero.**
  ⚠️ **PRE-REGISTRADO — no se renegocia después de ver resultados.**

  Vender calls **se ve como ingreso**: la prima entra todas las semanas y la
  curva de "prima cobrada" sube sin bajar nunca. Medido contra cero —o contra
  "prima anualizada sobre capital", que es la métrica con la que se vende el
  wheel en internet— **casi cualquier régimen alcista da un resultado
  espectacular y falso**: lo que entró por prima salió por upside tapado, y esa
  pata no aparece en el estado de resultados. El costo es invisible por
  construcción, así que hay que meterlo en el benchmark.

  **Benchmark = las mismas acciones, mismo periodo, mismo capital, sin vender
  calls**, pareado semana a semana. El estadístico principal va sobre **la
  diferencia** (wheel − B&H), no sobre los dos niveles por separado.

  **Regla NO-GO, congelada:** *si el wheel no le gana a buy & hold **ajustado
  por riesgo** en el mismo periodo → **NO-GO**.* Sin excepciones por "pero
  cobró mucha prima" ni por "pero tuvo menos drawdown": si la ventaja es de
  riesgo, tiene que aparecer **en la métrica ajustada por riesgo**, no en la
  prosa que acompaña la tabla. Cuál es esa métrica se congela **antes** de
  correr nada (recomendación: Sharpe de la serie semanal de la diferencia, con
  el spread medio semanal y su `t` reportados al lado).

- **D12b — Qué claim sostiene cada ventana** (pre-registrado, porque un año es
  un régimen y el covered call es la estrategia más régimen-dependiente que hay,
  §5.2c):

  | Ventana cosechada | Se PUEDE afirmar | NO se puede afirmar |
  |---|---|---|
  | **1 año** | *"En la ventana cosechada, sobre estos 5 nombres, el wheel rindió X bp/semana **vs buy & hold** (t = …)"*. Descriptivo, régimen-específico, con la ventana nombrada en la misma frase | Nada sobre edge esperado. Ni "el wheel funciona" ni "el wheel no funciona". Ninguna extrapolación a otro régimen |
  | **2 años** (con ≥1 tramo no-alcista) | *"Hay / no hay **evidencia preliminar** de captura de prima neta vs B&H, y el signo **se mantiene / se da vuelta** entre el tramo alcista y el no-alcista"* | Edge robusto fuera de muestra. Comportamiento en un crash (2 años casi seguro no contienen uno). Ranking entre deltas o DTE como conclusión — eso va etiquetado **EXPLORATORIO** |

  **Corolario obligatorio:** el resultado se reporta **partido por régimen**
  (mínimo: tramo alcista vs no-alcista), no solo agregado. **Si el signo del
  spread se da vuelta entre tramos, el veredicto es INCONCLUSO aunque el
  agregado sea positivo** — esa es exactamente la firma de una estrategia que
  solo cobra por vender opcionalidad mientras el mercado sube.
- **D13 — Universo point-in-time.** Con 5 mega-caps y 1-2 años el sesgo de
  supervivencia es chico, pero hay que **declararlo**, no ignorarlo.
- **D14 — Criterios de éxito congelados ANTES de correr nada**: piso de trades,
  umbral de spread neto vs buy & hold (**el NO-GO de D12 es el piso, no un
  criterio más**), `|t|` sobre la serie semanal pareada, el split por régimen de
  D12b, y veredicto **GO / NO-GO / INCONCLUSO** contra una **única**
  especificación principal. Todo lo demás, etiquetado EXPLORATORIO.
- **D15 — Almacenamiento y goteo.** Mismo patrón que PEAD: tabla de snapshots +
  **ledger reanudable** + **guard de presupuesto diario** en Neon, con
  validación de payload **en la ingesta** (la lección de §1.2: `Note`,
  `Information` y placeholders se detectan al entrar, nunca después).

---

## 8. Fuentes consultadas

Documentación y reportes de terceros vía búsqueda web (recordar §0: **ningún
sondeo en vivo fue posible desde este entorno**; lo de AV y Market Data es
esquema documentado, no verificado):

- [Alpha Vantage — API Documentation](https://www.alphavantage.co/documentation/) ·
  [Premium API Key](https://www.alphavantage.co/premium/)
- [QuantVPS — Best APIs for Historical Options Market Data & Volatility](https://www.quantvps.com/blog/best-apis-for-historical-options-market-data-volatility)
  (fuente del reporte de *placeholder data* en free tier — origen de G0)
- [Oyamori — Options Chain API: AlphaVantage vs Alpaca](https://oyamori.com/learning/options-data-api-alphavantage-alpaca/)
- [Market Data — Option Chain](https://www.marketdata.app/docs/api/options/chain/) ·
  [Plan Limits](https://www.marketdata.app/docs/account/plan-limits/) ·
  [Free Forever Plan](https://www.marketdata.app/docs/account/plans/free-forever/) ·
  [Rate Limits / Credits](https://www.marketdata.app/docs/api/rate-limiting/)
- [Alpaca — Historical Option Data](https://docs.alpaca.markets/us/docs/historical-option-data) ·
  [Historical bars](https://docs.alpaca.markets/us/reference/optionbars) ·
  [About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api) ·
  [Forum: historical option quote 404s](https://forum.alpaca.markets/t/historical-option-quote-question/19029)
- [yfinance — More In-Depth Option Data (discusión)](https://github.com/ranaroussi/yfinance/discussions/2078) ·
  [Macroption — Yahoo Finance Options Data with yfinance](https://www.macroption.com/yahoo-finance-options-python/)
- [FlashAlpha — Best Options Data APIs 2026](https://flashalpha.com/articles/best-options-data-apis-2026) ·
  [ORATS Data API](https://orats.com/data-api)

Evidencia interna del repo: `api/options.js:12-14` (Yahoo = front expiry, sin
histórico) · `api/_lib/av-earnings.js:6-10` (AV responde 200 con `Note` al
cortar) · `api/pead-harvest.js:160` (el gate que corta el gasto de AV) +
`.github/workflows/external-crons.yml` (el cron que trata `disabled` como fallo
duro) · `docs/alpaca-paper-scope.md:195` (precedente del 403 del
sandbox) · `docs/pead-backtest-scope.md:516` (candado de ≥30 trades).
