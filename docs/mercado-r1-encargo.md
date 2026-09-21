# R1 — El mapa. Encargo, actualizado con lo que R0 cambió

> **Contrato base:** el encargo original de `/mercado`, artboards 1 y 2. Este
> documento **no lo reemplaza**: lista lo que R0 movió de lugar, para que R1
> no arranque contra supuestos que ya no valen.
>
> **Precondición:** G1 y G2 en verde. G9 sigue rojo y es de R5 — la
> re-corrida de `?job=todo` va a dar NO-GO global, y eso no bloquea R1.

---

## 1. Lo que R0 cambió, y qué hay que hacer distinto

| El encargo decía | Lo que R0 dejó | Qué cambia en R1 |
|---|---|---|
| universo del screener (~150) | **`mercado_universo_us`**, poblada por cron | leer de ahí, no de `arena_screener` ni de Finnhub en vivo |
| "ampliar a S&P 500 si hace falta" | ya son ~579 símbolos | no hay que ampliar nada |
| sector por resolver | `sector_etf` precomputado | está; lo que falta es pintarlo |
| cap MX = acciones × precio | **÷ `acciones_por_unidad`** | la fórmula tiene un divisor |
| "emisora sin cap verificada → gris" | **tres motivos distintos** de gris | el motivo viaja al render |
| precios on-request | cron → Neon | el endpoint del mapa **lee**, no pide |

---

## 2. De dónde sale cada número

### 2.1 · Mapa EE.UU. — `mercado_universo_us`

```sql
select symbol, nombre, sector_etf, market_cap, cap_fuente, cap_actualizado
  from mercado_universo_us
 where sector_etf is not null and market_cap is not null
 order by market_cap desc
 limit 300;
```

**Top 300 por cap + el cuadro "+N más = X%"**, decidido en R0. Tres cosas que
el render tiene que respetar:

1. **El "+N más" no es decoración.** Sin él, un mapa de 300 se lee como si
   fuera el mercado entero. El `X%` se calcula sobre la **suma de caps de los
   que quedaron fuera**, nunca estimado.
2. **Los símbolos sin cap no entran en ese porcentaje.** Se cuentan aparte
   (`N sin capitalización`). Afirmar un porcentaje que no se midió es el
   mismo error que el mapa evita en todo lo demás. `recorteMapa()` ya lo
   devuelve separado.
3. **`cap_fuente` viaja al hover/hoja.** `finnhub:metric` y
   `neon:arena_market_cap` son fuentes distintas y la regla 3 del encargo
   pide que cada número diga la suya.

**Frescura:** `cap_actualizado` (no `actualizado`) es cuándo se **midió** la
cap. Si el cron viene atrasado, el pie del mapa lo tiene que decir — un mapa
cuyos cuadros son de hace tres días no está roto, pero tampoco es de hoy.

### 2.2 · Mapa México — con divisor y con motivo

```
cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
```

`acciones_por_unidad` y `serie_liquida` viven en `api/_lib/emisoras.json`.

**Hay tres motivos de gris y no son el mismo mensaje.** La hoja tiene que
distinguirlos, porque cada uno se arregla distinto:

| Estado | Qué decir en la hoja |
|---|---|
| `series con precio distinto, sin desglose` | "esta emisora cotiza en varias series a precios distintos y el reporte no desglosa acciones por serie" — FEMSA |
| `sin serie de precio` | "no hay cotización en nuestra fuente" — PE&OLES |
| `error > 5%` / `no cuadra` | "la capitalización calculada no cuadra con la referencia pública" — TLEVISA |

Y **dos vías hacia verde**, que también se dicen distinto:

- `verificada` → `cap: calc · verificada vs <fuente> (<fecha>)`
- `verificada_por_metodo` → `cap: calc · método validado (N muestras ≤2%)`

La segunda **no tiene control propio** y la etiqueta lo dice. No se colapsan
en un solo "verificada": la diferencia es real y el usuario que abre la hoja
tiene derecho a verla.

**Series sin mercado:** una serie con volumen 0 en la ventana no cuenta para
la cap ni para la dispersión, y se reporta. Si la hoja lista las series de una
emisora, esas van marcadas "sin operaciones" en vez de omitidas.

### 2.3 · Precios — el endpoint LEE

El cron deja los precios en Neon; `/api/mercado-mapa` hace **una** consulta.
Medido en la Fase 0: on-request son ~6.2 s en el miss contra ~120 ms leyendo.

`s-maxage` acorde a la ventana del cron. **Prohibido un fetch por cuadro** —
regla 7 del encargo, y ahora también aritmética.

---

## 3. Lo que R0 dejó listo y R1 solo tiene que usar

| Pieza | Dónde | Para qué |
|---|---|---|
| `recorteMapa(filas, 300)` | `_lib/mercado-r0.js` | top N + "+N más" con el % medido |
| `capConUnidades(...)` | idem | la cap MX con divisor |
| `estadoEmisora(...)` | idem | estado + etiqueta de fuente |
| `anclaYtd(serie, ahora)` | idem | el ancla de YTD por fecha |
| `sectorFromIndustry(...)` | `_lib/arena-meta.js` | industria → ETF sectorial |

---

## 4. Lo que sigue pendiente y R1 tiene que asumir

1. **YTD necesita serie de ≥1 año con timestamps.** `/api/price` da 30 cierres
   sin fecha y `/api/macro-markets` 70 puntos de 3 meses: **ninguna alcanza**.
   El endpoint del mapa manda `range=1y`. Sin eso, el toggle YTD pinta un
   número corto con etiqueta larga — el bug del % de periodo otra vez.
2. **`QD_PERIODS` gana `'YTD'`** con ancla por fecha (`anclaYtd`), y el
   `pct-lint` se extiende a los archivos nuevos.
3. **GFNORTE no está en `emisoras.json`** y sigue fuera: gris punteado
   (opción B), confirmado por el 401 de Yahoo.
4. **AMX, FEMSA, PINFRA** dependen de la corrida con la regla de "serie sin
   mercado". FEMSA va a seguir gris: UB y UBD operan las dos.
5. **El chip de estado de mercado es de UNA bolsa.** `qdMarketStatus()`
   (`app.html:4452`) sabe de acciones de EE.UU. con offset EDT fijo. R2 pide
   uno por bolsa; R1 puede vivir con el actual, pero no hay que descubrirlo
   después.

---

## 5. Lo que NO cambió

Todo lo demás del encargo original sigue igual: treemap propio sin librería
pesada, escala de color del mockup (−3% a +3%, 7 pasos, gris en ±0.5%),
mobile-first a 390 px con tap ≥44 px, hover solo en `pointer: fine`,
`qdPeriodChange` + `qdPctTag` como única fuente de los %, URL = estado, y el
pie con fuente y hora.

**Y la regla que R0 no dejó de ejercer ni una vez:** dato que falta es "—" en
gris **con su motivo**, nunca un estimado. Las tres clases de gris de §2.2
existen porque "no se pudo" no es una sola cosa.
