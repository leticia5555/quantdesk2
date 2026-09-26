# Enfriamiento de analistas → ¿predice beat/miss?

**PRE-REGISTRO.** Todo lo que sigue se escribió y se congeló en código ANTES de
correr una sola consulta. Los umbrales viven en `CRITERIOS_GRADES`
(`api/_lib/grades-backtest.js`) y están pineados por test: mover una portería
rompe un test y se ve en el diff.

Existe porque elegir el umbral después de ver el p-valor es exactamente cómo se
fabrica un hallazgo. Es el mismo patrón del PEAD y del earnings-beat.

---

## La pregunta

> ¿El enfriamiento de los analistas entre T-3 y T-1 meses antes del reporte
> predice beat/miss?

## Lo que esto NO es, escrito antes del resultado

**Aunque salga GO, esto es información PÚBLICA que el mercado ya ve**: las notas
de los analistas se publican. No implica ventaja contra Polymarket — esa
pregunta ya se corrió y salió **NO-GO** (Fase 2 del earnings-beat,
`docs/earnings-beat-scope.md`). Sería un **feature descriptivo, no una señal de
apuesta**.

Va en GO, en NO-GO y en INCONCLUSO. Hay test de que la frase viaja en los tres.

---

## El dato: por qué `grades-historical` y no lo otro

`FMP /stable/grades-historical` es **point-in-time**: una fila por MES con los
conteos de strongBuy/buy/hold/sell/strongSell, y **las filas viejas no se
sobrescriben**. Verificado con NKE: 6 strongBuy + 20 buy en dic-2025 contra
1 + 10 en sep-2026.

Es lo ÚNICO point-in-time que se encontró. Lo que NO sirve:

| Fuente | Por qué no |
|---|---|
| `analyst-estimates` de FMP | Una fila por período fiscal con el número de **hoy**. Un backtest con eso mide el futuro. |
| Alpha Vantage | Lo mismo: el estimado de hoy pegado al trimestre de ayer. Es la deuda que ya está anotada en `docs/earnings-beat-scope.md` §0.2. |

### La key

Es la **misma `FMP_API_KEY`** que ya usa `api/_lib/arena-universe.js`: **no hace
falta una env var nueva** si ya está puesta en el entorno donde corre esto. Y la
cicatriz que esa frontera ya pagó: **en Vercel una env var vive por ENTORNO** —
que esté en Production no la pone en Preview. Sin key, la respuesta dice
`sin_key` con ese detalle, no "sin datos".

### Las otras dos cicatrices de FMP que se heredan

1. **HTTP 200 con un objeto de error.** FMP contesta 200 y pone `Error Message`
   en el cuerpo. Sin mirarlo, "FMP no contestó" se vuelve indistinguible de "FMP
   contestó y dijo por qué". Hay test.
2. **Los primeros bytes SIEMPRE**, salga bien o mal: es donde FMP explica.

Y una propia: el `limit` va **alto a propósito** (1000). La Fase 0 tiene que
MEDIR hasta dónde llega la historia, y un límite bajo contestaría la pregunta
con el límite — es la cicatriz del `limit=5` del censo de Polymarket, que
disfrazó un tope propio de un hallazgo sobre la fuente. Si alguna serie toca el
límite, se avisa (`alguno_en_el_tope_del_limit`) en vez de concluir.

---

## FASE 0 — el censo, antes de nada

`GET /api/grades-backtest?fase=0` — mide si hay con qué. **No dictamina la
señal** (hay test de que no trae veredicto ni terciles).

1. **Cuántos meses de historia** devuelve `grades-historical`: min / mediana /
   max por símbolo, y el rango de fechas.
2. **Cobertura del universo v0**: cuántos de los 99 tienen grades. Solo se piden
   los símbolos que además tienen algún evento etiquetado — pedirle a FMP los 99
   cuando 40 no tienen evento gasta cuota para nada.
3. **Rate limits MEDIDOS, no asumidos**: pedidos, 429 contados **aparte** de un
   `http_error` cualquiera, latencia min/mediana/max, req/s, y **la cuota que
   gastó la corrida**. Si llegan 5 × 429 se corta y se declara: seguir pegándole
   gastaría cuota para aprender lo mismo dos veces.
4. **El tamaño de muestra REAL**: cuántos eventos tienen ventana válida.

**Si la muestra queda bajo 100 → INCONCLUSO y se para.** El candado está en
`analizaGrades`, no en la buena voluntad de quien lee.

### Una decisión sobre la muestra, dicha en voz alta

El encargo dice "los 231 mercados de `pm_earnings_markets`". Los 231 son los que
pasan **los filtros de la Fase 2**: precio válido a T-24h y volumen ≥ $500.

Este backtest usa **todos los mercados con outcome resuelto**, sin esos dos
filtros, porque **la validez del PRECIO es un requisito de la pregunta del
precio y acá el precio no juega**: exigirlo tiraría eventos etiquetados sin
ninguna razón, y el tamaño de muestra es justo lo que está en duda.

Los **dos conteos** van en la respuesta (`con_outcome` y
`con_filtros_de_la_fase_2`) para que la diferencia se pueda auditar y, si el
criterio tiene que ser el otro, se vea exactamente cuánto cambia.

---

## FASE 1 — el backtest

### La señal, definida antes de ver datos

```
score = (2·strongBuy + buy − sell − 2·strongSell) / total_analistas
```

`total_analistas` **incluye los HOLD**. No es un detalle: son analistas que
cubren el nombre y decidieron no mojarse. Dejarlos fuera del denominador haría
que una casa que pasa de *buy* a *hold* **suba** el score — lo contrario de
enfriarse. Hay test con ese caso exacto.

Un mes **sin analistas** da `null`, no cero: cero es "los buy y los sell se
cancelan", que es otra cosa.

- **delta = score(T-1) − score(T-3)**. Negativo = **enfriamiento**.
- Terciles por delta. El de abajo es `enfriamiento`, el de arriba
  `calentamiento`.

### La ventana, y sus tolerancias

La serie de FMP es **mensual**, así que:

- **T-1** = la última fila con fecha **estrictamente anterior** al reporte.
- **T-3** = la fila más cercana a 90 días antes del reporte, **entre las que
  dejan una ventana T-1↔T-3 dentro del rango**.

| Tolerancia | Valor | Por qué |
|---|---|---|
| `max_dias_t1` | 45 | Una última fila más vieja que eso no es "T-1". |
| `min_dias_ventana` | 45 | Una ventana de 14 días no es un cambio de 3 meses. |
| `max_dias_ventana` | 135 | Ni una de 5 meses. |
| `min_meses_grades` | 3 | Menos de tres filas previas no arma la ventana. |

**El orden de la búsqueda importa**, y la primera versión lo tenía al revés:
elegía la fila más cercana a 90 días y *después* miraba la ventana, así que un
reporte de fin de mes se descartaba aunque hubiera otra fila que sí servía. Las
tolerancias son las mismas; lo que cambió es que la búsqueda no se rinde en el
primer candidato. Hay test con el reporte del 27 de julio.

### CERO LOOK-AHEAD

El corte es **estricto**: `fecha < report_date`. Una fila fechada EL DÍA del
reporte ya puede contener la reacción de los analistas al reporte.

El test que lo prueba no es cosmético: mueve esa misma fila **un día antes** y el
delta **cambia de signo**. Si el corte fuera `<=`, el backtest mediría la
reacción y la llamaría predicción.

### El test estadístico

z de dos proporciones con varianza **agrupada**, p-valor a **DOS colas**.

Dos colas porque la pregunta pre-registrada es "¿difiere?", no "¿es menor?".
Elegir una cola después de ver de qué lado salió duplicaría la significancia
gratis — mover la portería con otro disfraz.

El `erf` se compara contra **valores de tabla** en los tests, y no por prolijidad:
la primera versión agrupó mal el polinomio y daba `p(z=1.96) = 0.061` en vez de
`0.050` — un p-valor equivocado justo en el umbral del veredicto.

### Criterio de GO (congelado)

**GO** si las tres cosas a la vez:

| Requisito | Umbral |
|---|---|
| Diferencia entre terciles extremos | ≥ **10 puntos porcentuales** |
| p-valor (dos colas) | < **0.05** |
| Eventos por tercil extremo | ≥ **30** |

Si no → **NO-GO**. Si la muestra total queda bajo **100** → **INCONCLUSO**.

**Baseline obligatorio:** la tasa base de beats del universo = **0.8182**. Una
señal que no se aparta de eso no es una señal: es la tasa base con otro nombre.
Va en la respuesta al lado de la tasa observada en la muestra — si la muestra ya
no se parece al universo, la comparación con el baseline no dice lo que parece.

### Dos cosas que un veredicto honesto tiene que distinguir

1. **NO-GO por TAMAÑO de tercil** no es "no hay señal". El criterio
   pre-registrado dice NO-GO y así queda, pero un tercil chico es **falta de
   evidencia**, no evidencia de ausencia, y el `porque` lo dice.
2. **Un tercil extremo VACÍO es INCONCLUSO, no NO-GO.** Pasa cuando los deltas se
   apilan en pocos valores: los cortes coinciden con esos valores y, como la
   asignación es por `<` estricto, el tercil de abajo queda sin nadie. Sin ese
   chequeo el test de proporciones recibía n = 0, devolvía p-valor `null`, y el
   veredicto salía NO-GO — **un NO-GO hecho de nulls, que es peor que no
   contestar**. Hay test.

Los empates **no se parten**: la asignación es por valor, así que dos eventos con
el mismo delta nunca caen en terciles distintos. El precio es que los terciles
pueden quedar desparejos, y por eso se publica el **n real** de cada uno.

---

## Uso

```bash
# FASE 0 primero, siempre:
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://quantdesk2.vercel.app/api/grades-backtest?fase=0" | jq
# en el navegador:
#   /api/grades-backtest?fase=0&format=md&secret=<CRON_SECRET>
#   /api/grades-backtest?format=md&secret=<CRON_SECRET>        ← la Fase 1
# opcional:
#   &simbolos=20   recorta el censo para no quemar cuota
#   &eventos=1     detalle evento por evento
```

**CUOTA:** una corrida completa son ~1 request a FMP **por símbolo con eventos**.
El plan gratis de FMP suele cortar por DÍA, así que conviene empezar con
`?simbolos=20` y leer `cuota_gastada_requests` antes de correr el censo entero.

**Garantías:** cero writes a Neon (dos `SELECT`), sin `ensureSchema()` ni
`beat()` — latir en un endpoint de análisis enmascararía un cron muerto —, gate
`CRON_SECRET`, `maxDuration = 300` **con su entrada en `vercel.json`** (sin ella
el archivo pide 300 y el glob concede 60: lo atrapó el lint
`tests/arena-timeouts.test.mjs`, no yo). **Esta tanda no crea tabla**: los grades se
leen en vivo y no se guardan. El lib de análisis es **puro**: sin `fetch`, sin
DB, testeado con fixtures.

---

## Archivos

| Archivo | Qué |
|---|---|
| `api/_lib/grades-backtest.js` | Lógica PURA: `CRITERIOS_GRADES` congelados, score, ventana sin look-ahead, terciles, z de proporciones, veredicto, resumen. |
| `api/_lib/fmp-grades.js` | Frontera de red con FMP. Clasifica y no lanza; hereda las cicatrices de `arena-universe.js`. |
| `api/grades-backtest.js` | Endpoint: gate, los dos SELECT, la cosecha de grades con sus límites medidos, Fase 0 y Fase 1. |
| `tests/grades-backtest.test.mjs` | Fixtures. Criterios pineados, cero look-ahead, p-valores contra tabla, GO/NO-GO/INCONCLUSO. |
| `tests/grades-backtest-e2e.test.mjs` | El endpoint con Neon y FMP simulados: SELECT-only, los 429, la key ausente, el 200 con error. |

## Fuera de esta tanda / backlog

- **Guardar los grades en Neon.** Hoy se leen en vivo. Si la Fase 0 dice que hay
  con qué y la cosa se repite, una tabla PIT propia evita depender de que FMP
  siga sirviendo la historia.
- **Otros horizontes** (T-6 → T-1, T-2 → T-0). v1 mide T-3 → T-1 porque es el
  encargo; el resto sería barrido de parámetros y acá no se barre nada.
- **El score con otros pesos.** Los pesos están congelados. Probar varios y
  quedarse con el mejor es mover la portería cinco veces.
- **Muestra desde `pead_earnings`** en vez de los mercados de Polymarket: daría
  más eventos para el mismo período de grades. NO se hace en esta tanda; si la
  Fase 0 sale INCONCLUSO por muestra, el número para decidirlo va a estar medido.
