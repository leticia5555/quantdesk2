// ═══════════════════════════════════════════════════════════════════
// /api/earnings-beat-v2 — earnings-beat v2 / v2.1: "barra vs consenso vigente".
//
// VISTAS (solo leen datos; aseguran que las tablas existan):
//   GET ?format=md                 mercados ABIERTOS hoy, por |desacuerdo A| desc
//   GET ?resueltos=1&format=md     ya resueltos, con acierto A, B y PM
//   GET ?validacion=1&format=md    el PILOTO de 22 (piloto-oct26), SIN veredicto
//   GET ?validacion=v21&format=md  el set v2.1 pre-registrado + veredicto
//
// JOBS (cron, CRON_SECRET):
//   ?job=mercados_v2   cosecha v2.1: mercados de earnings de Polymarket SIN
//                      filtro de universo → pm_earnings_markets_v2, con el Yes
//                      a T-24h. No toca la cosecha de v1.
//   ?job=hist          historial AV para símbolos que NO están en
//                      pead_earnings → pm_v2_hist. EARNINGS_V2_HIST_ENABLED=1.
//                      &symbols=AAL,PCG para pedir unos en particular.
//   ?job=diario        recalcula pm_earnings_v2_features y, con
//                      EARNINGS_V2_VIGENTE_ENABLED=1, captura el consenso
//                      vigente de Alpha Vantage.
//
// Los mercados se leen de pm_earnings_markets_v2 y, para lo que la cosecha
// v2.1 todavía no vio, de pm_earnings_markets (v1). El historial, de
// pead_earnings y, para el resto, de pm_v2_hist.
//
// Papel. Nada de esto va a la tab EARNINGS (docs/earnings-beat-v2.md).
//
// ── Alpha Vantage ──────────────────────────────────────────────────
// El cupo diario (25) es compartido y hoy es del wheel (docs/wheel-fase0.md
// §4.3). Las dos capturas están APAGADAS por default; prendidas, respetan el
// mismo guard pead_api_budget: el consenso vigente gasta ≤ 5 por corrida y el
// historial ≤ 10.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opc) · ALPHAVANTAGE_API_KEY (opc) ·
//           EARNINGS_V2_VIGENTE_ENABLED (opc) · EARNINGS_V2_HIST_ENABLED (opc)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { beat } from './_lib/heartbeat.js';
import { gamma, clob } from './_lib/polymarket.js';
import {
  normalizaMercado, indiceYes, resuelveSimbolo, construyeIndiceNombres, extraeConsensoEps,
  outcomeResuelto, tokenYes, clasificaParaV1, cruzaConPead, isoDia,
} from './_lib/earnings-beat.js';
import { descubrePorBusqueda, descubrePorSimbolo, precioDeUnMercado, CONCURRENCIA_CLOB } from './_lib/earnings-beat-descubrir.js';
import { preparaFila } from './_lib/earnings-beat-db.js';
import { fetchEarnings } from './_lib/av-earnings.js';
import { budgetUsed, budgetAdd, ensurePeadSchema } from './_lib/pead-db.js';
import {
  VALIDACION_V2, CORTE_VALIDACION, CRITERIOS_V2, CRITERIOS_V21, SET_PILOTO, UNIVERSO,
  leeMercado, eligeMercadoPiloto, filaV21, trimestreDelReporte, veredictoV21, enSetV21, acierto, renderMdV21, estimadoVigenteDeAv,
} from './_lib/earnings-beat-v2.js';
import {
  ensureSchemaV2, upsertFeatures, guardaVigente, upsertHist, upsertMercadosV2,
} from './_lib/earnings-beat-v2-db.js';

export const maxDuration = 300;
export { CONSULTAS, simbolosParaBuscar };

const AV_TOPE_DIARIO = 25;
const AV_POR_CORRIDA = 5;       // consenso vigente
const AV_HIST_POR_CORRIDA = 10; // historial (encargo v2.1)
const AV_ESPACIO_MS = 11000;
const PRESUPUESTO_MS = 240000;
const PRESUPUESTO_DESCUBRIR_MS = 160000; // el resto queda para el precio a T-24h
const HIST_FRESCO_DIAS = 80;    // un símbolo con historial más nuevo que esto no se vuelve a pedir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────── consultas ───────────────────

const COLS_MERCADO = `market_id, symbol, slug, question,
       to_char(coalesce(report_date, resolved_date), 'YYYY-MM-DD') as fecha,
       to_char(creado, 'YYYY-MM-DD') as creado,
       to_char(creado at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as creado_ts,
       outcome, abierto, yes_price_t24h, yes_price_estado, consensus_pm, raw`;

// v2.1 primero; de v1 solo lo que v2.1 todavía no tiene.
const SELECT_MERCADO = `select * from (
  select ${COLS_MERCADO}, 'v2' as cosecha from pm_earnings_markets_v2
  union all
  select ${COLS_MERCADO}, 'v1' as cosecha from pm_earnings_markets m
   where not exists (select 1 from pm_earnings_markets_v2 v where v.market_id = m.market_id)
) u`;

// Todas las consultas en un solo lugar, para que tests/earnings-beat-v2.test.mjs
// las PREPARE contra un Postgres real (el SQL sin verificar es cómo el mapa
// llegó roto a producción). `n` = cuántos símbolos van en el IN.
const ph = (n, desde = 1) => Array.from({ length: n }, (_, i) => `$${i + desde}`).join(', ');
const CONSULTAS = {
  historial: (n) => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, reported_eps, estimated_eps
      from pead_earnings where symbol in (${ph(n)}) order by reported_date desc`,
  historialV2: (n) => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, reported_eps, estimated_eps
      from pm_v2_hist where symbol in (${ph(n)}) and reported_date is not null order by reported_date desc`,
  gaps: (n) => `select symbol, to_char(quarter_end, 'YYYY-MM-DD') as quarter_end, concepto, brecha_por_accion,
             afecta, tipo, fuente_url, verificada, to_char(anunciado_en, 'YYYY-MM-DD') as anunciado_en
      from pm_known_gaps where symbol in (${ph(n)})`,
  guias: (n) => `select symbol, to_char(quarter_end, 'YYYY-MM-DD') as quarter_end, metrica, alcance, guia_min, guia_max,
             ytd_reportado, trimestres_restantes, fuente_url, verificada
      from pm_company_guidance where symbol in (${ph(n)})`,
  vigentes: () => `select market_id, consenso_vigente from pm_earnings_v2_features where consenso_vigente is not null`,
  abiertos: () => `${SELECT_MERCADO}
     where outcome is null and fecha >= to_char(current_date, 'YYYY-MM-DD')
     order by fecha asc`,
  resueltos: () => `${SELECT_MERCADO}
     where outcome is not null
     order by fecha desc limit $1`,
  semillas: () => `select symbol, to_char(fecha_mercado, 'YYYY-MM-DD') as fecha, market_id,
            metrica_barra, barra, consenso_creacion, prob_pm_t24, outcome, actual_eps
       from pm_v2_validation where set = $1`,
  validacion: (n) => `${SELECT_MERCADO}
     where symbol in (${ph(n)}) and fecha between '2026-10-15' and '2026-12-31'`, /* date-lint-ok: ventana ancha del piloto; el cruce fino lo hace eligeMercadoPiloto */
  setV21: () => `${SELECT_MERCADO}
     where creado between $1 and $2 and fecha < $3`,
  // job hist: quiénes NO necesitan llamada (están en PEAD o tienen historial fresco)
  conPead: (n) => `select distinct symbol from pead_earnings where symbol in (${ph(n)})`,
  histFresco: (n) => `select symbol from pm_v2_hist where symbol in (${ph(n)})
      group by symbol having max(capturado_en) > now() - ($${n + 1})::int * interval '1 day'`,
  simbolosCosechados: () => `select distinct symbol from pm_earnings_markets_v2 where symbol is not null`,
  pendientesPrecioV2: () => `select market_id, slug, question, symbol, yes_token_id, creado, universo_pead,
            to_char(resolved_date, 'YYYY-MM-DD') as resolved_date, abierto
       from pm_earnings_markets_v2
      where abierto = true or yes_price_estado is null or yes_price_estado not in ('valido', 'rancio')
      order by resolved_date desc nulls last limit $1`,
  peadRecientes: () => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date
       from pead_earnings where reported_date >= current_date - interval '400 days'`,
};

// ─────────────────── carga ───────────────────

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Fila de mercado (v1 o v2) → entrada de filaV21 (sin historial).
function mercadoDesdeFila(r, vigentes) {
  const norm = normalizaMercado(r.raw && typeof r.raw === 'object' ? r.raw : {}) || {};
  const m = { slug: r.slug || norm.slug, pregunta: r.question || norm.pregunta, descripcion: norm.descripcion };
  const lec = leeMercado(m);
  // prob PM: el precio VÁLIDO a T-24h (mismo candado que v1). Si todavía no
  // existe (mercado abierto), el último outcomePrices de Gamma, marcado.
  let prob_pm_t24 = r.yes_price_estado === 'valido' && r.yes_price_t24h !== null ? Number(r.yes_price_t24h) : null;
  let prob_pm_fuente = prob_pm_t24 !== null ? 't24h' : null;
  if (prob_pm_t24 === null && !r.outcome) {
    const iy = indiceYes(norm.outcomes);
    const p = iy === null ? null : norm.precios_outcome[iy];
    if (p !== null && p !== undefined) { prob_pm_t24 = p; prob_pm_fuente = 'gamma_ahora'; }
  }
  return {
    market_id: r.market_id, symbol: r.symbol, fecha: r.fecha, creado: r.creado || isoDia(norm.creado),
    metrica_barra: lec.metrica_barra, metrica_via: lec.metrica_via, metrica_motivo: lec.metrica_motivo, barra: lec.barra,
    consenso_creacion: lec.consenso_creacion ?? num(r.consensus_pm),
    consenso_vigente: vigentes.get(r.market_id) ?? null,
    prob_pm_t24, prob_pm_fuente, outcome: r.outcome, cosecha: r.cosecha || null,
  };
}

async function contexto(mercados) {
  const simbolos = [...new Set(mercados.map((m) => m.symbol).filter(Boolean))];
  if (!simbolos.length) return { hist: new Map(), fuente: new Map(), gaps: [], guias: [] };
  const [pead, av, gaps, guias] = await Promise.all([
    sql(CONSULTAS.historial(simbolos.length), simbolos),
    sql(CONSULTAS.historialV2(simbolos.length), simbolos).catch(() => []),
    sql(CONSULTAS.gaps(simbolos.length), simbolos).catch(() => []),
    sql(CONSULTAS.guias(simbolos.length), simbolos).catch(() => []),
  ]);
  // pead_earnings manda; pm_v2_hist solo para quien no tiene PEAD.
  const hist = new Map();
  const fuente = new Map();
  for (const [filas, nombre] of [[pead, 'pead'], [av, 'pm_v2_hist']]) {
    const porSim = new Map();
    for (const h of filas) {
      if (!porSim.has(h.symbol)) porSim.set(h.symbol, []);
      porSim.get(h.symbol).push(h);
    }
    for (const [s, f] of porSim) if (!hist.has(s)) { hist.set(s, f); fuente.set(s, nombre); }
  }
  return { hist, fuente, gaps, guias };
}

function construyeFilas(mercados, ctx) {
  return mercados.map((m) => {
    const q = trimestreDelReporte(m.fecha);
    const gaps = ctx.gaps.filter((g) => g.symbol === m.symbol && g.quarter_end === q);
    // La guía de la MISMA métrica que la barra, si la hay; si no, la que haya
    // (la columna se muestra igual; prob_B solo la usa si la métrica coincide).
    const guias = ctx.guias.filter((g) => g.symbol === m.symbol && g.quarter_end === q);
    const guia = guias.find((g) => g.metrica === m.metrica_barra) || guias[0] || null;
    const f = filaV21({ mercado: m, historial: ctx.hist.get(m.symbol) || [], fuenteHist: ctx.fuente.get(m.symbol) || null, gaps, guia });
    return { ...f, prob_pm_fuente: m.prob_pm_fuente || null, cosecha: m.cosecha || null,
      ...(m.piloto_cruce ? { piloto_cruce: m.piloto_cruce } : {}) };
  });
}

async function vigentesGuardados() {
  const rows = await sql(CONSULTAS.vigentes()).catch(() => []);
  return new Map(rows.map((r) => [r.market_id, Number(r.consenso_vigente)]));
}

async function mercadosAbiertos(vigentes) {
  return (await sql(CONSULTAS.abiertos())).map((r) => mercadoDesdeFila(r, vigentes));
}

async function mercadosResueltos(vigentes, limite) {
  return (await sql(CONSULTAS.resueltos(), [limite])).map((r) => mercadoDesdeFila(r, vigentes));
}

async function mercadosSetV21(vigentes) {
  const c = CRITERIOS_V21;
  const rows = await sql(CONSULTAS.setV21(), [c.creado_desde, c.creado_hasta, c.resuelve_antes]);
  return rows.map((r) => mercadoDesdeFila(r, vigentes)).filter((m) => enSetV21(m));
}

// El piloto de 22. La semilla de pm_v2_validation manda en la resolución (no
// depende de que Polymarket los marque) y completa la barra de los que no
// están en ninguna cosecha. El market_id se busca por símbolo + fecha (± 1
// día: Polymarket fecha por la resolución y pead_earnings por el reporte).
async function mercadosPiloto(vigentes) {
  const semillas = await sql(CONSULTAS.semillas(), [SET_PILOTO]).catch(() => []);
  const porClave = new Map(semillas.map((s) => [`${s.symbol}|${s.fecha}`, s]));
  const simbolos = [...new Set(VALIDACION_V2.map((v) => v.symbol))];
  const pm = await sql(CONSULTAS.validacion(simbolos.length), simbolos);
  return VALIDACION_V2.map(({ symbol, fecha }) => {
    const s = porClave.get(`${symbol}|${fecha}`) || {};
    const fijo = s.market_id ? pm.find((x) => x.market_id === s.market_id) : null;
    const eleccion = fijo ? { mercado: fijo, via: 'semilla', ambiguo: false, descartados_por_corte: 0 }
      : eligeMercadoPiloto(pm, { symbol, fecha, barraSemilla: num(s.barra) });
    const r = eleccion.mercado;
    const base = r ? mercadoDesdeFila(r, vigentes) : { market_id: null, symbol, fecha, consenso_vigente: null, prob_pm_t24: null };
    return {
      ...base,
      piloto_cruce: { via: eleccion.via, ambiguo: eleccion.ambiguo, descartados_por_corte: eleccion.descartados_por_corte },
      symbol, fecha,
      metrica_barra: base.metrica_barra || s.metrica_barra || null,
      barra: base.barra ?? num(s.barra),
      consenso_creacion: base.consenso_creacion ?? num(s.consenso_creacion),
      prob_pm_t24: base.prob_pm_fuente === 't24h' ? base.prob_pm_t24 : num(s.prob_pm_t24),
      prob_pm_fuente: base.prob_pm_fuente === 't24h' ? 't24h' : s.prob_pm_t24 !== null && s.prob_pm_t24 !== undefined ? 'semilla' : null,
      outcome: s.outcome || base.outcome || null,
      actual_eps: num(s.actual_eps),
    };
  });
}

// ─────────────────── job: mercados_v2 (cosecha sin universo) ───────────────────

// Lista de símbolos para la búsqueda por símbolo (el camino que ganó en la
// Fase 0). Sin universo no hay lista cerrada, así que se arma de lo que ya se
// sabe que tiene mercados: los 99 de PEAD + el piloto + todo símbolo que la
// cosecha v2.1 ya vio + los que se pidan. La búsqueda por FRASE corre igual y
// es la que trae símbolos nuevos; esos entran a la lista al día siguiente.
// Rota por día para que una lista más larga que el presupuesto se cubra entera
// en unos días, en vez de buscar siempre los mismos primeros.
function simbolosParaBuscar({ cosechados = [], pedidos = [], dia = 0 } = {}) {
  const todos = [...new Set([...pedidos, ...UNIVERSO, ...VALIDACION_V2.map((v) => v.symbol), ...cosechados])]
    .filter((s) => /^[A-Z][A-Z0-9.]{0,5}$/.test(s));
  const pedidosSet = new Set(pedidos);
  const resto = todos.filter((s) => !pedidosSet.has(s));
  const k = resto.length ? (dia * 37) % resto.length : 0;
  return [...pedidos.filter((s) => todos.includes(s)), ...resto.slice(k), ...resto.slice(0, k)];
}

async function jobMercadosV2(q) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const restanteDescubrir = () => PRESUPUESTO_DESCUBRIR_MS - (Date.now() - t0);
  await ensureSchemaV2();
  const rate = { http_429: 0 };
  const gamma1 = async (path, params, opts) => { const r = await gamma(path, params, opts); if (r && r.status === 'ratelimit') rate.http_429++; return r; };
  const clob1 = async (path, params, opts) => { const r = await clob(path, params, opts); if (r && r.status === 'ratelimit') rate.http_429++; return r; };

  const cosechados = (await sql(CONSULTAS.simbolosCosechados()).catch(() => [])).map((r) => r.symbol);
  const pedidos = String(q.symbols || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const dia = Math.floor(Date.now() / 86400000);
  const lista = simbolosParaBuscar({ cosechados, pedidos, dia });

  // ── 1. Descubrimiento ──
  const crudos = new Map();
  const aportes = {};
  const suma = (camino, filas) => {
    let nuevos = 0;
    for (const raw of filas || []) {
      const id = raw && raw.id !== undefined && raw.id !== null ? String(raw.id) : raw && raw.slug ? 'slug:' + raw.slug : null;
      if (!id || crudos.has(id)) continue;
      crudos.set(id, { ...raw, _via: camino, _etiqueta: raw._etiqueta || null });
      nuevos++;
    }
    aportes[camino] = (aportes[camino] || 0) + nuevos;
  };
  const porSimbolo = await descubrePorSimbolo({ simbolos: lista.length }, gamma1, restanteDescubrir, new Set(lista));
  suma('simbolo', porSimbolo.filas);
  const busqueda = await descubrePorBusqueda({}, gamma1, restanteDescubrir);
  suma('busqueda', busqueda.filas);

  // ── 2. Filtro de forma (beat/miss de EPS, el mismo de v1), SIN universo ──
  // Símbolo solo por ticker explícito ($AAL o (AAL)) o alias de nombre: sin
  // universo, el mapa de ~30k nombres de Finnhub mete coincidencias absurdas.
  const indice = construyeIndiceNombres({ nombres: null });
  const motivos = {};
  const aceptados = [];
  for (const raw of crudos.values()) {
    const m = normalizaMercado(raw);
    if (!m) continue;
    const simbolo = resuelveSimbolo(m, indice, null);
    const v1 = clasificaParaV1({ ...m, symbol: simbolo.symbol }, { etiqueta: raw._etiqueta || null, universo: null });
    motivos[v1.motivo] = (motivos[v1.motivo] || 0) + 1;
    if (!v1.acepta) continue;
    if (!simbolo.symbol) { motivos.sin_simbolo = (motivos.sin_simbolo || 0) + 1; continue; }
    const consenso = extraeConsensoEps(m.descripcion || '') || extraeConsensoEps(m.pregunta || '');
    const outcome = outcomeResuelto(m);
    aceptados.push({
      id: m.id, slug: m.slug, pregunta: m.pregunta, via: raw._via || null,
      symbol: simbolo.symbol, symbol_via: simbolo.via,
      creado: m.creado, fecha_resolucion: isoDia(m.fin),
      fin_declarado: m.fin_declarado, fin_real: m.fin_real,
      consenso_pm: consenso ? consenso.valor : null,
      outcome: outcome ? outcome.outcome : null,
      token_yes: tokenYes(m), volumen: m.volumen,
      _raw: raw,
    });
  }

  // ── 3. report_date para los que están en pead_earnings (como v1) ──
  let cruzados = aceptados;
  try { cruzados = cruzaConPead(aceptados, await sql(CONSULTAS.peadRecientes())); } catch (e) { /* sin cruce: report_date null */ }

  // ── 4. Yes a T-24h de lo nuevo, en lotes ──
  const conteo = {};
  const filas = [];
  let i = 0;
  for (; i < cruzados.length; i += CONCURRENCIA_CLOB) {
    if (restante() < 40000) break;
    const lote = cruzados.slice(i, i + CONCURRENCIA_CLOB);
    const res = await Promise.all(lote.map((m) => precioDeUnMercado(m, clob1)));
    lote.forEach((m, j) => {
      const r = res[j];
      conteo[r.clase] = (conteo[r.clase] || 0) + 1;
      const t24 = (r.fila && r.fila.yes_t24h) || {};
      filas.push({ ...preparaFila(m, { raw: m._raw, precio: { precio: t24.precio ?? null, ts: t24.ts || null, estado: r.clase } }), universo_pead: UNIVERSO.has(m.symbol) });
    });
  }
  // Lo que no alcanzó se guarda sin precio: la parte 5 de mañana lo completa.
  for (const m of cruzados.slice(i)) filas.push({ ...preparaFila(m, { raw: m._raw }), universo_pead: UNIVERSO.has(m.symbol) });
  const escritura = await upsertMercadosV2(filas);

  // ── 5. Con lo que sobre: precio de los pendientes de días anteriores ──
  const pendientes = restante() > 40000 ? await sql(CONSULTAS.pendientesPrecioV2(), [60]) : [];
  const conteoPend = {};
  const filasPend = [];
  for (let k = 0; k < pendientes.length; k += CONCURRENCIA_CLOB) {
    if (restante() < 30000) break;
    const lote = pendientes.slice(k, k + CONCURRENCIA_CLOB);
    const res = await Promise.all(lote.map((p) => precioDeUnMercado({
      id: p.market_id, slug: p.slug, pregunta: p.question, symbol: p.symbol,
      token_yes: p.yes_token_id, fecha_resolucion: p.resolved_date,
      fin_real: p.resolved_date ? p.resolved_date + 'T21:00:00Z' : null, fin_declarado: null,
    }, clob1)));
    lote.forEach((p, j) => {
      const r = res[j];
      conteoPend[r.clase] = (conteoPend[r.clase] || 0) + 1;
      const t24 = (r.fila && r.fila.yes_t24h) || {};
      filasPend.push({ ...preparaFila({ id: p.market_id, slug: p.slug, pregunta: p.question, symbol: p.symbol,
        fecha_resolucion: p.resolved_date, creado: p.creado },
      { precio: { precio: t24.precio ?? null, ts: t24.ts || null, estado: r.clase } }), universo_pead: p.universo_pead });
    });
  }
  const escrituraPend = await upsertMercadosV2(filasPend);

  return {
    job: 'mercados_v2',
    descubrimiento: { aportes_crudos: aportes, crudos: crudos.size, simbolos_en_lista: lista.length,
      simbolos_probados: porSimbolo.probados, frases: (busqueda.intentos || []).length },
    filtro: { motivos, aceptados: aceptados.length,
      fuera_universo_pead: aceptados.filter((m) => !UNIVERSO.has(m.symbol)).length },
    precios: { conteo, escritura },
    pendientes: { revisados: filasPend.length, conteo: conteoPend, escritura: escrituraPend },
    rate_limit: rate, ms: Date.now() - t0,
  };
}

// ─────────────────── job: hist (Alpha Vantage, fuera de PEAD) ───────────────────

async function jobHist(q) {
  if (process.env.EARNINGS_V2_HIST_ENABLED !== '1') return { job: 'hist', apagado: true, nota: 'EARNINGS_V2_HIST_ENABLED != 1' };
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) return { job: 'hist', error: 'ALPHAVANTAGE_API_KEY no está' };
  await ensureSchemaV2();
  await ensurePeadSchema();

  const pedidos = String(q.symbols || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const candidatos = pedidos.length ? [...new Set(pedidos)]
    : [...new Set([...VALIDACION_V2.map((v) => v.symbol), ...(await sql(CONSULTAS.simbolosCosechados())).map((r) => r.symbol)])];
  if (!candidatos.length) return { job: 'hist', llamadas: 0, nota: 'sin candidatos' };

  // Los de pead_earnings NO se piden: se leen de ahí. Los que ya tienen
  // historial fresco tampoco, salvo &forzar=1.
  const enPead = new Set((await sql(CONSULTAS.conPead(candidatos.length), candidatos)).map((r) => r.symbol));
  const frescos = String(q.forzar || '') === '1' ? new Set()
    : new Set((await sql(CONSULTAS.histFresco(candidatos.length), [...candidatos, HIST_FRESCO_DIAS])).map((r) => r.symbol));
  const cola = candidatos.filter((s) => !enPead.has(s) && !frescos.has(s));

  const dia = new Date().toISOString().slice(0, 10);
  const libres = AV_TOPE_DIARIO - (await budgetUsed(dia));
  const tanda = cola.slice(0, Math.max(0, Math.min(AV_HIST_POR_CORRIDA, libres)));
  const resultado = [];
  for (let i = 0; i < tanda.length; i++) {
    if (i) await sleep(AV_ESPACIO_MS);
    const s = tanda[i];
    const r = await fetchEarnings(s, apiKey);
    await budgetAdd(dia, 1);   // el cupo se gasta con la llamada, haya datos o no
    if (r.status === 'ok') {
      const n = await upsertHist(s, r.events);
      resultado.push({ symbol: s, estado: 'ok', trimestres: n });
    } else {
      resultado.push({ symbol: s, estado: r.status, mensaje: r.message || null });
      if (r.status === 'rate_limited') break;   // AV dijo basta: seguir es tirar cupo
    }
  }
  return {
    job: 'hist', llamadas: resultado.length, cupo_libre_antes: libres,
    en_pead_sin_llamar: [...enPead], frescos_sin_llamar: [...frescos],
    quedan_en_cola: cola.length - resultado.length, resultado,
  };
}

// ─────────────────── job: diario ───────────────────

async function jobDiario() {
  await ensureSchemaV2();
  const vigentes = await vigentesGuardados();
  const abiertos = await mercadosAbiertos(vigentes);
  const piloto = (await mercadosPiloto(vigentes)).filter((m) => m.market_id);
  const setV21 = await mercadosSetV21(vigentes);
  const todos = [...new Map([...abiertos, ...piloto, ...setV21].map((m) => [m.market_id, m])).values()];
  const filas = construyeFilas(todos, await contexto(todos));
  const escritas = await upsertFeatures(filas);

  const captura = { activa: process.env.EARNINGS_V2_VIGENTE_ENABLED === '1', intentos: [] };
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (captura.activa && !apiKey) captura.error = 'ALPHAVANTAGE_API_KEY no está';
  if (captura.activa && apiKey) {
    await ensurePeadSchema();
    const dia = new Date().toISOString().slice(0, 10);
    const libres = AV_TOPE_DIARIO - (await budgetUsed(dia));
    // Los más cercanos primero, con > 24h por delante. v2.1: sin filtro de
    // universo (el consenso vigente no depende del historial).
    const manana = Date.now() + 24 * 3600 * 1000;
    const cola = filas
      .filter((f) => f.market_id && f.symbol && Date.parse(f.fecha + 'T00:00:00Z') > manana)
      .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const porSimbolo = new Map();
    for (const f of cola) {
      let res = porSimbolo.get(f.symbol);
      if (!res) {
        if (porSimbolo.size >= Math.min(AV_POR_CORRIDA, libres)) break;
        if (porSimbolo.size) await sleep(AV_ESPACIO_MS);
        res = await fetchEarnings(f.symbol, apiKey);
        await budgetAdd(dia, 1);
        porSimbolo.set(f.symbol, res);
      }
      if (res.status !== 'ok') { captura.intentos.push({ symbol: f.symbol, estado: res.status }); continue; }
      const v = estimadoVigenteDeAv(res.events, f.quarter_end);
      if (v.valor === null) { captura.intentos.push({ symbol: f.symbol, estado: v.motivo }); continue; }
      const n = await guardaVigente(f.market_id, v.valor);
      captura.intentos.push({ symbol: f.symbol, estado: n ? 'capturado' : 'pasado_t24h', valor: v.valor });
    }
    captura.cupo_libre_antes = libres;
    captura.llamadas = porSimbolo.size;
  }
  return { job: 'diario', features_escritas: escritas, abiertos: abiertos.length, piloto_con_market_id: piloto.length, set_v21: setV21.length, captura };
}

// ─────────────────── handler ───────────────────

const LATIDO = { diario: 'earnings-beat:v2', mercados_v2: 'earnings-beat:v2-mercados', hist: 'earnings-beat:v2-hist' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const esMd = ['md', 'markdown'].includes(String(q.format || '').toLowerCase());
  const md = (txt) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(txt); };
  const job = String(q.job || '');

  try {
    if (LATIDO[job]) {
      const out = job === 'diario' ? await jobDiario() : job === 'mercados_v2' ? await jobMercadosV2(q) : await jobHist(q);
      await beat(LATIDO[job], out.apagado ? 'disabled' : 'ok', job === 'hist' ? { llamadas: out.llamadas ?? 0 } : null);
      return res.status(200).json(out);
    }

    // Las vistas solo LEEN datos, pero aseguran que las tablas existan: antes
    // de la primera cosecha v2.1, pm_earnings_markets_v2 no existe y la unión
    // con v1 fallaría. Crear una tabla vacía no es escribir datos.
    await ensureSchemaV2();
    const vigentes = await vigentesGuardados();
    const v = String(q.validacion || '');

    if (v === '1' || v === 'piloto') {
      const mercados = await mercadosPiloto(vigentes);
      const filas = construyeFilas(mercados, await contexto(mercados));
      if (esMd) return md(renderMdV21({ titulo: `earnings-beat v2 — piloto ${SET_PILOTO} (corte ${CORTE_VALIDACION}), sin veredicto`, filas, piloto: true }));
      return res.status(200).json({ vista: 'piloto', set: SET_PILOTO, veredicto: null, criterios_v2: CRITERIOS_V2, filas });
    }

    if (v === 'v21' || v === '2.1') {
      const mercados = await mercadosSetV21(vigentes);
      const filas = construyeFilas(mercados, await contexto(mercados));
      const veredicto = veredictoV21(filas, { hoy: new Date().toISOString() });
      if (esMd) return md(renderMdV21({ titulo: `earnings-beat v2.1 — set pre-registrado (creados ${CRITERIOS_V21.creado_desde}…${CRITERIOS_V21.creado_hasta})`, filas, veredicto }));
      return res.status(200).json({ vista: 'v2.1', criterios: CRITERIOS_V21, veredicto, filas });
    }

    if (String(q.resueltos || '') === '1') {
      const limite = Math.min(500, Math.max(1, Number(q.limite) || 200));
      const mercados = await mercadosResueltos(vigentes, limite);
      const filas = construyeFilas(mercados, await contexto(mercados)).map((f) => ({
        ...f, acierto_A: acierto(f.prob_A, f.outcome), acierto_B: acierto(f.prob_B, f.outcome), acierto_pm: acierto(f.prob_pm_t24, f.outcome),
      }));
      if (esMd) return md(renderMdV21({ titulo: 'earnings-beat v2 — resueltos', filas }));
      return res.status(200).json({ vista: 'resueltos', n: filas.length, filas });
    }

    const mercados = await mercadosAbiertos(vigentes);
    const filas = construyeFilas(mercados, await contexto(mercados))
      .sort((a, b) => Math.abs(b.desacuerdo_A ?? -1) - Math.abs(a.desacuerdo_A ?? -1));
    if (esMd) {
      return md(renderMdV21({
        titulo: `earnings-beat v2 — abiertos al ${new Date().toISOString().slice(0, 10)}`, filas,
        notas: ['prob PM: precio válido a T-24h si ya existe; si no, el último de Gamma (`prob_pm_fuente = gamma_ahora`).'],
      }));
    }
    return res.status(200).json({ vista: 'abiertos', n: filas.length, filas });
  } catch (err) {
    if (LATIDO[job]) await beat(LATIDO[job], 'error', { error: String((err && err.message) || err).slice(0, 200) });
    return res.status(500).json({ error: 'earnings-beat-v2: ' + ((err && err.message) || 'unknown') });
  }
}
