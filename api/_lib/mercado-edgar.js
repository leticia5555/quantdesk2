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

// ── EL SEGUNDO ESCALÓN: UNA EMISORA QUE TODAVÍA NO PRESENTA 10-Q ─────────
// SPCX salió a bolsa el 2026-09-18 y no se pintaba: la cap de Finnhub era del
// día de la IPO y difería 8% de acciones×precio, y EDGAR "no tenía" el conteo
// de acciones. Cerró en $147.79 y fue de las más operadas del día — un hueco
// de los que se notan (Lety, 2026-10-22).
//
// Y EDGAR SÍ LO TENÍA. `dei:EntityCommonStockSharesOutstanding` es un dato de
// PORTADA, y lo trae cualquier presentación con portada: el prospecto
// (424B4), el registro (S-1) y el 8-K del cierre de la oferta. La lista de
// arriba sólo aceptaba informes periódicos, así que los descartaba.
//
// VA COMO ESCALÓN Y NO MEZCLADO, a propósito: el conteo de un prospecto puede
// ser PREVIO a la oferta, y el de un S-1 puede quedar viejo entre enmiendas.
// Mientras exista un informe periódico, ese manda. Esto entra sólo cuando no
// hay ninguno — que es exactamente el caso de una emisora recién listada — y
// el resultado declara de qué forma salió, para que la procedencia se vea.
// ── LA VERSIÓN DE LA REGLA DE EXTRACCIÓN ────────────────────────────────
// Cuando la regla cambia, lo que la regla VIEJA dio por perdido hay que
// volver a preguntarlo. SPCX quedó marcado "EDGAR consultado el 2026-09-29,
// sin dato" con la regla que sólo aceptaba informes periódicos; al agregar las
// formas de IPO el arreglo no le llegaba, porque nadie vuelve a preguntar algo
// que ya tiene respuesta (Lety, 2026-10-22).
//
// Se sube este número cada vez que cambia QUÉ se acepta. Una fila consultada
// con una versión anterior vuelve a ser candidata, una sola vez, y queda
// marcada con la nueva. No es un "reintentar todo": es "lo que se descartó
// con un criterio que ya no usamos, se descartó por una razón que ya no vale".
//
//   1 → sólo 10-Q/10-K/20-F/40-F
//   2 → + las formas de IPO (424B4, S-1, 8-K…) y se rechaza la portada futura
export const REGLA_EDGAR_VERSION = 2;

export const FORMAS_IPO = ['424B4', '424B1', '424B3', '424B2', 'S-1', 'S-1/A', '8-K', '8-K/A', 'F-1', 'F-1/A'];

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

/**
 * EL CIK DE UN SÍMBOLO, PROBANDO LAS DOS ORTOGRAFÍAS.
 *
 * `company_tickers.json` escribe las clases de acción con GUION —`BRK-B`— y
 * nuestro universo con PUNTO —`BRK.B`—. La búsqueda era directa, así que
 * BRK.B salía `sin_cik` y nunca llegaba a consultar sus acciones (Lety,
 * 2026-10-22).
 *
 * CORRECCIÓN A UN COMENTARIO MÍO: en el PR del mapa escribí que el punto era
 * "la forma de la SEC". Es al revés — la SEC usa guion igual que Yahoo, y el
 * punto es nuestro. Queda dicho acá para que nadie lo lea al revés otra vez.
 *
 * Devuelve también CON QUÉ ortografía casó, porque "no está en EDGAR" y "está
 * con otro nombre" son dos causas distintas y una de ellas es nuestra.
 */
export function cikDe(mapa, symbol) {
  const base = String(symbol || '').toUpperCase().trim();
  if (!base || !mapa) return { cik: null, como: null };
  const formas = [base, base.replace(/\./g, '-'), base.replace(/-/g, '.')];
  for (const f of formas) {
    const cik = mapa.get ? mapa.get(f) : mapa[f];
    if (cik) return { cik, como: f };
  }
  return { cik: null, como: null };
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
  formas = FORMAS_CON_PORTADA, formasRespaldo = FORMAS_IPO,
  hoy = new Date(), maxMeses = MAX_MESES_PORTADA,
} = {}) {
  const { filas: unidades, unidad, forma } = filasDeUnits(json);
  const hoyIso = (hoy instanceof Date ? hoy : new Date(hoy || Date.now())).toISOString().slice(0, 10);
  const utilizable = (u) => {
    const v = num(u && u.val);
    if (v == null || v <= 0 || !u.end) return false;
    // ── UNA PORTADA DEL FUTURO NO EXISTE ──────────────────────────────
    // AAL resolvió con `portada: 2027-07-17` en un 10-Q presentado el
    // 2026-07-23 (Lety, 2026-10-22). Un conteo de acciones fechado un año
    // adelante del día en que se presentó es un error de etiquetado en el
    // propio filing, y multiplicado por el cierre de hoy da un tamaño
    // inventado con dos datos reales — el mismo modo de falla que la portada
    // de 2009 de CMCSA, por el otro extremo.
    //
    // No se corrige la fecha ni se adivina cuál quiso decir: se descarta el
    // hecho y, si no queda ninguno, el símbolo se va a gris con su causa.
    if (String(u.end).slice(0, 10) > hoyIso) return false;
    return true;
  };
  const deFormas = (lista) => unidades.filter((u) => utilizable(u) && lista.includes(String(u.form || '')));

  // Los informes periódicos primero. El escalón de IPO sólo si no hay ninguno.
  let validas = deFormas(formas);
  let escalon = 'periodico';
  if (!validas.length && Array.isArray(formasRespaldo) && formasRespaldo.length) {
    validas = deFormas(formasRespaldo);
    if (validas.length) escalon = 'ipo';
  }
  const base = { acciones: null, fecha_portada: null, presentado_en: null, form: null,
    unidad, forma, escalon: null };
  if (!validas.length) {
    return {
      ...base,
      motivo: unidades.length
        ? (() => {
          // Si lo único que había estaba fechado adelante de hoy, eso es lo
          // que hay que decir: "no trae formas con portada" mandaría a buscar
          // el problema donde no está.
          const futuras = unidades.filter((u) => u && u.end && String(u.end).slice(0, 10) > hoyIso).length;
          if (futuras && futuras === unidades.filter((u) => num(u && u.val) != null && u.end).length) {
            return `EDGAR trae ${futuras} conteo(s) de acciones con fecha de portada POSTERIOR a hoy (la más nueva, ${
              unidades.map((u) => String(u.end)).sort().pop()}): es un error de etiquetado del filing y no se puede usar`;
          }
          return `EDGAR no trae ${formas.join('/')} ni ${(formasRespaldo || []).join('/')} con conteo de acciones utilizable (${unidades.length} hechos en "${unidad}")`;
        })()
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
      // ── QUÉ HAY EN LA RESPUESTA, PARA PODER DEPURARLA DESDE AFUERA ───
      // ACN salió con "EDGAR sólo tiene portada de 2010" y Accenture reporta
      // cada trimestre (Lety, 2026-10-22). Desde este contenedor no hay
      // salida a sec.gov, así que lo único que puede explicar eso es lo que
      // el job traiga en el motivo: cuántos hechos hay, de qué formas y de
      // qué años. Con eso se distingue "la emisora usa otro concepto" de
      // "estamos pegándole al CIK de la entidad vieja" —Accenture Ltd
      // (Bermudas) y Accenture plc (Irlanda) son CIKs distintos— sin tener
      // que adivinar.
      hechos: validas.length,
      formas_presentes: [...new Set(validas.map((x) => String(x.form || '?')))].sort(),
      anios_presentes: [...new Set(validas.map((x) => String(x.end).slice(0, 4)))].sort(),
      // ── LA CAUSA REAL, CONFIRMADA POR LETY (2026-10-22) ─────────────
      // ACN resolvió con portada de 2010 teniendo el CIK correcto
      // (1467373, Accenture plc) y sólo dos hechos, de 2009-2010. Mi
      // hipótesis de la entidad de Bermudas no era.
      //
      // La causa es de la API: `companyconcept` OMITE los hechos con
      // dimensión —los que llevan `StatementClassOfStockAxis`—. Una empresa
      // con varias clases etiqueta la portada POR CLASE, así que desde el
      // trimestre en que empezó a hacerlo sus hechos desaparecen de esta API
      // y lo único que queda es el último sin dimensión, de hace quince años.
      // Lety lo confirmó en el 10-Q de Berkshire: dos
      // `dei:EntityCommonStockSharesOutstanding`, cada uno con su
      // `contextref`.
      //
      // Afecta a TODAS las de varias clases, no sólo a ACN y BRK.B, y no se
      // arregla con esta API: hace falta leer los contextos del filing, o
      // capturar las clases a mano. Va en el motivo para que el próximo que
      // lo vea no vuelva a buscar en el CIK.
      motivo: `EDGAR sólo tiene portada de ${portada.slice(0, 4)} (${portada}, ${Math.round(meses)} meses): un conteo de acciones de esa fecha por el cierre de hoy no sostiene un tamaño`
        + '. Causa frecuente: EDGAR separa la portada por clase y `companyconcept` no trae los hechos'
        + ' con dimensión, así que de una emisora de varias clases sólo queda su último hecho sin'
        + ' dimensión, que puede ser de hace años'
        + ` — ${validas.length} hecho(s) utilizable(s), formas ${[...new Set(validas.map((x) => String(x.form || '?')))].sort().join('/')}`
        + `, años ${[...new Set(validas.map((x) => String(x.end).slice(0, 4)))].sort().join(',')}`,
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
    // De qué escalón salió. `ipo` quiere decir "no hay informe periódico
    // todavía y esto viene de la portada del prospecto o del 8-K". No es peor
    // dato —es el mismo concepto de la misma fuente—, pero la procedencia se
    // declara: la regla 3 pide que cada número diga de dónde sale, y "del
    // 424B4 del 18-sep" no es lo mismo que "del 10-Q del 30-jun".
    escalon,
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
export function candidatosParaEdgar({
  entradas = [], veredictos = [], universoPorSymbol = new Map(), hoy = new Date(),
  traza = null, forzar = null,
} = {}) {
  const hoyIso = (hoy instanceof Date ? hoy : new Date(hoy || Date.now())).toISOString().slice(0, 10);
  const porSymbol = new Map(entradas.map((e) => [e.symbol, e]));
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const diagnostico = {
    filas: veredictos.length, sin_precio: 0, sin_acciones: 0,
    verificadas: 0, verificadas_sin_contraste: 0, no_usd: 0, ya_con_edgar: 0, candidatos: 0,
  };
  const candidatos = [];
  // ── POR QUÉ QUEDÓ FUERA CADA UNO, CON NOMBRE ──────────────────────────
  // Los contadores dicen CUÁNTOS, no CUÁLES. Con SPCX gris y 52 candidatos,
  // saber que hay "N sin acciones" no permite averiguar si SPCX es uno de
  // ellos: hubo que inferirlo, y la inferencia puede estar mal. Ahora cada
  // símbolo excluido viaja con su motivo.
  const excluidos = [];
  // ── UN SÍMBOLO, TODAS SUS COMPUERTAS ──────────────────────────────────
  // `excluidos` se recorta a 40, y con 500 filas eso quiere decir que
  // preguntar "¿y por qué no está SPCX?" no tiene respuesta: no aparece ni
  // entre los candidatos ni entre los excluidos. Dos de las compuertas
  // —verificada-y-cruzada, y ya-con-EDGAR— ni siquiera escriben en
  // `excluidos`: sólo suman a un contador.
  // `traza` sigue a UN símbolo por todas las compuertas, en orden, y dice en
  // cuál se cayó. Es la misma lección del comentario de arriba —los contadores
  // dicen cuántos, no cuáles— aplicada hasta el final (Lety, 2026-10-22).
  const trazaSym = traza ? String(traza).toUpperCase() : null;
  // ── LA LLAVE PARA UN SÍMBOLO, Y POR QUÉ HIZO FALTA ────────────────────
  // El sello que arregló el atoro ("se preguntó con la regla vigente y no dio
  // conteo" es una respuesta cerrada) crea un encierro para un caso concreto:
  // una emisora cuyo 10-Q se presentó HOY. Si se le pregunta a EDGAR antes de
  // que su XBRL esté indexado, contesta "no hay", la fila queda sellada, y la
  // única forma de reabrirla es subir `REGLA_EDGAR_VERSION` — que reabre las
  // 500, no la una.
  //
  // Es exactamente el caso de SPCX el 2026-10-22: 10-Q presentado ese mismo
  // día. `forzar` salta SÓLO las compuertas de "ya se contestó": las
  // estructurales —sin precio, sin conteo de Finnhub, cap en otra moneda—
  // siguen frenando, porque ahí el problema no es que falte preguntar.
  const forzado = forzar ? String(forzar).toUpperCase() : null;
  const pasos = [];
  const anota = (sym, paso, pasa, detalle) => {
    if (trazaSym && sym === trazaSym) pasos.push({ paso, pasa, ...(detalle ? { detalle } : {}) });
  };
  const fuera = (sym, motivo) => { excluidos.push({ symbol: sym, motivo }); };
  for (const v of veredictos) {
    const e = porSymbol.get(v.symbol) || {};
    const u = universoPorSymbol.get(v.symbol) || {};
    anota(v.symbol, 'está en las entradas del mapa', true,
      `estado=${v.estado} moneda=${v.moneda || '—'}`);
    if (!(n(e.precio_usd) > 0)) {
      anota(v.symbol, 'tiene precio en USD', false, `precio_usd=${e.precio_usd ?? 'null'}`);
      diagnostico.sin_precio++; fuera(v.symbol, 'sin precio en USD'); continue;
    }
    anota(v.symbol, 'tiene precio en USD', true, String(e.precio_usd));
    if (!(n(e.acciones) > 0)) {
      anota(v.symbol, 'tiene conteo de acciones de Finnhub', false, `acciones=${e.acciones ?? 'null'}`);
      diagnostico.sin_acciones++; fuera(v.symbol, 'sin conteo de acciones de Finnhub'); continue;
    }
    anota(v.symbol, 'tiene conteo de acciones de Finnhub', true, `${e.acciones} millones`);
    // ── EL LAZO: "VERIFICADA" NO PUEDE SER MOTIVO PARA NO PREGUNTAR ────
    // Acá decía `if (v.estado === 'verificada') continue;` a secas, y eso
    // cerraba un círculo del que SPCX no podía salir:
    //
    //   · `veredictoCapUs` la daba por verificada porque EDGAR no tenía
    //     conteo con qué contradecir a Finnhub;
    //   · y este filtro no la mandaba a EDGAR porque estaba verificada.
    //
    // O sea que el cruce que #320 agregó NUNCA iba a correr para ella, y
    // ningún job lo iba a arreglar: `?job=acciones-edgar` jamás la miraba.
    // Peor, salía por acá ANTES de la lista de `excluidos`, así que tampoco
    // aparecía entre los descartados: desaparecía en un contador (Lety,
    // 2026-10-22).
    //
    // Una verificada SIN conteo de EDGAR está verificada por el par de
    // Finnhub, que concuerda consigo mismo por construcción. Eso no es una
    // verificación, es una tautología — y es exactamente lo que #320 dijo que
    // no alcanza. Así que se pregunta igual: lo que no se puede es dar por
    // confirmado lo que nadie confirmó.
    //
    // Las que SÍ tienen conteo de EDGAR siguen saliendo por acá: ésas se
    // cruzaron de verdad y repreguntarlas gastaría la cuota de la SEC para
    // confirmar lo que ya sabemos.
    const yaCruzada = n(u.acciones_edgar_millones) > 0 || n(u.acciones_edgar_suma_millones) > 0;
    if (v.estado === 'verificada' && yaCruzada && v.symbol !== forzado) {
      anota(v.symbol, 'no es una verificada que YA se cruzó con EDGAR', false,
        `acciones_edgar=${u.acciones_edgar_millones ?? 'null'} suma_clases=${u.acciones_edgar_suma_millones ?? 'null'}`);
      diagnostico.verificadas++;
      fuera(v.symbol, 'verificada y ya cruzada con EDGAR: repreguntarla gastaría cuota de la SEC');
      continue;
    }
    anota(v.symbol, 'no es una verificada que YA se cruzó con EDGAR', true);
    if (v.estado === 'verificada') {
      diagnostico.verificadas_sin_contraste = (diagnostico.verificadas_sin_contraste || 0) + 1;
    }
    if (v.moneda !== 'USD') {
      anota(v.symbol, 'la cap declarada está en USD', false, `moneda=${v.moneda || 'null'}`);
      diagnostico.no_usd++; fuera(v.symbol, `la cap declarada está en ${v.moneda || 'otra moneda'}`); continue;
    }
    anota(v.symbol, 'la cap declarada está en USD', true);
    // ── LA REPREGUNTA POR CAMBIO DE REGLA, ACOTADA ─────────────────────
    // Cuando la regla cambia, lo que la regla VIEJA dio por perdido hay que
    // volver a preguntarlo (SPCX). Pero NO todo: el cambio de la versión 2
    // sólo AGREGÓ formas, así que un conteo que ya salió de un 10-Q sigue
    // siendo el mismo conteo. Repreguntar las 35 filas que ya tienen dato
    // gastaría la cuota de la SEC para confirmar lo que ya sabemos.
    //
    // Se repregunta en dos casos, y los dos son concretos:
    //   · SIN dato y consultado con una regla anterior — lo de SPCX: la
    //     respuesta "no hay" la produjo un criterio que ya no usamos;
    //   · CON dato cuya portada quedó en el futuro — lo de AAL: la versión 2
    //     rechaza esas fechas, así que el dato guardado es inválido aunque
    //     exista.
    const reglaVieja = n(u.edgar_regla) < REGLA_EDGAR_VERSION;
    const tieneDato = n(u.acciones_edgar_millones) > 0;
    const portadaFutura = u.acciones_edgar_portada
      && String(u.acciones_edgar_portada).slice(0, 10) > hoyIso;
    const repreguntar = (reglaVieja && !tieneDato && !!u.edgar_consultada_en)
      || (reglaVieja && portadaFutura);
    if (tieneDato && !repreguntar && v.symbol !== forzado) {
      anota(v.symbol, 'no tiene ya un conteo de EDGAR vigente', false,
        `acciones_edgar=${u.acciones_edgar_millones}`);
      diagnostico.ya_con_edgar++;
      fuera(v.symbol, 'ya tiene conteo de EDGAR con la regla vigente');
      continue;
    }
    anota(v.symbol, 'no tiene ya un conteo de EDGAR vigente', true);

    // ── EL ATORO: SIN DATO TAMBIÉN ES UNA RESPUESTA ────────────────────
    // Una fila sin conteo caía acá SIEMPRE, consultada o no: `tieneDato` era
    // false, así que el filtro de arriba no la frenaba y volvía a la cola en
    // cada corrida. Con `limite=100`, las mismas ~100 ya preguntadas iban
    // adelante en los siete lotes y empujaban a las nuevas: los `ok` bajaron
    // 70 → 20 mientras `sin_dato` subía 29 → 79, y quedaron 158 sin preguntar
    // nunca (Lety, 2026-10-22).
    //
    // El sello ya existía —`registroConsulta` graba `edgar_regla`— pero nadie
    // lo leía para este caso: sólo servía para detectar la regla VIEJA. Ahora
    // "se preguntó con la regla vigente y no dio conteo" es una respuesta
    // cerrada, igual que un conteo. Se reabre sola el día que
    // `REGLA_EDGAR_VERSION` suba, que es justo para lo que ese número existe.
    //
    // Lo que NO sella: un 5xx, un corte de red o un 429. Ésos no pasan por
    // `registroConsulta`, así que `edgar_consultada_en` sigue vacío y la fila
    // vuelve a la cola — que es lo correcto: no hubo respuesta, hubo un error.
    const consultadaConEstaRegla = !!u.edgar_consultada_en && !reglaVieja;
    if (!tieneDato && consultadaConEstaRegla && !portadaFutura && v.symbol !== forzado) {
      anota(v.symbol, 'no se le preguntó ya con la regla vigente', false,
        `consultada_en=${u.edgar_consultada_en} regla=${u.edgar_regla} motivo=${u.edgar_consulta_motivo || '—'}`);
      diagnostico.ya_preguntada_sin_dato = (diagnostico.ya_preguntada_sin_dato || 0) + 1;
      fuera(v.symbol, `ya se le preguntó con la regla ${REGLA_EDGAR_VERSION} y EDGAR no dio conteo`
        + `${u.edgar_consulta_motivo ? `: ${u.edgar_consulta_motivo}` : ''}`);
      continue;
    }
    anota(v.symbol, 'no se le preguntó ya con la regla vigente', true,
      u.edgar_consultada_en ? `consultada_en=${u.edgar_consultada_en} regla=${u.edgar_regla}` : 'nunca preguntada');

    if (repreguntar) {
      diagnostico.repregunta_por_regla = (diagnostico.repregunta_por_regla || 0) + 1;
    }
    const esForzada = v.symbol === forzado;
    if (esForzada) diagnostico.forzada = v.symbol;
    anota(v.symbol, 'ES CANDIDATA', true,
      esForzada ? 'forzada a mano' : (u.edgar_consultada_en ? 'repregunta' : 'nunca preguntada'));
    diagnostico.candidatos++;
    // Una forzada va PRIMERA: se pidió por su nombre, y con `limite` chico no
    // tiene sentido que quede detrás de 300 que nadie nombró.
    candidatos.push({ symbol: v.symbol, consultada_en: u.edgar_consultada_en || null, forzada: esForzada });
  }

  // ── PRIMERO LAS QUE NUNCA SE PREGUNTARON ──────────────────────────────
  // Sin este orden, un lote de 100 vuelve a gastar su cuota en las de
  // siempre. Las nunca preguntadas van primero; entre las repreguntas, la más
  // vieja primero, para que ninguna se quede al fondo para siempre.
  candidatos.sort((a, b) => {
    if (a.forzada !== b.forzada) return a.forzada ? -1 : 1;
    const an = a.consultada_en ? 1 : 0;
    const bn = b.consultada_en ? 1 : 0;
    if (an !== bn) return an - bn;
    if (an === 1) return String(a.consultada_en).localeCompare(String(b.consultada_en));
    return a.symbol.localeCompare(b.symbol);
  });
  diagnostico.nunca_preguntadas = candidatos.filter((c) => !c.consultada_en).length;
  // El recorte se queda, pero ahora se DICE cuántos quedaron afuera de la
  // lista: "40 excluidos" sobre 500 se lee como si fueran 40.
  diagnostico.excluidos_total = excluidos.length;
  diagnostico.excluidos = excluidos.slice(0, 40);
  const salida = { candidatos: candidatos.map((c) => c.symbol), diagnostico };
  if (trazaSym) {
    salida.traza = {
      symbol: trazaSym,
      en_entradas: veredictos.some((v) => v.symbol === trazaSym),
      pasos,
      // La compuerta donde se cayó, dicha de una: es lo que se vino a
      // preguntar.
      se_cayo_en: (pasos.find((p) => !p.pasa) || {}).paso || null,
      es_candidata: candidatos.some((c) => c.symbol === trazaSym),
      forzada: trazaSym === forzado,
    };
    if (!salida.traza.en_entradas) {
      salida.traza.explica = 'no está en las entradas del mapa: o no tiene `market_cap`, '
        + 'o no tiene `sector_etf` (el job mira sólo las que el mapa dibuja), o no está en '
        + '`mercado_universo_us`. Corré `?job=universo` y revisá su fila.';
    }
  }
  return salida;
}
