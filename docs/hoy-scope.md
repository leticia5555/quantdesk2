# /hoy — página pública del mercado del día (móvil primero)

Fecha: 2026-07-30. Página nueva para el bio de TikTok/redes: URL limpia
(`/hoy`), carga rápida en teléfono, sin login. Agrega en una sola vista lo que
la audiencia quiere de un vistazo — **sin** las secciones de la terminal completa.

## Qué muestra (en orden)

1. **Arena** — grid de cards por modelo (una hoy: *Claude PM · Haiku 4.5*). El
   layout es **N-ready**: cuando aterrice la liga multi-modelo (ChatGPT/Grok/
   Gemini/Claude), el mismo grid renderea N cards sin rehacerse. Lee `/api/arena`.
   Si `ARENA_ENABLED != 1` o faltan keys, la card muestra "próximamente" en vez
   de romperse.
2. **Calendario** — línea de tiempo que mergea dos fuentes:
   - **Macro CURADO** (`/api/macro-events`): tabla Neon `macro_events`. Lety
     carga a mano ~8 eventos/mes (Fed, CPI, empleo, PIB, subastas, discursos).
     **Nada de scraping frágil.**
   - **Earnings de mega-caps** (`/api/earnings?mega=1`): automático desde el
     calendario de Finnhub que ya existe, intersectado con un set curado de
     mega-caps (incluye ADR LATAM: NU/MELI/ITUB/VALE/PBR).
3. **Sectores** — heatmap compacto (`/api/sectors?category=us`). Ahora incluye
   **SOXX** (semis, el corazón del trade de IA) e **IBIT** (bitcoin) además de
   los 11 sectores GICS. Coloreado por % del día, con la fila de referencias
   (SPY/QQQ/IWM/DIA) arriba.

Footer: disclaimer (paper trading, no asesoría) + link a la terminal (`/app`).

## Piezas

| Pieza | Archivo |
|---|---|
| Página pública | `hoy.html` (rewrite `/hoy` en `vercel.json`) |
| Calendario macro curado (CRUD) | `api/macro-events.js` + tabla `macro_events` (`_lib/db.js`) |
| Admin para cargar eventos | `admin-macro.html` (gated, `noindex`) |
| Earnings mega-cap | `api/earnings.js` (`?mega=1`, set `MEGA_CAPS`) |
| Heatmap + SOXX/IBIT | `api/sectors.js` (categoría `us`) |
| Flag esconder SOCIAL | `app.html` (`QD_HIDE_SOCIAL`) |
| Tests | `tests/macro-events.test.mjs`, `tests/earnings.test.mjs` (bloque `mega=1`) |

## Cargar eventos macro (el flujo de 5 minutos)

1. Abre **`/admin-macro.html`** en el teléfono (no está enlazada en público y
   lleva `noindex`).
2. Pega el `ADMIN_SECRET` una vez (se guarda en localStorage del teléfono).
3. Fecha + título + categoría + importancia + nota opcional → **Agregar**.
   Abajo se ve la lista de próximos con botón de **Borrar**.

### API (por si prefieres script)

```
GET    /api/macro-events            → próximos (público, cacheado)
GET    /api/macro-events?all=1      → incluye 7 días pasados (para el admin)
POST   /api/macro-events            → agrega   (Authorization: Bearer <secret>)
       body: { event_date:"YYYY-MM-DD", title, category, importance, note }
DELETE /api/macro-events?id=<id>    → borra    (Authorization: Bearer <secret>)
```

## Env vars

- `ADMIN_SECRET` — secret de escritura del calendario macro. **Fail closed:** si
  no está configurado (ni `ADMIN_SECRET` ni `CRON_SECRET` como fallback), toda
  escritura responde 401 — la tabla nunca queda abierta a internet. La lectura
  GET es pública siempre.
- Reusa las existentes: `DATABASE_URL` (Neon), `FINNHUB_API_KEY` (earnings +
  heatmap), `ARENA_ENABLED`/`ALPACA_PAPER_*` (Arena).

## Esconder SOCIAL

`app.html` trae `const QD_HIDE_SOCIAL = true;`. Esconde el tab (el botón y, por
si hay un `qd_lastTab` rancio, redirige a SECTORS). El código de SOCIAL
(`#page-social`, `analyzeSocial`, `renderSocialPulse`) queda intacto — poner el
flag en `false` lo devuelve.

## Notas de diseño

- **Móvil primero:** la mayoría llega de TikTok en teléfono. Una sola columna,
  targets grandes, `safe-area-inset`, skeletons mientras carga, fallbacks
  honestos (nunca en blanco: "no disponible").
- **N-ready sin rehacer:** el front normaliza tanto la forma actual de
  `/api/arena` (un agente) como la futura `{ agents:[...] }` — la liga
  multi-modelo solo tendrá que devolver el array.
