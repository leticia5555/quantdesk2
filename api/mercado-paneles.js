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
import { armaEstaSemana, armaArena, ventanaSemana, DIAS_HORIZONTE } from './_lib/mercado-paneles.js';
import earningsHandler from './earnings.js';
import leaderboardHandler from './leaderboard.js';

// ═══════════════════════════════════════════════════════════════════════
// LOS OTROS ENDPOINTS SE LLAMAN EN PROCESO, NO POR HTTP
//
// La primera versión pedía `https://<host>/api/earnings?mega=1` y
// `/api/leaderboard` con `fetch`. En el preview eso devolvía **401**: Vercel
// protege los despliegues de preview, así que el servidor no puede llamarse a
// sí mismo por URL — se topa con su propia puerta. Lo encontró Lety
// (2026-10-05), y en producción habría sido igual de frágil: un salto de red
// que sale y vuelve a la misma máquina, con su latencia, su timeout y su
// autenticación, para leer algo que está en el mismo proceso.
//
// Ahora se invoca el handler directo con un `res` de mentira. Se gana lo mismo
// que se buscaba —UNA sola definición de cada cosa: `?mega=1` sabe qué es una
// mega-cap y el leaderboard sabe qué es el rendimiento de un agente— sin red,
// sin auth y sin timeout. Es el mismo patrón con el que `tests/earnings.test.mjs`
// prueba ese handler, así que la forma ya estaba probada.
//
// Lo que NO cambia: si el handler lanza o contesta un código que no es 200, eso
// viaja como motivo. Una fuente caída se dice; nunca se vuelve lista vacía.
// ═══════════════════════════════════════════════════════════════════════
// El tope de espera por fuente. Lo traía el `fetch` que se fue (con su
// `AbortController`) y hace falta igual sin red: el leaderboard habla con
// Alpaca y los reportes con Finnhub, así que una fuente lenta puede colgarse.
// Sin tope, la que se cuelga se lleva la pantalla entera hasta el timeout de la
// función; con tope, se cuelga ella sola y lo dice.
//
// NO CANCELA el trabajo de abajo —no se puede abortar un handler a medio
// camino— pero sí deja de esperarlo, que es lo que la pantalla necesita.
export const TOPE_FUENTE_MS = 6000;

export async function enProceso(handler, query = {}, { topeMs = TOPE_FUENTE_MS } = {}) {
  let code = 200;
  let body = null;
  const res = {
    setHeader() {}, getHeader() { return undefined; },
    status(c) { code = c; return this; },
    json(o) { body = o; return this; },
    send(o) { body = o; return this; },
    end() { return this; },
  };
  let temporizador = null;
  try {
    const corrida = Promise.resolve(handler({ method: 'GET', query, headers: {}, url: '/' }, res));
    const tope = new Promise((_, rechaza) => {
      temporizador = setTimeout(() => rechaza(new Error(`no contestó en ${topeMs} ms`)), topeMs);
    });
    await Promise.race([corrida, tope]);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    // Sin esto el temporizador mantiene viva la función después de responder.
    if (temporizador) clearTimeout(temporizador);
  }
  if (code !== 200) return { error: `el handler respondió ${code}` };
  return { json: body };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const ahora = new Date();
  const v = ventanaSemana(ahora);
  // EL HORIZONTE, NO LA VENTANA. Se pide un mes y se pinta una semana: así la
  // pantalla puede decir "sin eventos esta semana · 9 más adelante" en vez de
  // tirar nueve filas en silencio. `/api/earnings` sin fechas ya trae 30 días,
  // y el calendario macro se pide con el mismo horizonte para que las dos
  // mitades se midan igual.
  const horizonte = ventanaSemana(ahora, DIAS_HORIZONTE);

  const [macro, reportes, arena] = await Promise.all([
    // El calendario macro es una tabla nuestra: se lee directo.
    sql(`select to_char(event_date,'YYYY-MM-DD') as event_date, title, category, importance, note
           from macro_events
          where event_date >= $1::date and event_date <= $2::date
          order by event_date asc, importance desc, title asc
          limit 200`, [horizonte.desde, horizonte.hasta])
      .then((filas) => ({ filas }))
      .catch((e) => ({ error: String((e && e.message) || e) })),
    enProceso(earningsHandler, { mega: '1' })
      .then((r) => (r.error ? r : { filas: (r.json && r.json.earnings) || [] })),
    enProceso(leaderboardHandler)
      .then((r) => (r.error ? r : { agents: (r.json && r.json.agents) || [] })),
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
