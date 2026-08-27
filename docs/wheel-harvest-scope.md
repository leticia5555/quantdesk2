# SCOPE — Cosecha de cadenas de opciones (Wheel / Covered Calls)

> **Estado:** DISEÑO. Nada implementado todavía.
> **Prerrequisito cumplido:** Fase 0 cerrada con fuente confirmada — ver
> `docs/wheel-fase0.md` (G0 = NO para Alpha Vantage, **G0-b = SÍ para Market
> Data**).
> **Esto NO es el backtest.** Acá solo se baja y se guarda la materia prima. Las
> decisiones de diseño del backtest siguen congeladas en `wheel-fase0.md` §7 y
> son Fase 1.

## 1. El principio que ordena todo: **cosechar de atrás hacia adelante**

La cuenta de Market Data está en **Starter Trial**: 10.000 créditos/día, **30
días, no renovable**, y al terminar **cae automáticamente a Free Forever** —
100 créditos/día y **techo de 1 año de antigüedad**.

De ahí sale la asimetría que decide el orden de trabajo:

| Antigüedad del dato | ¿Accesible después del downgrade? |
|---|---|
| 0-12 meses | ✅ Sí, para siempre (Free Forever llega hasta ahí) |
| 13+ meses | ❌ **No. Nunca más.** |

**Por lo tanto: la historia profunda se baja PRIMERO.** Es la única parte que el
reloj puede quitarnos. Bajar primero los últimos 12 meses —lo intuitivo, porque
es lo más "relevante"— es gastar el trial en lo único que no se iba a perder.

**Corolario: durante el trial se sobre-cosecha.** No se filtra por strike ni por
delta ni por DTE más de lo imprescindible: se baja **la cadena lo más completa
que el costo permita**, porque el filtro se puede aplicar después sobre la base
y el dato no se puede volver a pedir. Es la lección de PEAD (*"la tabla nunca
recorta; el recorte es una cláusula del query de análisis, no de la ingesta"*)
con un reloj encima.

## 2. Antes de escribir código: tres números

Ninguno se puede leer de la documentación. Los mide `scripts/wheel-phase0-probe.mjs`
en una corrida:

| # | Número | Por qué manda | Qué cambia |
|:-:|---|---|---|
| 1 | **Días de trial restantes** (dashboard) | Dimensiona la ventana de trabajo | Si quedan 2 días, la cosecha es hoy y con el universo mínimo |
| 2 | **Techo real del ticker de CONTROL** (no AAPL) | AAPL es el ticker de demo de Market Data; su profundidad puede no ser la del plan | Si el control topea en 12 meses, el alcance es 1 año y el claim es descriptivo (`wheel-fase0.md` §6) |
| 3 | **Créditos de una cadena COMPLETA** | Decide si se sobre-cosecha (§1) o hay que filtrar | Si la completa cuesta ~1-20 créditos → sobre-cosechar. Si cuesta cientos → filtrar por `side=call` + ventana de DTE |

**Regla:** no se corre la cosecha sin esos tres números anotados en
`wheel-fase0.md`.

## 3. Universo v0 y muestreo

- **5 nombres**, criterio: mega-cap líquido **con weeklies profundos** (que es lo
  que el covered call semanal necesita), derivado por ADV en dólares de
  `SCREENER_UNIVERSE.us` (`app.html`) como hizo PEAD.
  Candidatos naturales: `AAPL`, `MSFT`, `NVDA`, `AMZN`, `TSLA`.
  ⚠️ **`AAPL` cuenta como nombre del universo pero NO como evidencia de
  cobertura**: si es el ticker de demo, su disponibilidad puede enmascarar un
  hueco en los otros cuatro. La auditoría (§7) reporta cobertura **por símbolo**,
  nunca agregada.
- **Unidad de cosecha: un `(símbolo, fecha_observación)`.** Una llamada devuelve
  la cadena de ese día — todas las expiraciones y strikes que el filtro permita.
- **Muestreo: viernes.** Si el viernes es feriado, el **último día hábil de esa
  semana**. Las fechas se generan en runtime, nunca hardcodeadas.
- **Ventana: la máxima que dé el techo del control** (§2, número 2), de más
  antigua a más reciente.

## 4. Qué se pide, exactamente

```
GET https://api.marketdata.app/v1/options/chain/{SYMBOL}/?date=YYYY-MM-DD
Authorization: Bearer $MARKETDATA_TOKEN
```

- **Sin filtros** si el número 3 de §2 lo permite (preferido, §1).
- **Fallback si la cadena completa es cara:** `side=call` + ventana de DTE
  ≤45 días + `strikeLimit` alrededor del spot. Los nombres exactos de los
  parámetros de filtro se fijan contra la doc del endpoint al implementar — la
  sonda ya trae la llamada base funcionando.
- **Nunca** filtrar por delta o por strike puntual en la ingesta: eso es una
  decisión del backtest (`wheel-fase0.md` §7, D3) y cambiarla no puede exigir
  volver a pedir datos que ya no van a estar.

**Formato de respuesta — ojo, es COLUMNAR.** Market Data no devuelve un array de
objetos como AV: devuelve un objeto de arrays paralelos (`optionSymbol[]`,
`strike[]`, `bid[]`, `ask[]`, `openInterest[]`, …) más `s: "ok"`. El parser
transpone; y **valida que todos los arrays tengan el mismo largo** antes de
transponer, porque un array corto desalinearía strikes con precios en silencio.

## 5. Almacenamiento (Neon, mismo patrón que PEAD)

```sql
-- Un renglón por contrato por fecha de observación. La PK hace el upsert
-- idempotente. NO se recorta nada en la ingesta.
CREATE TABLE wheel_chain (
  symbol         text        NOT NULL,   -- subyacente
  obs_date       date        NOT NULL,   -- fecha de observación (el viernes)
  option_symbol  text        NOT NULL,   -- OCC, identifica el contrato
  expiration     date        NOT NULL,
  strike         numeric     NOT NULL,
  side           text        NOT NULL,   -- call | put
  bid            numeric,
  ask            numeric,
  mid            numeric,
  last           numeric,
  volume         bigint,
  open_interest  bigint,
  iv             numeric,
  delta          numeric,
  gamma          numeric,
  theta          numeric,
  vega           numeric,
  underlying     numeric,                -- si el payload lo trae; si no, NULL
  ingested_at    timestamptz DEFAULT now(),
  PRIMARY KEY (symbol, obs_date, option_symbol)
);

-- La unidad de trabajo. ESTO es lo que hace la cosecha reanudable.
CREATE TABLE wheel_harvest_ledger (
  symbol          text NOT NULL,
  obs_date        date NOT NULL,
  priority        int  NOT NULL DEFAULT 100,  -- menor = se baja primero (§1: más viejo primero)
  status          text NOT NULL DEFAULT 'pending', -- pending|done|empty|error
  contracts       int  DEFAULT 0,
  credits_used    int  DEFAULT 0,
  attempts        int  DEFAULT 0,
  last_attempt_at timestamptz,
  error_msg       text,
  PRIMARY KEY (symbol, obs_date)
);

-- Guard de gasto, robusto a corridas dobles.
CREATE TABLE wheel_api_budget (
  day     date PRIMARY KEY,
  credits int  NOT NULL DEFAULT 0,
  calls   int  NOT NULL DEFAULT 0
);
```

**`status='empty'` no es `'error'` y no es `'done'`:** un viernes sin cadena
(feriado no detectado, símbolo sin weeklies esa semana) es un hecho del mundo,
se marca y no se reintenta. Un 500 o un timeout es `'error'` y sí se reintenta.
Confundirlos es lo que hace que una cosecha se cuelgue reintentando lo
inexistente o dé por completo lo que falló.

## 6. El runner

**Bulk backfill: script local one-shot, no cron.** La cosecha entera entra en una
tarde durante el trial (§4.4 del memo); meterla en un cron de Vercel solo agrega
timeouts, `maxDuration` y disparos parciales a un trabajo que no es recurrente.

```
MARKETDATA_TOKEN=xxx DATABASE_URL=xxx node scripts/wheel-harvest.mjs [--dry-run] [--limit=N]
```

Bucle, por cada `(símbolo, fecha)` del ledger en `ORDER BY priority, obs_date`
(§1: **más viejo primero**):

1. Leer `wheel_api_budget` del día. Si el gasto llegó al tope configurado → salir.
2. Pedir la cadena. **Validar antes de escribir**: `s === 'ok'`, arrays presentes
   y **del mismo largo**, `optionSymbol.length > 0`. Si no → `empty` o `error`
   según corresponda, **nunca `done`**.
3. Transponer y `UPSERT` en `wheel_chain`.
4. Marcar el ledger `done` con `contracts` y `credits_used` (del header
   `x-api-ratelimit-consumed`), e incrementar `wheel_api_budget`.
5. Pausa corta entre llamadas.

**Idempotente** (upsert por PK), **reanudable** (el ledger es la verdad; un
crash deja `pending` y la próxima corrida retoma), **auditable** (el gasto real
por día queda en la tabla, no en un log).

**Forward-fill: cron semanal, después del trial.** Una vez terminado el backfill,
un cron liviano agrega **el viernes nuevo** de cada semana: 5 símbolos = 5
llamadas/semana, dentro de los 100 créditos/día del Free Forever con enorme
margen. Es lo que convierte un activo que se encoge en uno que crece: la ventana
deja de caerse por el borde y empieza a estirarse hacia adelante.

## 7. Auditoría de la cosecha (antes de que la Fase 1 toque nada)

Un reporte, no un log. Por **símbolo** (nunca agregado, §3):

- Rango de `obs_date` efectivamente cubierto.
- % de viernes esperados con cadena válida; lista de huecos con su causa.
- % de snapshots con **al menos un weekly a 5-14 DTE** — sin eso, el snapshot no
  sirve para la especificación semanal aunque tenga contratos.
- % de contratos con `bid > 0` y con `open_interest > 0` (calidad de precio).
- Créditos totales gastados vs. contratos obtenidos.

**Criterio de cosecha completa:** cada símbolo del universo v0 con ≥90% de sus
viernes esperados cubiertos **y** ≥90% de esos snapshots con weekly utilizable.
Por debajo, se declara el hueco en el memo antes de backtestear — no se promedia
con los símbolos buenos.

## 8. Lo que este scope NO hace

- No elige strikes, no calcula deltas objetivo, no simula asignación: todo eso es
  Fase 1 y está congelado en `wheel-fase0.md` §7.
- No baja precios del subyacente. Eso es Yahoo (`api/candles.js`), gratis, y va
  **en escala cruda, no ajustada** (§7, D8) — los strikes no están ajustados por
  dividendos.
- No decide la ventana de análisis. La ingesta guarda todo lo que consiga; el
  recorte temporal es una cláusula del query del backtest.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| **El trial vence a mitad de la cosecha** | Orden más-viejo-primero (§1): lo que se pierde es lo recuperable después, no lo irrecuperable |
| **El techo del control es 1 año** | El alcance se achica a 12 meses y el claim baja a descriptivo (`wheel-fase0.md` §6). No rompe la cosecha, cambia la conclusión |
| **AAPL tapa un hueco de los otros 4** | Auditoría por símbolo, nunca agregada (§7) |
| **Payload columnar desalineado** | Validación de largos iguales antes de transponer (§4) |
| **Cosecha "exitosa" con datos basura** | Validación en la ingesta, no después; `empty` ≠ `done` (§5, §6) |
