# Ticket — `/api/arena` corre a 60s sin un techo propio

**Estado: ABIERTO.** Esta rama solo agrega la medición. No toca `vercel.json`
ni cambia lo que hace el endpoint.

## Motivo

`api/arena.js` (la tarjeta del Agente #6 en `/app` y el respaldo de `/hoy`)
no tiene patrón propio en `vercel.json`: cae en el comodín `api/*.js` de
**60s**. `tests/vercel-functions.test.mjs` lo dice: "va al comodín de 60s a
propósito". Pero ese número no sale de ninguna medida, y hoy es el **único**
techo que tiene el endpoint:

1. **Ni Neon ni Alpaca tienen timeout.** `neonFetch` (`_lib/db.js`) y
   `alpacaFetch` (`_lib/alpaca.js`) hacen `fetch` sin `AbortSignal`. Si
   cualquiera de los dos se cuelga, la función espera hasta que Vercel la
   mata a los 60s. El código ya tiene la respuesta honesta para
   "Alpaca no contestó" (`alpaca_error`), pero nunca llega a usarla en un
   cuelgue: la mata el reloj antes.
2. **Escribe en cada lambda fría.** Llama a `ensureSchema()`: un lote de
   **32 sentencias DDL** (`create table/index if not exists`, `alter`) en el
   primer request de cada instancia. Es un endpoint de lectura; `/api/liga/libros`
   tiene escrita la regla contraria ("NO llama a ensureSchema(): hace
   CREATE/ALTER").
3. **Los tres tramos van en serie.** DDL → 2 SELECT → 2 llamadas a Alpaca.
   Alpaca no depende de la base, y espera a que termine.

## Lo que se midió (estructura, sin red)

`node scripts/arena-js-medir.mjs` corre el handler real con la red simulada.
Con latencias **supuestas** de Neon 60 ms, DDL 900 ms y Alpaca 250 ms:

| | llamadas | total |
|---|---|---|
| lambda **fría** | 1 lote DDL (32 sentencias) → 2 SELECT ∥ → 2 Alpaca ∥ | 1.215 ms = 902 + 61 + 251 |
| lambda **caliente** | 2 SELECT ∥ → 2 Alpaca ∥ | 311 ms = 61 + 250 |

El total es la **suma** de los tramos (la prueba
`tests/arena-js-tiempos.test.mjs` lo fija). Eso es estructura, **no** el
tiempo de verdad: las latencias son supuestas.

## Lo que falta medir — **requiere producción**

Cada respuesta trae ahora `tiempos_ms` (`schema`, `journal`, `alpaca`,
`total`) y la cabecera `Server-Timing`. Después de desplegar esta rama:

```bash
node scripts/arena-js-medir.mjs --url https://quantdesk2.vercel.app/api/arena --n 20
```

Salta el CDN (`?_m=<azar>`; la respuesta tiene `s-maxage=60` y sin eso se
mediría la caché) y devuelve p50/p95/máx del cliente y de la función, más el
peor `schema_ms` (lambda fría).

## Propuesta (no implementada)

1. Timeouts propios en las dos lecturas: `AbortSignal.timeout(8000)` en Neon
   y en Alpaca **para este endpoint** (no en el cliente compartido, que usa
   el camino que decide).
2. Sacar `ensureSchema()` de la lectura, como en `/api/liga/libros`.
3. Alpaca en paralelo con la base (`Promise.all` de los dos bloques).
4. Con el p95 medido en mano, un patrón propio en `vercel.json`
   (`api/arena.js`, encima del comodín) con un techo de ~3× el p95, en vez de
   heredar 60s. **Esto toca `vercel.json`, que va aparte.**
