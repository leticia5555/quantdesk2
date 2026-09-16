# FASE 0b — Histórico vía PDF: ¿se pueden extraer los 9 campos con un modelo?

> **Alcance:** viabilidad, no pipeline. No se tocó el app ni Neon. El raw vive en
> `xbrl-raw/pdf/` (ignorada por git).
>
> # VEREDICTO tras la 2ª corrida: **no alcanza GO**
>
> **El criterio que lo decide es el de comunicados**, y es uno solo:
>
> > *"en comunicados salen al menos ingresos, controladora, activos, pasivos,
> > capital y efectivo"*
>
> **Walmex 4T2021 salió con 0 de esos 6.** El modelo truncó los seis por factor
> 1000, la validación de cita los detectó (que es lo que debía pasar) y los
> descartó (que también). Pero descartados es **cero campos útiles** de ese
> archivo, y el criterio pide seis. Se cumple en los otros 3 comunicados; en ese
> no.
>
> | Criterio de GO | 2ª corrida |
> |---|---|
> | 9 campos en el formato BMV | **casi** — salen 9/9, pero deuda salió como proxy no comparable (§6.4) |
> | ≥6 campos en comunicados | **NO** — Walmex 4T2021 quedó en 0/6 |
> | Identidades a ±1 de redondeo | **SÍ** — 4/4 en formato BMV; el resto sin descuadres |
> | Cruce 2T2020 cuadra | **NO todavía** — el BMV devolvió 6m y el comunicado 3m (§6.3) |
> | Fecha de publicación en los 5 | **SÍ** — 5/5 |
> | Costo < $0.05 por PDF | **SÍ medido** ($0.0167), pero ver §6.5 |
>
> **Ninguna condición de NO-GO se cumplió.** El modelo confundió la ventana en
> **un** archivo (el criterio dice "más de un archivo"), no inventó nada —su
> intento de sacar acciones de la UPA quedó descartado por la validación— y el
> formato BMV se parsea bien.
>
> **Los tres fallos que quedan tienen arreglo escrito en esta rama** (§6.3-6.5) y
> **ninguno está probado**, porque ni el PDF en formato BMV ni el `resultados.json`
> llegaron a este entorno en ninguna de las dos rondas. El veredicto definitivo
> sale de la 3ª corrida (§7).
>
> **Lo que sí quedó demostrado y no depende de otra corrida:** la validación
> contra cita funciona. Atrapó los 6 campos truncados de Walmex 4T2021 y frenó un
> intento de derivar acciones desde la UPA (17.46). Sin ella, esos siete valores
> habrían entrado a la base con las identidades cerrando.

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

### 3.1 Dry-run inicial: páginas elegidas y costo estimado **[VERIFICADO]**

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

> Estas son las cifras de los **estados financieros consolidados** (en miles),
> que sí son acumulados. El mismo documento trae además tablas resumen **en
> millones** con el trimestre suelto — ver la corrección en §5.1.

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

### 5.1 CORRECCIÓN — WALMEX sí trae el trimestre, en otra tabla y otra unidad

En el memo anterior afirmé que los comunicados de WALMEX no traían el trimestre
suelto. **Es falso.** Lo verifiqué en el PDF y el modelo tenía razón:

```
Total de Ingresos   187,844  100.0   170,757  100.0  10.0   195,619  100.0  174,674  100.0  12.0
                     ^^^ 1T2022                              ^^^ 2T2022 (3 meses)
```

`187,844 + 195,619 = 383,463`, que es exactamente el acumulado de seis meses.
Comprobado.

**De dónde vino mi error:** leí sólo los *estados financieros consolidados*
(p.6-p.7), que efectivamente son acumulados —4T2021 a 12 meses, 2T2022 a seis— y
concluí que el trimestre no existía. Pero el comunicado tiene **dos bloques
distintos**:

| Bloque | Dónde | Unidad | Ventanas |
|---|---|---|---|
| Tablas resumen de resultados | primeras páginas | **millones** | 1T, 2T y acumulado |
| Estados financieros consolidados | p.6-p.8 | **miles** | sólo acumulado |

O sea: **un mismo documento reporta en dos unidades distintas**, y el trimestre
sólo existe en el bloque de millones. No hay que derivar el trimestre restando
acumulados como dije: está impreso.

Que ese mismo documento mezcle miles y millones no es trivia — es la condición
que produjo el bug de unidad de §6.2.

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

### 5.5 Deuda LP de FEMSA: el comunicado netea derivados, el formato BMV no

El cruce 2T2020 dio esto:

| | Formato BMV | Comunicado | Diferencia |
|---|---:|---:|---:|
| Deuda con costo LP | 184,194,285,000 | 174,014,000,000 | **10,180,285,000** |

**No es un error de extracción: son dos definiciones.** El comunicado lo dice en
su propia nota, que el modelo recogió: *"Incluye efecto de derivados de tipo de
cambio y tasa de interés relacionados con los pasivos bancarios"*. O sea, la
cifra del comunicado está **neta de la cobertura**; la del formato BMV es el
saldo **bruto** de `CreditosBancariosALargoPlazo + CreditosBursatilesALargoPlazo`.

> **Decisión congelada: la serie usa la definición del formato BMV — deuda
> bruta, sin efecto de derivados.**
>
> Tres razones: es la misma definición `ifrs_mx` que ya quedó fija en Fase 0, así
> que las series empalman; es la que no depende de la política de cobertura de
> cada emisora, que cambia en el tiempo y entre empresas; y es la que se puede
> reproducir a partir de tags, no de una nota al pie.
>
> Consecuencia: cuando una emisora sólo tenga comunicado, su deuda LP **no es
> directamente comparable** con la de una que tenga formato BMV. Hay que marcar
> la fuente por celda, no sólo el valor.

El resto del cruce sí cuadra, con diferencias que son puro redondeo a millones:

| Campo | Formato BMV | Comunicado | Diferencia |
|---|---:|---:|---:|
| Activos totales | 744,647,464,000 | 744,647,000,000 | 464,000 |
| Pasivos totales | 421,130,038,000 | 421,130,000,000 | 38,000 |
| Capital contable | 323,517,426,000 | 323,517,000,000 | 426,000 |
| Efectivo | 140,240,015,000 | 140,240,000,000 | 15,000 |
| Deuda con costo CP | 38,659,690,000 | 38,659,000,000 | 690,000 |

Cinco de seis comparables cuadran al redondeo. Ingresos y controladora no se
pudieron cruzar porque el formato BMV los devolvió NULL (§6.1).

### 5.6 FEMSA reporta UNIDADES, no acciones — la regla es por emisora

Los comunicados de FEMSA dan **3,578,226,270**, que es el número de **Unidades
FEMSA**, no de acciones. El propio texto lo aclara: *"equivalente al número total
de acciones en circulación a la misma fecha, dividido entre 5"*.

```
acciones en circulación = unidades × 5 = 17,891,131,350
```

El modelo extrajo 3,578,226,270 y citó la frase completa — correcto como
extracción, **incorrecto como "acciones en circulación"** si se toma tal cual.

> **Regla, y es por emisora, no global:** el factor unidad→acción depende de la
> estructura de capital de cada empresa y puede cambiar (splits,
> recomposiciones). No se puede hardcodear un ×5 para todos.
>
> Lo que corresponde es guardar **lo que dice el documento** (unidades, con su
> cita) y aplicar el factor en una tabla de conversión por emisora y por fecha.
> Convertir en el momento de la extracción pierde la trazabilidad y hace
> imposible auditar el número después.

Contraste útil: el XBRL de Fase 0 da `NumeroDeAccionesEnCirculacion` ya en
acciones (16,935,974,370 para 2T2026). O sea que **XBRL y PDF no devuelven la
misma magnitud para el mismo campo** — otra razón para marcar la fuente por celda.

---

## 6. Los bugs del script — ronda 1 (§6.1-6.2) y ronda 2 (§6.3-6.5)

Ambos fallos de la corrida real fueron míos. Los dos ya están arreglados; **ninguno
de los dos está probado contra el archivo que los provocó** (§7).

### 6.1 Selección de páginas ignoraba el índice del formato BMV

El puntaje por palabras clave eligió `1, 12, 13, 42, 44, 56, 76`: agarró balance y
notas, y se saltó el estado de resultados (p.14), los datos informativos con
acciones (p.27) y la fecha (p.2 / p.47). De ahí los cuatro NULL.

**Arreglo:** cuando la p.1 trae el índice de secciones de la taxonomía
(`[210000]`, `[310000]`, `[700000]`, `[800xxx]`), se usan **esos** números de
página y se ignora el puntaje. Se incluye también la página siguiente a cada
sección, porque suelen desbordar. Si el índice no se deja leer, cae de vuelta al
puntaje **y lo dice en pantalla** — el modo `--dry-run` ahora imprime por qué vía
eligió las páginas y qué secciones encontró.

Referencia independiente que diste para ese PDF, contra la que se compara la
re-corrida:

| Campo | Valor esperado |
|---|---:|
| Ingresos 3m | 114,513,661,000 |
| Utilidad controladora 3m | (11,692,223,000) |
| Acciones en circulación | 17,891,131,350 |
| Fecha de publicación | 2020-07-24 |

Nota: 114,513,661,000 del formato BMV contra 114,514 millones del comunicado —
cuadra al redondeo. Y la controladora **negativa** aparece en ambos.

### 6.2 El bug de unidad, que las identidades no detectan

Es el hallazgo más valioso de la fase porque **falla en silencio**:

```
Walmex 4T2021 -> valor 394,389 [miles]      cita "Suma activos $ 394,389,471"
Walmex 2T2022 -> valor 396,362,084 [miles]  cita "Suma activos $ 396,362,084"
```

Mismo campo, misma empresa, dos trimestres, **factor 1000**. El modelo citó bien
y transcribió mal: truncó el número de la cita a sus primeros dígitos.

Y no fue un campo: en 4T2021 salieron truncados **los seis**. Por eso las
identidades lo dejaron pasar — `394,389 = 208,507 + 185,882` cierra perfecto
cuando todo está truncado igual. El único rastro fue un
`Activos = Circulante + No circulante DIFIERE por −1,000`, que parece ruido de
redondeo y es en realidad la punta del error.

**Arreglo — validación dura:** los dígitos del valor deben aparecer como un
**token numérico completo** dentro de su propia cita. `394389` contra
`"394,389,471"` **no pasa**, porque el token completo ahí es `394389471`. Un
campo que no pasa se marca `INCONSISTENTE`, **no se normaliza y no entra a las
identidades ni al conteo**.

Los campos de suma (deuda con costo) son la excepción: su total no está impreso
como tal, así que se validan porque los componentes sumen el total **y** porque
el total o algún componente esté respaldado por la cita.

Probado contra los 18 casos reales de tu corrida:

- **Atrapa** los 6 campos truncados de Walmex 4T2021 (activos, pasivos, capital,
  efectivo, ingresos, utilidad).
- **No molesta** a los que estaban bien: FEMSA 124,708; la controladora negativa
  (11,692); las unidades 3,578,226,270; el 744,647,464,000 del formato BMV; el
  195,619 del trimestre de Walmex; y las dos sumas de deuda.

**Confirmado en la 2ª corrida:** la validación atrapó los 6 campos truncados de
Walmex 4T2021 (`736,044` contra la cita `736,044,023`) y además frenó un intento
de derivar acciones en circulación desde la **UPA** (17.46) — un número que no
tiene nada que ver con el campo y que ninguna identidad contable habría
cuestionado. Siete valores que sin esto entraban a la base.

**Segunda red:** un chequeo de magnitud entre periodos de la misma emisora. Si un
saldo cambia por factor ≥100× entre trimestres, avisa. Cubre el caso en que la
unidad declarada esté mal pero el número se haya transcrito bien — ahí la
validación de cita no ve nada.

---

### 6.3 El formato BMV tomaba el acumulado, no el trimestre

Salió `236,715,817,000` (6m) y `-3,911,491,000` (6m) aunque la columna de
trimestre está en la **misma tabla**: `114,513,661,000` y `-11,692,223,000` (3m).

**Arreglo — regla de prioridad explícita en el prompt.** Si existe la columna de
tres meses, ésa es el valor principal con ventana `3m`; las demás ventanas del
mismo concepto van a un arreglo `otras_ventanas` con su propia cita. Si el
documento **sólo** trae acumulado, entonces ése es el principal con su ventana
real. El prompt ahora nombra los encabezados que hay que buscar ("Por el
trimestre", "Acumulado a", "Del 1 de enero al") y cierra con la razón: equivocar
la ventana **no produce ningún error visible, produce una serie equivocada**.

Guardar las otras ventanas además de la principal tiene un beneficio extra: el
6m queda disponible para cruzarlo contra el 3m del trimestre siguiente.

### 6.4 La deuda salió de una sección cortada a la mitad

Salió `Otros pasivos financieros` (64,881,378,000 / 186,383,930,000) con
`comparable=NO`. La causa no fue el modelo: **la selección por índice cortó la
sección**. `[800100]` arranca en p.43 y el desglose de créditos bancarios y
bursátiles está en **p.44**, que no se mandó. El modelo hizo lo correcto con lo
que tenía y marcó honestamente que no era comparable.

**Arreglo — rangos completos.** Una sección ahora se lee **desde su página hasta
la anterior a la siguiente sección del índice**, sea cual sea. Para eso hay que
recoger **todos** los códigos del índice, no sólo los que interesan, porque el
final de una sección lo define el arranque de la siguiente. Con tope de
`MAX_PAGINAS_POR_SECCION = 6` para que una sección de notas enorme no dispare el
costo; cuando trunca, lo dice.

Probado con un índice sintético con la estructura que reportaste:

```
[800100] comentarios y notas    p43-46      <- ahora sí incluye p44
[700000] datos informativos     p27-32  (truncada)
[310000] resultados             p14-15
```

Referencia contra la que se compara la 3ª corrida:

| Campo | Esperado | Componentes |
|---|---:|---|
| Deuda con costo CP | 38,659,690,000 | 36,159,690,000 + 2,500,000,000 |
| Deuda con costo LP | 184,194,285,000 | 14,207,715,000 + 169,986,570,000 |

### 6.5 Política de reintento — y el conflicto de costo que abre

```
intento 1: prompt normal, claude-haiku-4-5
   ↓  ≥3 de los 9 campos INCONSISTENTE
intento 2: + REFUERZO, mismo modelo
   ↓  siguen ≥3
intento 3: + REFUERZO, modelo de escala (claude-sonnet-4-6 por defecto)
```

Se queda el intento con **menos** campos inconsistentes; en empate, el primero.
**El costo suma todos los intentos, no sólo el que se queda.** El umbral cuenta
sólo los 9 campos —los extras son informativos y contarlos dispararía reintentos
de más— y **nunca se acepta un valor que no pase la validación**, en ningún
intento.

El `REFUERZO` ataca el modo de falla exacto que observamos: le muestra el error
("se citó 394,389,471 y se reportó 394389"), le pide contar los grupos de dígitos
y copiarlos todos, y le dice que un `null` es aceptable pero un número truncado no.

> **Conflicto que esto abre, y hay que decidirlo:** un PDF que escale los tres
> intentos cuesta **~$0.09**, contra un criterio escrito de **< $0.05 por PDF**.
> El promedio del corpus seguiría bajo si la escalada es rara (1 de 5 archivos
> daría ~$0.03 de promedio), pero **el criterio está escrito por PDF, no por
> corpus**.
>
> No lo resuelvo por mi cuenta. El script ahora reporta **promedio y peor caso
> por separado**, dice cuáles escalaron, y evalúa el criterio contra ambos. Si la
> intención era un techo de corpus, el criterio hay que reescribirlo — antes de
> correr, no después de ver el número.

**Nota de modelo:** dejé `claude-sonnet-4-6` como escala porque es el que pediste,
y está en la tabla de precios ($3.00 / $15.00 por millón). Vale saber que
`claude-sonnet-5` es más nuevo **y más barato** ($2.00 / $10.00). Se cambia con
`--modelo-escala claude-sonnet-5`, sin tocar código.

---

## 7. La 3ª corrida — y qué decide el veredicto

Ninguno de los tres arreglos está probado contra los archivos que los provocaron:
el PDF en formato BMV y el `resultados.json` no llegaron a este entorno en
ninguna de las dos rondas (la carpeta de adjuntos sigue con los 4 comunicados).

```bash
# 1) Revisar la selección de páginas sin gastar tokens.
node scripts/pdf-extract.mjs --dir xbrl-raw/pdf --dry-run

# 2) La corrida.
node scripts/pdf-extract.mjs --dir xbrl-raw/pdf --raw
```

**Qué decide cada criterio:**

| Mirar | Criterio que cierra |
|---|---|
| Que el BMV liste `[800100] ... p43-46` en el dry-run | deuda comparable (§6.4) |
| Que ingresos y controladora del BMV salgan `3m` con `otras_ventanas` para el 6m | cruce 2T2020 (§6.3) |
| Que deuda del BMV dé 38,659,690,000 / 184,194,285,000 | los 9 campos del formato BMV |
| **Que Walmex 4T2021 recupere sus 6 campos** vía reintento | **el criterio que hoy falla** |
| El bloque de costo: promedio **y** peor caso | costo < $0.05 (§6.5) |

Si Walmex 4T2021 sigue en 0/6 después de escalar a sonnet, **eso ya es un
resultado**, no un bug pendiente: significa que ese PDF en particular no se deja
extraer de forma confiable, y la pregunta pasa a ser si es un caso aislado o un
patrón — que se contesta con más archivos, no con más reintentos.

---

## 8. Censo — ¿qué publican otras emisoras ICS del IPC?

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

## 9. Qué me preocupa de escalar a ~1,400 PDFs

Por orden de probabilidad de morder:

1. **Los errores silenciosos de transcripción.** Subió al primer lugar después de
   esta corrida. El bug de §6.2 produjo seis campos mal por factor 1000, con citas
   correctas, identidades cerrando y cero señales de alarma. Lo encontraste tú
   comparando dos trimestres a ojo. **A 1,400 PDFs eso no escala como revisión
   manual**, y la validación de cita —aunque atrapa este caso— es una red, no una
   garantía. Antes de construir la serie hace falta decidir qué fracción se
   audita y contra qué: los trimestres que también están en XBRL son el candidato
   obvio, porque dan verdad independiente gratis.
2. **El descubrimiento de URLs, no la extracción.** 5 de 5 emisoras del censo
   tienen esquemas de URL distintos, dos con ids opacos y una alojando en
   terceros. **El cuello de botella es encontrar los 1,400 PDFs, no leerlos.**
   Esto probablemente no se automatiza del todo: es trabajo manual por emisora,
   una vez, y mantenimiento cuando alguien rediseñe su sitio.
3. **Formatos que cambian por año, dentro de la misma emisora.** WALMEX 4T2021 y
   2T2022 están a 5 meses de distancia y **ya difieren**: distinto productor de
   PDF (Word vs Adobe), distinto periodo de reporte (12m vs 6m), y uno con la
   tabla desalineada y el otro no (§5.4a). A 10 años, esperar estabilidad de
   formato dentro de una emisora no es realista.
4. **Emisoras que sólo publican resumen.** Ya se ve en la muestra: WALMEX no da
   acciones ni deuda. La cobertura no va a ser 9/9 uniforme — va a ser una matriz
   con huecos, y el diseño tiene que aceptarlo desde el principio en vez de
   tratarlo como error.
5. **Dos unidades en un mismo documento (§5.1).** Walmex publica las tablas
   resumen en millones y los estados financieros en miles, en el mismo PDF. Esa
   convivencia es exactamente lo que produjo el bug de §6.2, y no hay razón para
   pensar que Walmex es la única. La unidad hay que capturarla **por campo**,
   nunca por documento.
6. **Costo y su varianza.** ~$0.017/PDF × 1,400 ≈ **$24 USD** si el estimado se
   sostiene. Barato. Pero es sobre PDFs de 8-36 páginas; uno de formato BMV de
   108 páginas es otra cosa, y es justo el que no pude medir. El presupuesto real
   depende del archivo que falta.
7. **Verificación a escala.** Las identidades contables detectan contexto
   equivocado, pero **no** detectan un signo perdido ni una ventana confundida
   (§6). Para 1,400 PDFs hace falta una segunda señal — por ejemplo, contra los
   trimestres que sí están en XBRL, o coherencia de la serie en el tiempo. Sin
   eso, un error silencioso entra a la base y nadie lo ve.
8. **Reexpresiones.** Un comunicado publicado en 2018 puede traer cifras que la
   emisora reexpresó después. El PDF es el dato "as reported" de esa fecha, que
   para backtest es lo correcto, pero no va a cuadrar contra fuentes actuales.
   Hay que decidirlo explícitamente, no descubrirlo.

**Lo que NO me preocupa:** la extracción en sí. El texto sale limpio con
`-layout`, las tablas son legibles, y los casos difíciles que encontré (kerning,
prosa, etiqueta huérfana) son justo donde un modelo va mejor que un parser de
reglas. Si esto falla, va a fallar por descubrimiento de URLs o por verificación
a escala — no por leer el PDF.
