# Dual Momentum con gate de tendencia — agente defensivo + breaker macro

**Backtest PRE-REGISTRADO #3.** Mismo playbook que `/api/pead-analyze` y
`/api/rotation-analyze`: los criterios se fijaron **antes** de correr nada,
viven congelados en `CRITERIOS` (`api/_lib/dualmom-analyze.js`) y salen en cada
respuesta. Si alguien los mueve después de ver los números, el diff lo delata.

Endpoint: `GET /api/dualmom-analyze` (solo lectura) · `?format=md` ·
`?anios=N` · `?canastas=1` (detalle mes a mes + serie del gate).

---

## 1. La pregunta

¿El Dual Momentum con gate de tendencia sirve como **agente defensivo**, y
sirve como **evidencia para el breaker macro de la liga**? Son dos preguntas y
el reporte las contesta por separado: la segunda depende enteramente de si el
gate llegó a activarse.

## 2. Especificación principal (una sola)

| Pieza | Definición |
|---|---|
| Universo | el **mismo set** que `rotation-analyze` (símbolos con EPS en `pead_earnings`), por comparabilidad — esta estrategia no usa los EPS |
| Rebalanceo | primer día hábil del mes, **fills a la apertura** |
| Selección | rank por momentum 12-1 → top decil (~10), equal-weight |
| Filtro (a) | momentum **absoluto**: un nombre entra solo si su 12-1 > 0 |
| Filtro (b) | **gate macro**: SPY debajo de su SMA de 200 sesiones → cartera completa a efectivo (rinde 0) |
| Costos | 10 bp por lado sobre el turnover real (irse a efectivo y volver paga las dos veces) |
| Ventana | 3 años por default, la misma que `rotation-analyze` |

### 2.1 Decisiones que hay que declarar (y por qué)

- **El orden de los dos filtros importa.** Primero se corta el decil sobre
  todos los elegibles, y **recién después** se aplica el momentum absoluto. Al
  revés (rankear solo entre los positivos) la canasta tendría ~10 nombres
  siempre y el filtro no defendería de nada: en un mercado donde casi nada
  sube, el punto es quedarse con **menos** nombres, no con los diez menos malos.
- **El gate se lee al cierre ANTERIOR.** Compara el último cierre conocido
  contra la SMA calculada hasta esa misma sesión, y ejecuta en la apertura
  siguiente. Como el rebalanceo cae en el primer día hábil del mes, ese cierre
  es el **último del mes anterior**: es la señal mensual clásica (Faber) y es
  la única implementable — el cierre del propio día no existe cuando hay que
  mandar la orden. La lectura literal del encargo va como **EXPLORATORIO**.
- **Sin SMA computable se va a efectivo**, no risk-on por defecto, y se cuenta
  aparte: un gate mudo que se asume risk-on es una defensa que no defendió y
  de la que nadie se enteró.
- **El efectivo rinde 0.** Conservador a propósito: no se le acredita a la
  estrategia un rendimiento de T-bills que nadie modeló.

## 3. Criterios de éxito (congelados ANTES de correr)

La vara es **relativa a SPY**, no absoluta. Esta estrategia promete **defensa,
no alfa**, y un umbral absoluto de Sharpe premiaría el régimen: en una ventana
dorada cualquier cosa larga lo pasa y en una mala ninguna defensa lo alcanza
(la lección del `rotation-analyze`).

1. **Muestra** — ≥ 30 rebalanceos completos. Si no → **INCONCLUSO**.
2. **Sharpe** — Sharpe neto ≥ Sharpe de SPY **+ 0.15** en la misma ventana.
3. **Drawdown** — max drawdown ≤ **70%** del max drawdown de SPY.
4. **Costo de la defensa** — retorno anualizado neto ≥ SPY **− 1 punto**.
5. **GO = 2 y 3 y 4.**

### 3.1 Candado de honestidad (pre-registrado)

El reporte publica **`gate_activaciones`** (meses en efectivo por el gate
macro). **Si es 0, el mecanismo defensivo NO se probó en esta ventana**: los
números son los del momentum a secas en un régimen que nunca lo puso a prueba.
El veredicto se topa en **"GO frágil (gate sin evento en ventana)"** aunque los
cuatro criterios estén en verde, y el reporte lo dice explícito — incluida la
consecuencia: como evidencia para el breaker macro, esa corrida no alcanza.

El candado **no** aplica a la sensibilidad *sin gate*: ahí no hay mecanismo que
probar.

### 3.2 Un borde que se reporta en vez de aprobarse solo

Si SPY no tuvo drawdown medible en la ventana, el §3 queda **vacuo**
(cualquier caída lo violaría). Se marca `dd_evaluable: false`, se cuenta como
**no cumplido** y se dice — no se aprueba por defecto.

## 4. Sensibilidades obligatorias

- **Sin gate macro** — atribución: cuánto del resultado es el gate y cuánto el
  momentum.
- **Sin filtro absoluto** — momentum relativo puro. Es además el **puente** con
  el corte "solo momentum" de `rotation-analyze` (mismo universo, misma
  ventana, misma definición 12-1).
- **SMA de 10 meses** en vez de 200 días (variante Faber).
- **Rebalanceo bimestral** — se anticipa INCONCLUSO **aritmético** con una
  ventana de 3 años (~17 rebalanceos); léase por sus números.

Cualquier otro corte va etiquetado **EXPLORATORIO** y no cuenta.

## 5. Garantías de la implementación

- **Solo lectura**: un único `SELECT DISTINCT symbol` sobre `pead_earnings`
  (solo para heredar el universo). Cero DDL/DML, sin `ensurePeadSchema()`, sin
  `beat()`. El test captura toda query que cruza la frontera.
- **Gate del endpoint**: `CRON_SECRET` por header o query, `no-store`,
  `maxDuration = 300`.
- **Motor compartido**: el calendario de rebalanceos, el momentum 12-1, la
  simulación con costos sobre turnover real y la serie calendar-time de SPY
  son los de `_lib/rotation-analyze.js`; las velas ajustadas, las de
  `_lib/yahoo-daily.js`. Si el motor cambia, cambia para los dos backtests a la
  vez y no se desincronizan.
- **La prueba que importa**: `tests/dualmom-analyze.test.mjs` corre un fixture
  con **crash plantado** y verifica que el gate se activa, saca la cartera a
  efectivo **durante** la caída y deja el drawdown muy por debajo del de SPY
  **y** del de la misma estrategia sin gate. Si esa prueba no pasa, ningún otro
  número del reporte significa nada.

## 6. Caveat pre-registrado: esto NO es evidencia independiente

Corre sobre el **mismo universo** y la **misma ventana** que
`rotation-analyze`: hereda entero su sesgo de supervivencia y el mismo régimen
de mercado. Si el momentum funcionó allá, acá funciona otra vez **por
construcción** — no es confirmación, es el mismo experimento con otro
envoltorio. Lo único genuinamente nuevo es el gate; si `gate_activaciones = 0`,
esta corrida no aporta ninguna evidencia nueva sobre defensa.
