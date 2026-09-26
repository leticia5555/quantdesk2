# R1 — El mapa. Lo que se construyó y con qué se probó

> Precondición cumplida: G1 y G2 en verde, `?job=todo` con `rojos = ["g9"]`.
> G9 es Form 4 y es de R5.

---

## 1. El orden no fue casual: la serie primero

El toggle ofrece 1D/1S/1M/**YTD**, y **YTD no es un número de sesiones: es una
fecha** — el último cierre del año pasado. Cuántas sesiones hay hasta ahí
depende del día en que se pregunte.

Las dos fuentes que ya existían no alcanzan, y la Fase 0 lo había medido:
`/api/price` da 30 cierres **sin fecha** y `/api/macro-markets` 70 puntos de
3 meses. Con una serie sin timestamps, el toggle YTD pintaría un número corto
con una etiqueta larga — el bug del % de periodo, otra vez.

México ya tenía su serie fechada (`bmv_precios`). **EE.UU. no tenía ninguna
tabla de precios**, así que R1 empieza construyéndola:

| Pieza | Qué hace |
|---|---|
| `mercado_precios_us` | `(symbol, fecha)` con `cierre` y `cierre_ajustado` |
| `/api/mercado-precios?job=us` | siembra 1 año lo que no tiene serie, cola corta lo que sí. Reanudable, idempotente, 100 req/min |
| `/api/mercado-precios?job=estado` | cuántos símbolos pueden anclar YTD, y el motivo de los que no |
| cron `20,35,50 21 * * 1-5` | tres veces tras el cierre: la siembra de 300 no cabe en una corrida |

**Se guardan las dos columnas a propósito.** El % de un periodo largo con el
cierre pelado ignora splits y dividendos: un split 4:1 pinta un −75% que no
existió. `cierre_ajustado` es la serie de retorno y es la que usa el %;
`cierre` es el precio que la gente ve, y es el que se muestra. Mezclarlos es
pintar un precio que no existe o un % que ignora los splits.

**La barra del día en curso no se guarda.** Antes del cierre, el último punto
que manda Yahoo es el precio vivo; meterlo en una tabla que se lee como
definitiva hace que el % del día siguiente se calcule contra media sesión. Se
omite y se reporta cuántas se omitieron.

---

## 2. `qd-periods.js`: por qué hay un segundo archivo y no una copia suelta

El encargo prohíbe rediseñar `app.html`, y las piezas compartidas del %
—`qdPeriodChange`, `qdPctTag`— viven adentro de su `<script>`. Las opciones
eran copiar el bloque (dos implementaciones que se desincronizan en la primera
corrección) o mover el bloque (tocar un archivo de 5,000 líneas fuera del
alcance).

Se eligió una tercera: `qd-periods.js` es la fuente de `/mercado`, `app.html`
queda intacto, y **`tests/qd-periods.test.mjs` corre las dos implementaciones
reales sobre las mismas series y falla si difieren en un punto**. La garantía
no es "está bien copiado": es que no pueden discrepar sin que el test lo diga.

Ahí vive también el chip de estado, y por el mismo motivo: el encargo pide un
chip **por instrumento**, `/mercado` tiene dos bolsas con horarios distintos, y
el de `app.html` sabe de una sola (EE.UU., con offset EDT fijo). El nuevo
pregunta la hora local con `Intl` en vez de fijar offsets — México no cambia de
horario desde 2022 y EE.UU. sí.

**Los feriados no se modelan**, y está dicho en el código: BMV y NYSE tienen
calendarios distintos y una tabla desactualizada mentiría con más confianza que
el texto. Un día de asueto sale como "abierto" sin operaciones, y el pie dice
la fecha del último cierre, que es el dato que desambigua.

---

## 3. El endpoint LEE

`/api/mercado-mapa?map=us|mx`, público y cacheado (`s-maxage=600`). No pide
nada a ninguna API: lee Neon, donde los crons dejaron los precios. La Fase 0
midió ~6.2 s on-request contra ~120 ms leyendo, y la regla 7 prohíbe un fetch
por cuadro. Acá además es aritmética: 300 cuadros × 6 s no cabe en una página.

**Qué viaja, y por qué no la serie entera.** Un año × 300 nombres son 75,000
puntos en un teléfono para pintar 300 cuadritos. Mandar los cuatro % ya
calculados tampoco sirve: la regla 1 dice que todo % pasa por
`qdPeriodChange`, y si el servidor los calcula hay dos implementaciones del
ancla. Lo que viaja son **22 cierres** —el mínimo para que 1D, 1S y 1M usen la
regla real de `tradingDays`— más el **ancla YTD como punto explícito**, elegida
con `anclaYtd`, el mismo medidor que el navegador implementa y que el test
prueba equivalente. Un solo calculador, payload de teléfono.

El mapa MX usa **`evaluaG2`**, el mismo evaluador que `?job=unidades` y el
censo: el mapa no puede tener su propia opinión sobre qué está verificado. Y
**la cap sólo se pinta si está verificada** — un cuadro dimensionado con una
cap que no cuadra miente de tamaño, no sólo de color.

---

## 4. La página, y la decisión que el teléfono obligó

En 390 px, 300 cuadros dan ~10 px por lado. El encargo pide tap ≥44 px y las
dos cosas no caben juntas: un mapa de 300 nombres en un teléfono es una
textura, no una interfaz.

El primer intento fue hacer del **sector** el primer nivel —11 cuadros
holgadamente tocables— y entrar a los nombres al tocar uno. El teléfono lo
rechazó: un mapa de mercado que al abrirse no muestra una sola empresa no es
un mapa de mercado. **Corregido en R1b** (§7): el primer nivel son los ~30
nombres más grandes **agrupados bajo cabeceras de sector**, y cada sector
cierra con un "+N más = X%" que abre el sector completo. En escritorio el
sector se recorre con hover sin entrar. **El recorte del mapa NO cambia con el
dispositivo**: los 300 son los mismos y el "+N más = X%" también, así que dos
personas con pantallas distintas siguen viendo el mismo mapa.

El treemap es propio: `squarify` (Bruls, Huizing, van Wijk 2000) en ~60 líneas,
menos de lo que pesa cualquier dependencia. Squarified y no slice-and-dice
porque este último produce cuadros de 3 px de alto en una tira de 390 px —
imposibles de ver y de tocar.

**El "—" con su causa** viaja hasta la hoja: `ytd_motivo` cuando la serie no
llega al año anterior, el motivo del gris cuando la emisora no verifica. Y el
color de "sin dato" es **distinto** del gris de "sin cambio": pintar un hueco
del color de "no se movió" es afirmar algo que no se midió.

---

## 5. Cómo se probó

`node scripts/mercado-chromium.mjs` levanta la página con la API servida desde
un fixture y maneja un Chromium real. **30 comprobaciones en verde** (22 en R1,
cuatro por los arreglos de R1b y cuatro más por lo que destapó el preview),
entre ellas:

- 390 × 844 táctil: sin scroll horizontal **ni vertical**, todo control ≥44 px,
  cada sector tocable.
- **Tap real** —no `click()`— en la cabecera de un sector entra a sus nombres;
  en un nombre abre la hoja.
- El toggle cambia de periodo **sin volver a pedir el mapa** (se cuentan las
  peticiones al fixture).
- El estado viaja en la URL: `mapa`, `periodo`, `sector`, `symbol`.
- Un cuadro sin dato dice "—" **y dice por qué**.
- El chip es el de la BMV en el mapa MX y el de NYSE/Nasdaq en el de EE.UU.
- Escritorio 1440 × 900: sin scroll, hover con tooltip **con etiqueta de
  periodo**, y la hoja como panel lateral dentro de la pantalla.

Capturas en `docs/capturas/`: `mercado-390.png`, `mercado-390-hoja.png`,
`mercado-1440.png`.

Dos bugs que las capturas destaparon y que ninguna prueba unitaria habría
visto: los cuadros se dibujaban **encima del pie** (el mapa se medía antes de
que el "+N más" y el pie ocuparan su alto), y un −0.04% se pintaba como
**"−0.0%"**, un signo inventado por el redondeo.

---

## 6. Lo que queda abierto

1. ~~La tabla hay que sembrarla desde producción.~~ **Hecho:** cuatro corridas
   de `/api/mercado-precios?job=us` en prod, `completo: true` en la cuarta. Lo
   que destapó la tabla sembrada está en §7.
2. ~~El mapa MX y el PR #248.~~ **Cerrado, y no era inocuo.** El llamado a
   `evaluaG2` del mapa se escribió cuando `periodos` y `cierres_captura` no
   existían. En cuanto #248 entró a `main`, la omisión dejó de ser teórica:
   el mapa comparaba la referencia contra el cálculo de HOY y el censo contra
   el de su fecha de captura. Medido con el precio movido 8% desde la
   captura, `?job=unidades` decía `verificada` con 0% de error y el mapa
   `gris_punteado` con 8% — la misma emisora, los mismos datos, dos
   veredictos. Los dos parámetros son opcionales en la firma pero no en la
   práctica, y ahora hay un test que lo fija en los dos sentidos: que el mapa
   los pasa, y que omitirlos cambia el resultado.
3. **El `pct-lint` todavía sólo recorre `app.html`.** Para `/mercado` el
   candado es otro —el test de gemelas y que `qdPctTag` lanza sin etiqueta—,
   pero extender el lint a los archivos nuevos es trabajo pendiente.

---

## 7. R1b — lo que corrigió el teléfono en producción

Con la tabla sembrada (`completo: true`), `/mercado` en un iPhone real dio un
mapa **entero en gris**: "300 cuadros sin dato completo", chip "NYSE/Nasdaq:
cerrado · cierre del lunes". Tres arreglos salieron de ahí.

### 7.1 El periodo se mide sobre lo que hay, no sobre lo que el calendario espera

La cosecha omite la barra del día en curso (§1), así que un lunes por la tarde
la tabla termina el **viernes**. El mapa, en cambio, pedía el cierre de *hoy* —
y al no encontrarlo declaraba a los 300 nombres sin dato. El dato estaba; el
que se equivocaba era el que preguntaba.

**La regla, ahora explícita:** *1D es el último cierre que existe en la tabla
contra el anterior, y el chip dice de qué día es ese cierre.* El periodo se
calcula sobre lo que hay, con su etiqueta; nunca sobre lo que el calendario
dice que debería haber. El chip dejó de derivarse del reloj y pasó a derivarse
del dato: el endpoint manda `ultimo_cierre` —el máximo `fecha_precio` de los
cuadros— y la página escribe "cerrado · cierre del viernes" porque ese es el
cierre que se está viendo.

**Y dos causas más que el mapa vacío tapaba:**

- **Un `.catch(() => [])`** en las lecturas del endpoint convertía una consulta
  fallida en "300 cuadros sin serie": el mapa culpaba al dato de un problema de
  lectura. Un error tragado que se ve como dato faltante es la misma falta que
  un verde inventado, con peor disfraz. Ahora cada lectura registra su error y
  la respuesta trae `error` + `detalle`.
- **La consulta de precios traía ~60,000 filas** (300 símbolos × toda la
  ventana desde diciembre) para usar 23 por símbolo. Reescrita con funciones de
  ventana —últimas 23 filas por símbolo más el ancla YTD— baja a ~6,900.

**El cron no fue el culpable, y vale decirlo con la evidencia:** la hipótesis
era que la corrida de 21:20 UTC —ya post-cierre— había excluido la barra del
día. `git log -1 --format=%cI` sobre el merge de #249 lo desmiente: entró a
`main` a las 23:01 UTC, después de las tres corridas (21:20 / 21:35 / 21:50).
El cron de ese día **no corrió con el código nuevo**, no es que excluyera de
más.

Lo que sí estaba mal en la ventana de cierre era el **huso**: `CIERRE_US_UTC_H
= 21` es el valor de EST, y en septiembre (EDT) el mercado cierra a las 20:00
UTC, así que durante una hora después del cierre las barras se marcaban
provisionales. `esCierreDefinitivo` ahora pregunta la hora en
`America/New_York` con `Intl` (cierre 16:00 ET + 10 min de margen) en vez de
fijar un offset, y **falla cerrado** si `Intl` no contesta.

### 7.2 Al abrir se ven empresas

El primer nivel de sectores quedó descartado: *"un mapa que al abrirse no
muestra una sola empresa"*. En 390 px el primer nivel son ahora **los ~30
nombres más grandes agrupados por sector**, con cabecera de sector de 14 px
como en el artboard 1, y cada sector cerrando en un cuadro **"+N más = X%"**
que abre ese sector completo. Tap en la cabecera hace el mismo zoom. Escritorio
se queda como estaba (60 nombres).

**El detalle que hace honesto el dibujo:** el área del sector es su
capitalización **completa**, no la de los nombres visibles, y el "+N más" se
mide **sobre ese sector**, no sobre el mapa. Así el cuadro del resto ocupa
exactamente el peso que representa — un sector cuyos nombres no entraron al
top 30 aparece entero como "+9 más · 100%", que es la verdad.

### 7.3 Ninguna etiqueta cortada a mitad de palabra

"omunicacione", "dustrial", "ateriale": el nombre del sector se desbordaba y el
recorte del contenedor se comía la primera mitad. Se resolvió midiendo antes de
escribir: `etiquetaQueCabe` prueba candidatos en orden —nombre completo,
abreviatura corta (`Com.`, `Ind.`, `Mat.`), y las tres primeras letras— y usa
el primero que cabe en el ancho real. Si no cabe ninguno, no se escribe nada:
**una etiqueta cortada a mitad de palabra no es información, es ruido que
parece información**.

### 7.4 Cómo se probó

El caso que pidió el reporte, literal: **lunes 17:00 CT con la tabla al
viernes**. El reloj del navegador se congela con `addInitScript` en
`2026-09-21T23:00:00Z` y el fixture termina el viernes 18, así que la
aseveración del chip es determinista y no depende del día en que se corra.

```
✓ al abrir se ven EMPRESAS, no sólo sectores — 35 cuadros
✓ hay cabeceras de sector
✓ cada sector cierra con su cuadro "+N más"
✓ ninguna cabecera queda cortada a mitad de palabra
✓ el chip dice el cierre que se está viendo — ○ NYSE/Nasdaq: cerrado · cierre del viernes
✓ con la tabla al viernes, 1D se pinta igual — {"total":30,"conPct":30,"sinDato":0}
```

Más: `tests/mercado-precios.test.mjs` cubre EDT y EST (16:30 ET en septiembre
es cierre; 15:30 ET en enero no lo es) y el día de mercado contra el día UTC
(00:30 UTC del martes son las 20:30 del lunes en Nueva York);
`tests/mercado-mapa.test.mjs` fija el 1D sobre una tabla que termina el
viernes, el agrupado por sector con área de cap completa, el % del resto
medido sobre el sector, y el ajuste de etiquetas.

### 7.5 Lo que destapó el preview: el SQL que nadie probaba

El deploy de R1b salió a un preview y el teléfono lo tumbó de inmediato:

```
no se pudieron leer los datos del mapa
{"mercado_precios_us":"Neon: syntax error at or near \"filter\""}
```

**La consulta nueva del §7.1 no compilaba.** El ancla YTD se sacaba con
`row_number() over (...) filter (where fecha < $2)`, y `FILTER` **sólo existe
en agregados**: sobre una función de ventana Postgres ni siquiera llega a
planear — truena en el parser. Un error de sintaxis, el más barato de atrapar,
y se llevó el mapa entero.

**Lo bueno, y no es consuelo:** el arreglo del `.catch(() => [])` hizo
exactamente su trabajo. En vez de 300 cuadros grises culpando a la cosecha, la
pantalla nombró la tabla y el error de Postgres. El diagnóstico tomó un minuto
en vez de una tarde. Un error que se ve es un error que se arregla.

**El arreglo.** El ancla se consigue ordenando, no filtrando: las filas
previas al año primero y, dentro de ésas, la más reciente.

```sql
row_number() over (partition by p.symbol
                   order by (p.fecha < $2::date) desc, p.fecha desc) ancla
...
where recientes <= $3 or (ancla = 1 and previa)
```

El `and previa` no es adorno: sin él, un símbolo que salió a bolsa en agosto
recibiría como "ancla YTD" un cierre de **este** año, y el YTD saldría corto
con etiqueta larga — el bug del % de periodo, por tercera vez.

**Por qué se coló, que es la pregunta que importa.** Ninguna prueba tocaba el
SQL. Las demás mockean `sql()` y verifican el armado, que es lo correcto para
la lógica y **completamente ciego para la consulta**. El único que parseaba era
Postgres en producción.

`tests/mercado-sql.test.mjs` cierra ese hueco, y no con una expresión regular
que buscara `filter` —eso atraparía este bug y ninguno más—: **levanta un
Postgres de verdad, crea el esquema con la DDL real del repo y hace `PREPARE`
de cada consulta.** `PREPARE` parsea *y* resuelve nombres, así que también
falla si una columna no existe o si la DDL y la consulta se desincronizan.
Después corre la consulta contra datos sembrados y comprueba las tres cosas
que el mapa necesita: la serie con la tabla terminando el viernes, el ancla
YTD donde la hay, y **ninguna ancla inventada** donde no.

Se verificó que la prueba sirve **devolviéndole el bug**: con el `filter` de
vuelta, los cuatro sub-tests se ponen rojos con el mismo mensaje que dio
producción, palabra por palabra.

Y si no hay Postgres en la máquina, **el archivo falla en voz alta en vez de
saltarse solo**: una prueba que se auto-desactiva deja la suite en verde
afirmando algo que no midió, que es la misma falta que este PR vino a
corregir. Para saltarla hay que decirlo: `SIN_POSTGRES=1`.

### 7.6 Y el chip, otra vez: sin dato no se nombra un día

En esa misma pantalla rota el chip seguía diciendo **"cerrado · cierre del
lunes"**. Con `ultimo_cierre` ausente, `pintarChip` caía al texto de
`qdEstadoMercado`, que lo deriva del reloj: el mismo pecado del §7.1 entrando
por la puerta de atrás.

Ahora, sin fecha que respalde el rótulo, el chip dice **"cerrado"** a secas y
el motivo va en el `title`. Y el aviso del lienzo distingue **roto** de
**vacío** con `data-error`, porque mandan a buscar a lugares distintos: "no hay
cuadros" manda a revisar la cosecha; un error de lectura manda a revisar la
consulta.

Las cuatro comprobaciones nuevas del Chromium cubren las dos cosas, con el
interruptor del fallo **en el servidor de prueba, no en la página**: el primer
intento fue pedir `?mapa=roto` en la URL y no servía —`mercado.html` normaliza
el mapa a `us|mx`—, y hacer que lo aceptara habría sido meter código de prueba
en producción.

**30 comprobaciones en verde, 0 en rojo. Suite: 118/120.**

---

## §8 — Ronda 3: lo que encontró Chrome, y el gris que no se veía

Prod en Chrome, `main` en `d6eab7b`. Los puntos 3–5 del encargo (fecha del
chip, fuera el "+N más", cero logos) quedaron confirmados en pantalla. Dos
bugs nuevos, los dos de los que el mapa **dice** de sí mismo:

### 8.1 Un error cacheado diez minutos después de estar arreglado

La primera carga sirvió `column cap_moneda does not exist`, generado a las
5:06 pm — de **antes** de la migración. El error de lectura viaja dentro del
cuerpo (eso es correcto: es lo que #251 vino a arreglar), pero el handler
decidía el `Cache-Control` mirando **sólo el status**, y un 200 con un error
adentro se cacheaba igual que un mapa sano. Ningún reintento del teléfono lo
iba a limpiar.

La regla ahora es del **cuerpo**, en `cacheDeRespuesta()`: se cachea
únicamente una respuesta completa —sin `error` y con al menos un cuadro—. Todo
lo demás va `no-store`, porque una respuesta que describe un problema
transitorio no debe sobrevivir al arreglo del problema. La respuesta además
lleva `cacheable` y, si no lo es, `no_cacheado_porque`: si alguna vez vuelve a
aparecer un cuerpo viejo, el propio JSON dice si ese cuerpo era cacheable.

### 8.2 "277 cuadros sin dato completo" eran 25

El pie sumaba 250 símbolos **sin precio** a 25 caps sin verificar y lo
reportaba como un solo problema, que manda a buscar 277 bugs donde hay 25. Un
símbolo sin serie **no es un cuadro todavía**: no se dibuja, no tiene % y no
hay nada que mirar. `resumenFaltantes` ahora desglosa `sin_cap_verificada`,
`sin_precio`, `sin_periodo` y `sin_ancla_ytd`; el pie muestra el primero y dice
**"25 sin capitalización verificada"**. `total` sigue estando para quien lo
necesite.

### 8.3 Un cuadro gris tiene que verse

Éste no lo reportó nadie: salió de leer el código al confirmar el punto 4.
`agrupaPorSector` y `cuadrosVisibles` filtraban por `cap > 0`, así que una
emisora sin cap verificada **no salía gris punteada: salía ausente**. El único
rastro era un número en el pie, y un cuadro que no está no tiene dónde decir su
causa — que es justo lo que pide la regla 2 del encargo.

Ahora se dibuja con **tamaño fijo: el del cuadro verificado más chico de su
sector**, punteado, con ticker y `—`, y el motivo al tocarlo. El más chico a
propósito: el tamaño es lo único que el mapa no puede afirmar de esa emisora,
así que ocupa lo menos posible sin desaparecer, y nunca hereda un área
proporcional a una cap en la que no creemos. Un sector entero sin verificadas
cae al mínimo global; si no hay ninguna en todo el mapa —el día del despliegue,
con las columnas nuevas vacías— todas miden igual y el mapa es una rejilla gris
que lo dice, en vez de una pantalla en blanco.

El % **se calla** en esas: pintarlo sobre un cuadro cuyo tamaño no afirmamos lo
haría pasar por un cuadro entero.

### 8.4 Cómo se puso a prueba

`node scripts/mercado-chromium.mjs` → **42 comprobaciones en verde, 0 en rojo**,
incluidas las cuatro nuevas: la gris se dibuja punteada, lleva ticker y `—`, su
hoja dice la causa, y el pie no suma los sin precio.

`node --test tests/` → **122 de 123 suites en verde**. La única roja es la
heredada `agents-persistence`, que no se tocó.

---

## §9 — Ronda 4: las letras, la unidad, y dos preguntas contestadas

### 9.1 La fuente escala con el cuadro

Había una talla fija de 13px con una escalera que sólo bajaba. Resultado: V, MA,
JNJ, ABBV, BAC, GS y GOOGL salían **sin el %** teniendo espacio de sobra, y los
medianos sin nada. Tener sitio y no usarlo es tan malo como no tenerlo — el
cuadro más grande de la pantalla es el que más puede decir.

`etiquetaCuadro` ahora prueba de **18px a 8px** y busca, en este orden:

1. la talla más grande donde caben **ticker + %** (dos líneas),
2. si en ninguna caben las dos, la más grande donde cabe el ticker,
3. si tampoco a 8px, el cuadro va de color y sin texto.

Se prefieren las dos líneas antes que una letra más grande: el % es la mitad de
lo que el cuadro tiene que decir. El % va una talla menor que el ticker.

Candado en Chromium a 390px: **cero cuadros de ≥900px² sin texto** (900px² = 30×30,
que es donde entra un ticker de 4 letras a 8px con sus márgenes), más una
comprobación de que las tallas usadas son varias — si todas fueran iguales,
seguiría siendo el tamaño fijo con otro número. La corrida da
`{"10":5,"11":2,"12":8,"14":1,"15":4,"16":4,"17":4,"18":27}`.

Y al entrar a un sector el nombre va **completo**: las abreviaturas (`Con.`,
`Ser.`, `Inm.`, `Mat.`) son sólo para la cabecera apretada del primer nivel.

### 9.2 `qdCap`: la unidad se lee, no se descifra

La hoja decía **"5.51 B"** para NVDA. En español un billón es 10¹²; en inglés
*billion* es mil millones. Mil veces de diferencia en el número más grande de la
pantalla y sin forma de saber cuál era. Y **"790.8 mm"** era una abreviatura que
no existe fuera de esa pantalla.

Una sola función, `qdCap(valor, moneda)` en `qd-periods.js`, con escala larga y
la moneda al lado —60 mil millones de pesos y 60 mil millones de dólares no son
la misma empresa—:

| entrada | sale |
|---|---|
| `5.51e12, USD` | `5.51 billones USD` |
| `790.8e9, MXN` | `790.8 mil millones MXN` |
| `60.5e9, USD` | `60.5 mil millones USD` |
| `1e12, USD` | `1.00 billón USD` |
| `null` / `0` | `—` |

Ese último caso era un bug esperando: `Number(null)` es `0` y
`Number.isFinite(0)` es `true`, así que una cap que nadie midió se habría
escrito **"0 USD"**. Es el tercer sitio donde el mismo tropiezo aparece en dos
días (el filtro de EDGAR, el guardia del cierre de captura, y esto).

### 9.3 "puntos de serie: 24" con YTD — el número estaba bien, la etiqueta no

`puntos` es `serie.length` **de lo que la consulta trajo**, y la consulta del mapa
trae a propósito *23 cierres recientes + 1 ancla de fin de año* (`SQL_MAPA_US.precios`).
O sea: 24 filas, y el YTD sale del ancla que viene **entre** esas 24 — no de 24
días de historia. El largo real de la serie nunca viaja al navegador porque nadie
lo pide.

No había nada que arreglar en el dato. La etiqueta pasa a decir **"cierres
traídos: 24 (incluye el ancla de fin de año)"**, que es lo que el número es.

### 9.4 México con el cierre del jueves un sábado

El cron estaba bien declarado y no hay bug de huso: `10 22 * * 1-5` es 22:10 UTC
= 16:10 en Ciudad de México, 1h10 después del cierre de las 15:00, y el viernes
entra en `1-5`. `bmv-harvest.js` calcula `hoy` en UTC y a las 22:10 UTC del
viernes la fecha UTC **sigue siendo viernes**, así que pidió el viernes. Tampoco
existe del lado de México el guardia de "barra provisional" que causó el bug de
EDT/EST en EE.UU.

Quedan dos causas posibles, y `/api/cron-status` las distingue:

| si pasó esto | se ve así |
|---|---|
| el cron no corrió | `jobs[]` → `bmv:precios` con `stale: true` y su último latido del jueves |
| corrió y el proveedor no tenía el viernes | latido fresco del viernes, y `datos[]` → `bmv_precios` con `ultima_fecha` del jueves, `sesiones_faltantes` con el viernes y `alerta: true` |

La segunda es la apuesta, y hay una asimetría que la respalda: **EE.UU. cosecha
tres veces (21:20/21:35/21:50) y México una sola.** Si a las 16:10 locales el
proveedor todavía no publicó, no hay segunda oportunidad hasta el lunes. Se
agrega **una** corrida más (`10,40 22 * * 1-5`), no dos, para no triplicar el
consumo de DataBursatil — cuyo presupuesto de requests ya dio problemas de
medición (§4.4 de `docs/bmv-rotation.md`). El vigilante de `cron-status` se
actualizó con el mismo schedule, que es lo que `tests/crons-declarados.test.mjs`
exige.
