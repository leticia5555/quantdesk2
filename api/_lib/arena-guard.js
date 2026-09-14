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
// ADDENDUM DEL REGLAMENTO (2026-09-14, igual para los siete): toda orden tiene
// que venir respaldada por una decisión por posición COMPLETA — con
// `invalidation_condition` y `confidence` (0–1). Si el modelo no los llena, la
// orden se descarta aquí, con su razón. Es el único lugar del Arena donde esos
// dos campos tienen consecuencia: _lib/arena-memory.js los normaliza y los
// mide, pero medir no frena nada.
// ═══════════════════════════════════════════════════════════════

// Fracción en (0,1) por env; inválida → default, en silencio (mismo criterio
// que _lib/arena-exits.js, que es el otro dueño de constantes del Arena).
function envFrac(name, def) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0 || v >= 1) return def;
  return v;
}

export const ARENA_RULES = {
  max_positions: 8,            // posiciones simultáneas máximas
  max_position_fraction: 0.15, // techo de una posición: 15% del equity
  min_cash_fraction: 0.10,     // piso de cash: 10% del equity
  price_band: 0.02,            // limit_price a ±2% del último cierre
  min_price: 1,                // sin sub-$1
  // ── T2 #5 (2026-09-13): la VENTA del PM sale a MARKETABLE LIMIT ──
  // Cicatriz GOOGL: el PM decidió vender, puso un límite "justo" dentro de la
  // banda ±2%, la orden `day` se quedó descansando arriba del mercado y expiró
  // sin llenar. Al día siguiente la posición seguía ahí y el plan la narraba
  // como "pending order, monitor". Una salida que no llena NO es una salida.
  // Ahora la banda ±2% sigue siendo el SANITY CHECK del anclaje de precio del
  // modelo (si su precio está fuera de banda, la orden se descarta como
  // siempre), pero el precio que se ENVÍA es marketable: referencia × (1 −
  // banda), por DEBAJO del mercado, para que llene en la apertura. NO es un
  // "ajuste silencioso" de los que la casa prohíbe: es política declarada de la
  // capa de salida, journaleada por orden (`limit_price_proposed`, `repriced`,
  // `exit_band`) y visible en la card. Más angosta que la banda del breaker
  // (12%): esta venta es discrecional y ordenada, no una emergencia.
  discretionary_sell_band: envFrac('ARENA_EXIT_BAND_DISCRETIONARY', 0.04),
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
  // ── Campos de la Temporada 2, TOLERADOS a propósito ──────────────
  // `positions_review` (T2 #9), `commitments` y `commitment_updates` (T2 #1)
  // viajan CRUDOS: los normaliza _lib/arena-memory.js. Deliberadamente NO son
  // parte del contrato duro — ausentes o malformados NO abortan el run. El
  // contrato de "JSON malformado = cero órdenes" cubre `plan` y `actions`;
  // endurecerlo con tres campos más solo subiría la tasa de aborts (justo lo
  // que la T2 intenta bajar) y castigaría al modelo por olvidar, en vez de
  // MEDIR el olvido, que es lo que la auditoría de memoria hace.
  //
  // El ADDENDUM (2026-09-14) no cambia esto: un `positions_review` ausente o
  // incompleto sigue SIN abortar el run. Lo que cambia es que las ÓRDENES de
  // los símbolos sin decisión completa se caen en validateActions — la corrida
  // se journalea entera, con plan y con el motivo de cada descarte, en vez de
  // desaparecer detrás de un `aborted_malformed_json`.
  return {
    ok: true,
    plan: parsed.plan.trim(),
    actions: parsed.actions || [],
    positions_review: parsed.positions_review,
    commitments: parsed.commitments,
    commitment_updates: parsed.commitment_updates,
  };
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

// ── validación por acción, con estado acumulado del run ─────────────
// Entradas:
//   actions     → lo que propuso el LLM (ya parseado)
//   equity/cash → de GET /v2/account (números)
//   positions   → de GET /v2/positions: [{ symbol, qty, market_value }]
//   symbolMap   → { SYMBOL: nombre } (getSymbolMap de earnings.js) o null
//   lastCloses  → { SYMBOL: último cierre completo } (Yahoo, plumbing sim.js)
//   decisions   → pronunciamiento por posición YA normalizado
//                 (normalizePositionsReview de _lib/arena-memory.js): array o
//                 { SYMBOL: decisión }. ADDENDUM 2026-09-14 — ver abajo.
//   rules       → override para tests; default ARENA_RULES
// Salida: { approved: [...con qty entera], discarded: [{ action, reason }] }
export function validateActions({ actions, equity, cash, positions, symbolMap, symbolTypes, lastCloses, decisions, rules = ARENA_RULES }) {
  const approved = [];
  const discarded = [];
  const discard = (action, reason) => discarded.push({ action, reason });

  // ── ADDENDUM 2026-09-14: índice de decisiones por símbolo ───────────
  // Acepta el array tal como sale de normalizePositionsReview o un mapa ya
  // indexado. Ausente → mapa VACÍO, no "sin regla": fail closed, igual que el
  // symbol map. La regla se aplica abajo, en el orden fijo de validación.
  const decisionBy = new Map();
  const decisionList = Array.isArray(decisions)
    ? decisions
    : (decisions && typeof decisions === 'object' ? Object.values(decisions) : []);
  for (const d of decisionList) {
    if (d && typeof d === 'object' && typeof d.symbol === 'string') decisionBy.set(d.symbol.trim().toUpperCase(), d);
  }

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
    // ── ADDENDUM 2026-09-14: sin decisión COMPLETA, no hay orden ───────
    // El reglamento pide dos campos obligatorios en la decisión por posición:
    // `invalidation_condition` (qué tendría que pasar para que venda) y
    // `confidence` (0–1). Si el modelo no los llena, la ORDEN SE DESCARTA —
    // no se completa por él, no se le asume una confianza "razonable" y no se
    // aborta la corrida (el contrato de JSON malformado sigue cubriendo solo
    // `plan` y `actions`). Es la misma disciplina que el resto del guard:
    // violación → orden descartada y loggeada con razón.
    //
    // Va PRIMERO, antes del universo y del sizing, a propósito: si el PM no
    // declaró su decisión, no hay nada que validar — el número que mandó no
    // representa un juicio que la casa pueda publicar ni auditar después.
    //
    // Aplica a compras Y ventas, a nombres del libro y a nombres nuevos: el
    // símbolo que se opera tiene que aparecer en `positions_review`. Las
    // salidas DETERMINISTAS (trailing, time stop, breaker — _lib/arena-exits.js)
    // no pasan por aquí y siguen ejecutándose sin decisión del modelo: son de
    // la casa, no suyas.
    const decision = decisionBy.get(symbol);
    if (!decision) {
      discard(raw, `${symbol}: sin decisión por posición — el reglamento exige una entrada en positions_review (stance + invalidation_condition + confidence) para cada nombre que se opera`);
      continue;
    }
    if (!decision.invalidation_condition) {
      discard(raw, `${symbol}: la decisión no dice qué la invalidaría (invalidation_condition vacío) — una tesis sin condición de venta no ejecuta`);
      continue;
    }
    if (!(typeof decision.confidence === 'number' && Number.isFinite(decision.confidence) && decision.confidence >= 0 && decision.confidence <= 1)) {
      discard(raw, `${symbol}: la decisión no trae confidence en 0–1 (recibido: ${JSON.stringify(decision.confidence ?? null)}) — no se asume una confianza que el PM no declaró`);
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

    // ── T2 #5: precio de ENVÍO de una venta = MARKETABLE LIMIT ───────
    // La banda ±2% ya validó el anclaje del modelo (arriba). Acá la venta se
    // re-precia hacia ABAJO del cierre para que LLENE (cicatriz GOOGL). La
    // compra NO se toca: un límite agresivo de compra paga de más, y ahí el
    // precio del modelo sí es la decisión. Todo queda journaleado: el precio
    // que pidió el PM, el que se envió y la banda usada.
    const isSell = side === 'sell';
    const sendPrice = isSell
      ? Math.round(lastClose * (1 - rules.discretionary_sell_band) * 100) / 100
      : limitPrice;
    // Si el PM ya había puesto un límite MÁS agresivo que el marketable, se
    // respeta el suyo (más abajo llena igual; subirlo sería empeorar su venta).
    const finalPrice = isSell ? Math.min(limitPrice, sendPrice) : limitPrice;

    approved.push({
      symbol, side, qty, limit_price: finalPrice,
      // qty sale del límite que PIDIÓ el PM (su intención de notional); el
      // precio de envío no la infla — y la venta ya está capada a lo que hay.
      notional: +(qty * finalPrice).toFixed(2),
      ...(isSell && finalPrice !== limitPrice
        ? { limit_price_proposed: limitPrice, repriced: 'marketable_sell', exit_band: rules.discretionary_sell_band }
        : {}),
      security_type: secType, // null si el free tier no lo trajo (permitido, journaleado)
      conviction: num(a.conviction),
      reasoning: typeof a.reasoning === 'string' ? a.reasoning.slice(0, 600) : null,
      // ADDENDUM 2026-09-14: la decisión que AUTORIZÓ esta orden viaja CON la
      // orden. Duplica lo que ya está en context.positions_review a propósito:
      // el post-mortem lee la fila de acciones y tiene que poder contestar
      // "¿bajo qué condición dijo que vendería?" sin cruzar dos estructuras —
      // y el titular la narra desde aquí.
      stance: decision.stance,
      invalidation_condition: decision.invalidation_condition,
      confidence: decision.confidence,
    });
  }

  return { approved, discarded };
}
