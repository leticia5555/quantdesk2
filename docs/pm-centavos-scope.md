# PM-CENTAVOS: ¿la distancia en centavos barra − consenso predice el resultado mejor que el precio?

Backtest **pre-registrado**. Los criterios se fijaron antes de correr y viven
congelados en `CRITERIOS_PM_CENTAVOS` (`api/_lib/pm-centavos-analyze.js`),
pineados valor por valor en `tests/pm-centavos-analyze.test.mjs`. Si algo de
esto se cambia después de ver el resultado, es otro estudio con otro nombre.

**Hipótesis previa:** en gap = 0, el % real de Yes está **por debajo** del
precio medio del mercado a T-24h.

## Por qué (escrito el 6-nov, antes de correr)

En la semana del 2 al 5 de noviembre, 3 de los 4 errores del mercado fueron por
0–1 centavo: ON 0.90 vs 0.90, SYY 1.19 vs 1.20, FNF 1.32 vs 1.33. Referencia:
Degeorge, Patel & Zeckhauser (1999): las empresas aterrizan pegadas al
consenso (o un centavo arriba). La barra de Polymarket es **estricta**
(empate = No). Entonces, cuando la barra **es** el consenso, "aterrizar en el
consenso" resuelve No, y el mercado podría estar pagando de más por el Yes.

## Pregunta

gap = **barra − consenso**, en **centavos**, redondeado al centavo.
¿Agrega información sobre el precio del Yes a T-24h?

## Aislamiento

- Archivos nuevos: `api/_lib/pm-centavos-analyze.js` (lógica pura),
  `api/pm-centavos-analyze.js` (endpoint), `tests/pm-centavos-analyze.test.mjs`
  y este doc. Lo único que se modificó fue `vercel.json` (`maxDuration: 300`
  para el endpoint nuevo).
- v1 (`pm_earnings_markets`), v2 (`pm_earnings_markets_v2`) y
  `pead_event_hour`: **solo SELECT**. La UI no se toca.
- **No crea tablas propias.** El precio a T-24h sale de la caché de PM-DRIFT
  (`pm_price_hist`, `pm_price_hist_fetch`), con su mismo SCHEMA, su misma
  descarga y su misma regla de precio. Lo que PM-DRIFT ya bajó no se vuelve a
  pedir al CLOB; lo que baje este endpoint le sirve a PM-DRIFT.

## Datos

### Universo
Unión de v2 y v1 por `market_id`; si un mercado está en las dos, gana la fila
de v2. Se excluyen, en este orden y contando cada motivo:

1. duplicado (ya visto en v2)
2. **no resuelto**: `outcome` distinto de `yes`/`no`
3. **liquidez**: `volume` < **$500** o nulo (el mismo umbral que PM-DRIFT y
   Fase 2)
4. **sin consenso en la descripción** (ver abajo). La columna `consensus_pm`
   **no** lo sustituye: el estudio es sobre lo que el mercado declara.
5. **sin barra** (ver abajo)
6. sin token del Yes
7. sin fecha de reporte

### Consenso
Solo de la **descripción del mercado** (`raw->>'description'`), y solo si el
monto está pegado a la palabra *consensus*:

- plantilla nueva: «The Street consensus estimate for X's … EPS for the
  relevant quarter is **$0.43** as of market creation»;
- si no, el monto a ≤ 60 caracteres de *consensus* (el patrón
  `consensus_monto` del lector v1).

Un monto suelto junto a *estimate* o *EPS* **no** cuenta: suele ser la barra,
y contarlo fabricaría gap = 0. Negativos: `-$0.05`, `$-0.05`, `−$0.05` y
`($0.05)` (notación contable, igual que el lector v1).

### Barra
El umbral del **slug** (`…-1pt33`, `…-neg-0pt03`). Si el slug no lo trae, el
monto de la **pregunta**. **Nunca** la descripción (ahí el monto suele ser el
consenso).

### Gap
`gap = round((barra − consenso) × 100)`. Primero se limpia el ruido de coma
flotante (`toFixed(6)`: 1.33 − 1.32 = 0.01000000000000009 → 1); las mitades
de centavo se redondean **lejos del cero** (+0.5 → +1, −0.5 → −1). Nunca −0.

Regla de resolución: **estricta, empate = No**. El resultado es el `outcome`
con el que Polymarket resolvió.

### Precio a T-24h (p24)
La regla de PM-DRIFT, importada (no copiada): hora del reporte desde
`pead_event_hour` (BMO 07:00, DMH 12:00, AMC 16:00 ET; sin hora → AMC,
marcado imputado), T-24h desde esa hora, **el punto anterior más cercano**,
nunca uno posterior, faltante si está a **más de 3h**. Un mercado sin p24 no
entra a las pruebas; la cobertura dice cuántos y por qué.

**No** se usa `yes_price_t24h` de v1/v2: está anclado a la fecha de
**resolución**, que es posterior al reporte.

## Pruebas
Sobre los mercados del universo con p24.

a) **Tabla** por gap: ≤−4, −3, −2, −1, 0, +1, +2, +3, ≥+4 → N, % de Yes,
   p24 medio y diferencia (Yes real − p24 medio).

b) **Regresión logística**:
   `resultado ~ logit(p24) + 1[gap = 0] + 1[gap = −1] + 1[gap ≥ +1]`.
   Categoría base: **gap ≤ −2**. p24 acotado a [0.01, 0.99]. Errores
   **agrupados por fecha de reporte** (CR1, la misma función que PM-DRIFT,
   pineada contra statsmodels). Si no hay observaciones en la base, la matriz
   es singular y **no hay coeficiente** (→ NO-GO).

c) **Simulación en papel**, $1 por apuesta, $0.02 de costo fijo por operación:
   - gap = 0 y p24 ≥ 0.70 → comprar **No** a (1 − p24): gana `(1−y)/(1−p24) − 1`
   - gap ≤ −1 y p24 ≤ 0.70 → comprar **Yes** a p24: gana `y/p24 − 1`

d) **Fuera de muestra**: mediana de fecha = la fecha del medio de las
   observaciones válidas (la menor si N es par; la regla de PM-DRIFT).
   1ª mitad = fecha ≤ mediana; 2ª = fecha > mediana. Se repiten (b) y (c).

## Criterios (congelados)

| | |
|---|---|
| N(gap = 0) < **40** | **INCONCLUSO** |
| coef de 1[gap = 0] **< 0** con **\|t\| ≥ 2.5**, Y simulación neta **> 0** en **ambas** mitades | **GO** |
| lo mismo pero **2 ≤ \|t\| < 2.5** | **GO FRÁGIL** |
| cualquier otro caso (incluida la regresión sin convergencia) | **NO-GO** |

"Negativo con t ≥ 2.5" se lee como coef < 0 y t ≤ −2.5. Neto = 0 no cuenta
como > 0. La regresión de cada mitad se **reporta** pero no decide (el
criterio pide solo la simulación por mitad). La hipótesis previa (% Yes <
p24 en gap = 0) también se reporta y no decide.

Estados sin veredicto (igual que PM-DRIFT): **FALLA DE FRONTERA** (universo
vacío o cero puntos de precio del CLOB) y **COBERTURA INCOMPLETA** (quedan
historiales por bajar).

## Riesgos conocidos (escritos antes de correr)

- **Base chica.** El coeficiente de gap = 0 se mide contra gap ≤ −2. Si
  Polymarket casi siempre pone la barra en el consenso, la base puede tener
  pocos mercados y el error estándar será grande: eso empuja hacia NO-GO, no
  hacia un GO falso.
- **El consenso es el de la creación del mercado**, no el vigente a T-24h.
  Si el consenso se movió, el gap "real" es otro. Es a propósito: es el
  número que el mercado muestra.
- La simulación usa p24 como precio de ejecución (sin spread ni
  profundidad); el $0.02 fijo es la única fricción.

## Uso

```
GET /api/pm-centavos-analyze?solo=cobertura&format=md&secret=…   ← primero (repetir hasta COBERTURA LISTA)
GET /api/pm-centavos-analyze?format=md&secret=…                  ← resultado
GET /api/pm-centavos-analyze?format=md&obs=1&secret=…            ← + detalle (JSON sin format=md)
&bajar=0                                                          ← no toca el CLOB
```

Auth: `CRON_SECRET` por `?secret=` o `Authorization: Bearer`.
