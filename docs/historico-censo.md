# FASE 1b — Censo de fuentes para el histórico 2016→2026

> # El plan cambia: apareció DataBursatil
>
> `databursatil.com` expone `/v2/financieros` con **estados financieros
> trimestrales completos de 2T2016 a 2T2026** —posición, flujos, resultado del
> trimestre y acumulado, ~60 campos con tags `ifrs-full`—, precios diarios desde
> 2010, dividendos, y **emisoras deslistadas** (ELEKTRA aparece como `SUSPENDIDA`
> con financieros hasta 4T2025). API gratuita, self-serve con token.
> **Verificado por Lety con token propio.**
>
> **Cosechar ~1,400 PDFs ya no se justifica.** Lo que costaba semanas de
> descubrir URLs, ~$22 de extracción y un riesgo de transcripción que Fase 0b
> documentó a fondo, ahora son requests a una API.
>
> **Pero DataBursatil no lo resuelve todo, y lo que falta no es un detalle: es
> la parte que decide si el backtest es válido.** Tres huecos (§2), y el primero
> es el que importa.
>
> | Lo que aporta DataBursatil | Lo que sigue siendo nuestro |
> |---|---|
> | El núcleo `ifrs-full`: ~60 campos, 2016→2026, 40 trimestres | **La fecha real de publicación** (§2.1) |
> | Precios diarios desde 2010, dividendos | **Acciones en circulación** (§2.2) |
> | Deslistadas con su histórico | **El desglose de deuda con costo `ifrs_mx`** (§2.3) |
>
> Dicho de otra forma: **DataBursatil da el núcleo IFRS; lo nuestro es la
> extensión mexicana y el reloj.**

---

## 1. Qué aporta DataBursatil

**[VERIFICADO por el usuario con token propio]**

| | |
|---|---|
| Endpoint | `/v2/financieros` |
| Cobertura | **2T2016 → 2T2026** (40 trimestres) |
| Contenido | posición financiera, flujos, resultado del trimestre **y** acumulado |
| Campos | ~60, con tags `ifrs-full` |
| Extras | precios diarios desde 2010, dividendos |
| Deslistadas | sí — ELEKTRA con estatus `SUSPENDIDA` y financieros hasta 4T2025 |
| Acceso | gratuito, self-serve con token |

Que traiga **deslistadas** merece un párrafo aparte, porque resuelve algo que
Fase 0 dejó marcado como amenaza seria: el **survivorship bias**. El universo
point-in-time que congelamos (emisoras ICS que reportan en cada fecha) sólo
funciona si el histórico incluye a las que se murieron en el camino. ELEKTRA con
sus financieros hasta 4T2025 es exactamente ese caso, y con la captura manual
habría sido el más difícil de conseguir — su página deja de listar y sus
documentos se archivan.

**Operativo [SECUNDARIO, de su documentación]:** funciona con **créditos** que se
reponen solos el **día 1 de cada mes a las 00:01 CDMX**, y el token se renueva
como máximo una vez por semana. Es un proyecto sin fines de lucro sostenido por
colaboración de usuarios. Conviene planear la cosecha dentro de un presupuesto de
créditos —29 emisoras × 40 trimestres no es gratis en requests— y no martillar.

---

## 2. Los tres huecos

### 2.1 La fecha de publicación — el que decide si el backtest sirve

DataBursatil **indexa por periodo de cierre**, no por fecha de publicación.
Usarlo tal cual significa tratar el 2T2026 como disponible el **30 de junio**,
cuando en realidad se publicó semanas después.

**Cuánto es "semanas", con nuestros propios datos de Fase 1a:**

| Emisora | Cierre | Publicado | Lag |
|---|---|---|---:|
| WALMEX | 2026-06-30 | 2026-07-23 | **23 días** |
| PE&OLES | 2026-06-30 | 2026-07-23 | **23 días** |
| MEGA | 2026-06-30 | 2026-08-28 | **59 días** |

**De 23 a 59 días, en un solo trimestre.** Un periodo de tenencia trimestral son
~63 días hábiles: ese error es **37% a 94% del periodo de tenencia**. No es un
sesgo pequeño; es del tamaño de la señal que el backtest pretende medir.

**Y el atajo obvio no funciona.** Si se aplicara un lag fijo de 45 días:

| Emisora | Efecto del lag fijo |
|---|---|
| WALMEX, PE&OLES | **22 días tarde** — se descarta información que ya era pública y negociable |
| MEGA | **14 días temprano** — sigue habiendo look-ahead |

Un lag constante **no corrige el sesgo, lo reparte**: introduce un error en una
dirección para unas emisoras y lo deja en la otra para el resto. Y el reparto no
es aleatorio — las emisoras que reportan tarde son sistemáticamente distintas de
las que reportan pronto, así que el error se correlaciona con características de
la empresa. Eso es peor que un sesgo uniforme: es uno que el backtest puede
confundir con alfa.

> **La única corrección correcta es la fecha real por emisora y por trimestre.**
> Eso es exactamente lo que el capturador de Fase 1a produce, y lo que ninguna
> fuente agregada tiene — porque no está en el XBRL: vive sólo en el listado de
> BMV (decisión D8, `docs/xbrl-fase0.md` §2.5).

**El hueco que queda, dicho con honestidad:** el capturador produce fechas **de
aquí en adelante**. Para 2016→2026 no las tenemos. Eso convierte el trabajo del
inspector (#161) en algo más específico y más fácil de lo que era — §3.2.

### 2.2 Acciones en circulación

`NumeroDeAccionesEnCirculacion` es un tag de la **extensión mexicana**
(`ifrs_mx`), no de `ifrs-full`. Si DataBursatil sólo trae `ifrs-full`, no lo
tiene.

Importa porque es un insumo directo del screen: **capitalización = precio ×
acciones**, y sin capitalización no hay book-to-market ni filtro de tamaño — dos
piezas centrales de un value+momentum. Que DataBursatil traiga precios diarios
desde 2010 no alcanza por sí solo: falta el otro factor del producto.

**Antes de construir nada conviene verificar si publican capitalización ya
calculada o el número de acciones bajo otro nombre.** No lo doy por ausente sin
mirarlo; lo doy por **no confirmado**.

### 2.3 El desglose de deuda con costo

Fase 0 estableció que **IFRS no tiene un elemento único para "deuda con costo"**
y que la extensión mexicana sí resuelve la distinción:

```
CreditosBancariosA{Corto,Largo}Plazo     ← con costo
CreditosBursatilesA{Corto,Largo}Plazo    ← con costo
OtrosCreditosConCostoA{Corto,Largo}Plazo ← con costo
OtrosCreditosSinCostoA{Corto,Largo}Plazo ← EXCLUIDO a propósito
Current/NoncurrentLeaseLiabilities        ← IFRS-16, aparte (D3 sigue abierta)
```

Si DataBursatil sólo trae el agregado `ifrs-full`, **no se puede reproducir esa
definición** — y es la que quedó congelada en Fase 0 §5.5 como la de la serie.

El caso WALMEX lo hace concreto: reporta los seis componentes **explícitamente en
cero** y su único pasivo con costo son arrendamientos por 83 mil millones. Con un
agregado `ifrs-full` no se distingue "cero deuda financiera" de "deuda incluida
en otro renglón", y esa diferencia cambia por completo el apalancamiento de la
emisora.

---

## 3. Qué se queda vivo, y por qué

Nada se borra. Pero el **propósito** de dos de las tres piezas cambió, y vale la
pena decirlo explícito para que nadie las lea con el rol viejo.

### 3.1 El capturador de Fase 1a — sube de categoría

`api/xbrl-capture.js` + el cron semanal **se quedan, y pasan a ser la pieza
crítica**, no la fuente principal de datos.

Su trabajo ya no es "conseguir los financieros" —eso lo hace DataBursatil mejor y
hacia atrás— sino **producir la fecha real de publicación**, que es lo único que
hace válido el backtest (§2.1). Además sigue guardando el `raw_json` completo,
con el desglose `ifrs_mx` que DataBursatil no tiene (§2.3) y las acciones en
circulación (§2.2).

O sea que el capturador aporta, por trimestre y hacia adelante, **las tres cosas
que faltan**. Apagarlo sería quedarse con el 90% que cualquiera puede bajar y
perder justo el 10% que distingue este trabajo.

### 3.2 El inspector de #161 — mismo código, pregunta nueva

`api/bmv-inspect.js` se queda como herramienta, pero **lo que le vamos a
preguntar cambió**, y para bien:

| Antes | Ahora |
|---|---|
| ¿De dónde bajamos ~1,400 documentos con los 9 campos? | ¿De dónde sacamos **~1,160 fechas de publicación** para 2016→2026? |

El problema nuevo es **mucho más fácil**. No hace falta descargar ni extraer
nada: un evento relevante en el listado de BMV **ya es una fila con fecha**. Se
necesita un dato por celda, no un documento por celda.

Eso también **desinfla el tope de ~80 filas** que en la versión anterior de este
documento era "la pregunta más importante". Sigue importando —determina si las
fechas llegan a 2021 o a 2016— pero ya no decide entre "hay proyecto" y "no hay
proyecto": decide entre "fechas reales para todo el histórico" y "fechas reales
desde 2021 y una aproximación declarada para antes".

Las tres sondas del modo `?profundo=` siguen siendo las correctas para eso, y la
de paginación es la que más vale.

### 3.3 `scripts/pdf-extract.mjs` — se queda, y no se toca

No se borra. Razones concretas, no sentimentales:

- Es el **plan B** si DataBursatil cambia de términos, se queda sin créditos o
  deja de mantenerse. Es un proyecto sin fines de lucro sostenido por
  colaboración: excelente, y también una razón para no volverse dependiente sin
  salida.
- Es la forma de **auditar a DataBursatil**. Fase 0b cerró GO y dejó anotado que
  hacía falta verdad independiente para auditar a escala. Ahora la relación se
  invierte: el PDF audita a la API. Un muestreo de 20-30 trimestres contra el PDF
  original es barato (~$0.60) y es la única forma de saber si la API tiene
  errores de captura.
- El trabajo ya está hecho y probado (GO en Fase 0b, 45 tests).

---

## 4. El plan revisado

1. **Cosechar el histórico de DataBursatil** — los ~60 campos `ifrs-full`,
   2016→2026, dentro del presupuesto de créditos. Sustituye por completo la
   cosecha de PDFs.
2. **Mantener vivo el capturador de Fase 1a.** Cada trimestre agrega fecha real,
   desglose `ifrs_mx` y acciones. No es opcional.
3. **Resolver las fechas históricas** con el inspector (§3.2). Correr
   `?profundo=` y ver si la paginación llega a 2016.
4. **Verificar los dos huecos abiertos** antes de diseñar el esquema: si
   DataBursatil trae acciones o capitalización bajo otro nombre (§2.2), y si trae
   algo del desglose de deuda (§2.3).
5. **Auditar por muestreo** contra el PDF con `pdf-extract.mjs` (§3.3), y contra
   el XBRL que ya está en Neon para los trimestres que se solapan — ahí hay verdad
   independiente gratis.

**Lo que ya no se hace:** descubrir ~1,400 URLs en 29 sitios de IR, cosechar y
extraer ~1,400 PDFs, y cargar con el riesgo de transcripción silenciosa que Fase
0b documentó (y que costó dos corridas encontrar). Se ahorran semanas de trabajo
manual y ~$22 de extracción, pero sobre todo se ahorra la parte frágil.

---

## 5. Lo que hay que decidir

| # | Decisión | Estado |
|---|---|---|
| **D10** | ¿Fechas históricas: eventos relevantes, o aproximación declarada para pre-2021? | depende de §3.2 |
| **D11** | Si DataBursatil no trae acciones, ¿de dónde sale la capitalización histórica? | **[NO VERIFICADO]** — §2.2 |
| **D12** | Sin desglose `ifrs_mx` histórico, ¿la serie de deuda usa el agregado `ifrs-full` y se declara, o se deja en `null` antes de 2026? | §2.3 |
| **D3** | IFRS-16: ¿dentro o fuera de deuda con costo? | abierta desde Fase 0 |

**D12 merece una nota.** La tentación va a ser usar el agregado `ifrs-full` para
el histórico y el desglose `ifrs_mx` de 2026 en adelante. Eso produce una **serie
con dos definiciones distintas empalmadas**, con el corte justo donde empieza a
mejorar la calidad del dato — exactamente el tipo de discontinuidad que un
backtest lee como señal. Si se hace, hay que marcar la fuente por celda y probar
que el corte no genera un salto artificial.

---

## Apéndice — hallazgos de la 1ª corrida del inspector

Siguen siendo válidos y explican por qué el inspector conserva valor (§3.2).

**A.1 confirmado en 5/5:** la sección financiera de BMV lista **sólo el trimestre
vigente**. El supuesto de Fase 0 era correcto.

**A.3 — hay histórico en eventos relevantes, con tope:**

| Emisora | docs | trimestrales | ¿al tope? | Lectura |
|---|---:|---:|---|---|
| FEMSA | 84 | 1 | **sí** | truncada **y** el clasificador falla |
| ALSEA | 82 | — | **sí** | llega a 2021 porque ahí se corta |
| WALMEX | 80 | 28 | **sí** | idem |
| GMEXICO | 26 | 0 | **no** | **listado completo** — su cero es real |
| GCC | 28 | 0 | **no** | idem |

La deducción que sigue valiendo: **"2021-2026" no es el alcance del archivo de
BMV, es el alcance de una página.** Y GMEXICO y GCC no están truncadas, así que
sus ceros son información, no filas faltantes.

**Las tres preguntas siguen abiertas** y `?profundo=FEMSA` sigue siendo la
corrida que las cierra — ahora para conseguir fechas, no documentos:

```
https://<tu-dominio>/api/bmv-inspect?profundo=FEMSA
```

- `titulos` — los 84 títulos completos sin filtrar, para arreglar el clasificador
  sin adivinar el patrón.
- `paginacion` — si hay `fechaInicial`/`fechaFinal`, se piden rangos y el tope
  deja de importar. **Es la sonda que más vale** para D10.
- `zip_eventemi` — si el visor envuelve un XBRL real, esas celdas traen desglose
  `ifrs_mx` y acciones, o sea **dos de los tres huecos** para el histórico.

Esa última sonda cambió de importancia: antes era "sería bueno tener datos
estructurados"; ahora es **una vía posible para recuperar lo que DataBursatil no
tiene, hacia atrás**.

### Tests

```bash
node tests/bmv-inspect.test.mjs        # 22
node tests/xbrl-parse.test.mjs         # 18
node tests/xbrl-capture-fila.test.mjs  # 27
```

---

PR listo — no more pushes.
