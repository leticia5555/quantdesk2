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
un fixture y maneja un Chromium real. **26 comprobaciones en verde** (22 en R1,
cuatro más en R1b), entre ellas:

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
