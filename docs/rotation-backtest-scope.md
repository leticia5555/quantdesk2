# Rotación Value + Momentum — candidato a Agente #7 v2

**Backtest PRE-REGISTRADO.** Mismo playbook que `/api/pead-analyze`: los
criterios de éxito se fijaron **antes** de correr nada, viven congelados en
`CRITERIOS` (`api/_lib/rotation-analyze.js`) y salen en cada respuesta. Si
alguien los mueve después de ver los números, el diff lo delata.

Endpoint: `GET /api/rotation-analyze` (solo lectura) ·
`?format=md` para el resumen en español · `?anios=N` para la ventana ·
`?canastas=1` para el detalle canasta a canasta.

---

## 1. La pregunta

¿Una rotación mensual que combina *value* y *momentum* sobre el universo con
historial de EPS bate al SPY **de forma operable** y **sin look-ahead**?

## 2. Especificación principal (una sola)

| Pieza | Definición |
|---|---|
| Universo | los símbolos con historial de EPS en `pead_earnings` (~98) y precios en Yahoo |
| Rebalanceo | primer día hábil del mes (calendario de SPY), **fills a la apertura** |
| Value | earnings yield point-in-time: **TTM EPS / precio** |
| TTM EPS | suma de los EPS de los 4 trimestres cuyo `reported_date` es **ANTERIOR** a la fecha de rebalanceo |
| Momentum | 12-1: retorno de t−12m a t−1m (se salta el último mes) |
| Score | promedio de los dos **ranks percentiles**, calculados dentro de cada rebalanceo |
| Cartera | decil superior (~10 nombres), equal-weight, long-only |
| Costos | 10 bp por lado sobre el **turnover real** (Σ\|Δnotional\| / equity) |
| Benchmark | SPY, retorno anormal **diario** (calendar-time) |
| Ventana | 3 años por default (regla de la casa: el universo es de HOY, ver §6) |

### 2.1 Decisiones que hay que declarar (y por qué)

- **El "precio de ese día" es el CIERRE ANTERIOR.** El encargo dice "dividido
  entre el precio de ese día"; se usa el cierre de la sesión previa porque la
  canasta tiene que estar armada **antes** de la apertura en la que se ejecuta.
  Con el open del mismo día el ranking solo se podría calcular en el instante
  del fill, y el backtest dejaría de ser replicable en vivo. La diferencia
  (un gap overnight) se mide igual, como corte **EXPLORATORIO**.
- **Un reporte del mismo día NO entra al TTM.** `pead_earnings` no tiene hora:
  un reporte fechado el día del rebalanceo pudo salir después de la apertura.
  El corte es estricto (`reported_date < fecha`). A lo sumo se entra un mes
  tarde; nunca antes de que el dato existiera.
- **Las tres variantes de score comparten la misma población elegible.** Un
  nombre entra solo si tiene TTM válido **y** momentum válido **y** precio.
  Si cada pierna corriera sobre su propio universo, la comparación
  combo-vs-piernas mezclaría señal con cobertura de datos.
- **El t del §2 se mide BRUTO** (los costos son el §3), igual que en el PEAD.
  El t neto se reporta al lado, no se esconde.
- **Los pesos derivan entre rebalanceos.** No hay re-equiponderación diaria:
  eso sería un turnover que nadie paga en el backtest y todos pagan en vivo.

### 2.2 Qué se considera un TTM válido

Los 4 trimestres previos tienen que estar los 4, con `reported_eps` no nulo,
con 4 `fiscal_date_ending` distintos (un restatement duplicado no cuenta como
dos trimestres), con el último reporte a menos de **200 días** (dato rancio →
fuera) y con los 4 dentro de **500 días** (si no caben, falta un trimestre).
Un trimestre en pérdida **sí** se suma con su signo: un yield negativo es
información real, no un dato faltante. Cada exclusión se cuenta y se reporta
por motivo — un símbolo que desaparece en silencio es una muestra distinta a
la que dice el JSON.

## 3. Criterios de éxito (congelados ANTES de correr)

1. **Muestra** — ≥ 30 rebalanceos mensuales **completos** (con su periodo
   cerrado) y ≥ 8 nombres promedio por canasta. Si no → **INCONCLUSO**.
2. **Señal** — retorno anormal diario vs SPY de la cartera rotada
   (calendar-time), con **|t| ≥ 2**.
3. **Economía** — **Sharpe neto ≥ 0.9** *y* **retorno neto anualizado ≥
   SPY + 2 puntos porcentuales** (significancia económica, no solo estadística).
4. **GO requiere 2 y 3.** Falla de muestra → INCONCLUSO (no NO-GO: sin muestra
   no se afirma que la estrategia no sirve). Lo demás → NO-GO.
5. **GO FRÁGIL** — un GO con `|t| < 2.5` se reporta como frágil: pasa por poco
   y el sesgo de supervivencia (§6) empuja para el mismo lado.

El §2 es de **dos colas**: un t de −2.3 lo pasa. Cuando eso ocurre el reporte
lo dice explícitamente — hay señal, pero apunta en contra.

## 4. Sensibilidades obligatorias

- Quintil superior (~20 nombres) en vez del decil.
- **Solo value** y **solo momentum**, por separado: para saber si el combo
  aporta sobre cada pierna o si una está cargando a la otra.
- Rebalanceo cada 2 meses. Ojo: con una ventana de 3 años produce ~17
  rebalanceos, por debajo del piso de muestra **por aritmética**; su
  INCONCLUSO es de muestra, no de señal, y el reporte lo aclara.

Cualquier otro corte va etiquetado **EXPLORATORIO** y no cuenta para el
veredicto.

## 5. Garantías de la implementación

Las mismas del `pead-analyze`, verificadas en `tests/rotation-analyze.test.mjs`:

- **Solo lectura**: un único `SELECT` sobre `pead_earnings`. Cero DDL/DML, sin
  `ensurePeadSchema()`, sin `beat()` (latir acá enmascararía un cron muerto).
  El test captura toda query que cruza la frontera y falla si alguna no
  empieza con `select`.
- **Gate**: `CRON_SECRET` por header o por query (`?secret=`), respuesta
  `no-store`. `maxDuration = 300`.
- **Precios**: Yahoo en vivo (`api/_lib/yahoo-daily.js`, compartido con el
  PEAD), velas diarias ajustadas por splits **y** dividendos, con el factor
  aplicado también al open.
- **Lib puro**: `api/_lib/rotation-analyze.js` no hace I/O; se testea con
  sintéticos (combo plantado → GO, sin señal → NO-GO, muestra corta →
  INCONCLUSO, y huecos de EPS → INCONCLUSO con el motivo).

## 6. Caveat pre-registrado: sesgo de supervivencia

El universo es la lista de **HOY** mirada hacia atrás. Los nombres que
quebraron, fueron adquiridos o deslistados no están en `pead_earnings`, y los
que sobrevivieron llegaron hasta hoy justamente porque les fue bien. Eso
**INFLA** retorno, Sharpe y exceso sobre SPY, y no se puede corregir con estos
datos (haría falta un universo point-in-time — misma regla dura que
`docs/pead-backtest-scope.md` §2.2, que es también la razón de la ventana
default de 3 años).

Por eso: el umbral económico lleva margen (**SPY + 2 pp**, no SPY + 0) y un GO
marginal se reporta como **GO frágil**. Y por eso un **NO-GO acá es más creíble
que un GO**: el sesgo empuja hacia el GO, así que lo que no pasa ni con el
viento a favor, no pasa.

## 7. Si los datos no alcanzan

La primera sección del reporte contesta, con la cobertura **medida**, si el TTM
point-in-time desde `pead_earnings` sostiene el backtest: elegibles promedio
por rebalanceo, rebalanceos saltados y exclusiones desglosadas por motivo. Si
no alcanza, el veredicto es **INCONCLUSO** y se dice — **no se improvisa otra
fuente de EPS**.
