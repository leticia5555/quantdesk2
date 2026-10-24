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

### Frontera (25-oct): las 68 abiertas con `consenso_vigente` null

Con la captura prendida desde el 24-oct, las 68 filas abiertas seguían sin consenso vigente. Sin esa columna, A queda en "barra + sorpresa", porque la barra es el consenso de creación. En nombres estables da ~97%. Es lo pre-registrado, no un error de fórmula, y no se toca.

**Qué se sabe desde el código:**

- **Job:** `?job=diario`, cron `55 23 * * *`.
- **Endpoint:** Alpha Vantage `function=EARNINGS`. Toma el trimestre que viene con `reportedEPS` vacío y `estimatedEPS` lleno, con `fiscalDateEnding` a ± 45 días del fin de trimestre del mercado.
- **Tope:** 5 llamadas por corrida, de la fecha más cercana a la más lejana. Con 68 abiertos, muchos símbolos no se piden ningún día.
- **Rastro:** el latido no guardaba qué contestó AV. Ahora `cron_heartbeat.detail` de `earnings-beat:v2` trae `captura.por_estado` y muestras por símbolo.

**Hipótesis, NO verificada desde la sesión** (no hay acceso a AV): `EARNINGS` solo lista trimestres ya reportados. Si es así, todas las capturas terminan en `av_sin_estimado_del_trimestre` y la columna nunca se llena.

Para verificarlo hay `?job=vigente_diag&symbols=CL,VZ&calendario=1`. Gasta 3 llamadas de AV y no escribe nada. Devuelve:

- los 3 trimestres más nuevos que trae `EARNINGS`;
- cuáles vienen sin reportar;
- qué eligió la captura;
- con `&calendario=1`, lo que trae `EARNINGS_CALENDAR` para esos símbolos.

**Fuente alternativa más barata, si se confirma:** Alpha Vantage `function=EARNINGS_CALENDAR&horizon=3month`. Es **una llamada al día para todos los símbolos** que reportan en los próximos 3 meses: un CSV `symbol,name,reportDate,fiscalDateEnding,estimate,currency`. El parser ya está (`parseCalendarioCsv`) y lo usa el diagnóstico. Lo que hay que ver con el diagnóstico antes de cambiar la captura:

1. Si `estimate` viene lleno para los símbolos del set.
2. Si es el mismo consenso que el `estimatedEPS` de `EARNINGS` (EPS ajustado).
3. Si se mueve de un día a otro, o es una foto vieja.

Cambiar la captura a esa fuente es otro PR: cambia de dónde sale el dato, no la fórmula.


## Endpoint

| Ruta | Qué devuelve |
|---|---|
| `GET /api/earnings-beat-v2?format=md&secret=…` | Los mercados abiertos hoy, ordenados por \|desacuerdo A\| descendente. |
| `GET /api/earnings-beat-v2?resueltos=1&format=md` | Los resueltos, con `acierto_A`, `acierto_B` y `acierto_pm`. Acierto = el lado > 50% coincide con la resolución. |
| `GET /api/earnings-beat-v2?validacion=1&format=md` | El piloto de 22, con A y B, **sin veredicto**. |
| `GET /api/earnings-beat-v2?validacion=v21&format=md` | El set v2.1 y su veredicto (provisional hasta el 31-dic). |
| `GET /api/earnings-beat-v2?job=mercados_v2` | Cron `20 22 * * *`, latido `earnings-beat:v2-mercados`. Cosecha sin universo. |
| `GET /api/earnings-beat-v2?job=hist[&symbols=AAL,PCG]` | Cron `50 22 * * *`, latido `earnings-beat:v2-hist`. Historial de AV; apagado sin `EARNINGS_V2_HIST_ENABLED=1`. |
| `GET /api/earnings-beat-v2?job=vigente_diag&symbols=CL,VZ[&calendario=1]` | Diagnóstico del consenso vigente: qué trae AV `EARNINGS` (y `EARNINGS_CALENDAR`) para esos símbolos. Gasta una llamada por símbolo, más una por el calendario; no escribe nada. |
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

### Métrica y cruce del piloto (24-oct)

El primer `?validacion=1` real dio **9 de 22 en `sin_metrica`**: TSLA, SSNC, TFX, IMAX ×2, BA, PJT, PYPL, LLY y XOM. Además, IMAX 10-22 salió sin mercado ni consenso.

**Las 9 descripciones son la misma plantilla de Polymarket.** Está guardada verbatim en `tests/fixtures/earnings-beat-v2-plantilla-oct26.mjs`. El slug dice `nongaap-eps` y la oración que define el mercado dice "reports non-GAAP EPS greater than…", pero la descripción trae dos menciones a GAAP que el lector v1 no aparta. Como la descripción nombra las dos métricas, el lector la marca en conflicto con el slug y la métrica queda indeterminada.

Estas son las redacciones exactas:

1. «…; **or, if not published there, according to the GAAP EPS provided by SeekingAlpha.**» Es la cola, después del `;`, de un respaldo condicional («If no such figure is published within 96h…»). v1 corta en el `;` y la cola no empieza con «If», así que no la reconoce como condicional.
2. «**Note: For the purposes of this market, IFRS EPS will be treated as GAAP EPS.**» Es una nota de definición.

**Arreglo, solo en v2 (el lector v1 y sus pruebas no se tocan):**

- Si v1 ve una sola métrica, esa es.
- Si v1 ve las dos, decide la **oración principal**: «This market will resolve to "Yes" if X reports <métrica> EPS greater than $…». Es la regla por la que el mercado resuelve.
- La oración principal solo decide si el slug y la pregunta no la contradicen.
- Si la contradicen, si no hay oración principal o si la principal nombra las dos métricas, la fila queda `metrica_ambigua` (un faltante distinto de `sin_metrica`). No se adivina.
- Ninguna de las 9 resultó ambigua: las 9 dicen non-GAAP en la oración principal y en el slug.

**Consenso de creación:** en esta plantilla el monto está a más de 60 caracteres de "consensus" («The Street consensus estimate for Tesla’s non-GAAP EPS for the relevant quarter is $0.43 as of market creation»). v2 lee ahora esa oración entera. En producción no se notaba porque caía al `consensus_pm` de la tabla.

**Cruce del piloto:** antes elegía el primer mercado del símbolo con fecha de tabla a ± 1 día. Tenía tres fallas:

- **IMAX 10-22:** su mercado (slug `…-10-22-2026-0pt88`) tiene fecha de tabla 11-05, así que no lo encontraba.
- **LLY:** se colaba el mercado de 7.01, creado el 23-oct, después del corte.
- **XOM:** había dos mercados con la misma fecha de tabla.

Ahora (`eligeMercadoPiloto`):

1. Solo cuentan los mercados que existían al corte (21-oct 20:00 CT).
2. Entre esos gana el que tiene la **fecha del slug** igual a la de la lista; si ninguno, la fecha de tabla ± 1 día.
3. Si quedan varios, desempata la barra de la semilla; si todavía quedan, el más viejo, y la fila se marca `ambiguo`.
4. El cruce elegido viaja en `piloto_cruce`.

XOM 10-30 depende de cuándo nació el mercado de 4.11 (`5999289`): si existía al corte, es ese; si nació después, queda el de 3.87 (`5778597`).

**Qué debería dar con los insumos reales del 23-oct.** Es una predicción hecha con las mismas sorpresas, std, brecha y guía del JSON; la cifra real es la del próximo `?validacion=1`:

| Mercado | prob A | prob B |
|---|---|---|
| TSLA 10-20 | 50% | 50% |
| SSNC 10-22 | 76% | 51% |
| TFX 10-22 | 57% | 57% |
| IMAX 10-22 | 83% | 83% |
| IMAX 11-05 | 83% | 83% |
| BA 10-27 | 46% | 46% |
| PJT 10-27 | 68% | 68% |
| PYPL 10-27 | 92% | 67% |
| LLY 10-29 | 3% | 3% |
| XOM 10-30 | 70% | 70% |

Ninguna fila queda sin número.

- **TSLA** da exactamente 50%: la regla de acierto lo cuenta como fallo (se pre-registró así).
- **LLY** da 3% por el cargo de IPR&D de $4.57 marcado `afecta = AMBAS`, que se resta también de la barra non-GAAP. Es la columna (1) haciendo su trabajo, igual que con META. Se anota y no se toca.

### Observación del piloto: barra arriba de la guía (post-hoc, NO es regla)

> **Post-hoc, no es regla.** Se anotó después de ver los resultados. No cambia ninguna fórmula ni ningún criterio, y no cuenta para el veredicto de v2.1. Si algún día se quiere probar, va pre-registrado en un set nuevo.

En los dos resueltos del piloto donde la barra quedó **arriba** del rango de la guía, A falló y B acertó o quedó casi en 50%:

| Mercado | Barra | Guía Q implícita | Salió | prob A | prob B |
|---|---|---|---|---|---|
| SSNC 10-22 | 1.80 | 1.73–1.79 | No | 76% ✗ | 51% (casi) |
| PCG 10-22 | 0.43 | 0.405–0.415 | No | 60% ✗ | 42% ✓ |

Las cifras de SSNC son las calculadas el 24-oct con los insumos reales del `?validacion=1` del 23-oct, una vez corregida la métrica. Se confirman con el próximo `?validacion=1`.

El siguiente caso es **PYPL 10-27**: barra 1.34, guía 1.30–1.32, A ~92%, B ~67%. Dos casos no son evidencia; se anotan para no olvidarlos.

### `anunciado_en` (24-oct): dato, no regla

`pm_known_gaps.anunciado_en` registra cuándo se anunció cada cargo por primera vez:

| Cargo | Anunciado |
|---|---|
| META | 26-ago |
| LLY | 7-oct |
| UNP | 23-jul (8-K de Q2) |
| GOOGL DMA | 23-jul |

La fila marca con `§` (`brechas_anunciadas_antes_de_creacion` en el JSON) cuando el mercado nació después del anuncio. **La brecha se aplica igual.**

Se evaluó la regla "si el mercado se creó después del anuncio, el consenso ya trae el cargo y la brecha es 0", y se descartó por META. Su mercado se creó el 16-oct, después del anuncio, con barra GAAP 6.31 igual al consenso de creación, y salió 3.83. El consenso no traía el cargo: con esa regla v2 habría dicho ~83% en un mercado que resolvió No, en vez del 3% que acertó.

Para LLY el mercado de 7.49 casi seguro nació después del 7-oct (los de su tanda son del 16-oct). Queda marcado `§` y en 3%. Se sabrá el 29-oct si el consenso traía el cargo.

### Semillas para el set v2.1 (24-oct, `docs/sql/earnings-beat-v2-3.sql`)

Se cargaron antes de que resuelvan los mercados, todas con documento. Las fórmulas no cambian.

| Símbolo | Tabla | Qué | Verificada |
|---|---|---|---|
| MRK | brecha | IPR&D de SciBrunch, 0.13, `afecta = AMBAS`, anunciado el 28-sep | sí |
| HLT | guía Q3 | 2.28–2.34 | **no**: la URL del 8-K está, pero la sesión no puede abrir sec.gov |
| NET | guía Q3 | 0.34 (punto) | sí |
| EBAY | guía Q3 | 1.36–1.42 (el 8-K del 22-oct dice "above guidance ranges") | sí |
| MRK | guía anual | 2.66–2.76, YTD −1.41 → Q3 implícito 2.035–2.085 | sí |
| CL | guía anual | "mid-single-digit growth" sobre 3.69 → 3.84–3.91 (interpretación), YTD 1.97 → Q3 implícito 0.935–0.97 | **no**, pendiente de confirmar |

No se cargaron, porque no tienen guía de EPS: YELP, CBOE, CVX, IVZ, HGV, RDDT, DKNG y COIN.

**Fechas reales de reporte.** En varios casos el slug de Polymarket trae otra fecha:

| Empresa | Reporta |
|---|---|
| GOOGL | 28-oct |
| EBAY | 28-oct |
| HGV | 29-oct |
| RDDT | 29-oct |
| YELP | 5-nov |
| DKNG | ~5-nov |
| IMAX | 5-nov |

Se documentan, no se cargan: ninguna fórmula lee una fecha de reporte aparte, y la fecha del slug solo se usa para cruzar el piloto.

**IMAX 10-22 del piloto.** IMAX reporta el 5-nov, así que ese mercado (barra 0.88) no podía resolver el 22. Resuelve contra el **mismo** reporte que IMAX 11-05 (barra 0.89): son dos barras sobre un solo evento, no dos datos independientes. Quedó anotado en `pm_v2_validation.nota`; el piloto no tiene veredicto y no se toca nada más.

**MRK, para el registro (no cambia la fórmula).** La guía anual es de julio, anterior al cargo del 28-sep, así que no lo trae adentro. En cambio, el estimado A sí resta los 0.13 (`AMBAS`). prob B promedia entonces un A con el cargo y una guía sin el cargo.

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
  - **Orden de la cola (24-oct)**: primero los símbolos con un mercado abierto que resuelve antes; después los que solo tienen mercados ya pasados, del más reciente al más viejo; al final los que no están en la cosecha. Los empates se resuelven por orden alfabético. Con `&symbols=` se respeta el orden pedido. Antes iba por orden de aparición: con 46 en cola y 10 llamadas por corrida, HLT (reporta el 27-oct) se quedaba sin historial.
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
