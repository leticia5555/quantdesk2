# FASE 0 — CONGRESO (STOCK Act): reconocimiento de fuentes

> **Alcance de este documento:** SOLO reconocimiento de fuentes. No hay parser
> acá, ni diseño de UI, ni el agente copy-Congreso — si el veredicto habilita
> seguir, la Fase 1 arranca de la lista de decisiones a congelar (§7).
>
> **Veredicto: VIABLE POR LA RUTA HOUSE**, con **tres compuertas abiertas**:
> G1 y G2 se cierran con un solo comando desde una IP con egress (§0, §6); la
> **compuerta legal §13107(c)** la cierra un abogado, con la pregunta ya
> redactada en **§4.2**, y es previa a la Fase 1.
>
> Fecha del reconocimiento: 2026-09-04. Actualiza y **contradice en un punto**
> el censo de `docs/stock-tracker-scope.md` §1.1 (2026-07-21).

**Pregunta única.** ¿Existe una fuente accesible, gratuita o barata, y
**legalmente redistribuible**, para publicar un feed de trades del Congreso US
al estilo de los perfiles automáticos que Robinhood Social lanzó con datos de
TipRanks?

**Respuesta corta.** Sí, pero **no es la que el censo de julio recomendaba**.
Julio dijo *"Senate primero (estructurado), House en fase 2"*. El
reconocimiento de hoy lo da vuelta: **House primero**. Dos razones, ambas
duras:

1. **Senate eFD parece haber quedado detrás de protección anti-bot** (Akamai)
   que bloquea IPs de datacenter — o sea, exactamente donde corre Vercel. Es
   evidencia de **una sola fuente** y no verificada por nosotros (§2.2): por eso
   es una compuerta (G2), no una conclusión.
2. **Ningún agregador barato sirve para un feed público.** FMP y Quiver
   prohíben redistribuir/mostrar sus datos a terceros en los planes normales
   (§3). El producto que queremos ES redistribución. Eso los mata como ruta
   principal, sin importar el precio.

Lo que queda en pie y no depende de ningún permiso comercial: **el ZIP/XML del
Clerk de la Cámara + los PDFs de PTR**, que son obra del gobierno US (dominio
público) y hoy se sirven por HTTPS plano, sin agreement ni WAF conocido.

---

## 0. Aviso de honestidad: el sondeo en vivo NO se pudo hacer

Se intentó pegarle de verdad a las cinco fuentes candidatas. **Ninguna es
alcanzable desde este entorno** y no se rodeó el bloqueo:

```
$ curl -o /dev/null -w "%{http_code}" https://disclosures-clerk.house.gov/
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "disclosures-clerk.house.gov:443" },
  { ... "host": "efdsearch.senate.gov:443" },
  { ... "host": "financialmodelingprep.com:443" },
  { ... "host": "api.quiverquant.com:443" },
  { ... "host": "www.capitoltrades.com:443" } ]
```

Es **el mismo precedente ya documentado dos veces en la casa**:
`docs/wheel-fase0.md` §0 y `docs/stock-tracker-scope.md` §4 (*"el entorno de
investigación de hoy bloqueaba `*.gov` … razón de más para el smoke real"*).

**Consecuencia para este memo:** todo lo que sigue sobre *formato, campos y
accesibilidad* es **documentación y reportes de terceros, no verificado en
vivo**, y está marcado como tal fuente por fuente. Lo que **sí** es duro y no
depende de ningún sondeo es el **análisis de licencias** (§3) — que es donde se
decide el veredicto, porque elimina a los agregadores antes de que el precio
importe.

**Entregable que cierra el hueco:** `scripts/congreso-phase0-probe.mjs` (sin
dependencias, mismo patrón que `pead-phase0-probe.mjs` y
`wheel-phase0-probe.mjs`). Corre ~15 requests, guarda los payloads crudos en
disco, **mide de verdad el % de PDFs escaneados** (no lo cita de un blog) e
imprime el veredicto de G1 y G2. Se corre donde haya egress:

```
npm i --no-save pdfjs-dist                        # extractor autoritativo (opcional pero necesario para G1)
node scripts/congreso-phase0-probe.mjs                        # G1 + G2
node scripts/congreso-phase0-probe.mjs --efiled=30 --paper=5  # muestra partida por clase
```

No pide ninguna key. No imprime credenciales. Las dos rutas que sondea son
públicas y anónimas. Los payloads crudos quedan en `./.congreso-phase0/`.

El probe **avisa si detecta un proxy de egress local** y, si las dos fuentes
dan 403 en su primer request, se niega a llamarlo veredicto: eso es el entorno,
no las fuentes. (Corrido desde acá da exactamente eso — por diseño.)

---

## 1. Cámara (House) — `disclosures-clerk.house.gov`

### 1.1 Qué promete la documentación (y los pipelines de terceros)

| Ítem | Lo documentado |
|---|---|
| Índice | ZIP anual `/public_disc/financial-pdfs/<YEAR>FD.zip`, con un solo `<YEAR>FD.xml` adentro |
| Cobertura del índice | Todos los años desde **2008**, todos los estados/distritos, todos los tipos de filing |
| Campos del XML | `Prefix, Last, First, Suffix, FilingType, StateDst, Year, FilingDate, DocID` |
| Filtro que nos importa | `FilingType = P` (Periodic Transaction Report) |
| Regeneración | Diaria (el ZIP del año en curso se reescribe) |
| PDF por filing | `/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf` |
| Gate de acceso | **Ninguno reportado**: HTTPS plano, sin login, sin agreement, sin captcha |
| Licencia | Obra del gobierno federal US → **dominio público**, sin copyright (la restricción de uso comercial de §13107(c) es otra cosa, ver §4) |

**El XML es SOLO índice.** Las transacciones viven **dentro de cada PDF**. Esa
es toda la dificultad de esta ruta: no hay datos estructurados de trades en la
Cámara, hay un directorio bien portado de PDFs.

### 1.2 G1 — ¿cuántos PDFs son texto y cuántos escaneados?

Es la pregunta (a) del encargo y **la respuesta honesta hoy es: no lo sé con
precisión, y quien dice saberlo tampoco lo midió públicamente.**

- Los PTRs generados por el sistema electrónico de la Cámara traen **capa de
  texto extraíble** — coincidencia entre múltiples pipelines.
- Los de papel/manuscritos son **imágenes escaneadas** y requieren OCR.
- La cifra que circula es **"~5% no parseables"**, concentrados en filings
  viejos. Viene de **un solo pipeline de terceros** (Apify / dev.to, abr-2026)
  y ya estaba citada como tal en el censo de julio. **Nadie publica el número
  oficial.** No la tomes como dato: tómala como orden de magnitud.
- Aviso adicional del mismo pipeline, que sí importa para el esfuerzo: los PDFs
  e-filed son machine-generated pero **el orden de extracción de texto es
  caótico** — el parser no puede asumir que las filas salen en orden de tabla.
  Hay que reconstruir por coordenadas o por regex con anclas, no leyendo líneas.

**G1 (compuerta binaria):** correr el probe y medir, sobre una muestra real de
PTRs recientes, qué fracción tiene capa de texto. El probe clasifica cada PDF
inflando sus content streams y buscando operadores de texto (`BT`/`Tj`/`TJ`)
vs. XObjects de imagen — sin librería de PDF, sin OCR.

- **G1 verde** (≥90% de los **e-filed** rinde los 5 campos del formulario) →
  House es la ruta, el MVP ignora los de papel y **lo dice en la UI**.
- **G1 rojo** (<90%) → el MVP de House cubre menos de lo prometido y hay que
  decidir OCR (caro, fuera de un serverless de 60s) o recortar el alcance.

> **Actualización tras la corrida 1 (§6.1):** el veredicto se juega **solo en
> los e-filed** (DocID `2xxxxxxx`), medidos por separado de los de papel
> (`9xxxxxx`). Mezclarlos en un porcentaje único escondía la respuesta. Y la
> medición necesita un extractor de PDF de verdad: la heurística sin
> dependencias dio un falso negativo, documentado en §6.1.

### 1.3 Volumen (para dimensionar el cron, no para el veredicto)

No hay estadística oficial anual publicada. Referencia histórica: el Comité de
Ética de la Cámara reportó **más de 4,000 PTRs** en el 115° Congreso (dos años),
de Miembros + oficiales + staff senior. Para el diseño alcanza con esto: el
flujo diario de PTRs nuevos es de **decenas, no miles** — el cron incremental
(bajar el ZIP, diff de `DocID`, parsear solo los nuevos) cabe holgado en el
`maxDuration: 60` de Vercel. El backfill histórico **no** cabe y va aparte, en
un GitHub Action, como ya hacemos con los crons sub-diarios (`docs/crons.md`).

---

## 2. Senado — `efdsearch.senate.gov`

### 2.1 El flujo, tal como lo documentaba el censo de julio

1. `GET /search/home/` → extraer `csrfmiddlewaretoken`.
2. `POST /search/home/` con `prohibition_agreement=1` → cookie de sesión.
3. `POST /search/report/data/` (estilo DataTables, `report_types:[11]` = PTR,
   paginado de a 100) → **JSON**.
4. PTR e-filed → **tabla HTML estructurada por transacción**, parseable sin OCR.
   PTR en papel → imagen escaneada. La mayoría e-filea.

Esto es lo que hacía atractivo al Senado: los datos ya vienen estructurados, sin
tocar un PDF. Sigue siendo cierto **si se puede entrar**.

### 2.2 Lo que cambió (y por qué ahora es compuerta, no ruta)

Reportes de 2026 describen eFD como una app Django **detrás de protección
anti-bot de Akamai**, con tres síntomas concretos:

- `curl` directo → **403**.
- El pool de **IPs de datacenter** (el caso de Apify por defecto) → bloqueado.
- Hace falta **proxy residencial pinneado** para sostener la sesión entre el
  POST del agreement y la consulta de datos.

**Vercel serverless es exactamente una IP de datacenter.** Si el reporte es
correcto, la categoría Senado no es "frágil": es **inviable en nuestra
arquitectura actual**, y ninguna cantidad de parser lo arregla.

**Actualización tras la corrida 1 (§6.1):** desde una IP residencial el
`GET /search/home/` responde **200 con CSRF** y el POST del agreement **también
200** — la puerta de entrada NO está cerrada. Lo que falla es específicamente
`POST /search/report/data/`, con **503 y cuerpo XHTML**. Es compatible con
bot-mitigation, pero también con un 5xx de la app o un shape de request
obsoleto; la corrida 2 lo distingue probando dos payloads.

**Calidad de esta evidencia: baja-media.** Es **una sola fuente** (el mismo
artículo de abr-2026 que aporta el "~5%"), corroborada solo por el hecho
genérico y bien documentado de que los rangos de AWS/GCP/Azure están
blacklisteados por defecto en muchos WAFs. No encontré un issue de GitHub ni un
scraper conocido que reporte la rotura con fecha. **Puede estar
desactualizada, exagerada, o ser específica del pool de Apify.** Por eso:

**G2 (compuerta binaria):** correr el flujo completo agreement→CSRF→POST JSON
desde la IP donde va a vivir el cron.
- **G2 verde** → el Senado entra en la Fase 1 como segunda fuente y la ruta
  vuelve a ser la de julio (Senado estructurado + House PDF).
- **G2 rojo (403 / challenge de Akamai)** → el Senado queda **fuera del MVP** y
  la UI lo dice de frente ("por ahora, solo Cámara de Representantes"). La
  alternativa —proxy residencial de pago— agrega costo recurrente, fragilidad y
  un olor legal que no quiero en un producto que ya carga §13107(c).

> Nota de arquitectura, por si G2 sale rojo y alguien propone el rodeo obvio:
> **GitHub Actions también corre en IPs de datacenter** (Azure). Mover el
> scraper a un Action *no* esquiva un bloqueo por rango de IP. Sirve para el
> problema de duración, no para el de reputación de IP.

---

## 3. Alternativas con API — el filtro que decide no es el precio, es la licencia

El encargo pedía precio, lag y licencia de uso. **La licencia elimina a casi
todos antes de que el precio importe**, porque QuantDesk quiere *publicar* el
feed, y publicar es redistribuir.

| Fuente | Precio (sep-2026, sin verificar en vivo) | Lag | Licencia para un feed público | Veredicto |
|---|---|---|---|---|
| **FMP** (`senate-trades`, `house-trades`, `senate-latest`, `house-latest`) | Planes ~$29–$79/mes (Starter/Premium); los endpoints de Congreso no aparecen en el free tier documentado | Días tras el filing | **Bloqueante.** Los ToS prohíben revender/sublicenciar/dar acceso a terceros a los datos; mostrar o redistribuir exige un *Data Display and Licensing Agreement* aparte | ❌ Descartado sin deal comercial |
| **Quiver Quantitative** (`/beta/live/congresstrading`) | API desde ~$30/mes (antes ~$10); tier "Trader" ~$75/mes para algunos datasets | Diario | **Bloqueante.** "Personal, non-commercial use only"; prohibido redistribuir, republicar, revender o poner a disposición de terceros sin autorización escrita | ❌ Descartado sin deal comercial |
| **Capitol Trades (2iQ)** | Sin API pública; los scrapers de terceros cobran (~$0.90/1k llamadas en ScrapingBee/Apify) | Diario | Los datos son su producto comercial; scrapear = violación probable de ToS | ❌ Descartado (igual que en julio) |
| **Disclosed Capitol** | Free key con 750 créditos; pay-as-you-go desde $5; suscripción $14.99/mes con 30k créditos | Tiempo real declarado sobre STOCK Act | **El único que declara uso comercial permitido**, con atribución al republicar salidas agregadas | 🟡 Único agregador que sobrevive el filtro |
| **Unusual Whales / Finnhub `congressional-trading`** | Premium | — | Redistribución no permitida / sin free tier | ❌ (ya descartados en julio) |
| **Senate/House Stock Watcher** | Gratis | — | — | ❌ **Muerto** (verificado en julio: S3 → 403, repos parados desde 2021, dominio expirado abr-2025). Los tutoriales que lo citan están desactualizados |

**Lectura.** Solo **Disclosed Capitol** pasa el filtro de licencia a precio de
juguete. Pero es un vendor chico y nuevo: apoyar el critical path de un módulo
de producto en él viola la regla que ya escribimos en julio (*"no apoyar el
critical path en ningún agregador"*, riesgo #7). Su lugar correcto es
**fallback y backfill**, no fuente primaria — y aun así, antes de mandarle un
dólar hay que leer sus ToS completos, no el resumen de un buscador.

---

## 4. Compuerta legal §13107(c) — **ABIERTA**

Esta es la **tercera compuerta** del proyecto, junto a G1 y G2. A diferencia de
esas dos, no la cierra un script: la cierra un abogado. Y **es previa a la Fase
1**, no posterior.

### 4.1 El estatuto, con precisión

EIGA §105(c), hoy **5 U.S.C. §13107(c)**, prohíbe obtener o usar los reportes
de disclosure, entre otras cosas, **para cualquier propósito comercial** — con
una excepción explícita: *"other than by news and communications media for
dissemination to the general public"*. Aplica a **ambas cámaras**; que el Clerk
de la Cámara no te haga clickear un agreement y el Senado sí, no cambia el
estatuto, solo cambia quién te lo pone enfrente.

La exposición es **civil, por acción del Attorney General**, con multa tope
(ajustada por inflación). El monto exacto vigente y el mecanismo procesal son
parte de lo que confirma el abogado — no los doy por sabidos acá.

### 4.2 La pregunta que va al abogado (una, concreta)

> **QuantDesk es un producto SaaS que cobra suscripción por sus módulos de
> research (DCF, simulaciones, agentes). Queremos publicar un feed de PTRs del
> STOCK Act — datos públicos del Clerk de la Cámara y de eFD — en español, en
> modo mostrar-solo: sin ejecución de órdenes, sin recomendación, con el lag
> legal y los rangos de monto declarados en cada tarjeta.**
>
> **(a) ¿Un feed público y gratuito de PTRs, dentro de un producto que cobra
> por OTRAS funciones, cae dentro de la excepción de "news and communications
> media for dissemination to the general public" de 5 U.S.C. §13107(c)(1)(B)?
> ¿O el hecho de que la empresa que lo publica monetice otras partes del
> producto lo convierte en "commercial purpose" aunque el feed en sí no se
> cobre?**
>
> **(b) Si la respuesta es "solo si es gratis y abierto": ¿qué tiene que ser
> cierto exactamente? ¿Basta con que el feed no esté detrás del paywall, o
> también tiene que ser accesible sin cuenta, sin registro y sin rate-limit
> por plan? ¿Cambia algo si el feed convive en la misma app con módulos de
> pago, o hay que separarlo de dominio/producto?**

Es una pregunta de sí/no con una condicional, no una revisión abierta. Eso es a
propósito: es la condición 2 que ya fijó el censo de julio, y está redactada
para que se pueda responder en una consulta puntual.

### 4.3 Qué cambia en el diseño si la respuesta es "solo si es gratis y abierto"

Esto **no se decide después de construir**. Si la respuesta es esa, la Fase 1
arranca con estas restricciones congeladas desde el día uno:

1. **El feed del Congreso NUNCA va detrás del paywall.** Ni ahora con
   `PAYWALL_ENABLED` apagado (`api/_lib/paywall.js` — hoy toda la app está
   abierta), ni cuando se encienda. La categoría queda **excluida por código**
   del gate de paywall, no por configuración: una env var que alguien flipea
   por error no puede meter datos de §13107(c) detrás de una suscripción.
2. **Sin gating por cuenta ni por plan.** Nada de "regístrate para ver más",
   nada de límite de tarjetas por tier. El rate-limit que quede es
   anti-abuso de infraestructura, igual para todos, no un escalón de producto.
3. **Ruta pública propia**, indexable, del estilo `/congreso` — mismo patrón
   que `/liga` y `/hoy` en `vercel.json`. Que "dissemination to the general
   public" sea verificable abriendo una URL, no explicando una arquitectura.
4. **El agente copy-Congreso de la Fase 2 hereda la duda.** Un agente que
   *opera* con base en esos datos dentro de un producto de pago es un caso
   más difícil que un feed informativo — aunque sea paper trading. Si (a) sale
   ambiguo, la Fase 2 **no** arranca sin una segunda pregunta específica sobre
   ella.
5. **Atribución y origen visibles en cada tarjeta**: enlace al PDF/filing
   original en el sitio del Clerk. Es lo que convierte al feed en difusión de
   un documento público, no en un producto de datos derivado.

Si la respuesta a (a) es "sí, la excepción cubre el caso", los puntos 1–3 se
quedan igual de todos modos: son baratos, y son la postura que hace defendible
al producto. Lo que cambia es que dejan de ser obligatorios.

### 4.4 Robinhood no es precedente para nosotros — y esto es parte del riesgo

Es tentador mirar a Robinhood Social y concluir "si ellos lo hacen, se puede".
**No aplica, por una diferencia estructural:**

- **Robinhood no toca los filings.** Los datos de políticos, insiders y hedge
  funds de Robinhood Social vienen de **TipRanks**, un proveedor tercero, y
  cada tarjeta **atribuye a TipRanks**. Robinhood es *licenciatario*: la
  relación con §13107(c) —y el riesgo de que alguien la cuestione— la carga el
  proveedor, que se la vendió bajo contrato.
- **Nosotros seríamos fuente primaria, sin intermediario.** Bajamos el ZIP del
  Clerk, parseamos el PDF, publicamos. No hay un contrato de licencia entre
  nosotros y el estatuto. **Todo el riesgo es nuestro, directo.**

Y es justo la contracara de la decisión de §3: los agregadores que *podrían*
hacer de intermediario (FMP, Quiver) están descartados porque **prohíben
redistribuir**. O sea: pagar un proveedor para que cargue la licencia —el
arreglo de Robinhood— **no está disponible a nuestro precio**. La ruta directa
no es solo la más barata: por ahora es la única, y viene con el riesgo pegado.

Esto no cambia el veredicto de §6 (el riesgo sigue dimensionado como bajo por
las razones de julio). Cambia **quién lo carga**: nosotros, no un vendor. Va en
la pregunta al abogado como contexto, no como argumento.

### 4.5 Lo que ya estaba fijado en julio y sigue igual

El censo de julio dimensionó el riesgo como **bajo** (cero enforcement en 13
años; precedente análogo favorable *FEC v. Political Contributions Data*, 2d
Cir. 1991; toda la industria —Autopilot incluido— opera sobre estas fuentes) y
fijó **tres condiciones de activación**, que este memo NO toca y NO da por
cumplidas:

1. Smoke real de las fuentes desde producción → **esto es G1/G2, lo cierra el probe**.
2. **Consulta legal puntual** → **es §4.2, y sigue ABIERTA**.
3. Modo **mostrar-solo**, con disclaimer informativo, sin ejecución ni recomendación.

**Triggers de paro monitoreables** (sin cambios): primera acción del DOJ bajo
§13107(c) contra cualquier tracker, o ley nueva que restrinja el uso de los
disclosures.

---

## 5. La honestidad que va en la UI, no en el README

El encargo lo pide explícito y el reconocimiento lo confirma con números:

- **Plazo legal:** el PTR es obligatorio para trades >$1,000, dentro de 30 días
  desde la notificación del broker y **máximo 45 días desde el trade**. Multa
  por retraso: **$200**, rutinariamente condonada.
- **Lag real observado** (dataset Signal Congress, n≈29.8k trades, citado en el
  censo de julio): **mediana ≈26 días** trade→filing, ~90% dentro de los 45
  días, **~10% tarde**.
- **Montos en rango, nunca exactos.** Buckets del formulario: $1,001–$15k ·
  $15k–$50k · $50k–$100k · $100k–$250k · $250k–$500k · $500k–$1M · $1M–$5M ·
  $5M–$25M · $25M–$50M · >$50M.
- **El ticker no siempre existe.** Bonos, fondos y cripto llegan con `--` y solo
  descripción de texto libre. La card tiene que degradar, no romperse.
- **Cobertura parcial declarada.** Si G1 sale con escaneados y G2 sale rojo, la
  UI dice *"Cámara de Representantes; algunos filings en papel no se procesan"*
  — no se disimula con un feed que parece completo.

Cada card lleva **fecha del trade Y fecha del filing**, con el lag calculado por
trade ("presentado 34 días después"), igual que ya hace TRACKER con 13F/Form 4.
Ese contraste —Form 4 a 2 días hábiles vs. Congreso a 26–45 días— es el mejor
argumento de honestidad que tiene el producto, y es gratis: ya tenemos las dos
fuentes en la misma app.

---

## 6. VEREDICTO

### **VIABLE POR LA RUTA HOUSE** — fuente oficial directa, Senado detrás de G2

**La ruta recomendada, una sola:**

> **ZIP/XML anual del Clerk de la Cámara como índice + parsing de los PDFs de
> PTR con capa de texto, sin OCR, corriendo como cron incremental sobre Neon.
> Cero agregadores en el critical path. Senado solo si G2 sale verde.**

**Por qué esta y no otra:**
- Es la única gratis **y** redistribuible (dominio público). FMP y Quiver
  mueren por licencia, no por precio.
- Es la única sin gate de acceso reportado — el Senado hoy es una incógnita con
  evidencia negativa, y los agregadores comerciales son un contrato.
- El formato es aburrido y estable: un ZIP regenerado a diario desde 2008. La
  fragilidad que teníamos en julio (un endpoint JSON interno no documentado del
  Senado) desaparece.

**Costo en horas (estimado, patrón `vc-feed`/`stock-tracker` ya en casa):**

| Bloque | Horas |
|---|---|
| Descarga ZIP + lector ZIP sin dependencias + parser del XML índice + diff de `DocID` | 3–4 |
| Extractor de texto de PDF sin dependencias (o `pdf-parse` si se acepta la dep) + regex con anclas para la tabla de transacciones | **6–8** ← el grueso, y el que más se puede desviar por el orden caótico de extracción |
| Normalización (buckets de monto, tipo, owner, ticker faltante, fecha trade vs filing) + esquema y tabla en Neon | 3–4 |
| Endpoint del feed + doble cache + `?smoke=1` + cron incremental | 2–3 |
| Backfill histórico en GitHub Action (año en curso + anterior) | 2 |
| **Total Fase 1 (solo datos, sin UI ni agente)** | **16–21 h** |
| Senado, **solo si G2 verde** (agreement + JSON + parser de tabla HTML) | +6–10 |
| OCR, **solo si G1 rojo** | +8–12 y sale del serverless |

**El caveat, dicho de frente:** *esta ruta entrega un feed que **no es el
Congreso completo, es la Cámara** — 435 miembros, sí, pero sin los senadores,
que son justo los nombres que traen tráfico a un tracker. Si G2 sale rojo, hay
que resistir la tentación de comprar un proxy residencial y en cambio decirlo en
la UI. Y aun con G1 verde, un porcentaje de filings en papel queda afuera: el
feed es **incompleto por diseño**, y eso también se declara.*

### 6.1 Corrida 1 — 2026-09-08, MacBook, IP residencial, sin VPN

Primera corrida real. **Lo que cerró, lo que no, y un error mío.**

```
═══ G1 — CAMARA (disclosures-clerk.house.gov) ═══
  [1/3] ZIP indice: .../public_disc/financial-pdfs/2026FD.zip
  ✓ HTTP 200 — 0.05 MB en 692ms
  ✓ 2026FD.xml — 0.41 MB

  [2/3] Indice XML
  ✓ 1603 filings en el indice · 379 son PTR (FilingType=P)
    tipos: C=770 · P=379 · X=247 · W=101 · D=68 · A=34 · H=2 · T=2
    ejemplo: Mark Alford · MO04 · filed 3/31/2026 · DocID 20034201

  [3/3] Muestra de 20 PDFs
    20035392 indeterminado  0 textOps   91 KB   0/5 marcadores
    20035190 texto          2 textOps  145 KB   0/5
    9116328  texto          2 textOps  556 KB   1/5
    9116326  escaneado      0 textOps   43 KB   0/5
    9116311  escaneado      0 textOps   24 KB   0/5
    ...(15 de 20 "indeterminado", todos con textOps=0, 61-91 KB)...

    con capa de texto: 3/20 (15.0%) · escaneados: 2/20 · indeterminados: 15/20
    errores HTTP: 0
  → G1 ROJO: 15.0% con texto (umbral 90%)

═══ G2 — SENADO (efdsearch.senate.gov) ═══
  [1/3] GET /search/home/    ✓ HTTP 200 (468ms) · csrf encontrado
  [2/3] POST /search/home/   ✓ HTTP 200 (504ms)   ← el agreement SÍ pasa
  [3/3] POST /search/report/data/
        ✗ HTTP 503 (338ms) — cuerpo: <!DOCTYPE html ... XHTML 1.0 Transitional
  → G2 ROJO: el endpoint JSON no responde desde esta IP
```

#### Lo que esta corrida SÍ cerró (y es lo importante)

**La ruta de la Cámara es accesible desde una IP cualquiera, sin gate.**
ZIP en 692 ms, XML de 0.41 MB con 1,603 filings y **379 PTRs**, y **20 de 20
PDFs bajados con HTTP 200**. Sin login, sin agreement, sin captcha, sin WAF.
Eso era la premisa de toda la recomendación de §6 y **queda confirmado**.

#### El "G1 ROJO" es un FALSO NEGATIVO del extractor, no un hecho sobre los PDFs

No lo tomo como veredicto, y la razón está en los propios números:

- **15 PDFs "indeterminado" con `textOps=0` y 61–91 KB.** Un PTR escaneado de
  una página pesa lo que pesa una imagen; un PDF de 63 KB **con `/Font`
  presente** (por eso cae en "indeterminado" y no en "escaneado") es un PDF de
  texto que mi extractor no supo abrir.
- **Los 3 que sí clasificó "texto" dieron `textOps=2`.** Una página de PTR
  tiene decenas de operadores de texto, no dos. O sea: incluso donde "funcionó",
  infló un stream chico y falló con los de contenido.
- **0/5 marcadores del formulario en toda la muestra.** Si de verdad hubiera
  extraído texto de un PTR, "Transaction Date" o un bucket de monto tenían que
  aparecer. No aparecieron en ninguno. Eso no es un dato sobre la Cámara: es un
  extractor roto.

**Veredicto honesto de G1: INDETERMINADO, no rojo.** La v2 del probe lo trata
así explícitamente — con cero texto extraído y sin librería de PDF, se niega a
emitir veredicto.

#### Corrección de una hipótesis que se descartó

Se sospechó que la muestra no filtraba `FilingType=P` y traía reportes anuales
(lo que explicaría los 0/5 marcadores). **No es el caso:** el probe filtra a
`P` antes de ordenar y muestrear (`ptrs = members.filter(m => m.type === 'P')`
→ `sorted` → `sample`), y la evidencia lo respalda — los 20 DocIDs resolvieron **200 OK bajo `/ptr-pdfs/`**, cosa que un
reporte anual no hace. La causa es la del punto anterior, no la muestra.

#### Lo que la corrida sí enseñó sobre la partición e-filed / papel

Los DocID `9116xxx` (papel) se comportan distinto de los `2003xxxx` (e-filed) y
la v1 los mezclaba en un solo porcentaje, escondiendo justo lo que la pregunta
(a) quería saber. Confirmado en los datos: los dos `escaneado` de la muestra son
`9116326` y `9116311`. La v2 **parte la muestra por clase** y da un porcentaje
por cada una — el veredicto de G1 se juega **solo en los e-filed**, porque los
de papel ya se sabe que necesitan OCR y están fuera del MVP por diseño.

#### G2 — rojo, pero con un matiz que importa

**No es 403 en la puerta: es 503 en el último paso.** El `GET /search/home/`
devolvió 200 con CSRF, y el **POST del agreement pasó (200)**. Muere
específicamente en `POST /search/report/data/`, devolviendo XHTML en vez de
JSON. Eso es compatible con bot-mitigation, pero **también** con un 5xx de la
app o con un shape de request que el endpoint ya no acepta. La v1 no permitía
distinguir.

La v2 lo resuelve: pacing de 2 s entre pasos, **dos intentos** con el mismo
juego de headers (`Referer`, `Origin`, `X-CSRFToken`, `X-Requested-With:
XMLHttpRequest` — ya estaban en la v1) pero **distinto payload** (el simple y
el DataTables completo), y toma la **huella del cuerpo de error** (`<title>`,
`Reference #`, marcas de WAF). Si los dos shapes fallan igual, no es el request:
es la puerta, y el Senado queda fuera y se declara.

### 6.2 Corrida 2 (PENDIENTE)

```
npm i --no-save pdfjs-dist
node scripts/congreso-phase0-probe.mjs --efiled=30 --paper=5
```

Cierra G1 con extractor autoritativo y porcentajes separados por clase, y G2
con los dos intentos. **Hasta que esta corrida esté acá, G1 y G2 siguen
abiertas.**

### Lo que falta para cerrar la Fase 0 (no es opcional)

1. Correr `scripts/congreso-phase0-probe.mjs` desde una IP con egress y pegar
   su salida acá abajo, en un §6.1 nuevo. **G1 y G2 se cierran con números
   propios, no con citas.**
2. La **consulta legal puntual** — la pregunta está redactada en **§4.2** y la
   compuerta está **ABIERTA**. Es previa al primer PR de datos, no posterior.
3. Leer los ToS completos de Disclosed Capitol antes de considerarlo siquiera
   como fallback.

Hasta que 1 y 2 no estén, la Fase 1 no arranca.

---

## 7. Si es viable: decisiones que la Fase 1 tiene que CONGELAR

Ninguna se decide en este memo. Se listan para que la Fase 1 no las improvise.

**Datos**
1. Ventana del MVP: ¿año en curso, o año en curso + anterior?
2. ¿Se guarda el PDF crudo (o su hash) para auditar un parseo dudoso?
3. Matching legislador→partido/estado: el XML trae `StateDst` pero no partido ni
   bioguide ID. ¿Config estática nuestra (~535 filas) o se deriva?
4. Qué hacer con una fila que no parsea: ¿se descarta en silencio, o entra con
   `parse_status = 'failed'` y se cuenta en la UI? (Mi voto: lo segundo — es la
   misma honestidad de lag aplicada a la cobertura.)
5. Ticker faltante: ¿se intenta resolver desde la descripción, o se muestra la
   descripción cruda? (Resolver = inventar; cuidado.)

**Producto**
6. ¿Feed global cronológico, perfil por legislador, o los dos desde el día uno?
   (Robinhood/TipRanks hace los dos; el perfil es lo que engancha.)
7. Copy exacto del disclaimer de lag y de cobertura parcial, en español.
8. ¿Entra en TRACKER como categoría A (lo que decía julio) o es tab propio?
   **Restricción heredada:** si la compuerta §4 sale "solo si es gratis y
   abierto", la categoría queda excluida **por código** del gate de paywall y
   necesita ruta pública propia (§4.3) — eso condiciona dónde puede vivir.
9. Atribución en cada tarjeta: enlace al filing original del Clerk. No es
   estética, es lo que sostiene el argumento de "difusión de documento
   público" (§4.3.5) — y es la diferencia con Robinhood, que atribuye a su
   proveedor porque la licencia la carga él (§4.4).

**Agente copy-Congreso (Fase 2, ni se diseña acá)**
10. Regla de copia: ¿qué hace el agente con un rango de monto y 26 días de
    retraso? El tamaño de posición **no** es derivable del bucket.
11. Cuenta Alpaca paper propia y `agent_id` propio en la liga, o queda fuera del
    leaderboard por no ser comparable con el resto (los otros agentes deciden
    con información del día; este decide con información de hace un mes).
12. Cómo se etiqueta en el leaderboard para que nadie lea "copy-Congreso ganó"
    como "copiar al Congreso funciona" con n de tres meses.
13. **Precondición de §4.3.4:** si la respuesta legal sale ambigua, la Fase 2 no
    arranca sin una segunda pregunta específica sobre el agente.

---

## 8. Fuentes consultadas

Todas por búsqueda web; **ninguna verificada con request propio desde este
entorno** (§0).

- Clerk de la Cámara — portal de Public Disclosure: https://disclosures-clerk.house.gov/
- Ejemplo de PTR PDF (patrón de URL): https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033337.pdf
- Comité de Ética de la Cámara — Financial Disclosure: https://ethics.house.gov/financial-disclosure/
- Comité de Ética del Senado — Financial Disclosure: https://www.ethics.senate.gov/public/index.cfm/financialdisclosure
- Senado — Public Disclosure: https://www.disclosure.senate.gov/
- Pipeline de terceros (origen del "~5% escaneados" y del reporte de Akamai en eFD): https://dev.to/seralifatih/i-built-two-apify-actors-that-scrape-us-congress-trading-data-directly-from-government-sources-47m1
- Apify — US House Trading Pipeline (estructura ZIP/XML/PDF): https://apify.com/seralifatih/congress-trading-pipeline-1
- Apify — House Financial Disclosures Scraper (índice PFD): https://apify.com/parseforge/house-financial-disclosures-scraper
- `timothycarambat/senate-stock-watcher-data` (esquema JSON histórico; nota de escaneados): https://github.com/timothycarambat/senate-stock-watcher-data
- `neelsomani/senator-filings` ("some periodic transaction reports are PDFs, which are ignored"): https://github.com/neelsomani/senator-filings
- FMP — endpoints de Congreso: https://site.financialmodelingprep.com/developer/docs/stable/senate-trading · https://site.financialmodelingprep.com/developer/docs/stable/house-trading
- FMP — Terms of Service (prohibición de redistribución): https://site.financialmodelingprep.com/terms-of-service
- FMP — planes: https://site.financialmodelingprep.com/pricing-plans
- Quiver — pricing de API: https://api.quiverquant.com/pricing/
- Quiver — Terms of Use (uso personal no comercial): https://www.quiverquant.com/termsofservice/
- Disclosed Capitol — API y pricing: https://www.disclosedcapitol.com/data-files/api · https://www.disclosedcapitol.com/developers
- Capitol Trades — disclaimer: https://www.capitoltrades.com/disclaimer
- Robinhood — HOOD Summit 2025 (anuncio de Robinhood Social): https://robinhood.com/us/en/newsroom/hood-summit-2025-news/
- TipRanks — cobertura de trading del Congreso: https://www.tipranks.com/news/labs/follow-congress-trading-activity-with-tipranks
- CRS — Stock Trading in Congress: https://www.congress.gov/crs_external_products/TE/HTML/TE10073.html
- 5 U.S.C. §13107 (texto del estatuto, incl. la excepción de news media en (c)(1)(B)): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title5-section13107
- Robinhood Social — atribución de los datos de políticos/insiders/hedge funds a TipRanks: https://robinhood.com/us/en/newsroom/hood-summit-2025-news/
- Contexto de WAFs bloqueando rangos de datacenter: https://scrapfly.io/blog/posts/403-forbidden-web-scraping

**Fuentes internas:** `docs/stock-tracker-scope.md` (censo 2026-07-21, §1.1 y
§5) · `docs/wheel-fase0.md` (precedente del bloqueo de egress) ·
`docs/crons.md` · `api/stock-tracker.js` · `api/vc-feed.js` (patrón `?smoke=1`).
