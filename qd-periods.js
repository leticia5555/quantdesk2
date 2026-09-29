/* ═══════════════════════════════════════════════════════════════════
   qd-periods.js — la ÚNICA fuente del % de periodo para /mercado.

   POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO TOCA app.html.

   El bug del % de periodo volvió tres veces en este proyecto: un componente
   calculaba su propio porcentaje y lo pintaba sin decir de qué ventana era
   (un cambio de 30 días rotulado como si fuera diario). `app.html` lo cerró
   con dos piezas compartidas —qdPeriodChange y qdPctTag— y un lint que
   recorre su zona de render.

   /mercado es una página NUEVA y el encargo prohíbe rediseñar app.html. Las
   opciones eran copiar el bloque (dos implementaciones que se desincronizan
   en la primera corrección) o moverlo (tocar un archivo de 5,000 líneas que
   no está en el alcance). Se eligió una tercera: este archivo es la fuente
   de /mercado, app.html se queda como está, y
   `tests/qd-periods-gemelas.test.mjs` corre LAS DOS implementaciones sobre
   las mismas series y falla si difieren en un solo punto. La garantía no es
   "está copiado bien": es que no pueden discrepar sin que el test lo diga.

   LO QUE ESTE ARCHIVO AGREGA: 'YTD'.

   YTD no es un número de sesiones — es una FECHA: el último cierre del año
   pasado. Cuántas sesiones hay hasta ahí depende del día en que se pregunte.
   Por eso `qdPeriodChange` acepta dos formas de ancla, y por eso la serie
   tiene que traer timestamps. Sin ellos NO se estima: se devuelve pct null
   con su motivo, y el render pinta "—" en gris con la causa. Un YTD
   aproximado con 252 sesiones sería exactamente el bug que esto evita.
   ═══════════════════════════════════════════════════════════════════ */

/* También vive acá el chip de estado de mercado, por la misma razón: es
   lógica que la página necesita y que un test tiene que poder correr. El
   encargo pide un chip POR INSTRUMENTO, y /mercado tiene dos bolsas con
   horarios distintos — el de app.html sabe de una sola (EE.UU., con offset
   EDT fijo). */

/* eslint-disable no-unused-vars */

function qdEscHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Periodos del mapa. `tradingDays` = cuántos cierres atrás está el ancla
// (~5/semana, ~21/mes). `ancla:'ytd'` = por fecha, no por conteo.
const QD_PERIODS = {
  '1D': { label: '1D', tradingDays: 1 },
  '1S': { label: '1S', tradingDays: 5 },
  '1M': { label: '1M', tradingDays: 21 },
  'YTD': { label: 'YTD', ancla: 'ytd' },
};

// El ancla de YTD: el último cierre de un año anterior al de `ahora`.
// Devuelve el índice, o null CON motivo — nunca un aproximado.
function qdAnclaYtd(pts, ahora) {
  const now = ahora instanceof Date ? ahora : new Date(ahora || Date.now());
  const anio = now.getUTCFullYear();
  if (!pts.length || !Number.isFinite(pts[0].t)) {
    return { refIdx: null, motivo: 'la serie no trae fechas: YTD se ancla por fecha, no por número de sesiones' };
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    if (new Date(pts[i].t * 1000).getUTCFullYear() < anio) return { refIdx: i, motivo: null };
  }
  const primera = new Date(pts[0].t * 1000).toISOString().slice(0, 10);
  return {
    refIdx: null,
    motivo: 'la serie empieza en ' + primera + ' y no llega al año anterior: no hay cierre de fin de año contra el cual anclar',
  };
}

// Única fuente de verdad del % por periodo. Ningún componente resta precios
// ni divide por su cuenta.
function qdPeriodChange(series, periodKey, ahora) {
  const per = QD_PERIODS[periodKey];
  if (!per) throw new Error('qdPeriodChange: periodo desconocido ' + periodKey);
  const pts = (series || []).filter((p) => p && Number.isFinite(p.c) && p.c > 0);
  const n = pts.length;
  const out = { value: null, pct: null, periodLabel: per.label, window: pts, refIdx: 0, refValue: null, motivo: null };
  if (n < 2) {
    out.motivo = n ? 'la serie trae un solo punto: no hay contra qué comparar' : 'no hay serie para este instrumento';
    return out;
  }
  out.value = pts[n - 1].c;

  let refIdx;
  if (per.ancla === 'ytd') {
    const a = qdAnclaYtd(pts, ahora);
    if (a.refIdx == null) { out.motivo = a.motivo; out.window = pts; return out; }
    refIdx = a.refIdx;
  } else {
    refIdx = Math.max(0, n - 1 - per.tradingDays);
  }

  out.refIdx = refIdx;
  out.refValue = pts[refIdx].c;
  out.window = pts.slice(refIdx);
  if (out.refValue > 0) out.pct = ((out.value - out.refValue) / out.refValue) * 100;
  else out.motivo = 'el cierre del ancla no es un precio válido';
  return out;
}

// Única forma de pintar un %. La etiqueta de periodo es OBLIGATORIA: sin
// ella lanza. `motivo` convierte el "—" mudo en un "—" que dice por qué.
function qdPctTag(pct, periodLabel, opts) {
  if (!periodLabel || typeof periodLabel !== 'string' || !periodLabel.trim())
    throw new Error('qdPctTag: etiqueta de periodo obligatoria — prohibido pintar un % sin decir de qué periodo es');
  opts = opts || {};
  const fin = Number.isFinite(pct);
  const up = fin && pct >= 0;
  const col = !fin ? '#666' : (opts.invert ? (up ? '#E24B4A' : '#00c97d') : (up ? '#00c97d' : '#E24B4A'));
  const txt = fin ? ((up ? '+' : '') + pct.toFixed(2) + '%') : '—';
  const tit = !fin && opts.motivo ? ' title="' + qdEscHTML(opts.motivo) + '"' : '';
  return '<span class="qd-pct" style="color:' + col + '"' + tit + '>' + txt
    + '<span class="qd-pct-per">' + qdEscHTML(periodLabel) + '</span></span>';
}

// Única forma de pintar un PRECIO. Dos decimales siempre; sub-$1, cuatro.
function fmtPrice(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  const dec = (n !== 0 && Math.abs(n) < 1) ? 4 : 2;
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}


/* ═══════════════════════════════════════════════════════════════════
   LA CAPITALIZACIÓN, EN ESPAÑOL Y SIN AMBIGÜEDAD

   La hoja decía "5.51 B" para NVDA. En español "B" se lee como billón, pero
   quien viene de leer mercados en inglés lo lee como *billion* = mil millones:
   un factor de mil de diferencia en el número más grande de la pantalla, y sin
   forma de saber cuál de los dos significa. "790.8 mm" era peor: esa
   abreviatura no existe fuera de esta pantalla.

   Acá no se abrevia. Se escribe la escala con palabras —millones, mil
   millones, billones— y la moneda al lado, porque 60 mil millones de pesos y
   60 mil millones de dólares no son la misma empresa.

   Un solo sitio: si mañana hay que tocar la escala, se toca acá.
   ═══════════════════════════════════════════════════════════════════ */
function qdCap(valor, moneda) {
  const v = Number(valor);
  const mon = moneda ? String(moneda).toUpperCase() : '';
  const cola = mon ? ' ' + mon : '';
  // `Number(null)` es 0 y `Number.isFinite(0)` es true, así que preguntar sólo
  // por finitud devolvía "0 USD" para una cap que no existe. Una cap sin dato es
  // "—", con su causa al lado en la hoja; un cero es un número que nadie midió.
  // (Es el mismo tropiezo que dejó `candidatos: 0` en el job de EDGAR.)
  const a = Math.abs(v);
  if (!Number.isFinite(v) || !(a > 0)) return '—';

  const signo = v < 0 ? '-' : '';
  // Escala LARGA, la del español: un billón son 10¹², no 10⁹.
  const escalas = [
    { corte: 1e12, div: 1e12, palabra: 'billones', dec: 2 },
    { corte: 1e9, div: 1e9, palabra: 'mil millones', dec: 1 },
    { corte: 1e6, div: 1e6, palabra: 'millones', dec: 1 },
  ];
  for (const e of escalas) {
    if (a >= e.corte) {
      const n = (a / e.div).toFixed(e.dec);
      // "1.00 billones" chirría; en singular la palabra cambia.
      const palabra = Number(n) === 1
        ? (e.palabra === 'billones' ? 'billón' : (e.palabra === 'millones' ? 'millón' : 'mil millones'))
        : e.palabra;
      return `${signo}${n} ${palabra}${cola}`;
    }
  }
  // Por debajo del millón no hay escala que ayude: el número entero se lee solo.
  return `${signo}${Math.round(a).toLocaleString('es-MX')}${cola}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QD_PERIODS, qdPeriodChange, qdPctTag, qdAnclaYtd, fmtPrice, qdEscHTML };
}

/* ═══════════════════════════════════════════════════════════════════
   EL CHIP DE ESTADO SE FUE A `qd-mercados.js`

   Acá vivían `QD_BOLSAS`, `qdHoraEn` y `qdEstadoMercado`, con su propia tabla
   de dos bolsas (us, mx) y su propio `Intl`. R2 pide un chip por bolsa para
   ocho, y tener DOS tablas decidiendo si un mercado está abierto es el bug que
   #241 y #245 ya costaron con las capitalizaciones: el job decía una cosa y el
   mapa otra sobre el mismo hecho.

   Así que la tabla es una sola y vive en `qd-mercados.js`, junto con el arreglo
   del hueco que el comentario de acá admitía —"los feriados NO se modelan… un
   día de asueto sale como abierto sin operaciones"—: ahora el horario se
   contrasta con el último cierre y un feriado sale "sin cierre nuevo hoy".

   `qdEstadoMercado` sigue existiendo con el mismo nombre y el mismo shape,
   exportada desde ahí, así que quien la llamaba no cambia. Lo único que cambió
   es que recibe `{ ultimoCierre }` y con eso deja de afirmar "abierto" con el
   horario solo.
   ═══════════════════════════════════════════════════════════════════ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports.qdCap = qdCap;
}
