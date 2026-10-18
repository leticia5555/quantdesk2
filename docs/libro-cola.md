# El Libro — cola de candidatas

> Texto, no tabla. Nada de aquí está en `libro_estrategias` hasta que tenga backtest pre-registrado con GO escrito. Una a la vez: se corre hasta veredicto antes de abrir la siguiente.

## En el libro (Fase 0, sembradas)

- **spy_piso** — la vara. No opera.
- **tsla_bollinger** — validada (VENTAJA REAL a 2 años, FRÁGIL a 5). Entra en Fase 1, chica (10 %).

## Cola (orden)

1. **Wheel** (vender puts cubiertos con efectivo → calls cubiertos). Fase 0 VIABLE con dos incógnitas (cuánta historia da Market Data, costo de cadena completa). **Tiene reloj**: trial de Market Data. Ver `docs/wheel-fase0.md`, `docs/wheel-harvest-scope.md`. Requiere nivel de opciones en Alpaca (pendiente verificar para cuentas de México).
2. **Fuga pre-earnings** — máquina entregada, solo falta PR + merge + correr. Apuesta previa: NO-GO o INCONCLUSO. Ver `docs/fuga-backtest-scope.md`.
3. **Cripto spot** — Fase 0 (memo). Spot, sin apalancamiento, long-only. Ver `docs/cripto-fase0.md`.
4. **Overnight** (comprar al cierre / vender a la apertura) — expediente de investigación.
5. **Earnings-beat** (Polymarket beat/miss) — idea con Fase 1 de cosecha corriendo.

## Veredictos que llegan solos (no se corren, se leen)

- **Brasil / straddle PBR-EWZ** — 2ª vuelta 25-oct. Es el experimento de **compra** de opciones, en papel.
- **Arena T3** — cierra 30-oct. Es el experimento de **shorts** y de **LLMs**. Si un modelo le gana a SPY con margen > 0.77 (piso de ruido claude↔control), entra como candidata en T4. Si no, sigue siendo contenido.

## Cerradas (no vuelven)

- Rotación value+momentum — NO-GO en US (ago-24) y en BMV (sep-17).
- Dual momentum / gate SMA200 — NO-GO (ago-26).
- PEAD — NO-GO (ago-19).
- Anomalías de calendario (lunes, fin de mes) — cerradas (oct-16).
- Iron condor / iron butterfly diarios (AI Velocity) — NO-GO por régimen (oct-17).

## Lo que no entra, ni con GO

- Perpetuos / apalancamiento (donde murió la T1 de nof1).
- Comprar opciones sin backtest (el straddle de Brasil es papel).
- Cualquier cosa que no pase por `validarOrdenes`.
