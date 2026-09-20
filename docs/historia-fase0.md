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
| Prompt congelado en código + las 7 secciones + "Dónde se rompe la historia" | 8–12 |
| **Guard de citas**: toda `[accession]` de la salida tiene que existir en el contexto que se mandó; si no, se corta | 5–7 |
| **Guard anti-opinión**: prohibido precio, calificación y recomendación, con tests que lo intenten | 5–7 |
| Retiro del AI verdict de SMART $ + i18n + tests (§9) | 3–5 |
| **Subtotal Fase B** | **26–38** |

**Total: 71–103 horas.** Más, si G5 empuja a extraer guía de prosa: **+10–16**
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
