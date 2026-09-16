# FASE 1b — Censo de fuentes para el histórico 2016→2026

> **Estado: el inspector está listo; la Parte A no está corrida.**
>
> Mi sandbox no llega a `bmv.com.mx` (mismo caso que en Fase 0, 0b y 1a), así
> que el censo se hace como endpoint y lo corres desde prod. **Un solo request
> contesta las cuatro preguntas de la Parte A** (§2).
>
> ```
> https://<tu-dominio>/api/bmv-inspect?claves=WALMEX,FEMSA,GMEXICO,ALSEA,GCC
> ```
>
> ~12 segundos, 10 requests a 1/seg, no baja documentos ni escribe nada.
>
> **Este documento no puede cerrar la matriz de cobertura todavía** (§4) y lo
> digo de frente: la matriz depende de una respuesta que sólo da esa corrida.
> Lo que sí está: el árbol de decisión con lo que implica cada resultado
> posible, el conteo y costo bajo cada escenario, y el censo de sitios de IR
> hasta donde llegué sin abrir páginas.

---

## 1. Lo que ya sabemos, sin correr nada

De Fase 0 y 1a, verificado:

| Hecho | De dónde |
|---|---|
| BMV publica gratis **sólo el trimestre vigente** bajo `docs-pub/ifrsxbrl/` | `docs/xbrl-fase0.md` §1.1, §3.2 |
| El histórico XBRL **lo vende** BMV (pubsys2) | `docs/xbrl-fase0.md` §1.2 |
| CNBV tiene histórico público pero su `robots.txt` prohíbe automatizar | `docs/xbrl-fase0.md` §1.3, §8.1 |
| El XBRL empieza en **1T2014**, universal desde **1T2016** | `docs/xbrl-fase0.md` §3.1 |
| **29 emisoras ICS con 2T2026 en Neon**, 9/9 campos y fecha | `docs/xbrl-capture.md` §5 |
| Un PDF en **formato BMV** da los 9 campos a ~$0.02 | `docs/pdf-fase0b.md` |
| Un **comunicado** de prensa da 6/9 (sin deuda ni acciones en WALMEX) | `docs/pdf-fase0b.md` §5.2 |
| Evento relevante de WALMEX `1576009` y su XBRL `1576010`: **contiguos** | `docs/xbrl-fase0.md` §2.5 |

**La apuesta de esta fase** es que los **eventos relevantes** son la veta: ahí
viven los comunicados trimestrales, la página es del mismo dominio que ya
sabemos leer, y —a diferencia de `docs-pub/ifrsxbrl/`— **no hay razón para que
BMV borre un evento relevante viejo**, porque es un archivo regulatorio, no un
"último reporte disponible". Si eso se confirma, el histórico sale de BMV y no
de 29 sitios de IR distintos.

**Es una apuesta, no un hecho.** La Parte A la confirma o la tumba.

---

## 2. Parte A — lo que contesta la corrida del inspector

`/api/bmv-inspect` pide dos páginas por emisora y devuelve, para cada una:

### 2.1 Primero describe, después interpreta

Cada página trae un bloque `estructura` que dice **lo que hay, sin interpretarlo**:
encabezados, tipos de documento encontrados con ejemplos de nombre, conteo de
filas, años mencionados, y si el listado viene en el HTML o lo pinta JavaScript.

Esto es a propósito. Mis parsers están escritos **a ciegas**, contra una
descripción de las páginas y no contra su HTML. Pueden estar mal. Si
`resultados_trimestrales.n` sale 0 pero `estructura.docs_pub_por_tipo` muestra
80 enlaces bajo `eventemi/`, el problema es mi clasificador y se arregla mirando
los ejemplos — **sin pedirte otra corrida**.

Ya pasó una vez, en los tests: mi primer regex buscaba `docs-pub/<tipo>/` y el
link del XBRL en realidad es `visorXbrl.html?docins=../ifrsxbrl/…`, que **no
contiene `docs-pub`**. Habría dejado ciego al inspector justo en la sección que
esta fase existe para mirar. Lo cazó un test; ahora reconoce las dos formas.

### 2.2 Las cuatro preguntas

| # | Pregunta | Dónde sale en el JSON |
|---|---|---|
| A.1 | ¿La sección de estados financieros lista sólo el vigente o hay histórico? | `informacion_financiera.xbrl_trimestral.veredicto` |
| A.2 | ¿Qué cubren los reportes anuales y de qué tipo son? | `informacion_financiera.por_tipo` (anexon / infoanua / cmpcxbrl / lo que haya) |
| A.3 | ¿Hasta qué año llegan los comunicados en eventos relevantes? | `eventos_relevantes.resultados_trimestrales` (n, año mín/máx, periodos) |
| A.4 | ¿Los ids de docs-pub son contiguos? | `ids` |

**A.1 es la pregunta que decide todo.** Si alguna emisora lista más de un
trimestre, el supuesto central de Fase 0 —"sólo el vigente"— era incompleto y
buena parte del histórico sale gratis de donde ya sabemos leer.

### 2.3 Sobre A.4, y lo que NO significa

El inspector mide si los ids quedan cerca y reporta los pares con delta ≤ 5.
**Y siempre acompaña el resultado con esta advertencia, aunque salgan muchos
pares contiguos:**

> Que dos ids sean contiguos **no hace que `id−1` sea una URL válida**. El
> contador de `docs-pub` es **global de toda la BMV**: entre dos documentos de
> una misma emisora hay cientos de otras empresas. Un id vecino pertenece casi
> seguro a otra emisora, o a nada.

Sirve para **entender** cómo se asignan los ids —un envío genera varios
documentos seguidos—, no para enumerar hacia atrás. Enumerar sería además
justamente el tipo de barrido que la cortesía de 1 req/s existe para evitar:
adivinar 1,400 ids significa miles de 404 contra BMV. **No es el plan.**

---

## 3. Parte B — sitios de relación con inversionistas

**Todo `[NO VERIFICADO]`**: sale de resultados de búsqueda, sin abrir una sola
página. Y está incompleto a propósito — la Parte B es *"sólo para lo que A no
cubra"*, y hasta correr A no se sabe qué falta.

| Emisora | Sección de reportes | ¿formato BMV? | ¿comunicado? | Desde | Patrón de URL | Estado |
|---|---|---|---|---|---|---|
| AMX | `americamovil.com/Spanish/relacion-con-inversionistas/informes-financieros/reportes-trimestrales/` | **sí** — hay página aparte *"Presentaciones ante la BMV"* (`/bmv-filings/`) | sí | no determinado | no visto | [NO VERIFICADO] |
| WALMEX | `walmex.mx/informacion-financiera/trimestral.html` | no visto | sí | ≥2016 | `informes.walmex.mx/{AÑO}/docs/…` — **el año va en la ruta** | [NO VERIFICADO] |
| FEMSA | `femsa.gcs-web.com/financial-reports/quarterly-results` | no visto | sí | no determinado | plataforma de IR (gcs-web) | [NO VERIFICADO] |
| GMEXICO | `gmexico.com/Pages/reportes-financieros.aspx` | **sí** | sí | **≥2017** | `gmexico.com/GMDocs/ReportesFinancieros/Esp/{AÑO}/RF_ES_{AÑO}_BMV.pdf` | [NO VERIFICADO] |
| CEMEX | `cemex.com/investors/reports/bmv-reports` | **sí** — página dedicada | sí | no determinado | no visto | [NO VERIFICADO] |
| BIMBO | `grupobimbo.com/en/investors/reports` | no visto | sí | ≥2022 visto | S3/CloudFront con `?VersionId=` | [NO VERIFICADO] |
| ALFA | — | no visto | sí | ≥2021 visto | PDFs alojados en **latibex.com** y **sigmafoods.com**, no en alfa.com.mx | [NO VERIFICADO] |
| GRUMA | `gruma.com/en/investors/…/quarterly-releases.aspx` | no visto | sí | no determinado | `gruma.com/media/{ID}/…pdf` — **id opaco** | [NO VERIFICADO] |
| las otras 21 | — | — | — | — | — | sin censar |

**Lo útil que ya se ve:**

- **El formato BMV sí se republica en sitios de IR**: AMX y CEMEX tienen página
  dedicada, GMEXICO publica `RF_ES_{AÑO}_BMV.pdf` con el año en la ruta. Eso es
  9/9 campos, no 6/9.
- **Sólo GMEXICO y WALMEX tienen patrón de URL construible.** Los demás usan ids
  opacos (`gruma.com/media/724638/`), query strings de versión (BIMBO) o
  plataformas de IR. **No se enumeran: hay que listar la página.**
- **ALFA aloja en terceros.** Un cosechador que asuma "todo vive en el dominio
  de la emisora" se queda corto.

---

## 4. La matriz de cobertura

**No la puedo cerrar sin la Parte A**, y rellenarla con suposiciones sería
exactamente lo que estas fases existen para no hacer. Lo que sí está es la
estructura y las celdas que ya se conocen:

| Fuente | Qué da | Celdas que cubre hoy |
|---|---|---|
| `BMV-XBRL` | 9/9 campos | **29** — sólo 2026-T2, ya en Neon |
| `BMV-evento` | 6/9 (comunicado) o 9/9 (si el evento adjunta el formato BMV) | **? — lo dice A.3** |
| `IR-formatoBMV` | 9/9 | ? — AMX, CEMEX, GMEXICO al menos |
| `IR-comunicado` | 6/9 | ? |
| `ninguna` | — | ? |

El universo es **29 emisoras × 11 años (2016-2026) × 4 trimestres = 1,276
celdas**, de las cuales **29 están llenas (2.3%)**.

### 4.1 Los tres escenarios, y qué cambia cada uno

| Si A.3 dice… | Entonces |
|---|---|
| **Los eventos llegan a ~2016** | El histórico sale **casi todo de BMV**. La Parte B queda para tapar huecos. ~1,250 PDFs, un solo dominio, un solo scraper. **Es el mejor caso y es plausible**: un evento relevante es archivo regulatorio, no "el último disponible". |
| **Llegan a ~2020-2021** | Mitad y mitad: ~600 celdas de BMV y ~650 repartidas entre 29 sitios de IR. El costo real se va al **descubrimiento**, no a la extracción. |
| **Sólo unos meses hacia atrás** | BMV no sirve para histórico. Todo son sitios de IR, con 29 patrones distintos y varios sin patrón. Ahí hay que **reconsiderar comprar el histórico a BMV** (D1 de Fase 0) contra semanas de trabajo manual. |

### 4.2 Costo de extracción

A ~$0.02 por PDF con `pdf-extract.mjs` (medido en Fase 0b: $0.0193 promedio,
$0.0224 peor caso):

| Escenario | PDFs | Costo |
|---|---|---|
| Todo el histórico alcanzable | ~1,250 | **~$25 USD** |
| Mitad | ~600 | ~$12 |
| Sólo 2022→2026 | ~550 | ~$11 |

**El costo de la API no es el problema en ningún escenario.** Lo dije en Fase 0b
y sigue siendo cierto: el cuello de botella es **descubrir las URLs**. Veinticinco
dólares no compran las semanas de navegador que costaría un escenario 3.

---

## 5. Recomendación: por dónde empezar

**1. Correr el inspector.** Doce segundos y contesta si hay un escenario 1.

**2. Si A.3 confirma eventos hacia atrás, empezar por ahí y por los años
recientes.** No por 2016. Razones:

- Los años recientes son los que más pesan en un backtest de rotación: más
  emisoras vivas, mejor calidad de datos, régimen más parecido al actual.
- Un cosechador probado sobre 2024-2026 —donde se puede **cruzar contra el XBRL
  que ya está en Neon**— se valida solo. Ese cruce es verdad independiente
  gratis, y es exactamente lo que Fase 0b dejó como pendiente para auditar la
  extracción a escala.
- Si algo está mal, se descubre con 100 documentos, no con 1,250.

**3. Dejar 2016-2018 para el final.** Es la parte con más riesgo de formato
distinto y menos valor marginal, y es donde más probable es tener que comprar.

**4. No enumerar ids.** Ni hacia atrás ni hacia adelante (§2.3).

---

## 6. Lo que necesita navegador, no script

Esto no lo puede hacer un cosechador y conviene saberlo antes de intentarlo:

1. **Sitios que pintan la lista con JavaScript.** El inspector marca
   `tiene_listado_en_html: false`. Si la página muestra reportes en el navegador
   pero el HTML viene vacío, es trabajo manual o de navegador automatizado.
   BIMBO (S3 con `?VersionId=`) y las plataformas de IR tipo gcs-web son las
   candidatas.
2. **Sitios con id opaco.** GRUMA (`/media/724638/`) y similares: el id no se
   deriva de nada, hay que leer la página que los lista.
3. **El id de LASITE**, que sigue pendiente de Fase 1a. Una visita.
4. **Completar la Parte B para las 21 emisoras sin censar**, si A no las cubre.

---

## 7. Cómo correr

```bash
# Las 5 de la Parte A
curl -s 'https://<tu-dominio>/api/bmv-inspect?claves=WALMEX,FEMSA,GMEXICO,ALSEA,GCC' | jq

# Ayuda y lista de claves disponibles
curl -s 'https://<tu-dominio>/api/bmv-inspect' | jq
```

**Qué mirar primero, en este orden:**

1. `informacion_financiera.xbrl_trimestral.veredicto` — **la pregunta que decide todo.**
2. `eventos_relevantes.resultados_trimestrales.anio_min` — hasta dónde llega la veta.
3. `eventos_relevantes.otros_muestra` — si ahí hay comunicados de resultados que
   mi clasificador descartó, el clasificador está mal y se arregla mirando esos títulos.
4. `estructura.docs_pub_por_tipo` de ambas páginas — qué tipos existen de verdad.
5. `ids.conclusion` — y leer la advertencia completa.

Si algún parser falla, `estructura` alcanza para arreglarlo sin otra corrida.

### Tests

```bash
node tests/bmv-inspect.test.mjs        # 16 tests de los parsers del censo
node tests/xbrl-parse.test.mjs         # 18
node tests/xbrl-capture-fila.test.mjs  # 27
```

---

PR listo — no more pushes.
