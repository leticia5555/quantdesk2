# FASE 0 — XBRL de emisoras BMV: ¿se puede bajar y parsear de forma programática?

> **Alcance:** SOLO viabilidad de datos. No hay pipeline, no hay diseño de tablas,
> no se tocó Neon ni el app. Censo + smoke, nada más.
>
> **Veredicto: NO EMITIDO — la compuerta no se pudo correr desde este entorno.**
> No es GO y tampoco es NO-GO: es *no observado*. El sandbox no tiene egress a
> `bmv.com.mx` (§4), así que los 4 archivos nunca se intentaron bajar de verdad.
> Los criterios quedan escritos abajo **sin mover** y se cierran con ~20 minutos
> tuyos en local (§9).
>
> **Dos hallazgos que sí son firmes y no dependen de la compuerta:**
> 1. **La historia XBRL de BMV no llega a 14 años.** Arranca en 1T2014 y sólo es
>    universal desde 1T2016 (§3). El plan "35 emisoras × 14 años" **ya está
>    recortado** pase lo que pase con el gate.
> 2. **"Deuda con costo" no es un tag.** IFRS no define un elemento único para
>    eso; es una suma que hay que armar y justificar (§2.3). Es el campo con más
>    probabilidad de tumbar el criterio de "mismos tags".

---

## 0. Honestidad: qué está verificado y qué no

Este documento mezcla tres calidades de evidencia y las marca en todos lados:

| Marca | Significado |
|---|---|
| **[VERIFICADO]** | Lo corrí en esta máquina y pegué la salida. |
| **[SECUNDARIO]** | Sale de búsqueda web, no de tocar el recurso. Puede estar desactualizado o mal. |
| **[NO VERIFICADO]** | Suposición razonable. Marcada para que no se confunda con dato. |

**Nada de lo que sigue incluye un número financiero de WALMEX o FEMSA.** No pude
bajar un solo archivo real, así que no hay valores que reportar. La tabla de
verificación (§7) va vacía a propósito: rellenarla de memoria sería justo el
fracaso que esta Fase 0 existe para evitar.

---

## 1. Censo — dónde publica BMV el XBRL trimestral

### 1.1 Rutas candidatas encontradas

Todas **[SECUNDARIO]**; ninguna respondió desde aquí.

| # | Qué es | URL | Formato esperado |
|---|---|---|---|
| A | Portal XBRL de empresas listadas | `https://www.bmv.com.mx/es/empresas-listadas/informacion-financiera-xbrl` | selector emisora + periodo |
| B | "Archivos estándar XBRL" | `https://www.bmv.com.mx/es/emisoras/archivos-estadar-xbrl` | taxonomías / plantillas |
| C | Ficha de emisora → info financiera | `https://www.bmv.com.mx/es/emisoras/informacionfinanciera/WALMEX-5214-CGEN_CAPIT` | HTML con links de descarga |
| D | Backend Cognos de esas fichas | `https://cognos.bmv.com.mx/es/Grupo_BMV/InfoFinanciera/<TICKER>-<ID>` | HTML/servicio |
| E | Ruta estática pública observada | `https://www.bmv.com.mx/docs-pub/s1s2xbrl/s1s2xbrl_1555500_2025_1.html` | HTML renderizado del XBRL |
| F | EMISNET | `https://emisnet.bmv.com.mx/` | **carga** de documentos por el emisor, no descarga pública |

**Lectura del censo:**

- **La ruta C es la entrada real por emisora.** El patrón es `TICKER-ID`, con un
  **id numérico interno de BMV**, no derivable del ticker:
  `WALMEX-5214`, `FEMSA-5305`, `KOF-5525`, `PE&OLES-5608`, `BBVAMX-35973`,
  `TFOVICB-31914`, `DIS-6163` **[SECUNDARIO]**. Para 35 emisoras hace falta una
  tabla de equivalencias ticker→id; no hay fórmula.
- **La ruta E es la más prometedora y la menos documentada.** `docs-pub/` es una
  ruta estática, sin querystring de sesión, con nombre
  `<tipo>xbrl_<id>_<año>_<trimestre>.html`. Si el `.xbrl`/`.zip` vive al lado del
  `.html` con el mismo nombre, la descarga programática es trivial. **Pero el id
  `1555500` del ejemplo no coincide con los ids de la ruta C**, así que son dos
  espacios de identificadores distintos y no sé mapear uno al otro. **[NO VERIFICADO]**
- **EMISNET es de subida, no de bajada.** El emisor exporta su XBRL en ZIP y lo
  sube ahí; el portal de consulta pública es el de BMV. **[SECUNDARIO]**

### 1.2 Bandera amarilla: BMV **vende** esto como producto

`pubsys2.bmv.com.mx` lista "información financiera trimestral xbrl de \<emisora\>"
como **productos de catálogo**, uno por emisora
(`productdetails.aspx?i=1417` = WALMEX, `i=1105` = FEMSA) **[SECUNDARIO]**.

Al mismo tiempo, otras fuentes describen el portal XBRL de BMV como **gratuito y
sin registro** **[SECUNDARIO]**. Las dos cosas pueden convivir — consulta libre
una-a-una vs. suscripción para el histórico masivo — y esa es la lectura que
apostaría. **No lo pude resolver y es material:** si el acceso por emisora también
es de pago, el gate es NO-GO por licencia, no por técnica, y ningún ajuste de
script lo arregla. **Es lo primero que hay que mirar al correr el probe.**

### 1.3 ¿Sesión / cookies / captcha / rate limit?

**No verificable desde aquí.** No hay evidencia de captcha en ninguna de las
fuentes leídas, y tampoco hay un `robots.txt` o una página de términos que haya
podido leer para documentar rate limits. El probe del script (§5) imprime
`set-cookie` y redirects precisamente para contestar esto con evidencia en vez de
con opinión. Señal de NO-GO a buscar: un `302` a login, o un `ASP.NET_SessionId` /
`JSESSIONID` que haya que traer antes de poder bajar.

### 1.4 BIVA

BIVA (`biva.mx`) lista emisoras y publica información financiera de las que
cotizan ahí **[SECUNDARIO, no verificado]**. Dos límites estructurales que sí son
ciertos por diseño del mercado: BIVA es la bolsa **alterna**, con muchas menos
emisoras, y **el IPC es un índice de BMV**. Aun si BIVA publicara XBRL impecable,
no cubre por sí sola el universo del backtest. Ver §8.

---

## 2. Taxonomía y tags

### 2.1 Qué taxonomía

La taxonomía es una **extensión mexicana del IFRS Accounting Taxonomy**: BMV tomó
la taxonomía IFRS publicada, la comparó contra su catálogo contable, y creó
etiquetas nuevas sólo para lo que faltaba **[SECUNDARIO]**. De ahí los dos
namespaces que se esperan en el instance:

- `ifrs-full` → elementos IFRS estándar, p.ej. `https://xbrl.ifrs.org/taxonomy/2023-03-23/ifrs-full` **[SECUNDARIO]**
- extensión mexicana (`ifrs_mx` / `mx-ifrs`, prefijo exacto **[NO VERIFICADO]**)

CNBV publica las taxonomías de emisoras y hay variantes por perfil de emisor
(IFRS, SAPIB, ICS, instrumentos de corto plazo, FIBRAS) **[SECUNDARIO]**. Eso
importa: **una FIBRA no usa la misma taxonomía que WALMEX**, y el IPC tiene FIBRAs.

**Qué versión aplica en 2024-2026: NO LO SÉ.** No pude abrir la página de
taxonomías de CNBV. El script imprime los `xmlns` reales del archivo, que es la
forma correcta de contestarlo: leyéndolo del instance, no de una tabla.

### 2.2 Los tags de los 9 campos

Los seis primeros son elementos IFRS estándar. Son internacionales y estables;
esperarlos en el instance es razonable. **Ninguno está confirmado contra un
archivo real de BMV.**

| Campo | Tag candidato principal | Confianza |
|---|---|---|
| Ingresos | `ifrs-full:Revenue` (alt. `RevenueFromContractsWithCustomers`) | IFRS estándar, **[NO VERIFICADO]** en BMV |
| Utilidad neta atribuible | `ifrs-full:ProfitLossAttributableToOwnersOfParent` | IFRS estándar, **[NO VERIFICADO]** |
| Activos totales | `ifrs-full:Assets` | IFRS estándar, **[NO VERIFICADO]** |
| Pasivos totales | `ifrs-full:Liabilities` | IFRS estándar, **[NO VERIFICADO]** |
| Capital contable | `ifrs-full:Equity` (alt. `EquityAttributableToOwnersOfParent`) | IFRS estándar, **[NO VERIFICADO]** |
| Efectivo | `ifrs-full:CashAndCashEquivalents` | IFRS estándar, **[NO VERIFICADO]** |
| Deuda con costo CP | — ver §2.3 | **sin tag único** |
| Deuda con costo LP | — ver §2.3 | **sin tag único** |
| Acciones en circulación | `NumberOfSharesOutstanding` | **[NO VERIFICADO]**, ver §2.4 |
| Fecha de publicación | `DateOfAuthorisationForIssueOfFinancialStatements` | IFRS estándar, **[NO VERIFICADO]** |

El script **no confía en esta tabla**: prueba candidatos en orden, reporta cuál
pegó, y si ninguno pega marca el campo **FALTA** y sugiere `--dump-tags`. Un campo
que no resuelve se queda como hueco — nunca se rellena con un proxy silencioso.

### 2.3 "Deuda con costo" no existe como tag — esto es un problema real

IFRS no tiene un elemento `DeudaConCosto`. Lo que hay son varios elementos que
**hay que sumar**, y la suma correcta depende de decisiones contables:

- préstamos bancarios corto/largo plazo,
- deuda bursátil (certificados),
- **porción circulante de la deuda de largo plazo** (fácil de doble-contar o de
  perder según de qué lado la tomes),
- **pasivos por arrendamiento IFRS-16**, que desde 2019 inflan la "deuda" y que
  *casi ningún reporte de IR trata como deuda con costo*.

Ese último punto es el que más probablemente rompa la verificación contra PDF:
el XBRL puede estar impecable y aun así **no cuadrar** con el "Deuda Total" del
PDF, porque el PDF excluye IFRS-16 y el XBRL no. Si eso pasa, **no es un bug del
parser y no se parcha en el script**: es una decisión de definición que hay que
congelar y documentar antes de construir nada. Es una diferencia *explicable*
bajo el criterio de GO, pero sólo si se explica — no si se redondea.

### 2.4 Acciones en circulación: tres números distintos

`NumberOfSharesIssued` (emitidas), acciones en circulación (emitidas − recompra)
y `WeightedAverageShares` (promedio ponderado, el denominador del EPS) son **tres
cosas distintas**. Para un screener value el que importa es el de circulación al
cierre. Cuál de los tres trae el instance es justo lo que hay que descubrir.

---

## 3. Historia disponible — el hallazgo que recorta el plan

**[SECUNDARIO, pero consistente entre fuentes]**

| Hito | Fecha |
|---|---|
| BMV arranca el proyecto XBRL | 2012 |
| Primera aplicación a estados financieros trimestrales | **1T2014** |
| ~145 emisoras listadas obligadas a reportar en XBRL | **desde 1T2016** |

**Consecuencia directa sobre el objetivo declarado:**

- "35 emisoras × 14 años" (≈2012-2026) **no es alcanzable con XBRL de BMV.**
  Antes de 2014 el XBRL simplemente **no existe**.
- Ventana realista: **~2014 en adelante con huecos**, **~2016 en adelante
  completa** → **10-12 años**, no 14.
- Para un backtest de rotación value+momentum trimestral eso son ~40-48
  rebalanceos. No es fatal, pero **cubre un solo régimen largo** y no incluye
  2008-09. Vale la pena saberlo *antes* de construir, no después.

Pre-2014 habría que ir a PDFs o a otra fuente, que es un proyecto distinto y más
caro. **Recomendación: recortar el alcance a 2016+ y no pelear con 2014-2015.**

---

## 4. Egress del sandbox: NO llega a BMV **[VERIFICADO]**

```
$ curl -sS -o /dev/null -w "%{http_code}" https://www.bmv.com.mx/
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.bmv.com.mx:443" }, ... ]
```

Bloqueados **todos**: `www.bmv.com.mx`, `bmv.com.mx`, `emisnet.bmv.com.mx`,
`cognos.bmv.com.mx`, `xbrl.cnbv.gob.mx`, `www.cnbv.gob.mx`, `www.gob.mx`,
`www.biva.mx`, `biva.mx`, `www.walmex.mx`, `femsa.com`. `WebFetch` da el mismo
bloqueo (`EGRESS_BLOCKED`). `registry.npmjs.org` sí responde (200), o sea que el
bloqueo es de política de dominio, no de red caída.

**Ojo al leer la salida del probe:** los `403` que imprime aquí son **del proxy
local, no de BMV**. Se distinguen porque llegan en ~3ms con `content-type:
text/plain`. En tu máquina, un 403 real de BMV se verá distinto.

Es el mismo precedente ya documentado en la casa
(`docs/wheel-fase0.md` §0, `docs/alpaca-paper-scope.md:195`).

---

## 5. El smoke — `scripts/xbrl-smoke.mjs`

Sin dependencias. Dos piezas propias, ambas justificadas:

- **Lector de ZIP** (~70 líneas): central directory + `zlib.inflateRawSync`. Los
  XBRL de emisnet se publican en `.zip`. Meter `adm-zip`/`yauzl` por un inflate no
  se paga en Fase 0.
- **Parser de XBRL** (regex sobre el instance): un procesador XBRL de verdad
  (**Arelle**) es Python, descarga de taxonomías y minutos por archivo. Para leer
  *hechos* de un instance sólo hace falta (a) resolver contextos y (b) elegir
  qnames — XML plano y generado por máquina. **No resolvemos linkbases ni
  calculation arcs**, porque este smoke no valida la taxonomía: valida que los
  números salgan y cuadren contra el PDF. Si la Fase 1 necesita validación de
  cálculo, ahí sí entra Arelle.

### 5.1 Qué hace bien, a propósito

- **No elige por ti en la ambigüedad de periodo.** Para 2T un instance trae el
  trimestre (3m) *y* el acumulado (6m) con el mismo cierre. El script imprime
  **las dos** y marca `<-- OJO, ambigüedad de periodo`. Elegir en silencio es
  exactamente cómo un número deja de cuadrar contra el PDF.
- **Ignora contextos con dimensiones.** Sólo toma el consolidado total; un hecho
  con `explicitMember` (segmento, moneda, subsidiaria) se descarta.
- **Trata `xsi:nil` como ausente**, y si el tag existe pero vino nil te lo dice.
- **No reescala.** Imprime el valor crudo con su `unitRef` y `decimals`. El
  miles-vs-millones se resuelve mirando, no adivinando.
- **Calcula el criterio de GO solo:** la matriz de estabilidad de tags compara
  las 4 celdas por campo y dicta `estable` / `INESTABLE` / `FALTA`.

### 5.2 Qué se verificó de verdad **[VERIFICADO]**

Con `--file` y `--manual` sobre **fixtures sintéticos** construidos en el
scratchpad (no en el repo), el parser:

- separó bien 3m vs 6m y marcó la ambigüedad;
- **excluyó el contexto con `explicitMember`** (tomó `Assets` = 444,444,000 y no
  el 999,999,000 del segmento);
- trató el `nil` como FALTA y aun así avisó `parecidos en el archivo: LongtermBorrowings`;
- leyó los 4 ZIP (deflate + `.xsd` de ruido dentro) y encontró el instance;
- y con FEMSA-4T sembrado a propósito con `EquityAttributableToOwnersOfParent` en
  vez de `Equity`, **detectó la inestabilidad y volteó el veredicto a NO-GO**:

```
  Capital contable    INESTABLE: ifrs-full:Equity | ifrs-full:EquityAttributableToOwnersOfParent
  # Criterio "9 campos con los mismos tags en ambas emisoras": NO SE CUMPLE
```

**Esto prueba la mecánica del parser y del gate, NADA sobre los datos de BMV.**
Los fixtures los escribí yo con valores obviamente falsos (1000, 5000, 111111000).
No son datos de WALMEX ni de FEMSA y no deben citarse como tales.

---

## 6. Resultado del smoke contra BMV

**No se corrió.** 0 de 4 archivos bajados. Causa: §4. No hay números que reportar.

---

## 7. Tabla de verificación XBRL vs PDF

**Vacía porque no tengo los dos lados.** No pude bajar el XBRL (§4) ni abrir los
PDFs de IR (`walmex.mx` y `femsa.com` también bloqueados). Se llena corriendo §9.

| Campo | XBRL | PDF | Diferencia | Explicación |
|---|---|---|---|---|
| Ingresos | | | | |
| Utilidad neta atribuible | | | | |
| Activos totales | | | | |
| Pasivos totales | | | | |
| Capital contable | | | | |
| Efectivo | | | | |
| Deuda con costo CP | | | | ¿incluye IFRS-16? §2.3 |
| Deuda con costo LP | | | | ¿incluye IFRS-16? §2.3 |
| Acciones en circulación | | | | ¿emitidas o en circulación? §2.4 |

PDFs a usar:
- **WALMEX** — https://www.walmex.mx/informacion-financiera/trimestral.html
- **FEMSA** — https://femsa.com/es/inversionistas/reportes-y-filings/reportes-trimestrales/

Diferencias que **sí** cuentan como explicables: miles vs millones (`decimals`),
reexpresión del comparativo, trimestre vs acumulado (§5.1). Las que **no**:
un campo que sólo cuadra si le aplicas un factor que no sale de ningún atributo.

---

## 8. Criterios (escritos antes, sin mover) y estado

**GO:** los 4 archivos bajan sin sesión ni captcha **·** los 9 campos salen con
los mismos tags en ambas emisoras **·** los valores cuadran contra el PDF exacto
o con diferencia explicable.

**NO-GO:** BMV bloquea o exige sesión **·** los tags cambian entre emisoras o
entre trimestres sin patrón **·** cualquier número no cuadra sin explicación.

| Criterio | Estado |
|---|---|
| 4 archivos bajan sin sesión | **no observado** (bloqueo mío, no de BMV) |
| 9 campos, mismos tags | **no observado** |
| Valores cuadran vs PDF | **no observado** |

**Veredicto: no emitido.** Llamarlo NO-GO sería culpar a BMV de un 403 de mi
proxy; llamarlo GO sería inventar. La compuerta queda abierta y los criterios
intactos.

### Plan B si al correrlo sale NO-GO: ¿CNBV o BIVA?

**CNBV es el plan B serio.** El visor de archivos XBRL de CNBV
(`xbrl.cnbv.gob.mx`) expone archivos con nombre
`ifrsxbrl_<CLAVE>_<AÑO>-<TRIMESTRE>.xbrl` — p.ej. `ifrsxbrl_ALFA_2019-2.xbrl`
**[SECUNDARIO]**. Eso es exactamente lo que le falta a BMV en el censo: un
**nombre de archivo derivable del ticker y del periodo**, sin id interno opaco de
por medio. Si ese patrón es estable y el archivo se sirve sin sesión, construir el
cosechador es casi trivial, y además CNBV es el **regulador**: es la fuente
primaria de la que BMV es redistribuidor, con obligación legal de publicarla y sin
incentivo de vendértela (§1.2). El riesgo es el opuesto al de BMV: portales de
gobierno mexicano con disponibilidad irregular, y el `idEnvio` que aparecía junto
al nombre en el ejemplo sugiere que puede hacer falta un índice de envíos que no
pude ver. **Es la primera puerta a tocar si BMV falla, y honestamente vale la pena
probarla aunque BMV funcione.**

**BIVA no es plan B, es complemento.** El problema no es técnico sino de universo:
BIVA es la bolsa alterna, con una fracción de las emisoras, y **el IPC es un
índice de BMV**. Un backtest de rotación sobre el IPC necesita las emisoras del
IPC; si BIVA no las lista, su XBRL — por bueno que sea — no alimenta este
backtest. Puede servir después, para la API LATAM, ampliando cobertura de nombres
que no están en BMV. Para la Fase 1 que motiva esto, no resuelve nada. **Orden de
intento: BMV → CNBV → (BIVA sólo para cobertura extra).**

---

## 9. Cómo cerrar la compuerta — corre esto en local

En `~/quantdesk2`, rama `claude/xbrl-fase0`, Node 24:

```bash
# 1) Censo de red con evidencia (9 requests, 1.2s entre cada uno)
node scripts/xbrl-smoke.mjs --probe
```

Anota: ¿algún `200`? ¿hay `set-cookie` con id de sesión? ¿redirect a login?
¿content-type de zip/xml o sólo HTML?

```bash
# 2) Baja los 4 a mano, con la pestaña Network abierta, y COPIA LA URL REAL
#    del request del archivo. Esa URL es el entregable más valioso de todo esto.
mkdir -p .xbrl-fase0
#   guarda como: walmex_2025_2.zip  walmex_2025_4.zip
#                femsa_2025_2.zip   femsa_2025_4.zip

# 3) Extracción + tablas + veredicto automático del criterio de tags
node scripts/xbrl-smoke.mjs --manual .xbrl-fase0

# 4) Si algún campo sale FALTA, descubre el tag real (no lo supongas):
node scripts/xbrl-smoke.mjs --file .xbrl-fase0/walmex_2025_2.zip --dump-tags
```

`.xbrl-fase0/` está en `.gitignore`. El raw no entra al repo.

Con eso pegado aquí, §6 y §7 se llenan y el veredicto se emite en una pasada.

---

## 10. Si sale GO: qué me preocupa de escalar a 35 × 14

Por orden de probabilidad de morder, no de gravedad:

1. **Los 14 años no existen (§3).** Es lo primero a aceptar: el plan real es
   2016+, ~10 años. Todo lo demás se dimensiona sobre eso.
2. **El id interno por emisora (§1.1).** `WALMEX-5214`, `FEMSA-5305`, `KOF-5525`
   — no hay fórmula. Hay que construir y **mantener** una tabla ticker→id de 35
   filas, y esa tabla se pudre sola cuando una emisora cambia de clave.
3. **Emisoras que cambiaron de nombre o se deslistaron.** Es el clásico
   **survivorship bias**, y en el IPC pega fuerte: si armas el universo con los 35
   de hoy y lo corres 10 años hacia atrás, el backtest miente hacia arriba por
   construcción. Necesitas la **composición histórica del IPC por fecha**, que es
   un dato aparte y que **no vi disponible en ningún lado durante este censo**.
   *Esta es, de lejos, la amenaza más seria al backtest — más que cualquier
   detalle de parseo.* Y ojo: una emisora deslistada probablemente también
   desaparece de la ficha de BMV, o sea que su XBRL puede no ser recuperable.
4. **Taxonomía cambiando de versión.** 10 años cruzan varias versiones anuales de
   IFRS y de la extensión mexicana. Elementos que se renombran o se deprecan
   rompen un cosechador que hardcodee un tag. El script ya está escrito con
   **listas de candidatos** justo por esto, pero a 10 años eso hay que volverlo un
   mapa versionado, no una lista de 3.
5. **Perfiles de taxonomía distintos (§2.1).** El IPC tiene FIBRAs y tuvo bancos.
   No usan la misma taxonomía que una comercial. Probablemente necesites un
   extractor por perfil, no uno solo.
6. **Rate limits desconocidos.** El volumen es chico — 35 × 40 trimestres ≈ 1,400
   archivos, una sola vez, después ~35 por trimestre. Con 1-2 s entre requests es
   una tarde. **No me preocupa el volumen; me preocupa no saber el límite.** Es
   dato que sale del probe.
7. **La bandera de licencia (§1.2).** Si el histórico masivo es producto de pago,
   1,400 descargas programáticas es precisamente el uso que un ToS prohíbe,
   aunque técnicamente funcione. Conviene leer los términos antes de cosechar,
   no después.

**Lo que NO me preocupa:** el parseo en sí. Un instance XBRL es XML regular y el
extractor dependency-free ya demostró que hace el trabajo. Si esto falla, va a
fallar por acceso, por licencia o por definiciones contables — no por código.

---

## 11. Decisiones a congelar antes de la Fase 1

Ninguna se puede cerrar sin §9. Se listan para que la Fase 1 arranque de aquí:

- **D1** — ¿Fuente primaria: BMV o CNBV? (§8)
- **D2** — Ventana histórica: ¿2016+ o pelear 2014-2015? (§3)
- **D3** — Definición de "deuda con costo": ¿IFRS-16 dentro o fuera? (§2.3)
- **D4** — ¿Ingresos y utilidad del trimestre o acumulados? (§5.1)
- **D5** — ¿Qué medida de acciones? (§2.4)
- **D6** — Capital contable: ¿total o sólo controladora? (§2.2)
- **D7** — De dónde sale la composición histórica del IPC. **Sin fuente identificada.** (§10.3)
