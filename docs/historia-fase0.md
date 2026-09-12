# FASE 0 — HISTORIA (EDGAR): reconocimiento de fuentes

> **Alcance de este documento:** SOLO reconocimiento. No hay ingesta acá, ni
> endpoint, ni página, ni prompt. Si las compuertas abren, la Fase A arranca
> de la lista de decisiones congeladas (§10).
>
> **Estado: LA SONDA ESTÁ ESCRITA Y PROBADA, PERO NO CORRIDA.** El contenedor
> donde se escribió esto tiene el egress a `*.sec.gov` cerrado por política de
> la organización (§0). Los seis criterios de compuerta quedan **fijados antes
> de la corrida** (§4) y `scripts/historia-phase0-probe.mjs` los mide en una
> sola pasada desde cualquier máquina con internet abierto.
>
> Fecha del reconocimiento: 2026-09-12.

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

Seis. El criterio está escrito acá y **codificado** en la función `veredicto()`
de la sonda, así que no se puede mover después de ver el número.

### G1 — ¿existe la película trimestral, y es citable?
> **Verde si:** para los **4 conceptos del núcleo** (ingresos, margen bruto,
> inventario, resultado neto), cada emisor tiene **≥ 11 de 12 trimestres
> efectivos** en 3 años, contando los Q4 derivables.
>
> Se reporta además, sin que decida la compuerta: cuántos hechos vienen **sin
> `accn`** (cada uno es una afirmación que no se va a poder citar) y cuántos
> periodos tienen **re-expresiones**.

### G2 — ¿el 8-K se puede clasificar sin leerlo?
> **Verde si:** **≥ 95%** de los 8-K de los últimos 5 años traen la columna
> `items` en el índice **y 0 vienen mal formados** (todo item tiene que
> matchear `N.NN`).
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
`pead-db.js`. Tres tablas y dos vistas.

### Dos desviaciones de lo que pidió el encargo, y por qué

**1. `item` (singular) → tabla hija.** El encargo pide
`company_filings (cik, accession, form, item, fecha, url)`. Pero un 8-K trae
**varios** items (`5.02,9.01` es lo normal). Con `item` singular, "dame todos
los 8-K con 5.02 de este CIK" se vuelve un `like '%5.02%'` que también matchea
`15.02`. Se guarda la cadena cruda por fidelidad **y** una tabla hija
normalizada para consultar.

**2. `company_facts` necesita más que `(cik, concepto, periodo, valor,
accession)`.** Faltan tres columnas sin las cuales el módulo no funciona:
`period_start` (sin ella no se distingue un trimestre de un año que terminan
el mismo día), `period_class` (la clasificación Q/9M/FY que hace derivable el
Q4) y `filed` (sin ella no se ordenan las re-expresiones y no se sabe cuál es
la última palabra de la empresa).

```sql
create table if not exists company_filings (
  cik           text not null,
  accession     text not null,
  form          text not null,          -- '8-K', 'SC 13D/A', 'DEF 14A'…
  items_raw     text not null default '', -- '5.02,9.01' tal cual el índice
  filed         date not null,
  report_date   date,
  primary_doc   text,
  url           text not null,          -- documento primario, listo para citar
  index_url     text not null,          -- index.json del filing (exhibits)
  is_xbrl       boolean not null default false,
  size_bytes    bigint,
  ingested_at   timestamptz not null default now(),
  primary key (cik, accession)
);
create index if not exists company_filings_cik_form on company_filings (cik, form, filed desc);

-- Tabla hija: un renglón por item de 8-K. Lo que hace consultable la
-- pregunta 1 ("dame cada 5.02 en orden") sin un like frágil.
create table if not exists company_filing_items (
  cik       text not null,
  accession text not null,
  item      text not null,              -- '5.02'
  primary key (cik, accession, item),
  foreign key (cik, accession) references company_filings (cik, accession) on delete cascade
);
create index if not exists company_filing_items_item on company_filing_items (cik, item);

create table if not exists company_facts (
  id            bigserial primary key,
  cik           text not null,
  taxonomy      text not null,          -- 'us-gaap' | 'ifrs-full' | 'dei'
  concept       text not null,          -- el tag crudo, sin traducir
  familia       text,                   -- 'ingresos' | 'margen' | … (nuestro mapeo; null si no mapea)
  unit          text not null,          -- 'USD' | 'shares' | 'USD/shares'
  period_start  date,                   -- null en instantes (inventario, caja)
  period_end    date not null,
  period_class  text not null,          -- 'Q' | 'H1' | '9M' | 'FY' | 'INSTANT' | 'OTRO'
  fy            int,
  fp            text,
  form          text,                   -- '10-Q' | '10-K' | '20-F'
  filed         date not null,          -- ordena las re-expresiones
  accession     text not null,          -- LA CITA. Sin esto el hecho no se puede afirmar.
  val           numeric not null,
  derived       boolean not null default false,  -- true si es un Q4 = FY − 9M
  ingested_at   timestamptz not null default now()
);
-- Clave natural. Va como índice único y no como PK porque period_start es
-- nullable en los instantes y una PK no admite nulos.
create unique index if not exists company_facts_natural on company_facts (
  cik, taxonomy, concept, unit, period_end,
  coalesce(period_start, date '1900-01-01'), accession
);
create index if not exists company_facts_serie on company_facts (cik, familia, period_end desc);
```

### El gancho al Arena: la vista, no la tabla

> *"La serie trimestral es la película que le falta al PM — mismo módulo, dos
> consumidores. Diseñá la tabla para que `ai-guard.js` la pueda leer después."*

`ai-guard.js` tiene una doctrina explícita, escrita tras un bug real: **la
aritmética de calendario no se delega al LLM, se resuelve antes y viaja al
prompt ya hecha** (el comentario de `relativeDayLabel`: el PM narró unos
earnings a dos días como "post-market today"). La misma doctrina aplica acá:
el PM no debe recibir 12 filas crudas y calcular el YoY de cabeza. Recibe el
YoY ya calculado, con su fecha y su `accession`.

Por eso el consumidor del Arena no es la tabla: es **una vista que ya resolvió
las tres cosas difíciles** — la re-expresión (se queda la última palabra), el
Q4 derivado y el YoY fiscal.

```sql
-- Una fila por (cik, familia, trimestre), con la ÚLTIMA presentación de ese
-- periodo. `revisado` marca que hubo una anterior con otro valor: eso no se
-- esconde, es la pregunta 3.
create or replace view company_quarterly as
with ultima as (
  select distinct on (cik, familia, period_end)
         cik, familia, period_end, period_start, unit, val,
         accession, filed, form, derived
    from company_facts
   where familia is not null
     and period_class = 'Q'
   order by cik, familia, period_end, filed desc, accession desc
),
conteo as (
  select cik, familia, period_end, count(distinct val) as versiones
    from company_facts
   where familia is not null and period_class = 'Q'
   group by 1, 2, 3
)
select u.*,
       (c.versiones > 1) as revisado,
       lag(u.val, 4) over (partition by u.cik, u.familia order by u.period_end) as val_hace_un_anio,
       case when lag(u.val, 4) over (partition by u.cik, u.familia order by u.period_end) > 0
            then round(100.0 * (u.val - lag(u.val, 4) over (partition by u.cik, u.familia order by u.period_end))
                       / lag(u.val, 4) over (partition by u.cik, u.familia order by u.period_end), 1)
       end as yoy_pct
  from ultima u
  join conteo c using (cik, familia, period_end);
```

Cada fila que sale de ahí trae `accession` y `filed`. Es la condición para que
tanto el lector de Historia como el PM del Arena puedan afirmar algo: **el dato
y su documento viajan juntos, siempre.**

**Este PR no toca el Arena.** La vista se crea en la Fase A y queda ahí; quién
la conecte al PM es otra decisión y otro PR.

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

| Fase B — el lector | horas |
|---|---|
| Prompt congelado en código + las 7 secciones + "Dónde se rompe la historia" | 8–12 |
| **Guard de citas**: toda `[accession]` de la salida tiene que existir en el contexto que se mandó; si no, se corta | 5–7 |
| **Guard anti-opinión**: prohibido precio, calificación y recomendación, con tests que lo intenten | 5–7 |
| Retiro del AI verdict de SMART $ + i18n + tests (§9) | 3–5 |
| **Subtotal Fase B** | **21–31** |

**Total: 60–86 horas.** Más, si G5 empuja a extraer guía de prosa: **+10–16**
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
| Guía, si G5 confirma H1 | no está etiquetada en XBRL | *"La guía no viene estructurada: se enlaza el 8-K donde la empresa la dio."* |
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

---

## 11. Resultados de la corrida

**Vacío a propósito.** Se llena pegando la salida de la sonda. No hay número
acá hasta que haya una corrida real; ver §0.

```
(pendiente — node scripts/historia-phase0-probe.mjs)
```

| Compuerta | Criterio | LULU | MSFT | MELI | VIST | Estado |
|---|---|---|---|---|---|---|
| G1 company-facts | ≥11/12 trimestres efectivos en el núcleo | — | — | — | — | ⬜ |
| G2 items de 8-K | ≥95% con item, 0 mal formados | — | — | — | — | ⬜ |
| G3 13D / proxies | toda URL muestreada da 200 | — | — | — | — | ⬜ |
| G4 latencia | sin umbral (dimensionamiento) | — | — | — | — | ⬜ |
| G5 guía en XBRL | bifurcación de diseño | — | — | — | — | ⬜ |
| G6 perfil de emisor | etiqueta de cobertura | — | — | — | — | ⬜ |

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
