# data/universe — el ESCALÓN 3 del universo (arranque en frío)

Estos archivos están **vacíos a propósito y no hace falta llenarlos**.

El universo del Arena (B1) tiene tres fuentes, en este orden:

1. **FMP** — la composición fresca de los índices, con refresco semanal.
2. **Neon** — `arena_universe`, clave `constituents:<índice>`. Se escribe **sola**,
   en el mismo paso en que la lista se baja de FMP. Sobrevive a un deploy, a una
   caída de FMP y al reinicio de la lambda.
3. **Este directorio** — solo si Neon está vacío **y** FMP está caído el mismo
   día.

O sea: el escalón 3 existe para un caso que requiere que las otras dos fallen a
la vez. Con cualquiera de las dos viva, estos archivos no se leen nunca. Un seed
vacío **no cuenta como respaldo** (`readStatic` devuelve `null`), así que estar
vacío es inofensivo por construcción, no por suerte.

## Si algún día querés congelar un snapshot acá

Es opcional y nada depende de ello:

    GET /api/arena-universe?emit=1

devuelve los constituyentes en este mismo formato. Pero la persistencia **ya
ocurrió** cuando la lista se bajó: mirá `indices[].persisted` en la respuesta.

## Formato

```json
{
  "index": "sp500",
  "source": "fmp",
  "built_at": "2026-09-15T13:00:00.000Z",
  "symbols": ["AAPL", "ABBV", "..."]
}
```

`symbols` es lo único que se lee. Un archivo con `symbols: []` se ignora.

## Survivorship bias

La composición es la de **hoy**. No existe un endpoint gratis y confiable de
"constituyentes del S&P 500 en tal fecha", así que un backtest sobre esta lista
lo arrastra. El `caveat` viaja con el dato en cada corrida, no solo acá.
