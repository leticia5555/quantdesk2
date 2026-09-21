# R0 — Cimientos del mapa

> **Qué es:** la rebanada previa a R1, abierta después del **NO-GO** de la
> Fase 0 (`docs/mercado-fase0.md` §9). Ataca las dos compuertas rojas que
> dependen de datos nuestros.
>
> **Ya corrió el censo** (2026-09-20). Este documento está escrito contra sus
> números, no contra suposiciones: §9 los dimensiona, §10 lista lo que la
> corrida rompió y §11 lo que corrigió.
>
> **Qué NO es:** no hay UI, no se toca `app.html`, no hay treemap. R0 construye
> y verifica tablas; R1 pinta.
>
> **G9 (Form 4) no se toca acá.** Sigue siendo el pipeline de R5, con sus
> 30–40 h. O sea que **la re-corrida al final de R0 va a seguir dando NO-GO
> global**, y está bien: el criterio de avance que fijaste es más fino que el
> tablero — **GO a R1 con G1 y G2 en verde**, no con el tablero entero.
>
> | Gate rojo | Lo abre |
> |---|---|
> | **G1** universo US | R0(a) |
> | **G2** capitalización MX | R0(b) + R0(c) + R0(d) |
> | **G9** Form 4 | **R5**, no R0 |

---

## 0. Lo que tenés que leer antes que nada

**Hay un bloqueante en la instrucción (c), y no lo descubrí escribiendo
código: ya estaba medido en el repo.**

`docs/bmv-rotation.md` §4.4, del censo de Fase 1b que corrió con token real:

> Del censo de Fase 1b: **acciones en circulación** históricas y el desglose
> `ifrs_mx` de deuda con costo **son de la extensión mexicana, no de
> `ifrs-full`**. **Sin acciones no hay capitalización**, y por eso este
> backtest usa EPS/precio y no book-to-market ni un filtro de tamaño. *No es
> una preferencia metodológica: es lo que los datos permiten.*

O sea: **está medido que `/v2/financieros` de DataBursatil no trae acciones en
circulación**, y tampoco hay en el repo evidencia de un endpoint de
capitalización (el censo cubrió `/v2/emisoras`, `/v2/financieros`,
`/v2/historicos` y `/v2/creditos`; ninguno es de cap).

No lo doy por cerrado, porque "no lo vio el censo de Fase 1b" no es lo mismo
que "no existe", y porque la instrucción es tuya y merece medirse antes de
contradecirla. Así que **R0(c) es un job que lo resuelve — y que no cuesta un
solo crédito**, porque el cosechador guarda el JSON crudo completo en
`bmv_financieros.raw` y la búsqueda corre sobre lo ya guardado (§3).

**Lo que esto implica para el orden de R0:** (c) va **primero**. Sin
referencia de cap no hay verificación, y sin verificación **todas** las
emisoras salen gris punteadas — G2 no puede ponerse verde. Los jobs (a), (b) y
(d) corren igual y entregan valor, pero G2 depende de (c).

Y una consecuencia de la misma medición, que además resuelve (d) sola: **los
bancos quedan fuera de `/v2/financieros`**. `pendientesFinancieros` descarta a
toda emisora sin `fin_periodos` — "el mismo `continue` que filtra bancos y
casas de bolsa", el que dejó a Quálitas con 0 trimestres
(`docs/bmv-rotation.md` §3). GFNORTE es un banco. Tu propia instrucción ya
escribió el desenlace: *"si no, gris punteado (B)"*.

---

## 1. R0(a) — `mercado_universo_us`

**El problema que resuelve** (Fase 0 §3.1): el sector no está precomputado. Vive
como industria cruda de Finnhub en la caché por día del buffet, que se llena
solo con los símbolos que el Arena tocó ese día — unidades, no centenas.

```sql
create table if not exists mercado_universo_us (
  symbol       text primary key,
  nombre       text,
  industria    text,          -- la cadena cruda de Finnhub, para auditar el mapeo
  sector_etf   text,          -- XLK · XLF · … vía sectorFromIndustry
  market_cap   numeric,
  cap_fuente   text,          -- 'finnhub:metric' | 'neon:arena_market_cap' | 'previa'
  actualizado  timestamptz not null default now()
);
```

**Los símbolos salen de `arena_universe`**, que ya se reconstruye por cron a
las 9:00 ET con S&P 500 + Nasdaq 100 + movers (~600). R0 **no duplica** ese
trabajo: lo consume.

### Tres decisiones que vale la pena justificar

**1. Una fila incompleta ENTRA a la tabla, con `faltan`.** Un símbolo ausente
y uno sin cap se ven igual en un `count(*)` y son problemas distintos. El
render decide qué hacer; la tabla no esconde.

**2. El RITMO, que es lo que la primera corrida en prod rompió.** Ver §14 —
la versión inicial hacía **436 req/min** contra un techo de 60, y 433 de 553
llamadas volvieron 429. Ahora hay una cola que espacia **cada arranque** a 55
req/min, con presupuesto de reloj y reanudación entre corridas.

**3. Solo se pide a Finnhub lo que hace falta.** Esto es lo que decide si cabe
en el tier gratis (60 req/min):

| Dato | Cuándo se pide | Por qué |
|---|---|---|
| `profile2` (nombre + industria) | solo si no hay industria guardada | la industria de una empresa cambia cada varios años — el mismo argumento que ya justifica la caché por día del Arena |
| `metric` (cap) | solo si **`cap_actualizado`** tiene más de 36 h **y** el Arena no la midió ya | `arena_market_cap` es gratis y tiene su propia política de TTL; pedirla otra vez sería pagar dos veces por el mismo número |

En régimen, el cron diario pide **~0 profiles y N caps**. La primera corrida
es la cara.

**4. `marketCapitalization` de Finnhub viene en MILLONES**, y se convierte al
guardar. Guardarla cruda habría hecho que Apple midiera lo mismo que una small
cap con la cap en unidades — y el treemap dimensiona por ese número.

### Lo que el job reporta

`g1_proyectado` adelanta si G1 va a pasar, sin esperar al censo completo. Y
`industrias_sin_mapear` cuenta lo que **ninguna regla** de `SECTOR_RULES`
tocó: una falla de cobertura tiene que verse como falla de cobertura, no
disolverse en un bucket.

**Cron:** `30,45 13-21 * * 1-5` en `vercel.json` — dos veces por hora en
horario de mercado, y **auto-gateado**: cuando no hay nada pendiente cuesta
tres consultas a Neon y devuelve `completo`. Registrado en `/api/cron-status`
como `mercado:universo`, con el AVANCE en el detalle del heartbeat: un verde
que no dice cuánto falta no informa nada. El porqué de la frecuencia está en
§14.

---

## 2. R0(b) — las unidades MX

```
cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
```

`emisoras.json` gana tres campos por emisora: `acciones_por_unidad`,
`serie_liquida` y `unidad_verificado`.

### Los cuatro divisores: declarados por vos, NO verificados por mí

| Emisora | Serie | Divisor | Fuente |
|---|---|---|---|
| FEMSA | `FEMSAUBD` | 5 | operador (encargo R0b) |
| KOF | `KOFUBL` | 8 | operador (encargo R0b) |
| CEMEX | `CEMEXCPO` | 3 | operador (encargo R0b) |
| TLEVISA | `TLEVISACPO` | 117 | operador (encargo R0b) |

Pediste "verifica cada una contra el prospecto/BMV y reporta la fuente". **No
puedo**: este contenedor no llega a `bmv.com.mx` ni a un prospecto (§0 de la
Fase 0). Marcarlos verificados sería inventar una fuente, así que los cuatro
entran con **`unidad_verificado: false`** y `unidad_fuente: "operador"`. Hay un
test que falla si alguien los marca verificados sin medirlos.

### Pero un divisor sí se puede MEDIR — y contra el dato mismo

Si el divisor es correcto, `acciones × precio / apu` tiene que cuadrar con la
cap de referencia. Si no cuadra, **el cociente da el divisor implícito**. Eso
es mejor que leer un prospecto: el dato que se usa es el mismo que se verifica.

`verificaDivisor` tiene tres desenlaces, y los tres se reportan distinto:

| Estado | Qué significa | Qué hacer |
|---|---|---|
| `cuadra` | el divisor declarado produce la cap correcta | `unidad_verificado: true` |
| `divisor_corregido` | el implícito es **otro entero limpio** | el declarado está mal y el dato dice cuál es. Accionable sin preguntarle a nadie |
| `no_es_de_unidad` | el implícito **no** es un entero limpio | el error NO viene del empaquetado: acciones mal extraídas, serie que no cotiza, recompras. Mirar a mano |

**El tercero es el que importa.** Un "redondeá al entero más cercano" lo
escondería: un implícito de 1.37 se volvería un divisor de 1 y el error
quedaría archivado como "cuadra". Hay un test que planta ese caso.

Dos detalles que el código cuida y que rompen si se los olvida:

- **El implícito se COMPONE con el declarado.** Con `apu=5` y un factor 2
  sobrante, el real es 10, no 2. Olvidarlo daba divisores al cuadrado.
- **Hay un techo (`max_divisor: 500`).** 117 es un divisor real (TLEVISA CPO);
  4,812 es un error de unidades (miles vs unidades) disfrazado de divisor.

### La serie líquida también se contrasta

El registro declara una `serie_liquida` por emisora. El job **no le cree**: la
compara contra la serie con más importe operado en `bmv_precios` y reporta
`series_que_discrepan`. Una serie declarada mal produce una cap mal con todos
los demás campos correctos, que es el error más difícil de ver.

---

## 3. R0(c) — la referencia de capitalización

`?job=refcap` recorre el **crudo ya guardado** en `bmv_financieros.raw` y
devuelve **toda** llave que hable de acciones o de capitalización, con su ruta
y su valor. No adivina cuál es la buena: las encuentra todas y las reporta.

Es el mismo criterio que el `?job=diagnostico&que=eps` de `bmv-rotation`, que
saca todas las llaves de acciones y marca cuál reproduce el EPS guardado.

| Veredicto | Qué sigue |
|---|---|
| `GO` — hay cap | R0(b) verifica contra ella. G2 puede ponerse verde |
| `GO PARCIAL` — no hay cap pero **sí acciones** | la referencia se calcula con el precio. Sirve igual |
| `NO-GO` — ni una ni otra | **decisión tuya**, no un default que yo elija (§6) |

**Costo: cero créditos de DataBursatil.** Corre sobre lo que ya está en Neon.

Una llave presente y **vacía** se reporta igual que una con valor: "la fuente
no tiene el campo" y "lo tiene en null" cierran puertas distintas. Hay un test.

---

## 4. R0(d) — GFNORTE

`?job=gfnorte` mira tres cosas por separado, porque fallan por motivos
distintos: si hay **precio** en `bmv_precios`, si hay **financieros** de
DataBursatil, y si hay **XBRL**.

- **Precio:** probablemente sí. `bmv_precios` guarda todas las series del
  censo; el filtro `tipo_valor_id = '1'` se aplica al consultar el universo,
  no al cosechar.
- **Acciones:** probablemente no, por partida doble. Los bancos quedaron fuera
  de ICS (`xbrl-fase0` §2.1) **y** fuera de `/v2/financieros`
  (`bmv-rotation` §3).

Tu instrucción ya escribió las dos ramas, así que el job solo reporta cuál
toca: **"ENTRA con etiqueta `cap: databursatil`"** o **"GRIS PUNTEADO
(opción B)"**.

**El job NO agrega GFNORTE a `emisoras.json`.** Agregarlo sin cap sería crear
un cuadro que nunca se puede pintar; se agrega cuando el veredicto sea el
primero.

---

## 5. R0(e) — el parser de fechas de la Fed

Pediste revisar el manejo de EDT/EST. **Lo medí antes de escribir una línea de
arreglo, y la hipótesis no se sostiene:**

```
OK   Wed, 17 Sep 2026 14:00:00 EST  → 2026-09-17T19:00:00.000Z
OK   Wed, 17 Sep 2026 14:00:00 EDT  → 2026-09-17T18:00:00.000Z
OK   … CST, CDT, MST, MDT, PST, PDT, GMT, UT
NaN  Wed, 17 Sep 2026 14:00:00 CET
```

**El parser heredado de V8 ya conoce las zonas de EE.UU.** Si el feed de la Fed
falló, no fue por eso — y "arreglarlo" habría sido código muerto que disimula
el problema real. Hay un test que falla si alguien mete `EST` en la tabla de
zonas extra, justamente para que no se agregue por las dudas.

### Lo que sí hice, que es más útil que el arreglo pedido

1. **Las zonas que Date.parse SÍ falla, ahora se traducen**: CET/CEST, BST,
   JST, IST, y las latinoamericanas **BRT, ART, CLT, COT** — que nos importan
   porque Valor (BR) y La República (CO) están en el registro de noticias.
2. **Una zona desconocida se NOMBRA** (`zona horaria desconocida: "XYZ"`) en
   vez de contarse como "sin fecha".
3. **Una fecha sin hora se acepta y se advierte.** Un titular fechado a
   medianoche no es un titular de medianoche, y "lo de hoy" ordena por hora.
   *(Un test encontró que `Date.parse` se comía este caso antes de que el aviso
   se emitiera: la rama tuvo que ir primero.)*
4. **`diagnosticoFechas` guarda las cadenas crudas que fallaron, agrupadas por
   motivo.** Sin esto, "0% con fecha" es un callejón sin salida; con esto, la
   próxima corrida entrega las tres cadenas y el motivo se ve solo.

**Así que el GO de la Fed no lo puedo declarar desde acá.** Lo que puedo decir
es que la causa que suponíamos está descartada, y que la próxima corrida va a
traer el motivo real en vez de un booleano.

---

## 6. R0(f) — congelar las 22 URLs ganadoras

**Me falta el JSON del censo.** Cuál candidata ganó por fuente vive ahí y en
ningún otro lado: el registro quedó con las candidatas en orden, no con el
resultado.

Así que en vez de pedírtelo y esperar, la congelación es **mecánica**:

```bash
node scripts/mercado-congelar-fuentes.mjs censo.json --dry   # ver qué haría
node scripts/mercado-congelar-fuentes.mjs censo.json         # escribir
```

- La ganadora queda en `feed` **y primera en `feeds`**; las demás candidatas
  **no se borran** — si mañana muere, la siguiente ya está escrita.
- Un NO-GO deja `feed: null` **con motivo**, no borra la fuente.
- Una fuente que el JSON no menciona **se deja intacta** y se reporta.
- Un GO **sin** url ganadora es un JSON roto: se reporta y **no se escribe**.
  Preferimos un registro viejo a uno con un `feed` indefinido que después nadie
  sabe de dónde salió.
- El resumen nombra las que ganaron con una candidata **que no era la
  primera** — ese dato vale guardarlo.

**Banxico y BMV emisnet** quedan como fuente **no-RSS** en el registro, con su
plan B ya probado en el repo (`api/banxico.js` sobre el SIE;
`api/bmv-inspect.js` por HTML a 1 req/s). Eso lo escribe el mismo script
cuando el JSON diga que salieron NO-GO.

---

## 7. Lo que necesito de vos

1. **El JSON del censo** (`?job=todo`), para R0(f) y para dimensionar R0(a).
   Sin él, "G1 rojo" no dice si faltaron 20 nombres o 400.
2. **Una decisión, si `?job=refcap` sale NO-GO** (§0 y §3): sin referencia de
   cap, G2 no puede ponerse verde. Las opciones, y mi lectura:

| | Qué implica | Mi lectura |
|---|---|---|
| **Volver a Yahoo** solo como *verificador* | la cap que se PINTA sigue siendo `calc`; Yahoo solo dice si cuadra | **La que yo elegiría.** Lo que rechazaste fue Yahoo como fuente del número, y esto no lo es: es el patrón de referencia del §3.2 de la Fase 0, que ya funcionó |
| **Verificar con EPS** | `utilidad ÷ EPS` da el denominador implícito del emisor, y se contrasta con `acciones_circulacion` | Elegante y sin fuentes nuevas, pero mide otra cosa: el EPS va sobre promedio ponderado (IAS 33), no sobre el saldo al cierre. `bmv-rotation` §1 ya midió un 17% de brecha en FEMSA por esto |
| **Sin verificar** | las 30 emisoras salen gris punteadas | Honesto, pero deja el mapa MX vacío y G2 roja para siempre |

3. **Confirmar que R0 no toca G9** — está escrito arriba, pero prefiero que
   quede dicho: la re-corrida del final de R0 va a seguir dando **NO-GO
   global** y eso no es un fracaso de R0.

---

## 8. Estado

| Ítem | Estado |
|---|---|
| (a) `mercado_universo_us` + cron | **escrito**, sin correr (no hay Neon acá) |
| (b) unidades en `emisoras.json` + verificador | **escrito y probado** con fixtures; los 4 divisores sin verificar contra prospecto |
| (c) referencia de cap | **job escrito**; hay evidencia medida de que DataBursatil no la tiene (§0) |
| (d) GFNORTE | **job escrito**; las dos ramas ya decididas por el encargo |
| (e) parser de fechas | **hecho** — y la hipótesis del encargo, descartada con la medición |
| (f) congelar 22 URLs | **herramienta escrita y probada**; falta el JSON |
| re-corrida `?job=todo` | pendiente de (a) y (c) |


---

## 9. Lo que la corrida del 2026-09-20 dice, medido

### 9.1 · G1 — el tamaño exacto del hueco

| | |
|---|---|
| candidatos en `arena_universe` | **579** (6 llaves: 5 días de universo + `constituents:sp500` con 502) |
| con capitalización | **45** |
| **con sector** | **0** |
| con cap **y** sector | **0** |
| cap más vieja | 65.7 h (dentro del techo de 192 h) |
| industrias en la caché del buffet | **0** — `assets:sector` vacía ese día |

**El hueco no es de frescura ni de universo: es de cobertura, y es casi
total.** `arena_market_cap` tiene 132 filas pero solo **45** cruzan con los 579
del universo — el Arena mide la cap de lo que mira, y mira poco. Y el sector
es **cero**, exactamente como §3.1 de la Fase 0 predijo: la caché del buffet
se llena con los símbolos que el Arena tocó ese día, y ese día no tocó
ninguno.

**Lo que R0(a) tiene que producir, en números:** 579 símbolos con sector
(hoy 0) y al menos 120 con cap **y** sector (hoy 0). O sea **534 caps nuevas y
579 industrias**. Con el tier gratis a 60 req/min y tandas de 8:

- primera corrida ≈ **579 `profile2` + 534 `metric` ≈ 19 minutos** de reloj,
  partida en varias invocaciones o dejada correr dentro de los 300 s por tanda;
- en régimen, ~0 `profile2` (la industria no cambia) y las caps que venzan.

Es la corrida cara de la que hablaba §1, ahora con número.

### 9.2 · G2 — las dos fuentes de referencia se cerraron el mismo día

Las 30 emisoras salieron **`sin_referencia`**. Ninguna gris punteada por error
de cálculo: gris punteadas por no tener contra qué compararse.

```
WALMEX   WALMEX*.MX     401   sin marketCap (HTTP 401)
FEMSA    FEMSAB.MX      401
AMX      AMXA.MX        401
GMEXICO  GMEXICOB.MX    401
GFNORTE  GFNORTEO.MX    401
```

Y en `q8`, el precio objetivo de AAPL por la misma ruta: **401, `Invalid
Crumb`**. O sea que **no es el símbolo `.MX`: es `quoteSummary` entero**, para
cualquier símbolo, desde Vercel. Yahoo cerró la ruta sin crumb que
`api/fundamentals.js` todavía usa.

Eso deja el cuadro completo:

| Fuente de referencia | Estado | Evidencia |
|---|---|---|
| DataBursatil | sin acciones en circulación | medido en Fase 1b (`bmv-rotation` §4.4) |
| Yahoo `quoteSummary` | **401 Invalid Crumb** | esta corrida, 5 emisoras + AAPL |
| **Manual, fechada** | **el camino que queda** | §12 |

**De paso, un bug del censo que la corrida expuso:** el símbolo se armaba con
`series[0]` —la serie alfabéticamente primera— en vez de la líquida. Salió
`AMXA.MX` (serie A) en vez de la que opera, y `FEMSAB.MX`, que ni siquiera
aparece entre las candidatas con precio. Da igual para el resultado (todas
dieron 401), pero estaba mal y quedó arreglado: ahora sale de `serie_liquida`
del registro.

### 9.3 · G9 — confirmado, y peor de lo que decía la Fase 0

`Finnhub insider-transactions` devolvió **2 transacciones, las dos código
`S`**, y —el dato nuevo— **`con_hora_aceptacion: 0`**. O sea que Finnhub no
expone la hora de aceptación **en ninguna fila**. R5 ordena por hora de
filing: esa hora solo existe en el `<updated>` del atom de EDGAR, que sí
contestó (40 entries, 41 `<updated>`).

Nada de esto cambia R0: G9 es de R5.

---

## 10. Los divisores: el resultado, y por qué la razón entre series NO sirve

Pediste el implícito de las 9 emisoras con varias series. Con las caps
calculadas con divisor:

| emisora | apu | serie líquida | cap con divisor | razón precio unidad/serie base | ¿la razón respalda el apu? |
|---|---|---|---|---|---|
| AMX | 1 | AMXB | 1,195.7 bn | 1.24 | n/a |
| **FEMSA** | **5** | FEMSAUBD | **703.4 bn** | 1.26 | **NO** (1.26 vs 5) |
| **CEMEX** | **3** | CEMEXCPO | **253.4 bn** | 4.62 | **NO** (4.62 vs 3) |
| **TLEVISA** | **117** | TLEVISACPO | **20.1 bn** | 42.39 | **NO** (42.39 vs 117) |
| **KOF** | **8** | KOFUBL | **401.7 bn** | 11.75 | **NO** (11.75 vs 8) |
| LIVEPOL | 1 | LIVEPOLC-1 | 134.7 bn | 0.99 | n/a |
| KIMBER | 1 | KIMBERA | 115.0 bn | 0.99 | n/a |
| PINFRA | 1 | PINFRA* | 110.9 bn | 1.32 | n/a |
| LASITE | 1 | LASITE* | — | — | n/a (ver §11) |

**Ninguna de las cuatro razones respalda su divisor. Y el dato dice por qué,
sin que haya que suponerlo:**

```
CEMEX:    CEMEXA = CEMEXB = 3.8
TLEVISA:  TLEVISAB = TLEVISAD = TLEVISAL = 0.205
KOF:      KOFA = KOFD = 16.270452
```

Series distintas con el **precio idéntico**, una de ellas a seis decimales.
Eso no es un mercado: es una cotización de referencia o un valor convertido.
**Las series no líquidas de estas emisoras no tienen precio de mercado**, así
que la razón entre series no mide el empaquetado — mide un número puesto a
mano.

**Conclusión que vale para R0(b):** la razón entre series **no es un
verificador**, y no puede reemplazar a la referencia externa. Era la idea
elegante de "verificar sin fuentes nuevas", y los datos la descartan. Queda
escrito para que nadie la reintente dentro de tres meses.

Lo que sí se puede decir de los cuatro divisores: **producen caps de un orden
de magnitud coherente con emisoras de su tamaño**, mientras que sin divisor
FEMSA daría 3,517 bn y KOF 3,214 bn — más que GMEXICO, que es la más grande
del índice por cap. Eso es un **indicio fuerte a favor**, y no es una
verificación: el umbral del 5% necesita un número contra el cual restar.

---

## 11. Lo que la corrida corrigió en el registro

**LASITE apuntaba a una serie que no existe.** El registro declaraba
`LASITEB`; las series reales en `bmv_precios` son `LASITE*`, `LASITEB-1` y
`LASITEB-2`. O sea que LASITE salía sin cap **por un typo mío**, no por falta
de datos — que es justo la confusión que el campo `sin_precio` existe para
evitar. Corregido a `LASITE*`, con la procedencia anotada.

**PE&OLES no tiene ninguna serie en `bmv_precios`.** No es un typo: son 0
series. Queda con `serie_liquida: null` y un `sin_precio` que lo dice. Poner
una serie para que la fila se viera completa habría producido la cap de algo
que no cotiza.

Las dos son la clase de error que solo aparece corriendo, y las dos tienen
test ahora.

---

## 12. La referencia manual, como la previste

`api/_lib/mercado-cap-referencia.json`, vacío a propósito, más
`?job=unidades&manual=CLAVE:CAP,…&fuente=…&capturada_en=…` para verificar sin
redeploy.

Tres reglas que hacen que "manual" no signifique "flojo":

1. **`fuente` y `capturada_en` son obligatorias.** Una cap sin las dos no
   entra: es lo que separa una referencia de un número suelto. Hay test.
2. **Caduca a los 14 días.** Una cap de referencia envejece con el precio, y
   arrastrar un verde viejo es peor que volver a gris punteado. Pasada la
   vigencia, la emisora vuelve a gris y el motivo dice cuántos días tiene.
3. **Nunca se pinta.** El número que el mapa muestra sigue siendo `calc`
   (acciones × precio / divisor). La referencia solo produce el veredicto y el
   error %, exactamente como el patrón del §3.2 de la Fase 0.

Y una observación que no es autocomplaciente: **una cap capturada a mano y
fechada es más auditable que una API que devuelve 401.** Se sabe quién la vio
y cuándo. Lo que no puede pasar es que se use sin decir que es manual — de ahí
la etiqueta `verificada vs <fuente> (<fecha>)`.

**Lo que necesito:** las 5 caps que ofreciste, en
`api/_lib/mercado-cap-referencia.json` o por `?manual=`. Con ellas, G2 se
puede medir de verdad por primera vez.

---

## 13. El estado real, y qué falta para la re-corrida

| Ítem | Estado |
|---|---|
| (a) `mercado_universo_us` + cron | escrito y cableado; **falta correrlo** (579 símbolos, ~19 min la primera vez) |
| (b) unidades + verificador | **escrito, probado y corregido con la corrida** (§11). Los 4 divisores siguen `unidad_verificado: false` |
| (c) referencia | DataBursatil pendiente de `?job=refcap`; **Yahoo descartado (401)**; camino manual **listo** (§12) |
| (d) GFNORTE | **B — gris punteado**, confirmado por vos y por el 401 de la corrida |
| (e) fechas | hipótesis EDT/EST descartada; **diagnóstico cableado**: la próxima corrida trae la cadena cruda y los tags presentes del feed de la Fed |
| (f) 22 URLs | **congeladas** en `news-sources.json`, con Banxico y BMV como fuente `no_rss` con su plan B |

**La re-corrida de `?job=todo` NO la puedo hacer yo**: este contenedor no
tiene egress (§0 de la Fase 0) y, más importante, G1 no puede ponerse verde
hasta que `?job=universo` haya poblado la tabla desde prod. El orden es:

```
1. /api/mercado-r0?job=universo          (puebla; ~19 min la primera vez)
2. /api/mercado-r0?job=refcap            (¿DataBursatil tiene con qué?)
3. /api/mercado-r0?job=unidades&manual=…  (con tus 5 caps)
4. /api/mercado-censo?job=todo           (la re-corrida)
```

Y lo que esa re-corrida **va a seguir dando es NO-GO global**, porque G9 no se
toca en R0. Lo que hay que mirar es G1 y G2.


---

## 14. La primera corrida en prod, y los dos bugs que destapó

`?job=universo` corrió el 2026-09-21: **553 `profile2` + 508 `metric` en
150 s, con 433 y 448 errores.** No faltaban datos: era el techo de Finnhub
free devolviendo 429.

### 14.1 · El error era aritmético, y estaba en un comentario que decía lo contrario

```js
const CONCURRENCIA = 8;
const PAUSA_TANDA_MS = 1100;   // "deja margen para que el Arena corra en paralelo"
```

**8 en vuelo cada 1.1 s son 436 req/min.** El techo es 60. El comentario
afirmaba lo contrario de lo que hacía el código, que es la peor clase de
comentario: uno que tranquiliza.

El problema de fondo es conceptual, no de números: **una tanda concurrente con
pausa no es un limitador**. Es una ráfaga con intervalos. Un limitador espacia
**cada arranque**.

```
cola espaciada a 55 req/min → 1091 ms entre arranques
60 solicitudes pedidas a la vez → la última arranca 64 s después
```

Hay un test que pide 60 ranuras en el mismo instante y falla si el ritmo pasa
de 60/min. Es el test que habría evitado esta corrida.

**La ranura se reserva al PEDIRLA, no al terminar.** Si se reservara al
terminar, una llamada lenta correría a las de atrás y el ritmo dependería de
la latencia de Finnhub en vez del techo.

**Un 429 corre la ranura y deja el símbolo pendiente**, sin reintentar en el
acto — reintentar es pedirle a un servidor saturado que se sature más. El
símbolo lo toma la corrida siguiente, que es justo para lo que el job es
reanudable.

### 14.2 · El segundo bug, que el primero tapaba

El upsert ponía `actualizado = now()` en las 553 filas de cada corrida, y el
TTL de 36 h leía **ese** campo. O sea que en cuanto un símbolo conseguía su
cap, la corrida siguiente lo veía fresco **para siempre**, y la cap no se
refrescaba nunca más. El mapa habría congelado el tamaño de sus cuadros en la
primera corrida que funcionara, sin avisar.

No se había notado porque, con los 429, **ninguna cap llegaba a escribirse**.

El arreglo separa las dos fechas:

| Columna | Qué es |
|---|---|
| `actualizado` | cuándo se **tocó** la fila |
| `cap_actualizado` | cuándo se **midió** la cap — y es la que manda el TTL |

Con dos cuidados: el upsert **nunca retrocede** `cap_actualizado` (si esta
corrida no midió, la fecha de antes sigue siendo la buena), y una cap heredada
del Arena **conserva la fecha de medición del Arena** en vez de sellarse con
la hora de esta corrida.

Y ahora **solo se escriben las filas que cambian**. Escribir las 553 en cada
corrida no solo era gasto: era lo que pisaba `actualizado`.

### 14.3 · Por qué el cron dejó de ser diario

```
1061 requests ÷ 55/min      = 19.3 min
presupuesto por corrida     = 250 s  (maxDuration 300 s, menos la escritura)
caben por corrida           = 229
corridas necesarias         = 5
```

**Un cron diario habría tardado cinco días en sembrar la tabla.** Por eso pasó
a `30,45 13-21 * * 1-5` — dos veces por hora en horario de mercado — y se
auto-gatea: sin pendientes cuesta tres consultas a Neon. El backfill se
completa en ~2.5 horas el primer día; después, la mayoría de los ticks no
tienen nada que hacer.

Es el mismo patrón de `arena:watch`, que ya corre cada 5 minutos con la misma
lógica de "el handler decide si hay trabajo".

### 14.4 · Lo que el JSON reporta ahora

`errores_fuente: 433` era un número que no distinguía "me cortaron" de "no hay
dato" — y esa desambiguación la tuviste que hacer vos, a mano. Ahora:

```jsonc
"ritmo":   { "por_minuto": 55, "intervalo_ms": 1091,
             "ms_usados": …, "cortada_por_presupuesto": false },
"finnhub": { "profile2": { "ok": …, "rate_429": …, "sin_datos": …, "red": … },
             "metric":   { … },
             "total_429": …, "pausas_por_429": …,
             "lectura": "sin 429: el limitador aguanta" },
"avance":  { "pendientes_al_empezar": …, "procesados_en_esta": …,
             "pendientes_al_terminar": …, "completo": false,
             "corridas_mas_estimadas": 4 }
```

`lectura` dice qué hacer cuando hay 429 con el limitador puesto: significa que
el techo real está por debajo de 55/min —casi siempre porque el Arena está
pidiendo a la vez— y se baja con `MERCADO_R0_POR_MINUTO`, sin redeploy de
código.


---

## 15. La regla de verificación, v2 — y el hallazgo de FEMSA

### 15.1 · Dos vías hacia "verificada", porque son dos cosas distintas

Con 4 referencias manuales cuadraron 3 y G2 pedía 15: juntar 15 referencias a
mano para desbloquear un mapa de 30 cuadros dejaba **26 emisoras grises por
falta de trámite, no de dato**.

**Validar un INSTRUMENTO no es validar cada MEDICIÓN.** La fórmula

```
cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
```

no tiene **ningún parámetro libre** cuando la emisora tiene una serie y
divisor 1: no hay serie que elegir ni divisor que acertar. Si el instrumento
cuadra contra varias referencias independientes, lo que queda por verificar
ahí es aritmética.

| Vía | Quién | Umbral |
|---|---|---|
| **individual** | obligatoria donde hay parámetros libres (varias series o divisor > 1) — las 9 | ≤5% |
| **por método** | una serie, divisor 1 — las 20 | el instrumento: ≥3 muestras, **≥2 limpias**, ≤2% |

**El umbral del método es más estricto que el individual (2% vs 5%) a
propósito**: lo que se extrapola tiene que medirse mejor que lo que se mide
una sola vez. Y hacen falta **≥2 muestras limpias**: extrapolar a emisoras de
una serie apoyándose solo en multi-serie sería validar desde casos que no se
parecen al destino.

**Una falla no es igual que otra.** Si falla una emisora limpia, eso es
evidencia contra la aritmética y tumba el método. Si falla una con parámetros
libres, lo que está mal son *sus* parámetros. Sin esa distinción, TLEVISA
(5.6%) y FEMSA habrían tumbado el método para las 20 que no tienen nada que
ver con su problema.

`CRITERIOS.version` pasa a **2**. El 5% del encargo **no se movió** — cambió
qué cuenta como verificada, y queda versionado para que el cambio se vea en el
diff en vez de aparecer sin firma.

### 15.2 · FEMSA no era el divisor: es que no hay desglose

Tres cifras públicas, ninguna coincide:

| | |
|---|---|
| Yahoo | 837 B |
| Google Finance | 628 B |
| nuestro cálculo | 703 B |

**La causa es estructural.** FEMSA **UB** cotiza a 165 y **UBD** a 207.66 —
las dos son unidades de 5 acciones, o sea **comparables**, y difieren 26%. El
cálculo le aplica el precio de UBD a **todo** el capital. La cap correcta es

```
cap = Σ (acciones_de_la_serie × precio_de_la_serie) / apu
```

y **el XBRL da un total de acciones, no un desglose por serie**. Sin ese
desglose la cap no se puede calcular, y ninguna referencia más lo arregla: que
tres fuentes públicas no coincidan **entre sí** es exactamente lo que se
espera cuando la estructura de capital confunde a todos.

FEMSA va **gris punteada**, motivo `series con precio distinto, sin desglose`,
hasta tener el desglose del sitio de IR.

### 15.3 · La misma prueba, aplicada a las nueve

Dos trampas que hay que esquivar para no marcarlas a todas:

1. **Cotizaciones idénticas.** `CEMEXA = CEMEXB = 3.8`, `KOFA = KOFD =
   16.270452`, `TLEVISAB = D = L = 0.205`. Un grupo de precios idénticos
   cuenta como **un** precio: es un valor puesto a mano, no un mercado.
2. **Unidad contra acción suelta.** CPO a 17.56 y A a 3.8 no están en
   desacuerdo: una es un paquete de tres. Solo se comparan series del mismo
   tipo — el proxy es la razón de precios dentro de `[0.5, 2]`.

| emisora | series | comparables | spread | ¿desglose? |
|---|---|---|---|---|
| **AMX** | 3 | 3 | **23.7%** | **SÍ** |
| **FEMSA** | 2 | 2 | **25.9%** | **SÍ** |
| CEMEX | 3 | 1 | — | no (otro instrumento) |
| TLEVISA | 5 | 1 | — | no (otro instrumento) |
| KOF | 3 | 1 | — | no (otro instrumento) |
| LIVEPOL | 2 | 2 | 1.5% | no |
| KIMBER | 2 | 2 | 0.9% | no |
| **PINFRA** | 2 | 2 | **31.7%** | **SÍ** |
| LASITE | 3 | 1 | — | no (otro instrumento) |

**El desglose manda sobre la verificación individual.** Si las series cotizan
distinto, el número está estructuralmente mal aunque una referencia coincida —
y una referencia que coincide con un cálculo mal hecho puede estar haciendo el
mismo cálculo mal. Es el argumento que FEMSA vuelve concreto: Yahoo y Google
difieren 33% entre ellos.

### 15.4 · El conteo — y la única decisión que te queda

**25 verificadas · 5 grises · G2 VERDE** (piso 15).

| | |
|---|---|
| por método (una serie, divisor 1) | **20** |
| individuales (CEMEX, KOF, LIVEPOL, KIMBER, LASITE) | **5** |
| **total** | **25** |

Las 5 grises, con su motivo:

| emisora | motivo |
|---|---|
| **AMX** | series con precio distinto, 23.7% — **pero verificaba a 1.0%** |
| FEMSA | series con precio distinto, 25.9% (§15.2) |
| TLEVISA | error 5.6% > 5% — ver §15.5 |
| PINFRA | series con precio distinto, 31.7%, y sin referencia |
| PE&OLES | sin ninguna serie de precio en `bmv_precios` |

**AMX es la decisión que te queda.** Verificó a 1.0% contra una referencia, y
la regla nueva la manda a gris por 23.7% de dispersión. Las dos lecturas son
defendibles:

- **gris** (lo que implementé, siguiendo tu regla): el 1.0% puede ser
  circular, porque Yahoo podría estar haciendo el mismo cálculo naíf;
- **verificada**: AMX consolidó su capital en la serie B, así que las otras
  dos casi no pesan y la aproximación se sostiene — pero *eso no lo sabemos
  sin el desglose*, lo estamos suponiendo.

Cuesta una emisora de 30 y **G2 queda verde en los dos casos**. Implementé
gris porque es lo que pediste; decime si la querés verificada y es un renglón.

### 15.5 · TLEVISA: para contestar si el precio está viejo

No puedo mirar `bmv_precios` desde acá, así que el job ahora **reporta la
fecha del precio usado y su antigüedad en días**, más un top 5 de los precios
más viejos. Con eso, el 5.6% se separa solo: si el CPO trae fecha fresca, el
problema es el divisor 117 o el conteo de acciones; si trae semanas, es una
cotización rancia y no hay nada que arreglar en la fórmula.

### 15.6 · Google Finance queda como segunda fuente

`google.com/finance/quote/TICKER:BMV`, registrada en
`mercado-cap-referencia.json`. Y el registro acepta **varias referencias por
emisora**: si una cuadra y otra no, el estado **no** es "verificada" — es
`discrepancia_entre_fuentes`, porque dos fuentes públicas que no coinciden es
información, no un problema a esconder quedándose con la cómoda.


---

## 16. Serie sin mercado — y el verde falso que casi abre

Pediste que una serie con volumen 0 en los últimos 30 días no cuente, ni para
la dispersión ni para el cálculo. Implementado, con una salvedad que vale más
que la regla.

### 16.1 · Por qué la regla es correcta y no un atajo

Una cotización sin volumen no es la opinión del mercado sobre esa serie: es el
último número que quedó pegado. Si AMX A y L no operan, el capital de AMX
cotiza **entero** como B, y aplicarle el precio de B a todas las acciones deja
de ser una aproximación — es lo que pasa. La regla no relaja nada: describe
mejor.

Y tiene una consecuencia que resuelve a PINFRA sin referencia: con **una sola
serie viva**, la fórmula deja de tener parámetros libres, así que la emisora
pasa a ser elegible para la validación por método. `elegibleMetodo` cuenta
ahora **series con mercado**, no series del catálogo.

### 16.2 · El modo de falla que la regla podía abrir

Si la ventana de 30 días se ancla en el reloj y la cosecha de precios está
atrasada, **todas** las series dan volumen 0. Toda la dispersión desaparece, y
FEMSA, AMX y PINFRA se ponen **verdes solas**.

Un verde por falta de datos es peor que un gris: el gris se ve.

Dos anclas lo cierran:

1. **La ventana se ancla en `max(fecha)` de la tabla, no en `now()`.** Así se
   mide "los últimos 30 días de datos que tenemos", y el atraso de la cosecha
   se reporta aparte (`datos_precio.dias_atraso`) en vez de disfrazarse de
   series muertas.
2. **La serie líquida nunca se puede declarar sin mercado.** Si *ella* no
   operó, el problema son los datos: se devuelve `datos_rancios`, **no se
   excluye ninguna serie**, y la emisora va a gris con ese motivo. Fail
   closed.

Y el volumen `null` cuenta como **con** mercado: no saber no es saber que no.
Mantener la serie en la dispersión empuja hacia el gris, que es el lado
seguro. Hay un test para cada una de las tres.

### 16.3 · Qué esperar de la corrida

| emisora | qué decide |
|---|---|
| **AMX** | si A y L tienen volumen 0 → una serie viva → **verificada** (ya tiene referencia a 1.0%) |
| **PINFRA** | si L tiene volumen 0 → una serie viva → **verificada por método**, sin necesitar referencia |
| **FEMSA** | **sigue gris**: UB y UBD operan las dos, y la dispersión de 26% no se va |

No puedo anticipar los volúmenes —no llego a `bmv_precios`— así que lo
resuelve la corrida. Si AMX y PINFRA pasan, el conteo va a **27 verificadas y
3 grises** (FEMSA, TLEVISA, PE&OLES).

Y si `datos_precio.lectura` viene con texto, esta prueba no es confiable en
esa corrida y hay que releer el resto con desconfianza — está puesto arriba
del reporte justamente para eso.

---

## 17. Las dos regresiones del 2026-09-21, y por qué eran dos cosas distintas

La corrida de cierre de R0 destapó dos rojos que parecían el mismo problema
—"los datos no llegan"— y no lo eran. Uno era una **cosecha que nunca se
agendó**; el otro, **dos instrumentos leyendo tablas distintas**.

### 17.1 · `job=unidades`: 27 de 27 en `datos_rancios`

`datos_precio.ultima_fecha = 2026-09-15`, seis días de atraso, las 27 emisoras
rancias, G2 en 2 verificadas de 15.

**La regla hizo lo correcto.** Con precios del martes no se calcula una
capitalización de hoy: eso es la regla 2 del encargo ejerciéndose, y el
resultado —un rojo— es el resultado bueno. El problema estaba antes.

**La causa, medida y no supuesta:** `vercel.json` no tenía ningún cron para
`/api/bmv-harvest`. Aparecía sólo bajo `functions` (`maxDuration: 300`), que
declara cuánto puede durar, no cuándo corre. La cosecha de Fase 1b fue manual.
No murió un cron: nunca lo hubo.

Y agendar `?job=historicos` no habría alcanzado: su rango termina en
`hist_hasta`, la fecha del censo `?job=emisoras`. Alcanzado el censo, cada
emisora cae en `d >= h` y se salta; el cron habría contestado 200 y "nada
pendiente" todos los días. Un job de relleno histórico no es un job diario, por
mucho que se le ponga un horario.

**Lo que entra:** `?job=precios` (la cola diaria, contra la última sesión
esperada del calendario y no contra el censo), agendado `10 22 * * 1-5` —una
hora después del cierre de la BMV—, idempotente sin ledger, que salta las
suspendidas y las que no tienen ni una fila. El hueco del 16 al 18 de
septiembre se rellena con `?job=precios&desde=2026-09-16&hasta=2026-09-18`;
son **dos** sesiones y no tres, porque el 16 es Independencia.

**Y el aviso, que es lo que faltaba de verdad:** `/api/cron-status` gana
`datos[]`, que mide `max(fecha)` de `bmv_precios` contra el calendario de la
BMV y pone `ok: false` con más de una sesión de atraso. Vigilar el latido no
bastaba por partida doble: no había cron que latiera, y un cron que corre,
contesta 200 y no escribe nada deja el latido verde.

El mismo medidor entra en `?job=unidades`. El aviso de esa corrida estaba en
`dias_atraso > 30` —la ventana de volumen—, así que con seis días de atraso
salió `lectura: null`: el reporte se calló justo cuando las 27 emisoras se
caían. Ahora suena con la primera sesión perdida, que es cuando todavía se
arregla con una cosecha.

### 17.2 · El censo daba G1 rojo con la tabla llena

`?job=universo` reportaba 538 de 553 filas completas y `g1_proyectado.verde`,
y el censo del mismo día contestaba `{"candidatos":579,"con_cap":45,
"con_sector":0,"con_cap_y_sector":0,"verde":false}`.

No era un desacuerdo sobre los datos. `censoQ1` se escribió **antes** de que
existiera `mercado_universo_us` y seguía leyendo `arena_market_cap` más el
canal `assets:sector` del buffet —de ahí `con_sector: 0`, la caché del día
estaba vacía—. Dos instrumentos midiendo cosas distintas con el mismo nombre.

**Lo que entra:** una sola consulta (`SQL_UNIVERSO_US`) y una sola función
(`censoUniversoUsDesdeTabla`), importadas por los dos endpoints. El medidor
—`censoUniversoUs`, con los umbrales congelados de `CRITERIOS`— no cambió:
cambió de dónde saca las filas. De paso, `g1_proyectado` dejó de contar a mano
con 120 y 9 escritos al vuelo y sin mirar la frescura de la cap: ahora es el
mismo veredicto, con las mismas razones, que va a dar el censo.

Las tablas viejas siguen contándose, pero **aparte y etiquetadas**
(`legado_no_es_la_medicion`): sirven para explicar una divergencia como esta,
no para producir un número. Y una tabla vacía no se disimula cayendo al
legado: se dice, con el comando que la llena.

---

## 18. La columna que la cosecha nunca llenó

Con los precios al día —`ultima_fecha: 2026-09-18`, `sesiones_de_atraso: 0`,
`avanzo: true`— las 27 emisoras seguían en `datos_rancios` y G2 en 2 de 15.

**La bandera nunca leyó `dias_atraso`.** Leía volumen, y el problema estaba un
nivel más abajo: **`bmv_precios.volumen` está vacía en las ~570,000 filas.**
`/v2/historicos` devuelve `[cierre, importe]` y nada más — está escrito en el
propio cosechador desde la Fase 1b (`nota_columnas_vacias`). La consulta de
`?job=unidades` hacía:

```sql
sum(coalesce(p.volumen, 0)) as volumen_ventana
```

y ese `coalesce` convertía **"no medido" en "cero"**. Cero actividad en la
serie líquida es, por la regla de #239, "cosecha atrasada": las 27, incluida su
serie líquida, gris punteado. El ancla que escribimos para no abrir un verde
falso abrió un gris falso por el otro lado.

Tres cosas cambian:

1. **`sum(p.volumen)` sin `coalesce`.** En Postgres, la suma de una columna
   toda nula es `NULL`, y `NULL` es el dato: *no se midió*. Se agrega
   `sum(p.importe)`, que sí viene lleno, y los conteos de filas con cada uno.
2. **La actividad se mide con `volumen` o, si no hay, con `importe`**, y el
   JSON dice con cuál (`actividad_medida`). Si no hay ninguno de los dos, la
   emisora sale como `actividad_no_medible` — que **no es rancio**: la tabla
   puede estar al día y lo que falta es la columna. No se excluye ninguna
   serie y la dispersión decide, como antes de #239.
3. **El atraso de la cosecha entra como veredicto en SESIONES**, calculado por
   `bmv-frescura` y pasado a `clasificaSeries`; ya no se deduce de ceros. Un
   lunes son dos o tres días de calendario y cero sesiones.

`datos_rancios` conserva el nombre pero ahora dice su causa: `cosecha_atrasada`
(en sesiones) o `serie_liquida_sin_actividad` (con la tabla al día: o la serie
del registro está mal, o la emisora dejó de cotizar). Son dos arreglos
distintos y antes salían con el mismo texto.

**La lección, que es la cara y no el parche.** Las pruebas de #239 pasaban en
verde con fixtures que traían `volumen_ventana` con números. La tabla real
nunca los tuvo. *Un instrumento validado contra una columna que la cosecha no
llena mide otra cosa* — y lo hace en silencio, porque el fixture y el código
están de acuerdo entre ellos. Por eso las pruebas de esta rebanada incluyen el
caso que la producción sí entrega: `volumen` y `importe` los dos en `null`.

---

## 19. G2 medido dos veces, y con dos reglas distintas

El mismo día, con los mismos datos:

```
?job=unidades → g2_proyectado {verificadas: 26, verde: true}
?job=todo     → q2 {sin_referencia: 30}, rojos [g2, g9]
```

Es el mismo problema que G1 tuvo hasta #241, y con la misma forma: **el censo
medía por su cuenta.** `censoQ2` usaba `capMxCandidatas` + `veredictoCapMx`
contra la cap pública de Yahoo — y Yahoo `quoteSummary` devuelve **401 Invalid
Crumb** desde Vercel para todos los símbolos, así que las 30 emisoras salían
`sin_referencia` y G2 no podía ponerse verde aunque estuviera bien. Mientras
tanto `?job=unidades` leía `_lib/mercado-cap-referencia.json`, aplicaba el
divisor del registro y la regla de series, y contaba 26.

**Una sola función.** `evaluaG2` vive en `_lib/mercado-r0.js` con los tres
pasos completos (calcular → validar el método → decidir el estado), y
`SQL_G2` tiene las cuatro consultas que la alimentan. Los dos endpoints corren
esas consultas y llaman a esa función; el que construye y el que mide ya no
pueden discrepar. Los umbrales entran por parámetro en vez de importarse —así
no se cierra un ciclo con `mercado-fase0.js`— y la salida **declara con qué
umbrales midió**.

Yahoo se sigue pidiendo, pero como **medición y no como veredicto**: un 401
medido es un dato, y el día que vuelva a contestar queremos enterarnos. Va
bajo `yahoo_quotesummary` con esa etiqueta encima.

### 19.1 · La cláusula que había que retirar, y por qué no es aflojar

`censoQ2` exigía además que **las cinco emisoras nombradas** —WALMEX, FEMSA,
AMX, GMEXICO, GFNORTE— salieran verificadas. R0 demostró que dos de ellas no
pueden:

- **FEMSA** cotiza en UB (165) y UBD (207.66), dos unidades de 5 acciones que
  difieren 26%, y el XBRL da un **total** sin desglose por serie. La cap
  calculada está estructuralmente mal aunque el divisor esté bien. Va gris
  punteada con motivo "series con precio distinto, sin desglose" — decisión
  tomada el 2026-09-20, con tres referencias públicas que tampoco coinciden
  entre sí (Yahoo 837B, Google 628B, cálculo 703B).
- **GFNORTE** no tiene acciones en el XBRL ni cap pública que pedir. Opción B,
  gris punteado, confirmado dos veces.

Las dos son **grises por diseño, con su motivo en la hoja**. Exigirles verde
era pedirle a la compuerta que contradijera una decisión ya tomada: G2 no
podía cerrarse nunca, dijera lo que dijera el resto de las 30.

La cláusula se retira en **`CRITERIOS` v3**, con esas dos razones escritas en
el propio objeto. **Ningún umbral se movió:** el 5% por emisora sigue en 5, y
el piso de verificadas sigue en 15. Queda versionado para que el cambio se lea
en el diff en vez de aparecer sin firma — que es exactamente para lo que se
congelaron los criterios.

---

## 20. Un número que solo existe en una URL no existe para la compuerta

Con el evaluador ya unificado (#245), `?job=todo` seguía dando `g2` rojo:

```
"solo 0 emisoras verificadas: 0 con referencia individual + 0 por método"
```

Cero, no 26. El evaluador era el mismo; lo que no era el mismo era **la
entrada**. Las 10 referencias capturadas el 20-sep se habían pasado por
`?manual=CLAVE:CAP` en la URL de `?job=unidades`, y
`_lib/mercado-cap-referencia.json` —que es lo único que el censo lee— seguía
vacío. Un parámetro de URL no es un estado del sistema: vive lo que dura la
petición.

Las 11 filas (las 10 de Yahoo más la segunda de FEMSA desde Google Finance)
quedan **persistidas en el registro**, cada una con su `fuente`, su
`capturada_en` y quién la capturó — las tres cosas que separan una referencia
de un número suelto.

### 20.1 · `?manual=` pasa a ser override, y por una razón concreta

Mientras el registro estuvo vacío, sumar y reemplazar eran lo mismo. Con 11
filas adentro ya no, y la diferencia **cambia veredictos**: por la regla
`varias_por_emisora`, una emisora con dos referencias que no coinciden sale
`discrepancia_entre_fuentes`, o sea **gris**. Sumando, probar una cap
corregida en prod pondría gris a una emisora ya verificada — el ensayo
cambiaría el resultado en vez de medirlo.

Así que `?manual=` **aparta** las filas del archivo para las claves que
nombra, y lo apartado **se reporta** (`desplazadas_por_override`): un override
silencioso es una referencia que desapareció sin que nadie lo dijera. El censo
no acepta `?manual=` en absoluto, a propósito: mide lo que está guardado.

### 20.2 · La fecha en que esto se apaga solo

Las 11 se capturaron el mismo día, así que **vencen el mismo día**:
`capturada_en` 2026-09-20 + `vigencia_dias` 14 = **2026-10-04**. Y ese día G2
no baja un poco: se cae entero. Sin referencias individuales no hay muestras
que validen el método, así que se van también las que verificaban **por**
método.

Que se caiga está bien —es la regla de caducidad funcionando, y arrastrar un
verde viejo sería peor—. Lo que no puede pasar es que se caiga **por
sorpresa**. Por eso `vigenciaDelRegistro` viaja en cada corrida de los dos
endpoints (`vigencia_referencias`), avisa tres días antes, y una vez vencidas
lo dice como **razón** de G2 en vez de dejar un cero sin explicar.
