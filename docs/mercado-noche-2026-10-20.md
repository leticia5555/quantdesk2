# La noche del 20 de octubre de 2026 — `/mercado`, de R3b a R8

Siete rebanadas, siete PRs **apilados y sin mergear**. Cada rama sale de la
anterior, así que el orden de merge no es negociable: si mergeas el cuarto sin
los tres de abajo, trae los cambios de los tres igual (están en su historia),
pero el diff que GitHub enseña deja de ser legible.

---

## 1. Los PRs, en el orden en que hay que mergearlos

| # | Rebanada | Rama | Preview |
|---|---|---|---|
| — | **La fuga a la red de la suite** (`arena-universo` era el único rojo de CI) | `claude/new-session-e3vdti` | — |
| [#290](https://github.com/leticia5555/quantdesk2/pull/290) | **R3b** — la página de noticias (artboard 9) | `claude/mercado-r3b-noticias` | https://quantdesk2-puu27iqot-leticia5555s-projects.vercel.app |
| [#291](https://github.com/leticia5555/quantdesk2/pull/291) | **R3(c)** — escritorio del artboard 5 + paleta del §4 | `claude/mercado-r3c-desktop` | https://quantdesk2-n5vpt9d0e-leticia5555s-projects.vercel.app |
| [#292](https://github.com/leticia5555/quantdesk2/pull/292) | **R4** — ficha de índice (artboard 6) | `claude/mercado-r4-indice` | https://quantdesk2-4ar35a9j9-leticia5555s-projects.vercel.app |
| [#293](https://github.com/leticia5555/quantdesk2/pull/293) | **R5** — insiders (artboard 7) + TRACKER | `claude/mercado-r5-insiders` | https://quantdesk2-hpvobqck8-leticia5555s-projects.vercel.app |
| [#294](https://github.com/leticia5555/quantdesk2/pull/294) | **R6** — `/analiza/:ticker` (artboard 8) | `claude/mercado-r6-analiza` | https://quantdesk2-m1dg2wgsu-leticia5555s-projects.vercel.app |
| [#295](https://github.com/leticia5555/quantdesk2/pull/295) | **R7** — compartir imagen | `claude/mercado-r7-compartir` | https://quantdesk2-f1sn5t9jy-leticia5555s-projects.vercel.app |
| [#296](https://github.com/leticia5555/quantdesk2/pull/296) | **R8** — `/mercado` como home | `claude/mercado-r8-home` | https://quantdesk2-p01sd4q19-leticia5555s-projects.vercel.app |

**El preview de #296 trae las siete rebanadas juntas**, porque está encima de
todas. Es el que conviene abrir para ver el conjunto; los otros seis sirven
para revisar cada cambio por separado.

**#296 es el único que yo no mergearía hasta haber visto los demás en un
preview**: es el que cambia lo que ve alguien que escribe el dominio a secas.

### Rutas nuevas

```
/mercado/noticias        R3b
/mercado/indice/:idx     R4   (SPX NDX DJI IPC BOVESPA KOSPI NIKKEI DAX HSI)
/mercado/insiders        R5
/analiza/:ticker         R6
/                        R8   → el mapa
/inicio                  R8   → la landing, que no se borra
/hoy                     R8   → redirect temporal al mapa
```

---

## 2. Las decisiones que tomé por ti

Siempre la opción conservadora: la que **no** muestra un dato dudoso.

### Datos que preferí declarar antes que estimar

1. **Los componentes de un índice no se inventan** (R4). No tenemos membresía
   verificada de ninguno de los nueve: la del S&P 500 y la del Nasdaq 100 sale
   de las tenencias del ETF, que hoy **sólo lee el Arena** — y me dijiste que
   no lo tocara. El panel lo dice, y con él la capitalización total y el P/U
   agregado. Rellenarlo con el universo del screener habría sido el error más
   caro: *parecería* la composición del índice y no lo es.
2. **`^DJI` sale gris con su causa** (R3c). Los nueve índices de la tira son
   los de R4 y el catálogo de `/api/macro-markets` tiene ocho. Enseñar ocho y
   llamarlos nueve no.
3. **El precio objetivo ausente va punteado** (R6), con la causa exacta: es el
   NO-GO que anticipó la Fase 0.8 (`quoteSummary` pide crumb desde el
   servidor). Nunca el precio actual disfrazado de objetivo.
4. **"Venta propuesta" va deshabilitada** (R5): eso es un **Form 144**, otro
   documento, y no lo cosechamos. Un chip que filtrara por una lista vacía
   diría "no hubo ventas propuestas" cuando lo cierto es que no las miramos.
5. **"Pares" y "Opciones" van punteadas** (R6) con su causa real. Una lista de
   comparables armada a ojo no es una comparación.
6. **`og:image` no está** (R7). El encargo pide que el preview sea **el mismo
   PNG** que genera el botón, y ese PNG se dibuja en el navegador del lector;
   servirlo como `og:image` pide renderizarlo en el servidor — otra dependencia
   que no puedo instalar ni probar sin red. Una imagen genérica sería peor: el
   preview diría algo distinto de lo que la URL abre.

### Diseño

7. **Las piezas nuevas de R3(c) son de escritorio.** El encargo las lista bajo
   la línea del escritorio, y la captura a 390 px enseñó por qué importa: las
   dos pestañas y el tercer toggle le quitaban **~100 px al mapa**. Debajo de
   1200 px no se pintan.
8. **Tocar un chip de ticker filtra la página** (R3b), no abre
   `/analiza/:ticker`: cuando escribí esa rebanada, R6 todavía no existía y un
   chip que lleva a un 404 es peor que uno que filtra. **Ahora que R6 existe,
   vale la pena cambiarlo** — está anotado abajo.
9. **La ventana por default de noticias son 72 h**, la misma de "Lo de hoy":
   una sola fuente de verdad. `?horas=` la ensancha hasta 7 días.
10. **El redirect de `/hoy` es 307, no 301** (R8). Es la decisión que más me
    importa de la noche: un permanente **se queda cacheado en el navegador de
    cada lector durante meses** y no se puede deshacer desde el servidor.
11. **La landing queda en `/inicio`** (R8). El encargo dice que nada se borra
    pero no dice dónde queda.
12. **El toggle de moneda de R4 convierte con el tipo de cambio de cada día**,
    no con el último: con un factor único el % del periodo no se mueve y el
    toggle quedaría encendido sin hacer nada — el bug que reportaste del
    toggle MXN en el mapa.

### Un cambio con alcance más allá de `/mercado`

13. **`qdPeriodChange` ya no devuelve un % con la etiqueta equivocada** (R4).
    El ancla salía de `Math.max(0, n - 1 - tradingDays)`: con la serie más
    corta que el periodo caía en el primer punto y el resultado se pintaba con
    la etiqueta **del periodo pedido**. Pedir `5A` sobre 180 sesiones devolvía
    el cambio de ocho meses rotulado "5A". Ahora devuelve `—` con su causa.

    **`app.html` lleva su propia copia del calculador y no la toqué** —el
    encargo dice que no se rediseña—, así que **el bug sigue vivo allá** y
    queda declarado en una prueba. Hay que decidir si se arregla.

---

## 3. Lo que tienes que correr tú

Con el preview de **#296** arriba (trae todo), en este orden:

```
/api/noticias?job=feeds
/api/noticias?vista=pagina
```
El segundo alimenta la página de noticias. Si trae `error`, la pantalla lo
dice con la causa en vez de enseñar una lista vacía.

```
/api/stock-tracker?cat=form4
```
Lo estrena R5. La primera corrida en frío sólo ve la ventana del feed
`getcurrent` de EDGAR; a partir de ahí la instancia acumula. **Si viene vacío
con las fuentes en verde, no es un error**: es una ventana fría y la pantalla
lo dice.

```
/api/mercado-indice?idx=SPX
/api/mercado-indice?idx=IPC&rango=5y
```
El segundo es el que dice **si Yahoo nos da cinco años de historia**. Si `5y`
contesta, la ficha de índice gana 1A, 3A y 5A de verdad; hoy, con un año, esas
filas salen en `—` con su causa.

```
/api/analiza?ticker=NVDA
/api/analiza?ticker=NVDA&cik=1045810
```
El segundo enciende el bloque de ingresos y utilidad con sus 10-Q. **Y el dato
que más me importa de tu corrida**: si `quoteSummary` contesta o da 401 desde
Vercel. Si da 401, la valuación y el precio objetivo salen punteados con esa
causa —que es lo correcto—, pero conviene saberlo para decidir si vale la pena
otra fuente.

### En el teléfono

- **`navigator.share` con archivo** (R7): Chromium headless no lo expone, así
  que mis corridas siempre tomaron el camino de descarga. En tu iPhone debería
  abrir la hoja de compartir.
- **El preview de WhatsApp**: necesita la URL pública arriba.

---

## 4. Lo que no pude probar, y por qué

Este entorno **no sale a internet**. Todo lo que toca una fuente externa va con
fixtures que imitan la forma real:

| Qué | Por qué | Cómo lo cubrí |
|---|---|---|
| Los feeds RSS/Atom vivos | sin red | cinco fixtures con la forma real de cada dialecto, incluidos CDATA y el `<link>` como atributo |
| EDGAR (`companyfacts`, Form 4) | sin red | un Form 4 con los pedazos que importan —cinco códigos, una derivada, un "le quedan" en cero, uno ausente— y `companyfacts` con una reexpresión y un anual |
| Yahoo `quoteSummary` | sin red, y además es el NO-GO de la Fase 0.8 | la ficha pinta los paneles punteados con la causa exacta |
| Finnhub (UPA, recomendaciones) | sin red | fixtures con trimestres que sí y que no tienen estimado |
| `range=5y` en `/api/candles` | el parámetro es nuevo y nadie lo ha ejercido | el parser es el que ya corre en prod; sólo cambia el `range` |
| Google Fonts | el proxy no trae su CA | se volvió una comprobación: la página tiene que verse bien con la fuente del sistema, y se verifica que la pila declare el respaldo |
| `navigator.share` con archivo | headless no lo expone | el camino de descarga sí, con el PNG verificado byte a byte |
| El redirect de `/hoy` | lo hace Vercel, no la página | se prueba la declaración en `vercel.json` |

Y una que no es de red: **no pude reproducir `$1.4Tvaluation`** con el parser
actual. Fui por los dos mecanismos que **sí** se pueden demostrar —un separador
invisible (`U+200B`, guion blando) y un "menor que" en prosa leído como
etiqueta, que no pega palabras sino que **borra**— y los dos están arreglados
con fixture propio. Si tu caso era un tercer mecanismo, **el titular crudo lo
fija**.

---

## 5. Lo que queda abierto (mi lista, por si sirve)

1. **El chip de ticker en noticias** debería abrir `/analiza/:ticker` ahora que
   R6 existe. Una línea.
2. **Los componentes de índice**: extraer el peso del CSV de tenencias
   (`api/_lib/etf-holdings.js` hoy sólo saca símbolos y sectores). Toca el
   camino de datos del Arena, así que lo dejé para cuando esa sesión termine.
3. **El mapa ticker→CIK** en `/analiza`, para no tener que pasar `?cik=`.
4. **`og:image` de verdad**, si decides que vale la dependencia.
5. **El bug de `qdPeriodChange` en `app.html`** (punto 13 de arriba).
6. **Fed y BMV** siguen sin fuente de noticias real. No se inventa.
7. **`yahoo_finance`** sigue fuera (404 en la cosecha del 20 de octubre); no le
   inventé una URL de reemplazo.
8. **Auto-hospedar IBM Plex**: hoy viene de Google Fonts con respaldo del
   sistema. Bajar los `.woff2` al repo quita una petición a un tercero, pero no
   puedo descargarlos desde aquí.

---

## 6. El estado de las pruebas al cerrar

```
164 archivos de prueba · 0 rojos
arena-carga-vercel        verde (lo que Vercel importa al construir)

Chromium, con tap real a 390 px y escritorio a 1440×1000:
  /mercado              191 comprobaciones
  /mercado/noticias      45
  /mercado/indice/:idx   38
  /mercado/insiders      26
  /analiza/:ticker       32
```

Cada rebanada cerró con la suite completa, `arena-carga-vercel`, Chromium a
390 px y a 1440 px, y las dos capturas pegadas en su PR.

**Tres cosas se arreglaron porque las vi en una captura y ninguna comprobación
las miraba**: las pestañas encimadas a 390 px, el mapa cortado por las tiras
(175 cuadros partidos), y la tarjeta de compartir diciendo
"Fuente: [object Object]" con la URL encimada sobre la firma. Las tres tienen
ahora una comprobación que las vigila.

---

# Apéndice — la revisión de Lety contra prod (20 de octubre, por la mañana)

Lety abrió el preview de #296 en Chrome contra producción, con todos los jobs
corridos, y encontró seis cosas. **Insiders y noticias funcionaban**; lo demás,
no del todo. Esto es lo que se arregló, en qué PR quedó cada cosa, y la lección
que dejó.

## La lección, primero

**Cuatro de los seis defectos eran el mismo defecto**: la pantalla leía una
llave que el endpoint nunca devolvió.

| Pantalla | Pedía | El endpoint manda | Se veía como |
|---|---|---|---|
| Ficha de índice | `{time, open, high, low, close}` | `{t,o,h,l,c,v}` | "cargando SPX…" para siempre |
| `/analiza` · UPA | `earnings`, `date`, `eps_est` | `history`, `period`, `eps_estimate` | "sin trimestres" para NVDA |
| Fondos · 13F | `name` | `fund` | "1067983" en vez de Berkshire |
| `/analiza` · EDGAR | nada: esperaba el CIK en la URL | — | "no devolvió conceptos us-gaap" |

Los cuatro pasaron **todas** las comprobaciones, porque los fixtures de las
corridas en Chromium estaban **escritos a mano con la forma que yo suponía**.
Un fixture inventado no puede desmentirme: repite lo que supuse. Y como el
síntoma era "no cargó", apuntaba al endpoint, que estaba contestando perfecto.

**Lo que cambia de raíz:** los fixtures de las tres corridas ahora **corren el
endpoint de verdad** —el mismo archivo que Vercel sirve— y fingen sólo la RED,
cada fuente en su forma cruda (Yahoo v8, el SIE con sus fechas DD/MM/AAAA, los
submissions y el infoTable de la SEC, Finnhub). Si alguien cambia la forma de
una vela o el nombre de una llave, la corrida lo ve el mismo día.

Y hay un archivo nuevo, `tests/mercado-contratos.test.mjs`, que compara las
llaves que cada pantalla lee contra las que su productor devuelve,
**ejecutándolo**. No prueba que el número esté bien: prueba que la pantalla y
el endpoint estén hablando del mismo campo, que es lo único que falló.

## Los seis, uno por uno

### 1 · La ficha de índice no pintaba — #292

`/mercado/indice/SPX` se quedaba en "cargando SPX…", la gráfica en blanco y
los nueve periodos en "—".

La vela de `/api/candles` es `{t,o,h,l,c,v}`; media pantalla leía la forma de
Lightweight Charts. Con la forma de verdad, `setData` recibía `time: undefined`
y **lanzaba**; como `pintar()` era una lista de llamadas seguidas, la gráfica
se llevaba por delante a la tabla, los datos y el pie. De ahí los tres
síntomas a la vez.

- La forma se fija **en la puerta** (`normalizaVelas`), y la de la librería se
  arma sólo al dibujar, en un único sitio.
- **Un panel que truena ya no congela la ficha**: cada uno se pinta por su
  cuenta, el que falla lo dice en su sitio, y el pie no puede quedarse en
  "cargando" con los datos en la mano.
- De camino: con Yahoo limitando las peticiones la pantalla decía "el handler
  respondió 502". La causa la tiraba `enProceso`, que se quedaba con el número.
  Ahora dice **"Yahoo respondió HTTP 429: está limitando las peticiones"**.

### 2 · `/analiza` casi vacía — #294

- **(a) El CIK se resuelve solo**, desde `company_tickers.json` de la SEC, con
  caché de 12 horas por instancia. No adivina: un ticker que no está devuelve
  null con su causa, y `.MX` la dice entera (la BMV no reporta a la SEC, así
  que no hay 10-Q que citar).
- **(b) La UPA** leía `earnings`/`date`/`eps_est` y el endpoint manda
  `history`/`period`/`eps_estimate`. El próximo reporte ya venía resuelto
  (`next_earnings`): deducirlo filtrando el historial era buscar fechas futuras
  donde nunca las hay.
- **(c) El 429 de Yahoo**, con tres capas: caché de 10 minutos por ticker —la
  que de verdad lo quita—, reintento con espera creciente **sólo** ante 429 y
  5xx (un 401 o un 404 no mejoran por insistir), y la última respuesta buena
  dicha **como vieja, con su edad**. Si nada alcanza, la valuación se arma con
  los fundamentales de **Finnhub** y la pantalla avisa arriba de la tabla que
  cambió de proveedor.

  **Dos trampas de unidades**, con prueba propia: Finnhub da la capitalización
  en MILLONES (el tropiezo que ya costó que Apple midiera lo mismo que una
  small cap) y los márgenes, ROA, ROE y dividendo en POR CIENTO, mientras
  Yahoo los da en fracción. Sin convertir, un ROE de 90.5 % se pintaría
  9050 %.

### 3 · Noticias: las fotos, las destacadas y el pie — #290

- **Las cuatro destacadas eran del mismo medio.** `conFoto.slice(0,4)` le daba
  la franja entera al que más publica con imagen (Valor BR publica todo con
  foto). Ahora se elige **por fuente**, y si no hay cuatro fuentes vivas se
  repite medio **y se dice**.
- **Sin foto se reservaba el hueco de la foto.** El bloque de color del
  artboard se pintaba también cuando el feed nunca trajo imagen: cuatro
  cuadros grises. El bloque se queda como **relevo** de una foto que falla
  —ahí el hueco ya está medido—, no como anuncio de que no hay nada. Y la
  tarjeta sin foto ya no se estira al alto de las que la tienen.
  Dos mecanismos más del cuadro gris: `loading="lazy"` en un carrusel
  horizontal (tres de las cuatro nacen fuera de la ventana) y la foto que
  llega tarde, que no dispara `error`. Ahora hay plazo.
- **El pie se encimaba sobre la lista.** `align-items:start` del layout base
  sobrevivía dentro del escritorio sin scroll, así que cada columna se medía
  por su contenido y se salía de su fila hacia abajo. Con nueve notas no se
  veía; con las de producción (16 fuentes, decenas de notas) la lista de
  medios llegaba **600 px más abajo del pie**. El fixture tenía tres notas por
  columna: por eso la comprobación pasaba sobre una página corta.

### 4 · El chip, una sola función — #290 y adelante

Las cuatro pantallas nuevas pintaban el texto crudo de `estadoDeBolsa`, que
con la bolsa cerrada y sin pasarle el último cierre dice **"no se sabe de qué
día es el último cierre"**: cierto, y una queja en pantalla sobre un dato que
esa pantalla no está mostrando.

`chipDeMercado` sale de donde estaba —dentro del `pintarChip` del mapa— y pasa
a `qd-mercados.js`. La fecha del dato se nombra **sólo donde hay un dato con
fecha** (la ficha de índice y la de ticker la sacan de su última vela); donde
no, el chip dice "cerrado" a secas y la causa va al `title`. Una prueba fija
que ninguna pantalla vuelva a componer ese renglón a mano.

### 5 · Los fondos salían como su CIK — #293

La página leía `f.name`; el endpoint manda `fund` (y `persona`). Ahora dice
**"Berkshire Hathaway · Warren Buffett"**.

### 6 · Jerga en pantalla — #293, #294 y #290

| Decía | Dice |
|---|---|
| la ventana del feed `getcurrent` de EDGAR | los Form 4 que EDGAR publica en su lista de lo recién presentado |
| "le quedan" sale de `sharesOwnedFollowingTransaction` | "le quedan" es la tenencia que el propio formulario 4 declara después de la operación |
| el caso NO-GO de la Fase 0.8: Yahoo quoteSummary pide crumb | Yahoo pide una credencial que sólo le da a un navegador, no a un servidor como el nuestro |
| lectura fallida: Falta DATABASE_URL (connection string) | no se pudo leer nuestra base de datos en este momento |
| el P/U agregado necesita el `metric` de Finnhub | el P/U agregado necesita los fundamentales de cada componente |
| 14 notas leídas de 9 fuentes GO | 14 notas leídas de 9 fuentes registradas |
| (RSS/Atom de api/_lib/news-sources.json) | (titulares de los feeds RSS/Atom de las fuentes registradas) |

Hay una comprobación nueva en las tres corridas que **recorre todo el texto
visible, incluidos los `title`**, buscando comillas de código, rutas del repo
y nombres internos de endpoints o campos.

**Lo que NO se tocó, y es una decisión:** las fuentes declaradas
—`yahoo:v8/chart`, `banxico:SF43718`, `edgar:companyfacts`, `finnhub:metric`—
siguen visibles. Son la procedencia que pide la regla 3, van en su columna y
no en la prosa, y llevan meses en el pie del mapa. La comprobación las exime a
propósito. **Si quieres que también esas se traduzcan, es un cambio chico y
dímelo.**

## Cómo quedó el conteo

| | Antes | Ahora |
|---|---|---|
| Archivos de prueba | 164 | **165** |
| `/mercado` | 191 | **191** |
| `/mercado/noticias` | 45 | **55** |
| `/mercado/indice/:idx` | 38 | **42** |
| `/mercado/insiders` | 26 | **29** |
| `/analiza/:ticker` | 32 | **42** |

Todo en verde, más `arena-carga-vercel`.

## Lo que sigue sin poder probarse aquí

Lo mismo de anoche —este sandbox no sale a internet— con una diferencia que
importa: ahora las corridas ejercen **el código de producción** contra esas
fuentes fingidas, en vez de un fixture escrito a mano. Lo que falta por ver en
prod es el comportamiento de las fuentes reales:

- si `quoteSummary` contesta, da 429 o da 401 desde Vercel (las tres rutas
  están probadas; cuál toca, lo dice prod);
- si la lista de emisoras de la SEC baja completa desde la IP de Vercel;
- si `range=5y` trae cinco años de verdad;
- `navigator.share` con archivo, que Chromium headless no expone;
- el redirect de `/hoy`, que lo hace Vercel y no la página.
