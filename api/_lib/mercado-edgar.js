// ═══════════════════════════════════════════════════════════════════════
// LAS ACCIONES EN CIRCULACIÓN, SEGÚN QUIEN LAS TIENE QUE DECLARAR
//
// La auditoría del 2026-09-24 contra prod dejó 21 emisoras en USD cuya cap
// declarada por Finnhub no cuadra con `shareOutstanding × precio`. El patrón
// dice de qué lado está el error: VMRK 2.1765, MNST 2.0782, APH 1.9847 — tres
// múltiplos pegados a 2× son un split 2:1 que `shareOutstanding` no reflejó.
// O sea que la cap declarada está bien y el conteo de acciones está viejo.
//
// EDGAR es la fuente que no puede estar vieja: `dei:EntityCommonStockShares‐
// Outstanding` es el número de la PORTADA del 10-Q, y la portada la firma la
// empresa. Acá se leen dos cosas de la API XBRL y nada más:
//
//   - el conteo de acciones del último 10-Q/10-K,
//   - la fecha de esa portada, que se guarda PEGADA al conteo.
//
// ── POR QUÉ ESTE UMBRAL ES 10% Y NO EL 5% DE G2 ──────────────────────────
// `CRITERIOS.g2_max_error_pct = 5` compara dos medidas del MISMO instante. Acá
// no: las acciones son las de la portada del trimestre y el precio es el
// cierre de hoy. Entre las dos fechas la empresa recompra, emite, vestea
// RSUs — la diferencia esperada NO es cero ni ruido de redondeo, es deriva
// real de semanas. Con el 5% de G2, la banda de 5–7% de la auditoría (ORCL
// 10.69, BX 6.06, APO 5.55, PAYX 6.89, CDNS −5.92, SHOP −5.79, MRNA −5.72,
// RKT 5.45, BE 5.29) quedaría gris por un desajuste que no es un error de
// nadie, y el mapa perdería una docena de nombres grandes con ORCL entre
// ellos.
//
// El 10% es una decisión de Lety del 2026-09-24, declarada acá y en
// docs/mercado-r0.md, SEPARADA del 5% de G2 a propósito: son dos preguntas
// distintas y mezclarlas en una constante es cómo se pierde de vista cuál se
// está aflojando. Lo que el 10% NO hace es tapar el caso que importaba: un
// split 2:1 son 100 puntos de error y sigue cayendo del lado gris si EDGAR no
// lo confirma.
// ═══════════════════════════════════════════════════════════════════════
import { errorPct } from './mercado-fase0.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** El techo de ESTE contraste. Declarado, versionado, y no es el de G2. */
export const UMBRAL_EDGAR_PCT = 10;

/** Las formas que traen portada con conteo de acciones. Un 8-K no sirve. */
export const FORMAS_CON_PORTADA = ['10-Q', '10-K', '10-K/A', '10-Q/A', '20-F', '40-F'];

/**
 * El mapa ticker → CIK, desde `https://www.sec.gov/files/company_tickers.json`.
 *
 * El CIK va a 10 dígitos con ceros porque así lo pide la ruta de la API. Un
 * ticker que EDGAR no conoce NO se inventa: se queda fuera y el símbolo sigue
 * gris con "sin CIK en EDGAR", que es una causa accionable (casi siempre un
 * ADR extranjero que presenta 20-F, o un ETF que no presenta nada).
 */
export function mapaCik(json) {
  const out = new Map();
  const filas = json && typeof json === 'object' ? Object.values(json) : [];
  for (const f of filas) {
    const t = f && f.ticker ? String(f.ticker).toUpperCase().trim() : '';
    const cik = num(f && f.cik_str);
    if (!t || cik == null) continue;
    if (!out.has(t)) out.set(t, String(Math.trunc(cik)).padStart(10, '0'));
  }
  return out;
}

export const rutaCompanyConcept = (cik) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`;

/**
 * LA FORMA DE `units`, PARA PODER DEPURARLA.
 *
 * La corrida del 2026-09-26 murió con `TypeError: unidades.filter is not a
 * function`: el lector hacía `json.units.shares.filter(...)` dando por hecho
 * que la clave se llama `shares` y que su valor es un arreglo. La respuesta
 * real no tiene por qué cumplir ninguna de las dos cosas, y el resto del
 * código de esta casa nunca lo dio por hecho — `mercado-fase0.js:622` y
 * `historia-ingesta.js:183` recorren `Object.entries(units)` justamente
 * porque la clave de unidad es un dato de la respuesta, no una constante.
 *
 * Esta huella viaja en el motivo cuando no se encuentran filas: un
 * `TypeError` en el log dice que algo no era un arreglo, pero no QUÉ era, y
 * sin eso la siguiente corrida se depura a ciegas otra vez.
 */
export function formaDeUnits(json) {
  if (!json || typeof json !== 'object') return `respuesta: ${json === null ? 'null' : typeof json}`;
  const u = json.units;
  if (u === undefined) return 'sin campo units';
  if (u === null) return 'units: null';
  if (Array.isArray(u)) return `units: arreglo de ${u.length}`;
  if (typeof u !== 'object') return `units: ${typeof u}`;
  const partes = Object.keys(u).slice(0, 6).map((k) => {
    const v = u[k];
    if (Array.isArray(v)) return `${k}: arreglo de ${v.length}`;
    return `${k}: ${v === null ? 'null' : typeof v}`;
  });
  return `units: objeto con {${partes.join(', ')}}`;
}

/**
 * Las filas de hechos de una respuesta `companyconcept`, venga como venga.
 *
 * `units` es un objeto cuyas CLAVES son nombres de unidad XBRL (`shares`,
 * `USD`, `USD/shares`…) y cuyos valores son los arreglos de hechos. Para
 * `dei:EntityCommonStockSharesOutstanding` la clave esperada es `shares`, y se
 * prefiere; pero si no está o no es un arreglo, se toma la primera clave que
 * SÍ traiga un arreglo, y se dice cuál se usó. Lo que no se hace nunca más es
 * llamar `.filter` sobre algo que no se verificó que sea un arreglo.
 */
export function filasDeUnits(json, { preferida = 'shares' } = {}) {
  const u = json && typeof json === 'object' ? json.units : null;
  if (Array.isArray(u)) return { filas: u, unidad: null };
  if (!u || typeof u !== 'object') return { filas: [], unidad: null };
  if (Array.isArray(u[preferida])) return { filas: u[preferida], unidad: preferida };
  for (const [k, v] of Object.entries(u)) {
    if (Array.isArray(v)) return { filas: v, unidad: k };
  }
  return { filas: [], unidad: null };
}

/**
 * El conteo de acciones más reciente de una respuesta `companyconcept`.
 *
 * Se elige por `filed` (cuándo se presentó), no por `end`: dos trimestres
 * pueden compartir instante de portada y lo que manda es cuál se declaró
 * después. `fecha_portada` es el `end` —el instante al que se refiere el
 * conteo— y `presentado_en` el `filed`. Se guardan LAS DOS porque responden
 * preguntas distintas: una dice a qué fecha vale el número, la otra cuándo
 * nos enteramos.
 */
export function accionesDeCompanyConcept(json, { formas = FORMAS_CON_PORTADA } = {}) {
  const { filas: unidades, unidad } = filasDeUnits(json);
  const validas = unidades.filter((u) => {
    const v = num(u && u.val);
    return v != null && v > 0 && u.end && formas.includes(String(u.form || ''));
  });
  if (!validas.length) {
    return {
      acciones: null, fecha_portada: null, presentado_en: null, form: null, unidad,
      motivo: unidades.length
        ? `EDGAR no trae ${formas.join('/')} con conteo de acciones utilizable (${unidades.length} hechos en "${unidad}")`
        // La huella va PEGADA al motivo: es la diferencia entre "EDGAR no tiene
        // el concepto" y "la respuesta vino con otra forma y no la supimos leer".
        : `EDGAR no reporta dei:EntityCommonStockSharesOutstanding para este CIK (${formaDeUnits(json)})`,
    };
  }
  const orden = validas.slice().sort((a, b) => {
    const fa = String(a.filed || a.end), fb = String(b.filed || b.end);
    if (fa !== fb) return fa < fb ? 1 : -1;
    return String(a.end) < String(b.end) ? 1 : -1;
  });
  const u = orden[0];
  return {
    acciones: num(u.val),
    fecha_portada: String(u.end),
    presentado_en: u.filed ? String(u.filed) : null,
    form: String(u.form),
    unidad,
    fy: u.fy != null ? Number(u.fy) : null,
    fp: u.fp ? String(u.fp) : null,
    accn: u.accn ? String(u.accn) : null,
    motivo: null,
  };
}

/**
 * El veredicto con EDGAR de árbitro.
 *
 * La cap que sale a pintar es **acciones de EDGAR × nuestro último cierre**:
 * las dos mitades medidas, ninguna heredada. La de Finnhub queda de CRUCE — si
 * las dos concuerdan dentro del 10% le creemos al conjunto, y si no, gris con
 * la causa y el múltiplo, que es el que dice si fue un split (≈2×) o deriva.
 */
export function veredictoCapEdgar({ symbol, declarada_usd, acciones_edgar, precio_usd, fecha_portada }, umbral = UMBRAL_EDGAR_PCT) {
  const dec = num(declarada_usd);
  const acc = num(acciones_edgar);
  const px = num(precio_usd);
  const base = { symbol, via: 'edgar', fecha_portada: fecha_portada || null, umbral_pct: umbral };

  if (acc == null || acc <= 0 || px == null || px <= 0) {
    return {
      ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo: null,
      fuente: null,
      motivo: acc == null || acc <= 0
        ? 'EDGAR no dio acciones en circulación para este símbolo'
        : 'no hay cierre nuestro con el que multiplicar las acciones de EDGAR',
    };
  }

  const reconstruida = acc * px;
  // Sin declarada no hay cruce. Una sola fuente no se verifica a sí misma:
  // ése fue el error que puso a TSM del tamaño de NVDA.
  if (dec == null || dec <= 0) {
    return {
      ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo: null,
      fuente: null, motivo: 'hay acciones de EDGAR pero ninguna cap declarada con la que cruzarlas',
    };
  }

  const e = errorPct(dec, reconstruida);
  const multiplo = dec / reconstruida;
  if (e == null) {
    return {
      ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo,
      fuente: null, motivo: 'las dos fuentes no son comparables',
    };
  }

  const ok = Math.abs(e) <= umbral;
  return {
    ...base,
    estado: ok ? 'verificada' : 'gris_punteado',
    auditable: true,
    // La que se dibuja es la NUESTRA, no la declarada: acciones de la portada
    // por el cierre que cosechamos.
    cap_usd: ok ? reconstruida : null,
    fuente: ok ? 'calc: edgar×neon' : null,
    error_pct: e,
    multiplo,
    motivo: ok ? null
      : `acciones de EDGAR (${fecha_portada || 'portada sin fecha'}) × cierre difieren ${e.toFixed(1)}% de la cap declarada (${multiplo.toFixed(2)}×), techo propio ${umbral}%`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TRES ESTADOS, NO DOS — Y UNA CAUSA QUE NO SE INVENTA
//
// El 2026-09-26 el mapa decía de ORCL, MNST y APH "EDGAR no dio acciones en
// circulación". EDGAR nunca fue consultado: el job había muerto en la primera
// respuesta. La causa en pantalla era FALSA, y de las peores: acusa a la
// fuente de no tener un dato que nadie le pidió, así que manda a revisar
// EDGAR en lugar de revisar el job.
//
// La raíz eran dos cosas a la vez. Una, `filaVeredictoCapUs` fabricaba una
// fila de EDGAR para TODAS las emisoras, porque preguntaba
// `num(acciones_edgar_millones) != null` y `num(null)` devuelve **0** —
// `Number(null)` es 0—, así que la columna vacía entraba como "EDGAR dio 0
// acciones". Dos: aunque el guardia estuviera bien, "la columna está vacía" no
// distingue "todavía no se preguntó" de "se preguntó y no había".
//
// Así que los estados son tres y cada uno se arregla distinto:
//
//   no_consultado         → correr ?job=acciones-edgar. NO es un hallazgo.
//   consultado_sin_dato   → EDGAR contestó y no tiene el concepto (típico de
//                           un ADR que presenta 20-F, o de un CIK ausente).
//                           Se guarda CUÁNDO se preguntó y QUÉ contestó.
//   consultado_con_dato   → hay conteo de portada: recién acá hay veredicto.
// ═══════════════════════════════════════════════════════════════════════

/** Los tres estados, nombrados. Un cuarto tendría que aparecer acá primero. */
export const ESTADOS_EDGAR = ['no_consultado', 'consultado_sin_dato', 'consultado_con_dato'];

/**
 * En qué estado está la consulta a EDGAR de un símbolo, y cómo se dice.
 *
 * `acciones` es el conteo ya en acciones (no en millones). El guardia es
 * `> 0` y no `!= null` a propósito: es el mismo `Number(null) === 0` que ya
 * costó cuatro bugs en este archivo y en `mercado-mapa.js`.
 */
export function estadoEdgar({ acciones = null, consultada_en = null, motivo = null } = {}) {
  const acc = num(acciones);
  if (acc != null && acc > 0) return { estado: 'consultado_con_dato', consultada_en, frase: null };
  if (consultada_en) {
    const dia = String(consultada_en).slice(0, 10);
    return {
      estado: 'consultado_sin_dato', consultada_en: dia,
      frase: `EDGAR consultado el ${dia} y no dio acciones en circulación${motivo ? `: ${motivo}` : ''}`,
    };
  }
  return {
    estado: 'no_consultado', consultada_en: null,
    // La frase dice lo que HAY QUE HACER, no lo que la fuente no hizo.
    frase: 'pendiente de consulta a EDGAR (falta correr ?job=acciones-edgar)',
  };
}

/**
 * A QUIÉN LE FALTA PREGUNTARLE A EDGAR — y por qué a los demás no.
 *
 * Extraído del job para poder probarlo, porque el 2026-09-25 devolvió
 * `candidatos: 0` con 21 hallazgos en el universo y la causa fue un descarte
 * silencioso: el filtro preguntaba `num(acciones_edgar_millones) == null`, y
 * `num(null)` devuelve **0**, no null —`Number(null)` es 0—, así que las 21
 * filas con la columna vacía se descartaban como si ya tuvieran acciones de
 * EDGAR. Un cero sin desglose no se puede depurar: ahora cada descarte se
 * cuenta y la pregunta correcta es "¿tiene un conteo POSITIVO?".
 */
export function candidatosParaEdgar({ entradas = [], veredictos = [], universoPorSymbol = new Map() } = {}) {
  const porSymbol = new Map(entradas.map((e) => [e.symbol, e]));
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const diagnostico = {
    filas: veredictos.length, sin_precio: 0, sin_acciones: 0,
    verificadas: 0, no_usd: 0, ya_con_edgar: 0, candidatos: 0,
  };
  const candidatos = [];
  for (const v of veredictos) {
    const e = porSymbol.get(v.symbol) || {};
    const u = universoPorSymbol.get(v.symbol) || {};
    if (!(n(e.precio_usd) > 0)) { diagnostico.sin_precio++; continue; }
    if (!(n(e.acciones) > 0)) { diagnostico.sin_acciones++; continue; }
    if (v.estado === 'verificada') { diagnostico.verificadas++; continue; }
    if (v.moneda !== 'USD') { diagnostico.no_usd++; continue; }
    if (n(u.acciones_edgar_millones) > 0) { diagnostico.ya_con_edgar++; continue; }
    diagnostico.candidatos++;
    candidatos.push(v.symbol);
  }
  return { candidatos, diagnostico };
}
