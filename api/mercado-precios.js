// ═══════════════════════════════════════════════════════════════════
// /api/mercado-precios — R1(a): la SERIE FECHADA de EE.UU.
//
//   GET ?job=us      → siembra/actualiza mercado_precios_us. ESCRIBE.
//   GET ?job=estado  → SOLO LEE: qué tan cubierta está la tabla.
//
// POR QUÉ ESTE ENDPOINT EXISTE, Y POR QUÉ VA PRIMERO EN R1.
//
// El toggle del mapa ofrece 1D/1S/1M/YTD, y **YTD no es un número de
// sesiones: es una fecha** — el último cierre del año pasado. Las dos
// fuentes que ya teníamos no alcanzan, y la Fase 0 lo midió: `/api/price`
// devuelve 30 cierres SIN FECHA y `/api/macro-markets` 70 puntos de 3 meses.
// Con una serie sin timestamps, YTD pintaría un número corto con una
// etiqueta larga: el bug del % de periodo otra vez.
//
// México ya tenía la suya (`bmv_precios`, con fecha). EE.UU. no tenía
// ninguna tabla de precios, así que la rebanada empieza construyéndola.
//
// GATE: ARENA_ADMIN_KEY, o CRON_SECRET para el cron diario.
// ENV: ARENA_ADMIN_KEY · CRON_SECRET · DATABASE_URL
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import { beat } from './_lib/heartbeat.js';
import { proximaRanura, intervaloDe } from './_lib/mercado-r0.js';
import {
  SCHEMA_PRECIOS_US, RANGO_SIEMBRA, MIN_PUNTOS_SERIE,
  aplanarChartYahoo, planPreciosUs, soloCierresDefinitivos, serieDesdeFilas, cubreYtd,
} from './_lib/mercado-precios.js';

export const maxDuration = 300;

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Cuántos nombres pinta el mapa. Mismo número que `recorteMapa` usa para el
// treemap: sembrar series que nadie va a mirar es pagar por nada.
const TOP_MAPA = 300;

// Yahoo no publica un techo, así que se elige uno CONSERVADOR y se declara:
// 100/min es una petición cada 600 ms. La siembra de 300 nombres toma ~3
// minutos de reloj y entra en varias corridas si hace falta.
const POR_MINUTO = (() => {
  const n = Number(process.env.MERCADO_PRECIOS_POR_MINUTO);
  return Number.isFinite(n) && n > 0 && n <= 300 ? Math.floor(n) : 100;
})();

// Presupuesto de reloj, por debajo de maxDuration: la escritura va al final
// de cada símbolo, pero el reporte va al final de todo.
const PRESUPUESTO_MS = (() => {
  const n = Number(process.env.MERCADO_PRECIOS_PRESUPUESTO_MS);
  return Number.isFinite(n) && n >= 10000 && n <= 285000 ? Math.floor(n) : 250000;
})();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let schemaListo = false;
async function ensureSchema() {
  if (schemaListo) return;
  await sqlBatch(SCHEMA_PRECIOS_US.map((q) => [q, []]));
  schemaListo = true;
}

async function chart(symbol, rango) {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=${rango}&interval=1d&events=div%2Csplit`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, status: r.status, json: null };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, status: r.status, json: null, noJson: true };
    return { ok: true, status: r.status, json: await r.json() };
  } catch (e) {
    const to = e && e.name === 'TimeoutError';
    return { ok: false, status: 0, json: null, red: true, error: to ? 'timeout (12000ms)' : String((e && e.message) || e) };
  }
}

async function guardar(symbol, filas, lote = 400) {
  let escritas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const t = filas.slice(i, i + lote);
    await sql(
      `insert into mercado_precios_us (symbol, fecha, cierre, cierre_ajustado)
       select * from unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[])
       on conflict (symbol, fecha) do update set
         cierre = excluded.cierre,
         cierre_ajustado = coalesce(excluded.cierre_ajustado, mercado_precios_us.cierre_ajustado)`,
      [t.map(() => symbol), t.map((f) => f.fecha), t.map((f) => f.cierre), t.map((f) => f.cierre_ajustado)]);
    escritas += t.length;
  }
  return escritas;
}

/** Los símbolos que el mapa va a pintar: top por cap, con sector y con cap. */
async function simbolosDelMapa(n = TOP_MAPA) {
  const filas = await sql(
    `select symbol from mercado_universo_us
      where sector_etf is not null and market_cap is not null
      order by market_cap desc limit $1`, [n]).catch(() => []);
  return filas.map((f) => String(f.symbol).toUpperCase());
}

/** Estado de la tabla: última fecha y cuántos puntos por símbolo. */
async function estadoTabla() {
  const filas = await sql(
    `select symbol, max(fecha)::text as hasta, min(fecha)::text as desde, count(*)::int as puntos
       from mercado_precios_us group by 1`).catch(() => []);
  const yaTengo = new Map(), cuenta = new Map(), desde = new Map();
  for (const f of filas) {
    yaTengo.set(f.symbol, f.hasta);
    cuenta.set(f.symbol, f.puntos);
    desde.set(f.symbol, f.desde);
  }
  return { yaTengo, cuenta, desde, filas };
}

async function jobUs({ ahora, dry, t0, tope }) {
  await ensureSchema();
  const simbolos = await simbolosDelMapa();
  if (!simbolos.length) {
    return {
      job: 'us', escritas: 0,
      error: 'mercado_universo_us no tiene filas con sector Y cap: corré /api/mercado-r0?job=universo primero',
    };
  }

  const { yaTengo, cuenta } = await estadoTabla();
  const hoy = ahora.toISOString().slice(0, 10);
  const plan = planPreciosUs({ simbolos, yaTengo, cuenta, hasta: hoy, min_puntos: MIN_PUNTOS_SERIE });

  // La siembra primero: un símbolo sin serie no puede pintar NADA, mientras
  // que uno con la cola corta atrasada pinta casi todo bien.
  const pendientes = [
    ...plan.siembra.map((x) => ({ ...x, rango: RANGO_SIEMBRA, tipo: 'siembra' })),
    ...plan.cola.map((x) => ({ ...x, rango: '1mo', tipo: 'cola' })),
  ];

  const deadline = t0 + PRESUPUESTO_MS;
  const intervalo = intervaloDe(POR_MINUTO);
  let ritmo = { proxima: 0 };
  const hecho = [];
  const contadores = { ok: 0, sin_datos: 0, http: 0, red: 0 };
  let escritas = 0, provisionalesTotal = 0, cortada = false;
  let i = 0;

  for (; i < pendientes.length && hecho.length < tope; i++) {
    const p = pendientes[i];
    const r = proximaRanura(ritmo, Date.now(), intervalo);
    ritmo = r.estado;
    if (Date.now() + r.espera > deadline) { cortada = true; break; }
    if (r.espera > 0) await dormir(r.espera);

    const res = await chart(p.symbol, p.rango);
    if (!res.ok) {
      contadores[res.red ? 'red' : 'http']++;
      hecho.push({ symbol: p.symbol, tipo: p.tipo, estado: 'error', status: res.status, error: res.error || `HTTP ${res.status}` });
      continue;
    }
    const plano = aplanarChartYahoo(res.json);
    if (!plano.filas.length) {
      contadores.sin_datos++;
      hecho.push({ symbol: p.symbol, tipo: p.tipo, estado: 'sin_datos', motivo: plano.motivo });
      continue;
    }
    // La barra del día en curso es el precio VIVO, no un cierre.
    const { filas, provisionales } = soloCierresDefinitivos(plano.filas, ahora);
    provisionalesTotal += provisionales;
    const n = dry ? 0 : await guardar(p.symbol, filas);
    escritas += n;
    contadores.ok++;
    hecho.push({
      symbol: p.symbol, tipo: p.tipo, estado: 'ok',
      filas: filas.length, escritas: n, descartadas: plano.descartadas,
      provisionales, sin_adjclose: plano.sin_adjclose || undefined,
    });
  }

  // El estado DESPUÉS, leído de la tabla: es lo que decide si hace falta otra
  // corrida, y no se deduce de los contadores.
  const despues = dry ? null : await estadoTabla();
  const cubiertos = despues
    ? simbolos.filter((s) => (despues.cuenta.get(s) ?? 0) >= MIN_PUNTOS_SERIE).length
    : null;
  const restantes = Math.max(0, pendientes.length - hecho.length);

  const salida = {
    job: 'us', dry: !!dry,
    simbolos_del_mapa: simbolos.length,
    plan: { siembra: plan.siembra.length, cola: plan.cola.length, al_dia: plan.al_dia },
    ritmo: { por_minuto: POR_MINUTO, intervalo_ms: intervalo, presupuesto_ms: PRESUPUESTO_MS, ms_usados: Date.now() - t0, cortada_por_presupuesto: cortada },
    procesados: hecho.length,
    restantes,
    completo: restantes === 0,
    escritas,
    contadores,
    // Barras del día en curso que NO se guardaron: es un dato, no un hueco.
    barras_provisionales_omitidas: provisionalesTotal,
    cobertura: despues ? {
      simbolos_en_tabla: despues.yaTengo.size,
      simbolos_con_serie_util: cubiertos,
      pct_del_mapa: simbolos.length ? Math.round((cubiertos / simbolos.length) * 1000) / 10 : null,
      min_puntos: MIN_PUNTOS_SERIE,
    } : null,
    detalle: hecho.filter((h) => h.estado !== 'ok').slice(0, 30),
    ultimos_ok: hecho.filter((h) => h.estado === 'ok').slice(-10),
  };

  if (!dry) {
    await beat('mercado:precios', contadores.ok ? 'ok' : 'error', {
      escritas, procesados: hecho.length, restantes,
      cobertura: salida.cobertura ? salida.cobertura.pct_del_mapa : null,
    });
  }
  return salida;
}

async function jobEstado({ ahora }) {
  await ensureSchema();
  const simbolos = await simbolosDelMapa();
  const { yaTengo, cuenta, desde } = await estadoTabla();

  // ¿Cuántos pueden anclar YTD? Es LA pregunta de esta rebanada: sin ancla no
  // hay toggle, y un toggle que pinta "—" en 300 cuadros no es un toggle.
  const conYtd = [];
  const sinYtd = [];
  for (const s of simbolos) {
    const d = desde.get(s);
    if (!d) { sinYtd.push({ symbol: s, motivo: 'sin serie en la tabla' }); continue; }
    const r = cubreYtd([
      { t: Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000), c: 1 },
      { t: Math.floor(Date.parse(`${yaTengo.get(s)}T00:00:00Z`) / 1000), c: 1 },
    ], ahora);
    if (r.cubre) conYtd.push(s); else sinYtd.push({ symbol: s, motivo: r.motivo });
  }

  return {
    job: 'estado', solo_lectura: true,
    simbolos_del_mapa: simbolos.length,
    simbolos_en_tabla: yaTengo.size,
    con_serie_util: simbolos.filter((s) => (cuenta.get(s) ?? 0) >= MIN_PUNTOS_SERIE).length,
    ancla_ytd: {
      con_ancla: conYtd.length,
      sin_ancla: sinYtd.length,
      // El motivo por nombre: "no se pudo" no es una sola cosa.
      ejemplos_sin_ancla: sinYtd.slice(0, 10),
    },
    min_puntos: MIN_PUNTOS_SERIE,
    nota: 'la serie se guarda con cierre Y cierre_ajustado: el % de un periodo largo con el cierre pelado ignora splits y dividendos',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = (req.query) || {};
  // El cron entra con CRON_SECRET; una persona, con ARENA_ADMIN_KEY. Mismo
  // patrón que /api/mercado-r0.
  const cronSecret = process.env.CRON_SECRET;
  const auth = (req.headers.authorization || '') === `Bearer ${cronSecret}` && cronSecret
    ? { ok: true, via: 'cron' }
    : checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  const job = String(q.job || '').toLowerCase();
  const ahora = new Date();
  const dry = String(q.dry || '') === '1';
  const tope = Math.max(1, Math.min(600, Number(q.max || 600)));

  try {
    let out;
    if (job === 'us') out = await jobUs({ ahora, dry, t0, tope });
    else if (job === 'estado') out = await jobEstado({ ahora });
    else {
      out = {
        endpoint: '/api/mercado-precios',
        que_es: 'R1(a): la serie diaria FECHADA de los nombres del mapa US. YTD se ancla por fecha, así que sin timestamps no hay toggle.',
        jobs: {
          us: 'protegido, ESCRIBE: siembra 1y lo que no tiene serie y actualiza la cola de lo que sí. Reanudable e idempotente. &max=N, &dry=1',
          estado: 'protegido, SOLO LEE: cobertura de la tabla y cuántos símbolos pueden anclar YTD',
        },
        mexico: 'MX no pasa por acá: su serie fechada ya vive en bmv_precios (cosechada por /api/bmv-harvest?job=precios)',
      };
    }
    out.ms = Date.now() - t0;
    out.doc = 'docs/mercado-r1.md';
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ job, error: String((e && e.stack) || e), ms: Date.now() - t0 });
  }
}
