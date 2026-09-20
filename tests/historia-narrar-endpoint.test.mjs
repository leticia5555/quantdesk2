// ═══════════════════════════════════════════════════════════════
// Tests de api/historia-narrar.js y del bloque de narración de /api/historia.
//
//   1. **La llamada NO se dispara al abrir la página.** Si /api/historia
//      narrara bajo demanda, cada visita sería una llamada a Opus pagada —y
//      una factura invisible, porque la página se vería igual de bien.
//   2. **La puerta que gasta es fail-closed.** Sin llave configurada: 503, no
//      abierto. Con llave mal: 401. Y en ninguno de los dos casos se llama.
//   3. **Lo que ya está no se vuelve a pagar.** Mismo hash, cero llamadas.
//   4. **Se guarda SIEMPRE**, cualquiera sea el estado. Una narración
//      rechazada es la evidencia de por qué se rechazó.
//   5. **Las tres salidas de la página** —hay / no hay / retenida— se
//      distinguen, y una cita que no resuelve retiene la narración entera.
//
// Correr con `node tests/historia-narrar-endpoint.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { correrNarracion } from '../api/historia-narrar.js';
import { armarHistoria, armarNarracion, verificarCitas, citasDe } from '../api/_lib/historia-lectura.js';
import { hashNarracion } from '../api/_lib/historia-narrador.js';
import { autorizar } from '../api/_lib/historia-auth.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const EMISOR = { cik: '0001099590', ticker: 'MELI', nombre: 'MERCADOLIBRE INC', forma_anual: '10-K', cobertura: 'completa', ultima_ingesta: '2026-09-20T00:00:00Z' };
const fila = (accession, form, items = '', filed = '2026-02-20') => ({
  accession, form, items_raw: items, filed, report_date: null,
  url: `https://www.sec.gov/Archives/${accession}.htm`,
  index_url: `https://www.sec.gov/Archives/${accession}/`,
});
const FILAS = [fila('acc-502', '8-K', '5.02,9.01', '2026-02-20'), fila('acc-13d', 'SC 13D', '', '2025-11-04')];
const lectura = (emisor = EMISOR, filas = FILAS) => ({
  emisorPorTicker: async () => emisor,
  eventos: async () => ({ filas, total: filas.length }),
  serie: async () => [],
});

// Un almacén en memoria con el mismo contrato que el repo.
const almacenFalso = () => {
  const filas = [];
  return {
    filas,
    async guardarNarracion(n) { filas.push(n); return 1; },
    async narracionPorHash(cik, hash) {
      return filas.find((f) => f.cik === cik && f.hash === hash && f.estado === 'ok') || null;
    },
  };
};

const SECCIONES = [{ id: 'direccion', texto: 'Nombró un director financiero [acc-502].' }];
const llamarOk = (extra = {}) => async (ev) => ({
  estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
  secciones: SECCIONES, crudo: { id: 'msg_1' }, costo: { usd_total: 0.09 }, ...extra,
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La puerta que gasta es fail-closed');
{
  // Sin ninguna llave configurada NO queda abierta. Y no es 401: el que se
  // equivocó es el servidor.
  const sin = autorizar({ headers: {}, query: {} }, {});
  eq(sin.ok, false, 'sin llave configurada no autoriza');
  eq(sin.status, 503, 'y contesta 503, no 401: el problema es del servidor');

  const mal = autorizar({ headers: { 'x-admin-key': 'no' }, query: {} }, { ADMIN_SECRET: 'si' });
  eq(mal.ok, false, 'una llave equivocada no pasa');
  eq(mal.status, 401, 'y ahí sí es 401');
  ok(!JSON.stringify(mal.cuerpo).includes('si'), 'el 401 nunca enseña el valor de la llave');

  for (const [via, req] of [
    ['x-admin-key', { headers: { 'x-admin-key': 'si' }, query: {} }],
    ['Bearer', { headers: { authorization: 'Bearer si' }, query: {} }],
    ['?key=', { headers: {}, query: { key: 'si' } }],
    ['?secret=', { headers: {}, query: { secret: 'si' } }],
  ]) {
    eq(autorizar(req, { ADMIN_SECRET: 'si' }).ok, true, `la puerta ${via} funciona`);
  }
  eq(autorizar({ headers: { 'x-admin-key': 'k' }, query: {} }, { ARENA_ADMIN_KEY: 'k' }).ok, true,
    'y ARENA_ADMIN_KEY sirve igual que ADMIN_SECRET');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Lo que ya está no se vuelve a pagar');
{
  const almacen = almacenFalso();
  let llamadas = 0;
  const llamar = async (ev) => { llamadas++; return llamarOk()(ev); };

  const r1 = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar, apiKey: 'k' });
  eq(r1.status, 200, 'la primera corrida narra');
  eq(r1.cuerpo.narrada, true, 'y lo dice');
  eq(llamadas, 1, 'con una llamada');
  ok(r1.cuerpo.costo, 'y el costo a la vista');

  const r2 = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar, apiKey: 'k' });
  eq(llamadas, 1, 'la segunda NO llama: mismo hash');
  eq(r2.cuerpo.cacheada, true, 'se marca como cacheada');
  eq(r2.cuerpo.costo, null, 'y no inventa un costo que no se pagó');
  hondo(r2.cuerpo.secciones, SECCIONES, 'devolviendo lo guardado');

  // Un filing nuevo cambia el hash y eso SÍ vuelve a narrar.
  const conNuevo = [fila('acc-nuevo', '8-K', '1.01', '2026-07-01'), ...FILAS];
  await correrNarracion('MELI', { lectura: lectura(EMISOR, conNuevo), almacen, llamar, apiKey: 'k' });
  eq(llamadas, 2, 'un filing nuevo sí re-narra: la historia cambió');

  // `forzar` existe para poder rehacerla a mano sin esperar un filing.
  await correrNarracion('MELI', { lectura: lectura(), almacen, llamar, apiKey: 'k', forzar: true });
  eq(llamadas, 3, 'forzar=1 narra aunque ya esté guardada');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Se guarda SIEMPRE, y simular no gasta');
{
  // Una narración rechazada no es basura: es la evidencia de por qué se
  // rechazó. Sin ella el guardia es una caja negra que dice "no".
  for (const estado of ['cortada', 'rechazo_modelo', 'json_invalido', 'http', 'modelo_distinto']) {
    const almacen = almacenFalso();
    const llamar = async (ev) => ({
      estado, hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
      crudo: { lo_que_dijo: 'texto del modelo' }, costo: { usd_total: 0.09 }, detalle: 'x',
    });
    const r = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar, apiKey: 'k' });
    eq(almacen.filas.length, 1, `el estado "${estado}" se guarda igual`);
    ok(almacen.filas[0].crudo, '…con la respuesta cruda adentro');
    eq(almacen.filas[0].secciones, null, '…y sin secciones servibles');
    eq(r.status, 502, '…y el endpoint contesta 502, no 200');
    ok(r.cuerpo.costo, '…pero muestra el costo: se pagó igual');
    eq(r.cuerpo.secciones, null, '…sin devolver texto a medias');
  }

  // Una que falló NO se sirve después como si estuviera buena.
  {
    const almacen = almacenFalso();
    let llamadas = 0;
    const falla = async (ev) => { llamadas++; return { estado: 'cortada', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h', crudo: {}, costo: {} }; };
    await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: falla, apiKey: 'k' });
    await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: falla, apiKey: 'k' });
    eq(llamadas, 2, 'una narración cortada no queda cacheada: se reintenta');
  }

  // `simular=1` arma todo y no llama: sirve para ver el costo que se VA a
  // pagar antes de pagarlo.
  {
    const almacen = almacenFalso();
    let llamadas = 0;
    const r = await correrNarracion('MELI', {
      lectura: lectura(), almacen, apiKey: 'k', simular: true,
      llamar: async () => { llamadas++; },
    });
    eq(llamadas, 0, 'simular NO llama');
    eq(almacen.filas.length, 0, 'ni guarda nada');
    eq(r.cuerpo.estado, 'simulado', 'y lo dice');
    ok(r.cuerpo.evidencia_bytes > 0, 'con el peso de lo que se iba a mandar');
    ok(r.cuerpo.hash, 'y el hash con el que se guardaría');
  }

  // Un emisor sin ingerir no se narra "en chiquito": no se narra.
  {
    const almacen = almacenFalso();
    let llamadas = 0;
    const r = await correrNarracion('LULU', {
      lectura: lectura({ ...EMISOR, ultima_ingesta: null }), almacen, apiKey: 'k',
      llamar: async () => { llamadas++; },
    });
    eq(r.status, 409, 'un emisor sin ingerir no se narra');
    eq(llamadas, 0, 'y no se gasta en intentarlo');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las tres salidas de la página');
{
  const { cuerpo } = await armarHistoria(lectura(), 'MELI', {});

  // (a) No hay narración: se declara, igual que "sin documentos".
  {
    const n = await armarNarracion(cuerpo, { buscar: async () => null });
    eq(n.estado, 'sin_narracion', 'sin narración guardada se dice');
    hondo(n.secciones, [], 'sin texto inventado');
    ok(/se guarda, no se escribe cada vez/.test(n.declaraciones[0].texto),
      'y la declaración explica que no se genera al abrir la página');
    ok(n.hash, 'con el hash, para saber cuál generar');
  }

  // (b) Hay narración y sus citas resuelven.
  {
    const n = await armarNarracion(cuerpo, {
      buscar: async () => ({ secciones: SECCIONES, modelo: 'claude-opus-5', prompt_version: 1, creado_en: 'x' }),
    });
    eq(n.estado, 'ok', 'con narración guardada y citas que resuelven, se muestra');
    hondo(n.secciones, SECCIONES, 'con su texto');
    eq(n.modelo, 'claude-opus-5', 'y la procedencia: qué modelo y qué versión de prompt');
    eq(n.prompt_version, 1, 'la versión también');
  }

  // (c) EL CASO QUE IMPORTA: una cita que no resuelve retiene TODO.
  {
    const n = await armarNarracion(cuerpo, {
      buscar: async () => ({
        secciones: [
          { id: 'direccion', texto: 'Nombró un CFO [acc-502].' },
          { id: 'catalizador', texto: 'Compró una empresa [acc-inventado].' },
        ],
        modelo: 'claude-opus-5', prompt_version: 1,
      }),
    });
    eq(n.estado, 'retenida', 'una cita que no resuelve retiene la narración');
    hondo(n.secciones, [], 'y NO se muestra ninguna sección, ni siquiera la buena');
    hondo(n.citas_desconocidas, ['acc-inventado'], 'se dice cuál falló');
    ok(/no lo es/.test(n.declaraciones[0].texto),
      'y por qué: un texto que parece riguroso y no lo es es peor que no tener texto');
  }

  // El detector de citas.
  hondo(citasDe('Nombró [acc-1] y firmó [0000320193-25-000073].'), ['acc-1', '0000320193-25-000073'],
    'las citas se extraen del texto');
  hondo(citasDe('Nada de esto [a] es una cita, ni [12].'), [],
    'y un corchete corto no se confunde con un accession');
  eq(verificarCitas([{ texto: 'sin citas' }], new Set()).ok, true, 'un texto sin citas no falla la verificación');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
