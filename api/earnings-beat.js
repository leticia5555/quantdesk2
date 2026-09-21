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
//   ?indice=0      arranca en el N-ésimo cruzado: para partir en dos corridas
//                  y sumar (el censo publica índice inicial, final y restantes)
//   ?max_precios=400  tope de mercados a los que se les pide el precio T-24h
//                  (el conteo del candado). Si no entran, trunca y lo declara
//   ?detalle=1     incluye el detalle mercado por mercado del T-24h
//   ?simbolos=99   cuántos símbolos del universo v0 se buscan uno por uno
//                  (camino D, el que decide el candado). &simbolos=0 lo apaga
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
  isoDia, ts, resumenMarkdown, extraeTags, extraeCluster, FRASES_BUSQUEDA, detectaTopeUniforme,
  analizaDesfases, clasificaT24h, clasificaParaV1, comparaEmparejamiento,
} from './_lib/earnings-beat.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { getSymbolMap } from './earnings.js';

// Paginar Gamma + bajar historiales del CLOB + sondas de revisiones no entra
// en los 60s de default. Misma medicina que pead-analyze/pead-harvest.
export const maxDuration = 300;

const PRESUPUESTO_MS = 240000;   // corte duro del censo: reporta truncado, no 504
const LIMITE_SONDA = 100;        // explícito: las sondas miran esquema, no catálogo
// El CLOB se pide en paralelo de a pocos: 145 requests en serie no entran en
// el presupuesto, y 145 de golpe es una forma elegante de que te limiten.
// Mismo criterio que CONCURRENCIA en _lib/yahoo-daily.js.
const CONCURRENCIA_CLOB = 6;
const UMBRAL_RUIDO = 100;        // filas traídas por un símbolo para llamarlo ruidoso

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

// ── CICATRIZ #2: el "5" que hacía ver un catálogo como una muestra ────────
// La corrida anterior devolvió EXACTAMENTE 5 filas en toda respuesta. Dos
// causas distintas, y conviene no confundirlas porque se arreglan distinto:
//   · las sondas del §1 llevaban un `limit: 5` MÍO (probes baratas);
//   · la búsqueda iba con solo `q` — quité `limit_per_type` en la vuelta
//     anterior "para no inventar parámetros", y sin él public-search sirve su
//     DEFAULT, que resultó ser 5 por tipo.
// O sea que la prudencia de no mandar el parámetro NO fue neutral: eligió el
// default del servidor y lo disfrazó de resultado. La lección no es "inventar
// parámetros", es: **mandarlo y verificar que funcionó**, con reintento pelado
// si el servidor lo rechaza. Un límite implícito es peor que uno explícito:
// el explícito se ve en el diff.
const PAGINAS_BUSQUEDA = 12;      // tope de páginas por frase
const LIMITE_BUSQUEDA = 100;      // explícito, y verificado abajo
const PAGINAS_POR_SIMBOLO = 3;    // 99 búsquedas: acá el presupuesto manda

async function buscaFrase(gamma1, frase, restante, etiqueta, maxPaginas = PAGINAS_BUSQUEDA) {
  const intentos = [];
  const filas = [];
  const idsVistos = new Set();
  let conLimite = true;

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    if (restante() < 40000) { intentos.push({ frase, etiqueta, nota: 'corte por presupuesto de tiempo' }); break; }
    const params = { q: frase };
    if (conLimite) params.limit_per_type = LIMITE_BUSQUEDA;
    if (pagina > 0) params.page = pagina + 1;

    let r = await gamma1('/public-search', params);
    // Si el parámetro explícito es el problema, se cae al pelado UNA vez y
    // queda registrado — pero entonces el conteo sale con el default del
    // servidor y hay que leerlo como tal.
    if (r.status !== 'ok' && conLimite && pagina === 0) {
      intentos.push({ frase, etiqueta, pagina, status: r.status, http: r.http ?? null,
        nota: `limit_per_type=${LIMITE_BUSQUEDA} rechazado — reintento sin parámetros` });
      conLimite = false;
      r = await gamma1('/public-search', { q: frase });
    }

    const encontradas = r.status === 'ok' ? cosechaDeBusqueda(r.body) : [];
    const ids = encontradas.map(idDeMercado).filter(Boolean);
    const nuevos = ids.filter((i) => !idsVistos.has(i));
    for (const i of ids) idsVistos.add(i);

    intentos.push({
      frase, etiqueta, pagina, status: r.status, http: r.http ?? null, ms: r.ms,
      filas: encontradas.length, nuevos: nuevos.length,
      limite: conLimite ? LIMITE_BUSQUEDA : 'default del servidor',
      forma: r.status === 'ok' ? formaDe(r.body) : null,
    });
    filas.push(...encontradas);

    if (r.status !== 'ok') break;
    if (!encontradas.length) break;
    // ¿La paginación AVANZA de verdad? Si la página 2 trae lo mismo que la 1,
    // public-search no pagina y seguir pidiendo es gastar presupuesto en el
    // mismo lote. Se declara, no se asume.
    if (pagina > 0 && nuevos.length === 0) {
      intentos.push({ frase, etiqueta, nota: 'la página no trajo ids nuevos: public-search no pagina — se corta' });
      break;
    }
    // Página incompleta = última página.
    if (conLimite && encontradas.length < LIMITE_BUSQUEDA) break;
  }
  return { intentos, filas };
}

function idDeMercado(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.id !== undefined && raw.id !== null) return String(raw.id);
  return raw.slug ? 'slug:' + raw.slug : null;
}

async function descubrePorBusqueda(ctx, gamma1, restante) {
  const intentos = [];
  const filas = [];
  for (const frase of FRASES_BUSQUEDA) {
    if (restante() < 40000) break;
    const r = await buscaFrase(gamma1, frase, restante, 'frase');
    intentos.push(...r.intentos);
    filas.push(...r.filas);
  }
  return { camino: 'busqueda', intentos, filas };
}

// ── Camino D: una búsqueda POR SÍMBOLO de nuestro universo ────────────────
// Es el camino que apunta directo a la pregunta que decide el candado: no
// "cuántos mercados de earnings hay en Polymarket", sino **cuántos hay de las
// empresas que nosotros podemos modelar**. Las plantillas conocidas
// ("Will X (TICKER) beat quarterly earnings?" y el slug estilo
// "nke-quarterly-earnings-gaap-eps-…") ponen el ticker en el texto, así que
// buscar por ticker es la consulta más específica que podemos hacer.
async function descubrePorSimbolo(ctx, gamma1, restante, universo) {
  const intentos = [];
  const filas = [];
  const simbolos = [...universo].slice(0, ctx.simbolos);
  const traidas = {};   // filas crudas por símbolo, ANTES de filtrar intentos
  let probados = 0;
  for (const sym of simbolos) {
    if (restante() < 60000) break;
    // Tope de páginas MÁS BAJO que el de las frases: son 99 búsquedas, y un
    // ticker que es palabra común ("NOW", "ON") puede paginar sin fin sin
    // aportar un solo mercado de earnings. El presupuesto vale más que la
    // página 4 de "Now You See Me".
    const r = await buscaFrase(gamma1, `${sym} quarterly earnings`, restante, sym, PAGINAS_POR_SIMBOLO);
    probados++;
    traidas[sym] = r.intentos.reduce((a, i) => a + (typeof i.filas === 'number' ? i.filas : 0), 0);
    // Solo se reportan los intentos que trajeron algo o fallaron: 99 filas de
    // "0 resultados" tapan el reporte sin decir nada que el total no diga.
    for (const i of r.intentos) {
      if (i.nota || i.status !== 'ok' || (i.filas ?? 0) > 0) intentos.push(i);
    }
    // Cada fila recuerda QUÉ búsqueda la trajo: la búsqueda por símbolo es por
    // SUBCADENA y hay tickers que son palabras comunes (NOW, ON, ALL). Sin la
    // etiqueta no se puede auditar si por ahí se coló basura.
    filas.push(...r.filas.map((f) => ({ ...f, _etiqueta: sym })));
  }
  return { camino: 'simbolo', intentos, filas, traidas, probados, de: simbolos.length, universo: universo.size };
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

// Precio del Yes a T-24h de UN mercado. Dos formas de parámetros probadas en
// orden; se reporta cuál funcionó. Nunca lanza: un fallo del CLOB es una
// categoría del conteo, no el final del censo.
async function precioDeUnMercado(m, clob1) {
  const base = { slug: m.slug, pregunta: m.pregunta, symbol: m.symbol, fecha_resolucion: m.fecha_resolucion,
    outcome: m.outcome, consenso_pm: m.consenso_pm, reported_date: m.cruce ? m.cruce.reported_date : null };
  if (!m.token_yes) return { clase: 'sin_token', forma: 'n/a', fila: { ...base, yes_t24h: null, motivo: 'sin_token_yes' } };
  const finMs = ts(m.fin_real || m.fin_declarado);
  if (!finMs) return { clase: 'sin_precio', forma: 'n/a', fila: { ...base, yes_t24h: null, motivo: 'sin_fecha_de_resolucion' } };

  const desdeTs = Math.floor((finMs - 72 * 3600 * 1000) / 1000);
  const hastaTs = Math.floor(finMs / 1000);
  let r = await clob1('/prices-history', { market: m.token_yes, startTs: desdeTs, endTs: hastaTs, fidelity: 60 });
  let forma = 'startTs/endTs';
  if (r.status !== 'ok' || !(r.body && Array.isArray(r.body.history) && r.body.history.length)) {
    r = await clob1('/prices-history', { market: m.token_yes, interval: 'max', fidelity: 60 });
    forma = 'interval=max';
  }
  if (r.status !== 'ok') {
    return { clase: 'error', forma, fila: { ...base, yes_t24h: null, clob: { status: r.status, http: r.http ?? null } } };
  }
  const history = r.body ? (Array.isArray(r.body.history) ? r.body.history : filasDe(r.body)) : [];
  const precio = precioEnT24h(history, finMs);
  return {
    clase: clasificaT24h(precio), forma,
    fila: { ...base, clob: { status: r.status, http: r.http ?? null, ms: r.ms, forma, puntos: history.length }, yes_t24h: precio },
  };
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
    const r = await gamma1(e.path, { ...e.params(ctx, 0), limit: LIMITE_SONDA });
    const filas = r.status === 'ok' ? filasDe(r.body) : [];
    sondas.push({
      estrategia: e.nombre, endpoint: 'gamma' + e.path, status: r.status, http: r.http ?? null,
      // `filas` de una sonda está TOPADA por su propio límite: es el censo del
      // ESQUEMA, no un conteo del catálogo. Se publica el tope al lado para que
      // nadie vuelva a leer "5" como si fuera el tamaño del universo.
      ms: r.ms, filas: filas.length, limite_de_la_sonda: LIMITE_SONDA,
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
      crudosPorId.set(id, { ...raw, _via: camino, _etiqueta: raw._etiqueta || null });
      nuevos++;
    }
    aportes[camino] = (aportes[camino] || 0) + nuevos;
    return nuevos;
  };

  const busqueda = await descubrePorBusqueda(ctx, gamma1, restante);
  suma('busqueda', busqueda.filas);

  // Camino D ANTES de tags/racimo: es el que más semillas produce, y tags y
  // racimo fallaron la vuelta pasada por falta de semillas, no por no existir.
  const porSimbolo = ctx.simbolos > 0
    ? await descubrePorSimbolo(ctx, gamma1, restante, universo)
    : { camino: 'simbolo', intentos: [{ nota: 'apagado con &simbolos=0' }], filas: [], traidas: {}, probados: 0, de: 0 };
  suma('simbolo', porSimbolo.filas);

  // Semillas para B y C: los mercados de earnings que A sí encontró. Si A no
  // encontró ninguno, B y C se declaran no disponibles en vez de inventarse
  // un tag plausible.
  const todasLasSemillas = [...crudosPorId.values()]
    .filter((raw) => pareceEarnings(normalizaMercado(raw)).si);
  const semillas = todasLasSemillas.slice(0, 8);
  // ¿Los mercados traen tags/evento cuando hay más de dos? La vuelta pasada
  // tags y racimo quedaron "no disponibles" por falta de semillas; con este
  // conteo se distingue "no había semillas" de "las semillas no traen tags".
  const semillas_info = {
    total: todasLasSemillas.length,
    usadas: semillas.length,
    con_tags: todasLasSemillas.filter((raw) => extraeTags(raw).length > 0).length,
    con_racimo: todasLasSemillas.filter((raw) => {
      const c = extraeCluster(raw);
      return !!(c.evento_id || c.evento_slug || c.serie_id || c.serie_slug);
    }).length,
  };

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
  // Cada descarte con su motivo Y su muestra: un filtro que no se puede
  // auditar es el que dejó pasar 26 mercados del símbolo equivocado.
  const motivos_filtro = {};
  const muestras_filtro = {};
  for (const raw of crudosPorId.values()) {
    for (const k of Object.keys(raw || {})) claves.set(k, (claves.get(k) || 0) + 1);
    const m = normalizaMercado(raw);
    if (!m) continue;
    const fecha = isoDia(m.fin);
    const simbolo = resuelveSimbolo(m, indice, universo);
    // El filtro v1 necesita el símbolo YA resuelto para poder aplicar la regla
    // dura de "resuelto != buscado".
    const v1 = clasificaParaV1({ ...m, symbol: simbolo.symbol }, { etiqueta: raw._etiqueta || null, universo });
    motivos_filtro[v1.motivo] = (motivos_filtro[v1.motivo] || 0) + 1;
    if (!v1.acepta) {
      const muestra = (muestras_filtro[v1.motivo] = muestras_filtro[v1.motivo] || []);
      if (muestra.length < 4 && (m.pregunta || m.slug)) {
        muestra.push({
          texto: String(m.pregunta || m.slug).slice(0, 100),
          buscado: raw._etiqueta || null, resuelto: simbolo.symbol || null,
        });
      }
      if (descartados.length < 8 && m.pregunta) descartados.push(m.pregunta.slice(0, 110));
      continue;
    }
    if (fecha && fecha < ctx.desde) continue;   // fuera de ventana: no se cuenta
    const esEarnings = { senales: v1.senales };
    const consenso = extraeConsensoEps(m.descripcion || '') || extraeConsensoEps(m.pregunta || '');
    const outcome = outcomeResuelto(m);
    mercados.push({
      id: m.id, slug: m.slug, pregunta: m.pregunta, via: raw._via || null, etiqueta: raw._etiqueta || null,
      fecha_resolucion: fecha, fin_declarado: m.fin_declarado, fin_real: m.fin_real,
      // La fecha de creación viaja hasta el cruce: es la que decide CONTRA QUÉ
      // REPORTE apunta el mercado. Sin ella la regla nueva no actúa (y el
      // censo lo grita en `sin_fecha_de_creacion`).
      creado: m.creado,
      cerrado: m.cerrado, uma: m.uma, volumen: m.volumen,
      senales: esEarnings.senales, senales_eps: v1.senales_eps || [],
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

  // ── Auditoría del ruido de la búsqueda por subcadena ──
  // "NOW" trae las películas "Now You See Me"; "ON", "ALL" y "KEY" son peores.
  // El filtro de earnings los descarta, pero "el filtro descartó bien" es una
  // afirmación que hay que PODER COMPROBAR: por eso se publica, por cada
  // símbolo ruidoso, cuántas filas trajo, cuántas sobrevivieron, y una muestra
  // de las ACEPTADAS para leerlas a ojo.
  const traidasPorEtiqueta = new Map(Object.entries(porSimbolo.traidas || {}));
  const aceptadasPorEtiqueta = new Map();
  for (const m of mercados) {
    if (!m.etiqueta) continue;
    if (!aceptadasPorEtiqueta.has(m.etiqueta)) aceptadasPorEtiqueta.set(m.etiqueta, []);
    aceptadasPorEtiqueta.get(m.etiqueta).push(m);
  }
  const ruidosos = [...traidasPorEtiqueta.entries()]
    .filter(([, n]) => n >= UMBRAL_RUIDO)
    .sort((a, b) => b[1] - a[1])
    .map(([sym, traidas]) => {
      const aceptados = aceptadasPorEtiqueta.get(sym) || [];
      return {
        symbol: sym, filas_traidas: traidas, aceptados: aceptados.length,
        descartadas: traidas - aceptados.length,
        // La prueba de que no se coló basura no es un porcentaje: son las
        // preguntas aceptadas, leídas.
        muestra_aceptados: aceptados.slice(0, 3).map((m) => ({
          pregunta: (m.pregunta || m.slug || '').slice(0, 90),
          symbol_resuelto: m.symbol, coincide_con_la_busqueda: m.symbol === sym,
        })),
        // Un aceptado cuyo símbolo resuelto NO es el que se buscó es
        // exactamente el modo de falla que esta auditoría persigue.
        aceptados_con_otro_simbolo: aceptados.filter((m) => m.symbol && m.symbol !== sym).length,
      };
    });

  // Qué camino encontró MÁS mercados de earnings (no crudos: earnings).
  const porCamino = {};
  for (const m of mercados) porCamino[m.via || 'desconocido'] = (porCamino[m.via || 'desconocido'] || 0) + 1;
  const ganadora = Object.entries(porCamino).sort((a, b) => b[1] - a[1])[0] || null;

  const resueltos = mercados.filter((m) => m.outcome !== null);
  const conSimbolo = mercados.filter((m) => m.symbol);

  // ── 4. Cruce con pead_earnings (SELECT, nada más) ──
  // VA PRIMERO, antes del CLOB: el conteo del candado se mide sobre los
  // mercados CRUZADOS, así que hay que saber cuáles son antes de gastar el
  // presupuesto pidiendo precios.
  const cruce = { consultado: false, filas_pead: 0, error: null, cruzados: 0, en_universo_v0: 0, sin_cruce: {} };
  let cruzados = [];
  let desfases = null;
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
    // Emparejamiento corregido (solo reportes POSTERIORES a la creación del
    // mercado) + la comparación contra el viejo, para poder decir qué pasó con
    // los casos que antes caían en "fecha fuera de tolerancia".
    const comparacion = comparaEmparejamiento(mercados, filas);
    const todos = comparacion.ahora;
    cruce.emparejamiento = {
      regla: 'el reporte tiene que ser POSTERIOR a la creación del mercado; tolerancia sigue en ±' + CRITERIOS.tolerancia_dias_cruce + ' día',
      cruzados_con_regla_vieja: comparacion.cruzados_antes,
      cruzados_ahora: comparacion.cruzados_ahora,
      casos_que_antes_caian_fuera_de_tolerancia: comparacion.fuera_de_tolerancia_antes,
      destino_de_esos_casos: comparacion.destino_de_esos_casos,
      dejaron_de_casar_con_la_regla_nueva: comparacion.dejaron_de_casar_con_la_regla_nueva,
      sin_fecha_de_creacion: comparacion.sin_fecha_de_creacion,
      nota_sin_creacion: comparacion.nota_sin_creacion,
    };
    cruzados = todos.filter((m) => m.cruce);
    cruce.cruzados = cruzados.length;
    cruce.en_universo_v0 = cruzados.filter((m) => m.en_universo_v0).length;
    for (const m of todos) {
      if (m.cruce) continue;
      const k = m.motivo_sin_cruce || 'desconocido';
      cruce.sin_cruce[k] = (cruce.sin_cruce[k] || 0) + 1;
    }
    // ¿Los que no cruzan por fecha son un desfase sistemático o ruido?
    desfases = analizaDesfases(todos);
  } catch (e) {
    cruce.error = String((e && e.message) || e).slice(0, 200);
  }

  // ── 5. EL CONTEO DEL CANDADO: precio del Yes a T-24h en TODOS los cruzados ──
  // Tres ejemplos no miden nada: el candado exige ≥100 mercados cruzados CON
  // precio a T-24h, así que hay que pedirle el precio a CADA uno. Se procesa
  // en lotes con concurrencia, y si el presupuesto se acaba se declara
  // truncado con cuántos alcanzó a ver — un conteo parcial que se sabe parcial
  // sigue siendo útil; uno parcial que se cree total, no.
  // `&indice=N` arranca en el N-ésimo cruzado: si los 312 no entran en una
  // corrida, se parte en dos y se suman — con los índices publicados para que
  // la suma no sea a ojo.
  const universoPrecios = cruzados.length ? cruzados
    : mercados.filter((m) => m.token_yes && m.fecha_resolucion);
  const objetivo = universoPrecios.slice(ctx.indice, ctx.indice + ctx.max_precios);
  const sobre = cruzados.length ? 'mercados_cruzados' : 'mercados_de_earnings (sin cruce disponible)';

  const t24 = {
    sobre, universo: universoPrecios.length,
    indice_inicial: ctx.indice, indice_final: ctx.indice + objetivo.length - 1,
    restantes_despues_de_esta_corrida: Math.max(0, universoPrecios.length - (ctx.indice + objetivo.length)),
    total: objetivo.length, procesados: 0, truncado: false, motivo_corte: null,
    conteo: { valido: 0, rancio: 0, sin_ticks: 0, sin_ticks_antes: 0, sin_precio: 0, error: 0, sin_token: 0 },
    formas: {}, detalle: [],
  };

  for (let i = 0; i < objetivo.length; i += CONCURRENCIA_CLOB) {
    if (restante() < 35000) {
      t24.truncado = true;
      t24.motivo_corte = `presupuesto_de_tiempo tras ${t24.procesados} de ${objetivo.length}`;
      break;
    }
    if (t24.procesados >= ctx.max_precios) {
      t24.truncado = true;
      t24.motivo_corte = `tope &max_precios=${ctx.max_precios}`;
      break;
    }
    if (t24.procesados >= objetivo.length) break;
    const lote = objetivo.slice(i, i + CONCURRENCIA_CLOB);
    const resultados = await Promise.all(lote.map((m) => precioDeUnMercado(m, clob1)));
    for (const r of resultados) {
      t24.procesados++;
      t24.conteo[r.clase] = (t24.conteo[r.clase] || 0) + 1;
      t24.formas[r.forma] = (t24.formas[r.forma] || 0) + 1;
      t24.detalle.push(r.fila);
    }
  }

  // Los "ejemplos" salen del mismo lote: cero requests extra.
  const ejemplos = t24.detalle.filter((d) => d.yes_t24h && d.yes_t24h.precio !== null).slice(0, ctx.ejemplos);
  if (!ctx.detalle_precios) t24.detalle = undefined;

  // ── 6. Revisiones de estimados — CERRADO: fuera de v1 ──
  // Resuelto en la corrida anterior con la fila cruda a la vista: lo que hay
  // son CONTEOS de revisiones y promedios ancla (7/30 días), sin valores
  // fechados. No es point-in-time. La sonda se sigue corriendo (es barata y
  // una fuente puede cambiar), pero el feature NO entra a v1 y el veredicto
  // de la Fase 0 ya no depende de ella.
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

  // Autodefensa: ¿todas las búsquedas trajeron el mismo número? Entonces lo
  // que se está midiendo es un tope, no una población (cicatriz de la 2ª
  // corrida). El censo lo dice arriba de todo y los conteos quedan marcados
  // como NO legibles.
  const sospecha_de_tope = detectaTopeUniforme(
    [...busqueda.intentos, ...porSimbolo.intentos], LIMITE_BUSQUEDA);

  return {
    ventana: { desde: ctx.desde, hasta: new Date().toISOString().slice(0, 10), meses: ctx.meses },
    sospecha_de_tope,
    sondas,
    descubrimiento: {
      metodo: 'dirigido (búsqueda → tags → racimo). El barrido por offset quedó como control opcional.',
      busqueda: { intentos: busqueda.intentos },
      simbolo: { intentos: porSimbolo.intentos, probados: porSimbolo.probados, de: porSimbolo.de },
      semillas: semillas_info,
      ruido_por_subcadena: {
        umbral: UMBRAL_RUIDO,
        nota: 'La búsqueda por símbolo es por SUBCADENA: un ticker que es palabra común trae de todo. Acá se ve cuánto trajo, cuánto sobrevivió al filtro, y una muestra de lo aceptado.',
        simbolos: ruidosos,
        aceptados_totales_de_ruidosos: ruidosos.reduce((a, r) => a + r.aceptados, 0),
        aceptados_con_simbolo_distinto: ruidosos.reduce((a, r) => a + r.aceptados_con_otro_simbolo, 0),
      },
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
    filtro_v1: {
      regla: 'v1 = SOLO beat/miss de EPS. Fuera: mercados de mención ("Will X say Y during the call"), otras métricas de earnings (volumen, guidance), y cualquiera cuyo símbolo resuelto no sea el buscado salvo que el título lo nombre explícitamente.',
      motivos: motivos_filtro,
      muestras: muestras_filtro,
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
    t24h: t24,
    cruce: { ...cruce, desfases },
    revisiones,
    estado_revisiones: 'CERRADO — fuera de v1 (conteos y promedios ancla, sin valores fechados)',
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
    // Cuántos símbolos del universo v0 se buscan uno por uno (camino D).
    // Default: todos. &simbolos=0 lo apaga.
    simbolos: q.simbolos === undefined ? 99 : Math.max(0, Math.min(200, Number(q.simbolos) || 0)),
    // Tope de mercados a los que se les pide precio (el conteo del candado).
    max_precios: Math.max(1, Math.min(500, Number(q.max_precios) || 400)),
    // Índice de arranque dentro de los cruzados (segunda pasada sumable).
    indice: Math.max(0, Number(q.indice) || 0),
    detalle_precios: String(q.detalle || '') === '1',
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
