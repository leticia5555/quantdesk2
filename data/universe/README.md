# data/universe — el ESCALÓN 3 del universo (arranque en frío)

`constituents.js` está **vacío a propósito y no hace falta llenarlo**.

> **Era un par de `.json` y eso tumbó producción (2026-09-15).** Se leían del
> disco con `new URL(..., import.meta.url)`, y como este repo no tiene
> `package.json`, un `.js` de `/api` no es un módulo ESM para el runtime de
> Vercel: el código se transpila a CommonJS, e `import.meta` es lo único de ESM
> que no tiene traducción. `SyntaxError: Cannot use 'import.meta' outside a
> module`, al **importar** el módulo — o sea que se llevaba puesto a todo el que
> dependiera de él. Ahora es un módulo que se importa estáticamente: el bundler
> lo incluye por definición y funciona igual en ESM y en CJS.

El universo del Arena (B1) tiene tres fuentes, en este orden:

1. **FMP** — la composición fresca de los índices, con refresco semanal.
2. **Neon** — `arena_universe`, clave `constituents:<índice>`. Se escribe **sola**,
   en el mismo paso en que la lista se baja de FMP. Sobrevive a un deploy, a una
   caída de FMP y al reinicio de la lambda.
3. **`constituents.js`** — solo si Neon está vacío **y** FMP está caído el
   mismo día.

O sea: el escalón 3 existe para un caso que requiere que las otras dos fallen a
la vez. Con cualquiera de las dos viva, esta lista no se lee nunca. Un seed
vacío **no cuenta como respaldo** (`readStatic` devuelve `null`), así que estar
vacío es inofensivo por construcción, no por suerte.

## Si algún día querés congelar un snapshot acá

Es opcional y nada depende de ello:

    GET /api/arena-universe?emit=1

devuelve los constituyentes en este mismo formato. Pero la persistencia **ya
ocurrió** cuando la lista se bajó: mirá `indices[].persisted` en la respuesta.

## Formato

```js
export const CONSTITUENTS = {
  sp500:     { index: 'sp500',     source: 'fmp', built_at: '2026-09-15T13:00:00.000Z', symbols: ['AAPL', 'ABBV'] },
  nasdaq100: { index: 'nasdaq100', source: 'seed', built_at: null, symbols: [] },
};
```

`symbols` es lo único que se lee. Una entrada con `symbols: []` se ignora.

## Survivorship bias

La composición es la de **hoy**. No existe un endpoint gratis y confiable de
"constituyentes del S&P 500 en tal fecha", así que un backtest sobre esta lista
lo arrastra. El `caveat` viaja con el dato en cada corrida, no solo acá.
