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
 * Agrupa para el primer nivel. `cuadros` = los del mapa (ya recortados al
 * top 300 por el servidor); `n` = cuántas empresas se ven de entrada.
 *
 * Devuelve un grupo por sector con `visibles`, `resto` y el `cap_total` que
 * define su área. Un sector sin ningún nombre entre los `n` más grandes
 * igual aparece, con su cuadro de resto: si no, sus empresas quedarían
 * inalcanzables desde el primer nivel.
 */
function agrupaPrimerNivel(cuadros, opts) {
  const o = opts || {};
  const n = o.n || 30;
  const conCap = (cuadros || []).filter((c) => Number.isFinite(c.cap) && c.cap > 0);
  const top = conCap.slice().sort((a, b) => b.cap - a.cap).slice(0, n);
  const visiblePor = new Set(top.map((c) => c.symbol));

  const porSector = new Map();
  for (const c of conCap) {
    const k = c.sector || '—';
    if (!porSector.has(k)) porSector.set(k, { sector: k, cap_total: 0, visibles: [], ocultos: [] });
    const g = porSector.get(k);
    g.cap_total += c.cap;
    (visiblePor.has(c.symbol) ? g.visibles : g.ocultos).push(c);
  }

  const grupos = [...porSector.values()].map((g) => {
    const capOculta = g.ocultos.reduce((a, c) => a + c.cap, 0);
    g.visibles.sort((a, b) => b.cap - a.cap);
    return {
      sector: g.sector,
      cap_total: g.cap_total,
      visibles: g.visibles,
      // El % del resto se mide sobre la capitalización del SECTOR, no sobre
      // la del mapa: es lo que contesta "¿cuánto de este sector no estoy
      // viendo?", que es la pregunta que el cuadro dispara.
      resto: g.ocultos.length
        ? { n: g.ocultos.length, cap: capOculta, pct: g.cap_total > 0 ? (capOculta / g.cap_total) * 100 : null }
        : null,
    };
  });
  grupos.sort((a, b) => b.cap_total - a.cap_total);
  return { grupos, visibles: top.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    squarify, colorDe, ESCALA_COLOR, COLOR_SIN_DATO,
    etiquetaQueCabe, candidatosSector, agrupaPrimerNivel, ABREV_SECTOR,
  };
}
