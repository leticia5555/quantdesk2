// ═══════════════════════════════════════════════════════════════════
// api/earnings-beat-harvest.js — cron de cosecha del dataset earnings-beat
// (FASE 1, tras el GO de la Fase 0 — docs/earnings-beat-scope.md §0.0).
//
//   GET /api/earnings-beat-harvest                  (job=mercados, default)
//   GET /api/earnings-beat-harvest?job=precios      completa T-24h pendientes
//   GET /api/earnings-beat-harvest?job=status       stats (sin escribir)
//
// GATES (en orden): CRON_SECRET → EARNINGS_BEAT_HARVEST_ENABLED=1.
// Heartbeat `earnings-beat:mercados` / `earnings-beat:precios`, para que
// /api/cron-status marque en rojo un cron muerto.
//
// ── QUÉ SE GUARDA, Y QUÉ NO ────────────────────────────────────────
//   · Solo lo que pasa el FILTRO v1 (beat/miss de EPS). El filtro corre ACÁ,
//     no en el análisis: lo que entra a la tabla ya está filtrado y el motivo
//     queda guardado. Si filtrara el consumidor, el día que uno se olvide los
//     mercados de mención volverían a contar como beat/miss.
//   · Los mercados ABIERTOS también se guardan (`abierto = true`). Resuelven
//     después y el cron del día siguiente los completa. Guardar solo resueltos
//     nace con sesgo de supervivencia y obliga a re-descubrir lo ya visto.
//   · `yes_price_ts` viaja SIEMPRE junto al precio: sin el timestamp, "precio
//     a 24h" no es auditable y el rancio no se puede detectar después.
//   · `raw` completo: el esquema de Gamma cambia, y re-parsear sale gratis
//     comparado con re-cosechar.
//
// ── LOS DOS CAMINOS ────────────────────────────────────────────────
// El censo midió `simbolo` 252 vs `busqueda` 67, así que símbolo es el camino
// ganador — pero se corren LOS DOS igual: 67 mercados que el ganador no ve
// siguen siendo 67, y el día que Polymarket cambie las plantillas el que
// sobreviva va a ser el otro. El aporte de cada uno se journalea por corrida.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opc) · EARNINGS_BEAT_HARVEST_ENABLED ·
//           FINNHUB_API_KEY (opc, nombres de empresa para resolver símbolos)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { gamma, clob } from './_lib/polymarket.js';
import { beat } from './_lib/heartbeat.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { getSymbolMap } from './earnings.js';
import {
  descubrePorBusqueda, descubrePorSimbolo, precioDeUnMercado, CONCURRENCIA_CLOB,
} from './_lib/earnings-beat-descubrir.js';
import {
  normalizaMercado, resuelveSimbolo, construyeIndiceNombres, extraeConsensoEps,
  outcomeResuelto, tokenYes, clasificaParaV1, cruzaConPead, isoDia,
} from './_lib/earnings-beat.js';
import {
  ensureSchema, upsertMercados, statsMercados, mercadosPendientes, preparaFila,
} from './_lib/earnings-beat-db.js';

export const maxDuration = 300;

const PRESUPUESTO_MS = 240000;
// v1 se queda con los 99 símbolos del universo del PEAD. NO se amplía: el
// censo dio 239 válidos (2.4× el candado), y ampliar antes de saber si el
// modelo sirve es trabajo sin respuesta. Si la Fase 2 sale INCONCLUSO por
// muestra, ahí se amplía con razón. Ver docs/earnings-beat-scope.md §0.1.
const SIMBOLOS_V1 = 99;

// ─────────────────── job: mercados ───────────────────

async function cosechaMercados(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const rate = { headers: {}, http_429: 0, topes_de_offset: 0 };
  const gamma1 = async (path, params, opts) => {
    const r = await gamma(path, params, opts);
    for (const [k, v] of Object.entries((r && r.headers) || {})) rate.headers[k] = v;
    if (r && r.status === 'ratelimit') rate.http_429++;
    if (r && r.http === 422) rate.topes_de_offset++;
    return r;
  };
  const clob1 = async (path, params, opts) => {
    const r = await clob(path, params, opts);
    if (r && r.status === 'ratelimit') rate.http_429++;
    return r;
  };

  const universo = new Set(V0_UNIVERSE);

  // ── 1. Descubrimiento: los DOS caminos ──
  const crudos = new Map();
  const aportes = {};
  const suma = (camino, filas) => {
    let nuevos = 0;
    for (const raw of filas || []) {
      const id = raw && raw.id !== undefined && raw.id !== null ? String(raw.id)
        : raw && raw.slug ? 'slug:' + raw.slug : null;
      if (!id || crudos.has(id)) continue;
      crudos.set(id, { ...raw, _via: camino, _etiqueta: raw._etiqueta || null });
      nuevos++;
    }
    aportes[camino] = (aportes[camino] || 0) + nuevos;
  };

  const ctxDesc = { simbolos: SIMBOLOS_V1, limite: 100 };
  const porSimbolo = await descubrePorSimbolo(ctxDesc, gamma1, restante, universo);
  suma('simbolo', porSimbolo.filas);
  const busqueda = await descubrePorBusqueda(ctxDesc, gamma1, restante);
  suma('busqueda', busqueda.filas);

  // ── 2. Filtro v1 ANTES de insertar ──
  let nombres = null;
  if (ctx.finnhubKey) {
    try { nombres = await getSymbolMap(ctx.finnhubKey); } catch (e) { nombres = null; }
  }
  const indice = construyeIndiceNombres({ nombres, universo });

  const motivos = {};
  const aceptados = [];
  for (const raw of crudos.values()) {
    const m = normalizaMercado(raw);
    if (!m) continue;
    const simbolo = resuelveSimbolo(m, indice, universo);
    const v1 = clasificaParaV1({ ...m, symbol: simbolo.symbol }, { etiqueta: raw._etiqueta || null, universo });
    motivos[v1.motivo] = (motivos[v1.motivo] || 0) + 1;
    if (!v1.acepta) continue;
    // v1 se queda con los 99: un mercado de una empresa que no cosechamos no
    // tiene historial con qué modelarse. Se cuenta aparte, no se guarda.
    if (!simbolo.symbol || !universo.has(simbolo.symbol)) {
      motivos.fuera_del_universo_v1 = (motivos.fuera_del_universo_v1 || 0) + 1;
      continue;
    }
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

  // ── 3. Cruce con pead_earnings (para report_date) ──
  // SELECT solamente. Si no cruza, el mercado SE GUARDA igual con report_date
  // null: el cruce se puede rehacer cuando la cosecha del PEAD se ponga al día
  // (§0.2), y descartarlo acá obligaría a re-descubrirlo después.
  let cruzados = aceptados;
  const cruce = { filas_pead: 0, con_report_date: 0, error: null };
  try {
    const filas = await sql(
      `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date
         from pead_earnings
        where reported_date >= current_date - interval '400 days'
        order by reported_date asc`
    );
    cruce.filas_pead = filas.length;
    cruzados = cruzaConPead(aceptados, filas);
    cruce.con_report_date = cruzados.filter((m) => m.cruce).length;
  } catch (e) {
    cruce.error = String((e && e.message) || e).slice(0, 200);
  }

  // ── 4. Precio del Yes a T-24h, en lotes ──
  const precios = { pedidos: 0, conteo: {} };
  const conPrecio = [];
  for (let i = 0; i < cruzados.length; i += CONCURRENCIA_CLOB) {
    if (restante() < 40000) break;
    const lote = cruzados.slice(i, i + CONCURRENCIA_CLOB);
    const res = await Promise.all(lote.map((m) => precioDeUnMercado(m, clob1)));
    for (let j = 0; j < lote.length; j++) {
      const r = res[j];
      precios.pedidos++;
      precios.conteo[r.clase] = (precios.conteo[r.clase] || 0) + 1;
      const t24 = (r.fila && r.fila.yes_t24h) || {};
      conPrecio.push({ m: lote[j], precio: { precio: t24.precio ?? null, ts: t24.ts || null, estado: r.clase } });
    }
  }
  // Los que no alcanzaron el presupuesto se guardan SIN precio: el job
  // `precios` los completa después. Guardar el mercado ya es progreso.
  for (let i = conPrecio.length; i < cruzados.length; i++) {
    conPrecio.push({ m: cruzados[i], precio: null });
  }

  // ── 5. Upsert ──
  const filas = conPrecio.map(({ m, precio }) => preparaFila(m, { raw: m._raw, precio }));
  const escritura = await upsertMercados(filas);

  return {
    job: 'mercados',
    descubrimiento: { aportes_crudos: aportes, crudos: crudos.size,
      simbolos_probados: porSimbolo.probados, de: porSimbolo.de,
      frases: (busqueda.intentos || []).length },
    filtro_v1: { motivos, aceptados: aceptados.length },
    cruce,
    precios,
    escritura,
    rate_limit: rate,
    stats: await statsMercados(),
    ms: Date.now() - t0,
  };
}

// ─────────────────── job: precios ───────────────────
// Completa lo que quedó sin precio bueno y re-mira los abiertos (que pueden
// haber resuelto). Es el que vuelve la tabla convergente sin re-descubrir.

async function completaPrecios(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const clob1 = (path, params, opts) => clob(path, params, opts);

  const pendientes = await mercadosPendientes(ctx.limite);
  if (!pendientes.length) return { job: 'precios', done: true, note: 'nada pendiente', stats: await statsMercados() };

  const conteo = {};
  const filas = [];
  for (let i = 0; i < pendientes.length; i += CONCURRENCIA_CLOB) {
    if (restante() < 30000) break;
    const lote = pendientes.slice(i, i + CONCURRENCIA_CLOB);
    const res = await Promise.all(lote.map((p) => precioDeUnMercado({
      id: p.market_id, slug: p.slug, pregunta: p.question, symbol: p.symbol,
      token_yes: p.yes_token_id, fecha_resolucion: p.resolved_date,
      fin_real: p.resolved_date ? p.resolved_date + 'T21:00:00Z' : null,
      fin_declarado: null,
    }, clob1)));
    for (let j = 0; j < lote.length; j++) {
      const r = res[j];
      conteo[r.clase] = (conteo[r.clase] || 0) + 1;
      const t24 = (r.fila && r.fila.yes_t24h) || {};
      // Upsert parcial: solo el precio. El resto de las columnas se mantienen
      // por los coalesce del ON CONFLICT.
      filas.push(preparaFila({
        id: lote[j].market_id, slug: lote[j].slug, pregunta: lote[j].question,
        symbol: lote[j].symbol, fecha_resolucion: lote[j].resolved_date,
        outcome: lote[j].abierto ? null : 'yes',   // no se toca: el coalesce lo protege
      }, { precio: { precio: t24.precio ?? null, ts: t24.ts || null, estado: r.clase } }));
    }
  }
  const escritura = await upsertMercados(filas);
  return { job: 'precios', pendientes: pendientes.length, procesados: filas.length, conteo, escritura,
    stats: await statsMercados(), ms: Date.now() - t0 };
}

// ─────────────────── handler ───────────────────

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

  const job = String(q.job || 'mercados').toLowerCase();

  if (process.env.EARNINGS_BEAT_HARVEST_ENABLED !== '1') {
    if (job === 'mercados' || job === 'precios') await beat('earnings-beat:' + job, 'disabled');
    return res.status(200).json({ disabled: true, hint: 'EARNINGS_BEAT_HARVEST_ENABLED != 1' });
  }

  const ctx = {
    finnhubKey: process.env.FINNHUB_API_KEY || null,
    limite: Math.max(1, Math.min(300, Number(q.limite) || 120)),
  };

  try {
    await ensureSchema();
    if (job === 'status') {
      return res.status(200).json({ job: 'status', stats: await statsMercados() });
    }
    if (job === 'precios') {
      const out = await completaPrecios(ctx);
      await beat('earnings-beat:precios', 'ok', { procesados: out.procesados ?? null });
      return res.status(200).json(out);
    }
    const out = await cosechaMercados(ctx);
    await beat('earnings-beat:mercados', 'ok', {
      aceptados: out.filtro_v1.aceptados, escritura: out.escritura, total: out.stats && out.stats.n,
    });
    return res.status(200).json(out);
  } catch (err) {
    await beat('earnings-beat:' + job, 'error', { msg: String((err && err.message) || err).slice(0, 200) });
    return res.status(500).json({ error: 'earnings-beat-harvest: ' + ((err && err.message) || 'unknown') });
  }
}

export { cosechaMercados, completaPrecios, SIMBOLOS_V1 };
