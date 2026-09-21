# SCOPE — Experimento "earnings-beat": ¿QuantDesk le gana a Polymarket?

> **Estado: FASE 0 → GO.** El censo (`/api/earnings-beat?smoke=1`) contestó las
> cuatro preguntas y el candado se cumple con margen. Veredicto y números en
> §0.0. Las revisiones PIT quedaron **CERRADAS: fuera de v1** (§1.4). Lo que
> sigue es la **Fase 1 (cosecha, `pm_earnings_markets`)**, en su propia rama.
>
> Los `CRITERIOS` de la Fase 2 siguen **congelados** en
> `api/_lib/earnings-beat.js` y **pineados por test**, sin haberse movido en
> ninguna de las cinco vueltas — incluida la tolerancia de ±1 día, que el censo
> propuso subir y **no se subió** (§1.3).

## 0.0 VEREDICTO DE LA FASE 0 — **GO** (cerrado, números finales)

**Se puede construir el dataset del experimento con la API pública de
Polymarket.** Corrida final, ya con el filtro v1 y el emparejamiento corregido:

| Medida | Valor | Umbral | ¿Cumple? |
|---|---|---|---|
| **Mercados cruzados con precio válido a T-24h** | **239** | ≥ 100 | **SÍ — 2.4×** |
| Cobertura | **sin truncar** (los 312 cruzados, completos) | — | el 239 es final, no un piso |
| Filtro v1 | **0 ruido de subcadena · 0 símbolo distinto** | — | limpio |
| Consenso declarado por Polymarket | **100%** de los mercados | — | el consenso propio está disponible siempre |
| Emparejamiento corregido | **sin pérdidas** | — | ningún mercado que cruzaba dejó de cruzar |

Las cuatro preguntas del encargo, contestadas:

| Pregunta | Respuesta |
|---|---|
| ¿Mercados de earnings resueltos, con símbolo, consenso y outcome? | **Sí** |
| ¿Historial de precios del token Yes? | **Sí**, con T-24h real |
| ¿Cruce con `pead_earnings`? | **Sí**, 312 cruzados |
| ¿Fuente PIT de revisiones gratis? | **No.** CERRADA, fuera de v1 (§1.4) |

**Lo que costó llegar acá, porque es la parte reutilizable:** cuatro de las
cinco vueltas no midieron Polymarket, midieron el instrumento. Un tope de
offset leído como "no hay mercados", un `limit=5` disfrazado de catálogo, tres
ejemplos haciéndose pasar por el conteo del candado, y un histograma de
desfases que era el trimestre siguiente. **Ningún `CRITERIO` se movió en
ninguna de las cinco** — incluida la tolerancia de ±1 día que el propio censo
propuso subir y no se subió.

## 0.1 Universo de v1: los 99, y no se amplía

**v1 se queda con los 99 símbolos del universo del PEAD.** No se amplía, y el
motivo es de método, no de pereza: **239 es 2.4× el candado**, y ampliar el
universo antes de saber si el modelo sirve es trabajo sin respuesta. Si la
Fase 2 sale **INCONCLUSO por muestra**, ahí se amplía **con razón** — sabiendo
qué pregunta responde la ampliación.

Congelado en `SIMBOLOS_V1` (`api/earnings-beat-harvest.js`) y con test.

## 0.2 La deuda que sí bloquea: el historial del PEAD

De los mercados que no cruzan, los que dicen `sin_reporte_posterior_a_la_creacion`
son mercados cuyo trimestre **todavía no está en `pead_earnings`**. Sin eso, los
mercados de **este** trimestre no tienen con qué emparejarse, y el problema
crece solo con cada trimestre que pasa.

**Pero el goteo del PEAD está apagado a propósito, y su cupo ya tiene dueño.**
El backtest PEAD cerró con NO-GO, su ledger quedó 99/99, y los **25
requests/día de Alpha Vantage se reasignaron al wheel**
(`docs/wheel-fase0.md` §4.3). Re-encenderlo **no es gratis**: es quitarle el
cupo a otro proyecto durante los días que dure la puesta al día.

Por eso lo que se entrega es **la decisión informada, no la decisión tomada**:

```bash
# CERO llamadas a AV: solo dice cuántos símbolos quedaron viejos y qué costaría
curl ".../api/pead-harvest?job=refresh&dry=1&secret=$CRON_SECRET"
#   → simbolos_viejos · costo_en_llamadas_av · dias_de_goteo_a_25_por_dia
```

`job=refresh` corre **antes** del gate de `PEAD_HARVEST_ENABLED` justamente
porque su razón de ser es *decidir si vale la pena prender el goteo*: detrás
del gate sería inalcanzable en el único momento en que hace falta. Sin `?dry=1`
devuelve esos símbolos a `pending`; el gasto real **no ocurre** hasta que
alguien prenda `PEAD_HARVEST_ENABLED=1` y le ponga un schedule.

**Las opciones, con su costo:**

| Opción | Costo | Cuándo conviene |
|---|---|---|
| Prender el goteo unos días | el wheel se queda sin cupo de AV ese tiempo | si el `dry-run` dice que son pocos símbolos |
| Partir el cupo (menos símbolos/día) | más lento para los dos | si los dos proyectos corren en paralelo |
| No hacer nada por ahora | los mercados del trimestre actual no cruzan | si la Fase 2 va a correr sobre trimestres ya cosechados |

La tercera es viable para arrancar: **la Fase 2 mide trimestres pasados**, que
ya están en la tabla. La deuda muerde cuando el experimento pase a tiempo real.

---

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
`connect_rejected … policy denial`). Re-sondeado en la segunda vuelta: sigue
bloqueado, y también `clob.polymarket.com` y `www.alphavantage.co`. O sea que
**ningún campo, endpoint ni límite de esta sección está verificado desde acá**,
y tampoco se pudo mirar la fila cruda de AV desde el sandbox — por eso la sonda
la **imprime** (§1.4) en vez de que yo la describa de memoria.

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

### 1.0 Lo que enseñó la primera corrida (dos hechos, ninguno sobre Polymarket)

**Hecho 1 — Gamma tiene TOPE DE OFFSET, y no es rate limit.** Paginar
`/markets` con offset creciente murió con **HTTP 422 en la página 6**. El
barrido alcanzó a ver **~500 mercados de decenas de miles**, así que su
resultado —"0 mercados de earnings"— **no dice nada sobre Polymarket**: dice
que el método era ciego. Un censo que confunde *no vi* con *no hay* miente con
números, y ése es exactamente el error que un censo existe para no cometer.

> El veredicto de esa corrida fue **INCONCLUSO por descubrimiento, no por
> fuente**. Sabemos además que los mercados existen: hay earnings resueltos
> desde el arranque de la ventana (p. ej. NMAX, resuelto en marzo).

El 422 queda registrado en el censo (`topes_de_offset`, con su offset y su
límite) para que **no vuelva a morder**. Va **aparte** de `rate_limit`: mezclar
"topé el offset" con "me estás limitando" llevaría a esperar y reintentar un
problema que no se arregla esperando.

**Hecho 2 — la sonda de revisiones tenía un falso positivo.** Marcó
`pit: SÍ` una respuesta que no es point-in-time. Ver §1.4: se corrigió la regla
y ahora la sonda **enseña la fila cruda**.

**Consecuencia de diseño:** el descubrimiento pasa de **barrido** a **búsqueda
dirigida** (§1.1b). El barrido queda como **control opcional** (`&barrido=1`),
nunca como el método — y cuando corre, sirve sobre todo para volver a registrar
el tope.

### 1.0b El "5" de la segunda corrida: un tope del cliente, no un catálogo

La segunda corrida devolvió **exactamente 5 filas en toda respuesta** — las 4
sondas del §1 y las 4 búsquedas del §2. Los "10 mercados de earnings" eran
**4×5 deduplicados**, no una población. Dos causas distintas, y se arreglan
distinto:

| Causa | Dónde | Por qué pasó |
|---|---|---|
| `limit: 5` explícito | las sondas del §1 | mío, para que las probes fueran baratas |
| `limit_per_type` **ausente** | la búsqueda del §2 | lo quité en la vuelta anterior "para no inventar parámetros", y sin él public-search sirve su **default**, que resultó ser 5 por tipo |

> **La lección no es "inventar parámetros".** Es que **no mandar un parámetro
> tampoco es neutral**: elige el default del servidor y lo disfraza de
> resultado. Un límite implícito es peor que uno explícito, porque el
> explícito se ve en el diff. Ahora el límite se **manda y se verifica**, con
> reintento pelado registrado si el servidor lo rechaza.

Y lo que la corrida sí dejó, que es material de verdad: el descubrimiento
dirigido **funciona**. Mercados con símbolo, consenso en la descripción, token
del Yes, y **precio real a T-24h** en COST y MU con 72 puntos de CLOB. El
problema nunca fue la fuente.

**Tres cosas cambian a partir de esto:**

1. La búsqueda **pagina** hasta agotar resultados, topar 422 o detectar que
   *la paginación no avanza* (si la página 2 trae los mismos ids que la 1,
   `public-search` no pagina: se declara y se corta, no se asume).
2. Las sondas publican **su propio tope** (`limite_de_la_sonda`) al lado del
   conteo, para que un número topado no se vuelva a leer como el tamaño del
   universo.
3. Entra el **camino D: búsqueda por símbolo** (§1.1b), que es el que apunta a
   la pregunta que decide el candado.

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
que matcheen `x-ratelimit*` / `retry-after`, cuenta las respuestas `429` y los
publica en `rate_limit`. Si Polymarket no publica presupuesto, la Fase 1 fija
cadencia conservadora y la mide con 429s — no con un número inventado.

**Un conteo que se cuida aparte:** `sin_fecha_de_resolucion` (mercados de
earnings cuya fecha no se pudo leer). **No se descartan** —se verían como
inexistentes— pero quedan fuera del cruce y de los ejemplos por su cuenta.

### 1.1b Descubrimiento dirigido: cuatro caminos, medidos por separado

El método ya no es "traer todo y filtrar". Son cuatro caminos, y cada uno reporta
**cuántos mercados de earnings aportó**, para que la Fase 1 herede el que
funciona en vez del que suena bien:

| Camino | Qué hace | Por qué puede fallar |
|---|---|---|
| **A. Búsqueda** | `gamma/public-search` con las **frases reales** con que se redactan estos mercados: `"beat quarterly earnings"`, `"beat its quarterly EPS estimate"` (+ dos genéricas). | Si la búsqueda solo indexa mercados vivos, los resueltos no aparecen. |
| **B. Tags** | De los mercados que A encontró saca sus **tags** (del mercado y del evento), y pagina **DENTRO** del filtro. | Si Gamma ignora `tag_id`, devuelve catálogo suelto: se detecta porque aporta filas pero **0 de earnings**. |
| **C. Racimo** | Desde un mercado de earnings salta a su **evento/serie** para enumerar los hermanos. | Si el mercado no expone `eventId`/`seriesId`, el camino se declara **no disponible**. |
| **D. Símbolo** | Una búsqueda **por cada símbolo del universo v0** (`"<TICKER> quarterly earnings"`). | Si la búsqueda no indexa el ticker, aporta 0 — y eso también es dato. |

**Por qué el camino D es el que importa.** La pregunta que decide el candado no
es "¿cuántos mercados de earnings hay en Polymarket?" sino **"¿cuántos hay de
las empresas que nosotros podemos modelar?"**. Buscar ticker por ticker es la
consulta más específica que podemos hacer, y atraviesa **las dos plantillas
observadas**, que es justo lo que una sola frase no logra:

| # | Forma | Ejemplo |
|---|---|---|
| 1 | pregunta con ticker | `Will Costco (COST) beat quarterly earnings?` |
| 2 | slug sin "beat" | `nke-quarterly-earnings-gaap-eps-…` |

La forma 2 **no dice "beat" en ninguna parte**: buscar solo por `"beat"` se
comería media población sin que nada fallara. De ahí que las frases del camino
A incluyan también `"quarterly earnings"` y `"GAAP EPS"`, y de ahí el camino D.

**Semillas, declaradas:** tags y racimo dependen de lo que A y D encuentren. El
censo publica cuántas semillas hubo y **cuántas traen tags o evento**, para
distinguir *"no había semillas"* de *"las semillas no traen tags"* — la vuelta
pasada esos dos casos se veían igual y no son lo mismo.

Dos decisiones que sostienen la honestidad del conteo:

- **B y C se alimentan de lo que A encontró**, no de tags que a mí me parezcan
  plausibles. Si A no encuentra nada, B y C se declaran *no disponibles* en vez
  de inventarse una semilla.
- **Paginar dentro del filtro sí alcanza**: el tope de offset muerde al
  catálogo entero, no a un tag con cientos de mercados.

Los cuatro se unen **deduplicando por `id`**, y cada mercado recuerda **por qué
camino entró** (`via`). De ahí sale `estrategia_ganadora`, que es el dato que
importa para la Fase 1.

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

### 1.2b El conteo del candado: T-24h en TODOS los cruzados

Tres ejemplos no miden nada. El candado exige **≥100 mercados cruzados con
precio válido a T-24h**, así que hay que pedirle el precio **a cada uno**.

- Se pide en **lotes con concurrencia 6** (145 requests en serie no entran en
  el presupuesto; 145 de golpe es una forma elegante de que te limiten).
- Si el presupuesto se acaba, **se declara truncado con cuántos alcanzó a
  ver**. Un conteo parcial que se sabe parcial sirve; uno parcial que se cree
  total, no.
- **Dos corridas sumables.** `&indice=N` arranca en el N-ésimo cruzado, y el
  censo publica `indice_inicial`, `indice_final` y
  `restantes_despues_de_esta_corrida`. Si los 312 no entran en 240s, se parte
  en dos y **se suman los válidos sin ambigüedad** — los índices están
  publicados justamente para que la suma no sea a ojo.
- Los "ejemplos" salen **del mismo lote**: cero requests extra.

Y el resultado se parte en las categorías que deciden, porque no todas cuentan:

| Categoría | ¿Cuenta para el candado? | Por qué |
|---|---|---|
| **válido** | **SÍ** | hay tick real ≤ T-24h y no está rancio |
| rancio | no | el precio existe, pero el último tick es mucho más viejo que T-24h: no dice lo que creemos |
| sin ticks antes de T-24h | no | el mercado no existía 24h antes de resolver |
| historial vacío / sin token / error | no | no hay dato, y se dice cuál de los tres |

El markdown compara el conteo de **válidos** contra el umbral congelado y dice
en letras si el candado se cumple, no se cumple, o si el conteo está truncado y
por lo tanto es un **piso**.

### 1.2c El ruido de la búsqueda por subcadena

La búsqueda por símbolo es **por subcadena**, y hay tickers que son palabras
comunes: `NOW` trajo 545 filas (las películas *"Now You See Me"*), `FTNT` 709,
`SNPS` 123. El filtro de earnings las descartó — pero **"el filtro descartó
bien" es una afirmación que hay que poder comprobar**, no creer.

Por cada símbolo que traiga ≥100 filas, el censo publica: cuántas trajo,
cuántas sobrevivieron, cuántas se descartaron, **una muestra de las aceptadas
para leerlas a ojo**, y el número que de verdad importa —
**`aceptados_con_otro_simbolo`**: un mercado aceptado cuyo símbolo resuelto no
es el que se buscó. Ése es exactamente el modo de falla que esta auditoría
persigue; si es 0, no se coló basura por la subcadena.

Además, la búsqueda por símbolo pagina **máximo 3 páginas** (las frases,
12): son 99 búsquedas, y el presupuesto vale más que la página 4 de
*"Now You See Me"*.

### 1.2d Filtro v1 — solo beat/miss de EPS

La corrida con GO destapó tres poblaciones que pasaban el filtro de "parece
earnings" **sin ser lo que el experimento mide**:

| Población | Ejemplo | Qué se hace |
|---|---|---|
| **Mercados de mención** | `Will X say "tariffs" during the earnings call?` | **FUERA.** Ocurren *en* un earnings call, pero no predicen beat/miss de nada |
| **Otras métricas de earnings** | los de `MO`: volumen de cigarros de Altria | **FUERA de v1**, documentado. Son earnings de verdad, pero no EPS. **v1 = solo beat/miss de EPS** |
| **Símbolo ajeno** | `GEV` apareciendo al buscar `GE`, `LYFT` al buscar `NOW` | **FUERA**, salvo que el título nombre explícitamente al símbolo resuelto |

**Se excluye por la FORMA del título, no por símbolo.** Prohibir `GEV` taparía
el síntoma y dejaría la puerta abierta para el siguiente ticker ruidoso; la
firma real es el verbo (`say`/`mention`) con una frase entre comillas, o el
`during … earnings call`.

**Y la regla dura, tal como se pidió:** si el símbolo resuelto ≠ el símbolo
buscado, el mercado **se descarta**, salvo que el título lo nombre explícitamente
(`$SYM` o `(SYM)`). Los dos hallazgos que la motivaron —26 de 36 aceptados de
símbolos ruidosos resolvían a otro símbolo— eran casi todos mercados de mención,
así que las dos reglas se refuerzan.

Para que el filtro sea **auditable** (el anterior aceptaba y descartaba sin decir
por qué), el censo publica **el conteo por motivo** y **una muestra de lo
descartado en cada uno**:

```
ok · mercado_de_menciones · no_es_beat_miss_de_eps · simbolo_distinto_al_buscado · no_parece_earnings
```

### 1.3 Cruce con la cosecha del PEAD

**Corrección de nomenclatura:** el encargo dice `pead_events`; esa tabla no
existe. La tabla real es **`pead_earnings`** (`api/_lib/pead-db.js`), con PK
`(symbol, reported_date)`. Y el universo v0 del PEAD tiene **99** símbolos, no
98 (`api/_lib/pead-universe.js` — contados, no estimados).

El cruce es por **símbolo + fecha ±1 día** (`CRITERIOS.tolerancia_dias_cruce`),
con el candidato más cercano cuando hay varios. La tolerancia no es cosmética:
la **fecha de resolución del mercado no es la fecha del reporte** — un mercado
AMC suele resolver al día siguiente.

**Los dos motivos de no-cruce apuntan a culpables opuestos**, y de eso depende
qué se arregla después:

| Motivo | Quién es el cuello de botella | Qué se hace |
|---|---|---|
| `simbolo_no_esta_en_pead_earnings` | **nuestro** universo v0 (99 símbolos) | ampliar la cosecha del PEAD sube el cruce; pelearse con Gamma no |
| `fecha_fuera_de_tolerancia` | el emparejamiento | revisar la tolerancia de ±1 día antes de tocar el universo |

El markdown del censo dice cuál de los dos manda, en letras, para que la
decisión no dependa de leer bien una tabla de conteos.

#### El histograma de 69 no era ruido: era el trimestre siguiente

El grueso de los "fuera de tolerancia" caía a **+90/+119 días** porque se
emparejaba contra el reporte **anterior**: MU resolvió el 30 de septiembre y se
casaba con el reporte de junio. Un mercado creado en septiembre **no puede estar
preguntando por un reporte que ya había ocurrido cuando el mercado nació**.

> **Regla corregida: el reporte tiene que ser POSTERIOR a la creación del
> mercado.** La tolerancia **sigue en ±1 día** — esto no relaja nada, al
> contrario: elimina emparejamientos falsos contra el trimestre anterior.

Y vuelve honesto el diagnóstico, porque parte los casos en tres destinos que
antes se veían igual:

| Destino | Qué significa | Qué se hace |
|---|---|---|
| **recuperados** | el reporte correcto sí estaba cosechado | cruzan, y suman al candado |
| **esperan cosecha** | el reporte del trimestre que el mercado pregunta **todavía no está en `pead_earnings`** | se arregla **cosechando**, no moviendo umbrales |
| **ruido de verdad** | hay reporte posterior y aun así no cuadra | se quedan afuera |

El censo publica los tres números, más `dejaron_de_casar_con_la_regla_nueva`
(normalmente falsos emparejamientos eliminados, o sea una corrección) y
—clave— **`sin_fecha_de_creacion`**: si Gamma no expone `createdAt`, la regla
**no actúa y nada falla**, que es el modo de falla silencioso que este contador
existe para hacer visible. En el ensayo local, ese contador fue el que detectó
que la fecha de creación no estaba llegando al cruce.

**Y el segundo motivo se diagnostica, no solo se cuenta.** "31 fuera de
tolerancia" es un número sin diagnóstico: no distingue un desfase de calendario
de dispersión. Ahora el cruce guarda, para cada caso que no entró, **por cuánto
no entró** (`cercano_fuera_de_tolerancia`), y `analizaDesfases()` publica el
histograma en días con una regla **fijada antes de ver los números**:

> **Sistemático** = un mismo desfase (mismo valor con signo) explica **≥50%** de
> los casos **y** ese valor es **≤3 días**. Si no, es **ruido** y esos mercados
> se quedan afuera.

Cuando sale sistemático, la función **propone** una tolerancia y dice cuántos
mercados recuperaría. **Propone: no cambia.** Los `CRITERIOS` están congelados y
se mueven a mano, en un diff que se vea — que es justo el punto de haberlos
congelado. Hay test que verifica que la tolerancia congelada **no se movió
sola**.

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

### 1.4 Revisiones de estimados — **CERRADO: fuera de v1**

> **Veredicto, con la fila cruda a la vista:** lo que publica Alpha Vantage son
> **conteos de revisiones y promedios ancla** (7/30 días), **sin valores
> fechados**. No cumple la regla congelada, y no se va a fingir que sí. **Las
> revisiones quedan FUERA de v1.** La sonda se sigue corriendo (es barata y una
> fuente puede cambiar), pero el veredicto de la Fase 0 ya no depende de ella y
> el modelo v1 no lleva ese feature.

#### La regla, y por qué se fijó ANTES de probar

Regla dura, congelada en `evaluaFuentePIT()` y testeada:

> Una fuente sirve para revisiones **solo si** da (a) una **fecha de corte por
> estimado** —una fecha de verdad, no un número— y (b) **más de un VALOR del
> estimado para el mismo período** con fechas de corte distintas.

Un endpoint que devuelve "el estimado de **hoy**" para trimestres futuros **no
es point-in-time**: no permite saber qué se creía *antes* del reporte, que es
exactamente lo que el modelo usaría. Aceptarlo sería meter look-ahead por la
puerta de atrás.

#### El falso positivo de la primera corrida, y qué se arregló

La sonda marcó **`pit: SÍ`** a `alphavantage/EARNINGS_ESTIMATES`. **Era falso**,
por dos bugs encadenados en la heurística:

1. la clave de corte se buscaba con `/revision/`, así que un campo de **conteo**
   de revisiones (del tipo `eps_estimate_revision_up_trailing_7_days`) pasaba
   por "fecha de corte";
2. no se validaba que el **valor** fuera una fecha, así que dos filas del mismo
   período con conteos distintos parecían "dos cortes".

**Un conteo de cuántos analistas revisaron arriba/abajo en los últimos 7/30 días
es un snapshot de HOY.** No dice qué se creía antes de un reporte de hace dos
años, que es lo único que serviría para entrenar sin look-ahead. La regla no se
relajó para acomodarlo: se apretó la implementación para que la regla se cumpla
de verdad.

Lo que cambió, y queda como regresión en `tests/earnings-beat.test.mjs`:

- la clave de corte tiene que **parecer fecha en su valor** (`esFecha`);
- las claves de **conteo** (`*_up`, `*_down`, `last_N_days`, `*_count`,
  `*_average`) quedan explícitamente excluidas como "fecha de corte";
- lo que tiene que variar entre cortes es el **valor del estimado**, no
  cualquier campo;
- se nombra el hallazgo cuando aparece:
  `las_revisiones_vienen_como_CONTEOS_no_como_valores_fechados`;
- **la sonda devuelve `fila_cruda`** (y el markdown la imprime) **siempre**, no
  solo cuando falla. Un `pit: SÍ` que nadie puede auditar no sirve de nada: la
  heurística propone, la fila cruda dispone.

El smoke sondea Finnhub (`/stock/eps-estimate`, `/stock/revision`) y Alpha
Vantage (`EARNINGS_ESTIMATES`) con las keys reales del entorno y reporta
`status` / `http` / `pit` / motivo **+ la fila cruda**. Detecta además la trampa
conocida de AV: rate-limit y premium vienen como **HTTP 200** con
`{"Note"|"Information"}`, no como 429 (`api/_lib/av-earnings.js`).

> **Si ninguna fuente cumple la regla, las revisiones quedan FUERA de v1** y se
> documenta acá con el resultado de la sonda. **No se inventa proxy**: "cambio
> del estimado actual contra el reportado" no es una revisión, es aritmética
> contaminada con el resultado.

**Camino que sí queda abierto, y no es un proxy:** si una fuente publica el
estimado **de hoy** (aunque sea sin historia), capturarlo **nosotros, día a
día, de hoy en adelante** construye una serie point-in-time legítima — con
fecha de corte propia y auditable. Lo que no se puede es **rellenar el pasado**:
para el histórico, sin fuente PIT gratis, no hay revisiones. Eso es Fase 1 si
alguna vez se decide, y se decide con la fila cruda a la vista.

### 1.5 Uso del smoke

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://quantdesk2.vercel.app/api/earnings-beat?smoke=1" | jq
# resumen en español, se abre directo en el navegador:
#   /api/earnings-beat?smoke=1&format=md&secret=<CRON_SECRET>
# opcionales: &meses=12 · &desde=YYYY-MM-DD · &ejemplos=3
# &simbolos=99 busca uno por uno los símbolos del universo v0 (camino D, el que
#   decide el candado). &simbolos=0 lo apaga si hay poco presupuesto de tiempo.
# &max_precios=250 tope de mercados a los que se les pide el precio T-24h.
#   Si no entran en el presupuesto, el censo trunca y lo declara.
# &detalle=1 incluye el detalle mercado por mercado del T-24h.
# &barrido=1 corre además el barrido por offset como CONTROL (apagado por
#   defecto: topa en 422 y ve ~500 de decenas de miles — ciego, no concluyente)
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

> **Resuelto: GO** (§0.0). Esta tabla queda como el registro de con qué regla se
> decidió, no como una compuerta pendiente.

| Resultado | Condición |
|---|---|
| **GO a Fase 1** | Gamma y CLOB contestan sin auth, hay mercados de earnings resueltos con outcome legible y token del Yes, **y** el conteo de T-24h **válidos** sobre los cruzados (§1.2b) alcanza el umbral congelado de ≥100 — o queda lo bastante cerca como para que ampliar la cosecha del PEAD lo cierre. |
| **INCONCLUSO por descubrimiento** | Los caminos de §1.1b aportaron 0 mercados de earnings; o solo A funcionó y devolvió un puñado; o **todas las respuestas traen el mismo número redondo** (señal de tope del cliente o default del servidor, §1.0b). **Un cero no es un hallazgo mientras el método no sepa buscar**: se ajustan frases/tags y se re-corre. Éste fue el veredicto de la primera corrida. |
| **INCONCLUSO por datos nuestros** | `pead_earnings` está vacía → el cruce no es medible todavía. Se re-corre después de la cosecha del PEAD. |
| **NO-GO** | Falta estructuralmente algo **y se sabe que se buscó bien**: mercados encontrados pero sin `clobTokenIds`, sin fecha de resolución, sin outcome; o la lectura exige auth de pago. |

**La asimetría es deliberada.** Para decir GO alcanza con que las piezas estén;
para decir NO-GO hay que haber buscado bien primero. Un NO-GO barato mata un
experimento por un bug del censo — que es justo lo que casi pasa en la primera
corrida.

Las revisiones PIT **no** deciden esta compuerta: su resultado define si el
feature entra a v1 o queda fuera documentado.

---

## FASE 1 — Cosecha ✅ IMPLEMENTADA

`/api/earnings-beat-harvest`, **dos crons diarios** con gate `CRON_SECRET` +
`EARNINGS_BEAT_HARVEST_ENABLED=1` y heartbeat, para que `/api/cron-status`
marque en rojo un cron muerto.

| Job | Cadencia (UTC) | Qué hace |
|---|---|---|
| `?job=mercados` | `0 23 * * *` | descubre (Gamma), filtra v1, cruza, pide precios, upsert |
| `?job=precios` | `40 23 * * *` | completa el T-24h pendiente y **re-mira los abiertos** (CLOB) |
| `?job=status` | — | stats, sin escribir |

**Están partidos a propósito:** un CLOB lento no puede comerse el presupuesto
del descubrimiento, y cada uno late por su cuenta — si el que se muere es
`precios`, la tabla sigue creciendo y eso se ve en `cron-status`.

### La tabla

`pm_earnings_markets` (`api/_lib/earnings-beat-db.js`), PK `market_id`. Sobre
el diseño anterior cambian tres cosas, y las tres son decisiones:

1. **Los mercados ABIERTOS también se guardan** (`abierto = true`). Antes el
   plan decía "solo resueltos"; eso **nace con sesgo de supervivencia** y
   además obliga a re-descubrir lo ya visto. Resuelven después y `job=precios`
   los completa.
2. **`filtro_motivo`** se guarda: lo que entra ya pasó el filtro v1, y queda
   dicho en la fila para poder auditarlo sin re-cosechar.
3. **`camino`**: por cuál de los dos caminos entró el mercado.

### Las dos reglas que hacen que "idempotente" signifique algo

Correr el cron dos veces no puede **degradar** la tabla. Están en SQL (dentro
del `ON CONFLICT`) y en JS (`debeReemplazarPrecio` / `mejorOutcome`, puras y
testeadas), y la escala de calidad del SQL **se genera desde el mismo objeto**
que usa el JS para que no puedan divergir:

- **Un precio válido no lo pisa un `sin_ticks`** de un reintento con el CLOB
  caído. El reemplazo es solo *hacia arriba* en calidad
  (`valido > rancio > sin_ticks_antes > sin_ticks > error`).
- **Un mercado resuelto no vuelve a abierto** porque una corrida lo haya visto
  abierto en cache. La resolución es un hecho.

### El filtro v1 corre en la COSECHA, no en el análisis

Lo que entra a la tabla ya está filtrado. Si filtrara el consumidor, cada
consumidor futuro tendría que acordarse de filtrar igual — y el día que uno se
olvide, los mercados de mención vuelven a contar como beat/miss. Además se
descartan acá los que caen fuera del universo v1 (§0.1): un mercado de una
empresa que no cosechamos no tiene historial con qué modelarse.

### Los dos caminos, los dos corriendo

El censo midió **`simbolo` 252 vs `busqueda` 67**, así que símbolo es el
ganador — pero **se corren los dos igual**: 67 mercados que el ganador no ve
siguen siendo 67, y el día que Polymarket cambie sus plantillas el que
sobreviva va a ser el otro. El aporte de cada camino se journalea por corrida.

El descubrimiento vive en `api/_lib/earnings-beat-descubrir.js`, **una sola
implementación** compartida con el censo: dos copias se desincronizan, y acá la
que se desincronizara decidiría **qué entra a la tabla**.

### Encendido

```bash
# 1. Env var en Vercel
EARNINGS_BEAT_HARVEST_ENABLED=1
# 2. Primera corrida a mano (crea el esquema y siembra)
curl -H "Authorization: Bearer $CRON_SECRET" ".../api/earnings-beat-harvest?job=mercados"
# 3. Verificar
curl -H "Authorization: Bearer $CRON_SECRET" ".../api/earnings-beat-harvest?job=status"
```

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
| ~~Revisiones de estimados~~ | — | **FUERA de v1** (§1.4, cerrado): no hay fuente PIT gratis. No se sustituye por un proxy |

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
