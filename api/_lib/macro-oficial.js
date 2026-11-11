// ═══════════════════════════════════════════════════════════════════════
// _lib/macro-oficial.js — LAS FECHAS QUE YA ESTÁN PUBLICADAS, EN EL REPO
//
// POR QUÉ EXISTE (2026-11-11). El calendario macro salía vacío en `/mercado`
// ("calendario macro sin cargar") y en la terminal. No había nada roto: la
// tabla `macro_events` es CURADA A MANO desde `/admin-macro.html`, y estaba en
// cero filas. Un calendario que depende de que alguien se acuerde de cargarlo
// se queda vacío justo cuando nadie lo mira.
//
// Hay tres fechas que no hace falta curar porque sus dueños las publican con
// un año de anticipación: las reuniones de la Fed y los dos informes del BLS
// (inflación y empleo). Van acá, versionadas, cada una con la página oficial
// de la que salió. NO es scraping —la decisión de producto sigue en pie—: es
// una lista corta que se actualiza con un PR.
//
// LA TABLA CURADA SIGUE MANDANDO. Lo que Lety cargue a mano se suma, y si
// carga un evento de la misma categoría el mismo día, gana el suyo (ver
// `unirMacro`): así puede corregir un título o una nota sin tocar el repo.
//
// ESTA LISTA SE ACABA, Y LO DICE. Llega hasta `OFICIAL_HASTA`. Pasada esa
// fecha el panel no puede decir "sin eventos": dice que la lista terminó y
// hay que extenderla (`fraseDeFuente`, en qd-tablas.js). Un calendario que se
// queda mudo al agotarse es el mismo defecto con otra causa.
//
// LAS HORAS VAN EN CT, como el resto de la pantalla: el BLS publica a las
// 8:30 ET (7:30 CT) y el comunicado de la Fed sale a las 14:00 ET (13:00 CT).
// La fecha de la Fed es el SEGUNDO día de la reunión, que es el de la decisión.
//
// Las fechas literales llevan `date-lint-ok`: el lint de relojes rotos
// (tests/no-hardcoded-dates.test.mjs) existe para que una fecha tatuada no se
// siga enseñando como "próxima" cuando ya pasó, y acá eso no puede ocurrir —
// todo lo que se sirve se filtra contra la fecha de hoy.
// ═══════════════════════════════════════════════════════════════════════

const FED = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const CPI = 'https://www.bls.gov/schedule/news_release/cpi.htm';
const EMPLEO = 'https://www.bls.gov/schedule/news_release/empsit.htm';

// Cuándo se leyeron las tres páginas. El BLS avisa que su calendario puede
// cambiar (en 2025 un cierre del gobierno movió varias fechas), así que esto
// dice de cuándo es la foto.
export const OFICIAL_VERIFICADO_EN = '2026-11-11'; /* date-lint-ok: fecha de la lectura, no un evento */

const fed = (event_date, reunion, sep) => ({
  event_date, title: 'Decisión de la Fed (FOMC)', category: 'fed', importance: 'high',
  note: `reunión del ${reunion} · comunicado 13:00 CT${sep ? ' · con proyecciones' : ''}`,
  fuente: 'oficial:federalreserve.gov', fuente_url: FED,
});
const cpi = (event_date, mes) => ({
  event_date, title: `Inflación de EE.UU. (CPI) de ${mes}`, category: 'inflacion', importance: 'high',
  note: 'BLS · 7:30 CT', fuente: 'oficial:bls.gov', fuente_url: CPI,
});
const empleo = (event_date, mes) => ({
  event_date, title: `Empleo de EE.UU. (nóminas) de ${mes}`, category: 'empleo', importance: 'high',
  note: 'BLS · 7:30 CT', fuente: 'oficial:bls.gov', fuente_url: EMPLEO,
});

export const CALENDARIO_OFICIAL = [
  empleo('2026-12-04', 'noviembre'), /* date-lint-ok: calendario publicado por el BLS */
  fed('2026-12-09', '8 y 9 de diciembre', true), /* date-lint-ok: calendario publicado por la Fed */
  cpi('2026-12-10', 'noviembre'), /* date-lint-ok: calendario publicado por el BLS */
  empleo('2027-01-08', 'diciembre'), /* date-lint-ok: calendario publicado por el BLS */
  cpi('2027-01-13', 'diciembre'), /* date-lint-ok: calendario publicado por el BLS */
  fed('2027-01-27', '26 y 27 de enero', false), /* date-lint-ok: calendario publicado por la Fed */
  empleo('2027-02-05', 'enero'), /* date-lint-ok: calendario publicado por el BLS */
  cpi('2027-02-11', 'enero'), /* date-lint-ok: calendario publicado por el BLS */
  empleo('2027-03-05', 'febrero'), /* date-lint-ok: calendario publicado por el BLS */
  cpi('2027-03-10', 'febrero'), /* date-lint-ok: calendario publicado por el BLS */
  fed('2027-03-17', '16 y 17 de marzo', true), /* date-lint-ok: calendario publicado por la Fed */
].sort((a, b) => (a.event_date < b.event_date ? -1 : 1));

/** La última fecha que la lista conoce. Después de ésta, la lista no sabe nada. */
export const OFICIAL_HASTA = CALENDARIO_OFICIAL[CALENDARIO_OFICIAL.length - 1].event_date;

/** Las oficiales entre dos fechas ISO, las dos inclusive. */
export function oficialesEntre(desde, hasta, lista = CALENDARIO_OFICIAL) {
  return lista.filter((e) => e.event_date >= desde && e.event_date <= hasta);
}

/**
 * Lo curado + lo oficial, en una sola lista ordenada.
 *
 * LO CURADO GANA: si la tabla ya trae un evento de la misma categoría el
 * mismo día, la oficial no entra. Se compara por (fecha, categoría) y no por
 * título, porque el título curado puede decir "FOMC" donde acá dice "Decisión
 * de la Fed" y serían el mismo evento dos veces.
 */
export function unirMacro(curadas = [], oficiales = []) {
  const clave = (e) => String(e.event_date).slice(0, 10) + '|' + String(e.category || '').trim().toLowerCase();
  const ya = new Set((curadas || []).filter((e) => e && e.category).map(clave));
  const out = [...(curadas || []), ...(oficiales || []).filter((e) => !ya.has(clave(e)))];
  return out.sort((a, b) => {
    const da = String(a.event_date).slice(0, 10), db = String(b.event_date).slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}
