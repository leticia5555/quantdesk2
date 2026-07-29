# Terminal de entrada — Censo y alcance

Fecha del censo: 2026-07-29.
Objetivo: rediseñar la **entrada** de QuantDesk como una terminal viva — alguien
llega desde la bio de TikTok (en teléfono) y en **3 segundos está VIENDO
mercado en vivo**: índices globales, el evento macro del día, la Arena del PM,
heatmap y movers. Hoy la entrada no muestra nada vivo.

Caso de uso que lo justifica (hoy): el KOSPI cayó **−10.84 %** (Samsung −13.4 %,
SK Hynix −14.7 %) y la Fed mantuvo tasas en decisión dividida **9-3** con tres
disidencias hawkish — y **nada de eso era visible en QuantDesk**. El usuario se
enteró por X. Para una terminal, eso está mal.

Estado: **SCOPE. Nada construido todavía.** Este doc cierra con las decisiones
que necesito de ti antes de escribir código.

---

## 1. Qué es la "entrada" hoy

- **El link de la bio → `/app` o `/terminal`** (`vercel.json` rewrites) → sirve
  `app.html`. `index.html` es la landing de marketing ("Empieza a entender
  invirtiendo"); no es la terminal.
- **La primera pantalla de la terminal** es `#page-agents`
  (`app.html:13806`, `class="page active"`) — la tab **AGENTS** del nav.
- **Qué ve un visitante nuevo HOY, de arriba a abajo**:
  1. Topbar con logo + nav de 20 tabs + PRO/ES.
  2. **Ticker tape** (`#tapeInner`, `app.html:313`) — esto SÍ está vivo:
     `refreshLiveTape()` (`app.html:4254`) batchea quotes de `/api/tape`.
     Pero muestra **acciones/cripto** (`defaultTickers`), no índices.
  3. Tres **cajas de research agent** apiladas: Risk Anomaly, Sentiment, Event
     (`#riskAgentSection`, `#sentimentAgentSection`, `#eventAgentSection`,
     `app.html:13808+`). Son **inputs vacíos** — "escribe un ticker y dale
     ANALYZE". Cero información de mercado. **Esto es lo que rompe los 3 seg.**
  4. Más abajo: barra de agentes de paper trading, toolbar "+ NUEVO AGENTE",
     el bloque **ARENA** (`#arenaSection`, `app.html:1895`, `display:none` hasta
     que `qdArenaLoad()` lo llena), y la lista de agentes.

**Diagnóstico**: la terminal ya tiene datos vivos (tape) y un bloque Arena, pero
lo primero que ve un recién llegado son formularios de research, no mercado. La
entrada está ordenada para el usuario que YA sabe qué es QuantDesk, no para el
que llega de un TikTok.

---

## 2. Infra reusable (lo que NO hay que construir)

| Pieza | Dónde | Reusable para la entrada |
|---|---|---|
| **Quotes batched** | `/api/tape` (`api/tape.js`) — Yahoo v8 chart, sin key, precio vs prevClose = % intradía. `MAX_SYMBOLS=20`. | **Sí, tal cual** para la barra de índices. Yahoo v8 acepta símbolos de índice y futuros igual que acciones (§3). |
| **Velas OHLC** | `/api/candles` (`api/candles.js`) — Yahoo v8 + Binance, caché CDN por intervalo. | Sí, si un índice abre chart modal al tap. |
| **Ticker tape UI** | `refreshLiveTape()` / `renderLiveTape()` (`app.html:4254-4325`). Ya detecta open/pre-market/after-hours/closed en hora ET. | **Reusar el motor de estado de mercado**; la barra de índices es una segunda instancia con label map propio. |
| **Heatmap de sectores** | `/api/sectors` (`api/sectors.js`) + `renderSectors()` (`app.html:12484`). 4 categorías (us/latam/themes/industries), ETFs reales vía Finnhub+Yahoo, strip de referencia SPY/QQQ/IWM/DIA. | Sí — versión **compacta** (top movers de sectores) para la entrada. |
| **Movers** | `/api/movers` (`api/movers.js`) + `renderMovers()` (`app.html:12718`). Watchlist curada + universo market. | Sí, bloque compacto abajo. |
| **Arena (PM #6)** | `/api/arena` (`api/arena.js`) → `{enabled, has_keys, account, positions, journal:{plan, actions}}`. `qdArenaHtml()` (`app.html:18901`). | Sí — es el núcleo del bloque grande. Ver §5 sobre escalar a leaderboard. |
| **Calendario de earnings** | `/api/earnings?from&to` (`api/earnings.js:340+`) — Finnhub `calendar/earnings`, free tier. | Sí, para el bloque de eventos (earnings mega-caps). |
| **Kill-switch de flags** | `/api/config` (`api/config.js`) → `{paywall_enabled}`; el front lo consulta al arrancar (`app.html:18415`) y setea `window.QD_*`. | **Patrón exacto** para el flag del tab SOCIAL (§7). |
| **i18n** | Diccionario `data-i18n` ES/EN (`app.html:8887+` / `9114+`), `toggleLang()`. | Toda etiqueta nueva pasa por aquí. |
| **Responsive** | 7 `@media`. El nav ya colapsa a 2 filas + strip scrolleable con fades en ≤768px (`app.html:250`). | La entrada nueva hereda esto; ver §8. |

**Conclusión de reuse**: ~80 % de la entrada es re-encuadre y composición de
piezas que ya existen y ya son honestas con los datos. Lo genuinamente nuevo es
poco (§10).

---

## 3. PIEZA 1 — Barra global de índices

### ¿Yahoo nos da todos estos índices con la infra de candles/tape que ya existe?

**Sí.** `/api/tape` y `/api/candles` pegan a `query1.finance.yahoo.com/v8/finance/chart/{símbolo}`,
que es **agnóstico al tipo de símbolo**: acepta acciones, ADRs, cripto (`BTC-USD`),
**índices (`^…`) y futuros (`…=F`)** con la misma forma de respuesta
(`meta.regularMarketPrice` + `chartPreviousClose`). Cero infra nueva: la barra de
índices es una llamada más a `/api/tape` con otra lista de símbolos.

### Símbolos Yahoo

| Mercado | Índice | Símbolo | Futuro US (mercado cerrado) | Símbolo |
|---|---|---|---|---|
| 🇺🇸 | S&P 500 | `^GSPC` | S&P e-mini | `ES=F` |
| 🇺🇸 | Nasdaq Composite | `^IXIC` | Nasdaq e-mini | `NQ=F` |
| 🇺🇸 | Nasdaq 100 | `^NDX` | — | — |
| 🇺🇸 | Dow Jones | `^DJI` | Dow e-mini | `YM=F` |
| 🇺🇸 | Russell 2000 | `^RUT` | Russell e-mini | `RTY=F` |
| 🇰🇷 | KOSPI | `^KS11` | — | — |
| 🇯🇵 | Nikkei 225 | `^N225` | — | — |
| 🇲🇽 | BMV IPC | `^MXX` | — | — |
| 🇧🇷 | Bovespa (opc.) | `^BVSP` | — | — |
| 🇦🇷 | Merval (opc.) | `^MERV` | — | — |

Notas honestas (a verificar en el smoke, §9):
- **`^DJI` es históricamente inestable en Yahoo** — hay temporadas en que
  devuelve sin datos y hay que caer al ETF **`DIA`** como proxy. Plan: si el
  smoke da `^DJI` vacío, usar `DIA` con label "Dow".
- El **% intradía sale solo**: para un índice asiático a media sesión, Yahoo
  entrega `regularMarketPrice` vs el `chartPreviousClose` correcto → el −10.84 %
  del KOSPI aparece en vivo sin lógica extra.
- **Futuros cuando US está cerrado**: ya existe el detector de estado de mercado
  en `renderLiveTape()` (`app.html:4283`). Regla: si `!isMarketHours && !isPreMarket`
  para US, la barra muestra `ES=F/NQ=F/YM=F/RTY=F` con badge "FUTUROS"; en
  horario regular muestra `^GSPC/^IXIC/^DJI/^RUT`. Esto cumple tu ítem del 26
  (panel pre-market DOW/S&P/NAS/RUS2K).

### Costo en llamadas y caché

- **Símbolos**: ~7 índices en abierto (3 US + KOSPI + Nikkei + IPC + 1 LATAM) o
  ~7 en cerrado (4 futuros US + 3 internacionales). Cabe de sobra en el
  `MAX_SYMBOLS=20` de `/api/tape` — **1 sola llamada batched** por refresh.
- **Yahoo no tiene API key** → no quema el rate limit de Finnhub (60/min). El
  único límite es el anti-abuso de Yahoo por IP de datacenter, que en prod ya
  toleramos para tape/candles.
- **Caché**: `/api/tape` hoy responde sin `Cache-Control` (siempre fresco). Para
  la entrada conviene **añadir `s-maxage` corto** (p. ej. 15-30 s) a una ruta o
  parámetro dedicado de índices, así los N visitantes de un pico de TikTok
  comparten UNA request Yahoo por ventana en vez de una por navegador. Decisión
  en §11.
- **Refresh en cliente**: 30 s en abierto (como la tape actual); en cerrado, más
  lento (60-120 s) — los futuros se mueven pero no hace falta 30 s.

---

## 4. PIEZA 2 — Evento macro del día (banner) + calendario

### ¿De dónde sacamos el calendario macro gratis y confiable?

Esta es la pieza **más débil en fuentes gratis**. Desglose honesto:

| Evento | ¿Fuente gratis fiable? | Detalle |
|---|---|---|
| **Earnings mega-caps** | ✅ **Finnhub `calendar/earnings`** — ya integrado (`api/earnings.js:354`), free tier. | Filtrar a una watchlist de mega-caps para el banner. Cero trabajo nuevo de fuente. |
| **IPOs** | ✅ Finnhub `calendar/ipo` (free) — ya hay `api/ipos.js`. | Secundario para el banner. |
| **Fed / FOMC, CPI, PCE, NFP** | ⚠️ **No hay fuente gratis limpia y estructurada.** | Ver abajo. |

**El punto crítico — Finnhub NO nos sirve para macro**: su endpoint
`calendar/economic` (FOMC, CPI, NFP, PCE) es **premium-only**; en free tier
devuelve 403/vacío. Confirmado por el patrón del resto del código (todo lo free
de Finnhub que usamos son quotes/earnings/ipo, nunca economic). No hay un feed
gratis, estructurado y confiable de decisiones de bancos centrales + impresiones
macro con el detalle que pides ("9-3, tres disidencias hawkish").

**Opciones para el banner macro** (elige en §11):

- **A — Curado a mano (recomendado para v1).** Un JSON versionado en el repo
  (`api/_lib/macro-calendar.js` o una tabla Neon) con los ~15-20 eventos macro
  del trimestre: fecha, tipo (FED/CPI/PCE/NFP), hora, y para eventos pasados el
  resultado ("sin cambio 3.50-3.75 %, votación 9-3"). El calendario de la Fed y
  las fechas de BLS/BEA se publican con **meses de anticipación** y casi nunca
  cambian → curarlo a mano es de bajo esfuerzo y **cero riesgo de fuente rota**.
  El banner lee: "próximo evento futuro" o "evento de hoy con resultado". Esto es
  lo que garantiza que el −10.84 % del KOSPI y el 9-3 de la Fed **sí** aparezcan.
- **B — Semi-automático con Claude.** Un cron diario que le pide a Claude (ya
  tenemos `guardedClaudeCall`, ver `api/macro-agent.js`) el resultado del último
  evento macro y persiste el texto. **Riesgo**: alucinación de cifras exactas
  (votación, rango de tasas) — inaceptable para una terminal que presume
  precisión. Solo como *enriquecimiento* del texto curado, nunca como fuente de
  la cifra.
- **C — API paga** (Trading Economics, FMP calendar, Finnhub premium). Fuera de
  scope de v1 salvo que quieras pagar.

**Recomendación**: **A** para las cifras (curado, confiable), con el banner
renderizado desde ese calendario. Earnings mega-caps vienen de Finnhub (ya
existe). El "MAÑANA: decisión de la Fed" y el "FED: sin cambio 3.50-3.75 %, 9-3"
salen del mismo JSON curado según la fecha de hoy.

Esfuerzo del curado: ~30 min llenar el trimestre; refresco manual cada ~6-8
semanas cuando salga el nuevo calendario Fed/BLS. Barato y honesto.

---

## 5. PIEZA 3 — Arena en grande, escalable a leaderboard

### Qué hay

`/api/arena` devuelve UN PM (Agente #6): `account` (equity/cash), `positions[]`
(symbol, qty, avg_entry, unrealized_plpc) y `journal` (el plan publicado + las
`actions` con su razonamiento verbatim). `qdArenaHtml()` lo pinta hoy como una
card morada colapsada dentro de `#page-agents`.

### Cómo lo hago escalar a N modelos sin rehacerlo

El layout de v1 se diseña como **leaderboard de 1 fila** desde el principio:

- Un contenedor `#arenaBoard` que renderiza un **array de PMs** aunque hoy
  `length === 1`. Cada PM = una card con: nombre del modelo, equity, P&L %,
  nº posiciones, y su tesis más reciente (1-2 líneas del `journal.plan`).
- El **orden** es por P&L (ya es un leaderboard, solo que con un competidor).
- Encabezado de tabla ("MODELO · EQUITY · P&L · POSICIONES · ÚLTIMA TESIS")
  presente desde v1 → cuando llegue la liga multi-modelo, se agregan filas al
  array y **el layout no cambia**.
- El bloque grande de "posiciones + razonamiento" del PM líder queda expandido
  debajo del leaderboard (hoy, el único PM siempre es el líder).

**Cambio de API a futuro** (no ahora): `/api/arena` tendría que devolver
`pms: [...]` en vez de un PM plano. Para v1 se envuelve la respuesta actual en
`[data]` del lado cliente — **la migración del backend es un follow-up**, no
bloquea la entrada. Lo dejo anotado para no pintar el layout de forma que
asuma "1".

---

## 6. PIEZA 4 — Heatmap compacto + Movers, y el ETF de semis

### El bug concreto que señalaste: no hay semis en INDUSTRIES

Confirmado leyendo `api/sectors.js:47-60`. La categoría **`industries`** tiene 12
ETFs (KRE, KIE, KCE, IHI, IYR, OIH, XHB, ITA, MOO, KWEB, XRT, IGV) y **ninguno es
de semiconductores**. Semis (`SOXX`) vive **solo en la categoría `themes`**
(`api/sectors.js:32`). En el día más movido del mercado (Samsung/SK Hynix
desplomándose), el heatmap de industrias no puede mostrar el sector protagonista.

**Fix (trivial)**: añadir una línea a `CATEGORIES.industries` en `api/sectors.js`:

```js
{ ticker: 'SMH', name: 'Semiconductors', emoji: '🔬', topStocks: ['NVDA','TSM','AVGO','AMD','QCOM'] },
```

- **`SMH` vs `SOXX`**: recomiendo **`SMH`** para industries — es más líquido y
  más ponderado en NVDA/TSM, así que refleja mejor el shock de hoy; y evita que
  el mismo `SOXX` aparezca duplicado en themes e industries. (Decisión menor,
  §11.) El label de industries pasaría de "(12)" a "(13)" en `app.html:13797`.

### Heatmap compacto para la entrada

No reconstruir: llamar `/api/sectors?category=us` (o `industries`) y renderizar
una versión **reducida** (top-5 arriba / bottom-5 abajo) con `renderSectors()`
adaptado, o un mini-grid de 10 celdas. El heatmap completo sigue en la tab
SECTORS.

### Movers compacto

`/api/movers` (watchlist) + `renderMovers()` recortado a top-3 gainers / top-3
losers. Ya existe todo; es recorte de presentación.

---

## 7. PIEZA 5 — Esconder el tab SOCIAL tras un flag

### Qué hay

- Botón de nav `SOCIAL` (`app.html:300`) → `#page-social` (`app.html:13671`) →
  `analyzeSocial()` (`app.html:9741`) que pega a Reddit + CoinGecko. Reddit no es
  confiable hoy → un tab que falla en la bio es peor que un tab ausente.

### Cómo

Patrón idéntico al kill-switch del paywall (`window.QD_PAYWALL_ENABLED` vía
`/api/config`):

1. `api/config.js` expone `social_enabled` (env var `SOCIAL_ENABLED`, default
   **off**).
2. El front lee `window.QD_SOCIAL_ENABLED` al arrancar; si es falso, **oculta el
   botón de nav** (`display:none`) y bloquea `showPage('social')`.
3. Cuando Reddit funcione, se prende la env var — cero deploy.

Esfuerzo: ~15 min. Es el cambio más barato y de mayor higiene de la lista.

---

## 8. ¿Página nueva o reordenar `app.html`? Móvil.

### Nueva página vs reordenar

**Recomendación: reordenar `#page-agents`, no crear archivo nuevo.** Razones:

- El link de la bio ya cae en `app.html`/`#page-agents` (la tab activa por
  default). Crear `terminal.html` significaría un segundo rewrite en
  `vercel.json`, duplicar topbar/tape/i18n/paywall boot, y mantener dos apps.
- Todo lo que la entrada necesita (tape, arena, sectors, movers, config, i18n)
  **ya vive en `app.html`**. Es composición, no una app nueva.

**Plan concreto**: insertar un bloque nuevo **`#terminalHero`** al tope de
`#page-agents` (antes de `#riskAgentSection`, `app.html:13808`) con: barra de
índices → banner macro → Arena/leaderboard → heatmap compacto + movers. Las tres
cajas de research agent (Risk/Sentiment/Event) **bajan** debajo del hero — siguen
existiendo, pero dejan de ser lo primero. La tab AGENTS pasa a llamarse, de cara
al usuario, la "terminal" (posible rename del label del nav a "TERMINAL" o
"INICIO" — decisión de copy, §11).

### Qué se reusa vs qué es nuevo

| | Reusa | Nuevo |
|---|---|---|
| Índices | `/api/tape`, motor de estado de mercado | Lista de símbolos-índice + label map (S&P/Nasdaq…) + toggle futuros/índices |
| Macro | `/api/earnings` (mega-caps), `/api/config` | **`macro-calendar` curado** + banner render |
| Arena | `/api/arena`, `qdArenaHtml` | Layout leaderboard (array-first) |
| Heatmap | `/api/sectors` (+ 1 línea SMH) | Render compacto |
| Movers | `/api/movers`, `renderMovers` | Recorte top-3/3 |
| Social | patrón `/api/config` | Flag `social_enabled` |
| Layout | topbar, tape, i18n, responsive | Contenedor `#terminalHero` + su CSS grid |

### Móvil (la mayoría llega de TikTok en teléfono)

Es **el** requisito, no un extra. Reglas de diseño del hero:

- **Orden vertical en móvil, prioridad de valor**: (1) barra de índices
  scrolleable horizontal, (2) banner macro (1 línea, siempre visible), (3) Arena
  compacta (equity + P&L + 1 tesis; posiciones colapsadas), (4) heatmap 2-col,
  (5) movers. Nada de tablas anchas que fuercen scroll horizontal de página.
- **Barra de índices = strip horizontal scrolleable** (mismo patrón que la tape y
  que el nav en ≤768px con fades). En móvil no caben 7 índices en fila fija.
- **3 segundos**: el hero debe pintar *algo* con el primer paint. La barra de
  índices y el banner macro no dependen de Claude ni de Alpaca → cargan primero;
  Arena/heatmap/movers rellenan al llegar. El estado de carga es un skeleton, no
  un spinner en blanco.
- Heredamos los `@media` existentes (768/600); el hero añade sus breakpoints para
  el grid interno.
- Verificar en viewport 390px (iPhone) que no haya overflow horizontal de página.

---

## 9. Riesgos y smoke test

- **Yahoo desde Vercel prod**: el proxy de este entorno de dev bloquea Yahoo
  (403), así que el smoke de símbolos-índice **debe correrse en prod** (o local
  sin proxy). Igual que la lección de `movers.js` con los 429 de Yahoo: no dar
  por bueno un símbolo hasta verlo devolver `regularMarketPrice + chartPreviousClose`
  reales. Símbolos a smoke-testear: `^GSPC ^IXIC ^DJI ^RUT ^KS11 ^N225 ^MXX
  ES=F NQ=F YM=F RTY=F` (+ `^BVSP ^MERV` si se incluyen). **`^DJI` es el
  sospechoso #1** → tener `DIA` listo como fallback.
- **Macro curado**: el riesgo es que se quede viejo. Mitigación: el banner solo
  muestra un evento pasado con resultado si su fecha ≤ hoy; y un recordatorio en
  el doc/calendario para refrescar cada trimestre.
- **Honestidad de datos** (patrón de la casa): si un índice no devuelve quote, la
  barra **conserva el último valor** o muestra "—", nunca inventa un +0.00 %
  (igual que `extractQuote` en `tape.js`).

---

## 10. Esfuerzo por pieza

| # | Pieza | Esfuerzo | Notas |
|---|---|---|---|
| 5 | Flag SOCIAL | **XS (~15 min)** | Patrón `/api/config` ya existe. Empezar por aquí. |
| 4a | SMH en industries | **XS (~10 min)** | 1 línea en `api/sectors.js` + label "(13)". |
| 1 | Barra de índices | **M** | Reusa `/api/tape`. Nuevo: símbolos + label map + toggle futuros/índices + caché edge. Smoke en prod. |
| 4b | Heatmap + movers compactos | **S-M** | Recorte de render sobre `/api/sectors` y `/api/movers` existentes. |
| 3 | Arena leaderboard-ready | **M** | Reusa `/api/arena`; el trabajo es el layout array-first + subirlo al hero. |
| 2 | Banner + calendario macro | **M** | Fuente curada nueva (`macro-calendar`) + render del banner. Earnings ya vienen de Finnhub. El curado inicial ~30 min. |
| — | Contenedor `#terminalHero` + móvil | **M** | Grid del hero, orden responsive, skeletons, smoke 390px. |
| — | Backend `pms:[]` en `/api/arena` | **Follow-up** | No bloquea v1; v1 envuelve en `[data]` en cliente. |

**Ruta sugerida**: XS primero (flag social + SMH, valor inmediato y cero riesgo)
→ barra de índices (el corazón del "3 segundos") → banner macro → Arena hero →
heatmap/movers compactos → pulido móvil.

---

## 11. Decisiones que necesito de ti

1. **Alcance de índices LATAM**: ¿solo **BMV IPC (`^MXX`)** en v1 (lo que
   pediste), o incluyo también **Bovespa (`^BVSP`)** y **Merval (`^MERV`)**?
   (Cada uno es un símbolo más en la barra, gratis.)
2. **Fuente del banner macro**: ¿confirmas **opción A (calendario curado a mano
   en el repo)** para las cifras Fed/CPI/PCE/NFP, con earnings de Finnhub? ¿O
   prefieres explorar una API paga (opción C) desde ya?
3. **SMH vs SOXX** para el heatmap de industrias: ¿voy con **`SMH`** (mi
   recomendación) o prefieres `SOXX` por consistencia con la etiqueta que ya usas
   mentalmente?
4. **Caché edge de índices**: ¿ok con añadir `s-maxage` corto (~20 s) a la ruta
   de índices para que un pico de tráfico de TikTok comparta requests a Yahoo?
   (Recomendado; el trade-off es hasta ~20 s de rezago vs "cada navegador pega a
   Yahoo".)
5. **Label del tab**: ¿el nav sigue diciendo **AGENTS**, o renombro la entrada a
   **TERMINAL / INICIO** para que un recién llegado entienda qué está viendo?
6. **Cierre del scope**: ¿construyo en este mismo orden (§10) o reordenas
   prioridades? (Puedo entregar las dos XS — flag social + SMH — de inmediato si
   quieres valor visible ya, y seguir con el hero.)
