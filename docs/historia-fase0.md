# FASE 0 — HISTORIA (EDGAR): reconocimiento de fuentes

> **Alcance de este documento:** SOLO reconocimiento. No hay ingesta acá, ni
> endpoint, ni página, ni prompt. Si las compuertas abren, la Fase A arranca
> de la lista de decisiones congeladas (§10).
>
> **Estado: CERRADA.** La corrida 2 (2026-09-20) está pegada entera en §11.
> **G1, G2 y G3 verdes · G4 medida · G5 resuelve la bifurcación (la guía no
> está etiquetada) · G6 clasifica a los cuatro emisores.** La Fase A no espera
> ningún dato de reconocimiento.
>
> Hubo una corrida anterior —la "corrida 1"— cuya salida se perdió en
> `.gitignore` aunque sí alcanzó a cambiar el criterio de G1 y G2. Está contada
> en §0.1 y se deja escrita porque explica por qué el criterio de §4 tiene una
> enmienda.
>
> El contenedor donde se escribió esto —y el de la Fase A— tiene el egress a
> `*.sec.gov` cerrado por política de la organización (§0), así que la sonda
> corre desde la máquina del operador.
>
> Fecha del reconocimiento: 2026-09-12. Cerrada con la corrida 2: 2026-09-20.
>
> **Enmienda posterior:** §11.2 (2026-09-20) cambia la FORMA de la lectura —
> una línea de tiempo con las siete preguntas como filtros, en vez de siete
> listas. No toca el esquema ni la ingesta; sí corrige un conteo que
> triplicaba documentos sin que se viera.

---

## 0. Aviso de honestidad: el sondeo en vivo NO se pudo hacer

La regla del producto es cero números inventados. Aplica primero a su propio
reconocimiento: **este documento no trae ni un número de EDGAR**, porque
ninguno se pudo ganar desde acá.

Evidencia, no impresión. Los tres hosts que la Fase 0 necesita:

```
000  https://www.sec.gov/files/company_tickers.json
000  https://data.sec.gov/submissions/CIK0001397187.json
000  https://data.sec.gov/api/xbrl/companyfacts/CIK0001397187.json
000  https://efts.sec.gov/LATEST/search-index?q=...&forms=8-K
000  https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&...
```

El proxy de egress lo reporta explícito:

```
connect_rejected — gateway answered 403 to CONNECT (policy denial)
  host: data.sec.gov:443
  host: efts.sec.gov:443
```

La sonda corrida acá muere donde tiene que morir, y lo dice:

```
✗ No se pudo bajar company_tickers.json: ticker-map: HTTP 403
  Si es un 403 del proxy de egress, esta máquina no tiene salida a sec.gov.
```

No es un bloqueo de la SEC ni un rate limit: es la política de red del
entorno. Desde una laptop con internet normal, EDGAR es público, anónimo y
gratuito. **Lo que falta es una corrida, no un permiso ni una credencial.**

### Qué sí se hizo, entonces

1. **La sonda completa** — `scripts/historia-phase0-probe.mjs`, sin
   dependencias, que en una pasada contesta las cinco preguntas del encargo
   (cobertura de company-facts, items de 8-K parseables, 13D/proxies,
   latencia, insumos de horas) y cierra seis compuertas.
2. **El medidor, probado** — `tests/historia-phase0-probe.test.mjs`, 50
   aserciones contra fixtures sintéticos con la respuesta plantada. Sin red
   no se ganan los números de EDGAR; sí se puede probar que el instrumento
   mide bien. La Fase 0 del Congreso perdió dos corridas enteras por un
   extractor que reportaba rojo sin estar probado (`docs/congreso-fase0.md`
   §6.1) — ese error no se repite.
3. **Los criterios de compuerta, fijados ANTES** (§4). Un umbral escrito
   después de ver el número no es un umbral, es una racionalización.
4. **Lo que no depende de la red**: el esquema de tablas (§5), el mapa de las
   7 preguntas a fuentes (§3), el alcance declarado "no cubierto" (§8), el
   inventario exacto del retiro del AI verdict (§9) y la estimación de horas
   (§7, con su margen de error declarado).

### Cómo cerrar la Fase 0

```bash
node scripts/historia-phase0-probe.mjs
```

~5 min, 4 tickers, sin keys. Imprime el tablero de compuertas y deja los
payloads crudos en `./.historia-fase0/`. Pegar la salida en §11 y el
veredicto queda ganado.

---

## 0.1. Enmienda del 2026-09-20: la corrida 1 existió, y su salida se perdió

Lo de arriba se escribió el 2026-09-12 y dice "no corrida". **Es falso desde
que alguien corrió la sonda.** La corrida ocurrió, no está fechada, y el único
lugar donde dejó rastro es el código que modificó.

La evidencia, textual, en `veredicto()` de la sonda:

> *"Corrida 1: G1 y G2 salieron rojas por un solo emisor, VIST, que es
> justamente el CONTROL de cobertura parcial (§4 del memo)."*

y, en la medición de G2:

> *"En la corrida 1 esto imprimia 'VIST 0.0%', que leia como fallo cuando era
> ausencia de muestra."*

**Qué se puede afirmar con eso, y nada más:**

| Se sabe | Cómo se sabe |
|---|---|
| La sonda corrió contra EDGAR en vivo al menos una vez | el comentario describe una salida concreta que solo existe corriendo |
| Con el criterio original, G1 y G2 salieron **rojas** | textual |
| El único emisor que las reprobó fue **VIST** | "por un solo emisor, VIST" |
| VIST tenía **0 8-K** en la ventana | el "VIST 0.0%" que se imprimía |
| LULU, MSFT y MELI **no** reprobaron G1 ni G2 | se deduce de "un solo emisor" |

**Qué NO se supo nunca de esa corrida:** ningún número por emisor, nada de G3,
G4 ni G5, ninguna latencia, ningún peso de `companyfacts`. Todo eso lo trajo la
**corrida 2** y está en §11 — pero de la corrida 1 no queda más que lo de
arriba, y este apartado se conserva para que se entienda de dónde salió la
enmienda de §4.

⚠️ **Trampa para el próximo lector:** los números que aparecen en
`tests/historia-phase0-probe.test.mjs` (`efectivos: 12`, `ochoK: 47`…) son
**fixtures sintéticos con la respuesta plantada**, puestos ahí para probar que
el medidor mide. **No son resultados de la corrida 1.** Copiarlos a §11 sería
exactamente el número inventado que este módulo existe para no producir.

**La causa raíz, para que no se repita:** `.historia-fase0/` está en
`.gitignore` (línea 3). Está bien que los payloads crudos no entren al repo
—son varios MB por emisor—, pero entonces **la salida del tablero tiene que
pegarse en §11 en el mismo momento de la corrida**, o se pierde. La sonda
corre en ~5 min; el costo de recuperarlo es volver a correrla.

---

## 1. La pregunta de la Fase 0

¿Alcanza EDGAR —solo EDGAR, gratis y sin auth— para contar la historia de una
empresa en 7 secciones, con **cada afirmación citada a un documento**, sin que
el módulo tenga que inventar, estimar o rellenar?

No es "¿existe EDGAR?". Es una pregunta de **cobertura y de forma**: si la
serie trimestral tiene huecos, si el 8-K se puede clasificar sin leerlo, si el
13D aparece bajo el CIK de la empresa o solo bajo el del fondo, y si cada dato
trae el `accession` que la cita necesita. Un dato sin `accession` no sirve
para este producto aunque sea correcto: **no se puede citar, y entonces no se
puede afirmar.**

---

## 2. La capa de datos: qué da EDGAR y qué no

Cinco rutas, todas públicas, anónimas y gratis. El
[webmaster FAQ](https://www.sec.gov/os/webmaster-faq#developers) exige
User-Agent descriptivo y pone el techo en **10 req/s**. La sonda va a 8 req/s:
ganarse un 429 sería medir nuestra imprudencia, no la fuente.

| Ruta | Qué da | Qué NO da |
|---|---|---|
| `www.sec.gov/files/company_tickers.json` | ticker → CIK, universo completo | nada de ADR con sufijo (`.MX`, `.SA`) |
| `data.sec.gov/submissions/CIK##########.json` | índice de filings: forma, fecha, **items del 8-K**, documento primario, tamaño | el contenido; y solo ~1.000 filings por página (el resto en `filings.files[]`) |
| `data.sec.gov/api/xbrl/companyfacts/CIK…json` | toda la serie XBRL con `accn`, `filed`, `fy`, `fp`, `frame` | lo que no esté etiquetado — **y la guía no se etiqueta** (hipótesis H1, §4) |
| `efts.sec.gov/LATEST/search-index` | full-text 2001→hoy | nada anterior a 2001; y es un índice, no un parser |
| `www.sec.gov/Archives/edgar/data/<cik>/<acc>/index.json` | el directorio del filing: exhibits, `EX-99.1` | el texto ya limpio |

### Las dos rarezas que decidieron el diseño del medidor

**(a) Q4 no existe.** Un emisor reporta Q1–Q3 en 10-Q y el **año** en 10-K. El
cuarto trimestre nunca es un hecho XBRL: hay que derivarlo, `Q4 = FY − 9M`. Un
contador ingenuo mira 9 trimestres en 3 años, canta 75% de cobertura y manda a
rojo una compuerta que está verde. La sonda deriva y reporta las dos cosas por
separado: `trimestres` (directos) y `efectivos` (directos + derivables). El
test lo prueba con un año al que se le quitó el hecho de nueve meses: ahí el
medidor tiene que decir **11 y no 12** — un hueco declarado, nunca uno
rellenado.

**(b) La serie cambia de tag a mitad de camino.** ASC 606 (2018) partió
`Revenues` en `RevenueFromContractWithCustomerExcludingAssessedTax`. Contar
por tag parte la película en dos. La unidad de cobertura es la **familia**
(un concepto económico y sus alias), y el reporte imprime qué tags aportaron.

**(c) Y una tercera, que es materia prima en vez de estorbo:** el mismo
periodo aparece varias veces, con valores distintos, presentado en filings
distintos. Eso es una **re-expresión**, y para la pregunta 3 ("qué prometieron
vs qué entregaron") es oro: es la empresa corrigiéndose a sí misma, con fecha
y documento. Por eso `accession` va en la clave de la tabla (§5) y no como
columna decorativa.

---

## 3. Las 7 preguntas → su fuente

| # | Pregunta | Fuente | Estado |
|---|---|---|---|
| 1 | Quién la dirige y si son estables | 8-K item **5.02** + bios del DEF 14A | 🟢 EDGAR, compuerta G2 |
| 2 | Quién la posee y quién pelea | 13F (ya lo tenemos) · SC 13D/13D-A · PREC14A/DEFC14A · Form 4 (ya lo tenemos) | 🟢 EDGAR, compuerta G3 |
| 3 | Qué prometieron vs qué entregaron | resultados de company-facts (G1) **vs** guía en prosa del 8-K 2.02/7.01 (G5) | 🟡 **partido en dos** — ver abajo |
| 4 | Qué dice y qué evade la gerencia | transcripts | 🔴 **NO CUBIERTO** por decisión del encargo (§8) |
| 5 | Quién les come el mercado | filings de los competidores **públicos** | 🟡 falta el mapa de pares (§6) |
| 6 | Qué cree ya el mercado | short volume + opciones + precio, **sin IA** | 🟢 ya lo tenemos (§6) |
| 7 | Cuál es el catalizador | 8-K de eventos anunciados + fechas de junta | 🟡 el **próximo earnings NO es de EDGAR** (§6) |

### La pregunta 3 es la que hay que mirar de frente

El encargo dice "guía en 8-K 2.02/7.01 vs resultados reales […] desde XBRL
company-facts, **guía si está etiquetada**". Ese "si" es el nudo.

Lo entregado (resultados) está en XBRL, estructurado, citable: eso lo mide G1
y hay poca duda. **Lo prometido (la guía) casi con certeza no está etiquetado
en ninguna taxonomía**: vive en prosa, dentro del `EX-99.1` que cuelga del
8-K item 2.02 — "esperamos ingresos de entre $X y $Y". Es la hipótesis H1 y
G5 la resuelve con dos mediciones, no con una opinión:

- **G5(a)** barre los ~1.000 conceptos de company-facts de cada emisor
  buscando `/guidance|forecast|outlook|projected|guided/i`. Si da 0, la guía
  no está en XBRL y punto.
- **G5(b)** abre el `index.json` de los últimos 5 filings con item 2.02 y
  cuenta cuántos traen un `EX-99`. Ahí es donde está.

**Consecuencia si H1 se confirma:** la mitad "prometieron" de la pregunta 3 no
es un problema de datos sino de **extracción de prosa**, y eso empuja trabajo
de la Fase A a la Fase B. Las salidas posibles, en orden de honestidad:

1. **Citar sin parsear** (recomendada para el MVP). La sección muestra la
   serie de resultados real y **enlaza** el 8-K 2.02 de cada trimestre con su
   `accession`. El lector IA de la Fase B lee el EX-99.1 y narra la guía
   citándola; no se guarda ningún número de guía en la DB.
2. **Extraer con un extractor determinista** (regex sobre rangos de dólares
   cerca de "expect/guidance"). Más rápido de escribir que de confiar: los
   formatos son un zoológico. Solo si el MVP lo pide.
3. **Declararlo no cubierto**, como los transcripts.

Lo que **no** es opción: guardar un número de guía que salió de un modelo sin
que nadie lo haya verificado contra el documento. Eso es exactamente el bug
que este módulo existe para no repetir.

---

## 4. Las compuertas — criterio fijado ANTES de la corrida

Seis, más una séptima que abrió la Fase A (**G7**, §10). El criterio está
escrito acá y **codificado** en la función `veredicto()` de la sonda, así que
mover un umbral obliga a moverlo en los dos lados y deja diff.

**G1 y G2 se tocaron después de la corrida 1.** No se movió ningún umbral: se
corrigió a qué emisores se les aplica. El caso está argumentado abajo, antes de
G1, para que el próximo lector lo juzgue en vez de descubrirlo.

### Enmienda a G1 y G2 tras la corrida 1 — y por qué no es una racionalización

Este documento dice, en §0, que *"un umbral escrito después de ver el número
no es un umbral, es una racionalización"*. G1 y G2 se tocaron
**después** de ver el resultado de la corrida 1. Entonces hay que sostenerlo o
retirarlo, no dejarlo pasar.

Lo que cambió **no es el umbral: es la población.** ≥11/12 sigue siendo
≥11/12, y ≥95% con 0 mal formados sigue igual — no se movió ni una unidad. Lo
que se corrigió es **a quién se le aplica la vara**: VIST entró a la muestra
como *control de cobertura parcial* ("La corrección al set de tickers", más
abajo en este mismo §4),
o sea como el emisor que por definición **no** reporta trimestres ni presenta
8-K. Medirlo con la vara del emisor doméstico hacía que el control reprobara
por ser el control. Eso no es un hallazgo sobre EDGAR; es un error de diseño
del medidor, y lo que un 20-F sí tiene que contestar ya lo pregunta **G6**.

La prueba de que no es conveniencia: con la enmienda puesta, **un doméstico
roto sigue mandando G1 a rojo** — está testeado
(`tests/historia-phase0-probe.test.mjs`, "veredicto: el perfil del emisor
decide qué compuerta aplica"). La compuerta no se ablandó, se enfocó.

Tres detalles del criterio enmendado, ya en `veredicto()`:

- **Sin emisores domésticos, la compuerta es `INCONCLUSO`** — ni verde por
  vacío ni roja. Una compuerta sin muestra no opina.
- **Sin 8-K, la cobertura de G2 es `n/a`, no `0%`.** En la corrida 1 se
  imprimía "0.0%", que leía como fallo cuando era ausencia de muestra.
- Los extranjeros **se siguen listando**, aparte y con el motivo escrito. No
  se esconden: se clasifican en G6.

La misma regla baja al producto en la Fase A: el 20-F **sale del denominador
de la cobertura, no del módulo** — se ingiere, se muestra y se etiqueta
"cobertura parcial" (§8).

### G1 — ¿existe la película trimestral, y es citable?
> **Verde si:** para los **4 conceptos del núcleo** (ingresos, margen bruto,
> inventario, resultado neto), **cada emisor doméstico** tiene **≥ 11 de 12
> trimestres efectivos** en 3 años, contando los Q4 derivables.
> *(Enmendado tras la corrida 1: el emisor extranjero queda fuera de criterio
> y lo clasifica G6. El umbral no se movió.)*
>
> Se reporta además, sin que decida la compuerta: cuántos hechos vienen **sin
> `accn`** (cada uno es una afirmación que no se va a poder citar) y cuántos
> periodos tienen **re-expresiones**.

### G2 — ¿el 8-K se puede clasificar sin leerlo?
> **Verde si:** **≥ 95%** de los 8-K de los últimos 5 años **de cada emisor
> doméstico** traen la columna `items` en el índice **y 0 vienen mal
> formados** (todo item tiene que matchear `N.NN`).
> *(Enmendado tras la corrida 1: el extranjero presenta 6-K y no 8-K — queda
> fuera de criterio, y un emisor sin 8-K se reporta `n/a`, no 0%.)*
>
> Hipótesis H2: **el full-text search no hace falta para clasificar.** El
> encargo lo pide "para items de 8-K", pero `submissions.json` ya trae los
> items en el índice. Si G2 sale verde, FTS baja de infraestructura a
> herramienta de diagnóstico, y eso borra una fuente entera del diseño. La
> sonda igual lo prueba: si un día EDGAR deja de poblar `items`, queremos
> saber que el plan B responde.

### G3 — ¿aparecen los 13D y los proxies, y su URL vive?
> **Verde si:** de una muestra con una de cada forma de interés
> (`SC 13D`, `SC 13D/A`, `SC 13G`, `PREC14A`, `DEFC14A`, `PRRN14A`, `DFAN14A`,
> `DEF 14A`, `4`, `8-K`, `10-Q`, `10-K`), **toda** URL de documento primario
> construida da **200**.
>
> Hipótesis H4: los `SC 13D` aparecen bajo el CIK de la **empresa sujeto**, no
> solo bajo el del fondo que los presenta. Si H4 fuera falsa, la pregunta 2
> necesita otra ruta de descubrimiento y el estimado de horas sube.

### G4 — latencia y techo de 10 req/s
> **Sin umbral de aprobado/reprobado** — es dimensionamiento, no decisión. Se
> reporta p50/p95/max y bytes por tipo de llamada, más una **ráfaga de 10
> concurrentes** para ver si la SEC contesta 429. El número que importa para
> el costo es el peso de `companyfacts` (varios MB por emisor): decide si la
> ingesta es por goteo con cron o bajo demanda con caché.

### G5 — ¿la guía está etiquetada?
> **No es aprobado/reprobado: es una bifurcación de diseño.** Si G5(a) da 0
> conceptos de guía en todos los emisores, se toma la salida 1 de §3 y la
> Fase A **no guarda números de guía**. Si da > 0, se mide qué tan completa
> es antes de prometerla.

### G6 — ¿emisor doméstico o extranjero?
> **No es aprobado/reprobado: es la etiqueta de cobertura.** La sonda mira qué
> forma anual presenta cada CIK. `10-K/10-Q` → cobertura completa.
> `20-F/6-K` → **COBERTURA PARCIAL**, y se dice en la UI: el emisor extranjero
> reporta anual (a veces semestral), no trimestral, así que la "película" de
> la pregunta 3 tiene la mitad de fotogramas.

### La corrección al set de tickers

El encargo pide tres: **LULU** (el caso completo: 3 CEOs, proxy fight, guía
recortada), **MSFT** (grande y estable) y **MELI** "un ADR".

**MELI no prueba lo que el encargo quiere probar.** MELI está constituida en
Delaware y reporta como emisor doméstico —10-K y 10-Q—, no como emisor privado
extranjero. Es un 10-K filer con ticker latino: si la pregunta es "¿qué le
pasa a la cobertura de un 20-F?", MELI contesta "nada", y contesta mal.

La sonda corre **los tres del encargo tal cual** y agrega un cuarto de
control, **VIST** (Vista Energy), que sí presenta 20-F. Y —esto importa— **no
le cree a esta nota**: G6 mide qué forma presenta cada CIK y lo imprime. Si
MELI resulta ser 20-F, el reporte desmiente este párrafo con datos.
`--sin-control` corre solo los tres pedidos.

---

## 5. El esquema

Postgres sobre la frontera de `api/_lib/db.js` (Neon, SQL sobre HTTP), como
`pead-db.js`.

> **El esquema ya no vive en este documento.** Está en
> `api/_lib/historia-db.js` y se lee en `docs/sql/historia.sql`, que se genera
> desde ahí y tiene un test que falla si los dos se separan. Lo que queda acá
> son las decisiones y el porqué — que es lo que un memo sí tiene que
> conservar. Tener el DDL en dos lados fue el error que cerró la rebanada 0
> (§0.1): dos versiones del mismo criterio, y la de papel era la vieja.

Cuatro tablas —`company_emisor`, `company_filings`, `company_filing_items`,
`company_facts`— y dos vistas: `company_quarterly` (el gancho al Arena) y
`company_cobertura` (la regla del 20-F, ejecutable).

### Dos desviaciones de lo que pidió el encargo

**1. `item` (singular) → tabla hija.** El encargo pide
`company_filings (cik, accession, form, item, fecha, url)`. Pero un 8-K trae
**varios** items (`5.02,9.01` es lo normal). Con `item` singular, "dame todos
los 8-K con 5.02 de este CIK" se vuelve un `like '%5.02%'` que también matchea
`15.02`. Se guarda la cadena cruda por fidelidad **y** una tabla hija
normalizada para consultar.

**2. `company_facts` necesita más que `(cik, concepto, periodo, valor,
accession)`.** Faltan `period_start` (sin ella no se distingue un trimestre de
un año que terminan el mismo día), `period_class` (la clasificación Q/9M/FY que
hace derivable el Q4) y `filed` (sin ella no se ordenan las re-expresiones y no
se sabe cuál es la última palabra de la empresa).

Y `accession` va en la **clave**, no como columna decorativa: un mismo periodo
presentado dos veces con dos valores son **dos filas**, no un update. Eso es la
materia prima de la pregunta 3, no ruido a limpiar.

### Tres correcciones que obligó la corrida 2

**1. `familia_rango`: el alias no es una re-expresión.** La familia une los
alias de un concepto porque la serie cruza el cambio de taxonomía. Pero dos
alias pueden medir cosas distintas —`InventoryNet` es el inventario y
`InventoryFinishedGoods` una de sus partes— y contar "valores distintos por
periodo" después de unirlos marca como re-expresión lo que es diferencia entre
tags. La corrida 2 lo dejó ver: **toda familia de dos tags salió revisada al
100%** (§11). Con rango, **por periodo gana un solo tag** —el mejor rankeado
que tenga dato— y las revisiones se cuentan **dentro** de ése. La serie sigue
pudiendo cambiar de tag entre periodos, que es justo para lo que la familia
existe.

**2. `accession_aux`: un Q4 derivado tiene dos fuentes, así que dos citas.**
`Q4 = FY − 9M` depende del 10-K **y** del último 10-Q. Con una sola columna se
mostraría citando el 10-K y la mitad de la resta quedaría sin respaldo — una
afirmación citada a medias. Un `CHECK` lo vuelve invariante en vez de buena
intención: `derived = true` sin `accession_aux` no entra.

**3. El YoY no se calcula contando cuatro filas.** `lag(val, 4)` asume que
cuatro filas atrás es un año atrás; con un trimestre faltante compara contra el
periodo equivocado y **nadie se entera**, porque el número sale bien formado.
Es la doctrina de `ai-guard.js` —la aritmética de calendario se resuelve antes
y se verifica, no se delega— aplicada al SQL. La vista trae el `period_end` de
la fila comparada y solo emite `yoy_pct` si está a 330–400 días. Si no, null:
sin YoY es honesto; un YoY contra el trimestre equivocado, no.

### El gancho al Arena: la vista, no la tabla

> *"La serie trimestral es la película que le falta al PM — mismo módulo, dos
> consumidores. Diseñá la tabla para que `ai-guard.js` la pueda leer después."*

`ai-guard.js` tiene una doctrina escrita tras un bug real: **la aritmética de
calendario no se delega al LLM, se resuelve antes y viaja al prompt ya hecha**
(el comentario de `relativeDayLabel`: el PM narró unos earnings a dos días como
"post-market today"). Por eso el consumidor del Arena no es la tabla: es
`company_quarterly`, que ya resolvió las cuatro cosas difíciles — qué tag manda
en cada periodo, cuál es la última palabra de la empresa, el Q4 derivado y el
YoY (o ningún YoY, dicho como null).

Cada fila que sale de ahí trae `accession`, `accession_aux` y `filed`. Es la
condición para que tanto el lector de Historia como el PM del Arena puedan
afirmar algo: **el dato y su documento viajan juntos, siempre.**

**Este PR no toca el Arena.** La vista se crea y queda ahí; quién la conecte al
PM es otra decisión y otro PR.

### La regla del 20-F, ejecutable

`company_cobertura` expone `cuenta_para_cobertura`, que es la enmienda de §4
escrita **una sola vez**: el emisor extranjero sale del **cálculo de cobertura**,
no del módulo. Se ingiere, se muestra y se etiqueta "cobertura parcial" (§8).
Quien mida cobertura filtra por esa columna en vez de reimplementar el criterio
—que es como aparecieron dos versiones de él la primera vez.

---

## 6. Lo que la sonda NO puede contestar

Tres huecos que no son de EDGAR y que no se cierran corriendo la sonda:

**El próximo earnings (pregunta 7) no está en EDGAR.** EDGAR es un archivo de
lo que ya pasó; no publica calendarios. La fecha sale de `api/earnings.js`
(Finnhub), que ya existe. La sección 7 mezcla entonces dos fuentes y **cada
una se etiqueta con la suya** — el 8-K con su `accession`, la fecha de
earnings con "Finnhub, estimada" si el calendario la da como tentativa.

**El short interest real (pregunta 6) sigue detrás de OAuth.** Ya está
documentado y decidido en `api/short-interest.js`: FINRA publica *short
interest* (Regla 4560, quincenal, da "% del float" y "días para cubrir") tras
el FINRA Query API con `client_id`/`secret`, y *short volume* (Reg SHO, diario,
sin key) que es lo que consumimos. **No son lo mismo y la UI no los confunde.**
El encargo pide "short interest real (FINRA Query API, ruta documentada)": la
ruta está documentada, la credencial no está pedida. Es una decisión de la
Fase A, no un hallazgo de la Fase 0.

**El mapa de competidores (pregunta 5) no existe todavía.** `submissions.json`
trae el código **SIC** del emisor, que es el candidato obvio para armar pares
— y es grueso: el SIC de LULU (5600, *retail-apparel*) mete en la misma bolsa
a media industria. Opciones, en orden de costo: (a) SIC + capitalización, (b)
lista curada a mano de 3–5 pares por ticker cubierto, (c) los pares que la
propia empresa nombra en su 10-K. **Recomendación: (b) para el MVP**, misma
filosofía que el `MEGA_CAPS` curado de `api/earnings.js` — lista corta, a
mano, estable, sin scraping. Los privados se declaran no cubiertos y ya.

---

## 7. Estimación de horas

Con su margen declarado. Las líneas marcadas **(G)** dependen de una compuerta
y pueden moverse fuerte; el resto es trabajo conocido, comparable con lo que
costaron PEAD y Congreso en este mismo repo.

| Fase A — datos, endpoint y página, sin IA | horas |
|---|---|
| Ingesta EDGAR: submissions paginado + company-facts + derivación de Q4 + mapeo de familias | 10–14 |
| Esquema + upserts + goteo reanudable + guard de 10 req/s | 6–8 |
| `/api/historia/:ticker` read-only + tests con fetch mockeado | 6–8 |
| Página: 7 secciones, estado "sin documentos", etiqueta de cobertura parcial, i18n es/en | 10–14 |
| Tests de ingesta + smoke de fuente | 4–6 |
| **(G)** Mapa de pares curado (pregunta 5) | 3–5 |
| **Subtotal Fase A** | **39–55** |

**Enmienda del 2026-09-20 — dos líneas que §7 no coteó:**

| Línea nueva | horas |
|---|---|
| Bajar la regla del 20-F al cálculo de cobertura del producto (§4, enmienda) | 2–3 |
| Tarifa fixture-first: `fetch` inyectable, captura y mantenimiento de fixtures | 4–5 |
| **Subtotal Fase A enmendado** | **45–63** |

El delta no es alcance nuevo que alguien haya pedido: es trabajo que el memo no
vio porque la enmienda a G1/G2 y el bloqueo de egress son posteriores a §7. Las
dos líneas que más pueden moverse siguen siendo las mismas de abajo.

**Enmienda del 2026-09-20 (2) — la línea de tiempo:**

| Línea nueva | horas |
|---|---|
| Rebanada F: jerarquía de items, consulta única de eventos, las 7 secciones como filtros, línea de tiempo en la página (§11.2) | 6–10 |

Va **antes** de la Fase B y no por estética: el lector recibe la evidencia ya
ordenada y sin triplicados, así que cada documento entra al prompt una vez en
vez de tres. Es un descuento directo en el contexto que se paga por corrida.

| Fase B — el lector | horas |
|---|---|
| Rebanada G: paquete de evidencia, aritmética resuelta, inventario de citas (§11.3) | 5–7 |
| Rebanada H: prompt congelado + versión en el hash + la llamada + persistencia + puerta autenticada (§11.4) | 9–13 |
| Correcciones sobre la H: invariante de citas colgadas, tope del reintento, tres estados en pantalla (§11.5) | 3–4 |
| Arreglo del diagnóstico + errores JSON en /api/ + pruebas de handler (§11.6) | 1–2 |
| Gasto perdido: esquema verificado antes de gastar + costo en los fallos + citas fuera de la frase (§11.7) | 2–3 |
| **Guard de citas** + **anti-opinión** + relativo-a-hoy, con el verificador literal que H3 reusa (§11.9) — *hecho* | 5–7 |
| Retiro del AI verdict de SMART $ + i18n + tests (§9) | 3–5 |
| **Subtotal Fase B** | **33–48** |

**Total: 78–113 horas.** Más, si G5 empuja a extraer guía de prosa: **+10–16**
por la salida 2 de §3 (y por eso la recomendación es la salida 1).

Las dos líneas que más pueden moverse y hay que vigilar:

- **La página (10–14).** Siete secciones con estados vacíos honestos y
  bilingües es más trabajo del que parece; es la línea donde el estimado se
  rompe si se mira poco.
- **El guard de citas (5–7).** Es la línea que **no se recorta**. Sin ese
  guard, "cada afirmación citada" es una promesa de marketing en vez de una
  propiedad verificable del sistema, y el diferenciador entero del producto
  descansa ahí.

---

## 8. Lo que NO se cubre, y se dice en la UI

No en el README: **en la pantalla**, donde el usuario está por sacar una
conclusión.

| Hueco | Por qué | Texto de la UI |
|---|---|---|
| Transcripts de calls (pregunta 4) | fuente pagada o scrapeada; riesgo de licencia | *"Pregunta 4 — no cubierta. Lo que la gerencia dice en las llamadas viene de transcripciones con licencia comercial. QuantDesk no las incluye."* |
| Competidores privados (pregunta 5) | no le reportan a la SEC | *"Solo competidores que cotizan en EE.UU. Los privados no presentan filings y no aparecen acá."* |
| Alt data (tráfico, tarjetas, satélite) | pagada | *"Sin datos alternativos."* |
| Expert networks | pagada | *"Sin expert networks."* |
| Emisor extranjero 20-F/6-K | reporta anual, no trimestral | *"Cobertura parcial: este emisor presenta 20-F. La serie es anual, no trimestral."* |
| Guía — **confirmado** (G5: 0/4 emisores) | no está etiquetada en XBRL | *"La guía no viene estructurada: se enlaza el 8-K donde la empresa la dio."* |
| Pre-2001 en full-text | EDGAR no indexa antes | *"La búsqueda de texto completo cubre desde 2001."* |

Y una sección que **no es opcional**, al final de cada historia:

> **Dónde se rompe la historia** — la contraevidencia. Sin ella el módulo es un
> generador de sesgo de confirmación con citas: más peligroso que uno sin
> citas, porque parece riguroso. Si no hay contraevidencia en los documentos,
> se dice *"no encontramos contraevidencia en los filings"*, que es una
> afirmación falsable — no se deja el hueco en blanco ni se rellena.

---

## 9. El retiro del AI verdict de SMART $ — inventario exacto (Fase B)

El encargo: los paneles de números se quedan como números; el AI verdict sale.
**Este PR no toca `app.html`.** Esto es el inventario para que la Fase B sea
una edición y no una búsqueda.

| Qué | Dónde | Acción |
|---|---|---|
| Contenedor del veredicto | `app.html` — `<div id="smVerdictWrap">` | quitar |
| Render del veredicto | `app.html` — `renderSmVerdictWrap()` | quitar |
| Llamada a la IA | `app.html` — `smLoadVerdict()` y su invocación en `runSmartMoney()` | quitar |
| Estado y caché del veredicto | `app.html` — campos `smState.verdict` / `smState.verdictReason`, y la clave de caché diaria `'smv:'+ticker` | quitar los campos; la caché caduca sola, no hace falta migración |
| El prompt ("You are a buy-side smart-money analyst… overall_signal: STRONG BUY\|…") | `app.html`, dentro de `smLoadVerdict()` | quitar — es literalmente la recomendación que el encargo prohíbe |
| Cabecera "MARKET-WIDE SMART MONEY SIGNALS 🤖 AI Analysis" y `#marketSignalsPanel` | `app.html` | **decisión pendiente**: es señal de mercado, no veredicto por ticker. El encargo no la nombra. Proponer: se queda, sin el 🤖 |
| Claves i18n `aiSmartVerdict`, `marketWideSignals` | `app.html`, bloques es/en | limpiar las que queden huérfanas |
| **Paneles de números** (Form 4, 13F, short volume, opciones, precio) en `#smGrid` | `app.html` | **NO se tocan.** Se quedan como números, sin párrafo de IA |
| `#earningsVerdictPanel` / `renderEarningsVerdict()` | `app.html`, página **EARNINGS** (no SMART $) | **fuera del alcance del encargo.** Se queda. Si se quiere retirar también, es otra decisión explícita |

Que "AI EARNINGS VERDICT" siga vivo en otra pestaña mientras se retira el de
SMART $ es una inconsistencia visible para el usuario. No se resuelve sola y
no se resuelve por inercia: o el encargo la extiende, o queda como está y se
sabe por qué.

---

## 10. Decisiones a congelar antes de la Fase A

1. **Universo.** ¿Todo emisor SEC bajo demanda, o una lista curada que se
   precalienta con cron? (El peso de `companyfacts` que mida G4 decide esto.)
2. **Frescura.** ¿Cada cuánto se refresca el índice de filings? Propuesta:
   diario para los tickers cubiertos, bajo demanda con caché de 6 h para el
   resto.
3. **Profundidad.** ¿Cuántos años de historia? Propuesta: 5 en el índice de
   filings, 3 en la serie trimestral (los criterios de G1 asumen 3).
4. **Guía.** La bifurcación de §3, según G5.
5. **Pares** (pregunta 5): lista curada, según §6.
6. **Short interest**: ¿se pide la credencial de FINRA Query API o la
   pregunta 6 se queda con short volume y lo dice?
7. **`#marketSignalsPanel`**: se queda o se va (§9).
8. **Formato de la cita.** Propuesta: `[0000320193-25-000073]` visible,
   enlazado al documento primario, con la forma y la fecha en el hover. Que se
   vea el identificador —y no un "fuente: SEC" genérico— es parte del
   producto: es lo que hace la afirmación verificable por el usuario.

### Acta de congelamiento — 2026-09-20

Las ocho quedan congeladas **en la propuesta del memo**, sin veto. Lo que rige
la Fase A:

| # | Decisión | Congelada en |
|---|---|---|
| 1 | Universo | **goteo reanudable por cron** — la corrida 2 midió 42 s/ticker y un lambda de 60 s no alcanza (§11, G4) |
| 2 | Frescura | diario para tickers cubiertos · 6 h bajo demanda para el resto |
| 3 | Profundidad | **5 años** de índice de filings · **3 años** de serie trimestral |
| 4 | Guía | **salida 1 de §3**: se cita el 8-K 2.02, **no se guarda ningún número de guía**. Confirmada por G5: 0/4 emisores con guía etiquetada, y 5/5 filings 2.02 con `EX-99` (§11) |
| 5 | Pares (pregunta 5) | lista curada a mano, 3–5 por ticker, estilo `MEGA_CAPS` |
| 6 | Short interest | se queda con **short volume** y la UI dice que no es short interest |
| 7 | `#marketSignalsPanel` | se queda, sin el 🤖 — **es Fase B, no se toca acá** |
| 8 | Formato de la cita | `[0000320193-25-000073]` visible y enlazado al documento primario |

La 4 tiene ahora dos respaldos independientes: el encargo de la Fase A —**sin
IA en esta fase**, las siete secciones se muestran como documentos y el lector
con prompt congelado sigue siendo Fase B— y la medición de G5, que descarta el
XBRL como fuente de guía en los cuatro emisores.

### La restricción que no estaba en el plan: fixture-first

El contenedor de la Fase A **tampoco alcanza EDGAR** — verificado, no supuesto:

```
000  https://www.sec.gov/files/company_tickers.json
000  https://data.sec.gov/submissions/CIK0001397187.json
000  https://data.sec.gov/api/xbrl/companyfacts/CIK0001397187.json
     connect_rejected — el proxy de egress deniega el CONNECT (política de la organización)
```

Consecuencias, que son de diseño y no de logística:

1. **El `fetch` va inyectable desde el primer archivo.** La capa de datos
   recibe su cliente HTTP por parámetro; en test entra uno que lee fixtures.
   No es un refactor para después: es la única forma de que la ingesta sea
   probable desde acá.
2. **Los fixtures nacen sintéticos y marcados como tales.** Ninguno se
   presenta como captura de EDGAR mientras no lo sea.
3. **Queda una compuerta abierta y declarada: G7.**

### G7 — verificación contra EDGAR real *(mitad cerrada)*

**La ingesta ya está verificada contra la fuente y contra la base** — el goteo
del 2026-09-20 corrió los cuatro emisores y sus números están en §11. Lo que
queda es la vista.

> **Verde si:** la ingesta corre contra EDGAR en vivo para LULU, MSFT, MELI y
> VIST, y para cada uno: los conteos de la serie trimestral coinciden con los
> de §11, **0 hechos sin `accn`** llegan a la tabla (la corrida 2 midió 0 en
> todas las familias de los cuatro: si aparece uno, es nuestro), y las
> re-expresiones de MELI quedan guardadas con su `filed` y su `accession`,
> contadas **por tag y no por familia** — el 19 del tablero mezcla
> re-expresión con diferencia entre alias, y §11 explica por qué.
>
> **Hasta que G7 cierre, la Fase A está probada contra fixtures, no contra la
> fuente.** Se dice así en el PR y no se declara "funciona con EDGAR".

G7 se gana por partes, y la primera ya se puede cobrar sin esquema ni ingesta:
el **transporte** (`api/_lib/edgar.js`) tiene su propio smoke contra EDGAR real.

```bash
node scripts/historia-edgar-smoke.mjs        # LULU, MSFT, MELI, VIST
```

Diez llamadas, sin keys, sin DB, sin escribir nada. Contesta si el UA es
aceptado, si las URLs de documento primario resuelven, cuánto pesa
`companyfacts` de verdad (el insumo de G4) y qué formas presenta cada emisor
(el dato de G6, medido en vez de asumido). Lo que **no** contesta es si lo
ingerido queda bien guardado.

### Cómo cerrar G7 entera

La ingesta existe desde la rebanada C. Con `DATABASE_URL` y **una** de
`ADMIN_SECRET`, `CRON_SECRET` o `ARENA_ADMIN_KEY` configuradas, son dos
llamadas. El endpoint sin `?job=` dice cuáles están puestas —los nombres,
nunca los valores— así que la primera consulta es gratis:

```bash
# 0. ¿Está habilitada la escritura, y con qué llave?
curl -sS "https://<host>/api/historia-harvest" | jq .escritura

# 1. Sembrar el universo: resuelve tickers a CIK y los deja pendientes.
curl -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://<host>/api/historia-harvest?job=sembrar&tickers=LULU,MSFT,MELI,VIST"

# 2. Un turno del goteo. ~42 s por ticker (G4), maxDuration 300.
curl -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "https://<host>/api/historia-harvest?job=goteo&limite=4"
```

Sirven las tres llaves por cuatro puertas (`x-admin-key`,
`Authorization: Bearer`, `?key=`, `?secret=`), por la misma razón que
`api/arena-audit.js`: en Vercel una env var marcada como Secret no se puede
volver a leer, y un endpoint con una sola llave termina con una llave
ilegible para quien la necesita. Varias llaves válidas no debilitan nada;
una ilegible sí, porque termina pegada en un archivo para no perderla.

**Sin ninguna configurada el endpoint contesta 503, no queda abierto** —
escribe en Neon y le pega a EDGAR con nuestro User-Agent.

La respuesta del goteo es el veredicto de G7, y se lee contra §11:

| Qué mirar | Verde si |
|---|---|
| `sinCita` | **0**. La corrida 2 midió 0 hechos sin `accn` en los cuatro emisores: cualquier otro número es nuestro, no de EDGAR |
| `claveAmbigua` | **0**. Si sale > 0, la clave natural NO distingue dos hechos que sí son distintos, y hay que agregarle columnas — no es ruido que se limpia y ya |
| `descartados.duplicados` | > 0 está bien: EDGAR repite el mismo hecho en varios contextos del mismo filing. Colapsarlos no pierde nada |
| `descartados` | `sin_valor` y `sin_fecha` en 0, o explicados |
| `derivados` | > 0 en los tres domésticos (los Q4), **0 en VIST** (un 20-F no tiene 9M que restar) |
| `perfil.cobertura` | `completa` en LULU, MSFT y MELI · **`parcial` en VIST** |
| `indiceTruncado` | `false`. Si sale `true`, la ventana de 5 años se quedó corta y hay que subir `maxPaginas` |
| `red.reintentos` | 0 o pocos. Muchos reintentos significan que 6 req/s sigue siendo demasiado |

Y después, en SQL, las dos que los tests **no** pueden probar sin Postgres:

```sql
-- El arreglo del alias: LULU inventario NO debe salir revisado al 100%.
select familia, count(*) filter (where revisado) as revisados, count(*) as trimestres
  from company_quarterly where cik = '0001397187' group by familia;

-- Las re-expresiones de MELI en ingresos, contadas POR TAG (§11).
select concept, period_end, count(distinct val) as versiones
  from company_facts
 where cik = '0001099590' and familia = 'ingresos' and period_class = 'Q'
 group by 1, 2 having count(distinct val) > 1 order by 2 desc;
```

Ese segundo query es el que contesta de verdad cuántas re-expresiones tiene
MELI. El 19 del tablero mezcla re-expresión con diferencia entre alias; esto
las separa.

**Los tres están en un solo comando**, con su criterio codificado para que no
se pueda mover después de ver el número:

```bash
DATABASE_URL=... node scripts/historia-g7.mjs
```

Solo lee. Sale 0 si G7 cierra y 1 si no, y siempre imprime el número al lado
del veredicto: un "VERDE" sin el dato no se puede auditar. El criterio vive
aparte de las consultas y está probado —incluido **el rojo**: si LULU vuelve a
salir con inventario revisado al 100%, la compuerta se pone roja
(`tests/historia-g7.test.mjs`). Una compuerta que solo se ha visto en verde no
está probada.

El número que originó el encargo —"MELI: 19 revisiones del concepto de
ingresos"— apareció en la corrida 2, así que ya tiene respaldo. Lo que **no**
tiene respaldo es su lectura: 19 es el conteo de periodos con más de un valor
tras unir los dos alias de ingresos, y eso mezcla re-expresión con diferencia
entre tags (§11). No se usa como aserción de ningún test mientras no esté
separado por tag.

---

## 11. Resultados de la corrida

**Corrida 2 — 2026-09-20**, desde la Mac del operador, con salida abierta a
`sec.gov`. Ésta sí quedó registrada. La salida va textual; el análisis viene
después y está separado a propósito: primero el dato, después su lectura.

```
━━━ LULU · CIK 0001397187 · lululemon athletica inc.
  · índice: 1628 filings en 2 página(s), 0.27 MB, desde 2007-04-30
  · 8-K (5a): 48 · con item en el índice: 48 (100.0%) · mal formados: 0
    items clave → 1.01:3  2.02:20  5.02:14  5.07:5  7.01:10  8.01:8
  · formas (5a): 4:196  8-K:48  DEF 14A:4  SC 13D/A:4  SC 13G/A:17  PREC14A:2  DEFC14A:2  DFAN14A:32  10-Q:15  10-K:5
  · URLs de documento primario resueltas: 10/10
  · perfil: anual=10-K · 10-Q=true · 6-K=false · 20-F=false
  · company-facts: 2.97 MB · taxonomías [dei, us-gaap, srt, ecd, ffd] · 431 conceptos
    familia           tags   Q    FY   9M   Q4-deriv  efectivos  revisiones  sin-accn
    ingresos         1      9    3    3    3         12         0           0
    costo            1      9    3    3    3         12         0           0
    margen           1      9    3    3    3         12         0           0
    sgya             1      9    3    3    3         12         0           0
    op               1      9    3    3    3         12         0           0
    neto             1      9    3    3    3         12         0           0
    eps              1      9    3    3    3         12         0           0
    inventario       2      12   -    -    0         12         12          0
    caja             0      0    -    -    0         0          0           0
    deuda             —      AUSENTE
    acciones         2      24   -    -    0         24         0           0
    conceptos de guía en XBRL: 0  ← la guía NO está etiquetada
  · 8-K item 2.02 revisados: 5 · con exhibit EX-99: 5
  · full-text search: OK · 144 hits

━━━ MSFT · CIK 0000789019 · MICROSOFT CORP
  · índice: 4525 filings en 3 página(s), 0.73 MB, desde 1994-02-14
  · 8-K (5a): 44 · con item en el índice: 44 (100.0%) · mal formados: 0
    items clave → 1.01:0  2.02:20  5.02:5  5.07:5  7.01:9  8.01:5
  · formas (5a): 4:599  8-K:43  DEF 14A:5  SC 13G/A:6  10-Q:15  10-K:5
  · URLs de documento primario resueltas: 6/6
  · perfil: anual=10-K · 10-Q=true · 6-K=false · 20-F=false
  · company-facts: 4.88 MB · taxonomías [dei, us-gaap] · 565 conceptos
    familia           tags   Q    FY   9M   Q4-deriv  efectivos  revisiones  sin-accn
    ingresos         1      9    3    3    3         12         0           0
    costo            1      9    3    3    3         12         0           0
    margen           1      9    3    3    3         12         0           0
    sgya             1      9    3    3    3         12         0           0
    op               1      9    3    3    3         12         0           0
    neto             1      9    3    3    3         12         0           0
    eps              1      9    3    3    3         12         0           0
    inventario       1      12   -    -    0         12         0           0
    caja             1      12   -    -    0         12         0           0
    deuda            2      12   -    -    0         12         12          0
    acciones         2      24   -    -    0         24         0           0
    conceptos de guía en XBRL: 0  ← la guía NO está etiquetada
  · 8-K item 2.02 revisados: 5 · con exhibit EX-99: 5
  · full-text search: OK · 243 hits

━━━ MELI · CIK 0001099590 · MERCADOLIBRE INC
  · índice: 812 filings en 1 página(s), 0.13 MB, desde 2007-05-11
  · 8-K (5a): 53 · con item en el índice: 53 (100.0%) · mal formados: 0
    items clave → 1.01:7  2.02:21  5.02:9  5.07:5  7.01:6  8.01:7
  · formas (5a): 4:53  8-K:52  DEF 14A:5  SC 13D:1  SC 13D/A:1  SC 13G:1  SC 13G/A:13  10-Q:15  10-K:5
  · URLs de documento primario resueltas: 9/9
  · perfil: anual=10-K · 10-Q=true · 6-K=false · 20-F=false
  · company-facts: 3.90 MB · taxonomías [dei, srt, us-gaap, ecd] · 627 conceptos
    familia           tags   Q    FY   9M   Q4-deriv  efectivos  revisiones  sin-accn
    ingresos         2      10   3    3    3         13         19          0
    costo            1      10   3    3    3         13         3           0
    margen           1      10   3    3    3         13         4           0
    sgya             1      10   3    3    3         13         0           0
    op               1      10   3    3    3         13         3           0
    neto             1      10   3    3    3         13         0           0
    eps              1      10   3    3    3         13         0           0
    inventario       1      12   -    -    0         12         0           0
    caja             1      12   -    -    0         12         0           0
    deuda            1      12   -    -    0         12         0           0
    acciones         2      24   -    -    0         24         0           0
    conceptos de guía en XBRL: 0  ← la guía NO está etiquetada
  · 8-K item 2.02 revisados: 5 · con exhibit EX-99: 5
  · full-text search: OK · 168 hits

━━━ VIST · CIK 0001762506 · Vista Energy, S.A.B. de C.V.
  · índice: 396 filings en 1 página(s), 0.06 MB, desde 2019-01-24
  · 8-K (5a): 0 · con item en el índice: 0 (n/a) · mal formados: 0
    items clave → 1.01:0  2.02:0  5.02:0  5.07:0  7.01:0  8.01:0
  · formas (5a): 4:10  SC 13D:1  SC 13D/A:1  SC 13G:2  SC 13G/A:2  20-F:5  6-K:249
  · URLs de documento primario resueltas: 7/7
  · perfil: anual=20-F · 10-Q=false · 6-K=true · 20-F=true
  · company-facts: 0.57 MB · taxonomías [dei, ifrs-full, srt] · 304 conceptos
    familia           tags   Q    FY   9M   Q4-deriv  efectivos  revisiones  sin-accn
    ingresos         1      0    2    0    0         0          0           0
    costo             —      AUSENTE
    margen           1      0    2    0    0         0          0           0
    sgya              —      AUSENTE
    op               1      0    2    0    0         0          0           0
    neto             1      0    2    0    0         0          0           0
    eps              1      0    2    0    0         0          0           0
    inventario       1      2    -    -    0         2          0           0
    caja             1      2    -    -    0         2          0           0
    deuda             —      AUSENTE
    acciones         2      2    -    -    0         2          1           0
    conceptos de guía en XBRL: 0  ← la guía NO está etiquetada
  · 8-K item 2.02 revisados: 0 · con exhibit EX-99: 0
  · full-text search: OK · 0 hits

━━━ G4 — latencia por tipo de llamada
  endpoint          n     p50     p95     max     bytes-prom   no-200
  head-doc          32    2500ms  3919ms  4813ms  0            0
  filing-index      15    659ms   3492ms  3492ms  2594         0
  submissions       4     4080ms  4413ms  4413ms  138814       0
  companyfacts      4     5463ms  6910ms  6910ms  3077984      0
  fts               4     3640ms  5172ms  5172ms  41990        0
  submissions-old   3     1308ms  1340ms  1340ms  215298       0
  ticker-map        1     5083ms  5083ms  5083ms  799073       0

━━━ G4b — ráfaga contra el techo de 10 req/s
  · 10 concurrentes en 5323 ms → {"200":10}

═══════════════════════════════════════════════════════════
  COMPUERTAS — criterio fijado ANTES de la corrida
═══════════════════════════════════════════════════════════
  G1 company-facts   🟢 VERDE  (criterio: ≥11/12 trimestres efectivos en ingresos+margen+inventario+neto · SOLO emisores domésticos)
       LULU   peor familia del núcleo: 12/12
       MSFT   peor familia del núcleo: 12/12
       MELI   peor familia del núcleo: 12/12
       VIST   0/12 — FUERA DE CRITERIO: emisor extranjero, no reporta trimestres. Lo clasifica G6.
  G2 items de 8-K    🟢 VERDE  (criterio: ≥95% con item y 0 mal formados, desde el índice · SOLO emisores domésticos)
       LULU   100.0% · mal formados 0
       MSFT   100.0% · mal formados 0
       MELI   100.0% · mal formados 0
       VIST   n/a — FUERA DE CRITERIO: emisor extranjero, presenta 6-K y no 8-K. Lo clasifica G6.
  G3 13D / proxies   🟢 VERDE  (criterio: toda URL de documento primario muestreada da 200)
       LULU   URLs 10/10 · filings de pelea (13D/PREC14A/DEFC14A): 8
       MSFT   URLs 6/6 · filings de pelea (13D/PREC14A/DEFC14A): 0
       MELI   URLs 9/9 · filings de pelea (13D/PREC14A/DEFC14A): 2
       VIST   URLs 7/7 · filings de pelea (13D/PREC14A/DEFC14A): 2
  G5 guía en XBRL    🔴 NO EXISTE  (0/4 emisores con algún concepto de guía etiquetado)
       → si es 0, la pregunta 3 NO se contesta con XBRL solo: la guía vive en prosa del EX-99.1.
  G6 perfil de emisor
       LULU   emisor doméstico (10-K/10-Q) → cobertura completa
       MSFT   emisor doméstico (10-K/10-Q) → cobertura completa
       MELI   emisor doméstico (10-K/10-Q) → cobertura completa
       VIST   emisor privado extranjero (20-F/6-K) → COBERTURA PARCIAL

  corrida: 167.9s · 63 llamadas HTTP · 14.52 MB bajados
  costo por ticker (extrapolado): 16 llamadas, 42.0s
  reporte completo: .historia-fase0/reporte.json
```

| Compuerta | Criterio | LULU | MSFT | MELI | VIST | Estado |
|---|---|---|---|---|---|---|
| G1 company-facts | ≥11/12 trimestres efectivos · solo domésticos | 12/12 | 12/12 | 12/12 | fuera de criterio | 🟢 **VERDE** |
| G2 items de 8-K | ≥95% con item, 0 mal formados · solo domésticos | 100% | 100% | 100% | n/a (0 8-K) | 🟢 **VERDE** |
| G3 13D / proxies | toda URL muestreada da 200 | 10/10 | 6/6 | 9/9 | 7/7 | 🟢 **VERDE** |
| G4 latencia | sin umbral (dimensionamiento) | — | — | — | — | 📏 **medido** |
| G5 guía en XBRL | bifurcación de diseño | 0 | 0 | 0 | 0 | 🔴 **NO EXISTE** — H1 confirmada |
| G6 perfil de emisor | etiqueta de cobertura | completa | completa | completa | **parcial** | 🟢 **clasificados** |

**La Fase 0 queda cerrada.** Tres compuertas verdes, G4 medida, G5 resuelta como
bifurcación y G6 con los cuatro emisores clasificados. La Fase A ya no espera
ningún dato de reconocimiento.

### Lo que el tablero confirma

- **La película trimestral existe y es citable.** 12/12 en los tres domésticos,
  y **`sin-accn` = 0 en todas las familias de todos los emisores**. Ése es el
  número que hacía falta: cada hecho que vamos a guardar trae su `accession`, así
  que no hay ninguno que se pueda mostrar pero no citar.
- **H2 confirmada: el full-text search no hace falta para clasificar.** 100% de
  los 8-K traen `items` en el índice, 0 mal formados, en los tres domésticos. FTS
  baja de infraestructura a herramienta de diagnóstico, y eso borra una fuente
  entera del diseño de la Fase A.
- **H1 confirmada: la guía no está etiquetada.** 0 conceptos de guía en los
  cuatro. Y el complemento: **5 de 5 filings con item 2.02 traen un `EX-99`** en
  los tres domésticos. La guía existe, está en prosa y cuelga de un exhibit con
  su `accession` — que es exactamente la salida 1 de §3.
- **H4 confirmada: los 13D aparecen bajo el CIK de la empresa sujeto.** MELI
  tiene `SC 13D:1` y `SC 13D/A:1` en su propio índice; LULU trae la pelea
  completa (`PREC14A:2`, `DEFC14A:2`, `DFAN14A:32`). La pregunta 2 no necesita
  otra ruta de descubrimiento.
- **VIST se comportó como control.** 20-F, 6-K, cero 8-K, cero trimestres,
  `ifrs-full` en vez de `us-gaap`. La enmienda de §4 era correcta: medirlo con la
  vara doméstica lo convertía en falla siendo el control.

### El asterisco sobre las 19 revisiones de MELI

**El 19 es real como medición y ambiguo como hecho.** No se puede usar tal cual
como ground truth de un test, y la razón está dentro de esta misma corrida.

`revisiones` cuenta **periodos con más de un valor distinto** *después* de unir
todos los alias de la familia. Eso mezcla dos cosas que no son la misma:

1. una **re-expresión** de verdad — el mismo concepto, el mismo periodo,
   presentado otra vez con otro valor en un filing posterior; y
2. **dos tags distintos** de la misma familia que miden cosas distintas y por
   eso difieren en el mismo periodo.

La corrida se desmiente sola si se ordena por la columna `tags`:

| Emisor · familia | tags | periodos | revisiones |
|---|---|---|---|
| LULU · inventario | **2** | 12 | **12** (el 100%) |
| MSFT · deuda | **2** | 12 | **12** (el 100%) |
| MELI · ingresos | **2** | 13+ | **19** |
| MELI · costo | 1 | 13 | 3 |
| MELI · margen | 1 | 13 | 4 |
| MELI · op | 1 | 13 | 3 |
| MSFT · inventario | 1 | 12 | 0 |
| LULU · ingresos | 1 | 12 | 0 |

Que **todas** las familias de dos tags salgan revisadas al 100% y las de un tag
salgan en cero o en tres no es una propiedad de los emisores: es el artefacto.
`InventoryNet` y `InventoryFinishedGoods` **tienen** que diferir — son conceptos
distintos. `LongTermDebt` y `LongTermDebtNoncurrent` también. Y en ingresos,
`RevenueFromContractWithCustomerExcludingAssessedTax` e `…IncludingAssessedTax`
difieren por construcción: son la misma venta con y sin impuesto.

**Qué sí se sostiene:** que MELI se re-expresa y que LULU y MSFT no. Las
familias de **un solo tag** de MELI —costo 3, margen 4, op 3— son
re-expresiones genuinas, y ninguna otra empresa de la muestra tiene una sola.
MELI sigue siendo el fixture correcto para la pregunta 3. Lo que no se sostiene
es el número 19 como "19 re-expresiones de ingresos".

**Lo que la Fase A tiene que producir** es el conteo **por tag**, no por familia.
El esquema de §5 ya lo permite —`concept` está en la clave natural—, así que es
una cuestión de cómo se consulta, no de cómo se guarda.

### Tres cosas que el tablero delata y que la Fase A arregla

**1. La vista `company_quarterly` de §5 tiene el mismo defecto.** Está escrita
con `distinct on (cik, familia, period_end) … order by filed desc`, que elige
entre tags distintos por fecha de presentación, y con
`count(distinct val)` por `(cik, familia, period_end)`, que marca `revisado`
cuando lo único que pasó es que dos alias miden cosas distintas. Tal cual, le
mandaría al PM del Arena un "revisado" falso en el 100% de los inventarios de
LULU. **Se arregla en la rebanada B**, con prioridad de tag dentro de la familia
y el conteo de revisiones *dentro* del tag.

**2. LULU no tiene caja: 0 tags, 0 hechos.** No es que LULU no reporte efectivo
—lo reporta bajo el tag posterior a ASU 2016-18, que nuestra lista de alias no
incluye. La familia `caja` no es del núcleo de G1, así que no movió ninguna
compuerta, pero en la página produciría un **"sin documentos" falso**, que es
peor que un hueco: parece honesto. La lista de alias se amplía en la rebanada C
y el caso de LULU queda como su test.

**3. El censo de 8-K no cuadra consigo mismo por ±1.** MSFT: `8-K (5a): 44` en
la línea del censo, `8-K:43` en la de formas. MELI: 53 contra 52. LULU cuadra
(48 y 48) y VIST también (0). No mueve G2 —100% es 100% con 43 o con 44— pero es
un descuadre real entre dos conteos del mismo reporte, casi seguro por el borde
de la ventana de 5 años. La ingesta cuenta lo que guarda y ése es el número que
vale; queda anotado para que nadie lo persiga como bug.

### G4 — el dimensionamiento, que decide la decisión 1 de §10

**42 segundos y 16 llamadas por ticker.** El peso está en `companyfacts`
(p50 5.463 ms, 3,08 MB de promedio) y en los `head-doc` (32 llamadas, p50
2.500 ms). Eso resuelve el universo:

- **Un lambda de 60 s no alcanza para un ticker con margen.** La ingesta bajo
  demanda dentro de un request queda descartada por medición, no por opinión.
- Con `maxDuration: 300` —lo que ya usan `xbrl-capture` y los jobs del Arena en
  `vercel.json`— entran **~7 tickers por invocación**. La ingesta es un job de
  goteo reanudable, como dice la decisión 1.
- **La ráfaga de 10 concurrentes dio 10/10 en 200.** La SEC tolera su techo. El
  default de 6 req/s del cliente (`api/_lib/edgar.js`) es conservador a
  propósito: el margen es para los otros siete clientes que comparten la IP.

⚠️ **`reporte.json` vuelve a estar en `.gitignore`.** El tablero de acá arriba ya
es el registro durable, pero el JSON crudo de esta corrida es el mejor insumo
para los fixtures de la rebanada C. Si sigue en la Mac, vale la pena guardarlo
antes de que se pierda como el de la corrida 1.

### El goteo real — 2026-09-20

La ingesta corrió contra EDGAR en vivo y escribió en Neon. Dos turnos: el
primero con LULU y VIST, el segundo con MSFT y MELI después del arreglo de la
colisión (§11.1).

| | filings | items | hechos | derivados | `sinCita` | `claveAmbigua` | cobertura |
|---|---|---|---|---|---|---|---|
| LULU | 414 | 103 | 3.735 | 353 | **0** | n/d | completa |
| VIST | n/r | n/r | n/r | **0** | **0** | n/d | **parcial** |
| MSFT | n/r | n/r | 5.379 | 503 | **0** | **0** | completa |
| MELI | n/r | n/r | 5.091 | 380 | **0** | **0** | completa |

`n/d` = el campo no existía en el primer turno; se agregó con el arreglo.
`n/r` = no quedó en el reporte que se pegó acá. **No se rellena con una
estimación**: lo que no se reportó, no se sabe.

Lo que estos números cierran:

- **`sinCita` = 0 en los cuatro, contra la base real.** La corrida 2 lo había
  medido sobre el JSON de EDGAR; esto lo confirma sobre lo que efectivamente
  se guardó. Ningún hecho de la tabla se puede mostrar sin poder citarlo.
- **`derivados` > 0 en los tres domésticos y 0 en VIST.** Un 20-F no tiene 9M
  que restar, así que su cero no es una falla: es la definición de emisor
  extranjero, medida de punta a punta.
- **`claveAmbigua` = 0 y `duplicados` = 0.** La red de seguridad del arreglo
  quedó **sin atrapar nada**, y eso es lo que confirma el diagnóstico: la
  colisión era enteramente el Q4 derivado pisando al reportado, no una clave
  natural que no distinguiera hechos distintos. La red se queda igual — no
  depende de haber previsto todas las formas en que EDGAR repite un hecho.

### §11.1 — La colisión del primer goteo, y por qué no eran los dos tags

El primer turno perdió a MSFT y MELI enteros con
`ON CONFLICT DO UPDATE command cannot affect row a second time`: dos filas del
mismo lote con la clave de conflicto repetida hacen que Postgres rechace el
INSERT completo.

**No eran los dos tags.** La clave incluye `concept`, así que dos alias nunca
colisionan — y el contraejemplo está en el tablero de arriba: LULU también
tiene `inventario` con 2 tags y 12 revisiones, y pasó limpio.

Lo que separa a los que fallaron es otra columna de la corrida 2, **el número
de conceptos**: MELI 627 y MSFT 565 contra LULU 431 y VIST 304. La sonda
miraba 11 familias; la ingesta procesa todos los conceptos del emisor, y hay
conceptos donde **el 10-K trae el trimestre directo además del año**.
Derivarlo igual producía una segunda fila con el mismo `(concepto, unidad,
periodo, accession)` — el 10-K es el mismo documento en las dos.

El arreglo, y la regla que deja escrita: **lo que la empresa ya reportó no se
calcula.** Entre el trimestre que presentó y una resta nuestra, gana el suyo —
el suyo es el dato, el nuestro es aritmética sobre el dato.

### El 5.07 — la enmienda del desenlace *(decidida el 2026-09-20)*

La rebanada F dejó el 5.07 anotado como hueco con su número al lado. El
operador lo cerró en el mismo turno, y el argumento es mejor que el que yo
tenía:

> *"Es el único documento que dice cómo terminó la pelea. Hoy la línea muestra
> 34 filings de campaña y cero del resultado de la votación — el desenlace
> existe en EDGAR y lo estamos dejando fuera."*

Eso reencuadra el asunto. Yo lo estaba tratando como "cinco documentos más por
emisor", que es una pregunta de escala; visto así es una pregunta de
**completitud del relato**: la pregunta 2 tenía toda la campaña y nada del
resultado, que es la única parte que un lector no puede reconstruir solo. El
tablero de la corrida 2 acota el costo: **5 por emisor en los cuatro** (§11),
así que no hay cambio de escala que discutir.

**Y la línea que esto NO cruza.** Que el 5.07 aparezca en la pregunta 2 no es
decir quién ganó. El documento trae los votos —a favor, en contra,
abstenciones, non-votes— y la glosa dice "resultados de la votación de
accionistas", que es qué **es** el papel. Quién ganó, si la propuesta era del
consejo o del disidente, y qué significa el margen, es lectura, y la lectura
es Fase B. Hay tres pruebas que lo sostienen: la glosa no puede contener
vocabulario de desenlace, ni el evento ni la sección pueden traer un campo de
votos, y la pantalla entera se revisa contra ese mismo vocabulario (con el
descargo del episodio excluido, porque ése dice justamente que NO lo dice).

Un detalle que había que cuidar: **el 5.07 no engorda el episodio de la
pelea.** `agruparEpisodios` cuenta filings de solicitación impugnada; el 5.07
es un 8-K y es el cierre, no campaña. Sumarlo habría inflado un conteo que ya
es delicado ("34 filings en 156 días"), y hay una prueba que lo fija.

**No requiere re-ingesta.** `itemsDe` guarda todos los items del índice sin
lista blanca, así que los 5.07 de los cuatro emisores ya están en
`company_filing_items` desde la corrida del goteo. El cambio es de perímetro
de lectura, no de datos.

### Lo que sigue abierto

**La otra mitad de G7: la vista.** El goteo prueba que la ingesta baja y
guarda. No prueba que `company_quarterly` devuelva lo correcto — y la vista es
donde vivían los tres errores que la rebanada B tuvo que arreglar (el alias
confundido con re-expresión, el Q4 con una sola cita, el YoY contando cuatro
filas). Se cierra con `scripts/historia-g7.mjs` (§10).

## 11.2. Enmienda de formato — una línea de tiempo, siete filtros (rebanada F)

*2026-09-20. Posterior al cierre de la Fase A. Cambia la forma de la lectura,
no la capa de datos: ni el esquema ni la ingesta se tocan.*

La Fase A entregó las siete secciones y el operador las leyó. El diagnóstico
fue corto y correcto: **"sigue siendo un catálogo, no una historia"**. Tres
cosas concretas, más una cuarta que el diagnóstico no mencionaba y que era la
peor de las cuatro porque nadie la veía.

**1. El 9.01 es ruido con formato de señal.** Aparece en 30 de 30 filings y lo
único que dice es "adjunté un archivo". Mostrarlo al mismo nivel que un 4.02
no es neutralidad: es gastar la atención del lector en el sobre. Se degrada,
**no se esconde** — baja al final y en gris, y sigue contándose aparte. Lo
mismo con el 7.01… **salvo cuando va solo**. Un 8-K cuyo único item es 7.01 es
una divulgación Reg FD y ése *es* el evento; degradarlo siempre escondería
filings cuyo contenido completo es ése. La regla, entonces, depende del resto
de los items y no del item aislado (`esSecundario` en el glosario).

**2. El mismo 8-K salía en tres secciones.** El del 2022-03-29 aparecía en la
1, en la 3 y en la 7 sin decir que era el mismo papel. La regla que quedó:
*un documento es un evento — o se muestra una vez con todos sus temas, o se
marca claramente que es el mismo*. Hoy se muestra una vez y lleva las
etiquetas de las preguntas que contesta. El único lugar donde se repite a
propósito es "dónde se rompe la historia" (§8 lo pone al final, y ahí el
lector no va a buscar) — y ahí se declara en pantalla que es el mismo papel.

**3. Siete listas no son una historia.** El orden cronológico cuenta más que
el orden por categoría: lo que pasó en marzo se entiende junto a lo de abril,
no junto a otro 5.02 de hace siete años. Ahora hay **una línea**, y las siete
preguntas son filtros sobre ella.

**4. Lo que el diagnóstico no mencionaba: ese documento se contaba tres
veces.** Con siete consultas y siete listas, cada resumen sumaba 1 por el
mismo papel. "12 filings" en tres secciones sobre un universo de 20
documentos distintos es una cifra correcta sobre el conjunto equivocado, que
es la peor clase de número porque nadie la revisa. No se arregló contando con
más cuidado: se arregló **quitando la posibilidad**. Hay una sola consulta
(`eventos()`, con `exists` en vez de un join con `distinct`) y las secciones
guardan `accessions`, no copias de los documentos. Que un evento aparezca una
vez dejó de ser una convención y pasó a ser una propiedad de la estructura.

### Dos decisiones que esto obligó, y que se declaran

- **El perímetro de la línea.** La línea no es "todo lo que la empresa
  presentó": es lo que alimenta las siete preguntas. Los 10-K y 10-Q completos
  y las **Formas 3/4/5** de insiders quedan fuera — LULU tiene 196 Formas 4 y
  taparían la línea entera. No es un recorte nuevo (la Fase A tampoco las
  mostraba), pero ahora que hay UNA lista el vacío se lee como ausencia, así
  que se dice en pantalla (`linea_perimetro`).
- **Una pregunta no cubierta se puede filtrar, y ahí no se miente.** Los chips
  de las preguntas 4, 5 y 6 son clickeables aunque no tengan documentos: ahí
  es donde vive la explicación. Lo que la línea vacía **no** puede decir en
  ese caso es "se buscó en el índice y no hay" — eso sería afirmar sobre la
  empresa algo que en realidad es sobre nosotros, que es el error exacto que
  este módulo existe para no cometer. Tiene su propio texto y su propia
  prueba de e2e.

### Lo que sigue abierto

El desglose de un panel cuenta los temas de **los papeles del filtro**, no los
de la pregunta: bajo "cuál es el catalizador" puede salir `1× 5.02`, porque
ese mismo 8-K traía las dos cosas. Es cierto y es confuso, así que va
etiquetado ("Temas de estos filings:"). Si molesta en datos reales, la salida
es separar los temas de la pregunta de los del papel, no ocultar los segundos.

---

## 11.3. El paquete de evidencia (rebanada G)

*2026-09-20. Lo que la Fase B le va a pasar al modelo. Sin prompt y sin
llamada: eso es la H.*

`api/_lib/historia-evidencia.js`. La regla que lo gobierna la aprendió el
Arena con un bug, y está escrita en `api/_lib/ai-guard.js`: al PM le llegaban
las noticias con fecha absoluta y "calculá vos qué tan vieja es", y el modelo
narró unos earnings a DOS DÍAS como "post-market today". **La aritmética no se
delega al LLM.** Acá eso se traduce en cuatro cosas concretas:

- **El YoY llega resuelto**, y cuando no es comparable llega el **motivo** en
  vez de un hueco. Un `null` pelado invita a que el modelo haga su propia
  resta contra el trimestre que tenga a mano — que es exactamente el error.
  Por eso el campo `yoy_pct` **no existe** cuando no se puede calcular: en su
  lugar va `yoy_motivo`.
- **El margen bruto y el neto en porcentaje se calculan acá**, con las citas
  de los DOS hechos que entraron a la división, y **solo** cuando el periodo
  coincide exacto (inicio, fin y unidad). Mismo fin y distinto inicio —un
  trimestre contra un acumulado de nueve meses— se ve parecido y es otro
  número: no se divide.
- **La distancia entre dos papeles viene contada, y nombrando contra cuál.**
  Sin el accession, "45 días desde el anterior" es un número que el modelo no
  puede citar y el lector no puede verificar.
- **Una racha de 34 filings de campaña entra como UN episodio** con su
  conteo, su rango y su desglose, más el primero y el último como anclas
  citables. Contar es justamente lo que no se delega.

### Por qué no hay nada relativo a hoy

La tentación era mandar "hace 3 días", como hace `relativeDayLabel` en el
Arena. Acá no, y la razón es la decisión 3 de la Fase B: *la historia cambia
cuando cambia un filing, no cuando alguien abre la página*. La narración se
guarda con el hash de su evidencia. Si la evidencia dijera "hace 3 días", el
hash cambiaría todos los días —y se re-narrarían las cuatro mil empresas por
abrir la página— o, peor, no cambiaría y la narración cacheada diría "hace 3
días" cuando ya pasaron cuarenta. Una mentira con cita.

Así que el paquete lleva **fechas absolutas y distancias entre eventos**, que
son estables. `dateDirective` sí se inyecta en la llamada —para que el modelo
no ancle al presente de su entrenamiento— pero queda **fuera del hash**, por
la misma razón; y la narración tiene prohibido el lenguaje relativo a hoy, lo
cual es trabajo del guard de la rebanada I.

### Lo que entra al prompt es lo que la página muestra

El paquete se arma del **cuerpo de `/api/historia`**, no de la base. Eso hace
imposible que la narración cite algo que el usuario no pueda encontrar en la
pantalla. Leer la base por separado habría dejado que las dos vistas se
separaran sin que nadie se enterara.

### El inventario de lo citable

La pieza sobre la que descansa el guard de citas (rebanada I): la lista
cerrada de accessions que el modelo puede nombrar. Se construye **recorriendo
el paquete**, no en paralelo — una segunda lista escrita a mano se separaría
en el primer cambio, y nadie lo notaría hasta que una cita válida quedara
rechazada o, peor, una inválida aceptada. Un accession sin metadata (sin URL
abrible) sale por `huerfanos`: es un defecto del armado, no un dato, y se ve
antes de que llegue al guard. Una cita que no abre es un identificador bonito.

### El presupuesto, medido

| emisor duro (159 filings en la ventana, pelea de 34, 12 trimestres × 4 familias) | |
|---|---|
| primera versión | 58.2 KB (~17.000 tokens) |
| con el glosario deduplicado y los campos vacíos podados | **41.4 KB (~12.000 tokens)** |
| techo declarado (`TECHO_BYTES`), con prueba | 80 KB |

Las dos podas no son microoptimización. La glosa del 5.02 —"salida,
nombramiento o compensación de directivos o consejeros"— son 60 caracteres que
se repetían en cada 5.02 de la línea: en un emisor con 120 filings, **la mitad
del peso del paquete eran glosas copiadas**. Va un diccionario arriba, una
vez, y los eventos llevan solo el código. Lo mismo con los `false` y los `[]`
repetidos en 120 renglones: su ausencia dice exactamente lo mismo.

El techo está probado: si una rebanada futura lo empuja arriba, la prueba lo
dice antes de que aparezca en la factura.

### La puerta de inspección

`GET /api/historia?ticker=MELI&evidencia=1` devuelve **exactamente** lo que se
le va a pasar al modelo —más el hash, el peso medido, el inventario y los
huérfanos— **sin llamarlo**. Existe para poder mirar el paquete antes de
gastar, y para medir el presupuesto con datos reales en vez de adivinarlo.
Sigue siendo lectura: cero escrituras, cero IA.

El armado de esa respuesta vive en `historia-evidencia.js`, no en el endpoint:
meterle un seam de prueba al handler habría sido una puerta trasera en
producción para ahorrarse una función.

### La evidencia tampoco opina

El guard anti-opinión de la rebanada I mira la **salida**. Pero si la entrada
ya trae una calificación, el guard tendría que distinguir lo que el modelo
inventó de lo que nosotros le dimos, y esa distinción no se puede hacer desde
el texto. Más barato: que no entre. Hay pruebas de que el paquete no lleva
vocabulario de recomendación, ningún campo de veredicto o score, y ningún
precio — lo que el mercado ya cree vive en otro panel (§8, pregunta 6).

---

## 11.4. El prompt congelado y la llamada (rebanada H)

*2026-09-20. Cinco condiciones puestas por el operador antes de escribir una
línea. Las cinco están abajo con lo que se hizo.*

### 1. El hash tiene que cubrir el prompt y el modelo

El agujero, en las palabras del encargo: *"Si cambia una línea del prompt, las
narraciones guardadas siguen pasando el hash y son del prompt viejo. Hueco
silencioso."* Correcto y no lo había visto.

`hashNarracion` cubre ahora **(evidencia, `PROMPT_VERSION`, modelo)**. La
versión es una constante entera, explícita, legible en una columna.

Y como una constante que hay que acordarse de subir es una constante que
alguien va a olvidar, además se guarda `HUELLA_PROMPT` —el sha del TEXTO de
las instrucciones— y hay una prueba que la compara contra un valor clavado en
`tests/historia-narrador.test.mjs`. Si alguien edita el prompt sin subir la
versión, la prueba falla y dice las dos cosas que hay que hacer. No se hashea
el archivo entero a propósito: los comentarios cambian sin que cambie ninguna
instrucción, y re-narrar cuatro mil empresas por una coma en un comentario es
costo sin contrapartida.

**La fecha NO entra al hash.** `dateDirective` se inyecta en cada llamada para
que el modelo no ancle al presente de su entrenamiento, pero si entrara se
re-narraría todo cada medianoche. Lo que lo sostiene es que el prompt prohíbe
el lenguaje relativo a hoy (§11.3).

### 2. La llamada no se dispara al abrir la página

*"Si /api/historia narra on-demand, cada visita es una llamada a Opus pagada."*
Y sería una factura invisible: la página se vería igual de bien.

`/api/historia-narrar` es una puerta aparte, con las mismas tres llaves y
cuatro puertas del goteo y el mismo **fail-closed 503**. La autorización se
movió a `_lib/historia-auth.js` porque ahora la comparten dos endpoints, y
tener dos copias de "quién puede gastar plata nuestra" es tener dos reglas que
con el tiempo dicen cosas distintas.

`/api/historia` **lee** lo guardado. Tres salidas, las tres visibles:

| estado | qué se ve |
|---|---|
| `ok` | la lectura, con sus citas enlazadas y su procedencia (qué modelo, qué versión de prompt) |
| `sin_narracion` | se declara, igual que `sin_documentos`, y los documentos de la Fase A siguen ahí |
| `retenida` | **compuerta provisional**: si una cita no resuelve a un documento de esta página, no se muestra NINGUNA sección |

La tercera es más tosca que el guardia de la rebanada I —que corta la
afirmación, o la sección, y dice qué cortó— y es la dirección correcta para
equivocarse mientras tanto: una narración con una cita que no abre es un texto
que parece riguroso y no lo es.

**El pie de la página decía "sin IA" desde la Fase A.** Ahora es falso, y una
promesa falsa en el pie es peor que no tener pie. Dice lo que sigue siendo
cierto: sin predicciones de precio, sin calificaciones, sin recomendaciones.

### 3. Los episodios se citan como bloque

*"El modelo solo puede citar la primera y la última; si narra lo que pasó en
medio, el guardia le va a rechazar una frase que es cierta."* Eso sería culpa
del prompt, no del modelo.

La instrucción está **dentro** del prompt congelado, con un ejemplo correcto y
uno incorrecto, y con el porqué —"no tenés los documentos del medio y no podés
citarlos"—, que es la parte que se recuerda. Más la línea que no cruza: el
episodio no dice quién ganó; si hay un 5.07, se cita como el documento que es,
que trae los votos.

### 4. Los huérfanos: se excluyen, no se marcan

Decidido antes de la llamada, como pedía el encargo. Un hecho cuyo accession
no resuelve a un documento abrible **sale del paquete**, y lo que sale se
cuenta en `excluidos_sin_cita`.

La alternativa —dejarlo entrar marcado "no citable"— le pide al prompt cargar
una segunda regla en un módulo cuya promesa entera es *toda afirmación lleva su
accession*. Un hecho sin cita ahí no vale menos: no vale. Y una regla más es
una regla más que el modelo puede no seguir, con el guardia rechazando después
una frase que nosotros habilitamos.

Un matiz: si lo que no resuelve es el **vecino** de un evento (el `anterior`),
el evento se queda y se cae la referencia al vecino. Tirar un papel bueno
porque el de al lado no abre sería pagar dos veces.

**Un bug que esta poda destapó:** el campo que declara lo excluido se llamaba
`accessions`, que es justo una de las claves que `accessionsDe` recorre como
cita. El huérfano volvía a entrar al inventario y la puerta habría dicho "podé
esto" y seguido reportándolo como huérfano, para siempre. Se llama
`accessions_excluidos`, y hay una prueba: el nombre distinto es lo que separa
una cita de un descargo.

### 5. `stop_reason: max_tokens`

*"Una narración cortada a la mitad, con citas correctas hasta donde llegó, se
lee como completa."* Exacto: no hay nada en el texto que diga "acá me
cortaron". Se descarta, se registra el motivo y **no se guarda como narración
servible** — pero sí se guarda la fila, con estado `cortada`, y se reintenta la
próxima vez porque `narracionPorHash` solo devuelve `estado = 'ok'`.

Los otros finales que no son un éxito: `rechazo_modelo` (el clasificador
declinó), `json_invalido`, `modelo_distinto` (contestó otro modelo y guardar el
texto bajo un hash que dice éste sería mentir sobre su procedencia), `http` y
`red`.

### La respuesta cruda se guarda siempre

Pedido explícito, y es la regla correcta: *"Si el guardia la rechaza quiero ver
qué dijo, no nada más que la rechazó."* `company_narracion.crudo` se llena en
todos los caminos, incluso cuando la respuesta no es JSON en absoluto (se
guarda como texto). Sin eso el guardia es una caja negra que dice "no".

### El modelo, donde va

`HISTORIA_ANTHROPIC_MODEL` vive en `_lib/model.js`, la tercera perilla junto a
la de la app (Haiku) y la del Arena (Fable). No es preferencia: el lint de
`tests/claude-model.test.mjs` existe porque el retiro de un modelo tumbó la IA
entera por tener el ID en 26 sitios, y me agarró escribiéndolo en dos archivos
nuevos —incluso en un comentario, que también se copia—. Los precios salen de
la misma tabla, que ya tenía su doctrina escrita: *un modelo ausente devuelve
costo null, jamás un precio supuesto*.

### Lo que falta medir, y cómo

Este contenedor **alcanza `api.anthropic.com`** (probado: 401, o sea llegó)
pero **no tiene `ANTHROPIC_API_KEY`**. La corrida real la hace el operador,
igual que el goteo. Un ticker primero:

```bash
# 0. Ver qué se va a mandar y cuánto pesa, SIN pagar.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/historia-narrar?ticker=MELI&simular=1" | jq

# 1. La corrida real de UN ticker. El costo viene en la respuesta.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/historia-narrar?ticker=MELI" | jq '{estado, costo, evidencia_bytes}'

# 2. La segunda corrida mide el caché de prefijo: el prompt congelado son
#    ~1.400 tokens y el mínimo cacheable de este modelo es 512.
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/historia-narrar?ticker=MELI&forzar=1" | jq '.costo'
```

`costo` viene desglosado en `entrada`, `salida`, `cache_escritura` y
`cache_lectura`, más `cache_pego_pct`. El desglose no es decorativo: **si
`cache_lectura` sale en cero corrida tras corrida, algo está invalidando el
prefijo y se está pagando 10× de más sin que nada falle.**

El saldo lo comparte con la liga, así que va un ticker y se mira el número
antes de los cuatro.

### Anotado sin urgencia, y hecho igual

`?evidencia=1` colgaba de ruta pública sin autenticar. No filtra nada que la
página no muestre, pero en bucle le pega a Neon gratis y además enseña
exactamente qué se le manda al modelo. Ahora pide la misma llave: son cinco
líneas y ninguna de las dos cosas tiene por qué estar abierta.

---

## 11.5. Tres correcciones sobre la H

*2026-09-20. Tres huecos que el operador señaló al aprobar la H.*

### 1. El vecino podado: qué pasa con la distancia

El planteo: si el huérfano que se poda era el vecino de un evento que sí se
queda, la distancia entre papeles —que en la G viene *nombrando contra cuál*—
seguiría apuntando a un accession ausente. El modelo lo citaría, la compuerta
de la página no lo resolvería, y **se perdería la historia entera por un papel
que ni se muestra**.

Construí el caso exacto antes de decidir. `podarSinCita` ya hacía la opción
correcta —y la más fuerte de las dos que el encargo ofrecía—: cuando el vecino
se poda, **se cae el `anterior` entero, no solo el accession**. Dejar el número
de días sin referencia habría sido una afirmación que el modelo puede escribir
y no puede citar, que es exactamente lo que este módulo no hace.

Lo que estaba mal era que eso fuera un accidente del código en vez de una
propiedad probada. Ahora hay tres pruebas:

- **El caso exacto**, construido a mano: evento que sobrevive, vecino
  huérfano, y la verificación de que el paquete entero deja de nombrarlo.
- **La invariante general**, que es la que importa: *después de podar, ningún
  accession que el paquete nombre como cita puede quedar sin resolver en el
  inventario*. Vale para los eventos, los vecinos, las anclas de los
  episodios, la serie y la contraevidencia — probar un caso a mano deja los
  otros cuatro sueltos.
- Dos mutaciones deliberadas —dejar el `anterior` entero, y dejar solo los
  días— y las dos rompen pruebas.

Y un conteo mal hecho que apareció mirando: `excluidos.vecinos` se calculaba
sobre la lista original, así que un evento podado que además era vecino de
otro se contaba dos veces, una como evento excluido y otra como vecino
perdido.

**Lo que no se hace, y por qué:** el evento que pierde su vecino queda igual
que el más viejo de la ventana. No se le pone una marca de "acá había un
vecino que no puedo citar", porque el modelo no tiene nada útil que escribir
con eso. Lo perdido se cuenta en `excluidos.vecinos`, a nivel del paquete, que
es donde se puede declarar sin invitar a narrarlo.

### 2. El reintento de una narración cortada, con tope

El planteo: misma evidencia, mismo prompt, mismo modelo → el segundo intento
trunca igual. Sin límite son **dos llamadas pagadas por cada narración que no
cabe, y falla en silencio.**

Se hicieron las dos cosas que el encargo ofrecía como alternativas, porque son
complementarias:

- **El reintento sube el techo una sola vez** (16.000 → 32.000). Es lo único
  que puede cambiar el resultado; repetir con el mismo techo es pagar dos
  veces por el mismo fracaso.
- **Tope de dos intentos, acumulado en la fila.** `company_narracion.intentos`
  suma en el `on conflict`, y un hash que ya gastó sus dos intentos contesta
  **409 `cortada_definitiva`** sin llamar. Sin el acumulado, el tope se
  reiniciaría en cada visita y sería un infinito en cuotas. `forzar=1` sigue
  siendo la salida de emergencia.
- Un final que **no** es `cortada` —un rechazo del clasificador, un 500— no se
  reintenta: subir el techo no arregla ninguno de los dos.

**Y el costo suma los dos intentos.** El encargo lo dijo mejor que yo: si no,
*el número miente hacia abajo*. El intento que falló es el que más ganas dan
de no mirar, y por eso tiene que estar en la cuenta. `sumarCostos` suma tokens
y dólares y reporta `intentos`; si alguno de los intentos no tiene precio, el
total va `null` y se dicen los tokens, que sí se saben — nunca un parcial que
se lea como completo.

### 3. Las tres maneras de no mostrar una lectura

Antes las tres se veían igual: nada. Es la doctrina de `sin_documentos` /
`no_cubierta` / `fuera_del_modulo` (§8), sin aplicar a la narración.

| estado | qué pasó | qué hacer |
|---|---|---|
| `sin_narracion` | todavía no se escribió | esperar a que corra el job |
| `fallida` | se escribió y salió mal | ir a mirar qué pasó |
| `retenida` | se escribió bien, pero una cita no resuelve acá | arreglar un inventario **nuestro** |

Tres bloques distintos en pantalla —gris, rojo, ámbar—, y `fallida` dice el
motivo en categoría (`cortada`, `rechazo_modelo`, `http`…) y cuántas llamadas
se pagaron. El texto crudo del modelo **no** sale ahí: vive en la fila y se
mira con la llave, no en una página pública.

Hay una prueba de que los cuatro estados son distintos entre sí, y una de e2e
de que las tres clases CSS lo son: si dos colapsaran, la página mostraría lo
mismo para situaciones que piden acciones opuestas.

### Sobre el caché de prefijo: medirlo, no exprimirlo

Instrucción del operador, y la aritmética le da la razón: prefijo de ~1.400
tokens contra ~12.000 de evidencia que **no se comparte entre tickers**. El
techo del ahorro es ~10%, y escribir el caché cuesta 1,25× la entrada, así que
en la primera corrida de cada empresa es más caro que no cachear. Se mide para
saber que no hay nada que exprimir ahí.

**El número que importa es el costo por historia a secas**, y con el hash de
contenido cada empresa se narra una vez por cambio de filing — no una vez por
visita.

---

## 11.6. El diagnóstico que se caía justo cuando hacía falta

*2026-09-21. Un bug de una línea que costó media hora por cómo se veía.*

`GET /api/historia-harvest` sin `?job=` —la puerta de diagnóstico, la que dice
qué llaves están configuradas sin enseñar valores— devolvía **500**. Y era la
que hacía falta justamente en ese momento: la llave no entraba y ésa es la
pregunta que contesta.

### La causa

La rebanada H movió la autorización a `_lib/historia-auth.js` y dejó esto en
el endpoint:

```js
import { autorizar } from './_lib/historia-auth.js';
export { LLAVES, llavesDeLaPeticion, llavesConfiguradas, autorizar } from './_lib/historia-auth.js';
```

**`export … from` re-exporta sin crear binding local.** `autorizar` estaba
importado y funcionaba; `llavesConfiguradas` y `LLAVES` no existían en el
módulo. La rama de diagnóstico es la única que las usa, así que fue la única
que se cayó — los jobs y `/api/historia-narrar` seguían contestando 401 bien
formado, que es lo que hizo que el diagnóstico apuntara a otro lado.

El arreglo es importar los bindings y re-exportarlos:

```js
import { LLAVES, llavesDeLaPeticion, llavesConfiguradas, autorizar } from './_lib/historia-auth.js';
export { LLAVES, llavesDeLaPeticion, llavesConfiguradas, autorizar };
```

### Lo que faltaba, y es lo que importa

**No había ninguna prueba que pegara a esa rama.** Por eso se rompió en
silencio y se descubrió el día que hizo falta. Un diagnóstico que se cae
cuando lo necesitás no es un diagnóstico.

Ahora hay pruebas de handler para el GET sin `job`: que contesta 200, que
nombra las llaves configuradas, que **nunca** sale el valor de ninguna, que
fail-closed se ve desde ahí, y que aguanta una petición sin `query`. Las dos
mutaciones —volver al `export … from`, y sacar el envoltorio— rompen pruebas.

### Y un 500 que se pueda leer

Lo que convirtió un bug de una línea en media hora fue la **forma** del error.
Vercel devuelve su página HTML y todo esto se consume con `jq`, así que un
`ReferenceError` con nombre y todo llegaba como *"parse error: Invalid numeric
literal"* — que no dice absolutamente nada.

`_lib/historia-http.js` envuelve los tres endpoints de Historia para que
cualquier excepción salga como JSON con su **tipo** y su **mensaje**. No un
"error interno" pelado: eso deja al operador exactamente donde estaba, que es
el mismo problema. El mensaje pasa por un tamiz que borra lo que parece
secreto —una URL con credenciales (Neon mete la contraseña en algunos errores
de conexión), una llave con prefijo, un token largo— y el resto pasa entero.

Hay un lint que recorre `api/historia*.js` y exige el envoltorio, para que el
próximo endpoint no repita el mismo bug.

### De paso, el diagnóstico contesta la pregunta que se le hace

Quien llega ahí está preguntando *"¿mi llave está entrando?"*. Ahora lo dice:
por qué puerta llegó, de cuántos caracteres, y si sirve — un booleano. Nunca
el valor. Es la misma información que el 401 ya daba, así que no expone nada
nuevo, y ahorra el viaje de probar contra un job de verdad.

---

## 11.7. La primera corrida real, y lo que costó

*2026-09-21. MELI narrado desde la máquina del operador.*

| | |
|---|---|
| costo por historia | **$0,1719** |
| entrada | 14.344 tokens · $0,0717 (42%) |
| salida | 3.957 tokens · $0,0989 (**58%**) |
| caché leído | 2.487 tokens · $0,0012 (1%) |

**El costo lo manda la salida, no el paquete.** La evidencia entera —12.000
tokens de línea de tiempo, serie y razones— cuesta menos que las cinco
secciones que el modelo escribe. Es el dato que reordena todo lo que sigue:
apretar el paquete no mueve la aguja; lo que la mueve es cuánto se escribe.

**El caché queda cerrado como tema.** El prefijo pegó al 100%, pero fueron
2.487 tokens de 16.831 — **15% de la entrada, un centavo**. El techo es chico
por construcción: ~1.400 tokens de prompt congelado contra ~12.000 de
evidencia que no se comparte entre emisores. No hay nada que exprimir.

De paso, `costoDe` reportaba solo `cache_pego_pct` (lectura sobre cacheable),
que dio 100% y **se lee como si el caché hiciera todo el trabajo**. Ahora
reporta también `cache_del_total_pct` —cuánto de la entrada vino del caché,
14,8%—, que es el número que el operador calculó a mano justamente porque el
otro no lo decía.

### El gasto perdido, y por qué el resguardo no resguardaba

Dos llamadas anteriores murieron con `relation company_narracion does not
exist`. El orden efectivo era: armar evidencia → llamar a Opus → guardar →
tronar.

Sin `forzar=1` la lectura previa de la tabla iba primero y fallaba **gratis**.
Con `forzar=1` esa lectura se saltea, así que el primer contacto con la tabla
era el GUARDADO: la llamada se pagó y la respuesta se perdió. Y que el orden
quedara bien sin forzar era un accidente —una lectura que casualmente estaba
antes—, no una garantía.

Peor, y es el punto que importa: **la respuesta cruda se guarda en esa fila, o
sea que el resguardo vivía en la misma tabla que falló.**

Dos arreglos:

1. **Se verifica el esquema antes de cualquier camino que gaste.** Si falta,
   se intenta crear una vez (`asegurarEsquema` es idempotente); si sigue
   faltando, **503 sin llamar**. Una llamada que no se va a poder guardar no
   se hace.
2. **Un fallo posterior a la llamada reporta el costo ya incurrido** y
   devuelve lo que se compró —las secciones y la cruda— en la respuesta HTTP,
   porque cuando la escritura falla ése es el único lugar que queda.

Y dos cosas que el operador pidió y no estaban: `intentos` viaja en **toda**
respuesta (0 cuando no hubo llamada), y `excluidos_sin_cita` ya no es `null`
cuando no se excluyó nada — van los contadores en cero. En este módulo un
`null` no puede querer decir dos cosas.

### Las citas salieron de la frase

Nueve accessions dentro de una oración la vuelven ilegible, y era la razón
número uno de que no se leyera como historia. Ahora la cita es una **marca
numerada al margen del texto** que enlaza al documento y lo nombra en el
hover; el accession completo baja a la línea de fuentes de la sección. La
numeración es de la lectura entera, así que el mismo papel citado dos veces
lleva el mismo número — dos números harían parecer que son dos papeles.

Sigue siendo verificable a un clic, que es lo que no se negocia.

---

## 11.8. La decisión grande: leer el cuerpo de los 8-K

*Memo pedido el 2026-09-21. **No se implementa nada acá.** Es la decisión más
grande que le queda al módulo y va escrita antes de empezar.*

### El diagnóstico, que la propia narración dio

La sección `direccion` de MELI lo dijo sola:

> *"la evidencia cuenta documentos y fechas, no describe qué cargo cambió en
> cada caso"*

Nueve 8-K con item 5.02 y no se puede decir quién entró ni quién salió. Las
dos secciones que funcionan son las que se apoyan en XBRL, **donde sí hay
contenido**.

Esto no es un defecto del prompt ni del modelo: es estructural. Hoy el módulo
lee el **índice** de EDGAR —qué documento existe, de qué formulario, con qué
items, en qué fecha— y los **hechos XBRL**. El cuerpo del documento no se baja.
El índice dice que hubo un cambio de directivos; el cuerpo dice cuál.

### Qué se podría extraer, y qué no

| item | qué hay en el cuerpo | ¿lo tenemos hoy? |
|---|---|---|
| 5.02 | nombre, cargo, si fue salida o nombramiento, fecha efectiva, arreglo de compensación | **no** |
| 1.01 / 2.01 | contraparte, tipo de acuerdo, monto cuando se divulga | **no** |
| 4.02 | qué periodos no son confiables y por qué | **no** (solo que existe) |
| 5.07 | el recuento de votos, propuesta por propuesta | **no** (solo que hubo votación) |
| 2.02 | los números del trimestre, en el EX-99.1 | **ya los tenemos, y mejor**: XBRL etiquetado |

La fila del 2.02 importa: para lo que ya está en XBRL, el cuerpo es **peor
fuente**, no mejor. Leerlo ahí sería cambiar un número etiquetado por uno
parafraseado.

### Lo que el guardia de citas verifica, y lo que no

*Anotado acá y no solo en el reporte, por pedido del operador — y también en
la página, porque el lector tiene el mismo derecho a saberlo.*

> **El guardia de la rebanada I verifica que el documento EXISTA en la
> evidencia, no que la afirmación DIGA lo que el documento dice.**

Es la frase que hay que tener presente en todo lo que sigue. Hoy alcanza,
porque el modelo no tiene contenido con el que equivocarse: solo índices y
hechos XBRL. En cuanto entre la extracción, deja de alcanzar — y la cita
textual verificada contra el cuerpo es lo que cubre la diferencia.

### El problema de la cita, que es el problema del módulo

Hoy una afirmación cita un accession y el lector abre **un** documento y
cuenta. Si la afirmación sale de la página 3 de un exhibit de 40 páginas, el
accession sigue siendo correcto pero la promesa se degrada: de *"abrí esto y
contá"* a *"abrí esto y buscá"*.

La unidad de cita que sobrevive a leer cuerpos es **la cita textual**: un
fragmento literal del documento, que el lector confirma con un Ctrl-F y que
una máquina puede verificar contra el cuerpo guardado. Una paráfrasis no es
verificable; una cita textual aparece o no aparece.

**Recomendación: nada que salga de un cuerpo entra sin su fragmento literal.**

### El costo: qué está medido y qué no

**Medido:**

- Paquete actual: 41,4 KB / ~12.000 tokens en un emisor duro (§11.3).
- Corrida real: 14.344 tokens de entrada, $0,1719 por historia, **la salida es
  el 58%** (§11.7).

**NO medido, y no se puede medir desde el contenedor de la Fase A** — no
alcanza `sec.gov` (§0):

- Cuánto pesa el **documento primario** de un 8-K.
- Cuánto pesa el **item relevante** aislado del resto.

`company_filings.size_bytes` existe pero **mide la submission completa**
—todos los documentos, los exhibits y el XBRL—, y con eso adentro la cota
superior queda tan alta que **no informa nada**: un 8-K de dos párrafos con un
XBRL de 300 KB pesa lo mismo que uno de cuarenta páginas.

*Enmienda del 2026-09-21: el memo original proponía esa consulta como primer
número. No sirve. Lo que hay que medir es el **documento principal**, y eso no
está en la base.*

Sí está la URL del documento principal (`company_filings.url`, que la ingesta
guarda), así que **H1 es una sonda, no una consulta**: un `HEAD` por filing y
leer el `Content-Length`. No se baja el cuerpo, es una request por documento y
entra holgada en el techo de 10 req/s (§4, G4).

**El script está escrito: `scripts/historia-h1.mjs`.**

```bash
DATABASE_URL=... SEC_USER_AGENT="QuantDesk tu@correo" node scripts/historia-h1.mjs
#  --muestra=5          cuántos documentos se bajan enteros para el factor
#  --formas=8-K,10-Q    qué formularios medir
```

Las cuatro condiciones, cada una por un motivo:

1. **Solo el documento principal.** Una `HEAD` por filing sobre
   `company_filings.url`: una request, sin bajar el cuerpo.
2. **Bytes de HTML no son tokens.** En un filing de EDGAR el marcado se come
   la mitad o más, así que la aritmética sobre bytes crudos queda inflada dos
   o tres veces. De una muestra chica se bajan los documentos enteros, se les
   quitan las etiquetas y se mide la razón texto/bytes — y el informe imprime
   **el tamaño de la muestra al lado del factor**, porque un factor medido
   sobre tres documentos es eso y decirlo es parte del número. Los tokens se
   cuentan con `count_tokens` cuando hay llave (no genera, no cuesta) y con
   chars/4 cuando no, declarado como estimación.
   La muestra sale de los **8-K**: medir el factor sobre 10-K daría un número
   correcto sobre los documentos equivocados.
3. **Mediana y p95, no promedio.** Un 10-K con anexos mueve un promedio y no
   representa nada.
4. **Separado por formulario.** Un 8-K y un 10-K difieren en un orden de
   magnitud, y los que importan para la sección de dirección son los 8-K, que
   son los chicos. Un número agregado haría descartar la extracción por el
   peso de documentos que ni se van a extraer.

Eso da el peso del documento primario **sin exhibits**, que es la cifra de la
que cuelga toda la aritmética de arriba.

### La aritmética de la opción (a) — CUERPOS AL PROMPT, que es la descartada

> ⚠️ **Esta tabla es de la opción (a) y de ninguna otra.** Se deja porque es
> la que explica por qué (a) se descarta, no porque mida la ruta elegida.
> Enmienda del 2026-09-21: sin esta etiqueta, dentro de un mes alguien mata
> la idea buena con el número de la mala.

Entrada a $5/MTok (Opus 5). Hoy la entrada son 14.344 tokens ($0,072 de
$0,172).

| tokens útiles por 8-K | 20 filings | entrada extra | costo por historia |
|---|---|---|---|
| 500 (solo el párrafo del item) | 10.000 | $0,050 | ~$0,22 (+28%) |
| 2.000 (el item con su contexto) | 40.000 | $0,200 | ~$0,37 (**+116%**) |
| 8.000 (documento primario entero) | 160.000 | $0,800 | ~$0,97 (**+465%**) |

Y lo peor de (a) no es la tabla: **se paga cada vez**. Cada historia, cada
re-narración por un filing nuevo, cada subida de versión del prompt.

### La aritmética de la opción (b) — LA ELEGIDA: la extracción es un ACTIVO

*Enmienda del 2026-09-21. El memo original comparaba extracción contra
cuerpos-al-prompt **en una sola historia**, y así la extracción parece un
gasto más. La comparación real es amortizada, y cambia la conclusión de "caro"
a "se paga solo".*

Un 8-K **se extrae una vez en la vida**. El filing no cambia nunca: una vez
que están el nombre, el cargo, la fecha y la frase textual, los lee esa
historia, las que vengan después, todas las re-narraciones y todo lo que se
construya encima. La narración, en cambio, **se repaga por historia y por
versión del prompt**.

Y la extracción no necesita Opus. *"Quién salió, de qué cargo, con qué fecha,
con la frase textual"* es tarea chica y mecánica; asumir Opus infla el costo
varias veces. Con Haiku 4.5 ($1 / $5 por MTok) y ~3.000 tokens de entrada más
~300 de salida por filing:

| | qué se paga | cuándo | 20 filings |
|---|---|---|---|
| **(b) extracción** | $0,0045 por filing | **una vez en la vida del filing** | **$0,09, para siempre** |
| (b) hechos en el prompt | ~120 tokens por filing | por historia | $0,012 (**+7%** sobre $0,1719) |
| (a) cuerpos en el prompt | 2.000 tokens por filing | **por historia y por versión de prompt** | $0,20 cada vez |

**La extracción se repaga en media historia.** Después de eso, todo lo demás
es ganancia, y el paquete de narración crece un 7% en vez de un 116%.

El modelo de extracción es una **perilla aparte** de la de narración
(`HISTORIA_EXTRACCION_MODEL` en `_lib/model.js`, junto a las de la app, el
Arena e HISTORIA). Se mide con el más barato que pase H3 y se sube solo si no
pasa — no al revés.

### Tres arquitecturas

**(a) Cuerpos completos al prompt de narración.** Lo más simple de escribir y
lo peor en las tres dimensiones: el más caro (fila de abajo de la tabla), la
peor cita (la afirmación apunta a 40 páginas) y la mayor superficie de
invención, porque el modelo resume prosa libre.

**(b) Extracción por filing, en una pasada aparte, barata, con cita textual
obligatoria.** Un modelo chico —Haiku 4.5, o el más barato que pase H3— lee UN
documento y devuelve hechos
estructurados —nombre, cargo, entró/salió, fecha— cada uno con su fragmento
literal. Se guarda por accession. La narración consume **esos hechos**, no el
cuerpo.

- El paquete crece poco: un 5.02 son cuatro campos, no 8.000 tokens.
- Se paga **una vez por documento**, no una vez por historia: un filing no
  cambia nunca. Es un **activo**, no un gasto por historia — la aritmética
  amortizada está arriba.
- La cita textual se puede **verificar mecánicamente** contra el cuerpo
  guardado — es la extensión natural del guardia de citas de la rebanada I.
- Riesgo: la extracción puede errar. Pero un error con fragmento literal es
  falsable; una paráfrasis, no.

**(c) Recortar el item del HTML y mandarlo.** Barato, pero el HTML de EDGAR es
notoriamente irregular y un recorte que falla en silencio manda el párrafo
equivocado con la cita correcta, que es el peor resultado posible.

**Recomendación: (b).**

### El riesgo que no es de costo

Hoy el modelo **no puede inventar el nombre de un CFO porque no tiene ningún
nombre**. Los nombres, los cargos y los montos son exactamente donde un
resumidor deriva, y el diferenciador entero del módulo es "cero números
inventados".

Darle cuerpos cambia esa propiedad de raíz. La cita textual obligatoria es lo
que la reemplaza: un fragmento aparece en el documento o no aparece, y eso es
mecánicamente comprobable.

### Lo que habría que medir antes de escribir una línea

Con criterio fijado ANTES, como las compuertas de §4:

| | qué mide | criterio |
|---|---|---|
| **H1** | peso real del **documento primario** (mediana y **p95**, por formulario) por `HEAD` sobre su URL — no `size_bytes`, que es la submission entera. `scripts/historia-h1.mjs` | si la mediana del **8-K** pasa de ~6.000 tokens, (a) queda descartada sin discusión |
| **H2** | ¿se puede aislar el item 5.02 del HTML? | < 90% de documentos donde el encabezado se encuentra → (c) descartada |
| **H3** | ¿la extracción con cita textual verifica? Ver la definición de abajo | **< 95% → no se hace.** Es la compuerta que manda |
| **H4** | costo por filing de la extracción y cuántos filings por emisor | define si (b) es viable a 4.000 emisores |

**H3 es la que decide.** Si los fragmentos no verifican, leer cuerpos convierte
a HISTORIA en un resumidor con citas — que es peor que un resumidor sin citas,
porque parece riguroso.

#### Qué quiere decir "verifica", exactamente

*Fijado el 2026-09-21, antes de medir.*

**Subcadena exacta del cuerpo, normalizando SOLO espacios en blanco.**

- Se colapsa cualquier corrida de espacios, tabulaciones y saltos de línea a
  un espacio, en el fragmento y en el cuerpo. Nada más.
- No se normalizan mayúsculas, ni acentos, ni comillas tipográficas, ni
  guiones, ni puntuación.
- **Nada difuso.** Ni distancia de edición, ni "equivalente en significado",
  ni n-gramas, ni umbral de parecido.
- Si la frase no aparece **tal cual**, la extracción **se descarta y se
  cuenta**. No se corrige, no se aproxima, no se acepta "casi".

Ésa es la diferencia entre una cita y una afirmación. Un umbral de parecido
convierte la cita en una afirmación con buena presentación, y ahí se pierde
todo lo que el módulo tiene para ofrecer.

El verificador no es de esta rebanada: **es el mismo que la rebanada I usa
para las citas de la narración**, y por eso la I va primero.

### Lo que no cambia en ningún escenario

Las reglas de §8 y la prohibición de predecir precio, calificar o recomendar.
Y la contraevidencia obligatoria: si se leen cuerpos, "dónde se rompe la
historia" gana una fuente nueva —lo que el documento dice y contradice lo que
contamos— no pierde ninguna.

---

## 11.9. Los guardias de la salida (rebanada I)

*2026-09-21. Van antes de la extracción, por pedido del operador y con razón:
la extracción de cuerpos es exactamente por donde entraría una cita inventada.
Hoy el modelo no puede alucinar el nombre de un CFO porque no tiene ninguno;
el guardia tiene que estar antes de que eso cambie.*

`api/_lib/historia-guardia.js`. El módulo descansa en dos promesas —*toda
afirmación lleva su cita* y *nada de predecir precio, calificar ni
recomendar*— y un prompt que las pide es una intención. Esto es lo que las
vuelve propiedades.

### El verificador literal, que es el mismo que va a usar H3

**Subcadena exacta, normalizando SOLO espacios en blanco.** Se colapsa
cualquier corrida de espacios, tabulaciones y saltos de línea; nada más. Un
acento, una mayúscula, una comilla tipográfica o un guión distinto **cuentan
como diferencia** y descartan el fragmento.

Nada difuso: ni distancia de edición, ni "equivalente en significado", ni
umbral de parecido. Un umbral convierte la cita en una afirmación con buena
presentación, y ahí se pierde todo lo que el módulo tiene para ofrecer.

Se normalizan los espacios y nada más porque el HTML de EDGAR parte las frases
con saltos de línea en lugares arbitrarios: una corrida de espacios no es una
diferencia de contenido. Lo demás sí lo es.

### Qué se corta, y con qué granularidad

La unidad es la **oración**, no el párrafo: una cita inventada en la tercera
afirmación no tiene por qué llevarse las dos buenas. Si después de cortar no
queda ninguna, **cae la sección entera** — mostrarla vacía o con un resto
inerte miente por omisión.

| guardia | qué corta | por qué |
|---|---|---|
| **citas** | una `[accession]` que no está en el inventario del paquete que se le mandó | es el diferenciador del producto |
| **opinión** | precio objetivo, calificación, recomendación, veredicto de inversión | §8 y el encargo |
| **relativo a hoy** | "recientemente", "actualmente", "este año" | la narración se guarda con el hash de su evidencia y se sirve durante meses: "hace poco" envejece mintiendo, con la cita correcta al lado |

El guardia corre **antes de guardar**, no al leer: una narración con una cita
inventada no debe llegar a existir como servible. Lo que se guarda en
`secciones` es el texto ya cortado; `cortes` lleva el registro con el texto
cortado adentro, y `crudo` queda intacto — sin eso no se puede ver qué dijo el
modelo antes del corte, que es la misma razón por la que la cruda se guarda
siempre (§11.4).

Estados: `ok` (no se tocó nada) · `ok_con_cortes` (sobrevivió algo, el hueco
se declara en pantalla) · `rechazada` (no quedó ninguna sección; la página se
cae a los documentos de la Fase A).

### Dónde está el límite de la lista de opinión

Es la parte fácil de arruinar en la dirección contraria. **Describir lo que un
documento dice no es calificar**: *"avisó que no se puede confiar en sus
estados financieros [acc]"* es un hecho; *"tiene problemas contables serios"*
es una conclusión nuestra.

Por eso la lista tiene verbos de consejo y adjetivos de valuación, y **no**
tiene palabras como "riesgo" o "problema", que aparecen legítimamente al
describir lo que un 8-K dice de sí mismo. Hay siete frases permitidas en las
pruebas que fallarían con una lista más ancha.

Mismo cuidado en el guardia de fechas: `reciente` **no** entra como raíz
suelta, porque *"el filing más reciente"* es una comparación entre documentos
y es correcta.

### Dos cosas que las pruebas adversarias encontraron

Las pruebas están escritas para **intentar pasar** el guardia, no para
confirmar que anda. Dos resultados:

1. **Un bug real.** El estado se calculaba mirando primero si hubo cortes:
   un modelo que devolviera secciones de texto vacío —cero afirmaciones, cero
   cortes— quedaba en `ok` con nada adentro, y la página habría pintado un
   bloque en blanco como si fuera una lectura. Ahora lo primero que se mira es
   si sobrevivió algo.

2. **Código muerto que parecía defensa.** Había un caso especial para no
   partir en los decimales (`12.3%`). Al mutarlo no rompía ninguna prueba: la
   regla de *"el punto tiene que ir seguido de un espacio"* ya lo cubre. Se
   sacó. Código que parece cargar peso y no lo carga es peor que no tenerlo,
   porque el próximo que lo lea va a creer que ahí está la defensa. La lista
   de abreviaturas, en cambio, sí hace falta: al mutarla, `EE.UU.` se parte al
   medio.

### La colisión con las citas textuales, resuelta antes de que aparezca

*Enmienda del 2026-09-21. El operador la vio venir: la extracción va a traer
frases textuales de los documentos, y una carta de un activista dice "la
acción está infravalorada" con todas las letras. El guardia cortaría una cita
literal verificada — lo más verificable que el módulo tiene.*

**La prohibición es sobre la voz del narrador, no sobre texto entre comillas
comprobado contra el cuerpo.** Dos cambios:

**1. El consejo de otro es un hecho; el nuestro es una recomendación.** La
lista se partió en dos. `RAICES_CONSEJO` está marcada por persona —primera
persona, imperativo, adjetivo deóntico— y el discurso referido no entra.
`RAICES_VALUACION` sigue siendo ancha, porque "la acción está barata" no tiene
primera persona y es una calificación igual.

Esto arregló un bug que ya estaba vivo: la raíz `recomend` cortaba **"El
consejo recomendó votar a favor [acc]"**, que es un hecho sobre un proxy y
justamente lo que la pregunta 2 existe para decir. Y lo hacía de forma
arbitraria, porque en español el tallo alterna: agarraba "recomendó" y
"recomendamos" pero **no** "recomienda", así que la misma frase pasaba o se
cortaba según el tiempo verbal.

**2. La exención de la cita textual, fail-closed.** Lo entrecomillado con
`«…»` se exime de los guardias de opinión y de fecha **solo si aparece
literal en el cuerpo de alguno de los documentos que la propia afirmación
cita**. Si no verifica, se corta con el motivo `cita_textual_no_verificada`.

Tres decisiones adentro:

- **`«…»` y no comillas rectas.** El delimitador decide qué se exime de un
  guardia, así que es load-bearing; las comillas rectas aparecen solas en
  prosa y un delimitador inequívoco vale más que uno natural.
- **Contra el cuerpo del documento CITADO**, no contra cualquiera: si no, se
  le atribuiría a un papel lo que dijo otro.
- **La exención cubre lo entrecomillado y nada más.** La opinión propia
  pegada al lado de una cita válida sigue cayendo.

Hoy no hay cuerpos guardados, así que **ninguna cita textual verifica y
ninguna pasa**. Es el estado correcto: la exención existe, está probada y está
cerrada hasta que la extracción la abra. Por eso tampoco se tocó el prompt: una
instrucción de "podés citar textual" sin cuerpos de dónde citar es una
invitación a inventar comillas, y el guardia se las cortaría después de pagar
la llamada.

### Lo que este guardia NO hace

**Verifica que el documento EXISTA en la evidencia, no que la afirmación DIGA
lo que el documento dice.** La verificación de contenido es la cita textual, y
es la que entra con la extracción (§11.8, H3) — usando este mismo verificador
literal.

---

## 12. Fuentes

- SEC, *Webmaster FAQ / Developer resources* — User-Agent obligatorio y techo
  de 10 req/s: https://www.sec.gov/os/webmaster-faq#developers
- SEC, *EDGAR Application Programming Interfaces* (`submissions`,
  `companyconcept`, `companyfacts`, `frames`):
  https://www.sec.gov/edgar/sec-api-documentation
- SEC, *Full-Text Search* (cobertura desde 2001):
  https://efts.sec.gov/LATEST/search-index — UI en https://efts.sec.gov/LATEST/search-index?q=
- SEC, *Form 8-K — items*: https://www.sec.gov/fast-answers/answersform8khtm.html
- FASB ASC 606 y el corte de taxonomía en los tags de ingresos (us-gaap 2018+).
- Precedentes en este repo: `docs/congreso-fase0.md` (la disciplina de
  compuertas con criterio previo y la lección del medidor sin probar),
  `api/_lib/pead-db.js` (forma del esquema sobre Neon), `api/short-interest.js`
  (short interest vs short volume), `api/_lib/ai-guard.js` (la aritmética se
  resuelve antes del prompt, no dentro).
