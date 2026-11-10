# PM-CENTAVOS2: barra − consenso FINAL de Alpha Vantage, en centavos

Backtest **pre-registrado**. Sucede a PM-CENTAVOS (#351), que salió
**degenerado**: Polymarket fija la barra = el consenso de su propia
descripción, así que los 183 mercados tenían gap = 0. No fue un NO-GO real:
era medir contra el número equivocado.

## Cambio respecto de PM-CENTAVOS

`gap = barra − estimatedEPS de AV para ESE trimestre`, en centavos. El
`estimatedEPS` de AV `EARNINGS` (`pm_v2_hist`) es el consenso **final**, el
que había al día del reporte. El trimestre se empareja con la regla de
`docs/pm-fechas-av-scope.md` (fecha de la tabla ± 3 días; o, sin fecha, el
primer reporte tras la creación del mercado). Por eso el universo incluye los
mercados con fecha recuperada (`av_hist`).

Todo lo demás es **idéntico** a PM-CENTAVOS: barra (slug, si no la pregunta),
redondeo del gap, empate = No, precio a T-24h (caché y regla de PM-DRIFT),
tabla, regresión, simulación, mitades y veredicto. Se **reusa**
`CRITERIOS_PM_CENTAVOS` valor por valor (`CRITERIOS_PM_CENTAVOS2` solo cambia
el texto de la hipótesis; el test lo exige) y las funciones de
`api/_lib/pm-centavos-analyze.js`. PM-CENTAVOS no se toca.

## Universo
v2 ∪ v1 sin duplicados, resueltos, liquidez ≥ $500, con token; luego, en
orden: sin fecha de reporte (con su motivo), sin barra, sin `estimatedEPS` de
AV para el trimestre (con su motivo). No exige consenso en la descripción.

## Pruebas (las de PM-CENTAVOS)
a) tabla por gap (≤−4 … ≥+4): N, % Yes, p24 medio, diferencia;
b) `resultado ~ logit(p24) + 1[gap=0] + 1[gap=−1] + 1[gap≥+1]`, base gap ≤ −2,
   errores agrupados por fecha;
c) simulación: gap = 0 y p24 ≥ 0.70 → No a (1−p24); gap ≤ −1 y p24 ≤ 0.70 →
   Yes a p24; $1, $0.02;
d) mitades por fecha, repitiendo (b) y (c).

Informativo: cuánto se movió el consenso entre la descripción (creación) y
AV (reporte).

## Criterios (los de PM-CENTAVOS, congelados)

| | |
|---|---|
| N(gap = 0) < **40** | **INCONCLUSO** |
| coef de 1[gap = 0] **< 0** con **\|t\| ≥ 2.5** y simulación neta **> 0** en ambas mitades | **GO** |
| lo mismo con **2 ≤ \|t\| < 2.5** | **GO FRÁGIL** |
| cualquier otro caso | **NO-GO** |

## Hipótesis previa (se reporta, NO decide)

Con el consenso final: **gap ≤ 0** (consenso igual o arriba de la barra) → el
% real de Yes está **por encima** del precio; **gap ≥ +1** (barra arriba del
consenso) → **por debajo**.

**Ojo, escrito antes de correr:** los criterios heredados de PM-CENTAVOS
apuestan en la dirección **contraria** a esta hipótesis en gap = 0 (piden
coef(gap=0) < 0 y la simulación compra **No** en gap = 0). Si la hipótesis es
cierta en gap = 0, el veredicto tiende a NO-GO aunque haya señal. Se dejó así
porque se pidió "criterios iguales a pm-centavos"; si se quiere alinear, hay
que cambiarlo **antes** de abrir el resultado, como otro estudio.

## Uso

```
GET /api/pm-centavos2-analyze?solo=cobertura&format=md&secret=…   ← primero (repetir hasta COBERTURA LISTA)
GET /api/pm-centavos2-analyze?format=md&secret=…                  ← resultado
&obs=1 → detalle (JSON) · &bajar=0 → no toca el CLOB
```
Escribe solo en la caché de precios de PM-DRIFT. Auth: `CRON_SECRET`.
