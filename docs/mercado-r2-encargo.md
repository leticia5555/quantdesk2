# R2 — Mundo y "en pesos": lo que hay, lo que falta, y lo que hay que decidir

**Estado: PLAN, sin código.** Igual que la Fase 0 antes de R1: primero medir,
después construir. Lo que sigue son hechos verificados contra el repo, no
supuestos.

## 0. Una aclaración sobre el encargo

El archivo `bc8a50e9-encargo-mercado.md` **no está en el repositorio** — no
aparece en ninguna parte del árbol ni referenciado desde ningún archivo. Así que
la definición de R2 que usa este plan sale de las tres fuentes que sí existen, y
está declarada acá para que se pueda corregir antes de gastar horas:

1. `docs/mercado-fase0.md` §11: *"R2 mundo + pesos · 8–12 h ·
   `/api/macro-markets` ya trae los índices; falta USD/MXN y el chip por
   bolsa"*.
2. `docs/mercado-fase0.md` §12 y `docs/mercado-r1-encargo.md` §4.5: el chip de
   estado de mercado hoy sabe de **una** bolsa (EE.UU., offset EDT fijo −4);
   *"R2 pide un chip por bolsa (Asia abre a las 18:00 CT, etc.)"*.
3. Las 10 reglas vigentes, que no cambian.

O sea: **R2 = pestaña Mundo + toggle "en pesos" + chip de estado por bolsa.** Si
el encargo pedía algo más, hay que decirlo ahora.

## 1. Lo que YA existe (medido)

### 1.1 Los índices del mundo: `/api/macro-markets`

Ya batchea 19 símbolos de Yahoo v8 en una sola respuesta cacheada, y **no
devuelve ningún porcentaje pre-cocinado** — sólo precio y serie fechada, que es
exactamente el contrato que la regla 1 pide. Lo que trae, por región:

| región | símbolos |
| :--- | :--- |
| Asia | `^N225` (Nikkei), `^KS11` (KOSPI), `^HSI` (Hang Seng) |
| Europa | `^GDAXI` (DAX), `^FTSE` |
| LATAM | `^MXX` (IPC), `^BVSP` (Bovespa) |
| EE.UU. (futuros) | `ES=F`, `NQ=F`, `YM=F` |
| volatilidad | `^VIX` |
| tasas | `^TNX`, `2YY=F`, `^TYX` |
| FX | `DX-Y.NYB`, `JPY=X`, `EURUSD=X` |
| commodities | `CL=F` (WTI), `BZ=F` (Brent) |

Cada símbolo trae su `currency`, que hace falta para "en pesos".

**Un límite que ya estaba anotado y hay que resolver:** el endpoint pide
`range=3mo` (~70 puntos). Con eso **1D/1S/1M/3M se pueden calcular y YTD no**.
Es el mismo problema que R1 tuvo con el mapa y se arregló pidiendo `range=1y`.

### 1.2 El peso: `/api/banxico?series=USDMXN`

Existe y apunta a la serie **SF43718 — tipo de cambio FIX**, que es la oficial
de Banxico. Token en el entorno, caché de 1 hora, y acepta `&days=N` para traer
la serie.

**El FIX es DIARIO.** Se publica una vez por día hábil y vale para el día
siguiente. Convertir un precio intradía de Nueva York con un FIX de ayer es
mezclar dos fechas, y eso se declara o no se hace: el número tiene que decir
**qué FIX usó y de qué día**, igual que la cap de un ADR dice su razón.

### 1.3 El chip de estado: una sola bolsa

`qdMarketStatus()` (`app.html:4452`) sabe de acciones de EE.UU. con un offset
EDT **fijo** de −4, y devuelve `abierto` / `cerrado · cierre del viernes`. Un
offset fijo se equivoca dos veces al año, en los cambios de horario.

### 1.4 Calendarios de feriados: sólo EE.UU.

`api/_lib/alpaca.js` trae `/v2/calendar`, que **sí** tiene los feriados de
EE.UU. Para Tokio, Seúl, Hong Kong, Fráncfort, Londres, São Paulo y la BMV
**no hay ninguna fuente de feriados en el repo**.

Esto importa más de lo que parece: un chip que dice "abierto" el día de un
feriado japonés es un verde producido por un dato que falta, y eso es peor que
un gris. **Propuesta:** el chip no afirma "abierto" desde el horario solo. Dice
el horario **y** lo contrasta con el dato que tenemos: si el reloj de la bolsa
dice que la sesión debería estar corriendo pero el último cierre de la serie es
de ayer o antes, el chip dice *"sin cierre nuevo hoy"* en lugar de "abierto". Se
mide con lo que hay en vez de afirmar con lo que falta.

## 2. Las rebanadas

Cada una es su propio PR, con `node --test` verde y Chromium verde, y espera OK.

### R2(a) — el reloj de las bolsas, puro y probado
`qd-mercados.js` nuevo: una tabla de bolsas (clave, nombre, zona IANA, horario
de sesión) y `estadoDeBolsa(bolsa, ahora, { ultimoCierre })` → `abierta`,
`cerrada`, o `sin_cierre_nuevo` con su etiqueta en español y la hora local de la
bolsa. Cero red: `Intl.DateTimeFormat` con `timeZone`, que es lo que ya se usa
para la hora local de mercado, así que los cambios de horario salen bien sin
tabla de fechas. Pruebas con reloj congelado en los dos lados de cada cambio de
horario, y en el traslape de Asia (que abre el día anterior en hora de México).

### R2(b) — Mundo en pantalla
Pestaña **Mundo** en `/mercado`, agrupada por región, leyendo
`/api/macro-markets`. Los cuatro periodos con `qdPeriodChange`/`qdPctTag` como
en los otros dos mapas; YTD **gris con causa** hasta que se resuelva el
`range=3mo`, o verde si se resuelve en esta rebanada (ver decisión 3). Chip de
estado por bolsa de R2(a). No es un treemap: los índices no tienen
capitalización comparable entre sí — **decisión 1**.

### R2(c) — "en pesos"
Toggle que convierte con el **FIX de Banxico**, con la fecha del FIX visible y
la fuente declarada (`banxico:SF43718 (FIX del AAAA-MM-DD)`). Sin FIX, o con un
FIX más viejo que N días hábiles, el número va **gris con causa** y nunca
convertido a medias. El FIX viaja en el payload del mapa, no se pide aparte al
apretar el toggle.

## 3. Lo que hay que decidir antes de construir

1. **Mundo: ¿treemap o lista?** Un treemap necesita un tamaño comparable y los
   índices no lo tienen (el Nikkei y el VIX no comparten unidad). Propuesta:
   **tarjetas por región**, cada una con su % del periodo y su chip de bolsa —
   como el mockup del tab MACRO, no como el mapa. Si querías treemap, hay que
   decidir con qué se dimensiona.
2. **"En pesos": ¿qué convierte?** Tres candidatos, y no son lo mismo:
   (a) sólo el mapa de EE.UU. (las caps en pesos), (b) también los índices de
   Mundo (el Nikkei en pesos no significa gran cosa), (c) sólo las cifras de
   dinero (caps y precios), dejando los índices en sus puntos. Propuesta: **(c)**.
3. **El `range=3mo` de `/api/macro-markets`.** Para que Mundo tenga YTD hay que
   subirlo a `1y`. El endpoint lo comparte con el tab MACRO de `app.html`, que
   no se rediseña en este encargo; agregar un parámetro opcional `range` es
   aditivo y no lo toca. ¿Se hace en R2(b) o Mundo sale sin YTD?
4. **Qué bolsas entran en el chip.** Propuesta: las 8 que tienen un símbolo en
   el endpoint (NYSE/Nasdaq, BMV, Tokio, Seúl, Hong Kong, Fráncfort, Londres,
   São Paulo). Los futuros de EE.UU. y el FX cotizan casi 24 h y necesitan otra
   etiqueta, no "abierto/cerrado".
5. **Feriados fuera de EE.UU.** ¿Alcanza la propuesta de §1.4 —el chip nunca
   afirma "abierto" contra el horario solo, sino contra el último cierre que
   tenemos— o hay que conseguir calendarios por bolsa?

---

# ADENDA — el encargo llegó, y las cinco decisiones (2026-09-29)

El contrato ya está en el repo como **`docs/mercado-encargo.md`** y es la fuente
de verdad. Su §3/R2 confirma lo que este plan había reconstruido y agrega el
detalle que faltaba. Las respuestas de Lety, anotadas acá porque una decisión
que se queda en el chat se pierde (como las acciones de NVO desde el 20-F, que
tardaron cuatro días en llegar a un archivo):

1. **Mundo: tarjetas por región, tamaño fijo, color por %.** El encargo lo dice
   así: *"los índices no tienen cap; no fingir"*. Regiones: **América / Europa /
   Asia / Cripto-FX-materias primas**.
2. **"En pesos" convierte el RENDIMIENTO, no los precios.** Toggle global
   USD | MXN. El % de cada activo se recalcula con el cruce de **su** moneda
   contra el peso en el mismo periodo:
   `r_pesos = (1 + r_local) × (1 + r_moneda/MXN) − 1`. Número grande = en pesos,
   chico = local, con la etiqueta visible **"rendimiento en pesos"**. Aplica
   también al Nikkei y al DAX. La hoja muestra la línea "en pesos".
3. **`/api/macro-markets` sube a `range=1y`**, para que haya YTD.
4. **Las 8 bolsas sí.** Futuros, FX y cripto llevan **"24h"** en lugar de
   abierto/cerrado.
5. **Feriados: la propuesta de §1.4 alcanza.** El chip no dice "abierto" sólo
   por el horario; si la sesión debería estar corriendo y el último cierre es de
   ayer, dice *"sin cierre nuevo hoy"*. No hay que conseguir calendarios.

## R2(a) — entregado

`qd-mercados.js` y `qd-pesos.js`, puros y probados, sin UI y sin tocar
`/mercado`.

### Lo que hubo que agregar al endpoint

Para que el punto 2 funcione **también** para el FTSE, el KOSPI, el Hang Seng y
el Bovespa hacían falta los cruces de sus monedas, que no estaban:
`GBPUSD=X`, `KRW=X`, `HKD=X`, `BRL=X`. El yen y el euro ya estaban. El peso
**no** se agrega ahí: viene del FIX de Banxico, que es la fuente oficial y trae
su fecha.

### La aritmética, y por qué la prueba va al revés

La composición es multiplicativa y el término cruzado no es redondeo: el S&P
+20% con el dólar +10% da **+32%**, no +30% — dos puntos enteros de
rendimiento real. Sumar los dos porcentajes es el error clásico.

El encargo pide "test unitario del cálculo con un caso conocido". Una prueba que
verifique `(1+a)(1+b)−1` contra `(1+a)(1+b)−1` no prueba nada: repite la
fórmula. Así que el caso conocido se arma **al revés** — se construyen los
precios en pesos (índice × FIX), se calcula el rendimiento directo, y se exige
que la composición dé lo mismo. Igual para el Nikkei, donde el peso se llega
pasando por el yen: `yenes ÷ (yenes por dólar) × (pesos por dólar)`. Si la
fórmula estuviera mal, esas pruebas se ponen rojas.

### `num(null)` es 0, y `num('')` también — quinta vez

El guardia ingenuo hacía que `rendimientoEnPesos(null, 10)` devolviera **+10%**:
un rendimiento ausente entraba como "no se movió", que es una **afirmación**
donde lo que hay es una ausencia. Es la quinta vez que esta coerción cuesta un
bug en este proyecto y la primera que una prueba lo caza **antes** de subirlo —
la que dice "un rendimiento ausente no vale cero".
