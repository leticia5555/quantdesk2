// ═══════════════════════════════════════════════════════════════════
// /api/earnings-beat — FASE 0 del experimento "earnings-beat": CENSO + SMOKE.
//
// Pregunta del experimento: ¿QuantDesk predice beat/miss de EPS mejor que
// Polymarket? Ver docs/earnings-beat-scope.md.
//
//   GET /api/earnings-beat?smoke=1            → censo completo (JSON)
//   GET /api/earnings-beat?smoke=1&format=md  → el mismo censo, en español
//   GET /api/earnings-beat                    → qué es esto + en qué fase va
//
// Parámetros del censo (todos opcionales):
//   ?meses=12      ventana hacia atrás (default 12; la Fase 0 pidió "desde
//                  septiembre del año pasado" y 12 meses la cubre SIN tatuar
//                  la fecha en el código — lint tests/no-hardcoded-dates)
//   ?desde=...     fecha exacta de corte, gana sobre ?meses
//   ?paginas=20    tope de páginas de Gamma (el censo reporta si truncó)
//   ?limite=500    tamaño de página
//   ?ejemplos=3    cuántos mercados traen precio del Yes a T-24h
//
// ── POR QUÉ ESTO CORRE EN VERCEL Y NO EN UNA LAPTOP ────────────────
// La Fase 0 no pregunta "¿existe la API?" sino "¿la vemos DESDE DONDE VA A
// VIVIR EL CRON?". Una IP de datacenter puede recibir otro trato que una
// residencial (misma lección que el G3 del Congreso). Este endpoint es el
// censo ejecutable desde el sitio exacto donde viviría la cosecha.
//
// ── SOLO LECTURA ───────────────────────────────────────────────────
// Cero writes a Neon: un solo SELECT sobre pead_earnings para el cruce. NO
// llama a ensurePeadSchema() (haría CREATE TABLE) ni a beat() — latir acá
// enmascararía un cron muerto, y además todavía no hay cron que lata.
//
// ── Gate ───────────────────────────────────────────────────────────
// CRON_SECRET por header (Authorization: Bearer ...) o por query (?secret=...,
// para abrir el markdown en el navegador). Mismo patrón que pead-analyze.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opc) · FINNHUB_API_KEY (opc, nombres
//           de empresa + sonda de revisiones) · ALPHAVANTAGE_API_KEY (opc,
//           sonda de revisiones)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { gamma, clob } from './_lib/polymarket.js';
import {
  CRITERIOS, normalizaMercado, pareceEarnings, resuelveSimbolo, construyeIndiceNombres,
  extraeConsensoEps, outcomeResuelto, tokenYes, precioEnT24h, cruzaConPead, evaluaFuentePIT,
  isoDia, ts, resumenMarkdown,
} from './_lib/earnings-beat.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { getSymbolMap } from './earnings.js';

// Paginar Gamma + bajar historiales del CLOB + sondas de revisiones no entra
// en los 60s de default. Misma medicina que pead-analyze/pead-harvest.
export const maxDuration = 300;

const PRESUPUESTO_MS = 240000;   // corte duro del censo: reporta truncado, no 504

// ─────────────────── estrategias de descubrimiento ───────────────────
// NO se asume cuál funciona. Se sondea cada una con UNA página, se reporta lo
// que contestó, y el barrido usa la primera que devolvió filas. Un endpoint
// que contesta 404 es un hecho del censo, no un crash.
const ESTRATEGIAS = [
  {
    nombre: 'markets_cerrados_por_fecha', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false', end_date_min: c.desde + 'T00:00:00Z' }),
  },
  {
    nombre: 'markets_cerrados', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false' }),
  },
  {
    nombre: 'events_cerrados', api: 'gamma', path: '/events',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false' }),
  },
  {
    nombre: 'markets_sin_filtros', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ limit: c.limite, offset }),
  },
];

// Gamma devuelve a veces un array pelado y a veces {data:[...]}. Y /events
// trae los mercados anidados. Esta función aplana las dos formas sin decidir
// de antemano cuál vino.
function filasDe(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && Array.isArray(body.markets)) return body.markets;
  return [];
}

function aplanaMercados(item) {
  if (item && Array.isArray(item.markets) && item.markets.length) {
    // Evento: cada mercado hereda la descripción del evento si no trae la suya
    // (el consenso a veces vive en el texto del evento, no del mercado).
    return item.markets.map((m) => ({ ...m, description: m.description || item.description, _evento: item.slug || item.title || null }));
  }
  return [item];
}

// ─────────────────── el censo ───────────────────

async function corre(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const headersVistos = {};
  const anota = (r) => { for (const [k, v] of Object.entries((r && r.headers) || {})) headersVistos[k] = v; return r; };

  // ── 1. Sondas: ¿qué contesta cada endpoint, y con qué esquema? ──
  const sondas = [];
  let elegida = null;
  for (const e of ESTRATEGIAS) {
    const r = anota(await gamma(e.path, e.params(ctx, 0)));
    const filas = r.status === 'ok' ? filasDe(r.body) : [];
    sondas.push({
      estrategia: e.nombre, endpoint: e.api + e.path, status: r.status, http: r.http ?? null,
      ms: r.ms, filas: filas.length,
      forma: r.status === 'ok' ? (Array.isArray(r.body) ? 'array' : 'objeto:' + Object.keys(r.body || {}).slice(0, 6).join(',')) : null,
      claves_primera_fila: filas.length ? Object.keys(filas[0]).slice(0, 40) : null,
      mensaje: r.message ? String(r.message).slice(0, 200) : null,
    });
    if (!elegida && filas.length) elegida = e;
    if (restante() < 60000) break;
  }
  // Sonda aparte: ¿existe búsqueda pública? Ahorraría paginar todo el catálogo
  // en la Fase 1 si existe. Se reporta exista o no.
  const busqueda = anota(await gamma('/public-search', { q: 'earnings' }));
  sondas.push({
    estrategia: 'busqueda_publica', endpoint: 'gamma/public-search', status: busqueda.status,
    http: busqueda.http ?? null, ms: busqueda.ms,
    forma: busqueda.status === 'ok' ? (Array.isArray(busqueda.body) ? 'array' : 'objeto:' + Object.keys(busqueda.body || {}).slice(0, 8).join(',')) : null,
    mensaje: busqueda.message ? String(busqueda.message).slice(0, 200) : null,
  });

  if (!elegida) {
    return {
      error: 'Ninguna estrategia de Gamma devolvió filas — fuente CAÍDA o esquema cambiado.',
      sondas, headers_de_rate_limit: headersVistos,
    };
  }

  // ── 2. Barrido paginado con la estrategia que sí contestó ──
  const crudos = [];
  const barrido = { estrategia: elegida.nombre, paginas: 0, filas: 0, truncado: false, motivo_corte: null, orden_desc_confirmado: true, http_429: 0 };
  let ultimoFin = null;
  for (let pagina = 0; pagina < ctx.paginas; pagina++) {
    if (restante() < 70000) { barrido.truncado = true; barrido.motivo_corte = 'presupuesto_de_tiempo'; break; }
    const r = anota(await gamma(elegida.path, elegida.params(ctx, pagina * ctx.limite)));
    if (r.status === 'ratelimit') { barrido.http_429++; barrido.truncado = true; barrido.motivo_corte = 'rate_limit_429'; break; }
    if (r.status !== 'ok') { barrido.truncado = true; barrido.motivo_corte = r.status + (r.http ? ':' + r.http : ''); break; }
    const filas = filasDe(r.body);
    barrido.paginas++;
    barrido.filas += filas.length;
    if (!filas.length) { barrido.motivo_corte = 'fin_del_catalogo'; break; }

    for (const item of filas) for (const m of aplanaMercados(item)) crudos.push(m);

    // Corte temprano SOLO si el orden descendente se sostuvo hasta acá: si el
    // servidor ignoró `order`, cortar por fecha se comería mercados buenos.
    const fines = filas.map((f) => isoDia(f.endDate || f.closedTime)).filter(Boolean);
    const ultimo = fines.length ? fines[fines.length - 1] : null;
    if (ultimo && ultimoFin && ultimo > ultimoFin) barrido.orden_desc_confirmado = false;
    if (ultimo) ultimoFin = ultimo;
    if (barrido.orden_desc_confirmado && ultimo && ultimo < ctx.desde) { barrido.motivo_corte = 'alcanzo_la_fecha_de_corte'; break; }
    if (pagina === ctx.paginas - 1) { barrido.truncado = true; barrido.motivo_corte = 'tope_de_paginas'; }
  }

  // ── 3. Clasificación: ¿cuáles son de earnings, de qué símbolo, resueltos? ──
  const universo = new Set(V0_UNIVERSE);
  let nombres = null;
  if (ctx.finnhubKey) {
    try { nombres = await getSymbolMap(ctx.finnhubKey); } catch (e) { nombres = null; }
  }
  const indice = construyeIndiceNombres({ nombres, universo });

  const claves = new Map();
  const mercados = [];
  const descartados = [];
  // Dedup por id: si la paginación se corre (mercados que cierran mientras
  // paginamos), el mismo mercado puede venir en dos páginas y contarse dos
  // veces. Un conteo inflado es peor que uno corto: decide un candado.
  const vistos = new Set();
  let duplicados = 0;
  for (const raw of crudos) {
    const idCrudo = raw && raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
    if (idCrudo) {
      if (vistos.has(idCrudo)) { duplicados++; continue; }
      vistos.add(idCrudo);
    }
    for (const k of Object.keys(raw || {})) claves.set(k, (claves.get(k) || 0) + 1);
    const m = normalizaMercado(raw);
    if (!m) continue;
    const fecha = isoDia(m.fin);
    const esEarnings = pareceEarnings(m);
    if (!esEarnings.si) {
      if (descartados.length < 8 && m.pregunta) descartados.push(m.pregunta.slice(0, 110));
      continue;
    }
    if (fecha && fecha < ctx.desde) continue;   // fuera de ventana: no se cuenta
    const simbolo = resuelveSimbolo(m, indice, universo);
    const consenso = extraeConsensoEps(m.descripcion || '') || extraeConsensoEps(m.pregunta || '');
    const outcome = outcomeResuelto(m);
    mercados.push({
      id: m.id, slug: m.slug, pregunta: m.pregunta,
      fecha_resolucion: fecha, fin_declarado: m.fin_declarado, fin_real: m.fin_real,
      cerrado: m.cerrado, uma: m.uma, volumen: m.volumen,
      senales: esEarnings.senales,
      symbol: simbolo.symbol, symbol_via: simbolo.via, symbol_ambiguo: !!simbolo.ambiguo,
      en_universo_v0: simbolo.symbol ? universo.has(simbolo.symbol) : false,
      consenso_pm: consenso ? consenso.valor : null,
      consenso_patron: consenso ? consenso.patron : null,
      consenso_fragmento: consenso ? consenso.fragmento : null,
      outcome: outcome ? outcome.outcome : null,
      outcome_es_yes: outcome ? outcome.es_yes : null,
      token_yes: tokenYes(m),
    });
  }

  const resueltos = mercados.filter((m) => m.outcome !== null);
  const conSimbolo = mercados.filter((m) => m.symbol);
  const enUniverso = mercados.filter((m) => m.en_universo_v0);

  // ── 4. Precio del Yes a T-24h: los ejemplos pedidos por la Fase 0 ──
  // Se priorizan los resueltos, en nuestro universo y con token: si esos
  // fallan, el estudio no existe, así que son los que hay que ver fallar.
  const candidatos = [...mercados]
    .filter((m) => m.token_yes && m.fecha_resolucion)
    .sort((a, b) => (Number(b.en_universo_v0) - Number(a.en_universo_v0))
      || (Number(b.outcome !== null) - Number(a.outcome !== null))
      || String(b.fecha_resolucion).localeCompare(String(a.fecha_resolucion)));

  const ejemplos = [];
  for (const m of candidatos) {
    if (ejemplos.length >= ctx.ejemplos || restante() < 25000) break;
    const finMs = ts(m.fin_real || m.fin_declarado);
    if (!finMs) continue;   // sin instante de resolución no hay T-24h que pedir
    const desdeTs = Math.floor((finMs - 72 * 3600 * 1000) / 1000);
    const hastaTs = Math.floor(finMs / 1000);
    let r = anota(await clob('/prices-history', { market: m.token_yes, startTs: desdeTs, endTs: hastaTs, fidelity: 60 }));
    let forma = 'startTs/endTs';
    if (r.status !== 'ok' || !(r.body && Array.isArray(r.body.history) && r.body.history.length)) {
      // Segunda forma documentada del endpoint. Si tampoco, se reporta el fallo.
      r = anota(await clob('/prices-history', { market: m.token_yes, interval: 'max', fidelity: 60 }));
      forma = 'interval=max';
    }
    const history = r.status === 'ok' && r.body ? (Array.isArray(r.body.history) ? r.body.history : filasDe(r.body)) : [];
    const precio = precioEnT24h(history, finMs);
    ejemplos.push({
      slug: m.slug, pregunta: m.pregunta, symbol: m.symbol, fecha_resolucion: m.fecha_resolucion,
      outcome: m.outcome, consenso_pm: m.consenso_pm,
      clob: { status: r.status, http: r.http ?? null, ms: r.ms, forma, puntos: history.length },
      yes_t24h: precio,
    });
  }

  // ── 5. Cruce con pead_earnings (SELECT, nada más) ──
  const cruce = { consultado: false, filas_pead: 0, error: null, cruzados: 0, en_universo_v0: 0, sin_cruce: {} };
  let mercadosCruzados = [];
  try {
    const filas = await sql(
      `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date
         from pead_earnings
        where reported_date >= ($1)::date - 7
          and reported_date <= current_date + 7
        order by reported_date asc`,
      [ctx.desde]
    );
    cruce.consultado = true;
    cruce.filas_pead = filas.length;
    mercadosCruzados = cruzaConPead(mercados, filas);
    cruce.cruzados = mercadosCruzados.filter((m) => m.cruce).length;
    cruce.en_universo_v0 = mercadosCruzados.filter((m) => m.cruce && m.en_universo_v0).length;
    for (const m of mercadosCruzados) {
      if (m.cruce) continue;
      const k = m.motivo_sin_cruce || 'desconocido';
      cruce.sin_cruce[k] = (cruce.sin_cruce[k] || 0) + 1;
    }
  } catch (e) {
    cruce.error = String((e && e.message) || e).slice(0, 200);
  }

  // ── 6. ¿Existe fuente PIT de revisiones de estimados, gratis? ──
  const revisiones = [];
  if (ctx.finnhubKey && restante() > 15000) {
    for (const path of ['/stock/eps-estimate', '/stock/revision']) {
      const url = `https://finnhub.io/api/v1${path}?symbol=AAPL&freq=quarterly&token=${ctx.finnhubKey}`;
      revisiones.push(await sondaPIT('finnhub' + path, url));
    }
  } else {
    revisiones.push({ fuente: 'finnhub', status: 'sin_key', pit: false, motivo: 'FINNHUB_API_KEY no está en el entorno' });
  }
  if (ctx.avKey && restante() > 10000) {
    revisiones.push(await sondaPIT('alphavantage/EARNINGS_ESTIMATES',
      `https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=AAPL&apikey=${ctx.avKey}`));
  } else {
    revisiones.push({ fuente: 'alphavantage', status: 'sin_key', pit: false, motivo: 'ALPHAVANTAGE_API_KEY no está en el entorno' });
  }

  return {
    ventana: { desde: ctx.desde, hasta: new Date().toISOString().slice(0, 10), meses: ctx.meses },
    sondas,
    barrido,
    esquema_observado: {
      claves_mas_frecuentes: [...claves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k} (${n})`),
      mercados_crudos: crudos.length,
    },
    conteos: {
      mercados_de_earnings_en_ventana: mercados.length,
      resueltos: resueltos.length,
      con_simbolo: conSimbolo.length,
      sin_simbolo: mercados.length - conSimbolo.length,
      en_universo_v0: enUniverso.length,
      con_consenso_en_descripcion: mercados.filter((m) => m.consenso_pm !== null).length,
      con_token_yes: mercados.filter((m) => m.token_yes).length,
      simbolo_ambiguo: mercados.filter((m) => m.symbol_ambiguo).length,
      // Sin fecha legible NO se descartan (se verían como "no existen"): se
      // cuentan acá y quedan fuera del cruce y de los ejemplos por su cuenta.
      sin_fecha_de_resolucion: mercados.filter((m) => !m.fecha_resolucion).length,
      duplicados_descartados: duplicados,
      universo_v0: universo.size,
      nombres_finnhub: nombres ? Object.keys(nombres).length : 0,
    },
    ejemplos,
    cruce,
    revisiones,
    rate_limit: {
      headers_observados: headersVistos,
      hubo_429: barrido.http_429 > 0,
      nota: 'Si no hay headers, Polymarket no publicó presupuesto en esta corrida: la cadencia de la Fase 1 se fija conservadora y se mide con 429s.',
    },
    muestras: {
      earnings: mercados.slice(0, 5).map((m) => ({ pregunta: m.pregunta, symbol: m.symbol, via: m.symbol_via, fecha: m.fecha_resolucion, outcome: m.outcome, consenso: m.consenso_pm })),
      sin_simbolo: mercados.filter((m) => !m.symbol).slice(0, 5).map((m) => m.pregunta),
      descartados_por_el_filtro: descartados,
    },
    ms_totales: Date.now() - t0,
  };
}

// Sonda de una fuente de revisiones. Pregunta única: ¿da un valor por FECHA DE
// CORTE, o solo "el estimado de hoy"? Lo segundo NO sirve y se dice así.
async function sondaPIT(fuente, url) {
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return { fuente, status: 'neterror', pit: false, motivo: String((e && e.message) || e).slice(0, 120) };
  }
  if (!r.ok) {
    return { fuente, status: r.status === 403 || r.status === 401 ? 'premium_o_sin_permiso' : 'httperror', http: r.status, pit: false, motivo: `HTTP ${r.status}` };
  }
  let body = null;
  try { body = await r.json(); } catch (e) { return { fuente, status: 'nonjson', http: r.status, pit: false, motivo: 'cuerpo no-JSON' }; }
  // Alpha Vantage rate-limitea con HTTP 200 + {Note|Information} (trampa
  // documentada en _lib/av-earnings.js): sin esto, un 200 vacío parecería GO.
  if (body && (body.Note || body.Information)) {
    return { fuente, status: 'premium_o_rate_limit', http: 200, pit: false, motivo: String(body.Note || body.Information).slice(0, 160) };
  }
  const ev = evaluaFuentePIT(body);
  return { fuente, status: 'ok', http: r.status, ...ev };
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

  if (String(q.smoke || '') !== '1') {
    return res.status(200).json({
      que: 'Experimento earnings-beat: ¿QuantDesk predice beat/miss de EPS mejor que Polymarket?',
      fase: 0,
      estado: 'censo + smoke. Cero código de modelo hasta que la Fase 0 pase.',
      uso: '/api/earnings-beat?smoke=1 (agregá &format=md para leerlo en español)',
      criterios_congelados: CRITERIOS,
      doc: 'docs/earnings-beat-scope.md',
    });
  }

  const meses = Math.max(1, Math.min(60, Number(q.meses) || 12));
  let desde = /^\d{4}-\d{2}-\d{2}$/.test(String(q.desde || '')) ? String(q.desde) : null;
  if (!desde) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - meses);
    desde = d.toISOString().slice(0, 10);
  }
  const ctx = {
    desde, meses,
    paginas: Math.max(1, Math.min(60, Number(q.paginas) || 20)),
    limite: Math.max(1, Math.min(500, Number(q.limite) || 500)),
    ejemplos: Math.max(1, Math.min(10, Number(q.ejemplos) || 3)),
    finnhubKey: process.env.FINNHUB_API_KEY || null,
    avKey: process.env.ALPHAVANTAGE_API_KEY || null,
  };

  try {
    const censo = await corre(ctx);
    const salida = {
      pregunta: '¿Se puede construir el dataset del experimento earnings-beat con la API pública de Polymarket?',
      fase: 0, solo_lectura: true,
      generado_en: new Date().toISOString(),
      criterios_congelados: CRITERIOS,
      ...censo,
    };
    if (String(q.format || '').toLowerCase() === 'md' || String(q.format || '').toLowerCase() === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(resumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'earnings-beat: ' + ((err && err.message) || 'unknown') });
  }
}

export { corre, ESTRATEGIAS, filasDe, aplanaMercados };
