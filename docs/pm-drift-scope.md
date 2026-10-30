# PM-DRIFT: ¿el movimiento previo del precio de Polymarket predice el beat?

Backtest **pre-registrado**. Los criterios se fijaron antes de bajar un solo
precio y viven congelados en `CRITERIOS_PM_DRIFT`
(`api/_lib/pm-drift-analyze.js`), pineados valor por valor en
`tests/pm-drift-analyze.test.mjs`. Si algo de esto se cambia después de ver
el resultado, es otro estudio con otro nombre.

**Hipótesis previa (Claude, chat): NO-GO o INCONCLUSO.** Esperamos que el
precio ya incluya el movimiento.

## Pregunta

Si el precio del "Yes" sube entre T-72h y T-24h antes del reporte, ¿sale Yes
más seguido de lo que el propio precio de T-24h ya dice?

- **Drift principal:** Δ = p(T-24h) − p(T-72h), en puntos (0–100).
- **Drift secundario** (se reporta, no decide): Δ2 = p(T-2h) − p(T-24h).

## Aislamiento

- Archivos nuevos: `api/_lib/pm-drift-analyze.js` (lógica pura),
  `api/pm-drift-analyze.js` (endpoint), `docs/sql/pm-drift.sql`,
  `tests/pm-drift-analyze.test.mjs`. Lo único que se modificó fue la línea de
  `maxDuration: 300` en `vercel.json`.
- Sobre `pm_earnings_markets` (v1), `pm_earnings_markets_v2` y
  `pead_event_hour`: **solo SELECT**. La UI no se toca.
- Solo escribe en dos tablas nuevas: `pm_price_hist` y `pm_price_hist_fetch`.

## Datos

### Universo
Unión de v2 y v1 por `market_id`; si un mercado está en las dos, gana la fila
de v2 (el mismo criterio que `earnings-beat-v2`). Se excluyen, en este orden
y contando cada motivo:

1. duplicado (ya visto en v2)
2. **no resuelto**: `outcome` distinto de `yes`/`no`
3. **liquidez**: `volume` < **$500** o nulo (mismo umbral que Fase 2,
   `CRITERIOS_F2.min_volumen_usd`; un test exige que coincidan)
4. sin token del Yes
5. **sin fecha de reporte** (`report_date` nulo). La fecha de resolución
   **no** se usa como sustituto: es posterior al reporte y metería precios
   del futuro en T-24h y T-2h.

### Hora del reporte
Sale de `pead_event_hour` por (symbol, report_date). En hora del Este, con
horario de verano de EE.UU.:

| hora | se toma como |
|---|---|
| BMO | 07:00 ET |
| DMH | 12:00 ET |
| AMC | 16:00 ET |
| **sin hora** | **AMC 16:00 ET** (marcado `hora_imputada`) |

Riesgo conocido: si un mercado sin hora en realidad fue BMO, su "T-2h" (14:00
del día del reporte) ya trae el resultado. Eso solo afecta a Δ2, que no
decide; a T-24h y T-72h no les cambia el lado del reporte. Como control se
reporta (sin decidir) la regresión de Δ **sin** los mercados con hora imputada.

### Precios
`GET clob.polymarket.com/prices-history?market=<token Yes>&startTs&endTs&fidelity=60`;
si viene vacío o falla, se reintenta con `interval=max`. Se guarda la ventana
[fecha−4d 00:00Z, fecha+1d 00:00Z). En cada hora objetivo (T-72h, T-24h,
T-2h) se toma **el punto más cercano anterior o igual** a esa hora. Nunca uno
posterior. Si ese punto está a **más de 3h**, el precio **falta**.
**Empate** (dos puntos con el mismo timestamp): gana el último que llegó, igual
que el `ON CONFLICT DO UPDATE` de la tabla.

La ventana no recorta nada que pudiera servir: el punto más temprano que hace
falta es BMO −72h −3h = fecha−3d 08:00Z, y la ventana arranca en fecha−4d.

### Caché y rate limits
- `pm_price_hist (market_id, ts, price)`, PK (market_id, ts), `ON CONFLICT`.
- `pm_price_hist_fetch`: una fila por mercado pedido. `ok` (aunque venga
  vacío) **no se vuelve a pedir**; `error` se reintenta en la siguiente
  corrida; un `ok` nunca se degrada a `error`.
- Lotes de 4 requests con 250 ms de pausa entre lotes, 200 s de presupuesto
  por corrida. Un **429 corta toda la corrida** y no se registra: lo que falta
  se baja al abrir el link otra vez.

## Cobertura (paso 1: `?solo=cobertura`)
Dice cuántos mercados tienen los 3 precios, cuántos tienen Δ y, por cada hora,
cuántos faltan y por qué (`sin_historial`, `sin_punto_anterior`,
`hueco_mayor_3h`), más los pendientes de bajar y los errores de descarga.

Estados sin veredicto:
- **FALLA DE FRONTERA**: el universo está vacío, o hay **cero** puntos de
  precio del CLOB para todo el universo (por ejemplo, el CLOB está caído o
  bloqueado). Nunca se convierte en veredicto.
- **COBERTURA INCOMPLETA**: quedan historiales por bajar. Hay que volver a
  abrir el link.
- **COBERTURA LISTA** (solo en `?solo=cobertura`): todo bajado; el
  resultado sale sin `solo=cobertura`.

## Pruebas
Todas sobre los mercados con Δ válido (p72 y p24 presentes), salvo la (e).

a) **Regresión logística**: `resultado ~ logit(p24) + Δ` (p24 acotado a
   [0.01, 0.99]; Δ en puntos). Errores estándar **agrupados por fecha de
   reporte** (CR1: G/(G−1)·(N−1)/(N−K), el mismo de statsmodels/Stata; un
   test exige que coincida con statsmodels a 1e-8). Sin convergencia
   (separación, matriz singular, un solo grupo) → no hay coeficiente.

b) **Tabla**: por tramo de p24 (0-30, 30-50, 50-70, 70-100; el último incluye
   el 100), tasa de Yes cuando Δ ≥ +5 contra Δ ≤ −5 (con su n y su p24 medio).

c) **Simulación en papel**: Δ ≥ +5 → comprar Yes a p24; Δ ≤ −5 → comprar No
   a (1 − p24). **$1 por apuesta**, **$0.02 de costo fijo por operación**.
   Ganancia: Yes `y/p24 − 1`, No `(1−y)/(1−p24) − 1`, menos 0.02.

d) **Fuera de muestra**: mediana de fecha = la fecha del medio de las
   observaciones con Δ (la menor si N es par). 1ª mitad = fecha ≤ mediana;
   2ª = fecha > mediana. Se repiten (a) y (c) en cada mitad.

e) **Calibración** de p24 por deciles (10 grupos de igual tamaño ordenados
   por p24) y **Brier**, sobre todos los que tienen p24. Es referencia, no
   decide.

Secundario (se reporta, no decide): N y media de Δ2, `resultado ~ logit(p24) + Δ2`,
y (a) sin los mercados con hora imputada.

## Criterios (congelados)

| | |
|---|---|
| N con Δ válido < **150** | **INCONCLUSO** |
| coef Δ > 0 con **t ≥ 2.5**, Y coef > 0 en **ambas mitades**, Y simulación neta **> 0** en ambas mitades | **GO** |
| lo mismo pero **2 ≤ t < 2.5** | **GO FRÁGIL** |
| cualquier otro caso (incluida la regresión sin convergencia) | **NO-GO** |

Neto = 0 no cuenta como > 0.

## Uso

```
GET /api/pm-drift-analyze?solo=cobertura&format=md&secret=…   ← primero (repetir hasta COBERTURA LISTA)
GET /api/pm-drift-analyze?format=md&secret=…                  ← resultado
GET /api/pm-drift-analyze?format=md&obs=1&secret=…            ← + detalle (JSON sin format=md)
&bajar=0                                                       ← no toca el CLOB
```

Auth: `CRON_SECRET` por `?secret=` o `Authorization: Bearer`.
