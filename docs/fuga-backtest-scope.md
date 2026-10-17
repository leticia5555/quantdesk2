# FUGA PRE-EARNINGS — ¿el run-up previo al reporte predice la reacción?

**Backtest PRE-REGISTRADO, sexto de la serie.** Mismo playbook que
`/api/pead-analyze`: los criterios viven en un solo objeto,
`CRITERIOS_FUGA` (`api/_lib/fuga-analyze.js`), pineados por
`tests/fuga-analyze.test.mjs`. Mover una portería rompe un test y se ve en el diff.

**Estado:** máquina entregada, **sin correr contra datos reales** (el sandbox
donde se construyó no llega a Neon ni a Yahoo). Se corre post-merge.

---

## 1. La pregunta

Idea externa (AI Velocity, "Earnings Leak Detector"): si una acción le gana al
SPY por ≥6% en los días previos a su reporte, "alguien sabe algo" → comprar y
vender en el reporte. Su backtest tiene 1 operación.

- **H1:** el exceso de retorno pre-anuncio predice la reacción al anuncio.
- **H0 (la apuesta):** la reacción es independiente del run-up; lo que haya es
  momentum de corto plazo o ruido.

## 2. Especificación principal (una sola)

| Pieza | Definición |
|---|---|
| Eventos | `pead_earnings` ⋈ `pead_event_hour`, ventana 3 años (calendario de SPY) |
| Precios | velas diarias ajustadas de Yahoo vía `api/_lib/yahoo-daily.js`; cierres |
| D (detección) | última sesión cuyo cierre ocurre ANTES del anuncio. BMO → E−1 · AMC → E |
| Señal | `excess_5 = ret(acción, D−5→D) − ret(SPY, D−5→D)` |
| SEÑAL | `excess_5 ≥ +6%` (umbral de la fuente; no se barre) |
| CONTROL | `|excess_5| < 2%` |
| CORTO (informativo) | `excess_5 ≤ −6%` — se reporta, no decide |
| Entrada / salida | cierre de D → primer cierre después del anuncio (BMO: cierre de E · AMC: cierre de E+1) |
| Métrica | reacción anormal = ret(acción) − ret(SPY) en la tenencia |
| Costos | 10 bp por lado sobre el lado largo |
| Stop | ninguno (1 sesión con cierres: un stop intradía no es medible) |

### 2.1 Decisiones declaradas antes de correr

- **Fin de semana / feriado.** D = última sesión `< E` (BMO) o `≤ E` (AMC); la
  salida es la siguiente sesión. Las dos reglas caen solas en la sesión correcta.
- **DMH → BMO.** Con el anuncio en horario de mercado, el cierre de E ya lo
  incorpora; tratarlo como AMC (como hace el PEAD para su entrada al *open*)
  metería look-ahead acá.
- **Sin hora → AMC** en la principal, como pidió el encargo. **Ojo:** en este
  diseño AMC *no* es la opción conservadora — si el reporte en realidad fue
  BMO, el cierre de E ya vio el anuncio. Por eso: (a) la cobertura cuenta los
  eventos con hora imputada, (b) la sensibilidad "sin hora descartados" es
  obligatoria, (c) va un EXPLORATORIO etiquetado "sin hora → BMO", que nunca
  mete look-ahead.
- **Velas faltantes no se rellenan.** Si falta el cierre de D, de D−5 o de la
  salida, el evento se cae con su motivo (`sin_vela_d`, `sin_vela_formacion`,
  `sin_vela_salida`…) y la cobertura lo cuenta.
- **El criterio (3) se mide sobre la reacción ANORMAL neta**, no sobre el
  retorno crudo: si no, la deriva de SPY contaría como edge.
- **GO FRÁGIL también exige (3).** El encargo dice "GO FRÁGIL si (1) y (2) con
  2 ≤ t < 2.5"; se lee de forma conservadora: un edge que no paga costos no es
  GO de ningún tipo.

## 3. Placebo (decide junto con los criterios)

Misma señal (`excess_5 ≥ +6%`) en sesiones D' que **no** caen en
`[iE−10, iE+3]` de ningún reporte del símbolo (iE = primera sesión ≥ E,
cualquier hora; los reportes de antes de la ventana también vedan). Misma
tenencia, mismo cálculo. Se toman **todas** las sesiones elegibles dentro de la
ventana de análisis — determinista, y ≥ N(SEÑAL) en cualquier universo realista;
si no alcanzara, el reporte lo marca con ⚠️.

Lectura: si SEÑAL ≈ PLACEBO, lo que haya es momentum, no fuga.

## 4. Estadística

- Por grupo (SEÑAL, CONTROL, PLACEBO, CORTO): N, fechas distintas, media,
  mediana, % positivos, media neta, media por fecha y **t de la media por fecha**.
- **Clustering:** antes de cualquier t, los eventos se promedian por fecha de D.
  La unidad del t es la fecha, no el evento.
- Diferencias SEÑAL−CONTROL y SEÑAL−PLACEBO: Welch sobre las series por fecha.

## 5. Criterios (congelados)

- **Candado:** N(SEÑAL) ≥ 30 y N(CONTROL) ≥ 100; si no → **INCONCLUSO**.
- **GO** requiere las tres, con ambos t ≥ 2.5:
  1. media de SEÑAL (por fecha) > 0 con t ≥ 2
  2. SEÑAL − PLACEBO > 0 con t ≥ 2 (es fuga, no momentum)
  3. reacción anormal neta ≥ +0.30 % por operación
- **GO FRÁGIL:** las tres, pero el t de (1) o de (2) en [2, 2.5).
- **NO-GO:** cualquier otro caso con muestra suficiente.
- t(1) ≤ −2 → **hallazgo** "el run-up se revierte"; sigue siendo NO-GO para la
  idea long.

## 6. Sensibilidades (se reportan, NO deciden, NO se promueven)

1. Formación 10 sesiones (`excess_10 ≥ +6%`)
2. Umbral 4% y 8% (solo forma)
3. Split BMO (incluye DMH) vs AMC (incluye sin hora imputados) — CONTROL y
   PLACEBO quedan enteros
4. Eventos sin hora descartados
5. Tenencia 3 sesiones post-anuncio

Cualquier otra variante = EXPLORATORIO etiquetado. Hoy hay uno: sin hora → BMO.

## 7. Caveats pre-registrados

- Universo actual hacia atrás = survivorship que infla; un GO con t apenas
  arriba de 2 es FRÁGIL por construcción.
- 3 años = un régimen alcista; un NO-GO aquí es más creíble que un GO.
- Tenencia de 1 sesión con cierres ignora la apertura: el PEAD mostró que el
  gap es incapturable entrando después; aquí entramos ANTES del gap a
  propósito, así que esta vez sí lo cobramos (ese es el punto de la idea).

## 8. Cómo correrlo

```bash
# Paso 1 — SOLO cobertura. Parar y revisarla antes de leer resultados.
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://quantdesk2.vercel.app/api/fuga-analyze?solo=cobertura&format=md"

# Paso 2 — el veredicto.
#   /api/fuga-analyze?format=md&secret=<CRON_SECRET>
#   ?obs=1 agrega el detalle evento a evento al JSON
```

## 9. Archivos

| Archivo | Qué hace |
|---|---|
| `api/_lib/fuga-analyze.js` | Lógica pura: `CRITERIOS_FUGA`, D/salida, señal, grupos, placebo, clustering, Welch, veredicto, markdown. |
| `api/fuga-analyze.js` | Endpoint: gate, un `SELECT` a Neon, Yahoo ajustado, principal + sensibilidades + exploratorio. |
| `tests/fuga-analyze.test.mjs` | Gate, solo-lectura, cero look-ahead, placebo, criterios pineados, fronteras del veredicto, y sintéticos: fuga → GO · nulo → NO-GO · momentum → NO-GO por (2) · muestra corta → INCONCLUSO. |
