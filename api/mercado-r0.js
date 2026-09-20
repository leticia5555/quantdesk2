// ═══════════════════════════════════════════════════════════════════
// /api/mercado-r0 — R0: cimientos del mapa. Construye y verifica.
//
//   GET ?job=universo   → puebla mercado_universo_us (R0a). ESCRIBE.
//   GET ?job=unidades   → verifica los divisores MX contra la referencia (R0b+c).
//   GET ?job=refcap     → ¿de dónde sale la cap de referencia? (R0c). SOLO LEE.
//   GET ?job=gfnorte    → ¿entra GFNORTE, y con qué etiqueta? (R0d). SOLO LEE.
//
// A diferencia de /api/mercado-censo, este endpoint SÍ escribe — es el que
// construye la tabla que G1 necesita. `?dry=1` lo deja en solo-lectura para
// ver qué haría sin hacerlo.
//
// GATE: ARENA_ADMIN_KEY (el mismo helper que arena-smoke y mercado-censo).
// El cron diario entra con CRON_SECRET.
//
// ENV VARS: ARENA_ADMIN_KEY · CRON_SECRET · DATABASE_URL · FINNHUB_API_KEY ·
//           DATABURSATIL_TOKEN (R0c/R0d)
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import { sectorFromIndustry } from './_lib/arena-meta.js';
import { beat } from './_lib/heartbeat.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import {
  capConUnidades, verificaDivisor, estadoEmisora,
  buscarPistas, PISTAS_ACCIONES, PISTAS_CAP,
  filaUniversoUs, recorteMapa,
} from './_lib/mercado-r0.js';

export const maxDuration = 300;

const FINNHUB = 'https://finnhub.io/api/v1';
// Tier gratis: 60 req/min. 8 en vuelo con pausa entre tandas deja margen para
// que el cron del Arena corra en paralelo sin que ninguno de los dos coma 429.
const CONCURRENCIA = 8;
const PAUSA_TANDA_MS = 1100;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const SCHEMA = [
  `create table if not exists mercado_universo_us (
     symbol        text primary key,
     nombre        text,
     industria     text,
     sector_etf    text,
     market_cap    numeric,
     cap_fuente    text,
     actualizado   timestamptz not null default now()
   )`,
  `create index if not exists mercado_universo_us_cap_idx
     on mercado_universo_us (market_cap desc nulls last)`,
  `create index if not exists mercado_universo_us_sector_idx
     on mercado_universo_us (sector_etf)`,
];
let schemaListo = false;
async function ensureSchema() {
  if (schemaListo) return;
  await sqlBatch(SCHEMA.map((q) => [q, []]));
  schemaListo = true;
}

async function json(url, timeoutMs = 12000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, status: r.status, json: null };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, status: r.status, json: null };
    return { ok: true, status: r.status, json: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: String((e && e.message) || e) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// R0(a) — mercado_universo_us
// ═══════════════════════════════════════════════════════════════════

// Los símbolos a poblar: el universo del Arena (S&P 500 + Nasdaq 100 +
// movers). Se lee de arena_universe, que YA se reconstruye por cron a las
// 9:00 ET — R0 no duplica ese trabajo, lo consume.
async function simbolosDelUniverso() {
  const rows = await sql('select key, payload, source, built_at from arena_universe');
  const out = new Set();
  const formas = {};
  for (const row of rows) {
    const p = row && row.payload;
    if (!p) continue;
    const arr = Array.isArray(p.symbols) ? p.symbols
      : Array.isArray(p.admitidos) ? p.admitidos
        : Array.isArray(p) ? p : null;
    if (!arr) { formas[row.key] = 'forma no reconocida'; continue; }
    formas[row.key] = `${arr.length} símbolos · ${row.source || 's/fuente'} · ${row.built_at || 's/fecha'}`;
    for (const s of arr) {
      const sym = typeof s === 'string' ? s : (s && s.symbol);
      if (sym) out.add(String(sym).toUpperCase());
    }
  }
  return { simbolos: [...out].sort(), formas };
}

/**
 * Por símbolo: `profile2` da nombre + industria (→ sector), `metric` da la
 * capitalización. Dos requests por símbolo, y solo para los que HACEN FALTA.
 *
 * "Los que hacen falta" es la parte que decide si esto cabe en el tier gratis:
 * la industria de una empresa cambia cada varios años y la cap se mueve con el
 * precio. Así que `profile2` se pide solo para símbolos SIN industria
 * guardada, y `metric` solo para los que tienen la cap vencida. En régimen,
 * el cron diario pide ~0 profiles y N caps.
 */
async function refrescarSimbolos(simbolos, { finnhubKey, ahora, soloFaltantes = true, maxCap = 600 }) {
  await ensureSchema();
  const previas = new Map(
    (await sql('select symbol, nombre, industria, sector_etf, market_cap, cap_fuente, actualizado from mercado_universo_us'))
      .map((r) => [r.symbol, r]));

  // Caps ya medidas por el Arena: gratis, y con su propia política de TTL
  // (arena-mcap-cache). Pedirlas de nuevo a Finnhub sería pagar dos veces por
  // el mismo número.
  const capsArena = new Map(
    (await sql('select symbol, market_cap, fetched_at from arena_market_cap').catch(() => []))
      .map((r) => [String(r.symbol).toUpperCase(), r]));

  const necesitaPerfil = [];
  const necesitaCap = [];
  for (const sym of simbolos) {
    const p = previas.get(sym);
    if (!p || !p.industria) necesitaPerfil.push(sym);
    const capArena = capsArena.get(sym);
    const tieneCapFresca = (p && num(p.market_cap) != null
      && (ahora - new Date(p.actualizado)) < 36 * 3600e3);
    if (!tieneCapFresca && !(capArena && num(capArena.market_cap) != null)) necesitaCap.push(sym);
  }

  const perfiles = new Map(), caps = new Map();
  const errores = { profile2: 0, metric: 0 };

  const enTandas = async (lista, fn) => {
    for (let i = 0; i < lista.length; i += CONCURRENCIA) {
      await Promise.all(lista.slice(i, i + CONCURRENCIA).map(fn));
      if (i + CONCURRENCIA < lista.length) await dormir(PAUSA_TANDA_MS);
    }
  };

  if (finnhubKey) {
    await enTandas(soloFaltantes ? necesitaPerfil : simbolos, async (sym) => {
      const r = await json(`${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`);
      if (!r.ok || !r.json) { errores.profile2++; return; }
      perfiles.set(sym, { nombre: r.json.name || null, industria: r.json.finnhubIndustry || null });
    });
    await enTandas((soloFaltantes ? necesitaCap : simbolos).slice(0, maxCap), async (sym) => {
      const r = await json(`${FINNHUB}/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${finnhubKey}`);
      const m = r.ok && r.json && r.json.metric;
      const cap = m ? num(m.marketCapitalization) : null;
      // Finnhub da la cap en MILLONES. Guardarla sin convertir habría hecho
      // que Apple midiera lo mismo que una small cap con la cap en unidades.
      if (cap != null && cap > 0) caps.set(sym, cap * 1e6);
      else errores.metric++;
    });
  }

  const filas = simbolos.map((sym) => {
    const prev = previas.get(sym) || {};
    const perfil = perfiles.get(sym);
    const industria = (perfil && perfil.industria) || prev.industria || null;
    const nombre = (perfil && perfil.nombre) || prev.nombre || null;
    const { etf } = sectorFromIndustry(industria);

    let cap = caps.get(sym) ?? null, fuente = cap != null ? 'finnhub:metric' : null;
    if (cap == null) {
      const ca = capsArena.get(sym);
      if (ca && num(ca.market_cap) != null) { cap = num(ca.market_cap); fuente = 'neon:arena_market_cap'; }
    }
    if (cap == null && num(prev.market_cap) != null) { cap = num(prev.market_cap); fuente = prev.cap_fuente || 'previa'; }

    return filaUniversoUs({
      symbol: sym, nombre, industria, sector_etf: etf,
      market_cap: cap, cap_fuente: fuente, ahora,
    });
  });

  // Los que ninguna regla de sector tocó. Se CUENTAN — una falla de cobertura
  // tiene que verse como falla de cobertura, no disolverse en un bucket.
  const sinMapear = filas
    .filter((f) => f.industria && !f.sector_etf)
    .map((f) => ({ symbol: f.symbol, industria: f.industria }));

  return { filas, sinMapear, errores, pedidos: { profile2: necesitaPerfil.length, metric: necesitaCap.length } };
}

async function guardarUniverso(filas) {
  if (!filas.length) return 0;
  const lote = 200;
  let escritas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const trozo = filas.slice(i, i + lote);
    await sql(
      `insert into mercado_universo_us (symbol, nombre, industria, sector_etf, market_cap, cap_fuente, actualizado)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::timestamptz[])
       on conflict (symbol) do update set
         nombre = coalesce(excluded.nombre, mercado_universo_us.nombre),
         industria = coalesce(excluded.industria, mercado_universo_us.industria),
         sector_etf = coalesce(excluded.sector_etf, mercado_universo_us.sector_etf),
         market_cap = coalesce(excluded.market_cap, mercado_universo_us.market_cap),
         cap_fuente = coalesce(excluded.cap_fuente, mercado_universo_us.cap_fuente),
         actualizado = excluded.actualizado`,
      [trozo.map((f) => f.symbol), trozo.map((f) => f.nombre), trozo.map((f) => f.industria),
       trozo.map((f) => f.sector_etf), trozo.map((f) => f.market_cap), trozo.map((f) => f.cap_fuente),
       trozo.map((f) => f.actualizado)]);
    escritas += trozo.length;
  }
  return escritas;
}

async function jobUniverso({ ahora, dry, finnhubKey }) {
  const { simbolos, formas } = await simbolosDelUniverso();
  if (!simbolos.length) {
    return {
      job: 'universo', error: 'arena_universe está vacía: el cron arena:universe no ha corrido',
      fuentes: formas, escritas: 0,
    };
  }
  const { filas, sinMapear, errores, pedidos } = await refrescarSimbolos(simbolos, { finnhubKey, ahora });
  const escritas = dry ? 0 : await guardarUniverso(filas);

  const completas = filas.filter((f) => f.completa);
  const porSector = {};
  for (const f of completas) porSector[f.sector_etf] = (porSector[f.sector_etf] || 0) + 1;
  const recorte = recorteMapa(completas, 300);

  return {
    job: 'universo', dry: !!dry,
    simbolos: simbolos.length, escritas,
    fuentes: formas,
    completas: completas.length,
    sin_sector: filas.filter((f) => !f.sector_etf).length,
    sin_cap: filas.filter((f) => f.market_cap == null).length,
    por_sector: porSector,
    sectores_con_piso: Object.entries(porSector).filter(([, n]) => n >= 5).map(([s]) => s).sort(),
    industrias_sin_mapear: sinMapear.slice(0, 25),
    industrias_sin_mapear_total: sinMapear.length,
    requests: pedidos, errores_fuente: errores,
    // Lo que G1 va a leer en la re-corrida, adelantado acá para no tener que
    // esperar al censo completo para saber si sirvió.
    g1_proyectado: {
      con_cap_y_sector: completas.length,
      sectores_con_piso: Object.keys(porSector).filter((s) => porSector[s] >= 5).length,
      verde: completas.length >= 120 && Object.values(porSector).filter((n) => n >= 5).length >= 9,
    },
    recorte_top300: { dentro: recorte.dentro.length, resto: recorte.resto },
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(c) — ¿DataBursatil tiene con qué armar la referencia de cap?
// ═══════════════════════════════════════════════════════════════════

/**
 * LA PREGUNTA QUE HAY QUE CONTESTAR ANTES DE CONSTRUIR SOBRE ESTO.
 *
 * El encargo pide la referencia de cap "vía DataBursatil". Pero el censo de
 * Fase 1b ya MIDIÓ que las acciones en circulación **no están en `ifrs-full`**
 * (docs/bmv-rotation.md §4.4, textual: "sin acciones no hay capitalización, y
 * por eso este backtest usa EPS/precio y no book-to-market ni un filtro de
 * tamaño"). Si eso sigue siendo cierto, DataBursatil no puede dar una cap.
 *
 * Lo bueno: la pregunta se contesta **sin gastar un solo crédito**. El
 * cosechador guarda el JSON crudo completo en `bmv_financieros.raw`, así que
 * la búsqueda corre sobre lo ya guardado.
 */
async function jobRefcap({ limite = 40 }) {
  const filas = await sql(
    `select emisora, anio, trimestre, raw
       from bmv_financieros
      order by anio desc, trimestre desc
      limit $1`, [limite]).catch((e) => ({ error: String((e && e.message) || e) }));

  if (!Array.isArray(filas)) {
    return { job: 'refcap', error: filas && filas.error, veredicto: 'NO SE PUDO LEER bmv_financieros' };
  }
  if (!filas.length) {
    return { job: 'refcap', veredicto: 'SIN DATOS', motivo: 'bmv_financieros está vacía: la cosecha de Fase 1b no corrió en esta base' };
  }

  const porEmisora = [], llavesGlobales = new Map();
  for (const f of filas) {
    const acc = buscarPistas(f.raw, { pistas: PISTAS_ACCIONES });
    const cap = buscarPistas(f.raw, { pistas: PISTAS_CAP });
    for (const h of [...acc.hallazgos, ...cap.hallazgos]) {
      const k = h.llave;
      if (!llavesGlobales.has(k)) llavesGlobales.set(k, { llave: k, veces: 0, con_valor: 0, ejemplo_ruta: h.ruta, ejemplo_valor: h.valor });
      const g = llavesGlobales.get(k);
      g.veces++;
      if (h.valor != null) g.con_valor++;
    }
    porEmisora.push({
      emisora: f.emisora, periodo: `${f.anio}T${f.trimestre}`,
      acciones: acc.llaves_distintas, acciones_con_valor: acc.con_valor,
      cap: cap.llaves_distintas, cap_con_valor: cap.con_valor,
    });
  }

  const llaves = [...llavesGlobales.values()].sort((a, b) => b.con_valor - a.con_valor);
  const hayAcciones = llaves.some((l) => l.con_valor > 0 && PISTAS_ACCIONES.includes(l.llave.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const hayCap = llaves.some((l) => l.con_valor > 0 && PISTAS_CAP.includes(l.llave.toLowerCase().replace(/[^a-z0-9]/g, '')));

  return {
    job: 'refcap',
    filas_revisadas: filas.length,
    llaves_encontradas: llaves,
    por_emisora: porEmisora.slice(0, 20),
    hay_acciones: hayAcciones, hay_cap: hayCap,
    veredicto: hayCap ? 'GO: DataBursatil trae capitalización'
      : hayAcciones ? 'GO PARCIAL: no trae cap, pero SÍ acciones — la referencia se calcula con el precio'
        : 'NO-GO: ni cap ni acciones en el crudo guardado',
    nota_censo_previo: 'docs/bmv-rotation.md §4.4 midió en Fase 1b que las acciones en circulación NO están en ifrs-full. Si este job lo confirma, la referencia de g2 necesita otra fuente y es una decisión del operador, no un default que yo elija.',
    costo: 'cero créditos de DataBursatil: corre sobre el crudo ya guardado en bmv_financieros',
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(b) — verificar los divisores contra la referencia
// ═══════════════════════════════════════════════════════════════════

async function jobUnidades({ ahora }) {
  const acciones = await sql(
    `select distinct on (clave) clave, anio, trimestre, acciones_circulacion
       from xbrl_reports order by clave, anio desc, trimestre desc`).catch(() => []);
  const precios = await sql(
    `select distinct on (emisora_serie) emisora, emisora_serie, fecha, cierre, importe
       from bmv_precios order by emisora_serie, fecha desc`).catch(() => []);

  const accPor = new Map(acciones.map((a) => [String(a.clave).toUpperCase(), a]));
  const preciosPor = new Map();
  for (const p of precios) {
    const k = String(p.emisora || '').toUpperCase();
    if (!preciosPor.has(k)) preciosPor.set(k, []);
    preciosPor.get(k).push(p);
  }

  // La referencia: lo que R0(c) haya establecido. Mientras no esté resuelto,
  // el job corre igual y reporta `sin_referencia` — que NO es un verde.
  const ref = await jobRefcap({ limite: 20 });
  const referenciaDisponible = ref.hay_cap === true;

  const salida = EMISORAS.emisoras.map((em) => {
    const clave = String(em.clave).toUpperCase();
    const a = accPor.get(clave);
    const series = preciosPor.get(clave) || [];
    const elegida = series.find((s) => s.emisora_serie === em.serie_liquida) || null;

    // ¿La serie declarada es de verdad la más líquida? Se CONTRASTA contra el
    // importe operado en vez de creerle al registro.
    const masOperada = series.slice().sort((x, y) => (num(y.importe) || 0) - (num(x.importe) || 0))[0] || null;
    const serieDiscrepa = masOperada && em.serie_liquida && masOperada.emisora_serie !== em.serie_liquida;

    const calc = capConUnidades({
      clave, acciones_circulacion: a ? a.acciones_circulacion : null,
      precio: elegida ? elegida.cierre : null,
      serie_liquida: em.serie_liquida, acciones_por_unidad: em.acciones_por_unidad,
    });
    const verif = verificaDivisor({
      capCalculada: calc.cap, capReferencia: null,   // se llena cuando R0(c) resuelva
      acciones_por_unidad: em.acciones_por_unidad,
    });
    const estado = estadoEmisora(verif, { cap: calc.cap, fuente_cap: 'calc' });

    return {
      clave, nombre: em.nombre, sector: em.sector,
      serie_liquida: em.serie_liquida,
      acciones_por_unidad: em.acciones_por_unidad,
      unidad_fuente: em.unidad_fuente, unidad_verificado: em.unidad_verificado,
      periodo_xbrl: a ? `${a.anio}T${a.trimestre}` : null,
      cap_calculada: calc.cap, motivo_calculo: calc.motivo,
      series_vistas: series.length,
      serie_mas_operada: masOperada ? masOperada.emisora_serie : null,
      serie_discrepa: !!serieDiscrepa,
      verificacion: verif, estado: estado.estado, etiqueta: estado.etiqueta,
    };
  });

  const conCap = salida.filter((s) => s.cap_calculada != null);
  const discrepan = salida.filter((s) => s.serie_discrepa);
  return {
    job: 'unidades', generado_en: ahora.toISOString(),
    emisoras: salida.length,
    con_cap_calculada: conCap.length,
    sin_cap: salida.length - conCap.length,
    series_que_discrepan: discrepan.map((d) => ({ clave: d.clave, declarada: d.serie_liquida, mas_operada: d.serie_mas_operada })),
    referencia: {
      disponible: referenciaDisponible,
      veredicto_refcap: ref.veredicto,
      bloqueante: !referenciaDisponible,
      nota: referenciaDisponible ? null
        : 'SIN REFERENCIA NO HAY VERIFICACIÓN: las caps calculadas de arriba no están validadas y TODAS las emisoras salen gris punteadas. Resolver R0(c) primero.',
    },
    detalle: salida,
    g2_proyectado: { verificadas: 0, verde: false, motivo: 'la referencia de cap no está resuelta (R0c)' },
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(d) — GFNORTE
// ═══════════════════════════════════════════════════════════════════

async function jobGfnorte() {
  // Precio: puede estar, porque bmv_precios guarda TODAS las series del censo
  // y el filtro `tipo_valor_id = '1'` se aplica al consultar el universo, no
  // al cosechar.
  const precios = await sql(
    `select emisora, emisora_serie, fecha, cierre from bmv_precios
      where emisora ilike 'GFNORTE%' order by fecha desc limit 5`).catch(() => []);
  // Acciones: casi seguro NO. El censo de Fase 1b midió que
  // `pendientesFinancieros` descarta a bancos y casas de bolsa — el mismo
  // `continue` que dejó a Quálitas con 0 trimestres (docs/bmv-rotation.md §3).
  const fin = await sql(
    `select emisora, anio, trimestre from bmv_financieros
      where emisora ilike 'GFNORTE%' limit 5`).catch(() => []);
  const xbrl = await sql(
    `select clave, anio, trimestre, acciones_circulacion from xbrl_reports
      where clave ilike 'GFNORTE%' limit 5`).catch(() => []);

  const tienePrecio = Array.isArray(precios) && precios.length > 0;
  const tieneFin = Array.isArray(fin) && fin.length > 0;
  const tieneXbrl = Array.isArray(xbrl) && xbrl.length > 0;

  return {
    job: 'gfnorte',
    precio: { hay: tienePrecio, filas: precios.slice(0, 5) },
    financieros_databursatil: { hay: tieneFin, filas: fin.slice(0, 5) },
    xbrl: { hay: tieneXbrl, filas: xbrl.slice(0, 5) },
    // La decisión que el encargo ya dejó escrita: si DataBursatil da cap,
    // entra con etiqueta; si no, gris punteado (B). Acá solo se reporta cuál
    // de las dos ramas toca.
    veredicto: (tieneFin || tieneXbrl) && tienePrecio
      ? 'ENTRA con etiqueta "cap: databursatil"'
      : 'GRIS PUNTEADO (opción B)',
    motivo: (tieneFin || tieneXbrl) && tienePrecio ? null
      : !tienePrecio ? 'sin serie de precios de GFNORTE en bmv_precios'
        : 'sin acciones en circulación: los bancos quedan fuera de ICS (xbrl-fase0 §2.1) y de /v2/financieros (bmv-rotation §3, el mismo `continue` que dejó a Quálitas en 0)',
    nota: 'GFNORTE no está en api/_lib/emisoras.json y este job NO lo agrega: agregarlo sin cap sería crear un cuadro que nunca se puede pintar.',
  };
}

// ═══════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  // El cron entra con CRON_SECRET; una persona, con ARENA_ADMIN_KEY.
  const cronSecret = process.env.CRON_SECRET;
  const auth = (req.headers.authorization || '') === `Bearer ${cronSecret}` && cronSecret
    ? { ok: true, via: 'cron' }
    : checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  res.setHeader('Cache-Control', 'no-store');
  const job = String(q.job || 'universo').toLowerCase();
  const dry = q.dry === '1' || q.dry === 'true';
  const ahora = new Date();
  const t0 = Date.now();

  try {
    let out;
    if (job === 'universo') out = await jobUniverso({ ahora, dry, finnhubKey: process.env.FINNHUB_API_KEY });
    else if (job === 'unidades') out = await jobUnidades({ ahora });
    else if (job === 'refcap') out = await jobRefcap({ limite: Number(q.limite) || 40 });
    else if (job === 'gfnorte') out = await jobGfnorte();
    else return res.status(400).json({ error: 'job debe ser universo | unidades | refcap | gfnorte' });

    // Solo el job que construye late: los de diagnóstico no son un cron y
    // marcarlos vivos haría que /api/cron-status mintiera.
    if (job === 'universo' && !dry) await beat('mercado:universo').catch(() => {});

    out.ms = Date.now() - t0;
    out.doc = 'docs/mercado-r0.md';
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ job, error: String((e && e.stack) || e), ms: Date.now() - t0 });
  }
}
