# Alertas a Telegram

Un solo módulo manda: `api/_lib/alertas.js`. Un solo endpoint decide cuándo:
`/api/alertas`. Nada más en el repo le habla a `api.telegram.org` (lo exige
`tests/alertas.test.mjs`).

## Las cuatro

| Alerta | Cuándo se revisa | Se manda… | Clave de deduplicación |
|---|---|---|---|
| Saldo de OpenRouter bajo `$10` | vigía, cada 10 min | máximo **una vez por día** (día de Monterrey) | `saldo-openrouter:AAAA-MM-DD` |
| Un cron que falla | vigía, cada 10 min | **una vez por episodio**: no repite mientras siga roto; si se recupera y vuelve a fallar, avisa otra vez | `cron:<job>` (se archiva al recuperarse) |
| Una emisora se mueve más de 30% en 1D | vigía, cada 10 min | **una vez por emisora y cierre** | `movimiento:<us\|mx>:<símbolo>:<fecha>` |
| Resumen diario (La Liga + cobertura de Form 4) | `0 2 * * *` UTC = **20:00 en Monterrey** | **una vez por día** | `resumen:AAAA-MM-DD` |

Detalles que importan:

- **Cron que falla** = su último latido dijo `error`, o lleva más de
  `stale_after_h` sin latir (la misma lista `EXPECTED` de `/api/cron-status`).
  `disabled` y `skipped` no son fallas. Un cron que nunca latió no se alerta
  (recién agregado todavía no corrió); sigue en rojo en `/api/cron-status`.
- **1D** es el del mapa de `/mercado`: último cierre contra el cierre anterior,
  EE. UU. y BMV. Es al **cierre**, no intradía. Una serie atrasada o con un
  hueco de más de 5 días no cuenta: su "1D" no sería de un día.
- **Monterrey es UTC−6 todo el año** (México no cambia de horario desde 2022),
  así que `0 2 * * *` no hay que tocarlo en verano.
- **Sin repetir** es la tabla `alertas_enviadas`: antes de mandar se reclama la
  clave con un `insert … on conflict`. Si Telegram falla, la fila queda sin
  `enviada_at` y el siguiente tick reintenta.
- El saldo se lee directo de OpenRouter; una lectura fallida **no** es saldo
  bajo y no alerta.

## Variables de entorno (Vercel)

| Variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | obligatoria. Nunca sale en una respuesta ni en un error. |
| `TELEGRAM_CHAT_ID` | opcional. Si no está, se usa el que guardó `?job=chat-id` en la tabla `alertas_config`. Si está, gana. |
| `CRON_SECRET` / `ARENA_ADMIN_KEY` | la compuerta. Sin ninguna, `/api/alertas` contesta 503. |
| `ARENA_OPENROUTER_PISO_USD` | opcional, default `10`. |
| `ALERTA_MOVIMIENTO_PCT` | opcional, default `30`. |

## A mano

```bash
# qué hay configurado y las últimas 20 alertas (nunca muestra el token)
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/alertas?job=estado"

# una vez: tomar el chat_id de getUpdates y guardarlo (antes hay que escribirle al bot)
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/alertas?job=chat-id"

# mensaje de prueba
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/alertas?job=prueba"

# ver qué mandaría, sin mandar ni marcar nada
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/alertas?job=vigia&seco=1"
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/alertas?job=resumen&seco=1"
```

`?job=chat-id` sólo toma chats **privados**. Si le escribió más de una persona
al bot no adivina: pide `&usuario=<username o nombre>`. Telegram guarda los
mensajes de `getUpdates` 24 horas.

## Agregar una alerta nueva

Una función pura que devuelva `{ clave, tipo, texto }` en `api/_lib/alertas.js`
y una llamada a `enviarAlerta()`. La clave es lo que define "la misma alerta":
elegirla es decidir cada cuánto puede repetirse.
