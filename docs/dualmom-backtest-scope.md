# Dual Momentum con gate de tendencia — backtest pre-registrado #2

**Backtest PRE-REGISTRADO.** Mismo playbook que `/api/pead-analyze` y
`/api/rotation-analyze`: los criterios de éxito se fijaron **antes** de correr
nada, viven congelados en `CRITERIOS` (`api/_lib/dualmom-analyze.js`) y salen en
cada respuesta. Si alguien los mueve después de ver los números, el diff lo
delata.

Candidato a **agente defensivo** y evidencia para el **breaker macro de la
liga**.

Endpoint: `GET /api/dualmom-analyze` (solo lectura) ·
`?format=md` para el resumen en español · `?anios=N` para la ventana ·
`?canastas=1` para el detalle canasta a canasta.

---

## 1. La pregunta

¿Un Dual Momentum (momentum relativo + momentum absoluto + gate de tendencia
sobre SPY) **defiende de verdad** — menos drawdown que el SPY sin costar más de
1 punto de retorno al año?

Ojo con lo que promete esta estrategia: **defensa, no alfa**. Eso cambia la
vara (§3).

## 2. Especificación principal (una sola)

| Pieza | Definición |
|---|---|
| Universo | **el mismo set de símbolos que `/api/rotation-analyze`** (los que tienen historial de EPS en `pead_earnings` y precios en Yahoo), por comparabilidad |
| Rebalanceo | primer día hábil del mes (calendario de SPY), **fills a la apertura** |
| Selección | rank por **momentum 12-1** (retorno de t−12m a t−1m) → **top decil** (~10), equal-weight |
| Filtro (a) | **momentum absoluto**: un nombre solo entra si su propio 12-1 > 0 |
| Filtro (b) | **gate macro**: si SPY está debajo de su **SMA de 200 días** en la fecha de rebalanceo, la cartera **entera** se va a efectivo ese mes |
| Efectivo | rinde **0** (conservador) |
| Costos | 10 bp por lado sobre el **turnover real** (Σ\|Δnotional\| / equity) |
| Benchmark | SPY, mismos días, misma ventana. Los §2, §3 y §4 son **relativos a él** |
| Ventana | 3 años por default — **la misma que rotation-analyze** (ver §6) |

### 2.1 Reuso, no reimplementación

El lib es puro y **reusa los helpers de `api/_lib/rotation-analyze.js`**: el
calendario de rebalanceos (`primerosHabilesDelMes`), el momentum 12-1
(`momentum121`), el simulador con turnover real y costos por lado
(`simulaRotacion`), la serie calendar-time de SPY (`serieSpy`), la anualización
(`anualizado`) y las primitivas de precio (`alineaAlCalendario`,
`cierreVigente`, `recortaVelasIncompletas`) son **exactamente los mismos**. Si
un helper cambia, cambian los dos backtests a la vez — que es el punto.

Lo nuevo de este backtest es el gate (`smaDias`, `smaMeses`, `evaluaGate`), el
filtro absoluto y los criterios relativos a SPY.

La única extensión al helper compartido es un campo **opcional** en la canasta,
`ranuras`, que `simulaRotacion` usa como denominador del reparto en vez de la
cantidad de nombres — lo necesita la variante Antonacci (§4) para dejar en
efectivo las ranuras recortadas. **Sin el campo el comportamiento es idéntico al
de siempre**: la rotación Value+Momentum no lo pasa y no cambia ni un decimal
(lo cubre `tests/rotation-analyze.test.mjs`, que sigue en verde sin tocarse).

### 2.2 Decisiones que hay que declarar (y por qué)

- **El gate se evalúa con el CIERRE DE LA SESIÓN PREVIA.** El encargo dice "si
  SPY cierra debajo de su SMA de 200 días en la fecha de rebalanceo". El fill
  es a la **apertura** de esa fecha: el cierre de ese día todavía no existe
  cuando se ejecuta. Usarlo sería look-ahead puro, y justamente en la variable
  que decide si se está en el mercado o en efectivo — donde más duele. Como el
  rebalanceo es el primer día hábil del mes, ese cierre previo **es el cierre de
  fin de mes anterior**, que además es la convención de la literatura (Faber).
  La lectura literal se mide igual, como corte **EXPLORATORIO**.
- **El decil se calcula sobre TODA la población elegible y el filtro absoluto
  recorta después.** Así "top decil (~10)" sigue queriendo decir ~10, y el
  filtro se ve como lo que es: un recorte, contado en
  `filtro_absoluto.nombres_recortados`. La otra lectura (filtrar primero y sacar
  el decil del subconjunto positivo) va como corte **EXPLORATORIO**.
- **Los nombres que caen por el filtro absoluto NO dejan su ranura en
  efectivo**: los sobrevivientes se reparten el capital. Es la lectura literal
  de "un nombre solo *entra* si…" — habla de entrada, no de pesos. Si no
  sobrevive ninguno, la canasta queda vacía y el mes es de efectivo.
  Esta decisión **no se queda en una nota al pie**: la otra convención
  (Antonacci — cada ranura recortada se queda en efectivo, peso 1/N sobre
  N = tamaño del decil) es una **sensibilidad obligatoria** (§4), porque mueve
  el §3 justo en los meses de momentum roto — que es cuando la lectura literal
  *concentra* en los pocos que quedan en vez de des-arriesgar. El reporte
  publica las dos al lado y **dice si el §3 se voltea entre ellas**: si el
  veredicto colgara de esa decisión de pesos, la defensa que se está midiendo
  no sería la que se pre-registró.
- **El efectivo rinde 0.** Un T-bill habría que elegirlo y modelarlo (¿qué
  plazo? ¿qué serie?); poner 0 subestima la estrategia a propósito, que es el
  lado correcto del error para algo que se vende como defensivo.
- **Si no hay historia para calcular la SMA, el mes se va a efectivo** (coherente
  con una estrategia defensiva) pero se cuenta **aparte** en `gate.sin_sma`: un
  hueco de datos no es una prueba del mecanismo.
- **El t del retorno anormal vs SPY se reporta como DIAGNÓSTICO, no como
  criterio.** Esta estrategia no promete alfa; medirla por su t sería medirla
  por lo que no prometió.
- **Los pesos derivan entre rebalanceos** (heredado del simulador del rotation):
  no hay re-equiponderación diaria.

## 3. Criterios de éxito (congelados ANTES de correr)

La vara es **relativa a SPY en la misma ventana** — lección directa del
rotation: un umbral **absoluto** de Sharpe premia el régimen, no la estrategia
(en un año dorado cualquier cosa larga lo pasa; en uno malo, nada lo pasa).

1. **Muestra** — ≥ **30** rebalanceos mensuales **completos** (con su periodo
   cerrado). Si no → **INCONCLUSO**.
2. **Sharpe** — Sharpe **neto** ≥ Sharpe de SPY **+ 0.15** en la misma ventana.
3. **Drawdown** — max drawdown ≤ **70%** del max drawdown de SPY (en magnitud).
   Es el criterio que mide la promesa: **defensa**.
4. **Retorno** — retorno anualizado neto ≥ **SPY − 1 punto porcentual**. La
   defensa no puede costar más de un punto al año.
5. **GO = §2 y §3 y §4.** Falla de muestra (§1) → INCONCLUSO (no NO-GO: sin
   muestra no se afirma que la estrategia no sirve). Lo demás → NO-GO.

### 3.1 Candado de honestidad pre-registrado

Se reporta **`gate_activaciones`**: cuántos rebalanceos se fueron a efectivo por
el gate macro. **Si es 0, el mecanismo defensivo NO SE PROBÓ en esta ventana**
— la estrategia fue idéntica a su versión sin gate — y el veredicto se topa en

> **GO frágil (gate sin evento en ventana)**

aunque los cuatro criterios pasen. El reporte lo dice explícito, arriba de
todo, antes de los números. Los meses de efectivo por falta de SMA se cuentan
aparte (`gate.sin_sma`) y **no** cuentan como activaciones.

## 4. Sensibilidades obligatorias

- **Sin gate macro** — atribución: cuánto del §3 lo pone el gate. Con
  `gate_activaciones = 0` esta corrida y la principal tienen que ser
  **idénticas**; si no lo fueran, sería un bug del gate, no un hallazgo.
- **Sin filtro absoluto** (momentum relativo puro + gate) — aísla el filtro (a).
- **SMA de 10 meses** en vez de 200 días (**variante Faber**) — misma idea de
  tendencia, otra ventana. Si el veredicto se voltea acá, colgaba de la elección
  de SMA.
- **Rebalanceo cada 2 meses** — con una ventana de 3 años produce ~17
  rebalanceos, por debajo del piso **por aritmética**: su INCONCLUSO es de
  muestra, no de señal, y el reporte lo aclara.
- **Ranura vacía a efectivo** (convención **Antonacci**) — cada nombre
  recortado por el filtro absoluto deja su ranura en efectivo: el peso es
  **1/N sobre N = tamaño del decil**, no sobre los sobrevivientes. Es la
  variante que de verdad des-arriesga cuando el momentum se rompe. El criterio
  principal sigue siendo la lectura literal (§2.2); esta se reporta **al lado**,
  con su atribución calculada.
- **Sin filtros** (sin gate y sin absoluto) — **el puente con el rotation**
  (ver §6).

Cualquier otro corte va etiquetado **EXPLORATORIO** y no cuenta para el
veredicto: el gate con el cierre del propio día (mide el look-ahead), el filtro
absoluto antes del decil (la otra lectura del orden) y el quintil.

## 5. Garantías de la implementación

Las mismas del `pead-analyze` / `rotation-analyze`, verificadas en
`tests/dualmom-analyze.test.mjs`:

- **Solo lectura**: un único `SELECT DISTINCT symbol` sobre `pead_earnings`, y
  solo para heredar el universo del rotation (esta estrategia no usa un solo
  EPS). Cero DDL/DML, sin `ensurePeadSchema()`, sin `beat()` (latir acá
  enmascararía un cron muerto). El test captura toda query que cruza la frontera
  y falla si alguna no empieza con `select`.
- **Gate**: `CRON_SECRET` por header o por query (`?secret=`), respuesta
  `no-store`. `maxDuration = 300`.
- **Precios**: Yahoo en vivo (`api/_lib/yahoo-daily.js`, compartido con PEAD y
  rotación), velas diarias ajustadas por splits **y** dividendos, con el factor
  aplicado también al open.
- **Lib puro**: `api/_lib/dualmom-analyze.js` no hace I/O. Se testea con
  sintéticos deterministas (LCG, no `Math.random`):
  - **tendencia con crash plantado** — el gate **tiene** que activarse y cortar
    el drawdown a una fracción del de la misma estrategia sin gate; se verifica
    además que los meses de gate son canastas **vacías** y que el cierre previo
    de SPY estaba efectivamente debajo de la SMA200. Es la prueba de que la
    máquina mide lo que dice medir;
  - **tendencia limpia sin crash** — `gate_activaciones = 0` con los cuatro
    criterios en verde: el veredicto **tiene** que toparse en GO frágil;
  - **mercado plano** — control negativo: no hay nada que ganar y los costos se
    pagan igual;
  - **muestra corta** — INCONCLUSO por la regla dura, no "casi";
  - **la ranura en efectivo, medida en el simulador** — una canasta de 1 nombre
    con 4 ranuras tiene que dejar 3/4 del capital quieto en efectivo y negociar
    solo 25%; y sin el campo `ranuras` el comportamiento tiene que ser
    **idéntico** al de siempre (por eso la rotación Value+Momentum no se entera
    de que el simulador ahora lo soporta);
  - **el puente roto** — un t fuera de la banda tiene que producir el aviso que
    apunta a la herencia del universo, y un split sin serie tiene que salir
    "NO VERIFICABLE", nunca "cuadra".

## 6. Caveat pre-registrado: NO es una prueba independiente del momentum

Esta corrida usa **la misma ventana y el mismo universo** que
`/api/rotation-analyze`, así que hereda entera su contaminación:

1. **Sesgo de supervivencia.** El universo es la lista de **HOY** mirada hacia
   atrás: los nombres que quebraron, fueron adquiridos o deslistados no están en
   `pead_earnings`, y los que sobrevivieron llegaron hasta hoy justamente porque
   les fue bien.
2. **Régimen compartido.** Son los mismos ~3 años de mercado, en su mayoría
   alcistas.

Y el sesgo **no empuja parejo en los cuatro criterios**: infla el retorno y el
Sharpe (§2, §4), pero también infla los de SPY, que es la vara. Sobre el
drawdown (§3) el efecto es más sutil — un universo sin quiebras tiene menos cola
izquierda idiosincrática, así que la defensa medida acá es, si acaso, **más
fácil** de lo que sería en vivo.

### 6.1 El puente: el split "sin filtros" tiene que reproducir el momentum-solo del rotation

El corte **"sin filtros"** (sin gate y sin absoluto) es momentum relativo puro
sobre el **mismo universo** y la **misma ventana** que el corte **"solo
momentum"** de `/api/rotation-analyze`, que reportó **t = 1.87**. Son
esencialmente **la misma medición sobre los mismos datos**, así que el split de
acá **tiene que reproducirlo aproximadamente**. La referencia está congelada
junto al resto de los criterios:

```
puente_rotation_t_referencia: 1.87
puente_tolerancia_t: 0.5
```

No se espera igualdad exacta y la tolerancia se fijó **antes** de correr, por
dos razones declaradas: el momentum-solo del rotation exige además **TTM
válido** para ser elegible (comparte población con la pierna value) y acá no
—esta estrategia no usa EPS, así que su población elegible es algo más amplia—,
y las dos corridas se ejecutan en fechas distintas, con lo que la ventana de 3
años no arranca exactamente en el mismo día.

**Si la brecha se sale de la banda, el reporte lo dice y lo dice fuerte.** La
lectura correcta de un puente roto **no** es "el momentum cambió" — las dos
corridas miden lo mismo sobre los mismos datos —, sino que **algo se rompió en
la herencia del universo**: otro set de símbolos, otra ventana o otro
calendario. La sección "Puente con `/api/rotation-analyze`" del reporte sale con
un **⚠️ NO CUADRA**, publica t observado, t esperado, brecha y banda, y avisa de
revisar la herencia **antes de creerle un solo número al resto del reporte**.
Es un chequeo de **integridad**, no un criterio de éxito: no entra en el GO.

Y al revés: si **sí** cuadra, eso **confirma la herencia del universo, no el
momentum**. Vale la pena repetirlo porque es exactamente el error que este
caveat existe para prevenir: dos mediciones idénticas sobre los mismos datos
coincidiendo no son evidencia independiente de nada.


## 7. Si los datos no alcanzan

Si `pead_earnings` está vacío en la ventana, la respuesta lo dice y no se
improvisa otro universo. Si ningún rebalanceo llega al piso de elegibles, el
veredicto es **INCONCLUSO** (no NO-GO) y el reporte muestra la contabilidad:
rebalanceos programados, ejecutados, saltados, y las exclusiones desglosadas por
motivo. **Elegibles + exclusiones = símbolos × rebalanceos ejecutados** — es una
aserción del test: un símbolo que desaparece en silencio es una muestra distinta
a la que dice el JSON.
