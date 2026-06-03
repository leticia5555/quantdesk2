# Plan: `/api/why-moved` — Atribución de movimiento a noticia

> **Estado: PROPUESTA. No construido.** Documento de diseño para decidir cuándo
> implementar. No modifica el comportamiento de la app.
>
> **Meta:** que cuando una acción se mueva fuerte, QuantDesk diga *exactamente*
> qué la movió, conectando precio ↔ noticia. Ejemplo objetivo:
> *"Victoria's Secret (VSCO) +45% hoy porque reportó EPS de $X vs $Y esperado —
> un beat de Z%."*

---

## 1. Idea en una frase

Un endpoint que **une** el movimiento de precio de hoy + las noticias del mismo
día + el contexto de earnings (beat/miss), y le pide a **Claude** que elija el
**único driver más probable** y redacte una explicación de una línea, con un
**nivel de confianza** y la **fuente** para que el usuario verifique.

No inventa una capacidad nueva desde cero: **reutiliza piezas que ya existen** en
`api/` (ver §3). Lo único nuevo es la capa que las **junta y razona**.

---

## 2. Contrato del endpoint

```
GET /api/why-moved?ticker=VSCO
GET /api/why-moved?ticker=VSCO&date=2026-06-02   (opcional, para back-testear un día pasado)
```

**Parámetros**
- `ticker` (requerido): símbolo, ej. `VSCO`, `NVDA`, `MELI`.
- `date` (opcional): día a explicar (default = hoy / última sesión).
- `threshold` (opcional): % mínimo para considerar "movimiento fuerte" (default 5%).

**Variables de entorno** (ya existen en Vercel, no hay que añadir nada):
- `FINNHUB_API_KEY` — precio + noticias.
- `ANTHROPIC_API_KEY` — razonamiento de Claude (server-side, nunca en el navegador).

**Caché:** CDN 15 min (`s-maxage=900`) para no repetir llamadas ni gastar tokens.

---

## 3. Qué APIs/datos UNE (todo ya existe en el repo)

| Pieza | Archivo actual | Qué aporta a la atribución |
|-------|----------------|----------------------------|
| **Movimiento de hoy** | `api/movers.js` / `api/price.js` (Finnhub `/quote`: `dp`, `d`, `c`, `pc`) | El **±% del día**, precio actual y cierre previo. Es el "qué pasó". |
| **Noticias del día** | `api/news.js` (Finnhub `/company-news`, ya trae `datetime`, `source`, `url`, `summary`) | Lista de titulares **con timestamp** → candidatos a driver. |
| **Earnings / beat-miss** | `api/earnings.js` (`surprise_pct`, `beat`, `stock_reaction_pct`, `eps_estimate`, `eps_actual`) | ¿Hoy fue día de reporte? ¿Superó lo esperado y por cuánto? Driver más fuerte y cuantificable. |
| **Catalizadores extra (opcional)** | `api/event-agent.js` (M&A keywords, regulatorio CADE/COFECE/Banxico…) | Señales de fusión/regulación que a veces explican saltos. |
| **Razonador** | patrón de `api/claude.js` (proxy seguro a Anthropic) | Elige el driver y redacta la frase. |

> **Nota de implementación:** conviene extraer un helper compartido para las
> llamadas a Finnhub (hoy el fetch está repetido en `movers.js`, `news.js`,
> `sentiment-agent.js`). No es bloqueante, pero evita duplicar código.

---

## 4. Flujo paso a paso

```
1. MOVE      → Finnhub /quote(ticker)  → { changePct, price, prevClose }
                 ├─ si |changePct| < threshold → responde {significant:false}
                 │   (movimiento normal, no vale la pena explicar)
                 └─ si es fuerte → continúa

2. NEWS      → Finnhub /company-news(ticker, últimas 48h)
                 → dedup + ordenar por fecha → top ~8 titulares con datetime/source/url

3. EARNINGS  → reutiliza lógica de earnings.js
                 → ¿hubo reporte en las últimas ~48h? beat/miss + surprise_pct
                 → ¿la dirección del beat/miss coincide con la del movimiento?

4. (opcional) EVENTS → event-agent: ¿señal de M&A / regulatorio reciente?

5. BRIEF     → arma un resumen compacto (JSON pequeño) con todo lo anterior

6. CLAUDE    → UNA sola llamada (vía patrón claude.js):
                 "Dado este movimiento y estos titulares, ¿cuál es el driver
                  más probable? Devuelve SOLO JSON."

7. RESPONSE  → JSON estructurado (ver §6) + caché 15 min
```

Todo lo de los pasos 1–4 corre **en paralelo** (`Promise.allSettled`) para latencia baja.

---

## 5. Qué se le pasa a Claude (el "brief")

Una sola llamada, barata, con un brief compacto. Ejemplo del *input*:

```json
{
  "ticker": "VSCO",
  "company": "Victoria's Secret & Co.",
  "move": { "change_pct": 45.2, "direction": "UP", "price": 38.10, "prev_close": 26.24 },
  "is_earnings_day": true,
  "earnings": { "beat": true, "surprise_pct": 32.0, "eps_estimate": 0.10, "eps_actual": 0.14, "reported": "2026-06-02" },
  "headlines": [
    { "t": "Victoria's Secret tops Q1 estimates, raises guidance", "source": "Reuters", "datetime": "2026-06-02T11:02:00Z", "url": "…" },
    { "t": "VSCO shares surge after earnings beat",               "source": "Yahoo",   "datetime": "2026-06-02T13:20:00Z", "url": "…" },
    { "t": "Analyst lifts Victoria's Secret price target",        "source": "Benzinga","datetime": "2026-06-02T14:05:00Z", "url": "…" }
  ]
}
```

**System prompt (resumen de instrucciones):**
- Eres un analista. Elige **el único driver más probable** del movimiento.
- Prioriza earnings si `is_earnings_day` y la dirección coincide.
- Si ningún titular explica el movimiento, responde `type:"unexplained"` (no inventes).
- Explicación en **español LATAM**, 1 frase, con el número clave (ej. el % de sorpresa).
- Mantén tickers/siglas (EPS, ADR, M&A) en su forma original.
- Devuelve **SOLO JSON** con el esquema de §6.
- Reglas de confianza: `HIGH` si earnings beat/miss del mismo día coincide con la
  dirección, o un titular claramente dominante; `MEDIUM` si hay un titular
  plausible pero sin earnings; `LOW` si no hay noticia clara.

---

## 6. Esquema de respuesta

```json
{
  "ticker": "VSCO",
  "significant": true,
  "move_pct": 45.2,
  "direction": "UP",
  "price": 38.10,
  "as_of": "2026-06-02",
  "driver": {
    "type": "earnings",            // earnings | news | analyst | m&a | regulatory | macro | unexplained
    "headline": "Victoria's Secret tops Q1 estimates, raises guidance",
    "source": "Reuters",
    "url": "https://…",
    "datetime": "2026-06-02T11:02:00Z"
  },
  "explanation_es": "VSCO +45% hoy porque reportó EPS de $0.14 vs $0.10 esperado — un beat de 32% — y subió su guía anual.",
  "confidence": "HIGH",
  "confidence_reason": "Reporte de earnings el mismo día con beat de 32%, dirección consistente con el alza.",
  "secondary_factors": ["Subida de price target de un analista", "Volumen 4× el promedio"],
  "caveat": "Atribución por correlación del mismo día (cierre diario), no causalidad probada ni timing intradía.",
  "source_engine": "finnhub + earnings + claude"
}
```

Casos especiales:
- **Movimiento pequeño:** `{ "significant": false, "move_pct": 1.2, ... }` → el front no muestra tarjeta.
- **Sin noticia clara:** `driver.type = "unexplained"`, `confidence = "LOW"`,
  `explanation_es = "VSCO −8% hoy sin una noticia clara que lo explique (posible rotación de sector o flujo técnico)."`

---

## 7. Cómo se vería en el terminal (`app.html`)

**A) Tarjeta "¿Por qué se movió?" en la vista del ticker**

```
┌────────────────────────────────────────────────────────┐
│ 🔍 ¿POR QUÉ SE MOVIÓ?                    [HIGH ●]        │
│                                                         │
│  VSCO  ▲ +45.2%                          📊 EARNINGS     │
│  "VSCO +45% hoy porque reportó EPS de $0.14 vs $0.10    │
│   esperado — un beat de 32% — y subió su guía anual."   │
│                                                         │
│  Fuente: Reuters · 11:02 →  (link)                      │
│  También: ↑ price target de analista · volumen 4×       │
└────────────────────────────────────────────────────────┘
```
- Badge de color: verde si sube, rojo si baja.
- Chip de confianza: `HIGH / MEDIUM / LOW`.
- Ícono por tipo de driver: 📊 earnings · 📰 noticia · 🏦 analista · ⚖️ regulatorio · 🤝 M&A · ❓ sin causa clara.
- Link a la fuente (para que el usuario verifique — clave para la confianza).

**B) Integración con la lista de Movers (`/api/movers`)**

Cada fila de top gainer/loser ya tiene `onclick="useMoverTicker(...)"`. Se le
añade un botón **"¿por qué? →"** que llama a `/api/why-moved?ticker=X` y expande
la explicación de una línea **inline**, sin salir de la lista. Así el usuario ve
de un vistazo *"NVDA +6% → subió por guía de data centers; PLTR −9% → caída tras
secundario de acciones."*

---

## 8. Limitaciones honestas (mostrarlas en el `caveat`)

1. **Timing diario, no intradía.** El `%` es de **cierre diario**; no sabemos a
   qué hora exacta ocurrió el salto. La atribución es **correlación del mismo
   día + criterio del LLM**, no prueba de "el spike de las 10am". Suficiente para
   el caso Victoria's Secret; no es forense.
2. **Juicio del LLM = puede equivocarse.** Por eso siempre se muestra
   **confianza + fuente con link**, no una afirmación absoluta.
3. **Cobertura de datos.** Finnhub free cubre bien US large/mid cap; small caps y
   algunos **ADR LATAM** traen pocas noticias → más casos `unexplained`.
4. **Rate limits / costo.** Finnhub free ~60 req/min; cada lookup = 1 llamada a
   Claude → la **caché de 15 min** y un **threshold de movimiento** mantienen el
   costo bajo (solo se explica lo que de verdad se movió).

---

## 9. Plan por fases (para construir cuando decidas)

**Fase 1 — MVP (lo que cumple tu ejemplo VSCO):**
- Endpoint `/api/why-moved?ticker=` que une quote + company-news + earnings y
  llama a Claude → one-liner + confianza + fuente.
- Tarjeta "¿Por qué se movió?" en la vista del ticker.
- *Reutiliza* APIs existentes; es la pieza de "juntar y razonar".
- Esfuerzo estimado: medio día.

**Fase 2 — Movers:**
- Botón "¿por qué?" en cada fila de gainers/losers; explicación inline.
- (Opcional) un job que pre-calcula el "por qué" de los top 10 movers del día.

**Fase 3 — Precisión intradía (la parte que hoy falta):**
- Traer **precio intradía** (Finnhub/Yahoo intraday) y hacer **matching por
  timestamp** entre el salto y el titular.
- Detección de **comunicados oficiales** (press releases) para subir confianza.
- Esto cierra la brecha de "a las 10am por *esta* noticia exacta".

---

## 10. Resumen para decidir

- **~70% de las piezas ya están** (`movers`, `price`, `news`, `earnings`, `claude`).
- Lo nuevo de **Fase 1** es chico y de bajo riesgo: un endpoint que junta datos
  que ya produces y una tarjeta de UI.
- La única brecha **real** (timing intradía) es **Fase 3** y es opcional para tu
  caso de uso principal.
- No requiere nuevas llaves ni servicios: usa `FINNHUB_API_KEY` y
  `ANTHROPIC_API_KEY` que ya tienes.

*(Fin del plan — nada de esto está implementado todavía.)*
