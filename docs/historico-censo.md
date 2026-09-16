# FASE 1b — Censo de fuentes para el histórico 2016→2026

> **1ª corrida hecha. Hay histórico en BMV, con un tope que todavía no sé si es
> el techo real.**
>
> | Lo que contestó | |
> |---|---|
> | **A.1** ¿sólo el trimestre vigente? | **Sí, 5 de 5.** El supuesto de Fase 0 queda confirmado |
> | **A.3** ¿hay histórico en eventos relevantes? | **Sí** — WALMEX y ALSEA llegan a **2021**, no sólo a 2026 |
> | El tope | ~80-84 filas por página. **Si se rodea, el histórico podría llegar a 2016** |
>
> **Tres preguntas abiertas, y una sola corrida las cierra** (§8):
>
> ```
> https://<tu-dominio>/api/bmv-inspect?profundo=FEMSA
> ```
>
> **El JSON de la 1ª corrida no llegó** — la carpeta de adjuntos sigue con los
> PDFs de turnos anteriores. Tu resumen alcanzó para lo que sigue, pero **los 84
> títulos de FEMSA no los tengo**, y sin verlos no puedo arreglar el
> clasificador: tendría que adivinar el patrón, que es justo lo que no se hace
> acá. Por eso el modo `?profundo=` devuelve **la lista completa de títulos sin
> filtrar** (§8.1).

---

## 0. Una deducción que sale de tus números

El tope aparente (~80-84) separa las 5 emisoras en dos grupos, y eso cambia cómo
se lee cada resultado:

| Emisora | docs | trimestrales | ¿al tope? | Qué significa su resultado |
|---|---:|---:|---|---|
| FEMSA | 84 | **1** | **sí, truncada** | dos problemas superpuestos: falta histórico **y** el clasificador falla |
| ALSEA | 82 | — | **sí, truncada** | llega a 2021 porque ahí se corta, no porque ahí empiece |
| WALMEX | 80 | 28 | **sí, truncada** | idem |
| GMEXICO | 26 | 0 | **no** | **listado completo** — sus 0 trimestrales no son por filas faltantes |
| GCC | 28 | 0 | **no** | **listado completo** — idem |

Dos consecuencias:

1. **"2021-2026" no es el alcance del archivo de BMV, es el alcance de una
   página.** WALMEX y ALSEA se cortan exactamente donde se acaban las filas. El
   archivo real puede llegar mucho más atrás — **por eso la pregunta de la
   paginación es la que decide todo.**
2. **GMEXICO y GCC no están truncadas**, así que su cero es información: o no
   publican su trimestral como evento relevante, o mi clasificador no reconoce
   su título. No es que falten filas. Se distingue mirando sus títulos — que es
   lo que `?profundo=` devuelve.

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

## 4. La matriz de cobertura, con lo que ya se sabe

Universo: **29 emisoras × 11 años (2016-2026) × 4 trimestres = 1,276 celdas.**

### 4.1 Lo confirmado

| Franja | Fuente | Celdas | Estado |
|---|---|---:|---|
| 2026-T2 | `BMV-XBRL` (9/9 campos) | **29** | **en Neon**, Fase 1a |
| 2021→2026 | `BMV-evento` (6/9, o 9/9 si el evento adjunta formato BMV) | **≈ 22 por emisora que publique así** | confirmado en WALMEX y ALSEA |
| pre-2021 | ? | ~580 | **depende de la paginación** |
| GMEXICO, GCC y similares | no por evento | — | necesitan sitio de IR |

### 4.2 Por emisora, hasta donde llega la evidencia

| Emisora | 2016-2020 | 2021-2026 | 2026-T2 | Fuente y estado |
|---|---|---|---|---|
| WALMEX | ? paginación | `BMV-evento` ✔ | `BMV-XBRL` ✔ | 28 trimestrales detectados |
| ALSEA | ? paginación | `BMV-evento` ✔ | `BMV-XBRL` ✔ | 82 docs, mismo rango |
| FEMSA | ? paginación | `BMV-evento` ? | `BMV-XBRL` ✔ | **clasificador falla** — §8.1 |
| GMEXICO | `IR-formatoBMV` probable | `IR-formatoBMV` probable | `BMV-XBRL` ✔ | listado completo sin trimestrales; IR publica `RF_ES_{AÑO}_BMV.pdf` |
| GCC | ? | ? | `BMV-XBRL` ✔ | listado completo sin trimestrales; IR sin censar |
| otras 24 | ? | ? | `BMV-XBRL` ✔ | sin inspeccionar |

**No relleno el resto.** Con 5 de 29 inspeccionadas y la pregunta de la
paginación abierta, cualquier número por emisora sería inventado.

### 4.3 Los dos escenarios que quedan

| Si la paginación… | Celdas alcanzables desde BMV | Lo que queda para sitios de IR |
|---|---:|---|
| **funciona** (o hay consulta por rango de fechas) | hasta ~1,100 | los huecos de emisoras que no publican por evento |
| **no funciona** — el tope es el techo | ~500 (2021→2026) | **~750 celdas en 29 sitios distintos** |

La diferencia entre los dos es **~600 celdas y semanas de trabajo**, y se
resuelve con un request. Por eso §8.2 es la pregunta prioritaria.

### 4.4 Costo de extracción

A $0.02 por PDF (medido en Fase 0b: $0.0193 promedio, $0.0224 peor caso):

| Escenario | PDFs | Costo |
|---|---:|---:|
| Paginación funciona | ~1,100 | **~$22** |
| Sólo 2021→2026 | ~500 | ~$10 |

**Y si la pregunta del zip (§8.3) sale bien, el costo tiende a cero** en las
celdas que tengan XBRL: datos estructurados no pasan por el modelo.

El costo de API sigue sin ser el problema en ningún escenario. Lo caro es
descubrir URLs y, si el tope es el techo, 29 sitios de IR.

## 5. Recomendación

**1. Correr `?profundo=FEMSA` antes de cualquier otra cosa** (§8). Cierra las
tres preguntas y define si el plan es "un scraper contra BMV" o "29 scrapers
contra sitios de IR". No tiene sentido diseñar el cosechador antes de eso.

**2. Empezar la cosecha por 2024-2026, no por 2016.** Se sostiene y ahora con un
argumento más fuerte: ahí se puede **cruzar contra el XBRL que ya está en Neon**.
Esa es verdad independiente gratis, y es exactamente lo que Fase 0b dejó
pendiente para auditar la extracción a escala. Si el cosechador tiene un sesgo,
se ve con 100 documentos en vez de con 1,100.

**3. Para GMEXICO y similares, ir directo al sitio de IR.** Su listado de eventos
está completo y no trae trimestrales (§0): esperar a resolver la paginación no
les va a servir de nada. GMEXICO además publica `RF_ES_{AÑO}_BMV.pdf` con el año
en la ruta, que es el caso más fácil que existe — **formato BMV, 9/9 campos, URL
construible**.

**4. No enumerar ids** (§2.3). La contigüidad observada no cambia eso.

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
# Censo de más emisoras (el de la 1ª corrida, para las 24 que faltan)
curl -s 'https://<tu-dominio>/api/bmv-inspect?claves=AMX,KOF,CEMEX,BIMBO,ORBIA' | jq

# Modo profundo: UNA emisora, las tres preguntas abiertas
curl -s 'https://<tu-dominio>/api/bmv-inspect?profundo=FEMSA' | jq
```

### Tests

```bash
node tests/bmv-inspect.test.mjs        # 22 tests de los parsers del censo
node tests/xbrl-parse.test.mjs         # 18
node tests/xbrl-capture-fila.test.mjs  # 27
```

---

## 8. Las tres preguntas abiertas, y la corrida que las cierra

```
https://<tu-dominio>/api/bmv-inspect?profundo=FEMSA
```

Una emisora, ~6 requests, ~8 segundos. Sólo lee.

### 8.1 ¿Por qué FEMSA salió con 1 de 84? — `titulos`

Devuelve **los 84 títulos completos, sin filtrar**, cada uno con cómo lo
clasificó mi código. Con eso el patrón real se ve de un vistazo.

**Lo que no voy a hacer es adivinarlo.** Sé que el PDF de FEMSA se titula
*"FEMSA Anuncia Resultados del Segundo Trimestre de 2020"* —lo tengo de Fase
0b— y mi clasificador **sí** reconoce esa forma; hay test. Que aun así saliera 1
de 84 significa que **el título del evento en el listado de BMV no es el título
del PDF**. Puede ser un asunto genérico, puede estar en inglés, puede ser
"Información Financiera Trimestral". Cualquiera de las tres cambia el arreglo, y
elegir sin ver los títulos sería exactamente el error que esta fase evita.

**Si resulta que FEMSA no publica su trimestral como evento relevante**, eso
también es una respuesta y va al doc como tal: FEMSA pasa a depender de su sitio
de IR (`femsa.gcs-web.com`), como GMEXICO.

### 8.2 ¿El tope de ~80 filas es el techo? — `paginacion`

**Es la pregunta más importante que queda**: son ~600 celdas de diferencia (§4.3).

La sonda **busca el mecanismo en la página** en vez de adivinar parámetros, y
reporta enlaces de paginación, campos de formulario y pistas de texto. Si
encuentra un enlace, **lo sigue una vez** y compara: si trae documentos que no
estaban, la paginación funciona y el tope no es el techo.

Busca en particular campos `fechaInicial` / `fechaFinal`. BMV los usa en su
sección de Información Digitalizada:

```
/_mod/CHANGE_PAGE?claveCotiza=X&fechaInicial=&fechaFinal=&tipoDocumento=&index=9
```

**Si la página de eventos acepta rango de fechas, el tope deja de importar**: se
pide 2016-2018 directo y no hay que paginar nada. Sería el mejor resultado
posible de esta fase.

### 8.3 ¿El zip de eventemi trae XBRL de verdad? — `zip_eventemi`

Notaste que los eventemi aparecen como `.pdf` **y** como
`visorXbrl.html?docins=../eventemi/eventemi_XXXX_1.zip`. La sonda baja hasta 3 de
esos zips y mira qué son: revisa los bytes mágicos (¿ZIP o PDF disfrazado?) y, si
es zip de verdad, **lista lo que trae adentro** y busca `.json` / `.xbrl` / `.xml`.

Los dos desenlaces:

| Si adentro hay datos estructurados | Si el visor sólo envuelve el PDF |
|---|---|
| **Cambia todo el plan.** 9/9 campos sin PDF, sin modelo, con el parser de Fase 1a que ya existe. Costo de API **cero** en esas celdas, y sin el riesgo de transcripción de Fase 0b | Seguimos con `pdf-extract` a $0.02, que ya está probado y da GO |

Vale la pena aclarar por qué esto es plausible y no ilusión: el visor se llama
`visorXbrl.html` y el parámetro es `docins` — *documento instancia*, que es
justo el término XBRL. Que BMV use ese visor para un evento relevante sugiere que
espera encontrar un instance adentro. **Pero podría ser sólo que reutilizan el
mismo visor para todo**, y eso es exactamente lo que la sonda distingue.

---

PR listo — no more pushes.
