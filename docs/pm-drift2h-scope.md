# PM-DRIFT2H: ¿Δ2 agrega algo al ÚLTIMO precio?

Backtest **pre-registrado**. Criterios congelados en `CRITERIOS_PM_DRIFT2H`
(`api/_lib/pm-drift2h-analyze.js`), pineados en
`tests/pm-drift2h-analyze.test.mjs`.

**Hipótesis previa (Claude, chat): NO-GO.** Esperamos que p2h ya incluya el
movimiento de las últimas 22 horas.

## Por qué otro estudio

PM-DRIFT (#350) dio NO-GO en su prueba principal y reportó Δ2 =
p(T-2h) − p(T-24h) como secundario, pero con `resultado ~ logit(p24) + Δ2`.
Eso pregunta si Δ2 agrega algo a un precio **viejo**: si p2h es el precio
justo, Δ2 "predice" contra p24 solo porque p2h sabe más, y no hay nada que
operar (a las 2h ya se compra a p2h). Un test lo muestra: con datos donde
p2h es exactamente el precio justo, la especificación vieja da t > 2.5 y esta
da NO-GO.

## Especificación

- `resultado ~ logit(p2h) + Δ2`, Δ2 en puntos (0–100), p2h acotado a
  [0.01, 0.99], errores agrupados por fecha de reporte (la logística de
  PM-DRIFT).
- **Sin los mercados con hora de reporte imputada**: sin hora real, el T-2h
  de un BMO caería después del reporte.
- Simulación **a precio p2h**: Δ2 ≥ +5 → Yes a p2h; Δ2 ≤ −5 → No a
  (1 − p2h). $1 por apuesta, $0.02 por operación.
- Mitades por fecha (la regla de PM-DRIFT), repitiendo regresión y simulación.
- Referencia (no decide): la especificación vieja sobre la misma muestra.

Precios, caché y hora del reporte: los de PM-DRIFT (T-2h y T-24h desde la
hora del reporte, punto anterior más cercano, hueco ≤ 3h). Fechas: las de la
tabla o, si no hay, las recuperadas de `pm_v2_hist`
(`docs/pm-fechas-av-scope.md`); la hora se busca en `pead_event_hour` en la
fecha efectiva.

## Criterios (congelados)

| | |
|---|---|
| N con Δ2 válido < **150** | **INCONCLUSO** |
| coef Δ2 > 0 con **t ≥ 2.5** Y neto **> 0** en **ambas** mitades | **GO** |
| cualquier otro caso (no hay GO FRÁGIL) | **NO-GO** |

## Uso

```
GET /api/pm-drift2h-analyze?solo=cobertura&format=md&secret=…   ← primero
GET /api/pm-drift2h-analyze?format=md&secret=…                  ← resultado
&obs=1 → detalle (JSON) · &bajar=0 → no toca el CLOB
```
Escribe solo en la caché de precios de PM-DRIFT. Auth: `CRON_SECRET`.
