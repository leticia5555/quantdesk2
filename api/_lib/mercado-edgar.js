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

/**
 * CUÁNDO DOS CONTEOS DE ACCIONES LE GANAN A LA CAP DECLARADA.
 *
 * MNST, APH y VMRK (corrida del 2026-09-28): las acciones de la portada de
 * EDGAR × nuestro cierre dan 2× la cap que declara Finnhub, y las acciones que
 * declara Finnhub × nuestro cierre dan TAMBIÉN 2×. O sea que los dos conteos de
 * acciones concuerdan entre sí y la que se sale es la cap declarada — el patrón
 * de un split 2:1 que la cap de Finnhub no reflejó.
 *
 * Regla de Lety del 2026-09-29: cuando los dos conteos coinciden dentro de este
 * umbral, se verifica con `calc: edgar×neon` y la cap declarada se DESCARTA,
 * diciéndolo.
 *
 * ESTE 5% NO ES EL DE G2 aunque coincida el número, y por eso es su propia
 * constante: G2 compara una cap declarada contra una reconstruida; acá se
 * comparan dos CONTEOS DE ACCIONES, que es una pregunta distinta y con otra
 * deriva esperada (recompras y emisiones entre la portada y hoy).
 *
 * Y una honestidad sobre la palabra "independientes": no sabemos de dónde saca
 * Finnhub su `shareOutstanding`, y bien puede venir de los mismos filings. Lo
 * que hace segura la regla no es la independencia de las fuentes: es que el
 * número que se PINTA sigue siendo el nuestro —acciones × nuestro cierre— y
 * nunca la cap declarada. Si los dos conteos estuvieran mal por la misma razón,
 * el tamaño estaría mal; pero entonces también lo estaría el de las 286 que ya
 * se verifican por este camino.
 */
export const UMBRAL_ACUERDO_ACCIONES_PCT = 5;

/**
 * CUÁNTO PUEDE ENVEJECER UNA PORTADA.
 *
 * CMCSA (misma corrida) resolvió con una portada del **2009-12-31**: el
 * concepto de ese CIK no traía nada más nuevo con forma de 10-Q/10-K, y el
 * lector tomó lo más reciente que había sin preguntarse si eso era reciente.
 * Un conteo de acciones de hace 17 años multiplicado por el cierre de hoy es un
 * número inventado con dos datos reales.
 *
 * 15 meses = un año fiscal más el trimestre de gracia para presentarlo. Pasado
 * eso, gris con la causa diciendo DE QUÉ AÑO es lo único que EDGAR tiene, que
 * es lo que permite decidir si hay que buscar el conteo en otra parte.
 */
export const MAX_MESES_PORTADA = 15;

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
    // `shares: object` no alcanzó para entender qué llegó en BE: un objeto
    // puede ser un hecho suelto o un diccionario de hechos, y se arreglan
    // distinto. Así que la huella también dice SUS claves.
    if (v && typeof v === 'object') {
      const dentro = Object.keys(v).slice(0, 6).join('|');
      return `${k}: objeto con claves {${dentro}${Object.keys(v).length > 6 ? '…' : ''}}`;
    }
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
  if (Array.isArray(u)) return { filas: u, unidad: null, forma: 'units es el arreglo' };
  if (!u || typeof u !== 'object') return { filas: [], unidad: null, forma: null };

  // Un OBJETO de hechos también es una colección de hechos. BE llegó así en la
  // corrida del 2026-09-28 —la huella dijo `units: objeto con {shares: object}`—
  // y el lector, que ya no reventaba, tampoco entendía la forma: devolvía cero
  // filas. `Object.values` la entiende, y se valida que lo de dentro tenga
  // pinta de hecho (`val` con `end` o `form`) antes de tratarlo como tal: un
  // objeto cualquiera no se convierte en hechos por tener valores.
  const comoFilas = (v) => {
    if (Array.isArray(v)) return { filas: v, forma: 'arreglo' };
    if (!v || typeof v !== 'object') return null;
    const vals = Object.values(v);
    const hechos = vals.filter((x) => x && typeof x === 'object' && !Array.isArray(x)
      && num(x.val) != null && (x.end || x.form));
    if (!hechos.length) return null;
    return { filas: hechos, forma: `objeto con ${hechos.length} de ${vals.length} valores con pinta de hecho` };
  };

  const pref = comoFilas(u[preferida]);
  if (pref) return { filas: pref.filas, unidad: preferida, forma: pref.forma };
  for (const [k, v] of Object.entries(u)) {
    const r = comoFilas(v);
    if (r) return { filas: r.filas, unidad: k, forma: r.forma };
  }
  return { filas: [], unidad: null, forma: null };
}

/**
 * UN PEDAZO DE LA RESPUESTA CRUDA, PARA PODER MIRARLA.
 *
 * La huella dice la forma; esto dice el CONTENIDO. Cuando una respuesta no se
 * entiende, lo que hace falta es verla — y desde el contenedor donde se
 * construye esto no hay salida a sec.gov, así que la única manera de que
 * aparezca en pantalla es que el job la traiga recortada. Va sólo para los que
 * fallan: la respuesta completa de un CIK son cientos de KB.
 */
export function muestraCruda(json, max = 600) {
  let txt;
  try { txt = JSON.stringify(json); } catch { return '(no serializable)'; }
  if (txt == null) return String(json);
  return txt.length > max ? `${txt.slice(0, max)}… (${txt.length} caracteres en total)` : txt;
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
export function accionesDeCompanyConcept(json, {
  formas = FORMAS_CON_PORTADA, hoy = new Date(), maxMeses = MAX_MESES_PORTADA,
} = {}) {
  const { filas: unidades, unidad, forma } = filasDeUnits(json);
  const validas = unidades.filter((u) => {
    const v = num(u && u.val);
    return v != null && v > 0 && u.end && formas.includes(String(u.form || ''));
  });
  const base = { acciones: null, fecha_portada: null, presentado_en: null, form: null, unidad, forma };
  if (!validas.length) {
    return {
      ...base,
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
  const portada = String(u.end);

  // ── VARIAS CLASES DE ACCIONES ────────────────────────────────────────
  // BX presenta una línea de portada por clase, y la API de companyconcept no
  // dice de qué clase es cada hecho —la clase vive en el contexto XBRL, que acá
  // no viaja—. Tomar el primero cuenta de menos, así que `acciones` sigue en
  // null y el conteo NO entra por la puerta de siempre.
  //
  // LO QUE SÍ SE PUEDE: la SUMA viaja aparte, como candidata. Sumar es adivinar
  // que están todas y sin repetir —dos clases con el MISMO conteo se colapsan
  // acá y la suma quedaría corta—, y por eso la suma no se pinta sola: sólo se
  // acepta si un conteo INDEPENDIENTE (el de Finnhub) la confirma dentro del
  // mismo techo del 5% que Lety fijó el 2026-09-28 para MNST/APH/VMRK. Si la
  // suma se comió una clase o contó una de más, no concuerda y se queda gris
  // con su causa. Es la misma regla de siempre: dos mediciones que coinciden
  // valen; una sola que podría estar incompleta, no.
  //
  // NO SE PUDO COMPROBAR CONTRA EDGAR DE VERDAD: este contenedor no tiene
  // salida a sec.gov (403 del proxy), así que la forma viene de la respuesta
  // que el job ya guardó y la aritmética se prueba con fixtures. Lo que
  // protege al mapa no es que yo haya visto el JSON de BX: es el acuerdo.
  const mismaPortada = orden.filter((x) => String(x.end) === portada && String(x.filed || '') === String(u.filed || ''));
  const valores = [...new Set(mismaPortada.map((x) => num(x.val)))];
  if (valores.length > 1) {
    const conteos = valores.slice().sort((a, b) => b - a);
    return {
      ...base, fecha_portada: portada, presentado_en: u.filed ? String(u.filed) : null, form: String(u.form),
      clases: conteos.length, conteos,
      suma_clases: conteos.reduce((a, b) => a + b, 0),
      motivo: `EDGAR reporta ${conteos.length} conteos distintos para la portada del ${portada} (${conteos.join(' / ')}): son varias clases de acciones y la API no dice cuál es cuál, así que tomar uno contaría de menos; la suma (${conteos.reduce((a, b) => a + b, 0)}) sólo vale si otro conteo la confirma`,
    };
  }

  // ── LA PORTADA NO PUEDE SER DE OTRA ÉPOCA ────────────────────────────
  // CMCSA resolvió con una portada del 2009-12-31 porque era lo más nuevo que
  // el concepto traía. Un conteo de hace 17 años por el cierre de hoy es un
  // número inventado con dos datos reales.
  const meses = mesesEntre(portada, hoy);
  if (meses != null && meses > maxMeses) {
    return {
      ...base, fecha_portada: portada, presentado_en: u.filed ? String(u.filed) : null, form: String(u.form),
      meses_de_antiguedad: Math.round(meses),
      motivo: `EDGAR sólo tiene portada de ${portada.slice(0, 4)} (${portada}, ${Math.round(meses)} meses): un conteo de acciones de esa fecha por el cierre de hoy no sostiene un tamaño`,
    };
  }

  return {
    acciones: num(u.val),
    fecha_portada: portada,
    presentado_en: u.filed ? String(u.filed) : null,
    form: String(u.form),
    unidad,
    forma,
    meses_de_antiguedad: meses != null ? Math.round(meses) : null,
    fy: u.fy != null ? Number(u.fy) : null,
    fp: u.fp ? String(u.fp) : null,
    accn: u.accn ? String(u.accn) : null,
    motivo: null,
  };
}

/** Meses entre una fecha ISO y el reloj que se le pase. Null si no se puede. */
export function mesesEntre(fechaIso, hoy = new Date()) {
  const t = Date.parse(String(fechaIso));
  const n = hoy instanceof Date ? hoy.getTime() : Date.parse(String(hoy));
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  return (n - t) / (1000 * 60 * 60 * 24 * 30.4375);
}

/**
 * El veredicto con EDGAR de árbitro.
 *
 * La cap que sale a pintar es **acciones de EDGAR × nuestro último cierre**:
 * las dos mitades medidas, ninguna heredada. La de Finnhub queda de CRUCE — si
 * las dos concuerdan dentro del 10% le creemos al conjunto, y si no, gris con
 * la causa y el múltiplo, que es el que dice si fue un split (≈2×) o deriva.
 */
export function veredictoCapEdgar({
  symbol, declarada_usd, acciones_edgar, acciones_finnhub, precio_usd, fecha_portada,
  suma_clases_edgar = null, clases_edgar = null,
}, umbral = UMBRAL_EDGAR_PCT) {
  const dec = num(declarada_usd);
  const acc = num(acciones_edgar);
  // En ACCIONES, no en millones: el llamador convierte. Mezclar las dos
  // unidades en esta función es cómo se compara 2,800 con 2,800,000,000 y sale
  // "coinciden dentro del 5%" jamás, o peor, siempre.
  const accF = num(acciones_finnhub);
  const px = num(precio_usd);
  const base = { symbol, via: 'edgar', fecha_portada: fecha_portada || null, umbral_pct: umbral };

  const suma = num(suma_clases_edgar);
  const clases = num(clases_edgar);

  // ── LA SUMA DE CLASES, SÓLO SI OTRO CONTEO LA CONFIRMA (BX) ──────────
  // Va ANTES del descarte por falta de `acciones`: para una emisora de varias
  // clases, `acciones` siempre es null a propósito —ningún conteo suelto vale—
  // y la suma es lo único que puede sostener un tamaño. Nunca se contrasta
  // contra la cap DECLARADA: en una emisora de varias clases la declarada es
  // justo el número del que se sospecha, así que arbitrar con ella sería
  // preguntarle al sospechoso. Sólo el acuerdo con un conteo independiente.
  if ((acc == null || acc <= 0) && suma != null && suma > 0 && px != null && px > 0) {
    const dif = accF != null && accF > 0 ? errorPct(accF, suma) : null;
    if (dif != null && Math.abs(dif) <= UMBRAL_ACUERDO_ACCIONES_PCT) {
      const capSuma = suma * px;
      return {
        ...base, estado: 'verificada', auditable: true,
        cap_usd: capSuma,
        fuente: 'calc: edgar×neon',
        via: 'edgar_suma_clases',
        clases, acciones_acuerdo_pct: dif, umbral_acuerdo_pct: UMBRAL_ACUERDO_ACCIONES_PCT,
        error_pct: dec != null && dec > 0 ? errorPct(dec, capSuma) : null,
        multiplo: dec != null && dec > 0 ? dec / capSuma : null,
        motivo: null,
        nota: `acciones sumadas de las ${clases} clases de la portada (${(suma / 1e6).toFixed(1)}M): Finnhub cuenta ${(accF / 1e6).toFixed(1)}M, ${Math.abs(dif).toFixed(1)}% de diferencia, techo ${UMBRAL_ACUERDO_ACCIONES_PCT}%`,
      };
    }
    return {
      ...base, estado: 'gris_punteado', auditable: true, cap_usd: null, error_pct: null, multiplo: null,
      fuente: null, clases,
      motivo: dif == null
        ? `EDGAR da ${clases} clases de acciones y no hay un segundo conteo con el que confirmar la suma (${(suma / 1e6).toFixed(1)}M)`
        : `la suma de las ${clases} clases (${(suma / 1e6).toFixed(1)}M) no concuerda con el conteo de Finnhub (${(accF / 1e6).toFixed(1)}M): ${Math.abs(dif).toFixed(1)}% de diferencia, techo ${UMBRAL_ACUERDO_ACCIONES_PCT}% — o falta una clase o sobra`,
    };
  }

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

  // ── DOS CONTEOS DE ACCIONES QUE COINCIDEN LE GANAN A LA CAP DECLARADA ──
  // MNST, APH y VMRK: EDGAR × cierre da 2× la cap declarada, y Finnhub ×
  // cierre da TAMBIÉN 2×. Los dos conteos concuerdan entre sí; la que se sale
  // es la cap declarada, que es justo el patrón de un split que la cap no
  // reflejó. Esto va ANTES del contraste contra la declarada, porque cuando los
  // conteos concuerdan la declarada ya no es el árbitro: es el sospechoso.
  const acuerdo = accF != null && accF > 0 ? errorPct(accF, acc) : null;
  if (acuerdo != null && Math.abs(acuerdo) <= UMBRAL_ACUERDO_ACCIONES_PCT) {
    return {
      ...base, estado: 'verificada', auditable: true,
      cap_usd: reconstruida,
      fuente: 'calc: edgar×neon',
      via: 'edgar_acuerdo_acciones',
      acciones_acuerdo_pct: acuerdo,
      umbral_acuerdo_pct: UMBRAL_ACUERDO_ACCIONES_PCT,
      // El desajuste con la declarada NO se borra por haberla descartado: queda
      // dicho, porque es lo que explica por qué la fuente dice `edgar`.
      error_pct: dec != null && dec > 0 ? errorPct(dec, reconstruida) : null,
      multiplo: dec != null && dec > 0 ? dec / reconstruida : null,
      // El motivo viaja aunque esté verificada: acá el motivo no es una queja,
      // es la procedencia de una decisión que descartó un dato de la fuente.
      motivo: null,
      nota: `cap declarada de Finnhub descartada: dos conteos de acciones coinciden (EDGAR ${(acc / 1e6).toFixed(1)}M y Finnhub ${(accF / 1e6).toFixed(1)}M, ${Math.abs(acuerdo).toFixed(1)}% de diferencia, techo ${UMBRAL_ACUERDO_ACCIONES_PCT}%)`,
    };
  }

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
