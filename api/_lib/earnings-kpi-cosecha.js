// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-kpi-cosecha.js — el job de la cosecha de mercados de
// RANGOS de KPI. Lo llaman:
//   · /api/earnings-beat-harvest?job=kpi          (cron diario, escribe)
//   · /api/earnings-beat-harvest?job=kpi&dry=1    (en seco, NO escribe)
//   · scripts/pm-kpi-seco.mjs                     (en seco, desde Actions)
//
// No habla con la red por su cuenta: recibe `gamma`/`clob` (los de
// _lib/polymarket.js, o dobles en tests). Tampoco con la DB: recibe `db` (el
// módulo earnings-kpi-db.js) y si no viene, es corrida en seco.
//
// ── LOS CANDADOS, EN CÓDIGO ─────────────────────────────────────────
//   · Gamma 422 (paginación) → se PARA todo el descubrimiento, sin reintentar,
//     y no se escribe nada. Se reporta dónde fue.
//   · Cero datos de la frontera → `frontera.estado = 'falla_de_frontera'`.
//     Nunca se lee como "no hay mercados de KPI".
//   · Conteos por semilla, aunque den 0: una semilla muda se DICE.
// ═══════════════════════════════════════════════════════════════════

import {
  SEMILLAS_KPI, filasDeEvento, conteos, veredictoFrontera,
} from './earnings-kpi.js';
import { filasDe } from './earnings-beat-descubrir.js';

const PAGINAS_POR_SEMILLA = 5;
const LIMITE_POR_PAGINA = 50;
const CONCURRENCIA = 6;
// Ventana del backfill de CLOB: 7 días de historial horario antes del cierre
// (o antes de hoy, si el cierre es futuro). Cubre T-24h con holgura sin
// meter meses de puntos horarios por cajón.
const VENTANA_CLOB_DIAS = 7;

// ── 1. Descubrimiento: /public-search por semilla ─────────────────────────
// Devuelve los eventos crudos con su semilla. Corta en seco ante un 422.
async function descubreEventos(gamma, restante, { semillas = SEMILLAS_KPI } = {}) {
  const intentos = [];
  const porSemilla = {};
  const eventos = new Map();   // slug → { evento, semilla }
  let corte422 = null;

  for (const semilla of semillas) {
    porSemilla[semilla] = { eventos_crudos: 0, nuevos: 0, paginas: 0, status: null };
    if (corte422) { porSemilla[semilla].status = 'no_corrida_por_422'; continue; }
    const vistosSemilla = new Set();
    for (let pagina = 1; pagina <= PAGINAS_POR_SEMILLA; pagina++) {
      if (restante() < 60000) { porSemilla[semilla].status = 'corte_por_tiempo'; break; }
      const params = { q: semilla, limit_per_type: LIMITE_POR_PAGINA };
      if (pagina > 1) params.page = pagina;
      const r = await gamma('/public-search', params);
      intentos.push({ semilla, pagina, status: r.status, http: r.http ?? null, ms: r.ms ?? null });
      porSemilla[semilla].status = r.status;
      porSemilla[semilla].paginas = pagina;
      if (r.http === 422) {
        corte422 = { semilla, pagina, url: r.url || null, message: r.message || null };
        break;
      }
      if (r.status !== 'ok') break;
      const evs = eventosDeBusqueda(r.body);
      let nuevosPagina = 0;
      for (const ev of evs) {
        if (!ev.slug || vistosSemilla.has(ev.slug)) continue;
        vistosSemilla.add(ev.slug);
        nuevosPagina++;
        porSemilla[semilla].eventos_crudos++;
        if (!eventos.has(ev.slug)) {
          eventos.set(ev.slug, { evento: ev, semilla });
          porSemilla[semilla].nuevos++;
        }
      }
      // Sin ids nuevos o página incompleta → no hay más.
      if (!nuevosPagina || evs.length < LIMITE_POR_PAGINA) break;
    }
  }
  return { intentos, porSemilla, eventos, corte422 };
}

// public-search trae eventos en `events` (y otras cosas en otras claves). Solo
// los eventos: un evento KPI es un evento con varios mercados.
function eventosDeBusqueda(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.events)) return body.events.filter((e) => e && e.slug);
  if (Array.isArray(body)) return body.filter((e) => e && e.slug && Array.isArray(e.markets));
  return [];
}

// ── 2. Hidratación: /events?slug= trae el evento completo ─────────────────
// La búsqueda puede devolver el evento con los mercados recortados; el evento
// por slug trae todos los cajones con outcomePrices y clobTokenIds. Si la
// hidratación falla, se usa lo que trajo la búsqueda y se cuenta.
async function hidrataEventos(gamma, restante, entradas) {
  const conteo = { pedidos: 0, ok: 0, fallback_busqueda: 0, sin_datos: 0, http_422: 0 };
  const out = [];
  let corte422 = null;
  for (let i = 0; i < entradas.length; i += CONCURRENCIA) {
    if (restante() < 45000 || corte422) {
      for (const e of entradas.slice(i)) out.push({ ...e, hidratado: false });
      break;
    }
    const lote = entradas.slice(i, i + CONCURRENCIA);
    const res = await Promise.all(lote.map((e) => gamma('/events', { slug: e.slug })));
    for (let j = 0; j < lote.length; j++) {
      conteo.pedidos++;
      const r = res[j];
      if (r.http === 422) { conteo.http_422++; corte422 = corte422 || { slug: lote[j].slug, url: r.url || null }; }
      const ev = r.status === 'ok' ? filasDe(r.body).find((x) => x && x.slug === lote[j].slug) || filasDe(r.body)[0] : null;
      if (ev && Array.isArray(ev.markets) && ev.markets.length) {
        conteo.ok++;
        out.push({ ...lote[j], evento: ev, hidratado: true });
      } else if (lote[j].evento && Array.isArray(lote[j].evento.markets) && lote[j].evento.markets.length) {
        conteo.fallback_busqueda++;
        out.push({ ...lote[j], hidratado: false });
      } else {
        conteo.sin_datos++;
      }
    }
  }
  return { conteo, eventos: out, corte422 };
}

// ── 3. CLOB: historial del Yes por cajón ──────────────────────────────────
async function historialClob(clob, f, ahoraMs) {
  if (!f.yes_token_id) return { clase: 'sin_token', puntos: [] };
  const finMs = Date.parse(f.end_date || '');
  const hasta = Number.isFinite(finMs) ? Math.min(finMs, ahoraMs) : ahoraMs;
  const creado = Date.parse(f.created_at_pm || '');
  let desde = hasta - VENTANA_CLOB_DIAS * 86400000;
  if (Number.isFinite(creado) && creado > desde) desde = creado;
  const r = await clob('/prices-history', {
    market: f.yes_token_id, startTs: Math.floor(desde / 1000), endTs: Math.floor(hasta / 1000), fidelity: 60,
  });
  if (r.status !== 'ok') return { clase: 'error', http: r.http ?? null, puntos: [] };
  const hist = r.body && Array.isArray(r.body.history) ? r.body.history : [];
  const puntos = hist
    .map((x) => ({ t: Number(x && x.t), p: Number(x && x.p) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p >= 0 && x.p <= 1)
    .map((x) => ({ market_id: f.market_id, ts: new Date((x.t > 1e12 ? x.t : x.t * 1000)).toISOString(), price_yes: x.p, fuente: 'clob' }));
  return { clase: puntos.length ? 'con_historial' : 'sin_ticks', puntos };
}

async function backfillClob(clob, restante, filas, ahoraMs) {
  const conteo = {};
  const puntos = [];
  const hechos = [];
  for (let i = 0; i < filas.length; i += CONCURRENCIA) {
    if (restante() < 30000) { conteo.corte_por_tiempo = filas.length - i; break; }
    const lote = filas.slice(i, i + CONCURRENCIA);
    const res = await Promise.all(lote.map((f) => historialClob(clob, f, ahoraMs)));
    for (let j = 0; j < lote.length; j++) {
      conteo[res[j].clase] = (conteo[res[j].clase] || 0) + 1;
      puntos.push(...res[j].puntos);
      // Un error de CLOB NO marca el backfill como hecho: se reintenta mañana.
      if (res[j].clase !== 'error') hechos.push(lote[j].market_id);
    }
  }
  return { conteo, puntos, hechos };
}

// ── El job ────────────────────────────────────────────────────────────────
// opciones: { gamma, clob, db (null = en seco), ahora (Date), presupuestoMs,
//             clobEnSeco (bool: en seco, probar también el CLOB) }
async function cosechaKpi({ gamma, clob, db = null, ahora = new Date(), presupuestoMs = 240000, clobEnSeco = false } = {}) {
  const t0 = Date.now();
  const restante = () => presupuestoMs - (Date.now() - t0);
  const seco = !db;
  const ahoraIso = ahora.toISOString();
  const ahoraMs = ahora.getTime();

  // 1. Descubrimiento
  const desc = await descubreEventos(gamma, restante);
  const base = { job: 'kpi', seco, ahora: ahoraIso, por_semilla: desc.porSemilla };
  if (desc.corte422) {
    return { ...base, frontera: veredictoFrontera({ intentos: desc.intentos, eventosCrudos: desc.eventos.size, corte422: desc.corte422 }),
      corte_422: desc.corte422, escritura: null, ms: Date.now() - t0 };
  }

  // 2. Eventos a hidratar: los descubiertos + los abiertos que ya conocemos.
  const entradas = [...desc.eventos.entries()].map(([slug, v]) => ({ slug, evento: v.evento, semilla: v.semilla }));
  let conocidos = 0;
  if (db) {
    const ya = new Set(entradas.map((e) => e.slug));
    for (const slug of await db.eventosAbiertos()) {
      if (ya.has(slug)) continue;
      entradas.push({ slug, evento: null, semilla: null });
      conocidos++;
    }
  }
  const hid = await hidrataEventos(gamma, restante, entradas);
  if (hid.corte422) {
    return { ...base, frontera: { estado: 'falla_de_frontera', motivo: `Gamma devolvió 422 en /events?slug=${hid.corte422.slug} — se paró sin reintentar` },
      corte_422: hid.corte422, hidratacion: hid.conteo, escritura: null, ms: Date.now() - t0 };
  }

  // 3. Filtro + filas por cajón
  const motivos = {};
  const porSemillaAceptados = {};
  let filas = [];
  let ilegibles = 0;
  const muestraIlegibles = [];
  const vistos = new Set();
  for (const e of hid.eventos) {
    const r = filasDeEvento(e.evento, { semilla: e.semilla });
    motivos[r.motivo] = (motivos[r.motivo] || 0) + 1;
    if (r.motivo !== 'ok') continue;
    // Solo cuentan los cajones ilegibles de eventos ACEPTADOS: los de eventos
    // excluidos (menciones, "Azure outage") no son rangos que se perdieron.
    ilegibles += r.ilegibles;
    for (const et of r.etiquetasIlegibles || []) if (muestraIlegibles.length < 25) muestraIlegibles.push(`${e.slug}: ${et}`);
    if (e.semilla) porSemillaAceptados[e.semilla] = (porSemillaAceptados[e.semilla] || 0) + 1;
    for (const f of r.filas) {
      if (vistos.has(f.market_id)) continue;   // un cajón en dos eventos: no debería, pero no se duplica
      vistos.add(f.market_id);
      filas.push(f);
    }
  }
  for (const s of Object.keys(desc.porSemilla)) desc.porSemilla[s].eventos_kpi = porSemillaAceptados[s] || 0;

  const frontera = veredictoFrontera({ intentos: desc.intentos, eventosCrudos: desc.eventos.size + conocidos });
  const resumen = {
    ...base,
    frontera,
    descubrimiento: { eventos_unicos: desc.eventos.size, abiertos_conocidos: conocidos, requests: desc.intentos.length,
      requests_ok: desc.intentos.filter((i) => i.status === 'ok').length },
    hidratacion: hid.conteo,
    filtro: { motivos, cajones_ilegibles: ilegibles, muestra_ilegibles: muestraIlegibles },
    conteos: conteos(filas, ahoraMs),
  };

  if (seco) {
    if (clobEnSeco) {
      const abiertos = filas.filter((f) => !f.resolved);
      const bf = await backfillClob(clob, restante, abiertos, ahoraMs);
      resumen.clob_en_seco = { cajones_abiertos: abiertos.length, conteo: bf.conteo, puntos: bf.puntos.length };
    }
    resumen.eventos = muestraEventos(filas);
    resumen.ms = Date.now() - t0;
    return resumen;
  }

  // Frontera caída → no se escribe nada: una tabla que "se queda igual" porque
  // Gamma no contestó se lee después como un día sin mercados.
  if (frontera.estado !== 'ok') {
    resumen.escritura = null;
    resumen.ms = Date.now() - t0;
    return resumen;
  }

  // 4. Escritura: cajones + snapshot del día
  const prep = filas.map((f) => db.preparaFilaKpi(f, ahoraIso));
  const escritura = await db.upsertMercadosKpi(prep);
  const snap = await db.insertaPrecios(db.puntosDeSnapshot(filas, ahoraIso));

  // 5. Backfill de CLOB para lo que lo necesite
  const pend = await db.pendientesClob(300);
  const bf = await backfillClob(clob, restante, pend, ahoraMs);
  const ins = await db.insertaPrecios(bf.puntos);
  await db.marcaBackfill(bf.hechos);

  // 6. T-24h desde el historial
  const t24 = await db.recalculaT24h();

  return {
    ...resumen,
    escritura: { ...escritura, snapshot_puntos: snap.puntos },
    clob: { pendientes: pend.length, conteo: bf.conteo, puntos: ins.puntos, marcados: bf.hechos.length },
    t24h: t24,
    stats: await db.statsKpi(),
    ms: Date.now() - t0,
  };
}

// Vista compacta por evento para el reporte en seco.
function muestraEventos(filas) {
  const m = new Map();
  for (const f of filas) {
    if (!m.has(f.event_slug)) {
      m.set(f.event_slug, { slug: f.event_slug, titulo: f.event_title, symbol: f.symbol, end_date: f.end_date,
        semilla: f.semilla, tipo: f.range_kind, rangos: 0, con_precio: 0, resuelto: true });
    }
    const e = m.get(f.event_slug);
    e.rangos++;
    if (f.price_yes_latest !== null && f.price_yes_latest !== undefined) e.con_precio++;
    if (!f.resolved) e.resuelto = false;
  }
  return [...m.values()].sort((a, b) => (Date.parse(a.end_date || '') || Infinity) - (Date.parse(b.end_date || '') || Infinity));
}

// Reporte en seco → markdown (para la descripción del PR y el resumen del job).
function markdownSeco(r) {
  const out = ['## Cosecha KPI — corrida en seco', '', `Ahora: \`${r.ahora}\` · sin escribir a Postgres`, ''];
  out.push(`**Frontera:** ${r.frontera.estado}${r.frontera.motivo ? ' — ' + r.frontera.motivo : ''}`, '');
  out.push('| semilla | status | páginas | eventos devueltos | nuevos (dedupe) | eventos KPI aceptados (de sus nuevos) |');
  out.push('|---|---|---:|---:|---:|---:|');
  for (const [s, v] of Object.entries(r.por_semilla || {})) {
    out.push(`| ${s} | ${v.status ?? '—'} | ${v.paginas} | ${v.eventos_crudos} | ${v.nuevos} | ${v.eventos_kpi ?? '—'} |`);
  }
  const ceros = Object.entries(r.por_semilla || {}).filter(([, v]) => !v.eventos_crudos).map(([s]) => s);
  out.push('', ceros.length ? `**Semillas con 0 eventos:** ${ceros.join(', ')}` : 'Ninguna semilla devolvió 0 eventos.', '');
  if (r.corte_422) { out.push('**Corte por 422:** `' + JSON.stringify(r.corte_422) + '`', ''); return out.join('\n') + '\n'; }
  if (r.hidratacion) out.push(`Hidratación /events?slug=: \`${JSON.stringify(r.hidratacion)}\``, '');
  if (r.filtro) {
    out.push(`Filtro (eventos por motivo): \`${JSON.stringify(r.filtro.motivos)}\` · cajones ilegibles en eventos aceptados: ${r.filtro.cajones_ilegibles}`, '');
    if ((r.filtro.muestra_ilegibles || []).length) out.push('Ilegibles (muestra): ' + r.filtro.muestra_ilegibles.map((x) => '`' + x + '`').join(', '), '');
  }
  if (r.conteos) {
    const c = r.conteos;
    out.push('| conteo | n |', '|---|---:|');
    out.push(`| eventos KPI | ${c.eventos} |`);
    out.push(`| rangos (cajones) | ${c.rangos} |`);
    out.push(`| con precio válido (Yes en [0,1]) | ${c.con_precio_valido} |`);
    out.push(`| … de ellos vivos (0 < Yes < 1) | ${c.con_precio_vivo} |`);
    out.push(`| con end_date futura | ${c.con_end_date_futura} (en ${c.eventos_con_end_date_futura} eventos) |`);
    out.push(`| resueltos | ${c.resueltos} |`);
    out.push(`| sin símbolo | ${c.sin_symbol} |`);
    out.push(`| sin token Yes | ${c.sin_token_yes} |`);
    out.push(`| eventos escalera ("above __", range_kind='umbral') | ${c.eventos_escalera} |`, '');
  }
  if (r.clob_en_seco) out.push(`CLOB /prices-history (cajones abiertos, ventana ${VENTANA_CLOB_DIAS} d): \`${JSON.stringify(r.clob_en_seco)}\``, '');
  if (r.eventos && r.eventos.length) {
    out.push('| evento | símbolo | cierra | semilla | tipo | rangos | con precio | resuelto |', '|---|---|---|---|---|---:|---:|---|');
    for (const e of r.eventos) {
      out.push(`| ${String(e.titulo || e.slug).replace(/\|/g, '/')} | ${e.symbol || '—'} | ${e.end_date ? String(e.end_date).slice(0, 10) : '—'} | ${e.semilla || '—'} | ${e.tipo} | ${e.rangos} | ${e.con_precio} | ${e.resuelto ? 'sí' : 'no'} |`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

export {
  cosechaKpi, descubreEventos, eventosDeBusqueda, hidrataEventos, historialClob, backfillClob,
  markdownSeco, muestraEventos, PAGINAS_POR_SEMILLA, LIMITE_POR_PAGINA, VENTANA_CLOB_DIAS,
};
