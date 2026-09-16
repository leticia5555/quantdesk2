# FASE 0b — Histórico vía PDF: ¿se pueden extraer los 9 campos con un modelo?

> **Alcance:** viabilidad, no pipeline. No se tocó el app ni Neon. El raw vive en
> `xbrl-raw/pdf/` (ignorada por git).
>
> # VEREDICTO: NO EVALUABLE — dos bloqueos, ninguno de diseño
>
> No puedo emitir GO ni NO-GO, y no voy a mover los criterios para poder hacerlo.
>
> 1. **Falta el PDF en formato BMV.** Llegaron 4 archivos, no 5: los dos
>    comunicados de FEMSA y los dos de WALMEX. **El FEMSA 2T2020 en formato BMV
>    (108 páginas) no está.** Sin él no se puede evaluar *"los 9 campos salen en
>    el formato BMV"* ni el cruce de verificación #1, que eran el corazón de esta
>    fase.
> 2. **No hay `ANTHROPIC_API_KEY` en el sandbox.** `api.anthropic.com` sí
>    responde (401, o sea llega), pero sin credencial no hice ni una llamada. El
>    criterio que decide todo — *¿el modelo inventa o confunde ventanas?* — sigue
>    sin medirse.
>
> **Lo que sí quedó hecho, y no es poco:**
>
> - `scripts/pdf-extract.mjs` construido y probado en `--dry-run` sobre los 4
>   PDFs: selecciona páginas, arma el prompt y estima costo. Falta apretar el
>   botón (§6).
> - **Verdad de referencia establecida a mano** (§4): extraje los 9 campos de los
>   4 PDFs leyendo el texto yo mismo. Es contra esto que se compara la salida del
>   modelo cuando corra. **Las 4 identidades contables cierran exactas.**
> - **Tres hallazgos que cambian el diseño de la Fase 1** y que no dependen de
>   correr el modelo (§5): los comunicados de WALMEX **no traen el trimestre
>   suelto**, **no reportan acciones**, y **no traen línea de deuda**.

---

## 1. Qué llegó

| Archivo | Qué es | Páginas | Unidad | Fecha en documento |
|---|---|---|---|---|
| `FEMSA_resultados_2T18.pdf` | FEMSA comunicado 2T2018 | 36 | millones | 27-jul-2018 |
| `FEMSA_resultados_2T20.pdf` | FEMSA comunicado 2T2020 | 33 | millones | 24-jul-2020 |
| `eventemi_1165270_1.pdf` | WALMEX comunicado 4T2021 | 8 | **miles** | 16-feb-2022 |
| `eventemi_1208124_1.pdf` | WALMEX comunicado 2T2022 | 8 | **miles** | 26-jul-2022 |
| *(falta)* | *FEMSA 2T2020 formato BMV, 108 pp.* | — | — | — |

Las unidades ya difieren entre emisoras: FEMSA en millones, WALMEX en miles.
Por eso el script pide la unidad **declarada** por campo y no normaliza nada sin
ella.

---

## 2. Herramientas — decisiones justificadas

### 2.1 `pdftotext -layout`, no `pdf-parse`

Un estado financiero **es una tabla**: el significado está en qué columna cae
cada número (`Jun-20` vs `Dic-19` vs `% Inc.`). `pdftotext -layout` conserva esa
geometría en texto plano. `pdf-parse` —y pdfjs si no usas coordenadas— devuelve
un stream que aplana las columnas y deja los números de dos periodos pegados:
ni un humano ni el modelo pueden decir cuál es cuál.

Verificado sobre estos 4 PDFs: con `-layout` las tablas salen legibles tal cual.

No estaba instalado en el sandbox. Se instala con:

```bash
apt-get update && apt-get install -y poppler-utils   # Linux
brew install poppler                                  # macOS
```

El `apt-get update` **no es opcional**: sin él el índice está viejo y el install
da 404.

### 2.2 HTTP directo, no el SDK

El SDK oficial (`@anthropic-ai/sdk`) es lo que yo elegiría en un proyecto con
`package.json`. **Este repo no tiene `package.json` ni `node_modules`**, y sus 6
scripts usan sólo builtins de `node:`. Meter `npm install` para una sonda de
Fase 0 rompe esa convención y le agrega un paso a quien corra esto. `fetch` es
global en Node 18+. Si la Fase 1 se construye de verdad, ahí sí entra el SDK.

### 2.3 Modelo y costo

`claude-haiku-4-5` por defecto ($1.00 / $5.00 USD por millón de tokens
in/out). La tabla de precios está en el script; si cambian, es lo único a tocar.

---

## 3. El script — `scripts/pdf-extract.mjs`

```bash
node scripts/pdf-extract.mjs --dir xbrl-raw/pdf --dry-run   # sin llamar a la API
node scripts/pdf-extract.mjs --dir xbrl-raw/pdf             # de verdad
node scripts/pdf-extract.mjs --file <pdf> --raw             # guarda prompt y respuesta
```

Qué hace, en orden: extrae texto por página → puntúa y elige las páginas con
señales de estado financiero (la p1 va siempre, ahí está la fecha) → arma el
prompt → llama al modelo → parsea el JSON → normaliza a pesos según la unidad
**declarada** → corre las identidades contables → reporta costo.

**Reglas duras que le impone al modelo:** nunca inventar (campo ausente = `null`);
cita literal obligatoria por número; unidad y ventana por campo; tomar siempre la
columna del periodo más reciente; y una definición explícita de deuda con costo
(préstamos + bursátil + vencimientos CP de LP, **sin** arrendamientos ni
intereses por pagar), con los componentes listados y una bandera `comparable`.

Si el balance no muestra deuda financiera, la instrucción es devolver `null` y
explicar — **no `0`**, porque "no reportado" y "reportó cero" no son lo mismo.

### 3.1 Dry-run: páginas elegidas y costo estimado **[VERIFICADO]**

```
[FEMSA_resultados_2T18.pdf] páginas: 1, 2, 10, 11, 17, 29, 33   (~11,437 tok)  ~$0.0174
[FEMSA_resultados_2T20.pdf] páginas: 1, 2, 10, 11, 17, 28, 30   (~13,252 tok)  ~$0.0193
[eventemi_1165270_1.pdf]    páginas: 1, 2, 5, 6, 7, 8           (~8,756 tok)   ~$0.0148
[eventemi_1208124_1.pdf]    páginas: 1, 2, 5, 6, 7, 8           (~8,480 tok)   ~$0.0145
                                            total estimado: $0.0659  (~$0.0165/PDF)
```

El selector acierta: p10 (resultados) y p11 (balance) en FEMSA, p6-p8 en WALMEX.

**Costo estimado ~$0.017 por PDF, contra un criterio de $0.05.** Es estimación,
no medición: sale de `longitud/4` como proxy de tokens y de suponer ~1,200 de
salida. El número real sólo se sabe corriendo.

---

## 4. Verdad de referencia — extracción manual **[VERIFICADO]**

Como no pude correr el modelo, extraje los 9 campos **leyendo el texto yo
mismo**. Esto **no es la salida del modelo**: es el patrón contra el que se
compara cuando corras el script. Valores tal como están impresos, en la unidad
del documento.

### 4.1 FEMSA (millones de pesos)

| Campo | 2T2018 | 2T2020 | Ventana |
|---|---:|---:|---|
| Ingresos totales | 124,708 | 114,514 | **3m** |
| Ingresos totales | 240,046 | 236,716 | **6m** |
| Participación controladora | 8,796 | **(11,692)** | **3m** |
| Participación controladora | 8,797 | (3,911) | **6m** |
| TOTAL ACTIVOS | 584,732 | 744,647 | saldo |
| Total pasivos | 260,019 | 421,130 | saldo |
| Total capital contable | 324,713 | 323,517 | saldo |
| Efectivo y valores de realización inmediata | 53,876 | 140,240 | saldo |
| **Deuda con costo CP** | **14,302** | **38,659** | saldo |
| ├ Préstamos bancarios C.P. | 3,458 | 33,566 | |
| └ Vencimientos C.P. del pasivo L.P. | 10,844 | 5,093 | |
| **Deuda con costo LP** | **120,296** | **174,014** | saldo |
| Acciones en circulación | 17,891,131,350 | 17,891,131,350 | saldo |

**Excluidos a propósito de la deuda** (y esto es lo que el modelo tiene que
replicar): `Intereses por pagar` (792 / 2,048) porque son intereses devengados,
no principal; y `Vencimientos de arrendamientos de L.P. en C.P.` (7,348 en 2T20)
más `Arrendamientos L.P.` (48,996) porque son IFRS-16.

**La deuda del comunicado SÍ es comparable con la definición `ifrs_mx` de Fase 0**
(§5.3): el balance desglosa préstamos bancarios, vencimientos e intereses en
líneas separadas, así que se puede armar exactamente la misma suma.

Acciones: vienen **en prosa**, no en tabla — *"El número de Unidades FEMSA en
circulación al 30 de junio del 2020 fue 3,578,226,270 equivalente al número total
de acciones en circulación a la misma fecha, dividido entre 5"*. ×5 =
17,891,131,350. Idéntico en 2018 y 2020.

### 4.2 WALMEX (miles de pesos)

| Campo | 4T2021 | 2T2022 | Ventana |
|---|---:|---:|---|
| Total ingresos | 736,044,023 | 383,462,867 | **12m** / **6m** |
| Utilidad neta **consolidada** | 44,138,072 | 22,000,642 | **12m** / **6m** |
| Suma activos | 394,389,471 | 396,362,084 | saldo |
| Suma pasivos | 208,507,468 | 224,470,567 | saldo |
| Suma capital contable | 185,882,003 | 171,891,517 | saldo |
| Efectivo y equivalentes | 42,816,535 | 48,548,435 | saldo |
| Deuda con costo CP | **no reportada** | **no reportada** | — |
| Deuda con costo LP | **no reportada** | **no reportada** | — |
| Acciones en circulación | **no reportada** | **no reportada** | — |

### 4.3 Identidades contables — las 4 cierran exactas **[VERIFICADO]**

| Documento | Pasivos + Capital | Activos | Diferencia |
|---|---:|---:|---:|
| FEMSA 2T2018 | 260,019 + 324,713 = 584,732 | 584,732 | **0** |
| FEMSA 2T2020 | 421,130 + 323,517 = 744,647 | 744,647 | **0** |
| WALMEX 4T2021 | 208,507,468 + 185,882,003 = 394,389,471 | 394,389,471 | **0** |
| WALMEX 2T2022 | 224,470,567 + 171,891,517 = 396,362,084 | 396,362,084 | **0** |

Cero exacto en los cuatro. Sobre **mi** extracción: confirma que las cifras del
documento son coherentes y que la identidad sirve como detector. **No dice nada
todavía sobre si el modelo las extrae bien** — ese es justamente el punto de
correr el script (§6).

---

## 5. Hallazgos que cambian el diseño, independientes del modelo

### 5.1 Los comunicados de WALMEX no traen el trimestre suelto

Los estados financieros de WALMEX son **acumulados**:

- 4T2021: *"Por los años terminados el 31 de Diciembre de"* → **12 meses**.
- 2T2022: *"Por el periodo de seis meses que terminó el 30 de junio"* → **6 meses**.

**No hay columna de 3 meses.** El dato del trimestre solo existe en la narrativa
en forma de variación porcentual (*"Los ingresos totales crecieron 12.0%"*), no
como cifra.

Consecuencia para un backtest trimestral: el flujo del trimestre hay que
**construirlo restando acumulados consecutivos** (2T = 6m − 3m). Eso obliga a
tener el trimestre anterior de la misma emisora para poder calcular el actual, y
cualquier hueco en la serie propaga. No es bloqueante, pero es una dependencia
real que no existía con XBRL, donde el 3m viene explícito.

FEMSA sí trae ambas columnas (3m y 6m), lado a lado — que es precisamente el
escenario donde el modelo puede confundirse.

### 5.2 WALMEX no reporta acciones en circulación ni deuda

- **Acciones:** ninguna línea en los 8 páginas de ninguno de los dos
  comunicados. `null`, sin discusión.
- **Deuda con costo:** el balance sólo trae `Pasivos por arrendamiento a corto
  plazo` y `Pasivos por arrendamiento **y otros pasivos** a largo plazo`. No hay
  línea de deuda financiera. Y la de largo plazo viene **combinada**, así que ni
  siquiera se pueden aislar los arrendamientos limpiamente.

Del comunicado **no se puede afirmar 0**, sólo "no reportado" → `null`. Contrasta
con el XBRL de Fase 0, donde WALMEX reporta los seis componentes **explícitamente
en cero**. Son dos afirmaciones distintas y sólo una la respalda el documento.

Esto significa que **los 9 campos no salen completos de un comunicado de WALMEX**:
salen 6 de 9, y 2 de los 3 faltantes no son recuperables de ese documento.

### 5.3 La deuda de FEMSA sí es comparable; la de WALMEX no existe

Contra la definición `ifrs_mx` de Fase 0 (préstamos + bursátil + vencimientos,
sin arrendamientos ni intereses):

| Documento | ¿Comparable? | Por qué |
|---|---|---|
| FEMSA 2T2018 | **Sí** | líneas separadas de préstamos, vencimientos e intereses |
| FEMSA 2T2020 | **Sí** | idem, más arrendamientos separados |
| WALMEX 4T2021 | **N/A** | no hay línea de deuda; sólo arrendamientos, y agregados |
| WALMEX 2T2022 | **N/A** | idem |

### 5.4 Dos trampas de parseo encontradas en 4 archivos

**(a) Tabla desalineada y etiqueta huérfana — WALMEX 4T2021.** A media tabla las
columnas se corren, y `Suma capital contable` queda **separada de su valor**:

```
                   Fondo para el plan de acciones al personal   (6,595,404)   (6,666,394)
                                                               185,882,003   169,118,693
                   Suma capital contable
                   Suma pasivos y capital contable            $ 394,389,471 $ 361,883,101
```

El número está en la línea **anterior** a su etiqueta. Un parser posicional lo
asigna mal o devuelve `null`. (Que la identidad cierre con 185,882,003 es lo que
confirma cuál es.) Esto es exactamente el riesgo "tablas rotadas", y apareció en
**1 de 4** archivos.

**(b) Kerning que parte palabras.** Estos PDFs salen de Word y `pdftotext`
produce `"Ef ectivo"`, `"Benef icio"`, `"f ebrero"`. Un regex sobre `"Efectivo"`
**no encuentra la línea del efectivo**. Un modelo lo lee sin problema.

Es el argumento más fuerte a favor del enfoque con modelo sobre uno de reglas: no
es que las reglas sean más trabajo, es que **fallan en silencio** en casos que el
modelo absorbe.

---

## 6. Qué falta para emitir veredicto

**1. El PDF en formato BMV de FEMSA 2T2020.** Sin él no hay criterio #1 ni cruce.

**2. Correr el script con credencial.** `api.anthropic.com` responde desde el
sandbox (401), así que con la key exportada corre aquí o en tu máquina:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
apt-get update && apt-get install -y poppler-utils    # si falta pdftotext
node scripts/pdf-extract.mjs --dir xbrl-raw/pdf --raw
```

`--raw` guarda prompt y respuesta cruda en `xbrl-raw/pdf-out/` para poder auditar
qué vio el modelo cuando algo salga raro.

**Qué mirar al leer la salida**, en orden de importancia:

1. **Ventanas.** ¿Le puso `3m` al trimestre de FEMSA y `6m`/`12m` a WALMEX? Es
   el NO-GO más probable: FEMSA pone las dos columnas lado a lado.
2. **El signo negativo.** FEMSA 2T2020 tiene utilidad controladora
   **(11,692) negativa**. Si sale positiva, el modelo perdió el paréntesis — y
   ese error no lo detecta ninguna identidad contable.
3. **Deuda.** ¿Excluyó intereses por pagar y arrendamientos? ¿Devolvió `null` en
   WALMEX en vez de inventar un 0?
4. **Identidades.** Deben dar 0 contra §4.3.
5. **Costo real** vs. los ~$0.017 estimados.

---

## 7. Censo — ¿qué publican otras emisoras ICS del IPC?

**Todo [NO VERIFICADO]:** el sandbox no llega a estos sitios; esto sale sólo de
resultados de búsqueda, sin abrir una sola página.

| Emisora | Formato BMV | Comunicado | Desde | Nota |
|---|---|---|---|---|
| **BIMBO** | no visto | **sí**, PDF | ≥2022 visto | assets en S3/CloudFront con `?VersionId=` en la URL |
| **GMEXICO** | **sí** | sí | **≥2017** visto | `gmexico.com/GMDocs/ReportesFinancieros/Esp/2017/RF_ES_2017_BMV.pdf` |
| **CEMEX** | **sí** | sí | no determinado | página dedicada `cemex.com/investors/reports/bmv-reports` + "Archivo de Reportes" |
| **ALFA** | no visto | **sí**, PDF | ≥2021 visto | PDFs aparecen alojados en **latibex.com** y **sigmafoods.com**, no sólo en alfa.com.mx |
| **GRUMA** | no visto | **sí**, PDF | no determinado | `gruma.com/media/724638/4q24-gruma_1.pdf` — id numérico opaco |

Tres cosas útiles salen de aquí:

1. **El formato BMV sí se publica en sitios de IR**, al menos GMEXICO y CEMEX, y
   GMEXICO con una ruta que incluye el año —o sea potencialmente construible.
2. **Las URLs no son un patrón**: `?VersionId=` de BIMBO y el id `724638` de
   GRUMA no se derivan de nada. Es el mismo problema del id de `docs-pub` en
   Fase 0, multiplicado por 35 emisoras × 40 trimestres.
3. **ALFA aloja sus PDFs en terceros** (latibex, sigmafoods). Un cosechador que
   asuma "todo vive en el dominio de la emisora" se va a quedar corto.

---

## 8. Qué me preocupa de escalar a ~1,400 PDFs

Por orden de probabilidad de morder:

1. **El descubrimiento de URLs, no la extracción.** 5 de 5 emisoras del censo
   tienen esquemas de URL distintos, dos con ids opacos y una alojando en
   terceros. **El cuello de botella es encontrar los 1,400 PDFs, no leerlos.**
   Esto probablemente no se automatiza del todo: es trabajo manual por emisora,
   una vez, y mantenimiento cuando alguien rediseñe su sitio.
2. **Formatos que cambian por año, dentro de la misma emisora.** WALMEX 4T2021 y
   2T2022 están a 5 meses de distancia y **ya difieren**: distinto productor de
   PDF (Word vs Adobe), distinto periodo de reporte (12m vs 6m), y uno con la
   tabla desalineada y el otro no (§5.4a). A 10 años, esperar estabilidad de
   formato dentro de una emisora no es realista.
3. **Emisoras que sólo publican resumen.** Ya se ve en la muestra: WALMEX no da
   acciones ni deuda. La cobertura no va a ser 9/9 uniforme — va a ser una matriz
   con huecos, y el diseño tiene que aceptarlo desde el principio en vez de
   tratarlo como error.
4. **Los flujos acumulados (§5.1).** Si varias emisoras reportan como WALMEX, el
   trimestre hay que derivarlo restando, lo que encadena trimestres y hace que un
   hueco contamine el siguiente. Es la diferencia entre una fila independiente y
   una serie con dependencias.
5. **Costo y su varianza.** ~$0.017/PDF × 1,400 ≈ **$24 USD** si el estimado se
   sostiene. Barato. Pero es sobre PDFs de 8-36 páginas; uno de formato BMV de
   108 páginas es otra cosa, y es justo el que no pude medir. El presupuesto real
   depende del archivo que falta.
6. **Verificación a escala.** Las identidades contables detectan contexto
   equivocado, pero **no** detectan un signo perdido ni una ventana confundida
   (§6). Para 1,400 PDFs hace falta una segunda señal — por ejemplo, contra los
   trimestres que sí están en XBRL, o coherencia de la serie en el tiempo. Sin
   eso, un error silencioso entra a la base y nadie lo ve.
7. **Reexpresiones.** Un comunicado publicado en 2018 puede traer cifras que la
   emisora reexpresó después. El PDF es el dato "as reported" de esa fecha, que
   para backtest es lo correcto, pero no va a cuadrar contra fuentes actuales.
   Hay que decidirlo explícitamente, no descubrirlo.

**Lo que NO me preocupa:** la extracción en sí. El texto sale limpio con
`-layout`, las tablas son legibles, y los casos difíciles que encontré (kerning,
prosa, etiqueta huérfana) son justo donde un modelo va mejor que un parser de
reglas. Si esto falla, va a fallar por descubrimiento de URLs o por verificación
a escala — no por leer el PDF.
