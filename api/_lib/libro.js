// ═══════════════════════════════════════════════════════════════════
// api/_lib/libro.js — EL LIBRO: la cuenta real de Lety con las puertas del Arena.
//
// Tres cosas, y nada más:
//   1. Solo opera estrategias con GO escrito, detrás del mismo guard
//      determinista del Arena (rieles + salidas de riesgo ANTES de cualquier
//      estrategia).
//   2. Ledger con fecha REAL de envío de cada orden (no la fecha de la decisión).
//   3. Reporte de TRES números contra SPY: ¿le gané al piso? ¿cuánto me asusté?
//      ¿fue suerte?
//
// FASE 0 (este archivo): plomería. Ninguna estrategia está enchufada; el
// registro de adaptadores (ADAPTADORES) está vacío a propósito y el cron, si
// corriera, solo evaluaría salidas de riesgo. Fase 1 enchufa tsla_bollinger
// (ver docs/libro.md §Fase 1).
//
// PRINCIPIOS CONGELADOS (ver docs/libro.md; no se negocian en el código):
//   · LIBRO_LIVE_ENABLED='true' o nada sale (sombra) — _lib/libro-alpaca.js.
//   · Credenciales ALPACA_LIVE_*; jamás las del Arena.
//   · Limit-only, day. Long-only en v1. Máx 8 posiciones, 15%/posición,
//     10% cash, banda ±2% sobre el último cierre, precio ≥ $5.
//   · Violación de riel = orden DESCARTADA y journaleada. Nunca ajustada.
//   · Kill switch: cancela todo + LIBRO_HALT=1 en Neon. Con halt, nada se manda.
//   · Stop catastrófico 22% / breaker −15% delever / −20% liquida+halt:
//     IMPORTADOS de _lib/arena-exits.js (misma regla, mismo código).
//   · Una estrategia activa no se edita: se cierra. (`cerrarEstrategia`.)
//
// ENV VARS: DATABASE_URL · ALPACA_LIVE_* · LIBRO_LIVE_ENABLED · ADMIN_SECRET
// ═══════════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { EXIT_RULES, buildRiskExits } from './arena-exits.js';

// ─────────────────── RIELES ───────────────────
// Copia DECLARADA de ARENA_RULES (api/_lib/arena-guard.js), no importada: el
// Arena ajusta sus bandas por env var para experimentar; el Libro no
// experimenta con dinero real. Si algún día difieren, que sea por decisión
// escrita aquí, no por una env var que alguien movió para la liga.
export const LIBRO_RULES = Object.freeze({
  max_positions: 8,
  max_position_fraction: 0.15,
  min_cash_fraction: 0.10,
  price_band: 0.02,
  min_price: 5,
  long_only: true,
});

// Salidas de riesgo: el Libro usa las MISMAS reglas que la T2 del Arena
// (22% catastrófico, 15%/20% breaker). Se re-exportan para que el reporte y
// los docs lean de un solo lugar.
export const LIBRO_EXIT_RULES = EXIT_RULES;

export const ESTADOS = Object.freeze(['candidata', 'paper', 'validada', 'activa', 'cerrada']);
export const HORIZONTE_DEFAULT_MESES = 6;

// ─────────────────── SCHEMA ───────────────────
const SCHEMA = [
  `create table if not exists libro_estrategias (
     id                 text primary key,
     nombre             text not null,
     estado             text not null,
     fuente_del_go      text,
     fecha_inicio       date,
     horizonte_meses    int not null default 6,
     tamano_max_pct     numeric not null default 10,
     criterio_de_salida text,
     notas              text,
     created_at         timestamptz not null default now(),
     cerrada_at         timestamptz,
     motivo_cierre      text
   )`,
  `create table if not exists libro_ordenes (
     client_order_id    text primary key,
     enviada_at         timestamptz not null,
     estrategia_id      text not null,
     symbol             text not null,
     side               text not null,
     qty                int not null,
     limit_price        numeric not null,
     referencia         numeric,
     estado             text not null,
     alpaca_order_id    text,
     fill_price         numeric,
     fill_ts            timestamptz,
     motivo             text,
     origen             text not null default 'estrategia',
     sombra             boolean not null default true
   )`,
  `create table if not exists libro_equity_diario (
     fecha      date primary key,
     equity     numeric not null,
     cash       numeric not null,
     spy_close  numeric,
     posiciones int not null default 0,
     tomado_at  timestamptz not null default now()
   )`,
  // Una sola fila de estado: halt, benchmark (spy_unidades), equity inicial.
  `create table if not exists libro_estado (
     key        text primary key,
     valor      text,
     updated_at timestamptz not null default now()
   )`,
];

let ready = false;
export async function ensureLibroSchema() {
  if (ready) return;
  for (const q of SCHEMA) await sql(q);
  ready = true;
}
export function _resetSchemaCache() { ready = false; } // tests

// ─────────────────── ESTADO (halt / benchmark) ───────────────────
export async function leerEstado(key) {
  const rows = await sql(`select valor from libro_estado where key = $1`, [key]);
  return rows.length ? rows[0].valor : null;
}
export async function escribirEstado(key, valor) {
  await sql(
    `insert into libro_estado (key, valor, updated_at) values ($1, $2, now())
     on conflict (key) do update set valor = excluded.valor, updated_at = now()`,
    [key, valor == null ? null : String(valor)],
  );
}
export async function estaEnHalt() { return (await leerEstado('LIBRO_HALT')) === '1'; }

// Benchmark: UNA SOLA VEZ, igual que arena-benchmark.js. Guarda cuántas
// "unidades" de SPY compraba el equity inicial; desde ahí la línea SPY es
// unidades × precio. Dividendos NO contados (dicho en el reporte).
export async function abrirBenchmark({ equity, spyPrice, now = new Date() }) {
  const e = Number(equity), p = Number(spyPrice);
  if (!Number.isFinite(e) || e <= 0) return { ok: false, reason: 'sin_equity' };
  if (!Number.isFinite(p) || p <= 0) return { ok: false, reason: 'sin_precio_spy', detail: 'no se abre el benchmark con un precio inventado' };
  const ya = await leerEstado('spy_unidades');
  if (ya != null) return { ok: true, ya_estaba: true, spy_unidades: Number(ya), equity_inicial: Number(await leerEstado('equity_inicial')) };
  const unidades = +(e / p).toFixed(6);
  await escribirEstado('spy_unidades', unidades);
  await escribirEstado('equity_inicial', e);
  await escribirEstado('spy_entry', p);
  await escribirEstado('abierto_at', now.toISOString());
  return { ok: true, ya_estaba: false, spy_unidades: unidades, equity_inicial: e, spy_entry: p };
}

// ─────────────────── ESTRATEGIAS ───────────────────
// Semilla de Fase 0: la vara y la única validada. Nada más — la cola de
// candidatas vive en docs/libro-cola.md como texto, no en la tabla.
export const SEMILLA = Object.freeze([
  {
    id: 'spy_piso', nombre: 'SPY · comprar y dejar (la vara)', estado: 'validada',
    fuente_del_go: 'No es una estrategia: es el benchmark. No opera.',
    horizonte_meses: 6, tamano_max_pct: 0,
    criterio_de_salida: 'No aplica.',
    notas: 'Todo se mide contra esto. Dividendos no contados.',
  },
  {
    id: 'tsla_bollinger', nombre: 'TSLA · Bollinger (bot de reglas)', estado: 'validada',
    fuente_del_go: 'Frankenstein validation engine: VENTAJA REAL a 2 años, FRÁGIL a 5. Edge "tesla bollingerr" en la flota de agentes.',
    horizonte_meses: 6, tamano_max_pct: 10,
    criterio_de_salida: 'Dos meses consecutivos por debajo de SPY, o drawdown propio > 15%.',
    notas: 'Entra chica. Candidata a Fase 1 (adaptador pendiente). Etiqueta honesta: real a 2 años, frágil a 5.',
  },
]);

export async function sembrarEstrategias(semilla = SEMILLA) {
  await ensureLibroSchema();
  let insertadas = 0;
  for (const s of semilla) {
    const r = await sql(
      `insert into libro_estrategias (id, nombre, estado, fuente_del_go, horizonte_meses, tamano_max_pct, criterio_de_salida, notas)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing returning id`,
      [s.id, s.nombre, s.estado, s.fuente_del_go, s.horizonte_meses, s.tamano_max_pct, s.criterio_de_salida, s.notas],
    );
    if (r.length) insertadas++;
  }
  return { insertadas, total: semilla.length };
}

export async function listarEstrategias() {
  await ensureLibroSchema();
  return sql(`select * from libro_estrategias order by created_at asc`);
}

// REGLA "cero cambios a media temporada": una fila ACTIVA no se edita. Lo
// único permitido es cerrarla (con motivo). Cambiar un parámetro = cerrar y
// abrir otra con otro id. El código lo impide, no un comentario.
export function puedeEditarse(estrategia) {
  return !!estrategia && estrategia.estado !== 'activa';
}
export async function actualizarEstrategia(id, campos) {
  await ensureLibroSchema();
  const [row] = await sql(`select * from libro_estrategias where id = $1`, [id]);
  if (!row) throw new Error(`estrategia ${id} no existe`);
  if (!puedeEditarse(row)) throw new Error(`estrategia ${id} está ACTIVA: no se edita, se cierra (cerrarEstrategia)`);
  const permitidos = ['nombre', 'estado', 'fuente_del_go', 'fecha_inicio', 'horizonte_meses', 'tamano_max_pct', 'criterio_de_salida', 'notas'];
  const sets = [], vals = [];
  for (const k of permitidos) if (k in campos) { sets.push(`${k} = $${sets.length + 2}`); vals.push(campos[k]); }
  if (!sets.length) return row;
  if ('estado' in campos && !ESTADOS.includes(campos.estado)) throw new Error('estado inválido: ' + campos.estado);
  // Activar exige fecha_inicio y criterio_de_salida escritos: sin eso no hay temporada.
  if (campos.estado === 'activa') {
    const fi = campos.fecha_inicio ?? row.fecha_inicio;
    const cs = campos.criterio_de_salida ?? row.criterio_de_salida;
    if (!fi || !cs) throw new Error('activar exige fecha_inicio y criterio_de_salida escritos');
  }
  await sql(`update libro_estrategias set ${sets.join(', ')} where id = $1`, [id, ...vals]);
  return (await sql(`select * from libro_estrategias where id = $1`, [id]))[0];
}
export async function cerrarEstrategia(id, motivo) {
  await ensureLibroSchema();
  if (!motivo) throw new Error('cerrar exige motivo escrito');
  await sql(`update libro_estrategias set estado = 'cerrada', cerrada_at = now(), motivo_cierre = $2 where id = $1`, [id, motivo]);
  return (await sql(`select * from libro_estrategias where id = $1`, [id]))[0];
}

// ─────────────────── GUARD (rieles) ───────────────────
// Puro. Recibe las órdenes propuestas por una estrategia y el estado de la
// cuenta, y devuelve { approved, discarded }. Nunca ajusta: una orden que viola
// un riel se descarta entera y se explica. Misma filosofía que validateActions
// del Arena; más chico porque el Libro no tiene LLM ni symbol map (las
// estrategias son reglas sobre un ticker conocido).
export function validarOrdenes({ ordenes = [], equity, cash, positions = [], lastCloses = {}, estrategias = {}, rules = LIBRO_RULES }) {
  const approved = [], discarded = [];
  const eq = Number(equity), ca = Number(cash);
  if (!Number.isFinite(eq) || eq <= 0 || !Number.isFinite(ca)) {
    return { approved, discarded: ordenes.map((o) => ({ ...o, reason: 'cuenta sin equity/cash legibles — fail closed' })) };
  }
  const held = new Map(positions.map((p) => [String(p.symbol).toUpperCase(), Number(p.qty) || 0]));
  const mv = new Map(positions.map((p) => [String(p.symbol).toUpperCase(), Number(p.market_value) || 0]));
  let cashLibre = ca;
  let nPos = positions.filter((p) => (Number(p.qty) || 0) !== 0).length;

  for (const o of ordenes) {
    const sym = String(o.symbol || '').toUpperCase();
    const side = o.side;
    const qty = o.qty;
    const limit = Number(o.limit_price);
    const ref = Number(lastCloses[sym]);
    const est = estrategias[o.estrategia_id];
    const rechazo = (reason) => discarded.push({ ...o, symbol: sym, reason });

    if (!sym) { rechazo('sin símbolo'); continue; }
    if (side !== 'buy' && side !== 'sell') { rechazo('side debe ser buy|sell'); continue; }
    if (!Number.isInteger(qty) || qty < 1) { rechazo('qty debe ser entero ≥ 1 (sin fraccionales)'); continue; }
    if (!Number.isFinite(limit) || limit <= 0) { rechazo('limit_price inválido'); continue; }
    if (!Number.isFinite(ref) || ref <= 0) { rechazo(`${sym}: sin último cierre de referencia — no se ancla el límite`); continue; }
    if (!est) { rechazo(`${o.estrategia_id}: estrategia desconocida`); continue; }
    if (est.estado !== 'activa') { rechazo(`${o.estrategia_id}: estado "${est.estado}", solo opera una estrategia ACTIVA`); continue; }
    if (Math.abs(limit - ref) / ref > rules.price_band + 1e-9) {
      rechazo(`${sym}: límite ${limit} fuera de la banda ±${rules.price_band * 100}% del cierre ${ref}`); continue;
    }
    if (ref < rules.min_price) { rechazo(`${sym}: precio ${ref} < $${rules.min_price}`); continue; }

    if (side === 'sell') {
      const h = held.get(sym) || 0;
      if (rules.long_only && qty > h) { rechazo(`${sym}: venta de ${qty} con ${h} en libro — sin cortos en v1`); continue; }
      approved.push({ ...o, symbol: sym });
      held.set(sym, h - qty);
      if (h - qty === 0) nPos--;
      cashLibre += qty * limit;
      continue;
    }

    // buy
    const notional = qty * limit;
    const yaTiene = (held.get(sym) || 0) > 0;
    if (!yaTiene && nPos + 1 > rules.max_positions) { rechazo(`${sym}: superaría ${rules.max_positions} posiciones`); continue; }
    const expuesto = (mv.get(sym) || 0) + notional;
    if (expuesto > eq * rules.max_position_fraction + 1e-6) {
      rechazo(`${sym}: ${expuesto.toFixed(0)} sería ${(expuesto / eq * 100).toFixed(1)}% del equity > ${rules.max_position_fraction * 100}%`); continue;
    }
    const topeEstrategia = eq * (Number(est.tamano_max_pct) / 100);
    if (expuesto > topeEstrategia + 1e-6) {
      rechazo(`${sym}: ${expuesto.toFixed(0)} supera el tamaño máximo de ${o.estrategia_id} (${est.tamano_max_pct}% = ${topeEstrategia.toFixed(0)})`); continue;
    }
    if (cashLibre - notional < eq * rules.min_cash_fraction - 1e-6) {
      rechazo(`${sym}: dejaría cash ${((cashLibre - notional) / eq * 100).toFixed(1)}% < ${rules.min_cash_fraction * 100}%`); continue;
    }
    approved.push({ ...o, symbol: sym });
    held.set(sym, (held.get(sym) || 0) + qty);
    mv.set(sym, expuesto);
    if (!yaTiene) nPos++;
    cashLibre -= notional;
  }
  return { approved, discarded };
}

// Salidas de riesgo: EL MISMO código de la T2. Corren antes que cualquier
// estrategia y no pasan por validarOrdenes (una venta protectora no se
// descarta por banda: su límite es marketable por diseño, ver arena-exits).
export function salidasDeRiesgo({ equity, peak, positions = [], closes = {}, escalation = {}, peaks = {} }) {
  return buildRiskExits({ equity, peak, positions, closes, rules: LIBRO_EXIT_RULES, escalation, peaks });
}

// ─────────────────── LEDGER ───────────────────
export function clientOrderId({ estrategia_id, date, symbol, side }) {
  return `libro:${estrategia_id}:${date}:${String(symbol).toUpperCase()}:${side}`;
}

// Registra UNA orden con su timestamp REAL de envío. Idempotente por
// client_order_id: un reintento del cron no duplica la fila.
export async function registrarOrden(o) {
  await ensureLibroSchema();
  const r = await sql(
    `insert into libro_ordenes (client_order_id, enviada_at, estrategia_id, symbol, side, qty, limit_price, referencia, estado, alpaca_order_id, motivo, origen, sombra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (client_order_id) do nothing returning client_order_id`,
    [o.client_order_id, (o.enviada_at instanceof Date ? o.enviada_at : new Date(o.enviada_at || Date.now())).toISOString(),
     o.estrategia_id, String(o.symbol).toUpperCase(), o.side, o.qty, o.limit_price, o.referencia ?? null,
     o.estado, o.alpaca_order_id ?? null, o.motivo ?? null, o.origen ?? 'estrategia', o.sombra !== false],
  );
  return { insertada: r.length > 0 };
}

export async function registrarFill({ client_order_id, fill_price, fill_ts, estado = 'filled' }) {
  await sql(`update libro_ordenes set fill_price = $2, fill_ts = $3, estado = $4 where client_order_id = $1`,
    [client_order_id, fill_price, fill_ts instanceof Date ? fill_ts.toISOString() : fill_ts, estado]);
}

export async function registrarEquityDiario({ fecha, equity, cash, spy_close, posiciones = 0 }) {
  await ensureLibroSchema();
  await sql(
    `insert into libro_equity_diario (fecha, equity, cash, spy_close, posiciones, tomado_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (fecha) do update set equity = excluded.equity, cash = excluded.cash,
       spy_close = coalesce(excluded.spy_close, libro_equity_diario.spy_close),
       posiciones = excluded.posiciones, tomado_at = now()`,
    [fecha, equity, cash, spy_close ?? null, posiciones],
  );
}

// ─────────────────── KILL SWITCH ───────────────────
// cancelAll es inyectable para tests. Devuelve lo que Alpaca contestó por orden.
export async function kill({ cancelAll, motivo = 'kill switch manual', now = new Date() }) {
  await ensureLibroSchema();
  let canceladas = null, error = null;
  try { canceladas = await cancelAll(); } catch (e) { error = String(e && e.message || e); }
  await escribirEstado('LIBRO_HALT', '1');
  await escribirEstado('LIBRO_HALT_MOTIVO', `${now.toISOString()} · ${motivo}`);
  return { halt: true, canceladas, error };
}
export async function reanudar() {
  await escribirEstado('LIBRO_HALT', '0');
  return { halt: false };
}

// ─────────────────── MÉTRICAS (puras) ───────────────────
// Entrada: filas de libro_equity_diario ordenadas por fecha + spy_unidades.
// Salida: los tres números y lo que hace falta para pintarlos.
export function metricas({ equityDiario = [], spyUnidades = null, equityInicial = null }) {
  const filas = equityDiario.filter((f) => Number.isFinite(Number(f.equity)) && f.fecha).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  if (!filas.length) return { dias: 0, retorno_libro: null, retorno_spy: null, exceso: null, max_drawdown: null, dias_bajo_agua: null };
  const e0 = Number(equityInicial ?? filas[0].equity);
  const eN = Number(filas[filas.length - 1].equity);
  const retorno_libro = e0 > 0 ? eN / e0 - 1 : null;
  let retorno_spy = null;
  const conSpy = filas.filter((f) => Number.isFinite(Number(f.spy_close)) && Number(f.spy_close) > 0);
  if (conSpy.length && Number.isFinite(Number(spyUnidades)) && Number(spyUnidades) > 0 && e0 > 0) {
    retorno_spy = (Number(spyUnidades) * Number(conSpy[conSpy.length - 1].spy_close)) / e0 - 1;
  } else if (conSpy.length >= 2) {
    retorno_spy = Number(conSpy[conSpy.length - 1].spy_close) / Number(conSpy[0].spy_close) - 1;
  }
  let peak = -Infinity, maxDD = 0, bajoAgua = 0, maxBajoAgua = 0;
  for (const f of filas) {
    const e = Number(f.equity);
    if (e > peak) { peak = e; bajoAgua = 0; } else { bajoAgua++; maxBajoAgua = Math.max(maxBajoAgua, bajoAgua); }
    if (peak > 0) maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  return {
    dias: filas.length, desde: filas[0].fecha, hasta: filas[filas.length - 1].fecha,
    equity_inicial: e0, equity_final: eN,
    retorno_libro, retorno_spy,
    exceso: retorno_libro != null && retorno_spy != null ? retorno_libro - retorno_spy : null,
    max_drawdown: maxDD, dias_bajo_agua: maxBajoAgua,
  };
}

// ¿Fue suerte? — 1,000 libros al azar con el MISMO número de operaciones, los
// MISMOS símbolos elegibles, fechas de entrada al azar, MISMA duración de
// tenencia por operación y MISMOS costos. Devuelve el percentil del retorno
// real dentro de esa nube. 40–60 = "indistinguible de suerte". Determinista
// (RNG con semilla) para que dos lecturas del mismo reporte digan lo mismo.
//   ops:    [{ symbol, entrada: 'YYYY-MM-DD', salida: 'YYYY-MM-DD' }] (cerradas)
//   series: { SYM: { fechas:[], closes:[] } }   (calendario alineado)
export function percentilSuerte({ ops = [], series = {}, retornoReal, n = 1000, costoBp = 10, seed = 7 }) {
  const cerradas = ops.filter((o) => o.entrada && o.salida && series[String(o.symbol).toUpperCase()]);
  if (!cerradas.length || !Number.isFinite(retornoReal)) return { aplica: false, motivo: cerradas.length ? 'sin retorno real' : '0 operaciones cerradas' };
  const simbolos = Object.keys(series).filter((s) => series[s] && series[s].closes && series[s].closes.length > 2);
  if (!simbolos.length) return { aplica: false, motivo: 'sin series de precios' };
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const idx = (s, fecha) => { const i = series[s].fechas.indexOf(fecha); return i >= 0 ? i : null; };
  const tenencias = cerradas.map((o) => {
    const s = String(o.symbol).toUpperCase(); const a = idx(s, o.entrada), b = idx(s, o.salida);
    return a != null && b != null && b > a ? b - a : 1;
  });
  const costo = costoBp / 10000;
  const peso = 1 / cerradas.length; // cada operación pesa igual: retorno medio por operación
  const nube = [];
  for (let k = 0; k < n; k++) {
    let r = 0;
    for (let j = 0; j < cerradas.length; j++) {
      const s = simbolos[Math.floor(rnd() * simbolos.length)];
      const c = series[s].closes, h = tenencias[j];
      if (c.length <= h + 1) { continue; }
      const i = Math.floor(rnd() * (c.length - h - 1));
      r += peso * ((c[i + h] / c[i] - 1) - 2 * costo);
    }
    nube.push(r);
  }
  nube.sort((a, b) => a - b);
  const debajo = nube.filter((v) => v < retornoReal).length;
  const percentil = Math.round(100 * debajo / n);
  return {
    aplica: true, percentil, n, operaciones: cerradas.length,
    veredicto: percentil >= 40 && percentil <= 60 ? 'indistinguible de suerte' : percentil > 60 ? 'mejor que el azar' : 'peor que el azar',
    nube_p10: nube[Math.floor(n * 0.1)], nube_p50: nube[Math.floor(n * 0.5)], nube_p90: nube[Math.floor(n * 0.9)],
  };
}

// Retorno medio por operación cerrada (para alimentar percentilSuerte).
export function retornoMedioPorOperacion(ordenes = []) {
  const porSym = new Map();
  for (const o of ordenes.filter((o) => o.estado === 'filled' && Number.isFinite(Number(o.fill_price)))) {
    const k = `${o.estrategia_id}:${String(o.symbol).toUpperCase()}`;
    if (!porSym.has(k)) porSym.set(k, []);
    porSym.get(k).push(o);
  }
  const ops = [];
  for (const [k, lista] of porSym) {
    lista.sort((a, b) => new Date(a.fill_ts || a.enviada_at) - new Date(b.fill_ts || b.enviada_at));
    let abierta = null;
    for (const o of lista) {
      if (o.side === 'buy' && !abierta) abierta = o;
      else if (o.side === 'sell' && abierta) {
        ops.push({ symbol: k.split(':')[1], estrategia_id: k.split(':')[0],
          entrada: String(abierta.fill_ts || abierta.enviada_at).slice(0, 10), salida: String(o.fill_ts || o.enviada_at).slice(0, 10),
          retorno: Number(o.fill_price) / Number(abierta.fill_price) - 1 - 2 * 0.001 });
        abierta = null;
      }
    }
  }
  const media = ops.length ? ops.reduce((s, o) => s + o.retorno, 0) / ops.length : null;
  return { ops, media };
}

// ─────────────────── RENDER ───────────────────
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);

export function renderReporteMarkdown({ m, suerte, estrategias = [], ordenes = [], halt = false, live = false, cuenta = 'paper', sombra = true, now = new Date() }) {
  const L = [];
  L.push(`# El Libro — reporte ${now.toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`Cuenta: **${String(cuenta).toUpperCase()}** · envío: **${live ? 'ENCENDIDO' : 'SOMBRA'}**${halt ? ' · **HALT**' : ''} · dividendos de SPY no contados.`);
  L.push('');
  if (!m.dias) {
    L.push('**Sin días registrados todavía.** El reporte se llena con la primera fila de `libro_equity_diario` (cron `libro:equity`).');
  } else {
    const ops = ordenes.filter((o) => o.estado === 'filled').length;
    L.push(`## 1. ¿Le gané al piso?  **${pct(m.exceso)}**`);
    L.push(`Libro ${pct(m.retorno_libro)} vs SPY ${pct(m.retorno_spy)} (${m.desde} → ${m.hasta}, ${m.dias} días).` + (ops === 0 ? ' **0 operaciones · libro = cash.**' : ''));
    L.push('');
    L.push(`## 2. ¿Cuánto me asusté?  **${pct(-m.max_drawdown)}**`);
    L.push(`Peor caída desde un máximo; ${m.dias_bajo_agua} día(s) seguidos bajo el agua.`);
    L.push('');
    L.push(`## 3. ¿Fue suerte?  **${suerte && suerte.aplica ? `percentil ${suerte.percentil} → ${suerte.veredicto}` : 'no aplica'}**`);
    L.push(suerte && suerte.aplica
      ? `Contra ${suerte.n} libros al azar con ${suerte.operaciones} operaciones: p10 ${pct(suerte.nube_p10)} · p50 ${pct(suerte.nube_p50)} · p90 ${pct(suerte.nube_p90)}.`
      : `Motivo: ${(suerte && suerte.motivo) || 'sin operaciones cerradas'}. Con 0 operaciones no hay nada que distinguir de la suerte.`);
  }
  L.push('');
  L.push('## Estrategias');
  L.push('| id | estado | ops | acierto | retorno neto | días activa | salida |');
  L.push('|---|---|---|---|---|---|---|');
  for (const e of estrategias) {
    const { ops } = retornoMedioPorOperacion(ordenes.filter((o) => o.estrategia_id === e.id));
    const acierto = ops.length ? ops.filter((o) => o.retorno > 0).length / ops.length : null;
    const neto = ops.length ? ops.reduce((s, o) => s + o.retorno, 0) : null;
    const dias = e.fecha_inicio && e.estado === 'activa' ? Math.max(0, Math.round((now - new Date(e.fecha_inicio)) / 86400000)) : (e.estado === 'activa' ? '?' : '—');
    L.push(`| ${e.id} | ${e.estado} | ${ops.length} | ${acierto == null ? '—' : (acierto * 100).toFixed(0) + '%'} | ${pct(neto)} | ${dias} | ${e.criterio_de_salida || '—'} |`);
  }
  if (sombra && ordenes.some((o) => o.sombra)) {
    L.push('');
    L.push(`_${ordenes.filter((o) => o.sombra).length} orden(es) en sombra: calculadas y journaleadas, no enviadas._`);
  }
  return L.join('\n');
}

// ─────────────────── ADAPTADORES (Fase 1, vacío a propósito) ───────────────────
// Interfaz que una estrategia debe cumplir para enchufarse al cron del Libro:
//   decidir({ estrategia, closes:{SYM:{fechas,closes}}, positions, equity, cash, today })
//     → [{ estrategia_id, symbol, side:'buy'|'sell', qty, limit_price, motivo }]
// El cron NO ejecuta lo que el adaptador devuelve: lo pasa por salidasDeRiesgo
// primero y por validarOrdenes después. Fase 1 agrega `tsla_bollinger` aquí
// leyendo la regla de api/_lib/sim.js (ver docs/libro.md §Fase 1).
export const ADAPTADORES = Object.freeze({});
