// ═══════════════════════════════════════════════════════════════════
// api/_lib/bmv-frescura.js — ¿está al día la tabla de precios de la BMV?
//
// PURA: no abre Neon, no pide red. Recibe la última fecha guardada y un
// reloj, y devuelve cuántas SESIONES faltan. Se prueba con fixtures.
//
// POR QUÉ EXISTE. El 2026-09-21 `?job=unidades` reportó las 27 emisoras en
// `datos_rancios`: `bmv_precios` no se cosechaba desde el martes 15. La
// regla de fail-closed hizo lo suyo —G2 cayó a 2/15 en vez de inventar una
// cap con precios viejos—, pero nadie se enteró de que la cosecha estaba
// parada hasta que una compuerta se puso roja seis días después.
//
// `/api/cron-status` no lo podía ver: vigila LATIDOS (¿corrió el cron?), y
// aquí no había cron que latiera. Este módulo vigila el DATO, que además
// atrapa el otro modo de falla —el cron corre, contesta 200 y no escribe
// nada— que un latido declara sano.
// ═══════════════════════════════════════════════════════════════════

/**
 * Días en que la BMV no opera, además de sábados y domingos.
 *
 * NO está verificada contra el calendario oficial de la BMV: sale de los
 * días de descanso obligatorio y de los que la bolsa observa desde siempre.
 * Por eso el veredicto REPORTA los asuetos que aplicó dentro de la ventana:
 * si uno está de más o de menos, se ve en la salida en vez de corregir la
 * cuenta en silencio.
 *
 * El error se eligió hacia el lado ruidoso: falta un asueto → el aviso
 * cuenta una sesión que no existió y avisa de más; sobra un asueto → se
 * come un día de atraso. La tolerancia de 1 día hábil absorbe el primero.
 */
export const ASUETOS_BMV = {
  '2026-01-01': 'Año Nuevo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-02-02': 'Día de la Constitución', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-03-16': 'Natalicio de Benito Juárez', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-04-02': 'Jueves Santo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-04-03': 'Viernes Santo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-05-01': 'Día del Trabajo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-09-16': 'Independencia', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-11-02': 'Día de Muertos', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-11-16': 'Revolución Mexicana', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2026-12-25': 'Navidad', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-01-01': 'Año Nuevo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-02-01': 'Día de la Constitución', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-03-15': 'Natalicio de Benito Juárez', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-03-25': 'Jueves Santo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-03-26': 'Viernes Santo', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-09-16': 'Independencia', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-11-02': 'Día de Muertos', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-11-15': 'Revolución Mexicana', /* date-lint-ok: calendario declarado, no una fecha calculada */
  '2027-12-25': 'Navidad', /* date-lint-ok: calendario declarado, no una fecha calculada */
};

/** Los años que el calendario de arriba cubre. Fuera de ellos sólo hay findes. */
export const ANIOS_CON_ASUETOS = [...new Set(Object.keys(ASUETOS_BMV).map((d) => d.slice(0, 4)))];

// La BMV cierra a las 15:00 de la CDMX. México no cambia de horario desde
// 2022, así que CDMX = UTC-6 todo el año y no hace falta una tabla de DST.
export const CDMX_OFFSET_H = -6;
export const CIERRE_CDMX_H = 15;
// Margen entre el cierre y la hora en que la cosecha ya debería tener el
// dato. El cron corre a las 22:00 UTC (16:00 CDMX); una hora alcanza.
export const MARGEN_CIERRE_H = 1;

// Cuántas sesiones se toleran sin cosechar antes de gritar. 1 = "la de hoy
// todavía puede estar en camino"; 2 ya es un día hábil entero perdido.
export const MAX_DIAS_HABILES = 1;

const DIA_MS = 86400000;

/** 'AAAA-MM-DD' → Date a mediodía UTC (el mediodía evita que un offset mueva el día). */
function aMedioDia(iso) {
  return new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
}
const iso = (d) => d.toISOString().slice(0, 10);

/** ¿Cae en sábado o domingo? */
export function esFinDeSemana(fechaIso) {
  const dow = aMedioDia(fechaIso).getUTCDay();
  return dow === 0 || dow === 6;
}

/** ¿Es día de operación de la BMV? (ni finde ni asueto conocido) */
export function esSesion(fechaIso, asuetos = ASUETOS_BMV) {
  if (esFinDeSemana(fechaIso)) return false;
  return !(asuetos && Object.prototype.hasOwnProperty.call(asuetos, String(fechaIso).slice(0, 10)));
}

/**
 * La última sesión cuyo cierre YA PASÓ, en hora de la CDMX.
 *
 * Sin esto, cualquier consulta de la mañana vería "falta la sesión de hoy" y
 * avisaría todos los días a las 9 am. El cierre de hoy no se le puede exigir
 * a nadie antes de que haya cierre.
 */
export function sesionEsperada({ ahora, asuetos = ASUETOS_BMV } = {}) {
  const t = ahora instanceof Date ? ahora : new Date(ahora);
  // Reloj de la CDMX, corrido para que "ya cerró" caiga en el día correcto.
  const cdmx = new Date(t.getTime() + CDMX_OFFSET_H * 3600000);
  let dia = new Date(Date.UTC(cdmx.getUTCFullYear(), cdmx.getUTCMonth(), cdmx.getUTCDate(), 12));
  const cerroHoy = cdmx.getUTCHours() >= CIERRE_CDMX_H + MARGEN_CIERRE_H;
  if (!cerroHoy) dia = new Date(dia.getTime() - DIA_MS);
  // Y de ahí hacia atrás hasta encontrar un día que sí opere.
  for (let i = 0; i < 14; i++) {
    if (esSesion(iso(dia), asuetos)) return iso(dia);
    dia = new Date(dia.getTime() - DIA_MS);
  }
  return iso(dia);
}

/**
 * Las sesiones que deberían estar guardadas y no están: los días hábiles
 * DESPUÉS de `desde` y hasta `hasta` inclusive.
 *
 * `tope` corta la lista para que una tabla vacía de hace dos años no
 * devuelva 500 fechas; el conteo sigue siendo el real.
 */
export function sesionesFaltantes(desde, hasta, { asuetos = ASUETOS_BMV, tope = 30 } = {}) {
  if (!desde || !hasta) return { n: null, fechas: [], truncada: false };
  const fin = aMedioDia(hasta).getTime();
  let cur = aMedioDia(desde).getTime() + DIA_MS;
  const fechas = [];
  let n = 0;
  // Guarda de seguridad: 5 años de días es más que cualquier ventana sensata.
  for (let i = 0; cur <= fin && i < 1900; i++, cur += DIA_MS) {
    const f = iso(new Date(cur));
    if (!esSesion(f, asuetos)) continue;
    n++;
    if (fechas.length < tope) fechas.push(f);
  }
  return { n, fechas, truncada: n > fechas.length };
}

/**
 * El veredicto. `ultima_fecha` es `max(fecha)` de `bmv_precios`.
 *
 * `alerta: true` significa "la cosecha de precios está parada", y eso es lo
 * que `/api/cron-status` convierte en `ok: false`.
 */
export function frescuraPrecios({
  ultima_fecha,
  ahora,
  max_dias_habiles = MAX_DIAS_HABILES,
  asuetos = ASUETOS_BMV,
  tabla = 'bmv_precios',
} = {}) {
  const esperada = sesionEsperada({ ahora, asuetos });
  const ultima = ultima_fecha ? String(ultima_fecha).slice(0, 10) : null;

  if (!ultima) {
    return {
      tabla, ultima_fecha: null, sesion_esperada: esperada,
      dias_habiles_atraso: null, sesiones_faltantes: [], sesiones_faltantes_n: null,
      max_dias_habiles, alerta: true,
      motivo: `${tabla} está vacía: nunca se cosechó un precio`,
      asuetos_aplicados: {}, anios_sin_calendario: [],
    };
  }

  const { n, fechas, truncada } = sesionesFaltantes(ultima, esperada, { asuetos });
  // Los asuetos que la cuenta saltó dentro de la ventana, para que un
  // calendario equivocado se vea en la salida y no sólo en el número.
  const aplicados = {};
  for (const [d, nombre] of Object.entries(asuetos || {})) {
    if (d > ultima && d <= esperada && !esFinDeSemana(d)) aplicados[d] = nombre;
  }
  // Años dentro de la ventana que el calendario no cubre: ahí la cuenta sólo
  // sabe de fines de semana, y hay que decirlo.
  const anios = new Set();
  for (const a of [ultima.slice(0, 4), esperada.slice(0, 4)]) {
    if (!ANIOS_CON_ASUETOS.includes(a)) anios.add(a);
  }

  const atraso = n == null ? null : n;
  const alerta = atraso != null && atraso > max_dias_habiles;
  return {
    tabla,
    ultima_fecha: ultima,
    sesion_esperada: esperada,
    dias_habiles_atraso: atraso,
    sesiones_faltantes: fechas,
    sesiones_faltantes_n: atraso,
    sesiones_faltantes_truncada: truncada,
    max_dias_habiles,
    alerta,
    motivo: alerta
      ? `${tabla} tiene ${atraso} sesiones sin cosechar (${ultima} → ${esperada}); el tope es ${max_dias_habiles}`
      : null,
    asuetos_aplicados: aplicados,
    anios_sin_calendario: [...anios],
  };
}
