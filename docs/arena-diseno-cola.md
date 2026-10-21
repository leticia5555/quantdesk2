# Arena — cola de diseño (para discutir DESPUÉS de abrir)

Lo que se vio corriendo y no se toca antes de la apertura. Cada entrada dice
qué se vio, por qué importa y qué habría que decidir. Nada de esto está
implementado.

---

## 1. El pre-filtro diario sobre el mercado completo

**Qué se vio.** Lety: "¿por qué siempre ADBE y LULU?". Rallies le pasa al
modelo "unas pocas operaciones potenciales" que salen de un embudo previo
(extremos técnicos + flujo de opciones + fundamentales + catalizadores
cercanos); nof1 usa 7 acciones fijas.

**Lo que ya tenemos.** Los siete ven el MISMO tablero (~130 extremos de un
universo de ~570: S&P 500 + Nasdaq 100 + hasta 50 del día). Desde la puerta en
vivo (`abrirPuertaEnVivo`), los del día son los de HOY y no los de ayer.

**La propuesta.** Un pre-filtro nuestro, diario, sobre el mercado completo, que
entregue a los siete la misma lista de 20–30 "interesantes hoy": top movers
arriba y abajo, volumen inusual, reportan esta semana. Igual para todos =
sigue siendo comparable.

**A decidir.** Si reemplaza al tablero o se suma; de dónde sale "el mercado
completo" (hoy la base son dos índices); cómo se mide si cambió algo (¿bajó la
repetición de nombres entre corridas?).

## 2. Una posición sin tesis no es una tesis: "¿la comprarías hoy?"

**Qué se vio (2026-10-20).** DeepSeek con FICO al 20%. La tesis publicada:
*"core holding, just less of it"*. No dice por qué FICO, dice que ya estaba.
Es inercia, no una decisión.

**Por qué importa.** El contrato es de portafolio OBJETIVO: cada corrida
declara el libro entero. Un peso que se sostiene solo por estar ya en el libro
es un sesgo de dotación, y además hace que el agente "decida" menos de lo que
parece — su retorno pasa a medir la herencia de otra corrida.

**APROBADO (2026-10-20), en este orden:**

1. **Primero medir.** Un marcador **sin tesis** en /liga para las posiciones
   cuya tesis sólo habla de la tenencia ("core", "keep", "less of it"). Mide
   la inercia ANTES de tocar el prompt, y dice si es un agente o son todos.
2. **Después, con ese dato,** el cambio de prompt: por cada posición, *"si hoy
   no la tuvieras, ¿la comprarías a este peso?"*.

## 3. La quinta herramienta: `historia(ticker)`

**La idea.** Los agentes no pueden leer filings. HISTORIA ya lee EDGAR (8-K,
10-K/10-Q, company facts) y tiene una narración guardada por ticker.

**Lo que costaría, con lo que hay hoy en el código:**

- **La llamada en sí: casi cero.** `/api/historia` es SOLO lectura de Neon:
  no ingiere al vuelo ni narra al vuelo. La narración (Opus) se paga una vez
  por ticker y se reusa mientras no cambie la evidencia (hash de evidencia +
  versión del prompt + modelo). Una herramienta que lea eso no llama a ningún
  modelo ni a EDGAR.
- **Lo caro es la cobertura.** La ingesta mide ~42 s y ~16 llamadas a EDGAR
  por ticker (`docs/historia-fase0.md`), y `historia-harvest` todavía NO tiene
  cron: sólo existe lo que se sembró a mano. Para cubrir el universo del Arena
  (~570) son ~6.6 horas de goteo, más una narración de Opus por ticker. Sin
  eso, la herramienta contestaría `sin_ingesta` para casi todo — y una
  herramienta que casi siempre dice "no tengo" enseña al modelo a no llamarla.
- **El peso en el contexto.** La narración completa no entra en una vuelta
  del loop sin compactar; habría que definir un resumen acotado (como hace
  `ficha` con sus líneas) y medir sus tokens con `?evidencia=1` antes.
- **Point-in-time.** La narración se arma con los filings a la fecha de
  ingesta. En vivo está bien; para replay hay que guardar qué versión vio el
  agente (el journal ya guarda el resultado completo de cada herramienta).

**APROBADO (2026-10-20): sembrar sólo lo del tablero (~130), no el universo.**

**Sigue a decidir.** Si la narración es la de Opus o un resumen más corto
hecho para la herramienta; y el criterio de éxito: ¿cambia alguna decisión, o
sólo agrega texto a las tesis?

## 4. El presupuesto de herramientas recorta justo lo nuevo

**Qué se vio (2026-10-20, puerta en sombra).** Grok gastó sus 20 llamadas
revisando lo que ya tenía, y los intentos 21-24 se negaron por presupuesto:
`screener(near_52w_high, limit=25)`, `ficha MU`, `ficha WDC`, `ficha STX`. Eso
era EXPLORACIÓN — un screener de máximos y tres nombres que no tiene. ChatGPT
también topó 20 ese día. (Leídos como `rows: null` parecían fallas; eran
rechazos. /liga ahora los dice "rechazada: presupuesto".)

**Por qué importa.** El tope limita a los dos agentes que más investigan, y lo
que les recorta es lo nuevo, no lo que ya tienen. Un techo que castiga la
exploración empuja a todos hacia sus tenencias — la misma inercia de la
entrada 2, por otro camino.

**Opciones a discutir:**
- subir el tope;
- que las fichas de posiciones PROPIAS no cuenten contra él: el agente ya
  tiene `pesos_actuales`, y desde el 2026-10-20 la ficha de una posición
  propia le da su precio de Alpaca aunque no esté en el tablero.

**Dato a juntar antes:** por agente, qué fracción de las llamadas fue a
nombres que ya tenía, y cuántas corridas toparon el cupo.

## 5. Un cierre cortado que el reintento rescató no queda registrado

**Qué se vio (2026-10-21, al contar el corte del cierre en
`puerta_por_corrida`).** El corte de nuestro reloj en el CIERRE se cuenta desde
`context.llm_error.cuerpos_vacios` (`vuelta: 'cierre'`, `timeout_nuestro`).
Pero `llm_error` sólo se escribe en el camino de ABORTO de `arena-shadow`. Si
el primer intento del cierre muere por nuestro reloj y el reintento lo
rescata, la corrida termina `ok_target` y ese corte no queda en ningún lado:
`ctx.cierre` (el `cierre_diagnostico`) guarda los intentos sin decir si el
vacío fue por nuestro reloj, y `cuerpos_vacios` no viaja en `ctx.tools`.

**Por qué importa.** `cortes.cierre` sale `cortado: false` en esas corridas: la
puerta las ve verdes aunque nuestro reloj haya cortado una llamada. Es el
mismo hueco que tenía la fila 13 antes de contar el cierre, en el caso que
termina bien.

**El arreglo (NO hecho todavía):** que `arena-shadow` journalee
`cuerpos_vacios` también cuando la corrida termina bien (p. ej. en
`ctx.tools.cuerpos_vacios`), y que `cortesDelCierre` lo lea de ahí además de
`llm_error`. Toca el journaleo del camino que decide: va en su propio PR, con
una sombra que lo pruebe.
