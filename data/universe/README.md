# Respaldo estático de los constituyentes (B1 · D1)

Los dos JSON de esta carpeta son **el último recurso** del universo del Arena,
no su fuente. El orden de resolución es siempre el mismo (ver
`api/_lib/arena-universe.js`):

```
1. FMP        (fresco, refresco SEMANAL)
2. Neon       (el último bueno que se bajó — sobrevive a un deploy)
3. este JSON  (arranque en frío: Neon vacío y FMP caído el mismo día)
```

**Nunca bloquean el tablero.** Si los tres fallan, el universo se arma solo con
los movers/most-actives del día y el journal lo dice
(`universe_source: 'movers_only'`). Un universo más chico es un sesgo
declarado; un tablero que no sale es una corrida perdida.

## Por qué arrancan vacíos

Se generan corriendo el refresco contra FMP —no se escriben a mano— y el
entorno donde se escribió este código **no tiene salida a
financialmodelingprep.com** (la política de red del proyecto la deniega con
403). Una lista de 500 tickers escrita de memoria estaría desactualizada de
formas que nadie puede auditar y corrompería el universo en silencio, que es
peor que estar vacía: vacía se ve, y el código ya sabe qué hacer con eso
(`source: 'seed'` → se salta al siguiente escalón).

## Cómo llenarlos

Con `FMP_API_KEY` puesta en Vercel:

```bash
curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" \
  "$BASE/api/arena-universe?refresh=1&emit=1" > /tmp/u.json

jq '.constituents.sp500'     /tmp/u.json > data/universe/sp500.json
jq '.constituents.nasdaq100' /tmp/u.json > data/universe/nasdaq100.json
git add data/universe && git commit -m "Universo: snapshot de constituyentes"
```

`emit=1` devuelve el contenido **ya en el formato de estos archivos**, para
copiar y pegar sin editar nada a mano.

## Survivorship bias — dicho, no disimulado

Esto **no es point-in-time de verdad**. Una lista de hoy aplicada a la sesión
de ayer arrastra survivorship bias: las empresas que salieron del índice ya no
están. No hay endpoint gratis y confiable de "constituyentes del S&P 500 en tal
fecha", así que se declara en vez de fingir lo contrario. El journal lleva
`built_at` y `source` en cada corrida para que el post-mortem sepa con qué
lista se operó.
