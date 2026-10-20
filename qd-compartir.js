// ═══════════════════════════════════════════════════════════════════════
// qd-compartir.js — R7: la imagen para compartir.
//
// SCRIPT CLÁSICO (sin `export`, con el guardia de `typeof module`): lo cargan
// `/mercado`, la ficha de índice y la de ticker con un <script src>. Un
// `export` acá es un SyntaxError que deja la página entera sin ejecutar.
//
// ── LO QUE SE PUEDE PROBAR Y LO QUE NO ───────────────────────────────
// Dibujar en un canvas no se puede probar en Node sin una librería. Lo que
// SÍ se puede probar es QUÉ se dibuja y DÓNDE, así que la tarjeta se arma en
// dos pasos:
//
//   1. `opsDeTarjeta(...)` → una lista de operaciones ({tipo, texto, x, y…}).
//      Pura, sin canvas, sin reloj. Es la que se prueba.
//   2. `pintaOps(ctx, ops)` → las ejecuta. Veinte líneas sin decisiones.
//
// Así "la tarjeta dice la fuente y la hora" es una prueba unitaria, y no una
// inspección visual de un PNG.
//
// ── LO QUE LA TARJETA PROMETE ────────────────────────────────────────
// Fecha, periodo, moneda, FUENTE y "quantdesk" en la esquina. Son los
// mismos cinco datos del pie de pantalla (regla 5): una imagen que circula
// por WhatsApp sin decir de cuándo es y de dónde salió es exactamente el
// tipo de captura que termina citada como si fuera de hoy.
// ═══════════════════════════════════════════════════════════════════════

var QD_FORMATOS = {
  // Los dos del encargo. `historia` es el vertical de stories.
  historia: { id: 'historia', w: 1080, h: 1920, nombre: 'Vertical (stories)' },
  cuadrado: { id: 'cuadrado', w: 1080, h: 1080, nombre: 'Cuadrado' }
};

var QD_PALETA_TARJETA = {
  fondo: '#0b0f14', panel: '#0e141b', linea: '#161c24',
  texto: '#e6edf3', tenue: '#8b98a5', apagado: '#7d8793', verde: '#00c97d'
};

/**
 * EL ANCHO DE UN CARACTER EN LA MONO, medido.
 *
 * IBM Plex Mono —como toda monoespaciada— avanza 0.6 del tamaño por
 * caracter. Sirve para saber cuántos caracteres caben en un renglón SIN
 * medir con el canvas, que es lo que permite que esto se pruebe en Node.
 */
var QD_ANCHO_CARACTER_MONO = 0.6;

/** Cuántos caracteres de `tam` px caben en `ancho` px de monoespaciada. */
function qdCabenCaracteres(ancho, tam) {
  return Math.max(4, Math.floor(ancho / (tam * QD_ANCHO_CARACTER_MONO)));
}

/**
 * Un texto recortado A UN RENGLÓN, con el recorte VISIBLE.
 *
 * La tarjeta descargada enseñó la línea de la fuente saliéndose del lienzo:
 * `neon:mercado_universo_us (sector y cap) · neon:mercado_precios…` seguía
 * de largo hasta el borde y se cortaba sin más. Un texto cortado por el
 * borde del lienzo parece un texto completo.
 */
function qdRecortaALinea(texto, maxChars) {
  var t = String(texto == null ? '' : texto);
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(1, maxChars - 1)) + '…';
}

/** Corta un texto en líneas de a lo más `max` caracteres, por palabras. */
function qdCortaTexto(texto, max) {
  var palabras = String(texto == null ? '' : texto).split(/\s+/).filter(Boolean);
  var lineas = [], actual = '';
  for (var i = 0; i < palabras.length; i++) {
    var p = palabras[i];
    if (!actual) { actual = p; continue; }
    if ((actual + ' ' + p).length <= max) actual += ' ' + p;
    else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

/**
 * LAS OPERACIONES DE LA TARJETA.
 *
 * `datos` lleva lo que la pantalla sabe de sí misma:
 *   titulo, subtitulo, filas[{k, v, color}], periodo, moneda, fuente,
 *   fecha (ISO), url.
 *
 * TODO LO QUE FALTA SE DICE. Sin fuente, la tarjeta escribe "sin fuente
 * declarada" en vez de dejar el renglón vacío: una imagen sin procedencia
 * circulando es peor que una imagen fea.
 */
function opsDeTarjeta(datos, formato) {
  var f = QD_FORMATOS[formato] || QD_FORMATOS.historia;
  var d = datos || {};
  var ops = [];
  var margen = 72;
  var ancho = f.w - margen * 2;

  ops.push({ tipo: 'fondo', color: QD_PALETA_TARJETA.fondo, x: 0, y: 0, w: f.w, h: f.h });

  // ── Cabecera: la marca, siempre ───────────────────────────────────
  var y = margen + 56;
  ops.push({ tipo: 'texto', texto: '/mercado', x: margen, y: y, tam: 44, peso: 600,
             color: QD_PALETA_TARJETA.verde, fuente: 'mono', rol: 'marca' });
  y += 72;

  // ── Título y subtítulo ────────────────────────────────────────────
  // UN RECORTE QUE NO SE VE ES UN TEXTO CAMBIADO. Si el título no cabe en
  // tres renglones, la última línea termina en "…": el lector sabe que falta
  // algo. Cortarlo en silencio convierte "…por sector" en otra afirmación.
  var titulo = qdCortaTexto(d.titulo || 'QuantDesk', f.id === 'cuadrado' ? 22 : 20);
  var MAX_LINEAS_TITULO = 3;
  var recortado = titulo.length > MAX_LINEAS_TITULO;
  var lineasTitulo = titulo.slice(0, MAX_LINEAS_TITULO);
  if (recortado) lineasTitulo[MAX_LINEAS_TITULO - 1] = lineasTitulo[MAX_LINEAS_TITULO - 1] + '…';
  for (var i = 0; i < lineasTitulo.length; i++) {
    ops.push({ tipo: 'texto', texto: lineasTitulo[i], x: margen, y: y, tam: 64, peso: 700,
               color: QD_PALETA_TARJETA.texto, fuente: 'sans', rol: 'titulo' });
    y += 74;
  }
  if (d.subtitulo) {
    var sub = qdCortaTexto(d.subtitulo, f.id === 'cuadrado' ? 44 : 40);
    var lineasSub = sub.slice(0, 2);
    if (sub.length > 2) lineasSub[1] = lineasSub[1] + '…';
    for (var j = 0; j < lineasSub.length; j++) {
      ops.push({ tipo: 'texto', texto: lineasSub[j], x: margen, y: y, tam: 30, peso: 400,
                 color: QD_PALETA_TARJETA.tenue, fuente: 'mono', rol: 'subtitulo' });
      y += 40;
    }
  }
  y += 28;

  // ── Las filas: lo que la pantalla está enseñando ──────────────────
  // El tope sale del ALTO disponible, no de un número a ojo: el cuadrado
  // tiene la mitad de pantalla y no puede llevar las mismas filas.
  var altoFila = 68;
  var reservadoPie = 215;
  var cabenFilas = Math.max(0, Math.floor((f.h - y - reservadoPie) / altoFila));
  var filas = (d.filas || []).slice(0, cabenFilas);
  for (var k = 0; k < filas.length; k++) {
    var fila = filas[k];
    ops.push({ tipo: 'rect', color: QD_PALETA_TARJETA.panel, x: margen, y: y, w: ancho, h: altoFila - 10, r: 10 });
    ops.push({ tipo: 'texto', texto: String(fila.k == null ? '' : fila.k), x: margen + 22, y: y + 40,
               tam: 30, peso: 400, color: QD_PALETA_TARJETA.tenue, fuente: 'sans', rol: 'fila-k' });
    ops.push({ tipo: 'texto', texto: String(fila.v == null ? '—' : fila.v), x: margen + ancho - 22, y: y + 40,
               tam: 34, peso: 600, color: fila.color || QD_PALETA_TARJETA.texto,
               fuente: 'mono', alinear: 'derecha', rol: 'fila-v' });
    y += altoFila;
  }
  if ((d.filas || []).length > filas.length) {
    ops.push({ tipo: 'texto', texto: '+' + ((d.filas || []).length - filas.length) + ' más en la pantalla',
               x: margen, y: y + 30, tam: 26, peso: 400, color: QD_PALETA_TARJETA.apagado,
               fuente: 'mono', rol: 'resto' });
  }

  // ── EL PIE: los cinco datos que la imagen no puede omitir ─────────
  var pie = f.h - margen - 96;
  ops.push({ tipo: 'linea', color: QD_PALETA_TARJETA.linea, x: margen, y: pie - 28, w: ancho, h: 2 });
  var meta = [];
  if (d.fecha) meta.push(qdFechaLegible(d.fecha));
  else meta.push('sin fecha declarada');
  if (d.periodo) meta.push('periodo ' + d.periodo);
  if (d.moneda) meta.push('en ' + d.moneda);
  ops.push({ tipo: 'texto', texto: qdRecortaALinea(meta.join(' · '), qdCabenCaracteres(ancho, 26)),
             x: margen, y: pie + 8, tam: 26, peso: 400,
             color: QD_PALETA_TARJETA.tenue, fuente: 'mono', rol: 'meta' });
  ops.push({ tipo: 'texto',
             texto: qdRecortaALinea('Fuente: ' + qdTextoDeFuente(d.fuente), qdCabenCaracteres(ancho, 24)),
             x: margen, y: pie + 44, tam: 24, peso: 400,
             color: QD_PALETA_TARJETA.apagado, fuente: 'mono', rol: 'fuente' });
  // LA URL Y LA FIRMA EN RENGLONES DISTINTOS. En la primera versión iban en
  // la misma `y`, una a la izquierda y otra a la derecha, y con una URL
  // larga se ENCIMABAN: la tarjeta descargada decía
  // "…periodo=1MInformación, no asesoría". Se vio en el PNG de verdad.
  if (d.url) {
    ops.push({ tipo: 'texto', texto: qdRecortaALinea(d.url, qdCabenCaracteres(ancho, 22)),
               x: margen, y: pie + 78, tam: 22, peso: 400,
               color: QD_PALETA_TARJETA.apagado, fuente: 'mono', rol: 'url' });
  }
  ops.push({ tipo: 'texto', texto: 'Información, no asesoría · quantdesk',
             x: f.w - margen, y: pie + 112, tam: 24, peso: 400,
             color: QD_PALETA_TARJETA.apagado, fuente: 'mono', alinear: 'derecha', rol: 'firma' });
  return { formato: f, ops: ops, filas_dibujadas: filas.length, filas_totales: (d.filas || []).length };
}

/**
 * LA FUENTE, COMO TEXTO. Nunca "[object Object]".
 *
 * Varios endpoints mandan la fuente como OBJETO —el mapa trae una por
 * bloque: `{cuadros, series, cap_por_fuente}`—, y concatenarlo a una cadena
 * escribía "[object Object]" en la tarjeta. Lo vi en el PNG descargado.
 * Una imagen que circula diciendo eso en lugar de su procedencia es justo
 * lo que la regla 3 existe para impedir.
 */
function qdTextoDeFuente(f) {
  if (f == null || f === '') return 'sin fuente declarada';
  if (typeof f === 'string') return f;
  if (typeof f !== 'object') return String(f);
  // De un objeto se toman los valores que son texto, en orden, sin claves
  // internas: lo que importa es de DÓNDE salió, no cómo se llama el campo.
  var partes = [];
  for (var k in f) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
    if (typeof f[k] === 'string' && f[k]) partes.push(f[k]);
  }
  return partes.length ? partes.join(' · ') : 'sin fuente declarada';
}

/** La fecha, legible y sin inventar: lo que no parsea se dice. */
function qdFechaLegible(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return String(iso);
  var d = new Date(t);
  try {
    return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Ejecuta las operaciones sobre un contexto 2D. Sin decisiones. */
function pintaOps(ctx, plan) {
  var mono = '"IBM Plex Mono", ui-monospace, monospace';
  var sans = '"IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif';
  for (var i = 0; i < plan.ops.length; i++) {
    var o = plan.ops[i];
    if (o.tipo === 'fondo' || o.tipo === 'rect' || o.tipo === 'linea') {
      ctx.fillStyle = o.color;
      ctx.fillRect(o.x, o.y, o.w, o.h);
    } else if (o.tipo === 'texto') {
      ctx.fillStyle = o.color;
      ctx.font = (o.peso || 400) + ' ' + o.tam + 'px ' + (o.fuente === 'mono' ? mono : sans);
      ctx.textAlign = o.alinear === 'derecha' ? 'right' : 'left';
      ctx.fillText(o.texto, o.x, o.y);
    }
  }
  ctx.textAlign = 'left';
  return plan;
}

/** Canvas listo con la tarjeta dibujada. Devuelve el elemento. */
function qdDibujaTarjeta(datos, formato, doc) {
  var plan = opsDeTarjeta(datos, formato);
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return { plan: plan, canvas: null };
  var c = d.createElement('canvas');
  c.width = plan.formato.w; c.height = plan.formato.h;
  pintaOps(c.getContext('2d'), plan);
  return { plan: plan, canvas: c };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QD_FORMATOS, QD_PALETA_TARJETA, qdCortaTexto, opsDeTarjeta,
                     qdFechaLegible, qdTextoDeFuente, qdRecortaALinea, qdCabenCaracteres,
                     QD_ANCHO_CARACTER_MONO, pintaOps, qdDibujaTarjeta };
}
