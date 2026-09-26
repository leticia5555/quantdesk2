# ARENA — LO QUE VIVE EN DOS CAMINOS

Fecha del barrido: **2026-09-25**, ampliado el **2026-09-26** (fila 8).
Verificado LEYENDO los archivos en `main` a esas fechas, no de memoria. Cada fila trae archivo y línea para que el próximo
que lo lea pueda desmentirme en treinta segundos.

## Por qué existe este doc

En una semana aparecieron cinco bugs con la misma forma, no cinco bugs:

1. **El `client_order_id` sin corrida.** El contrato de acciones ya lo había
   arreglado. El del objetivo nació después y no se llevó el arreglo. 180 de
   204 órdenes rechazadas por id duplicado — el 39% de la semana.
2. **El ladder de escalamiento del stop.** Correcto el 2026-07-30, roto el
   2026-09-14, apagado diez días. El otro camino nunca se enteró.
3. **El pareo de fills.** Un mapa indexado por `client_order_id` consultado por
   símbolo. 100% de fallo silencioso, 462 órdenes sin precio.
4. **Los cortos en las salidas** (`arena-exits-short.js`). Ya cerrado: hoy los
   importan los dos caminos.
5. **`ARENA_AGENTS` como sinónimo de "la liga".** Lo rompió este mismo doc: la
   primera entrada del registry que no era un competidor tumbó cinco pruebas y
   apagó el anuncio de apertura de la T3. Ver abajo.

No es mala suerte. Son dos motores que hacen el mismo trabajo — el camino del
**contrato objetivo** (el modelo emite pesos, el motor determinista arma las
órdenes) y el de la **red determinista de riesgo** (stops, breaker, trailing) —
que nacieron con meses de diferencia y comparten la mitad de las reglas por
copia en vez de por referencia. Un arreglo entra por un camino y el otro sigue
con la versión vieja hasta que produce una factura.

**Este doc es el inventario, no el arreglo.** Lo que está arreglado dice que lo
está. Lo que no, dice qué cuesta y qué rompe si se deja.

---

## 1. La aritmética del límite marketable — DOS COPIAS

| | camino objetivo | camino red determinista |
|---|---|---|
| función | `limiteMarketable` | `riskExitLimit` |
| archivo | `api/_lib/arena-objetivo-vivo.js:120` | `api/_lib/arena-exits.js:392` |
| firma | `(referencia, lado, banda)` | `(reference, band, side)` |
| vocabulario del lado | `'buy'` / `'sell'` | `'cover'` / `'sell'` |
| guarda de nulos | `Number.isFinite` inline | `num()` local |
| banda por default | `BANDA_MARKETABLE` (0.5%) | `exitBand(...)` (~12%) |

El cuerpo es **idéntico**: misma dirección, mismo `Math.round(p * 100) / 100`,
misma condición final `> 0 ? x : null`.

**Los parámetros están cruzados**: el segundo y el tercero van al revés entre
las dos. Quien lea una y llame a la otra pasa la banda donde va el lado.

Lo corrí antes de escribirlo, contra el árbol de hoy:

```
limiteMarketable(100, 0.12, 'sell')  → null      (llamada cruzada)
limiteMarketable(100, 'sell', 0.12)  → 88        (llamada correcta)
riskExitLimit(100, 'sell', 0.12)     → null      (llamada cruzada)
riskExitLimit(100, 0.12, 'sell')     → 88        (llamada correcta)
```

**Las dos fallan cerradas, y eso hay que decirlo antes que la queja.** La
guarda de la banda (`Number.isFinite` en una, `num()` en la otra) atrapa el
string, devuelve `null`, y el caller descarta la orden con su motivo. No hay
mispricing silencioso. Iba a escribir que sí lo había, hasta que lo corrí.

Lo que queda es real igual, pero es más chico de lo que parece: una orden que
se descarta con el motivo *"no se pudo calcular el límite marketable (ref
100)"* cuando la causa verdadera fue un argumento en la posición equivocada.
Ruidoso, sí; diagnosticable, no. Y ninguna prueba lo cubre, porque cada función
tiene la suya y ninguna llama a la otra.

Las bandas SÍ tienen que seguir siendo distintas (0.5% para rebalanceo, ~12%
para un stop que tiene que llenar). Eso es un argumento, no una función aparte.

> **Costo del arreglo:** bajo. Una función con la firma de `riskExitLimit`
> (`reference, band, side`), el lado normalizado a un vocabulario, y un test
> que corra los dos juegos de casos contra ella.

## 2. El lado de la orden — TRES MAPAS

- `LADO_ALPACA = { buy, cover, sell, short }` — `arena-objetivo-vivo.js:133`
- `ALPACA_SIDE = { sell: 'sell', cover: 'buy' }` — `arena-exits.js:142`
- `a.alpaca_side || (a.side === 'cover' ? 'buy' : 'sell')` — inline en
  `submitRiskExits`, `arena-run.js`

Los tres contestan la misma pregunta: las cuatro intenciones del rebalanceo
(`buy`/`sell`/`short`/`cover`) contra los dos lados que Alpaca conoce. El
tercero es el peor: es el mapa escrito a mano en el sitio de uso, y es el que
se olvida cuando entra una intención nueva.

> **Costo:** bajo. Un mapa exportado, tres call sites.

## 3. Los estados terminales de una orden — TRES CONJUNTOS

| constante | archivo | contenido |
|---|---|---|
| `TERMINAL` | `api/arena-run.js:3508` | filled, canceled, expired, rejected, replaced, done_for_day |
| `TERMINALES` | `api/_lib/arena-fills.js:51` | **los mismos seis, byte a byte** |
| `EXIT_NONFILL` | `api/arena-run.js:1634` | los mismos **menos** `filled` |

`TERMINAL` y `TERMINALES` son la misma lista escrita dos veces con nombres que
se diferencian en una letra. `EXIT_NONFILL` es derivable: `TERMINAL` sin
`filled`. Si Alpaca agrega un estado terminal, hay que acordarse de tres sitios
y uno de ellos se llama casi igual que otro.

> **Costo:** muy bajo. Una constante y una derivación.

## 4. El nombre del mismo campo — `referencia` vs `reference`

- El objetivo escribe `referencia:` — `arena-objetivo-vivo.js:194`
- La red determinista escribe `reference:` — `arena-exits.js:453`, y
  `attributeRiskExit` lo copia tal cual — `arena-run.js:1451`

Misma cosa: el precio contra el que se calculó el límite. Dos nombres.

**Cómo se sabe que esto ya costó:** el lector tiene que aceptar los dos.
`api/_lib/arena-fills.js:183` dice `orden.referencia ?? orden.reference`. Esa
línea es la cicatriz: existe porque la primera versión leyó uno solo y las
salidas de riesgo salieron sin precio de referencia en la pantalla.

Lo mismo pasa con el motivo del descarte: el objetivo escribe `motivo` (ocho
sitios en `arena-objetivo-vivo.js`), la red escribe `reason`.

> **Costo:** medio, y es el único de la lista con datos viejos en juego. Las
> filas ya escritas en `arena_journal` tienen la ortografía de su día. El
> arreglo es escribir UNA ortografía de hoy en adelante y dejar el `??` del
> lector como compatibilidad hacia atrás, con el comentario diciendo hasta qué
> fecha hace falta.

## 5. `attributeRiskExit` estampa `side: 'sell'` a mano — DEFECTO ABIERTO

`api/arena-run.js:1450`.

`buildRiskExits` ya resolvió el lado bien: `arena-exits.js:449` dice *"El lado
sale del PLAN, ya no escrito a mano"* y entrega `'sell'` o `'cover'`.
`submitRiskExits` lo traduce bien y manda un `buy` a Alpaca. Pero la fila del
journal pasa por `attributeRiskExit`, que descarta el lado del plan y escribe
`'sell'` fijo.

**Consecuencia medible:** una cobertura de corto disparada por la red sale al
broker como compra y queda en el journal como venta. `resultadoContraEntrada`
la lee como cierre de largo y calcula el P&L con el signo invertido — o no lo
calcula. En la pantalla, una cobertura de la red no muestra resultado.

Es UNA línea: `side: a.side || 'sell'`. No la toqué en este barrido porque el
encargo era inventariar, y porque cambia lo que se escribe en el journal — eso
va con su propio test.

## 6. `buildPositionMeta` no lo llama el camino vivo — HUECO ABIERTO

`api/_lib/arena-memory.js:137` calcula `days_in_position`, el pico desde la
entrada y el trailing stop. Lo llaman:

- `api/arena-run.js:1914` — `runArenaDecide` (contrato de ACCIONES, retirado)
- `api/arena-run.js:2613` — `runArenaRiskNet` (la red determinista)
- `api/arena-watch.js:123` — el vigilante

**No lo llama `runAgenteObjetivo`** (`api/arena-shadow.js:116`), que es el
camino del contrato vigente. Ése arma `rail_meta` con `buildRailMeta` (precio,
tradable, sector — lo que los rieles necesitan) y nada más.

O sea: el tercer campo faltante que pediste en su momento no falta. Está
calculado, en un archivo importado por el vecino, y el camino que decide hoy no
lo pide. El costo no es el cálculo, es pasar las series y los `opens` por una
función que hoy no los recibe.

## 7. `ARENA_AGENTS` como sinónimo de "la liga" — CERRADO HOY

El sexto caso, y lo produjo el barrido mismo. Hasta el 2026-09-25 toda entrada
del registry era un competidor, así que medio repo usaba el array crudo para
decir "los siete". Las tres sondas de ruta —que no compiten— rompieron cinco
pruebas de un saque y, más grave, `announceSeasonOpen` (`arena-run.js:3113`)
comparaba `activeAgents().length < ARENA_AGENTS.length`: 7 < 10, la apertura de
la T3 no se anunciaba nunca. El id es idempotente y la T2 ya está sellada, así
que no se habría visto hasta noviembre.

Arreglado como norma, no como parche: `competidores()` en
`api/_lib/arena-registry.js`, y las llamadas que preguntaban por el padrón
apuntan ahí. **No** se reusó `activeAgents()`: contesta otra pregunta —"quién
corre hoy", que cambia con `ARENA_LEAGUE` y con `enabled`. Un agente sacado un
día sigue siendo competidor; una sonda apagada nunca lo fue.

## 8. El presupuesto de herramientas — EL ESTIMADOR NO LEE EL MOTOR

Encontrado el 2026-09-26 costeando la sonda de ruta, o sea: buscando otra cosa.

| | valor | dónde |
|---|---:|---|
| lo que el motor permite | **20** | `TOOL_BUDGET.fixed_round`, `_lib/arena-tools.js:67` |
| lo que el estimador asume | **8** | `roundTools = 8`, `_lib/arena-watch.js:691` |
| lo que se publica como supuesto | **8** | `tools_per_fixed_round: 8`, `_lib/arena-watch.js:755` |

El 8 está escrito a mano y no lee `TOOL_BUDGET`. Consecuencia: si alguien sube
`ARENA_TOOLS_MAX` en Vercel, el motor gasta más y el "peor caso" publicado no
se mueve un centavo. Y el breaker de B9 se compara contra ese número.

**Mitigante real, y hay que decirlo antes que la queja:** el reloj del loop son
185s (`relojDisponible({scanMs: 0})`), y a ~20s por vuelta no entran 20
herramientas — entran 8 o 9. O sea que el 8 hoy da un número *empíricamente*
razonable. Pero lo da por casualidad: nadie derivó el 8 del reloj, y el día que
el reloj o el precio se muevan, el estimador seguirá diciendo 8.

> **Costo:** bajo. O el estimador lee `TOOL_BUDGET`, o el 8 se deriva del reloj
> con el comentario que lo explique. Lo que no puede quedar es un 8 sin
> procedencia.

## 9. Lo que está en dos lugares A PROPÓSITO

Un inventario que no dice esto invita a "unificar" algo que se separó por una
razón.

**La referencia de precio.** La red determinista usa `exitReference` (último
cierre COMPLETO → `current_price` → `avg_entry`); el objetivo usa
`meta[sym].price`, el snapshot vivo. Distintas porque un stop que se preciara
con el tick de ahora mismo se dispararía con el ruido intradía, y un rebalanceo
que se preciara con el cierre de ayer mandaría límites que no llenan. La
diferencia es la decisión.

**Las bandas.** 0.5% para rebalanceo, ~12% para una salida de riesgo. Valores
distintos de la MISMA regla: la regla se comparte, el número es argumento.

**El orden de la lista de nombres del día.** Cambia por agente a propósito
(anti-herding). No es divergencia, es el experimento.

---

## Cómo se lee esta lista

Del más barato al más caro, y del más silencioso al más ruidoso:

| # | qué | costo | qué rompe si se deja |
|---|---|---|---|
| 3 | estados terminales ×3 | muy bajo | un estado nuevo de Alpaca leído como no-terminal en uno de los tres |
| 2 | mapas de lado ×3 | bajo | una intención nueva olvidada en el mapa inline |
| 1 | límite marketable ×2 | bajo | firmas cruzadas: falla cerrada, pero con un motivo que apunta al lado equivocado |
| 5 | `side: 'sell'` a mano | **una línea** | una cobertura de la red sin P&L en pantalla |
| 4 | `referencia`/`reference` | medio | el lector ya paga con un `??`; el próximo campo nuevo repite el patrón |
| 6 | `buildPositionMeta` ausente | medio | el camino vivo decide sin edad de posición ni trailing |
| 8 | el estimador asume 8 herramientas, el motor permite 20 | bajo | el peor caso publicado no se mueve si sube `ARENA_TOOLS_MAX`; el breaker se compara contra él |
| 7 | `ARENA_AGENTS` = la liga | hecho | — |

Lo que NO está en esta tabla porque ya se arregló esta semana: el
`client_order_id` (ahora `clientOrderIdObjetivo` + `minutoDeCorrida`
compartidos por los dos caminos), el ladder del stop, el pareo de fills y los
cortos de salida.

La norma que sale de todo esto está en `docs/arena.md` → **B41**, con la
prueba que decide si estás mirando una regla o dos, y la regla de operación:
cuando entre al registry el próximo agente que no compita, se vuelve a barrer.
