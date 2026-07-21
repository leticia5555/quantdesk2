# Stock Tracker — Censo de fuentes y diagnóstico de alcance

Fecha del censo: 2026-07-21.

## Decisión (aprobada 2026-07-21)

- **v1 = Insider buys destacados (Form 4) + Movimientos 13F**, como **tab nuevo** (no extensión de SMART $). Sin cambios tras el research de Autopilot.
- **Congreso: ACTIVABLE** (reformulado 2026-07-21 tras research de Autopilot; antes "pausado por revisión legal"). Se construye tras cumplir TRES condiciones:
  1. Smoke de efdsearch.senate.gov desde Vercel real → OK.
  2. Consulta legal puntual (no una revisión abierta — una pregunta concreta sobre nuestro caso).
  3. Modo **mostrar-solo** con disclaimer informativo (sin ejecución, sin recomendación).

  Base de la reformulación: (a) Autopilot usa las mismas fuentes públicas gratis — procesa los filings ellos mismos, sin agregadores — y su registro como RIA existe porque **ejecutan** trades; nuestro modo mostrar-solo no lo requiere. (b) Cero enforcement en 13 años de EIGA §105(c) (hoy 5 U.S.C. §13107(c)). (c) Precedente análogo favorable: *FEC v. Political Contributions Data* (2d Cir. 1991) — republicar datos públicos de disclosure con fines informativos. (d) El memo de Ballard Spahr sobre el espacio ni lo menciona como riesgo.

  **Triggers de paro monitoreables** (si ocurre cualquiera, la categoría se congela y se reevalúa): primera acción del DOJ bajo §13107(c) contra cualquier tracker, o ley nueva que restrinja el uso de los disclosures.
- **Gate previo al primer PR de v1:** smoke tests desde Vercel real contra www.sec.gov (atom + Archives), data.sec.gov (submissions) y OpenFIGI. Endpoint: `GET /api/stock-tracker?smoke=1` (mismo patrón que vc-feed). Hasta que el smoke pase en producción, no se construyen las categorías.
- **Fix de honestidad pendiente (aparte, tracked como issue):** los paneles de SMART $ generados por Claude (institutional / short interest / options) llevan mínimo un disclaimer estilo #55; el reemplazo del panel institutional con 13F real viene después de la v1.

Regla de diseño: cada categoría existe solo con fuente real y gratuita detrás. Nada de IA inventando trades. Framing del producto: **honestidad de lag** — los datos llegan con retraso legal y se dice de frente.

---

## 1. Censo por fuente

### 1.1 Congreso US (STOCK Act) — 🟡 viable, pero es la fuente más frágil

**Plazos legales (confirmado):** PTR obligatorio para trades >$1,000, dentro de 30 días desde la notificación del broker y **máximo 45 días desde el trade**. Multa por retraso: $200 (rutinariamente condonada). Lag observado (dataset Signal Congress, n≈29.8k trades): mediana ≈26 días trade→filing, ~90% dentro de los 45 días, ~10% tarde.

**Senate — efdsearch.senate.gov:**
- Requiere aceptar un agreement: GET `/search/home/` → extraer `csrfmiddlewaretoken` → POST con `prohibition_agreement=1` → cookie de sesión.
- Existe endpoint JSON **interno, no documentado**: `POST /search/report/data/` (estilo DataTables; `report_types:[11]` = PTR, paginado de a 100). Estable desde ~2019 (varios scrapers activos lo usan), pero puede romperse sin aviso.
- PTRs e-filed → **tabla HTML estructurada** por transacción (parseable sin OCR). PTRs en papel → imágenes escaneadas (OCR). La mayoría de senadores usa e-filing.

**House — disclosures-clerk.house.gov:**
- PTRs = **PDFs individuales** (`/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf`).
- Índice estructurado: ZIP anual `/public_disc/financial-pdfs/<YEAR>FD.zip` con XML (nombre, estado/distrito, FilingType=P, DocID, fecha de filing), regenerado a diario. **El XML es solo índice — las transacciones viven dentro de los PDFs.**
- PDFs del sistema electrónico traen texto extraíble; los de papel/manuscritos requieren OCR (~5% "unparseable" según un pipeline tercero; sin cifra oficial).

**Agregadores gratuitos — estado real 2026:**

| Agregador | Estado | Veredicto |
|---|---|---|
| Senate/House Stock Watcher | **Muerto.** Buckets S3 → 403 AccessDenied (verificado directo), repos parados desde 2021, dominio expirado abr-2025 | Descartado. Tutoriales que lo citan están desactualizados |
| Capitol Trades (2iQ) | Vivo, sin API pública; los datos son su producto comercial | Scrapear = violación probable de ToS. Descartado |
| Quiver Quantitative | API desde ~$10/mes (uso no comercial), sin tier gratuito permanente | Descartado para producto gratuito |
| Unusual Whales | Web politics gratis para humanos; API de pago, redistribución no permitida | Descartado |
| Finnhub `/stock/congressional-trading` | Existe pero es **Premium**, no free tier | Descartado |
| Repos GitHub mantenidos (congresskit, etc.) | Activos pero ninguno publica bulk JSON gratuito estilo Stock Watcher | No hay sucesor gratuito confiable |

**Conclusión:** en 2026 no existe agregador gratuito confiable. La ruta realista es **fuente oficial directa**: JSON interno de eFD (Senate) + ZIP/XML índice de House + parsing de PDFs. MVP realista: **Senate primero** (estructurado), House en fase 2 limitado a PDFs e-filed con texto extraíble (sin OCR en MVP).

**Campos por trade:** legislador (nombre; sin ID bioguide — matching manual), ticker (**no siempre** — bonos/fondos/cripto traen `--` y solo descripción de texto libre), tipo (Purchase / Sale full / Sale partial / Exchange), rango de monto en buckets ($1,001–$15k, $15k–$50k, $50k–$100k, $100k–$250k, $250k–$500k, $500k–$1M, $1M–$5M, $5M–$25M, $25M–$50M, >$50M), fecha de trade, fecha de filing (→ lag calculable por trade), owner (Self / Spouse / Joint / Dependent Child).

**⚠️ Riesgo legal específico (dimensionado — ver Decisión):** el agreement de eFD refleja la Ethics in Government Act §105(c) (hoy 5 U.S.C. §13107(c)) — prohíbe usar los reportes para **fines comerciales** (con excepción de difusión al público general). Research 2026-07-21: cero enforcement en 13 años, precedente análogo favorable (*FEC v. Political Contributions Data*, 2d Cir. 1991), y los players del espacio (Autopilot incluido) operan sobre las mismas fuentes sin que ningún memo del sector lo marque como riesgo. Queda una consulta legal puntual como condición de activación, no una revisión abierta.

### 1.2 Insiders corporativos (SEC Form 4) — 🟢 la fuente más sólida

- **XML estructurado** (`ownershipDocument`) obligatorio desde 2003. Campos: `rptOwnerName`, `rptOwnerCik`, `isDirector`/`isOfficer`/`isTenPercentOwner`, `officerTitle` (texto libre, p.ej. "Chairman, CEO"), issuer + `issuerTradingSymbol` (⚠️ puede venir vacío — no usar como clave), `transactionCode` (P=compra open-market, S=venta, A=award, M=ejercicio, F=retención fiscal, G=regalo), shares, precio, fecha de transacción, shares tras la transacción, flag 10b5-1 (desde 2023 — distingue compras programadas de discrecionales). La fecha de filing sale de los metadatos del submission, no del XML.
- **Lag legal: 2 días hábiles** desde la transacción (Section 16(a)). El feed de EDGAR es casi tiempo real (<1 s tras dissemination).
- **Feed global:** atom `browse-edgar?action=getcurrent&type=4&output=atom` (máx 100/página).
- **Por persona: sí.** Los insiders tienen CIK propio (Elon Musk = CIK 0001494730) y cada Form 4 se indexa bajo el CIK del owner Y del issuer. `data.sec.gov/submissions/CIK##########.json` funciona para personas → historial cross-empresa.
- **Volumen:** ~600–800 Form 4/día hábil (picos >1,500 post-earnings). El atom no trae el transactionCode → hay que fetchear el XML para filtrar. Filtro estándar: `transactionCode == 'P'` + `acquiredDisposedCode == 'A'` + `isOfficer||isDirector` + valor mínimo (~$100k) → decenas de eventos/día. Backfill: Insider Transactions Data Sets oficiales (TSV trimestral gratis).

### 1.3 Instituciones (13F) — 🟢 parseable, el diff lo computamos nosotros

- 13F-HR = 2 XML por filing: `primary_doc.xml` (cover) + infotable. Campos por posición: `nameOfIssuer`, `cusip`, `value` (**dólares completos desde ene-2023; miles antes** — ojo con históricos), shares, putCall, votingAuthority.
- **Solo CUSIP, sin ticker.** Mapeo gratis: OpenFIGI API (POST `ID_CUSIP` → ticker; gratis, ~25 jobs/min con key gratuita) con caché (los CUSIP de un fondo cambian poco entre trimestres). `company_tickers.json` de SEC mapea CIK↔ticker, no CUSIP.
- **Lag: 45 días** tras el cierre del trimestre; los fondos grandes filean el último día → "13F days" ≈ 14-feb / 15-may / 14-ago / 14-nov con avalancha de filings.
- **EDGAR solo da snapshots** — el diff (nuevas / cerradas / aumentadas / reducidas) es un JOIN por CUSIP entre dos trimestres, computable por nosotros. Cuidado con amendments (13F-HR/A) y filers múltiples parent/subsidiary.
- Diffs pre-computados gratuitos NO confiables para automatización: WhaleWisdom free es limitado y con bot protection, 13f.info bloquea bots (403 a fetchers) y sin ToS claros. `forms13f.com` tiene API JSON gratuita — candidato a fallback, no a critical path.
- **Tamaños:** Berkshire (~40 posiciones) ≈ 20–60 KB. Renaissance (3,213 posiciones, $63.9B Q1-2026) ≈ 1–2.5 MB. Con maxDuration 60s de Vercel alcanza; parsear en streaming, no DOM completo.

### 1.4 Mapeo persona→CIK/filer — 🟢 estable y construible una vez

- **CIKs son permanentes** — nunca se reciclan ni cambian aunque el filer cambie de nombre. Hardcodear en config es seguro.
- Confirmados: Berkshire 1067983 · Bridgewater 1350694 · ARK Invest 1697748 · Scion (Burry) 1649339 · Pershing Square 1336528 · Renaissance 1037389 · Elon Musk (persona) 1494730.
- **Excepción: el Congreso no tiene CIK.** eFD/House dan nombre + estado/distrito sin ID estable → el mapeo personaje→nombre-en-filings es manual (variantes de nombre: "Nancy Pelosi" vs "Hon. Nancy Pelosi"). Construible una vez para ~15 congresistas curados; mantenimiento bajo.
- Config estática propuesta: `{ slug, displayName, tipo: congress|insider|fund, cik?|efdName?, foto, bio }` para ~20–30 personajes.

---

## 2. Taxonomía propuesta (4 categorías, las 4 con fuente real)

### A. Trades del Congreso (feed reciente + filtro por legislador)
- **Fuente:** eFD Senate (JSON interno + HTML de PTRs e-filed); House fase 2 (ZIP/XML índice + PDFs e-filed).
- **Card:** legislador · partido/estado (de nuestra config) · ticker o descripción del asset · Compra/Venta · bucket de monto ("$50k–$100k") · fecha del trade · **"presentado N días después"** (lag real calculado por trade).
- **Lag mostrado:** "Por ley pueden reportar hasta 45 días tarde. Mediana real: ~26 días."
- **Refresh:** cron 2×/día es suficiente (los filings entran en lotes); CDN `s-maxage=21600, swr=43200`.

### B. Insider buys destacados (la señal clásica: CEOs comprando su propia empresa)
- **Fuente:** EDGAR atom `getcurrent&type=4` → fetch XML → filtro code P + officer/director + valor ≥ $100k; bonus: flag "cluster buy" (≥2 insiders mismo issuer en ~7 días) y badge 10b5-1 vs discrecional.
- **Card:** insider · cargo real (`officerTitle`) · empresa/ticker · shares × precio = valor · fecha de transacción · fecha de filing.
- **Lag mostrado:** "Reportado máx. 2 días hábiles después del trade" — esta categoría es casi tiempo real y es el contraste honesto perfecto con el Congreso.
- **Refresh:** cron cada 1–2 h en horario de mercado; `s-maxage=3600, swr=7200`.

### C. Movimientos 13F del trimestre (diffs de fondos famosos)
- **Fuente:** EDGAR submissions JSON por CIK hardcodeado (~10–15 fondos) → infotable XML → diff propio por CUSIP vs trimestre anterior → CUSIP→ticker vía OpenFIGI cacheado.
- **Card:** fondo · posiciones NUEVAS / CERRADAS / top aumentos y recortes · valor y % del portafolio · trimestre reportado.
- **Lag mostrado:** "Foto al cierre del trimestre, publicada hasta 45 días después. Esto es lo que tenían el 31 de marzo, no lo que tienen hoy." — el disclaimer más importante del producto.
- **Refresh:** trimestral; cron diario ligero solo en las ventanas 13F (± una semana de cada deadline) que detecta filings nuevos; `s-maxage=86400`.

### D. Vista por personaje (perfil con historial)
- **Fuente:** config estática de ~20–30 personajes (sección 1.4) + las tres fuentes anteriores filtradas por persona. Insiders vía CIK personal (submissions JSON cross-empresa); fondos vía CIK; congresistas vía name-match.
- **Card/perfil:** foto, quién es, tipo de disclosure que lo cubre, su lag legal, historial cronológico de trades con lag por trade.
- **Refresh:** deriva de A–C; el perfil no fetchea nada propio.

**Orden de construcción sugerido por riesgo:** B (Form 4, todo estructurado) → C (13F, estructurado + diff) → A (Congreso, scraping frágil + tema legal) → D (agregación de las anteriores).

---

## 3. Overlap con SMART $

**Hallazgo del repo:** en el tab SMART $ solo el panel de insiders usa datos reales (`/api/insider` → Finnhub `stock/insider-transactions`, `api/insider.js:32`). Los paneles de Institutional Ownership, Short Interest y Options **los genera Claude** (`app.html:2960-3031`) — exactamente lo que la regla de diseño del Stock Tracker prohíbe. Ownership real sí existe en `/api/price` (Finnhub `stock/metric`) pero se usa en el Screener, no en SMART $.

**Veredicto: tab nuevo, no extensión.** SMART $ es *per-ticker* ("analiza AAPL"); Stock Tracker es *per-persona* ("qué hizo Pelosi") — modelos de navegación distintos. Pero con dos sinergias:
1. El panel Institutional de SMART $ (hoy AI-inventado) puede **reemplazarse** después con los datos 13F reales de la categoría C — mejora colateral que alinea SMART $ con la regla de honestidad.
2. `/api/insider` per-ticker se queda como está; la categoría B es un feed global que no lo reemplaza.

**Finnhub free vs EDGAR directo para insiders:**

| | Finnhub free | EDGAR directo |
|---|---|---|
| Modo | Solo per-ticker, ~1 año de histórico | Feed global + per-persona + per-empresa |
| Cargo del insider | **No** (`title` siempre vacío — ya documentado en `api/insider.js:105`) | Sí (`officerTitle`, isDirector/isOfficer) |
| Por persona cross-empresa | No | Sí (CIK personal) |
| Flag 10b5-1 | No | Sí |
| Costo | 60 calls/min compartidas con todo lo demás | Gratis, 10 req/s propios |

Para el Stock Tracker se necesita EDGAR directo; Finnhub queda como está para el caso per-ticker.

---

## 4. Infra

**Mismo patrón vc-feed** (`api/vc-feed.js`): función serverless por feed, doble cache (memoria por instancia + CDN s-maxage/swr), fallo → sirve stale, User-Agent `QuantDesk research@quantdesk.app` para SEC, parser sin dependencias.

**Presupuesto de requests (estimado):**
- Categoría B: poll atom (24–48 req/día) + XML de candidatos (~600–800/día si se filtra todo el flujo, en un cron batch a ≤5 req/s ≈ 3 min; muy por debajo del límite de 10 req/s).
- Categoría C: trimestral, ~15 fondos × ~4 requests + OpenFIGI batch cacheado. Despreciable.
- Categoría A: 2 crons/día × (2–3 req eFD + N páginas de PTR nuevos, típicamente <20/día). Despreciable.
- Total: sin riesgo de rate limit si cada fuente vive detrás de su cache CDN y los fetches van en cron, no per-request de usuario.

**Smoke tests obligatorios desde Vercel real ANTES de construir** (lección FinSMEs/Stocktwits — Cloudflare y WAFs bloquean IPs de datacenter y solo producción lo revela; usar el patrón `?smoke=1` de `api/vc-feed.js:417-448`):
1. `www.sec.gov` (atom getcurrent + Archives) y `data.sec.gov` (submissions JSON) con el SEC_UA — EDGAR no bloquea datacenter per se, pero las IPs compartidas de Vercel pueden heredar bloqueos temporales de otros tenants.
2. **efdsearch.senate.gov** — el flujo completo agreement→CSRF→POST JSON desde IP de Vercel. Es el smoke más crítico: si el WAF del Senado bloquea datacenter, la categoría A cambia de arquitectura (p.ej. GitHub Action que scrapea y commitea JSON).
3. `disclosures-clerk.house.gov` — descarga del ZIP anual y de un PDF.
4. OpenFIGI API con key gratuita.

**Nota de verificación:** el entorno de investigación de hoy bloqueaba `*.gov` y finnhub.io a nivel de proxy propio, así que nada de esto se probó contra las IPs de Vercel — razón de más para el smoke real.

---

## 5. Riesgos

1. **Legal (Congreso):** EIGA §105(c) / 5 U.S.C. §13107(c) prohíbe uso "comercial" de los disclosures. Riesgo dimensionado como bajo (ver Decisión: cero enforcement, precedente favorable, práctica de la industria); condiciones de activación: consulta legal puntual + modo mostrar-solo con disclaimer. Triggers de paro: primera acción del DOJ bajo §13107(c) contra cualquier tracker, o ley nueva restrictiva. Form 4 y 13F no tienen esta restricción (datos EDGAR de dominio público).
2. **Fragilidad eFD:** el endpoint JSON es interno del frontend; puede cambiar sin aviso. Mitigación: parser defensivo + alerta si el shape cambia + stale cache.
3. **PDFs de House:** sin OCR en MVP; asumir cobertura parcial de House y decirlo en el UI ("algunos filings en papel no se procesan").
4. **EDGAR:** 10 req/s por IP, User-Agent con email obligatorio (403 sin él), 429 con bloqueo temporal (~10 min). Ya cumplimos el patrón en `api/sec-edgar.js`.
5. **Tamaño 13F:** hasta 2.5 MB (Renaissance) — parsear en streaming, cuidar memoria/timeout serverless.
6. **Ticker faltante:** Congreso (assets sin ticker) y Form 4 (`issuerTradingSymbol` a veces vacío) — la card debe degradar a descripción de texto, no romperse.
7. **Agregadores:** todos los gratuitos de 2021 están muertos o cerrados; no apoyar el critical path en ninguno (forms13f.com solo como fallback de C).
