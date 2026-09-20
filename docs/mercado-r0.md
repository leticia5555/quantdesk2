# R0 — Cimientos del mapa

> **Qué es:** la rebanada previa a R1, abierta después del **NO-GO** de la
> Fase 0 (`docs/mercado-fase0.md` §9). Ataca las dos compuertas rojas que
> dependen de datos nuestros.
>
> **Qué NO es:** no hay UI, no se toca `app.html`, no hay treemap. R0 construye
> y verifica tablas; R1 pinta.
>
> **G9 (Form 4) no se toca acá.** Sigue siendo el pipeline de R5, con sus
> 30–40 h. O sea que **la re-corrida al final de R0 va a seguir dando NO-GO
> global**, y está bien: el criterio de avance que fijaste es más fino que el
> tablero — **GO a R1 con G1 y G2 en verde**, no con el tablero entero.
>
> | Gate rojo | Lo abre |
> |---|---|
> | **G1** universo US | R0(a) |
> | **G2** capitalización MX | R0(b) + R0(c) + R0(d) |
> | **G9** Form 4 | **R5**, no R0 |

---

## 0. Lo que tenés que leer antes que nada

**Hay un bloqueante en la instrucción (c), y no lo descubrí escribiendo
código: ya estaba medido en el repo.**

`docs/bmv-rotation.md` §4.4, del censo de Fase 1b que corrió con token real:

> Del censo de Fase 1b: **acciones en circulación** históricas y el desglose
> `ifrs_mx` de deuda con costo **son de la extensión mexicana, no de
> `ifrs-full`**. **Sin acciones no hay capitalización**, y por eso este
> backtest usa EPS/precio y no book-to-market ni un filtro de tamaño. *No es
> una preferencia metodológica: es lo que los datos permiten.*

O sea: **está medido que `/v2/financieros` de DataBursatil no trae acciones en
circulación**, y tampoco hay en el repo evidencia de un endpoint de
capitalización (el censo cubrió `/v2/emisoras`, `/v2/financieros`,
`/v2/historicos` y `/v2/creditos`; ninguno es de cap).

No lo doy por cerrado, porque "no lo vio el censo de Fase 1b" no es lo mismo
que "no existe", y porque la instrucción es tuya y merece medirse antes de
contradecirla. Así que **R0(c) es un job que lo resuelve — y que no cuesta un
solo crédito**, porque el cosechador guarda el JSON crudo completo en
`bmv_financieros.raw` y la búsqueda corre sobre lo ya guardado (§3).

**Lo que esto implica para el orden de R0:** (c) va **primero**. Sin
referencia de cap no hay verificación, y sin verificación **todas** las
emisoras salen gris punteadas — G2 no puede ponerse verde. Los jobs (a), (b) y
(d) corren igual y entregan valor, pero G2 depende de (c).

Y una consecuencia de la misma medición, que además resuelve (d) sola: **los
bancos quedan fuera de `/v2/financieros`**. `pendientesFinancieros` descarta a
toda emisora sin `fin_periodos` — "el mismo `continue` que filtra bancos y
casas de bolsa", el que dejó a Quálitas con 0 trimestres
(`docs/bmv-rotation.md` §3). GFNORTE es un banco. Tu propia instrucción ya
escribió el desenlace: *"si no, gris punteado (B)"*.

---

## 1. R0(a) — `mercado_universo_us`

**El problema que resuelve** (Fase 0 §3.1): el sector no está precomputado. Vive
como industria cruda de Finnhub en la caché por día del buffet, que se llena
solo con los símbolos que el Arena tocó ese día — unidades, no centenas.

```sql
create table if not exists mercado_universo_us (
  symbol       text primary key,
  nombre       text,
  industria    text,          -- la cadena cruda de Finnhub, para auditar el mapeo
  sector_etf   text,          -- XLK · XLF · … vía sectorFromIndustry
  market_cap   numeric,
  cap_fuente   text,          -- 'finnhub:metric' | 'neon:arena_market_cap' | 'previa'
  actualizado  timestamptz not null default now()
);
```

**Los símbolos salen de `arena_universe`**, que ya se reconstruye por cron a
las 9:00 ET con S&P 500 + Nasdaq 100 + movers (~600). R0 **no duplica** ese
trabajo: lo consume.

### Tres decisiones que vale la pena justificar

**1. Una fila incompleta ENTRA a la tabla, con `faltan`.** Un símbolo ausente
y uno sin cap se ven igual en un `count(*)` y son problemas distintos. El
render decide qué hacer; la tabla no esconde.

**2. Solo se pide a Finnhub lo que hace falta.** Esto es lo que decide si cabe
en el tier gratis (60 req/min):

| Dato | Cuándo se pide | Por qué |
|---|---|---|
| `profile2` (nombre + industria) | solo si no hay industria guardada | la industria de una empresa cambia cada varios años — el mismo argumento que ya justifica la caché por día del Arena |
| `metric` (cap) | solo si la cap tiene más de 36 h **y** el Arena no la midió ya | `arena_market_cap` es gratis y tiene su propia política de TTL; pedirla otra vez sería pagar dos veces por el mismo número |

En régimen, el cron diario pide **~0 profiles y N caps**. La primera corrida
es la cara.

**3. `marketCapitalization` de Finnhub viene en MILLONES**, y se convierte al
guardar. Guardarla cruda habría hecho que Apple midiera lo mismo que una small
cap con la cap en unidades — y el treemap dimensiona por ese número.

### Lo que el job reporta

`g1_proyectado` adelanta si G1 va a pasar, sin esperar al censo completo. Y
`industrias_sin_mapear` cuenta lo que **ninguna regla** de `SECTOR_RULES`
tocó: una falla de cobertura tiene que verse como falla de cobertura, no
disolverse en un bucket.

**Cron:** `30 13 * * 1-5` en `vercel.json` (30 min después de `arena:universe`,
que le da los símbolos), registrado en `/api/cron-status` como
`mercado:universo` — si no, el día que se caiga nadie se entera.

---

## 2. R0(b) — las unidades MX

```
cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
```

`emisoras.json` gana tres campos por emisora: `acciones_por_unidad`,
`serie_liquida` y `unidad_verificado`.

### Los cuatro divisores: declarados por vos, NO verificados por mí

| Emisora | Serie | Divisor | Fuente |
|---|---|---|---|
| FEMSA | `FEMSAUBD` | 5 | operador (encargo R0b) |
| KOF | `KOFUBL` | 8 | operador (encargo R0b) |
| CEMEX | `CEMEXCPO` | 3 | operador (encargo R0b) |
| TLEVISA | `TLEVISACPO` | 117 | operador (encargo R0b) |

Pediste "verifica cada una contra el prospecto/BMV y reporta la fuente". **No
puedo**: este contenedor no llega a `bmv.com.mx` ni a un prospecto (§0 de la
Fase 0). Marcarlos verificados sería inventar una fuente, así que los cuatro
entran con **`unidad_verificado: false`** y `unidad_fuente: "operador"`. Hay un
test que falla si alguien los marca verificados sin medirlos.

### Pero un divisor sí se puede MEDIR — y contra el dato mismo

Si el divisor es correcto, `acciones × precio / apu` tiene que cuadrar con la
cap de referencia. Si no cuadra, **el cociente da el divisor implícito**. Eso
es mejor que leer un prospecto: el dato que se usa es el mismo que se verifica.

`verificaDivisor` tiene tres desenlaces, y los tres se reportan distinto:

| Estado | Qué significa | Qué hacer |
|---|---|---|
| `cuadra` | el divisor declarado produce la cap correcta | `unidad_verificado: true` |
| `divisor_corregido` | el implícito es **otro entero limpio** | el declarado está mal y el dato dice cuál es. Accionable sin preguntarle a nadie |
| `no_es_de_unidad` | el implícito **no** es un entero limpio | el error NO viene del empaquetado: acciones mal extraídas, serie que no cotiza, recompras. Mirar a mano |

**El tercero es el que importa.** Un "redondeá al entero más cercano" lo
escondería: un implícito de 1.37 se volvería un divisor de 1 y el error
quedaría archivado como "cuadra". Hay un test que planta ese caso.

Dos detalles que el código cuida y que rompen si se los olvida:

- **El implícito se COMPONE con el declarado.** Con `apu=5` y un factor 2
  sobrante, el real es 10, no 2. Olvidarlo daba divisores al cuadrado.
- **Hay un techo (`max_divisor: 500`).** 117 es un divisor real (TLEVISA CPO);
  4,812 es un error de unidades (miles vs unidades) disfrazado de divisor.

### La serie líquida también se contrasta

El registro declara una `serie_liquida` por emisora. El job **no le cree**: la
compara contra la serie con más importe operado en `bmv_precios` y reporta
`series_que_discrepan`. Una serie declarada mal produce una cap mal con todos
los demás campos correctos, que es el error más difícil de ver.

---

## 3. R0(c) — la referencia de capitalización

`?job=refcap` recorre el **crudo ya guardado** en `bmv_financieros.raw` y
devuelve **toda** llave que hable de acciones o de capitalización, con su ruta
y su valor. No adivina cuál es la buena: las encuentra todas y las reporta.

Es el mismo criterio que el `?job=diagnostico&que=eps` de `bmv-rotation`, que
saca todas las llaves de acciones y marca cuál reproduce el EPS guardado.

| Veredicto | Qué sigue |
|---|---|
| `GO` — hay cap | R0(b) verifica contra ella. G2 puede ponerse verde |
| `GO PARCIAL` — no hay cap pero **sí acciones** | la referencia se calcula con el precio. Sirve igual |
| `NO-GO` — ni una ni otra | **decisión tuya**, no un default que yo elija (§6) |

**Costo: cero créditos de DataBursatil.** Corre sobre lo que ya está en Neon.

Una llave presente y **vacía** se reporta igual que una con valor: "la fuente
no tiene el campo" y "lo tiene en null" cierran puertas distintas. Hay un test.

---

## 4. R0(d) — GFNORTE

`?job=gfnorte` mira tres cosas por separado, porque fallan por motivos
distintos: si hay **precio** en `bmv_precios`, si hay **financieros** de
DataBursatil, y si hay **XBRL**.

- **Precio:** probablemente sí. `bmv_precios` guarda todas las series del
  censo; el filtro `tipo_valor_id = '1'` se aplica al consultar el universo,
  no al cosechar.
- **Acciones:** probablemente no, por partida doble. Los bancos quedaron fuera
  de ICS (`xbrl-fase0` §2.1) **y** fuera de `/v2/financieros`
  (`bmv-rotation` §3).

Tu instrucción ya escribió las dos ramas, así que el job solo reporta cuál
toca: **"ENTRA con etiqueta `cap: databursatil`"** o **"GRIS PUNTEADO
(opción B)"**.

**El job NO agrega GFNORTE a `emisoras.json`.** Agregarlo sin cap sería crear
un cuadro que nunca se puede pintar; se agrega cuando el veredicto sea el
primero.

---

## 5. R0(e) — el parser de fechas de la Fed

Pediste revisar el manejo de EDT/EST. **Lo medí antes de escribir una línea de
arreglo, y la hipótesis no se sostiene:**

```
OK   Wed, 17 Sep 2026 14:00:00 EST  → 2026-09-17T19:00:00.000Z
OK   Wed, 17 Sep 2026 14:00:00 EDT  → 2026-09-17T18:00:00.000Z
OK   … CST, CDT, MST, MDT, PST, PDT, GMT, UT
NaN  Wed, 17 Sep 2026 14:00:00 CET
```

**El parser heredado de V8 ya conoce las zonas de EE.UU.** Si el feed de la Fed
falló, no fue por eso — y "arreglarlo" habría sido código muerto que disimula
el problema real. Hay un test que falla si alguien mete `EST` en la tabla de
zonas extra, justamente para que no se agregue por las dudas.

### Lo que sí hice, que es más útil que el arreglo pedido

1. **Las zonas que Date.parse SÍ falla, ahora se traducen**: CET/CEST, BST,
   JST, IST, y las latinoamericanas **BRT, ART, CLT, COT** — que nos importan
   porque Valor (BR) y La República (CO) están en el registro de noticias.
2. **Una zona desconocida se NOMBRA** (`zona horaria desconocida: "XYZ"`) en
   vez de contarse como "sin fecha".
3. **Una fecha sin hora se acepta y se advierte.** Un titular fechado a
   medianoche no es un titular de medianoche, y "lo de hoy" ordena por hora.
   *(Un test encontró que `Date.parse` se comía este caso antes de que el aviso
   se emitiera: la rama tuvo que ir primero.)*
4. **`diagnosticoFechas` guarda las cadenas crudas que fallaron, agrupadas por
   motivo.** Sin esto, "0% con fecha" es un callejón sin salida; con esto, la
   próxima corrida entrega las tres cadenas y el motivo se ve solo.

**Así que el GO de la Fed no lo puedo declarar desde acá.** Lo que puedo decir
es que la causa que suponíamos está descartada, y que la próxima corrida va a
traer el motivo real en vez de un booleano.

---

## 6. R0(f) — congelar las 22 URLs ganadoras

**Me falta el JSON del censo.** Cuál candidata ganó por fuente vive ahí y en
ningún otro lado: el registro quedó con las candidatas en orden, no con el
resultado.

Así que en vez de pedírtelo y esperar, la congelación es **mecánica**:

```bash
node scripts/mercado-congelar-fuentes.mjs censo.json --dry   # ver qué haría
node scripts/mercado-congelar-fuentes.mjs censo.json         # escribir
```

- La ganadora queda en `feed` **y primera en `feeds`**; las demás candidatas
  **no se borran** — si mañana muere, la siguiente ya está escrita.
- Un NO-GO deja `feed: null` **con motivo**, no borra la fuente.
- Una fuente que el JSON no menciona **se deja intacta** y se reporta.
- Un GO **sin** url ganadora es un JSON roto: se reporta y **no se escribe**.
  Preferimos un registro viejo a uno con un `feed` indefinido que después nadie
  sabe de dónde salió.
- El resumen nombra las que ganaron con una candidata **que no era la
  primera** — ese dato vale guardarlo.

**Banxico y BMV emisnet** quedan como fuente **no-RSS** en el registro, con su
plan B ya probado en el repo (`api/banxico.js` sobre el SIE;
`api/bmv-inspect.js` por HTML a 1 req/s). Eso lo escribe el mismo script
cuando el JSON diga que salieron NO-GO.

---

## 7. Lo que necesito de vos

1. **El JSON del censo** (`?job=todo`), para R0(f) y para dimensionar R0(a).
   Sin él, "G1 rojo" no dice si faltaron 20 nombres o 400.
2. **Una decisión, si `?job=refcap` sale NO-GO** (§0 y §3): sin referencia de
   cap, G2 no puede ponerse verde. Las opciones, y mi lectura:

| | Qué implica | Mi lectura |
|---|---|---|
| **Volver a Yahoo** solo como *verificador* | la cap que se PINTA sigue siendo `calc`; Yahoo solo dice si cuadra | **La que yo elegiría.** Lo que rechazaste fue Yahoo como fuente del número, y esto no lo es: es el patrón de referencia del §3.2 de la Fase 0, que ya funcionó |
| **Verificar con EPS** | `utilidad ÷ EPS` da el denominador implícito del emisor, y se contrasta con `acciones_circulacion` | Elegante y sin fuentes nuevas, pero mide otra cosa: el EPS va sobre promedio ponderado (IAS 33), no sobre el saldo al cierre. `bmv-rotation` §1 ya midió un 17% de brecha en FEMSA por esto |
| **Sin verificar** | las 30 emisoras salen gris punteadas | Honesto, pero deja el mapa MX vacío y G2 roja para siempre |

3. **Confirmar que R0 no toca G9** — está escrito arriba, pero prefiero que
   quede dicho: la re-corrida del final de R0 va a seguir dando **NO-GO
   global** y eso no es un fracaso de R0.

---

## 8. Estado

| Ítem | Estado |
|---|---|
| (a) `mercado_universo_us` + cron | **escrito**, sin correr (no hay Neon acá) |
| (b) unidades en `emisoras.json` + verificador | **escrito y probado** con fixtures; los 4 divisores sin verificar contra prospecto |
| (c) referencia de cap | **job escrito**; hay evidencia medida de que DataBursatil no la tiene (§0) |
| (d) GFNORTE | **job escrito**; las dos ramas ya decididas por el encargo |
| (e) parser de fechas | **hecho** — y la hipótesis del encargo, descartada con la medición |
| (f) congelar 22 URLs | **herramienta escrita y probada**; falta el JSON |
| re-corrida `?job=todo` | pendiente de (a) y (c) |
