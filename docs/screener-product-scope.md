# Screener de producto — Censo y alcance

Fecha del censo: 2026-07-28.
Objetivo: convertir el SCREENER de "alimentador del Arena" en herramienta de
producto — el usuario pica filtros y salen acciones con **precio vivo** y
**fundamentales explicados en español**.

Estado: **SCOPE. Nada construido todavía.** Este doc cierra con las decisiones
que necesito de ti antes de escribir código.

---

## 1. Qué existe hoy

### 1a. La pestaña SCREENER (app.html)

- **UI**: `app.html` → `#page-screener` (línea ~977). Motor: `runScreener()`
  (línea ~1953), render: `renderScreenerResults()` (~2296).
- **De dónde saca los datos HOY**: 100 % del navegador, **en vivo, por request**.
  Cada click en SCREEN abre un abanico de llamadas a `/api/price?ticker=X`
  sobre el universo, hasta `SC_SCAN_CAP=120` símbolos en lotes de
  `SC_CONCURRENCY=24`. **No toca Neon en absoluto.**
- **Qué es `/api/price` por símbolo (ruta US)**: Finnhub `quote` + `stock/metric`
  + `profile2` + `recommendation` + `insider-transactions` + Yahoo 1y chart =
  **~6 llamadas upstream por ticker**. Un SCREEN = hasta 120 × 6 ≈ **700 llamadas
  en ráfaga** → 429s, lento. El propio código tiene comentarios sobre el
  "stampede" y los rate limits.
- **Columnas hoy**: Ticker, Empresa, Precio, 30D %, Sigma (volatilidad),
  Squeeze, Insider, Inst Own, Signal, Thesis. → Es un screener **técnico /
  short-squeeze**, NO fundamental. **No muestra P/E, ni ROE, ni márgenes.**
- **Filtros hoy**: Universo, Sector (¡decorativo — nunca se aplica en la lógica
  de filtro!), Min Squeeze, Min Momentum %, Insider, Signal, rango Sigma, Sort,
  Max results. Presets: squeeze/insider/momentum/latam/volatile.
- **CTA**: click en fila → `openFromScreener()` salta a la pestaña **SIM** (no al
  Arena). El README dice "el screener solo alimenta al Arena" — es impreciso:
  *la pestaña* alimenta a SIM; *la tabla de Neon* alimenta al Arena (§1b).
- **Campos que casi nunca llegan**: Squeeze / Inst Own dependen del tier premium
  de Finnhub → en free tier son null casi siempre (por eso ya existe
  `qdUnavailableCell()`, el placeholder honesto).
- **Universo duplicado**: el tab tiene SU PROPIA copia hardcodeada
  (`SCREENER_UNIVERSE` en app.html: 178 US **incluyendo ~27 ETFs**, 82 LATAM,
  41 crypto), distinta del universo del backend (§1b). Riesgo de drift.

### 1b. La tabla `arena_screener` (Neon) — el activo reutilizable

- **Precompute**: cron `api/arena-screener.js` (cada 4 h) llena `arena_screener`
  con, por símbolo: `last_close, ma50, ma200, pe_ttm, ps_ttm, gross_margin,
  net_margin, debt_to_equity, roe_ttm, rev_growth_yoy, security_type,
  refreshed_at`. Fundamentales de Finnhub `stock/metric` + precio/MA de Yahoo.
- **Universo**: `api/_lib/screener-universe.js` → `US_SCREENER_UNIVERSE` =
  **151** (equity común + ADR, SIN ETFs). Este es el "151" de tu brief.
  **NO** incluye BMV/B3/BCBA locales ni crypto.
- **Consumidor actual**: solo `arena-run.js` (líneas 224-226, 422). Lee la tabla,
  corre `computeScreens()` (`screens.js`) → dos screens deterministas
  **value** (P/E bajo + ROE alto + deuda baja) y **momentum** (precio > MA50 >
  MA200). Cero llamadas en la corrida.

### Conclusión: ¿evolucionar o reemplazar?

**Evolucionar el cascarón, reemplazar el motor.** No construir en paralelo:
esta ES la pestaña, reconstruida.

- **Reusar**: el tab, top-bar, tabla de resultados, plumbing i18n, presets UI,
  `openFromScreener`, `qdUnavailableCell`, `LATAM_ADR_COUNTRY`, `bmvNames`.
- **Reemplazar**: el camino de datos (abanico de `/api/price`) → **un SELECT a
  Neon + precio vivo solo para los ~20 que pasan**. Añadir filtros
  fundamentales + explicadores de métricas.
- El modo técnico actual (squeeze/momentum/vol) se conserva como **modo/preset
  secundario** — sirve para BMV y crypto (§4). Pero el v1 de producto es
  **fundamental-first**, que es justo lo que la pestaña NO hace hoy.

---

## 2. Arquitectura — confirmación del diseño

**Tu diseño es correcto. Confirmado, con dos precisiones.**

Flujo propuesto:
```
usuario pica filtros
  → SELECT parametrizado sobre arena_screener  (ms, el tamaño del universo da igual)
      WHERE pe_ttm BETWEEN ... AND roe_ttm >= ... AND debt_to_equity <= ... ...
  → ~20 filas (fundamentales trimestrales + precio/MA stale 1-2 días)
  → SOLO para esos ~20: traer PRECIO VIVO
  → recalcular P/E al momento
  → render
```

Por qué es correcto: `arena_screener` ya es un cache de precompute; sumar un
segundo lector (screener de producto) junto al Arena es gratis. Los
fundamentales cambian por trimestre → stale está bien y es **honesto**
(etiquetar "trimestral"). El precio sí es vivo. Dos consumidores, una tabla.

**Precisión A — cómo se recalcula P/E vivo (la mecánica):**
P/E = precio / BPA. No guardamos BPA, pero sí `pe_ttm` y `last_close` (ambos
del mismo momento del precompute). Entonces:
```
BPA_ttm       = last_close / pe_ttm        (derivado, trimestral → OK stale)
pe_vivo       = precio_vivo / BPA_ttm
```
Igual para P/S (`last_close / ps_ttm` = ventas por acción). **Solo P/E y P/S se
recalculan con precio vivo.** ROE, márgenes, deuda, crecimiento **no dependen
del precio** → se muestran tal cual de Neon, etiquetados "trimestral". Split
limpio y sin mentir.

**Precisión B — no re-uses la ruta pesada de `/api/price` para los 20.**
Esa ruta hace ~6 llamadas/ticker. Para el precio vivo solo necesitamos Finnhub
`quote` (1 llamada/ticker) → 20 llamadas, ~1-2 s, muy por debajo del cap.
Recomiendo un **endpoint nuevo `/api/screener`** que hace el SELECT **y** los
~20 quotes **server-side**, y devuelve todo en UN request al navegador (esconde
la key, cacheable, sin 20 round-trips desde el cliente).

---

## 3. Universo — expansión

- **Hoy**: 151 (backend). Para producto es poco.
- **Realidad de capacidad**: llenaste 151 en ~8 min con 4 llamadas manuales, sin
  429. El cuello NO es el rate limit — es el wall de 60 s de la lambda
  (`PER_RUN=30`, `SPACING_MS=1200` → ~40 s/run) y la frecuencia del cron (4 h).
  A 1.2 s de spacing son ~50 llamadas Finnhub/min, bajo el cap de 60/min.
- **Propuesta v1**: **S&P 500 ∪ 151 actual ∪ ADRs LATAM ≈ ~600 símbolos.**
  Lista estática curada (como el universo actual). Líquidos, cubiertos por
  Finnhub, reconocibles, fundamentales completos.
- **Cuánto tarda el llenado**:
  - Cold fill a settings actuales: 600 ÷ 30 = 20 runs × 4 h = demasiado lento
    para un backfill único.
  - **Backfill manual en ráfaga** (lo que ya haces): subir `PER_RUN` a ~45-50
    (SPACING ~1000 ms → ~45-50 s, cabe en 60 s) → 600 ÷ 50 ≈ 12 runs. A ~45 s
    cada uno + tu ritmo de disparo manual ≈ **~25-30 min**, consistente con tu
    experiencia de "151 en 8 min". El ledger es reanudable (`pickStaleSymbols`
    drena lo más viejo/nunca primero), así que se puede hacer en tandas seguras.
  - Steady-state: con `PER_RUN=50` cada 4 h = 300/día → universo completo cada
    ~2 días. Fundamentales trimestrales → 2 días de staleness es irrelevante.
- **Descarto** la expansión vía Finnhub symbol map + filtro de liquidez para v1:
  el symbol map free no trae volumen; rankear liquidez pediría un quote por
  símbolo (miles de llamadas). La lista estática S&P 500 es más simple y mejor.
  El filtro de liquidez queda como follow-up si quieres pasar de 500.
- **Dedup**: al expandir, matar la copia hardcodeada del frontend y que consuma
  el universo del backend (elimina el drift de §1a).

---

## 4. LATAM — dos casos

### 4a. ADRs (cotizan en EE.UU., Finnhub da fundamentales completos)

Van **igual que cualquier US name**. Ya en el universo (30):
`MELI NU GLOB STNE VALE ITUB PBR ABEV BBD SBS CIB BAP XP LSPD DESP PAGS VIST EC
AVAL BVN SCCO BSAC ERJ ERO FMX KOF AMX CX ASR PAC`.

**ADRs LATAM notables que FALTAN** (US-listed, fundamentales Finnhub, deberían
entrar):
- **Brasil**: UGP (Ultrapar), BSBR (Santander Brasil), CIG (Cemig), SID (CSN),
  TIMB (TIM), VIV (Telefônica Brasil/Vivo), EBR (Eletrobras), BAK (Braskem),
  AZUL, GGB (Gerdau), CBD (Pão de Açúcar), INTR (Inter&Co).
- **Argentina**: YPF, GGAL (Galicia), BMA (Macro), PAM (Pampa), LOMA (Loma
  Negra), CEPU (Central Puerto), CRESY (Cresud), TEO (Telecom Arg), EDN
  (Edenor), SUPV (Supervielle), BIOX (Bioceres).
- **Chile**: **SQM** (litio — grande), **BCH** (Banco de Chile), ENIC (Enel
  Chile), CCU (cervecería), LTM (LATAM Airlines).
- **México**: BSMX (Santander México), TV (Televisa), SIM (Simec).
- **Perú**: FSM (Fortuna).

**Insight clave**: para SQM, BCH, YPF, GGAL, BMA, PAM, LOMA ya tienes la
listing **local** (`.SN`/`.BA`) en el array LATAM pero **no el ADR** — y el ADR
es el que da fundamentales gratis. Agregar el ADR **sube** esos nombres de
"solo técnico" a "fundamental completo".

### 4b. BMV/B3/BCBA directas (WALMEX.MX, FEMSA, GMEXICO, PETR4.SA…)

Yahoo da precio; **Finnhub free NO da fundamentales**. Solo se puede screening
**técnico** (precio vs MA, volumen, rangos). Cómo modelarlo sin mentir:

- **Dos modos claramente etiquetados**: **"Fundamental"** (P/E, ROE, márgenes →
  solo US + ADRs) y **"Técnico"** (precio/MA/vol/rango → funciona para todos,
  incl. BMV locales y crypto).
- **Cero plumbing nuevo para el técnico**: `arena_screener` YA guarda
  `last_close/ma50/ma200`. Si metes los símbolos BMV al ledger, el screen
  técnico (precio vs MA50/MA200, % sobre media, momentum, volatilidad, posición
  en rango 52s) funciona para ellos **sin tocar nada más**.
- **Etiquetado honesto**: columna/badge **DATOS** por fila —
  "Fundamental+Precio" vs "Solo técnico (mercado local)". En modo Fundamental,
  las columnas de fundamentales para un BMV se renderizan como
  `qdUnavailableCell()` → "Sin datos fundamentales (mercado local)", **nunca en
  blanco que se lea como cero**. Chip de filtro: "Incluir BMV/B3 (solo técnico)".
- **Crypto** cae natural en el modo Técnico también (no tiene P/E).

---

## 5. UX

- **Español, nombres que la audiencia reconoce** (ya existen `LATAM_ADR_COUNTRY`
  y `bmvNames`).
- **El diferenciador = explicadores de métricas inline.** Cada métrica lleva un
  "¿Qué es P/E?" / "¿Qué significa ROE?" en lenguaje llano. El repo ya usa
  `title=` por todos lados + `qdUnavailableCell()`; extenderlo con un popover
  explicador por métrica. Ese es el moat vs Finviz/TradingView (inglés, sin
  explicación) — **no el screener en sí**.
- **Filtros v1 — pocos y útiles** (mapean directo a columnas de Neon):
  1. **Mercado**: US large-cap / ADRs LATAM / (Técnico: +BMV).
  2. **Sector** — pero **de verdad** esta vez (hoy es decorativo). Requiere una
     columna sector/industria (Finnhub `profile2.finnhubIndustry`) en
     `arena_screener` → re-fill del cron.
  3. **P/E (Precio/Ganancias)** — rango. "barato < 15, caro > 30".
  4. **ROE (Rentabilidad sobre capital)** — mínimo. "> 15 % = buena".
  5. **Margen neto** — mínimo.
  6. **Deuda / Capital** — máximo. "< 1 = conservador".
  7. **Crecimiento de ingresos (YoY)** — mínimo.
- **Presets v1 en español** (ya existen como screens deterministas en
  `screens.js` — reusar la lógica):
  - **"Calidad barata"** = valueScreen (P/E bajo + ROE alto + deuda baja).
  - **"Momentum"** = momentumScreen (precio > MA50 > MA200).
  - **"Crecimiento"** = rev_growth alto + margen (nuevo, trivial).
- **Columnas v1**: Ticker, Empresa, **Precio (VIVO)**, **P/E (vivo)**, ROE,
  Margen neto, Deuda/Cap, Crec. ingresos, DATOS-badge, [acción].

---

## 6. Esfuerzo — reusa vs nuevo

### Reusa (~70 %)
- `arena_screener` tabla + schema (ya tiene todos los fundamentales + precio/MA).
- `screener-db.js` → añadir UNA función de lectura `queryScreener(filtros)`
  (SELECT parametrizado). `readScreenerRows` ya existe.
- `screens.js` → valueScreen/momentumScreen = los presets, reuso directo.
- `arena-screener.js` (cron precompute) → reuso; solo expandir el ledger +
  añadir campo industria.
- `finnhub-dive.js` `fetchFundamentals` → reuso; sumar `profile2.industry`.
- `/api/price` → reuso para el quote vivo (o rama quote-only ligera).
- app.html: cascarón del tab, dict i18n, presets UI, tabla de render,
  `openFromScreener`, `qdUnavailableCell`, `bmvNames`, `LATAM_ADR_COUNTRY`.

### Nuevo (~30 %)
- **Backend**: `GET /api/screener` → SELECT sobre `arena_screener` + quote vivo
  para los ~20 + recompute P/E vivo. (~1 archivo, ~120 líneas.)
- **Schema**: columna `industry text` (y quizá tag `market`) en `arena_screener`;
  guardar `finnhubIndustry` en el upsert del cron.
- **Universo**: lista estática S&P 500 + ADRs LATAM faltantes; opcional símbolos
  BMV marcados técnico-only. Dedup del frontend contra el backend.
- **Frontend**: reescribir el motor `runScreener()` para llamar al UN endpoint
  nuevo en vez del abanico de `/api/price`; controles de filtro fundamental;
  popovers explicadores; badge DATOS para filas técnico-only.
- **Ops**: ajustar `PER_RUN`/`SPACING`/frecuencia del cron para el universo
  mayor; backfill único (~25-30 min manual).

---

## Decisiones que necesito de ti

1. **Evolucionar vs reemplazar**: ¿OK vaciar el motor técnico actual (abanico en
   vivo) y reconstruir fundamental-first en el mismo tab, conservando el técnico
   como modo secundario?
2. **Tamaño del universo v1**: ¿S&P 500 ∪ 151 ∪ ADRs LATAM (~600)? ¿Y OK subir
   `PER_RUN` + un backfill manual en ráfaga (~30 min) para llenarlo?
3. **BMV directas en v1**: ¿incluirlas ya en un modo "Técnico" etiquetado, o
   diferir a v2 y arrancar fundamental-only (US + ADRs)?
4. **Destino del click en fila**: ¿seguir a SIM, o abrir el análisis completo de
   agentes / una ficha de ticker?
5. **Alcance del recompute vivo**: confirmar que **solo P/E (y P/S)** se
   recalculan con precio vivo; ROE/márgenes/deuda/crecimiento se muestran de
   Neon como trimestrales (etiquetados).
6. **Forma del endpoint**: SELECT + quotes server-side en UN `/api/screener`
   (recomendado) vs. el frontend orquestando — confirmar un solo round-trip.
7. **Sector de verdad**: ¿invertir ya en la columna sector/industria (implica
   re-fill del cron para poblarla)?
