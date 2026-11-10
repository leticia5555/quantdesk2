# PM-CENTAVOS2: barra − consenso FINAL de Alpha Vantage, en centavos

Backtest **pre-registrado**, **estudio propio**. Los criterios se fijaron
antes de ver un solo número y viven congelados en `CRITERIOS_PM_CENTAVOS2`
(`api/_lib/pm-centavos2-analyze.js`), pineados valor por valor en
`tests/pm-centavos2-analyze.test.mjs`. Si algo se cambia después de ver el
resultado, es otro estudio con otro nombre.

## Por qué

PM-CENTAVOS (#351) salió **degenerado**: Polymarket fija la barra = el
consenso de su propia descripción, así que los 183 mercados tenían gap = 0.
No fue un NO-GO real: era medir contra el número equivocado. Acá el consenso
es el **final**, el `estimatedEPS` de AV `EARNINGS` (`pm_v2_hist`) para el
trimestre que el mercado pregunta.

Una primera versión de este estudio heredaba los criterios de PM-CENTAVOS
(decidía gap = 0 y compraba No ahí), que apuestan **en contra** de esta
hipótesis. Se corrigió **antes de correr nada**: el veredicto ahora decide la
variable de la hipótesis.

## Hipótesis previa

**Barra arriba del consenso final (gap ≥ +1)** → el % real de Yes está **por
debajo** del precio. **Consenso final arriba de la barra (gap ≤ −1)** → **por
arriba**.

## Variable

`gap = barra − estimatedEPS(AV)`, en **centavos**, redondeado al centavo
(misma regla que PM-CENTAVOS: se limpia el ruido de coma flotante, las mitades
se redondean lejos del cero, nunca −0). Empate = No: se usa el `outcome` con
el que resolvió el mercado.

- **Barra**: el umbral del slug (`…-1pt33`, `…-neg-0pt03`); si no, el monto
  de la pregunta.
- **Trimestre de AV**: con la regla de `docs/pm-fechas-av-scope.md`: fecha de
  la tabla ± 3 días; sin fecha en la tabla, el primer reporte tras la
  creación del mercado (≤ 120 días, no después de la resolución). Por eso
  entran también los mercados con fecha recuperada (`av_hist`).
- **p24**: T-24h desde la hora del reporte, la caché y la regla de PM-DRIFT
  (punto anterior más cercano, hueco ≤ 3h; sin hora → AMC imputado).

## Universo
v2 ∪ v1 sin duplicados (gana v2), resueltos, liquidez ≥ $500, con token;
luego, en orden y con su motivo: sin fecha de reporte, sin barra, sin
`estimatedEPS` de AV para el trimestre. No exige consenso en la descripción.

## Pruebas

a) **Tabla** por gap: ≤−4, −3, −2, −1, 0, +1, +2, +3, ≥+4 → N, % de Yes
   real, p24 medio y diferencia. **Se reporta, no decide.**

b) **Regresión logística**:
   `resultado ~ logit(p24) + 1[gap ≥ +1] + 1[gap ≤ −1]`.
   Categoría base: **gap = 0**. p24 acotado a [0.01, 0.99]. Errores
   **agrupados por fecha de reporte** (la logística de PM-DRIFT, pineada
   contra statsmodels). **Decide coef(1[gap ≥ +1])**; coef(1[gap ≤ −1]) se
   reporta y no decide. Sin mercados en la base (gap = 0) la matriz es
   singular y no hay coeficiente (→ NO-GO).

c) **Simulación en papel**, $1 por apuesta, $0.02 de costo fijo por
   operación, sin umbral de precio:
   - gap ≥ +1 → comprar **No** a (1 − p24): gana `(1−y)/(1−p24) − 1`
   - gap ≤ −1 → comprar **Yes** a p24: gana `y/p24 − 1`
   - gap = 0 → **no se apuesta**

d) **Fuera de muestra**: mediana de fecha (la regla de PM-DRIFT: la fecha del
   medio, la menor si N es par); 1ª mitad = ≤ mediana, 2ª = > mediana. Se
   repiten (b) y (c).

Informativo: cuánto se movió el consenso entre la descripción (creación del
mercado) y AV (reporte).

## Criterios (congelados)

| | |
|---|---|
| N(gap ≥ +1) < **40** | **INCONCLUSO** |
| coef(1[gap ≥ +1]) **< 0** con **t ≤ −2.5**, Y simulación neta **> 0** en **ambas** mitades | **GO** |
| lo mismo con **−2.5 < t ≤ −2** | **GO FRÁGIL** |
| cualquier otro caso (incluida la regresión sin convergencia) | **NO-GO** |

Neto = 0 no cuenta como > 0. La regresión de cada mitad, coef(gap ≤ −1), la
tabla y la hipótesis previa se reportan y **no deciden**.

Estados sin veredicto (los de PM-DRIFT): **FALLA DE FRONTERA** (universo
vacío o cero puntos del CLOB) y **COBERTURA INCOMPLETA** (quedan historiales
por bajar).

## Limitación (escrita antes de correr)

`estimatedEPS` es el consenso **al día del reporte**. Asumimos que a T-24h ya
era prácticamente ese número. Si en las últimas 24h el consenso se movió, la
señal usaría información que el mercado a T-24h todavía no tenía. **Si sale
GO, hay que confirmarlo hacia adelante con el snapshot diario
(`pm_v2_consenso_snap`)**, que sí es point-in-time.

Otros riesgos: la simulación usa p24 como precio de ejecución (sin spread ni
profundidad); el $0.02 fijo es la única fricción.

## Aislamiento

PM-CENTAVOS no se toca. De ahí se reusan solo la plomería y las reglas
neutrales (lectura de la barra, redondeo del gap, tramos de la tabla, precio a
T-24h, mitades); los criterios, la regresión, la simulación y el veredicto son
propios. Escribe solo en la caché de precios de PM-DRIFT; sobre v1, v2,
`pm_v2_hist` y `pead_event_hour`: SELECT.

## Uso

```
GET /api/pm-centavos2-analyze?solo=cobertura&format=md&secret=…   ← primero (repetir hasta COBERTURA LISTA)
GET /api/pm-centavos2-analyze?format=md&secret=…                  ← resultado
&obs=1 → detalle (JSON) · &bajar=0 → no toca el CLOB
```
Auth: `CRON_SECRET` por `?secret=` o `Authorization: Bearer`.
