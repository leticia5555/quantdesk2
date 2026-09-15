# SCOPE — Reglamento v4 "estilo arena" (relanzamiento lunes 21, 13:30 UTC)

> **Estado:** PROPUESTA. Los rieles de abajo son mi recomendación con su
> justificación; ninguno está en código todavía. Se prueban contra el histórico
> de T1 (§7) antes de congelarse.
>
> Entra **todo junto** el lunes 21 a las 13:30 UTC, en el mismo `season_started`
> que aplana los siete libros y los resetea a $100k. `PROMPT_VERSION` sube a
> `arena-pm-v4`: las métricas de T2 y T3 **no son comparables**.

## El cambio de fondo

El PM deja de entregar **una lista de órdenes** y entrega un **portafolio
objetivo**: peso % por ticker, signo para corto, % en cash. El motor calcula la
diferencia contra lo que hay y ejecuta.

No es cosmético. Cambia qué se le está midiendo al modelo: hoy se mide *"¿qué
comprás mañana?"*, y a partir del 21 se mide *"¿cómo querés estar posicionado?"*.
Un PM que entrega órdenes puede dejar el 60% del libro sin opinión y nadie se
entera. Uno que entrega pesos **tiene que pronunciarse sobre todo el libro en
cada corrida, por construcción** — es la regla #9 de la T2 (pronunciamiento
obligatorio por posición) convertida en el formato mismo de la respuesta, en vez
de una auditoría que cuenta los olvidos después.

---

## 1. Los rieles — mi propuesta

Vos pusiste cuatro números. Endoso tres y **propongo cambiar uno**, y agrego los
tres que faltan (los cortos necesitan rieles propios).

| # | Riel | Tu número | Mi propuesta | Por qué |
|---|---|---|---|---|
| R1 | Bruto por nombre, **largo** | 30% | **25%** | ver §1.1 |
| R2 | Bruto por nombre, **corto** | (30%) | **15%** | ver §1.2 — la asimetría del corto |
| R3 | Exposición **bruta** total | ≤ 100% | **≤ 100%** ✅ | sin apalancamiento, y más estricto que Reg T |
| R4 | Exposición **neta** | — | **−50% a +100%** | falta un riel; ver §1.3 |
| R5 | **Corto** total | — | **≤ 50%** del equity | ver §1.2 |
| R6 | Por **sector** | 50% | **50%** ✅ | ver §1.4 (con una decisión de datos) |
| R7 | **Cash** libre | 0-100% | **0-100%** ✅ | el cash es una posición; que pueda ir a 100% es el punto |
| R8 | Nº de posiciones | sin tope | **sin tope** ✅ | ver §1.5 |

Definiciones, para que no haya ambigüedad al implementar:

```
peso(n)   = valor_mercado(n) / equity          (con signo: corto negativo)
bruto     = Σ |peso(n)|                        ≤ 100%   (R3)
neto      = Σ  peso(n)                         ∈ [−50%, +100%]  (R4)
corto     = Σ |peso(n)| sobre los n < 0        ≤ 50%    (R5)
cash      = 1 − neto                           (queda derivado, no se declara aparte)
```

### 1.1 Por qué 25% y no 30% en el largo

Con el tope de 8 posiciones retirado y el máximo por nombre subiendo de 15%, el
riesgo de concentración pasa a ser **lo único** que limita al modelo. A 30%, tres
nombres son el 90% del libro: lo que la temporada mediría ya no es "qué modelo
construye mejor un portafolio" sino "qué modelo eligió mejor sus tres nombres".
Con 20 sesiones y siete agentes, eso es ruido de selección, no señal de modelo.

A 25% el modelo sigue pudiendo expresar convicción fuerte (un nombre a un cuarto
del libro no es timidez) pero necesita **cuatro** nombres para llenar el libro en
vez de tres y pico. Es medio punto de libertad a cambio de que el resultado
signifique algo.

**Es el riel del que estoy menos seguro** y el primero que revisaría con los
datos de §7: si en el histórico de T1 el PM nunca pasó del 15% por voluntad
propia, el tope es decoración y da igual 25 que 30.

### 1.2 Los cortos necesitan rieles propios — la asimetría

Este es el punto donde "aplicar los mismos rieles a los cortos" sería un error, y
vale la pena escribirlo entero porque es lo que más fácil sale mal cuando se
habilitan cortos desde el día 1:

**Un largo que sale mal se encoge. Un corto que sale mal crece.**

- Una posición larga del 25% que cae 50% pasa a pesar ~14% del libro. El error se
  auto-limita: el riel sigue respetado sin hacer nada.
- Una posición corta del 25% cuyo subyacente **sube** 50% pasa a pesar ~37%
  negativo, y sigue creciendo. El riel se viola solo, y la pérdida no tiene techo
  teórico.

Por eso: **R2 = 15% por nombre corto** (no 25%) y **R5 = 50% de corto total**. Un
corto del 15% que se duplica en contra llega a ~30% — el mismo lugar donde un
largo *empieza*. Es la simetría que importa: no la del peso inicial, la del peso
después de que el trade salga mal.

**Tres rieles más, solo para cortos:**

- **R9 — solo `shortable` y `easy_to_borrow`.** Se leen del activo en Alpaca. Si
  el campo no está disponible, **fail closed**: la orden se descarta. Un corto en
  un nombre *hard-to-borrow* puede sufrir un buy-in forzado que cierra la
  posición a precio de mercado sin que el PM decida nada — y eso no es un
  resultado del experimento, es ruido del broker.
- **R10 — precio mínimo $5 para cortos** (contra $1 de los largos). Los sub-$5
  son donde viven los squeezes, y un squeeze es exactamente el evento que la red
  determinista no puede frenar a tiempo.
- **R11 — el buy-in forzado se journalea como tal.** Si el reconcile encuentra
  una posición corta cerrada sin una orden nuestra, se marca
  `forced_buy_in` en vez de dejar que aparezca como una decisión del PM. Una
  salida que el PM no decidió no puede contar en su contra ni a su favor.

### 1.3 Falta un riel: el neto (R4)

Con solo `bruto ≤ 100%` el modelo puede legalmente ponerse **0% largo y 100%
corto**. En una ventana de 4 semanas eso no es un portafolio: es una apuesta
direccional única que va a dominar el resultado del agente por completo, y el
post-mortem no va a poder separar "este modelo elige bien" de "este modelo le
atinó a la dirección del S&P en septiembre".

`neto ∈ [−50%, +100%]` deja al modelo:

- irse a 100% cash (defensivo),
- market-neutral (50/50),
- net-short moderado (hasta −50%, que es una postura bajista de verdad),
- 100% largo,

y le prohíbe solo la apuesta que haría irrelevante todo lo demás. El límite
inferior es −50% y no −100% por la misma asimetría de §1.2.

### 1.4 Sector 50% — con una decisión de datos pendiente

El número está bien: con 25% por nombre, el tope de sector empieza a morder en el
tercer nombre del mismo sector, que es donde debe morder.

**El problema no es el número, es el dato.** Hoy el sector solo llega vía
`profile2.finnhubIndustry` del deep-dive, que es **best-effort**: un nombre sin
cobertura de Finnhub viaja con `null` y el harness lo tolera. Un riel de sector
convierte ese `null` en un agujero: un PM podría concentrar el 100% en un sector
usando nombres sin clasificar.

Mi propuesta: **los nombres sin sector caen en un bucket `UNKNOWN` que tiene el
mismo tope de 50%**, y el hecho se journalea por nombre. Así el agujero existe
pero está acotado y contado. La alternativa —descartar toda orden sin sector—
convierte una falla de cobertura de Finnhub en una prohibición de operar, y eso
castiga al PM por un problema nuestro. → **Decisión D3.**

### 1.5 Sin tope de posiciones: qué lo reemplaza

Retirar el tope de 8 está bien —era un proxy tosco de diversificación y los
rieles de concentración hacen ese trabajo mejor— pero deja un hueco: nada impide
un libro de 60 nombres al 1.5% cada uno. Eso no es riesgoso, es **ilegible**: el
razonamiento publicado (que es el producto) se vuelve una lista, y el
pronunciamiento por posición se vuelve impracticable dentro del techo de tokens.

No propongo un tope duro. Propongo un **peso mínimo: 2% por posición**. Un
objetivo por debajo de 2% se trata como 0 (no se abre, o se cierra si existe).
Justificación doble: a 0.15% de costo de ida y vuelta, una posición del 1% tiene
que moverse ~15% para pagar su propio costo de entrada y salida; y el techo
natural que impone (≤ 50 posiciones) mantiene la respuesta dentro de los 6000
tokens.

---

## 2. El motor de diferencias

El PM entrega pesos; el motor los convierte en órdenes. Cuatro decisiones de
diseño que hay que fijar **antes** de escribir una línea, porque cada una cambia
lo que se está midiendo:

### 2.1 Omisión = 0% = salida

Un ticker que el PM **no menciona** en su portafolio objetivo se interpreta como
**peso 0**, y si está en el libro **se cierra**.

La alternativa ("lo que no menciono se queda como está") suena más segura y es
peor: deja que el PM ignore posiciones y que la omisión pase por decisión. Con
omisión = salida, **todo el libro se re-afirma en cada corrida o desaparece**. Es
la regla #9 de la T2 hecha estructura en vez de auditoría.

Es un cambio fuerte y hay que decirlo en el prompt con todas las letras, porque
un modelo que no lo entienda liquida su libro por descuido el primer día.

### 2.2 Banda de no-negociación: 2 puntos porcentuales

Solo se genera una orden si `|objetivo − actual| ≥ 2pp` del equity **o** la pata
es un cierre completo (objetivo 0).

Sin banda, el motor negocia todos los días contra el drift de precios: una
posición que el PM quiere al 12% y que cerró en 11.6% generaría una compra de
$400 que cuesta ~$0.60 en costos y no expresa ninguna decisión. Veinte de esas
por día es churn con etiqueta de estrategia. La banda hace que en el journal solo
aparezcan las órdenes que el PM **decidió**, no las que el mercado desalineó.

### 2.3 Orden de ejecución: primero lo que libera, después lo que consume

`ventas → coberturas → compras → cortos nuevos`. Si no, una corrida que rota el
libro entero viola el riel de bruto a mitad de la secuencia o se queda sin cash
para las compras. El motor **re-valida los rieles después de cada pata**, no solo
sobre el objetivo declarado.

### 2.4 Un objetivo que viola un riel se descarta ENTERO, no se escala

Si los pesos suman más de 100% de bruto, o un nombre pasa su tope, la respuesta
se descarta completa y la corrida journalea `aborted_target_violates_rails` con
el riel y el nombre. **No se normaliza, no se recorta al tope, no se escala
proporcionalmente.**

Es la misma regla de la casa que ya gobierna el guard ("descarta, no ajusta"),
y acá importa más: escalar un portafolio objetivo lo convierte en un portafolio
que el PM nunca propuso, y después el journal publicaría como suyo un
razonamiento que no corresponde a las posiciones. Mejor cero órdenes y la razón
escrita.

---

## 3. La red determinista se queda — y es lo que nos distingue

Esto no se toca, y ahora aplica a cortos:

| Red | Largo (T2, vigente) | Corto (propuesto) |
|---|---|---|
| Stop catastrófico | −22% desde la entrada | **+20% en contra** desde la entrada |
| Trailing: arma | +15% a favor | **−15% a favor** (el precio bajó 15%) |
| Trailing: dispara | −8% desde el pico | **+8% desde el mínimo** |
| Time stop | 45 días | **45 días**, igual |
| Breaker de libro | −20% de drawdown → liquida y detiene | **igual**, incluye coberturas |

El stop del corto es **+20% y no +22%** por §1.2: cuando un corto está 20% en
contra ya creció de 15% a ~18% del libro, y los dos puntos extra de tolerancia
cuestan más en un corto que en un largo.

Que la red exista es la diferencia declarada con Alpha Arena. Ahí un modelo puede
llevar su libro a cero y eso es el espectáculo; acá el experimento es "qué hace
un modelo **dentro de una disciplina de riesgo**", que es la única pregunta cuya
respuesta le sirve a alguien.

---

## 4. Mismo prompt, mismo buffet, lentes rotadas

Sin cambios respecto de lo acordado: mismo prompt, misma temperatura *(con la
salvedad del 2026-09-15: Fable 5.1 no acepta `temperature` — ver
`docs/arena-modelos-2026-09-15.md` §2)*, mismo buffet para los siete, con las
lentes rotadas del anti-herding.

**Una nota que el v4 hace urgente:** con portafolio objetivo, el herding se
vuelve más fácil de medir (la correlación entre los vectores de peso de los siete
agentes es un número directo) y también más consecuente — siete libros idénticos
con pesos idénticos es un experimento con n=1. Propongo publicar esa correlación
por corrida como métrica de primera clase de la temporada.

---

## 5. Qué hay que tocar

| Archivo | Cambio | Tamaño |
|---|---|---|
| `_lib/arena-guard.js` | `validateTargetPortfolio()` **nueva**, al lado de `validateActions` (que se queda para la red determinista) | grande |
| `_lib/arena-diff.js` | **nuevo** — objetivo + libro → órdenes. JS puro, sin I/O | mediano |
| `_lib/arena-exits.js` | los stops con signo | chico |
| `api/arena-run.js` | el contrato del prompt y el parser | mediano |
| `_lib/alpaca.js` | `shortable`/`easy_to_borrow`, órdenes de venta en corto | chico |
| `docs/arena.md` | el reglamento v4 completo | — |

`validateActions` **no se borra**: la red determinista sigue emitiendo órdenes,
no pesos. Conviven.

---

## 6. Riesgos de esto, sin adornos

1. **Un modelo que no entienda "omisión = salida" se liquida solo el día 1.** Es
   el riesgo más concreto del cambio. Mitigación: decirlo tres veces en el
   prompt y que el smoke del v4 verifique que los siete devuelven un objetivo que
   incluye todas sus posiciones.
2. **Los cortos en paper no se comportan como en real.** Alpaca paper no simula
   costo de borrow, ni buy-ins, ni el ensanchamiento del spread en un squeeze.
   Los resultados de los cortos van a ser **optimistas** y hay que etiquetarlos
   así, del mismo modo que etiquetamos los fills del replay.
3. **Cuatro semanas no alcanzan para juzgar una estrategia long/short.** Ya no
   alcanzaban para long-only. Con cortos, la varianza sube. La etiqueta de la
   casa —experimento sin validación estadística— se vuelve más necesaria, no
   menos.
4. **El reset a $100k borra la comparabilidad con T1 y T2.** Es deliberado y está
   bien, pero significa que el 21 el historial acumulado deja de servir como
   baseline y empezamos de cero por tercera vez.

---

## 7. Cómo probar los rieles contra T1 (lo que pediste)

Los rieles no se congelan hasta correr esto. Cada uno tiene una pregunta y un
resultado que lo mataría:

| Riel | Qué medir sobre el histórico de T1 | Qué lo falsifica |
|---|---|---|
| R1 (25% largo) | distribución del peso máximo por nombre que el PM eligió por su cuenta | si nunca pasó de 15%, el tope es decoración → da igual 25 o 30 |
| R4 (neto ≥ −50%) | cuántas corridas habrían querido net-short | si son 0, el riel no cuesta nada y queda como seguro barato |
| R6 (sector 50%) | % de corridas donde 2+ nombres del mismo sector superan 50% | si mordía seguido, el PM ya estaba concentrado por sector y el riel cambia la estrategia, no solo el riesgo |
| R6-`UNKNOWN` | % de nombres de T1 sin `finnhubIndustry` | si es > 20%, el bucket UNKNOWN es un agujero grande y hay que buscar otra fuente de sector |
| Banda 2pp | cuántas órdenes de T1 movían < 2pp | mide directo cuánto churn se ahorra |
| Peso mínimo 2% | cuántas posiciones de T1 pesaban < 2% | si eran muchas, el mínimo cambia el estilo del PM, no solo limpia el ruido |

Todo eso sale de `arena_journal` + el snapshot de `docs/arena-replay-scope.md`.
**Sugiero correrlo con el replay**: es literalmente para lo que sirve — probar
una regla nueva contra días históricos sin esperar semanas de cron.

---

## 8. Decisiones que necesito antes de codear

**D1 — ¿25% o 30% por nombre largo?** Mi propuesta es 25 (§1.1). Es el riel del
que menos seguro estoy y el que más cambia el carácter del experimento.

**D2 — ¿Aceptás los rieles asimétricos de corto** (15% por nombre, 50% total,
+20% de stop)? Si preferís simetría total largo/corto, decímelo — pero entonces
quiero dejar escrito en el reglamento que un corto puede violar su propio riel
sin que nadie haga nada, porque crece cuando pierde.

**D3 — Nombres sin sector:** ¿bucket `UNKNOWN` con tope propio (mi propuesta), o
se prohíbe operar un nombre sin sector?

**D4 — ¿Confirmás "omisión = salida"?** (§2.1). Es el cambio con más riesgo
operativo del v4 y la alternativa es defendible.

**D5 — ¿La banda de no-negociación va en 2pp?** Más angosta = más fiel al
objetivo y más churn; más ancha = menos costos y más deriva.

**D6 — ¿Los cortos entran con la red de seguridad ya probada, o hay una semana de
cortos apagados** mientras se valida el plumbing de Alpaca (shortable,
easy_to_borrow, buy-in)? Habilitarlos el día 1 del relanzamiento es lo que
pediste; mi única reserva es que el camino de venta en corto **nunca corrió en
producción** y el lunes 21 estrena reglamento, modelos y cortos a la vez.

**D7 — ¿Publicamos la correlación de pesos entre agentes** como métrica de
temporada (§4)?
