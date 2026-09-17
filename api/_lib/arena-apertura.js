// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-apertura.js — EL CONTEXTO DEL MOMENTO EN QUE SE ABRIÓ.
//
// Por cada posición que un agente ABRE, se guarda el estado del mundo en ese
// instante: momentum, sector, noticias del nombre y lo que el mercado de
// opciones cobraba por que terminara arriba de la entrada.
//
// La pregunta que esto existe para poder contestar después: ¿en qué
// CONDICIONES le va bien a cada modelo? Un post-mortem que sólo tiene "compró
// NVDA y ganó 4%" no puede distinguir al que entra en rupturas con volumen del
// que entra en nombres castigados — y ésa es la diferencia que importa.
//
// ── SÓLO APERTURAS, Y ESO ES DELIBERADO ──────────────────────────────
// Un agregado a una posición viva no es una decisión nueva sobre el nombre: es
// la misma tesis, promediada. El contexto que hay que capturar es el del
// momento en que se decidió ENTRAR.
//
// ── ESTO NO PUEDE COSTAR UNA ORDEN ───────────────────────────────────
// Corre DESPUÉS de mandar las órdenes, nunca antes: una noticia que tarda en
// bajar no puede retrasar un fill. Cada pieza falla por separado y lo que no
// se pudo traer viaja como null con su motivo — un snapshot a medias sigue
// sirviendo; una corrida que no operó por buscar contexto, no.
//
// Y está acotado: un tope de símbolos por corrida. Siete agentes abriendo ocho
// posiciones cada uno son 56 cadenas de opciones y 56 consultas de noticias en
// una lambda con reloj.
//
// ENV VARS: DATABASE_URL · ARENA_APERTURA_MAX_SIMBOLOS (opcional).
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { opcionesDeApertura } from './arena-opciones.js';

// Tope de símbolos por corrida. No es una opinión sobre cuántas posiciones
// debería abrir un agente: es el reloj de la lambda.
export const MAX_SIMBOLOS = Number(process.env.ARENA_APERTURA_MAX_SIMBOLOS) || 10;

const SCHEMA = [
  `create table if not exists arena_aperturas (
     id          text primary key,
     agent_id    text not null,
     run_date    date not null,
     abierta_en  timestamptz not null default now(),
     symbol      text not null,
     qty         numeric,
     limit_price numeric,
     referencia  numeric,
     peso_objetivo numeric,
     -- El peso ANTERIOR: la entrada del juicio "esto fue una apertura".
     -- Se guarda el dato y no solo la conclusion: cuando weight_from no vino,
     -- la fila se captura igual (mejor de mas que de menos) y queda en null,
     -- asi el analisis puede filtrar en vez de confiar en mi criterio.
     peso_desde  numeric,
     enfoque     text,
     tesis       text,
     contrato    text,
     momentum    jsonb,
     opciones    jsonb,
     noticias    jsonb,
     sector      text,
     created_at  timestamptz not null default now()
   )`,
  `create index if not exists arena_aperturas_idx on arena_aperturas (agent_id, run_date, symbol)`,
];

let ready = false;
export async function ensureAperturaSchema() {
  if (ready) return;
  for (const q of SCHEMA) await sql(q);
  ready = true;
}

// ── QUÉ ES UNA APERTURA ──────────────────────────────────────────────
// Peso anterior CERO (o sin dato) y peso nuevo positivo. Un agregado sobre una
// posición viva NO entra: es la misma tesis promediada, no una decisión nueva.
export function esApertura(orden) {
  if (!orden || orden.side !== 'buy') return false;
  const desde = Number(orden.weight_from);
  return !Number.isFinite(desde) || desde <= 0;
}

// El momentum, del universo que la corrida YA pagó. `ret_1d` sale del buffet
// (el cambio del día de los movers); `ret_5d` y `ret_1m` del universo.
export function momentumDe(symbol, { universo = null, buffet = null } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const r = (universo && universo.retornos && universo.retornos[sym]) || {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

  // El cambio del día: se busca en las listas del buffet, que es donde vive.
  let ret1d = null;
  const listas = buffet ? [buffet.movers, buffet.gainers, buffet.losers, buffet.actives, buffet.universo_dia] : [];
  for (const lista of listas) {
    if (!Array.isArray(lista)) continue;
    const hit = lista.find((x) => String((x && (x.symbol || x.ticker)) || '').toUpperCase() === sym);
    if (hit) { ret1d = num(hit.change_pct ?? hit.percent_change); if (ret1d != null) break; }
  }

  return {
    ret_1d: ret1d,
    ret_5d: num(r.ret_5d),
    ret_1m: num(r.ret_1m),
    // De dónde salió cada uno: un null de "no estaba en los movers de hoy" no
    // es lo mismo que un null de "el universo no trajo retornos".
    fuente: { ret_1d: ret1d != null ? 'buffet del día' : 'no estaba en las listas del buffet', ret_5d_1m: universo && universo.retornos ? 'universo del día' : 'el universo no trajo retornos' },
  };
}

export function sectorDe(symbol, { universo = null } = {}) {
  const sym = String(symbol || '').toUpperCase();
  return (universo && universo.sectores && universo.sectores[sym]) || null;
}

// ── EL SNAPSHOT DE UN SÍMBOLO ────────────────────────────────────────
// `deps.news(symbol)` y `deps.chain(symbol)` se inyectan: así el test corre sin
// red y el llamador decide qué fuentes usar.
export async function contextoDeApertura(orden, { universo = null, buffet = null, deps = {}, ahora = Date.now() } = {}) {
  const symbol = String((orden && orden.symbol) || '').toUpperCase();
  const entrada = Number(orden && (orden.limit_price ?? orden.referencia));

  const ctx = {
    symbol,
    momentum: momentumDe(symbol, { universo, buffet }),
    sector: sectorDe(symbol, { universo }),
    noticias: null,
    opciones: null,
  };

  // NOTICIAS. Cada pieza falla por su cuenta: sin noticias el snapshot sigue
  // sirviendo, y una excepción acá no puede tumbar la corrida que YA operó.
  if (typeof deps.news === 'function') {
    try {
      const items = await deps.news(symbol);
      ctx.noticias = {
        n: Array.isArray(items) ? items.length : 0,
        // Titulares y hora, no el cuerpo: el cuerpo pesa y no se lee.
        titulares: (Array.isArray(items) ? items : []).slice(0, 5).map((x) => ({
          titular: String((x && (x.headline || x.title)) || '').slice(0, 200),
          fuente: (x && x.source) || null,
          en: (x && (x.created_at || x.updated_at)) || null,
        })),
      };
    } catch (e) {
      ctx.noticias = { n: null, error: String((e && e.message) || e) };
    }
  }

  // OPCIONES + la probabilidad implícita de terminar arriba de la entrada.
  if (typeof deps.chain === 'function' && Number.isFinite(entrada)) {
    try {
      const chainRes = await deps.chain(symbol);
      ctx.opciones = opcionesDeApertura(chainRes, { entrada, ahora });
    } catch (e) {
      ctx.opciones = { disponible: false, motivo: String((e && e.message) || e) };
    }
  }

  return ctx;
}

// ── GUARDAR ──────────────────────────────────────────────────────────
// Nunca lanza: esto cuelga de una corrida que YA mandó órdenes. Perder un
// snapshot es perder una fila de estudio; tumbar la corrida después de operar
// deja órdenes en Alpaca sin la fila que las explica.
export async function registrarAperturas({ agentId, runDate, ordenes = [], target = null, enfoque = null, contrato = null, universo = null, buffet = null, deps = {}, now = new Date() }) {
  const aperturas = (ordenes || []).filter(esApertura).slice(0, MAX_SIMBOLOS);
  if (!aperturas.length) return { guardadas: 0, de: 0 };

  const out = { guardadas: 0, de: aperturas.length, fallidas: [] };
  try {
    await ensureAperturaSchema();
  } catch (e) {
    return { ...out, guardadas: 0, error: 'no se pudo asegurar el schema: ' + String((e && e.message) || e) };
  }

  for (const orden of aperturas) {
    try {
      const ctx = await contextoDeApertura(orden, { universo, buffet, deps, ahora: now.getTime() });
      const sym = ctx.symbol;
      const tesis = target && target.theses ? (target.theses[sym] || null) : null;
      const peso = target && target.weights && Number.isFinite(Number(target.weights[sym])) ? Number(target.weights[sym]) : null;
      await sql(
        `insert into arena_aperturas
           (id, agent_id, run_date, abierta_en, symbol, qty, limit_price, referencia,
            peso_objetivo, peso_desde, enfoque, tesis, contrato, momentum, opciones, noticias, sector)
         values ($1,$2,$3::date,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (id) do nothing`,
        [
          `${agentId}:${runDate}:${sym}:${now.toISOString()}`,
          agentId, runDate, now.toISOString(), sym,
          Number.isFinite(Number(orden.qty)) ? Number(orden.qty) : null,
          Number.isFinite(Number(orden.limit_price)) ? Number(orden.limit_price) : null,
          Number.isFinite(Number(orden.referencia)) ? Number(orden.referencia) : null,
          peso,
          Number.isFinite(Number(orden.weight_from)) ? Number(orden.weight_from) : null,
          enfoque, tesis ? String(tesis).slice(0, 1000) : null, contrato,
          JSON.stringify(ctx.momentum || null),
          JSON.stringify(ctx.opciones || null),
          JSON.stringify(ctx.noticias || null),
          ctx.sector,
        ],
      );
      out.guardadas++;
    } catch (e) {
      out.fallidas.push({ symbol: orden && orden.symbol, motivo: String((e && e.message) || e) });
    }
  }
  return out;
}

export async function leerAperturas({ dias = 7, agentId = null, symbol = null } = {}) {
  try {
    await ensureAperturaSchema();
    const desde = new Date(Date.now() - Math.max(1, Math.min(365, dias)) * 86400000).toISOString().slice(0, 10);
    const filas = await sql(
      `select id, agent_id, run_date, abierta_en, symbol, qty, limit_price, referencia,
              peso_objetivo, peso_desde, enfoque, tesis, contrato, momentum, opciones, noticias, sector
         from arena_aperturas
        where run_date >= $1::date
          ${agentId ? 'and agent_id = $2' : ''}
          ${symbol ? (agentId ? 'and symbol = $3' : 'and symbol = $2') : ''}
        order by abierta_en desc limit 500`,
      [desde, ...(agentId ? [agentId] : []), ...(symbol ? [String(symbol).toUpperCase()] : [])],
    );
    return { ok: true, filas: filas || [] };
  } catch (e) {
    return { ok: false, filas: [], motivo: String((e && e.message) || e) };
  }
}
