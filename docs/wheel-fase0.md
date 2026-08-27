# FASE 0 — Wheel / Covered Calls: viabilidad de datos

> **Alcance de este documento:** SOLO viabilidad de datos. No hay diseño de
> backtest acá — si el veredicto habilita seguir, la Fase 1 arranca de la lista
> de decisiones a congelar (§7). Nada de libs compartidas fue tocado.
>
> **Veredicto: VIABLE CON RECORTE SEVERO**, condicionado a una sonda pendiente
> (G0-b, §3.1). **Alpha Vantage quedó CERRADA: es un endpoint premium** (§1.2,
> sondeado con la key real). Ver §6.

**Pregunta única.** ¿Existe una fuente accesible de cadenas de opciones
**históricas** (strikes, expiraciones, bid/ask o premiums, idealmente con
volumen/OI) suficiente para backtestear covered calls **semanales** sobre
acciones US líquidas?

**Respuesta corta.** Sí, existe — pero **no en Alpha Vantage**. El sondeo con la
key real cerró esa puerta: `HISTORICAL_OPTIONS` es **endpoint premium**, no
existe en el free tier (§1.2). Con eso muere de golpe **todo el plan de cosecha
por goteo** que era el corazón de este memo: las 25 requests/día no compran
**cero** cadenas históricas, así que no hay tabla de presupuesto que valga.

Lo que queda gratis es **Market Data** (`marketdata.app`): 100 créditos/día y
cadenas históricas as-of, pero con **techo duro de 12 meses**. Ahí el
presupuesto deja de importar (la cosecha completa son ~3-6 días) y **la
restricción pasa a ser la ventana**: un año es un régimen, y por la regla que
este mismo memo pre-registró (§7 D12b), un año **solo sostiene un claim
descriptivo**. El backtest se puede correr; lo que no se puede es concluir "el
wheel tiene edge" con él.

---

## 0. Cómo se sondeó (y qué no se pudo sondear)

**El sondeo NO se pudo hacer desde la sesión de Claude Code** — el egress
devuelve 403 en CONNECT para `alphavantage.co`, `query2.finance.yahoo.com`,
`marketdata.app` y `dolthub.com`, y no se rodeó el bloqueo:

```
$ curl "https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=IBM&apikey=demo"
curl: (56) CONNECT tunnel failed, response 403
```

Es el mismo precedente ya documentado en `docs/alpaca-paper-scope.md:195`
(*"el sandbox de desarrollo no puede pegar a Alpaca (proxy 403) — el smoke en
Vercel es el único gate real"*).

**Se resolvió corriendo `scripts/wheel-phase0-probe.mjs` en local, con la key
real.** Eso es lo que cerró G0 (§1.2). Lo que sigue pendiente es la misma sonda
contra Market Data (**G0-b**, §3.1) — la corrida no llegó a ejecutarse: el
comando quedó sin el espacio antes de `node`, así que la shell intentó ejecutar
`MARKETDATA_TOKEN=…=node` como un programa en vez de setear la variable.

```
MARKETDATA_TOKEN=xxx node scripts/wheel-phase0-probe.mjs   # ← el espacio importa
```

**Estado de la evidencia en este memo:**

| Afirmación | Estado |
|---|---|
| AV `HISTORICAL_OPTIONS` es premium | ✅ **verificado en vivo**, payload en §1.3 |
| Yahoo no tiene cadenas históricas | ✅ verificado por el código del propio repo (`api/options.js`) |
| Market Data: 100 créditos/día, as-of, techo de 12 meses | ⚠️ **documentación, sin verificar** — es G0-b |
| Alpaca: historia desde feb-2024, sin cadena as-of | ⚠️ documentación + reportes de foro, sin verificar |

⚠️ **Higiene de credenciales:** la key de AV usada en el sondeo quedó expuesta
en texto plano fuera del repo. **Rotarla** (`ALPHAVANTAGE_API_KEY` en Vercel).
Ninguna key vive en este documento ni en el probe — se pasan por env var.

## 1. Fuente (1) — Alpha Vantage: **CERRADA. Es endpoint premium**

### 1.1 Lo que prometía la documentación

Vale dejarlo escrito porque explica por qué era la candidata #1 — y por qué la
documentación pública no alcanzó para decidir:

| Ítem | Lo documentado |
|---|---|
| Unidad de request | 1 request = 1 símbolo × 1 fecha = **la cadena COMPLETA de ese día** |
| Parámetro de fecha | `date=YYYY-MM-DD`, cualquier fecha desde 2008-01-01 |
| Profundidad | 15+ años |
| Campos | strike, expiration, type, bid, ask, last, mark, volume, open interest, IV y greeks |

Era la fuente ideal **en el papel**. En el free tier no existe.

### 1.2 G0 — **CERRADO: NO**

La sonda pidió la cadena de AAPL en tres profundidades con la key real
(`ALPHAVANTAGE_API_KEY` del repo, free tier). Las tres devolvieron **HTTP 200**
con el mismo cuerpo:

| Profundidad | Fecha | Resultado |
|---|---|---|
| reciente (~10 d) | viernes -10 d | `premium endpoint` |
| ~1 año | viernes -365 d | `premium endpoint` |
| ~2 años | viernes -730 d | `premium endpoint` |

**Esto no es rate limit y no se reintenta.** El cupo diario estaba intacto y el
mensaje no habla de cupo: habla de suscripción. Es un **paywall**, y un paywall
no cambia mañana.

> **La sonda se equivocó en esto y ya está corregido.** Etiquetó las tres
> respuestas como `rate_limited` y concluyó *"reintentar mañana"* — porque AV
> manda **por el mismo campo `Information`, con el mismo HTTP 200**, dos cosas
> incompatibles: "te pasaste del cupo" (transitorio) y "esto es premium"
> (definitivo). `classifyAvChain()` ahora las separa por el texto y devuelve
> `paywalled`, el veredicto dice **NO reintentar**, y corta sin gastar los
> requests restantes. Es la misma familia de trampa que ya estaba documentada en
> `api/_lib/av-earnings.js:6-10`, un escalón más abajo: no basta con detectar
> `Note`/`Information`, hay que **leer cuál de las dos cosas dice**.

### 1.3 Payload real

Respuesta de `HISTORICAL_OPTIONS` con key free, idéntica en las tres fechas:

```json
{
  "Information": "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints"
}
```

Sin `data[]`, sin `endpoint`, sin `message`. **No hay cadena que parsear.**

### 1.4 Qué se muere con esto

1. **Todo el plan de cosecha por goteo.** Las 25 requests/día del free tier
   compran **cero** cadenas históricas. La tabla de escenarios "símbolos ×
   fechas × ventana" contra las 25/día —que era el corazón de este memo— **no
   aplica a ninguna fuente que tengamos gratis** (§4).
2. **La ventana profunda gratis.** Los 15+ años de AV eran lo único que ponía
   2, 3 o 5 años al alcance sin pagar. Lo que queda gratis llega a **1 año**
   (Market Data) o a **feb-2024** (Alpaca).
3. **El "reintentar mañana"** como salida. No la hay.

**Lo que AV sigue siendo:** la opción paga más barata que conocemos con
profundidad seria — **$49.99/mes** (75 req/min, sin tope diario). Y ojo con el
reencuadre: a 75 req/min, los 520 requests del alcance "5 nombres × 2 años"
tardan **~7 minutos**, no 21 días. Pagar no acelera el goteo: lo elimina (§4.2).

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

## 3. Fuente (3) — con AV caída, esto es **todo lo que queda**

Ordenadas por qué tan cerca están de resolver el problema hoy.

### 3.1 Market Data (`marketdata.app`) — **ahora la candidata PRINCIPAL**

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

#### G0-b — **PASÓ**, con dos asteriscos que hay que medir antes de cosechar

Sondeo en local: las tres fechas devolvieron cadenas reales, **la de ~13 meses
no rebotó** (10/10 contratos con `bid > 0`) y las tres llamadas consumieron
**0 créditos de 10.000**. La fuente sirve. Pero los dos números que sonaban a
buena noticia son, cada uno, una bandera:

**Asterisco 1 — 10.000 créditos/día no es el Free Forever.** Free Forever son
**100/día**. 10.000/día es el **Starter Trial**: $0 por **30 días**, **no
renovable ni extensible**, y al terminar la cuenta **cae automáticamente a Free
Forever** (100/día y techo de 1 año). O sea: **la cosecha tiene reloj**, y lo
primero es averiguar en el dashboard **cuántos días quedan**.

**Asterisco 2 — el sondeo usó AAPL, que es el ticker de demo de Market Data.**
La documentación del Starter Trial dice que el acceso histórico está limitado a
**1 año "en tickers distintos de AAPL"**. El probe corre con
`WHEEL_PROBE_SYMBOL` en `AAPL` por defecto — es decir, **sondeamos justo el
único símbolo que puede no tener el límite**. Los 13 meses que no rebotaron
pueden ser un privilegio del ticker de demo, no una propiedad del plan. Y lo
mismo vale para los 0 créditos: si AAPL es demo, su costo tampoco es
representativo.

**Ninguno de los dos se resuelve leyendo.** La sonda ya está extendida para
medir las tres cosas de una (`scripts/wheel-phase0-probe.mjs`):

| Qué mide | Cómo |
|---|---|
| **(a) Plan real** | Lee `x-api-ratelimit-limit`. 100 = Free Forever · 10.000 = Starter Trial · 100.000 = Trader Trial. Si es trial, avisa del reloj |
| **(b) Techo real** | Escalera de 1 mes → 5 años, corrida **dos veces: AAPL y un ticker de control** (`MSFT`). Si AAPL llega más atrás que el control, lo marca como **falso positivo de profundidad** |
| **(c) Costo real** | Cadena **completa sin filtros** vs filtrada, sobre el **control**, con los créditos consumidos de cada una. Ése es el presupuesto de verdad |

```
MARKETDATA_TOKEN=xxx node scripts/wheel-phase0-probe.mjs
```

**Lo que decide el veredicto es la fila del control, no la de AAPL.**

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

## 4. La matemática de presupuesto — **reencuadrada**

Este era el corazón del memo mientras AV free era la fuente. Con el paywall
(§1.2) **el cuello de botella se movió de lugar**: ya no es cuántas requests
entran por día, es **hasta dónde llega la ventana**.

### 4.1 La unidad de costo (sigue valiendo, sea cual sea la fuente)

**1 request = 1 símbolo × 1 fecha de observación = la cadena de ese día.** De
ahí salen dos consecuencias que valen para Market Data igual que valían para AV:

1. **Las especificaciones son gratis.** Un mismo snapshot del viernes contiene
   todos los strikes y expiraciones → probar Δ0.20 vs Δ0.30, o 7 vs 30 DTE, **no
   cuesta requests adicionales**. Barrer parámetros es gratis; agregar símbolos
   o fechas es lo que cuesta.
2. **Hold-to-expiry cuesta 1 request por trade; los rolls cuestan 2-3.** El
   desenlace al vencimiento se calcula con el **precio del subyacente** (Yahoo,
   gratis, ya en el repo). Pero cerrar al 50% o rollear el miércoles exige el
   precio **del mismo contrato en otra fecha** → otro snapshot. Por eso los
   rolls quedan fuera del v0 (§7, D6).

### 4.2 Lo que se murió: el goteo contra las 25/día de AV

La tabla que ocupaba este lugar —3 símbolos × 52 viernes × 2 años = 312 requests
= ~13 días de goteo, y sus variantes— **ya no describe ninguna opción
disponible**. A 25 requests/día contra un endpoint premium, el alcance
cosechable es **cero**, en todos los escenarios.

Queda como referencia de **cuánto costaría el camino pago**, y ahí el reencuadre
importa: los planes de AV no tienen tope diario, así que **no compran un goteo
más rápido, eliminan el goteo**.

| Alcance | Requests | Free (25/día) | AV Premium ($49.99/mes, 75/min) |
|---|---:|---|---|
| 3 símbolos × 52 viernes × 1 año | 156 | ❌ imposible | ~2 min |
| 5 × 52 × 1 año | 260 | ❌ imposible | ~4 min |
| 5 × 104 × 2 años | 520 | ❌ imposible | **~7 min** |
| 10 × 156 × 3 años | 1.560 | ❌ imposible | ~21 min |

**Lectura:** si el proyecto se decide a pagar, la restricción de datos
desaparece por completo — no hay "plan de cosecha" que diseñar, es una tarde de
trabajo. La pregunta pasa a ser de negocio (¿vale $50/mes averiguar esto?), no
de ingeniería.

### 4.3 El presupuesto de AV que se liberó — y por qué ya no importa acá

PEAD cerró con **NO-GO** (ledger 99/99) y su goteo se retiró en este mismo
branch. Las 25 requests/día quedaron libres — **pero para el wheel no valen
nada**, porque el endpoint que necesita no está en el free tier.

El apagado sigue siendo correcto por sus propios motivos, así que se deja hecho:

| # | Qué | Dónde | Qué logra | Estado |
|:-:|---|---|---|---|
| **1** | `PEAD_HARVEST_ENABLED` ≠ `1` | env var de **Vercel** | Corta el gasto de la key (el gate de `api/pead-harvest.js:160` devuelve `disabled` antes de llamar a AV) | ⚠️ pendiente, del lado de Vercel |
| **2** | Schedule + job `pead-earnings` | `.github/workflows/external-crons.yml` | Evita que Actions quede **roja 5×/día para siempre** — el job trata `disabled:true` como fallo duro | ✅ hecho |
| **3** | `pead:earnings` en `EXPECTED` | `api/cron-status.js` | Evita `ok:false` permanente por `stale` sin heartbeat | ✅ hecho |

`pead:hour` (`vercel.json`, SEC 8-K) se deja como estaba: no gasta cupo de AV.

### 4.4 El presupuesto que sí importa ahora: Market Data

El sondeo cambió los dos parámetros de esta cuenta. Ya no son 100 créditos/día
sino **10.000** — pero por **30 días** (Starter Trial, §3.1). El presupuesto
dejó de ser una restricción y pasó a ser **una fecha de vencimiento**.

| Alcance (5 nombres × 52 viernes) | Snapshots | A 10.000 créditos/día |
|---|---:|---|
| 1 año | 260 | **una tarde** |
| 2 años | 520 | **una tarde** |
| 3 años | 780 | **una tarde** |

A menos que la cadena completa resulte carísima (eso es lo que mide el punto (c)
de la sonda), **el cupo diario ya no limita nada durante el trial**. Con 10.000
créditos y snapshots de 1-2 créditos entran ~5.000-10.000 por día: el universo
entero de cualquier alcance razonable cabe en una sola corrida.

**La restricción real pasó a ser doble, y las dos son relojes:**

1. **El trial se acaba** (30 días, no renovable). Después: 100 créditos/día y
   techo de 1 año.
2. **La ventana se cae por el borde.** Lo que hoy tiene 13 meses, después del
   downgrade es inalcanzable para siempre.

**De ahí sale el principio que ordena toda la cosecha: cosechar de atrás hacia
adelante.** Los últimos 12 meses van a seguir siendo accesibles después del
downgrade; **todo lo anterior, no**. Así que la historia profunda se baja
**primero** — es la única que el reloj puede quitarnos. Detalle en
`docs/wheel-harvest-scope.md`.

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

### 5.3 Alcance mínimo digno — contra lo que realmente existe

| Nivel | Alcance | ¿Se puede hoy, gratis? | Qué se puede afirmar |
|---|---|---|---|
| **Piso digno** | 5 nombres × **2 años** semanales | ❌ **No.** AV free está cerrada; Market Data free topea en 12 meses; Alpaca llega a feb-2024 pero sin cadena as-of | Captura de prima neta vs buy & hold con **al menos un tramo no-alcista** dentro |
| **Lo único alcanzable gratis** | 5 nombres × **1 año** semanales | ✅ Sí, vía Market Data (~3-6 días), **si G0-b pasa** | Solo **"cómo le fue en este régimen"** (§7 D12b). Sin claim de edge |
| **Recorte mensual** | 5 nombres × 1 año, solo mensuales | ✅ Sí (~12 snapshots/nombre) | Responde por el wheel **mensual**, con ~60 trades y un solo régimen. Más barato y más pobre |
| **Piso digno, pagando** | 5 × 2-3 años semanales | 💰 $30-50/mes | Lo mismo que el piso digno, sin esperar: la cosecha son minutos (§4.2) |

**El piso digno ya no cabe en gratis.** Ese es el cambio real que introdujo el
paywall de AV: antes el piso digno entraba justo (520 requests ≈ 21 días); ahora
la única forma de alcanzarlo es pagando.

## 6. VEREDICTO

### **VIABLE** — con el alcance final pendiente de una medición, no de una apuesta

Las dos compuertas están cerradas: **G0 = NO** (AV es premium, §1.2) y
**G0-b = SÍ** (Market Data devuelve cadenas históricas reales con `bid > 0`,
§3.1). Existe una fuente accesible y gratuita. La pregunta de la Fase 0 está
respondida: **sí, se puede backtestear covered calls semanales sobre líquidos US
sin pagar.**

Lo que queda abierto no es *si* se puede, sino *cuánta historia* — y de eso
depende **qué pregunta** puede responder la Fase 1:

| Si el ticker de **control** llega a… | Recorte | D12b permite |
|---|---|---|
| **≥2 años** | De **tamaño** (menos nombres, no menos pregunta) | **Evidencia preliminar** de captura de prima vs B&H, con split alcista/no-alcista. **D12b respira** |
| **~1 año** (la profundidad de AAPL era privilegio de demo) | De **pregunta** | Solo el claim **descriptivo régimen-específico** |

**Por qué no lo resuelvo por decreto:** el sondeo que dio 13 meses corrió sobre
**AAPL, el ticker de demo de Market Data**, y la documentación del Starter Trial
dice que el histórico está limitado a 1 año en tickers distintos de AAPL. Dar el
veredicto optimista con esa evidencia sería exactamente el error que este memo
viene evitando desde §1.2 — creerle a una lectura cuando un request la puede
desmentir. La sonda extendida lo mide en una corrida.

### Estado por fuente, final

| Fuente | Estado |
|---|---|
| **Market Data** | ✅ **FUENTE PRIMARIA.** Cadenas as-of con bid/ask/OI/greeks. Cupo: 10.000/día durante el trial |
| **AV `HISTORICAL_OPTIONS`** | ❌ Cerrada — endpoint premium (verificado) |
| **Yahoo** | ❌ Sin historia (verificado) |
| **Alpaca** | 🔵 Plan B, ya no hace falta sondearlo salvo que Market Data falle |
| **Pagas** ($30-50/mes) | 💰 La salida si el techo del control es 1 año y se quiere el piso digno |

### Lo que manda ahora: **el reloj**

El Starter Trial dura **30 días, no renovable**, y al terminar la cuenta cae a
Free Forever (100/día, techo de 1 año). Todo lo que esté a más de 12 meses de
antigüedad y no se haya bajado antes de esa fecha **se pierde para siempre**.

**Orden de trabajo, en este orden y sin adelantarse:**

1. **Averiguar cuántos días quedan de trial** (dashboard de Market Data). Es el
   dato que dimensiona todo lo demás.
2. **Correr la sonda extendida** — plan, techo real del control, costo de la
   cadena completa. Una corrida, tres respuestas.
3. **Cosechar de atrás hacia adelante** (`docs/wheel-harvest-scope.md`): la
   historia profunda primero, porque es la única que el reloj puede quitarnos.
   Los últimos 12 meses siguen ahí después del downgrade.
4. Recién entonces, Fase 1 desde §7, con D12/D12b congelados.

**La regla de "cero líneas de harvester hasta que G0-b esté cerrado" está
cumplida** — G0-b pasó, y el diseño de la cosecha vive en
`docs/wheel-harvest-scope.md`. Lo que **no** se escribe todavía es una línea de
*backtest*: eso es Fase 1 y arranca de §7.

## 7. Decisiones que la Fase 1 tiene que CONGELAR

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
