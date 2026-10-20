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
