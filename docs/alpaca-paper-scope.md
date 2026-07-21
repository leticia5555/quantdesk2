# Alpaca Paper API — Censo y diagnóstico de alcance de la migración

Fecha del censo: 2026-07-21. Solo alcance — cero código de app en este PR.

**Gate:** hasta que `?smoke=1` pase desde el Vercel real contra `paper-api.alpaca.markets`, no se construye nada (sección 6). Verificado hoy: el sandbox de investigación bloquea `*.alpaca.markets` a nivel de proxy (CONNECT 403), así que el smoke desde Vercel no es solo "el que cuenta" — es el único posible.

---

## 0. Encuadre: qué hay realmente en el repo (correcciones de premisa)

Antes de proponer, cuatro realidades del código que difieren del modelo mental del pedido:

1. **"Los 5 agentes"** no son 5 entidades con nombre en el código. Son las filas `status='alive'` de la tabla `agents` en Neon (los agentes que el usuario creó desde la UI; hoy tu cuenta tiene 5). El motor (`api/_lib/sim.js`) es **determinista, sin LLM**: edges de señales (`buildRule` del signal-backtester) y de pares (z-score OLS). Los 6 research-agents LLM y las 13 investor personas son otra cosa y no entran en esta migración.
2. **Los fills de hoy no son "precio Finnhub sin costos".** `sim.js:40-65` ya modela slippage 0.10% adverso + comisión 0.05% por lado, sobre **cierre diario de Yahoo Finance** (no Finnhub). Lo que falta no son costos — es realismo: órdenes de verdad, libro real, calendario real, fills intradía.
3. **No existe integración WhatsApp/Railway en este repo.** Cero código, cero env var. El canal de Railway vive fuera del repo; aquí lo que toca es construir el cliente que le pega (sección 4) y necesitamos el contrato de ese servicio.
4. **Los edges pueden ser cripto** (`api/_lib/crypto-map.js` mapea a símbolos Yahoo). Alpaca paper soporta cripto, pero con endpoints de datos distintos, mercado 24/7 (sin calendario) y fee model propio. **Propuesta: v1 = solo equities en Alpaca; los edges cripto siguen en el simulador actual** hasta una fase posterior.

Zona segura: nada de `api/agents*.js`, `api/_lib/sim.js` ni `api/_lib/db.js` se tocó en los merges de esta semana (#52–#67, que fueron MOVERS/TRACKER/charts/VC — esos archivos no se tocan).

---

## 1. Censo de la Alpaca Paper API

### Auth y base

- Base URL: `https://paper-api.alpaca.markets` (live: `https://api.alpaca.markets` — **misma API, solo cambia base URL y keys**; eso es exactamente lo que habilita la Fase 2 con el mismo código).
- Headers en cada request: `APCA-API-KEY-ID` y `APCA-API-SECRET-KEY`. Las keys del paper se generan en el dashboard de Alpaca (sección "Paper Trading") y son distintas de las live.
- La cuenta paper nace con $100k; el balance se puede resetear a un monto arbitrario **solo desde el dashboard** (no hay endpoint de reset). El dashboard actual permite **crear y borrar múltiples cuentas paper, cada una con sus propias keys** — relevante para los 5 libros (sección 2.4). Confirmar el máximo de cuentas al abrir la cuenta.

### Endpoints que necesitamos

| Endpoint | Método | Para qué |
|---|---|---|
| `/v2/account` | GET | equity, cash, buying_power, status; check de salud en smoke y antes de cada corrida |
| `/v2/orders` | POST | mandar la orden límite (body: `symbol, qty, side, type:'limit', limit_price, time_in_force, client_order_id, extended_hours?`) |
| `/v2/orders/{id}` o `?client_order_id=` | GET | poll del estado / fill |
| `/v2/orders/{id}` | DELETE | cancelar (smoke y política de expiración) |
| `/v2/orders` | DELETE | cancelar TODO lo abierto (kill switch) |
| `/v2/positions` | GET | reconciliación contra Neon |
| `/v2/positions/{symbol}` | DELETE | cerrar posición (con `?qty=` para parcial) — internamente genera una orden; para respetar la regla limit-only, cerrar con orden límite propia, no con este endpoint |
| `/v2/clock` | GET | `{timestamp, is_open, next_open, next_close}` — guard de mercado abierto |
| `/v2/calendar?start=&end=` | GET | días/horarios de sesión (`{date, open, close}`) — feriados y cierres tempranos |

### Tipos de orden y regla de la casa

- Soporta `market, limit, stop, stop_limit, trailing_stop`; TIF: `day, gtc, opg, cls, ioc, fok`.
- **Regla de la casa (cicatriz Polymarket): JAMÁS `market`.** Se codifica como guardrail determinista (sección 3), no como convención: el cliente Alpaca del repo directamente no expondrá `type` — todo sale `limit`.
- `extended_hours: true` solo se acepta con `limit` + `day` — compatible con la regla limit-only.
- Fraccionales: soportados (limit incluido, en horario regular); **shorts solo en acciones enteras**. Los legs cortos de pares se redondean a enteros.

### Qué devuelve un fill simulado

El objeto orden trae: `id`, `client_order_id`, `status` (`new → partially_filled → filled` / `canceled` / `expired`), `filled_qty`, `filled_avg_price`, `filled_at` (timestamp real), `submitted_at`, `limit_price`. Cómo simula el paper:

- Fills contra **quotes reales (NBBO) en tiempo real**: una limit de compra solo llena cuando `limit_price ≥ ask`; una de venta cuando `limit_price ≤ bid`. Es decir, el "slippage" implícito es el spread real del momento — mucho más realista que cierre-Yahoo ± 0.10%.
- **10% de las veces mete fills parciales aleatorios** cuando la orden es elegible.
- **Lo que NO simula** (documentado por Alpaca): posición en cola para limits no-marketables, price improvement, fees regulatorios, dividendos, ni constraint de liquidez (te llena tamaños mayores al NBBO). Comisión $0 en equities (igual que live). Conclusión: los fills paper son **ligeramente optimistas** — aceptable para validar agentes, y hay que decirlo en la UI igual que hoy se muestran `ASSUMPTIONS`.

### Rate limits

200 requests/min por key (429 al excederlo). Nuestro uso (5 agentes × pocas órdenes/día + polls + reconciliación) queda órdenes de magnitud por debajo. Sin riesgo.

### Nota regulatoria que cambia un guardrail pedido

**FINRA retiró la regla PDT; Alpaca la reemplazó por el "Intraday Margin Framework" el 4 de junio de 2026** (ya no existe el límite duro de 3 day-trades/5 días hábiles ni el mínimo de $25k). El guard de round-trips que pides sigue siendo buena disciplina de la casa — pero es eso, regla propia, no obligación del broker. Se implementa igual (sección 3), con el dato correcto en el naming: `HOUSE_MAX_ROUNDTRIPS`, no "PDT".

---

## 2. Arquitectura de la migración

### 2.1 El problema de fondo: 22:30 UTC es mercado cerrado

El cron corre a las 22:30 UTC = 18:30 ET (verano) / 17:30 ET (invierno) — NYSE cerró a las 16:00 ET. Además `sim.js` decide sobre **barras completas** por diseño (excluye la vela parcial del día). Dos opciones honestas:

- **A (recomendada): decidir a las 22:30, ejecutar a la apertura siguiente.** La orden límite se manda con `time_in_force: 'day'` fuera de horario → Alpaca la encola para el open siguiente. `limit_price` = cierre del día ± banda de tolerancia (p.ej. 0.5%: compra a `close × 1.005`, venta a `close × 0.995`) — protege del gap violento (la cicatriz) pero deja pasar el ruido normal de apertura. Si abre con gap más allá de la banda, la orden no llena y expira sola al cierre (`day`): el agente simplemente no entró, y lo re-decide el cron siguiente. Eso también es un fill realista.
- **B (descartada para v1): `extended_hours: true`** para llenar en after-hours a las 22:30. Spreads anchos y quotes finos → fills de mala calidad; y en invierno el after-hours igual sigue abierto pero el realismo empeora. No aporta nada frente a A.

Consecuencia estructural: **el flujo pasa de 1 fase a 2 fases** (Vercel maxDuration 60s tampoco permite esperar fills en el mismo request):

```
Cron 22:30 UTC (existente)      →  decide + guardrails + POST órdenes límite + journal + alerta "orden enviada"
Cron ~14:35 UTC nuevo (L-V)     →  reconcilia: GET órdenes por client_order_id, registra fills
                                   (precio/timestamp reales), actualiza positions/equity en Neon,
                                   alerta "fill" o "expiró sin fill", verifica invariantes vs /v2/positions
```

(14:35 UTC ≈ 10:35 ET verano — una hora después del open; en invierno el open es 14:30 UTC, así que el cron de reconciliación conviene a ~15:35 UTC o correrlo 2× para cubrir ambos horarios. Detalle a fijar en implementación.)

### 2.2 Neon vs Alpaca: quién es fuente de verdad

- **Neon = libro contable y fuente de verdad del producto**: qué agente decidió qué, con qué razonamiento, qué posición lógica tiene cada agente, equity history, leaderboard. Todo lo que la UI muestra sale de Neon, como hoy.
- **Alpaca = capa de ejecución y fuente de verdad de los fills**: precio, timestamp y qty ejecutada vienen de Alpaca y se copian a Neon en la reconciliación. Nunca al revés.
- Regla de oro: **Neon nunca inventa un fill** — una posición en Neon pasa a `open` solo cuando Alpaca reporta `filled`/`partially_filled`. El estado intermedio existe explícitamente (orden `submitted` sin fill aún).

### 2.3 Reconciliación

- **Idempotencia por `client_order_id` determinista**: `qd:{agent_id}:{fecha}:{symbol}:{side}`. Si el cron corre dos veces (retry de Vercel, catch-up), el POST duplicado rebota en Alpaca (client_order_id único) y el GET por client_order_id siempre encuentra la orden. Mismo espíritu que el catch-up idempotente actual por `last_run_date`.
- **Nueva tabla `orders`** en Neon (sección 5 la extiende con journal): estado local de cada orden con su `alpaca_order_id`, `status`, `limit_price`, `filled_avg_price`, `filled_at`. `positions` se deriva de órdenes llenadas.
- **Invariante diario** (en el cron de reconciliación): para cada símbolo, `Σ qty posiciones abiertas en Neon (por cuenta) == qty en GET /v2/positions` de esa cuenta. Divergencia → alerta WhatsApp + flag del agente, no auto-corrección silenciosa.

### 2.4 Los 5 portafolios: 5 cuentas paper, no sub-libros

**Recomendación: una cuenta paper por agente (5 cuentas, 5 pares de keys).** El dashboard de Alpaca hoy permite crear múltiples cuentas paper. Razones, en orden:

1. **Netting fatal en cuenta única:** el motor de pares abre shorts. Si el agente 1 está long TSLA y el agente 2 quiere short TSLA, en una sola cuenta la orden del 2 **cierra la posición del 1** en vez de abrir un short. No hay client_order_id que arregle eso — es contabilidad de la cuenta. Con 5 cuentas el problema no existe.
2. **Aislamiento de cash y buying power:** cada agente tiene su equity real ($10k iniciales seteables al crear la cuenta), su drawdown y su muerte a −20% sin contaminar a los demás.
3. **Fase 2 limpia:** "el agente validado pasa a dinero real" = apuntar SUS keys a `api.alpaca.markets`. Con sub-libros lógicos habría que desenredar la cuenta compartida primero.

Costo: 5 pares de env vars y un map `agent_id → cuenta` en Neon (columna `alpaca_account_label` en `agents`). Fallback si el dashboard limitara el número de cuentas paper: sub-libros lógicos sobre 1 cuenta con ledger en Neon — pero entonces **hay que prohibir señales opuestas simultáneas sobre el mismo símbolo** (guardrail extra) y el realismo de cash por agente se pierde. Es plan B, no plan A.

### 2.5 Qué pasa con `sim.js`

No se borra. Fase de **shadow mode** (primeras 2–3 semanas): el cron corre ambos caminos — simulador actual (persiste como hoy) + órdenes Alpaca en paralelo — y la reconciliación compara fills Alpaca vs fills Yahoo±0.10%. Cuando la divergencia esté caracterizada, Alpaca pasa a ser el camino que persiste y `sim.js` queda para backtesting/validación de edges (que es su otra vida actual vía signal-backtester). Además el simulador sigue siendo el motor de los edges cripto (sección 0.4).

---

## 3. Guardrails deterministas (fuera del LLM — y aquí ni siquiera hay LLM en el loop)

Módulo nuevo `api/_lib/guardrails.js`, JS puro, corre ANTES de cada POST de orden. Todos con test unitario (`tests/`). Orden de evaluación:

1. **Kill switch** — primero de todos. Flag en Neon (tabla `system_flags`, key `trading_halted`), NO env var (cambiar una env var en Vercel exige redeploy; un UPDATE en Neon es inmediato). Si está activo: no se manda nada, y además `DELETE /v2/orders` (cancela todo lo abierto) en cada cuenta. Se activa manualmente (SQL/endpoint admin) o automáticamente si el invariante de reconciliación falla 2 corridas seguidas.
2. **Mercado abierto / operable** — `GET /v2/clock` + calendar. Para la arquitectura A (decidir 22:30, llenar al open): el check no es "¿está abierto ahora?" sino "¿el próximo día hábil existe y no es feriado?" (calendar). Si el clock/calendar no responde → no se opera (fail closed).
3. **Limit-only** — el cliente no acepta `type != 'limit'`. Hardcodeado, sin config que lo desactive.
4. **Tope por orden** — `min(20% del equity del agente, HOUSE_MAX_ORDER_USD)` con `HOUSE_MAX_ORDER_USD = 2000` inicial (config en un solo lugar, junto a `ASSUMPTIONS`). Rechaza, no recorta silenciosamente: orden rechazada = evento de journal + alerta.
5. **Round-trips (ex-PDT)** — máx 3 round-trips por agente por 5 días hábiles, computado desde Neon (`positions` cerradas con `entry_date`/`exit_date`). Nota: FINRA retiró PDT en jun-2026 (sección 1); esto queda como regla de la casa contra el overtrading, renombrada como tal.
6. **Banda de precio** — `limit_price` dentro de ±5% del último cierre conocido (sanity check contra bugs de cálculo, aparte de la banda de ejecución de 0.5%).
7. **Idempotencia** — si ya existe orden con ese `client_order_id` en Neon, skip.

---

## 4. Alertas → WhatsApp (Railway)

Estado real: **greenfield en este repo** — no hay una línea de código de WhatsApp/Railway hoy. Lo que toca aquí, asumiendo que el servicio de Railway ya expone un webhook HTTP:

- `api/_lib/notify.js`: `notify(event)` → POST al webhook de Railway. Fire-and-forget con timeout corto (3s) y **nunca** bloquea ni tira la corrida (una alerta caída no puede impedir un trade ni una reconciliación).
- Env vars: `WHATSAPP_WEBHOOK_URL` + `WHATSAPP_WEBHOOK_TOKEN` (o el auth que use el servicio).
- Eventos v1: orden enviada · fill (símbolo, qty, `filled_avg_price`, agente) · orden expirada sin fill · orden rechazada por guardrail · kill switch activado · invariante de reconciliación roto · muerte de agente.
- **Dato faltante (bloqueante de esta sección, no del resto):** el contrato del servicio Railway — URL, método de auth y formato de payload que espera. Con eso, esta pieza es ~1 archivo + llamadas en los 2 crons.

---

## 5. Journal (patrón nof1): el porqué junto al trade

Hoy no existe: `positions` solo tiene `exit_reason` mecánico (`'stop'|'regla'|'muerte'`) y los razonamientos LLM del producto viven en localStorage o en respuestas HTTP no persistidas. Propuesta — la tabla `orders` nueva lleva el journal integrado (una decisión = una orden = un porqué, atómico):

```sql
create table if not exists orders (
  id text primary key,                 -- client_order_id determinista
  agent_id text not null references agents(id) on delete cascade,
  alpaca_order_id text,
  symbol text not null, side text not null, qty numeric not null,
  limit_price numeric not null,
  status text not null default 'pending_submit',  -- → submitted → filled|partial|expired|canceled|rejected_guardrail
  filled_avg_price numeric, filled_qty numeric, filled_at timestamptz,
  decided_at timestamptz not null,
  decision jsonb not null              -- ← el journal
);
```

`decision` (jsonb) captura el estado de la decisión EN el momento de decidir, no reconstruido después:

- **Edges de señales:** regla que disparó (config del edge), valores de los indicadores en la barra de decisión, cierre usado, equity/cash del agente, guardrails evaluados y su resultado.
- **Edges de pares:** z-score, α/β de la ventana OLS, spread, umbral cruzado.
- **Campo `narrative` opcional** reservado para cuando un agente LLM entre al loop (Fase 2+): ahí va prompt + respuesta, mismo esquema, sin migración.

La UI puede mostrar el journal en el detalle del agente ("por qué entró aquí") — es la parte nof1 visible: cada trade del leaderboard con su razonamiento auditable.

---

## 6. Env vars y smoke (el gate)

### Env vars nuevas (las agregas tú en Vercel cuando tengas la cuenta)

Con la recomendación de 5 cuentas (sección 2.4), la forma más limpia es **una env var JSON**, no 10 sueltas:

```
ALPACA_PAPER_ACCOUNTS = [{"label":"agent-1","key":"PK...","secret":"..."}, ...]   # 5 entradas
ALPACA_PAPER_BASE     = https://paper-api.alpaca.markets    # default en código; en Fase 2, api.alpaca.markets por cuenta validada
WHATSAPP_WEBHOOK_URL / WHATSAPP_WEBHOOK_TOKEN               # sección 4
```

Para el smoke inicial basta un solo par: `ALPACA_PAPER_KEY` + `ALPACA_PAPER_SECRET` (el smoke usa la primera credencial que encuentre; cuando existan las 5 cuentas, itera todas).

### Modo smoke: `GET /api/alpaca?smoke=1`

Endpoint nuevo `api/alpaca.js` (después será el cliente/salud del broker; no toca `agents-run`), mismo patrón que `api/vc-feed.js:416-448` / `api/stock-tracker.js` / `movers.js?smoke=market`, con `Cache-Control: no-store` y respuesta `{ smoke:true, results, generated_at }`. Pasos, cada uno con `ok/status/detail`:

1. `GET /v2/account` con los headers `APCA-*` → valida auth (esperado: `status:"ACTIVE"`).
2. `GET /v2/clock` y `GET /v2/calendar` (hoy±5 días) → valida los endpoints del guard de mercado.
3. `POST /v2/orders` — **orden límite imposible de llenar** (`buy 1 AAPL, limit_price: 1.00, tif: day`) → valida el path de escritura sin riesgo de fill.
4. `GET /v2/orders/{id}` → status `new`/`accepted`.
5. `DELETE /v2/orders/{id}` → cancelada; re-GET confirma `canceled`.
6. (informativo) headers de rate limit que devuelva la API.

Criterio de verde: los 5 pasos `ok:true` desde **producción Vercel** (no preview, si las env vars solo viven en prod). Verificado hoy que el sandbox de desarrollo no puede pegar a Alpaca (proxy 403) — el smoke en Vercel es el único gate real, como en vc-feed/stock-tracker.

---

## 7. Riesgos y decisiones abiertas

1. **Fills paper optimistas** (sin cola, sin liquidez, price improvement no modelado): sesgo conocido y documentado por Alpaca. Mitigación: decirlo en la UI (como hoy `ASSUMPTIONS`) y validar en shadow mode contra el simulador.
2. **Órdenes que expiran sin fill** (gap fuera de la banda de 0.5%): comportamiento deseado, pero cambia la semántica del agente — "decidió entrar" ya no implica "entró". La UI y el leaderboard deben distinguirlo (el journal lo registra).
3. **Cuenta única como plan B:** si Alpaca limitara las cuentas paper múltiples, el netting de shorts entre agentes obliga a un guardrail extra y pierde realismo de cash por agente. Confirmar número de cuentas posibles apenas exista la cuenta — **es la primera pregunta a resolver post-registro, antes del smoke**.
4. **Cripto fuera de v1:** edges cripto siguen en el simulador actual; migrarlos a Alpaca crypto (24/7, sin calendar, fee model propio) es fase aparte.
5. **Horario de invierno:** el cron de reconciliación y la banda de decisión asumen open 13:30 UTC (verano); el cambio a 14:30 UTC (nov) hay que resolverlo con calendar API, no con otro cron hardcodeado.
6. **Contrato del webhook Railway:** dato faltante para la sección 4 (no bloquea smoke ni arquitectura).
7. **Regulatorio:** PDT retirado (jun-2026) → el guard de round-trips es regla de la casa; el Intraday Margin Framework de Alpaca no nos afecta con TIF `day` y sin apalancamiento.

## 8. Orden de construcción propuesto (post-smoke-verde)

1. `api/alpaca.js` (cliente + smoke) — es el gate, va primero.
2. `api/_lib/guardrails.js` + tests.
3. Tabla `orders` (+ `system_flags`) en `db.js` `SCHEMA` + journal en el path de decisión.
4. Cron de reconciliación (`vercel.json` + endpoint) + invariantes.
5. Shadow mode en `agents-run` (Alpaca en paralelo al simulador, sin persistir como verdad).
6. `notify.js` (cuando exista el contrato Railway).
7. Switch: Alpaca pasa a ser la verdad; simulador queda para backtesting y cripto.
