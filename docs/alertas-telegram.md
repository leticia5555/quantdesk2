# Alertas de Telegram

QuantDesk le manda a Lety alertas del mercado por Telegram. Horas de
**Monterrey**, sólo los días en que abre el mercado de EE.UU., en español
sencillo y cada una con su link a QuantDesk.

## Las alertas

| Alerta | Cuándo | Qué dice |
|---|---|---|
| **Mañana** | 8:00 | Futuros del S&P 500 y el Nasdaq, a qué hora abre el mercado, y lo que hay hoy en el calendario: Fed, inflación, empleo y reportes de empresas grandes. |
| **Cierre** | 15:15 | Cómo cerraron el S&P 500 y el Nasdaq, las 3 que más subieron y las 3 que más bajaron, y el mejor y el peor sector. |
| **Mis acciones** | cada 10 min, 6:00–17:50 | SPCX, NVDA, SMMT y ANT: si alguna se mueve más de 5% en el día, si sale una noticia o un aviso oficial de la empresa, o si un insider compra o vende. |
| **Víspera** | 15:30 del día hábil anterior | Aviso corto antes de la decisión de la Fed, del dato de inflación o del reporte de empleo: qué es y por qué importa. |

## Las tres reglas

1. **Nunca la misma alerta dos veces.** Cada alerta tiene una clave estable
   (`cierre:2026-12-01`, `mov:NVDA:2026-12-01:sube`, `insider:<accession>:venta`…)
   que se aparta en la tabla `alertas_enviadas` *antes* de mandar. Si el envío
   falla, la fila queda marcada `fallo` y la siguiente corrida lo vuelve a intentar.
2. **Nada de mensajes vacíos.** Sin datos no hay mensaje, y una sección sin
   datos se omite. Ningún texto dice "no hay nada".
3. **Cada mensaje con link** a la página de QuantDesk donde se ve más.

## Cómo está armado

| Archivo | Qué hace |
|---|---|
| `api/_lib/telegram.js` | **El único módulo que le habla a Telegram.** `mandaMensaje(texto)`, el chat_id y el cuidado del token. |
| `api/_lib/alertas.js` | Qué dice cada alerta. Puro: entran datos, sale el texto (o `null`). |
| `api/_lib/alertas-fuentes.js` | De dónde sale cada dato. |
| `api/alertas.js` | El endpoint: los jobs, el candado de repetidos y la muestra. |

### De dónde sale cada dato

- **Futuros e índices:** Yahoo, el mismo quote que la cinta (`/api/tape`).
- **Si hoy abre el mercado, y a qué hora:** el calendario de Alpaca. Un feriado
  no se adivina.
- **Cierres, sectores y el 5%:** snapshots de Alpaca, con la *fecha* de la barra.
- **Calendario macro:** `macro_events` (lo curado a mano) + las fechas oficiales
  de la Fed y el BLS (`_lib/macro-oficial.js`).
- **Reportes:** `/api/earnings?mega=1`.
- **Insiders:** `mercado_form4_tx`, los Form 4 que ya baja `stock-tracker`. Sólo
  compras y ventas en el mercado (no otorgamientos ni ejercicios de opciones).
  El aviso llega cuando la SEC publica el Form 4, que puede ser hasta dos días
  hábiles después de la operación.
- **Noticias:** `mercado_noticias`, los titulares de las fuentes de QuantDesk
  que nombran a la empresa. El titular va tal como lo publicó el medio.
- **Avisos oficiales:** los 8-K de la SEC, que es el aviso que una empresa está
  obligada a presentar cuando pasa algo relevante. Se dicen en español según la
  sección del aviso (resultados, cambio de directivos, acuerdo importante…).

### "Sólo emisoras con datos al día"

Para el top 3 del cierre una emisora entra **sólo si su barra diaria es de la
sesión de hoy**. Una emisora suspendida o deslistada trae la barra de su último
día de operación (PSKY traía la de un mes atrás) y su "cambio" compara dos
cierres viejos: no es un movimiento de hoy. Esas se cuentan aparte
(`medicion.atrasadas` en la respuesta del job) y no entran a la lista.

El top 3 sale de las empresas con capitalización de **US$10 mil millones o más**
del universo de QuantDesk. El piso existe porque el universo también trae las
"movidas del día", que son acciones chicas que suben 40% con poco volumen.

### Horarios

Monterrey no cambia de horario; Nueva York sí. De noviembre a marzo el mercado
abre 8:30 y cierra 15:00 de Monterrey. **De marzo a noviembre abre 7:30 y cierra
14:00**, así que en esos meses el mensaje de las 8:00 llega con el mercado ya
abierto (el mensaje lo dice) y el del cierre llega una hora y cuarto después.

## Configuración

| Variable | Dónde | Para qué |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel | El token del bot. **Nunca se imprime**: ni en logs ni en respuestas. |
| `TELEGRAM_CHAT_ID` | Vercel (opcional) o Neon | A quién se le manda. Si no está en Vercel se lee de `alertas_config`, donde lo deja `?job=chat-id`. |
| `ALERTAS_ENABLED` | Vercel (opcional) | `0` apaga las cuatro alertas sin deploy. |

Todo pide `x-admin-key: <ARENA_ADMIN_KEY>` (o `?key=`); los crons de Vercel
entran con `CRON_SECRET`.

```bash
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "https://quantdesk2.vercel.app/api/alertas?job=estado"
```

```bash
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "https://quantdesk2.vercel.app/api/alertas?job=chat-id"
```

```bash
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "https://quantdesk2.vercel.app/api/alertas?job=muestra"
```

- `?job=chat-id` saca el chat con `getUpdates` y lo guarda. Telegram sólo
  conserva los mensajes de las últimas 24 horas: si salió vacío, escríbele algo
  al bot y vuelve a correrlo. Si le escribió más de una persona no adivina:
  devuelve la lista y se guarda con `&chat_id=<el tuyo>`.
- `?job=muestra` manda un ejemplo de cada alerta. Cada uno dice arriba si los
  datos son reales o inventados para enseñar el formato, y no cuenta para el
  candado de repetidos. `&tipo=manana|cierre|acciones|vispera` manda una sola.

## Cambiar las acciones

Están en `MIS_ACCIONES`, en `api/_lib/alertas.js`. El umbral del movimiento es
`UMBRAL_MOVIMIENTO_PCT`.
