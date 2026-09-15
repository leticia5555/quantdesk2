// ═══════════════════════════════════════════════════════════════
// /api/arena-universe — reconstruye el UNIVERSO del día (B1), pre-apertura.
//
// ~600 nombres (S&P 500 + Nasdaq 100 + hasta 100 del día) × precio, volumen y
// market cap NO cabe dentro de una corrida del PM. Vive acá, en su propio cron,
// ANTES de la apertura, y la corrida solo LEE el resultado — el mismo patrón
// que el canal screener (`arena-screener` precomputa, `arena-run` lee).
//
//   GET (cron)                   → reconstruye y guarda el universo de hoy
//   GET ?dry=1                   → lo construye y lo devuelve SIN guardar
//   GET ?refresh=1               → fuerza el refresco de constituyentes contra
//                                  FMP, salteando la ventana semanal
//   GET ?emit=1                  → además IMPRIME los constituyentes (solo para
//                                  mirarlos). NO hace falta guardarlos a mano:
//                                  la lista se persiste sola en Neon en cuanto
//                                  se baja de FMP — ver abajo.
//   GET ?peek=1                  → NO construye nada: muestra qué universo hay
//                                  guardado y de cuándo es (gratis)
//
// GATES: CRON_SECRET (el cron) **o** ARENA_ADMIN_KEY (a mano). Los dos sirven y
// se prueban los dos: el cron no tiene la llave de admin y la persona que lo
// dispara a mano no debería tener que buscar la del cron.
//
// NO GASTA UN TOKEN: acá no hay ninguna llamada a un LLM. Es datos de mercado y
// una lista de constituyentes.
//
// ── LA LISTA SE GUARDA SOLA. NADIE COMMITEA NADA ─────────────────────
// Cuando los constituyentes se bajan de FMP, `resolveConstituents` los escribe
// en Neon (`arena_universe`, clave `constituents:<índice>`) en el mismo paso.
// Eso los hace sobrevivir al deploy, a una caída de FMP y al reinicio de la
// lambda, y es lo que convierte al cron de las 13:00 UTC en autosuficiente: la
// primera corrida encuentra Neon vacío, baja la lista y la guarda; las
// siguientes la leen de ahí y solo vuelven a FMP cuando cumple una semana
// (`refreshDue`, por EDAD y no por calendario, así que un cron que no corrió el
// lunes refresca el martes en vez de esperar al lunes siguiente).
//
// El JSON de `data/universe/` es SOLO el arranque en frío (Neon vacío Y FMP
// caído el mismo día). Está vacío a propósito y no hace falta llenarlo: sin él
// el universo sigue teniendo dos fuentes por delante. `persisted` en la
// respuesta dice, por índice, si la lista quedó guardada.
//
// ENV VARS: FMP_API_KEY (opc) · FINNHUB_API_KEY (market cap de la admisión) ·
//           ALPACA_PAPER_KEY/SECRET · DATABASE_URL · CRON_SECRET ·
//           ARENA_ADMIN_KEY · ARENA_UNIVERSE_REFRESH_DAYS · ARENA_UNIVERSE_MOVERS_MAX
// ═══════════════════════════════════════════════════════════════

import { ensureSchema } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import { alpacaCreds } from './_lib/alpaca.js';
import { buildUniverse, saveUniverse, loadUniverse, resolveConstituents, REFRESH_DAYS, MOVERS_MAX } from './_lib/arena-universe.js';
import { beat } from './_lib/heartbeat.js';

// ~600 nombres × admisión (Finnhub profile2 + Yahoo, en lotes) es lo más lento
// del Arena. Mismo techo que el resto (plan Pro); vercel.json tiene que decir
// lo mismo o este número no existe.
export const maxDuration = 300;

// Las DOS llaves. El cron manda `Authorization: Bearer $CRON_SECRET`; la
// persona manda `x-admin-key`. Cualquiera de las dos abre.
function autorizado(req) {
  const cron = process.env.CRON_SECRET;
  if (cron) {
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
    if (h === 'Bearer ' + cron) return { ok: true, via: 'cron' };
  }
  const admin = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (admin.ok) return { ok: true, via: 'admin' };
  // Sin CRON_SECRET configurado, el endpoint queda solo detrás de la llave de
  // admin — y si ésa tampoco está, gana el 503 de checkAdminAuth, que explica
  // exactamente qué falta.
  return { ok: false, status: admin.status, body: admin.body };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const auth = autorizado(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const dry = String(q.dry || '') === '1';
  const force = String(q.refresh || '') === '1';
  const emit = String(q.emit || '') === '1';
  const peek = String(q.peek || '') === '1';
  const now = new Date();

  try {
    await ensureSchema();

    // ?peek=1 — gratis: qué hay guardado, sin construir nada.
    if (peek) {
      const u = await loadUniverse({ now });
      return res.status(200).json({
        peek: true,
        universe: u ? {
          built_at: u.built_at, loaded_from: u.loaded_from, is_today: u.is_today,
          universe_source: u.universe_source, counts: u.counts, indices: u.indices, note: u.note || null,
        } : null,
        hint: u ? null : 'No hay universo guardado todavía. Corré este endpoint sin ?peek=1 para construir el primero.',
      });
    }

    const universe = await buildUniverse({ creds: alpacaCreds(), now, force });

    let saved = false;
    if (!dry) saved = await saveUniverse(universe, now);

    const out = {
      ran_at: now.toISOString(),
      mode: dry ? 'dry_run' : 'saved',
      saved,
      universe_source: universe.universe_source,
      built_at: universe.built_at,
      market_day: universe.market_day,
      counts: universe.counts,
      indices: universe.indices,
      admission: { ...universe.admission, rejected: universe.admission.rejected.slice(0, 20) },
      errors: universe.errors,
      caveat: universe.caveat,
      // La lista entera no se imprime por default: son ~600 símbolos que nadie
      // lee en una terminal y que tapan el diagnóstico, que es lo que sí se lee.
      sample: universe.symbols.slice(0, 20),
      refresh_days: REFRESH_DAYS,
      movers_max: MOVERS_MAX,
    };

    // ?emit=1 — los constituyentes, para MIRARLOS. La persistencia no depende de
    // esto: ya quedaron en Neon cuando se bajaron. El formato coincide con el de
    // data/universe/*.json por si algún día se quiere congelar un arranque en
    // frío, pero eso es opcional y nadie tiene que hacerlo para que B1 funcione.
    if (emit) {
      const [sp, nq] = await Promise.all([
        resolveConstituents('sp500', { now, force: false }),
        resolveConstituents('nasdaq100', { now, force: false }),
      ]);
      const snap = (r, index) => ({
        index, source: r.source, built_at: r.built_at, symbols: r.symbols,
        note: 'Snapshot generado por /api/arena-universe?emit=1. Respaldo de arranque en frío; la fuente viva es FMP con refresco semanal.',
      });
      out.constituents = { sp500: snap(sp, 'sp500'), nasdaq100: snap(nq, 'nasdaq100') };
      out.emit_hint = 'Esto es para MIRAR. No hay que guardarlo: la lista ya quedó en Neon (ver indices[].persisted) y el cron de las 13:00 UTC la refresca solo cada 7 días.';
    }

    // Si una lista vino FRESCA de FMP pero no se pudo escribir, la próxima
    // corrida la vuelve a pedir: no se rompe nada, pero se está pagando cuota de
    // más y conviene que se vea.
    const sinPersistir = Object.entries(universe.indices || {})
      .filter(([, v]) => v && v.refreshed && v.persisted === false).map(([k]) => k);
    if (sinPersistir.length) {
      out.persistence_warning = `No se pudo guardar en Neon: ${sinPersistir.join(', ')}. La lista de hoy sirve igual, pero mañana se va a volver a pedir a FMP en vez de leerse de la base.`;
    }

    out.verdict = universe.counts.admitidos === 0
      ? 'VACÍO: ningún nombre pasó. Revisá `errors` y `indices[].source` — el tablero va a caer a movers_only o a nada.'
      : `${universe.counts.admitidos} nombres (${universe.counts.indices} de índices + ${universe.counts.del_dia_nuevos} del día), fuente ${universe.universe_source}.` +
        (universe.admission.rejected_count ? ` ${universe.admission.rejected_count} rechazados por admisión (${universe.admission.data_unavailable} por falta de datos).` : '');

    await beat('arena:universe', universe.counts.admitidos ? 'ok' : 'empty', {
      source: universe.universe_source, admitidos: universe.counts.admitidos,
    });
    return res.status(200).json(out);
  } catch (err) {
    await beat('arena:universe', 'error', { error: String((err && err.message) || err) });
    return res.status(500).json({ error: 'arena-universe: ' + ((err && err.message) || 'unknown') });
  }
}
