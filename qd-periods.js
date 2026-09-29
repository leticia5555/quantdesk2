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
   EL CHIP DE ESTADO, UNO POR BOLSA

   Un precio congelado en fin de semana es CORRECTO —es el cierre del
   viernes— pero sin decirlo parece roto. Y con dos mercados en la misma
   página, un solo chip mentiría en uno de los dos: la BMV cierra a las 15:00
   de la CDMX y Nueva York a las 16:00 del Este, que no son la misma hora ni
   con el mismo cambio de horario. México no cambia de horario desde 2022;
   EE.UU. sí, y por eso su offset se toma del reloj del propio navegador en
   vez de fijarse a −4.
   ═══════════════════════════════════════════════════════════════════ */

const QD_BOLSAS = {
  us: { nombre: 'EE.UU.', tz: 'America/New_York', abre: 9.5, cierra: 16, etiqueta: 'NYSE/Nasdaq' },
  mx: { nombre: 'México', tz: 'America/Mexico_City', abre: 8.5, cierra: 15, etiqueta: 'BMV' },
};

// La hora local de una zona, sin librerías: Intl ya sabe los cambios de
// horario, así que preguntarle es más honesto que una tabla de offsets.
function qdHoraEn(tz, ahora) {
  const d = ahora instanceof Date ? ahora : new Date(ahora || Date.now());
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const h = Number(g('hour')), m = Number(g('minute'));
    return { hora: (h % 24) + m / 60, dow: dias[g('weekday')], ok: Number.isFinite(h) };
  } catch (e) {
    return { hora: null, dow: null, ok: false };
  }
}

function qdEstadoMercado(bolsa, ahora) {
  const b = QD_BOLSAS[bolsa];
  if (!b) throw new Error('qdEstadoMercado: bolsa desconocida ' + bolsa);
  const t = qdHoraEn(b.tz, ahora);
  if (!t.ok) {
    return { bolsa, nombre: b.nombre, etiqueta: b.etiqueta, abierto: null, texto: 'horario no disponible', motivo: 'el navegador no resolvió la zona horaria' };
  }
  const finde = t.dow === 0 || t.dow === 6;
  const abierto = !finde && t.hora >= b.abre && t.hora < b.cierra;
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  let d = t.dow;
  if (finde || t.hora < b.abre) { do { d = (d + 6) % 7; } while (d === 0 || d === 6); }
  return {
    bolsa, nombre: b.nombre, etiqueta: b.etiqueta,
    abierto,
    // Los feriados NO se modelan: la BMV y NYSE tienen calendarios distintos y
    // una tabla desactualizada mentiría con más confianza que este texto.
    // Un día de asueto sale como "abierto" sin operaciones, y el pie del mapa
    // dice la fecha del último cierre, que es el dato que desambigua.
    texto: abierto ? 'abierto' : ('cerrado · cierre del ' + DIAS[d]),
    ultimo_dia: DIAS[d],
    motivo: null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports.QD_BOLSAS = QD_BOLSAS;
  module.exports.qdEstadoMercado = qdEstadoMercado;
  module.exports.qdHoraEn = qdHoraEn;
  module.exports.qdCap = qdCap;
}
