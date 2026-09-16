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

// El benchmark del backtest. Se cosecha aunque NO sea tipo_valor_id=1 (es un
// ETF, no una acción): sin él no hay contra qué medir. Si no está en
// /v2/historicos hay que PREGUNTAR antes de sustituirlo por el índice IPC —
// el IPC no es invertible y cambiaría el criterio, no solo el dato.
const BENCHMARK = 'NAFTRAC';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.DATABURSATIL_TOKEN;
  if (!t) throw new Error('Falta DATABURSATIL_TOKEN en las env vars.');
  return t;
}

function contacto() {
  return process.env.XBRL_CONTACT || 'https://github.com/leticia5555/quantdesk2';
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

/** '2016-2' — la clave con la que se identifica un periodo en el ledger. */
function clavePeriodo(anio, trimestre) {
  return `${anio}-${trimestre}`;
}

function parseClavePeriodo(clave) {
  const m = /^(\d{4})-([1-4])$/.exec(String(clave).trim());
  return m ? { anio: Number(m[1]), trimestre: Number(m[2]) } : null;
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

/** Intersección de un rango con la cobertura declarada de la API. */
function recortarACobertura(desde, hasta, cobertura = COBERTURA_FIN) {
  const n = (p) => p.anio * 4 + p.trimestre;
  const d = !desde || n(desde) < n(cobertura.desde) ? cobertura.desde : desde;
  const h = !hasta || n(hasta) > n(cobertura.hasta) ? cobertura.hasta : hasta;
  return n(d) > n(h) ? null : { desde: d, hasta: h };
}

/* ─────────────────── el censo: rangos de /v2/emisoras ─────────────────── */

/**
 * `rango_financieros` es EL dato point-in-time del censo: define en qué
 * trimestre existía cada emisora, y por lo tanto quién puede estar en el
 * universo de cada rebalanceo. Sin él, el universo sería la lista de hoy
 * mirada hacia atrás — survivorship bias puro.
 *
 * No sé su forma exacta [NO VERIFICADO], así que se aceptan las que tienen
 * sentido y se falla ABIERTO al reporte, no al dato: lo que no se entiende
 * devuelve null con motivo, y el crudo queda guardado para re-parsear sin
 * gastar créditos.
 *
 * Formas aceptadas:
 *   '2016-2/2026-2'  ·  '2016-2 a 2026-2'  ·  '2016-2,2026-2'  ·  '2016-2'
 *   ['2016-2','2026-2']  ·  {inicio|desde|min, fin|hasta|max}
 *   {'2016':[2,3,4], '2017':[1,2,3,4]}  → min y max de las llaves
 */
function parsearRangoPeriodos(valor) {
  if (valor === null || valor === undefined) return { rango: null, motivo: 'ausente' };

  if (Array.isArray(valor)) {
    const claves = valor.map((v) => parseClavePeriodo(v)).filter(Boolean);
    if (claves.length >= 2) return { rango: { desde: claves[0], hasta: claves[claves.length - 1] }, motivo: null };
    if (claves.length === 1) return { rango: { desde: claves[0], hasta: claves[0] }, motivo: null };
    return { rango: null, motivo: 'arreglo sin periodos reconocibles' };
  }

  if (typeof valor === 'object') {
    const bajo = {};
    for (const [k, v] of Object.entries(valor)) bajo[k.toLowerCase()] = v;
    const ini = bajo.inicio ?? bajo.desde ?? bajo.min ?? bajo.primero;
    const fin = bajo.fin ?? bajo.hasta ?? bajo.max ?? bajo.ultimo;
    if (ini !== undefined && fin !== undefined) {
      const a = parseClavePeriodo(ini), b = parseClavePeriodo(fin);
      if (a && b) return { rango: { desde: a, hasta: b }, motivo: null };
    }
    // {'2016':[2,3,4], ...} — año → trimestres
    const pares = [];
    for (const [k, v] of Object.entries(valor)) {
      const anio = /^\d{4}$/.test(k) ? Number(k) : null;
      if (anio === null) continue;
      const trims = Array.isArray(v) ? v.map(Number).filter((n) => n >= 1 && n <= 4) : [];
      for (const t of trims) pares.push({ anio, trimestre: t });
    }
    if (pares.length) {
      pares.sort((x, y) => (x.anio * 4 + x.trimestre) - (y.anio * 4 + y.trimestre));
      return { rango: { desde: pares[0], hasta: pares[pares.length - 1] }, motivo: null };
    }
    return { rango: null, motivo: 'objeto sin forma reconocible' };
  }

  const s = String(valor).trim();
  const partes = s.split(/\s*(?:\/|,|;|\||\ba\b|-{2,}|→|\.\.)\s*/i).filter(Boolean);
  const claves = partes.map((p) => parseClavePeriodo(p)).filter(Boolean);
  if (claves.length >= 2) return { rango: { desde: claves[0], hasta: claves[claves.length - 1] }, motivo: null };
  if (claves.length === 1) return { rango: { desde: claves[0], hasta: claves[0] }, motivo: null };
  return { rango: null, motivo: `no se reconoce el formato: ${s.slice(0, 40)}` };
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
    const bajo = {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
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
  BASE, BENCHMARK, CAMPOS, COBERTURA_FIN, PAUSA_MS, PRESUPUESTO_MENSUAL, TIMEOUT_MS,
  aNumero, aplanarHistoricos, cabecerasDeCredito, clavePeriodo, construirUrl,
  dormir, finDeTrimestre, mesPresupuesto, normalizaLlave, normalizarFinancieros,
  parseClavePeriodo, parsearRangoFechas, parsearRangoPeriodos, recortarACobertura,
  resolverCampo, traer, trimestresEntre, urlSegura,
};
