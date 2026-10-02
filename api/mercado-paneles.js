// ═══════════════════════════════════════════════════════════════════════
// /api/mercado-paneles — UN batch para los paneles de R3 que no salen del mapa.
//
//   GET /api/mercado-paneles → { esta_semana: {...}, arena: {...} }
//
// POR QUÉ UN ENDPOINT Y NO TRES FETCHES DEL NAVEGADOR. Regla 7 del encargo: un
// batch por pantalla, nada de una petición por pieza. Las tres fuentes se piden
// acá —en paralelo, desde un sitio con buena red— y la respuesta se cachea en
// el CDN para toda la base de usuarios: un teléfono en 4G hace UNA petición y
// recibe lo que ya estaba calentito.
//
// NINGUNA FUENTE PUEDE TUMBAR LA PANTALLA, Y NINGUNA SE CALLA. Cada una va con
// su `catch` y su motivo: una fuente caída sale como `ok:false` con el texto del
// error, nunca como una lista vacía. Son dos cosas distintas y se arreglan
// distinto — "Finnhub devolvió 429" manda a esperar, "no hay reportes" manda a
// mirar otra semana.
//
// EL CACHÉ VA SEGÚN QUÉ PASÓ. Si alguna fuente falló, la respuesta NO se cachea:
// quedarse cinco minutos sirviendo un error que ya pasó es peor que pedirlo otra
// vez. Mismo criterio que `/api/mercado-mapa`.
//
// Cero IA (regla 6) y cero cálculo de porcentajes: lo que viaja ya lo midió
// quien lo mide.
// ═══════════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { armaEstaSemana, armaArena, ventanaSemana } from './_lib/mercado-paneles.js';

const TIMEOUT_MS = 5000;

/** El origen de esta misma app, para los endpoints que ya existen. */
function origenDe(req) {
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
  return host ? `${proto}://${host}` : null;
}

async function pedir(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { json: await r.json() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const ahora = new Date();
  const v = ventanaSemana(ahora);
  const origen = origenDe(req);

  // Los reportes y Arena se piden a nuestros propios endpoints en vez de
  // reimplementar su lógica: `?mega=1` ya sabe qué es una mega-cap y el
  // leaderboard ya sabe qué es el rendimiento de un agente. Dos definiciones
  // del mismo número es exactamente lo que este repo evita en todas partes.
  const [macro, reportes, arena] = await Promise.all([
    // El calendario macro es una tabla nuestra: se lee directo, sin salto.
    sql(`select to_char(event_date,'YYYY-MM-DD') as event_date, title, category, importance, note
           from macro_events
          where event_date >= $1::date and event_date <= $2::date
          order by event_date asc, importance desc, title asc
          limit 60`, [v.desde, v.hasta])
      .then((filas) => ({ filas }))
      .catch((e) => ({ error: String((e && e.message) || e) })),
    origen
      ? pedir(`${origen}/api/earnings?mega=1`).then((r) => (r.error ? r : { filas: (r.json && r.json.earnings) || [] }))
      : Promise.resolve({ error: 'no se pudo resolver el origen para pedir el calendario de reportes' }),
    origen
      ? pedir(`${origen}/api/leaderboard`).then((r) => (r.error ? r : { agents: (r.json && r.json.agents) || [] }))
      : Promise.resolve({ error: 'no se pudo resolver el origen para pedir el leaderboard' }),
  ]);

  const body = {
    esta_semana: armaEstaSemana({ macro, reportes, ahora }),
    arena: armaArena(arena),
    generado_en: ahora.toISOString(),
    ms: Date.now() - t0,
  };

  const algoFallo = !body.esta_semana.fuentes.macro.ok
    || !body.esta_semana.fuentes.reportes.ok
    || !!body.arena.motivo;
  res.setHeader('Cache-Control', algoFallo
    ? 'no-store'
    : 's-maxage=300, stale-while-revalidate=900');
  return res.status(200).json(body);
}
