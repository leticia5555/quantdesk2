# T3 — apertura del 2026-10-20: los comandos, listos para pegar

Verificado contra el código, no de memoria: `api/arena-reset.js`,
`api/_lib/arena-baseline.js` (`setBaseline`, `marcarInicioTemporada`),
`api/_lib/arena-benchmark.js` y `api/_lib/arena-registry.js`.

```bash
BASE=https://<tu-dominio>          # producción
# ARENA_ADMIN_KEY ya cargada con `vercel env pull` (ver arena-t3-apertura.md §ROTAR)
H="x-admin-key: $ARENA_ADMIN_KEY"
```

**Requisito:** este PR mergeado y desplegado ANTES del reset. Es el que hace
que el anuncio traiga la ventana real, los días fuera de la serie y el ámbar.
Sin él, el reset funciona igual pero el anuncio sale sin esas tres líneas.

---

## 0 · ANTES DEL DRY RUN — tres trampas de idempotencia (SQL, 10 s)

El reset NO pisa tres cosas si ya existen. Si alguna de las tres sale con
filas, **pará y avisame** antes de seguir: la temporada quedaría anclada a una
fecha vieja sin que nada falle.

```sql
-- (a) ¿ya hay un inicio T3 escrito? marcarInicioTemporada no lo pisa.
select key, value, updated_at from arena_flags where key = 'season_start:T3';
-- ESPERADO: 0 filas.

-- (b) ¿ya hay un SPY de la T3? abrirBenchmark no lo re-abre.
select key, entry, shares, opened_at from arena_benchmark where key = 'benchmark:spy:T3';
-- ESPERADO: 0 filas.

-- (c) ¿la apertura automática de la T3 ya se journaleó (el 29-sep)?
select id, run_date, left(plan, 120) as plan from arena_journal
 where id = 'arena-temporada-T3-apertura';
-- ESPERADO: 1 fila del 2026-09-29 (la corrida contaminada). NO bloquea:
-- es idempotente y no se re-publica; el anuncio que vale es el del reset.
-- Se deja como evidencia. Si sale 0 filas, también está bien.
```

---

## 1 · EL RESET — dry run primero

Con Qwen en ámbar (si la puerta lo deja ahí). Sin ámbar, sacá los dos
parámetros `ambar` y `ambar_motivo`.

```bash
curl -s "$BASE/api/arena-reset?ambar=qwen&ambar_motivo=su%20proveedor%20ignora%20el%20presupuesto%20de%20razonamiento%20(reasoning.max_tokens%3A%20pidi%C3%B3%204000%2C%20razon%C3%B3%206000%20en%20el%20cierre%20real)%3B%20corre%20con%20ARENA_MAX_TOKENS%3D12000%20y%20se%20arregla%20fijando%20proveedor%20cuando%20view%3Dcierres%20diga%20cu%C3%A1l%20lo%20respeta" \
  -H "$H" | jq '{mode, reset_id, market, verdict, warnings, ambar,
    benchmark: (.benchmark | {abierto, ya_estaba, would_open, precio, note}),
    cuentas: [.accounts[] | {agent, ok, failure, equity: .before.equity,
              venderia: .would_sell, cancelaria: .would_cancel, baseline_equity}],
    anuncio: .anuncio_que_se_publicaria}'
```

**Lo que tenés que ver:**

| campo | esperado |
|---|---|
| `mode` | `"dry_run"` |
| `reset_id` | `"arena-t3-2026-10-20"` |
| `market.is_open` | `true` — con el mercado cerrado las ventas se encolan y NO llenan |
| `verdict` | `DRY RUN — se cancelarían N órdenes y se venderían M posiciones en 7 cuentas. Nada se tocó.` |
| `warnings` | `[]` |
| `ambar` | `[{agent: "qwen", motivo: "su proveedor ignora…"}]` (o `[]` sin ámbar) |
| `benchmark` | `would_open: true`, `ya_estaba` ausente, `precio` = SPY de hoy |
| `cuentas` | **7**, todas `ok: true`, ninguna con `failure` |
| `anuncio` | las líneas de abajo |

**Las líneas del anuncio, en este orden:**

1. `RESET DE LIBROS — arena-t3-2026-10-20. …`
2. `VENTANA DE LA TEMPORADA: 2026-10-20 → 2026-10-30, 9 sesiones hábiles. … La ventana PLANEADA era 2026-10-01 → 2026-10-30 (4.4 semanas); este corte la acorta…`
3. `BASELINE de la temporada: el EQUITY REAL de cada cuenta…` (siete montos)
4. `CAPITAL DE ARRANQUE, que NO es igual entre los siete: claude $… (posición mínima $…) · …`
5. `ENFOQUE DEL DÍA — LA REJILLA COMPLETA … 9 sesiones … Reparto por agente — …`
6. `DÍAS FUERA DE LA SERIE de la T3 … 2026-09-29 [corrio_contaminado] — … · 2026-09-30 [detenida_a_proposito] — …`
7. `EN ÁMBAR AL ABRIR: qwen — …` (sólo si se pidió)
8. `CORTE DE MEMORIA…` · `BENCHMARK PASIVO…` · `Las métricas de ANTES y DESPUÉS…`

**Cualquier `failure`, `warnings` no vacío o `is_open: false`: NO se aprieta.**

### El reset de verdad — mismo comando + `&confirm=1`

```bash
curl -s "$BASE/api/arena-reset?confirm=1&ambar=qwen&ambar_motivo=<el mismo de arriba>" \
  -H "$H" | jq '{mode, reset_id, verdict, warnings, inicio_temporada, journaled,
    watch, benchmark: (.benchmark | {abierto, temporada, entry, shares}),
    cuentas: [.accounts[] | {agent, flat, baseline_equity, baseline_written, starting_drawdown_pct}]}'
```

| campo | esperado |
|---|---|
| `mode` | `"applied"` |
| `verdict` | `VERDE: las 7 cuentas quedaron planas y re-basadas a SU equity real (las siete arrancan en 0.00%). Vigilante reactivado. Corte journaleado como arena-t3-2026-10-20.` |
| `warnings` | `[]` |
| `inicio_temporada` | `{start: "2026-10-20", ya_estaba: false}` |
| `journaled` | `true` |
| `benchmark` | `abierto: true, temporada: "T3"`, `entry` = SPY de hoy |
| `cuentas` | 7 × `flat: true, baseline_written: true, starting_drawdown_pct: 0` |

`PARCIAL:` en el verdict → no se abre. El reset es idempotente: se puede
volver a correr con el mercado abierto.

---

## ENTRE LOS DOS · arranque limpio (SQL — siete líneas)

```sql
select s.agent_id,
       s.halted,                                   -- false
       s.baseline_at::date        as baseline_dia, -- 2026-10-20
       s.baseline_equity,                          -- no nulo
       s.baseline_id,                              -- arena-t3-2026-10-20
       (select count(*) from arena_journal j
         where j.agent_id = s.agent_id
           and j.created_at > s.baseline_at)  as corridas_despues  -- 0
  from arena_state s
 where s.agent_id in ('claude','control','openai','grok','gemini','deepseek','qwen')
 order by 1;
```

**Verde = 7 filas, `halted = false`, `baseline_dia = 2026-10-20`,
`baseline_equity` no nulo, `baseline_id = arena-t3-2026-10-20`,
`corridas_despues = 0`.** La última columna es la que demuestra que nada corrió
contra el libro nuevo antes de abrir.

Y las tres que cierran el corte:

```sql
select value->>'start' as inicio from arena_flags where key = 'season_start:T3';   -- 2026-10-20
select entry, shares, opened_at::date from arena_benchmark where key = 'benchmark:spy:T3';  -- 1 fila, hoy
select id, status, context->'ambar' as ambar from arena_journal where id = 'arena-t3-2026-10-20';  -- rules_changed
```

---

## 2 · QUITAR EL HALT — que en código son DOS cosas distintas

**(a) El halt de `arena_state` ya NO existe después del reset.** `setBaseline`
escribe `halted = false, halted_at = null, halted_reason = null` por agente
(`api/_lib/arena-baseline.js`). La columna `halted` del SQL de arriba es la
prueba. No hay curl que correr para esto, y no hace falta el
`update arena_state set halted = false` del runbook del 30-sep.

**(b) Lo que de verdad mantiene la liga cerrada es `ARENA_ENABLED`.** Es una
env var, no un curl: Vercel → `ARENA_ENABLED=1` → **redeploy sin caché**.
Después, la verificación (la del 0-bis: el juez es el runtime, no el panel):

```bash
curl -s "$BASE/api/arena-audit?compuertas=1" -H "$H" | jq '{build, compuertas: (.compuertas | {liga_habilitada, ARENA_ENABLED, ARENA_MAX_TOKENS, techo_de_salida, presupuesto_razonamiento, lectura})}'
```

| campo | esperado |
|---|---|
| `build` | el SHA del deploy nuevo |
| `liga_habilitada` | `true` |
| `ARENA_ENABLED` | `"1"` |
| `ARENA_MAX_TOKENS` | `"12000"` |
| `techo_de_salida.efectivo` | `12000`, sin `aviso` |
| `presupuesto_razonamiento.qwen` / `.deepseek` | `{crudo: null, efectivo: null}` |
| `lectura` | `LA LIGA CORRE: arena-run decide y arena-watch dispara.` |

La primera ronda fija después de eso es la apertura.
