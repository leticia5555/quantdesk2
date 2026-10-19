// ═══════════════════════════════════════════════════════════════════════
// /api/noticias — R3(b): los feeds a Neon, y de Neon a la pantalla.
//
//   GET /api/noticias                 → SOLO LEE. Lo último, para "lo de hoy".
//   GET /api/noticias?job=feeds       → ESCRIBE. Cosecha las fuentes GO.
//   GET /api/noticias?job=banxico     → ESCRIBE. Cambios de tasa desde el SIE.
//   GET /api/noticias?job=estado      → SOLO LEE. Qué fuente trajo qué y cuándo.
//
// TRES REGLAS QUE ESTE ARCHIVO NO PUEDE ROMPER:
//
//   1. NUNCA SE GUARDA NI SE MUESTRA EL CUERPO. Titular, fuente, hora y link.
//      Lo demás es republicar, y eso no es lo que esta sección hace.
//   2. CERO IA (regla 6). Los tickers salen de cruzar el titular contra el
//      catálogo que ya existe, con lista de exclusión. Nada se clasifica ni se
//      resume con un modelo.
//   3. UNA FUENTE CAÍDA NO TUMBA LA PÁGINA NI SE CALLA. Cada feed va con su
//      timeout y su `catch`; la que falla queda marcada con su motivo y la
//      pantalla lo pinta. "No contestó" y "no publicó nada" son dos cosas
//      distintas y se arreglan distinto.
//
// El job es REANUDABLE y acotado por tiempo, como los demás de este repo: si
// el presupuesto se acaba, deja dicho por dónde iba en vez de morir a medias.
// ═══════════════════════════════════════════════════════════════════════

import { sql, sqlBatch, ensureSchema as ensureBase } from './_lib/db.js';
import REGISTRO from './_lib/news-sources.json' with { type: 'json' };
import { filasDeFuente, dedupe, cambiosDeTasa } from './_lib/noticias.js';
import banxicoHandler from './banxico.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import { beat } from './_lib/heartbeat.js';

const TIMEOUT_FUENTE_MS = 5000;      // el encargo: 5 s por fuente
const PRESUPUESTO_MS = 45000;        // el job no se pasa de la función
const VENTANA_HORAS = 72;            // nada más viejo entra: "lo de hoy" es hoy
const UA = 'Mozilla/5.0 (compatible; QuantDesk/1.0; research@quantdesk.app)';

export const SCHEMA_NOTICIAS = [
  `create table if not exists mercado_noticias (
     url            text primary key,
     titular        text not null,
     titulo_norm    text not null,
     fuente_id      text not null,
     fuente_nombre  text,
     tipo           text,
     idioma         text,
     seccion        text,
     publicado_en   timestamptz not null,
     imagen         text,
     imagen_via     text,
     tickers        text[],
     fuente_dato    text,
     visto_en       timestamptz not null default now()
   )`,
  // Por fecha: "lo de hoy" siempre pide lo último y nada más.
  `create index if not exists mercado_noticias_fecha_idx
     on mercado_noticias (publicado_en desc)`,
  // El dedupe por TITULAR necesita su propio índice: sin él, cada inserción
  // escanea la tabla entera para saber si el hecho ya estaba.
  `create index if not exists mercado_noticias_titulo_idx
     on mercado_noticias (titulo_norm)`,
  `create table if not exists mercado_noticias_fuentes (
     fuente_id      text primary key,
     ultima_corrida timestamptz,
     ok             boolean,
     motivo         text,
     leidas         int,
     guardadas      int
   )`,
];

let listo = false;
async function ensureSchema() {
  if (listo) return;
  await ensureBase();
  await sqlBatch(SCHEMA_NOTICIAS.map((q) => [q, []]));
  listo = true;
}

/** Las fuentes que el smoke del punto 0.10 dejó en GO, con su URL ganadora. */
export function fuentesGo(registro = REGISTRO) {
  return (registro.fuentes || []).filter(
    (f) => f.smoke && f.smoke.veredicto === 'GO' && f.feed);
}

async function pedirFeed(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_FUENTE_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!r.ok) {
      // El 403 se nombra: es el caso Cloudflare, que se arregla cambiando de
      // fuente o metiendo proxy, no corrigiendo una URL.
      return { error: r.status === 403 ? 'HTTP 403 (bloqueo de datacenter)' : `HTTP ${r.status}` };
    }
    return { xml: await r.text() };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? `no contestó en ${TIMEOUT_FUENTE_MS} ms` : String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * El catálogo para los chips: lo que YA está en el mapa, sin pedir nada nuevo.
 * EE.UU. sale de la tabla del universo y México de `emisoras.json`, que es la
 * misma semilla que usa el mapa — así un chip no puede llevar a una emisora
 * que la pantalla no sabe dibujar.
 */
async function catalogoDeTickers() {
  const us = await sql('select symbol, nombre from mercado_universo_us where sector_etf is not null').catch(() => []);
  const mx = (EMISORAS.emisoras || []).map((e) => ({ symbol: e.clave, nombre: e.nombre }));
  return [...us.map((r) => ({ symbol: r.symbol, nombre: r.nombre })), ...mx];
}

async function guarda(filas) {
  if (!filas.length) return 0;
  // `on conflict do nothing`: una nota que ya estaba NO se reescribe. Su
  // `publicado_en` es el de la primera vez que se vio, que es cuando pasó el
  // hecho; pisarlo con la hora del eco la subiría sola a lo más reciente.
  const lotes = [];
  for (let i = 0; i < filas.length; i += 50) {
    const t = filas.slice(i, i + 50);
    lotes.push([
      `insert into mercado_noticias
         (url, titular, titulo_norm, fuente_id, fuente_nombre, tipo, idioma, seccion,
          publicado_en, imagen, imagen_via, tickers, fuente_dato)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                            $6::text[], $7::text[], $8::text[], $9::timestamptz[],
                            $10::text[], $11::text[], $12::text[][], $13::text[])
       on conflict (url) do nothing`,
      [
        t.map((f) => f.url), t.map((f) => f.titular), t.map((f) => f.titulo_norm),
        t.map((f) => f.fuente_id), t.map((f) => f.fuente_nombre || null),
        t.map((f) => f.tipo || null), t.map((f) => f.idioma || null), t.map((f) => f.seccion || null),
        t.map((f) => f.publicado_en), t.map((f) => f.imagen || null), t.map((f) => f.imagen_via || null),
        t.map((f) => f.tickers || []), t.map((f) => f.fuente_dato || null),
      ],
    ]);
  }
  await sqlBatch(lotes);
  return filas.length;
}

async function jobFeeds({ t0, max }) {
  await ensureSchema();
  const fuentes = fuentesGo().slice(0, max || undefined);
  const catalogo = await catalogoDeTickers();
  const ahora = new Date();
  const estados = [];
  const todas = [];
  let corte = null;

  // TODAS EN PARALELO, como pide el encargo. Son 22 peticiones a dominios
  // distintos: en serie, a 5 s de timeout cada una, el peor caso son 110 s y
  // la función muere antes. En paralelo el peor caso son los mismos 5 s.
  const respuestas = await Promise.all(fuentes.map(async (f) => {
    if (Date.now() - t0 > PRESUPUESTO_MS) return { f, r: { error: 'no alcanzó el presupuesto de la corrida' } };
    return { f, r: await pedirFeed(f.feed) };
  }));

  for (const { f, r } of respuestas) {
    const est = filasDeFuente(f, r, { ahora, catalogo, maxHoras: VENTANA_HORAS });
    estados.push(est);
    for (const fila of est.filas) todas.push(fila);
    if (Date.now() - t0 > PRESUPUESTO_MS && !corte) corte = f.id;
  }

  const d = dedupe(todas);
  const guardadas = await guarda(d.filas);

  await sqlBatch(estados.map((e) => ([
    `insert into mercado_noticias_fuentes (fuente_id, ultima_corrida, ok, motivo, leidas, guardadas)
     values ($1, now(), $2, $3, $4, $5)
     on conflict (fuente_id) do update set
       ultima_corrida = excluded.ultima_corrida, ok = excluded.ok,
       motivo = excluded.motivo, leidas = excluded.leidas, guardadas = excluded.guardadas`,
    [e.id, !e.caida, e.motivo, e.leidas || 0, e.filas.length],
  ])));

  // El latido dice "el job corrió", no "trajo notas": una cosecha en la que
  // todas las fuentes estaban caídas corrió igual, y eso se ve en `caidas`.
  await beat('mercado:noticias', estados.some((e) => !e.caida) ? 'ok' : 'error', {
    fuentes: fuentes.length, caidas: estados.filter((e) => e.caida).length,
    leidas: todas.length, guardadas,
  }).catch(() => {});

  return {
    job: 'feeds',
    fuentes: fuentes.length,
    caidas: estados.filter((e) => e.caida).map((e) => ({ id: e.id, motivo: e.motivo })),
    leidas: todas.length,
    duplicadas_url: d.duplicadas_url,
    duplicadas_titulo: d.duplicadas_titulo,
    unicas: d.filas.length,
    guardadas,
    corte,
    ms: Date.now() - t0,
  };
}

async function jobBanxico({ t0 }) {
  await ensureSchema();
  // En proceso, no por HTTP: el servidor no puede llamarse a sí mismo por URL
  // —en preview se topa con su propia puerta y da 401— y además `/api/banxico`
  // ya sabe hablar con el SIE, con su token y su caché.
  let code = 200;
  let body = null;
  const res = { setHeader() {}, status(c) { code = c; return this; }, json(o) { body = o; return this; }, end() { return this; } };
  try {
    await banxicoHandler({ method: 'GET', query: { series: 'POLICY', days: '400' }, headers: {} }, res);
  } catch (e) {
    return { job: 'banxico', error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
  if (code !== 200 || !body || !Array.isArray(body.points)) {
    return { job: 'banxico', error: `el SIE no devolvió la serie (código ${code})`, ms: Date.now() - t0 };
  }
  const filas = cambiosDeTasa(body.points);
  const guardadas = await guarda(filas);
  // Cero cambios es un resultado CORRECTO —la tasa no se movió—, así que el
  // latido va en ok: decir error haría sonar una alarma cada mes tranquilo.
  await beat('mercado:banxico', 'ok', { puntos: body.points.length, cambios: filas.length, guardadas }).catch(() => {});
  return { job: 'banxico', puntos: body.points.length, cambios: filas.length, guardadas, ms: Date.now() - t0 };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const q = (req && req.query) || {};
  const job = String(q.job || '').toLowerCase();

  try {
    if (job === 'feeds') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await jobFeeds({ t0, max: Number(q.max) || 0 }));
    }
    if (job === 'banxico') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await jobBanxico({ t0 }));
    }
    if (job === 'estado') {
      await ensureSchema();
      const filas = await sql(
        `select f.fuente_id, f.ultima_corrida, f.ok, f.motivo, f.leidas, f.guardadas,
                (select count(*)::int from mercado_noticias n where n.fuente_id = f.fuente_id) as en_tabla
           from mercado_noticias_fuentes f order by f.ok nulls first, f.fuente_id`).catch(() => []);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ job: 'estado', solo_lectura: true, fuentes: filas, registradas: fuentesGo().length });
    }

    // ── LECTURA: "lo de hoy" ──────────────────────────────────────────
    await ensureSchema();
    const limite = Math.min(Math.max(Number(q.limite) || 30, 1), 100);
    const [filas, caidas] = await Promise.all([
      sql(`select url, titular, fuente_id, fuente_nombre, tipo, idioma, seccion,
                  publicado_en, imagen, tickers, fuente_dato
             from mercado_noticias
            where publicado_en >= now() - interval '72 hours'
            order by publicado_en desc limit $1`, [limite]).catch(() => []),
      // Las caídas viajan CON la lista: una sección corta sin decir que medio
      // mundo no contestó se lee como "no pasó nada hoy".
      sql(`select fuente_id, motivo from mercado_noticias_fuentes where ok = false`).catch(() => []),
    ]);
    res.setHeader('Cache-Control', filas.length ? 's-maxage=120, stale-while-revalidate=600' : 'no-store');
    return res.status(200).json({
      noticias: filas,
      fuentes_caidas: caidas,
      fuentes_go: fuentesGo().length,
      generado_en: new Date().toISOString(),
      // Regla 5: de dónde salió lo que se está viendo.
      fuente: 'neon:mercado_noticias (RSS/Atom de api/_lib/news-sources.json)',
      ms: Date.now() - t0,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ job: job || 'leer', error: String((e && e.stack) || e), ms: Date.now() - t0 });
  }
}
