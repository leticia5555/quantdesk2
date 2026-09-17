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
//   ?ejemplos=3    cuántos mercados traen precio del Yes a T-24h
//   ?barrido=1     además, corre el barrido por offset como CONTROL (apagado
//                  por defecto: Gamma topa el offset con 422 y el barrido ve
//                  ~500 de decenas de miles — ciego, no concluyente)
//   ?paginas=20 · ?limite=500   solo aplican al barrido de control
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
  isoDia, ts, resumenMarkdown, extraeTags, extraeCluster, FRASES_BUSQUEDA,
} from './_lib/earnings-beat.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { getSymbolMap } from './earnings.js';

// Paginar Gamma + bajar historiales del CLOB + sondas de revisiones no entra
// en los 60s de default. Misma medicina que pead-analyze/pead-harvest.
export const maxDuration = 300;

const PRESUPUESTO_MS = 240000;   // corte duro del censo: reporta truncado, no 504

// ─────────────────── sondas de esquema ───────────────────
// NO se asume qué contesta cada endpoint: se sondea con `limit` chico y se
// reporta status, HTTP y LAS CLAVES REALES de la primera fila. Son el censo
// del ESQUEMA, no el método para juntar mercados — eso lo hace el
// descubrimiento dirigido de más abajo. Un 404 es un hecho del censo, no un
// crash; y un 422 queda anotado en `topes_de_offset`.
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

// ─────────────────── descubrimiento dirigido ───────────────────
//
// POR QUÉ NO SE BARRE EL CATÁLOGO (cicatriz de la primera corrida):
// paginar `/markets` con offset creciente muere con **HTTP 422 en la página 6**
// — Gamma tiene un TOPE DE OFFSET, no es rate limit. El barrido llegó a ver
// ~500 mercados de decenas de miles, así que su "0 mercados de earnings" no
// era un hallazgo sobre Polymarket: era ceguera del método. Un censo que
// confunde "no vi" con "no hay" miente con números.
//
// Ahora el descubrimiento es DIRIGIDO, por tres caminos que se miden por
// separado para saber cuál vale la pena en la Fase 1:
//   A. búsqueda por las frases reales con que se redactan estos mercados;
//   B. tags/categorías sacados de los mercados que A encontró, paginando
//      DENTRO del filtro (ahí el offset sí alcanza);
//   C. el racimo (evento/serie) al que pertenece un mercado de earnings.
// El barrido queda como control opcional (&barrido=1), nunca como el método.

async function descubrePorBusqueda(ctx, gamma1, restante) {
  const intentos = [];
  const filas = [];
  for (const frase of FRASES_BUSQUEDA) {
    if (restante() < 40000) break;
    // Solo `q`: cualquier parámetro extra sería inventado por mí, y un
    // parámetro desconocido puede tirar 422 y matar el camino principal.
    // Si la búsqueda recorta de más, se va a ver en el conteo y se ajusta
    // con un dato en la mano, no con una suposición.
    const r = await gamma1('/public-search', { q: frase });
    const encontradas = r.status === 'ok' ? cosechaDeBusqueda(r.body) : [];
    intentos.push({ frase, status: r.status, http: r.http ?? null, ms: r.ms, filas: encontradas.length,
      forma: r.status === 'ok' ? formaDe(r.body) : null });
    filas.push(...encontradas);
  }
  return { camino: 'busqueda', intentos, filas };
}

// public-search devuelve varios tipos a la vez (eventos, tags, perfiles). Se
// toma lo que tenga mercados adentro, venga como venga.
function cosechaDeBusqueda(body) {
  const out = [];
  const candidatos = [];
  if (Array.isArray(body)) candidatos.push(...body);
  else if (body && typeof body === 'object') {
    for (const k of ['events', 'markets', 'data', 'results']) {
      if (Array.isArray(body[k])) candidatos.push(...body[k]);
    }
  }
  for (const item of candidatos) for (const m of aplanaMercados(item)) out.push(m);
  return out;
}

async function descubrePorTags(ctx, gamma1, restante, semillas) {
  const intentos = [];
  const filas = [];
  // Tags de los mercados de earnings que ya encontramos: los que importan son
  // los que esos mercados comparten, no los que a mí me parezcan.
  const cuenta = new Map();
  for (const raw of semillas) {
    for (const t of extraeTags(raw)) {
      const k = (t.id || '') + '|' + (t.slug || '');
      const prev = cuenta.get(k) || { ...t, n: 0 };
      prev.n++;
      cuenta.set(k, prev);
    }
  }
  const top = [...cuenta.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  if (!top.length) {
    return { camino: 'tags', intentos: [{ nota: 'ningún mercado semilla trajo tags — camino no disponible' }], filas, tags_vistos: [] };
  }

  for (const tag of top) {
    // Con id se filtra `/markets` (tag_id); sin id, el slug se le pregunta a
    // `/events`, que es quien los entiende. Pedirle un slug a /markets sería
    // inventar un parámetro, y un filtro ignorado devuelve catálogo suelto.
    const path = tag.id ? '/markets' : '/events';
    // Paginado DENTRO del filtro: acá el offset se queda corto y no topa.
    for (let pagina = 0; pagina < 4; pagina++) {
      if (restante() < 40000) break;
      const params = tag.id
        ? { tag_id: tag.id, closed: 'true', limit: 100, offset: pagina * 100 }
        : { tag_slug: tag.slug, closed: 'true', limit: 100, offset: pagina * 100 };
      const r = await gamma1(path, params);
      const encontradas = r.status === 'ok' ? filasDe(r.body).flatMap(aplanaMercados) : [];
      const deEarnings = encontradas.filter((raw) => pareceEarnings(normalizaMercado(raw)).si).length;
      intentos.push({ tag: tag.label || tag.slug || tag.id, endpoint: 'gamma' + path, pagina,
        status: r.status, http: r.http ?? null, filas: encontradas.length, de_earnings: deEarnings });
      filas.push(...encontradas);
      if (r.status !== 'ok' || encontradas.length === 0) break;
      // Filas sí, earnings no → el filtro se está ignorando y esto es catálogo
      // suelto. Seguir paginando sería gastar presupuesto en ruido.
      if (deEarnings === 0) {
        intentos.push({ tag: tag.label || tag.slug || tag.id, nota: 'trajo filas pero ninguna de earnings: el filtro parece ignorado — se corta' });
        break;
      }
    }
  }
  return { camino: 'tags', intentos, filas, tags_vistos: top.map((t) => ({ id: t.id, slug: t.slug, veces: t.n })) };
}

async function descubrePorCluster(ctx, gamma1, restante, semillas) {
  const intentos = [];
  const filas = [];
  const clusters = semillas.map(extraeCluster).filter((c) => c.evento_slug || c.evento_id || c.serie_id || c.serie_slug);
  if (!clusters.length) {
    return { camino: 'cluster', intentos: [{ nota: 'los mercados semilla no exponen evento ni serie — camino no disponible' }], filas };
  }
  const probados = new Set();
  for (const c of clusters.slice(0, 3)) {
    const tiros = [
      c.serie_id ? { que: 'serie_id', path: '/markets', params: { series_id: c.serie_id, closed: 'true', limit: 200 } } : null,
      c.serie_slug ? { que: 'serie_slug', path: '/events', params: { series_slug: c.serie_slug, closed: 'true', limit: 200 } } : null,
      c.evento_slug ? { que: 'evento_slug', path: '/events', params: { slug: c.evento_slug } } : null,
    ].filter(Boolean);
    for (const t of tiros) {
      const clave = t.que + ':' + JSON.stringify(t.params);
      if (probados.has(clave) || restante() < 35000) continue;
      probados.add(clave);
      const r = await gamma1(t.path, t.params);
      const encontradas = r.status === 'ok' ? filasDe(r.body).flatMap(aplanaMercados) : [];
      intentos.push({ via: t.que, endpoint: 'gamma' + t.path, status: r.status, http: r.http ?? null, filas: encontradas.length });
      filas.push(...encontradas);
    }
  }
  return { camino: 'cluster', intentos, filas };
}

function formaDe(body) {
  if (Array.isArray(body)) return 'array';
  if (body && typeof body === 'object') return 'objeto:' + Object.keys(body).slice(0, 8).join(',');
  return typeof body;
}

// ─────────────────── el censo ───────────────────

async function corre(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const headersVistos = {};
  const topes_de_offset = [];
  let http_429 = 0;
  // Envoltorio de gamma(): anota headers de rate limit y — sobre todo — deja
  // registrado cada 422 con su offset. El tope de offset es un HECHO del censo
  // y tiene que quedar escrito para que no vuelva a morder.
  const gamma1 = async (path, params, opts) => {
    const r = await gamma(path, params, opts);
    for (const [k, v] of Object.entries((r && r.headers) || {})) headersVistos[k] = v;
    if (r && r.status === 'ratelimit') http_429++;
    if (r && r.http === 422) {
      topes_de_offset.push({ endpoint: 'gamma' + path, offset: (params && params.offset) ?? null,
        limit: (params && params.limit) ?? null, mensaje: String(r.message || '').slice(0, 160) });
    }
    return r;
  };
  const clob1 = async (path, params, opts) => {
    const r = await clob(path, params, opts);
    for (const [k, v] of Object.entries((r && r.headers) || {})) headersVistos[k] = v;
    if (r && r.status === 'ratelimit') http_429++;
    return r;
  };

  // ── 1. Sondas: ¿qué contesta cada endpoint, y con qué esquema? ──
  // Con `limit` chico: son para el CENSO del esquema, no para juntar datos.
  const sondas = [];
  for (const e of ESTRATEGIAS) {
    if (restante() < 60000) break;
    const r = await gamma1(e.path, { ...e.params(ctx, 0), limit: 5 });
    const filas = r.status === 'ok' ? filasDe(r.body) : [];
    sondas.push({
      estrategia: e.nombre, endpoint: 'gamma' + e.path, status: r.status, http: r.http ?? null,
      ms: r.ms, filas: filas.length,
      forma: r.status === 'ok' ? formaDe(r.body) : null,
      claves_primera_fila: filas.length ? Object.keys(filas[0]).slice(0, 40) : null,
      mensaje: r.message ? String(r.message).slice(0, 200) : null,
    });
  }

  // ── 2. Descubrimiento dirigido (A → B/C, que se apoyan en lo que A halló) ──
  const universo = new Set(V0_UNIVERSE);
  const crudosPorId = new Map();
  const aportes = {};
  let sinId = 0;
  const suma = (camino, filas) => {
    let nuevos = 0;
    for (const raw of filas || []) {
      const id = raw && raw.id !== undefined && raw.id !== null ? String(raw.id)
        : raw && raw.slug ? 'slug:' + raw.slug : null;
      if (!id) { sinId++; continue; }
      if (crudosPorId.has(id)) continue;
      crudosPorId.set(id, { ...raw, _via: camino });
      nuevos++;
    }
    aportes[camino] = (aportes[camino] || 0) + nuevos;
    return nuevos;
  };

  const busqueda = await descubrePorBusqueda(ctx, gamma1, restante);
  suma('busqueda', busqueda.filas);

  // Semillas para B y C: los mercados de earnings que A sí encontró. Si A no
  // encontró ninguno, B y C se declaran no disponibles en vez de inventarse
  // un tag plausible.
  const semillas = [...crudosPorId.values()]
    .filter((raw) => pareceEarnings(normalizaMercado(raw)).si)
    .slice(0, 5);

  const porTags = await descubrePorTags(ctx, gamma1, restante, semillas);
  suma('tags', porTags.filas);
  const porCluster = await descubrePorCluster(ctx, gamma1, restante, semillas);
  suma('cluster', porCluster.filas);

  // ── 2b. Barrido: CONTROL opcional, nunca el método ──
  const barrido = { corrido: false, nota: 'apagado por defecto: el tope de offset lo vuelve ciego (&barrido=1 para correrlo igual)' };
  if (ctx.barrido) {
    delete barrido.nota;   // corrió: la nota de "apagado" dejaría de ser cierta
    Object.assign(barrido, { corrido: true, paginas: 0, filas: 0, truncado: false, motivo_corte: null });
    for (let pagina = 0; pagina < ctx.paginas; pagina++) {
      if (restante() < 70000) { barrido.truncado = true; barrido.motivo_corte = 'presupuesto_de_tiempo'; break; }
      const r = await gamma1('/markets', { closed: 'true', limit: ctx.limite, offset: pagina * ctx.limite, order: 'endDate', ascending: 'false' });
      if (r.status !== 'ok') {
        barrido.truncado = true;
        barrido.motivo_corte = (r.http === 422 ? 'tope_de_offset_422' : r.status) + ' en offset ' + (pagina * ctx.limite);
        break;
      }
      const filas = filasDe(r.body);
      barrido.paginas++;
      barrido.filas += filas.length;
      if (!filas.length) { barrido.motivo_corte = 'fin_del_catalogo'; break; }
      suma('barrido', filas.flatMap(aplanaMercados));
      if (pagina === ctx.paginas - 1) { barrido.truncado = true; barrido.motivo_corte = 'tope_de_paginas'; }
    }
  }

  // ── 3. Clasificación ──
  let nombres = null;
  if (ctx.finnhubKey) {
    try { nombres = await getSymbolMap(ctx.finnhubKey); } catch (e) { nombres = null; }
  }
  const indice = construyeIndiceNombres({ nombres, universo });

  const claves = new Map();
  const mercados = [];
  const descartados = [];
  for (const raw of crudosPorId.values()) {
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
      id: m.id, slug: m.slug, pregunta: m.pregunta, via: raw._via || null,
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

  // Qué camino encontró MÁS mercados de earnings (no crudos: earnings).
  const porCamino = {};
  for (const m of mercados) porCamino[m.via || 'desconocido'] = (porCamino[m.via || 'desconocido'] || 0) + 1;
  const ganadora = Object.entries(porCamino).sort((a, b) => b[1] - a[1])[0] || null;

  const resueltos = mercados.filter((m) => m.outcome !== null);
  const conSimbolo = mercados.filter((m) => m.symbol);

  // ── 4. Precio del Yes a T-24h ──
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
    let r = await clob1('/prices-history', { market: m.token_yes, startTs: desdeTs, endTs: hastaTs, fidelity: 60 });
    let forma = 'startTs/endTs';
    if (r.status !== 'ok' || !(r.body && Array.isArray(r.body.history) && r.body.history.length)) {
      r = await clob1('/prices-history', { market: m.token_yes, interval: 'max', fidelity: 60 });
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
    const cruzados = cruzaConPead(mercados, filas);
    cruce.cruzados = cruzados.filter((m) => m.cruce).length;
    cruce.en_universo_v0 = cruzados.filter((m) => m.cruce && m.en_universo_v0).length;
    for (const m of cruzados) {
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
      revisiones.push(await sondaPIT('finnhub' + path,
        `https://finnhub.io/api/v1${path}?symbol=AAPL&freq=quarterly&token=${ctx.finnhubKey}`));
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
    descubrimiento: {
      metodo: 'dirigido (búsqueda → tags → racimo). El barrido por offset quedó como control opcional.',
      busqueda: { intentos: busqueda.intentos },
      tags: { intentos: porTags.intentos, tags_vistos: porTags.tags_vistos || [] },
      cluster: { intentos: porCluster.intentos },
      aportes_crudos: aportes,
      mercados_de_earnings_por_camino: porCamino,
      estrategia_ganadora: ganadora ? { camino: ganadora[0], mercados_de_earnings: ganadora[1] } : null,
      sin_id_descartados: sinId,
    },
    topes_de_offset,
    barrido,
    esquema_observado: {
      claves_mas_frecuentes: [...claves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k} (${n})`),
      mercados_crudos: crudosPorId.size,
    },
    conteos: {
      mercados_de_earnings_en_ventana: mercados.length,
      resueltos: resueltos.length,
      con_simbolo: conSimbolo.length,
      sin_simbolo: mercados.length - conSimbolo.length,
      en_universo_v0: mercados.filter((m) => m.en_universo_v0).length,
      con_consenso_en_descripcion: mercados.filter((m) => m.consenso_pm !== null).length,
      con_token_yes: mercados.filter((m) => m.token_yes).length,
      simbolo_ambiguo: mercados.filter((m) => m.symbol_ambiguo).length,
      sin_fecha_de_resolucion: mercados.filter((m) => !m.fecha_resolucion).length,
      universo_v0: universo.size,
      nombres_finnhub: nombres ? Object.keys(nombres).length : 0,
    },
    ejemplos,
    cruce,
    revisiones,
    rate_limit: {
      headers_observados: headersVistos,
      http_429,
      nota: 'El 422 NO es rate limit: es tope de offset de Gamma, y va aparte en topes_de_offset.',
    },
    muestras: {
      earnings: mercados.slice(0, 5).map((m) => ({ pregunta: m.pregunta, symbol: m.symbol, via: m.symbol_via, camino: m.via, fecha: m.fecha_resolucion, outcome: m.outcome, consenso: m.consenso_pm })),
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
    barrido: String(q.barrido || '') === '1',
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

export { corre, ESTRATEGIAS, filasDe, aplanaMercados, cosechaDeBusqueda, formaDe };
