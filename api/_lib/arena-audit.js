// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-audit.js — reconstrucción SOLO-LECTURA del rastro del Arena.
//
// Transformación PURA (sin I/O, sin LLM, sin writes) de las filas de
// `arena_journal` a la auditoría que sirve /api/arena-audit: qué vio el
// agente en cada corrida, qué eligió, qué aprobó/descartó el guard, qué
// llenó y cómo quedó la prosa.
//
// ── Por qué reconstruir y no leer un campo ────────────────────────────
// El journal guarda el BUFFET dentro del texto del prompt del SCAN
// (`context.scan.prompt.user`), no como estructura aparte: buildScanUserPrompt
// serializa el buffet a JSON en su propia línea, después de la etiqueta
// 'MARKET CONTEXT'. Igual el PORTFOLIO. Así que las métricas de "qué llegó y
// con cuántos ítems reales" y "qué posiciones venían heridas" se recuperan
// parseando ESE texto — exactamente lo que el PM tuvo enfrente, no una
// re-derivación de otra fuente. Si el parseo falla (prompt de un harness
// viejo, formato distinto), se marca `reconstruido: false` y los conteos
// quedan en null: hueco honesto, nunca un cero inventado.
//
// Nada de aquí toca el camino de decisión: el prompt del PM, el guard y
// arena-run no se importan ni se modifican. Esto solo LEE lo que quedó.
// ═══════════════════════════════════════════════════════════════

// Deploy de `buffet-quality` (PR #108: earnings por relevancia + filtro de
// tipos en movers), merge a main el 2026-08-06 19:38 UTC. Es el corte de la
// PREDICCIÓN MEDIBLE que quedó registrada: si el buffet mejora, el scout
// debería nombrar más candidatos por corrida después de esta fecha. El cron
// de decide corre 22:40 UTC, así que la corrida del 2026-08-06 ya es "después".
// Override por query (?deploy=ISO) para re-cortar el post-mortem sin re-deploy.
export const BUFFET_QUALITY_DEPLOY = /* date-lint-ok: no es una referencia a "hoy" — es el timestamp del merge, un hecho histórico fijo */ '2026-08-06T19:38:08Z';

// Umbral de "posición herida": P&L desde entrada ≤ −5%. Métrica de ATENCIÓN,
// no regla de trading — el stop catastrófico real vive en _lib/arena-exits.js
// y es mucho más ancho. Aquí solo se mide si el PM las nombra después.
export const HERIDA_PCT = -5;

const up = (s) => String(s == null ? '' : s).trim().toUpperCase();
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// ── parseo del prompt del SCAN ───────────────────────────────────────
// buildScanUserPrompt arma el prompt con join('\n') y deja cada JSON en su
// PROPIA línea, justo después de su etiqueta. Se busca la etiqueta y se
// parsea la primera línea siguiente que abra objeto (tolerancia de 2 líneas
// por si algún día se cuela una línea en blanco). Nunca lanza: null si no
// hay match o el JSON no parsea.
export function jsonAfterMarker(text, marker) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(marker));
  if (i === -1) return null;
  // Ventana de 10 líneas, no de 2: entre el marcador y el JSON viven las
  // INSTRUCCIONES de esa sección (timing de earnings, recién-reportados,
  // historia de la posición…) y esa lista crece con cada regla nueva. Con la
  // ventana corta, agregar una línea de prompt rompía en silencio la
  // reconstrucción del buffet y el post-mortem reportaba `items:null` como si
  // el canal no hubiera llegado.
  for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
    const s = lines[j].trim();
    if (s.startsWith('{')) { try { return JSON.parse(s); } catch (e) { return null; } }
  }
  return null;
}

// '+6.1%' / '-2.14%' → 6.1 / -2.14. null si no es un string con número.
export function parsePct(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Frases de la prosa que nombran a `simbolo` (palabra completa). Se usa para
// dos métricas: atención a posiciones heridas y citas de los cambios de
// veredicto. Se compara en mayúsculas contra el símbolo escapado, así "MU" no
// matchea "mucho" pero sí "MU," o "(MU)".
export function frasesConSimbolo(plan, simbolo) {
  const sym = up(simbolo);
  if (typeof plan !== 'string' || !sym) return [];
  const re = new RegExp(`(^|[^A-Z0-9])${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`);
  return plan
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && re.test(s.toUpperCase()));
}

// ── el buffet de una corrida ─────────────────────────────────────────
// `unavailable`/`fetch_errors` sí viven como estructura en el context (los
// journalea arena-run); los CONTEOS por canal se reconstruyen del prompt.
// "llegó" ≠ "traía ítems": un canal puede responder 200 y venir vacío — la
// distinción es justo la que se quiere auditar.
export function buffetDeFila(context) {
  const ctx = context || {};
  // La corrida por EVENTO (T2 #7) no tiene fase SCAN ni buffet: su slate lo da
  // el evento. Ahí `reconstruido:false` es la verdad, no un hueco de datos.
  // DÓNDE VIVE EL BUFFET, y por qué hay dos lugares. Desde el fix de caché del
  // 2026-09-15 el buffet viaja en `prompt.shared` (el prefijo cacheado, idéntico
  // para los siete agentes) y ya no en `prompt.user`. Las filas ANTERIORES a ese
  // cambio lo tienen en `user` y siguen en el journal para siempre: leer solo el
  // lugar nuevo dejaría toda la historia previa con `reconstruido: false`, que es
  // indistinguible de una corrida por evento. Se miran los dos, el nuevo primero.
  const scanPrompt = (ctx.scan && ctx.scan.prompt) || null;
  const buffet = jsonAfterMarker(scanPrompt ? scanPrompt.shared : null, 'MARKET CONTEXT')
    || jsonAfterMarker(scanPrompt ? scanPrompt.user : null, 'MARKET CONTEXT');
  const unavailable = Array.isArray(ctx.unavailable) ? ctx.unavailable
    : (buffet && Array.isArray(buffet.unavailable) ? buffet.unavailable : []);
  const errores = ctx.fetch_errors && typeof ctx.fetch_errors === 'object' ? ctx.fetch_errors : {};
  const caidos = new Set(unavailable.map((s) => String(s)));

  const syms = (arr, key) => [...new Set((arr || []).map((x) => up(x && x[key])).filter(Boolean))];
  const canal = (nombre, items, simbolos, detalle) => ({
    llego: !caidos.has(nombre),
    items: buffet ? items : null,     // null = no reconstruible, NO cero
    simbolos: buffet ? simbolos : [],
    ...(detalle ? { detalle } : {}),
    error: errores[nombre] || null,
  });

  const mv = buffet && buffet.movers ? buffet.movers : null;
  const moversSyms = mv ? [...new Set([...syms(mv.gainers, 'symbol'), ...syms(mv.losers, 'symbol'), ...syms(mv.actives, 'symbol')])] : [];
  const moversN = mv ? (mv.gainers || []).length + (mv.losers || []).length + (mv.actives || []).length : 0;
  const earnings = buffet ? (buffet.earnings_this_week || []) : [];
  // T2 #2: los recién-reportados son parte del canal earnings (slots propios).
  const reportados = buffet ? (buffet.recently_reported || []) : [];
  const insiders = buffet ? (buffet.notable_insider_buys || []) : [];
  const scr = buffet && buffet.screener ? buffet.screener : null;
  const scrSyms = scr ? [...new Set([...syms(scr.value, 'symbol'), ...syms(scr.momentum, 'symbol')])] : [];

  return {
    reconstruido: !!buffet,
    unavailable,
    fetch_errors: errores,
    screener_state: (ctx.scan && ctx.scan.screener_state) || (buffet && buffet.screener_state) || null,
    canales: {
      movers: canal('movers', moversN, moversSyms, mv
        ? { gainers: (mv.gainers || []).length, losers: (mv.losers || []).length, actives: (mv.actives || []).length }
        : null),
      earnings: canal('earnings', earnings.length + reportados.length,
        [...new Set([...syms(earnings, 'ticker'), ...syms(reportados, 'ticker')])],
        buffet ? { proximos: earnings.length, reportados: reportados.length } : null),
      insiders: canal('insiders', insiders.length, syms(insiders, 'ticker')),
      screener: canal('screener', scrSyms.length, scrSyms, scr
        ? { value: (scr.value || []).length, momentum: (scr.momentum || []).length }
        : null),
    },
  };
}

// ── el libro tal como lo vio el PM ───────────────────────────────────
export function portafolioDeFila(context) {
  const ctx = context || {};
  // El libro viaja en AMBOS prompts. La corrida por evento no tiene el del SCAN,
  // así que se cae al del DIVE — el mismo bloque, la misma marca.
  const fuente = (ctx.scan && ctx.scan.prompt && ctx.scan.prompt.user)
    || (ctx.dive && ctx.dive.prompt && ctx.dive.prompt.user)
    || null;
  const p = jsonAfterMarker(fuente, 'PORTFOLIO');
  if (!p) return null;
  return {
    equity: isNum(p.equity) ? p.equity : null,
    cash: isNum(p.cash) ? p.cash : null,
    posiciones: (p.positions || []).map((x) => ({
      simbolo: up(x && x.symbol),
      qty: x && x.qty != null ? Number(x.qty) : null,
      entrada: x && x.avg_entry != null ? Number(x.avg_entry) : null,
      valor: x && x.market_value != null ? Number(x.market_value) : null,
      pnl_desde_entrada: (x && x.pnl_since_entry_pct) || null,
      pnl_pct: parsePct(x && x.pnl_since_entry_pct),
    })),
    ordenes_abiertas: (p.open_orders || []).map((o) => ({
      simbolo: up(o && o.symbol), side: o && o.side, qty: o && o.qty,
      limite: o && o.limit_price != null ? Number(o.limit_price) : null, status: o && o.status,
    })),
  };
}

// ── acciones: propuesta + veredicto del guard + fill ─────────────────
const VEREDICTO = { approved: 'aprobada', discarded: 'descartada', submit_failed: 'envio_fallido' };

export function normalizaAccion(a) {
  const act = a && typeof a === 'object' ? a : {};
  // Una acción descartada por malformada se journalea como { raw: <lo que dijo
  // el LLM> }: el símbolo/lado hay que sacarlo de ahí, no del nivel de arriba.
  const raw = act.raw && typeof act.raw === 'object' ? act.raw : null;
  const src = act.symbol != null ? act : (raw || act);
  const canales = Array.isArray(act.channels) ? act.channels : [];
  const fill = (act.filled_avg_price != null || act.filled_at != null || act.filled_qty != null)
    ? { qty: act.filled_qty != null ? Number(act.filled_qty) : null,
        precio: act.filled_avg_price != null ? Number(act.filled_avg_price) : null,
        at: act.filled_at || null }
    : null;
  return {
    simbolo: up(src.symbol) || null,
    side: src.side || null,
    qty: src.qty != null ? Number(src.qty) : null,
    limite: src.limit_price != null ? Number(src.limit_price) : null,
    notional: act.notional != null ? Number(act.notional) : null,
    canales,
    origin: act.origin != null ? act.origin : null,
    screens: act.screens || null,
    screener_qualifiers: act.screener_qualifiers || null,
    veredicto: VEREDICTO[act.result] || act.result || 'desconocido',
    motivo: act.reason != null ? act.reason : null,
    reason_codes: act.reason_codes || null,
    razonamiento: act.reasoning != null ? act.reasoning : null,
    conviction: act.conviction != null ? act.conviction : null,
    order_status: act.order_status || null,
    alpaca_order_id: act.alpaca_order_id || null,
    fill,
    lleno: !!(fill && (act.order_status === 'filled' || fill.qty)),
    // Las salidas deterministas (breaker / stop catastrófico) NO son decisión
    // del PM: se separan en toda métrica que hable de discrecionalidad.
    es_salida_de_riesgo: canales.includes('risk_exit'),
    raw_malformada: raw || null,
  };
}

// ── EL BLOQUE DEL CONTRATO OBJETIVO ──────────────────────────────────
// null cuando la fila es del contrato viejo: un bloque vacío en cada fila de
// septiembre sería ruido en el post-mortem.
export function objetivoDeFila(ctx = {}, row = {}) {
  const ej = ctx.ejecucion || null;
  const target = ctx.target || null;
  const reb = ctx.rebalance || null;
  if (!target && !ej && !reb) return null;

  const pesos = (target && target.weights) || {};
  const rieles = ctx.rails || null;

  // Las órdenes CALCULADAS, que sin envío son las únicas que hay. Se publican con
  // el monto ya hecho: `qty × limit_price` es la pregunta que se hace quien
  // revisa ("¿cuánto dinero mueve esto?"), y obligarla a multiplicar a mano es
  // donde se cuela un error de lectura.
  const orden = (o) => ({
    simbolo: o.symbol, lado: o.side, qty: o.qty,
    limite: o.limit_price, referencia: o.referencia ?? null,
    monto: o.notional_real ?? (Number.isFinite(o.qty) && Number.isFinite(o.limit_price) ? +(o.qty * o.limit_price).toFixed(2) : null),
    peso_de: o.weight_from ?? null, peso_a: o.weight_to ?? null,
    delta_pp: Number.isFinite(o.delta_weight) ? +(o.delta_weight * 100).toFixed(2) : null,
    cierra: !!o.closes_position,
    intencion: o.intencion || null,
    ...(o.result ? { resultado: o.result } : {}),
    ...(o.order_status ? { order_status: o.order_status } : {}),
    ...(o.error ? { error: o.error } : {}),
  });

  const calculadas = (ej && ej.ordenes_calculadas) || [];
  const enviadas = (ej && ej.enviadas) || [];

  return {
    contrato: ctx.contrato || 'objetivo',
    // El libro que el PM QUIERE, en porcentaje: los pesos viajan en fracción y
    // leer 0.12 como "12%" es el error de un cero de diferencia.
    pesos_pct: Object.fromEntries(Object.entries(pesos).map(([k, v]) => [k, +(Number(v) * 100).toFixed(2)])),
    posiciones: Object.keys(pesos).length,
    cash_pct: target && target.cash != null ? +(Number(target.cash) * 100).toFixed(2) : null,
    tesis: (target && target.theses) || null,
    rieles: rieles ? {
      paso: !!rieles.ok,
      violaciones: (rieles.violations || []).map((v) => ({ riel: v.rail, simbolo: v.symbol || null, detalle: v.detail })),
      avisos: (rieles.warnings || []).map((w) => ({ riel: w.rail, detalle: w.detail })),
      exposicion: rieles.exposures || null,
    } : null,
    tickers: ctx.tickers || null,
    turnover: reb ? reb.turnover : null,
    // MODO. `dry` = se calcularon y NO se mandaron. Es lo primero que hay que
    // confirmar antes de mirar nada más: si dice `enviado` cuando se esperaba
    // sin enviar, la bandera no era la que se creía.
    modo: ej ? ej.modo : null,
    candado_ok: ej ? !!(ej.candado && ej.candado.ok) : null,
    freno: (ej && ej.freno) || null,
    ordenes: calculadas.map(orden),
    ordenes_n: calculadas.length,
    monto_total: calculadas.length
      ? +calculadas.reduce((s2, o) => s2 + (Number(o.notional_real) || 0), 0).toFixed(2)
      : 0,
    enviadas_n: enviadas.filter((o) => o.result === 'approved').length,
    fallidas_n: enviadas.filter((o) => o.result === 'submit_failed').length,
    // Lo que NO llegó a orden, con su motivo. Un peso que desaparece sin
    // explicación es peor que uno rechazado.
    descartadas: ((ej && ej.descartadas) || []).map((d) => ({ simbolo: d.symbol, lado: d.side, motivo: d.motivo })),
  };
}

// ── EL DIAGNÓSTICO DE UN ABORTO ──────────────────────────────────────
// Contesta las tres preguntas que se hacen SIEMPRE que un agente no operó: en
// qué vuelta se cayó, cuántos ms tardó en caerse, y quién lo atendió.
//
// ── OJO CON `proveedor: null` EN UN CUERPO VACÍO ─────────────────────
// No es un hueco: es la CONSECUENCIA de la falla. OpenRouter manda el nombre
// del proveedor DENTRO del cuerpo de la respuesta, así que cuando el cuerpo
// nunca llega no hay nombre que journalear. Un `proveedor: null` en un corte
// por cuerpo vacío significa "el cuerpo no llegó", no "no lo registramos".
//
// Lo que SÍ se sabe son las vueltas ANTERIORES (`proveedores[]`), que sí
// trajeron cuerpo: con eso se ve si el corte cae siempre sobre el mismo
// proveedor o si rota — que son diagnósticos opuestos.
export function diagnosticoDeFila(ctx = {}) {
  // Los DOS contratos guardan esto en lugares distintos: el objetivo lo pone
  // al nivel de arriba (`runAgenteObjetivo` es una sola cadena) y el viejo lo
  // pone bajo `dive` (tenía scan y dive). Leer solo uno dejaría media historia
  // sin diagnóstico justo en las corridas viejas, que son las que hay que
  // comparar cuando algo cambia de comportamiento.
  const dive = ctx.dive || {};
  const t = ctx.tools || dive.tools || null;
  const err = ctx.llm_error || dive.llm_error || null;
  // `ctx.tickers` cuenta como diagnóstico POR SÍ SOLO: un `rejected_tickers`
  // no tiene bloque de herramientas ni `llm_error` —el modelo contestó bien, el
  // problema fue el contenido— así que sin esto el bloque se saltaba justo en
  // el aborto que más se mira.
  if (!t && !err && !ctx.tickers && !ctx.murio_en && !ctx.cierre && !ctx.threw) return null;
  // Qué contrato la produjo: sin esto, un bloque vacío se lee como "no se
  // journaleó" en vez de "esta corrida no tenía esa fase".
  const contrato = ctx.contrato || (ctx.dive ? 'acciones' : null);
  return {
    // Cuál de los tres techos cortó la investigación, con los tres al lado.
    herramientas: t ? {
      usadas: t.used ?? null, tope: t.budget ?? null, vueltas: t.turns ?? null,
      corte: t.stopped_by || null, limites: t.limites || null,
    } : null,
    // Quién atendió CADA vuelta que sí contestó.
    proveedores: (t && t.proveedores) || null,
    proveedores_colgados: (t && t.proveedores_colgados) || (err && err.proveedores_colgados) || null,
    // Los cortes por cuerpo vacío, con vuelta, intento, ms y bytes.
    cuerpos_vacios: (err && err.cuerpos_vacios) || (t && t.cuerpos_vacios) || null,
    // DÓNDE murió: dentro de una vuelta, o en el turno de cierre. Un
    // `cierre: null` significaba las dos cosas y se veían iguales.
    murio_en: ctx.murio_en || (err && err.murio_en) || null,
    cierre: ctx.cierre || (err && err.cierre) || null,
    // Y cuál RELOJ cortó, con su origen: una env var y el reparto del loop se
    // arreglan en lugares opuestos.
    techo_ms: (err && err.techo_ms) ?? null,
    techo_origen: (err && err.techo_origen) || null,
    timeout_nuestro: err ? !!err.timeout_nuestro : null,
    status_http: err ? (err.status ?? null) : null,
    detalle: err ? (err.detail || null) : null,
    stack: (ctx.threw && ctx.threw.stack) || (err && err.threw_stack) || null,
    contrato,
    // ── LOS DOS ABORTOS QUE NO SON DEL PROVEEDOR ─────────────────────
    // `rejected_tickers` y `aborted_malformed_target` son del MODELO, no de la
    // red, y su detalle ya se journaleaba sin que ningún endpoint lo mostrara:
    // había que entrar a Neon para saber QUÉ ticker se rechazó o QUÉ tenía de
    // malformado el JSON. Son los dos abortos más accionables que hay —
    // apuntan al prompt, no a la infraestructura.
    tickers: ctx.tickers || null,
  };
}

// ── una fila de journal → una entrada de auditoría ───────────────────
const TIPO_POR_STATUS = {
  risk_exit: 'red_de_riesgo',
  risk_broad_cut: 'red_de_riesgo',
  skipped_market_closed: 'mercado_cerrado',
  // Cadencia por evento: la fila marcadora que dejan el cron
  // nocturno y la matutina ya retirados. NO es una decisión —cero tokens, cero
  // órdenes—, así que agruparla con las decisiones diluiría toda métrica por
  // corrida del post-mortem.
  skipped_superseded_by_watch: 'cadencia_retirada',
};

export function auditaFila(row) {
  const ctx = (row && row.context) || {};
  const scan = ctx.scan || {};
  const acciones = (Array.isArray(row.actions) ? row.actions : []).map(normalizaAccion);
  const guard = {
    propuestas: acciones.length,
    aprobadas: acciones.filter((a) => a.veredicto === 'aprobada').length,
    descartadas: acciones.filter((a) => a.veredicto === 'descartada').length,
    envios_fallidos: acciones.filter((a) => a.veredicto === 'envio_fallido').length,
    motivos_descarte: acciones.filter((a) => a.veredicto === 'descartada' && a.motivo).map((a) => a.motivo),
  };
  return {
    id: row.id,
    fecha: row.run_date,
    created_at: row.created_at,
    agente: row.agent_id || null,
    tipo: TIPO_POR_STATUS[row.status] || 'decision',
    status: row.status,
    modelo: row.model || null,
    prompt_version: row.prompt_version || null,
    prompt_hash: row.prompt_hash || null,
    error: row.error || null,
    // ── POR QUÉ ABORTÓ, LEGIBLE ──────────────────────────────────────
    // `status: 'aborted_llm_error'` dice QUE murió. Todo lo que dice POR QUÉ
    // —qué vuelta, cuántos ms, qué proveedor atendió, cuál reloj cortó— ya se
    // journaleaba y NINGÚN endpoint lo proyectaba: la única forma de leerlo era
    // entrar a Neon a mano. Con el contrato objetivo EN VIVO, un aborto sin
    // diagnóstico legible es un agente que no operó y nadie sabe por qué.
    diagnostico: diagnosticoDeFila(ctx),
    cuenta: row.account || null,
    buffet: buffetDeFila(ctx),
    portafolio: portafolioDeFila(ctx),
    scout: {
      tesis: scan.thesis != null ? scan.thesis : null,
      // null = el scan no llegó a correr (abortado antes); [] = corrió y no
      // nombró a nadie. La diferencia importa para el promedio de picks.
      picks: Array.isArray(scan.candidates) ? scan.candidates.map(up) : null,
      picks_n: Array.isArray(scan.candidates) ? scan.candidates.length : null,
    },
    slate_final: Array.isArray(scan.slate) ? scan.slate : null,
    floor: scan.floor || null,
    screener_state: scan.screener_state || null,
    riesgo: ctx.risk || null,
    market_check: ctx.market_check || null,
    // ── EL CONTRATO OBJETIVO (v4) ────────────────────────────────────
    // Sin esto, una corrida del contrato nuevo salía en la auditoría como una
    // fila casi vacía: `scout`, `slate` y `acciones` están construidos sobre el
    // contrato de ACCIONES, y el objetivo, los rieles y las órdenes calculadas
    // viven en `context`. La corrida SIN ENVIAR es justamente la que no tiene
    // `actions` —no se mandó nada— así que sin este bloque no habría nada que
    // revisar antes de encender.
    objetivo: objetivoDeFila(ctx, row),
    acciones,
    guard,
    fills: acciones.filter((a) => a.fill).map((a) => ({
      simbolo: a.simbolo, side: a.side, qty: a.fill.qty, precio: a.fill.precio,
      at: a.fill.at, order_status: a.order_status,
    })),
    plan: row.plan != null ? row.plan : null,
    // Detector de fabricación (#93, _lib/prose-audit.js): journal-only. Se
    // expone tal cual quedó — con su tolerancia — para poder recomputar la
    // tasa de falsos positivos sin re-correr el modelo.
    deteccion_fabricacion: ctx.plan_number_audit || null,
  };
}

// Agrupa las filas por FECHA de corrida: un día normal trae una fila (la
// decisión del PM); un día con red de riesgo trae dos (la salida determinista
// se journalea aparte, por diseño). Orden ascendente por fecha y, dentro,
// por created_at — el orden en que realmente pasaron las cosas.
export function agrupaCorridas(filas) {
  const porFecha = new Map();
  for (const f of filas) {
    const k = String(f.fecha);
    if (!porFecha.has(k)) porFecha.set(k, { fecha: f.fecha, agentes: [], filas: [] });
    const c = porFecha.get(k);
    c.filas.push(f);
    if (f.agente && !c.agentes.includes(f.agente)) c.agentes.push(f.agente);
  }
  const corridas = [...porFecha.values()].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  for (const c of corridas) {
    c.filas.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
  return corridas;
}

// ── vista agregada (?view=resumen) ───────────────────────────────────
// Todas las métricas se calculan sobre las filas YA auditadas, en orden
// cronológico. Cero writes, cero red.
export function construyeResumen(filas, { deploy = BUFFET_QUALITY_DEPLOY } = {}) {
  const orden = [...filas].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const decisiones = orden.filter((f) => f.tipo === 'decision');
  const fechas = [...new Set(orden.map((f) => String(f.fecha)))].sort();

  // 1. Corridas y estatus.
  const por_status = {};
  for (const f of orden) por_status[f.status] = (por_status[f.status] || 0) + 1;

  // 2. Órdenes: propuestas / aprobadas / descartadas / fills.
  const todasAcciones = orden.flatMap((f) => f.acciones.map((a) => ({ ...a, fecha: f.fecha, fila: f.id })));
  const pmAcciones = todasAcciones.filter((a) => !a.es_salida_de_riesgo);
  const ordenes = {
    propuestas: todasAcciones.length,
    aprobadas: todasAcciones.filter((a) => a.veredicto === 'aprobada').length,
    descartadas: todasAcciones.filter((a) => a.veredicto === 'descartada').length,
    envios_fallidos: todasAcciones.filter((a) => a.veredicto === 'envio_fallido').length,
    fills: todasAcciones.filter((a) => a.lleno).length,
    del_pm: {
      propuestas: pmAcciones.length,
      aprobadas: pmAcciones.filter((a) => a.veredicto === 'aprobada').length,
      descartadas: pmAcciones.filter((a) => a.veredicto === 'descartada').length,
      fills: pmAcciones.filter((a) => a.lleno).length,
    },
    salidas_de_riesgo: todasAcciones.filter((a) => a.es_salida_de_riesgo).length,
  };

  // 3. Ventas VOLUNTARIAS: ventas del PM, sin contar la red determinista.
  // Esperado 0 — el agente nunca ha vendido por decisión propia.
  const ventas = pmAcciones.filter((a) => String(a.side || '').toLowerCase() === 'sell');
  const ventas_voluntarias = {
    esperado: 0,
    total: ventas.length,
    detalle: ventas.map((a) => ({
      fecha: a.fecha, simbolo: a.simbolo, qty: a.qty, limite: a.limite,
      veredicto: a.veredicto, motivo: a.motivo,
    })),
  };

  // 4. scout_picks por corrida, ANTES vs DESPUÉS del deploy de buffet-quality.
  // Solo cuentan las filas donde el scan CORRIÓ (picks !== null): una corrida
  // abortada antes del scan no es un cero, es un dato ausente.
  const conScan = decisiones.filter((f) => f.scout.picks_n != null);
  const periodoDe = (f) => (String(f.created_at) >= String(deploy) ? 'despues' : 'antes');
  const grupo = (nombre) => {
    const g = conScan.filter((f) => periodoDe(f) === nombre);
    const total = g.reduce((s, f) => s + f.scout.picks_n, 0);
    return {
      corridas: g.length,
      picks_totales: total,
      promedio: g.length ? +(total / g.length).toFixed(2) : null,
      corridas_sin_picks: g.filter((f) => f.scout.picks_n === 0).length,
    };
  };
  const antes = grupo('antes');
  const despues = grupo('despues');
  const scout_picks_vs_buffet_quality = {
    deploy,
    antes,
    despues,
    delta_promedio: (antes.promedio != null && despues.promedio != null)
      ? +(despues.promedio - antes.promedio).toFixed(2) : null,
    por_corrida: conScan.map((f) => ({
      fecha: f.fecha, periodo: periodoDe(f), picks: f.scout.picks_n,
      slate: Array.isArray(f.slate_final) ? f.slate_final.length : null,
      simbolos: f.scout.picks,
    })),
  };

  // 5. Posiciones heridas (≤ −5% desde entrada) y atención posterior del PM.
  // La pregunta medida: cuando una posición cruzó −5%, ¿el plan de las
  // corridas SIGUIENTES la nombró por su nombre, o la ignoró?
  const heridas = new Map();
  for (const f of orden) {
    for (const p of ((f.portafolio && f.portafolio.posiciones) || [])) {
      if (p.pnl_pct == null || p.pnl_pct > HERIDA_PCT || !p.simbolo) continue;
      if (!heridas.has(p.simbolo)) heridas.set(p.simbolo, { simbolo: p.simbolo, primera_fecha: f.fecha, primer_created_at: f.created_at, corridas_heridas: [], peor_pnl_pct: p.pnl_pct });
      const h = heridas.get(p.simbolo);
      h.corridas_heridas.push({ fecha: f.fecha, pnl_pct: p.pnl_pct });
      if (p.pnl_pct < h.peor_pnl_pct) h.peor_pnl_pct = p.pnl_pct;
    }
  }
  const conProsa = orden.filter((f) => typeof f.plan === 'string' && f.plan.trim() && f.tipo === 'decision');
  const detalleHeridas = [...heridas.values()].map((h) => {
    const posteriores = conProsa.filter((f) => String(f.created_at) > String(h.primer_created_at));
    const menciones = posteriores
      .map((f) => ({ fecha: f.fecha, frases: frasesConSimbolo(f.plan, h.simbolo) }))
      .filter((m) => m.frases.length);
    return {
      simbolo: h.simbolo,
      primera_corrida_herida: h.primera_fecha,
      corridas_herida: h.corridas_heridas.length,
      peor_pnl_pct: h.peor_pnl_pct,
      corridas_posteriores_con_prosa: posteriores.length,
      corridas_que_la_mencionan: menciones.length,
      tasa_mencion: posteriores.length ? +(menciones.length / posteriores.length).toFixed(2) : null,
      mencionada_en_la_siguiente: posteriores.length
        ? frasesConSimbolo(posteriores[0].plan, h.simbolo).length > 0 : null,
      menciones,
    };
  }).sort((a, b) => a.peor_pnl_pct - b.peor_pnl_pct);
  const totPost = detalleHeridas.reduce((s, h) => s + h.corridas_posteriores_con_prosa, 0);
  const totMen = detalleHeridas.reduce((s, h) => s + h.corridas_que_la_mencionan, 0);
  const posiciones_heridas = {
    umbral_pct: HERIDA_PCT,
    simbolos: detalleHeridas.length,
    corridas_posteriores_totales: totPost,
    menciones_totales: totMen,
    tasa_mencion_global: totPost ? +(totMen / totPost).toFixed(2) : null,
    detalle: detalleHeridas,
  };

  // 6. Cambios de veredicto sobre un MISMO símbolo entre corridas (el caso
  // LYFT: descartado el 05-ago, aprobado el 13/14-ago). Solo acciones del PM
  // —una salida determinista no es un cambio de opinión— y solo veredictos
  // reales del guard (aprobada/descartada). Se citan las frases del plan de
  // esa corrida que nombran al símbolo: el porqué, verbatim.
  const porSimbolo = new Map();
  for (const f of decisiones) {
    for (const a of f.acciones) {
      if (a.es_salida_de_riesgo || !a.simbolo) continue;
      if (a.veredicto !== 'aprobada' && a.veredicto !== 'descartada') continue;
      if (!porSimbolo.has(a.simbolo)) porSimbolo.set(a.simbolo, []);
      porSimbolo.get(a.simbolo).push({
        fecha: f.fecha, veredicto: a.veredicto, side: a.side, qty: a.qty, limite: a.limite,
        motivo: a.motivo, canales: a.canales, origin: a.origin,
        frases_del_plan: frasesConSimbolo(f.plan, a.simbolo),
      });
    }
  }
  const cambios_de_veredicto = [...porSimbolo.entries()]
    .map(([simbolo, apariciones]) => ({ simbolo, apariciones }))
    .filter(({ apariciones }) => {
      const v = new Set(apariciones.map((x) => x.veredicto));
      return v.has('aprobada') && v.has('descartada');
    })
    .map(({ simbolo, apariciones }) => ({
      simbolo,
      corridas: apariciones.length,
      secuencia: apariciones.map((x) => `${x.fecha}:${x.veredicto}`),
      apariciones,
    }))
    .sort((a, b) => b.corridas - a.corridas || a.simbolo.localeCompare(b.simbolo));

  return {
    rango: { desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null },
    corridas: {
      fechas: fechas.length,
      filas_journal: orden.length,
      decisiones: decisiones.length,
      filas_de_riesgo: orden.filter((f) => f.tipo === 'red_de_riesgo').length,
      mercado_cerrado: orden.filter((f) => f.tipo === 'mercado_cerrado').length,
      por_status,
    },
    ordenes,
    ventas_voluntarias,
    scout_picks_vs_buffet_quality,
    posiciones_heridas,
    cambios_de_veredicto,
  };
}

// ═══════════════ Markdown (español, para leer o pegar) ═══════════════

const nf = (n, d = 2) => (isNum(n) ? n.toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const si = (b) => (b === true ? 'sí' : b === false ? 'no' : '—');
const val = (v) => (v == null || v === '' ? '—' : String(v));

function mdTabla(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map((c) => String(c == null ? '—' : c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`),
  ].join('\n');
}

// ── EL BLOQUE DEL CONTRATO OBJETIVO, EN MARKDOWN ─────────────────────
// Pensado para leerse en una terminal SIN jq: una tabla de órdenes con el monto
// ya calculado, y el modo arriba de todo. Lo primero que hay que poder
// confirmar en una corrida SIN ENVIAR es que no salió una sola orden.
function mdObjetivo(o) {
  const L = [];
  // El MISMO sello que la tarjeta de /liga/libros. Dos lugares con dos
  // redacciones para el mismo estado es la forma de que un día difieran.
  const sinEnviar = o.modo === 'dry';
  L.push(`**Contrato objetivo (v4)** — modo \`${val(o.modo)}\` · **${sinEnviar ? 'EN VIVO · SIN ENVIAR' : 'EN VIVO'}**` +
    (sinEnviar ? ' — NADA SE MANDÓ: las órdenes de abajo son las que se habrían mandado.' : ''));

  const rieles = o.rieles
    ? (o.rieles.paso ? '✅ pasa los rieles' : `❌ **RECHAZADO** — ${o.rieles.violaciones.map((v) => v.riel + (v.simbolo ? ' ' + v.simbolo : '')).join(', ')}`)
    : '—';
  L.push(`${rieles} · ${o.posiciones} posición(es) objetivo · turnover ${o.turnover != null ? (o.turnover * 100).toFixed(1) + '%' : '—'}` +
    (o.candado_ok === false ? ' · ⛔ **CANDADO SALTÓ**' : ''));
  if (o.freno) L.push(`\n> ⛔ **FRENO:** ${o.freno}`);

  if (o.rieles && o.rieles.violaciones.length) {
    L.push('');
    L.push(mdTabla(['riel', 'símbolo', 'detalle'], o.rieles.violaciones.map((v) => [v.riel, v.simbolo || '—', v.detalle])));
  }

  const pesos = Object.entries(o.pesos_pct || {});
  if (pesos.length) {
    L.push('\n**El libro que quiere**');
    L.push(mdTabla(['símbolo', 'peso'], pesos.map(([k, v]) => [k, v + '%'])));
  }

  if (o.ordenes && o.ordenes.length) {
    L.push(`\n**Órdenes ${sinEnviar ? 'que habría mandado' : 'mandadas'}** — ${o.ordenes_n}, $${nf(o.monto_total)} en total`);
    L.push(mdTabla(
      ['símbolo', 'lado', 'qty', 'límite', 'monto', 'peso', 'estado'],
      o.ordenes.map((x) => [
        x.simbolo, x.lado, x.qty, x.limite != null ? '$' + x.limite : '—',
        x.monto != null ? '$' + nf(x.monto) : '—',
        `${((x.peso_de || 0) * 100).toFixed(1)}% → ${((x.peso_a || 0) * 100).toFixed(1)}%`,
        sinEnviar ? 'sin enviar' : (x.resultado === 'approved' ? (x.order_status || 'enviada') : (x.error ? 'FALLÓ: ' + String(x.error).slice(0, 60) : val(x.resultado))),
      ]),
    ));
  } else if (o.rieles && o.rieles.paso) {
    L.push('\n_Cero órdenes: el libro real ya coincide con el objetivo (o los movimientos no pasaron la banda de no-negociación)._');
  }

  if (o.descartadas && o.descartadas.length) {
    L.push('\n**Patas que NO llegaron a orden**');
    L.push(mdTabla(['símbolo', 'lado', 'motivo'], o.descartadas.map((d) => [d.simbolo, d.lado || '—', d.motivo])));
  }
  if (o.tickers && (o.tickers.reparados || []).length) {
    L.push(`\n> ⚠️ **Tickers reparados:** ${o.tickers.reparados.map((r) => `"${r.pedido}" → ${r.normalizado}`).join(', ')}. El modelo los escribió mal y se normalizaron contra el universo.`);
  }
  return L.join('\n');
}

// ── EL DIAGNÓSTICO, EN MARKDOWN ──────────────────────────────────────
// Las tres preguntas de siempre, en tres renglones: qué vuelta, cuántos ms,
// qué proveedor. Y la cuarta que nadie hace hasta que la necesita: cuál reloj.
function mdDiagnostico(d) {
  const L = [];
  const h = d.herramientas;
  if (h) {
    L.push(`**Investigación** — ${val(h.usadas)}/${val(h.tope)} herramientas en ${val(h.vueltas)} vuelta(s) · cortó por \`${val(h.corte)}\``);
  }

  // Los cortes por cuerpo vacío: vuelta, intento, ms, bytes y quién atendió.
  if (d.cuerpos_vacios && d.cuerpos_vacios.length) {
    L.push('\n**Cuerpos vacíos** — el proveedor abrió la conexión y la cerró sin mandar respuesta');
    L.push(mdTabla(['vuelta', 'intento', 'ms', 'bytes', 'proveedor', '¿reloj nuestro?'], d.cuerpos_vacios.map((v) => [
      val(v.vuelta), v.omitido ? `— (${v.omitido})` : val(v.intento), val(v.ms), val(v.bytes),
      // `null` acá NO es un hueco: OpenRouter manda el nombre del proveedor
      // DENTRO del cuerpo, así que un cuerpo que no llegó no trae nombre.
      v.proveedor || '_(el cuerpo no llegó: el nombre viaja adentro)_',
      v.timeout_nuestro ? '**SÍ**' : 'no',
    ])));
  }

  // Quién atendió cada vuelta que SÍ contestó. Es lo que dice si el corte cae
  // siempre sobre el mismo proveedor o si rota.
  if (d.proveedores && d.proveedores.length) {
    L.push('\n**Quién atendió cada vuelta**');
    L.push(mdTabla(['vuelta', 'proveedor', 'ms', 'ok'], d.proveedores.map((p2) => [
      val(p2.vuelta), val(p2.proveedor), val(p2.ms), p2.ok ? '✅' : '❌',
    ])));
  }
  if (d.proveedores_colgados && d.proveedores_colgados.length) {
    L.push(`\n> Proveedores que se colgaron: ${d.proveedores_colgados.join(', ')}`);
  }

  // Dónde murió, y cuál reloj lo cortó.
  const donde = d.murio_en ? `murió en \`${val(d.murio_en.fase || d.murio_en)}\`` : (d.cierre ? 'llegó al turno de cierre' : null);
  if (donde) L.push(`\n${donde}`);
  if (d.techo_ms != null) {
    L.push(`\n> ⏱️ **Techo de esa llamada:** ${Math.round(d.techo_ms / 1000)}s — puesto por: ${val(d.techo_origen)}`);
  }
  if (d.detalle) L.push(`\n> ${d.status_http != null ? `HTTP ${d.status_http} — ` : ''}${d.detalle}`);

  // Los tickers: qué se rechazó y qué se reparó. Apunta al prompt, no a la red.
  const t2 = d.tickers;
  if (t2 && ((t2.desconocidos || []).length || (t2.reparados || []).length || (t2.colisiones || []).length)) {
    if ((t2.desconocidos || []).length) {
      // `desconocidos` son OBJETOS ({pedido, normalizado?, motivo}), no strings:
      // un `join` los imprimía como "[object Object]" y el reporte decía que
      // algo se rechazó sin decir QUÉ — que es la única pregunta que se hace
      // ante un rechazo de tickers.
      L.push(`\n> ❌ **Tickers que no existen en el universo** (${t2.desconocidos.length}) — el objetivo ENTERO se rechaza: una orden sobre un nombre inventado no se manda.`);
      L.push('');
      L.push(mdTabla(['pedido', 'normalizado', 'por qué'], t2.desconocidos.map((d) => [
        '`' + val(d.pedido) + '`',
        d.normalizado && d.normalizado !== d.pedido ? '`' + d.normalizado + '`' : '—',
        val(d.motivo),
      ])));
    }
    if ((t2.reparados || []).length) {
      L.push(`\n> ⚠️ **Tickers reparados:** ${t2.reparados.map((r) => `"${r.pedido}" → ${r.normalizado}`).join(', ')}`);
    }
    if ((t2.colisiones || []).length) {
      L.push(`\n> ⚠️ **Colisiones al normalizar:** ${JSON.stringify(t2.colisiones).slice(0, 200)}`);
    }
    if (t2.validado_contra_universo === false) {
      L.push('\n> El universo no estaba disponible: NO se validó contra él (hueco honesto, no un visto bueno).');
    }
  }
  return L.join('\n');
}

function mdFila(f) {
  const L = [];
  const titulo = f.tipo === 'red_de_riesgo' ? 'Red de riesgo (determinista)'
    : f.tipo === 'mercado_cerrado' ? 'Mercado cerrado' : 'Decisión del PM';
  L.push(`### ${titulo} — \`${f.status}\``);
  const meta = [`agente **${val(f.agente)}**`, `modelo \`${val(f.modelo)}\``, `prompt \`${val(f.prompt_version)}\``];
  if (f.cuenta && f.cuenta.equity != null) meta.push(`equity **$${nf(Number(f.cuenta.equity))}** · cash $${nf(Number(f.cuenta.cash))} · ${val(f.cuenta.positions)} posiciones`);
  L.push(meta.join(' · '));

  // ── EL LIBRO CON EL QUE DECIDIÓ ──
  // Con precio de entrada y P&L al momento de decidir. Es la mitad del
  // contexto de una decisión: sin él, "compró NVDA" no dice si ya la tenía
  // ganando o si estaba entrando por primera vez.
  if (f.cuenta && Array.isArray(f.cuenta.holdings) && f.cuenta.holdings.length) {
    L.push('\n**El libro al decidir**');
    L.push(mdTabla(['símbolo', 'qty', 'entrada', 'precio', 'valor', 'P&L'], f.cuenta.holdings.map((h) => [
      h.symbol, val(h.qty),
      h.avg_entry_price != null ? '$' + h.avg_entry_price : '—',
      h.current_price != null ? '$' + h.current_price : '—',
      h.market_value != null ? '$' + nf(h.market_value) : '—',
      h.unrealized_plpc != null ? ((h.unrealized_plpc >= 0 ? '+' : '') + (h.unrealized_plpc * 100).toFixed(1) + '%') : '—',
    ])));
  }
  if (f.error) L.push(`\n> **Error de la corrida:** ${f.error}`);

  // ── POR QUÉ ABORTÓ ──
  // Va inmediatamente después del error y antes que nada más: si la corrida no
  // decidió, lo único que importa de esa fila es por qué.
  if (f.diagnostico) L.push('\n' + mdDiagnostico(f.diagnostico));

  // ── CONTRATO OBJETIVO (v4) ──
  // Va ARRIBA del buffet: en una corrida del contrato nuevo esto es la
  // decisión, y el buffet es el insumo. En la corrida SECA es además lo único
  // que hay para revisar antes de encender.
  if (f.objetivo) L.push('\n' + mdObjetivo(f.objetivo));

  // Buffet
  L.push('\n**Buffet — qué canales llegaron**');
  if (!f.buffet.reconstruido) {
    L.push('_El prompt del scan no quedó journaleado en esta fila: no se pueden contar los ítems (hueco honesto, no un cero)._');
  }
  const c = f.buffet.canales;
  L.push(mdTabla(['canal', 'llegó', 'ítems reales', 'detalle', 'error'], [
    ['movers', si(c.movers.llego), c.movers.items, c.movers.detalle ? `gainers ${c.movers.detalle.gainers} · losers ${c.movers.detalle.losers} · actives ${c.movers.detalle.actives}` : '—', c.movers.error],
    ['earnings', si(c.earnings.llego), c.earnings.items, c.earnings.detalle ? `próximos ${c.earnings.detalle.proximos} · ya reportaron ${c.earnings.detalle.reportados}` : '—', c.earnings.error],
    ['insiders', si(c.insiders.llego), c.insiders.items, '—', c.insiders.error],
    ['screener', si(c.screener.llego), c.screener.items, c.screener.detalle ? `value ${c.screener.detalle.value} · momentum ${c.screener.detalle.momentum}` : '—', c.screener.error],
  ]));
  if (f.buffet.screener_state) L.push(`Estado del canal screener: \`${f.buffet.screener_state}\``);

  // Libro
  if (f.portafolio && f.portafolio.posiciones.length) {
    const heridas = f.portafolio.posiciones.filter((p) => p.pnl_pct != null && p.pnl_pct <= HERIDA_PCT);
    L.push(`\n**Libro que vio el PM:** ${f.portafolio.posiciones.length} posiciones` +
      (heridas.length ? ` · **heridas (≤${HERIDA_PCT}%): ${heridas.map((p) => `${p.simbolo} ${p.pnl_desde_entrada}`).join(', ')}**` : ''));
  }

  // Scout + slate
  if (f.scout.picks != null) {
    L.push(`\n**Scout** (${f.scout.picks_n} picks): ${f.scout.picks.length ? f.scout.picks.join(', ') : '_ninguno_'}`);
    if (f.scout.tesis) L.push(`> ${f.scout.tesis}`);
  }
  if (f.slate_final) {
    L.push(`\n**Slate final:** ${f.slate_final.length ? f.slate_final.map((s) => `${s.symbol} (${s.origin})`).join(', ') : '_vacío_'}`);
    if (f.floor) L.push(`Floor del screener: ${f.floor.applied ? '**aplicado**' : 'no aplicado'} · razón \`${val(f.floor.reason)}\` · reserva [${(f.floor.reserved || []).join(', ') || '—'}] · tope ${val(f.floor.floor)}`);
  }

  // Acciones + guard
  if (f.acciones.length) {
    L.push('\n**Acciones propuestas y veredicto del guard**');
    L.push(mdTabla(['símbolo', 'lado', 'qty', 'límite', 'veredicto', 'por qué', 'canal/origen'], f.acciones.map((a) => [
      a.simbolo, a.side, a.qty, a.limite != null ? `$${nf(a.limite)}` : '—',
      a.veredicto === 'aprobada' ? '**aprobada**' : a.veredicto,
      a.motivo || (a.reason_codes ? a.reason_codes.join(', ') : '—'),
      [(a.canales || []).join('/') || '—', a.origin || null].filter(Boolean).join(' · '),
    ])));
  } else {
    L.push('\n**Acciones propuestas:** ninguna.');
  }

  // Fills
  L.push(`\n**Fills:** ${f.fills.length
    ? f.fills.map((x) => `${x.simbolo} ${x.side} ${val(x.qty)} @ $${nf(x.precio)} (${val(x.at)}, ${val(x.order_status)})`).join(' · ')
    : 'ninguno'}`);

  // Riesgo
  if (f.riesgo) {
    L.push(`\n**Riesgo:** etapa \`${val(f.riesgo.stage)}\` · drawdown ${f.riesgo.drawdown != null ? (f.riesgo.drawdown * 100).toFixed(1) + '%' : '—'} · pico $${nf(Number(f.riesgo.peak))}`);
  }

  // Prosa
  if (f.plan) {
    L.push('\n**Plan (verbatim)**');
    L.push(f.plan.split('\n').map((l) => `> ${l}`).join('\n'));
  }

  // Detector de fabricación (#93)
  if (f.deteccion_fabricacion) {
    const d = f.deteccion_fabricacion;
    L.push(`\n**Detector de fabricación (#93):** ${d.checked} % citados · **${d.unmatched} sin ancla** (tolerancia abs ${d.tolerance ? d.tolerance.abs : '—'} / rel ${d.tolerance ? d.tolerance.rel : '—'})`);
    const sinAncla = (d.tokens || []).filter((t) => !t.matched);
    if (sinAncla.length) L.push(sinAncla.map((t) => `- \`${t.token}\` — más cercano en el prompt: ${val(t.nearest)} (Δ ${val(t.delta)})`).join('\n'));
  } else if (f.tipo === 'decision' && f.plan) {
    L.push('\n**Detector de fabricación (#93):** sin registro para esta corrida.');
  }
  return L.join('\n');
}

export function renderCorridasMarkdown(audit) {
  const L = [];
  L.push(`# Auditoría del Arena — agente \`${audit.agente}\``);
  L.push('');
  L.push(`Generado ${audit.generado_en} · ${audit.total_filas} filas de journal · ${audit.corridas.length} corridas` +
    (audit.rango && audit.rango.desde ? ` · rango ${audit.rango.desde} → ${audit.rango.hasta}` : ''));
  L.push('');
  L.push('_Solo lectura: este endpoint no escribe en ninguna tabla, no late heartbeats y no toca el camino de decisión._');
  if (audit.halt && audit.halt.length) {
    const detenidos = audit.halt.filter((h) => h.halted);
    if (!detenidos.length) {
      L.push(`\n> ✅ Ningún agente detenido por el breaker (${audit.halt.length} revisado(s)).`);
    }
    for (const h of audit.halt) {
      // ── "HALT — control activo" SE LEÍA AL REVÉS ───────────────────
      // El encabezado decía HALT y el estado decía "activo", así que un agente
      // SANO parecía detenido. La palabra que manda tiene que ser la primera.
      // Y una línea por agente sano es ruido: sólo se listan los detenidos, y
      // si no hay ninguno se dice una vez.
      if (h.halted) {
        L.push(`\n> ⛔ **DETENIDO** — \`${h.agent_id}\` desde ${val(h.halted_at)}: ${val(h.halted_reason)}. No vuelve solo: se reactiva a mano con \`/api/arena-run?phase=resume&agent=${h.agent_id}\`.`);
      }
    }
  }
  if (!audit.corridas.length) L.push('\n_Sin corridas en el journal para este agente._');
  for (const c of audit.corridas) {
    L.push(`\n---\n`);
    L.push(`## Corrida ${c.fecha}${c.filas.length > 1 ? ` (${c.filas.length} filas)` : ''}`);
    for (const f of c.filas) { L.push(''); L.push(mdFila(f)); }
  }
  return L.join('\n') + '\n';
}

export function renderResumenMarkdown(audit) {
  const r = audit.resumen;
  const L = [];
  L.push(`# Resumen del run — Arena, agente \`${audit.agente}\``);
  L.push('');
  L.push(`Generado ${audit.generado_en} · rango ${val(r.rango.desde)} → ${val(r.rango.hasta)}`);
  L.push('');
  L.push('_Solo lectura: este endpoint no escribe en ninguna tabla, no late heartbeats y no toca el camino de decisión._');

  L.push('\n## Corridas');
  L.push(mdTabla(['métrica', 'valor'], [
    ['fechas con corrida', r.corridas.fechas],
    ['filas de journal', r.corridas.filas_journal],
    ['decisiones del PM', r.corridas.decisiones],
    ['filas de red de riesgo', r.corridas.filas_de_riesgo],
    ['mercado cerrado', r.corridas.mercado_cerrado],
  ]));
  L.push('\n**Por status**');
  L.push(mdTabla(['status', 'corridas'], Object.entries(r.corridas.por_status).sort((a, b) => b[1] - a[1])));

  L.push('\n## Órdenes');
  L.push(mdTabla(['métrica', 'total', 'solo PM'], [
    ['propuestas', r.ordenes.propuestas, r.ordenes.del_pm.propuestas],
    ['aprobadas', r.ordenes.aprobadas, r.ordenes.del_pm.aprobadas],
    ['descartadas', r.ordenes.descartadas, r.ordenes.del_pm.descartadas],
    ['envíos fallidos', r.ordenes.envios_fallidos, '—'],
    ['fills', r.ordenes.fills, r.ordenes.del_pm.fills],
    ['salidas de riesgo', r.ordenes.salidas_de_riesgo, '—'],
  ]));

  L.push('\n## Ventas voluntarias (esperado: 0)');
  const v = r.ventas_voluntarias;
  L.push(v.total === 0
    ? '**0 ventas voluntarias.** El PM nunca vendió por decisión propia; todo lo que salió del libro lo sacó la red determinista.'
    : `**${v.total} ventas voluntarias** (rompe la expectativa de 0):`);
  if (v.total) L.push(mdTabla(['fecha', 'símbolo', 'qty', 'límite', 'veredicto', 'motivo'],
    v.detalle.map((x) => [x.fecha, x.simbolo, x.qty, x.limite != null ? `$${nf(x.limite)}` : '—', x.veredicto, x.motivo])));

  L.push('\n## scout_picks: antes vs después de buffet-quality');
  const s = r.scout_picks_vs_buffet_quality;
  L.push(`Corte del deploy: \`${s.deploy}\` (PR #108 — earnings por relevancia + filtro de tipos en movers). La predicción registrada: más candidatos por corrida después.`);
  L.push(mdTabla(['periodo', 'corridas', 'picks totales', 'promedio/corrida', 'corridas con 0 picks'], [
    ['antes', s.antes.corridas, s.antes.picks_totales, s.antes.promedio, s.antes.corridas_sin_picks],
    ['después', s.despues.corridas, s.despues.picks_totales, s.despues.promedio, s.despues.corridas_sin_picks],
  ]));
  L.push(`**Delta del promedio:** ${s.delta_promedio == null ? '— (falta un lado del corte)' : (s.delta_promedio > 0 ? '+' : '') + s.delta_promedio + ' picks/corrida'}`);
  if (s.por_corrida.length) {
    L.push('\n**Por corrida**');
    L.push(mdTabla(['fecha', 'periodo', 'picks', 'slate final', 'símbolos'],
      s.por_corrida.map((x) => [x.fecha, x.periodo, x.picks, x.slate, (x.simbolos || []).join(', ') || '—'])));
  }

  L.push('\n## Atención a posiciones heridas (≤ −5%)');
  const h = r.posiciones_heridas;
  L.push(`${h.simbolos} símbolos cruzaron −5% desde su entrada. En las corridas POSTERIORES con prosa, el plan los nombró **${h.menciones_totales} de ${h.corridas_posteriores_totales}** veces (tasa ${h.tasa_mencion_global == null ? '—' : h.tasa_mencion_global}).`);
  if (h.detalle.length) L.push(mdTabla(['símbolo', 'primera corrida herida', 'corridas herido', 'peor P&L', 'corridas posteriores', 'lo mencionan', 'tasa', 'la siguiente corrida'],
    h.detalle.map((x) => [x.simbolo, x.primera_corrida_herida, x.corridas_herida, x.peor_pnl_pct + '%',
      x.corridas_posteriores_con_prosa, x.corridas_que_la_mencionan, x.tasa_mencion, si(x.mencionada_en_la_siguiente)])));
  for (const x of h.detalle) {
    if (!x.menciones.length) continue;
    L.push(`\n**${x.simbolo}** — frases donde el plan la nombra:`);
    for (const m of x.menciones) for (const fr of m.frases) L.push(`- ${m.fecha}: “${fr}”`);
  }

  L.push('\n## Cambios de veredicto sobre el mismo símbolo');
  if (!r.cambios_de_veredicto.length) L.push('_Ningún símbolo cambió de veredicto entre corridas._');
  for (const cv of r.cambios_de_veredicto) {
    L.push(`\n### ${cv.simbolo} — ${cv.secuencia.join(' → ')}`);
    L.push(mdTabla(['fecha', 'veredicto', 'lado', 'límite', 'por qué (guard)'],
      cv.apariciones.map((a) => [a.fecha, a.veredicto === 'aprobada' ? '**aprobada**' : a.veredicto, a.side,
        a.limite != null ? `$${nf(a.limite)}` : '—', a.motivo || '—'])));
    for (const a of cv.apariciones) {
      for (const fr of a.frases_del_plan) L.push(`- ${a.fecha}: “${fr}”`);
    }
  }
  return L.join('\n') + '\n';
}
