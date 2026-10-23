# El Libro — la cuenta real de Lety, con las puertas del Arena

> **Futuro-yo:** esto NO es el Arena ni la flota de agentes. Es dinero real, una sola cuenta, sin LLM decidiendo nada. Si una orden sale de aquí, salió por `api/_lib/libro-alpaca.js` con `LIBRO_LIVE_ENABLED=true` y pasó por `validarOrdenes`. No hay otro camino.

## Qué es

Una pregunta: **¿las señales de mi radar me hacen ganar dinero a mí, más de lo que ganaría sin hacer nada?** Si sí, es producto y es renta. Si no, lo sé antes de venderlo.

El Libro hace tres cosas y nada más:

1. **Ejecuta solo estrategias con GO escrito**, detrás del mismo guard determinista del Arena. Las salidas de riesgo (stop catastrófico, breaker) corren **antes** que cualquier estrategia y no las decide nadie: son código.
2. **Lleva un ledger con la fecha real de envío** de cada orden (`libro_ordenes.enviada_at`), no la fecha de la decisión. Idempotente por `client_order_id = libro:{estrategia}:{fecha}:{SYM}:{side}`: un reintento del cron no duplica nada.
3. **Reporta tres números contra SPY** (`/api/libro-report?format=md`). Nada más arriba del pliegue.

## Las puertas (principios congelados)

| Puerta | Cómo está hecha | Dónde |
|---|---|---|
| **Dos cuentas, un modo** | `LIBRO_MODO` = `paper` (default) o `live`. Paper → host `paper-api`, keys `ALPACA_LIBRO_PAPER_KEY / SECRET` (una cuenta paper **propia** del Libro: ni la del Arena ni la del smoke de venta). Live → `api.alpaca.markets`, keys `ALPACA_LIVE_KEY / SECRET`. En paper el cliente ni siquiera lee las keys live, y al revés. El test verifica que ninguna llamada de la suite use las keys del Arena. | `_lib/libro-alpaca.js` |
| **Interruptor de envío** | `LIBRO_LIVE_ENABLED` — solo el string `'true'` permite que `createLimitOrder` mande. Ausente o cualquier otra cosa = **sombra**: calcula y journalea, el cliente se niega (lanza `LibroSombraError`). Aplica en los dos modos: en paper también se arranca en sombra. No existe `force`. | `_lib/libro-alpaca.js` |
| **Limit-only, day** | El cliente no expone `type`. Tampoco expone liquidación a mercado (`closeAllPositions` no existe aquí). | `_lib/libro-alpaca.js` |
| **Rieles** | 8 posiciones · 15 % del equity por posición · 10 % mínimo en cash · banda ±2 % sobre el último cierre · precio ≥ $5 · long-only · enteros · solo estrategia **activa** · tope propio de cada estrategia (`tamano_max_pct`). Violación = orden **descartada y journaleada**. Nunca ajustada. | `LIBRO_RULES`, `validarOrdenes` |
| **Salidas de riesgo** | Stop catastrófico 22 % por posición, breaker −15 % (delever pro-rata) / −20 % (liquida todo + halt). **Importadas** de `_lib/arena-exits.js` (reglas T2): mismo código, no una copia. | `salidasDeRiesgo` |
| **Kill switch** | `GET /api/libro?kill=1` cancela todas las órdenes abiertas y pone `LIBRO_HALT=1` en Neon. Con halt nada se manda. `?reanudar=1` lo apaga: decisión humana, no automática. | `kill`, `reanudar` |
| **Cero cambios a media temporada** | Una estrategia `activa` **no se edita** (`actualizarEstrategia` lanza). Se cierra con motivo (`cerrarEstrategia`) y, si hace falta, se abre otra con otro id. Activar exige `fecha_inicio` y `criterio_de_salida` escritos. | `_lib/libro.js` |

Los rieles son una **copia declarada** de `ARENA_RULES`, no un import: el Arena ajusta bandas por env var para experimentar; el Libro no experimenta con dinero real.

## Cómo entra una estrategia

```
candidata → paper → validada → activa → cerrada
```

1. **candidata**: existe la idea, está en `docs/libro-cola.md`. No está en la tabla.
2. **paper**: tiene backtest pre-registrado con criterios escritos **antes** de ver datos, y dio GO (o GO FRÁGIL con nota). Corre 4 semanas en paper de Alpaca.
3. **validada**: el paper no la contradijo. Entra a la tabla con `fuente_del_go` (ruta al doc/PR), `horizonte_meses` (default 6), `tamano_max_pct` y `criterio_de_salida` escritos.
4. **activa**: Lety cambia el estado a mano, con `fecha_inicio`. Desde ese momento la fila es de solo lectura. Opera chica.
5. **cerrada**: por su propio `criterio_de_salida`, por el horizonte, o por decisión escrita. Nunca "porque subió mucho" ni "porque me asusté" — para eso están los breakers.

Estados posibles: `candidata`, `paper`, `validada`, `activa`, `cerrada`. Un NO-GO no entra nunca; la cola lo registra con acta y se cierra.

## Cómo se lee el reporte

`GET /api/libro-report?format=md` (con `ADMIN_SECRET`). Tres números:

1. **¿Le gané al piso?** = retorno del libro − retorno de SPY, mismo periodo. SPY se calcula como en `/liga`: al abrir el libro se guardan `spy_unidades = equity_inicial / SPY` y desde ahí la línea SPY es unidades × precio. **Dividendos no contados** (el reporte lo dice). Negativo = el radar estorba.
2. **¿Cuánto me asusté?** = peor caída desde un máximo (max drawdown), en % y en días seguidos bajo el agua. Si no la aguantas, el retorno no importa.
3. **¿Fue suerte?** = percentil del retorno medio por operación contra **1,000 libros al azar** con el mismo número de operaciones, los mismos símbolos elegibles, fechas de entrada al azar, la misma duración de tenencia y los mismos costos (10 bp por lado). Determinista (RNG con semilla). **Percentil 40–60 = "indistinguible de suerte"**, con esas palabras. Con 0 operaciones cerradas dice "no aplica" — no hay nada que distinguir.

Debajo: tabla por estrategia (ops, acierto, retorno neto, días activa, criterio de salida). Con 0 operaciones el reporte dice **"0 operaciones · libro = cash"** y el retorno de SPY del periodo. Eso es un reporte honesto, no un error.

Juzgar a **6 meses mínimo**. La inconsistencia a medio camino es el dato, no una razón para mover (misma regla que el Arena).

## Endpoints

| Llamada | Quién | Qué hace |
|---|---|---|
| `GET /api/libro` | público | salud: cuenta (paper/live), hay keys, envío (SOMBRA/ENCENDIDO), halt, rieles. No filtra secretos. |
| `GET /api/libro?smoke=1` | ADMIN | auth (cuenta del modo) · clock · calendar · orden límite **imposible** (AAPL @ $1) · lookup · cancel. En sombra la pata de escritura reporta `sombra:true`, no error. Verde = 6/6. |
| `GET /api/libro?sembrar=1` | ADMIN | crea tablas + siembra `spy_piso` y `tsla_bollinger`. Idempotente. |
| `GET /api/libro?abrir=1` | ADMIN | abre el benchmark **una sola vez** (`spy_unidades`, `equity_inicial`). Si ya estaba, lo dice y no lo pisa. |
| `GET /api/libro?kill=1&motivo=...` | ADMIN | cancela todo + halt. |
| `GET /api/libro?reanudar=1` | ADMIN | halt 0. |
| `GET /api/libro?equity=1` | CRON / ADMIN | foto diaria → `libro_equity_diario`. Cron `5 21 * * 1-5`, latido `libro:equity`. |
| `GET /api/libro-report?format=md` | ADMIN | el reporte. |

ADMIN = `Authorization: Bearer <ADMIN_SECRET>`, header `x-admin-key`, o `?secret=`. Fallback `CRON_SECRET`. Sin secret configurado → 401 siempre.

## Tablas (Neon)

- `libro_estrategias(id, nombre, estado, fuente_del_go, fecha_inicio, horizonte_meses, tamano_max_pct, criterio_de_salida, notas, created_at, cerrada_at, motivo_cierre)`
- `libro_ordenes(client_order_id PK, enviada_at, estrategia_id, symbol, side, qty, limit_price, referencia, estado, alpaca_order_id, fill_price, fill_ts, motivo, origen, sombra)`
- `libro_equity_diario(fecha PK, equity, cash, spy_close, posiciones, tomado_at)`
- `libro_estado(key PK, valor)` — `LIBRO_HALT`, `spy_unidades`, `equity_inicial`, `spy_entry`, `abierto_at`.

## Fase 1 — primera estrategia (NO está en este PR)

Adaptador `tsla_bollinger` que cumpla la interfaz de `ADAPTADORES` en `_lib/libro.js`:

```
decidir({ estrategia, closes, positions, equity, cash, today })
  → [{ estrategia_id, symbol, side, qty, limit_price, motivo }]
```

- Lee la **misma regla** del edge "tesla bollingerr" de la flota (`api/_lib/sim.js` + tabla `edges`), no una reimplementación.
- Cron nocturno propio (`/api/libro?decide=1`, después del cierre): salidas de riesgo → adaptador → `validarOrdenes` → `createLimitOrder` (límite en banda para el open siguiente) → `registrarOrden` con `enviada_at` real. Reconcile a las 14:40 UTC copia fills a `libro_ordenes` (Neon = fuente de verdad del producto, Alpaca = fills).
- Se enciende solo cuando Lety ponga `estado='activa'` + `fecha_inicio` en la fila **y** `LIBRO_LIVE_ENABLED=true`. Hasta entonces, todo lo anterior corre en sombra y se journalea.
- Tamaño: `tamano_max_pct = 10`. Etiqueta honesta: "VENTAJA REAL a 2 años, FRÁGIL a 5". Criterio de salida: dos meses seguidos por debajo de SPY, o drawdown propio > 15 %.

## Secuencia: primero PAPER, después LIVE

El Libro arranca en **paper** (es el default: sin `LIBRO_MODO` es paper). Live se prende cuando el paper lleve 4 semanas limpias con la primera estrategia. Las tablas de Neon son las mismas en los dos modos; cada orden guarda `sombra` y el reporte dice en qué cuenta corrió.

### Paso A — cuenta paper propia del Libro (hoy)

```
# 1) Alpaca → el login que tenga espacio (son 3 paper por login) → crear una
#    cuenta PAPER nueva y nombrarla "LIBRO". No reutilizar la del Arena ni la
#    del smoke de venta: un libro que comparte cuenta con la liga no mide nada.
#    Generar keys de ESA cuenta → guardarlas en tus notas.
# 2) Vercel → Settings → Environment Variables (Production):
#    ALPACA_LIBRO_PAPER_KEY, ALPACA_LIBRO_PAPER_SECRET
#    (NO poner LIBRO_MODO ni LIBRO_LIVE_ENABLED todavía)
# 3) Redeploy. Luego, desde una terminal (S = tu ADMIN_SECRET):
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro"
#    esperado: cuenta:"paper", keys:true, envio:"SOMBRA"
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro?sembrar=1"
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro?smoke=1"
#    esperado: ok:true, modo:"paper", live:false, limit_order.sombra:true
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro?abrir=1"
#    esperado: ya_estaba:false, spy_unidades = equity_paper / SPY
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro?equity=1"
curl -s -H "Authorization: Bearer $S" "https://quantdesk2.vercel.app/api/libro-report?format=md"
#    esperado: "Cuenta: PAPER · envío: SOMBRA" y "0 operaciones · libro = cash"
# 4) Encender el envío EN PAPER (aquí sí, es paper):
#    LIBRO_LIVE_ENABLED=true → redeploy → ?smoke=1 → 6/6 sin sombra
#    (la orden imposible AAPL @ $1 se manda y se cancela en la cuenta paper).
```

### Paso B — live (cuando el paper lleve 4 semanas limpias)

```
# 1) KYC de Alpaca live terminado, cuenta fondeada, keys live en tus notas.
# 2) Vercel: ALPACA_LIVE_KEY, ALPACA_LIVE_SECRET; QUITAR LIBRO_LIVE_ENABLED.
# 3) LIBRO_MODO=live → redeploy → /api/libro (cuenta:"live", envio:"SOMBRA")
#    → ?smoke=1 (sombra) → ?abrir=1 → ?equity=1 → report.
#    El benchmark se reabre: `spy_unidades` ya existe de paper. Antes de abrir
#    en live, borrar las filas de libro_estado (spy_unidades, equity_inicial,
#    spy_entry, abierto_at) y libro_equity_diario — el paper fue ensayo, el
#    reloj de los 6 meses arranca con dinero real.
# 4) Solo entonces LIBRO_LIVE_ENABLED=true.
```

Nota de Vercel: `api/libro.js` y `api/libro-report.js` **no** llevan entrada propia en `functions` de `vercel.json` — el glob `api/*.js` ya les da 60 s, y una entrada específica después del glob rompe el build (`unused_function`, visto en el deploy de #280).

## Tests

`node tests/libro.test.mjs` — interruptor, limit-only, credenciales, rieles uno por uno, salidas de riesgo importadas, kill, no-edición de activa, métricas, suerte determinista, reporte honesto con 0 ops, gates 401, y una aserción global: **ninguna llamada de la suite usó las keys del Arena**.
