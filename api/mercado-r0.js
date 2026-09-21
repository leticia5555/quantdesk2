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
  filaUniversoUs,
  referenciaManual, parseManualParam,
  proximaRanura, intervaloDe, penalizarPor429, planCorrida,
} from './_lib/mercado-r0.js';
import REFERENCIAS_CAP from './_lib/mercado-cap-referencia.json' with { type: 'json' };

export const maxDuration = 300;

const FINNHUB = 'https://finnhub.io/api/v1';

// ── EL RITMO ────────────────────────────────────────────────────────
// Finnhub free: 60 req/min. Vamos a 55 para dejarle aire al Arena, que
// también le pega con sus propios crons.
//
// La versión anterior decía "8 en vuelo con 1.1 s entre tandas deja margen".
// Eran **436 req/min**, y la corrida del 2026-09-21 cobró la cuenta: 433 de
// 553 `profile2` y 448 de 508 `metric` fallaron con 429. No faltaban datos:
// sobraban requests. Una tanda concurrente con pausa NO es un limitador.
const POR_MINUTO = (() => {
  const n = Number(process.env.MERCADO_R0_POR_MINUTO);
  return Number.isFinite(n) && n > 0 && n <= 60 ? Math.floor(n) : 55;
})();

// Presupuesto de reloj. `maxDuration` es 300 s; se corta antes para que
// quepan el upsert y la respuesta — una corrida que muere por timeout pierde
// TODO lo que juntó, porque la escritura va al final.
const PRESUPUESTO_MS = (() => {
  const n = Number(process.env.MERCADO_R0_PRESUPUESTO_MS);
  return Number.isFinite(n) && n >= 10000 && n <= 285000 ? Math.floor(n) : 250000;
})();

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
  // `cap_actualizado` es CUÁNDO SE MIDIÓ LA CAP, y no es lo mismo que
  // `actualizado` (cuándo se tocó la fila).
  //
  // Mezclarlos era un bug de verdad y de los callados: el upsert ponía
  // `actualizado = now()` en las 553 filas de cada corrida, y el TTL de 36 h
  // leía ESE campo. O sea que en cuanto un símbolo conseguía su cap, la
  // corrida siguiente lo veía "fresco" para siempre y **la cap no se
  // refrescaba nunca más**. El mapa habría congelado el tamaño de sus cuadros
  // en la primera corrida que funcionara, sin avisar.
  //
  // Antes no se notaba porque, con los 429, ninguna cap llegaba a escribirse.
  `alter table mercado_universo_us add column if not exists cap_actualizado timestamptz`,
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
    // El 429 se distingue del resto A PROPÓSITO: "429" y "no hay datos" son
    // problemas opuestos y el reporte anterior los sumaba en un solo
    // `errores_fuente`, que fue justo lo que hizo falta desambiguar a mano.
    if (r.status === 429) return { ok: false, status: 429, rate: true, json: null };
    if (!r.ok) return { ok: false, status: r.status, json: null };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, status: r.status, json: null, noJson: true };
    return { ok: true, status: r.status, json: await r.json() };
  } catch (e) {
    const to = e && e.name === 'TimeoutError';
    return { ok: false, status: 0, json: null, red: true, error: to ? `timeout (${timeoutMs}ms)` : String((e && e.message) || e) };
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
async function refrescarSimbolos(simbolos, { finnhubKey, ahora, deadline }) {
  await ensureSchema();
  const previas = new Map(
    (await sql('select symbol, nombre, industria, sector_etf, market_cap, cap_fuente, actualizado, cap_actualizado from mercado_universo_us'))
      .map((r) => [r.symbol, r]));

  // Caps ya medidas por el Arena: gratis, y con su propia política de TTL
  // (arena-mcap-cache). Pedirlas de nuevo a Finnhub sería pagar dos veces por
  // el mismo número.
  const capsArena = new Map(
    (await sql('select symbol, market_cap, fetched_at from arena_market_cap').catch(() => []))
      .map((r) => [String(r.symbol).toUpperCase(), r]));

  // ── QUÉ FALTA, que es lo único que se pide ──────────────────────────
  // El TTL de la cap se mide contra `cap_actualizado` —cuándo se MIDIÓ— y no
  // contra `actualizado` —cuándo se tocó la fila—. Ver el comentario del
  // schema: confundirlos congelaba la cap para siempre.
  const necesitaPerfil = [];
  const necesitaCap = [];
  for (const sym of simbolos) {
    const p = previas.get(sym);
    if (!p || !p.industria) necesitaPerfil.push(sym);
    const capArena = capsArena.get(sym);
    const medida = p && p.cap_actualizado ? new Date(p.cap_actualizado) : null;
    const capFresca = p && num(p.market_cap) != null && medida
      && (ahora - medida) < 36 * 3600e3;
    if (!capFresca && !(capArena && num(capArena.market_cap) != null)) necesitaCap.push(sym);
  }

  // ── LA COLA, espaciada de verdad ────────────────────────────────────
  // Una sola cola para los DOS endpoints: el techo de Finnhub es por cuenta,
  // no por ruta. Dos colas de 55/min serían 110/min y el mismo 429 de antes
  // con otro disfraz.
  const intervalo = intervaloDe(POR_MINUTO);
  let ritmo = { proxima: 0 };
  const contadores = {
    profile2: { ok: 0, rate_429: 0, sin_datos: 0, red: 0 },
    metric: { ok: 0, rate_429: 0, sin_datos: 0, red: 0 },
  };
  let pausas429 = 0;
  let sinPresupuesto = false;

  // Pide una ranura y espera a que llegue. Devuelve false si ya no hay
  // presupuesto: el llamador corta la cola y lo que falte queda para la
  // próxima corrida, que es exactamente para lo que sirve ser reanudable.
  async function ranura() {
    const r = proximaRanura(ritmo, Date.now(), intervalo);
    ritmo = r.estado;
    if (Date.now() + r.espera > deadline) { sinPresupuesto = true; return false; }
    if (r.espera > 0) await dormir(r.espera);
    return true;
  }

  const perfiles = new Map(), caps = new Map();

  // ── profile2 ────────────────────────────────────────────────────────
  for (const sym of necesitaPerfil) {
    if (!(await ranura())) break;
    const r = await json(`${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`);
    if (r.rate) {
      contadores.profile2.rate_429++;
      // Un 429 con el limitador puesto significa que el techo real está más
      // abajo (casi siempre porque el Arena está pidiendo a la vez). Se corre
      // la ranura y el símbolo queda pendiente — no se reintenta en el acto.
      ritmo = penalizarPor429(ritmo, Date.now());
      pausas429++;
      continue;
    }
    if (r.red) { contadores.profile2.red++; continue; }
    if (!r.ok || !r.json) { contadores.profile2.sin_datos++; continue; }
    contadores.profile2.ok++;
    perfiles.set(sym, { nombre: r.json.name || null, industria: r.json.finnhubIndustry || null });
  }

  // ── metric ──────────────────────────────────────────────────────────
  for (const sym of necesitaCap) {
    if (sinPresupuesto || !(await ranura())) break;
    const r = await json(`${FINNHUB}/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${finnhubKey}`);
    if (r.rate) {
      contadores.metric.rate_429++;
      ritmo = penalizarPor429(ritmo, Date.now());
      pausas429++;
      continue;
    }
    if (r.red) { contadores.metric.red++; continue; }
    const m = r.ok && r.json && r.json.metric;
    const cap = m ? num(m.marketCapitalization) : null;
    // Finnhub da la cap en MILLONES. Guardarla sin convertir habría hecho
    // que Apple midiera lo mismo que una small cap con la cap en unidades.
    if (cap != null && cap > 0) { caps.set(sym, cap * 1e6); contadores.metric.ok++; }
    else contadores.metric.sin_datos++;
  }

  // ── Las filas ───────────────────────────────────────────────────────
  // Solo viajan a Neon las que CAMBIAN. Escribir las 553 en cada corrida no
  // solo era gasto: era lo que pisaba `actualizado` y congelaba el TTL.
  const filas = [];
  for (const sym of simbolos) {
    const prev = previas.get(sym) || {};
    const perfil = perfiles.get(sym);
    const capFresca = caps.get(sym) ?? null;
    const capArena = capsArena.get(sym);

    let cap = capFresca, fuente = capFresca != null ? 'finnhub:metric' : null, capMedidaAhora = capFresca != null;
    if (cap == null && capArena && num(capArena.market_cap) != null) {
      cap = num(capArena.market_cap); fuente = 'neon:arena_market_cap';
      // La cap del Arena trae SU fecha de medición: se respeta en vez de
      // sellarla con la hora de esta corrida.
      capMedidaAhora = false;
    }
    const huboNovedad = !!perfil || capFresca != null
      || (cap != null && num(prev.market_cap) == null);
    if (!huboNovedad && previas.has(sym)) continue;   // nada que escribir

    const industria = (perfil && perfil.industria) || prev.industria || null;
    const nombre = (perfil && perfil.nombre) || prev.nombre || null;
    const { etf } = sectorFromIndustry(industria);
    if (cap == null && num(prev.market_cap) != null) { cap = num(prev.market_cap); fuente = prev.cap_fuente || 'previa'; }

    const fila = filaUniversoUs({
      symbol: sym, nombre, industria, sector_etf: etf,
      market_cap: cap, cap_fuente: fuente, ahora,
    });
    // Solo se sella la medición cuando la cap se midió DE VERDAD en esta
    // corrida; si vino del Arena, se hereda su fecha; si no, se conserva la
    // que hubiera.
    fila.cap_actualizado = capMedidaAhora ? ahora.toISOString()
      : (capArena && capArena.fetched_at && cap != null && fuente === 'neon:arena_market_cap'
        ? new Date(capArena.fetched_at).toISOString()
        : (prev.cap_actualizado ? new Date(prev.cap_actualizado).toISOString() : null));
    filas.push(fila);
  }

  return {
    filas, contadores, pausas429, sinPresupuesto,
    pendientes: { profile2: necesitaPerfil.length, metric: necesitaCap.length },
    procesados: {
      profile2: contadores.profile2.ok + contadores.profile2.rate_429 + contadores.profile2.sin_datos + contadores.profile2.red,
      metric: contadores.metric.ok + contadores.metric.rate_429 + contadores.metric.sin_datos + contadores.metric.red,
    },
  };
}

async function guardarUniverso(filas) {
  if (!filas.length) return 0;
  const lote = 200;
  let escritas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const trozo = filas.slice(i, i + lote);
    await sql(
      `insert into mercado_universo_us (symbol, nombre, industria, sector_etf, market_cap, cap_fuente, actualizado, cap_actualizado)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::timestamptz[], $8::timestamptz[])
       on conflict (symbol) do update set
         nombre = coalesce(excluded.nombre, mercado_universo_us.nombre),
         industria = coalesce(excluded.industria, mercado_universo_us.industria),
         sector_etf = coalesce(excluded.sector_etf, mercado_universo_us.sector_etf),
         market_cap = coalesce(excluded.market_cap, mercado_universo_us.market_cap),
         cap_fuente = coalesce(excluded.cap_fuente, mercado_universo_us.cap_fuente),
         actualizado = excluded.actualizado,
         -- NUNCA se retrocede la fecha de medición: si esta corrida no midió
         -- la cap, la de antes sigue siendo la buena.
         cap_actualizado = greatest(
           coalesce(excluded.cap_actualizado, mercado_universo_us.cap_actualizado),
           coalesce(mercado_universo_us.cap_actualizado, excluded.cap_actualizado))`,
      [trozo.map((f) => f.symbol), trozo.map((f) => f.nombre), trozo.map((f) => f.industria),
       trozo.map((f) => f.sector_etf), trozo.map((f) => f.market_cap), trozo.map((f) => f.cap_fuente),
       trozo.map((f) => f.actualizado), trozo.map((f) => f.cap_actualizado ?? null)]);
    escritas += trozo.length;
  }
  return escritas;
}

async function jobUniverso({ ahora, dry, finnhubKey, t0 }) {
  const { simbolos, formas } = await simbolosDelUniverso();
  if (!simbolos.length) {
    return {
      job: 'universo', error: 'arena_universe está vacía: el cron arena:universe no ha corrido',
      fuentes: formas, escritas: 0,
    };
  }
  if (!finnhubKey) {
    return { job: 'universo', error: 'FINNHUB_API_KEY no configurada', simbolos: simbolos.length, escritas: 0 };
  }

  const deadline = t0 + PRESUPUESTO_MS;
  const r = await refrescarSimbolos(simbolos, { finnhubKey, ahora, deadline });
  const escritas = dry ? 0 : await guardarUniverso(r.filas);

  // El estado DESPUÉS de escribir: es lo que decide si hace falta otra
  // corrida, y se lee de la tabla en vez de deducirse de los contadores.
  const despues = dry ? [] : await sql(
    `select count(*)::int total,
            count(*) filter (where sector_etf is not null)::int con_sector,
            count(*) filter (where market_cap is not null)::int con_cap,
            count(*) filter (where sector_etf is not null and market_cap is not null)::int completas
       from mercado_universo_us`).catch(() => []);
  const est = despues[0] || {};

  const porSector = dry ? {} : Object.fromEntries(
    (await sql(`select sector_etf, count(*)::int n from mercado_universo_us
                 where sector_etf is not null and market_cap is not null
                 group by 1 order by 2 desc`).catch(() => []))
      .map((x) => [x.sector_etf, x.n]));

  const pendientesRestantes = (r.pendientes.profile2 - r.procesados.profile2)
    + (r.pendientes.metric - r.procesados.metric);
  const plan = planCorrida({ pendientes: pendientesRestantes, presupuesto_ms: PRESUPUESTO_MS, por_minuto: POR_MINUTO });
  const total429 = r.contadores.profile2.rate_429 + r.contadores.metric.rate_429;

  const sectoresConPiso = Object.entries(porSector).filter(([, n]) => n >= 5).map(([x]) => x).sort();

  return {
    job: 'universo', dry: !!dry,
    simbolos: simbolos.length,
    fuentes: formas,

    // ── EL RITMO, que es lo que la corrida anterior no dejaba ver ──────
    ritmo: {
      por_minuto: POR_MINUTO,
      intervalo_ms: intervaloDe(POR_MINUTO),
      presupuesto_ms: PRESUPUESTO_MS,
      ms_usados: Date.now() - t0,
      cortada_por_presupuesto: r.sinPresupuesto,
    },
    // 429 SEPARADO de "sin datos": son problemas opuestos y el reporte
    // anterior los sumaba en un solo `errores_fuente`.
    finnhub: {
      profile2: r.contadores.profile2,
      metric: r.contadores.metric,
      total_429: total429,
      pausas_por_429: r.pausas429,
      lectura: total429 === 0
        ? 'sin 429: el limitador aguanta'
        : `${total429} respuestas 429 — el techo real está por debajo de ${POR_MINUTO}/min (¿otro cron pidiendo a la vez?). Bajá MERCADO_R0_POR_MINUTO`,
    },

    // ── EL AVANCE entre corridas ──────────────────────────────────────
    avance: {
      pendientes_al_empezar: r.pendientes,
      procesados_en_esta: r.procesados,
      pendientes_al_terminar: pendientesRestantes,
      escritas: escritas,
      completo: pendientesRestantes === 0,
      corridas_mas_estimadas: pendientesRestantes === 0 ? 0 : plan.corridas_estimadas,
      plan,
    },

    tabla: {
      filas: est.total ?? null,
      con_sector: est.con_sector ?? null,
      con_cap: est.con_cap ?? null,
      completas: est.completas ?? null,
    },
    por_sector: porSector,
    sectores_con_piso: sectoresConPiso,

    g1_proyectado: {
      con_cap_y_sector: est.completas ?? 0,
      sectores_con_piso: sectoresConPiso.length,
      verde: (est.completas ?? 0) >= 120 && sectoresConPiso.length >= 9,
      falta: pendientesRestantes === 0 ? null
        : `${pendientesRestantes} símbolos sin pedir — corré de nuevo (${plan.corridas_estimadas} corridas más)`,
    },
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

async function jobUnidades({ ahora, manual }) {
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

  // LA REFERENCIA. Dos caminos, en este orden:
  //   1. DataBursatil, si `?job=refcap` encontró con qué (R0c).
  //   2. El registro manual, fechado y con fuente (_lib/mercado-cap-referencia.json
  //      o `?manual=CLAVE:CAP`), que es el camino que la corrida del
  //      2026-09-20 dejó abierto al cerrar los dos automáticos.
  const ref = await jobRefcap({ limite: 20 });
  const referenciaDisponible = ref.hay_cap === true;
  const registroManual = manual && manual.referencias && manual.referencias.length
    ? { vigencia_dias: REFERENCIAS_CAP.vigencia_dias, referencias: manual.referencias }
    : REFERENCIAS_CAP;

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
    const refMan = referenciaManual(registroManual, clave, ahora);
    const verif = verificaDivisor({
      capCalculada: calc.cap, capReferencia: refMan.cap,
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
      referencia: refMan.cap != null
        ? { cap: refMan.cap, fuente: refMan.fuente, capturada_en: refMan.capturada_en, dias: refMan.dias }
        : { cap: null, motivo: refMan.motivo, vencida: refMan.vencida === true },
    };
  });

  const conCap = salida.filter((s) => s.cap_calculada != null);
  const discrepan = salida.filter((s) => s.serie_discrepa);
  const verificadas = salida.filter((s) => s.estado === 'verificada');
  const conRef = salida.filter((s) => s.referencia && s.referencia.cap != null);
  // El divisor implícito de las que NO cuadran: es el entregable de R0(b),
  // porque dice cuál ES el divisor en vez de solo decir que el declarado
  // está mal.
  const implicitos = salida
    .filter((s) => s.verificacion && s.verificacion.divisor_implicito != null
      && s.verificacion.divisor_implicito !== s.acciones_por_unidad)
    .map((s) => ({
      clave: s.clave, declarado: s.acciones_por_unidad,
      implicito: s.verificacion.divisor_implicito, exacto: s.verificacion.exacto,
      error_pct: s.verificacion.error_pct,
    }));
  const noSonDeUnidad = salida
    .filter((s) => s.verificacion && s.verificacion.estado === 'no_es_de_unidad')
    .map((s) => ({ clave: s.clave, motivo: s.verificacion.motivo }));
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
    divisores_implicitos: implicitos,
    no_son_de_unidad: noSonDeUnidad,
    detalle: salida,
    g2_proyectado: {
      con_referencia: conRef.length,
      verificadas: verificadas.length,
      verde: verificadas.length >= 5 && conRef.length >= 5,
      motivo: conRef.length ? null : 'ninguna emisora tiene capitalización de referencia: cargar _lib/mercado-cap-referencia.json o pasar ?manual=',
    },
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
  // `?manual=WALMEX:784e9,FEMSA:7e11&fuente=...&capturada_en=...` — la
  // referencia a mano, para verificar sin redeploy. `fuente` y `capturada_en`
  // valen para todas las de la corrida: si vinieron en la misma sesión,
  // vinieron del mismo lado y el mismo día.
  const manual = parseManualParam(q.manual, {
    fuente: q.fuente, capturada_en: q.capturada_en,
  });
  const ahora = new Date();
  const t0 = Date.now();

  try {
    let out;
    if (job === 'universo') out = await jobUniverso({ ahora, dry, finnhubKey: process.env.FINNHUB_API_KEY, t0 });
    else if (job === 'unidades') out = await jobUnidades({ ahora, manual });
    else if (job === 'refcap') out = await jobRefcap({ limite: Number(q.limite) || 40 });
    else if (job === 'gfnorte') out = await jobGfnorte();
    else return res.status(400).json({ error: 'job debe ser universo | unidades | refcap | gfnorte' });

    // Solo el job que construye late: los de diagnóstico no son un cron y
    // marcarlos vivos haría que /api/cron-status mintiera.
    //
    // El detalle lleva el AVANCE, no solo "corrió": con el backfill repartido
    // en varias corridas, un heartbeat verde que no dice cuánto falta deja al
    // operador mirando un ok que no informa nada.
    if (job === 'universo' && !dry) {
      const a = out.avance || {};
      const det = a.completo
        ? `completo · ${(out.tabla || {}).completas ?? '?'} filas con cap y sector`
        : `parcial · faltan ${a.pendientes_al_terminar} (${a.corridas_mas_estimadas} corridas más)`;
      await beat('mercado:universo', 'ok', det).catch(() => {});
    }

    if (manual.invalidas.length) out.manual_invalidas = manual.invalidas;
    if (manual.referencias.length) {
      out.manual_usado = { n: manual.referencias.length, fuente: q.fuente || null, capturada_en: q.capturada_en || null };
    }
    out.ms = Date.now() - t0;
    out.doc = 'docs/mercado-r0.md';
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ job, error: String((e && e.stack) || e), ms: Date.now() - t0 });
  }
}
