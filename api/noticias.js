// ═══════════════════════════════════════════════════════════════════════
// /api/noticias — R3(b): los feeds a Neon, y de Neon a la pantalla.
//
//   GET /api/noticias                 → SOLO LEE. Lo último, para "lo de hoy".
//   GET /api/noticias?job=feeds       → ESCRIBE. Cosecha las fuentes GO.
//   GET /api/noticias?job=banxico     → ESCRIBE. Cambios de tasa desde el SIE.
//   GET /api/noticias?job=estado      → SOLO LEE. Qué fuente trajo qué y cuándo.
//   GET /api/noticias?vista=pagina     → SOLO LEE. Todo lo del artboard 9, de un
//                                        tirón: destacadas, las tres columnas,
//                                        los chips de fuente y los contadores.
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
import { filasDeFuente, dedupe, cambiosDeTasa, tickersDeFila } from './_lib/noticias.js';
import { armaPagina, chipsDeFuente, seccionesSinFuente, SECCIONES,
  imagenDeLaPagina, candidatasDeFoto } from './_lib/noticias-pagina.js';
import banxicoHandler from './banxico.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import { beat } from './_lib/heartbeat.js';

const TIMEOUT_FUENTE_MS = 5000;      // el encargo: 5 s por fuente
const PRESUPUESTO_MS = 45000;        // el job no se pasa de la función
const VENTANA_HORAS = 72;            // nada más viejo entra: "lo de hoy" es hoy
const UA = 'Mozilla/5.0 (compatible; QuantDesk/1.0; research@quantdesk.app)';

// Cuántas filas puede traer la página de un tirón. 400 son ~72 h de 21
// fuentes con margen: lo que no quepa se pide con `antes_de` ("cargar más").
export const TOPE_PAGINA = 400;

/**
 * LA CONSULTA DE LA PÁGINA DE NOTICIAS, exportada para probarla.
 *
 * Se exporta por lo mismo que `SQL_INSERTA_NOTICIAS`: el INSERT de este
 * archivo llegó a producción con un tipo mal ligado y la suite estaba verde,
 * porque ninguna prueba se la había dado a un Postgres de verdad. Una consulta
 * que vive dentro de un `await` no se puede PREPARAR desde una prueba.
 *
 * `($1 || ' hours')::interval` y no `interval '$1 hours'`: en la segunda forma
 * el parámetro está DENTRO del literal del intervalo y Postgres no lo liga.
 *
 * El cursor cambia la forma de la consulta —un `and` más y un $3—, así que es
 * un parámetro de la función y las dos formas se preparan en la prueba.
 */
export const SQL_PAGINA = (conCursor) => `
  select url, titular, fuente_id, fuente_nombre, tipo, idioma, seccion,
         publicado_en, imagen, imagen_via, imagen_leida_en, tickers, fuente_dato
    from mercado_noticias
   where publicado_en >= now() - ($1 || ' hours')::interval
     ${conCursor ? 'and publicado_en < $3' : ''}
   order by publicado_en desc
   limit $2`;

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
  // ── LA FOTO LEÍDA DE LA NOTA ────────────────────────────────────
  // `imagen_leida_en` es CUÁNDO se leyó esa URL, que es lo que la vuelve
  // citable: una foto puede cambiar o caerse y hay que poder decir de cuándo
  // es la que estamos enseñando.
  //
  // `imagen_intento_en` es la CACHÉ: marca que ya se fue a buscar. Sin ella,
  // cada corrida volvería a pedir la página de las mismas notas viejas que no
  // tienen og:image — 20 peticiones por corrida a los mismos medios, para
  // nada. Con ella, una nota se intenta UNA vez.
  `alter table mercado_noticias add column if not exists imagen_leida_en timestamptz`,
  `alter table mercado_noticias add column if not exists imagen_intento_en timestamptz`,
  `alter table mercado_noticias add column if not exists imagen_motivo text`,
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

/**
 * Las fuentes que se piden: las que el smoke de la Fase 0 dejó en GO Y que la
 * última cosecha no tumbó.
 *
 * SON DOS CAMPOS Y NO UNO A PROPÓSITO. `smoke` es una medición FECHADA —qué se
 * probó en septiembre y qué contestó— y reescribirla borraría el registro de
 * lo que se intentó. `cosecha` es lo último que dijo producción. Mantenerlos
 * separados distingue "nunca sirvió" de "servía y se cayó", que se arreglan
 * distinto: lo primero es buscar otra fuente, lo segundo es arreglar una URL.
 *
 * `yahoo_finance` es el primer caso: GO en septiembre, 404 el 2026-10-20.
 */
export function fuentesGo(registro = REGISTRO) {
  return (registro.fuentes || []).filter((f) =>
    f.smoke && f.smoke.veredicto === 'GO' && f.feed
    && !(f.cosecha && f.cosecha.veredicto && f.cosecha.veredicto !== 'GO'));
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

/**
 * El INSERT, exportado para que `tests/mercado-sql.test.mjs` lo PREPARE contra
 * un Postgres real. Con el texto en línea, "column tickers is of type text[]
 * but expression is of type text" sólo se veía corriendo el job contra
 * producción — que es exactamente como se vio (Lety, 2026-10-20).
 */
export const SQL_INSERTA_NOTICIAS =
      `insert into mercado_noticias
         (url, titular, titulo_norm, fuente_id, fuente_nombre, tipo, idioma, seccion,
          publicado_en, imagen, imagen_via, tickers, fuente_dato)
       select u.url, u.titular, u.titulo_norm, u.fuente_id, u.fuente_nombre, u.tipo,
              u.idioma, u.seccion, u.publicado_en, u.imagen, u.imagen_via,
              coalesce(string_to_array(nullif(u.tickers, ''), ','), '{}')::text[],
              u.fuente_dato
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                     $6::text[], $7::text[], $8::text[], $9::timestamptz[],
                     $10::text[], $11::text[], $12::text[], $13::text[])
              as u(url, titular, titulo_norm, fuente_id, fuente_nombre, tipo, idioma,
                   seccion, publicado_en, imagen, imagen_via, tickers, fuente_dato)
       on conflict (url) do nothing`;

async function guarda(filas) {
  if (!filas.length) return 0;
  // `on conflict do nothing`: una nota que ya estaba NO se reescribe. Su
  // `publicado_en` es el de la primera vez que se vio, que es cuando pasó el
  // hecho; pisarlo con la hora del eco la subiría sola a lo más reciente.
  const lotes = [];
  for (let i = 0; i < filas.length; i += 50) {
    const t = filas.slice(i, i + 50);
    lotes.push([
      SQL_INSERTA_NOTICIAS,
      [
        t.map((f) => f.url), t.map((f) => f.titular), t.map((f) => f.titulo_norm),
        t.map((f) => f.fuente_id), t.map((f) => f.fuente_nombre || null),
        t.map((f) => f.tipo || null), t.map((f) => f.idioma || null), t.map((f) => f.seccion || null),
        t.map((f) => f.publicado_en), t.map((f) => f.imagen || null), t.map((f) => f.imagen_via || null),
        t.map((f) => (f.tickers || []).join(',')), t.map((f) => f.fuente_dato || null),
      ],
    ]);
  }
  await sqlBatch(lotes);
  return filas.length;
}

// ═══════════════════════════════════════════════════════════════════════
// LA COSECHA DE FOTOS
//
// Lety, 2026-10-22: en el iPhone, una destacada sin foto salía como un bloque
// de color con el nombre del medio y se veía mal. La foto ahora se lee de la
// propia nota (`og:image`), que es la que el medio publica para que su enlace
// se vea bien al compartirlo.
//
// LOS TOPES, que no son decoración:
//   · ~20 notas por corrida, elegidas como las elige la pantalla (una por
//     fuente antes que dos de la misma). Pedir las 300 sería 300 peticiones a
//     ocho dominios por corrida: así es como un medio nos bloquea;
//   · 4 s por página y 8 s para el paso entero. El job tiene un presupuesto y
//     las fotos son lo ÚLTIMO que se hace: si no alcanza, no se hace y la
//     cosecha de titulares no se ve afectada;
//   · 256 KB por página. Sólo hace falta la cabecera; un artículo entero con
//     sus scripts pesa megabytes y nada de eso se mira;
//   · un intento por nota, para siempre. La marca queda en la tabla aunque no
//     haya foto: es la caché, y sin ella cada corrida repetiría las mismas
//     peticiones fallidas.
// ═══════════════════════════════════════════════════════════════════════
export const FOTOS_POR_CORRIDA = 20;
const FOTO_TIMEOUT_MS = 4000;
const FOTO_PRESUPUESTO_MS = 8000;
const FOTO_MAX_BYTES = 256 * 1024;
const FOTO_A_LA_VEZ = 5;
// Se dice quiénes somos. Un `User-Agent` de navegador fingido es mentirle al
// medio sobre quién está pidiendo; uno propio deja que nos bloqueen si no nos
// quieren, que es su derecho.
export const FOTO_UA = 'QuantDeskBot/1.0 (+https://quantdesk.app; lector de og:image para enlazar la nota)';

/** La cabecera de una página, acotada en tiempo y en bytes. */
export async function cabeceraDe(url, { fetchImpl = fetch, timeoutMs = FOTO_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': FOTO_UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!r.ok) return { html: null, motivo: `la nota respondió HTTP ${r.status}` };
    const tipo = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    if (tipo && !/html|xml/i.test(tipo)) return { html: null, motivo: `la nota no devolvió HTML (${tipo.split(';')[0]})` };
    // Se lee de a pedazos y se corta: el `<head>` viene al principio.
    if (r.body && typeof r.body.getReader === 'function') {
      const lector = r.body.getReader();
      const dec = new TextDecoder();
      let texto = ''; let bytes = 0;
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        bytes += value.byteLength;
        texto += dec.decode(value, { stream: true });
        if (bytes >= FOTO_MAX_BYTES || /<\/head>/i.test(texto)) { try { await lector.cancel(); } catch { /* ya cerrado */ } break; }
      }
      return { html: texto, motivo: null };
    }
    const texto = await r.text();
    return { html: texto.slice(0, FOTO_MAX_BYTES), motivo: null };
  } catch (e) {
    return { html: null, motivo: e && e.name === 'AbortError'
      ? `la nota no contestó en ${timeoutMs} ms` : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

async function cosechaFotos({ t0, fetchImpl = fetch } = {}) {
  const candidatas = candidatasDeFoto(await sql(`
    select url, fuente_id, publicado_en
      from mercado_noticias
     where imagen is null
       and imagen_intento_en is null
       and publicado_en >= now() - interval '48 hours'
     order by publicado_en desc
     limit 80`, []), { cuantas: FOTOS_POR_CORRIDA });
  if (!candidatas.length) return { pedidas: 0, con_foto: 0, sin_foto: 0, ms: 0 };

  const tF = Date.now();
  const resultados = [];
  for (let i = 0; i < candidatas.length; i += FOTO_A_LA_VEZ) {
    if (Date.now() - tF > FOTO_PRESUPUESTO_MS) break;
    const tanda = candidatas.slice(i, i + FOTO_A_LA_VEZ);
    resultados.push(...await Promise.all(tanda.map(async (n) => {
      const { html, motivo } = await cabeceraDe(n.url, { fetchImpl });
      if (!html) return { url: n.url, imagen: null, via: null, motivo };
      const img = imagenDeLaPagina(html, n.url);
      return { url: n.url, imagen: img.url, via: img.via, motivo: img.motivo };
    })));
  }

  // El intento se marca SIEMPRE, con foto o sin ella: es la caché.
  await sqlBatch(resultados.map((r) => ([
    `update mercado_noticias
        set imagen = coalesce($2, imagen),
            imagen_via = case when $2 is null then imagen_via else $3 end,
            imagen_leida_en = case when $2 is null then imagen_leida_en else now() end,
            imagen_intento_en = now(),
            imagen_motivo = $4
      where url = $1`,
    [r.url, r.imagen, r.via, r.motivo],
  ])));

  return {
    pedidas: resultados.length,
    con_foto: resultados.filter((r) => r.imagen).length,
    sin_foto: resultados.filter((r) => !r.imagen).length,
    sin_pedir: candidatas.length - resultados.length,
    ms: Date.now() - tF,
  };
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

  // LAS FOTOS VAN AL FINAL, y sólo si sobró presupuesto. Los titulares son
  // lo que la pantalla necesita para existir; la foto es lo que la hace
  // mirable. Si hay que sacrificar una, es la foto.
  let fotos = { pedidas: 0, sin_pedir: null, motivo: 'no alcanzó el presupuesto de la corrida' };
  if (Date.now() - t0 < PRESUPUESTO_MS) {
    try { fotos = await cosechaFotos({ t0 }); } catch (e) { fotos = { pedidas: 0, error: String((e && e.message) || e) }; }
  }

  return {
    job: 'feeds',
    fuentes: fuentes.length,
    fotos,
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
      const out = await jobFeeds({ t0, max: Number(q.max) || 0 });
      // Que una fuente esté caída es NORMAL y no es una falla del job. Que
      // estén caídas TODAS, o que no se haya podido guardar nada teniendo
      // notas, sí: eso es el job roto y tiene que verse como roto.
      const todasCaidas = out.fuentes > 0 && out.caidas.length === out.fuentes;
      const noGuardo = out.unicas > 0 && out.guardadas === 0;
      if (todasCaidas || noGuardo) {
        out.error = todasCaidas
          ? `las ${out.fuentes} fuentes fallaron`
          : `se leyeron ${out.unicas} notas y no se guardó ninguna`;
        return res.status(500).json(out);
      }
      return res.status(200).json(out);
    }
    if (job === 'banxico') {
      res.setHeader('Cache-Control', 'no-store');
      const out = await jobBanxico({ t0 });
      return res.status(out.error ? 500 : 200).json(out);
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

    // ── LECTURA: LA PÁGINA DE NOTICIAS (R3b, artboard 9) ──────────────
    // UNA sola llamada para toda la pantalla (regla 7). El filtrado por
    // sección, idioma, fuente y búsqueda ocurre en el servidor y no en la
    // página: así la URL es el estado (regla 9) y una vista pegada en WhatsApp
    // abre con el mismo contenido para quien la recibe.
    if (q.vista === 'pagina') {
      await ensureSchema();
      // La ventana por default es la misma de "lo de hoy" —72 h— porque las
      // dos vistas leen la MISMA tabla y el encargo pide una sola fuente de
      // verdad. Se puede ensanchar a 7 días por query, no más: lo que no
      // cosechó el cron no existe, y pedir 30 días sólo haría que la pantalla
      // dijera "no hay nada" sobre un hueco de recolección.
      const horas = Math.min(Math.max(Number(q.horas) || VENTANA_HORAS, 1), 168);
      const porColumna = Math.min(Math.max(Number(q.por_columna) || 30, 5), 100);
      // `antes_de` es el cursor de "cargar más": la hora de la última nota que
      // el lector ya tiene. Con ISO inválido se ignora en vez de romper.
      const antesDe = (() => {
        const d2 = q.antes_de ? new Date(String(q.antes_de)) : null;
        return d2 && Number.isFinite(d2.getTime()) ? d2.toISOString() : null;
      })();
      const [filas, corridas] = await Promise.all([
        sql(SQL_PAGINA(!!antesDe),
          antesDe ? [String(horas), TOPE_PAGINA, antesDe] : [String(horas), TOPE_PAGINA])
          .catch((e) => ({ error: e })),
        sql(`select fuente_id, ultima_corrida, ok, motivo, leidas, guardadas
               from mercado_noticias_fuentes`).catch(() => []),
      ]);
      // UNA LECTURA QUE FALLA NO SE PINTA COMO "NO HAY NOTICIAS". Es la cicatriz
      // del mapa: cero filas por un error se leía igual que un día sin notas, y
      // la pantalla afirmaba algo falso. Acá el error viaja y la pantalla lo dice.
      const error = filas && filas.error ? String((filas.error && filas.error.message) || filas.error) : null;
      const notas = error ? [] : (filas || []).map((n) => ({ ...n, tickers: tickersDeFila(n.tickers) }));
      const go = fuentesGo();
      const armado = armaPagina(notas, {
        seccion: q.seccion || 'todo',
        idioma: q.idioma === 'es' ? 'es' : 'todo',
        q: q.q || '',
        fuente: q.fuente || null,
        orden: q.orden === 'fuente' ? 'fuente' : 'hora',
        porColumna,
      });
      res.setHeader('Cache-Control', notas.length ? 's-maxage=120, stale-while-revalidate=600' : 'no-store');
      return res.status(200).json({
        vista: 'pagina',
        ...armado,
        error,
        // Qué se pidió, devuelto tal cual: la pantalla pinta el estado de los
        // toggles desde la respuesta y no desde su propia memoria, así que un
        // parámetro ignorado se ve en la pantalla en vez de esconderse.
        filtros: {
          seccion: q.seccion || 'todo',
          idioma: q.idioma === 'es' ? 'es' : 'todo',
          orden: q.orden === 'fuente' ? 'fuente' : 'hora',
          q: q.q || '',
          fuente: q.fuente || null,
          horas,
          antes_de: antesDe,
        },
        secciones: SECCIONES,
        secciones_sin_fuente: seccionesSinFuente(go),
        fuentes: chipsDeFuente(go, corridas),
        leidas: notas.length,
        tope: TOPE_PAGINA,
        generado_en: new Date().toISOString(),
        fuente: 'neon:mercado_noticias (titulares de los feeds RSS/Atom de las fuentes registradas)',
        ms: Date.now() - t0,
      });
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
      // `tickers` sale del driver como el literal de Postgres (`{NVDA,ORCL}`),
      // no como arreglo. Se normaliza ACÁ y no en la pantalla: la API promete
      // un arreglo, y R3b y `/analiza` van a leer de esta misma tabla.
      noticias: filas.map((n) => ({ ...n, tickers: tickersDeFila(n.tickers) })),
      fuentes_caidas: caidas,
      fuentes_go: fuentesGo().length,
      generado_en: new Date().toISOString(),
      // Regla 5: de dónde salió lo que se está viendo.
      fuente: 'neon:mercado_noticias (titulares de los feeds RSS/Atom de las fuentes registradas)',
      ms: Date.now() - t0,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    // UN JOB QUE FALLA RESPONDE 5xx. Con 200 y un `error` dentro, el cron de
    // Vercel y `cron-status` lo cuentan como una corrida buena: el job llevaba
    // días tronando al guardar y la vigilancia decía que todo iba bien (Lety,
    // 2026-10-20). Un 200 es una promesa, y una promesa falsa sobre el estado
    // del sistema es peor que el error que la causó.
    //
    // La LECTURA sí se queda en 200 con la lista vacía: ahí el llamador es la
    // pantalla, y un 500 le quitaría la sección entera en vez de dejarle decir
    // qué pasó. Son dos consumidores con necesidades opuestas.
    const esJob = job === 'feeds' || job === 'banxico' || job === 'estado';
    return res.status(esJob ? 500 : 200)
      .json({ job: job || 'leer', error: String((e && e.stack) || e), ms: Date.now() - t0 });
  }
}
