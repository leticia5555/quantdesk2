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
import {
  hashNarracion, sumarCostos, MAX_TOKENS, MAX_TOKENS_REINTENTO, MAX_INTENTOS,
} from '../api/_lib/historia-narrador.js';
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
    async guardarNarracion(n) {
      // Como el repo real: los intentos se ACUMULAN sobre la fila que ya
      // estaba. Pisarlos haría que el tope no llegara nunca.
      const previa = filas.find((f) => f.cik === n.cik && f.hash === n.hash);
      if (previa) Object.assign(previa, n, { intentos: (previa.intentos || 0) + (n.intentos || 1) });
      else filas.push({ ...n, intentos: n.intentos || 1 });
      return 1;
    },
    async intentoPrevio(cik, hash) {
      return filas.find((f) => f.cik === cik && f.hash === hash) || null;
    },
    async esquemaListo() { return true; },
    async asegurarEsquema() { return true; },
    async narracionPorHash(cik, hash) {
      // Como el repo real: `ok_con_cortes` también sirve; `rechazada` no.
      return filas.find((f) => f.cik === cik && f.hash === hash
        && (f.estado === 'ok' || f.estado === 'ok_con_cortes')) || null;
    },
  };
};

// La forma REAL que devuelve costoDe: un doble recortado escondería que el
// sumador depende de campos que el doble no traía.
const COSTO = (total) => ({
  modelo: 'claude-opus-5',
  tokens: { entrada: 12000, salida: 1400, cache_escritura: 1430, cache_lectura: 0 },
  usd: { entrada: total * 0.6, salida: total * 0.4, cache_escritura: 0, cache_lectura: 0 },
  usd_total: total,
  cache_pego_pct: 0,
});

const SECCIONES = [{ id: 'direccion', texto: 'Nombró un director financiero [acc-502].' }];
const llamarOk = (extra = {}) => async (ev) => ({
  estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
  secciones: SECCIONES, crudo: { id: 'msg_1' }, costo: COSTO(0.09), ...extra,
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
      crudo: { lo_que_dijo: 'texto del modelo' }, costo: COSTO(0.09), detalle: 'x',
    });
    const r = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar, apiKey: 'k' });
    eq(almacen.filas.length, 1, `el estado "${estado}" se guarda igual`);
    ok(almacen.filas[0].crudo, '…con la respuesta cruda adentro');
    eq(almacen.filas[0].secciones, null, '…y sin secciones servibles');
    eq(r.status, 502, '…y el endpoint contesta 502, no 200');
    ok(r.cuerpo.costo, '…pero muestra el costo: se pagó igual');
    eq(r.cuerpo.secciones, null, '…sin devolver texto a medias');
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
console.log('\n── El reintento de una narración cortada tiene tope');
{
  // Misma evidencia, mismo prompt, mismo modelo: el segundo intento trunca
  // igual. Lo ÚNICO que puede cambiar el resultado es el techo, así que el
  // reintento lo sube una vez y después se para.
  {
    const almacen = almacenFalso();
    const techos = [];
    const cortaSiempre = async (ev, opts) => {
      techos.push(opts.maxTokens);
      return { estado: 'cortada', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5',
        huella_prompt: 'h', crudo: { t: techos.length }, costo: COSTO(0.05), detalle: 'techo' };
    };

    const r1 = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: cortaSiempre, apiKey: 'k' });
    hondo(techos, [MAX_TOKENS, MAX_TOKENS_REINTENTO], 'el reintento sube el techo, no repite el mismo');
    eq(techos.length, MAX_INTENTOS, `y son ${MAX_INTENTOS} intentos, no más`);
    eq(r1.cuerpo.intentos, 2, 'la respuesta dice cuántas llamadas se pagaron');

    // EL NÚMERO QUE NO PUEDE MENTIR HACIA ABAJO: el costo es la suma de los
    // dos intentos, no el del último. El que falló es el que más ganas dan
    // de no mirar, y por eso tiene que estar.
    eq(r1.cuerpo.costo.usd_total, 0.1, 'el costo suma los DOS intentos');
    eq(r1.cuerpo.costo.intentos, 2, 'y lo dice');
    eq(r1.cuerpo.costo.tokens.entrada, 24000, 'los tokens también se suman');

    // Y en la visita siguiente NO se vuelve a llamar: un tope que se reinicia
    // en cada lectura es un infinito en cuotas.
    const antes = techos.length;
    const r2 = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: cortaSiempre, apiKey: 'k' });
    eq(techos.length, antes, 'la corrida siguiente NO llama: ya gastó sus intentos');
    eq(r2.status, 409, 'y lo contesta con 409');
    eq(r2.cuerpo.estado, 'cortada_definitiva', 'con su propio estado');
    eq(r2.cuerpo.intentos_gastados, 2, 'diciendo cuántos se gastaron');
    ok(/forzar=1/.test(r2.cuerpo.detalle), 'y cómo pagarlo igual si se quiere');
    eq(r2.cuerpo.costo, null, 'sin inventar un costo que no se pagó');

    // `forzar` sigue siendo la salida de emergencia.
    await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: cortaSiempre, apiKey: 'k', forzar: true });
    ok(techos.length > antes, 'forzar=1 llama igual: es la salida de emergencia');
  }

  // Si el reintento con el techo al doble SÍ entra, se guarda como buena.
  {
    const almacen = almacenFalso();
    let n = 0;
    const cortaUnaVez = async (ev, opts) => {
      n++;
      if (opts.maxTokens === MAX_TOKENS) {
        return { estado: 'cortada', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5',
          huella_prompt: 'h', crudo: {}, costo: COSTO(0.05) };
      }
      return { estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5',
        huella_prompt: 'h', secciones: SECCIONES, crudo: {}, costo: COSTO(0.07) };
    };
    const r = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: cortaUnaVez, apiKey: 'k' });
    eq(n, 2, 'dos llamadas');
    eq(r.cuerpo.estado, 'ok', 'y con el techo al doble entra');
    eq(r.cuerpo.costo.usd_total, 0.12, 'pero el costo incluye el intento que se cortó');
    hondo(r.cuerpo.secciones, SECCIONES, 'con su texto');
  }

  // Un final que NO es "cortada" no se reintenta: subir el techo no arregla
  // un rechazo del clasificador ni un 500.
  for (const estado of ['rechazo_modelo', 'json_invalido', 'http']) {
    const almacen = almacenFalso();
    let n = 0;
    const falla = async (ev) => {
      n++;
      return { estado, hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5',
        huella_prompt: 'h', crudo: {}, costo: COSTO(0.05) };
    };
    await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: falla, apiKey: 'k' });
    eq(n, 1, `"${estado}" no se reintenta: subir el techo no lo arregla`);
  }

  // El sumador, aparte.
  {
    eq(sumarCostos([]), null, 'sin costos no se inventa uno');
    eq(sumarCostos([COSTO(0.09)]).intentos, 1, 'un solo intento se reporta como uno');
    eq(sumarCostos([COSTO(0.05), COSTO(0.07)]).usd_total, 0.12, 'dos intentos se suman');
    // Si alguno no tiene precio, el total no se puede afirmar: se dicen los
    // tokens, que sí se saben, y el costo va null.
    const sinPrecio = sumarCostos([COSTO(0.05), { modelo: 'x', tokens: { entrada: 10, salida: 0, cache_escritura: 0, cache_lectura: 0 }, usd: null, usd_total: null, sin_precio: true }]);
    eq(sinPrecio.usd_total, null, 'con un intento sin precio, el total NO se afirma');
    eq(sinPrecio.tokens.entrada, 12010, 'pero los tokens sí: eso se sabe');
    eq(sinPrecio.sin_precio, true, 'y se dice por qué');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Nunca se llama a lo que no se va a poder guardar');
//
// Gasto perdido real (§11.7): con `forzar=1` la lectura previa de
// company_narracion se saltea, así que el primer contacto con la tabla era el
// GUARDADO — después de la llamada. La tabla no estaba, la llamada se pagó, y
// la respuesta se perdió. Y lo peor: la cruda se guarda en esa misma fila, o
// sea que el resguardo vivía en la tabla que falló.
{
  const sinEsquema = () => ({
    ...almacenFalso(),
    async esquemaListo() { return false; },
    async asegurarEsquema() { return true; },   // "corre" pero no arregla nada
  });

  for (const forzar of [false, true]) {
    const almacen = sinEsquema();
    let llamadas = 0;
    const r = await correrNarracion('MELI', {
      lectura: lectura(), almacen, apiKey: 'k', forzar,
      llamar: async () => { llamadas++; return llamarOk()({}); },
    });
    eq(llamadas, 0, `sin la tabla NO se llama al modelo (forzar=${forzar})`);
    eq(r.status, 503, '…y contesta 503');
    eq(r.cuerpo.estado, 'sin_esquema', '…con su propio estado');
    eq(r.cuerpo.intentos, 0, '…diciendo que no hubo llamadas');
    ok(/no se llamó al modelo/i.test(r.cuerpo.detalle), '…y que por eso no se gastó');
    ok(/historia\.sql|job=sembrar/.test(r.cuerpo.detalle), '…más cómo arreglarlo');
  }

  // Si el esquema se puede crear solo, se crea y se sigue: la falta de tabla
  // no tiene por qué ser una parada manual.
  {
    let creado = false;
    const almacen = {
      ...almacenFalso(),
      async esquemaListo() { return creado; },
      async asegurarEsquema() { creado = true; return true; },
    };
    let llamadas = 0;
    const r = await correrNarracion('MELI', {
      lectura: lectura(), almacen, apiKey: 'k',
      llamar: async (ev) => { llamadas++; return llamarOk()(ev); },
    });
    eq(creado, true, 'se intenta crear el esquema una vez');
    eq(llamadas, 1, 'y ahí sí se llama');
    eq(r.cuerpo.estado, 'ok', 'con resultado normal');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Un fallo que costó plata dice cuánto costó');
{
  // El guardado revienta DESPUÉS de la llamada. La plata ya se gastó, y el
  // resguardo de la cruda era justamente la fila que no se pudo escribir: lo
  // único que queda es la respuesta HTTP.
  const almacen = {
    ...almacenFalso(),
    async esquemaListo() { return true; },
    async guardarNarracion() { throw new Error('relation company_narracion does not exist'); },
  };
  const r = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: llamarOk(), apiKey: 'k' });

  eq(r.status, 502, 'un guardado fallido no es un 200');
  eq(r.cuerpo.estado, 'guardado_fallido', 'con su propio estado, distinto del del modelo');
  eq(r.cuerpo.estado_modelo, 'ok', 'y el del modelo también, que si no se pierde con la fila');
  ok(r.cuerpo.costo && r.cuerpo.costo.usd_total > 0, 'EL COSTO VA EN LA RESPUESTA: se pagó igual');
  eq(r.cuerpo.intentos, 1, 'y cuántas llamadas se hicieron');
  ok(/se pagó/.test(r.cuerpo.detalle), 'el detalle dice que se pagó');
  ok(/relation company_narracion/.test(r.cuerpo.detalle), 'y por qué no se pudo guardar');

  // Lo que se compró viaja en la respuesta, porque en la tabla no entró.
  hondo(r.cuerpo.secciones, SECCIONES, 'la narración comprada se devuelve');
  ok(r.cuerpo.crudo_no_guardado, 'y la cruda también: es lo único que queda de esta corrida');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El guardia corre ANTES de guardar, no al leer');
{
  // Una narración con una cita inventada no debe llegar a EXISTIR como
  // servible. Lo que se guarda es el texto ya cortado; la cruda queda intacta
  // para poder ver qué dijo el modelo antes del corte.
  const conInventada = async (ev) => ({
    estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
    secciones: [
      { id: 'direccion', texto: 'Nombró un director financiero [acc-502]. Compró una empresa [acc-inventado].' },
      { id: 'catalizador', texto: 'Todo inventado [otro-inventado].' },
    ],
    crudo: { id: 'msg_1' }, costo: COSTO(0.09),
  });

  const almacen = almacenFalso();
  const r = await correrNarracion('MELI', { lectura: lectura(), almacen, llamar: conInventada, apiKey: 'k' });

  eq(r.cuerpo.estado, 'ok_con_cortes', 'el estado dice que se cortó algo');
  eq(r.status, 200, 'y sirve igual: sobrevivió una sección');
  eq(r.cuerpo.secciones.length, 1, 'la sección sin nada que sostener desaparece');
  eq(r.cuerpo.secciones[0].texto, 'Nombró un director financiero [acc-502].',
    'y de la que queda, solo la afirmación citable');
  ok(!JSON.stringify(r.cuerpo.secciones).includes('inventado'),
    'ninguna cita inventada sobrevive al guardado');

  // Lo que se cortó se cuenta y viaja.
  eq(r.cuerpo.cortes.afirmaciones_cortadas, 2, 'dos afirmaciones cortadas');
  eq(r.cuerpo.cortes.secciones_cortadas, 1, 'y una sección entera');

  // EN LA FILA: el texto guardado es el cortado, la cruda es la original.
  const fila = almacen.filas[0];
  eq(fila.estado, 'ok_con_cortes', 'la fila guarda el estado del guardia');
  eq(fila.secciones.length, 1, 'con el texto ya cortado');
  ok(fila.cortes && fila.cortes.lista.length === 3, 'y la lista completa de cortes');
  ok(/Compró una empresa/.test(JSON.stringify(fila.cortes)),
    'con el texto cortado adentro: sin eso no se puede ver qué dijo el modelo');
  ok(fila.crudo, 'la cruda queda intacta, sin cortar');

  // Si NADA sobrevive, no se sirve: la página se cae a la Fase A.
  {
    const todoMalo = async (ev) => ({
      estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
      secciones: [{ id: 'direccion', texto: 'Inventado [no-existe].' }],
      crudo: {}, costo: COSTO(0.09),
    });
    const a2 = almacenFalso();
    const r2 = await correrNarracion('MELI', { lectura: lectura(), almacen: a2, llamar: todoMalo, apiKey: 'k' });
    eq(r2.cuerpo.estado, 'rechazada', 'sin ninguna sección viva, la narración se rechaza');
    eq(r2.status, 502, 'y no se contesta 200');
    eq(r2.cuerpo.secciones, null, 'sin texto servible');
    ok(r2.cuerpo.costo.usd_total > 0, 'pero el costo se reporta: se pagó igual');
    // Y NO queda cacheada como buena: la próxima lectura no la sirve.
    eq(await a2.narracionPorHash('0001099590', r2.cuerpo.hash), null,
      'una narración rechazada no se sirve después como si estuviera buena');
  }

  // Una opinión que se cuela tampoco sobrevive al guardado.
  {
    const conOpinion = async (ev) => ({
      estado: 'ok', hash: hashNarracion(ev), prompt_version: 1, modelo: 'claude-opus-5', huella_prompt: 'h',
      secciones: [{ id: 'direccion', texto: 'Nombró un CFO [acc-502]. La acción está barata [acc-502].' }],
      crudo: {}, costo: COSTO(0.09),
    });
    const a3 = almacenFalso();
    const r3 = await correrNarracion('MELI', { lectura: lectura(), almacen: a3, llamar: conOpinion, apiKey: 'k' });
    eq(r3.cuerpo.secciones[0].texto, 'Nombró un CFO [acc-502].', 'la opinión se corta aunque tenga cita válida');
    eq(r3.cuerpo.cortes.por_motivo.opinion, 1, 'y se cuenta como opinión');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las tres salidas de la página');
{
  const { cuerpo } = await armarHistoria(lectura(), 'MELI', {});

  // (a) No hay narración NI intento: se declara, igual que "sin documentos".
  {
    const n = await armarNarracion(cuerpo, { buscar: async () => null, intento: async () => null });
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

  // (d) SE INTENTÓ Y FALLÓ. No es lo mismo que no haberlo intentado, y verlos
  // iguales borra justo el dato que decide qué hacer: esperar a que corra el
  // job, o ir a mirar qué pasó. Es la doctrina de sin_documentos vs
  // no_cubierta, aplicada a la narración.
  {
    const n = await armarNarracion(cuerpo, {
      buscar: async () => null,
      intento: async () => ({ estado: 'cortada', intentos: 2, detalle: 'techo' }),
    });
    eq(n.estado, 'fallida', 'un intento fallido tiene su propio estado, distinto de "no hay"');
    eq(n.motivo, 'cortada', 'con el motivo en categoría');
    eq(n.intentos, 2, 'y cuántas llamadas se pagaron');
    hondo(n.secciones, [], 'sin mostrar nada a medias');
    ok(/se lee como completa/.test(n.declaraciones[0].texto),
      'y la declaración dice por qué no se muestra el pedazo que llegó');
    // El texto crudo del modelo NO sale acá: vive en la fila y se mira con la
    // llave, no en una página pública.
    ok(!/techo/.test(JSON.stringify(n)), 'el detalle crudo no se filtra a la página');
  }

  // Un intento que salió OK no se reporta como falla, obviamente — pero la
  // combinación importa: hay fila 'ok' Y la busca la encuentra.
  {
    const n = await armarNarracion(cuerpo, {
      buscar: async () => ({ secciones: SECCIONES, modelo: 'claude-opus-5', prompt_version: 1 }),
      intento: async () => ({ estado: 'ok', intentos: 1 }),
    });
    eq(n.estado, 'ok', 'con fila buena, se muestra');
  }

  // Los cuatro estados son distintos entre sí: si dos colapsaran, la página
  // mostraría lo mismo para dos situaciones que piden acciones opuestas.
  {
    const estados = new Set();
    estados.add((await armarNarracion(cuerpo, { buscar: async () => null, intento: async () => null })).estado);
    estados.add((await armarNarracion(cuerpo, { buscar: async () => null, intento: async () => ({ estado: 'http' }) })).estado);
    estados.add((await armarNarracion(cuerpo, { buscar: async () => ({ secciones: [{ id: 'd', texto: 'x [no-existe-1]' }] }) })).estado);
    estados.add((await armarNarracion(cuerpo, { buscar: async () => ({ secciones: SECCIONES }) })).estado);
    eq(estados.size, 4, 'los cuatro estados de la narración son distintos entre sí');
    hondo([...estados].sort(), ['fallida', 'ok', 'retenida', 'sin_narracion'], 'y son estos');
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
