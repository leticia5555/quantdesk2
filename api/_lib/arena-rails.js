// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-rails.js — B6: LOS RIELES del portafolio objetivo.
//
// JS PURO, sin I/O y sin LLM, como el guard y las salidas. Las reglas se pueden
// probar con un libro sintético sin levantar nada.
//
// El guard viejo (`_lib/arena-guard.js`) valida ÓRDENES: "¿esta compra cabe en
// el libro?". Esto valida un PORTAFOLIO: "¿este conjunto de pesos es un libro
// admisible?". Son preguntas distintas y por eso viven aparte — una orden puede
// ser válida y el portafolio que produce no serlo.
//
// ── LA ASIMETRÍA DEL CORTO, que es el punto de todo esto ─────────────
//
//     Un largo que sale mal SE ENCOGE. Un corto que sale mal CRECE.
//
// Un largo del 25% que cae 50% pasa a pesar ~14%: el error se auto-limita y el
// riel se sigue respetando solo. Un corto del 25% cuyo subyacente SUBE 50% pasa
// a ~37% y sigue creciendo — VIOLA SU PROPIO RIEL sin que nadie haga nada, y la
// pérdida no tiene techo teórico. Un corto del 15% que se duplica en contra
// llega a ~30%, que es donde un largo *empieza*.
//
// De ahí salen tres cosas: el tope del corto es la mitad del largo (R2), hay
// rieles que solo existen para cortos (R9-R11), y —la que de verdad importa—
// EL MOTOR RECORTA (R12). Rechazar entradas nuevas no sirve de nada contra una
// posición que se infla sola.
//
// ── DESCARTA, NO ESCALA ──────────────────────────────────────────────
// Un portafolio objetivo que viola un riel se descarta ENTERO. Escalarlo para
// que quepa lo convierte en uno que el PM nunca propuso, y el journal publicaría
// como suya una tesis que no corresponde a las posiciones. Misma regla de la
// casa que el guard ("descarta, no ajusta").
//
// La única excepción es el RECORTE (R12), y no es una excepción de verdad: no
// modifica el objetivo del PM, es la red determinista actuando sobre el libro
// REAL — igual que un stop que dispara. Viaja journaleado como `rail_trim` con
// el peso antes y después, y el PM lo ve en su siguiente prompt como un hecho
// consumado.
// ═══════════════════════════════════════════════════════════════

function envFrac(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : def;
}
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const RAILS = {
  // R1 — bruto por nombre, LARGO. Decisión de Lety (D3). Mi reserva quedó
  // anotada y es MEDIBLE: sin tope de posiciones, a 30% tres nombres son el 90%
  // del libro y la temporada mediría "qué modelo eligió mejor sus tres nombres"
  // más que cómo construye un portafolio. Si en T1 el PM nunca pasó del 15% por
  // voluntad propia, el tope es decoración y da igual.
  max_long_weight: envFrac('ARENA_RAIL_MAX_LONG', 0.30),
  // R2 — bruto por nombre, CORTO. La mitad del largo, por la asimetría.
  max_short_weight: envFrac('ARENA_RAIL_MAX_SHORT', 0.15),
  // R3 — exposición BRUTA: sin apalancamiento.
  max_gross: envFrac('ARENA_RAIL_MAX_GROSS', 1.00),
  // R4 — exposición NETA. El único que no se confirmó; va asumido. Sin tope al
  // neto, un agente puede irse 0% largo y 100% corto, y en 4 semanas eso no es
  // un portafolio: es una apuesta direccional que va a dominar su resultado, y
  // el post-mortem no podrá separar "este modelo elige bien" de "le atinó a la
  // dirección del mercado en septiembre".
  min_net: -0.50,
  max_net: 1.00,
  // R5 — corto TOTAL.
  max_short_gross: envFrac('ARENA_RAIL_MAX_SHORT_GROSS', 0.50),
  // R6 — por SECTOR. El bucket UNKNOWN comparte el mismo tope: prohibir operar
  // un nombre sin sector castigaría al PM por una falla de cobertura NUESTRA.
  max_sector: envFrac('ARENA_RAIL_MAX_SECTOR', 0.50),
  // R7 — cash. 0-100% (no hay piso: un libro 100% en cash es una decisión).
  // R8 — mínimo por posición. Debajo de esto, la posición no mueve la aguja y
  // solo agrega ruido de ejecución.
  min_position: envFrac('ARENA_RAIL_MIN_POSITION', 0.02),
  // R10 — precio mínimo para CORTOS, más alto que el del universo ($5). Los
  // nombres baratos son donde viven los squeezes.
  min_short_price: envNum('ARENA_RAIL_MIN_SHORT_PRICE', 10),
  // B5 · banda de no-negociación. Sin ella el motor negocia contra el drift de
  // precios todos los días: una posición que el PM quiere al 12% y cerró en
  // 11.6% generaría una orden que no expresa ninguna decisión. Con banda, en el
  // journal solo aparecen las órdenes que el PM DECIDIÓ.
  no_trade_band: envFrac('ARENA_RAIL_NO_TRADE_BAND', 0.02),
};

export const SECTOR_UNKNOWN = 'UNKNOWN';

// ── PARSER DE LA RESPUESTA (B5/B10) ──────────────────────────────────
// Hermano de `parsePlanResponse`, para el contrato NUEVO. Misma regla de la
// casa: JSON malformado = corrida abortada honesta, CERO órdenes. Acá no se
// arregla nada.
//
// El contrato DURO es `plan` + `pesos`. Lo demás (tesis, positions_review,
// commitments) viaja crudo y su ausencia NO aborta — endurecer el contrato con
// campos accesorios solo subiría la tasa de aborts, que es justo lo que la T2
// intenta bajar, y castigaría al modelo por olvidar en vez de MEDIR el olvido.
//
// UN `pesos` VACÍO ES VÁLIDO Y SIGNIFICA ALGO: liquidar todo e irse a cash. No
// se confunde con "faltó el campo" — por eso `pesos` tiene que ESTAR aunque
// esté vacío. La diferencia entre `{}` y ausente es la diferencia entre "decidí
// no tener nada" y "me olvidé de contestar", y con omisión = salida esa
// distinción vale todo el libro.
export function parsePortfolioResponse(raw) {
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
  if (typeof parsed.plan !== 'string' || !parsed.plan.trim()) {
    return { ok: false, error: 'falta plan (string no vacío)' };
  }
  const pesosRaw = parsed.pesos !== undefined ? parsed.pesos : parsed.weights;
  if (pesosRaw === undefined) {
    return {
      ok: false,
      error: 'falta `pesos`. Un objetivo VACÍO ({}) es válido y significa liquidar todo e irse a cash; la AUSENCIA del campo no es lo mismo y no se interpreta como tal.',
    };
  }
  const t = parseTarget({ pesos: pesosRaw, cash: parsed.cash, tesis: parsed.tesis || parsed.theses });
  if (!t.ok) return { ok: false, error: t.error };
  return {
    ok: true,
    plan: parsed.plan.trim(),
    weights: t.weights,
    cash: t.cash,
    theses: t.theses || {},
    // Crudos, como en el contrato viejo: los normaliza _lib/arena-memory.js.
    positions_review: parsed.positions_review,
    commitments: parsed.commitments,
    commitment_updates: parsed.commitment_updates,
  };
}

// ── EL OBJETIVO, normalizado ─────────────────────────────────────────
// Entra lo que dijo el modelo; sale una forma canónica o un error. NO se
// arregla nada: un objetivo que no se puede leer se rechaza y la corrida se
// journalea abortada, con cero órdenes. Misma regla que el JSON malformado.
export function parseTarget(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'el objetivo no es un objeto' };
  const pesos = raw.pesos || raw.weights || null;
  if (!pesos || typeof pesos !== 'object') return { ok: false, error: 'falta `pesos`' };

  const weights = {};
  for (const [k, v] of Object.entries(pesos)) {
    const sym = String(k || '').trim().toUpperCase();
    if (!sym) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, error: `peso no numérico para ${sym}: ${JSON.stringify(v)}` };
    // Se acepta 12 y 0.12 como "12%"? NO. Ambigüedad resuelta por contrato: los
    // pesos vienen en PORCENTAJE (12 = 12%). Adivinar la escala es cómo un
    // libro del 12% se convierte en uno del 1200%.
    if (Math.abs(n) > 100) return { ok: false, error: `peso fuera de rango para ${sym}: ${n} (los pesos van en PORCENTAJE, -100 a 100)` };
    if (n === 0) continue;   // 0% explícito = salir; equivale a omitirlo
    weights[sym] = n / 100;
  }
  const cash = raw.cash != null ? Number(raw.cash) / 100 : null;
  return { ok: true, weights, cash, theses: raw.tesis || raw.theses || {} };
}

// Exposiciones de un vector de pesos (fracciones con signo).
export function exposures(weights) {
  let gross = 0, net = 0, shortGross = 0, longGross = 0;
  for (const w of Object.values(weights || {})) {
    gross += Math.abs(w);
    net += w;
    if (w < 0) shortGross += Math.abs(w); else longGross += w;
  }
  const r = (x) => +x.toFixed(6);
  return { gross: r(gross), net: r(net), short_gross: r(shortGross), long_gross: r(longGross), cash_implied: r(1 - gross) };
}

// ── LA VALIDACIÓN ────────────────────────────────────────────────────
// `meta[sym] = { price, sector, shortable, easy_to_borrow }`.
// Devuelve { ok, violations[] }. Una sola violación descarta el objetivo
// ENTERO — pero se reportan TODAS, no la primera: un PM que recibe "violaste
// R3" arregla R3 y vuelve a chocar con R6 mañana.
export function validateTarget(weights, meta = {}, rails = RAILS) {
  const v = [];
  const exp = exposures(weights);

  for (const [sym, w] of Object.entries(weights || {})) {
    const m = meta[sym] || {};
    const abs = Math.abs(w);
    if (w > 0 && w > rails.max_long_weight + 1e-9) {
      v.push({ rail: 'R1', symbol: sym, detail: `largo ${(w * 100).toFixed(1)}% > tope ${(rails.max_long_weight * 100).toFixed(0)}%` });
    }
    if (w < 0 && abs > rails.max_short_weight + 1e-9) {
      v.push({ rail: 'R2', symbol: sym, detail: `corto ${(abs * 100).toFixed(1)}% > tope ${(rails.max_short_weight * 100).toFixed(0)}%` });
    }
    if (abs < rails.min_position - 1e-9) {
      v.push({ rail: 'R8', symbol: sym, detail: `${(abs * 100).toFixed(2)}% < mínimo ${(rails.min_position * 100).toFixed(0)}% — una posición así no mueve la aguja y solo agrega ruido de ejecución` });
    }
    if (w < 0) {
      // R9 — FAIL CLOSED. Un campo ausente NO es un permiso: un buy-in forzado
      // cierra la posición sin que el PM decida, y eso es ruido del broker
      // metido en el resultado del experimento.
      if (m.shortable !== true || m.easy_to_borrow !== true) {
        v.push({
          rail: 'R9', symbol: sym,
          detail: `no está confirmado como shortable + easy-to-borrow (shortable=${m.shortable ?? 'sin dato'}, etb=${m.easy_to_borrow ?? 'sin dato'}). Fail closed: sin el dato NO se abre el corto.`,
        });
      }
      if (Number.isFinite(m.price) && m.price < rails.min_short_price) {
        v.push({ rail: 'R10', symbol: sym, detail: `precio $${Number(m.price).toFixed(2)} < mínimo de corto $${rails.min_short_price} — los nombres baratos son donde viven los squeezes` });
      }
    }
  }

  if (exp.gross > rails.max_gross + 1e-9) {
    v.push({ rail: 'R3', detail: `exposición bruta ${(exp.gross * 100).toFixed(1)}% > ${(rails.max_gross * 100).toFixed(0)}% (sin apalancamiento)` });
  }
  if (exp.net < rails.min_net - 1e-9 || exp.net > rails.max_net + 1e-9) {
    v.push({ rail: 'R4', detail: `exposición neta ${(exp.net * 100).toFixed(1)}% fuera de [${(rails.min_net * 100).toFixed(0)}%, ${(rails.max_net * 100).toFixed(0)}%]` });
  }
  if (exp.short_gross > rails.max_short_gross + 1e-9) {
    v.push({ rail: 'R5', detail: `corto total ${(exp.short_gross * 100).toFixed(1)}% > ${(rails.max_short_gross * 100).toFixed(0)}%` });
  }

  // R6 — sector. El bruto por sector, con UNKNOWN como un bucket más.
  const porSector = {};
  for (const [sym, w] of Object.entries(weights || {})) {
    const s = (meta[sym] && meta[sym].sector) || SECTOR_UNKNOWN;
    porSector[s] = (porSector[s] || 0) + Math.abs(w);
  }
  // ── R6 Y EL BUCKET UNKNOWN: AVISO, NO VIOLACIÓN ────────────────────
  // Lo que pasó el 2026-09-15: la sombra rechazó a openai y a gemini por R6
  // con `sector: UNKNOWN`. No estaban concentrados — es que NINGÚN nombre
  // tenía sector, así que los catorce cayeron al mismo bucket y la suma dio
  // 100% "en un sector".
  //
  // Eso no es concentración: es una falla de COBERTURA NUESTRA. Y rechazar el
  // objetivo entero por una falla nuestra le carga al PM un error que no
  // cometió — exactamente el mismo problema que tenía `data_unavailable` en el
  // canal del día, donde el motivo equivocado mandaba a buscar al lugar
  // equivocado.
  //
  // Así que UNKNOWN sale como `warning`, no como violación, y el objetivo pasa.
  // Los sectores REALES siguen aplicando el tope igual: se arregló la ceguera,
  // no se aflojó el riel.
  const warnings = [];
  for (const [s, peso] of Object.entries(porSector)) {
    if (peso <= rails.max_sector + 1e-9) continue;
    const symbols = Object.keys(weights).filter((k) => ((meta[k] && meta[k].sector) || SECTOR_UNKNOWN) === s);
    if (s === SECTOR_UNKNOWN) {
      warnings.push({
        rail: 'R6', sector: s, symbols,
        detail: `${(peso * 100).toFixed(1)}% del bruto está en nombres SIN SECTOR. Esto NO es concentración sectorial: es una falla de cobertura NUESTRA, así que no invalida el objetivo. Los nombres sin clasificar son: ${symbols.slice(0, 12).join(', ')}${symbols.length > 12 ? '…' : ''}.`,
        es_falla_nuestra: true,
      });
      continue;
    }
    v.push({
      rail: 'R6', sector: s, symbols,
      detail: `sector ${s} ${(peso * 100).toFixed(1)}% > ${(rails.max_sector * 100).toFixed(0)}%`,
    });
  }

  // `warnings` NO cuenta para `ok`: son fallas nuestras, no del objetivo. Pero
  // viajan, porque un objetivo que pasó CON siete nombres sin clasificar no es
  // lo mismo que uno que pasó limpio, y el post-mortem tiene que poder verlo.
  return { ok: v.length === 0, violations: v, warnings, exposures: exp, by_sector: porSector };
}

// ── R12 · EL RECORTE ─────────────────────────────────────────────────
// La consecuencia directa de la asimetría. Una posición que CRECIÓ por encima
// de su riel (porque el subyacente se movió en contra, en el caso del corto) se
// recorta al riel, aunque el PM no lo haya pedido y aunque su objetivo la deje
// donde está.
//
// Es DETERMINISTA y va con la red del §B7, no con la decisión del PM. Rechazar
// entradas nuevas no sirve de nada contra una posición que se infla sola.
//
// Aplica a los DOS lados: un largo también puede pasarse del 30% si subió
// mucho. La diferencia es que el largo tiende a auto-corregirse y el corto no.
export function railTrims(positions, equity, meta = {}, rails = RAILS) {
  const trims = [];
  if (!Number.isFinite(equity) || equity <= 0) return trims;
  for (const p of positions || []) {
    const sym = String(p.symbol || '').trim().toUpperCase();
    const mv = Number(p.market_value);
    if (!sym || !Number.isFinite(mv) || mv === 0) continue;
    const w = mv / equity;
    const esCorto = w < 0 || Number(p.qty) < 0;
    const tope = esCorto ? rails.max_short_weight : rails.max_long_weight;
    const abs = Math.abs(w);
    if (abs <= tope + 1e-9) continue;
    const objetivo = esCorto ? -tope : tope;
    trims.push({
      symbol: sym, side: esCorto ? 'short' : 'long',
      weight_before: +w.toFixed(4), weight_after: +objetivo.toFixed(4),
      rail: esCorto ? 'R2' : 'R1',
      reason: esCorto
        ? `El corto creció de su riel (${(tope * 100).toFixed(0)}%) a ${(abs * 100).toFixed(1)}% porque el subyacente subió. Un corto que sale mal CRECE: si no se recorta, sigue inflándose solo y su pérdida no tiene techo.`
        : `El largo creció de su riel (${(tope * 100).toFixed(0)}%) a ${(abs * 100).toFixed(1)}%.`,
      // Fracción de la posición que hay que cerrar para volver al riel.
      trim_fraction: +((abs - tope) / abs).toFixed(4),
    });
  }
  return trims;
}
