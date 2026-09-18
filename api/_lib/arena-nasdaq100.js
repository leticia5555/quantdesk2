// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-nasdaq100.js — los constituyentes del Nasdaq 100, gratis.
//
// POR QUÉ EXISTE: Invesco (QQQ) empezó a devolver HTML en vez del CSV —metieron
// protección anti-bot, no es algo que arregle un header— y los dos endpoints de
// FMP contestan 402/403 porque los constituyentes son de pago. El universo
// venía saliendo solo con el S&P 500.
//
// ── ADVERTENCIA HONESTA SOBRE CÓMO SE ESCRIBIÓ ESTE ARCHIVO ──────────
// El entorno donde se programó esto NO PUDO ALCANZAR ninguna de las dos
// fuentes: la política de egress rechazó el CONNECT a en.wikipedia.org y a
// www.slickcharts.com. O sea que los parsers se escribieron SIN VER el HTML
// real, contra fixtures construidas a mano.
//
// Eso cambia el diseño entero. No se puede confiar en posiciones de columna ni
// en nombres de clase CSS que nadie verificó. Así que:
//
//   1. Cada parser extrae PERMISIVAMENTE y se ancla a lo más estructural que
//      tiene su fuente (en slickcharts, los enlaces /symbol/TICKER; en
//      Wikipedia, las celdas de las filas de tabla del wikitext).
//   2. Cada lista pasa por una horquilla DURA de tamaño. El piso de 80 ya
//      existía; el techo es nuevo y es el que atrapa el error que de verdad
//      importa: un parser que agarra de más devuelve 400 nombres, y 400
//      nombres no son un índice de 100 — son basura con forma de ticker.
//   3. EL GUARD DE VERDAD ES EL CRUCE. Dos fuentes independientes que
//      coinciden en ~el 90% de los nombres no están las dos mal de la misma
//      manera. Si no coinciden, esto devuelve null y el índice se queda
//      vacío, que es exactamente lo que hace hoy — nunca peor.
//
// El Nasdaq 100 es OPCIONAL en el universo: que falte no rompe nada. Por eso
// fallar cerrado acá es barato y equivocarse es caro.
// ═══════════════════════════════════════════════════════════════

const TICKER = /^[A-Z][A-Z0-9]{0,4}$/;   // Nasdaq: sin puntos ni clases de acción con sufijo

// Tokens con forma de ticker que NO son tickers y que aparecen en estas
// páginas. Existe porque el regex de arriba no puede distinguir "GICS" de
// "AAPL" — los dos son cuatro mayúsculas.
export const RUIDO = new Set([
  // Encabezados y jerga de tabla. Ninguno es un ticker de Nasdaq.
  'GICS', 'ISIN', 'CIK', 'CUSIP', 'SIC', 'ICB', 'USD', 'ETF', 'NYSE',
  // Cromo de wiki que puede quedar en una celda.
  'EDIT', 'HELP', 'MAIN', 'TALK', 'VIEW', 'PAGE', 'LIST', 'DATE', 'NAME', 'TICKER',
]);

// ── LO QUE SE SACÓ DE ESTA LISTA, Y POR QUÉ IMPORTA ──────────────────
// La primera versión traía las abreviaturas de los meses ('JAN'..'DEC') y los
// sufijos societarios ('INC', 'CORP', 'PLC', 'LTD', 'NV', 'SA', 'AG', 'CO').
// Las dos tandas estaban MAL:
//
//   · MAR es Marriott International, constituyente REAL del Nasdaq 100. La
//     lista lo habría borrado en silencio de las DOS fuentes a la vez — o sea
//     sin que el cruce lo notara, porque las dos se filtran igual. Un nombre
//     desaparecido que ningún guard puede ver es el peor tipo de bug acá.
//   · Varios sufijos societarios también son tickers reales (CO cotiza).
//
// Y no compraban nada: un sufijo societario nunca aparece SOLO en una celda
// (va dentro de "Apple Inc.", que es Title Case y se descarta por el caso), y
// una columna de fechas trae "2019-11-21" o "November 21, 2019", no "MAR". La
// selección de columna por consistencia posicional ya descarta esas columnas
// enteras. Filtrar por lista lo que la estructura ya filtra solo agrega
// falsos positivos sobre nombres verdaderos.
//
// REGLA: en esta lista solo entra un token que NO PUEDE ser un ticker de este
// índice. Ante la duda, se deja pasar: un nombre de más lo tira la admisión;
// un nombre de menos no lo nota nadie.

// La horquilla. El índice tiene ~100 nombres (a veces 101: una empresa puede
// tener dos clases de acción). Un parseo que devuelve 300 agarró la página
// entera; uno que devuelve 40 agarró media tabla. Ninguno es la lista.
export const MIN_NOMBRES = 80;
export const MAX_NOMBRES = 130;

// Cuánto tienen que coincidir las dos fuentes, sobre la MÁS CHICA de las dos.
// 0.85 tolera un rebalanceo que una fuente ya reflejó y la otra no (son 2-5
// nombres al año) y NO tolera que una de las dos esté leyendo otra cosa.
export const CRUCE_MINIMO = 0.85;

const limpiar = (s) => String(s || '').trim().toUpperCase();

// ── LA MAYÚSCULA ES EL DISCRIMINANTE, Y POR ESO NO SE NORMALIZA ANTES ─
// Primera versión de esto: pasaba la celda por toUpperCase() y DESPUÉS probaba
// la forma. El propio test lo tumbó en el primer intento — "Apple" pasa a
// "APPLE", que son cinco mayúsculas y cumple el regex de ticker. El parser de
// Wikipedia devolvía APPLE, AAPL, MSFT.
//
// Un ticker en la fuente YA viene en mayúsculas; un nombre de empresa viene en
// Title Case. Esa diferencia es gratis y separa las dos cosas perfectamente,
// pero solo si se mira ANTES de normalizar. Normalizar primero destruye
// justamente la señal que se necesita.
//
// (Éste es exactamente el tipo de error que se habría visto en dos segundos
// mirando la página real, y que acá hubo que atrapar con una fixture.)
export function esTickerPlausible(t, { yaNormalizado = false } = {}) {
  const crudo = String(t || '').trim();
  if (!crudo) return false;
  if (!yaNormalizado && crudo !== crudo.toUpperCase()) return false;   // Title Case → no es ticker
  const s = crudo.toUpperCase();
  return TICKER.test(s) && !RUIDO.has(s);
}

function horquilla(symbols, fuente) {
  const n = symbols.length;
  if (n < MIN_NOMBRES) return { ok: false, reason: 'lista_corta', fuente, recibidos: n, minimo: MIN_NOMBRES };
  if (n > MAX_NOMBRES) return { ok: false, reason: 'lista_larga', fuente, recibidos: n, maximo: MAX_NOMBRES,
    detail: `${n} nombres no son un índice de 100: el parser agarró de más y estaría metiendo basura al universo.` };
  return { ok: true };
}

// ── SLICKCHARTS ──────────────────────────────────────────────────────
// Ancla estructural: cada fila enlaza el símbolo como /symbol/TICKER. Eso no
// depende de en qué columna esté ni de cómo se llame la clase CSS.
export function parseSlickcharts(html) {
  const out = [];
  const visto = new Set();
  const re = /\/symbol\/([A-Za-z0-9.-]{1,6})/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    // Acá el ticker sale del href, donde el caso no significa nada: se
    // normaliza y se salta la prueba de mayúsculas.
    const t = limpiar(m[1]);
    if (!esTickerPlausible(t, { yaNormalizado: true }) || visto.has(t)) continue;
    visto.add(t); out.push(t);
  }
  return out;
}

// ── WIKIPEDIA ────────────────────────────────────────────────────────
// Se pide el WIKITEXT por la API (`action=parse&prop=wikitext`), no el HTML
// renderizado: el wikitext cambia mucho menos y no trae el cromo de la página
// (navegación, pies, plantillas) que sí ensucia el HTML.
//
// En una tabla de wikitext cada celda arranca con `|` o `||`. El ticker es una
// celda que, después de quitar el marcado de enlaces, es un token con forma de
// ticker Y NADA MÁS. Esa última condición es la que descarta "[[Apple Inc.]]":
// el nombre de la empresa nunca es un token solo de ≤5 mayúsculas.
export function parseWikitextNasdaq(wikitext) {
  const texto = String(wikitext || '');

  // ── POR QUÉ NO ALCANZA CON "LA CELDA PARECE UN TICKER" ─────────────
  // Primera versión: se tomaba CUALQUIER celda con forma de ticker. El test lo
  // tumbó — una celda de UNA letra mayúscula (una clase de acción, una
  // inicial, una nota al pie) cumple `^[A-Z][A-Z0-9]{0,4}$`, así que otra
  // columna se colaba.
  //
  // La señal que sí existe sin ver la página es POSICIONAL: en una tabla de
  // constituyentes, la columna del ticker es ticker en TODAS las filas. Una
  // columna que a veces trae algo con forma de ticker es otra cosa. Así que se
  // arman las filas, se cuenta por columna, y se publica SOLO la que gana.
  // Eso también hace al parser inmune a que la columna cambie de lugar.
  const filas = [];
  for (const linea of texto.split('\n')) {
    const l = linea.trim();
    if (!l.startsWith('|') || l.startsWith('|-') || l.startsWith('|+')) continue;
    filas.push(l.replace(/^\|+/, '').split('||').map(limpiarCelda));
  }
  if (!filas.length) return [];

  const columnas = Math.max(...filas.map((f) => f.length));
  let mejor = -1;
  let mejorCuenta = 0;
  for (let c = 0; c < columnas; c++) {
    let cuenta = 0;
    for (const f of filas) if (esTickerPlausible(f[c])) cuenta++;
    if (cuenta > mejorCuenta) { mejorCuenta = cuenta; mejor = c; }
  }
  if (mejor < 0) return [];

  const out = [];
  const visto = new Set();
  for (const f of filas) {
    const celda = f[mejor];
    if (!esTickerPlausible(celda)) continue;
    const t = limpiar(celda);
    if (visto.has(t)) continue;
    visto.add(t); out.push(t);
  }
  return out;
}

// Quita el marcado de enlace y etiquetas de una celda de wikitext, SIN tocar
// el caso: [[X|Y]] → Y, [[X]] → X.
function limpiarCelda(celdaCruda) {
  return String(celdaCruda || '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/''+/g, '')
    .trim();
}

// ── LAS DESCARGAS ────────────────────────────────────────────────────
// `fetchImpl` inyectable: así todo esto se prueba contra fixtures sin red, que
// es la única forma en que se pudo probar.
const UA = 'QuantDesk-Arena/1.0 (experimento público de paper trading; contacto en github.com/leticia5555/quantdesk2)';

export const URL_WIKIPEDIA = 'https://en.wikipedia.org/w/api.php?action=parse&page=Nasdaq-100&prop=wikitext&format=json&formatversion=2';
export const URL_SLICKCHARTS = 'https://www.slickcharts.com/nasdaq100';

async function bajar(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r || !r.ok) {
    const err = new Error('HTTP ' + ((r && r.status) || 0));
    err.status = (r && r.status) || 0;
    throw err;
  }
  return r.text();
}

export async function fetchWikipedia({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const texto = await bajar(URL_WIKIPEDIA, { fetchImpl, timeoutMs });
  let j = null;
  try { j = JSON.parse(texto); } catch { const e = new Error('respuesta no es JSON'); e.reason = 'json_invalido'; throw e; }
  const wikitext = j && j.parse && (typeof j.parse.wikitext === 'string' ? j.parse.wikitext : (j.parse.wikitext && j.parse.wikitext['*']));
  if (!wikitext) { const e = new Error('la respuesta no trae wikitext'); e.reason = 'sin_wikitext'; throw e; }
  return parseWikitextNasdaq(wikitext);
}

export async function fetchSlickcharts({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  return parseSlickcharts(await bajar(URL_SLICKCHARTS, { fetchImpl, timeoutMs }));
}

// ── EL CRUCE, que es el guard de verdad ──────────────────────────────
// Devuelve { symbols, source, cruce } o null. NUNCA lanza: el caller baja un
// escalón igual que con las otras fuentes.
export async function fetchNasdaq100({ now = new Date(), fetchImpl = fetch, diag = null, deps = {} } = {}) {
  const anota = (fila) => { if (Array.isArray(diag)) diag.push({ fuente: 'tabla_publica', index: 'nasdaq100', ...fila }); };
  const wiki = deps.fetchWikipedia || fetchWikipedia;
  const slick = deps.fetchSlickcharts || fetchSlickcharts;

  const [rw, rs] = await Promise.allSettled([wiki({ fetchImpl }), slick({ fetchImpl })]);

  const evaluar = (res, fuente) => {
    if (res.status !== 'fulfilled') {
      anota({ origen: fuente, ok: false, reason: res.reason && res.reason.reason ? res.reason.reason : 'fallo', status: res.reason && res.reason.status, detail: String((res.reason && res.reason.message) || res.reason) });
      return null;
    }
    const symbols = res.value || [];
    const h = horquilla(symbols, fuente);
    if (!h.ok) { anota({ origen: fuente, ok: false, ...h }); return null; }
    anota({ origen: fuente, ok: true, recibidos: symbols.length });
    return symbols;
  };

  const deWiki = evaluar(rw, 'wikipedia');
  const deSlick = evaluar(rs, 'slickcharts');

  if (!deWiki && !deSlick) { anota({ ok: false, reason: 'ninguna_fuente' }); return null; }

  // UNA SOLA FUENTE NO SE PUBLICA SIN DECIRLO. Pasa la horquilla, así que no es
  // basura, pero nadie la corroboró — y estos parsers se escribieron sin poder
  // ver la página real. Se acepta (el índice es opcional: tenerlo a medias es
  // mejor que no tenerlo) y el journal lleva el asterisco.
  if (!deWiki || !deSlick) {
    const symbols = deWiki || deSlick;
    const origen = deWiki ? 'wikipedia' : 'slickcharts';
    anota({ ok: true, reason: 'sin_cruce', origen, recibidos: symbols.length,
      detail: 'La otra fuente no contestó o no pasó la horquilla. La lista pasa el piso y el techo, pero NADIE la corroboró.' });
    return { index: 'nasdaq100', source: 'tabla_publica', origen, built_at: now.toISOString(), symbols, sectores: {},
      cruce: { estado: 'sin_cruce', origen, n: symbols.length } };
  }

  const setSlick = new Set(deSlick);
  const comunes = deWiki.filter((t) => setSlick.has(t));
  const menor = Math.min(deWiki.length, deSlick.length);
  const ratio = menor ? comunes.length / menor : 0;

  if (ratio < CRUCE_MINIMO) {
    // LAS DOS PASARON LA HORQUILLA Y NO SE PARECEN: al menos una está leyendo
    // otra cosa. No hay forma de saber cuál desde acá, así que no se elige —
    // se falla cerrado y el índice se queda como está hoy, vacío.
    anota({ ok: false, reason: 'cruce_insuficiente', ratio: +ratio.toFixed(3), minimo: CRUCE_MINIMO,
      wikipedia: deWiki.length, slickcharts: deSlick.length, comunes: comunes.length,
      detail: 'Las dos listas pasan el piso y el techo pero no coinciden. Al menos una está parseando otra cosa y no se puede saber cuál: NO se publica ninguna.' });
    return null;
  }

  // Se publica la INTERSECCIÓN: un nombre que aparece en las dos fuentes
  // independientes es el único del que se puede afirmar algo. Los que están en
  // una sola suelen ser un rebalanceo que la otra todavía no reflejó, y entran
  // solos la semana que viene — el refresco es semanal.
  const h = horquilla(comunes, 'interseccion');
  if (!h.ok) { anota({ ok: false, ...h, detail: 'La intersección quedó fuera de la horquilla.' }); return null; }

  anota({ ok: true, reason: 'cruzado', ratio: +ratio.toFixed(3), wikipedia: deWiki.length, slickcharts: deSlick.length, publicados: comunes.length });
  return {
    index: 'nasdaq100', source: 'tabla_publica', origen: 'wikipedia+slickcharts',
    built_at: now.toISOString(), symbols: comunes, sectores: {},
    cruce: { estado: 'cruzado', ratio: +ratio.toFixed(3), wikipedia: deWiki.length, slickcharts: deSlick.length, publicados: comunes.length },
  };
}
