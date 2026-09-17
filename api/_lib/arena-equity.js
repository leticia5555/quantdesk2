// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-equity.js — EL EQUITY INTRADÍA, muestreado.
//
// Hasta acá el equity de cada agente existía en DOS momentos: el snapshot de
// la corrida nocturna y lo que /api/leaderboard lee EN VIVO de Alpaca. O sea:
// un punto al día y un número que no se guarda. Con eso no hay curva, no hay
// máximo del día, y no se puede contestar la pregunta que de verdad importa —
// "¿esta posición llegó a estar arriba y lo devolvió?".
//
// ── POR QUÉ UNA TABLA Y NO UN CAMPO MÁS EN EL JOURNAL ────────────────
// El journal tiene UNA fila por DECISIÓN. Esto tiene una fila por MUESTRA, que
// es otra granularidad y otro ciclo de vida: las muestras no se leen para
// decidir, se leen para graficar y para el post-mortem. Meterlas en
// `arena_journal` obligaría a que toda consulta de decisiones filtrara un tipo
// de fila que no es una decisión — y ese es el `where` que alguien olvida.
//
// ── EL MÁXIMO ES EL MÁXIMO DE LAS MUESTRAS, Y SE DICE ────────────────
// Se muestrea cada ~5 min (el tick de arena-watch). El máximo del día es el
// máximo de ESAS muestras, no el máximo real del día: si el equity tocó su
// pico entre dos muestras, no está. La diferencia importa para la capa de toma
// de ganancias (¿llegó a +X% alguna vez hoy?): con muestreo, la respuesta es
// un PISO — si las muestras dicen que llegó, llegó; si dicen que no, pudo
// haber llegado igual.
//
// Por eso cada lectura publica `muestreo` con el intervalo y cuántos puntos
// tiene el día: un análisis que trate esto como una serie continua está
// sacando conclusiones de una resolución que no tiene.
//
// ── FAIL-SAFE, SIEMPRE ───────────────────────────────────────────────
// Esto cuelga del tick que también dispara la red determinista y las rondas
// fijas. Un fallo escribiendo una muestra NO puede tumbar ese tick: sería
// cambiar observabilidad por operación, que es exactamente al revés. Todo lo
// de acá traga sus errores y los devuelve como dato.
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

// Cada cuánto MUESTREA el cron que llama a esto (arena-watch: */5). No fuerza
// nada: se publica para que quien lea la serie sepa su resolución.
export const MUESTREO_MS = 5 * 60 * 1000;

const SCHEMA = [
  `create table if not exists arena_equity_intraday (
     agent_id   text not null,
     minuto     timestamptz not null,
     session_date date not null,
     equity     numeric not null,
     cash       numeric,
     posiciones int,
     primary key (agent_id, minuto)
   )`,
  `create index if not exists arena_equity_intraday_dia_idx
     on arena_equity_intraday (session_date, agent_id, minuto)`,
];

let ready = false;
export async function ensureEquitySchema() {
  if (ready) return;
  for (const q of SCHEMA) await sql(q);
  ready = true;
}

// La marca de la muestra, truncada al MINUTO. Es lo que hace la escritura
// idempotente: si el cron dispara dos veces en el mismo minuto —pasa— la
// segunda no duplica el punto en vez de dibujar un escalón que no existió.
export function minutoDe(now = new Date()) {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

// Una muestra por agente. `equity` es el TOTAL de la cuenta (posiciones +
// cash), que es el número con el que se mide el retorno — no el valor de
// mercado de las posiciones, que sube cuando se compra y baja cuando se vende
// sin que haya pasado nada.
export async function registrarEquity({ agentId, equity, cash = null, posiciones = null, sessionDate, now = new Date() }) {
  const e = Number(equity);
  // Un equity no numérico NO se guarda como 0: un cero en esta serie se lee
  // como una cuenta vaciada, que es un evento real y grave.
  if (!Number.isFinite(e)) return { guardado: false, motivo: `equity no numérico (${equity})` };
  try {
    await ensureEquitySchema();
    await sql(
      `insert into arena_equity_intraday (agent_id, minuto, session_date, equity, cash, posiciones)
       values ($1, $2::timestamptz, $3::date, $4, $5, $6)
       on conflict (agent_id, minuto) do nothing`,
      [agentId, minutoDe(now), sessionDate, e,
       Number.isFinite(Number(cash)) ? Number(cash) : null,
       Number.isFinite(Number(posiciones)) ? Number(posiciones) : null],
    );
    return { guardado: true, agente: agentId, equity: e };
  } catch (err) {
    return { guardado: false, agente: agentId, motivo: String((err && err.message) || err) };
  }
}

// ── EL SNAPSHOT DEL LIBRO EN EL MOMENTO DE DECIDIR ───────────────────
// El camino vivo del contrato objetivo NO escribía la columna `account`: el
// equity, el cash y las posiciones de una ronda viva quedaban SÓLO dentro del
// texto del prompt. Se podían parsear —es prosa— y eso es exactamente la
// derivación frágil que ya mordió con el buffet.
//
// Es el estado de ESE día: si no se guarda cuando pasa, mañana no existe.
//
// ── LA FORMA VIEJA, MÁS EL DETALLE ───────────────────────────────────
// `{equity, cash, positions}` es lo que journaleaba el contrato viejo y lo que
// leen las vistas de hoy: se conserva tal cual, con `positions` como CONTEO.
// `holdings` se agrega al lado, con lo que hace falta para estudiar una
// decisión después: precio de entrada promedio, valor de mercado y el P&L no
// realizado de cada nombre en ese instante.
//
// Un campo que Alpaca no mande viaja como null. Nunca 0: un 0 en un precio de
// entrada se lee como una posición regalada.
export function snapshotCuenta(account = {}, positions = []) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const holdings = (Array.isArray(positions) ? positions : []).map((p) => ({
    symbol: String((p && p.symbol) || '').toUpperCase() || null,
    qty: n(p && p.qty),
    avg_entry_price: n(p && p.avg_entry_price),
    market_value: n(p && p.market_value),
    unrealized_plpc: n(p && p.unrealized_plpc),
    current_price: n(p && p.current_price),
  })).filter((h) => h.symbol);
  return {
    equity: n(account.equity),
    cash: n(account.cash),
    // CONTEO, como en el contrato viejo: hay vistas que lo leen así. Se deriva
    // de `holdings` y no del array crudo para que los dos NO puedan diferir:
    // un `positions: 7` al lado de seis holdings se lee como un dato perdido y
    // manda a buscar un bug que no existe.
    positions: holdings.length,
    holdings,
  };
}

// ── LA SERIE DE UN DÍA ───────────────────────────────────────────────
// Devuelve, por agente, los puntos y los tres números que se miran primero:
// apertura (la PRIMERA muestra del día), máximo y último.
//
// `pct_desde_apertura` es el que sirve para "¿llegó a +X% hoy?": el retorno
// contra el arranque del día, no contra el baseline de temporada. Son
// preguntas distintas y las dos viajan.
export function serieDe(filas) {
  const puntos = (filas || []).map((r) => ({
    ts: typeof r.minuto === 'string' ? r.minuto : new Date(r.minuto).toISOString(),
    equity: Number(r.equity),
    cash: r.cash != null ? Number(r.cash) : null,
    posiciones: r.posiciones != null ? Number(r.posiciones) : null,
  })).filter((p) => Number.isFinite(p.equity));

  if (!puntos.length) return { puntos: [], n: 0, apertura: null, maximo: null, minimo: null, ultimo: null };

  puntos.sort((a, b) => a.ts.localeCompare(b.ts));
  const apertura = puntos[0];
  const ultimo = puntos[puntos.length - 1];
  let maximo = puntos[0];
  let minimo = puntos[0];
  for (const p of puntos) {
    if (p.equity > maximo.equity) maximo = p;
    if (p.equity < minimo.equity) minimo = p;
  }
  const pct = (x) => (apertura.equity > 0 ? +(((x.equity - apertura.equity) / apertura.equity) * 100).toFixed(3) : null);
  return {
    puntos, n: puntos.length,
    apertura: { ts: apertura.ts, equity: apertura.equity },
    maximo: { ts: maximo.ts, equity: maximo.equity, pct_desde_apertura: pct(maximo) },
    minimo: { ts: minimo.ts, equity: minimo.equity, pct_desde_apertura: pct(minimo) },
    ultimo: { ts: ultimo.ts, equity: ultimo.equity, pct_desde_apertura: pct(ultimo) },
    // Cuánto del máximo se devolvió hasta ahora. Es la pregunta que motivó
    // todo esto, y sin el máximo no se puede contestar.
    devuelto_desde_maximo_pct: maximo.equity > 0
      ? +(((ultimo.equity - maximo.equity) / maximo.equity) * 100).toFixed(3) : null,
  };
}

export async function leerEquityDia({ sessionDate, agentId = null } = {}) {
  try {
    await ensureEquitySchema();
    const filas = await sql(
      `select agent_id, minuto, equity, cash, posiciones
         from arena_equity_intraday
        where session_date = $1::date ${agentId ? 'and agent_id = $2' : ''}
        order by agent_id, minuto`,
      agentId ? [sessionDate, agentId] : [sessionDate],
    );
    const porAgente = {};
    for (const f of filas || []) (porAgente[f.agent_id] = porAgente[f.agent_id] || []).push(f);
    const out = {};
    for (const [id, rows] of Object.entries(porAgente)) out[id] = serieDe(rows);
    return { ok: true, por_agente: out };
  } catch (err) {
    // La tabla puede no existir todavía (nunca corrió un tick). Eso es un
    // ESTADO, no un error del endpoint que la lee.
    return { ok: false, por_agente: {}, motivo: String((err && err.message) || err) };
  }
}

// Los días que ya tienen muestras, del más reciente al más viejo. Para que la
// página ofrezca sólo días que existen en vez de un calendario con huecos.
export async function diasConMuestras({ limite = 30 } = {}) {
  try {
    await ensureEquitySchema();
    const filas = await sql(
      `select session_date, count(*)::int as n, count(distinct agent_id)::int as agentes
         from arena_equity_intraday group by session_date order by session_date desc limit $1`,
      [Math.max(1, Math.min(365, limite))],
    );
    return (filas || []).map((r) => ({
      dia: typeof r.session_date === 'string' ? r.session_date.slice(0, 10) : new Date(r.session_date).toISOString().slice(0, 10),
      muestras: r.n, agentes: r.agentes,
    }));
  } catch { return []; }
}
