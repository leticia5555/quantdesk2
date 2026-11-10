# PM-FECHAS-AV: rellenar report_date desde Alpha Vantage (pm_v2_hist)

PM-DRIFT (#350) y PM-CENTAVOS (#351) excluyeron ~720 mercados resueltos por
no tener `report_date` en v1/v2. Este paso les pone fecha desde
`pm_v2_hist` (AV `EARNINGS`), **marcando la fuente**, sin tocar v1/v2.
Los criterios de #350/#351 no se tocan: los estudios nuevos (PM-CENTAVOS2,
PM-DRIFT2H) son los que usan las fechas recuperadas.

Regla congelada en `CRITERIOS_TRIMESTRE_AV` (`api/_lib/pm-trimestre-av.js`),
pineada en `tests/pm-fechas-av.test.mjs`.

## Regla

**Mercado SIN `report_date`** → fecha = el **primer** `reported_date` de
`pm_v2_hist` del símbolo que sea **≥ el día de creación** del mercado (UTC),
con dos candados:

- a **≤ 120 días** de la creación (si no: `sin_reporte_cercano`);
- **no después de la resolución** del mercado + 1 día (si no:
  `posterior_a_resolucion`): un mercado no resuelve antes del reporte por el
  que pregunta.

Fuente: `av_hist`. Otros motivos de no recuperar: `sin_simbolo`,
`sin_creado`, `simbolo_sin_hist` (el símbolo no está en `pm_v2_hist`),
`hist_desactualizado` (el último reporte de AV es anterior a la creación: la
cosecha de AV todavía no trae ese trimestre).

**Mercado CON `report_date`** → la fecha de la tabla manda (fuente `tabla`).
Para el estimado de AV de ese trimestre se toma la fila con `reported_date`
más cercano a esa fecha, a **≤ 3 días** (si no: `sin_trimestre_av`).

## Validación (se reporta, no decide)

La misma regla se aplica a los mercados que **sí** traen fecha, como si no la
tuvieran, y se cuenta cuántas veces da la misma fecha (± 3 días). Es la
estimación de acierto del relleno.

También se informa cuántos de los no recuperados **sí** tendrían fecha en
`pead_earnings`. Ese número no se usa para rellenar (la fuente pedida es
`pm_v2_hist`); sirve para decidir si vale la pena ampliarla.

## Qué escribe

Solo la tabla nueva `pm_fecha_av` (una fila por mercado: fecha de la tabla,
fecha efectiva, `fuente_fecha`, `motivo`, trimestre, `estimated_eps`,
`reported_eps`). Sobre v1, v2, `pm_v2_hist`, `pead_event_hour` y
`pead_earnings`: solo SELECT. Los estudios calculan la misma regla en el
momento (la misma función), no leen esta tabla: es la auditoría.

## Uso

```
GET /api/pm-fechas-av?format=md&secret=…            ← resumen (y escribe pm_fecha_av)
GET /api/pm-fechas-av?format=md&escribir=0&secret=…  ← sin escribir
GET /api/pm-fechas-av?obs=1&secret=…                 ← detalle por mercado (JSON)
```
