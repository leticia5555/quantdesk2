// ═══════════════════════════════════════════════════════════════════
// api/_lib/databursatil.js — cliente de api.databursatil.com (Fase A).
//
// Lógica PURA + un fetch con cortesía. Todo lo que se puede probar sin red
// vive aquí y tiene test: el calendario de trimestres, el parseo de los
// rangos del censo, la resolución de campos sobre el JSON crudo, y la
// aritmética del presupuesto de créditos.
//
// ── POR QUÉ ESTE ARCHIVO ES TAN DEFENSIVO ──────────────────────────
// El sandbox donde se escribió esto NO alcanza `api.databursatil.com`: el
// proxy de egress de la organización responde 403 al CONNECT (política, no
// falla transitoria — no se reintenta, se reporta). Tampoco alcanza
// `databursatil.com`, así que **la documentación tampoco se pudo leer**.
//
// Consecuencia honesta: el CONTRATO EXACTO DE LA API NO ESTÁ VERIFICADO.
// No sé con certeza cómo se llama el parámetro del periodo, ni si la
// respuesta viene anidada por bloque o plana, ni cuántos créditos cuesta
// cada request. Todo eso está marcado [NO VERIFICADO] donde aparece.
//
// En vez de adivinar y quemar 200,000 créditos contra una suposición, el
// diseño es:
//
//   1. `?job=probe` gasta un puñado de requests (tope duro) y DESCUBRE el
//      contrato: prueba las grafías candidatas del periodo y devuelve la
//      forma cruda de lo que contesta el servidor. Es el mismo patrón de
//      descubrimiento de tags del smoke de Fase 0 — nunca asumir.
//   2. El cosechador guarda SIEMPRE el JSON crudo completo. Si la
//      normalización quedó mal, se arregla con un UPDATE sobre lo guardado,
//      sin volver a gastar un solo crédito.
//   3. Fail-closed: un campo que no resuelve es `null` CON MOTIVO, nunca un
//      proxy ni un cero. Misma regla que el XBRL (docs/xbrl-fase0.md).
//
// ENV VARS: DATABURSATIL_TOKEN
// ═══════════════════════════════════════════════════════════════════

const BASE = 'https://api.databursatil.com/v2';
const PAUSA_MS = 1000;      // 1 request/segundo: cortesía con un proyecto sin fines de lucro
const TIMEOUT_MS = 30000;

// Cobertura declarada de /v2/financieros (censo de Fase 1b, verificado por
// Lety con token propio): 2T2016 → 2T2026.
const COBERTURA_FIN = { desde: { anio: 2016, trimestre: 2 }, hasta: { anio: 2026, trimestre: 2 } };

// El benchmark del backtest, confirmado por Lety: **NAFTRAC ISHRS**, emisora
// NAFTRAC, serie ISHRS, `tipo_valor_id` **1B**.
//
// Que sea 1B y no 1 es justo lo que lo mantiene FUERA del universo: el filtro
// de emisoras es `tipo_valor_id = '1'`, igualdad exacta de texto, y el tipo se
// guarda sin coerción — '1B' nunca empata con '1'. O sea que el benchmark no
// puede colarse a su propia canasta, y no hace falta una excepción para
// lograrlo: la exclusión es estructural. Hay un test que la fija.
//
// Se cosecha aparte, por eso mismo: nunca sale en el universo, y sin él no hay
// contra qué medir.
// SIN espacio. Todos los identificadores de la API van pegados —WALMEX*,
// FEMSAUBD, LIVEPOLC-1, LACOMERUBC— y éste no es la excepción. Probarlo con
// espacio fue lo que devolvió 400; NAFTRAC sí está en el censo (16 filas 1B),
// el problema era cómo se armaba el identificador.
const BENCHMARK_EMISORA = 'NAFTRAC';
const BENCHMARK_SERIE = 'ISHRS';
const BENCHMARK = BENCHMARK_EMISORA + BENCHMARK_SERIE;   // 'NAFTRACISHRS'
const BENCHMARK_TIPO = '1B';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.DATABURSATIL_TOKEN;
  if (!t) throw new Error('Falta DATABURSATIL_TOKEN en las env vars.');
  return t;
}

function contacto() {
  return process.env.XBRL_CONTACT || 'https://github.com/leticia5555/quantdesk2';
}

/**
 * El identificador que pide /v2/historicos es **emisora + serie**, no la
 * emisora sola: `WALMEX*`, `FEMSAUBD`, `AMXB`, `GMEXICOB`, `CEMEXCPO`,
 * `LIVEPOLC-1`, `NAFTRAC ISHRS`. Y el parámetro se llama `emisora_serie`.
 *
 * La serie NO se adivina: viene en el censo como la llave del sub-objeto de
 * cada emisora (§ filaCenso). Este concatenado es literal —sin separador,
 * sin normalizar— justo para que una serie que traiga su propio espacio, como
 * ` ISHRS`, produzca `NAFTRAC ISHRS` sin un caso especial.
 */
function emisoraSerie(emisora, serie) {
  const e = String(emisora || '').trim();
  if (serie === null || serie === undefined || serie === '') return e;
  return e + String(serie);
}

/* ─────────────────── URLs ─────────────────── */

/**
 * Arma la URL con el token como query param. `params` con valor null/undefined
 * se omiten (así los jobs pueden pasar opcionales sin ramificar).
 *
 * El token va en la URL y NO debe salir nunca en una respuesta ni en un log:
 * `urlSegura()` es la que se reporta.
 */
function construirUrl(ruta, params = {}, tok = null) {
  const u = new URL(BASE + (ruta.startsWith('/') ? ruta : '/' + ruta));
  u.searchParams.set('token', tok || token());
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** La misma URL con el token tachado — es la única forma en que se reporta. */
function urlSegura(url) {
  return String(url).replace(/([?&]token=)[^&]*/gi, '$1***');
}

/* ─────────────────── fetch con cortesía ─────────────────── */

/**
 * Un reintento SÓLO en 5xx o error de red. Un 4xx no se reintenta: si la API
 * dice 401 o 404, martillar no lo arregla — y cada intento cuesta créditos.
 *
 * Devuelve { ok, status, json, texto, url } — nunca lanza por HTTP, para que
 * el cosechador pueda anotar el error en el ledger y seguir con la siguiente
 * emisora en vez de morirse a la mitad de la corrida.
 */
async function traer(url, { pausaMs = PAUSA_MS, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          'User-Agent': `quantdesk-bmv-harvest/1.0 (+${contacto()})`,
          Accept: 'application/json,*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      ultimo = { ok: false, status: 0, error: `red: ${e && e.message ? e.message : e}`, url: urlSegura(url) };
      if (intento === 2) return ultimo;
      await dormir(pausaMs * 2);
      continue;
    }
    const texto = await res.text().catch(() => '');
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (e) { json = null; }

    if (res.status >= 500 && intento === 1) {
      ultimo = { ok: false, status: res.status, error: `HTTP ${res.status}`, texto: texto.slice(0, 400), url: urlSegura(url) };
      await dormir(pausaMs * 2);
      continue;
    }
    return {
      ok: res.ok && json !== null,
      status: res.status,
      json,
      texto: json === null ? texto.slice(0, 400) : undefined,
      error: res.ok ? (json === null ? 'respuesta no es JSON' : null) : `HTTP ${res.status}`,
      url: urlSegura(url),
      // Si la API publica el saldo en headers, se guarda: es la única forma de
      // calibrar el costo real por request sin confiar en una suposición.
      creditos_header: cabecerasDeCredito(res),
    };
  }
  return ultimo;
}

/**
 * Busca en los headers cualquier cosa que huela a saldo de créditos. No sé si
 * la API los manda [NO VERIFICADO]; si los manda, quedan guardados y el
 * presupuesto deja de ser una estimación.
 */
function cabecerasDeCredito(res) {
  const out = {};
  try {
    for (const [k, v] of res.headers) {
      if (/credit|credito|quota|cuota|limit|remaining|restante|saldo/i.test(k)) out[k] = v;
    }
  } catch (e) { /* headers no iterables en algún mock: no es un error */ }
  return Object.keys(out).length ? out : null;
}

/* ─────────────────── calendario de trimestres ─────────────────── */

/** Último día natural del trimestre — la fecha de cierre que indexa la API. */
function finDeTrimestre(anio, trimestre) {
  const mes = trimestre * 3;                 // 3, 6, 9, 12
  const dia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * El formato de periodo que pide /v2/financieros: **'1T_2020'** — trimestre,
 * T, guion bajo, año. VERIFICADO contra la API: ninguna de las 8 grafías que
 * este archivo probaba primero era ésta, y el error que devolvió lo dijo con
 * todas sus letras ("Es necesario ingresar un periodo valido... Por ejemplo:
 * '1T_2020'"). `periodo=2T_2017` devuelve datos.
 *
 * Va aparte de `clavePeriodo` a propósito: aquélla es la llave del LEDGER
 * ('2016-2', ordenable y estable), ésta es el dialecto de la API. Mezclarlas
 * ataría nuestro índice al formato de un tercero.
 */
function periodoApi(anio, trimestre) {
  return `${trimestre}T_${anio}`;
}

/** '2016-2' — la clave con la que se identifica un periodo en el ledger. */
function clavePeriodo(anio, trimestre) {
  return `${anio}-${trimestre}`;
}

/**
 * Acepta las DOS formas: la nuestra ('2016-2') y la de la API ('2T_2016').
 *
 * Aceptar la de la API no es una concesión estética: `rango_financieros` llega
 * como una lista en ese dialecto, y rechazarlo dejaba la cobertura en CERO.
 */
function parseClavePeriodo(clave) {
  const t = String(clave ?? '').trim();
  const a = /^(\d{4})-([1-4])$/.exec(t);
  if (a) return { anio: Number(a[1]), trimestre: Number(a[2]) };
  const b = /^([1-4])T_(\d{4})$/i.exec(t);
  if (b) return { anio: Number(b[2]), trimestre: Number(b[1]) };
  return null;
}

/** Orden cronológico. Existe porque la API NO manda la lista ordenada así. */
function ordenPeriodo(p) {
  return p.anio * 4 + p.trimestre;
}

/**
 * Lista de trimestres [desde, hasta] inclusive. Devuelve [] si el rango está
 * invertido (no lanza: un rango raro del censo no debe tumbar la corrida).
 */
function trimestresEntre(desde, hasta) {
  if (!desde || !hasta) return [];
  const out = [];
  let a = desde.anio, t = desde.trimestre;
  const fin = hasta.anio * 4 + hasta.trimestre;
  let guarda = 0;
  while (a * 4 + t <= fin && guarda++ < 1000) {
    out.push({ anio: a, trimestre: t });
    t += 1;
    if (t > 4) { t = 1; a += 1; }
  }
  return out;
}

/**
 * Intersección de un rango con la cobertura declarada de la API.
 *
 * FAIL-CLOSED: si falta cualquiera de los dos extremos devuelve `null`, NO la
 * cobertura completa. Rellenar un rango ausente con "todo" es exactamente el
 * error que el censo existe para evitar: le inventaría a la emisora una fecha
 * de nacimiento, la metería al universo en trimestres en los que no cotizaba, y
 * de paso cobraría 41 requests por cada rango que no se supo leer.
 *
 * Una emisora sin rango legible se reporta (`ics_sin_rango_financieros`) y se
 * salta. Un ETF como el benchmark tampoco tiene financieros, y por eso tampoco
 * se le cobran.
 */
function recortarACobertura(desde, hasta, cobertura = COBERTURA_FIN) {
  if (!desde || !hasta) return null;
  const n = (p) => p.anio * 4 + p.trimestre;
  const d = n(desde) < n(cobertura.desde) ? cobertura.desde : desde;
  const h = n(hasta) > n(cobertura.hasta) ? cobertura.hasta : hasta;
  return n(d) > n(h) ? null : { desde: d, hasta: h };
}

/* ─────────────────── el censo: rangos de /v2/emisoras ─────────────────── */

/**
 * `rango_financieros` es EL dato point-in-time del censo: define en qué
 * trimestre existía cada emisora, y por lo tanto quién puede estar en el
 * universo de cada rebalanceo. Sin él, el universo sería la lista de hoy
 * mirada hacia atrás — survivorship bias puro.
 *
 * ── LO QUE LA API MANDA DE VERDAD [VERIFICADO] ─────────────────────
 * Una LISTA separada por comas, en el dialecto de la API:
 *
 *     "1T_2017, 1T_2018, 1T_2019, ..., 2T_2016, ..., 4T_2025"
 *
 * Dos cosas de esa cadena, y las dos muerden:
 *
 *   1. No es un rango de dos extremos: es la **enumeración** de los trimestres
 *      que esa emisora sí reportó. Puede tener huecos, y los huecos importan —
 *      un trimestre que no reportó no es un trimestre que valga pedir. Por eso
 *      además del rango se devuelve la lista completa en `periodos`.
 *   2. **No viene en orden cronológico**, sino lexicográfico: todos los 1T,
 *      luego los 2T… Así que `1T_2017` aparece ANTES que `2T_2016`. Tomar el
 *      primero y el último daría un inicio un año tarde. De ahí que se ordene
 *      antes de sacar mínimo y máximo.
 *
 * ── Por qué esto estuvo roto ───────────────────────────────────────
 * El fail-closed quedó demasiado estricto y rechazaba el formato BUENO: las
 * 137 ICS salieron con motivo "no se reconoce el formato" y la cobertura en
 * cero. Fallar cerrado protege de inventar datos; no sirve de nada si además
 * tira los que llegan bien. El test usa la cadena literal de WALMEX.
 *
 * Otras formas que se siguen aceptando:
 *   '2016-2/2026-2'  ·  '2016-2 a 2026-2'  ·  '2016-2'
 *   ['2016-2','2026-2']  ·  {inicio|desde|min, fin|hasta|max}
 *   {'2016':[2,3,4], '2017':[1,2,3,4]}
 */
function parsearRangoPeriodos(valor) {
  if (valor === null || valor === undefined) return { rango: null, periodos: [], motivo: 'ausente' };

  if (Array.isArray(valor)) {
    return deLista(valor.map((v) => parseClavePeriodo(v)).filter(Boolean),
      'arreglo sin periodos reconocibles');
  }

  if (typeof valor === 'object') {
    const bajo = {};
    for (const [k, v] of Object.entries(valor)) bajo[k.toLowerCase()] = v;
    const ini = bajo.inicio ?? bajo.desde ?? bajo.min ?? bajo.primero;
    const fin = bajo.fin ?? bajo.hasta ?? bajo.max ?? bajo.ultimo;
    if (ini !== undefined && fin !== undefined) {
      const a = parseClavePeriodo(ini), b = parseClavePeriodo(fin);
      if (a && b) return deLista([a, b], 'objeto sin forma reconocible');
    }
    // {'2016':[2,3,4], ...} — año → trimestres
    const pares = [];
    for (const [k, v] of Object.entries(valor)) {
      const anio = /^\d{4}$/.test(k) ? Number(k) : null;
      if (anio === null) continue;
      const trims = Array.isArray(v) ? v.map(Number).filter((n) => n >= 1 && n <= 4) : [];
      for (const t of trims) pares.push({ anio, trimestre: t });
    }
    if (pares.length) return deLista(pares, 'objeto sin forma reconocible');
    return { rango: null, periodos: [], motivo: 'objeto sin forma reconocible' };
  }

  const s = String(valor).trim();
  const partes = s.split(/\s*(?:\/|,|;|\||\ba\b|-{2,}|→|\.\.)\s*/i).filter(Boolean);
  const claves = partes.map((p) => parseClavePeriodo(p)).filter(Boolean);
  return deLista(claves, `no se reconoce el formato: ${s.slice(0, 60)}`);
}

/**
 * Min y max CRONOLÓGICOS de una lista de periodos, más la lista misma
 * ordenada y sin repetidos. La lista es lo que permite pedir sólo los
 * trimestres que la emisora de verdad reportó, en vez de rellenar los huecos
 * con requests que van a volver vacíos.
 */
function deLista(claves, motivoSiVacio) {
  if (!claves.length) return { rango: null, periodos: [], motivo: motivoSiVacio };
  const vistos = new Map();
  for (const c of claves) vistos.set(ordenPeriodo(c), c);
  const orden = [...vistos.keys()].sort((a, b) => a - b).map((k) => vistos.get(k));
  return {
    rango: { desde: orden[0], hasta: orden[orden.length - 1] },
    periodos: orden,
    motivo: null,
  };
}

/** Lo mismo para `rango_historicos`, que son FECHAS y no trimestres. */
function parsearRangoFechas(valor) {
  if (valor === null || valor === undefined) return { rango: null, motivo: 'ausente' };
  const fechas = [];
  const empujar = (v) => {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(String(v));
    if (m) fechas.push(m[1]);
  };
  if (Array.isArray(valor)) valor.forEach(empujar);
  else if (typeof valor === 'object') Object.values(valor).forEach(empujar);
  else String(valor).split(/\s*(?:\/|,|;|\||\ba\b|\.\.|→)\s*/i).forEach(empujar);

  if (!fechas.length) return { rango: null, motivo: `no se reconoce el formato: ${String(valor).slice(0, 40)}` };
  fechas.sort();
  return { rango: { desde: fechas[0], hasta: fechas[fechas.length - 1] }, motivo: null };
}

/* ─────────────────── resolver campos sobre el JSON crudo ─────────────────── */

// Los 7 campos que el backtest necesita normalizados. El resto vive en el
// crudo: guardar TODO cuesta lo mismo (ya se pagó el request) y evita una
// segunda cosecha si mañana hace falta otro renglón.
//
// `basicearningslosspershare` del bloque `resultado_trimestre` es el corazón
// del value: el TTM es la SUMA de los 4 trimestres. Por eso se pide
// `resultado_trimestre` y no `resultado_acumulado` — sumar cuatro acumulados
// contaría el 1T cuatro veces.
const CAMPOS = [
  'revenue',
  'profitlossattributabletoownersofparent',
  'basicearningslosspershare',
  'assets',
  'liabilities',
  'equity',
  'cashandcashequivalents',
];

function normalizaLlave(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Busca un campo en cualquier nivel del JSON, comparando llaves normalizadas.
 * No sé si la respuesta viene plana o anidada por bloque [NO VERIFICADO], así
 * que se recorre el árbol.
 *
 * AMBIGÜEDAD = FALLA, no promedio: si el mismo campo aparece en dos ramas con
 * valores DISTINTOS, devuelve null con motivo y las rutas. Es la misma regla
 * que la ambigüedad de ventana del XBRL (3m/6m/12m con el mismo cierre): un
 * dato que puede significar dos cosas no es un dato.
 */
function resolverCampo(raw, nombre) {
  const objetivo = normalizaLlave(nombre);
  const hallazgos = [];
  const visto = new Set();

  const caminar = (nodo, ruta) => {
    if (!nodo || typeof nodo !== 'object' || visto.has(nodo) || ruta.length > 8) return;
    visto.add(nodo);
    for (const [k, v] of Object.entries(nodo)) {
      const aqui = [...ruta, k];
      if (normalizaLlave(k) === objetivo) {
        const num = aNumero(v);
        if (num !== null) hallazgos.push({ valor: num, ruta: aqui.join('.') });
      }
      if (v && typeof v === 'object') caminar(v, aqui);
    }
  };
  caminar(raw, []);

  if (!hallazgos.length) return { valor: null, ruta: null, motivo: 'no está en la respuesta' };

  const distintos = [...new Set(hallazgos.map((h) => h.valor))];
  if (distintos.length > 1) {
    return {
      valor: null,
      ruta: null,
      motivo: `AMBIGUO: ${distintos.length} valores distintos (${hallazgos.map((h) => `${h.ruta}=${h.valor}`).join(' · ')})`,
    };
  }
  return { valor: hallazgos[0].valor, ruta: hallazgos[0].ruta, motivo: null };
}

/**
 * Texto → número. Acepta el paréntesis contable como negativo y la coma SÓLO
 * como separador de miles bien formado. Devuelve null en vez de NaN: un NaN
 * guardado en `numeric` se vuelve un cero silencioso más adelante.
 *
 * ── Por qué la coma es estricta ────────────────────────────────────
 * México escribe el decimal con punto y los miles con coma, igual que EE.UU.
 * Pero si alguna respuesta trajera un decimal con coma, quitarla a lo bruto
 * convertiría `10,7` en `107`: un precio 10× mal, sin ruido, sin excepción y
 * sin forma de notarlo después. Es exactamente la clase de error de unidad
 * que Fase 0b documentó y por la que existe la validación contra cita.
 *
 * Así que la coma sólo se acepta cuando forma grupos de miles VÁLIDOS
 * (`1,234` · `12,345.67`). Cualquier otra coma devuelve null, el campo se
 * marca faltante con motivo, y el crudo queda guardado para revisarlo. Un
 * hoyo visible es infinitamente mejor que un 107 que parece un precio.
 */
function aNumero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/\s/g, '');
  if (s.startsWith('-')) { negativo = !negativo; s = s.slice(1); }

  if (s.includes(',')) {
    // Grupos de miles bien formados, con decimal opcional. Nada más.
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

/** Los 7 campos + el motivo de cada faltante. Fail-closed por construcción. */
function normalizarFinancieros(raw) {
  const valores = {};
  const faltantes = {};
  for (const campo of CAMPOS) {
    const r = resolverCampo(raw, campo);
    valores[campo] = r.valor;
    if (r.valor === null) faltantes[campo] = r.motivo;
  }
  return { valores, faltantes: Object.keys(faltantes).length ? faltantes : null };
}

/* ─────────────────── precios ─────────────────── */

/**
 * Aplana la respuesta de /v2/historicos a filas {fecha, cierre, importe, …}.
 * Se aceptan las formas plausibles [NO VERIFICADO]:
 *   {'2016-01-04': {cierre: 1.2, importe: 3}, …}      ← mapa por fecha
 *   [{fecha:'2016-01-04', cierre:1.2, importe:3}, …]  ← arreglo de filas
 *
 * Lo que no se entienda NO se inventa: se cuenta como descartado y el conteo
 * sale en el reporte, para que un cambio de formato se vea como cobertura que
 * no cuadra en vez de como una serie con hoyos.
 */
const ALIAS_PRECIO = {
  cierre: ['cierre', 'close', 'precio_cierre', 'ultimo', 'precio'],
  apertura: ['apertura', 'open', 'precio_apertura'],
  maximo: ['maximo', 'máximo', 'max', 'high'],
  minimo: ['minimo', 'mínimo', 'min', 'low'],
  volumen: ['volumen', 'volume', 'titulos', 'títulos'],
  importe: ['importe', 'importe_operado', 'monto', 'monto_operado', 'valor_operado', 'amount'],
};

function aplanarHistoricos(raw) {
  const filas = [];
  let descartadas = 0;

  const filaDe = (fecha, obj) => {
    const f = /(\d{4}-\d{2}-\d{2})/.exec(String(fecha));
    if (!f) { descartadas++; return; }

    // FORMATO REAL [VERIFICADO]: {"2026-06-22": [50.57, 1313556324.33]} —
    // un ARREGLO [precio, importe], no un objeto con llaves. El parser lo
    // trataba como objeto, no encontraba ninguna llave y descartaba la fila:
    // 7 de 7 filas de WALMEX se perdían, e `importe_operado_presente` salía
    // false cuando el importe SÍ venía.
    if (Array.isArray(obj)) {
      if (obj.length === 2 || obj.length === 1) {
        const cierre = aNumero(obj[0]);
        const importe = obj.length === 2 ? aNumero(obj[1]) : null;
        if (cierre === null) { descartadas++; return; }
        filas.push({ fecha: f[1], cierre, apertura: null, maximo: null, minimo: null, volumen: null, importe });
        return;
      }
      // Un arreglo de otro largo tiene un orden de columnas que NO está
      // verificado. Adivinarlo podría meter el volumen donde va el importe y
      // el filtro de liquidez quedaría midiendo otra cosa, en silencio.
      descartadas++;
      return;
    }

    const bajo = {};
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) bajo[normalizaLlave(k)] = v;
    }
    const tomar = (nombres) => {
      for (const n of nombres) {
        const v = bajo[normalizaLlave(n)];
        const num = aNumero(v);
        if (num !== null) return num;
      }
      return null;
    };
    // Un número suelto en vez de un objeto = el cierre.
    const suelto = aNumero(obj);
    const fila = {
      fecha: f[1],
      cierre: suelto !== null ? suelto : tomar(ALIAS_PRECIO.cierre),
      apertura: tomar(ALIAS_PRECIO.apertura),
      maximo: tomar(ALIAS_PRECIO.maximo),
      minimo: tomar(ALIAS_PRECIO.minimo),
      volumen: tomar(ALIAS_PRECIO.volumen),
      importe: tomar(ALIAS_PRECIO.importe),
    };
    // Sin cierre la fila no sirve para nada: ni ranking, ni retorno.
    if (fila.cierre === null) { descartadas++; return; }
    filas.push(fila);
  };

  const caminar = (nodo, profundidad) => {
    if (!nodo || typeof nodo !== 'object' || profundidad > 4) return;
    if (Array.isArray(nodo)) {
      for (const it of nodo) {
        if (it && typeof it === 'object') {
          const bajo = {};
          for (const [k, v] of Object.entries(it)) bajo[normalizaLlave(k)] = v;
          const fecha = bajo.fecha ?? bajo.date ?? bajo.dia ?? bajo.día;
          if (fecha !== undefined) filaDe(fecha, it);
          else caminar(it, profundidad + 1);
        }
      }
      return;
    }
    const llaves = Object.keys(nodo);
    const conFecha = llaves.filter((k) => /^\d{4}-\d{2}-\d{2}/.test(k));
    if (conFecha.length) {
      for (const k of conFecha) filaDe(k, nodo[k]);
      // Una llave que NO es fecha dentro de un mapa por fecha es la señal de
      // que el formato cambió. Se cuenta: si no, la serie sale con hoyos y el
      // reporte de cobertura los presenta como días sin operar.
      descartadas += llaves.length - conFecha.length;
      return;
    }
    for (const v of Object.values(nodo)) caminar(v, profundidad + 1);
  };
  caminar(raw, 0);

  filas.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  return { filas, descartadas };
}

/* ─────────────────── distribuciones (retorno total) ─────────────────── */

// LOS DOS LADOS son de retorno total, y por eso esto se extrae para TODAS las
// emisoras, no sólo para el benchmark:
//
//   · NAFTRAC reparte. Compararse contra su precio pelón le resta ~3%/año y nos
//     regalaría un exceso que no existió.
//   · Las emisoras de la canasta también reparten. Medir la canasta a precio
//     contra un benchmark de retorno total sería el MISMO error con el signo
//     volteado — y por un monto mayor que el margen económico entero.
//
// O sea: precio + distribuciones reinvertidas en la fecha EX-CUPÓN, de los dos
// lados. Es una corrección de MEDICIÓN, no de umbral: iguala cómo se mide cada
// serie sin tocar contra qué se comparan.
//
// Las distribuciones vienen dentro de la respuesta de /v2/emisoras, así que no
// cuestan un request extra: llegan con el censo, para cada emisora. La forma
// exacta NO está verificada [NO VERIFICADO], así que el extractor es tolerante
// y el crudo del censo se guarda igual — si esto falla, se re-extrae con un
// UPDATE.
const RE_DISTRIBUCION = /distribuc|dividend|cupon|cupón|reparto/i;
const ALIAS_MONTO = ['monto', 'importe', 'dividendo', 'distribucion', 'distribución',
  'valor', 'cantidad', 'amount', 'pago', 'cupon', 'cupón', 'efectivo'];
const ALIAS_EX = ['fecha_ex', 'ex', 'excupon', 'excupón', 'fecha_excupon', 'fecha', 'date'];

/**
 * Saca {fecha_ex, monto} de donde sea que vengan. La fecha que importa es la
 * **ex-cupón**: reinvertir en la fecha de pago adelantaría el flujo y metería
 * look-ahead por la puerta de atrás — justo lo que los 65 días cierran del
 * otro lado.
 *
 * Los montos se toman **brutos**, como vengan. El ISR sobre dividendos aplica
 * igual a la canasta y al benchmark, así que a primer orden se cancela en el
 * exceso; aplicarlo a un solo lado sí sería un sesgo.
 */
function extraerDistribuciones(raw) {
  const out = [];
  let descartadas = 0;
  const visto = new Set();
  // Los nombres de campo que se vieron. Se reportan porque de ellos depende si
  // la fecha guardada es la EX o la de PAGO, y eso no se puede deducir del
  // número: son días distintos y el retorno total se arma con la ex.
  const campos = new Set();

  const tomar = (bajo, nombres) => {
    for (const n of nombres) {
      const v = bajo[normalizaLlave(n)];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const fila = (clave, valor) => {
    // Igual que los precios, un reparto puede llegar como ARREGLO
    // ({"2025-12-17": [0.85]}) o como número suelto ({"2025-12-17": 0.85}).
    // El parser sólo miraba objetos con llaves, así que descartaba las dos
    // formas: 11 repartos de WALMEX salían como "sin reparto".
    if (Array.isArray(valor)) {
      const f = /(\d{4}-\d{2}-\d{2})/.exec(String(clave ?? ''));
      // El monto es el primer número del arreglo que no sea una fecha.
      const monto = valor.map(aNumero).find((x) => x !== null && x !== undefined);
      if (!f || monto === null || monto === undefined) { descartadas++; return; }
      const llave = f[1] + '|' + monto;
      if (!visto.has(llave)) { visto.add(llave); out.push({ fecha_ex: f[1], monto }); }
      return;
    }
    const bajo = {};
    if (valor && typeof valor === 'object') {
      for (const [k, v] of Object.entries(valor)) bajo[normalizaLlave(k)] = v;
      for (const k of Object.keys(bajo)) campos.add(k);
    }
    const crudoFecha = tomar(bajo, ALIAS_EX) ?? clave;
    const m = /(\d{4}-\d{2}-\d{2})/.exec(String(crudoFecha ?? ''));
    const monto = aNumero(tomar(bajo, ALIAS_MONTO) ?? (valor && typeof valor === 'object' ? undefined : valor));
    // Sin fecha ex o sin monto no sirve para reinvertir: se descarta y se
    // cuenta. Inventarle un cero pasaría como "no repartió" sin serlo.
    if (!m || monto === null) { descartadas++; return; }
    const llave = m[1] + '|' + monto;
    if (visto.has(llave)) return;
    visto.add(llave);
    out.push({ fecha_ex: m[1], monto });
  };

  const caminar = (nodo, dentro, profundidad) => {
    if (!nodo || typeof nodo !== 'object' || profundidad > 6) return;
    if (Array.isArray(nodo)) {
      if (dentro) for (const it of nodo) fila(null, it);
      else for (const it of nodo) caminar(it, false, profundidad + 1);
      return;
    }
    for (const [k, v] of Object.entries(nodo)) {
      if (!v || typeof v !== 'object') continue;
      const esAqui = dentro || RE_DISTRIBUCION.test(k);
      if (!esAqui) { caminar(v, false, profundidad + 1); continue; }
      if (Array.isArray(v)) { for (const it of v) fila(null, it); continue; }
      const llaves = Object.keys(v);
      if (llaves.some((x) => /^\d{4}-\d{2}-\d{2}/.test(x))) {
        for (const x of llaves) fila(x, v[x]);
        continue;
      }
      caminar(v, true, profundidad + 1);
    }
  };
  caminar(raw, false, 0);

  out.sort((a, b) => (a.fecha_ex < b.fecha_ex ? -1 : a.fecha_ex > b.fecha_ex ? 1 : 0));
  return { distribuciones: out, descartadas, campos: [...campos] };
}

/* ─────────────────── presupuesto de créditos ─────────────────── */

/**
 * El mes del presupuesto se calcula en **CDMX**, no en UTC. Los créditos se
 * reponen el día 1 a las 00:01 hora de Ciudad de México (censo de Fase 1b);
 * con el mes UTC, todo el 1º de mes entre las 00:00 y las 06:00 UTC caería en
 * el mes anterior y el contador arrancaría el mes nuevo ya "gastado".
 */
function mesPresupuesto(fecha = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
  }).format(fecha);
  return f.slice(0, 7);
}

const PRESUPUESTO_MENSUAL = 200000;

export {
  BASE, BENCHMARK, BENCHMARK_EMISORA, BENCHMARK_SERIE, BENCHMARK_TIPO,
  CAMPOS, COBERTURA_FIN, PAUSA_MS, PRESUPUESTO_MENSUAL, TIMEOUT_MS,
  aNumero, aplanarHistoricos, cabecerasDeCredito, clavePeriodo, construirUrl,
  dormir, emisoraSerie, extraerDistribuciones, finDeTrimestre, mesPresupuesto,
  normalizaLlave, normalizarFinancieros, periodoApi,
  ordenPeriodo, parseClavePeriodo, parsearRangoFechas, parsearRangoPeriodos,
  recortarACobertura,
  resolverCampo, traer, trimestresEntre, urlSegura,
};
