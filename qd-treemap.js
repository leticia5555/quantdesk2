// ═══════════════════════════════════════════════════════════════════
// qd-treemap.js — el treemap, sin librería.
//
// PURO y en la raíz web para que la página lo cargue con <script src> y el
// test lo importe con require: UN archivo, no dos copias. El encargo pide
// treemap propio sin librería pesada; esto es squarified (Bruls, Huizing,
// van Wijk 2000) en ~60 líneas, menos de lo que pesa cualquier dependencia.
//
// SQUARIFIED, y no slice-and-dice, por una razón concreta: en una tira de
// 390 px de ancho, slice-and-dice produce cuadros de 3 px de alto que no se
// pueden ni ver ni tocar. Squarified mantiene la proporción cerca de 1:1, que
// es lo que hace que un cuadro de 44 px sea un cuadro y no una línea.
// ═══════════════════════════════════════════════════════════════════

const peor = (fila, lado, escala) => {
  if (!fila.length) return Infinity;
  let min = Infinity, max = -Infinity, suma = 0;
  for (const v of fila) { const a = v * escala; suma += a; if (a < min) min = a; if (a > max) max = a; }
  const s2 = suma * suma, l2 = lado * lado;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
};

/**
 * `items` = [{ key, value }] con value > 0. Devuelve [{ key, x, y, w, h }].
 *
 * Los valores no positivos se descartan ANTES: un cuadro de área cero no es
 * un cuadro chiquito, es un cuadro que no existe, y meterlo en la aritmética
 * mete un NaN en el resto.
 */
function squarify(items = [], { x = 0, y = 0, w = 1, h = 1 } = {}) {
  const vivos = items.filter((it) => Number.isFinite(it.value) && it.value > 0);
  const total = vivos.reduce((a, it) => a + it.value, 0);
  if (!vivos.length || total <= 0 || w <= 0 || h <= 0) return [];

  const escala = (w * h) / total;
  const orden = vivos.slice().sort((a, b) => b.value - a.value);
  const out = [];
  let cx = x, cy = y, cw = w, ch = h;
  let fila = [], filaItems = [];

  const cerrarFila = () => {
    if (!filaItems.length) return;
    const suma = fila.reduce((a, v) => a + v, 0) * escala;
    const horizontal = cw >= ch;
    const grosor = horizontal ? suma / ch : suma / cw;
    let off = horizontal ? cy : cx;
    for (let i = 0; i < filaItems.length; i++) {
      const a = fila[i] * escala;
      const largo = horizontal ? a / grosor : a / grosor;
      out.push(horizontal
        ? { key: filaItems[i].key, item: filaItems[i], x: cx, y: off, w: grosor, h: largo }
        : { key: filaItems[i].key, item: filaItems[i], x: off, y: cy, w: largo, h: grosor });
      off += largo;
    }
    if (horizontal) { cx += grosor; cw -= grosor; } else { cy += grosor; ch -= grosor; }
    fila = []; filaItems = [];
  };

  for (const it of orden) {
    const lado = Math.min(cw, ch);
    const conEl = [...fila, it.value];
    if (fila.length && peor(fila, lado, escala) < peor(conEl, lado, escala)) {
      cerrarFila();
      fila = [it.value]; filaItems = [it];
    } else {
      fila = conEl; filaItems.push(it);
    }
  }
  cerrarFila();
  return out;
}

/** El color del cuadro: 7 pasos de −3% a +3%, gris dentro de ±0.5%. */
const ESCALA_COLOR = [
  { max: -3, color: '#8B1A1A' },
  { max: -2, color: '#B4332B' },
  { max: -0.5, color: '#D2635C' },
  { max: 0.5, color: '#3C3C3C' },
  { max: 2, color: '#4CAF7D' },
  { max: 3, color: '#1E9E5F' },
  { max: Infinity, color: '#0B7A42' },
];
const COLOR_SIN_DATO = '#242424';

function colorDe(pct) {
  if (!Number.isFinite(pct)) return COLOR_SIN_DATO;
  for (const p of ESCALA_COLOR) if (pct < p.max) return p.color;
  return ESCALA_COLOR[ESCALA_COLOR.length - 1].color;
}

/* ═══════════════════════════════════════════════════════════════════
   EL PRIMER NIVEL: EMPRESAS, NO SECTORES

   La primera versión abría en los 11 sectores porque 300 cuadros a 390 px
   dan ~10 px de lado y el encargo pide tap ≥44 px. Probado en el teléfono,
   la conclusión fue otra: un mapa de mercado que abre sin una sola empresa
   no es un mapa de mercado.

   Así que el primer nivel son los ~30 nombres MÁS GRANDES, agrupados bajo la
   cabecera de su sector, y cada sector cierra con un cuadro "+N más = X%"
   que lo abre completo. El área de cada sector es su capitalización TOTAL —
   la de los nombres visibles más la del resto—, así que el cuadro del resto
   ocupa exactamente el peso que representa. Ningún cuadro miente de tamaño.
   ═══════════════════════════════════════════════════════════════════ */

const ABREV_SECTOR = {
  'Tecnología': 'Tec.', 'Finanzas': 'Fin.', 'Salud': 'Salud',
  'Consumo discrecional': 'Cons. disc.', 'Consumo básico': 'Cons. bás.',
  'Energía': 'Energía', 'Industriales': 'Ind.', 'Materiales': 'Mat.',
  'Servicios públicos': 'Serv. púb.', 'Inmobiliario': 'Inmob.',
  'Comunicaciones': 'Com.',
};

/**
 * La etiqueta MÁS LARGA QUE CABE, de una lista de candidatos ordenada de más
 * completa a más corta. Si no cabe ninguna, null — mejor un cuadro sin texto
 * que uno con "omunicacione".
 *
 * El ancho se estima: en monoespaciada un carácter mide ~0.6 em, y se deja
 * un margen. Estimar de menos corta palabras; estimar de más sólo abrevia
 * antes de tiempo, que es el lado barato del error.
 */
function etiquetaQueCabe(candidatos, anchoPx, fontPx, opts) {
  const o = opts || {};
  const factor = o.factor || 0.62;
  const margen = o.margen == null ? 8 : o.margen;
  const util = anchoPx - margen;
  for (const c of candidatos) {
    if (!c) continue;
    if (String(c).length * fontPx * factor <= util) return String(c);
  }
  return null;
}

/** Los candidatos de una cabecera de sector, de más completo a más corto. */
function candidatosSector(nombre, abrev) {
  return [nombre, abrev || ABREV_SECTOR[nombre], String(nombre || '').slice(0, 3) + '.'];
}

/**
 * EL MAPA DIBUJA TODAS LAS EMPRESAS. Siempre. Sin agrupar.
 *
 * Antes el primer nivel mostraba los ~30 nombres más grandes y cerraba cada
 * sector con un "+N más = X%". Se cayó contra el teléfono por una razón que
 * ningún test iba a ver: un sector cuyas empresas no entraban al top 30
 * aparecía como **"+55 más · 100%"** — un sector entero sin una sola empresa,
 * y un cuadro de resto que era el 100% de lo que decía resumir. El agregado
 * había dejado de ser un resumen para ser una tapa.
 *
 * La regla ahora es la de Finviz: cada empresa es un cuadro con área =
 * capitalización, y el texto se pinta **sólo si cabe**. Un cuadro de 3px
 * existe, se toca y no lleva letra. Al entrar al sector, las chicas crecen y
 * ahí sí caben.
 *
 * Esto mueve un poste del encargo —la regla 6 pide tap ≥44px— y está dicho a
 * propósito: el ≥44px pasa a valer para los controles y las cabeceras de
 * sector, que son la navegación de verdad. Los cuadros se tocan a cualquier
 * tamaño.
 */
function agrupaPorSector(cuadros) {
  const conCap = (cuadros || []).filter((c) => Number.isFinite(c.cap) && c.cap > 0);
  const porSector = new Map();
  for (const c of conCap) {
    const k = c.sector || '—';
    if (!porSector.has(k)) porSector.set(k, { sector: k, cap_total: 0, items: [] });
    const g = porSector.get(k);
    g.cap_total += c.cap;
    g.items.push(c);
  }
  const grupos = [...porSector.values()].map((g) => {
    g.items.sort((a, b) => b.cap - a.cap);
    return g;
  });
  grupos.sort((a, b) => b.cap_total - a.cap_total);
  return { grupos, empresas: conCap.length };
}

/** Cuánto mide un texto en monoespaciada, en px. Un sitio, una vez. */
function anchoTexto(txt, fontPx, factor) {
  return String(txt || '').length * fontPx * (factor || 0.62);
}

/**
 * QUÉ TEXTO LLEVA UN CUADRO, dado su tamaño real en píxeles.
 *
 * Tres resultados posibles, y el tercero es tan válido como los otros dos:
 *   · ticker + %  — cuando caben las dos líneas;
 *   · sólo ticker — cuando cabe una;
 *   · nada        — cuando no cabe ninguna. El cuadro va de color y se toca.
 *
 * Nunca se recorta a mitad de palabra. "NVDA" entero o nada: media palabra no
 * es información, es ruido con forma de información.
 */
function etiquetaCuadro(w, h, opts) {
  const o = opts || {};
  const font = o.fontPx || 11;
  const factor = o.factor || 0.62;
  const margen = o.margen == null ? 4 : o.margen;
  const ticker = o.ticker ? String(o.ticker) : '';
  const pct = o.pct == null ? null : String(o.pct);

  const utilW = w - margen * 2;
  if (!ticker || utilW <= 0 || h <= 0) return { ticker: null, pct: null, font: null };

  // ESCALERA DE TAMAÑOS, como Finviz. Con un solo tamaño, un cuadro que le
  // queda 2px corto se va sin letra aunque haya sitio de sobra para una letra
  // un punto más chica. Se prueba de mayor a menor y se usa la primera que
  // entra — nunca se recorta el texto para que quepa.
  //
  // El ANCHO lleva margen —el texto no puede tocar el borde— pero el ALTO no:
  // un cuadro de 12px con letra de 11 sí lleva su ticker, apretado y legible.
  const min = o.fontMin || 8;
  // La escalera baja HASTA `fontMin`, no tres puntos y para. Con base 13 se
  // cortaba en 10 y los cuadros de ~28px se iban sin letra teniendo sitio
  // para una de 8 — justo los que la regla quiere rescatar.
  const escalera = o.escalera || Array.from({ length: Math.max(0, font - min + 1) }, (_, i) => font - i);
  let elegida = null;
  for (const f of escalera) {
    if (h >= f && anchoTexto(ticker, f, factor) <= utilW) { elegida = f; break; }
  }
  if (elegida == null) return { ticker: null, pct: null, font: null };

  const fontPct = Math.max(min - 1, elegida - 2);
  const cabePct = pct != null
    && h >= elegida + fontPct + 2
    && anchoTexto(pct, fontPct, factor) <= utilW;
  return { ticker, pct: cabePct ? pct : null, font: elegida, font_pct: cabePct ? fontPct : null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    squarify, colorDe, ESCALA_COLOR, COLOR_SIN_DATO,
    etiquetaQueCabe, candidatosSector, ABREV_SECTOR,
    agrupaPorSector, etiquetaCuadro, anchoTexto,
  };
}
