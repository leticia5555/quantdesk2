// ═══════════════════════════════════════════════════════════════
// api/_lib/edgar.js — el transporte de HISTORIA contra EDGAR.
//
// Un solo lugar que respeta lo que la SEC exige y lo que nosotros nos
// prometimos: User-Agent descriptivo, techo de 10 req/s, y CERO datos que no
// puedan citarse. Acá no se interpreta nada — no hay familias, ni Q4, ni
// items de 8-K. Esto baja bytes y los entrega tal cual; la lectura es de la
// capa de ingesta (Fase A, rebanada C).
//
// ── POR QUÉ EXISTE, SI YA HAY CÓDIGO QUE LE PEGA A SEC ──────────────
// Ocho archivos de este repo le pegan a sec.gov, cada uno con su fetch:
// api/sec-edgar.js, api/stock-tracker.js, api/vc-feed.js, api/arena-run.js,
// api/_lib/arena-buffet-cache.js, api/_lib/arena-watch-events.js,
// api/_lib/pead-hour.js y la sonda de la Fase 0. **Ninguno limita su tasa de
// salida.** Que hoy no nos hayamos ganado un 429 no es un diseño, es una
// racha: el tope de la SEC es por IP de origen y se comparte entre todos.
//
// Este módulo NO los migra. Tres de ellos son del Arena y están fuera de
// alcance por decisión explícita; migrar los otros es un PR con su propio
// riesgo, no un efecto colateral del módulo de Historia. Lo que sí hace es
// dejar de agregar un noveno cliente sin freno, y quedar listo para que esa
// migración sea un cambio de import.
//
// ── LA HONESTIDAD DEL LIMITADOR: ES POR INSTANCIA ───────────────────
// Misma limitación declarada que api/_lib/rate-limit.js, y por la misma
// razón: el bucket vive en la memoria del proceso. En Vercel hay N lambdas
// calientes y el tope de la SEC es de la IP, no del proceso — así que este
// limitador gobierna NUESTRAS ráfagas dentro de una instancia, no el total
// del despliegue. Dos consecuencias que se asumen a ojos abiertos:
//
//   · El default va en 6 req/s, no en 10. El margen no es timidez: es el
//     espacio para los otros siete clientes que comparten la IP.
//   · Donde el limitador SÍ es garantía es en la ingesta: un job largo y de
//     un solo proceso, que es exactamente el caso que más pega.
//
// Si algún día hace falta un tope global de verdad, el upgrade es el mismo
// que documenta rate-limit.js: un contador compartido (Upstash/Neon).
//
// ── EL ESPACIADO ES UNA CADENA DE PROMESAS, NO UN `lastCall` ────────
// La sonda de la Fase 0 espacia con `wait = THROTTLE - (now - lastCall)`.
// Es correcto ahí porque corre secuencial. Bajo concurrencia tiene una
// carrera: dos llamadas que entran juntas leen el MISMO `lastCall`, calculan
// la MISMA espera y salen juntas — el limitador reporta 6 req/s y la SEC ve
// 12. Acá cada turno se encadena al anterior, así que el espaciado se
// sostiene aunque el llamador dispare 20 en paralelo. Está testeado.
//
// ── EL SEAM: `fetch` ENTRA POR PARÁMETRO ────────────────────────────
// El contenedor donde se construye la Fase A tiene el egress a *.sec.gov
// cerrado por política de la organización (docs/historia-fase0.md §0, §10).
// Eso no es una molestia de logística: decide el diseño. El cliente recibe su
// `fetch`, su reloj y su `dormir`, así que la suite prueba reintentos,
// esperas y backoff sin red y sin esperar de verdad. En producción los
// defaults son los reales.
//
// ENV VARS (todas opcionales):
//   SEC_USER_AGENT      → UA descriptivo. Default: el de la sonda.
//   SEC_REQ_POR_SEGUNDO → techo propio por instancia. Default 6, máximo 10.
//   SEC_TIMEOUT_MS      → corte por request. Default 30s (companyfacts pesa).
// ═══════════════════════════════════════════════════════════════

export const UA_DEFAULT = 'QuantDesk research@quantdesk.app';

// El techo de la SEC. No es configurable hacia arriba: si alguien pone 50 en
// la env var, se recorta acá y se dice. https://www.sec.gov/os/webmaster-faq
export const TECHO_SEC_REQ_POR_SEGUNDO = 10;
export const REQ_POR_SEGUNDO_DEFAULT = 6;
export const TIMEOUT_MS_DEFAULT = 30_000;

// Cuántas veces se reintenta lo que SÍ se reintenta (429, 503, red caída).
export const REINTENTOS_DEFAULT = 3;
// Tope de la espera que se le concede a un Retry-After. Un lambda tiene 60s
// de presupuesto: obedecer un "Retry-After: 600" sería colgarse hasta morir.
export const ESPERA_MAXIMA_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────
// User-Agent: la SEC lo exige descriptivo y con forma de contacto. Un UA
// genérico se gana 403, y un 403 por UA se parece demasiado a un 403 del
// proxy de egress — se han perdido horas confundiéndolos. Se valida al crear
// el cliente y se falla ahí, no en la request número 300 de una ingesta.
// ─────────────────────────────────────────────────────────────────────────
export function validarUA(ua) {
  const s = String(ua || '').trim();
  if (!s) throw new Error('SEC_USER_AGENT vacío: la SEC exige un User-Agent descriptivo.');
  if (s.length < 10) throw new Error(`SEC_USER_AGENT demasiado corto ("${s}"): la SEC exige algo descriptivo con contacto.`);
  if (!/[^@\s]+@[^@\s]+\.[^@\s]+/.test(s)) {
    throw new Error(`SEC_USER_AGENT sin contacto ("${s}"): tiene que incluir un email. Sin eso la SEC devuelve 403 y se confunde con un bloqueo de red.`);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// URLs. El CIK aparece con DOS formas distintas en EDGAR y confundirlas es
// el error clásico de la fuente:
//   · data.sec.gov  → CIK a 10 dígitos con ceros:  CIK0001397187
//   · /Archives/    → CIK entero SIN ceros:        /data/1397187/
// Un accession viaja con guiones en los metadatos (0000320193-25-000073) y
// SIN ellos en la ruta del directorio. Por eso hay builders y no plantillas
// sueltas por ahí.
// ─────────────────────────────────────────────────────────────────────────
export const pad10 = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');
export const cikInt = (cik) => String(parseInt(String(cik).replace(/\D/g, ''), 10));
export const sinGuiones = (accession) => String(accession).replace(/-/g, '');

export const URL_TICKERS = 'https://www.sec.gov/files/company_tickers.json';
export const urlSubmissions = (cik) => `https://data.sec.gov/submissions/CIK${pad10(cik)}.json`;
export const urlSubmissionsPagina = (archivo) => `https://data.sec.gov/submissions/${archivo}`;
export const urlCompanyFacts = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`;
export const urlDocumento = (cik, accession, doc) =>
  `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${sinGuiones(accession)}/${doc}`;
export const urlIndice = (cik, accession) =>
  `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${sinGuiones(accession)}/index.json`;

// ─────────────────────────────────────────────────────────────────────────
// Errores con forma. Un `throw new Error(texto)` obliga a que el llamador
// parsee prosa para decidir si reintenta. Estos llevan `status` y `clase`.
//
// `clase` distingue lo que el operador tiene que hacer distinto:
//   'egress'    → esta máquina no tiene salida a sec.gov (nuestro caso)
//   'ua'        → la SEC rechazó el User-Agent
//   'tasa'      → 429/503 tras agotar reintentos
//   'ausente'   → 404: el documento no existe (reintentar no lo crea)
//   'red'       → la conexión se cayó o expiró el timeout
//   'formato'   → contestó 200 con algo que no es el JSON prometido
//   'http'      → cualquier otro no-2xx
// ─────────────────────────────────────────────────────────────────────────
// El peso que se reporta es el del cuerpo YA DESCOMPRIMIDO, en bytes UTF-8 —
// no los bytes que viajaron por el cable, que con gzip son bastantes menos.
// Es el número correcto para dimensionar memoria y almacenamiento, que es para
// lo que G4 lo pide; si algún día importa el ancho de banda, ése es otro dato.
// `cuerpo.length` NO sirve acá: cuenta unidades UTF-16, y un nombre de emisor
// con acentos ya rompe la cuenta.
const pesoUtf8 = (s) => (typeof Buffer !== 'undefined'
  ? Buffer.byteLength(s, 'utf8')
  : new TextEncoder().encode(s).length);

export class ErrorEdgar extends Error {
  constructor(mensaje, { status = null, clase = 'http', url = null, kind = null } = {}) {
    super(mensaje);
    this.name = 'ErrorEdgar';
    this.status = status;
    this.clase = clase;
    this.url = url;
    this.kind = kind;
  }
}

// Un 403 es ambiguo y el mensaje tiene que decir las dos posibilidades, o el
// próximo que lo vea repite el diagnóstico desde cero. Pasó en la Fase 0.
function errorDe403(url, kind, ua) {
  return new ErrorEdgar(
    `${kind}: HTTP 403. Dos causas posibles y se distinguen rápido: ` +
    `(a) esta máquina no tiene egress a sec.gov —el proxy deniega el CONNECT—, ` +
    `(b) la SEC rechazó el User-Agent "${ua}". Si otras salidas HTTPS funcionan, es (b).`,
    { status: 403, clase: 'egress', url, kind },
  );
}

// `ahoraMs` entra por parámetro y no se lee `Date.now()` acá: el cliente corre
// con reloj inyectado y mezclar dos relojes en el mismo cálculo da esperas que
// no se pueden probar ni explicar.
export const esperaDeRetryAfter = (valor, ahoraMs) => {
  if (valor == null || valor === '') return null;
  const segundos = Number(String(valor).trim());
  if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, ESPERA_MAXIMA_MS);
  const fecha = Date.parse(String(valor));
  if (Number.isFinite(fecha)) return Math.min(Math.max(0, fecha - ahoraMs), ESPERA_MAXIMA_MS);
  return null;
};

// ─────────────────────────────────────────────────────────────────────────
// El cliente. Todo lo inyectable tiene default real, así que en producción
// se construye con `crearCliente()` a secas.
// ─────────────────────────────────────────────────────────────────────────
export function crearCliente({
  fetch: fetchImpl = globalThis.fetch,
  ahora = () => Date.now(),
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  ua = process.env.SEC_USER_AGENT || UA_DEFAULT,
  reqPorSegundo = Number(process.env.SEC_REQ_POR_SEGUNDO) || REQ_POR_SEGUNDO_DEFAULT,
  timeoutMs = Number(process.env.SEC_TIMEOUT_MS) || TIMEOUT_MS_DEFAULT,
  reintentos = REINTENTOS_DEFAULT,
} = {}) {
  const uaValido = validarUA(ua);
  if (typeof fetchImpl !== 'function') {
    throw new Error('crearCliente: no hay fetch. En Node < 18 hay que inyectarlo.');
  }

  // Recorte al techo de la SEC. Silencioso sería peor: quien puso 50 en la
  // env var cree que está corriendo a 50.
  let rps = Number(reqPorSegundo);
  if (!Number.isFinite(rps) || rps <= 0) rps = REQ_POR_SEGUNDO_DEFAULT;
  const recortado = rps > TECHO_SEC_REQ_POR_SEGUNDO;
  if (recortado) rps = TECHO_SEC_REQ_POR_SEGUNDO;
  const intervaloMs = 1000 / rps;

  const llamadas = [];   // { host, kind, ms, status, bytes, intento }
  let esperaTotalMs = 0;
  let turno = Promise.resolve();
  let proximoLibre = 0;

  // Cada turno se encadena al anterior: el espaciado no depende de cuándo
  // leyó el reloj cada llamador, que es lo que hace correr al `lastCall`.
  function acomodarTurno() {
    const mio = turno.then(async () => {
      const t = ahora();
      const espera = Math.max(0, proximoLibre - t);
      if (espera > 0) {
        esperaTotalMs += espera;
        await dormir(espera);
      }
      proximoLibre = Math.max(t, proximoLibre) + intervaloMs;
    });
    // La cadena no se rompe si un turno falla.
    turno = mio.catch(() => {});
    return mio;
  }

  async function unaVez(url, { kind, metodo = 'GET' }) {
    const control = typeof AbortController === 'function' ? new AbortController() : null;
    const corte = control ? setTimeout(() => control.abort(), timeoutMs) : null;
    const t0 = ahora();
    try {
      const r = await fetchImpl(url, {
        method: metodo,
        headers: {
          'User-Agent': uaValido,
          'Accept-Encoding': 'gzip, deflate',
          Accept: '*/*',
        },
        ...(control ? { signal: control.signal } : {}),
      });
      const cuerpo = metodo === 'HEAD' ? '' : await r.text();
      return { r, cuerpo, ms: ahora() - t0, bytes: pesoUtf8(cuerpo) };
    } finally {
      if (corte) clearTimeout(corte);
    }
  }

  function anotar(url, kind, ms, status, bytes, intento) {
    let host = '';
    try { host = new URL(url).host; } catch { host = ''; }
    llamadas.push({ host, kind, ms, status, bytes, intento });
  }

  // Devuelve { cuerpo, bytes, status }. Reintenta SOLO lo transitorio.
  async function traer(url, { kind = 'otro', metodo = 'GET' } = {}) {
    let ultimo = null;
    for (let intento = 0; intento <= reintentos; intento++) {
      await acomodarTurno();

      let paso;
      try {
        paso = await unaVez(url, { kind, metodo });
      } catch (e) {
        const abortado = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
        anotar(url, kind, 0, abortado ? 'TIMEOUT' : 'ERR', 0, intento);
        ultimo = new ErrorEdgar(
          abortado
            ? `${kind}: timeout tras ${timeoutMs} ms`
            : `${kind}: red caída — ${e && e.message ? e.message : 'sin detalle'}`,
          { clase: 'red', url, kind },
        );
        if (intento === reintentos) throw ultimo;
        await dormir(1000 * 2 ** intento);
        continue;
      }

      const { r, cuerpo, ms, bytes } = paso;
      anotar(url, kind, ms, r.status, bytes, intento);

      if (r.status === 429 || r.status === 503) {
        ultimo = new ErrorEdgar(`${kind}: HTTP ${r.status} tras ${reintentos} reintentos`, {
          status: r.status, clase: 'tasa', url, kind,
        });
        if (intento === reintentos) throw ultimo;
        // Si la SEC dijo cuánto esperar, se le hace caso. Nuestro backoff es
        // una conjetura; su Retry-After es el dato.
        const pedido = esperaDeRetryAfter(
          r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null,
          ahora(),
        );
        await dormir(pedido != null ? pedido : 1000 * 2 ** intento);
        continue;
      }

      if (r.status === 403) throw errorDe403(url, kind, uaValido);
      if (r.status === 404) {
        throw new ErrorEdgar(`${kind}: HTTP 404 — no existe en EDGAR (${url})`, {
          status: 404, clase: 'ausente', url, kind,
        });
      }
      if (!r.ok) {
        throw new ErrorEdgar(`${kind}: HTTP ${r.status}`, { status: r.status, clase: 'http', url, kind });
      }

      // Las cabeceras viajan porque una HEAD no trae cuerpo: el peso del
      // documento está en `content-length` y en ningún otro lado.
      return { cuerpo, bytes, status: r.status, cabeceras: r.headers || null };
    }
    throw ultimo;
  }

  return {
    ua: uaValido,
    reqPorSegundo: rps,
    recortadoAlTecho: recortado,

    async json(url, opciones = {}) {
      const { cuerpo, bytes } = await traer(url, opciones);
      try {
        return { json: JSON.parse(cuerpo), bytes };
      } catch {
        // 200 con HTML es la forma en que un portal cautivo o una página de
        // error se disfraza de dato. Se corta acá y se muestra el principio.
        throw new ErrorEdgar(
          `${opciones.kind || 'otro'}: contestó 200 pero no es JSON — "${cuerpo.slice(0, 120)}…"`,
          { status: 200, clase: 'formato', url, kind: opciones.kind || null },
        );
      }
    },

    // Una HEAD: el peso del documento SIN bajarlo. Es lo que hace que medir
    // 160 filings sea una request por documento en vez de 160 descargas.
    //
    // `content-length` puede no venir (transfer-encoding chunked, un proxy
    // que lo saca). En ese caso devuelve null y NO se inventa un número —
    // quien llama decide si baja el documento para medirlo o lo descarta de
    // la muestra.
    async cabeza(url, opciones = {}) {
      const { status, cabeceras } = await traer(url, { ...opciones, metodo: 'HEAD' });
      const crudo = cabeceras && typeof cabeceras.get === 'function' ? cabeceras.get('content-length') : null;
      const n = crudo == null ? NaN : Number(crudo);
      return { status, bytes: Number.isFinite(n) ? n : null };
    },

    async texto(url, opciones = {}) {
      const { cuerpo, bytes } = await traer(url, opciones);
      return { texto: cuerpo, bytes };
    },

    // Para G3: ¿la URL del documento primario vive? Un HEAD no baja el
    // documento y contesta la única pregunta que importa. No lanza: el
    // estado ES la respuesta.
    async head(url, { kind = 'head-doc' } = {}) {
      try {
        const { status } = await traer(url, { kind, metodo: 'HEAD' });
        return status;
      } catch (e) {
        return e instanceof ErrorEdgar && e.status ? e.status : 'ERR';
      }
    },

    // Insumo de G4 y del log de ingesta. Se lee, no se imprime solo.
    stats() {
      const ms = llamadas.map((c) => c.ms).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
      const p = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor((q / 100) * ms.length))] : null);
      return {
        llamadas: llamadas.length,
        bytes: llamadas.reduce((a, c) => a + (c.bytes || 0), 0),
        reintentos: llamadas.filter((c) => c.intento > 0).length,
        esperaTotalMs,
        p50: p(50), p95: p(95), max: ms.length ? ms[ms.length - 1] : null,
        detalle: llamadas.slice(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Bajadas concretas. Siguen sin interpretar: entregan el JSON de EDGAR tal
// cual, más lo que hace falta para no perder nada por el camino.
// ─────────────────────────────────────────────────────────────────────────

// ticker → { cik, cikPad, nombre }. El archivo viene como {"0": {...}, ...}.
export async function bajarTickerMap(cli) {
  const { json, bytes } = await cli.json(URL_TICKERS, { kind: 'ticker-map' });
  const map = {};
  for (const fila of Object.values(json || {})) {
    if (!fila || !fila.ticker || fila.cik_str == null) continue;
    map[String(fila.ticker).toUpperCase()] = {
      cik: String(fila.cik_str),
      cikPad: pad10(fila.cik_str),
      nombre: fila.title || '',
    };
  }
  if (!Object.keys(map).length) {
    throw new ErrorEdgar('ticker-map: el archivo bajó vacío — EDGAR cambió de forma', {
      status: 200, clase: 'formato', url: URL_TICKERS, kind: 'ticker-map',
    });
  }
  return { map, bytes };
}

// submissions.json trae ~1.000 filings en `filings.recent` y el resto en
// páginas sueltas listadas en `filings.files[]`. Quien lea solo `recent` cree
// tener el historial completo y tiene los últimos mil: para un emisor con
// muchos Form 4 eso puede ser menos de dos años.
//
// Dos cuidados que no son opcionales:
//   · `desde` salta las páginas enteras cuyo `filingTo` es anterior a la
//     ventana. Cada página son cientos de KB que no se bajan y que la SEC no
//     tiene que servir; el dato para decidirlo viene en el índice.
//   · `truncado` avisa si `maxPaginas` cortó la bajada. Un recorte silencioso
//     convertiría "5 años de filings" en "los que cupieron" sin que nadie se
//     entere, y la cobertura que se muestre al usuario sería mentira.
export async function bajarSubmissionsCompleto(cli, cik, { desde = null, maxPaginas = 12 } = {}) {
  const url = urlSubmissions(cik);
  const { json: principal, bytes } = await cli.json(url, { kind: 'submissions' });

  const archivos = (principal && principal.filings && Array.isArray(principal.filings.files))
    ? principal.filings.files : [];

  const candidatas = archivos.filter((f) => {
    if (!f || !f.name) return false;
    if (!desde) return true;
    // Sin filingTo no se puede descartar: ante la duda se baja.
    return !f.filingTo || String(f.filingTo) >= String(desde);
  });

  const aBajar = candidatas.slice(0, maxPaginas);
  const truncado = candidatas.length > aBajar.length;

  const paginas = [];
  let bytesPaginas = 0;
  for (const f of aBajar) {
    const { json, bytes: b } = await cli.json(urlSubmissionsPagina(f.name), { kind: 'submissions-pagina' });
    paginas.push({ archivo: f.name, json });
    bytesPaginas += b;
  }

  return {
    principal,
    paginas,
    truncado,
    paginasOmitidasPorVentana: archivos.length - candidatas.length,
    bytes: bytes + bytesPaginas,
  };
}

// companyfacts pesa varios MB por emisor: es la llamada que decide si la
// ingesta va por goteo con cron o bajo demanda con caché (G4 del memo). Se
// devuelve crudo y con su peso, que es justamente el número a vigilar.
export async function bajarCompanyFacts(cli, cik) {
  const { json, bytes } = await cli.json(urlCompanyFacts(cik), { kind: 'companyfacts' });
  return { facts: json, bytes };
}
