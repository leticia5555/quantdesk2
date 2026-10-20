# Borrador — «¿la comprarías hoy si no la tuvieras?»

**Estado: BORRADOR. NO ACTIVADO.** `api/arena-run.js` no se tocó en la rama.
Cambiar el prompt a mitad de la preparación de temporada se decide con Lety.

## Qué cambia

Una línea en `buildTargetSystemPrompt` (`api/arena-run.js`), en el bloque de
salida, justo después del recordatorio de "lo que no nombrás, se vende". Obliga
a que cada posición existente se justifique como una compra nueva, no como "la
tengo, la mantengo". Se apoya en un campo que ya existe
(`positions_review[].reason`), así que **no cambia el formato** ni los parsers.

```diff
diff --git a/api/arena-run.js b/api/arena-run.js
index 04f9660..f5e3776 100644
--- a/api/arena-run.js
+++ b/api/arena-run.js
@@ -428,6 +428,7 @@ OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no pr
 
 ⚠️ \`pesos\` MUST BE PRESENT even when empty. \`{}\` means "liquidate everything, go to cash" — a real and sometimes correct decision. Omitting the field entirely is not that; it is a malformed answer and the run is aborted with nothing placed.
 ⚠️ Once more, because it decides your whole book: ANY TICKER YOU HOLD AND DO NOT LIST IN \`pesos\` WILL BE SOLD. Restate everything you want to keep.
+⚠️ EVERY POSITION YOU ALREADY HOLD MUST BE JUSTIFIED AS A NEW BUY: would you buy it TODAY, at this weight, if you did not own it? If not, trim it or exit it. "I already hold it" is not a reason, and neither is your entry price — the \`reason\` of a "hold" in \`positions_review\` is the case for buying it today.
 Trading more is not the objective. Stating explicitly what you want to hold, and why, is.`;
 }
 
```

Para aplicarlo: guardar el bloque de arriba como `prompt.diff` y
`git apply prompt.diff`.

## Lo que se verificó sin activarlo

- Con la línea aplicada, la suite completa queda **161 verdes / 0 rojas**
  (se aplicó en el árbol de trabajo, se corrió la suite y se revirtió; el
  commit no la trae).
- Agrega **~77 tokens** (308 caracteres) al system prompt de los siete.

## Lo que hay que decidir al activarlo

1. **Es un cambio del experimento.** `prompt_hash` cambia solo (sale del
   texto). `PROMPT_VERSION` (`arena-pm-v3-<temporada>`) NO cambia solo:
   decidir si se sube `PROMPT_FLUJO` a `arena-pm-v4` para que el post-mortem
   agrupe por versión sin depender del hash.
2. **Una fila `rules_changed` en el journal** con la fecha, como se hizo con
   los cortos el 2026-09-18: un libro con esta regla no es el mismo
   experimento que uno sin ella.
3. **El prefijo cacheado se invalida una vez**: el system prompt es parte del
   prefijo; la primera corrida de cada agente después del cambio paga la
   escritura de caché.
4. **Los siete a la vez**, nunca uno: una regla que tiene uno solo es una
   ventaja, no un riel.

## Cómo medir si sirvió

`/api/liga/libros` ya publica, por corrida, `razonamiento.posiciones[].movimiento`
(`se mantiene` / `sube` / `baja` / `sale`) y `razonamiento.sin_consulta_propia`.
Comparar antes y después: la proporción de posiciones `se mantiene` con
`sin_consulta_propia`, y cuántas `sale` por corrida. Si la regla funciona, las
posiciones heredadas que nadie re-investigó deberían bajar.
