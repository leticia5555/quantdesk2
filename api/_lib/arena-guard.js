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
// ═══════════════════════════════════════════════════════════════

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
// Solo equity común, ADR y REIT. Se excluyen ETP (ETFs/ETNs — incluye índices
// tipo SPY/QQQ, no solo apalancados) y Closed-End Fund. Los ADR se mantienen a
// propósito: NU/MELI/ITUB son ADRs LATAM, el corazón de la audiencia. Regla de
// PRODUCTO, no de seguridad: con `type` vacío/desconocido se PERMITE (el gate
// peligroso —leveraged— ya lo cubre la doble barrera de arriba).
export const EXCLUDED_SECURITY_TYPES = new Set(['ETP', 'Closed-End Fund']);

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

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ── validación por acción, con estado acumulado del run ─────────────
// Entradas:
//   actions     → lo que propuso el LLM (ya parseado)
//   equity/cash → de GET /v2/account (números)
//   positions   → de GET /v2/positions: [{ symbol, qty, market_value }]
//   symbolMap   → { SYMBOL: nombre } (getSymbolMap de earnings.js) o null
//   lastCloses  → { SYMBOL: último cierre completo } (Yahoo, plumbing sim.js)
//   rules       → override para tests; default ARENA_RULES
// Salida: { approved: [...con qty entera], discarded: [{ action, reason }] }
export function validateActions({ actions, equity, cash, positions, symbolMap, symbolTypes, lastCloses, rules = ARENA_RULES }) {
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

    approved.push({
      symbol, side, qty, limit_price: limitPrice,
      notional: +cost.toFixed(2),
      security_type: secType, // null si el free tier no lo trajo (permitido, journaleado)
      conviction: num(a.conviction),
      reasoning: typeof a.reasoning === 'string' ? a.reasoning.slice(0, 600) : null,
    });
  }

  return { approved, discarded };
}
