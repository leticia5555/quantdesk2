# FASE 0 — XBRL de emisoras BMV: ¿se puede bajar y parsear de forma programática?

> **Alcance:** SOLO viabilidad de datos. No hay pipeline, no hay diseño de tablas,
> no se tocó Neon ni el app. Censo + smoke, nada más.
>
> **Veredicto: GO PARCIAL — la adquisición está resuelta para el trimestre
> corriente; el histórico es el problema real y no es técnico.**
>
> - **Bajar el trimestre más reciente: resuelto.** BMV sirve el XBRL gratis, sin
>   sesión y sin captcha, en una ruta estática (§1.1). Eso cierra la mitad de
>   adquisición del criterio de GO.
> - **Bajar el histórico: no resuelto, y no se arregla con código.** BMV **vende**
>   el histórico (§1.2). CNBV lo tiene público pero su `robots.txt` prohíbe el
>   acceso automatizado (§1.3). Es una decisión de licencia y de riesgo, no de
>   parsing (§8.1).
> - **Números contra PDF: sin verificar.** Es lo único que falta del criterio y
>   lo cierra el smoke corriendo en tu máquina (§9).
>
> **Lo que cambia el plan de inmediato (§3.2):** como el feed gratis de BMV sólo
> expone el trimestre vigente, **es un feed de mantenimiento, no de backfill**.
> Cada trimestre que no captures es un trimestre que después vas a tener que
> comprar. Conviene empezar a capturar ya, antes de decidir qué hacer con el
> histórico.

---

## 0. Honestidad: qué está verificado y qué no

| Marca | Significado |
|---|---|
| **[VERIFICADO]** | Corrido en esta máquina, con la salida pegada. |
| **[VERIFICADO-FUERA]** | Lo comprobaste tú fuera del sandbox y lo incorporo como dato. |
| **[SECUNDARIO]** | Sale de búsqueda web, no de tocar el recurso. |
| **[NO VERIFICADO]** | Suposición razonable, marcada para no confundirla con dato. |

**Este documento no contiene un solo número financiero de WALMEX ni de FEMSA.**
No bajé ningún archivo real. La tabla de verificación (§7) va vacía a propósito.

---

## 1. Censo — dónde publica BMV el XBRL trimestral

### 1.1 BMV: el trimestre corriente es gratis y sin sesión **[VERIFICADO-FUERA]**

BMV expone el XBRL del **trimestre más reciente** de cada emisora como archivo
estático bajo `docs-pub`, sin login, sin cookie de sesión y sin captcha:

```
https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_<ID>_<AAAA>-<TT>_1.zip

ej. Bimbo 2T2026:
https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_1576474_2026-02_1.zip
```

Del patrón se leen tres cosas:

- `<TT>` es el **trimestre**, no el mes (`2026-02` = 2T2026).
- `<ID>` es un **id interno de BMV** (`1576474` = Bimbo). **No es el ticker y no
  es el mismo id de la ficha de emisora** (`WALMEX-5214`, `FEMSA-5305`,
  `KOF-5525` **[SECUNDARIO]**). Son dos espacios de identificadores distintos y
  **no tengo el mapa entre ellos**. Ese mapa es el entregable que falta para
  automatizar la descarga; por eso el script no la automatiza (§5.3).
- El sufijo `_1` parece un consecutivo de envío. **[NO VERIFICADO]** — importa,
  porque una reexpresión podría publicarse como `_2`.

**Límite duro: sólo se lista el último trimestre por emisora.** No hay índice
histórico en esta ruta. Consecuencias en §3.2.

### 1.2 El histórico lo vende BMV **[VERIFICADO-FUERA]**

La ficha de emisora ofrece **"Comprar XBRL Histórico"**, que lleva al catálogo de
`pubsys2.bmv.com.mx` (un producto por emisora: `productdetails.aspx?i=1417`
WALMEX, `i=1105` FEMSA **[SECUNDARIO]**).

Queda confirmada la bandera amarilla de la versión anterior de este memo, y en la
dirección menos cómoda: **gratis lo vigente, de pago lo histórico.** No es un
bloqueo técnico que se rodee con mejor código; es el modelo de negocio.

### 1.3 CNBV: el histórico está público, pero `robots.txt` lo prohíbe **[VERIFICADO-FUERA]**

`xbrl.cnbv.gob.mx` expone el histórico con una convención **mucho mejor** que la
de BMV, porque el nombre se deriva de la **clave de pizarra** y el periodo:

```
ifrsxbrl_ALFA_2020-1.xbrl      (+ un idEnvio asociado)
```

Eso es exactamente lo que le falta a BMV: nombre construible desde el ticker, sin
id opaco de por medio. **Pero el `robots.txt` del host prohíbe el acceso
automatizado.** Qué implica eso, en serio, en §8.1.

### 1.4 EMISNET, BIVA

- **EMISNET es de subida, no de bajada** **[SECUNDARIO]**: el emisor exporta su
  XBRL en ZIP y lo sube ahí. La consulta pública es el portal de BMV.
- **BIVA** publica información de las emisoras que cotizan ahí **[SECUNDARIO, no
  verificado]**. No es plan B; ver §8.2.

### 1.5 Rate limits y captcha

**Sigue sin verificar.** No hay evidencia de captcha en la ruta `docs-pub` (baja
como archivo estático), y no pude leer términos ni `robots.txt` de BMV. El probe
del script (§5) ahora pega con **dos user-agents** e imprime **todas** las
cabeceras `Set-Cookie`, precisamente para contestar esto con evidencia.

---

## 2. Taxonomía y tags

### 2.1 Qué taxonomía — y qué queda fuera de la v1

La taxonomía es una **extensión mexicana del IFRS Accounting Taxonomy**
**[SECUNDARIO]**. Se esperan dos namespaces en el instance: `ifrs-full` y la
extensión mexicana (prefijo exacto **[NO VERIFICADO]**).

CNBV publica variantes por perfil de emisor (ICS, SAPIB, instrumentos de corto
plazo, FIBRAS) **[SECUNDARIO]**.

> **Decisión tomada: la v1 usa SÓLO la taxonomía ICS.** Bancos y FIBRAs quedan
> fuera. Esto elimina de raíz el problema de tener que escribir un extractor por
> perfil, y es la razón por la que el script puede tener una sola lista de tags.
> El costo es de cobertura, no de corrección: el universo de la v1 simplemente no
> incluye esos nombres.

**Qué versión de la taxonomía aplica en 2024-2026: no lo sé** y no lo voy a
suponer. El script imprime los `xmlns` reales del archivo, que es la forma
correcta de contestarlo. **Por eso importa el 4T2016 de CNBV en el sample
(§5.2): es la prueba directa de si la versión cambió en 10 años y si los tags
sobreviven al cambio.**

### 2.2 Los tags de los 9 campos

Los seis primeros son elementos IFRS estándar; esperarlos es razonable.
**Ninguno está confirmado contra un archivo real de BMV.**

| Campo | Tag candidato principal | Confianza |
|---|---|---|
| Ingresos | `ifrs-full:Revenue` (alt. `RevenueFromContractsWithCustomers`) | IFRS estándar, **[NO VERIFICADO]** en BMV |
| Utilidad neta atribuible | `ifrs-full:ProfitLossAttributableToOwnersOfParent` | IFRS estándar, **[NO VERIFICADO]** |
| Activos totales | `ifrs-full:Assets` | IFRS estándar, **[NO VERIFICADO]** |
| Pasivos totales | `ifrs-full:Liabilities` | IFRS estándar, **[NO VERIFICADO]** |
| Capital contable | `ifrs-full:Equity` (alt. `EquityAttributableToOwnersOfParent`) | IFRS estándar, **[NO VERIFICADO]** |
| Efectivo | `ifrs-full:CashAndCashEquivalents` | IFRS estándar, **[NO VERIFICADO]** |
| Deuda con costo CP / LP | — ver §2.3 | **sin tag único** |
| Acciones en circulación | `NumberOfSharesOutstanding` | **[NO VERIFICADO]**, ver §2.4 |

El script **no confía en esta tabla**: prueba candidatos en orden, reporta cuál
pegó, y si ninguno pega marca **FALTA** y sugiere `--dump-tags`.

### 2.3 "Deuda con costo" no existe como tag

IFRS no tiene un elemento `DeudaConCosto`. Hay que **sumar**: préstamos bancarios
CP/LP, deuda bursátil, **porción circulante de la deuda de largo plazo** (fácil de
doble-contar) y **pasivos por arrendamiento IFRS-16**.

IFRS-16 es el que más probablemente rompa la verificación: el XBRL puede estar
impecable y **no cuadrar** con el "Deuda Total" del PDF porque el PDF excluye
arrendamientos y el XBRL no. Si pasa, **no es bug del parser y no se parcha**: es
una definición que hay que congelar (D3). Es diferencia *explicable* bajo el
criterio de GO, pero sólo si se explica.

### 2.4 Acciones en circulación: tres números distintos

`NumberOfSharesIssued` (emitidas), acciones en circulación (emitidas − recompra) y
`WeightedAverageShares` (promedio ponderado, denominador del EPS) son **tres cosas
distintas**. Para un screener value importa el de circulación al cierre.

### 2.5 Las tres fechas, y cuál evita look-ahead

| Fecha | Dónde vive | Sirve para |
|---|---|---|
| **Envío a BMV/CNBV** | **NO está en el instance.** Listado de la página de la emisora, con hora (ej. `23-Jul-2026 14:11`) | **La correcta contra look-ahead (D8)** |
| Autorización del consejo | `DateOfAuthorisationForIssueOfFinancialStatements` | Proxy: es *anterior* al envío |
| Cierre del periodo | `DateOfEndOfReportingPeriod2013` | **No es publicación.** Dato secundario |

> **Decisión tomada (D8): la fecha buena es la de envío, no la del consejo.**
> El script ahora reporta la de autorización como proxy explícito, imprime la de
> cierre **etiquetada como secundaria** para que nadie la confunda, y dice en
> claro que la de envío **no la resuelve** y hay que capturarla del listado.

Esto no es un detalle cosmético: usar la fecha de cierre como si fuera la de
publicación mete ~1-2 meses de look-ahead en cada rebalanceo, que en un backtest
de rotación trimestral es una fracción enorme del periodo de tenencia.

---

## 3. Historia disponible

### 3.1 El piso: no hay 14 años **[SECUNDARIO, consistente entre fuentes]**

| Hito | Fecha |
|---|---|
| BMV arranca el proyecto XBRL | 2012 |
| Primera aplicación a estados financieros trimestrales | **1T2014** |
| ~145 emisoras obligadas a reportar en XBRL | **desde 1T2016** |

Ventana realista: **~2016 en adelante completa**, 2014-2015 con huecos. Son
**~10 años**, no 14. Para un backtest trimestral, ~40 rebalanceos, cubriendo
esencialmente un solo régimen largo y sin 2008-09.

**Recomendación: fijar el alcance en 2016+ y no pelear 2014-2015.**

### 3.2 El techo de adquisición: el feed gratis es de mantenimiento, no de backfill

Este es el hallazgo operativo de esta ronda. Cruzando §1.1 y §1.2:

- BMV gratis = **sólo el trimestre vigente**.
- BMV histórico = **de pago**.
- CNBV histórico = **público pero robots-blocked** (§8.1).

O sea que hay **dos problemas distintos** que conviene no mezclar:

1. **Mantener la serie hacia adelante** — resuelto, gratis, ~35 descargas por
   trimestre. Se puede empezar hoy.
2. **Rellenar 2016→hoy** — no resuelto, y es una decisión de licencia.

**Consecuencia práctica:** el costo del backfill sólo crece. Cada trimestre que
pasa sin capturar es un trimestre que después hay que comprar o cosechar. **Vale
la pena arrancar la captura del trimestre corriente aunque el backfill siga sin
decidirse** — es barato, es legal y es irreversible en el buen sentido.

---

## 4. Egress del sandbox: no llega a BMV **[VERIFICADO]**

```
$ curl -sS -o /dev/null -w "%{http_code}" https://www.bmv.com.mx/
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.bmv.com.mx:443" }, ... ]
```

Bloqueados todos: `bmv.com.mx`, `emisnet`, `cognos.bmv.com.mx`,
`xbrl.cnbv.gob.mx`, `cnbv.gob.mx`, `gob.mx`, `biva.mx`, `walmex.mx`, `femsa.com`.
`WebFetch` da `EGRESS_BLOCKED`. `registry.npmjs.org` sí responde: es política de
dominio, no red caída.

**Al leer la salida del probe:** los `403` que salen *aquí* son **del proxy
local**, no de BMV — llegan en ~3ms con `content-type: text/plain` y 101 bytes.
En tu máquina un 403 real se ve distinto.

---

## 5. El smoke — `scripts/xbrl-smoke.mjs`

Sin dependencias. Dos piezas propias, ambas justificadas en el encabezado del
archivo: **lector de ZIP** (central directory + `zlib.inflateRawSync`) y **parser
de instance por regex**. No entra Arelle porque para leer *hechos* sólo hace falta
resolver contextos y elegir qnames; este smoke no valida la taxonomía, valida que
los números salgan y cuadren.

### 5.1 Qué hace bien, a propósito

- **No elige por ti en la ambigüedad de periodo.** Un instance de 2T trae el
  trimestre (3m) *y* el acumulado (6m) con el mismo cierre. El script imprime las
  dos, ordena determinísticamente (ventana más corta primero) y marca la celda
  con `*` / `AMBIGUO` **en la tabla resumen**, no sólo en el detalle.
- **La ventana entra al criterio de GO.** Dos archivos pueden traer el mismo
  `ifrs-full:Revenue` y aun así ser incomparables si uno reporta 3m y el otro 6m.
  El criterio ahora exige **mismo tag Y misma ventana**, y reporta
  `VENTANA INESTABLE` aparte de `TAG INESTABLE`.
- **Ignora contextos con dimensiones** (segmento, moneda, subsidiaria): sólo
  consolidado total.
- **Trata `xsi:nil` como ausente**, y avisa si el tag existe pero vino nil.
- **No reescala.** Imprime valor crudo con `unitRef` y `decimals`.
- **Separa las tres fechas** (§2.5).
- **El probe pega con dos user-agents** y usa `getSetCookie()` — no
  `headers.get('set-cookie')`, que colapsa y pierde cookies. Si el sitio contesta
  200 al UA de navegador y 403 al de script, lo marca: eso es dato de viabilidad
  *y* de términos de uso. El script **mide y reporta; no se disfraza**.

### 5.2 El sample

| Archivo | Fuente | Para qué |
|---|---|---|
| WALMEX 2T2026 | BMV `docs-pub` | números vs PDF |
| FEMSA 2T2026 | BMV `docs-pub` | números vs PDF + estabilidad de tags entre emisoras |
| lo que salga, 4T2016 | CNBV | **versión de taxonomía a 10 años**, no comparación de números |

El modo `--manual` ya entiende los **nombres nativos**, no hay que renombrar:

```
ifrsxbrl_1576474_2026-02_1.zip   (BMV: id numérico -> se reporta como id:1576474)
ifrsxbrl_ALFA_2016-4.xbrl        (CNBV: clave de pizarra -> ALFA)
walmex_2026_2.zip                (libre, por si prefieres renombrar)
```

### 5.3 Por qué la descarga automática sigue sin implementarse

Ya conocemos el patrón de URL (§1.1), pero **no el mapa ticker → id de
`docs-pub`**. Con Bimbo = `1576474` y nada más, construir la URL de WALMEX
requeriría adivinar el id. Bajando los dos a mano con la pestaña Network abierta y
anotando sus ids, se ve si el mapa es estable y ahí sí automatizar es trivial.

### 5.4 Qué se verificó de verdad **[VERIFICADO]**

Sobre **fixtures sintéticos** (en el scratchpad, nunca en el repo), el parser:

- separó 3m vs 6m, ordenó determinísticamente y marcó `AMBIGUO` en la tabla;
- con un archivo a 3m y otro a 6m con el **mismo tag**, reportó
  `VENTANA INESTABLE: 3m | 6m (mismo tag)` y volteó el veredicto a NO-GO;
- excluyó el contexto con `explicitMember` (tomó el consolidado, no el segmento);
- trató `nil` como FALTA avisando que el tag existía;
- reportó la fecha de autorización primero y la de cierre etiquetada como
  secundaria;
- leyó ZIP (deflate, con `.xsd` de ruido) y `.xbrl` suelto;
- infirió emisora/periodo de los nombres nativos de BMV y de CNBV.

**Esto prueba la mecánica del parser y del gate, NADA sobre los datos de BMV.**
Los fixtures los escribí yo con valores obviamente falsos (1000, 5000, 1900). No
son datos de WALMEX ni FEMSA y no deben citarse como tales.

---

## 6. Resultado del smoke contra archivos reales

**No se corrió.** 0 archivos bajados desde este entorno (§4). No hay números que
reportar. Se llena con §9.

---

## 7. Tabla de verificación XBRL vs PDF

**Vacía porque no tengo los dos lados**: ni el XBRL (§4) ni los PDFs de IR
(`walmex.mx` y `femsa.com` también bloqueados).

| Campo | XBRL 2T2026 | PDF 2T2026 | Diferencia | Explicación |
|---|---|---|---|---|
| Ingresos | | | | ¿3m o 6m? §5.1 |
| Utilidad neta atribuible | | | | ¿3m o 6m? |
| Activos totales | | | | |
| Pasivos totales | | | | |
| Capital contable | | | | ¿total o controladora? |
| Efectivo | | | | |
| Deuda con costo CP | | | | ¿incluye IFRS-16? §2.3 |
| Deuda con costo LP | | | | ¿incluye IFRS-16? §2.3 |
| Acciones en circulación | | | | ¿emitidas o en circulación? §2.4 |

PDFs:
- **WALMEX** — https://www.walmex.mx/informacion-financiera/trimestral.html
- **FEMSA** — https://femsa.com/es/inversionistas/reportes-y-filings/reportes-trimestrales/

Explicables: miles vs millones (`decimals`), reexpresión, trimestre vs acumulado.
No explicable: un campo que sólo cuadra con un factor que no sale de ningún atributo.

---

## 8. Criterios (escritos antes, sin mover) y estado

**GO:** los archivos bajan sin sesión ni captcha **·** los 9 campos salen con los
mismos tags en ambas emisoras **·** los valores cuadran contra el PDF exacto o con
diferencia explicable.

| Criterio | Estado |
|---|---|
| Bajan sin sesión ni captcha | **CUMPLE para el trimestre vigente** (§1.1). Para el histórico, ver §8.1 |
| 9 campos, mismos tags (y misma ventana) | **no observado** — lo dicta el smoke |
| Valores cuadran vs PDF | **no observado** — lo dicta el smoke |

**Veredicto: GO PARCIAL.** La adquisición del trimestre corriente está probada
libre. Lo que queda abierto es (a) la verificación numérica, que es trabajo de
§9, y (b) el histórico, que **no es una pregunta técnica**.

### 8.1 Qué implica el `robots.txt` de CNBV para un cosechador

Hay que separar dos cosas que se confunden seguido.

**Viabilidad técnica: total.** `robots.txt` no es un control de acceso. Es un
archivo de texto donde el sitio declara su política para robots; no autentica, no
bloquea, no cifra. Un script que lo ignore funciona igual. Si la pregunta fuera
sólo "¿se puede?", la respuesta es sí, y además con la mejor convención de
nombres de las tres fuentes (§1.3).

**Términos de uso y riesgo: es el problema.** Ignorarlo es una violación de la
política declarada del sitio, y el peso de eso cambia según el uso. Para una
consulta manual ocasional es intrascendente. Para lo que tú quieres construir —
**una API LATAM comercial** — es otra cosa: estarías redistribuyendo datos de un
**regulador** contra su política explícita de acceso automatizado, de forma
sostenida y a escala. El riesgo práctico inmediato es bloqueo por IP y quedarte
sin fuente a media operación; el riesgo de fondo es de licencia y reputación, y no
es un riesgo que un script pueda mitigar.

Un matiz que juega **a favor** y que no hay que tirar: **el dato en sí es
público por mandato**. CNBV publica estos reportes porque está obligada, no como
cortesía. Eso hace razonable *pedir acceso* en vez de asumir la negativa, y en
México hay mecanismos baratos y reales para hacerlo (solicitud de información
pública / transparencia, o preguntar por una ruta de datos abiertos). Es la
diferencia entre "no se puede" y "no he preguntado".

**Rutas, por defensibilidad:**

1. **Preguntar a CNBV** por una vía autorizada o de datos abiertos. Barato,
   lento, y si sale, resuelve el problema de forma permanente y limpia.
2. **Comprar el histórico a BMV una sola vez** y mantenerlo con el feed gratis
   (§3.2). Es la opción con licencia clara, y el costo es de una vez, no
   recurrente. **Para un producto comercial, es probablemente la correcta.**
3. **Cosecha manual o de bajísima frecuencia desde CNBV para investigación**, sin
   alimentar el producto comercial. Es el uso más defendible del scraping.
4. **Ignorar el `robots.txt`.** Funciona técnicamente y carga todo el riesgo
   anterior. **Es decisión del dueño del proyecto, no del script, y no la voy a
   dejar cableada en el código.** El probe se limita a bajar el `robots.txt` y
   mostrártelo.

**Caveat honesto:** no pude leer el `robots.txt` (§4), así que estoy razonando
sobre tu reporte de que "bloquea acceso automatizado". **Los directivos exactos
importan**: no es lo mismo un `Disallow: /` global que un `Disallow` sobre rutas
de búsqueda dejando los archivos servibles, ni lo mismo si aplica a `*` o a
agentes nombrados. El probe ahora incluye esa URL para que lo leas antes de
decidir nada.

### 8.2 BIVA no es plan B

El problema no es técnico sino de universo: BIVA es la bolsa alterna y lista una
fracción de las emisoras. Con el universo ahora definido como "emisoras ICS que
reportan XBRL" (§10), BIVA podría sumar *algunos* nombres, pero no sustituye a
BMV/CNBV como fuente principal. Sirve después, para ampliar cobertura de la API
LATAM. **Orden: BMV (vigente) → decisión de histórico (§8.1) → BIVA sólo como
cobertura extra.**

---

## 9. Cómo cerrar lo que falta — corre esto en local

En `~/quantdesk2`, rama `claude/xbrl-fase0`, Node 24:

```bash
# 1) Censo de red con evidencia. Dos UA por URL; incluye el robots.txt de CNBV.
node scripts/xbrl-smoke.mjs --probe
```

Anota: ¿el zip de Bimbo baja 200 con `content-type` de zip? ¿hay cookie de
sesión? ¿el UA cambia la respuesta? ¿qué dice exactamente el `robots.txt`?

```bash
# 2) Baja a mano, con la pestaña Network abierta, WALMEX y FEMSA 2T2026.
#    ANOTA EL <ID> DE CADA URL: con dos ya se ve si el mapa ticker->id sirve.
mkdir -p .xbrl-fase0
#    Si consigues un 4T2016 de CNBV, mételo a la misma carpeta.
#    No hace falta renombrar: los nombres nativos ya se entienden.

# 3) Extracción + tablas + veredicto automático del criterio
node scripts/xbrl-smoke.mjs --manual .xbrl-fase0

# 4) Si algún campo sale FALTA, descubre el tag real (no lo supongas):
node scripts/xbrl-smoke.mjs --file .xbrl-fase0/<archivo> --dump-tags
```

`.xbrl-fase0/` está en `.gitignore`. El raw no entra al repo.

---

## 10. Universo y qué me preocupa de escalar

> **Decisión tomada: el universo NO es la membresía del IPC.**
> **Universo = todas las emisoras ICS que reportan XBRL en cada fecha**, con
> filtro de **liquidez y capitalización calculado en esa misma fecha**.

Esto es construcción **point-in-time** y es estrictamente mejor que usar el IPC:
el índice se rebalancea con criterios propios y su composición histórica no la
encontré publicada en ningún lado. Definir el universo por "quién reportó ese
trimestre, filtrado por lo que se podía observar ese día" elimina la dependencia
de ese dato y ataca el survivorship bias en la raíz.

Dos consecuencias que hay que tener presentes (no reabren la decisión, la operan):

- **El backfill tiene que incluir emisoras que ya se deslistaron.** Si sólo
  cosechas los nombres vivos de hoy, reintroduces exactamente el sesgo que esta
  definición evita. Cosechar hacia adelante (§3.2) es point-in-time por
  construcción y no sufre esto; el histórico comprado o cosechado sí, y hay que
  exigir explícitamente que traiga los nombres muertos.
- **El filtro de liquidez y capitalización necesita precios y acciones por
  fecha**, que no salen del XBRL. Las acciones sí (§2.4); los precios y el volumen
  son otra fuente. Es una dependencia a resolver, no un problema de esta fase.

**Lo demás que me preocupa, por probabilidad de morder:**

1. **El techo de adquisición del histórico (§3.2, §8.1).** Es el riesgo número
   uno del proyecto y no se resuelve programando.
2. **La ventana histórica real es ~10 años, no 14 (§3.1).**
3. **El mapa ticker → id de `docs-pub` (§1.1).** No hay fórmula; hay que
   construirlo y mantenerlo, y se pudre cuando una emisora cambia de clave.
   35 filas es manejable; que nadie lo note cuando cambie, no.
4. **Cambios de versión de taxonomía a 10 años.** Elementos renombrados o
   deprecados rompen un cosechador que hardcodee tags. El script ya usa listas de
   candidatos; a 10 años eso tiene que volverse un mapa versionado. **El 4T2016
   del sample es justamente la primera medición de este riesgo.**
5. **Emisoras que cambiaron de nombre.** Con universo point-in-time el sesgo de
   supervivencia está atacado, pero el *encadenado de identidad* sigue: hay que
   poder seguir a la misma empresa cuando cambia de clave, o la tratas como dos.
6. **Rate limits desconocidos.** El volumen es chico (~35/trimestre en curso;
   ~1,400 archivos si se backfillea de una). No me preocupa el volumen; me
   preocupa no saber el límite. Sale del probe.

**Lo que NO me preocupa:** el parseo. Un instance es XML regular y el extractor
dependency-free ya demostró que hace el trabajo. Si esto falla, va a fallar por
licencia, por adquisición del histórico o por definiciones contables — no por
código.

---

## 11. Decisiones a congelar antes de la Fase 1

Cerradas en esta ronda:

- ~~**D7** — composición histórica del IPC~~ → **eliminada.** Universo
  point-in-time por emisoras ICS que reportan (§10).
- **D8** — fecha anti-look-ahead = **fecha de envío a BMV/CNBV**, no la del
  consejo. Si el instance no la trae, se captura del listado de la emisora con
  hora (§2.5). **Cerrada.**
- **Perfil de taxonomía** — sólo **ICS**. Bancos y FIBRAs fuera de la v1 (§2.1).
  **Cerrada.**

Abiertas, y ninguna se cierra sin correr §9:

- **D1** — Fuente del histórico: ¿comprar a BMV, pedir a CNBV, o no backfillear? (§8.1)
- **D2** — Ventana: ¿2016+ y listo? (§3.1)
- **D3** — "Deuda con costo": ¿IFRS-16 dentro o fuera? (§2.3)
- **D4** — ¿Ingresos y utilidad del trimestre o acumulados? (§5.1)
- **D5** — ¿Qué medida de acciones? (§2.4)
- **D6** — Capital contable: ¿total o sólo controladora? (§2.2)
- **D9** — ¿Se arranca ya la captura del trimestre vigente, sin esperar a D1? (§3.2)
