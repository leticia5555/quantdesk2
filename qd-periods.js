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
  // ── R4: LOS PERIODOS LARGOS DE LA FICHA DE ÍNDICE ──────────────────
  // El artboard 6 pide una tabla de 1D a 5A. Se agregan ACÁ y no en la
  // pantalla por la regla 1: el día que el % de 3M se calcule en un HTML,
  // habrá dos definiciones de "tres meses" y van a discrepar.
  // Las sesiones son las del año bursátil: 252 al año, 21 al mes.
  // Los largos se anclan POR FECHA (`meses`), no contando sesiones. Por qué,
  // abajo en `qdAnclaMeses`.
  '3M': { label: '3M', meses: 3 },
  '6M': { label: '6M', meses: 6 },
  '1A': { label: '1A', meses: 12 },
  '3A': { label: '3A', meses: 36 },
  '5A': { label: '5A', meses: 60 },
  'YTD': { label: 'YTD', ancla: 'ytd' },
};

// Cuántos días de calendario puede quedarse corta la serie sin que el periodo
// se considere no cubierto. Ver `qdAnclaMeses`.
const QD_GRACIA_DIAS = 7;

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

/**
 * EL ANCLA DE UN PERIODO LARGO: POR FECHA, NO CONTANDO SESIONES.
 *
 * "1A" salía "—" con 252 sesiones (Lety, 2026-10-21), que son exactamente un
 * año bursátil. La cuenta pedía 253 porque `tradingDays` es la DISTANCIA en
 * sesiones hasta el ancla y entre 252 cierres hay 251 saltos: un off-by-one.
 *
 * Subir el número a 251 lo habría tapado un día y lo habría dejado igual de
 * frágil: un año de Yahoo trae 250, 252 o 253 cierres según cuántos feriados
 * cayeron en días hábiles, y con 250 la tabla volvería a decir "—" sobre un
 * año entero de datos.
 *
 * La causa de fondo es que "un año" es una distancia de CALENDARIO y se
 * estaba midiendo en sesiones. Así que el ancla es ahora la última sesión en
 * o antes de la misma fecha de hace N meses. Es lo que YTD ya hacía, y por lo
 * mismo.
 *
 * LA GRACIA DE SIETE DÍAS, y por qué no es un número inventado: la serie de
 * un año empieza en el primer día hábil DESPUÉS de la fecha de corte, así que
 * casi nunca hay un cierre en o antes del ancla exacta — por un fin de semana
 * o un feriado. Sin gracia, "1A" sobre una serie de exactamente un año diría
 * "—" siempre. Con más de siete días la cosa cambia de naturaleza: ya no es
 * el calendario desalineado, es que faltan datos.
 *
 * Cuando se usa la gracia, el número sale y la `nota` dice la distancia REAL.
 * No es lo mismo que `motivo`: `motivo` es "no hay número"; `nota` es "hay
 * número y esto es lo que mide". Un % con la etiqueta equivocada sigue siendo
 * peor que un hueco, y por eso la distancia viaja.
 */
function qdAnclaMeses(pts, meses) {
  const ultimo = pts[pts.length - 1];
  if (!Number.isFinite(ultimo && ultimo.t)) {
    return { refIdx: null, motivo: 'la serie no trae fechas: un periodo de calendario se ancla por fecha' };
  }
  const objetivo = new Date(ultimo.t * 1000);
  objetivo.setUTCMonth(objetivo.getUTCMonth() - meses);
  const tObjetivo = objetivo.getTime() / 1000;

  // La ÚLTIMA sesión en o antes de la fecha objetivo.
  for (let i = pts.length - 1; i >= 0; i--) {
    if (Number.isFinite(pts[i].t) && pts[i].t <= tObjetivo) return { refIdx: i, motivo: null, nota: null };
  }

  // No hay ninguna: la serie empieza después. ¿Por cuánto?
  const primero = pts[0];
  if (!Number.isFinite(primero.t)) {
    return { refIdx: null, motivo: 'la serie no trae fechas: un periodo de calendario se ancla por fecha' };
  }
  const faltanDias = Math.round((primero.t - tObjetivo) / 86400);
  const fecha = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  if (faltanDias <= QD_GRACIA_DIAS) {
    const diasReales = Math.round((ultimo.t - primero.t) / 86400);
    return {
      refIdx: 0, motivo: null,
      nota: `la serie empieza el ${fecha(primero.t)}: el periodo mide ${diasReales} días`,
    };
  }
  return {
    refIdx: null,
    motivo: `la serie empieza el ${fecha(primero.t)} y el periodo necesita llegar al ${fecha(tObjetivo)}:`
      + ` faltan ${faltanDias} días`,
  };
}

// Única fuente de verdad del % por periodo. Ningún componente resta precios
// ni divide por su cuenta.
function qdPeriodChange(series, periodKey, ahora) {
  const per = QD_PERIODS[periodKey];
  if (!per) throw new Error('qdPeriodChange: periodo desconocido ' + periodKey);
  const pts = (series || []).filter((p) => p && Number.isFinite(p.c) && p.c > 0);
  const n = pts.length;
  const out = { value: null, pct: null, periodLabel: per.label, window: pts, refIdx: 0, refValue: null, motivo: null, nota: null };
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
  } else if (per.meses) {
    // Periodo de CALENDARIO: el ancla es una fecha, no un conteo de sesiones.
    const a = qdAnclaMeses(pts, per.meses);
    if (a.refIdx == null) { out.motivo = a.motivo; out.window = pts; return out; }
    refIdx = a.refIdx;
    out.nota = a.nota || null;
  } else {
    // ── LA SERIE TIENE QUE CUBRIR EL PERIODO ─────────────────────────
    // Esto era `Math.max(0, n - 1 - tradingDays)`, y ese `max(0, …)` es un
    // NÚMERO MAL esperando a que alguien pida un periodo largo: con 180
    // sesiones y un pedido de 5A, el ancla caía en el primer punto y el
    // resultado salía etiquetado "5A" siendo el cambio de ocho meses.
    //
    // 1D, 1S y 1M se siguen midiendo en SESIONES y no en calendario, a
    // propósito: son los tres del mapa, llevan meses en pantalla y cambiarles
    // el ancla cambiaría números que ya se están leyendo. Los largos nacieron
    // con R4 y no tienen esa deuda.
    const ref = n - 1 - per.tradingDays;
    if (ref < 0) {
      out.motivo = `la serie trae ${n} sesiones y ${per.label} necesita ${per.tradingDays + 1}`;
      return out;
    }
    refIdx = ref;
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
  // El gris del "—" era #666: 3.22 de contraste sobre el panel de la paleta
  // del §4 (#0e141b), debajo del piso AA de 4.5 que R3(c) fija. #7d8793 da
  // 5.08 ahí y 5.4 sobre el fondo viejo de app.html, así que sube en las dos.
  // Un dato que falta tiene que LEERSE: es la mitad de la regla 2.
  const col = !fin ? '#7d8793' : (opts.invert ? (up ? '#E24B4A' : '#00c97d') : (up ? '#00c97d' : '#E24B4A'));
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

// El puente a Node para las pruebas. Va AL FINAL del archivo, después de que
// todas las funciones existen: `qdCap` se definía más abajo que el bloque y
// por eso no se podía exportar (en el navegador daba igual, porque una
// declaración de función se iza; en `module.exports` no).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QD_PERIODS, qdPeriodChange, qdPctTag, qdAnclaYtd, fmtPrice, qdEscHTML, qdCap };
}
