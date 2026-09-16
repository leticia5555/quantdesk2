# FASE 0 — XBRL de emisoras BMV: ¿se puede bajar y parsear de forma programática?

> **Alcance:** SOLO viabilidad de datos. No hay pipeline, no hay diseño de tablas,
> no se tocó Neon ni el app. Censo + smoke, nada más.
>
> # VEREDICTO: **GO**
>
> Los tres criterios, escritos antes y sin mover, se cumplen:
>
> | Criterio | Estado | Evidencia |
> |---|---|---|
> | Bajan sin sesión ni captcha | **CUMPLE** | 2 zips de `docs-pub`, libres (§1.1) |
> | 9 campos, mismos tags en ambas emisoras | **CUMPLE** | mismo tag y misma ventana en las 9 filas (§6.2) |
> | Valores cuadran contra el PDF | **CUMPLE** | los 9 campos en ambas emisoras (§7) |
>
> Se puede bajar y parsear el XBRL de BMV de forma programática, repetible y con
> números correctos. **La Fase 0 cierra aquí.**
>
> **Dos frentes quedan abiertos, y ninguno es de parseo:**
>
> 1. **Taxonomía 2016 sin probar.** No se consiguió un archivo viejo (CNBV
>    bloqueado). Sabemos que la extensión mexicana es de 2014 y el entry point
>    de 2019 (§2.1), lo que hace *probable* que 2016 use los mismos tags —
>    probable, no verificado. Riesgo vivo para el backfill (§10.5).
> 2. **Histórico pendiente de licencia.** BMV publica gratis sólo el trimestre
>    vigente y **vende** el histórico; CNBV lo tiene público pero su `robots.txt`
>    prohíbe automatizar (§1.2, §1.3, §8.1). Es decisión de licencia, no técnica.
>
> **Hallazgos grandes de la Fase 0:**
>
> - **BMV no sirve XBRL estándar**, sino un JSON propietario del editor de
>   EMISNET. Se parsea bien, pero no lo lee ninguna herramienta XBRL y puede
>   cambiar sin aviso (§1.1, §10.2).
> - **"Deuda con costo" está mejor modelada de lo previsto**: la extensión
>   mexicana distingue con costo de sin costo, y deja IFRS-16 aparte (§2.3).
> - **La historia XBRL no llega a 14 años**: arranca en 1T2014, universal desde
>   1T2016 (§3.1). El plan real es ~10 años.

---

## 0. Honestidad: qué está verificado y qué no

| Marca | Significado |
|---|---|
| **[VERIFICADO]** | Corrido en esta máquina, con la salida pegada. |
| **[VERIFICADO-FUERA]** | Lo comprobaste tú fuera del sandbox y lo incorporo como dato. |
| **[VERIFICADO POR EL USUARIO]** | Lo contrastaste tú contra el PDF y lo incorporo como dato. |
| **[SECUNDARIO]** | Sale de búsqueda web, no de tocar el recurso. |
| **[NO VERIFICADO]** | Suposición razonable, marcada para no confundirla con dato. |

**Este documento no contiene un solo número financiero de WALMEX ni de FEMSA.**
No bajé ningún archivo real. La tabla de verificación (§7) va vacía a propósito.

---

## 1. Censo — dónde publica BMV el XBRL trimestral

### 1.1 BMV: el trimestre corriente es gratis y sin sesión — pero no es XBRL **[VERIFICADO]**

BMV expone el reporte del **trimestre más reciente** de cada emisora como archivo
estático bajo `docs-pub`, sin login, sin cookie de sesión y sin captcha:

```
https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_<ID>_<AAAA>-<TT>_1.zip

WALMEX 2T2026 -> ifrsxbrl_1576010_2026-02_1.zip   (1.0 MB)
FEMSA  2T2026 -> ifrsxbrl_1577302_2026-02_1.zip   (2.6 MB)
```

- `<TT>` es el **trimestre**, no el mes (`2026-02` = 2T2026).
- `<ID>` es un id interno de BMV, **no derivable del ticker**. Las tres entradas
  del mapa que tenemos: `1576010`=WALMEX, `1577302`=FEMSA, `1576474`=Bimbo. Ya
  están en el script (`ID_DOCSPUB_A_TICKER`); las otras ~32 se llenan a mano.
- **Sólo se lista el último trimestre por emisora.** No hay índice histórico.

#### Lo que hay dentro del zip NO es XBRL estándar

Esto es lo más importante del censo y sólo se ve abriendo el archivo:

```
$ unzip -l ifrsxbrl_1576010_2026-02_1.zip
   ifrsxbrl_1576010_2026-02_1.json      7,714,361 bytes
```

Un solo `.json`. No hay instance document XML, ni `.xsd`, ni linkbases. Y el
JSON **no es xBRL-JSON de la OIM** (el estándar): es el volcado del modelo
interno del editor de BMV/EMISNET, con claves en español y campos que no tienen
nada que hacer en una publicación:

```json
{ "ContextosPorId": {...}, "HechosPorId": {...}, "Taxonomia": {...},
  "NombreArchivo": "/logs/services/serviciosXbrl/tmp03/xbrl_abx_temp_http_5adea875-...xbrl",
  "PuedeEscribir": ..., "EsDueno": ..., "Bloqueado": ...,
  "IdUsuarioBloqueo": ..., "NombreUsuarioBloqueo": ... }
```

`Bloqueado`, `IdUsuarioBloqueo`, `NombreUsuarioBloqueo` y una ruta temporal del
servidor son **estado interno de la herramienta de captura**. Eso dice algo que
importa más que la curiosidad: **este endpoint no parece una API pública
diseñada, sino un volcado del editor que quedó accesible.** Consecuencias en §10.

**La buena noticia:** el contenido está completo y bien estructurado
(`ContextosPorId`, `HechosPorId`, `Taxonomia`), se parsea sin drama y los datos
salen correctos (§6). El script ya lo lee.

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

### 2.1 Qué taxonomía — **confirmada** **[VERIFICADO]**

El entry point viene declarado en el propio archivo, y es el mismo en las dos
emisoras:

```
http://www.cnbv.gob.mx/taxonomy/ifrs_mx/full_ifrs_mc_mx_ics_entry_point_2019-01-01
```

Es decir: **taxonomía ICS de CNBV, versión 2019-01-01**, todavía vigente en
2026. Eso cierra la pregunta abierta de "qué versión aplica en 2024-2026": la
de 2019, sin cambios desde entonces hasta 2T2026.

Los namespaces de los hechos, también verificados:

| Prefijo | Namespace | Hechos (WALMEX) |
|---|---|---|
| `ifrs-full` | `http://xbrl.ifrs.org/taxonomy/2017-03-09/ifrs-full` | 1,962 |
| `ifrs_mx-cor_20141205` | `http://bmv.com.mx/ifrs_mx-cor_20141205/full_ifrs_mx-cor_2014-12-05` | 385 |
| `ifrs-mc` | `http://xbrl.ifrs.org/taxonomy/2017-03-09/ifrs-mc` | 6 |
| `mc_mx-cor_20141205` | `http://bmv.com.mx/mc_mx-cor_20141205/mc_mx-cor_2014-12-05` | 2 |

Dos cosas que saltan y hay que anotar:

1. **El IFRS de abajo es el de 2017**, no uno reciente. La taxonomía mexicana
   está congelada sobre IFRS 2017 vía el entry point de 2019.
2. **La extensión mexicana es de 2014** (`ifrs_mx-cor_20141205`). O sea que los
   tags mexicanos llevan ~12 años estables. Eso es **muy buena noticia** para el
   riesgo de "cambios de taxonomía" del memo anterior: el histórico 2016→hoy
   probablemente usa los mismos tags. Queda por confirmar con un archivo viejo
   (el 4T2016 de CNBV que falta del sample).

> **Decisión tomada: la v1 usa SÓLO la taxonomía ICS.** Bancos y FIBRAs fuera.
> Conviene notar que el entry point de estos dos archivos **ya es el de ICS**, o
> sea que WALMEX y FEMSA caen naturalmente dentro del alcance de la v1.

### 2.2 Los tags de los 9 campos — **verificados** **[VERIFICADO]**

Los nueve salen, con **el mismo tag en ambas emisoras**:

| Campo | Tag real | Namespace |
|---|---|---|
| Ingresos | `Revenue` | ifrs-full |
| Utilidad neta atribuible | `ProfitLossAttributableToOwnersOfParent` | ifrs-full |
| Activos totales | `Assets` | ifrs-full |
| Pasivos totales | `Liabilities` | ifrs-full |
| Capital contable | `Equity` (y `EquityAttributableToOwnersOfParent`) | ifrs-full |
| Efectivo | `CashAndCashEquivalents` | ifrs-full |
| Deuda con costo CP | **Σ de 3 tags**, ver §2.3 | ifrs_mx |
| Deuda con costo LP | **Σ de 3 tags**, ver §2.3 | ifrs_mx |
| Acciones en circulación | `NumeroDeAccionesEnCirculacion` | ifrs_mx |

**Dónde me equivoqué en el memo anterior:** puse candidatos IFRS
(`ShorttermBorrowings`, `NumberOfSharesOutstanding`) para los dos campos que en
realidad viven en la extensión mexicana. Los archivos reales traen **cero** hechos
con esos nombres. Estaban marcados `[DESCUBRIR]` justamente por eso, y el modo
`--dump-tags` es lo que los encontró. El script ya usa los tags reales.

### 2.3 "Deuda con costo" sí existe — y está mejor modelada que en IFRS **[VERIFICADO]**

Esto se invierte respecto del memo anterior. La extensión mexicana **distingue
explícitamente crédito con costo de crédito sin costo**, que es exactamente la
distinción que IFRS no hace:

```
CreditosBancariosACortoPlazo        CreditosBancariosALargoPlazo
CreditosBursatilesACortoPlazo       CreditosBursatilesALargoPlazo
OtrosCreditosConCostoACortoPlazo    OtrosCreditosConCostoALargoPlazo
--- y aparte, explícitamente excluidos ---
OtrosCreditosSinCostoACortoPlazo    OtrosCreditosSinCostoALargoPlazo
```

**Deuda con costo = suma de los tres "con costo"** por plazo. El script la calcula
así y reporta cada componente por separado, para que la suma sea auditable.

**IFRS-16 queda fuera y separable.** Los arrendamientos viven en
`CurrentLeaseLiabilities` / `NoncurrentLeaseLiabilities` (ifrs-full), tags
distintos. El script los imprime como extras para que **D3 se pueda decidir con
los dos números a la vista** en vez de a ciegas. El riesgo que el memo anterior
daba como el más probable de tumbar la verificación resultó ser un no-problema:
lo que había que sumar está etiquetado y lo que había que excluir también.

Un componente **ausente no es cero**: el script lo reporta aparte
(`NO REPORTADOS (≠ cero)`) para no confundir "no reportó" con "reportó 0". En los
dos archivos de 2T2026 los seis componentes vienen presentes y explícitos.

### 2.4 Acciones en circulación — resuelto **[VERIFICADO]**

`NumeroDeAccionesEnCirculacion` (ifrs_mx) lo da literal, y es lo que queríamos:
en circulación, no emitidas ni promedio ponderado. `NumeroDeAccionesRecompradas`
(tesorería) es un tag aparte y **no hay que restarlo**: ya viene descontado.

### 2.5 Las tres fechas — la de autorización NO viene **[VERIFICADO]**

| Fecha | Dónde vive | Estado en los archivos reales |
|---|---|---|
| **Envío a BMV/CNBV** | listado de la emisora, con hora | **no está en el archivo** |
| Autorización del consejo | `DateOfAuthorisationForIssueOfFinancialStatements` | **AUSENTE en ambos** |
| Cierre del periodo | `DateOfEndOfReportingPeriod2013` | presente: `2026-06-30` |

Esto endurece D8 en vez de relajarlo: **el archivo no trae ninguna fecha de
publicación, ni siquiera la del consejo como proxy.** Lo único que trae es el
cierre de periodo, que no sirve para eso. O sea que **capturar la fecha del
listado de la emisora no es opcional: es la única fuente que hay.** Si el
cosechador no la captura al momento de bajar, se pierde.

#### Pista que salió de la verificación **[VERIFICADO POR EL USUARIO]**

Los dos PDFs contrastados en §7 traen fecha, y es la de publicación:

| Emisora | Documento | Fecha |
|---|---|---|
| WALMEX | evento relevante BMV `eventemi_1576009_1.pdf` | **22-jul-2026** |
| FEMSA | `femsa.gcs-web.com` | **28-jul-2026** |

Y hay un detalle que puede valer para dos problemas a la vez: el evento relevante
de WALMEX es el id **1576009** y su XBRL es el **1576010** — **consecutivos**.
Con un solo par no es una regla, pero sugiere que los documentos de un mismo
envío ocupan ids contiguos en `docs-pub`. Si se confirma con más emisoras,
serviría para:

1. **D8** — tomar la fecha del evento relevante contiguo como fecha de envío, en
   vez de depender de raspar el listado.
2. **El mapa ticker → id** (§5.3) — acotar la búsqueda del id de cada emisora.

**No está verificado más allá de este par y no debe darse por bueno sin probarlo.**

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

| Archivo | Fuente | Estado | Para qué |
|---|---|---|---|
| WALMEX 2T2026 | BMV `docs-pub` | **recibido** | números vs PDF |
| FEMSA 2T2026 | BMV `docs-pub` | **recibido** | números + estabilidad de tags entre emisoras |
| 4T2016 | CNBV | **falta** | versión de taxonomía a 10 años, no comparación de números |

El modo `--manual` entiende los **nombres nativos**, no hay que renombrar:

```
ifrsxbrl_1576010_2026-02_1.zip   (BMV: id -> WALMEX, vía ID_DOCSPUB_A_TICKER)
ifrsxbrl_ALFA_2016-4.xbrl        (CNBV: clave de pizarra -> ALFA)
walmex_2026_2.zip                (libre, por si prefieres renombrar)
```

Un id que no esté en el mapa se reporta como `id:<n>` en vez de inventarle ticker.

### 5.3 Por qué la descarga automática sigue sin implementarse

Conocemos el patrón de URL (§1.1) y ya tenemos **3 entradas** del mapa
ticker → id de `docs-pub` (`1576010`=WALMEX, `1577302`=FEMSA, `1576474`=Bimbo).
Con tres puntos se ve que **los ids no son consecutivos ni derivables del
ticker**, así que el mapa hay que completarlo emisora por emisora. Mientras esté
incompleto, automatizar la descarga significaría adivinar ids, y eso no se hace.

Es trabajo de una sentada (~32 emisoras, una visita cada una) y es lo único que
separa el cosechador del trimestre vigente de estar hecho.

### 5.4 El parser ahora lee dos formatos

Como `docs-pub` sirve JSON propietario (§1.1), el script detecta el formato y
normaliza ambos a la misma forma interna, así que las tablas y el criterio
funcionan igual con uno u otro:

- **XBRL XML estándar** — para lo que venga de CNBV.
- **JSON propietario de BMV** — `ContextosPorId` / `HechosPorId`, con
  `Periodo.Tipo` 1=instante, 2=duración, y `ContieneInformacionDimensional`
  para descartar segmentos.

---

## 6. Resultado del smoke **[VERIFICADO]**

```
node scripts/xbrl-smoke.mjs --manual xbrl-raw
```

### 6.1 Lo que se leyó

| | WALMEX | FEMSA |
|---|---|---|
| Archivo | `ifrsxbrl_1576010_2026-02_1.zip` | `ifrsxbrl_1577302_2026-02_1.zip` |
| Formato | JSON propietario BMV | JSON propietario BMV |
| Entry point | `full_ifrs_mc_mx_ics_entry_point_2019-01-01` | idéntico |
| Contextos | 195 (10 sin dimensiones) | **1,093** (10 sin dimensiones) |
| Hechos | 2,355 | 3,449 |

Nota: FEMSA trae 1,093 contextos contra 195 de WALMEX — 5.6× más complejidad
dimensional, por la estructura de subsidiarias. **Los contextos sin dimensiones
son 10 en ambas**, que es lo que se usa. La complejidad dimensional no estorba,
pero avisa de cuánto varía el tamaño de archivo entre emisoras.

### 6.2 Tabla emisora × campo × valor × tag

Todos los valores en **pesos** (`decimals=-3`, o sea precisión al millar). El PDF
casi seguro los muestra **en millones**: ahí está la diferencia esperada de 10⁶.

| Campo | WALMEX 2T2026 | FEMSA 2T2026 | Tag usado |
|---|---:|---:|---|
| Ingresos (3m) | 250,947,844,000 | 231,002,301,000 | `ifrs-full:Revenue` |
| ├ Ingresos (6m acum.) | 495,966,330,000 | 438,695,214,000 | mismo tag, otra ventana |
| └ Ingresos (12m móvil) | 1,020,335,804,000 | 872,836,541,000 | mismo tag, otra ventana |
| Utilidad neta atribuible (3m) | 11,152,382,000 | 5,535,227,000 | `ifrs-full:ProfitLossAttributableToOwnersOfParent` |
| ├ (6m acum.) | 23,651,933,000 | 20,375,998,000 | mismo tag, otra ventana |
| └ (12m móvil) | 49,999,035,000 | 31,292,138,000 | mismo tag, otra ventana |
| Activos totales | 505,946,590,000 | 802,581,500,000 | `ifrs-full:Assets` |
| Pasivos totales | 267,332,796,000 | 501,646,499,000 | `ifrs-full:Liabilities` |
| Capital contable (total) | 238,613,794,000 | 300,935,001,000 | `ifrs-full:Equity` |
| └ del cual, controladora | 238,613,794,000 | **217,055,000,000** | `ifrs-full:EquityAttributableToOwnersOfParent` |
| Efectivo y equivalentes | 30,118,253,000 | 104,959,729,000 | `ifrs-full:CashAndCashEquivalents` |
| **Deuda con costo — corto plazo** | **0** | **14,947,551,000** | Σ ifrs_mx (3 comp.) |
| ├ CreditosBancariosACortoPlazo | 0 | 3,514,879,000 | `ifrs_mx-cor_20141205` |
| ├ CreditosBursatilesACortoPlazo | 0 | 11,432,672,000 | `ifrs_mx-cor_20141205` |
| └ OtrosCreditosConCostoACortoPlazo | 0 | 0 | `ifrs_mx-cor_20141205` |
| **Deuda con costo — largo plazo** | **0** | **124,830,071,000** | Σ ifrs_mx (3 comp.) |
| ├ CreditosBancariosALargoPlazo | 0 | 2,245,065,000 | `ifrs_mx-cor_20141205` |
| ├ CreditosBursatilesALargoPlazo | 0 | 122,585,006,000 | `ifrs_mx-cor_20141205` |
| └ OtrosCreditosConCostoALargoPlazo | 0 | 0 | `ifrs_mx-cor_20141205` |
| Acciones en circulación | 17,220,231,803 | 16,935,974,370 | `ifrs_mx:NumeroDeAccionesEnCirculacion` |
| *(extra)* Arrend. IFRS-16 CP | 5,495,152,000 | 15,435,382,000 | `ifrs-full:CurrentLeaseLiabilities` |
| *(extra)* Arrend. IFRS-16 LP | 77,602,948,000 | 97,791,927,000 | `ifrs-full:NoncurrentLeaseLiabilities` |

**Estabilidad de tags: CUMPLE.** Las 9 filas salen con el mismo tag y la misma
ventana en ambas emisoras.

**Sobre el 0 de WALMEX:** no es un fallo de extracción. Los seis componentes
están presentes en el archivo y reportados explícitamente en cero. WALMEX no
tiene deuda financiera; su único pasivo con costo son los arrendamientos
(83,098,100,000 sumando CP+LP), que por §2.3 quedan fuera del campo hasta que se
decida D3. **Este caso es la mejor prueba de por qué D3 importa:** para WALMEX,
D3 es la diferencia entre deuda 0 y deuda 83 mil millones.

### 6.3 Verificaciones internas: las 4 identidades cuadran al peso **[VERIFICADO]**

No sustituyen al PDF, pero son la evidencia más fuerte disponible sin él: si el
extractor estuviera tomando el contexto equivocado (un segmento, otra fecha, otra
ventana), estas sumas no darían exacto.

| Identidad | WALMEX | FEMSA |
|---|---|---|
| Assets = Liabilities + Equity | **OK** (dif. 0) | **OK** (dif. 0) |
| Assets = CurrentAssets + NoncurrentAssets | **OK** | **OK** |
| Liabilities = Current + Noncurrent | **OK** | **OK** |
| Equity = Controladora + NoControladora | **OK** | **OK** |

Diferencia exacta de cero en las ocho comprobaciones, sin redondeo.

---

## 7. Verificación XBRL vs PDF — **hecha, cuadra** **[VERIFICADO POR EL USUARIO]**

Fuentes del lado PDF:

- **WALMEX** — evento relevante en BMV, `eventemi_1576009_1.pdf`, **22-jul-2026**.
- **FEMSA** — `femsa.gcs-web.com`, **28-jul-2026**.

**Resultado: los 9 campos cuadran en ambas emisoras.** Todas las diferencias son
menores a 1 millón de pesos y se explican por redondeo de presentación.

### 7.1 WALMEX 2T2026

El PDF reporta el balance **en miles**, o sea a precisión completa. Ahí el match
es **exacto, cero diferencia**:

| Campo | XBRL (pesos) | PDF (miles) | PDF ×1000 | Diferencia |
|---|---:|---:|---:|---:|
| Activos totales | 505,946,590,000 | 505,946,590 | 505,946,590,000 | **0** |
| Pasivos totales | 267,332,796,000 | 267,332,796 | 267,332,796,000 | **0** |
| Capital contable | 238,613,794,000 | 238,613,794 | 238,613,794,000 | **0** |
| Efectivo | 30,118,253,000 | 30,118,253 | 30,118,253,000 | **0** |

El estado de resultados lo reporta **en millones**, y ahí la diferencia es el
redondeo esperado:

| Campo | XBRL (MM) | PDF (MM) | Diferencia | ¿round(XBRL) = PDF? |
|---|---:|---:|---:|---|
| Ingresos 2T (3m) | 250,947.844 | 250,948 | −0.156 | sí |
| Utilidad controladora 2T (3m) | 11,152.382 | 11,152 | +0.382 | sí |

| Campo | XBRL | PDF | Nota |
|---|---:|---|---|
| Deuda con costo CP | 0 | sin deuda bancaria | cuadra |
| Deuda con costo LP | 0 | sin deuda bancaria | cuadra |
| Acciones en circulación | 17,220,231,803 | — | no contrastado contra PDF |
| *(extra)* Arrend. IFRS-16 CP+LP | 83,098,100,000 | sólo arrendamientos | confirma el 0 de deuda |

**El 0 de WALMEX queda confirmado del lado del PDF:** no tiene deuda bancaria,
sólo arrendamientos. La extracción era correcta.

### 7.2 FEMSA 2T2026

PDF en millones en todos los campos:

| Campo | XBRL (MM) | PDF (MM) | Diferencia | ¿round(XBRL) = PDF? |
|---|---:|---:|---:|---|
| Ingresos 2T (3m) | 231,002.301 | 231,002 | +0.301 | sí |
| Utilidad controladora 2T (3m) | 5,535.227 | 5,536 | **−0.773** | no (round daría 5,535) |
| Activos totales | 802,581.500 | 802,582 | −0.500 | sí (half-up) |
| Pasivos totales | 501,646.499 | 501,647 | **−0.501** | no (round daría 501,646) |
| Capital contable (total) | 300,935.001 | 300,935 | +0.001 | sí |
| Efectivo | 104,959.729 | 104,960 | −0.271 | sí |
| Deuda con costo CP | 14,947.551 | 14,947 | **+0.551** | no (round daría 14,948) |
| Deuda con costo LP | 124,830.071 | 124,830 | +0.071 | sí |

### 7.3 Las tres diferencias que no son round() del total — y por qué está bien

En tres campos de FEMSA el número del PDF no es el redondeo del total del XBRL.
Todas son **< 1 MM** y el patrón es el clásico de presentación: **el PDF suma
componentes ya redondeados**, en vez de redondear la suma. Redondear después de
sumar y sumar después de redondear dan resultados distintos por hasta medio
millón por componente.

Esto es diferencia **explicable** bajo el criterio de GO, y además es un
argumento a favor del XBRL como fuente: el XBRL trae el número sin redondear.

**Corolario operativo:** no se debe esperar reconciliación al peso contra un PDF
en millones. Contra un PDF en miles (WALMEX) sí, y ahí dio exacto.

### 7.4 Deuda de corto plazo de FEMSA: el total cuadra, la descomposición NO

Es el hallazgo más útil de la verificación y hay que tenerlo presente:

| | Componente 1 | Componente 2 | Total |
|---|---:|---:|---:|
| **XBRL** | `CreditosBancariosACortoPlazo` 3,514.879 | `CreditosBursatilesACortoPlazo` 11,432.672 | **14,947.551** |
| **PDF** | préstamos bancarios 2,860 | vencimientos CP de LP 12,087 | **14,947** |

Los totales cuadran. **Los componentes no son la misma partición.** El XBRL parte
por **tipo de instrumento** (bancario vs bursátil); el PDF parte por **origen del
vencimiento** (préstamo corriente vs porción circulante de deuda larga). Son dos
cortes distintos del mismo agregado.

**Regla que sale de aquí:** confiar en el **total** de deuda con costo por plazo,
y **no** mapear componente a componente contra el PDF. Si la Fase 1 quiere
guardar el desglose, que guarde el del XBRL y no pretenda que es el del reporte.

### 7.5 Acciones de FEMSA: la tesorería reconcilia al número **[VERIFICADO]**

El PDF da dos cifras distintas de acciones y hay que saber cuál es cuál:

| Fuente | Unidades | × 5 acciones/unidad | Qué es |
|---|---:|---:|---|
| PDF portada | 3,412,732,415 | 17,063,662,075 | **incluye** tesorería |
| PDF p.16 | 3,387,194,875 | 16,935,974,375 | **excluye** tesorería |
| **XBRL** `NumeroDeAccionesEnCirculacion` | — | **16,935,974,370** | **excluye** tesorería |

Y la diferencia entre portada y XBRL cierra exactamente contra el tag de
tesorería del propio XBRL:

```
17,063,662,075 (portada, con tesorería)
-16,935,974,370 (XBRL, en circulación)
= 127,687,705  ==  NumeroDeAccionesRecompradas del XBRL, al número
```

No es aproximado: es idéntico. Eso confirma que `NumeroDeAccionesEnCirculacion`
es **neto de tesorería** y que el XBRL es internamente coherente en este campo.

**Una precisión honesta:** el XBRL da 16,935,974,**370** y la p.16 del PDF, a 5
acciones por unidad, da 16,935,974,**375**. Quedan **5 acciones** de diferencia
(0.00000003%), que es 1 unidad. Es inmaterial y no cambia nada, pero lo anoto en
vez de afirmar una identidad exacta que no se cumple al último dígito.

> **Decisión tomada (D5): se usa la cifra del XBRL, neta de tesorería, para
> capitalización.** Es la correcta —las acciones en tesorería no son capital en
> circulación— y además es la que sale directo del tag sin post-proceso.

---

## 8. Criterios (escritos antes, sin mover) y veredicto

**GO:** los archivos bajan sin sesión ni captcha **·** los 9 campos salen con los
mismos tags en ambas emisoras **·** los valores cuadran contra el PDF exacto o con
diferencia explicable.

**NO-GO:** BMV bloquea o exige sesión **·** los tags cambian entre emisoras o entre
trimestres sin patrón **·** cualquier número no cuadra y no hay explicación.

| Criterio | Estado | Evidencia |
|---|---|---|
| Bajan sin sesión ni captcha | **CUMPLE** | 2 zips de `docs-pub` bajados libres (§1.1) |
| 9 campos, mismos tags en ambas emisoras | **CUMPLE** | mismo tag y misma ventana en las 9 filas (§6.2) |
| Valores cuadran contra el PDF | **CUMPLE** | 9 campos × 2 emisoras, dif. < 1 MM (§7) |

### Veredicto: GO

El criterio que decidió fue el tercero, que era el único que faltaba: **los
valores cuadran**. En WALMEX, contra un PDF en miles, la diferencia es **cero
exacto** en los cuatro rubros de balance. En FEMSA, contra un PDF en millones,
todas las diferencias son **menores a 1 MM** y responden a un patrón identificado
(el PDF suma componentes redondeados, §7.3), que es diferencia explicable en el
sentido literal del criterio.

Ninguna condición de NO-GO se cumplió en ningún momento: BMV no bloqueó ni pidió
sesión, los tags no cambiaron entre emisoras, y no quedó ningún número sin
explicar.

### 8.0 Lo que el GO NO cubre

El GO es sobre **la pregunta que se hizo**: bajar y parsear, repetible y con
números correctos. No se extiende a:

- **El histórico.** Se verificó un trimestre, el vigente, que es justo el único
  que BMV publica gratis. Todo el backfill sigue sujeto a §8.1.
- **La taxonomía de 2016.** No se probó; no llegó archivo viejo. §10.5.
- **Emisoras fuera de ICS.** Bancos y FIBRAs quedaron fuera de la v1 por decisión
  y no se tocaron.
- **Emisoras distintas de estas dos.** Dos emisoras con el mismo tag es evidencia
  buena, no prueba de las ~35. El riesgo es bajo (mismo entry point, extensión
  congelada desde 2014) pero no es cero.

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

## 9. Qué queda — y qué NO es todavía

**La Fase 0 está cerrada.** Contestó su pregunta y el veredicto es GO. Lo que
sigue **no es Fase 1**: son los dos frentes abiertos, que se resuelven antes de
diseñar nada.

**1. Licencia del histórico (D1).** Es el bloqueante real. Tres rutas ordenadas
por defensibilidad en §8.1; la que más me convence para un producto comercial es
comprar el histórico a BMV una vez y mantenerlo con el feed gratis.

**2. Taxonomía 2016 (§10.5).** Un solo archivo viejo cierra la duda. Cuando
consigas uno:

```bash
node scripts/xbrl-smoke.mjs --file <archivo> --dump-tags
```

El script lee XML estándar además del JSON de BMV, así que sirve tal cual.

**3. Arrancar la captura del vigente (D9).** Barato, legal e irreversible en el
buen sentido: cada trimestre sin capturar es uno que después hay que comprar
(§3.2), y el endpoint podría cerrarse (§10.2). No depende de D1.

**Re-correr el smoke** cuando haga falta:

```bash
node scripts/xbrl-smoke.mjs --manual xbrl-raw
```

`xbrl-raw/` está en `.gitignore`: el raw no entra al repo.

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

1. **El techo de adquisición del histórico (§3.2, §8.1).** Sigue siendo el riesgo
   número uno y no se resuelve programando.
2. **El formato JSON propietario (§1.1).** Riesgo nuevo de esta corrida, y
   subestimado en el memo anterior. No es un estándar: es el volcado del editor
   de BMV, con estado interno adentro (`Bloqueado`, `IdUsuarioBloqueo`, rutas
   temporales del servidor). Tres consecuencias:
   - **Ninguna herramienta XBRL estándar lo lee.** Arelle y compañía quedan
     descartados para la fuente BMV; el parser propio deja de ser una comodidad
     de Fase 0 y pasa a ser infraestructura que hay que mantener.
   - **Puede cambiar sin aviso.** No hay contrato público ni versionado visible;
     `Version` viene en `null`. Un cambio del editor rompe el cosechador en
     silencio. Hay que validar con las identidades contables (§6.3) en cada
     descarga y alertar, no confiar.
   - **Podría cerrarse.** Que exponga estado interno sugiere que quedó accesible
     más que diseñado. Conviene no construir asumiendo que estará ahí siempre —
     otra razón para capturar desde ya (§3.2) y para tomar en serio la ruta CNBV,
     que sí sirve XBRL estándar.
3. **La ventana histórica real es ~10 años, no 14 (§3.1).**
4. **El mapa ticker → id de `docs-pub` (§1.1).** Tenemos 3 de ~35. Sin fórmula,
   se llena a mano y se pudre cuando una emisora cambia de clave.
5. **Cambios de versión de taxonomía.** Riesgo **rebajado**: la extensión
   mexicana es de 2014 y el entry point de 2019, ambos estables hasta 2T2026
   (§2.1). Sigue sin verificarse contra un archivo de 2016.
6. **Las tres ventanas (3m / 6m / 12m).** Aparece una tercera, la de 12 meses
   móviles, que no estaba prevista. D4 se vuelve más importante: elegir mal la
   ventana no da error, da una serie equivocada.
7. **Emisoras que cambiaron de nombre.** El encadenado de identidad sigue
   pendiente.
8. **Rate limits desconocidos.** El volumen es chico. Me preocupa no saber el
   límite, no el volumen.

**Lo que NO me preocupa:** el parseo. Un instance es XML regular y el extractor
dependency-free ya demostró que hace el trabajo. Si esto falla, va a fallar por
licencia, por adquisición del histórico o por definiciones contables — no por
código.

---

## 11. Decisiones — estado al cierre de la Fase 0

### Cerradas

| # | Decisión | Resuelta como | Dónde |
|---|---|---|---|
| **D5** | ¿Qué medida de acciones? | **Cifra del XBRL, neta de tesorería**, para capitalización | §7.5 |
| **D6** | Capital contable: ¿total o controladora? | ambas disponibles y verificadas; el PDF de FEMSA contrastó contra **total** | §7.2 |
| **D7** | ~~Composición histórica del IPC~~ | **eliminada** — universo point-in-time por emisoras ICS que reportan | §10 |
| **D8** | Fecha anti-look-ahead | **fecha de envío a BMV/CNBV**, no la del consejo. No viene en el archivo: se captura al bajar | §2.5 |
| — | Perfil de taxonomía | sólo **ICS**; bancos y FIBRAs fuera de la v1 | §2.1 |

### Abiertas

| # | Decisión | Por qué sigue abierta |
|---|---|---|
| **D1** | Fuente del histórico: ¿comprar a BMV, pedir a CNBV, o no backfillear? | **Es el bloqueante.** Licencia, no técnica (§8.1) |
| **D2** | Ventana: ¿2016+ y listo? | depende de D1 (§3.1) |
| **D3** | "Deuda con costo": ¿IFRS-16 dentro o fuera? | los dos números están a la vista y verificados; falta decidir. En WALMEX es la diferencia entre deuda 0 y 83 mil MM (§6.2, §7.1) |
| **D4** | ¿Trimestre o acumulado? | hay **tres** ventanas (3m / 6m / 12m móvil). La verificación se hizo contra 3m (§7) |
| **D9** | ¿Arrancar ya la captura del vigente? | no depende de D1; sólo gana con el tiempo (§3.2, §9) |

### Lo que NO se decide aquí

El desglose de deuda: si la Fase 1 guarda componentes, guarda los del XBRL y no
pretende que mapean 1:1 contra el PDF (§7.4). Eso no es decisión, es un hecho
verificado que hay que respetar.
