// ═══════════════════════════════════════════════════════════════
// /api/leaderboard — datos públicos de la LIGA multi-modelo del Arena.
//
// Ruta pública NUEVA (no el tab MIS AGENTES): rankea a los agentes activos por
// EQUITY y, por cada uno, publica su último plan (verbatim, patrón nof1) y sus
// trades. Es la fuente de /leaderboard (página standalone) y de la versión
// compacta embebida en /hoy. Read-only, cacheado, nunca expone keys.
//
// Por cada agente activo (registry / ARENA_LEAGUE):
//   - equity/cash/posiciones de SU cuenta Alpaca (si tiene keys),
//   - última decisión journaleada (plan + acciones con resultado/fill),
//   - estado de HALT del breaker,
//   - return vs. baseline y cambio del día (last_equity de Alpaca).
// Ordenado por RETORNO desc (contra el baseline propio de cada agente); los que
// aún no operan (sin keys / Alpaca caída) caen al final sin ranking. Honesto >
// panel roto: si algo falla, el agente igual aparece con su error visible.
//
// ── EL DENOMINADOR ES PROPIO, NO GLOBAL ───────────────────────────────
// `return_pct` se divide por `arena_state.baseline_equity` del agente — el
// equity real con el que arrancó, escrito por el reset— y no por un $100k
// global. Aplanar a mercado deja un residuo distinto en cada libro; con un
// denominador compartido ese residuo se le cobra a cada agente como pérdida el
// primer día (el 2026-09-16: `control` −1.45%, `claude` −0.41%). Ver
// `_lib/arena-baseline.js`.
//
// ── LA FILA DEL BENCHMARK ─────────────────────────────────────────────
// Además de los siete va una OCTAVA fila: `S&P 500 · SPY`, $100k comprados el
// día del reset y nunca tocados (_lib/arena-benchmark.js). Se ORDENA por equity
// junto a los agentes —un benchmark al pie de la tabla se lee como nota al pie—
// pero NO toma número de ranking: `kind: 'BENCHMARK'`, `compite: false`, y los
// rangos 1..N se reparten solo entre los que decidieron algo. Si el índice
// queda arriba de todos, eso se VE en el orden; lo que no puede pasar es que
// "va ganando el S&P" salga de una fila que no jugó.
//
// `exceso_pp` por agente = su return menos el del índice. Y con `?postmortem=1`
// sale además el bloque completo con el PISO DE RUIDO (claude↔control): un
// exceso más chico que la distancia entre dos corridas idénticas no es
// habilidad. Va detrás de una bandera porque exige leer el journal de la
// sombra, y esta ruta es pública y cacheada.
//
// ENV VARS: ARENA_ENABLED · ALPACA_<ALPACA>_KEY/SECRET por agente ·
//           DATABASE_URL · ARENA_BASELINE_EQUITY (opc, default 100000).
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { getAccount, getPositions } from './_lib/alpaca.js';
import { activeAgents, agentAlpacaCreds } from './_lib/arena-registry.js';
import {
  BENCHMARK, leerBenchmark, precioBenchmark, benchmarkReturnPct, filaBenchmark, excesoVsBenchmark,
} from './_lib/arena-benchmark.js';
import { readBaselines, baselineDe, returnPct, indexarEquity, BASE_INDEX_USD } from './_lib/arena-baseline.js';

const BASELINE = (() => {
  const n = Number(process.env.ARENA_BASELINE_EQUITY);
  return Number.isFinite(n) && n > 0 ? n : 100000; // cuentas paper de Alpaca arrancan en $100k
})();

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? +(((a - b) / b) * 100).toFixed(2) : null);

const eqOf = (r) => (r && r.account && Number.isFinite(r.account.equity) ? r.account.equity : null);

// ── EL ORDEN DE LA TABLA ─────────────────────────────────────────────
// Pura, sin red, para que un test la ejercite entera.
//
// Tres cosas distintas que la gente confunde y acá NO se confunden:
//
//   - El ORDEN es por RETORNO, no por equity bruto, e incluye al benchmark. No
//     es un cambio a la decisión #6 ("rankear por equity"): mientras las siete
//     cuentas arranquen del MISMO capital, ordenar por retorno da exactamente
//     el mismo orden que ordenar por equity — es una transformación monótona.
//     Los dos órdenes solo se separan cuando el capital de arranque difiere, y
//     ahí es donde el equity bruto deja de ser justo: aplanar a mercado dejó a
//     `control` con ~$1,040 menos que a `claude`, y con orden por equity esa
//     diferencia lo deja atrás para siempre aunque los dos rindan idéntico —
//     que es justo el par que existe para rendir idéntico. El equity sigue
//     mostrándose; lo que cambia es qué decide el puesto. Empate → desempata el
//     equity.
//   - El RANGO (1, 2, 3…) es solo para los que compiten. El benchmark no
//     decidió nada: no puede ganar, así que no toma número. Por eso el rango se
//     asigna DESPUÉS de ordenar, contando solo `compite !== false` — si se
//     asignara antes, el índice se comería un puesto y "claude va 2º" sería
//     falso de una forma difícil de ver.
//   - Sin equity (sin keys, Alpaca caída, benchmark sin abrir) → al final, sin
//     rango. Un agente caído no es un agente en cero.
export function ordenarRanking({ agentes = [], bench = null } = {}) {
  const filas = [...agentes, ...(bench ? [bench] : [])];
  const retOf = (r) => (r && Number.isFinite(r.return_pct) ? r.return_pct : null);
  const conEquity = filas.filter((r) => eqOf(r) != null).sort((a, b) => {
    const ra = retOf(a), rb = retOf(b);
    // Una fila con equity pero sin retorno (baseline ilegible) no se cuela
    // arriba por un null: se ordena por equity contra las demás.
    if (ra != null && rb != null && ra !== rb) return rb - ra;
    return eqOf(b) - eqOf(a);
  });
  const sinEquity = filas.filter((r) => eqOf(r) == null);
  let puesto = 0;
  const marca = (r, orden) => ({
    id: r.id, name: r.name, kind: r.kind || 'MODELO',
    compite: r.compite !== false,
    orden, equity: eqOf(r),
    baseline_equity: r.baseline_equity ?? null,
    return_pct: r.return_pct ?? null,
    rank: r.compite !== false && eqOf(r) != null ? ++puesto : null,
  });
  return [...conEquity, ...sinEquity].map((r, i) => marca(r, i + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const enabled = process.env.ARENA_ENABLED === '1';
  const agents = activeAgents();

  // Estado de halt de TODA la tabla (es diminuta) → mapa por agent_id.
  let haltByAgent = {};
  let journalErr = null;
  try {
    await ensureSchema();
    const stateRows = await sql(`select agent_id, halted, halted_at, halted_reason, resumed_at from arena_state`);
    for (const r of stateRows) haltByAgent[r.agent_id] = r;
  } catch (err) { journalErr = String((err && err.message) || err); }

  // ── EL DENOMINADOR ES EL BASELINE PROPIO DE CADA AGENTE ──────────────
  // No un $100k global. El reset re-basa cada cuenta a SU equity real después
  // de aplanar (arena-reset paso 6), y ese mismo número tiene que ser el
  // denominador acá: si el piso del breaker es el equity real pero el retorno
  // se divide por $100k, la misma cuenta arranca en 0% para el breaker y en
  // −1.45% en la tabla pública. Si la DB no contesta, cae al global de siempre.
  const baselines = await readBaselines();

  const rows = await Promise.all(agents.map(async (agent) => {
    const creds = agentAlpacaCreds(agent);
    const out = {
      id: agent.id, name: agent.name, model: agent.model, model_label: agent.model_label,
      provider: agent.provider, house: agent.house, control: !!agent.control,
      has_keys: !!creds, account: null, positions: [], journal: null, halt: null,
      baseline_equity: baselineDe(baselines, agent.id, BASELINE),
      return_pct: null, day_change_pct: null,
    };

    // ── LA ÚLTIMA CORRIDA Y EL ÚLTIMO PLAN NO SON LO MISMO ────────────
    // Con `limit 1`, un agente cuya última corrida abortó salía como "Sin plan
    // publicado aún" aunque hubiera operado todo el día. El 2026-09-17 le pasó
    // a deepseek, control y qwen a la vez.
    //
    // Se traen las últimas corridas y se separan dos cosas que la tarjeta
    // necesita juntas: QUÉ PASÓ EN LA ÚLTIMA (status, hora — si abortó, eso hay
    // que decirlo) y CUÁL FUE EL ÚLTIMO PLAN BUENO, con su hora. Sustituir uno
    // por otro escondería el aborto, que es justo lo que no se quiere.
    try {
      const jr = await sql(
        `select run_date, status, plan, actions, account, created_at from arena_journal
         where phase = 'decide' and agent_id = $1 order by created_at desc limit 12`, [agent.id]);
      if (jr[0]) {
        out.journal = {
          run_date: jr[0].run_date, status: jr[0].status, plan: jr[0].plan,
          actions: jr[0].actions || [], created_at: jr[0].created_at,
        };
        const conPlan = jr.find((r) => r && typeof r.plan === 'string' && r.plan.trim());
        // Sólo viaja cuando es OTRA corrida: si la última ya trae plan, un
        // duplicado sólo invita a que la página muestre dos veces lo mismo.
        if (conPlan && conPlan.created_at !== jr[0].created_at) {
          out.ultimo_plan = {
            plan: conPlan.plan, status: conPlan.status,
            run_date: conPlan.run_date, created_at: conPlan.created_at,
          };
        }
      }
    } catch (err) { out.journal_error = String((err && err.message) || err); }

    const h = haltByAgent[agent.id];
    if (h) out.halt = { halted: !!h.halted, halted_at: h.halted_at || null, reason: h.halted_reason || null, resumed_at: h.resumed_at || null };

    if (creds) {
      try {
        const [account, positions] = await Promise.all([getAccount(creds), getPositions(creds)]);
        const equity = Number(account.equity);
        const lastEquity = Number(account.last_equity);
        out.account = { equity, cash: Number(account.cash), status: account.status };
        out.return_pct = returnPct(equity, out.baseline_equity);
        // ── LA VISTA INDEXADA ───────────────────────────────────────
        // Las siete arrancaron con baselines distintos (el reset aplanó y
        // aplanar no las dejó parejas). Indexar a 100,000 hace legible la
        // pantalla sin mover un dato: el ranking y los porcentajes salen
        // idénticos porque es multiplicar por una constante por cuenta.
        //
        // El equity REAL se queda donde estaba, con su nombre: nada del camino
        // de decisión lee el indexado. El breaker mide drawdown contra el real
        // — uno que mirara el indexado estaría midiendo una pantalla.
        out.equity_indexado = indexarEquity(equity, out.baseline_equity);
        out.day_change_pct = pct(equity, lastEquity);
        out.positions = positions.map((p) => ({
          symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
          market_value: Number(p.market_value),
          unrealized_pl: Number(p.unrealized_pl), unrealized_plpc: Number(p.unrealized_plpc),
        }));
      } catch (err) { out.alpaca_error = String((err && err.message) || err); }
    }
    return out;
  }));

  // ── EL BENCHMARK ─────────────────────────────────────────────────────
  // Best-effort de punta a punta: si Neon o Alpaca no contestan, la liga se
  // publica igual y la fila del índice sale con su motivo. Una tabla sin
  // benchmark es peor; una tabla que no carga es mucho peor.
  let bench = null;
  try {
    const estado = await leerBenchmark();
    // Keys de cualquier agente: `ALPACA_PAPER_KEY` (el default de la casa) puede
    // no estar puesta — en la liga cada cuenta tiene su propio par.
    const creds = agents.map(agentAlpacaCreds).find(Boolean) || null;
    const precio = estado ? await precioBenchmark({ creds, preferOpen: false }) : { ok: false, reason: 'sin_abrir' };
    bench = filaBenchmark(estado, precio.ok ? precio.price : null);
    if (estado && !precio.ok) bench.precio_error = precio.detail || precio.reason;
  } catch (err) {
    bench = { ...filaBenchmark(null, null), error: String((err && err.message) || err) };
  }

  // Ranking por EQUITY (decisión #6), con el benchmark ordenado entre medio
  // pero sin tomar puesto. Ver `ordenarRanking`.
  const ranking = ordenarRanking({ agentes: rows, bench });
  const porId = new Map(ranking.map((r) => [r.id, r]));
  for (const r of rows) r.rank = (porId.get(r.id) || {}).rank ?? null;
  if (bench) bench.rank = null;

  // El EXCESO vs. el índice, en la fila de cada agente. Es la única cifra que
  // contesta "¿le ganó al mercado?", y cuesta una resta: no merece una bandera.
  const benchReturn = bench && bench.abierto ? bench.return_pct : null;
  for (const r of rows) {
    r.exceso_pp = benchReturn != null && Number.isFinite(r.return_pct)
      ? +(r.return_pct - benchReturn).toFixed(2) : null;
  }

  const ranked = [...rows].sort((a, b) => {
    const A = porId.get(a.id), B = porId.get(b.id);
    return ((A && A.orden) || 0) - ((B && B.orden) || 0);
  });

  // ¿Los siete arrancaron del mismo capital? Si no, un único "baseline: $100,000"
  // en la cabecera es falso, y la página tiene que decir otra cosa.
  const bases = [...new Set(rows.map((r) => r.baseline_equity))];
  const body = {
    enabled, count: ranked.length,
    // El global sigue publicándose como FALLBACK declarado; el que manda es el
    // de cada fila (`agents[].baseline_equity`).
    baseline_equity: BASELINE,
    baselines_uniformes: bases.length <= 1,
    agents: ranked,
    // Fuera de `agents` a propósito: los consumidores que cuentan modelos
    // (`agents.length`) seguirían contando siete, no ocho. El benchmark no es
    // un modelo y la forma de la respuesta no debería sugerir que lo es.
    benchmark: bench,
    // El orden VISUAL, liviano: id + puesto + equity. La página arma la tabla
    // con esto y busca la fila completa por id, así el orden se decide UNA vez
    // acá y no se re-deriva en el navegador.
    ranking,
  };
  if (journalErr) body.journal_error = journalErr;

  // ── EL POST-MORTEM, detrás de bandera ────────────────────────────────
  // Exceso por agente CONTRA el piso de ruido. Exige leer el journal de la
  // sombra, que es una consulta más en una ruta pública y cacheada — por eso no
  // va en el camino por defecto.
  if (String((req.query || {}).postmortem || '') === '1') {
    // ── EL PISO SALE DEL ARCHIVO, no de recalcular el día de hoy ───────
    // Un post-mortem de temporada que recalcula el piso de HOY no sirve: el día
    // que se lee puede no tener sombra, y las filas de septiembre pueden no
    // seguir ahí en noviembre. `arena_noise_floor` guarda una fila por día con
    // las dos condiciones que hacen válido el número (mismo enfoque, mismo libro).
    let piso = null;
    let serie = [];
    try {
      const { leerPisosDeRuido } = await import('./_lib/arena-shadow.js');
      serie = await leerPisosDeRuido({ limite: 30 });
      piso = serie[0] || null;
      if (!piso) {
        piso = { comparable: false, motivo: 'todavía no hay ningún piso de ruido archivado: se archiva solo cuando claude y control comparten enfoque Y libro de arranque.' };
      }
    } catch (err) {
      piso = { comparable: false, motivo: 'no se pudo leer el piso de ruido: ' + String((err && err.message) || err) };
    }
    body.post_mortem = excesoVsBenchmark({
      agentes: rows.filter((r) => r.compite !== false),
      benchmarkReturn: benchReturn,
      pisoDeRuido: piso,
    });
    // La SERIE, no solo el último. Un piso de 0.77 no significa lo mismo si los
    // tres días previos dieron 0.93: lo primero es un día raro, lo segundo es el
    // sistema. Sin la serie, cada piso se lee como si fuera el único que hubo.
    body.post_mortem.piso_de_ruido_serie = serie;
    if (serie.length >= 2) {
      const xs = serie.map((p) => p.cosine).filter(Number.isFinite);
      const media = +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3);
      body.post_mortem.piso_de_ruido_media = { dias: xs.length, media, min: Math.min(...xs), max: Math.max(...xs) };
    }
  }

  // El equity intradía cambia poco para un ranking; el journal es diario.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(body);
}
