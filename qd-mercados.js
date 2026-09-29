// ═══════════════════════════════════════════════════════════════════════
// qd-mercados.js — EL RELOJ DE CADA BOLSA, Y LO QUE NO SABE
//
// Regla 4 del encargo: "chip de estado de mercado POR INSTRUMENTO en cada
// pantalla: abierto / cerrado · cierre del viernes / 24/7". Hoy
// `qdMarketStatus()` (`app.html:4452`) sabe de UNA bolsa —acciones de EE.UU.—
// con un offset EDT **fijo** de −4, que se equivoca dos veces al año en los
// cambios de horario. R2 pide uno por bolsa, y Asia abre el día ANTERIOR en
// hora de México, así que la aritmética a mano no alcanza.
//
// ── POR QUÉ `Intl` Y NO UNA TABLA DE OFFSETS ──────────────────────────
// `Intl.DateTimeFormat` con `timeZone` pregunta a la base de datos de zonas
// del sistema: si Brasil vuelve a mover su horario de verano, o Europa lo
// cambia de fecha, esto sigue bien sin que nadie toque el archivo. Un offset
// escrito a mano es un dato que se podre solo, y ya costó el chip de una bolsa.
//
// ── LO QUE ESTE ARCHIVO NO SABE, Y POR ESO NO AFIRMA ──────────────────
// Feriados. En el repo hay calendario de EE.UU. (`alpaca.js /v2/calendar`) y
// de NINGUNA otra bolsa. Un chip que diga "abierto" el día de un feriado
// japonés es un verde producido por un dato que falta, y eso es peor que un
// gris: el gris se ve.
//
// Así que el horario NUNCA afirma "abierta" solo. Se contrasta con el último
// cierre que tenemos:
//
//   - el horario dice que la sesión corre Y el último cierre es de hoy → ABIERTA
//   - el horario dice que corre PERO el último cierre es de ayer o antes
//     → SIN CIERRE NUEVO (feriado, media sesión, o la cosecha no llegó)
//   - el horario dice que no corre → CERRADA, y la etiqueta nombra el día
//     del último cierre, como el chip de EE.UU. que ya existía
//
// Sin `ultimoCierre` no se inventa nada: el estado sale `horario_solo` y la
// etiqueta lo dice, que es un gris honesto y no un verde inventado.
// ═══════════════════════════════════════════════════════════════════════

// Las 8 bolsas con símbolo en `/api/macro-markets` (decisión de Lety,
// 2026-09-29). Los horarios son de SESIÓN REGULAR en hora local; el `almuerzo`
// es el receso de mediodía, que Tokio y Hong Kong sí tienen y omitirlo haría
// decir "abierta" una hora en que no opera nadie.
//
// `dias` son los días de semana ISO que opera (1 = lunes). No hay bolsa de las
// ocho que opere en fin de semana, pero el campo existe porque el día se lee
// de la zona de la bolsa y no de la nuestra: en México pueden ser las 18:00 del
// domingo y en Tokio las 08:00 del lunes.
export const BOLSAS = {
  nyse:      { nombre: 'NYSE/Nasdaq', zona: 'America/New_York',   abre: '09:30', cierra: '16:00', dias: [1, 2, 3, 4, 5] },
  bmv:       { nombre: 'BMV',         zona: 'America/Mexico_City', abre: '08:30', cierra: '15:00', dias: [1, 2, 3, 4, 5] },
  tokio:     { nombre: 'Tokio',       zona: 'Asia/Tokyo',         abre: '09:00', cierra: '15:30', dias: [1, 2, 3, 4, 5], almuerzo: ['11:30', '12:30'] },
  seul:      { nombre: 'Seúl',        zona: 'Asia/Seoul',         abre: '09:00', cierra: '15:30', dias: [1, 2, 3, 4, 5] },
  hongkong:  { nombre: 'Hong Kong',   zona: 'Asia/Hong_Kong',     abre: '09:30', cierra: '16:00', dias: [1, 2, 3, 4, 5], almuerzo: ['12:00', '13:00'] },
  francfort: { nombre: 'Fráncfort',   zona: 'Europe/Berlin',      abre: '09:00', cierra: '17:30', dias: [1, 2, 3, 4, 5] },
  londres:   { nombre: 'Londres',     zona: 'Europe/London',      abre: '08:00', cierra: '16:30', dias: [1, 2, 3, 4, 5] },
  saopaulo:  { nombre: 'São Paulo',   zona: 'America/Sao_Paulo',  abre: '10:00', cierra: '17:00', dias: [1, 2, 3, 4, 5] },
};

/** Lo que cotiza casi sin parar: futuros, divisas y cripto. */
export const ETIQUETA_24H = '24h';

const DIAS_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const ISO_POR_NOMBRE = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const minutos = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * La hora de pared en una zona, sin depender del huso de quien pregunta.
 *
 * Devuelve `{ fecha: 'AAAA-MM-DD', hhmm: 'HH:MM', minutos, diaIso }`. Se lee
 * con `formatToParts` y no con `toLocaleString` + parseo de texto, porque el
 * texto cambia con el locale del dispositivo y el parseo se rompe en silencio.
 */
export function horaEnZona(zona, ahora = new Date()) {
  const d = ahora instanceof Date ? ahora : new Date(ahora);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const x of partes) if (x.type !== 'literal') p[x.type] = x.value;
  // `hour12:false` puede dar "24" a medianoche en algunos motores.
  const hora = p.hour === '24' ? '00' : p.hour;
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${hora}:${p.minute}`,
    minutos: Number(hora) * 60 + Number(p.minute),
    diaIso: ISO_POR_NOMBRE[p.weekday] || null,
  };
}

/**
 * El estado de una bolsa, contrastado con el dato que tenemos.
 *
 * `ultimoCierre` es la fecha (AAAA-MM-DD) del último cierre que hay en la
 * serie de esa bolsa. Es lo que convierte un horario en una afirmación: sin
 * él, esto no dice "abierta".
 */
export function estadoDeBolsa(clave, ahora = new Date(), { ultimoCierre = null, bolsas = BOLSAS } = {}) {
  const b = bolsas[clave];
  if (!b) return { estado: 'desconocida', etiqueta: 'bolsa sin horario declarado', abierta: false };

  const loc = horaEnZona(b.zona, ahora);
  const opera = b.dias.includes(loc.diaIso);
  const dentro = opera && loc.minutos >= minutos(b.abre) && loc.minutos < minutos(b.cierra);
  const enAlmuerzo = dentro && b.almuerzo
    && loc.minutos >= minutos(b.almuerzo[0]) && loc.minutos < minutos(b.almuerzo[1]);
  const sesionCorriendo = dentro && !enAlmuerzo;
  const base = {
    clave, nombre: b.nombre, zona: b.zona, hora_local: loc.hhmm, fecha_local: loc.fecha,
    dia_local: DIAS_ES[(loc.diaIso || 1) - 1], sesion_corriendo: sesionCorriendo,
    ultimo_cierre: ultimoCierre || null,
  };

  if (!sesionCorriendo) {
    // CERRADA. La etiqueta nombra el día del último cierre —como el chip de
    // EE.UU. que ya existía— y si no lo tenemos, lo dice en vez de callarlo.
    let etiqueta = 'cerrado';
    if (ultimoCierre) {
      const dc = new Date(`${ultimoCierre}T12:00:00Z`);
      const iso = Number.isFinite(dc.getTime()) ? ((dc.getUTCDay() + 6) % 7) : null;
      // "cierre del martes" cuando hoy ES martes se lee como si fuera de otra
      // semana. El chip dice de qué día es, y si es de hoy lo dice así.
      if (ultimoCierre === loc.fecha) etiqueta = 'cerrado · cierre de hoy';
      else if (iso != null) etiqueta = `cerrado · cierre del ${DIAS_ES[iso]}`;
      else etiqueta = `cerrado · último cierre ${ultimoCierre}`;
    } else {
      etiqueta = 'cerrado · no se sabe de qué día es el último cierre';
    }
    return {
      ...base, estado: enAlmuerzo ? 'receso' : 'cerrada', abierta: false,
      etiqueta: enAlmuerzo ? `receso de mediodía · ${b.almuerzo[0]}–${b.almuerzo[1]} local` : etiqueta,
    };
  }

  // EL HORARIO DICE QUE CORRE. Recién acá hace falta el dato para afirmarlo.
  if (!ultimoCierre) {
    return {
      ...base, estado: 'horario_solo', abierta: false,
      etiqueta: 'en horario, sin cierre con el que confirmarlo',
    };
  }
  if (ultimoCierre >= loc.fecha) {
    return { ...base, estado: 'abierta', abierta: true, etiqueta: 'abierto' };
  }
  // Feriado, media sesión, o la cosecha no llegó. Las tres se arreglan
  // distinto, y ninguna es "abierto".
  return {
    ...base, estado: 'sin_cierre_nuevo', abierta: false,
    etiqueta: `sin cierre nuevo hoy · último del ${ultimoCierre}`,
  };
}

/** Los que no abren ni cierran. La regla 4 los llama aparte a propósito. */
export function estado24h(clave = '24h') {
  return {
    clave, nombre: null, estado: 'continuo', abierta: true, etiqueta: ETIQUETA_24H,
    sesion_corriendo: true,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOLSAS, ETIQUETA_24H, horaEnZona, estadoDeBolsa, estado24h };
}
