# earnings-beat v2 — "barra vs consenso vigente"

Extiende el experimento earnings-beat (v1: docs/earnings-beat-scope.md) **sin tocarlo**. La Fase 2 de v1 cerró NO-GO el 24-sep: el modelo no le ganaba ni a la tasa por empresa ni a Polymarket a T-24h. v2 **no es otro modelo**. Son tres columnas de aritmética que v1 no tenía, probadas primero sobre un set chico y reciente antes de tocar la tabla histórica.

Papel. Nada se apuesta. `prob_v2` vive solo en el endpoint y en las tablas hasta que haya veredicto: **no va a la tab EARNINGS**. El lint que prohíbe lenguaje de pronóstico sigue vigente, y `tests/earnings-beat-v2.test.mjs` falla si alguna página o script del front menciona v2.

> **Estado al 23-oct-2026.** El set de 22 pasó a ser el **piloto `piloto-oct26`, sin veredicto** (decisión de Lety). Los criterios de abajo quedan escritos como estaban, pero no se aplican. El experimento sigue en **v2.1**: universo abierto, dos reglas (A y B) pre-registradas y un set definido por la cosecha. Ver §"Piloto oct-26" y §"v2.1 — set pre-registrado", al final.

## Por qué existe

Observación del 21–22 oct 2026, sobre los mercados de /finance/earnings que resolvieron esos días. Un lector humano con noticias sacó 2 de 4 (empate con el mercado). Tres reglas aritméticas, sin leer una sola noticia, habrían sacado 5 de 5:

| Mercado | Barra | Regla que lo resolvía | Resultado |
|---|---|---|---|
| META (21-oct) | GAAP > 6.31 | Brecha GAAP conocida por el cargo legal de $9.9B | No (3.83) |
| UNP (22-oct) | GAAP > 3.50 | Costos de fusión de $0.04/trim en cada 10-Q: GAAP = ajustado − 0.04 | No (3.49; ajustado 3.53) |
| PCG (22-oct) | core > 0.43 | La guía anual reafirmada implica Q3 ≈ 0.43, y la barra es ≥ la guía | No (0.41) |
| PG (22-oct) | non-GAAP > 1.94 | Consenso 1.90 + sorpresa mediana 8T (+0.04) = 1.94 → en el borde; 8 de 8 beats | Yes (2.00) |
| AAL (22-oct) | ajustado > −0.34 | Guía de −0.70 a −0.10, medio −0.40; AAL quedó arriba del medio 3 de 4 veces | Yes (−0.28) |

## Hipótesis (pre-registrada)

Tres columnas aritméticas producen una probabilidad con Brier menor que Polymarket a T-24h en la zona 25–75%, y en particular identifican los mercados donde Polymarket está a más de 15 pts:

1. la brecha GAAP/ajustado conocida;
2. el consenso vigente más la sorpresa mediana de la empresa;
3. la barra contra la guía implícita.

### Fórmula

- `estimado_v2`:
  - barra GAAP: `(consenso_vigente ?? consenso_creacion) + sorpresa_mediana_8t − brecha`;
  - barra NONGAAP: `consenso + sorpresa_mediana_8t`, menos solo los cargos marcados `afecta = AMBAS`, que se explican más abajo.
- `prob_v2 = Φ((estimado_v2 − barra − 0.005) / sorpresa_std_8t)`, con clamp a [0.03, 0.97].
  - Si no hay `sorpresa_std_8t`, se usa `0.05 × |barra|` y se marca `std_fallback`.
  - Piso de un centavo: una std de 0 es poca muestra, no certeza.
  - El −0.005 viene de que la barra es estricta y el EPS se publica en centavos.
- `beats_8t` y `metrica_match` viajan en la firma, pero no mueven el número: el encargo no define cómo deberían hacerlo.
- La **guía implícita es una columna, no entra al estimado**. Es lo pre-registrado; meterla ahora sería mover la portería.

### Criterios (sobre los 22) — ya no se aplican: el set es piloto

- **GO**: `Brier(prob_v2) < Brier(prob_pm_t24)` **y**, en la zona `|desacuerdo| > 15 pts`, v2 acierta ≥ 70%.
- **NO-GO**: `Brier(prob_v2) ≥ Brier(prob_pm_t24)`.
- **INCONCLUSO**: faltan más de 4 de 22 por datos, sea porque el símbolo está fuera del universo, porque el consenso o el historial son nulos, o porque no hay precio de Polymarket a T-24h. Igual que en v1: cero datos de frontera es una falla de frontera, no un veredicto.
- Lo que la regla no cubría, declarado antes de mirar:
  - Zona de desacuerdo vacía → INCONCLUSO.
  - Brier mejor pero zona < 70% → no es GO, se reporta NO-GO.

Los criterios están congelados en `CRITERIOS_V2` (`api/_lib/earnings-beat-v2.js`) y pineados por test.

## Set de validación — corte 21-oct-2026 20:00 CT

TSLA 10-20, WDFC 10-21, META 10-21, UNP 10-22, SSNC 10-22, PG 10-22, AAL 10-22, TFX 10-22, PCG 10-22, IMAX 10-22 (barra 0.88), AXP 10-23, SOFI 10-27, BA 10-27, PJT 10-27, CZR 10-27, PYPL 10-27, GOOGL 10-27, TDOC 10-28, AMZN 10-29, LLY 10-29, XOM 10-30, IMAX 11-05 (barra 0.89).

El `market_id` se busca en `pm_earnings_markets` por símbolo y fecha (± 1 día). La resolución de los que ya resolvieron (7: TSLA, WDFC, META, UNP, PG, AAL, PCG) se guarda a mano en `pm_v2_validation`, para que el Brier no dependa de que la API de Polymarket los marque.

## ⚠ Lo que ya se sabe antes de que resuelvan

**El set sale INCONCLUSO por construcción.** 11 de los 22 están fuera del universo de 99 símbolos: WDFC, SSNC, AAL, TFX, PCG, IMAX ×2, SOFI, PJT, CZR y TDOC. El tope es 4. La regla dice no ampliar el universo, y v1 descarta esos mercados al cosechar (`fuera_del_universo_v1`), así que ni siquiera están en `pm_earnings_markets`: no tienen `market_id` ni precio de Polymarket a T-24h. Para que este set pueda dar GO o NO-GO hay que hacer una de dos cosas, y es una decisión de Lety, no de este PR:

- (a) ampliar el universo para estos símbolos;
- (b) congelar un set nuevo, solo con símbolos del universo.

### Qué no reproduce de la tabla de arriba

Aplicada tal como está escrita, la fórmula no reproduce los 5 de 5:

- **AAL y PCG**: v2 no les da número, porque están fuera del universo.
- **PCG**, aun con historial: v2 dice No solo si su sorpresa mediana es ≤ 0.00. PCG suele ganarle al consenso por un centavo, y con +0.01 v2 dice Yes y falla.
  - Lo que resolvía PCG era la guía, y la guía no entra al estimado.
  - Además, la guía implícita con la fórmula del encargo da **0.405–0.415**, no 0.43–0.44: `(1.64 − 0.83) / 2` y `(1.66 − 0.83) / 2`, con un core YTD de 0.83 a junio. Eso refuerza el No, pero sale de otra cuenta.
- **AAL**, aun con historial: v2 dice Yes con cualquier sorpresa mediana ≥ +0.01. La guía (medio −0.40, barra −0.34 «dentro») no ayuda; si entrara, empujaría a No. Lo que resolvía AAL fue «quedó arriba del medio 3 de 4», que no es ninguna de las tres columnas.
- **PG** depende de qué consenso declare la descripción del mercado:
  - Si es 1.94 (= barra, como pide «consenso_creacion == barra»), v2 da Yes.
  - Si es 1.90, como dice la tabla, `1.90 + 0.04 = 1.94 = barra`, y con la regla de empate da 39%: **falla**. Para mercados pasados `consenso_vigente` es null, así que manda el de creación.
- **UNP**: acierta si la sorpresa mediana de UNP es < +0.05 (`3.50 + s − 0.04 ≤ 3.505`).
- **META**: robusto. Daría Yes solo con una sorpresa mediana > +3.30.

`tests/earnings-beat-v2.test.mjs` pinea estos umbrales. Las series de sorpresa del fixture son sintéticas, porque la sesión que escribió esto no tenía acceso a Neon. La verificación real es `GET /api/earnings-beat-v2?validacion=1&format=md` contra `pead_earnings`.

## Tablas (migración: `SCHEMA_V2` = `docs/sql/earnings-beat-v2.sql`)

- `pm_earnings_v2_features`: una fila por `market_id` de `pm_earnings_markets`. La escribe el job diario. No modifica ni `pm_earnings_markets` ni `pead_earnings`.
- `pm_known_gaps`: tiene las columnas `symbol, quarter_end, concepto, brecha_por_accion ≥ 0, afecta, tipo, fuente_url, publicado_en, verificada, nota`.
  - Solo entra lo que esté en un 8-K, un 10-Q o un documento de IR con URL. Una fila sin URL no cuenta.
  - **`afecta`** es una extensión declarada: `'AMBAS'` marca un cargo que la empresa deja también en su non-GAAP, como el IPR&D adquirido de Lilly ($4.57). La brecha GAAP−ajustado de LLY es 0, pero el cargo pega igual en la barra.
- `pm_company_guidance`: guía trimestral, o anual con `ytd_reportado` y `trimestres_restantes`. La guía implícita se calcula como `(guía anual − YTD) / restantes`.
- `pm_v2_validation`: los 22, con la barra y la métrica para los que no están en `pm_earnings_markets`, y la resolución a mano.

`quarter_end` es el fin del trimestre calendario anterior a la fecha del mercado. Es una aproximación declarada para fiscales no calendario como WDFC.

Las **semillas** (`docs/sql/earnings-beat-v2.sql`) se corren a mano una vez y son idempotentes. Todas entran con `verificada = false`: las URL se encontraron por búsqueda y nadie abrió el documento. Las que no tienen documento exacto apuntan al índice de 8-K/10-Q de EDGAR. Antes del 5-nov, cada una se abre y se marca.

Una en particular: **META**. El encargo habla de un 8-K de agosto que pre-anunciaba el cargo, y ese 8-K no apareció. El único documento primario con los $9.9B que encontré es el exhibit 99.1 de resultados de Q3, que es *posterior* al mercado.

## Consenso vigente

Es el `estimatedEPS` de Alpha Vantage `EARNINGS` del trimestre sin reportar. Lo captura el job diario, **solo desde que se prende** y solo mientras falten más de 24 h para el reporte. No se rellena hacia atrás: para los mercados pasados queda null y se usa el de creación.

- La captura está **apagada por default** (`EARNINGS_V2_VIGENTE_ENABLED=1` la prende).
  - El cupo de AV (25/día) es compartido y hoy es del wheel (docs/wheel-fase0.md §4.3).
  - Prendida, gasta como mucho 5 llamadas por corrida y respeta `pead_api_budget`.
- AV no publica el estimado del trimestre siguiente para todos los símbolos ni con la misma anticipación. Cuando falta, el job lo dice (`av_sin_estimado_del_trimestre`) y sigue.

## Endpoint

| Ruta | Qué devuelve |
|---|---|
| `GET /api/earnings-beat-v2?format=md&secret=…` | Los mercados abiertos hoy, ordenados por \|desacuerdo A\| descendente. |
| `GET /api/earnings-beat-v2?resueltos=1&format=md` | Los resueltos, con `acierto_A`, `acierto_B` y `acierto_pm`. Acierto = el lado > 50% coincide con la resolución. |
| `GET /api/earnings-beat-v2?validacion=1&format=md` | El piloto de 22, con A y B, **sin veredicto**. |
| `GET /api/earnings-beat-v2?validacion=v21&format=md` | El set v2.1 y su veredicto (provisional hasta el 31-dic). |
| `GET /api/earnings-beat-v2?job=mercados_v2` | Cron `20 22 * * *`, latido `earnings-beat:v2-mercados`. Cosecha sin universo. |
| `GET /api/earnings-beat-v2?job=hist[&symbols=AAL,PCG]` | Cron `50 22 * * *`, latido `earnings-beat:v2-hist`. Historial de AV; apagado sin `EARNINGS_V2_HIST_ENABLED=1`. |
| `GET /api/earnings-beat-v2?job=diario` | Cron `55 23 * * *`, latido `earnings-beat:v2`. Features + consenso vigente. |

Los mercados se leen de `pm_earnings_markets_v2` y, para lo que esa cosecha todavía no vio, de `pm_earnings_markets` (v1). En la vista de abiertos, `prob_pm` es el precio válido a T-24h si ya existe. Si no existe, es el último precio de Gamma, marcado `prob_pm_fuente = gamma_ahora`. Las vistas no escriben datos, pero sí crean las tablas si faltan (antes de la primera cosecha v2.1, la unión con v1 fallaría).

## Piloto oct-26 (sin veredicto)

El set de 22 se conserva en `pm_v2_validation` con `set = 'piloto-oct26'`. **No tiene veredicto** y la fórmula no se ajusta después de haber visto estos datos. Lo valioso fue lo que mostró: el "5 de 5" de la observación del 21–22 oct **no aguanta con las reglas escritas**.

Tabla de los 7 resueltos tal como se reportó el 22-oct. Las series de sorpresa de META, UNP y PG son **sintéticas**: esa sesión no tenía acceso a Neon. Ninguno tenía precio de Polymarket a T-24h en la tabla.

| Mercado | v2 dijo | Salió | Nota |
|---|---|---|---|
| TSLA 10-20 | sin número (sin barra en la semilla) | Yes (0.48) | |
| WDFC 10-21 | sin número (fuera del universo) | No (1.06) | |
| META 10-21 | 3% | No (3.83) | Acierta; robusto hasta una sorpresa mediana de +3.30. |
| UNP 10-22 | 35% (mediana sintética +0.03) | No (3.49) | Acierta solo si la mediana real es < +0.05 (con brecha 0.04). |
| PG 10-22 | 97% si el consenso de la descripción es 1.94 | Yes (2.00) | Con consenso 1.90 da 39% y falla. |
| AAL 10-22 | sin número (fuera del universo) | Yes (−0.28) | Ninguna de las tres columnas explica el Yes. |
| PCG 10-22 | sin número (fuera del universo) | No (0.41) | Lo resolvía la guía, que no estaba en la fórmula. |

Con v2.1, el piloto se vuelve a mostrar con A y B (`?validacion=1`) a medida que llegue el historial de AV. Sigue sin veredicto.

Cambios en las semillas del 23-oct, con las URL que abrió Lety (`docs/sql/earnings-beat-v2-1.sql`):

- **UNP**: la brecha pasa a **0.05**, la del último 8-K antes del mercado (Q2 2026, $35M). La de Q3 real fue 0.04 y no se usa, porque es posterior.
- **META**: la fuente es el comunicado del 26-ago citado por CNBC (verificada); el número final de $9.9B está en el 8-K de Q3.
- **GOOGL**: PriceRunner se reconoció en Q2, así que la brecha de Q3 es 0 (10-Q Q2, nota 10, verificada). La multa DMA queda `verificada = false`: no hay documento primario.
- **LLY, AAL, PCG, AXP, PYPL, TDOC**: verificadas. PYPL guarda el texto literal ("low-single digit decline"); el rango 1.30–1.32 es interpretación.
- **SSNC**: sigue sin verificar. La URL del 8-K del 23-jul está, pero desde la sesión no se puede abrir sec.gov.

## v2.1 — set pre-registrado

**Corte: 23-oct-2026**, el día que se abre el PR de v2.1. El encargo pedía la fecha de merge, pero el PR se abre listo para merge y sin pushes después, así que la fecha no se puede escribir en el código una vez conocida. Se fija la de apertura, que es cuando quedaron escritos los criterios. Si el merge cae después, el set incluye además los mercados creados entre la apertura y el merge: es una ventana más ancha, no una elegida mirando datos. Congelado en `CRITERIOS_V21` y pineado por test.

### Universo

Todos los símbolos que tengan mercado de earnings en Polymarket, no solo los 99 de PEAD. La cosecha de v1 no se toca; v2.1 tiene la suya:

- **`?job=mercados_v2`** escribe en `pm_earnings_markets_v2`. El esquema es el mismo que v1 (se deriva de su DDL) más `universo_pead`.
  - Usa la búsqueda por símbolo, el camino que ganó en la Fase 0, sobre una lista abierta: los 99, el piloto, todo símbolo ya cosechado y los que se pidan con `&symbols=`.
  - La búsqueda por frase corre igual y es la que trae símbolos nuevos.
  - La lista rota por día para cubrirse entera aunque no entre en una corrida.
  - El símbolo se resuelve solo por ticker explícito (`(AAL)`, `$AAL`) o por alias de nombre: sin universo, el mapa de nombres de Finnhub mete coincidencias absurdas.
  - Captura el Yes a T-24h como v1 y completa los pendientes con el tiempo que sobra.
- **`?job=hist`** guarda el historial en `pm_v2_hist`.
  - Hace una llamada a AV `EARNINGS` por símbolo, que devuelve unos 20 trimestres.
  - Los símbolos que están en `pead_earnings` no se piden: se leen de ahí.
  - Tope de 10 llamadas por corrida, respeta el cupo diario compartido (`pead_api_budget`, 25/día) y está apagado sin `EARNINGS_V2_HIST_ENABLED=1`.
  - Un símbolo con historial de menos de 80 días no se vuelve a pedir (salvo `&forzar=1`). Si AV dice rate limit, la corrida para.
  - **Costo de llenar el piloto: 10 llamadas.** Son 11 mercados fuera del universo PEAD pero 10 símbolos distintos (IMAX aparece dos veces), así que entran en una sola corrida y usan 10 de las 25 llamadas diarias compartidas.
- **`reported_date`** se agregó a `pm_v2_hist` aunque no estaba en el encargo: sin esa fecha no hay forma de usar solo los trimestres reportados antes del mercado (cero look-ahead).
- **Limitación, documentada y no resuelta:** AV no distingue GAAP de non-GAAP en `reportedEPS`. Para los símbolos con historial de `pm_v2_hist`, `sorpresa_metrica_match = null`.

### Las dos reglas (las dos pre-registradas, ninguna se elige después)

- **prob_A**: la fórmula de v2 tal cual. `estimado_A = consenso + sorpresa mediana 8T − brecha`.
- **prob_B**: igual, pero si hay guía trimestral o implícita de la anual: `estimado_B = promedio(estimado_A, punto medio de la guía)`.
  - Sin guía, `prob_B = prob_A`.
  - La guía se usa solo si es de la **misma métrica** que la barra (GAAP con GAAP, non-GAAP con non-GAAP). Es la única regla que agregué, porque promediar una guía GAAP con una barra non-GAAP mezcla dos números distintos. Una guía de otra métrica no entra y `prob_B = prob_A`.
- Las dos usan la misma Normal, la misma regla de empate de medio centavo, la misma std de respaldo y el mismo clamp.

Lo que la fórmula de B hace con el piloto, pineado en el test con series sintéticas:

- **PCG** con sorpresa +0.01: A da Yes (falla) y B, con la guía 0.41, da No (acierta).
- **AAL**: A da Yes (acierta) y B, con la guía −0.40, da No (falla).

Ninguna de las dos reglas saca los dos.

### Criterios

El set son todos los mercados de earnings de Polymarket creados entre el **23-oct** y el **30-nov-2026** que resuelvan antes del **31-dic-2026**. No hay lista a mano: lo define la cosecha.

- **GO**: `Brier(prob_A) < Brier(PM a T-24h)` **o** `Brier(prob_B) < Brier(PM a T-24h)`, sobre ≥ 40 mercados con todos los datos (A, B, PM a T-24h y resolución), **y** la regla ganadora acierta ≥ 65% donde |desacuerdo| > 15 pts.
- **NO-GO**: ninguna de las dos le gana al Brier de PM con ≥ 40 mercados.
- **INCONCLUSO**: menos de 40 mercados con datos completos al 31-dic. Es una falla de frontera, no un veredicto.
- Si las dos reglas pasan, se reporta cuál tiene mejor Brier, pero **no se elige** hasta un tercer set.
- Lo que la regla no dice, declarado antes de mirar (igual que en v2):
  - Una regla ganadora con la zona de desacuerdo vacía no cuenta como ganadora que pase.
  - Si gana el Brier pero ninguna llega al 65% en la zona, es NO-GO.
  - Antes del 31-dic el veredicto se marca `(provisional)`.
