# ENCARGO: `/mercado` + `/analiza/:ticker` — QuantDesk estilo Finviz, en español, mobile-first

Mockup aprobado: canvas "QuantDesk /mercado" (9 artboards). Este documento es el contrato. Trabajo por rebanadas; cada una termina con "PR listo — no more pushes" y espera mi OK antes de la siguiente. Trabajo nuevo = rama nueva.

---

## 0. Qué es y qué NO es

**Es** una capa de entrada nueva sobre lo que ya existe: mapa de calor, hover/hoja, tablas densas, fichas de índice y ticker, e insiders con todas las transacciones. Referencia visual: la home de finviz.com (densidad, todo tocable, cero login, URL = estado) y la ficha de Yahoo Finance (rendimiento total, UPA real vs estimado, ingresos vs utilidad, analistas, valuación).

**No es** un rediseño de `app.html`. Los 19 tabs no se tocan en este encargo, salvo el cambio puntual a TRACKER descrito en la rebanada 5. Cada pantalla nueva tiene un botón "Abrir la terminal completa" que lleva al tab correspondiente de `app.html`, como hoy hace `/hoy`.

**Archivos nuevos:** `mercado.html`, `analiza.html`, `indice.html`, `insiders.html` con rewrites en `vercel.json` (`/mercado`, `/analiza/:ticker`, `/mercado/indice/:idx`, `/mercado/insiders`). Un `js/mercado-*.js` compartido si hace falta; nada de esto entra a `app.html`.

**Mapa de integración (qué envuelve cada pantalla):**

| Pantalla | Reusa |
|---|---|
| `/mercado` home | tape, movers (WATCHLIST/MARKET), calendario earnings + macro_events, tarjeta Arena (`{agents:[...]}`), noticias |
| Mapa EE.UU. | fundamentales precalculados en Neon del screener (cap, sector) + precios |
| Mapa México | `xbrl_reports` (acciones en circulación) × precios `.MX` |
| Mundo | `/api/macro-markets` (series con timestamps) |
| Hoja / hover | modal Lightweight Charts existente + `metric` de Finnhub |
| Ficha de índice | mismo modal + `qdPeriodChange` + componentes del screener |
| Insiders | TRACKER (`?cat=insider`, `?cat=13f`) |
| `/analiza/:ticker` | EARNINGS, SMART $ (solo paneles reales), HISTORIA, TRACKER por ticker, agentes de research (botón ANALYZE), pares, `/api/options` |

---

## 1. Reglas no negociables (aplican a todas las rebanadas)

1. **Ni un número mal.** Todo % sale de `qdPeriodChange(series, period)` y se pinta con `qdPctTag(pct, periodLabel)`. Nunca `.dayChange` crudo ni un % calculado a mano. El `pct-lint` se extiende a todos los archivos nuevos.
2. **Dato que falta = "—" en gris + por qué.** Nunca estimado, nunca placeholder numérico, nunca el mensaje genérico "Data unavailable — free-tier". Cada bloque que falla dice su causa real (`source_down`, `rate_limited`, `no_data_in_window`, `paid_source`).
3. **Cada número dice su fuente.** Columna/etiqueta gris: `yahoo`, `finnhub`, `edgar` (con link al filing), `calc`, `neon`. Lo que es de pago (calificación de analista con nombre de casa, precio objetivo en Finnhub) se declara "no lo mostramos" en un panel punteado, no se inventa.
4. **Chip de estado de mercado por instrumento** en cada pantalla: `abierto` / `cerrado · cierre del viernes` / `24/7`. Reusar el que ya existe.
5. **Pie:** fuente + hora de actualización + "Información, no asesoría".
6. **Cero llamadas de IA** en `/mercado`, `/indice`, `/insiders`. En `/analiza` solo al pulsar "Analizar con agentes", con el caché por ticker+día ya existente.
7. **Un endpoint batch por mapa, con caché.** Prohibido un fetch por cuadro. Meta: `/mercado` interactivo en < 1.5 s en 4G.
8. **Mobile-first a 390 px; el desktop es 1440 px sin scroll.** Tap ≥ 44 px. En móvil la interacción es tap → hoja desde abajo; en desktop es hover → tarjeta flotante con el mismo contenido. Nunca depender del hover.
9. **URL = estado.** `?mapa=us|mx|mundo&periodo=1d|1s|1m|ytd&moneda=usd|mxn`. Cualquier vista pegada en WhatsApp abre igual.
10. **Cierre de cada rebanada:** suite `node --test` verde + checks Chromium a 390 px con touch real (`hasTouch + isMobile`, tap real, no click sintético) + screenshots móvil y desktop. Termina con "PR listo — no more pushes".

---

## 2. FASE 0 — CENSO + SMOKE (sin UI; entrégame `docs/mercado-fase0.md` y espera mi GO)

1. **Capitalización EE.UU.:** ¿qué tabla/campo de Neon la tiene, para cuántos tickers, qué tan fresca, trae sector? Si el universo es ~150, ¿alcanza para un mapa por sector o hay que ampliar a S&P 500 completo? Propón.
2. **Capitalización México:** `xbrl_reports.acciones × precio .MX`. **Trampa:** emisoras con varias series o unidades (FEMSA UBD, AMX, GFNORTE, KOF, GAP…). Acciones totales × precio de UNA serie da cifra falsa. Verifica contra la capitalización pública de WALMEX, FEMSA, AMX, GMEXICO, GFNORTE; reporta el error %. Regla: > 5% de error → esa emisora sale gris punteado ("sin capitalización verificada") hasta resolverlo.
3. **Precios en batch:** ~150 US + ~30 MX + ~20 índices. Yahoo v8 es por símbolo; el crumb dio 429 desde Vercel en julio. Propón cron → Neon precalculado (cada 15 min en horario de mercado) vs on-request con caché, y mide. Quiero la opción que cargue en < 1.5 s.
4. **Retorno total con dividendos:** confirma que el endpoint de velas de Yahoo devuelve `events=div` y que `qdPeriodChange` puede correr sobre precio ajustado. Necesario para la ficha de ticker.
5. **Fundamentales por ticker:** confirma en `metric` de Finnhub (free) qué campos hay de: cap, EV, P/U, P/U fwd, PEG, P/S, P/B, EV/Rev, margen, ROA, ROE, dividendo. Lo que no esté → "—".
6. **UPA real vs estimado:** confirma endpoint y ventana histórica en Finnhub free (últimos 4–8 trimestres) + estimado y fecha del próximo. Es la misma fuente de la tasa de beat de EARNINGS.
7. **Ingresos / utilidad trimestral:** EDGAR `companyfacts` (Revenues, NetIncomeLoss por trimestre, con `accn` y `form` para citar el 10-Q/10-K). Para BMV, `xbrl_reports` y DataBursatil.
8. **Analistas:** Finnhub `recommendation` (free) confirmado. Precio objetivo: probar Yahoo `quoteSummary` desde Vercel prod (crumb). Resultado por escrito: GO / NO-GO. Si NO-GO, el panel va punteado "fuente de pago".
9. **Form 4 completo:** confirmar que el parser actual guarda TODAS las transacciones (código A/S/M/F/P…) y no solo P, y que trae `sharesOwnedFollowing` ("le quedan") y el timestamp de aceptación del filing.
10. **Feeds de noticias:** para cada fuente de la lista de R3b, verificar desde Vercel: ¿tiene RSS/Atom público?, ¿responde sin Cloudflare (recordar FinSMEs)?, ¿trae `media:content`/`enclosure` con imagen?, ¿trae categoría o tickers? Tabla con GO / NO-GO por fuente. Bloomberg y NYT se asumen NO (sin RSS abierto).
11. **Smoke real desde Vercel** (`?smoke=1`): 3 tickers US, 3 MX, 3 índices con precio, cierre previo, cap, sector, dividendos; 1 ticker con `metric`, UPA, companyfacts, recommendation; 1 Form 4 con todos los códigos. GO / NO-GO por escrito.

---

## 3. REBANADAS (en este orden; cada una un PR)

### R1 — El mapa (artboards 1 y 2)
- `mercado.html` mobile-first + rewrite `/mercado`.
- Treemap squarified propio en SVG/canvas (sin librería pesada). Tamaño = capitalización, color = % del periodo, agrupado por sector. Escala de color fija de −3% a +3% (7 pasos; los del mockup), gris para ±0.5%.
- Tabs EE.UU. | México | Mundo (Mundo se llena en R2). Toggle 1D / 1S / 1M / YTD.
- Cuadro grande: ticker + %; chico: solo ticker. Etiqueta de sector en la cabecera de cada grupo.
- **Tap en móvil → bottom sheet:** nombre, precio, % con `periodLabel`, "en pesos" (R2; hasta entonces oculto), sparkline con el estilo ya rehecho de MACRO (gradiente, último punto con pulso, "actualizado hace X"), 4 datos (`metric`), 2 titulares del ticker, botones "Ver gráfica" (modal existente) y "Abrir ficha" (`/analiza/:ticker`, hasta R6 lleva al tab EARNINGS).
- **Hover en desktop** con el mismo contenido en tarjeta flotante; solo se ata en `pointer: fine`.
- Barra de índices arriba, fija, con flash verde/rojo al cambiar; chip de estado de mercado; leyenda; pie con fuente y hora.
- México: emisoras sin cap verificada (Fase 0.2) en gris punteado, sin tamaño inventado.
- Endpoint: `/api/mercado-mapa?mapa=us|mx&periodo=…` → un JSON por mapa, `s-maxage` acorde al cron.

### R2 — Mundo + pesos (artboards 4 y parte de 2)
- Tab Mundo: rejilla por región (América / Europa / Asia / Cripto-FX-materias primas), un cuadro por índice, **tamaño fijo** (los índices no tienen cap; no fingir), color por %.
- Toggle **USD | MXN** global: en MXN, el % de todo activo en dólares se recalcula con la serie USD/MXN del mismo periodo. En cuadros: número grande = en pesos, chico = local. Etiqueta visible "rendimiento en pesos". Test unitario del cálculo con un caso conocido.
- La línea "en pesos" se activa en la hoja/hover.
- Chip de estado por bolsa (Asia abre a las 18:00 CT, etc.), no global.

### R3 — Tablas densas + noticias (artboard 1 abajo, 5)
- Bajo el mapa en móvil / columnas laterales en desktop: **más suben / más bajan / más operadas** (8 filas, una línea), **lo de hoy** (titulares con hora, fuente y chips de ticker tocables; EE.UU. y México mezclados), **esta semana** (macro + reportes, hora CT, mismo origen que el calendario de `/hoy`), **insiders** (teaser, ver R5), **Arena** (tarjeta con el shape `{agents:[…]}`).
- Noticias: solo titular original + fuente + link. Si se traduce, etiqueta "traducción". Nada reescrito (eso es la sección con registro de email, aparte).
- Todo ticker tocable → misma hoja/hover.
- Desktop `1440×1000` sin scroll: 3 columnas (292 / 748 / 336) como el artboard 5, con tira del IPC (fila de tiles por cap) y tira de 9 índices en pesos bajo el mapa. Header con buscador de ticker, tabs Cripto/ETFs (vacíos con "pronto", no fingir) y toggle Sector / Sin agrupar.

### R3b — Página de noticias (artboard 9)
- `/mercado/noticias`. Mismo mecanismo que `api/vc-feed.js` (RSS → Neon → tarjetas), generalizado a un registro de fuentes `api/_lib/news-sources.json` con: nombre, url del feed, idioma, tipo (`medio | newsletter | oficial`), sección por default, y el resultado del smoke de Fase 0.10. Agregar una fuente = una fila.
- **Fuentes v1** (las que pasen Fase 0.10): medios EN — Reuters, CNBC, MarketWatch, WSJ (titulares), Seeking Alpha, ZeroHedge, Yahoo Finance; **medios ES** — El Financiero, Expansión, El Economista, Bloomberg Línea, Reuters en español, Investing.com ES, Infobae Economía, La República (CO), Valor (BR); **newsletters** — Stratechery, Doomberg, Net Interest, SemiAnalysis, App Economy Insights, Abnormal Returns, Klement on Investing, The Bear Cave; **oficiales** — Fed (comunicados FOMC), Banxico (anuncios de política monetaria), BMV emisnet (eventos relevantes), SEC EDGAR 8-K (solo tickers del universo).
- **Layout desktop:** cabecera con secciones Mercado | México · LATAM | Acciones | ETFs | Cripto | Oficiales; toggles "Por hora / Por fuente" y "Todo / Solo español"; chips de fuente (las ES en verde); buscador. Arriba **4 destacadas con foto**; abajo dos columnas: **Medios** (por hora, "cargar más") y **Newsletters** + **Oficiales**. Móvil: destacadas en carrusel horizontal, luego las listas apiladas.
- **Fotos:** solo si el feed trae `media:content` o `enclosure`. Si no, bloque de color con el nombre de la fuente. **Nada de scrapear `og:image` en v1.** Las imágenes se sirven por la URL del feed; si el hotlink falla, cae al bloque. Nunca se descarga ni se muestra el cuerpo de la nota: titular + foto + fuente + hora + link.
- **Sin IA.** Chips de ticker por coincidencia con el mapa de símbolos existente (nombre de empresa y ticker), con lista de exclusión para falsos positivos (ej. "AI", "IT", "NOW"). Sección "Acciones" = notas con al menos un ticker. Traducción: no en v1; el toggle "Solo español" filtra por idioma de la fuente.
- **Cron:** cada 10 min, todos los feeds en paralelo con timeout 5 s por fuente; una fuente caída se marca `source_down` en su chip, no tumba la página. Dedupe por URL canónica y por titular normalizado.
- **Reusa:** la sección "Lo de hoy" de `/mercado` (R3) y "Noticias del ticker" de `/analiza` (R6) leen de esta misma tabla filtrando por sección o ticker. Una sola fuente de verdad.
- **Fuera de v1:** reescritura en tu voz (eso es la sección con registro de email), resumen por IA, "por qué se mueve" (va en HISTORIA Fase B).

### R4 — Ficha de índice (artboard 6)
- `/mercado/indice/:idx` (SPX, NDX, DJI, IPC, BOVESPA, KOSPI, NIKKEI, DAX, HSI).
- Chart grande (Lightweight Charts) 1D→Máx, línea/velas, USD|MXN. Overlays **solo de cálculo**: media 50d, media 200d, máx/mín 52 semanas. Sin líneas de tendencia ni patrones automáticos (una línea mal trazada es un número mal).
- Tabla de rendimiento por periodo en **dos columnas USD y MXN** lado a lado.
- Datos: componentes, cap total, P/U agregado (solo si `metric` lo da; si no "—"), rango 52s, distancia al máximo, arriba/abajo de medias, volatilidad 30d anualizada (calc), ETF que lo replica, "se compra en México vía SIC (GBM, Kuspit)".
- Tira de componentes por peso con % del índice; "+N más = X%" al final.
- Noticias del índice. Tabs para brincar entre índices. Se llega desde cualquier índice de la barra o de Mundo.

### R5 — Insiders (artboard 7) + cambio puntual a TRACKER
- `/mercado/insiders`. Tabs: Insiders · Form 4 | Gestores · 13F | Fondos | Congreso (punteado "pronto", sin datos).
- **Default "Todas las transacciones"**, orden por hora de filing ↓. Chips: Compras / Ventas / Opciones / Venta propuesta / Dueño 10%. Vistas: Últimas | Top de la semana por ticker (neto en USD, conteo compras/ventas, "vendió todo" cuando `le quedan = 0`) | Compras destacadas (el filtro actual: oficiales ≥ $100k, etiqueta CLUSTER).
- Columnas: ticker, quién, cargo, fecha op., tipo, precio, acciones, valor, **le quedan**, filing. Filas coloreadas por tipo (venta rojo tenue, compra verde, opción neutro, propuesta ámbar).
- Lateral: top de la semana, compras destacadas, teaser de los 6 fondos del 13F.
- **TRACKER en `app.html`:** el estado vacío "0 compras destacadas" se reemplaza por la vista "Todas" con el filtro de compras como opción. Es el único cambio a `app.html` en este encargo.

### R6 — Ficha de ticker `/analiza/:ticker` (artboard 8)
- Header: ticker, nombre, bolsa/sector, precio, % 1D con etiqueta, "en pesos". Tabs: Resumen | Historia | Insiders | Noticias | Pares | Opciones. Botones: "Ver gráfica", "Analizar con agentes" (abre el flujo ANALYZE existente, con caché).
- **Rendimiento total vs S&P 500** YTD / 1A / 3A / 5A con dividendos (Fase 0.4), tercera línea "en pesos · vs IPC". Para emisoras `.MX`, benchmark = IPC y "en dólares".
- **UPA real vs estimado** (últimos 4–8 trimestres, "Le ganó +0.06" = real − estimado; aclarar en el pie que es vs consenso, no que la acción subió) + próximo reporte con estimado.
- **Ingresos vs utilidad por trimestre** con margen; **cada barra cita su 10-Q/10-K** (link a EDGAR con `accn`).
- **Analistas:** precio objetivo bajo/promedio/alto/actual (si Fase 0.8 = GO; si no, punteado "fuente de pago"), recomendaciones por mes (Finnhub), y la tarjeta "Última calificación con nombre de casa" **siempre punteada: "no lo mostramos, es dato de pago"**.
- **Valuación** y **Finanzas** con columna de fuente en cada fila.
- **Insiders del ticker** (3 últimas + neto 90 días), **Historia** (3 hitos con cita, de HISTORIA Fase A), **Noticias** del ticker.
- Móvil: los mismos bloques apilados; cada bloque colapsable.

### R7 — Compartir
- Botón "Compartir imagen" en mapa, ficha de índice y ficha de ticker: PNG con fecha, periodo, moneda, fuente y "quantdesk" en la esquina. Formato vertical 1080×1920 para stories y cuadrado 1080×1080.
- Verificar que toda URL con estado abre idéntica en incógnito y en WhatsApp preview (OG image = el mismo PNG).

### R8 — Volverla la home (solo cuando yo lo diga)
- `/` → `/mercado`. `app.html` pasa a "Modo experto" en el menú. `/hoy` redirige a `/mercado`. Nada se borra.

---

## 4. Decisiones ya tomadas (no preguntar de nuevo)
- Fuente: IBM Plex Sans Condensed + IBM Plex Mono. Fondo `#0b0f14`, paneles `#0e141b`, bordes `#161c24`. Escala de color del mapa: la del mockup.
- Mapa por país con bolsas locales de Brasil/Chile/Colombia: **fuera** de este encargo (sin capitalizaciones confiables).
- Líneas de tendencia / patrones automáticos: **fuera**.
- Logos por ticker: **fuera**.
- Título de la pantalla de insiders: "Quién compra, quién vende".

## 5. Preguntas que sí quiero que me hagas (con propuesta)
- Si el universo US del screener no alcanza para un mapa por sector.
- Si el cron de precios choca con el límite Hobby de Vercel.
- Cualquier emisora `.MX` cuya cap no cuadre y no sepas por qué.
