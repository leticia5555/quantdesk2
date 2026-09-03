// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-guard.js — risk guard DETERMINISTA del Arena (Agente #6).
//
// Todo lo que el LLM propone pasa por aquí ANTES de tocar Alpaca. JS puro,
// sin I/O, sin LLM: los datos (symbol map, últimos cierres, cuenta,
// posiciones) entran resueltos y las reglas se evalúan en orden fijo.
//
// Principios (del prompt de producto):
//   - Violación → orden DESCARTADA y loggeada con razón. JAMÁS ajustada
//     en silencio (ni clamp, ni redondeo "amable", ni "casi pasa").
//   - JSON malformado → run abortado honesto, CERO órdenes.
//   - Fail closed: si falta un dato de referencia (symbol map caído, sin
//     precio), la acción se descarta — nunca se asume que "seguro existe".
//
// REGLA TEMPORAL (sep 2026, hallazgo T1): además de las reglas de universo/
// precio/tamaño, el guard veta las COMPRAS "value" (y cualquier compra con el
// flag cuchillo cayendo) cuando la película del negocio está en rojo — ingresos
// desacelerando ≥2 trimestres seguidos o revisiones a la baja. Ver
// `temporalVeto` abajo y `_lib/temporal-fundamentals.js` para las derivaciones.
// ═══════════════════════════════════════════════════════════════

// Umbrales de la REGLA TEMPORAL (tendencia/revisiones/cuchillo cayendo): viven
// en _lib/temporal-fundamentals.js junto a las derivaciones que los usan, y se
// re-exportan acá para que quien lea el guard los encuentre.
import { TEMPORAL_RULES, isValueThesis } from './temporal-fundamentals.js';

export { TEMPORAL_RULES };

export const ARENA_RULES = {
  max_positions: 8,            // posiciones simultáneas máximas
  max_position_fraction: 0.15, // techo de una posición: 15% del equity
  min_cash_fraction: 0.10,     // piso de cash: 10% del equity
  price_band: 0.02,            // limit_price a ±2% del último cierre
  min_price: 1,                // sin sub-$1
};

// Sufijos de warrants/units/rights que el universo excluye aunque el
// symbol map los liste. Solo formas con separador — "GLW" es Corning,
// no un warrant.
const WARRANT_LIKE = /[.\-+](WS|WT|W|U|R|RT)$/i;

// ── ETFs apalancados/inversos: fuera del universo (equity común) ─────
// Doble señal, defensa en profundidad:
//   (1) Lista curada por ticker — rápida y exacta, compartida con el filtro
//       del buffet (trimMovers). No es exhaustiva: salen leveraged nuevos cada
//       mes.
//   (2) Heurística por NOMBRE del symbol map (Finnhub description) — atrapa a
//       los que aún no están en la lista. El feed del buffet no tiene nombres,
//       pero el guard sí, así que ESTA es la barrera real: no depende de
//       mantener la lista al día. Importa porque el resto del guard NO los
//       frena (están en el symbol map US, >$1, sin sufijo de warrant).
export const LEVERAGED_INVERSE_ETFS = new Set([
  // Single-stock (TSLA / NVDA / MSTR / otros nombres calientes)
  'TSLL', 'TSLT', 'TSLR', 'TSLG', 'TSLS', 'TSLQ', 'TSLZ', 'TSDD',
  'NVDL', 'NVDU', 'NVDX', 'NVDS', 'NVDD', 'CONL', 'CONY', 'MSTX', 'MSTU', 'MSTZ',
  'AMDL', 'AMUU', 'AAPU', 'AAPD', 'GGLL', 'AMZU', 'METU',
  // Índices (Nasdaq 100 / S&P 500 / Dow / Russell)
  'TQQQ', 'SQQQ', 'QLD', 'QID', 'PSQ', 'UPRO', 'SPXU', 'SPXL', 'SPXS',
  'SSO', 'SDS', 'UDOW', 'SDOW', 'DDM', 'DXD', 'TNA', 'TZA', 'URTY', 'SRTY',
  // Sectores / temáticos
  'SOXL', 'SOXS', 'LABU', 'LABD', 'FAS', 'FAZ', 'TECL', 'TECS',
  'WEBL', 'WEBS', 'DPST', 'NAIL', 'RETL', 'DFEN', 'CURE',
  // Commodities / bonos / vol / países / crypto-apalancado
  'BOIL', 'KOLD', 'UCO', 'SCO', 'NUGT', 'DUST', 'JNUG', 'JDST', 'GUSH', 'DRIP',
  'ERX', 'ERY', 'TMF', 'TMV', 'UVXY', 'SVXY', 'VIXY', 'UVIX', 'SVIX',
  'YINN', 'YANG', 'BITX', 'ETHU', 'ETHT', 'BITU', 'SBIT',
]);

// Multiplicador "2X/3X/-1x/1.5x", "Ultra/UltraPro/UltraShort", "Leveraged",
// "Inverse" en el nombre del fondo. Deliberadamente NO usa "bull/bear/short"
// pelados (falsos positivos: Bullfrog AI, Bear Creek Mining, Short-Term). El
// "\bultra\b" pega en "Ultra"/"UltraPro" pero no en "Ultragenyx" (sin frontera).
const LEVERAGED_INVERSE_NAME = /(\b\d(?:\.\d)?x\b|\bultra(?:pro|short)?\b|\bleveraged\b|\binverse\b)/i;

// symbol → bool. Con `name` (del symbol map) suma la señal por nombre; sin él
// (el buffet no tiene nombres) cae solo en la lista de tickers.
export function isLeveragedInverseETF(symbol, name) {
  if (LEVERAGED_INVERSE_ETFS.has(String(symbol || '').trim().toUpperCase())) return true;
  return !!name && LEVERAGED_INVERSE_NAME.test(String(name));
}

// ── Universo por TIPO de instrumento (campo `type` del symbol map) ──
// Solo equity común, ADR y REIT. Se excluyen los FONDOS: ETP (ETFs/ETNs —
// incluye índices tipo SPY/QQQ, no solo apalancados), Closed-End Fund y
// Open-End Fund. Los ADR se mantienen a propósito: NU/MELI/ITUB son ADRs LATAM,
// el corazón de la audiencia. Regla de PRODUCTO, no de seguridad: con `type`
// vacío/desconocido se PERMITE (el gate peligroso —leveraged— ya lo cubre la
// doble barrera de arriba).
export const EXCLUDED_SECURITY_TYPES = new Set(['ETP', 'Closed-End Fund', 'Open-End Fund']);

// Instrumentos NO-equity que el sufijo del ticker (WARRANT_LIKE) atrapaba por
// heurística; ahora el `type` del symbol map los marca de forma AUTORITATIVA
// (97.6% de cobertura confirmada en prod). El regex queda como respaldo para
// símbolos sin type. "Equity WRT" = warrant; "Preference" = acción preferente.
// `PUBLIC` es el catch-all de Finnhub (3ª categoría por tamaño): las muestras en
// prod (diag ?sample=N) resultaron puras preferentes y baby bonds — no-equity —
// así que se excluye también. No es suffix-catchable; solo lo marca el `type`.
export const NON_EQUITY_TYPES = new Set(['Unit', 'Equity WRT', 'Right', 'Preference', 'PUBLIC']);

// ── parse: respuesta cruda del LLM → { ok, plan, actions } ──────────
// Malformado (no-JSON, sin plan, actions no-array) → { ok:false, error }
// y el caller aborta el run completo con cero órdenes.
export function parsePlanResponse(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'respuesta vacía del modelo' };
  // El modelo a veces envuelve en fences pese al system prompt; quitarlas
  // no es "ajustar la orden", es des-serializar.
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'la respuesta no contiene un objeto JSON' };
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: 'JSON inválido: ' + e.message }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'la raíz no es un objeto' };
  }
  if (typeof parsed.plan !== 'string' || !parsed.plan.trim()) {
    return { ok: false, error: 'falta plan (string no vacío)' };
  }
  if (parsed.actions !== undefined && !Array.isArray(parsed.actions)) {
    return { ok: false, error: 'actions no es un array' };
  }
  return { ok: true, plan: parsed.plan.trim(), actions: parsed.actions || [] };
}

// ── parse del SCAN (fase 1): respuesta cruda → { ok, thesis, candidates } ──
// El SCOUT nombra ≤maxCandidates tickers a investigar a fondo. Malformado
// (no-JSON, candidates no-array) → { ok:false, error } y el caller aborta el
// run (aborted_scan_malformed_json), cero órdenes. Un array VACÍO de
// candidatos es válido (el SCOUT no vio nada que amerite deep dive) → el
// caller journalea `ok_no_candidates` y no gasta el DIVE.
export function parseScanResponse(raw, maxCandidates = 5) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'respuesta vacía del modelo' };
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'la respuesta no contiene un objeto JSON' };
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: 'JSON inválido: ' + e.message }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'la raíz no es un objeto' };
  }
  if (parsed.candidates !== undefined && !Array.isArray(parsed.candidates)) {
    return { ok: false, error: 'candidates no es un array' };
  }
  // Normaliza: uppercase, dedupe, descarta no-strings, corta a maxCandidates.
  const seen = new Set();
  const candidates = [];
  for (const c of parsed.candidates || []) {
    const sym = typeof c === 'string' ? c.trim().toUpperCase() : '';
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    candidates.push(sym);
    if (candidates.length >= maxCandidates) break;
  }
  const thesis = typeof parsed.scan_thesis === 'string' ? parsed.scan_thesis.trim() : '';
  return { ok: true, thesis, candidates };
}

// ── FLOOR del canal screener (determinista, time-boxed del trial) ────────
// Sin floor, si el scout tiene sesgo hacia lo noticioso, el screener podría no
// salir elegido en semanas → mediríamos el sesgo del scout, no la calidad del
// canal. El floor RESERVA hasta `floor` slots para candidatos del screener,
// SOLO cuando alguna screen realmente disparó (nada de rellenar con basura).
//
// El flag `origin` separa las dos métricas de atribución:
//   'scout_picked'   → el scout lo eligió (incluye screener elegido orgánicamente)
//   'floor_reserved' → lo forzó el floor (el PM/DIVE decide qué hace con él)
//
// Entrada: scoutPicks (símbolos del SCAN, en orden), screenerRanked (unión
// rankeada value+momentum), screenerState (estado de la tabla: fresh/empty/
// disabled/stale/unavailable — de screenerDataState). Salida:
// { candidates:[{symbol, origin}], floor }.
// `floor.reason` distingue los casos para el post-mortem (condición #3):
//   'no_qualifying_candidates' → HAY datos frescos pero ninguna screen disparó
//   'screener_disabled'        → tabla vacía y el cron del screener apagado (flag faltante)
//   'screener_empty'           → tabla vacía con el cron prendido (aún no llenó)
//   'screener_stale'           → hay filas pero rancias (el cron dejó de refrescar)
//   'screener_unavailable'     → la lectura de la tabla falló (DB caída)
//   'scout_met_floor'          → el scout ya tenía ≥floor picks de screener
//   'screener_already_picked'  → los candidatos de screener ya estaban en el scan
//   'floor_applied'            → se reservaron slots
// Los cuatro `screener_*` de arriba NO significan "nada calificó": significan
// "el canal no tenía datos que evaluar". Colapsarlos en no_qualifying_candidates
// (el bug de origen: ARENA_SCREENER_ENABLED faltaba en Vercel) hace que el
// journal se lea como "ninguna acción pasó la screen" cuando la verdad era "no
// hubo screener". `screenerState` viaja desde screenerDataState(rows).
export function applyScreenerFloor(scoutPicks, screenerRanked, { floor = 2, maxCandidates = 5, screenerState = 'fresh' } = {}) {
  const up = (s) => String(s || '').trim().toUpperCase();
  const picks = [...new Set((scoutPicks || []).map(up).filter(Boolean))].slice(0, maxCandidates);
  const rankedUp = [...new Set((screenerRanked || []).map(up).filter(Boolean))];
  const screenerSet = new Set(rankedUp);
  const mk = (arr, origin) => arr.map((symbol) => ({ symbol, origin }));

  if (rankedUp.length === 0) {
    // Sin símbolos rankeados: solo con datos FRESCOS es honesto decir "ninguna
    // screen disparó". Vacía/apagada/rancia/caída → el reason nombra el estado
    // del canal, no culpa a las acciones de no calificar.
    const reason = screenerState === 'fresh' ? 'no_qualifying_candidates' : `screener_${screenerState}`;
    return { candidates: mk(picks, 'scout_picked'), floor: { applied: false, reserved: [], reason, floor } };
  }
  const scoutScreenerCount = picks.filter((s) => screenerSet.has(s)).length;
  const deficit = Math.max(0, floor - scoutScreenerCount);
  if (deficit === 0) {
    return { candidates: mk(picks, 'scout_picked'), floor: { applied: false, reserved: [], reason: 'scout_met_floor', floor } };
  }
  const reserved = rankedUp.filter((s) => !picks.includes(s)).slice(0, deficit);
  if (reserved.length === 0) {
    return { candidates: mk(picks, 'scout_picked'), floor: { applied: false, reserved: [], reason: 'screener_already_picked', floor } };
  }
  // Cap a maxCandidates: `reserved` DEBE entrar; se recorta la cola de picks del
  // scout que NO son screener primero (preserva los picks de screener orgánicos).
  let kept = picks;
  const slotsForScout = maxCandidates - reserved.length;
  if (picks.length > slotsForScout) {
    const toDrop = picks.length - slotsForScout;
    const dropIdx = new Set();
    for (let i = picks.length - 1; i >= 0 && dropIdx.size < toDrop; i--) {
      if (!screenerSet.has(picks[i])) dropIdx.add(i);
    }
    for (let i = picks.length - 1; i >= 0 && dropIdx.size < toDrop; i--) dropIdx.add(i); // último recurso
    kept = picks.filter((_, i) => !dropIdx.has(i));
  }
  return {
    candidates: [...mk(kept, 'scout_picked'), ...mk(reserved, 'floor_reserved')],
    floor: { applied: true, reserved, reason: 'floor_applied', floor },
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ── REGLA TEMPORAL (hallazgo T1): no se compran cuchillos cayendo ────
//
// El PM compró LULU como "value" con la foto (P/E ~10, ROE 31%, cero deuda) sin
// ver que venía desacelerando varios trimestres, y un mes después la empresa
// reportó revenue miss + guía recortada. La foto era correcta; la película
// decía lo contrario. Esta regla es el candado determinista:
//
//   Una COMPRA cuya tesis es "value" —o CUALQUIER compra con el flag
//   `falling_knife` activo— se RECHAZA si la película está en rojo:
//   ingresos desacelerando ≥ `decel_min_quarters` trimestres seguidos, o
//   revisiones a la baja.
//
// NO aplica a VENTAS (salir de un nombre que se deteriora es exactamente lo
// que queremos) ni a compras sin tesis de valuación y sin flag (un momentum
// buy caro y subiendo no es un cuchillo).
//
// SIN DATOS ⇒ NO se rechaza. A diferencia del fail-closed del precio (donde la
// ausencia de referencia hace imposible validar la orden), aquí la ausencia de
// historial es la NORMA en símbolos de cobertura pobre: fallar cerrado
// bloquearía media liga por falta de cobertura de Finnhub, no por riesgo. Se
// journalea `temporal: 'no_data'` en la acción para poder MEDIR cuántas
// decisiones se tomaron a ciegas.
//
// Devuelve null (pasa) o el string de la razón del rechazo.
export function temporalVeto(action, temporal, rules = TEMPORAL_RULES) {
  if (!action || action.side !== 'buy' || !temporal) return null;
  const trend = temporal.revenue_trend || null;
  const revisions = temporal.revisions || null;
  const knife = !!(temporal.falling_knife && temporal.falling_knife.flag);

  const decelerating = !!(trend && trend.label === 'decelerating'
    && trend.consecutive_quarters >= rules.decel_min_quarters);
  const revisionsDown = !!(revisions && revisions.label === 'down');
  if (!decelerating && !revisionsDown) return null;

  const thesis = isValueThesis(action, temporal);
  if (!thesis.value && !knife) return null;

  const symbol = String(action.symbol || '').trim().toUpperCase();
  const motivo = thesis.value
    ? `compra con tesis VALUE (${thesis.why})`
    : 'compra con flag CUCHILLO CAYENDO activo';
  const senales = [];
  if (decelerating) {
    const yoy = (temporal.revenue_yoy_history || [])
      .slice(0, trend.consecutive_quarters + 1).reverse()
      .filter((q) => q && q.yoy_pct != null)
      .map((q) => `${q.label} ${q.yoy_pct > 0 ? '+' : ''}${q.yoy_pct}%`);
    senales.push(`ingresos desacelerando ${trend.consecutive_quarters} trimestres seguidos`
      + (yoy.length ? ` (YoY ${yoy.join(' → ')})` : ''));
  }
  if (revisionsDown) senales.push(`revisiones a la baja (${revisions.source})`);
  return `${symbol}: ${motivo} — ${senales.join(' y ')}. La regla temporal no compra cuchillos cayendo`
    + (knife ? ' (flag cuchillo cayendo activo)' : '')
    + '.';
}

// ── validación por acción, con estado acumulado del run ─────────────
// Entradas:
//   actions     → lo que propuso el LLM (ya parseado)
//   equity/cash → de GET /v2/account (números)
//   positions   → de GET /v2/positions: [{ symbol, qty, market_value }]
//   symbolMap   → { SYMBOL: nombre } (getSymbolMap de earnings.js) o null
//   lastCloses  → { SYMBOL: último cierre completo } (Yahoo, plumbing sim.js)
//   temporal    → { SYMBOL: temporal } (deriveTemporal: tendencia de ingresos,
//                  revisiones, momentum, flag de cuchillo cayendo). Ausente o
//                  vacío → la regla temporal no se evalúa (no bloquea nada).
//   rules       → override para tests; default ARENA_RULES
//   temporalRules → idem para los umbrales de la regla temporal
// Salida: { approved: [...con qty entera], discarded: [{ action, reason }] }
export function validateActions({ actions, equity, cash, positions, symbolMap, symbolTypes, lastCloses, temporal = null, rules = ARENA_RULES, temporalRules = TEMPORAL_RULES }) {
  const approved = [];
  const discarded = [];
  const discard = (action, reason) => discarded.push({ action, reason });

  const held = new Map(); // symbol → { qty, value } simulado según se aprueban órdenes
  for (const p of positions || []) {
    const qty = num(p.qty);
    const value = num(p.market_value);
    if (p.symbol && qty) held.set(String(p.symbol).toUpperCase(), { qty, value: value ?? 0 });
  }
  let simCash = num(cash) ?? 0;
  const eq = num(equity) ?? 0;

  for (const raw of actions || []) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const symbol = typeof a.symbol === 'string' ? a.symbol.trim().toUpperCase() : '';
    const side = a.side === 'buy' || a.side === 'sell' ? a.side : null;
    const notional = num(a.notional);
    const limitPrice = num(a.limit_price);

    if (!symbol || !side || !notional || notional <= 0 || !limitPrice || limitPrice <= 0) {
      discard(raw, 'acción malformada: se requieren symbol, side buy|sell, notional > 0 y limit_price > 0');
      continue;
    }
    if (WARRANT_LIKE.test(symbol)) { discard(raw, `${symbol}: warrants/units/rights fuera del universo`); continue; }
    if (!symbolMap) { discard(raw, 'symbol map no disponible — fail closed, no se opera a ciegas'); continue; }
    if (!symbolMap[symbol]) { discard(raw, `${symbol}: no existe en el symbol map US`); continue; }
    // Defensa en profundidad vs. el filtro del buffet: lista curada + nombre.
    // Los leveraged/inverse pasan el resto del guard (están en el map, >$1, sin
    // sufijo de warrant), así que sin esto se ejecutarían en Alpaca.
    if (isLeveragedInverseETF(symbol, symbolMap[symbol])) {
      discard(raw, `${symbol}: ETF apalancado/inverso fuera del universo (solo equity común)`);
      continue;
    }
    // Universo por tipo. type vacío/desconocido → se permite (regla de producto);
    // el type resuelto (o null) viaja en la aprobada para el journal.
    const secType = (symbolTypes && symbolTypes[symbol]) || null;
    if (secType && NON_EQUITY_TYPES.has(secType)) {
      discard(raw, `${symbol}: tipo ${secType} — no es equity común (warrant/right/unit/preferente)`);
      continue;
    }
    if (secType && EXCLUDED_SECURITY_TYPES.has(secType)) {
      discard(raw, `${symbol}: tipo ${secType} fuera del universo (solo equity común, ADR y REIT)`);
      continue;
    }

    // REGLA TEMPORAL — antes del sizing: es un veto sobre el NOMBRE y su
    // película, no sobre el precio ni el tamaño. Solo compras (ver temporalVeto).
    const temporalVetoReason = temporalVeto({ ...a, symbol, side }, temporal && temporal[symbol], temporalRules);
    if (temporalVetoReason) { discard(raw, temporalVetoReason); continue; }

    const lastClose = num(lastCloses && lastCloses[symbol]);
    if (!lastClose || lastClose <= 0) { discard(raw, `${symbol}: sin último cierre de referencia — fail closed`); continue; }
    if (lastClose < rules.min_price) { discard(raw, `${symbol}: sub-$${rules.min_price} (cierre ${lastClose}) fuera del universo`); continue; }
    if (Math.abs(limitPrice - lastClose) / lastClose > rules.price_band) {
      discard(raw, `${symbol}: limit_price ${limitPrice} fuera de la banda ±${rules.price_band * 100}% del cierre ${lastClose}`);
      continue;
    }

    const qty = Math.floor(notional / limitPrice);
    if (qty < 1) { discard(raw, `${symbol}: notional ${notional} no alcanza 1 acción a ${limitPrice}`); continue; }
    const cost = qty * limitPrice;

    if (side === 'buy') {
      const current = held.get(symbol) || { qty: 0, value: 0 };
      if (current.value + cost > eq * rules.max_position_fraction) {
        discard(raw, `${symbol}: la posición quedaría en ${(current.value + cost).toFixed(0)} > ${rules.max_position_fraction * 100}% del equity (${(eq * rules.max_position_fraction).toFixed(0)})`);
        continue;
      }
      if (!held.has(symbol) && held.size >= rules.max_positions) {
        discard(raw, `máximo de ${rules.max_positions} posiciones alcanzado`);
        continue;
      }
      if (simCash - cost < eq * rules.min_cash_fraction) {
        discard(raw, `la compra dejaría el cash bajo el piso del ${rules.min_cash_fraction * 100}% del equity`);
        continue;
      }
      simCash -= cost;
      held.set(symbol, { qty: current.qty + qty, value: current.value + cost });
    } else {
      const current = held.get(symbol);
      if (!current || current.qty <= 0) { discard(raw, `${symbol}: no hay posición larga que vender (universo long-only)`); continue; }
      if (qty > current.qty) {
        discard(raw, `${symbol}: venta de ${qty} excede la posición de ${current.qty} — no se ajusta en silencio`);
        continue;
      }
      simCash += cost;
      const rest = current.qty - qty;
      if (rest > 0) held.set(symbol, { qty: rest, value: current.value * (rest / current.qty) });
      else held.delete(symbol);
    }

    // Etiquetas temporales que el guard TUVO ENFRENTE al aprobar (o 'no_data'
    // si el símbolo no traía película). Journalearlas es lo que permite medir,
    // a 30 días, cuántas compras se hicieron a ciegas y con qué resultado.
    const t = temporal && temporal[symbol];
    const temporalTag = t
      ? {
        revenue_trend: t.revenue_trend ? t.revenue_trend.label : 'no_data',
        revenue_trend_quarters: t.revenue_trend ? t.revenue_trend.consecutive_quarters : 0,
        revisions: t.revisions ? t.revisions.label : 'no_data',
        revisions_source: t.revisions ? t.revisions.source : null,
        falling_knife: !!(t.falling_knife && t.falling_knife.flag),
      }
      : { revenue_trend: 'no_data', revenue_trend_quarters: 0, revisions: 'no_data', revisions_source: null, falling_knife: false };

    approved.push({
      symbol, side, qty, limit_price: limitPrice,
      notional: +cost.toFixed(2),
      security_type: secType, // null si el free tier no lo trajo (permitido, journaleado)
      temporal: temporalTag,
      conviction: num(a.conviction),
      reasoning: typeof a.reasoning === 'string' ? a.reasoning.slice(0, 600) : null,
    });
  }

  return { approved, discarded };
}
