# Cripto spot — Fase 0 (memo de factibilidad, sin código)

> **Estado:** memo. Cero líneas de cosecha ni de backtest hasta que Lety lo lea y diga GO a Fase 1. Lo escrito en §2 (hipótesis y criterios) queda **congelado antes de ver un solo dato**.
>
> **Reglas ya decididas (no se discuten aquí):** spot únicamente · sin apalancamiento · sin perpetuos · long-only. Dónde se ejecuta (Bitso, Binance spot o Alpaca cripto) se decide con GO, no antes.
>
> **Honestidad sobre lo que este memo sabe:** el sandbox no llega a Binance, Alpaca, Yahoo ni Polymarket (egress bloqueado, probado el 2026-10-17). Todo lo que diga de una fuente sale de su documentación pública y de lo que el repo ya usa; cada afirmación lleva su etiqueta — **[verificado en el repo]**, **[documentación]** o **[POR VERIFICAR con la sonda]** — y §1.5 deja los comandos exactos para que Lety cierre lo que falta desde su Mac en diez minutos.

---

## 0. De dónde viene esto

- **BTC RSI** en el simulador de la flota: −3 %, sin validar **[verificado en el repo: `agents`]**.
- **Hallazgos de febrero (frankenstein-bot, Polymarket BTC por vela):** spot momentum 67 % de acierto, UP-only 78 %, entrada < 60 ¢ 86 %. Un mes de datos, nunca backtest. Viven en otro repo al que este memo no tiene acceso → **se tratan como hipótesis**, no como hechos. Importante: esas tasas de acierto eran sobre **precios de Polymarket** (comprar un "UP" a 55 ¢ que paga $1), no sobre spot; el 86 % de "entrada < 60 ¢" es una afirmación sobre el *precio del contrato*, no sobre BTC. Traducirlas a spot cambia la pregunta, y eso se dice en §2.

---

## 1. Fuente de datos

### 1.1 Binance — klines públicos (spot)

- **Sin key.** `GET https://api.binance.com/api/v3/klines` es endpoint público de datos de mercado **[documentación]**.
- **Tope por request: 1,000 velas** (default 500) **[documentación]**.
- **Peso: 2 por request**, límite por IP ~6,000 de peso/minuto → ~3,000 requests/min **[documentación; POR VERIFICAR el peso actual en la cabecera `x-mbx-used-weight-1m`]**.
- **Profundidad:** BTCUSDT cotiza desde ago-2017; ETHUSDT igual **[documentación; POR VERIFICAR la primera vela con `startTime=0`]**.
- **Alternativa en bloque, también gratis y sin key:** `data.binance.vision` sirve ZIPs diarios/mensuales de klines por símbolo e intervalo. Para una cosecha única es más limpio que paginar.
- **Riesgo regulatorio del dato:** ninguno — es un feed público, no requiere cuenta. Que Binance tenga la cuenta de futuros de Lety restringida no afecta esto.

**Veredicto parcial:** fuente principal para el backtest. Gratis, profunda, sin key.

### 1.2 Alpaca — crypto bars

- Endpoint `GET https://data.alpaca.markets/v1beta3/crypto/us/bars` con `symbols=BTC/USD`, timeframes desde 1Min **[documentación]**. Requiere las keys de la cuenta.
- **Profundidad:** Alpaca empezó cripto en 2021; no esperar 2017 **[documentación]**.
- **¿Llega a cuentas de México?** **[POR VERIFICAR]**. El trading de cripto en Alpaca está limitado por jurisdicción; el smoke del Libro (`/api/libro?smoke=1`, PR #280) ya devuelve `crypto_status` de la cuenta live — ese campo contesta la pregunta sin preguntarle a soporte.
- Rol en Fase 1: **venue candidato para ejecutar**, no fuente del backtest (poca historia). Fees spot ~0.15–0.25 % por lado según volumen **[documentación; POR VERIFICAR en el dashboard]**.

### 1.3 Yahoo — BTC-USD / ETH-USD

- Diario desde 2014 (BTC), cierre a medianoche UTC **[documentación; el repo ya habla con Yahoo vía `api/_lib/yahoo-daily.js`, verificado]**.
- Intradía: 1m solo 7 días, 1h ~2 años → **no sirve para la hipótesis (a)** (15 min / 1 h con años de historia).
- Rol: **control cruzado** del diario de Binance (si los cierres diarios difieren > 1 %, algo está mal en una de las dos series). No fuente principal.

### 1.4 Polymarket — mercados "BTC Up/Down" por vela

- Los mercados de 15 min se resuelven contra el precio de Chainlink/Binance al cierre de la vela **[documentación]**.
- **Histórico:** la Gamma API lista mercados cerrados y el CLOB tiene `prices-history` por token — exactamente la pareja que `api/earnings-beat-harvest.js` ya usa **[verificado en el repo]**. O sea: el patrón de cosecha existe en casa.
- **Lo que NO está verificado:** cuántos mercados "Up/Down" de 15 min quedan listados hacia atrás (Polymarket crea y cierra cientos por día; si Gamma solo devuelve una ventana, la historia es corta) **[POR VERIFICAR con la sonda]**.
- **Decisión pre-registrada:** si la sonda muestra < 6 meses de mercados cerrados recuperables, la hipótesis "Polymarket" **se estaciona con acta** y Fase 1 corre solo spot. Si hay ≥ 6 meses, se abre como **tercera** hipótesis en un memo aparte (este memo pide máximo dos).

### 1.5 La sonda (Lety, desde su Mac, ~10 min)

```bash
# Binance: primera vela disponible + peso por request
curl -s -D - "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=0&limit=1" | grep -i "x-mbx-used-weight\|^\[" | head -3
curl -s "https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=0&limit=1"
# → anotar la primera fecha (ms → fecha) y el peso usado

# Binance: ¿1,000 velas de 15 min por request?
curl -s "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))"

# Alpaca: ¿cripto habilitado en la cuenta LIVE? (ya lo trae el smoke del Libro)
curl -s -H "Authorization: Bearer $ADMIN_SECRET" "https://quantdesk2.vercel.app/api/libro?smoke=1" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['detail'])"
# → mirar crypto_status

# Polymarket: ¿cuántos mercados "Bitcoin Up or Down" cerrados devuelve Gamma?
curl -s "https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=0&tag_id=&search=Bitcoin%20Up%20or%20Down" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d), d[0]['endDate'] if d else None, d[-1]['endDate'] if d else None)"
# → repetir con offset=1000, 5000: ¿hasta qué fecha llega?
```

Pegar los cuatro outputs al pedir Fase 1. Con eso las etiquetas **[POR VERIFICAR]** se cierran.

---

## 2. Hipótesis pre-registradas (máximo 2) — criterios ANTES de ver datos

**Universo:** BTC y ETH, spot, par USDT (Binance) para el backtest. Long-only.

**Costos realistas (los que deciden):** fee spot Binance 0.10 % por lado (0.075 % con BNB) + spread ~0.01–0.02 % en BTC/ETH ⇒ **0.12 % por lado, 0.24 % ida y vuelta**. Si el venue final fuera Bitso (~0.5–0.65 % taker en MXN **[documentación; POR VERIFICAR]**) o Alpaca (~0.25 %), el backtest se re-corre con ese costo antes de activar — una estrategia que vive solo con fees de Binance no es una estrategia.

**Benchmark:** buy-and-hold del **mismo activo**, misma ventana (no SPY, no cero).

**Criterios (iguales para las dos):**

- **GO** = |t| ≥ 2.5 **y** Sharpe ≥ B&H + 0.15 **y** ≥ 100 operaciones **y** positivo en ≥ 2 de 3 regímenes.
- **GO FRÁGIL** = 2.0 ≤ |t| < 2.5 con el resto cumplido.
- **INCONCLUSO** = < 100 operaciones, **o** el signo del exceso se invierte entre regímenes aunque el agregado sea positivo (regla D12b del wheel, misma casa).
- **NO-GO** = lo demás.
- **Regímenes:** 2022 (abajo), 2023–2024 (arriba), 2025–2026 (lo que haya). Se reportan los tres siempre.
- Sensibilidades (umbral ±25 %, ventana ±25 %, BTC solo / ETH solo) **se reportan y no deciden**.
- Estadístico t sobre retornos por operación con clustering por día (dos operaciones el mismo día no son dos observaciones).

### Hipótesis (a) — momentum intradía spot (la de febrero, traducida)

- **Pregunta:** ¿la dirección de la última vela de 15 min predice la siguiente, lo bastante para pagar 0.24 %?
- **Regla exacta:** al cierre de cada vela de 15 min, si `close_t > open_t` (vela verde) → comprar al cierre, vender al cierre de la vela siguiente. Si no, nada. Una posición a la vez por activo.
- **Sensibilidad declarada:** mismo esquema en 1 h (la de 15 min es la hipótesis; 1 h se reporta).
- **Por qué podría fallar aunque febrero "funcionara":** el 67 % de febrero era sobre contratos de Polymarket con payout asimétrico; en spot un acierto de 67 % con movimientos de ±0.2 % por vela y 0.24 % de costo es **pérdida esperada**. El backtest tiene que decirlo con número.
- **Operaciones esperadas:** ~40 % de velas verdes × 35,000 velas/año ≈ 14,000/año por activo. El criterio de N≥100 se cumple de sobra; el que manda es el costo.

### Hipótesis (b) — reversión a la media (Bollinger diario)

- **Pregunta:** ¿comprar BTC/ETH cuando cierran muy por debajo de su media de 20 días y vender al regresar a la media deja algo después de costos? Es la **misma familia que la única ventaja validada de la casa** (TSLA Bollinger), llevada a cripto.
- **Regla exacta:** velas diarias (cierre UTC). Comprar al cierre si `close < SMA20 − 2·σ20`. Vender al cierre del primer día en que `close ≥ SMA20`. Stop catastrófico 22 % desde la entrada (la misma regla del Libro). Una posición a la vez por activo.
- **Operaciones esperadas:** ~5–15 por activo por año → **≥ 100 exige los dos activos y toda la historia desde 2017**. Con 2022–2026 solamente es probable INCONCLUSO por N; por eso el backtest corre 2017→hoy y reporta los tres regímenes aparte.
- **Por qué podría fallar:** en 2022 "comprar la caída" compró cada caída de un mercado que cayó 65 %. Si 2022 sale muy negativo y 2023–24 muy positivo, la regla D12b la manda a INCONCLUSO aunque el total sea verde.

---

## 3. Presupuesto

| Qué | Requests | Tiempo | ¿Cabe en gratis? |
|---|---|---|---|
| (a) 15 min, BTC+ETH, 2022-01 → hoy (~4.8 años × 35,040 velas) | ~168 por activo (1,000/req) → **~340** | < 5 min con peso 2 y 6,000/min | **Sí**, sin key |
| (a) sensibilidad 1 h, mismos años | ~42 por activo → ~85 | < 1 min | Sí |
| (b) diario, BTC+ETH, 2017-08 → hoy (~3,350 velas) | **4 por activo** | segundos | Sí |
| Control Yahoo diario | 2 (ya existe `bajaSeries`) | segundos | Sí |
| Polymarket (si se abre) | depende de la sonda | — | POR VERIFICAR |

Todo cabe en gratis y en una tarde en la Mac de Lety (el sandbox no llega; el patrón "cosecha local una sola vez + Neon" es el mismo del wheel y del XBRL). **No hay recorte que proponer**: si la sonda confirma profundidad y límites, se corre entero.

Si la sonda dijera que Binance bloquea el feed público desde México (no se espera): plan B = `data.binance.vision` (ZIPs, otro host); plan C = Yahoo diario solo para (b) y (a) **se estaciona con acta** por falta de intradía gratis.

---

## 4. Apuesta previa (escrita antes de cualquier número)

- **(a) momentum 15 min spot: NO-GO.** El costo de 0.24 % ida y vuelta es del mismo tamaño que el movimiento típico de una vela de 15 min; para pagarlo se necesita una asimetría que la hipótesis no tiene. Lo de febrero era un edge de *precios de Polymarket*, no de BTC. Espero exceso negativo en los tres regímenes. Si saliera GO, lo primero que reviso es si el backtest está cobrando los costos de verdad.
- **(b) reversión Bollinger diaria: INCONCLUSO**, por dos vías probables: N justo en el límite (10–15 ops/año/activo) y 2022 muy negativo frente a 2023–24 muy positivo → inversión de signo → D12b. Si sale GO frágil, lo trato como lo que la etiqueta dice.

Dos NO/INCONCLUSO serían un resultado útil: cierran "cripto" en la cola con acta y el tiempo se va al wheel, que sí tiene reloj. Un GO en (b) abriría Fase 2 = 4 semanas en paper **en el venue que quede** (Alpaca si `crypto_status` lo permite; si no, Binance spot; Bitso solo si el costo re-corrido lo aguanta).

---

## 5. Lo que sigue (solo si Lety dice GO a Fase 1)

1. Correr la sonda de §1.5 y pegar los outputs.
2. Encargo de Fase 1: cosecha única local (BTC+ETH, 15m y 1d) → Neon (`cripto_velas`), control Yahoo, y `/api/cripto-analyze` con `CRITERIOS_CRIPTO` congelados **copiados de §2 de este memo** (test que los pinea). Mismo molde que `fuga-analyze`.
3. Leer veredicto contra criterios sin mover porterías.

*Memo redactado 2026-10-17 · PR docs-only · sin cosecha, sin backtest.*
