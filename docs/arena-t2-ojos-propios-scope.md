# SCOPE — Arena T2 "ojos propios" (relanzamiento lunes 21, 13:30 UTC)

> **Estado:** PROPUESTA, para los bloques B1-B12 del encargo. Los números de los
> rieles (§B6) son mi recomendación con su justificación; se prueban contra T1
> antes de congelarse. Nada de esto está en código todavía.
>
> Entra **todo junto** en el `season_started` del lunes 21 13:30 UTC
> (`arena-t2-ojos-propios-2026-09-21`), que aplana las siete cuentas y resetea a
> $100k. `PROMPT_VERSION` sube a `arena-pm-v4`. Las métricas de antes y después
> **no son comparables**, y el corte queda anunciado en el journal.
>
> El cambio de modelos del martes 15 va aparte y ya está:
> `docs/arena-modelos-2026-09-15.md`.

## El cambio de fondo

El PM deja de recibir un **buffet curado por nosotros** y pasa a tener **ojos
propios**: un tablero del mercado y herramientas para investigar lo que él
decida. Y deja de entregar **órdenes** para entregar un **portafolio objetivo**.

Las dos mitades importan por la misma razón. Hoy medimos a un modelo al que le
damos 5 candidatos preseleccionados y le pedimos órdenes sobre ellos: eso mide
*"¿sabe elegir entre lo que le pusimos enfrente?"*. A partir del 21 medimos
*"¿qué mira, cómo investiga y cómo se posiciona?"* — que es la pregunta cuya
respuesta le interesa a alguien.

Y trae un subproducto que es producto: **la secuencia de herramientas que llamó
es publicable**. "Cómo investigó" es contenido que nadie más está mostrando.

---

# B1 · UNIVERSO (~600 nombres)

S&P 500 + Nasdaq 100 + hasta 100 movers/most-actives del día que pasen el filtro
de admisión. Se reconstruye cada mañana **antes de la apertura** y se cachea en
KV.

- **El filtro de admisión ya existe** desde el martes 15
  (`_lib/arena-admission.js`): precio ≥ $5, market cap ≥ $1B, volumen en dólares
  ≥ $10M/día. B1 lo reusa tal cual, no lo reimplementa.
- **Point-in-time**: la reconstrucción usa velas **cerradas** del día anterior.
  Nada del cierre del día que se opera. Esto ya está resuelto en
  `fetchPriceAndVolume`, que filtra la vela viva.
- **Composición de los índices**: hay que decidir la fuente (§D1). No hay un
  endpoint gratis y confiable de "constituyentes del S&P 500 hoy". Las opciones
  reales son una lista curada en repo (como `screener-universe.js`, que ya hace
  esto con ~150 nombres), FMP (de pago, `sp500_constituent`), o los holdings de
  SPY/QQQ publicados por el emisor. **Point-in-time de verdad no vamos a tener**
  — una lista de hoy aplicada a ayer arrastra survivorship bias, y hay que
  decirlo en vez de fingir lo contrario.
- **Costo de construcción**: ~600 nombres × (precio+volumen) es mucho para hacer
  a demanda. Va en un cron pre-apertura, con el resultado en KV y `built_at`
  visible. Si el cron no corrió, la corrida usa el universo de ayer **y lo dice**
  en el journal; no se reconstruye a medias.

# B2 · TABLERO (~3-4K tokens, todos los agentes lo reciben igual)

Índices y VIX · calor por sector (11 ETFs, 1d/5d/1m) · top 30 gainers/losers ·
top 20 volumen inusual (RVOL vs 20d) · breakouts a máx/mín de 52 semanas ·
earnings de los próximos 5 días dentro del universo · titulares de
M&A/upgrades/downgrades del día · **su** libro (posiciones, P&L, cash, órdenes
abiertas) y sus últimas 3 decisiones.

- **Orden de filas aleatorizado por agente y por corrida** (anti-herding, §B8).
  La semilla es `hash(agent_id + run_id)` — **determinista**, para que el replay
  y el post-mortem puedan reconstruir exactamente lo que vio cada uno. Un
  `Math.random()` acá haría el journal irreproducible.
- **Presupuesto de tokens del tablero**: se mide y se journalea. 3-4K es el
  objetivo, no una esperanza: si una sección crece, otra cede. El tablero es la
  parte cacheable del prompt y por eso conviene que sea estable.
- **Ojo con la caché**: el tablero es idéntico para los siete **salvo el bloque
  del libro y el orden aleatorizado**. Eso rompe el prefijo compartido. Ver §D2.

# B3 · HERRAMIENTAS (tool use, máx 8 llamadas/corrida, ≤1.5K tokens cada una)

`screener(...)` · `noticias(...)` · `ficha(ticker)` · `sector(etf)` opcional.

- **El tope es del harness, no del prompt.** La llamada 9 se rechaza con un
  `tool_result` que dice "presupuesto agotado, decidí con lo que tenés". Un tope
  que solo vive en el prompt no es un tope.
- **Cada resultado se trunca a 1.5K y el truncamiento se dice** dentro del
  resultado (`"…(N filas más, truncado)"`). Un modelo que no sabe que le
  cortaron los datos razona sobre una lista que cree completa.
- **Todo cacheado por día** donde aplica (`screener`, `ficha`, `sector`);
  `noticias` por hora. La caché es por **contenido de los argumentos**, no por
  agente: si dos agentes piden lo mismo, se paga una vez. Eso no es herding —
  es el mismo dato, y el tablero ya es común.
- **La secuencia completa se journalea** (llamada, argumentos, resumen del
  resultado, ms) y se publica en `/liga`. Es el "cómo investigó".
- **Determinismo para el replay**: las respuestas de herramientas se journalean
  **enteras** (no solo el resumen) en una columna aparte, o el replay del §B12 no
  puede reproducir la corrida.
- **Anthropic vs OpenRouter**: el tool use tiene forma distinta en cada uno.
  `_lib/arena-model.js` ya normaliza la respuesta; ahora tiene que normalizar
  también el *loop* de herramientas. Es el trabajo más subestimado de B3 y
  conviene medirlo antes de prometer el miércoles (§D4).

# B4 · CADENCIA

Vigilante cada 5 min (sin cambios) + **3 rondas fijas**: apertura+30, 12:00 ET,
cierre−30. La nocturna pasa a **reporte/journal sin decisiones**.

- Corridas por disparador: acotadas al nombre + tablero, **máx 3** llamadas de
  herramienta (contra 8 de las rondas fijas).
- **La red determinista sigue decidiendo con cierres completos**, una vez al día.
  Moverla a intradía la volvería un stop-loss de tick, que es otro producto.
- **La nocturna sin decisiones es un cambio de contrato**: hoy es la corrida que
  produce el plan. Al volverse reporte, el "plan anterior" que se reinyecta pasa
  a ser el de la última **ronda fija**, no el de la nocturna. Hay que cambiar esa
  consulta o el PM recibe un plan viejo de horas.

# B5 · SALIDA = PORTAFOLIO OBJETIVO

`{pesos: {TICKER: ±%}, cash: %, tesis por posición, cambios vs libro actual}`.
Signo negativo = corto. El motor de rebalanceo calcula la diferencia y ejecuta.

Cuatro decisiones que hay que fijar antes de codear, porque cada una cambia lo
que se mide:

1. **Omisión = 0% = salida.** Un ticker que el PM no menciona se cierra. La
   alternativa ("lo que no menciono se queda") deja que la omisión pase por
   decisión. Con omisión = salida, **todo el libro se re-afirma en cada corrida
   o desaparece** — es el pronunciamiento obligatorio de la T2 hecho estructura.
   **Riesgo real:** un modelo que no lo entienda se liquida solo la primera
   corrida. Va dicho tres veces en el prompt y verificado en el smoke.
2. **Banda de no-negociación: 2pp.** Solo se opera si `|objetivo − actual| ≥ 2pp`
   del equity, o si es un cierre completo. Sin banda, el motor negocia contra el
   drift de precios todos los días: una posición que el PM quiere al 12% y cerró
   en 11.6% generaría una orden que no expresa ninguna decisión. Con banda, en el
   journal solo aparecen las órdenes que el PM **decidió**.
3. **Orden de ejecución**: ventas → coberturas → compras → cortos nuevos. Si no,
   una rotación completa viola el riel de bruto a mitad de secuencia o se queda
   sin cash. Los rieles se re-validan **después de cada pata**.
4. **Un objetivo que viola un riel se descarta ENTERO, no se escala.** Misma
   regla de la casa que el guard ("descarta, no ajusta"). Escalar un portafolio
   objetivo lo convierte en uno que el PM nunca propuso, y el journal publicaría
   como suya una tesis que no corresponde a las posiciones.

# B6 · RIELES — mi propuesta

Endoso tres de los tuyos, **propongo cambiar uno** y **agregar tres** que faltan.

| # | Riel | Tuyo | Mi propuesta |
|---|---|---|---|
| R1 | bruto por nombre, **largo** | 30% | **25%** |
| R2 | bruto por nombre, **corto** | (30%) | **15%** |
| R3 | exposición **bruta** | ≤ 100% | ≤ 100% ✅ |
| R4 | exposición **neta** | — | **−50% a +100%** |
| R5 | **corto** total | — | **≤ 50%** |
| R6 | por **sector** | 50% | 50% ✅ |
| R7 | **cash** | 0-100% | 0-100% ✅ |
| R8 | **mínimo** por posición | 2% | 2% ✅ |

```
peso(n) = valor_mercado(n) / equity      (con signo; corto negativo)
bruto   = Σ |peso(n)|   ≤ 100%           neto = Σ peso(n) ∈ [−50%, +100%]
corto   = Σ |peso(n)| sobre n < 0  ≤ 50%
```

**R1 — por qué 25 y no 30.** Sin tope de posiciones, la concentración es lo único
que limita al modelo. A 30%, tres nombres son el 90% del libro: la temporada
mediría "qué modelo eligió mejor sus tres nombres", no cómo construye un
portafolio. Con 20 sesiones y siete agentes eso es ruido de selección. A 25% la
convicción fuerte sigue siendo expresable (un cuarto del libro no es timidez) y
hacen falta cuatro nombres para llenarlo. **Es el riel del que menos seguro
estoy** y el primero que revisaría con los datos de §B12.

**R2/R5 — la asimetría del corto. Es el punto que más me importa de todo B6:**

> **Un largo que sale mal se encoge. Un corto que sale mal crece.**

Un largo del 25% que cae 50% pasa a pesar ~14%: el error se auto-limita y el riel
se sigue respetando solo. Un corto del 25% cuyo subyacente **sube** 50% pasa a
~37% y sigue creciendo — **viola su propio riel sin que nadie haga nada**, y la
pérdida no tiene techo teórico. Un corto del 15% que se duplica en contra llega a
~30%, que es donde un largo *empieza*. La simetría que importa no es la del peso
inicial: es la del peso después de que el trade salga mal.

**Tres rieles más, solo para cortos:**

- **R9** — solo nombres `shortable` **y** `easy_to_borrow` en Alpaca.
  Fail closed si el campo no está. Un buy-in forzado cierra la posición sin que
  el PM decida: eso es ruido del broker, no resultado del experimento.
- **R10** — precio mínimo **$10** para cortos (contra $5 del universo). Los
  nombres baratos son donde viven los squeezes.
- **R11** — un cierre de corto sin orden nuestra se journalea `forced_buy_in`,
  no como decisión del PM.

**R4 — por qué falta.** Con solo `bruto ≤ 100%`, el modelo puede ponerse 0% largo
y 100% corto. En 4 semanas eso no es un portafolio: es una apuesta direccional
única que va a dominar el resultado, y el post-mortem no podrá separar "este
modelo elige bien" de "le atinó a la dirección del mercado en septiembre".

**R6 — el número está bien, el dato no.** El sector hoy solo llega por
`profile2.finnhubIndustry`, que es best-effort. Un riel de sector convierte el
`null` en un agujero: se podría concentrar el 100% usando nombres sin clasificar.
Propongo bucket **`UNKNOWN` con el mismo tope de 50%**, journaleado por nombre.
Prohibir operar sin sector castiga al PM por una falla de cobertura nuestra.
→ **D5.**

**Sobre el slippage de 5 bps:** acá hay algo que aclarar. Estas son órdenes
**reales** en Alpaca paper, así que el fill ya trae su propia fricción. Cobrar 5
bps sintéticos **encima** sería contar el costo dos veces. Dos caminos honestos:
(i) solo fills reales y se mide el **turnover** como métrica de churn; o (ii) un
"libro de fricción" paralelo que solo se usa para el scoring, nunca para el
equity real, y se publica al lado. Prefiero (i) + turnover: el número ya existe y
no inventa nada. → **D6.**

# B7 · RED DETERMINISTA, extendida a cortos

| Red | Largo (vigente) | Corto (propuesto) |
|---|---|---|
| Stop catastrófico | −22% desde entrada | **+20% en contra** |
| Trailing: arma | +15% a favor | **−15%** (el precio bajó 15%) |
| Trailing: dispara | −8% desde el pico | **+8% desde el mínimo** |
| Time stop | 45 días | 45 días |
| Breaker de libro | −20% drawdown → liquida y detiene | igual, incluye coberturas |

El stop del corto es +20% y no +22% por §B6: a 20% en contra la posición ya creció
de 15% a ~18% del libro, y los dos puntos extra cuestan más en un corto.

> **Ya arreglado el 15:** el pico del breaker no tenía corte por temporada, así
> que el reset del 21 a $100k contra el pico de la T2 habría dado ~−23% de
> drawdown → los siete liquidados y HALTED en su primera corrida. Ver
> `docs/arena-modelos-2026-09-15.md` §8a.

# B8 · ANTI-HERDING Y MÉTRICAS

Orden aleatorio del tablero · **lente primaria rotativa** por agente y día
(momentum / catalizador / valor / reversión), dicha en el prompt como "hoy mirá
primero por…" y journaleada.

Métricas de post-mortem: % de libros que comparten el ticker más común ·
solapamiento promedio par a par · cuántas posiciones vinieron de herramientas vs
del tablero.

- **La lente es una rotación determinista** (`lente = LENTES[(hash(agent) + día)
  % 4]`), no aleatoria: tiene que ser reproducible y tiene que garantizar que en
  4 días cada agente pasó por las cuatro.
- **Con portafolio objetivo, el herding se vuelve medible de verdad**: la
  correlación entre los vectores de peso de los siete es un número directo.
  Propongo publicarlo por corrida como métrica de primera clase.
- **Advertencia honesta**: la lente rotativa es un **confound deliberado**. Dos
  agentes con lentes distintas el mismo día no son comparables ese día. Mide
  diversidad a costa de comparabilidad diaria; a lo largo de la temporada se
  promedia, pero hay que decirlo en el post-mortem.

# B9 · PRESUPUESTO

Contador de tokens y costo por agente por corrida en el journal. Breaker: si el
gasto del día de la liga supera `ARENA_DAILY_BUDGET_USD` (default 30), se apagan
las rondas fijas y quedan solo disparadores, con aviso en el journal.

**Estimación con los números del 15** (Fable 5.1 a $10/$50 por MTok):

| | tokens | Anthropic (2 agentes) |
|---|---|---|
| entrada por corrida (tablero 4K + herramientas ~8K + libro) | ~14K | $0.14 |
| salida por corrida (techo 6000, razonamiento incluido) | 6K | $0.30 |
| **por corrida** | | **~$0.44** |
| 3 rondas fijas × 2 agentes | | **$2.64/día** |
| peor caso 12 corridas × 2 agentes | | **$10.56/día** |

Los cinco de OpenRouter siguen **sin precio** hasta que el smoke los lea del
catálogo. Con eso, **$30/día de default es razonable para las rondas fijas y
queda justo en el peor caso**. Dos cosas lo mueven mucho:

- **La caché es la palanca grande.** El tablero y el reglamento son estables; si
  caché bien puesta convierte ~10K de entrada en lectura cacheada, la entrada
  baja ~10× (§D2).
- **El breaker que apaga las rondas fijas deja solo disparadores** — que en un
  día volátil pueden ser *más* caros que las rondas. El breaker tiene que
  apagar **por corrida**, no por tipo de corrida. → **D7.**

# B10 · PROMPT

Mismo prompt, mismo tablero y mismas herramientas para los siete. Explica el
mandato (equity a 4 semanas), los rieles, el formato de salida y que puede
investigar antes de decidir.

> **Salvedad del 15:** "misma temperatura" ya **no** se puede cumplir — Fable 5.1
> rechaza `temperature` con 400. Los dos de Anthropic corren sin ella + effort
> medio; los cinco de OpenRouter con 0.7. Lo que sí se preserva es la identidad
> de parámetros entre `claude` y `control`.

# B11 · PÁGINA /liga

Por agente: portafolio objetivo, tesis, **secuencia de investigación** y lente
del día. El control sigue marcado como control.

La secuencia de investigación es lo más publicable de todo el proyecto y merece
diseño propio, no una lista de llamadas: "buscó semis con RVOL alto → leyó las
noticias de NVDA → pidió la ficha de AMD → no compró ninguna" es una historia.

# B12 · ENTREGA

| Bloque | Día | PR |
|---|---|---|
| A (modelos, smoke, A4) | martes 15 | ✅ [#132](https://github.com/leticia5555/quantdesk2/pull/132) |
| B1-B3 (universo, tablero, herramientas) | miércoles 16 | |
| B4-B7 (cadencia, objetivo, rieles, red) | jueves 17 | |
| B8-B11 (anti-herding, presupuesto, prompt, /liga) | viernes 18 | |
| **SOMBRA** | jueves 17 y viernes 18 | decide y journalea con `shadow=true`, **cero órdenes** |

**Sobre la sombra:** corre en paralelo a la liga viva, con el mismo tablero y las
mismas herramientas, y journalea en las tablas nuevas. Dos condiciones para que
sirva:

1. **`shadow=true` tiene que ser imposible de confundir con una corrida real.**
   Tabla aparte, no una columna en `arena_journal`. Una bandera booleana en la
   misma tabla es una consulta mal escrita de distancia de contaminar el
   post-mortem.
2. **La sombra gasta dinero de verdad.** Dos días × 7 agentes × 3 rondas es
   ~$16 solo en Anthropic, más OpenRouter. Va contra el mismo
   `ARENA_DAILY_BUDGET_USD` o lo revienta.

**Tests** (uno por pieza, todos sin red): rebalanceo (diff, banda, orden de
ejecución) · rieles (los ocho, más los tres de corto) · cortos (signo, stops
invertidos, forced buy-in) · red de riesgo · presupuesto (breaker, contador) ·
filtros (ya está: `arena-admission`) · herramientas (tope de 8, truncado a 1.5K,
caché) · sombra (cero escrituras a tablas reales, cero órdenes a Alpaca).

---

# Cómo probar los rieles contra T1

Cada riel con su pregunta y con el resultado que lo mataría:

| Riel | Qué medir sobre T1 | Qué lo falsifica |
|---|---|---|
| R1 (25%) | distribución del peso máximo por nombre que el PM eligió solo | si nunca pasó de 15%, el tope es decoración |
| R4 (neto) | cuántas corridas habrían querido net-short | si son 0, es un seguro barato |
| R6 (sector) | % de corridas con 2+ nombres del mismo sector > 50% | si mordía seguido, cambia la estrategia, no solo el riesgo |
| R6-UNKNOWN | % de nombres de T1 sin `finnhubIndustry` | si > 20%, el bucket es un agujero grande |
| banda 2pp | cuántas órdenes de T1 movían < 2pp | mide directo el churn que se ahorra |
| R8 (mín 2%) | cuántas posiciones de T1 pesaban < 2% | si eran muchas, cambia el estilo, no solo limpia ruido |

Sale de `arena_journal` + el snapshot de `docs/arena-replay-scope.md`. **Sugiero
correrlo con el replay** — es literalmente para lo que sirve.

---

# Decisiones que necesito

**D1 — Composición de los índices (B1).** ¿Lista curada en repo, FMP de pago, o
holdings de SPY/QQQ? Y: ¿aceptás el survivorship bias declarado, o querés
congelar la lista el día 1 de la temporada y no tocarla?

**D2 — Caché vs tablero por agente (B2/B9).** El tablero es idéntico para los
siete salvo el libro y el orden aleatorizado. Si el bloque del libro va **al
final** y el orden aleatorizado solo afecta secciones posteriores al breakpoint,
los siete comparten prefijo cacheado y la entrada baja ~10×. Pero el orden
aleatorizado **es** el anti-herding. ¿Sacrificamos algo de aleatorización por la
caché, o pagamos la entrada completa por agente?

**D3 — ¿25% o 30% por nombre largo?** (R1). Mi propuesta es 25.

**D4 — El loop de tool use entre proveedores (B3).** Es el trabajo más
subestimado del miércoles. ¿Querés que B1-B2 salgan el miércoles y B3 el jueves
si el loop multi-proveedor no está verde, en vez de comprometer los tres?

**D5 — Nombres sin sector:** ¿bucket `UNKNOWN` con tope propio, o se prohíbe
operar sin sector?

**D6 — Slippage de 5 bps:** las órdenes son reales en paper y ya traen fricción.
¿Turnover como métrica de churn (mi propuesta), o libro de fricción paralelo solo
para scoring?

**D7 — El breaker de gasto (B9):** apagar las rondas fijas deja solo
disparadores, que en un día volátil pueden ser más caros. ¿Lo cambiamos a un tope
por corrida, o a "se apaga todo salvo la red determinista"?

**D8 — ¿Cortos desde el día 1?** Es lo que pediste y lo doy por decidido, pero lo
dejo escrito: el lunes 21 estrena reglamento, modelos, ojos propios **y** cortos
a la vez, y el camino de venta en corto **nunca corrió en producción**. Si algo
se cae ese día, no vamos a saber cuál de las cuatro cosas fue.
