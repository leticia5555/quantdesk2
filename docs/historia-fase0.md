# FASE 0 — HISTORIA (EDGAR): reconocimiento de fuentes

> **Alcance de este documento:** SOLO reconocimiento. No hay ingesta acá, ni
> endpoint, ni página, ni prompt. La Fase A arranca de las decisiones
> congeladas en §10.
>
> **VEREDICTO: VIABLE.** Compuertas tras la corrida 1 (§11): **G1 🟢 VERDE**
> (12/12 trimestres efectivos en los tres emisores domésticos) · **G2 🟢
> VERDE** (100% de los 8-K traen item en el índice, 0 mal formados) · **G3 🟢
> VERDE** (32/32 URLs resueltas) · **G4 🟢** (ráfaga de 10 concurrentes sin un
> solo 429) · **G5 🔴 la guía NO está en XBRL** — confirmado, y bifurca el
> diseño · **G6** LULU/MSFT/MELI domésticos, VIST cobertura parcial.
>
> Fecha del reconocimiento: 2026-09-12. Corrida 1 el mismo día, MacBook, IP
> residencial. La estimación subió de 60–86 h a **71–101 h**, y §7 dice por
> cuáles dos líneas.

---

## 0. Honestidad sobre de dónde salieron estos números

El contenedor donde se escribió la sonda **no tiene salida a `*.sec.gov`**
(política de egress de la organización: `403 to CONNECT` en `www.sec.gov`,
`data.sec.gov` y `efts.sec.gov`). Por eso la primera versión de este documento
se entregó con la tabla de resultados **vacía**: la regla de cero números
inventados aplica primero al propio reconocimiento.

Los números de §11 son de una **corrida real**, hecha por Leticia desde su
MacBook el 2026-09-12: 63 llamadas HTTP, 21.7 s, 14.46 MB. La salida cruda
quedó en `.historia-fase0/reporte.json`.

Lo que **no** está medido se marca como tal en cada tabla. Hay dos cosas así,
y ninguna afecta una compuerta (§11.4).

---

## 1. La pregunta de la Fase 0

¿Alcanza EDGAR —solo EDGAR, gratis y sin auth— para contar la historia de una
empresa en 7 secciones, con **cada afirmación citada a un documento**, sin que
el módulo tenga que inventar, estimar o rellenar?

**Respuesta: sí, con un hueco nombrado.** La mitad "entregaron" de la pregunta
3 está estructurada, completa y citable. La mitad "prometieron" —la guía— no
existe como dato estructurado en ninguna parte de EDGAR y pasa a ser trabajo
de lectura (§3). Las otras seis preguntas tienen fuente.

---

## 2. La capa de datos: qué da EDGAR y qué no

Cinco rutas, públicas, anónimas y gratis. El
[webmaster FAQ](https://www.sec.gov/os/webmaster-faq#developers) exige
User-Agent descriptivo y pone el techo en **10 req/s**. La sonda corre a 8.

| Ruta | Qué da | Medido en la corrida 1 |
|---|---|---|
| `www.sec.gov/files/company_tickers.json` | ticker → CIK | 10.426 tickers, 0.80 MB, 877 ms |
| `data.sec.gov/submissions/CIK…json` | índice: forma, fecha, **items del 8-K**, doc primario | p50 256 ms · LULU 1.627 filings desde 2007 en 2 páginas |
| `data.sec.gov/api/xbrl/companyfacts/…` | toda la serie XBRL con `accn`, `filed`, `fy`, `fp` | p50 354 ms · **3.9 MB promedio** por emisor doméstico |
| `efts.sec.gov/LATEST/search-index` | full-text 2001→hoy | p95 2.3 s · **1 de 4 llamadas dio HTTP 500** |
| `…/Archives/edgar/data/<cik>/<acc>/index.json` | exhibits del filing (`EX-99.1`) | p50 109 ms, 2.6 KB |

`companyfacts` es el **85% del payload total** (12.32 de 14.46 MB). Es la
única ruta pesada y la que decide la estrategia de ingesta (§10.1).

### Las tres rarezas que decidieron el diseño del medidor

**(a) Q4 no existe.** El 10-Q trae Q1–Q3 y el 10-K trae el **año**. El cuarto
trimestre nunca es un hecho XBRL: se deriva, `Q4 = FY − 9M`. Confirmado en los
tres domésticos: **9 trimestres directos + 3 Q4 derivables = 12 efectivos**,
exactamente el patrón previsto. Un contador que no derive habría cantado 75%
de cobertura y mandado a rojo una compuerta que está verde con margen.

**(b) La serie cambia de tag a mitad de camino.** MELI tiene **2 tags** en
ingresos (el corte de ASC 606); LULU y MSFT, 1. La unidad de cobertura es la
**familia**, no el tag.

**(c) Las re-expresiones son materia prima, no ruido.** MELI re-expresa costo
(3 periodos), margen bruto (4) y resultado operativo (3). Eso es la empresa
corrigiéndose, con fecha y documento — y es exactamente lo que la pregunta 3
necesita. Por eso `accession` va en la clave natural de la tabla (§5).

---

## 3. Las 7 preguntas → su fuente

| # | Pregunta | Fuente | Estado tras la corrida |
|---|---|---|---|
| 1 | Quién la dirige y si son estables | 8-K item **5.02** + bios del DEF 14A | 🟢 LULU 13 × 5.02 en 5 años · MSFT 5 |
| 2 | Quién la posee y quién pelea | 13F y Form 4 (ya los tenemos) · SC 13D/13D-A · PREC14A/DEFC14A | 🟢 LULU 8 filings de pelea + 32 DFAN14A |
| 3 | Qué prometieron vs qué entregaron | resultados de company-facts **vs** guía en prosa del EX-99.1 | 🟡 **partido en dos** — ver abajo |
| 4 | Qué dice y qué evade la gerencia | transcripts | 🔴 **NO CUBIERTO** por decisión del encargo (§8) |
| 5 | Quién les come el mercado | filings de los competidores **públicos** | 🟡 falta el mapa de pares (§6) |
| 6 | Qué cree ya el mercado | short volume + opciones + precio, **sin IA** | 🟢 ya lo tenemos (§6) |
| 7 | Cuál es el catalizador | 8-K de eventos + fechas de junta | 🟡 el próximo earnings **no es de EDGAR** (§6) |

### La pregunta 3, resuelta: la guía es trabajo del lector

G5 barrió **1.927 conceptos XBRL** en los cuatro emisores buscando
`/guidance|forecast|outlook|projected|guided/i`. Resultado: **0**. En ninguno.
Y los **15 de 15** filings con item 2.02 revisados traen un exhibit `EX-99`.

Los dos números apuntan al mismo lado y la hipótesis H1 queda confirmada: **la
guía no está etiquetada en ninguna taxonomía; vive en la prosa del EX-99.1 que
cuelga del 8-K item 2.02.**

Decisión, que es la salida 1 de las tres que planteaba la Fase 0:

- **La Fase A no guarda ni un número de guía.** Guarda la serie de resultados
  real (estructurada, citable) y la **URL del EX-99.1** de cada 8-K 2.02.
- **La Fase B lee ese EX-99.1** y narra lo que la gerencia prometió, citándolo
  con su `accession`. **Sin parsear números**: el lector cita la frase de la
  empresa, no extrae una cifra para guardarla.
- Lo que sigue prohibido: guardar un número de guía que salió de un modelo sin
  que nadie lo haya verificado contra el documento. Es exactamente el bug que
  este módulo existe para no repetir.

Esto mueve trabajo de la Fase A a la Fase B, y §7 lo cobra.

---

## 4. Las compuertas — criterio y resultado

Los criterios se fijaron **antes** de correr y están codificados en la función
`veredicto()` de la sonda.

| | Criterio | Resultado |
|---|---|---|
| **G1** company-facts | ≥11/12 trimestres efectivos en ingresos+margen+inventario+neto, **solo emisores domésticos** | 🟢 **VERDE** — 12/12 en LULU, MSFT y MELI · VIST fuera de criterio |
| **G2** items de 8-K | ≥95% de los 8-K con item en el índice y 0 mal formados, **solo emisores domésticos** | 🟢 **VERDE** — 100.0% en los tres, 0 mal formados · VIST fuera de criterio |
| **G3** 13D / proxies | toda URL de documento primario muestreada da 200 | 🟢 **VERDE** — 32/32, los cuatro emisores |
| **G4** latencia | sin umbral: dimensionamiento | 🟢 ráfaga de 10 concurrentes → 10× HTTP 200 en 524 ms, cero 429 |
| **G5** guía en XBRL | bifurcación de diseño | 🔴 **NO EXISTE** — 0 de 1.927 conceptos. Ver §3 |
| **G6** perfil de emisor | etiqueta de cobertura | LULU/MSFT/MELI domésticos · **VIST cobertura parcial** |

### 4.1 El criterio de G1 y G2 se condicionó al perfil del emisor **después** de ver el número

Hay que decirlo así de directo, porque §4 de la versión anterior prohibía
mover un umbral después de la corrida, y acá se movió algo.

**Qué pasó.** En la corrida 1, G1 y G2 salieron rojas. No por LULU, MSFT ni
MELI —los tres dieron 12/12 y 100.0%— sino **solo por VIST**, que dio 0/12
trimestres y 0 de 0 8-K.

**Por qué eso no es una falla de EDGAR.** VIST es emisor privado extranjero:
presenta 20-F anual y 6-K, **no presenta 10-Q ni 8-K**. G1 le estaba pidiendo
trimestres a quien no reporta trimestres, y G2 le estaba pidiendo items de 8-K
a quien tiene 0 8-K y 250 6-K. El rojo no medía la fuente: medía que le
pedimos peras al olmo.

**Qué se cambió.** La **población**, no la vara: G1 y G2 evalúan solo a los
emisores domésticos, y los extranjeros se imprimen aparte, **fuera de
criterio**, con sus números reales al lado.

Dos refinamientos que salieron al implementarlo y que valen por sí solos:

- **Sin 8-K la cobertura es `n/a`, no 0%.** La corrida 1 imprimió
  `VIST 0.0%`, que se lee como fallo cuando en realidad era ausencia de
  muestra. Son cosas distintas y ahora se imprimen distinto.
- **Estado `INCONCLUSO`.** Una compuerta que se queda sin emisores domésticos
  que medir no opina: ni verde por vacío ni roja. Sin esto, cualquier filtro
  que vaciara la muestra caía en rojo — la misma confusión de antes, en otra
  forma.

**Qué NO se cambió, y es la prueba de que no es hacer trampa:**

- **El umbral doméstico sigue en ≥11/12.** No se tocó. Los tres domésticos
  dieron 12/12 — la vara tiene un trimestre entero de margen y no se ajustó
  para que algo pasara raspando.
- **VIST no quedó "aprobada".** Quedó como *no aplica*, con su realidad
  impresa en el tablero: `0 trimestres`, `250 6-K sin columna items`. Y G6 la
  etiqueta **COBERTURA PARCIAL**, que es texto que el usuario va a ver en la
  pantalla (§8).
- **La alternativa tramposa estaba disponible y no se tomó**: bajar el umbral
  de ≥11/12 a ≥0/12 hubiera pintado las dos compuertas de verde sin cambiar
  un solo hecho del mundo.

La prueba que importa: **¿el cambio esconde algún problema real?** No — lo
hace *más* visible, porque convierte un foco rojo en una sonda interna en una
etiqueta de cobertura en el producto.

---

## 5. El esquema

Postgres sobre la frontera de `api/_lib/db.js` (Neon, SQL sobre HTTP), como
`pead-db.js`. Tres tablas y una vista.

### Dos desviaciones de lo que pidió el encargo, ya aceptadas

**1. `item` (singular) → tabla hija.** Un 8-K trae varios items —LULU tiene 47
8-K con `2.02,9.01` y compañía— y con `item` singular, "dame todos los 8-K con
5.02" se vuelve un `like '%5.02%'` que también matchea `15.02`. Se guarda la
cadena cruda por fidelidad **y** una tabla hija normalizada para consultar.

**2. `company_facts` necesita más que `(cik, concepto, periodo, valor,
accession)`:** `period_start` (sin ella no se distingue un trimestre de un año
que terminan el mismo día), `period_class` (lo que hace derivable el Q4) y
`filed` (sin ella no se ordenan las re-expresiones de MELI).

```sql
create table if not exists company_filings (
  cik           text not null,
  accession     text not null,
  form          text not null,            -- '8-K', 'SC 13D/A', '6-K'…
  items_raw     text not null default '', -- '5.02,9.01' tal cual el índice
  filed         date not null,
  report_date   date,
  primary_doc   text,
  url           text not null,            -- documento primario, listo para citar
  index_url     text not null,            -- index.json del filing (exhibits)
  exhibit_99_url text,                    -- EX-99.1 del 2.02: lo que lee la Fase B
  is_xbrl       boolean not null default false,
  size_bytes    bigint,
  ingested_at   timestamptz not null default now(),
  primary key (cik, accession)
);
create index if not exists company_filings_cik_form on company_filings (cik, form, filed desc);

create table if not exists company_filing_items (
  cik       text not null,
  accession text not null,
  item      text not null,                -- '5.02'
  primary key (cik, accession, item),
  foreign key (cik, accession) references company_filings (cik, accession) on delete cascade
);
create index if not exists company_filing_items_item on company_filing_items (cik, item);

create table if not exists company_facts (
  id            bigserial primary key,
  cik           text not null,
  taxonomy      text not null,          -- 'us-gaap' | 'ifrs-full' | 'dei'
  concept       text not null,          -- el tag crudo, sin traducir
  familia       text,                   -- 'ingresos' | 'margen' | … (null si no mapea)
  unit          text not null,
  period_start  date,                   -- null en instantes
  period_end    date not null,
  period_class  text not null,          -- 'Q' | 'H1' | '9M' | 'FY' | 'INSTANT' | 'OTRO'
  fy            int,
  fp            text,
  form          text,
  filed         date not null,          -- ordena las re-expresiones
  accession     text not null,          -- LA CITA. Sin esto el hecho no se afirma.
  val           numeric not null,
  derived       boolean not null default false,  -- true si es un Q4 = FY − 9M
  ingested_at   timestamptz not null default now()
);
-- Clave natural como índice único y no como PK: period_start es nullable en
-- los instantes y una PK no admite nulos.
create unique index if not exists company_facts_natural on company_facts (
  cik, taxonomy, concept, unit, period_end,
  coalesce(period_start, date '1900-01-01'), accession
);
create index if not exists company_facts_serie on company_facts (cik, familia, period_end desc);
```

### El gancho al Arena: la vista

`ai-guard.js` tiene una doctrina explícita, escrita tras un bug real (el PM
narró unos earnings a dos días como "post-market today"): **la aritmética no
se delega al LLM, se resuelve antes y viaja al prompt ya hecha.** Por eso el
consumidor —Historia o el PM del Arena— no recibe filas crudas: recibe una
vista que ya resolvió la re-expresión, el Q4 derivado y el YoY fiscal.

```sql
create or replace view company_quarterly as
with ultima as (
  select distinct on (cik, familia, period_end)
         cik, familia, period_end, period_start, unit, val,
         accession, filed, form, derived
    from company_facts
   where familia is not null and period_class = 'Q'
   order by cik, familia, period_end, filed desc, accession desc
),
conteo as (
  select cik, familia, period_end,
         count(distinct val)     as versiones,
         count(distinct concept) as tags
    from company_facts
   where familia is not null and period_class = 'Q'
   group by 1, 2, 3
)
select u.*,
       (c.versiones > 1 and c.tags = 1) as revisado,   -- la empresa se corrigió
       (c.versiones > 1 and c.tags > 1) as multi_tag,  -- dos alias, no una corrección
       lag(u.val, 4) over w as val_hace_un_anio,
       case when lag(u.val, 4) over w > 0
            then round(100.0 * (u.val - lag(u.val, 4) over w) / lag(u.val, 4) over w, 1)
       end as yoy_pct
  from ultima u
  join conteo c using (cik, familia, period_end)
window w as (partition by u.cik, u.familia order by u.period_end);
```

`revisado` y `multi_tag` son columnas separadas **porque son fenómenos
distintos** y confundirlos ya costó un número equivocado en esta misma Fase 0
(§11.3). Cada fila sale con su `accession` y su `filed`: el dato y su documento
viajan juntos, siempre.

**El caso de prueba de esta vista es MELI.** Es el único de los cuatro que
ejercita las dos ramas a la vez: re-expresa de verdad en costo (3 periodos),
margen (4) y operativo (3) —familias de **un solo tag**, así que son
correcciones limpias— y además tiene **2 tags** en ingresos por el corte de
ASC 606. Un fixture de MELI prueba que `revisado` se enciende donde la empresa
se corrigió y `multi_tag` donde solo cambió la etiqueta. LULU y MSFT no
sirven para esto: sus familias de un tag tienen 0 revisiones.

**Este PR no toca el Arena.** La vista se crea en la Fase A y queda ahí.

---

## 6. Lo que la sonda no podía contestar

**El próximo earnings (pregunta 7) no está en EDGAR.** EDGAR archiva lo que ya
pasó; no publica calendarios. La fecha sale de `api/earnings.js` (Finnhub), que
ya existe. La sección 7 mezcla dos fuentes y **cada una se etiqueta con la
suya**.

**El short interest real (pregunta 6) sigue detrás de OAuth.** Ya está
documentado en `api/short-interest.js`: FINRA publica *short interest* (Regla
4560, quincenal) tras el Query API con credencial, y *short volume* (Reg SHO,
diario, sin key) que es lo que consumimos. No son lo mismo y la UI no los
confunde. Pedir la credencial es decisión de Fase A, no hallazgo de Fase 0.

**El mapa de competidores (pregunta 5) no existe todavía.** El SIC del emisor
está en `submissions.json` y es grueso (el 5600 de LULU mete media industria
en la misma bolsa). **Recomendación: lista curada a mano de 3–5 pares por
ticker**, misma filosofía que el `MEGA_CAPS` de `api/earnings.js`. Los
privados se declaran no cubiertos.

---

## 7. Estimación: Fase A y Fase B por separado

La corrida **subió** el total de 60–86 h a **71–101 h**. Las dos líneas que lo
movieron son nuevas y las dos salieron de una compuerta:

- **G5** obliga a resolver y guardar el `EX-99.1` (Fase A) y a leerlo en prosa
  (Fase B): +2–3 y +5–7.
- **G6** obliga a dos carriles de ingesta, doméstico y extranjero: +4–6.

En descargo, una línea se borró: **H2 confirmado** (100% de los 8-K traen item
en el índice) saca al full-text search del diseño como infraestructura — queda
como herramienta de diagnóstico, lo cual además conviene, porque dio **HTTP
500 en 1 de 4 llamadas** y p95 de 2.3 s.

### Fase A — datos + `/api/historia/:ticker` + página, SIN IA

| | horas | nota |
|---|---|---|
| Ingesta EDGAR: submissions paginado + company-facts + derivación de Q4 + mapeo de familias | 9–12 | el costo quedó medido: 16 llamadas y 5.4 s por emisor, sin sorpresas |
| Esquema + upserts + goteo reanudable + guard de 10 req/s | 7–9 | +1 por separar `revisado` de `multi_tag` en la carga |
| **Dos carriles por perfil de emisor** (doméstico 10-K/10-Q vs extranjero 20-F/6-K) | 4–6 | **nuevo, por G6** |
| **Resolver y guardar la URL del `EX-99.1`** de cada 8-K 2.02 | 2–3 | **nuevo, por G5** |
| `/api/historia/:ticker` read-only + tests con fetch mockeado | 6–8 | |
| Página: 7 secciones, "sin documentos", etiqueta de cobertura parcial, i18n es/en | 10–14 | la línea más frágil del estimado |
| Tests de ingesta + smoke de fuente | 4–6 | |
| Mapa de pares curado (pregunta 5) | 3–5 | |
| **Total Fase A** | **45–63 h** | |

### Fase B — el lector

| | horas | nota |
|---|---|---|
| Prompt congelado en código + las 7 secciones + "Dónde se rompe la historia" | 8–12 | |
| **Lectura del `EX-99.1`** para la mitad "prometieron": fetch, HTML→texto, recorte, y la regla de citar sin extraer cifras | 5–7 | **nuevo, por G5** |
| **Guard de citas**: toda `[accession]` de la salida existe en el contexto enviado; si no, se corta | 5–7 | **no se recorta** |
| **Guard anti-opinión**: prohibido precio, calificación y recomendación, con tests que lo intenten | 5–7 | |
| Retiro del AI verdict de SMART $ + i18n + tests (§9) | 3–5 | |
| **Total Fase B** | **26–38 h** | |

**Total: 71–101 h.** El guard de citas es la línea que no se negocia: sin él,
"cada afirmación citada" es una promesa de marketing en vez de una propiedad
verificable, y el diferenciador entero del producto descansa ahí.

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
| **Emisor 20-F/6-K** (VIST y los ADR reales) | reporta anual, no trimestral, y sin items de 8-K | *"Cobertura parcial: este emisor presenta 20-F. La serie es anual, no trimestral, y sus avisos (6-K) no vienen clasificados por tipo de evento."* |
| **La guía** | confirmado: no está etiquetada en XBRL | *"La guía no viene estructurada. Enlazamos el 8-K donde la empresa la dio y citamos sus palabras, sin convertirlas en un número nuestro."* |
| Pre-2001 en full-text | EDGAR no indexa antes | *"La búsqueda de texto completo cubre desde 2001."* |
| **Sin contraparte en los filings** | p. ej. MSFT: 0 SC 13D, 0 proxies contestadas en 5 años | *"Sin documentos: nadie presentó un 13D ni una proxy contestada en el período."* |

Y una sección que **no es opcional**, al final de cada historia:

> **Dónde se rompe la historia** — la contraevidencia. Sin ella el módulo es un
> generador de sesgo de confirmación con citas: más peligroso que uno sin
> citas, porque parece riguroso. Si no hay contraevidencia en los documentos,
> se dice *"no encontramos contraevidencia en los filings"*, que es una
> afirmación falsable — no se deja el hueco en blanco ni se rellena.

---

## 9. El retiro del AI verdict de SMART $ — inventario (Fase B)

**Este PR no toca `app.html`.** Esto es el inventario para que la Fase B sea
una edición y no una búsqueda.

| Qué | Dónde | Acción |
|---|---|---|
| Contenedor del veredicto | `app.html` — `<div id="smVerdictWrap">` | quitar |
| Render del veredicto | `app.html` — `renderSmVerdictWrap()` | quitar |
| Llamada a la IA | `app.html` — `smLoadVerdict()` y su invocación en `runSmartMoney()` | quitar |
| Estado y caché | campos `smState.verdict` / `smState.verdictReason`, clave `'smv:'+ticker` | quitar los campos; la caché diaria caduca sola |
| El prompt ("You are a buy-side smart-money analyst… `overall_signal`: STRONG BUY\|…") | dentro de `smLoadVerdict()` | quitar — es literalmente la recomendación que el encargo prohíbe |
| Cabecera "MARKET-WIDE SMART MONEY SIGNALS 🤖 AI Analysis" y `#marketSignalsPanel` | `app.html` | **decisión pendiente** (§10.7): es señal de mercado, no veredicto por ticker |
| Claves i18n `aiSmartVerdict`, `marketWideSignals` | bloques es/en | limpiar las huérfanas |
| **Paneles de números** (Form 4, 13F, short volume, opciones, precio) en `#smGrid` | `app.html` | **NO se tocan** |
| `#earningsVerdictPanel` / `renderEarningsVerdict()` | página **EARNINGS**, no SMART $ | **fuera del alcance del encargo.** Se queda |

Que "AI EARNINGS VERDICT" siga vivo en otra pestaña mientras se retira el de
SMART $ es una inconsistencia visible para el usuario. No se resuelve sola: o
el encargo la extiende, o queda como está y se sabe por qué.

---

## 10. Decisiones a congelar antes de la Fase A

1. **Universo e ingesta.** Con 3.9 MB y 5.4 s por emisor doméstico, una lista
   curada de ~200 tickers son **~780 MB y ~18 min** por refresco completo:
   perfectamente viable como cron nocturno. Propuesta: lista curada
   precalentada por cron + resolución bajo demanda con caché para el resto.
2. **Frescura.** Diario para los tickers cubiertos; 6 h de caché para el resto.
3. **Profundidad.** 5 años en el índice de filings, 3 en la serie trimestral
   (es lo que asume el criterio de G1).
4. **Guía.** ✅ **Congelada**: salida 1 (§3). La Fase A guarda la URL del
   EX-99.1; la Fase B lo lee y cita sin parsear números.
5. **Pares** (pregunta 5): lista curada a mano, 3–5 por ticker (§6).
6. **Short interest**: ¿se pide la credencial de FINRA Query API, o la
   pregunta 6 se queda con short volume y lo dice?
7. **`#marketSignalsPanel`**: se queda o se va (§9).
8. **Formato de la cita.** Propuesta: `[0000320193-25-000073]` visible,
   enlazado al documento primario, con forma y fecha en el hover. Que se vea
   el identificador —y no un "fuente: SEC" genérico— es lo que hace la
   afirmación verificable por el usuario.

---

## 11. Corrida 1 — 2026-09-12, MacBook, IP residencial

63 llamadas HTTP · 21.7 s · 14.46 MB · 16 llamadas y 5.4 s por ticker.

### 11.1 El tablero

| Compuerta | LULU | MSFT | MELI | VIST | Estado |
|---|---|---|---|---|---|
| **G1** trimestres efectivos (núcleo) | 12/12 | 12/12 | 12/12 | n/a (20-F) | 🟢 **VERDE** |
| **G2** 8-K con item en el índice | 100.0% (47) | 100.0% (44) | 100.0% (52) | n/a (0 8-K) | 🟢 **VERDE** |
| **G3** URLs de doc primario | 10/10 | 6/6 | 9/9 | 7/7 | 🟢 **VERDE** |
| **G4** ráfaga 10 concurrentes | 10× HTTP 200 en 524 ms, cero 429 (ver §11.5) | ← | ← | ← | 🟢 |
| **G5** conceptos de guía en XBRL | 0 de 431 | 0 de 565 | 0 de 627 | 0 de 304 | 🔴 **no existe** |
| **G6** perfil | doméstico | doméstico | **doméstico** | 20-F → parcial | — |

**MELI es emisor doméstico.** La corrección que se aceptó antes de correr
queda confirmada por los datos: `anual=10-K · 10-Q=true · 6-K=false ·
20-F=false`. MELI es un 10-K filer con ticker latino y **no** sirve como caso
ADR; VIST sí.

### 11.2 Lo que cada emisor aporta como caso de prueba

**LULU — el caso completo, tal como prometía el encargo.** 1.627 filings desde
2007. En 5 años: **13 × item 5.02** (los 3 CEOs), **20 × 2.02**, **10 × 7.01**,
y la pelea entera — `SC 13D/A:4`, `PREC14A:2`, `DEFC14A:2` y **32 DFAN14A**.
Es el fixture de la pregunta 1 y de la 2.

**MSFT — el caso vacío, que es igual de importante.** `0` SC 13D, `0` proxies
contestadas en 5 años. La sección "quién pelea" tiene que renderizar **"sin
documentos"** y no inventar una narrativa de gobierno corporativo a partir de
5 filings de 5.02 rutinarios. Es el fixture del estado vacío honesto.

**MELI — el caso de las re-expresiones.** Ver §5: es el único que ejercita las
dos ramas de `company_quarterly`. Además tiene 10 trimestres directos en vez
de 9 (un Q4 reportado directo), lo que confirma que la derivación tiene que
ser aditiva y no asumir que siempre faltan.

**VIST — el caso de cobertura parcial.** `20-F:5`, **`6-K:250`**, `8-K:0`,
0 trimestres, 0.57 MB de company-facts bajo `ifrs-full` con solo 2 periodos
anuales, y `costo`, `sgya` y `deuda` ausentes. El dato que más pesa para el
diseño: **250 6-K sin columna `items`** — para un emisor extranjero, las
preguntas 1 y 7 no se pueden clasificar desde el índice.

### 11.3 Un número de la corrida 1 estaba mal, y era mío

La columna `revisiones` mezclaba dos cosas. La clave de conteo era
`start|end|unidad`, **sin el tag** — así que dos alias de la misma familia
cubriendo el mismo periodo se contaban como si la empresa se hubiera
corregido. La huella era inconfundible:

| | tags | Q | revisiones |
|---|---|---|---|
| LULU inventario | 2 | 12 | 12 |
| MSFT deuda | 2 | 12 | 12 |
| MELI ingresos | 2 | 10 | **19** |
| MELI costo / margen / op | **1** | 10 | 3 / 4 / 3 |

Toda familia con `revisiones == trimestres` tenía `tags=2`; toda familia con
`tags=1` daba un conteo chico y plausible. El "19" de MELI en ingresos es, en
su mayor parte, ese artefacto.

**Corregido** (`analizarFamilia`): ahora son dos contadores separados.
`revisiones` = el mismo tag reporta el mismo periodo con otro valor (la
empresa se corrigió). `desacuerdoAlias` = dos tags distintos difieren (el corte
de taxonomía). El test nuevo planta cada caso por separado.

**Lo que sigue siendo válido de la corrida 1:** las familias de **un solo
tag** nunca estuvieron afectadas por el bug. Las re-expresiones limpias de
MELI —costo 3, margen 4, operativo 3— son reales y bastan para hacer de MELI
el fixture de la vista. **Lo que falta medir:** el conteo corregido de las
familias multi-tag. Sale en la próxima corrida; no se usa ningún número viejo
en su lugar.

### 11.4 Los dos huecos que la corrida dejó (ninguno toca una compuerta)

**`caja` dio 0 tags en LULU.** No usa
`CashAndCashEquivalentsAtCarryingValue`. La hipótesis es que etiqueta bajo el
tag de ASU 2016-18 (efectivo + efectivo restringido), normal en retail. Se
agregó como alias; **la próxima corrida lo confirma o lo desmiente**. No está
en el núcleo de G1, así que no movía la compuerta.

**`deuda` ausente en LULU.** Probablemente un **verdadero negativo**: LULU no
tiene deuda de largo plazo. Si tras agregar el alias de caja la deuda sigue
ausente, queda confirmado, y la sección lo dice como un hecho
(*"no reporta deuda de largo plazo"*), no como un hueco de datos. Los dos casos
se ven distintos en la UI y no deben confundirse.

**Y un tercero, de fuente:** el full-text search dio **HTTP 500 en LULU** (1 de
4 llamadas) con p95 de 2.3 s. Como G2 salió 100%, FTS no es infraestructura y
esto no bloquea nada — pero confirma que no conviene apoyarse en él.

### 11.5 Latencia (G4)

| endpoint | n | p50 | p95 | max | bytes prom | no-200 |
|---|---|---|---|---|---|---|
| head-doc | 32 | 323 ms | 451 ms | 1311 ms | — | 0 |
| filing-index | 15 | 109 ms | 313 ms | 313 ms | 2.594 | 0 |
| submissions | 4 | 256 ms | 549 ms | 549 ms | 138.495 | 0 |
| companyfacts | 4 | 354 ms | 506 ms | 506 ms | **3.077.984** | 0 |
| fts | 4 | 756 ms | 2305 ms | 2305 ms | 27.882 | **1** |
| submissions-old | 3 | 134 ms | 207 ms | 207 ms | 214.919 | 0 |
| ticker-map | 1 | 877 ms | — | — | 797.931 | 0 |

Ráfaga de 10 concurrentes: **10× HTTP 200 en 524 ms, cero 429.** El techo de
10 req/s de la SEC tiene aire; la sonda corre a 8 por prudencia y así se queda.

---

## 12. Fuentes

- SEC, *Webmaster FAQ / Developer resources* — User-Agent y techo de 10 req/s:
  https://www.sec.gov/os/webmaster-faq#developers
- SEC, *EDGAR Application Programming Interfaces*:
  https://www.sec.gov/edgar/sec-api-documentation
- SEC, *Full-Text Search* (desde 2001): https://efts.sec.gov/LATEST/search-index
- SEC, *Form 8-K — items*: https://www.sec.gov/fast-answers/answersform8khtm.html
- FASB ASC 606 (corte de taxonomía en ingresos) y ASU 2016-18 (efectivo
  restringido).
- Precedentes en este repo: `docs/congreso-fase0.md` (disciplina de compuertas
  con criterio previo, y la lección del medidor sin probar),
  `api/_lib/pead-db.js` (esquema sobre Neon), `api/short-interest.js` (short
  interest vs short volume), `api/_lib/ai-guard.js` (la aritmética se resuelve
  antes del prompt, no dentro).
