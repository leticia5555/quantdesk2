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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { squarify, colorDe, ESCALA_COLOR, COLOR_SIN_DATO };
}
