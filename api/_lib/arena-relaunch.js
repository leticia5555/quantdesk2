// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-relaunch.js — EL RELANZAMIENTO de la Temporada 2.
//
// La jornada del lunes 14 fue un ENSAYO GENERAL, no la temporada. Lo que
// descubrió, en un solo día, justifica tirar esa población y empezar de cero:
//   - `openai` y `grok` abortaron (ver docs/arena.md y /api/arena-audit?view=abortos),
//   - un libro narró un fill que nunca ocurrió ("ZM filled at $95.5"),
//   - el buffet solo tenía 5 candidatos y 4 de 5 libros compraron lo mismo.
// Una temporada que arranca con dos de siete agentes mudos y un buffet de 5
// nombres no mide el MODELO: mide el arnés. Así que la T2 REAL arranca el
// lunes 21 con modelos nuevos, buffet nuevo y los siete libros reseteados.
//
// ── POR QUÉ ESTE ARCHIVO EXISTE ──────────────────────────────────────
// UNA SOLA FUNCIÓN define la fecha, el id y el texto del corte. Es la misma
// cicatriz que dejó `cadenceVersion()` en arena-run.js: cuando el id del
// anuncio se derivaba de una CONSTANTE y la compuerta de una ENV VAR, mover
// la fecha con la env var movía la compuerta pero NO el anuncio — y el corte
// del post-mortem quedaba sellado, para siempre, en un día en que no cambió
// nada. Todo lo que hable del relanzamiento (la compuerta de sombra, el id
// `rules_changed`, la fecha del `season_started`, el texto) sale de aquí.
//
// ENV VARS: ARENA_RELAUNCH_DATE (opc — mueve el corte sin deploy, igual que
//           ARENA_WATCH_START; una fecha inválida cae al default declarado).
// ═══════════════════════════════════════════════════════════════

// El DEFAULT declarado: lunes 21 de septiembre, 13:30 UTC (9:30 ET, la
// apertura). Es una fecha FIJA y pasada-o-futura según se mire — no una
// referencia a "hoy" —, por eso el waiver del lint de fechas.
export const RELAUNCH_DATE = /* date-lint-ok: fecha declarada del relanzamiento de la T2, un hecho fijo que ancla el corte del post-mortem */ '2026-09-21';

// La hora del corte en UTC (13:30 = 9:30 ET con horario de verano). Solo
// informativa: las compuertas comparan por DÍA en horario del Este, igual que
// el resto del Arena, para no equivocarse por el offset ni por DST.
export const RELAUNCH_TIME_UTC = '13:30';

// LA función. Todo lo demás se deriva de ella.
export function relaunchDate() {
  const raw = String(process.env.ARENA_RELAUNCH_DATE || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : RELAUNCH_DATE;
}

// El id del corte en el journal. Idempotente por construcción y FECHADO por
// la función de arriba: si la env var mueve el día, el id se mueve con ella.
export function relaunchId() {
  return 'arena-t2-relanzamiento-' + relaunchDate();
}

// Fecha de HOY en horario del ESTE ('YYYY-MM-DD'). Duplicada a propósito (tres
// líneas) en vez de importada: este módulo lo consumen el registry, el runner y
// el vigilante, y un import cruzado crearía un ciclo.
export function easternDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ¿Ya arrancó la temporada relanzada? Compara en ET, no en UTC.
export function relaunchActive(now = new Date()) {
  return easternDate(now) >= relaunchDate();
}
