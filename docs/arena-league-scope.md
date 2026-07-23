# ARENA → Liga multi-modelo — Censo y alcance

Fecha: 2026-07-23. Solo alcance — cero código de app en este PR (mismo criterio
que `docs/alpaca-paper-scope.md`). Continúa `docs/arena.md`: hoy el Arena es UN
agente ("Claude PM", `ANTHROPIC_MODEL` default haiku) sobre la cuenta paper
`PA3VOJ7VTZHW`. El pedido: N modelos compitiendo, cada uno con su libro de
$100K, mismo prompt/buffet/guard, y un leaderboard público comparando
rendimiento.

---

## 0. Encuadre: qué hay ya construido y una premisa que corregir

Lo que YA existe y es reutilizable casi entero (ver §2):

- `api/arena-run.js` — el tick de dos fases (`decide` + `reconcile`), con
  `gatherContext` (buffet), `buildSystemPrompt`/`buildUserPrompt`, plan anterior
  reinyectado, guard determinista y ejecución límite-only idempotente.
- `api/_lib/alpaca.js` — cliente REST único, limit-only hardcodeado. Lee `key`/
  `secret` de **dos env vars fijas** (`ALPACA_PAPER_KEY`/`ALPACA_PAPER_SECRET`).
- `api/_lib/arena-guard.js` — parse + risk guard, JS puro sin I/O ni LLM.
- `api/_lib/model.js` — `ANTHROPIC_MODEL`, un solo lugar, hoy **global**.
- `api/_lib/ai-guard.js` — `guardedClaudeCall` (única frontera con Anthropic).
- Tabla `arena_journal` (`api/_lib/db.js`) — journal por corrida, **sin columna
  de cuenta/modelo como dimensión** (el `model` se guarda pero no se filtra por
  él; una fila = una corrida global).
- `api/arena.js` — lee "la última decisión" (`limit 1`), asume libro único.

**Premisa a corregir (el hallazgo que define el v1):** el dashboard de Alpaca
permite **máximo 3 cuentas paper por login**, cada una con su propio par de
keys. No son ilimitadas. Esto no es un detalle de implementación — es el techo
duro de "cuántos modelos compiten con libro propio en una sola cuenta Alpaca"
(§1). El scope anterior (`alpaca-paper-scope.md §2.4`) dejó el número "a
confirmar"; ya está confirmado: **son 3**.

---

## 1. (a) Cuántas cuentas paper y cómo se gestionan las keys

### El techo: 3 cuentas paper por login

- Alpaca permite **hasta 3 cuentas paper** por usuario, cada una con balance y
  posiciones independientes. Para una 4.ª hay que abrir OTRO login de Alpaca.
- Cada cuenta se crea desde el dashboard (click en el número de cuenta arriba a
  la izquierda → "Open New Paper Account") y **genera su propio par de keys** —
  no se comparten entre cuentas.
- Cada cuenta nace con **$100K** (el default del pedido, gratis). El balance solo
  se resetea desde el dashboard, no hay endpoint de reset.

**Consecuencia directa:** con una sola cuenta Alpaca, la liga es de **N ≤ 3
modelos**. Y 3 es exactamente `haiku vs sonnet vs opus` — un modelo por tier de
Anthropic. Encaja sin fricción (§6). Para N > 3 (p.ej. sumar GPT/Gemini más
adelante) hay dos caminos, ambos fase posterior: (a) segundo login de Alpaca con
sus 3 cuentas, o (b) sub-libros lógicos sobre menos cuentas — **descartado**, es
el mismo netting fatal del scope de la flota (`alpaca-paper-scope.md §2.4`): dos
modelos operando el mismo símbolo en una cuenta se pisan las posiciones. Con
libros long-only y sin shorts el netting es menos violento que en pares, pero el
cash y el equity por modelo se contaminan igual → el leaderboard deja de ser
justo. Regla: **una cuenta paper por modelo, siempre.**

### Esquema de keys recomendado: registro en Neon, secrets en env

Hoy `alpaca.js` lee dos env vars fijas. Para N libros hay tres opciones:

| Opción | Forma | Veredicto |
|---|---|---|
| N pares de env vars sueltas | `ALPACA_PAPER_KEY_HAIKU`, `..._SECRET_HAIKU`, ×3 | Funciona pero no escala ni se audita bien; 6 vars para 3 modelos. |
| **1 env var JSON** (recom. corto plazo) | `ARENA_BOOKS='[{"slug":"haiku","alpaca_model":"claude-haiku-4-5","key":"PK…","secret":"…"},…]'` | Un solo secreto que rota junto; el código itera el array. Mismo patrón ya propuesto en `alpaca-paper-scope.md §6`. |
| Tabla `arena_books` en Neon + secrets en env por slug | fila `{slug, label, alpaca_model, env_key_ref}` en Neon; el secreto vive en `ALPACA_KEY_<SLUG>`/`ALPACA_SECRET_<SLUG>` | Lo más limpio a mediano plazo: la metadata (quién compite, qué modelo, desde cuándo) es dato de producto en Neon; el secreto sigue en env (no se commitea, no se guarda en DB). |

**Recomendación:** arrancar con **1 env var JSON** (`ARENA_BOOKS`) — el mínimo
para 3 modelos, un solo secreto que Lety agrega en Vercel. La tabla `arena_books`
es la evolución natural cuando el leaderboard necesite mostrar "compitiendo desde
el 2026-08-XX" y metadata por libro. En ambos casos `alpaca.js` deja de leer env
vars globales y pasa a recibir `{key, secret}` como parámetro (§2, refactor #1).

> Nota de seguridad: son keys de PAPER (dinero simulado, riesgo bajo) — pero aun
> así van en env/secret manager, nunca en el repo ni en columnas de Neon.

---

## 2. (b) Qué del arena-run actual es reutilizable vs qué refactorizar

Veredicto de cabecera: **~80% se reutiliza tal cual**. El arena-run ya está
escrito como una función pura de "estado del libro + contexto → órdenes"; lo que
falta es **parametrizarla por `{modelo, cuenta}`** y quitarle tres supuestos de
singleton. Nada se reescribe; se envuelve.

### Reutilizable sin tocar (el corazón)

- `buildSystemPrompt`, `buildUserPrompt`, `gatherContext` — el prompt y el buffet
  son idénticos para todos los modelos por diseño (es justo lo que pide la liga).
- `parsePlanResponse`, `validateActions`, `ARENA_RULES` — el guard es JS puro, no
  sabe de modelos; se corre igual N veces.
- `createLimitOrder` y todo el path de ejecución límite-only + idempotencia por
  `client_order_id`.
- `runArenaReconcile` — la reconciliación es por `alpaca_order_id`; funciona por
  libro sin cambios lógicos (solo hay que correrla contra cada cuenta).

### Qué refactorizar (los tres supuestos de singleton)

1. **`alpaca.js` lee env vars globales.** Hoy `alpacaCreds()` toma
   `ALPACA_PAPER_KEY/SECRET` del proceso. Refactor: cada función (`getAccount`,
   `getPositions`, `createLimitOrder`, …) recibe `creds` (o un cliente
   pre-construido con esas creds). Es el cambio más mecánico y el más extenso
   (toca cada llamada). No cambia la regla limit-only ni el hardcodeo de `type`.

2. **`model.js` es global (`ANTHROPIC_MODEL`).** Hoy un solo modelo para toda la
   app. La liga necesita el modelo **por libro** (viene de `ARENA_BOOKS[i].
   alpaca_model`). El default global sigue existiendo para el resto de la app
   (SIM, earnings, agentes); el Arena deja de usarlo y pasa el modelo explícito a
   `guardedClaudeCall`.

3. **`runArenaDecide` asume "el" libro y "el" plan anterior.** Hoy hace un
   `getAccount()`/`getPositions()` global y un `select … limit 1` del último plan.
   Refactor: envolver el cuerpo en un loop `for (book of ARENA_BOOKS)` donde cada
   iteración usa `book.creds`, `book.alpaca_model`, y el plan anterior **de ese
   libro** (el journal necesita filtrar por libro — ver abajo). El buffet y los
   `lastCloses` se calculan **UNA vez por tick** y se comparten (crítico para la
   justicia, §4).

### Cambio de esquema: `arena_journal` gana una dimensión

Hoy la tabla no distingue libros. Se agrega una columna:

```sql
alter table arena_journal add column book text;   -- 'haiku' | 'sonnet' | 'opus'
-- el 'model' ya se guarda; 'book' es el slug estable del competidor
```

Y los `select` de plan-anterior (`runArenaDecide`) y de UI (`arena.js`) pasan de
`limit 1` a `where book = $1 … limit 1`. Es aditivo: las filas viejas quedan con
`book = null` (el single-agent histórico) y no rompen nada.

### El tick, ya parametrizado (pseudo, sin implementar)

```
runArenaTick(phase=decide):
  buffet     = gatherContext(...)          # UNA vez, compartido
  lastCloses = resolveCloses(allSymbols)   # UNA vez, compartido (§4)
  for book in ARENA_BOOKS:                 # ≤ 3 iteraciones
     account, positions, prevPlan = load(book.creds, book.slug)
     llm = guardedClaudeCall(model=book.alpaca_model, system, user)
     {approved, discarded} = validateActions(...)   # mismo guard
     submit(book.creds, approved)
     journalInsert({..., book: book.slug, model: book.alpaca_model})
```

**Presupuesto de tiempo (Vercel maxDuration 60s):** 3 libros en serie ≈ 3 llamadas
LLM (1–8s c/u) + I/O Alpaca. Holgado. Si algún día N crece, correr los libros en
`Promise.all` (independientes entre sí) — pero para 3, en serie es más simple y
cabe de sobra.

---

## 3. (c) Costo por corrida por modelo — dimensionar el gasto diario

Precios API vigentes (por 1M tokens, tarifa first-party):

| Modelo | Input | Output |
|---|---|---|
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `claude-sonnet-5` | $3.00 ($2.00 intro hasta 2026-08-31) | $15.00 ($10.00 intro) |
| `claude-opus-4-8` | $5.00 | $25.00 |

**Tokens por corrida `decide`** (estimado del prompt actual): system ≈ 550 tok;
user (portfolio + plan anterior + buffet recortado) ≈ 900–1,400 tok → **input
≈ 1.8–2.0k**. `max_tokens` está en 1,500; la salida real (plan + actions JSON)
≈ 600–900 tok → **output ≈ 0.8k** sin thinking. La fase `reconcile` **no llama al
LLM** (solo poll a Alpaca) → costo IA = $0.

Costo por corrida `decide` (input 2.0k / output 0.8k, **sin extended thinking**):

| Modelo | $/corrida | ×21 días hábiles/mes |
|---|---|---|
| haiku | **~$0.006** | ~$0.13 |
| sonnet 5 (intro) | **~$0.012** | ~$0.25 |
| opus 4.8 | **~$0.030** | ~$0.63 |
| **Liga de 3 (suma)** | **~$0.048/día** | **~$1.0/mes** |

Conclusión honesta: **el gasto es despreciable** — la liga de 3 modelos cuesta
del orden de **$1–3 al mes**. El costo NO es una restricción de diseño; el techo
de 3 cuentas Alpaca sí lo es.

**La única palanca de costo real es el extended/adaptive thinking:**

- El código actual **no** setea `thinking`. En ese modo, `opus-4-8` corre sin
  pensar y `sonnet-5` corre en adaptive-on por default (omitir el campo = adaptive
  en Sonnet 5) — una asimetría que además **contamina la justicia** (§4).
- Si se activa adaptive thinking en los modelos grandes, el output puede subir a
  2–4k tok/corrida → opus ~$0.08/corrida, ~$1.7/mes. Sigue siendo trivial en
  dinero, pero cambia el perfil de latencia y **debe fijarse igual para todos**.

**Recomendación de costo/justicia:** fijar `thinking` explícito y **idéntico** en
los 3 libros (lo más limpio para v1: sin thinking / disabled donde el modelo lo
permita, o adaptive en los tres si se quiere razonamiento visible). No dejarlo al
default por-modelo. Prompt caching **no aplica** aquí: el prefijo (system ~550
tok) está por debajo del mínimo cacheable (2–4k según modelo) y la caché es
por-modelo (no se comparte entre haiku/sonnet/opus).

---

## 4. (d) Leaderboard: métricas justas y cómo journalear sin trampas

### Las cuatro condiciones de "misma carrera"

Para que la comparación sea legítima, los 3 libros deben diferir **solo en el
modelo**. Cuatro invariantes:

1. **Mismo capital y mismo arranque.** Las 3 cuentas paper se crean el mismo día,
   todas con $100K (default de Alpaca). Se habilitan en el mismo tick (misma
   fila-cero del journal). Ninguna arranca con ventaja de fecha.
2. **Mismo contexto de entrada.** El buffet (`gatherContext`) y los `lastCloses`
   de referencia del guard se calculan **UNA vez por tick** y se pasan idénticos
   a los 3 (§2). Hoy `gatherContext` corre por-run; si cada libro re-fetchea, un
   mover que cambia entre llamadas le da a un modelo datos que otro no vio → sesgo.
   **Fetch una vez, compartir el snapshot.**
3. **Mismo guard, mismas reglas.** `validateActions` con el mismo `ARENA_RULES`
   para todos. Ya es así (JS puro, sin estado de modelo).
4. **Misma mecánica de ejecución.** Límite ±2% del cierre, fill al open
   siguiente, `client_order_id` namespaced por libro (`arena:{slug}:{fecha}:
   {symbol}:{side}`). El plan anterior reinyectado es **por libro** (cada modelo
   construye sobre SU historia — eso es correcto y justo, no un sesgo).

Lo que legítimamente difiere: el plan, las acciones, y por lo tanto los fills y
el equity. Ahí vive la carrera.

### Métricas del leaderboard (fuente de verdad: Alpaca, no el plan)

Regla de oro (heredada de `alpaca-paper-scope.md §2.2`): **el rendimiento se mide
sobre fills reales de Alpaca, nunca sobre lo que el modelo "planeó".** "Decidió
entrar" ≠ "entró" (una orden puede expirar sin fill si abre fuera de la banda).

| Métrica | Cómo se calcula | Fuente |
|---|---|---|
| **Retorno neto** | `(equity − 100000) / 100000` | `GET /v2/account.equity` (Alpaca) |
| **Nº de trades** | conteo de órdenes `filled`/`partially_filled` | `arena_journal.actions` reconciliado |
| **Drawdown máx** | mayor caída peak-to-trough de la serie de equity | ver abajo |
| **Órdenes enviadas vs llenadas** | `submitted` vs `filled` (tasa de fill) | journal |
| (deriv.) **días en mercado**, **cash %** | de las snapshots diarias | Alpaca |

**Drawdown — usar la fuente que no se puede falsear:** Alpaca expone
`GET /v2/account/portfolio/history` (serie temporal de equity de cada cuenta).
El drawdown se computa de esa serie, no de una reconstrucción propia. Alternativa
(o complemento): snapshot diario de equity por libro en una tabla
`arena_equity(book, date, equity)` — se llena en el cron `reconcile` (que ya
corre post-open) y sirve para graficar la curva de cada modelo. **Recomendación:**
snapshot diario propio en Neon (para la curva del leaderboard) + `portfolio/
history` de Alpaca como verdad de auditoría cuando alguien pregunte "¿ese
drawdown es real?".

### Cómo journalear para comparar sin trampas

- **Una fila de journal por libro por tick** (columna `book`, §2). El `prompt_hash`
  ya existe: si los 3 libros comparten el mismo system+user salvo el estado del
  portfolio, el hash prueba que vieron el mismo buffet. Guardar además un
  `buffet_hash` compartido por tick sella la invariante #2 de forma auditable.
- **Snapshot de cuenta al momento de decidir** (`account` jsonb, ya existe) — deja
  el equity/cash de arranque de cada decisión, no reconstruido.
- **Reconciliación por libro:** `runArenaReconcile` corre contra las 3 cuentas;
  los fills (precio/timestamp reales) se copian al journal. El equity del
  leaderboard sale de Alpaca tras reconciliar, nunca de Neon inventado.
- **Sesgo conocido a declarar en la UI** (como hoy con `ASSUMPTIONS`): los fills
  paper son ligeramente optimistas (sin cola, sin price improvement — Alpaca lo
  documenta). Afecta a los 3 por igual, así que **no** distorsiona el ranking
  relativo — pero el retorno absoluto hay que etiquetarlo como paper-optimista.

---

## 5. (e) Modelos no-Anthropic (GPT/Gemini) — solo dimensionar

Hoy el único punto que sabe de Anthropic es `api/_lib/ai-guard.js`
(`guardedClaudeCall`): hardcodea la URL `api.anthropic.com/v1/messages`, los
headers `x-api-key`/`anthropic-version`, el shape `{model, system, messages}` y
la directiva anti-alucinación de fechas con su retry. **Todo lo demás del Arena es
provider-agnóstico** — `parsePlanResponse`, el guard, la ejecución y el journal
operan sobre texto/JSON, no les importa quién generó el string.

Qué cambiaría en la capa de IA para sumar GPT/Gemini (dimensión, **no** construir):

1. **Un adaptador por provider.** `ai-guard.js` pasa de "llama a Anthropic" a
   "router `provider → {url, auth header, request shape, response parse}`". Cada
   provider difiere en: endpoint, env var de auth (`OPENAI_API_KEY`,
   `GEMINI_API_KEY`), formato de request (OpenAI usa `messages` con `system` como
   rol; Gemini usa `contents`/`systemInstruction`) y de response (dónde vive el
   texto).
2. **La directiva anti-alucinación de fechas** (hoy inyectada en el mensaje) hay
   que re-expresarla por provider — el contenido es el mismo, el sitio donde se
   inyecta cambia con el shape.
3. **El registro de libros** (`ARENA_BOOKS`) gana un campo `provider`
   (`anthropic` | `openai` | `google`) además de `model`. El guard, el prompt y el
   journal no se tocan.
4. **Restricción de cuentas Alpaca** (§1): 3 modelos no-Anthropic adicionales =
   un segundo login de Alpaca. La capa de IA no lo resuelve; es el mismo techo de
   §1.

Tamaño estimado: **1 archivo nuevo** (`ai-providers.js` con los 2–3 adaptadores)
+ el campo `provider` en el registro. El resto del Arena queda intacto. Es una
tarde de trabajo, fase posterior — **no** parte del v1.

---

## 6. Recomendación: v1 mínimo que ya se siente carrera

**Liga de 3: `haiku-4-5` vs `sonnet-5` vs `opus-4-8`.** Un modelo por tier de
Anthropic, exactamente el techo de 3 cuentas paper (§1). Es la carrera más
legible posible ("¿el modelo caro le gana al barato manejando plata?") y no gasta
un centavo perceptible (§3).

Orden de construcción (post-confirmación de las 3 cuentas + smoke verde de cada
par de keys, mismo gate que `arena.md`):

1. **3 cuentas paper en Alpaca**, 3 pares de keys → `ARENA_BOOKS` (env JSON, §1).
2. **Refactor #1:** `alpaca.js` recibe `creds` por parámetro (deja de leer env
   global). Es el cambio más extenso; hacerlo primero y con tests.
3. **Refactor #2:** `arena_journal` gana columna `book`; los `select` de
   plan-anterior y de UI filtran por libro.
4. **Refactor #3:** `runArenaDecide` se envuelve en el loop `for book of
   ARENA_BOOKS`, con buffet + `lastCloses` calculados una vez y compartidos (§4).
   `guardedClaudeCall` recibe `book.alpaca_model`. `thinking` fijo e idéntico.
5. **`reconcile`** corre contra las 3 cuentas; snapshot diario de equity por libro
   (`arena_equity`) para la curva.
6. **Leaderboard en la UI** (`arena.js` + `app.html`): tabla ordenable por retorno
   neto, con nº de trades, drawdown y la curva de equity de cada modelo; cada
   trade con su razonamiento (el nof1 que ya se publica, ahora ×3). Etiqueta
   honesta de la casa: experimento, paper, fills paper-optimistas, no es asesoría.

Lo que el v1 NO incluye (fases posteriores, dimensionadas arriba): modelos
no-Anthropic (§5, necesita 2.º login Alpaca), N > 3, cripto, y cualquier
sub-libro lógico (descartado por netting/justicia).

---

## 7. Riesgos y decisiones abiertas

1. **Techo de 3 cuentas confirmado** — es duro. Toda ambición de N > 3 pasa por un
   segundo login de Alpaca. Decidir si eso importa antes de invertir en la capa
   multi-provider.
2. **Justicia del contexto compartido** — el fetch-una-vez del buffet es la
   invariante más frágil de implementar bien; si se rompe, el leaderboard miente.
   Sellarlo con `buffet_hash` compartido y test.
3. **Asimetría de thinking por default** — omitir `thinking` da comportamientos
   distintos por modelo (Sonnet 5 adaptive-on, Opus off). Fijarlo explícito o la
   carrera arranca sesgada.
4. **Fills paper optimistas** — afecta el retorno absoluto, no el ranking
   relativo; declararlo en la UI.
5. **Reset de equity solo por dashboard** — si un libro "muere" o se quiere
   reiniciar la temporada, es acción manual en Alpaca (no hay endpoint). Definir la
   política de temporadas antes de lanzar.
6. **Horario/calendario** — el mismo detalle de invierno/verano de `arena.md §Nota
   de horario` aplica igual; no cambia con la liga.
