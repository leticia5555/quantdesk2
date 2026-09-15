// ═══════════════════════════════════════════════════════════════
// tests/arena-buffet-cache.test.mjs — la caché POR DÍA de los canales lentos.
//
// EL PROBLEMA: el canal `insiders` le pega a SEC EDGAR (feed Atom + hasta 60
// XML de Form 4). Con la caché en memoria fría —o sea, en cada lambda nueva—
// son ~61 requests a un servidor que throttlea. 12s no alcanzaban; 30s fue un
// torniquete que seguía costando 30 segundos de wall-clock y seguía cayéndose.
//
// LA CURA es no volver a pedirlo: los Form 4 son un hecho del DÍA, el mismo
// contenido para la corrida de las 14:00 y la de las 20:00.
//
// Lo que se prueba son las tres promesas que hacen que esta caché sea honesta:
//   1. ACELERA: un hit del día no llama a nadie.
//   2. NO MIENTE: una entrada de OTRO día no es un hit — se vuelve a pedir.
//   3. NO TAPA UNA CAÍDA: si la fuente falla y no hay entrada de hoy, el canal
//      sale caído, con su error. Y un resultado vacío NO se cachea, para que un
//      hipo de 30 segundos no mate el canal hasta la medianoche.
//
// La DB se stubbea en memoria: lo que se prueba es la POLÍTICA, no Postgres.
// Correr con `node tests/arena-buffet-cache.test.mjs`.
// ═══════════════════════════════════════════════════════════════

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── stub de Neon: una tabla en memoria con la misma clave (canal, día) ──
const tabla = new Map();
let dbCaida = false;
const key = (c, d) => c + '|' + d;

globalThis.__sqlStub = async (q, params = []) => {
  if (dbCaida) throw new Error('Neon no contesta');
  if (/^create table/i.test(q)) return [];
  if (/^select payload/i.test(q)) {
    const row = tabla.get(key(params[0], params[1]));
    return row ? [row] : [];
  }
  if (/^insert into arena_buffet_cache/i.test(q)) {
    tabla.set(key(params[0], params[1]), { payload: JSON.parse(params[2]), fetched_at: '2026-09-15T18:00:00.000Z' });
    return [];
  }
  return [];
};

// El módulo importa `sql` de _lib/db.js. Se intercepta con un loader de módulos
// mínimo: se reescribe el import a un shim que reenvía al stub de arriba.
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { readFileSync } = await import('node:fs');

const dir = mkdtempSync(join(tmpdir(), 'buffetcache-'));
writeFileSync(join(dir, 'db.js'), 'export const sql = (...a) => globalThis.__sqlStub(...a);\n');
const src = readFileSync(new URL('../api/_lib/arena-buffet-cache.js', import.meta.url), 'utf8')
  .replace("from './db.js'", `from ${JSON.stringify(join(dir, 'db.js'))}`);
writeFileSync(join(dir, 'mod.mjs'), src);
const { cachedDayFetch, readDayCache, writeDayCache, marketDay } = await import(join(dir, 'mod.mjs'));

const HOY = new Date('2026-09-15T18:30:00Z');   // 14:30 ET, mercado abierto
const MANANA = new Date('2026-09-16T18:30:00Z');

console.log('\n── la clave es el día DE MERCADO, no el día UTC ──');
{
  ok(marketDay(new Date('2026-09-15T18:30:00Z')) === '2026-09-15', 'media tarde: mismo día en ET y en UTC');
  // 22:40 UTC es la hora de la nocturna: UTC ya cambió de día, el mercado no.
  ok(marketDay(new Date('2026-09-16T02:40:00Z')) === '2026-09-15',
    'LA NOCTURNA: 02:40 UTC del 16 sigue siendo la sesión del 15 en ET — con clave UTC, la corrida post-cierre habría pedido el canal de nuevo',
    marketDay(new Date('2026-09-16T02:40:00Z')));
}

console.log('\n── 1) acelera: un hit del día no llama a nadie ──');
{
  tabla.clear();
  let llamadas = 0;
  const fetcher = async () => { llamadas++; return { items: [{ ticker: 'NVDA' }] }; };

  const a = await cachedDayFetch('insiders', fetcher, { now: HOY });
  ok(a.source === 'fetch' && llamadas === 1, 'la primera vez se pide de verdad', a.source);
  ok(a.data.items[0].ticker === 'NVDA', 'y devuelve el dato');

  const b = await cachedDayFetch('insiders', fetcher, { now: HOY });
  ok(b.source === 'cache' && llamadas === 1, 'la segunda NO vuelve a llamar a EDGAR', `${b.source}, llamadas=${llamadas}`);
  ok(b.data.items[0].ticker === 'NVDA', 'y sirve el mismo dato');

  // Las 12 corridas del día × 7 agentes: una sola llamada a la fuente.
  for (let i = 0; i < 12 * 7; i++) await cachedDayFetch('insiders', fetcher, { now: HOY });
  ok(llamadas === 1, '84 corridas del día → UNA llamada a la fuente (antes: 84 × ~61 requests a EDGAR)', String(llamadas));

  const f = await cachedDayFetch('insiders', fetcher, { now: HOY, force: true });
  ok(f.source === 'fetch' && llamadas === 2, '?force=1 la salta (para un refresh a mano)', f.source);
}

console.log('\n── 2) no miente: una entrada de OTRO día no es un hit ──');
{
  tabla.clear();
  let llamadas = 0;
  const fetcher = async () => { llamadas++; return { items: [{ ticker: 'DIA' + llamadas }] }; };

  await cachedDayFetch('insiders', fetcher, { now: HOY });
  const m = await cachedDayFetch('insiders', fetcher, { now: MANANA });
  ok(m.source === 'fetch' && llamadas === 2, 'al día siguiente se vuelve a pedir: nada de servir el buffet de ayer', `${m.source}, llamadas=${llamadas}`);
  ok(m.data.items[0].ticker === 'DIA2', 'y el dato es el nuevo', JSON.stringify(m.data));
  ok((await readDayCache('insiders', HOY)).payload.items[0].ticker === 'DIA1', 'la entrada de ayer sigue ahí, pero no se sirve hoy');
}

console.log('\n── 3) no tapa una caída ──');
{
  tabla.clear();
  const roto = async () => { throw new Error('timeout (30s)'); };
  const r = await cachedDayFetch('insiders', roto, { now: HOY });
  ok(r.source === 'none' && r.data === null, 'fuente caída y sin entrada de hoy → canal caído, no un dato inventado', r.source);
  ok(/timeout \(30s\)/.test(r.error), 'y el error REAL viaja', r.error);

  // Un vacío no se cachea: si no, un hipo de 30 segundos mataría el canal hasta
  // la medianoche.
  tabla.clear();
  let llamadas = 0;
  const vacio = async () => { llamadas++; return llamadas === 1 ? null : { items: [{ ticker: 'LATE' }] }; };
  const v1 = await cachedDayFetch('insiders', vacio, { now: HOY });
  ok(v1.data === null, 'un fetch que devuelve null devuelve null');
  const v2 = await cachedDayFetch('insiders', vacio, { now: HOY });
  ok(v2.source === 'fetch' && v2.data.items[0].ticker === 'LATE',
    'y NO se cacheó: el intento siguiente vuelve a pedir y se recupera solo', JSON.stringify(v2.source));

  // Con una entrada buena de hoy, una caída posterior NO la borra.
  tabla.clear();
  await cachedDayFetch('insiders', async () => ({ items: [{ ticker: 'OK' }] }), { now: HOY });
  const tras = await cachedDayFetch('insiders', roto, { now: HOY });
  ok(tras.source === 'cache' && tras.data.items[0].ticker === 'OK',
    'con entrada buena de hoy, una caída posterior de EDGAR ya no cuesta un canal', tras.source);
}

console.log('\n── la DB caída no puede tumbar una corrida ──');
{
  tabla.clear();
  dbCaida = true;
  let llamadas = 0;
  const fetcher = async () => { llamadas++; return { items: [] }; };
  const r = await cachedDayFetch('insiders', fetcher, { now: HOY });
  ok(r.source === 'fetch' && llamadas === 1, 'sin Neon, se degrada a pedirlo como antes — la caché acelera, no sustituye', r.source);
  ok((await readDayCache('insiders', HOY)) === null, 'la lectura devuelve null en vez de lanzar');
  ok((await writeDayCache('insiders', { x: 1 }, HOY)) === false, 'la escritura devuelve false en vez de lanzar');
  dbCaida = false;
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
