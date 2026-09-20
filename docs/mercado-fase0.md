# FASE 0 — `/mercado`: censo de fuentes + smoke

> **Alcance:** SOLO reconocimiento. Acá no hay UI, ni `mercado.html`, ni
> treemap, ni un rewrite nuevo en `vercel.json`. Si las compuertas abren, R1
> arranca de las decisiones congeladas de §8.
>
> **Estado: ABIERTA — esperando UNA corrida.** El instrumento está escrito y
> probado; los números se ganan corriendo `/api/mercado-censo?job=todo` desde
> producción (§6). Este contenedor no tiene salida a Yahoo, Finnhub, EDGAR ni
> Neon (§0), así que **este documento no trae ni un número de esas fuentes**.
>
> Lo que SÍ trae, y es la mitad del trabajo: el censo de **lo que ya existe en
> el repo**, leído del código, con archivo y línea. Ahí salieron seis
> hallazgos que cambian el tamaño de tres rebanadas (§4) — y dos de ellos
> contradicen supuestos del encargo.
>
> Fecha del reconocimiento: 2026-09-20.

---

## 0. Aviso de honestidad: el sondeo en vivo NO se pudo hacer acá

La regla 2 del encargo —"dato que falta = '—' en gris **+ por qué**"— aplica
primero a su propio reconocimiento.

Los seis hosts que la Fase 0 necesita, desde este contenedor:

```
000  https://query1.finance.yahoo.com/
000  https://query2.finance.yahoo.com/
000  https://finnhub.io/
000  https://data.sec.gov/
000  https://www.sec.gov/
000  https://api.coingecko.com/
000  https://api.<region>.aws.neon.tech/sql
```

El proxy de egress lo reporta explícito:

```
connect_rejected — gateway answered 403 to CONNECT (policy denial)
  host: query1.finance.yahoo.com:443
  host: finnhub.io:443
  host: data.sec.gov:443
  host: www.sec.gov:443
```

No es rate limit ni bloqueo de la fuente: es la política de red del entorno.
Es el mismo caso de `docs/historia-fase0.md` §0, `docs/xbrl-fase0.md` y
`docs/historico-censo.md`. **Lo que falta es una corrida, no un permiso.**

Y aunque hubiera salida, **dos de las diez preguntas no se pueden contestar
desde otra máquina**: la 3 ("¿cuánto tarda esto?") y la 8 ("¿Yahoo nos
rate-limita?") son preguntas sobre el SITIO. `/api/movers` ya documentó que
Yahoo devuelve **429 en el crumb dance desde Vercel** aunque el `v8/chart` sin
auth sí funcione (`api/movers.js:37-41`). Medir eso desde una laptop
contestaría otra pregunta.

### Qué sí se hizo

1. **El censo del repo, leído del código.** §3 y §4. Ninguna afirmación de
   este documento sobre QuantDesk sale de memoria: todas llevan archivo y
   línea.
2. **El instrumento** — `api/mercado-censo.js`, que contesta las diez
   preguntas en una corrida desde prod, y `api/_lib/mercado-fase0.js` con toda
   la lógica de medición PURA.
3. **El medidor, probado** — `tests/mercado-fase0.test.mjs`, 46 casos contra
   fixtures con la respuesta plantada. Sin red no se ganan los números de las
   fuentes; sí se puede probar que el instrumento mide bien. La Fase 0 del
   Congreso perdió dos corridas por un extractor que reportaba rojo sin estar
   probado (`docs/congreso-fase0.md` §6.1) — ese error no se repite.
4. **Las compuertas, fijadas ANTES** (§5, y en código en
   `api/_lib/mercado-fase0.js` → `CRITERIOS`). Un umbral escrito después de
   ver el número no es un umbral, es una racionalización.
5. **Las tres preguntas de §5 del encargo, contestadas** (§7). Dos ya tienen
   respuesta firme sin correr nada.

### Cómo cerrar esta fase

```
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://quantdesk2.vercel.app/api/mercado-censo?job=todo" | jq
```

~60–90 s. No escribe una sola fila. Pegás el JSON en §9 y el tablero de
compuertas del final de la respuesta dice **GO / NO-GO** por escrito.

---

## 1. La pregunta de fondo de esta fase

El encargo describe `/mercado` como "una capa de entrada **sobre lo que ya
existe**". La Fase 0 existe para medir si eso es cierto, porque de ello
depende que R1 sea una semana o un mes.

La respuesta corta, adelantada: **es cierto para el mapa de México, para el
mundo, para el retorno total y para las noticias; es a medias para el mapa de
EE.UU.; y es falso para insiders.** El desarrollo está en §3 y §4.

---

## 2. Las diez preguntas, y dónde vive la respuesta

| # | Pregunta del encargo | Estado | Dónde se contesta |
|---|---|---|---|
| 1 | Capitalización EE.UU. en Neon | **medible; hay un hueco estructural** | §3.1 · G1 |
| 2 | Capitalización México (trampa de series) | **medible; el diseño ya la anticipó** | §3.2 · G2 |
| 3 | Precios en batch, <1.5 s | **aritmética cerrada; falta el ms real** | §3.3 · G3 |
| 4 | Retorno total con dividendos | **YA RESUELTO en el repo** | §3.4 · G4 |
| 5 | Fundamentales de `metric` | falta la corrida | §3.5 · G5 |
| 6 | UPA real vs estimado | **el encargo se equivoca de fuente** | §3.6 · G6 |
| 7 | Ingresos/utilidad con cita | falta la corrida | §3.7 · G7 |
| 8 | Analistas + precio objetivo | **hay dos afirmaciones opuestas en el repo** | §3.8 · G8 |
| 9 | Form 4 completo | **NO: el parser filtra a `P`** | §3.9 · G9 |
| 10 | Smoke desde Vercel | el instrumento está listo | §6 · G10 |
| **0.10** | **Feeds de noticias (adenda)** | **medible; falta la lista** | §3.10 · G11 |

---

## 3. El censo, pregunta por pregunta

### 3.1 · Capitalización EE.UU. — el hueco es el SECTOR, no la cap

**Lo que hay.** Tres tablas de Neon saben algo del universo US, y ninguna sabe
todo:

| Tabla | Qué tiene | Qué NO tiene |
|---|---|---|
| `arena_screener` | 150 símbolos curados por liquidez, con P/U, P/S, márgenes, ROE, MA50/MA200 (`api/_lib/screener-db.js`) | **ni capitalización ni sector** — mirá el `create table`, no hay columna |
| `arena_market_cap` | `symbol, market_cap, fetched_at, source` — la foto del cap con TTL variable: 7 días si está lejos del piso de $1B, 1 día si está en el borde (`api/_lib/arena-mcap-cache.js`) | sector; y solo tiene los símbolos que el Arena llegó a mirar |
| `arena_universe` | el universo del Arena: **S&P 500 + Nasdaq 100 + hasta 100 movers ≈ 600 nombres**, reconstruido por cron a las 9:00 ET (`api/_lib/arena-universe.js`) | cap y sector: guarda un `payload` jsonb de símbolos |

**El sector no vive en ninguna columna.** Vive en la caché por día del buffet
(`arena_buffet_cache`, canal `assets:sector`) como la **industria cruda de
Finnhub** (`profile2.finnhubIndustry`), y se traduce a uno de los 11 ETFs
sectoriales con una lista ordenada de reglas por palabra clave en tiempo de
corrida (`api/_lib/arena-meta.js` → `SECTOR_RULES`, `sectorFromIndustry`). Esa
caché se llena **solo con los símbolos que el Arena tocó ese día** —unidades,
no centenas— así que para un mapa de 150–500 nombres hoy está esencialmente
vacía.

**Entonces la respuesta a "¿alcanza el universo?" tiene dos mitades:**

- **Tamaño: sobra.** No hacen falta los 150 del screener: `arena_universe` ya
  trae ~600 con el S&P 500 completo, y se reconstruye solo, todos los días
  hábiles, antes de la apertura. El encargo pregunta "si el universo es ~150,
  ¿hay que ampliar a S&P 500?" — **ya está ampliado**, en otra tabla.
- **Sector: falta.** Pintar un treemap agrupado por sector necesita
  `{símbolo → sector}` para TODO el universo que se pinte, y hoy eso no existe
  precomputado.

**Propuesta (R1).** Una tabla nueva, `mercado_universo_us`, que el cron de
precios (§3.3) llena en la misma pasada:

```sql
create table if not exists mercado_universo_us (
  symbol       text primary key,
  nombre       text,
  sector_etf   text,        -- XLK · XLF · … (los 11 GICS, vía sectorFromIndustry)
  industria    text,        -- la cadena cruda de Finnhub, para auditar el mapeo
  market_cap   numeric,
  cap_fuente   text,        -- 'finnhub' | 'yahoo'
  refrescado_en timestamptz
);
```

Coste de llenarla: **un `profile2` por símbolo, una sola vez**, más el refresco
del cap. La industria de una empresa cambia cada varios años (el mismo
argumento que ya justifica la caché por día del Arena), así que se refresca
semanal y no diario. Con el tier gratis a 60 req/min, 500 símbolos son ~9
minutos de una corrida nocturna — cabe de sobra en los 300 s de `maxDuration`
partido en tandas, o en dos noches.

**Lo que el censo va a medir (G1):** cuántos de los candidatos tienen cap Y
sector, cuántos sectores llegan a 5 nombres, y qué tan vieja es la cap más
rancia. El piso es **por sector**, no global, a propósito: 200 nombres
repartidos en 3 sectores cumplen cualquier piso global y siguen sin ser un
mapa por sector. Hay un test que fija ese caso
(`tests/mercado-fase0.test.mjs` → "un total grande con sectores flacos NO
pasa").

---

### 3.2 · Capitalización México — la trampa, y por qué el repo ya la vio venir

**La trampa, precisada.** `xbrl_reports.acciones_circulacion` sale del tag ICS
`NumeroDeAccionesEnCirculacion` (`api/_lib/xbrl-parse.js:37-38`): **un solo
número instantáneo por emisora, sin dimensión de serie.** Multiplicarlo por el
precio de UNA serie falla de dos maneras que **no son la misma**:

1. **Varias series a precios distintos** (AMX A vs B; LIVEPOL C-1 vs 1). El
   error es del tamaño de la brecha entre series: puntos porcentuales, a veces
   decenas.
2. **Unidades vinculadas** (FEMSA **UBD**, CEMEX **CPO**, GAP/ASUR/OMA **B**).
   Ahí el precio no es por acción sino **por paquete**, así que
   `acciones_totales × precio_de_la_unidad` multiplica la cap por el tamaño del
   paquete. **El error no es de puntos: es de veces.**

Esa distinción importa para el producto: un error de 8% es un dato malo; un
error de 5× es un dato que hace que el cuadro de FEMSA se coma el mapa. Por eso
el censo reporta el **múltiplo** además del %, y hay un test que planta
exactamente ese caso (`"UNIDAD VINCULADA — el error es de VECES"`).

**La buena noticia: la infraestructura ya distingue series.** No hay que
inventarla.

- `bmv_precios` está llaveada por **`(emisora_serie, fecha)`**, no por emisora
  (`api/_lib/bmv-db.js:206-209`). El comentario de ese archivo dice, textual,
  que "una emisora puede tener más de una serie".
- El censo de DataBursatil está **cerrado y corrido**: **185 series ICS · 137
  emisoras únicas · 165 con cobertura**, y la cosecha trajo **569,589 filas de
  precio sobre 182 series** (`docs/bmv-rotation.md` §final).
- El identificador de la API es `emisora + serie` pegados —`WALMEX*`,
  `FEMSAUBD`, `AMXB`, `LIVEPOLC-1`— y está **verificado**, no supuesto
  (`api/_lib/databursatil.js` → `emisoraSerie`).

Así que la pregunta de Fase 0 no es "¿podemos separar series?" (sí), sino
**"¿existe, para cada emisora, UNA serie con la que el cálculo cuadre contra
la cap pública?"**. Eso es lo que mide G2: se prueban todas las series, se
elige la más cercana a la referencia y se reporta SU error. Elegir la más
cercana no es hacer trampa: si ni la mejor cuadra, ninguna lo hace.

**La referencia pública** sale de `marketCap` del `quoteSummary` de Yahoo para
el ticker `.MX`. Es la única cap pública pedible en batch. Si Yahoo no
contesta para una emisora, esa emisora sale **`sin_referencia`**, que NO es lo
mismo que error 0% — hay un test que fija esa distinción.

**Regla de render, ya decidida:** error > 5% → la emisora se pinta **gris
punteada, sin tamaño**, con la etiqueta "sin capitalización verificada". Nunca
un tamaño inventado. El umbral está en `CRITERIOS.g2_max_error_pct = 5` y hay
un test que lo fija en 4.9% pasa / 5.1% no.

**Un hallazgo que cambia la lista del encargo:** de las cinco emisoras que
pediste verificar, **GFNORTE no está en `api/_lib/emisoras.json`**. Las 30
emisoras de ese archivo son: AMX, WALMEX, FEMSA, GMEXICO, CEMEX, BIMBO,
TLEVISA, ORBIA, KOF, ALFA, PE&OLES, GRUMA, ALSEA, ASUR, LIVEPOL, KIMBER,
GCARSO, ELEKTRA, PINFRA, CHDRAUI, GCC, BOLSA, CUERVO, GAP, OMA, AC, VESTA,
MEGA, LASITE, VOLAR. GFNORTE falta **por una decisión congelada de Fase 0 del
XBRL**: bancos, FIBRAs, fideicomisos y aseguradoras quedaron fuera de la v1
porque usan taxonomías distintas de ICS (`emisoras.json` → `_reglas.excluidos`,
`docs/xbrl-fase0.md` §2.1). Detalle en §7.3.

---

### 3.3 · Precios en batch — la aritmética ya cierra; falta el ms real

**Lo que hay.** `/api/macro-markets` es exactamente el patrón que el encargo
pide, ya funcionando: 19 símbolos, **una** entrada de caché CDN compartida por
toda la base de usuarios (`s-maxage=120`), el servidor abre los fetches **solo
en cache-miss**, y —la parte importante— **no devuelve ni un porcentaje
precocinado**: manda la serie cronológica y el cliente calcula con
`qdPeriodChange`. Ese contrato es lo que mató el bug del % de periodo tres
veces seguidas (`api/macro-markets.js:14-24`).

**La cuenta.** 150 US + 30 MX + 20 índices = **200 símbolos**. Yahoo v8 es
por símbolo. Con concurrencia 8 y ~250 ms por símbolo:

```
tandas = ceil(200 / 8) = 25
on-request (cache-miss) = 25 × 250 ms = 6,250 ms
```

**6.2 s en el miss.** No cabe en 1.5 s, y el miss le toca al primero que entra
después de cada ventana de caché — que en un sitio con poco tráfico es casi
todo el mundo. Con Neon precalculado, en cambio, la lambda hace **una**
consulta y el tiempo **deja de depender de n**.

**Propuesta: cron → Neon.** Sin ambigüedad. Y el cron no choca con nada (§7.2).

```
mercado:precios   /api/mercado-precios?job=refresh   */15 13-21 * * 1-5   (horario de mercado ET)
mercado:cierre    /api/mercado-precios?job=cierre    30 21 * * 1-5        (tras el cierre)
```

El endpoint de mapa lee la tabla y sirve con `s-maxage` acorde a la ventana
del cron. **Un endpoint batch por mapa, cero fetch por cuadro** — la regla 7
del encargo se cumple por construcción.

**Lo que el censo va a medir (G3):** el ms/símbolo REAL desde Vercel contra
los 9 símbolos de la muestra, y extrapola el presupuesto de 200 con ese número
en vez de con mi 250 ms de sobremesa. Si el observado es mucho menor, la
recomendación puede cambiar — y el endpoint lo dirá solo.

---

### 3.4 · Retorno total con dividendos — YA ESTÁ RESUELTO

Esta pregunta tiene respuesta antes de la corrida, y la respuesta es que el
trabajo ya está hecho, en producción, desde los backtests:

`api/_lib/yahoo-daily.js` pide `?interval=1d&range=…&events=div%2Csplit`, lee
`indicators.adjclose[0].adjclose` (ajustado por splits **y dividendos**),
**deriva el factor del día `f = adjclose / close` y lo aplica también al
open**, para que open y close queden en la misma escala. El archivo explica
por qué mezclarlos rompe la serie: "un open sin ajustar contra un close
ajustado inventa un retorno del tamaño del dividendo el día ex".

Y `qdPeriodChange` corre sobre cualquier serie de `{t, c}` — no le importa si
los cierres son de precio o ajustados. Así que **el rendimiento total sale de
alimentar `qdPeriodChange` con la serie ajustada**, sin tocar ninguna de las
dos piezas.

Lo único que queda por MEDIR es que `adjclose` llegue también para los
símbolos `.MX`, donde nunca se probó. Eso es G4.

#### El hallazgo que sí cambia R1: **YTD no existe hoy, y no es un `tradingDays`**

`QD_PERIODS` (`app.html:4014-4019`) tiene exactamente cuatro periodos:

```js
'1D': tradingDays 1   ·   '1S': 5   ·   '1M': 21   ·   '3M': 63
```

El toggle del encargo es **1D / 1S / 1M / YTD**. Dos problemas, y el segundo
es el caro:

1. **YTD no es un número de sesiones.** Es una FECHA —el último cierre del año
   pasado— y cuántas sesiones hay hasta ahí depende del día en que preguntes.
   `qdPeriodChange` ancla por `tradingDays`, así que YTD necesita una rama de
   ancla-por-fecha. Escrita y probada:
   `api/_lib/mercado-fase0.js` → `anclaYtd(serie, ahora)`.
2. **Ninguna de las dos fuentes de serie del front alcanza para un YTD.**
   - `/api/price` devuelve `recentPrices`: **30 cierres, sin timestamp**
     (`api/price.js:103`). Sin timestamp no hay fecha contra la cual anclar.
   - `/api/macro-markets` devuelve **70 puntos de una ventana de 3 meses**
     (`series.slice(-70)` sobre `range=3mo`). En septiembre, un YTD necesita
     ~180 sesiones.

   El modo de falla es el peor que hay: **devolver un número corto rotulado
   "YTD"**. Es literalmente el bug del % de periodo, con otra ropa. Hay un
   test que planta ese caso y exige que `anclaYtd` conteste `cubre: false` con
   motivo, en vez de un número a medias.

**Consecuencia para R1:** el endpoint del mapa manda series de **≥1 año con
timestamps** (`range=1y`), y `QD_PERIODS` gana `'YTD'` con ancla por fecha.
Las dos cosas son chicas; el punto es que hay que hacerlas ANTES de pintar el
primer toggle, no después.

---

### 3.5 · Fundamentales por ticker — falta la corrida

**Lo que hay.** `/stock/metric?metric=all` de Finnhub, ya usado en
`api/_lib/finnhub-dive.js`, `api/memo.js` y `api/arena-screener`. El tier
gratis está **verificado** para `metric`, `profile2`, `recommendation` y
`company-news` (`api/_lib/finnhub-dive.js:8`).

Lo que NO está verificado es **cuáles de los 12 campos que pide la ficha de
ticker vienen poblados** en ese tier. Finnhub mezcla sufijos (`TTM`, `Annual`,
`Quarterly`) y no documenta el tier. Por eso el censo no busca una grafía
fija: `CAMPOS_METRIC` lleva **grafías candidatas en orden** por campo y
**reporta cuál resolvió**, para que la respuesta no dependa de que yo haya
adivinado bien.

Los 12: cap · EV · P/U · P/U fwd · PEG · P/S · P/B · EV/Rev · margen · ROA ·
ROE · dividendo.

Un detalle que el censo trata bien y que importa: **un campo presente con
valor `null` cuenta como AUSENTE.** Finnhub manda nulls y cadenas vacías en el
tier gratis, y un campo "presente" con null pintaría un hueco rotulado como
dato. Hay un test.

**G5: ≥8 de 12.** Por debajo de eso la ficha de ticker va medio vacía y hay
que decidir si vale la pena, no descubrirlo pintándola.

---

### 3.6 · UPA real vs estimado — **el encargo se equivoca de fuente**

El encargo dice: *"confirma endpoint y ventana histórica en Finnhub free…
**Es la misma fuente de la tasa de beat de EARNINGS**"*. La segunda mitad es
cierta; la primera esconde que en el repo hay **dos** fuentes de UPA, y no son
la misma:

| Fuente | Dónde | Qué da |
|---|---|---|
| **Finnhub `/stock/earnings`** | `api/earnings.js:210` | lo que alimenta la tasa de beat del tab EARNINGS: `slice(0, 8)` → **8 trimestres**, con `actual` y `estimate` |
| **Alpha Vantage `EARNINGS`** | `api/_lib/av-earnings.js` → tabla `pead_earnings` | **~30 años** de historial trimestral por símbolo, ya en Neon, con `reported_eps`, `estimated_eps`, `surprise`, `surprise_pct` |

O sea: **el dato que R6 necesita ya está en Neon, con mucha más historia de la
que la ficha pide**, cosechado por el pipeline del PEAD. `pead_earnings` está
llaveada por `(symbol, reported_date)`.

**Propuesta para R6:** leer `pead_earnings` (cero llamadas, cero cuota, 30
años) y usar Finnhub `/calendar/earnings` solo para el **próximo** reporte con
su estimado. Finnhub `/stock/earnings` queda como respaldo para un símbolo que
el PEAD no haya cosechado.

Una trampa de Alpha Vantage que ya está domada y conviene no re-aprender:
**cuando te rate-limita NO devuelve 429** — devuelve HTTP 200 con
`{"Note": …}` y sin datos. `parseEarnings` distingue los tres casos
(`ok` / `rate_limited` / `empty`) y por eso un símbolo vacío no se graba como
`done`.

**Y una nota de redacción que el encargo ya pide y conviene fijar acá:**
`actual − estimate` es la distancia al **consenso**, no lo que hizo la acción.
"Le ganó +0.06" con la acción cayendo 8% es normal y la ficha tiene que poder
decir las dos cosas sin mezclarlas. El pie de ese bloque lo aclara.

**G6: ≥4 trimestres con actual Y estimate** (los dos: "le ganó" es una resta,
y con media fila no existe).

---

### 3.7 · Ingresos / utilidad por trimestre, con cita — falta la corrida

**EE.UU. → EDGAR `companyfacts`.** El acceso ya está probado en este proyecto
(`api/_lib/edgar.js`, `api/historia-harvest.js`, con `User-Agent` identificado
obligatorio y techo de 10 req/s).

Dos cosas que el censo mide y que NO son obvias:

1. **Un hecho sin `accn` no cuenta.** La regla del encargo es "cada barra cita
   su 10-Q/10-K". Para esta ficha, un número sin número de accession es lo
   mismo que no tenerlo: no se puede auditar. El censo cuenta por separado
   `trimestrales` y `con_cita`.
2. **Solo los hechos TRIMESTRALES.** `companyfacts` mezcla en el mismo arreglo
   los hechos anuales, los acumulados de 9 meses y los trimestrales. Sumarlos
   como si fueran trimestres es la manera clásica de inventar un trimestre que
   nunca existió. El filtro es `60 ≤ (end − start) ≤ 120` días. Hay un test.
   Y se toma **el mejor** de los dos tags de ingresos (`Revenues` y
   `RevenueFromContractWithCustomerExcludingAssessedTax`), **nunca su suma**:
   una empresa que reporta bajo los dos contaría cada trimestre dos veces.

**BMV → `xbrl_reports` + DataBursatil.** Ya está: `ingresos` y
`utilidad_neta_atribuible`, cada uno **con su tag, su ventana y su motivo**
cuando falta (el esquema tiene `*_tag`, `*_ventana`, `*_motivo` por campo). La
cita para BMV es el propio reporte trimestral con su `doc_id` y `zip_url`.

**G7: ≥8 trimestres con cita, en ingresos y en utilidad.**

Un número que el censo también reporta y que puede decidir arquitectura: **el
tamaño del `companyfacts`**. El de una mega-cap pesa decenas de MB; si sale
grande, R6 no lo puede pedir en vivo y necesita precálculo.

---

### 3.8 · Analistas — hay **dos afirmaciones opuestas** en el repo

**`recommendation` (free): confirmado.** `api/_lib/finnhub-dive.js:8` lo
declara verificado en el tier gratis, y se usa en producción.

**Precio objetivo: el repo se contradice consigo mismo.**

- `api/_lib/finnhub-dive.js:9-13` dice que `stock/price-target` es **PREMIUM**
  y por eso NO se llama.
- `api/memo.js:37` y `api/fundamental-agent.js:8,19` **sí lo llaman**.

Una de las dos está mal, y hoy nadie sabe cuál: los dos llamadores tragan el
error en silencio (`.catch(() => null)`), así que un 403 permanente se ve
igual que "esta empresa no tiene cobertura". **El censo lo dirime con el
status code**, no con el comentario de nadie: pide `price-target` a propósito
y reporta el HTTP.

**Yahoo `quoteSummary` desde Vercel: eso es lo que el encargo pide probar**, y
el censo lo prueba por la ruta **sin crumb** —la misma que usa
`api/fundamentals.js:18-20`— porque el crumb dance ya está documentado como
429 desde Vercel. La respuesta sale como **GO / NO-GO por escrito** en
`q8_analistas.price_target_yahoo.veredicto`.

**Si es NO-GO**, ya está decidido qué pasa: el panel de precio objetivo va
punteado "fuente de pago". Por eso **G8 no depende del precio objetivo**: G8
es verde si `recommendation` sirve. El precio objetivo es una bifurcación con
las dos ramas ya escritas, no un bloqueo.

**La tarjeta "última calificación con nombre de casa" no se sondea**, por
decisión congelada del encargo (§3.R6): va **siempre** punteada, "no lo
mostramos, es dato de pago".

---

### 3.9 · Form 4 — **NO. El parser filtra a compras, y no guarda "le quedan"**

Ésta es la respuesta más dura del censo, y es un NO con línea de código.

`api/stock-tracker.js` → `parseForm4Xml` (línea 161) sí lee el XML completo:
saca el emisor, los dueños con **cargo real** (`officerTitle`, `isDirector`,
`isOfficer`, `isTenPercentOwner`) y la bandera `aff10b5One`. Y después, en la
**línea 193**:

```js
.filter((tx) => tx.code === 'P' && tx.ad === 'A' && tx.shares > 0 && tx.price > 0);
```

Cuatro consecuencias, todas directas sobre R5:

1. **Solo `P` adquisiciones.** Ventas (S), premios (A), ejercicios (M/X),
   retención fiscal (F), regalos (G) — todo se descarta. R5 abre en "Todas las
   transacciones": hoy el 90% de lo que necesita nunca se guarda.
2. **Solo `<nonDerivativeTransaction>`.** Las derivadas (Tabla II) —que son
   justo las opciones que el chip "Opciones" de R5 filtra— **ni se leen**.
3. **No extrae "le quedan".** El parser saca `code, ad, date, shares, price`
   y nada más. `sharesOwnedFollowingTransaction` está en el XML y no se
   toca. Sin ese campo no existe la vista "vendió todo" (`le quedan = 0`) que
   el encargo pide por nombre.
4. **La hora del filing se tira.** El atom sí trae `<updated>`, que ES la hora
   de aceptación, y el código la guarda en `meta.updated`… para después hacer
   `meta.updated.slice(0, 10)` y quedarse con la fecha
   (`api/stock-tracker.js:206`). R5 pide
   "orden por hora de filing ↓": la hora existe aguas arriba y se descarta
   aguas abajo.

**Y no hay persistencia.** `stock-tracker.js` **no toca Neon en ninguna línea**
(cero `sql(`, cero import de `db.js`). Lo que hay es `memCache` +
`insiderAccum`, dos `Map` **del proceso**, con `SCAN_CAP = 60` filings por
build y una retención de 7 días que **solo sobrevive mientras la instancia
esté caliente**. Un cold start arranca con la ventana del atom y nada más.

Es el mismo problema que ya se resolvió una vez para el market cap del Arena
(`api/_lib/arena-mcap-cache.js` explica exactamente por qué un `Map` de
proceso no sirve en Vercel). La solución de R5 es la misma medicina:

```sql
create table if not exists mercado_form4 (
  accession        text not null,
  linea            int  not null,        -- un Form 4 trae varias transacciones
  ticker           text,
  issuer_cik       text,
  insider_nombre   text,
  insider_cik      text,
  cargo            text,                 -- officerTitle | Director | Dueño 10%
  es_director      boolean,
  es_oficial       boolean,
  es_duenio_10     boolean,
  tabla            text,                 -- 'no_derivada' | 'derivada'
  codigo           text,                 -- P S A M F G C D X J K
  adquirido_dispuesto text,              -- A | D
  fecha_operacion  date,
  precio           numeric,
  acciones         numeric,
  valor            numeric,
  le_quedan        numeric,              -- sharesOwnedFollowingTransaction
  plan_10b5_1      boolean,
  aceptado_en      timestamptz,          -- <updated> del atom, CON HORA
  link             text,
  primary key (accession, linea)
);
```

**Esto es la parte honesta del censo: R5 no es "envolver el TRACKER". Es un
pipeline de Form 4 nuevo** —parser extendido, tabla, cron de ingesta— con el
TRACKER actual como un filtro más sobre ella. El encargo lo estimaba como
reuso; no lo es. Mejor saberlo ahora que en la mitad de la rebanada.

**G9** mide las dos fuentes por separado, porque no son intercambiables:
Finnhub (normalizado, con `share` = remanente — ojo, `change` es el
movimiento, y confundirlos ya infló un valor ~1000× una vez,
`api/insider.js:5-13`) y el atom de EDGAR (el original, con su `<updated>`).

Un detalle del medidor que vale la pena: **"le quedan" en cero es un DATO**
(vendió todo), no un hueco. Si el censo lo contara como ausente, el caso más
informativo de todos se reportaría como falta de cobertura. Hay un test.

---

### 3.10 · Punto 0.10 (adenda) — feeds de noticias

**Primero, lo que no tengo: la lista de la adenda no llegó a este
contenedor.** Y no la invento. Escribir cinco URLs de medios mexicanos de
memoria sería exactamente lo que la regla 2 prohíbe, con un agravante propio
de esta pregunta: **un feed inventado que devuelve 404 se lee igual que un
feed real que se cayó**, así que un censo con URLs adivinadas no reporta
ignorancia — reporta un rojo falso, que es peor.

**Por eso la lista es un parámetro, no una constante.** El punto 0.10 corre
sobre lo que le pases, sin redeploy:

```
?feeds=eleconomista=https://…|mx , elfinanciero=https://…|mx , reuters=https://…
```

`nombre=url`, separados por coma; el sufijo `|mx` marca el feed como
mexicano. **El país se declara, nunca se adivina por el dominio** — y la
respuesta incluye `lista_usada` y `origen_lista`, para que dos corridas con
listas distintas no se puedan confundir al leerlas. Una entrada mal formada
sale en `entradas_invalidas` en vez de desaparecer: un feed que falta por un
typo se lee igual que uno que no existe.

Sin el parámetro, corre sobre `FEEDS_DEFAULT`, y el JSON lo dice con todas
sus letras: *"NO es la lista de la adenda"*.

**Segundo, el censo de lo que hay — y es el hallazgo:**

| Fuente | Dónde | Qué da para "lo de hoy" |
|---|---|---|
| Finnhub `company-news` | `api/news.js` | titulares **por ticker**, ventana de 14 días. Sirve para la ficha de ticker (R6), no para la portada |
| Finnhub `/news?category=general` | **nadie lo usa todavía** | prensa financiera en inglés. El censo lista sus `source` distintas para ver si alguna es mexicana |
| RSS de `vc-feed.js` | TechCrunch, Crunchbase News, LatamList, Contxto | **rondas de VC**, no mercado. No van en "lo de hoy" |

**El repo no tiene NINGUNA fuente de noticias de México.** Ni una. R3 pide
"titulares con hora, fuente y chips de ticker tocables; **EE.UU. y México
mezclados**", y la mitad mexicana hoy no tiene de dónde salir. Eso es lo que
la lista de la adenda viene a llenar, y por eso el punto 0.10 existe.

**Lo que G11 mide, y por qué no es "¿contesta 200?":**

1. **Items usables**, no items. La regla 3 del encargo pide titular original +
   fuente + link. Un item sin link no se puede atribuir.
2. **Fecha parseable en ≥90% de los items.** "Lo de hoy" muestra la hora del
   titular; un feed sin `pubDate` obligaría a inventarla. Hay un test con un
   feed de 10 items, títulos y links perfectos, y cero fechas: sale **rojo**.
3. **RSS *y* Atom.** `parseRss` de `vc-feed.js` solo entiende `<item>`, y
   media web de noticias publica Atom (`<entry>`). Contar solo `<item>`
   reportaría "0 items" sobre un feed sano — un rojo inventado que cerraría
   una puerta abierta. `contarItemsFeed` entiende los dos y **dice cuál
   detectó**.
4. **Cobertura de México aparte del total.** Tres feeds gringos vivos no
   llenan la mitad mexicana, y un total sano lo escondería. Si la lista
   declara feeds `mx` y **ninguno** vive, G11 sale rojo aunque sobren los
   demás. Si la lista no declara ninguno, el censo **no concluye nada** sobre
   México — que es distinto de concluir que está bien. Hay un test para cada
   caso.
5. **Un 403 de Cloudflare se nombra `bloqueado_cloudflare`**, no "no
   disponible". `vc-feed` ya documentó que FinSMEs responde desde una laptop y
   **no** desde una IP de Vercel. Los dos fallos se arreglan distinto —uno
   cambiando de fuente o metiendo proxy, el otro corrigiendo una URL— así que
   el censo los distingue. FinSMES va en la lista por defecto como **control
   negativo**: si sale 403, el instrumento funciona; si saliera 200, cambió
   algo y hay que releer el resto del censo con desconfianza.

**G11 verde:** ≥3 feeds vivos · ≥5 items usables por feed · ≥90% con fecha ·
y si hay feeds MX declarados, al menos uno vivo.

---

## 4. Los seis hallazgos que cambian el plan

Resumidos, por si alguien lee solo esta sección:

| # | Hallazgo | Rebanada | Efecto |
|---|---|---|---|
| 1 | **YTD no existe** en `QD_PERIODS`, y ninguna serie del front llega al año anterior | R1 | +ancla por fecha, +`range=1y` en el endpoint del mapa. Chico, pero va ANTES del primer toggle |
| 2 | **El sector no está precomputado** para el universo US | R1 | +tabla `mercado_universo_us`, +`profile2` semanal. Es el trabajo real de R1, no el treemap |
| 3 | **El S&P 500 ya está** en `arena_universe` (~600 nombres, cron diario) | R1 | −trabajo: no hay que ampliar nada |
| 4 | **El retorno total ya está resuelto** (`yahoo-daily.js`) | R6 | −trabajo |
| 5 | **La UPA histórica ya está en Neon** (`pead_earnings`, ~30 años, vía Alpha Vantage) | R6 | −trabajo, −cuota, +historia |
| 6 | **Form 4 solo guarda compras, sin "le quedan" ni hora** | R5 | **+pipeline completo.** R5 es la rebanada más grande del encargo, no la mediana |

Dos de estos contradicen el encargo (5 y 6). El resto lo confirma.

---

## 5. Las compuertas (congeladas ANTES de la corrida)

Viven en código: `api/_lib/mercado-fase0.js` → `CRITERIOS`, versión 1. El
endpoint las devuelve en cada respuesta, así que el JSON de §9 queda
auto-contenido.

| Gate | Pregunta | Verde si | Si sale rojo |
|---|---|---|---|
| **G1** | universo US | ≥120 nombres con cap **y** sector · ≥9 sectores con ≥5 nombres · cap más vieja ≤192 h | R1 empieza por llenar `mercado_universo_us`; el mapa US se pospone dentro de R1, no se cancela |
| **G2** | capitalización MX | las 5 emisoras nombradas cuadran a ≤5% | las que no cuadren salen **gris punteadas**. El mapa MX sale igual — con menos cuadros y sin mentir |
| **G3** | precios batch | los 9 símbolos con serie; el presupuesto extrapolado cabe en 800 ms de servidor | cron → Neon (que ya es la recomendación) |
| **G4** | retorno total | `adjclose` presente y factor derivable en los 9, **y** la serie cubre YTD | sin `adjclose` en `.MX`: la ficha MX dice "rendimiento de precio", no "total". Sin cobertura YTD: se alarga el `range` |
| **G5** | `metric` | ≥8 de 12 campos | los que falten van "—" con su motivo; si son muchos, el bloque Valuación se recorta |
| **G6** | UPA | ≥4 trimestres con actual **y** estimate | se cae a `pead_earnings`, que tiene más |
| **G7** | companyfacts | ≥8 trimestres **con cita** en ingresos y en utilidad | sin cita no hay barra: el bloque se recorta a los trimestres citables |
| **G8** | analistas | `recommendation` devuelve filas | el bloque de analistas entero va punteado |
| **G9** | Form 4 | ≥4 códigos distintos · "le quedan" en el 100% · hora de aceptación en el 100% | **es el resultado esperado** (§3.9): R5 se replantea como pipeline y se re-estima |
| **G10** | smoke | los 9 de la muestra con precio y serie | se diagnostica símbolo por símbolo antes de tocar UI |
| **G11** | feeds (0.10) | ≥3 feeds vivos · ≥5 items usables c/u · ≥90% con fecha · ≥1 feed MX vivo si se declaró alguno | R3 se recorta a la mitad estadounidense y la mexicana espera una fuente. **No** se traduce prensa gringa para fingir cobertura de México |

**Una compuerta AUSENTE no cuenta como verde: cuenta como `sin_medir`, y con
una sin medir el veredicto global no puede ser GO.** Es la diferencia entre
"pasó" y "no se probó", que es justo la que un tablero mal hecho borra. Hay un
test.

---

## 6. El instrumento

### 6.1 Qué se agregó en esta fase

| Archivo | Qué es | Líneas |
|---|---|---|
| `api/_lib/mercado-fase0.js` | el medidor: **todo puro**, sin fetch, sin DB, sin `Date.now()` escondido | 726 |
| `api/mercado-censo.js` | el endpoint que corre desde prod y contesta las 10 + el punto 0.10 | 708 |
| `tests/mercado-fase0.test.mjs` | 46 casos contra fixtures con la respuesta plantada | 601 |
| `vercel.json` | `maxDuration: 300` para el endpoint (el glob de 60 s no alcanza — la lección de `arena-smoke`) | +3 |

**Cero cambios a `app.html`.** Cero UI. Cero llamadas de IA. El endpoint no
escribe una sola fila, ni siquiera cachés.

### 6.2 Cómo se corre

```bash
# las diez preguntas + el punto 0.10, CON la lista de la adenda
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" --get \
  --data-urlencode "job=todo" \
  --data-urlencode "feeds=eleconomista=https://…|mx,elfinanciero=https://…|mx,reuters=https://…" \
  "https://quantdesk2.vercel.app/api/mercado-censo" | jq

# sin la lista: corre igual, y el JSON avisa que el 0.10 midió otra cosa
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://quantdesk2.vercel.app/api/mercado-censo?job=todo" | jq

# solo Neon (rápido, sin gastar cuota de Finnhub)
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://quantdesk2.vercel.app/api/mercado-censo?job=censo" | jq

# solo las fuentes en vivo
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://quantdesk2.vercel.app/api/mercado-censo?job=smoke" | jq
```

La llave es la misma de `/api/arena-smoke` y `/api/arena-reset`, por el mismo
helper (`checkAdminAuth`). Acepta `Authorization: Bearer`, `x-admin-key` o
`?key=`.

**El gate no es paranoia:** el censo gasta cuota de Finnhub y pega cinco veces
a Yahoo con cortesía de 1 req/s. Un endpoint de censo abierto es una factura
de otro.

### 6.3 La muestra, fija a propósito

- **US:** AAPL, NVDA, JPM · **MX:** WALMEX.MX, FEMSAUBD.MX, GMEXICOB.MX ·
  **Índices:** ^GSPC, ^MXX, ^N225
- **Ficha completa:** AAPL (CIK 0000320193) — cobertura máxima en las cuatro
  fuentes, así que un hueco ahí es un hueco de la fuente y no del nombre.
- **Cap MX a verificar:** WALMEX, FEMSA, AMX, GMEXICO, GFNORTE (ver §7.3
  sobre la última).

Fija para que dos corridas sean comparables. FEMSAUBD está en la muestra
justamente porque es el caso de unidad vinculada.

---

## 7. Las tres preguntas que el encargo pidió que hiciera (§5)

### 7.1 · "Si el universo US del screener no alcanza para un mapa por sector"

**No alcanza — pero no por el motivo que suponía el encargo, y la solución no
es ampliar el screener.**

Los 150 de `arena_screener` alcanzan de sobra en cantidad. Lo que no tienen es
**cap ni sector** (§3.1). Y ampliarlos a S&P 500 tampoco haría falta: ese
universo **ya existe**, con ~600 nombres, reconstruido por cron todos los días
hábiles antes de la apertura, en `arena_universe`.

**Propuesta:** el mapa US se arma sobre `arena_universe` (no sobre
`arena_screener`), y R1 abre con una tabla `mercado_universo_us` que el cron
de precios llena con cap + sector + industria cruda. El `profile2` por símbolo
se paga una vez y se refresca semanal.

**DECIDIDO (Lety, al dar el GO): top 300 por capitalización + un cuadro
"+N más = X%".** Un treemap de 600 cuadros en 390 px hace cuadros de 6 px,
que no se pueden tocar (la regla 8 pide tap ≥44 px) ni caben una etiqueta.

El cuadro "+N más" no es decoración: es lo que evita que el recorte **mienta
sobre el tamaño del mercado**. Sin él, un mapa de 300 nombres se lee como si
fuera todo el universo. Con él, dice cuántos quedaron fuera y qué porcentaje
de la capitalización total representan — el mismo recurso que R4 ya usa para
la tira de componentes de un índice, así que es un patrón, no una excepción.

Consecuencias concretas para R1:
- El `limit 300` va **sobre la cap**, y la cap tiene que existir para los 600
  antes de poder ordenar: `mercado_universo_us` se llena entera y el recorte
  es de render, no de ingesta.
- `X%` se calcula sobre la **suma de las caps de los que quedaron fuera**,
  no estimado. Un nombre del universo sin cap no puede entrar en esa suma:
  se cuenta aparte, como "N sin capitalización", igual que el gris punteado
  de México.

### 7.2 · "Si el cron de precios choca con el límite Hobby de Vercel"

**No choca. La cuenta ya es Pro.** `docs/crons.md` lo documenta con todas sus
letras:

- El límite de **1×/día por cron era de Hobby**; en Pro la frecuencia **no
  está limitada**. Por eso `arena:watch` ya corre `*/5 13-21 * * 1-5` —cada 5
  minutos— **en `vercel.json`**.
- El tope de **cantidad** es 100 crons por proyecto en todos los planes desde
  enero 2026. `vercel.json` tiene **8**. Agregar dos deja 10.
- Pro también sube `maxDuration` de 60 s a **300 s**, que es lo que hace viable
  un refresh de 200 símbolos en una sola invocación.

Así que `*/15 13-21 * * 1-5` va directo a `vercel.json`, sin GitHub Actions.

Dos avisos de la casa, de `docs/crons.md`:
1. **`vercel.json` manda sobre `export const maxDuration`.** El glob
   `api/*.js` con 60 s pisaba el 300 del archivo y la función moría con
   `FUNCTION_INVOCATION_TIMEOUT`. Por eso ya agregué la entrada explícita.
2. **El cron nuevo llama a `beat()`** para aparecer en `/api/cron-status`; si
   no, el día que se caiga nadie se entera.

### 7.3 · "Cualquier emisora `.MX` cuya cap no cuadre y no sepas por qué"

Todavía no puedo nombrar ninguna por error de cálculo —falta la corrida—, pero
sí hay una que **no va a aparecer siquiera**, y sé exactamente por qué:

**GFNORTE no está en el universo.** `api/_lib/emisoras.json` tiene 30
emisoras y GFNORTE no es una de ellas. No es un olvido: es una **decisión
congelada de la Fase 0 del XBRL** — bancos, FIBRAs, fideicomisos y
aseguradoras quedaron fuera de la v1 porque **usan taxonomías distintas de
ICS** (`docs/xbrl-fase0.md` §2.1). Un banco no reporta "ingresos" en el mismo
tag que una embotelladora, y el parser de `xbrl-parse.js` está escrito contra
ICS.

**DECIDIDO (Lety, al dar el GO): opción C, con la fuente a la vista — y B
como caída.**

- La cap de GFNORTE sale de `marketCap` de Yahoo para `GFNORTEO.MX`.
- El cuadro del mapa **y** la hoja/hover llevan la etiqueta **`cap: yahoo`**,
  en el gris de fuente que la regla 3 ya define. No es una nota al pie: es la
  columna de fuente que todo número de este producto lleva.
- **Si Yahoo no devuelve cap, cae a B**: gris punteado, "sin capitalización
  verificada". Nunca a un número de otra parte.

Por qué esto NO rompe la regla 3, que era mi objeción: la regla 3 no pide que
todos los números salgan de la misma fuente — pide que **cada número diga la
suya**. Un mapa donde 29 cuadros dicen `calc · xbrl+bmv` y uno dice
`cap: yahoo` cumple la regla al pie de la letra. Lo que la rompería sería
mezclar fuentes **en silencio**, y la etiqueta es justamente lo que lo impide.

Dos cosas que R1 tiene que cuidar para que esto no se vuelva un hábito:
1. **La etiqueta es obligatoria, no opcional.** Si el render puede pintar un
   cuadro con cap de Yahoo sin la etiqueta, la decisión se degrada sola en
   tres meses. Va con la misma forma que `qdPctTag`: sin fuente, no pinta.
2. **La caída a B es automática**, no manual. `veredictoCapMx` ya devuelve
   `sin_referencia` cuando Yahoo no contesta, y ese estado ya se pinta gris
   punteado. No hace falta lógica nueva: hace falta no saltársela.

Y una advertencia que la corrida va a confirmar o desmentir: **las tres
aeroportuarias (GAP, ASUR, OMA) y CEMEX son candidatas al caso de unidad
vinculada**, igual que FEMSA. Si salen con un múltiplo limpio (≈2×, ≈5×, ≈10×)
contra la referencia, no es un error de datos: es el tamaño del paquete, y se
arregla con un divisor por emisora — verificable, no adivinado. Si sale un
múltiplo feo (1.37×), ahí sí hay algo que no entiendo y te lo traigo.

---

## 8. Decisiones congeladas (para R1, si hay GO)

Del encargo, sin cambios: fuente IBM Plex Sans Condensed + Mono · fondo
`#0b0f14`, paneles `#0e141b`, bordes `#161c24` · escala de color del mockup,
−3% a +3% en 7 pasos, gris en ±0.5% · sin logos · sin líneas de tendencia ·
sin bolsas locales de Brasil/Chile/Colombia · título de insiders "Quién
compra, quién vende".

Lo que esta Fase 0 agrega a esa lista:

1. **El mapa US se arma sobre `arena_universe`**, no sobre `arena_screener`,
   y pinta el **top 300 por capitalización + un cuadro "+N más = X%"**
   (Lety, §7.1). El recorte es de render; la ingesta llena los ~600.
2. **`mercado_universo_us` es el primer entregable de R1**, antes del treemap.
3. **El endpoint del mapa manda series de ≥1 año con timestamps.** Sin eso el
   toggle YTD no puede existir sin mentir.
4. **`QD_PERIODS` gana `'YTD'` con ancla por fecha**, con `anclaYtd` como
   implementación y el `pct-lint` extendido a los archivos nuevos. **Entra en
   R1** (Lety), no se pospone.
5. **Una emisora MX sin cap verificada se pinta gris punteada, sin tamaño.**
   Nunca un tamaño estimado.
6. **GFNORTE lleva cap de Yahoo con la etiqueta `cap: yahoo` visible en el
   cuadro y en la hoja; si Yahoo no da cap, cae a gris punteado** (Lety,
   §7.3). La etiqueta es obligatoria: sin fuente, no pinta.
7. **R6 lee la UPA de `pead_earnings`**, no de Finnhub.
8. **R5 incluye un pipeline de Form 4 con tabla en Neon**, presupuestado en
   **30–40 h**, y **se queda en su lugar del orden** (Lety). No es reuso del
   TRACKER.
9. **Las dos suites rojas pre-existentes no se tocan** (Lety, §10). Quedan
   documentadas y fuera del alcance de este encargo.
10. **El punto 0.10 corre con la lista de la adenda vía `?feeds=`**, y el país
    de cada feed se declara, nunca se adivina (§3.10).

---

## 9. La corrida

> **PENDIENTE.** Acá va pegado, entero y sin editar, el JSON de
> `/api/mercado-censo?job=todo`. Entero: un censo recortado es una opinión.

```json
(pendiente — corré el comando de §6.2 y pegá la salida acá)
```

**Tablero esperado en la primera corrida**, para que se vea si acerté o no
(esto es una predicción, no un resultado):

| Gate | Predicción | Confianza |
|---|---|---|
| G1 | **rojo** — el sector no está precomputado | alta |
| G2 | **rojo parcial** — FEMSA por unidad vinculada, GFNORTE por ausencia | alta |
| G3 | verde con `cron_neon`, rojo con `on_request` | alta |
| G4 | verde en US; incógnita en `.MX`; **rojo en YTD** por la ventana corta | media |
| G5 | verde, ~9–10 de 12 | media |
| G6 | verde | alta |
| G7 | verde | media |
| G8 | verde en `recommendation`; precio objetivo, incógnita | baja |
| G9 | **rojo** — es el hallazgo de §3.9 | muy alta |
| G10 | verde | alta |
| G11 | **depende de la lista.** Con `FEEDS_DEFAULT` predigo verde en los 3 de VC y 403 en el control negativo; con la lista de la adenda, no tengo base para predecir | — |

Un NO-GO en G1, G2 y G9 **no cancela nada**: las tres tienen su rama escrita en
§5. Lo que cambia es el orden y el tamaño de R1 y R5, que es exactamente para
lo que sirve una Fase 0.

**Sobre G11 no predigo nada**, y quiero que quede escrito por qué: no tengo la
lista de la adenda, y una predicción sobre feeds que no conozco no sería una
predicción sino un relleno. Si corrés sin `?feeds=`, el JSON va a decir
`origen_lista: "FEEDS_DEFAULT del repo (NO es la lista de la adenda)"` y G11
va a estar midiendo el canal RSS, no las fuentes de noticias del producto —
sigue siendo útil (dice si Vercel puede leer RSS), pero no es la pregunta.

---

## 10. Dos deudas que no son mías, pero bloquean la regla 10

La regla 10 del encargo pide "suite `node --test` verde" al cierre de cada
rebanada. **Hoy la suite no está verde**, y no por nada de esta fase. Medido
antes y después de tocar nada, el resultado es idéntico: **106 de 108 suites
en verde**, las mismas dos rojas en los dos casos. La 108 es la nueva de esta
fase, y pasa 46/46.

### 10.1 · El candado de `DELETE`

```
tests/agents-persistence.test.mjs
  FAIL todo DELETE de api/ está en la allowlist revisada
    → api/_lib/historia-db.js
      "delete from company_filing_items where cik = $1 and accession = $2"
```

Entró con la ingesta de HISTORIA (commit `1491d68`, en esta misma rama) y no
existe en `origin/main`. El test es un candado de seguridad a propósito: **cada
`DELETE` nuevo en `api/` exige que una persona lo revise y lo agregue a la
allowlist**. El de HISTORIA se ve inofensivo —re-ingesta idempotente, acotada
por `cik + accession`— pero **la revisión es justo lo que el candado existe
para forzar, así que no lo desbloqueo yo por mi cuenta**.

Es un renglón en `tests/agents-persistence.test.mjs` → `ALLOWED_DELETES`, con
su comentario de por qué. Decime y lo agrego, o lo hacés vos con la ingesta.

### 10.2 · El veredicto frágil del dual momentum

```
tests/dualmom-analyze.test.mjs
  "gate_activaciones = 0 → el GO se topa en GO frágil"
  FAIL los tres criterios económicos PASAN → drawdown: false
  FAIL el veredicto crudo es GO → NO-GO
  FAIL pero el candado pre-registrado lo marca FRÁGIL → false
```

El archivo de test es **idéntico al de `origin/main`**, así que lo que se movió
fue el analizador o sus criterios, no el test. La primera aserción que cae es
`drawdown: false`: el caso sintético ya no pasa el criterio de drawdown, y a
partir de ahí el veredicto sale `NO-GO` y el candado de "GO frágil" nunca se
ejerce. O el umbral de drawdown cambió y el fixture quedó viejo, o el cálculo
cambió y el fixture lo está delatando — y **cuál de las dos es, no lo puedo
decidir yo**: son los criterios pre-registrados de un backtest ajeno a este
encargo, y moverlos para poner algo en verde es exactamente lo que esos
criterios existen para impedir.

Queda anotado acá para que no se descubra al cerrar R1 y se confunda con algo
que rompió `/mercado`.

---

## 11. Estimación (con su margen declarado)

Suponiendo el tablero que predije en §9. Son horas de trabajo, no días de
calendario, y el margen es **±40%** — que es el margen honesto de una
estimación hecha antes de la corrida.

| Rebanada | Encargo suponía | Con lo que sabemos | Por qué |
|---|---|---|---|
| R1 mapa | ~16 h | **24–30 h** | +tabla de universo con sector, +YTD, +cron de precios. El treemap es la parte fácil |
| R2 mundo + pesos | ~10 h | **8–12 h** | `/api/macro-markets` ya trae los índices; falta USD/MXN y el chip por bolsa |
| R3 tablas + noticias | ~12 h | **10–14 h** | casi todo ya existe (movers, calendario, news, Arena) |
| R4 ficha de índice | ~12 h | **12–16 h** | el modal y las velas están; los componentes por peso no |
| R5 insiders | ~14 h | **30–40 h** | §3.9. Pipeline nuevo: parser + tabla + cron + backfill |
| R6 ficha de ticker | ~20 h | **16–22 h** | −retorno total, −UPA (ya están); +analistas y valuación |
| R7 compartir | ~8 h | **8–10 h** | OG image + PNG, sin sorpresas a la vista |

**Lo que más mueve la aguja es R5**, y por eso el censo se detuvo tanto ahí.

---

## 12. Lo que esta fase declara FUERA de alcance

Para que no se cuele después como "ah, pero se suponía que…":

- **Congreso / eFD**: el encargo ya lo pone punteado "pronto". `/api/stock-tracker`
  lo tiene activable con gates propios (`docs/congreso-fase0.md`), y no se
  toca acá.
- **Cripto y ETFs en el mapa**: el encargo los pone vacíos con "pronto". No se
  censan.
- **Point-in-time del universo**: `arena_universe` arrastra survivorship bias
  declarado (una lista de hoy aplicada a ayer). Para un mapa del día eso es
  irrelevante; para cualquier cosa histórica **no lo es**, y el mapa no va a
  ofrecer vistas históricas.
- **Estado de mercado por bolsa**: `qdMarketStatus()` (`app.html:4452`) hoy
  sabe de **una sola bolsa** —acciones de EE.UU., con un offset EDT fijo de
  −4— y devuelve `abierto` / `cerrado · cierre del viernes`. R2 pide un chip
  **por bolsa** (Asia abre a las 18:00 CT, etc.). Es trabajo de R2, no de
  Fase 0, pero queda anotado acá para que no se descubra en la mitad.
- **El mensaje genérico.** La regla 2 prohíbe "Data unavailable — free-tier";
  esa cadena vive hoy en `app.html:9739`. Las pantallas nuevas no la usan, y
  el `app.html` no se toca en este encargo — así que sigue ahí y está bien que
  siga ahí hasta que R8 lo reordene.
