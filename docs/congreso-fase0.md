# FASE 0 — CONGRESO (STOCK Act): reconocimiento de fuentes

> **Alcance de este documento:** SOLO reconocimiento de fuentes. No hay parser
> acá, ni diseño de UI, ni el agente copy-Congreso — si el veredicto habilita
> seguir, la Fase 1 arranca de la lista de decisiones a congelar (§7).
>
> **Veredicto: VIABLE POR LA RUTA HOUSE**, con **dos compuertas binarias
> abiertas** (G1 y G2) que se cierran con un solo comando desde una IP con
> egress — ver §0 y §6.
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
node scripts/congreso-phase0-probe.mjs            # G1 + G2
node scripts/congreso-phase0-probe.mjs --pdfs=40  # muestra más grande para el % escaneado
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

- **G1 verde** (≥90% con texto en filings del año en curso) → House es la ruta,
  el MVP ignora los escaneados y **lo dice en la UI**.
- **G1 rojo** (<90%) → el MVP de House cubre menos de lo prometido y hay que
  decidir OCR (caro, fuera de un serverless de 60s) o recortar el alcance.

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

## 4. Lo legal, en una línea (no cambió desde julio)

EIGA §105(c), hoy **5 U.S.C. §13107(c)**, prohíbe usar los reportes de
disclosure con **fines comerciales**, con excepción explícita de la **difusión
al público general**. Aplica a **ambas cámaras** — que el Clerk de la Cámara no
te haga clickear un agreement y el Senado sí, no cambia el estatuto.

El censo de julio ya dimensionó el riesgo como **bajo** (cero enforcement en 13
años; precedente análogo favorable *FEC v. Political Contributions Data*, 2d
Cir. 1991; toda la industria —Autopilot incluido— opera sobre estas fuentes) y
fijó **tres condiciones de activación**, que este memo NO toca y NO da por
cumplidas:

1. Smoke real de las fuentes desde producción → **esto es G1/G2, lo cierra el probe**.
2. **Consulta legal puntual** (una pregunta concreta, no una revisión abierta) → **sigue abierta**.
3. Modo **mostrar-solo**, con disclaimer informativo, sin ejecución ni recomendación → decisión de diseño de Fase 1.

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

### 6.1 Salida del probe (PENDIENTE — acá va)

> Correr `node scripts/congreso-phase0-probe.mjs` desde una IP con egress real
> y pegar la salida completa acá. Mientras este bloque diga PENDIENTE, **G1 y
> G2 siguen abiertas** y el veredicto de §6 es una recomendación con evidencia
> de terceros, no un hecho medido.

```
(pendiente)
```

### Lo que falta para cerrar la Fase 0 (no es opcional)

1. Correr `scripts/congreso-phase0-probe.mjs` desde una IP con egress y pegar
   su salida acá abajo, en un §6.1 nuevo. **G1 y G2 se cierran con números
   propios, no con citas.**
2. La **consulta legal puntual** (condición 2 de julio) — sigue abierta y es
   previa al primer PR de datos, no posterior.
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

**Agente copy-Congreso (Fase 2, ni se diseña acá)**
9. Regla de copia: ¿qué hace el agente con un rango de monto y 26 días de
   retraso? El tamaño de posición **no** es derivable del bucket.
10. Cuenta Alpaca paper propia y `agent_id` propio en la liga, o queda fuera del
    leaderboard por no ser comparable con el resto (los otros agentes deciden
    con información del día; este decide con información de hace un mes).
11. Cómo se etiqueta en el leaderboard para que nadie lea "copy-Congreso ganó"
    como "copiar al Congreso funciona" con n de tres meses.

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
- Contexto de WAFs bloqueando rangos de datacenter: https://scrapfly.io/blog/posts/403-forbidden-web-scraping

**Fuentes internas:** `docs/stock-tracker-scope.md` (censo 2026-07-21, §1.1 y
§5) · `docs/wheel-fase0.md` (precedente del bloqueo de egress) ·
`docs/crons.md` · `api/stock-tracker.js` · `api/vc-feed.js` (patrón `?smoke=1`).
