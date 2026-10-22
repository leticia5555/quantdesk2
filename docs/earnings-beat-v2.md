# earnings-beat v2 — "barra vs consenso vigente"

Extiende el experimento earnings-beat (v1: docs/earnings-beat-scope.md) **sin tocarlo**. La Fase 2 de v1 cerró NO-GO el 24-sep: el modelo no le ganaba ni a la tasa por empresa ni a Polymarket a T-24h. v2 **no es otro modelo**. Son tres columnas de aritmética que v1 no tenía, probadas primero sobre un set chico y reciente antes de tocar la tabla histórica.

Papel. Nada se apuesta. `prob_v2` vive solo en el endpoint y en las tablas hasta que haya veredicto: **no va a la tab EARNINGS**. El lint que prohíbe lenguaje de pronóstico sigue vigente, y `tests/earnings-beat-v2.test.mjs` falla si alguna página o script del front menciona v2.

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

### Criterios (sobre los 22, cuando resuelvan, aprox. 5-nov)

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
| `GET /api/earnings-beat-v2?format=md&secret=…` | Los mercados abiertos hoy, ordenados por \|desacuerdo\| descendente. |
| `GET /api/earnings-beat-v2?resueltos=1&format=md` | Los resueltos, con `acierto_v2` y `acierto_pm`. Acierto = el lado > 50% coincide con la resolución. |
| `GET /api/earnings-beat-v2?validacion=1&format=md` | Los 22 y el veredicto pre-registrado. |
| `GET /api/earnings-beat-v2?job=diario` | El cron (`55 23 * * *`, latido `earnings-beat:v2`). |

En la vista de abiertos, `prob_pm` es el precio válido a T-24h si ya existe. Si no existe, es el último precio de Gamma, marcado `prob_pm_fuente = gamma_ahora`.
