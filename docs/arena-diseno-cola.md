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

**A decidir.** Si el prompt de cierre pregunta explícitamente, por cada
posición: *"si hoy no la tuvieras, ¿la comprarías a este peso?"*. Y si una
tesis que sólo se refiere a la tenencia ("core", "keep", "less of it") se
marca en /liga como **sin tesis** — se puede contar sin cambiar el prompt, y
ese conteo dice si el problema es de un agente o de todos.

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

**A decidir.** Si se siembra el universo completo o sólo lo que aparece en el
tablero (mucho menos); si la narración es la de Opus o un resumen más corto
hecho para la herramienta; y el criterio de éxito: ¿cambia alguna decisión, o
sólo agrega texto a las tesis?
