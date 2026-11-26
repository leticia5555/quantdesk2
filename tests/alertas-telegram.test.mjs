// ═══════════════════════════════════════════════════════════════════
// tests/alertas-telegram.test.mjs — las alertas de Telegram.
//
// Lo que estas pruebas cuidan son las reglas que Lety puso, no el formato:
//   · el token del bot no sale en NINGÚN error;
//   · la misma alerta no se manda dos veces;
//   · sin datos no hay mensaje (y nunca un "no hay nada");
//   · todo mensaje lleva su link a QuantDesk;
//   · el top del cierre sólo cuenta emisoras con la barra de HOY.
//
// Sin red y sin base: todo lo que toca afuera entra inyectado.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mandaMensaje, llamaTelegram, chatsDeUpdates, descubreChatId, resuelveChatId, sinToken, escapaHtml,
} from '../api/_lib/telegram.js';
import {
  textoManana, textoCierre, eligeMovimientos, eligeSectores, movimientoDelDia, textoMovimiento,
  resumenesDeInsider, textoInsider, accionDeNoticia, textoNoticia, claveNoticia,
  avisosDeSubmissions, texto8K, eventosDeVispera, textoVispera, categoriaDeEvento,
  claveMovimiento, fechaLarga, hora12, dinero, fechaMonterrey, fechaNuevaYork,
} from '../api/_lib/alertas.js';
import { sesionDe, cotizaYahoo, fotos } from '../api/_lib/alertas-fuentes.js';
import { enviaUnaVez, autoriza } from '../api/alertas.js';
import { CALENDARIO_OFICIAL } from '../api/_lib/macro-oficial.js';

const TOKEN = '123456789:AAFakeTokenDePrueba_noEsReal_0123456789';
const LINK = /<a href="https:\/\/quantdesk2\.vercel\.app\/[^"]*">Ver más en QuantDesk →<\/a>$/;
const VACIO = /no hay|sin novedad|nada que reportar|sin eventos|sin datos/i;
const respuesta = (status, body) => ({ ok: status < 400, status, json: async () => body });

// ── telegram.js ──────────────────────────────────────────────────────
test('mandaMensaje: manda HTML al chat y devuelve el id', async () => {
  const vistas = [];
  const fetchImpl = async (url, init) => { vistas.push({ url, cuerpo: JSON.parse(init.body) }); return respuesta(200, { ok: true, result: { message_id: 7 } }); };
  const r = await mandaMensaje('hola <b>Lety</b>', { chatId: '42', token: TOKEN, fetchImpl });
  assert.equal(r.message_id, 7);
  assert.equal(vistas.length, 1);
  assert.ok(vistas[0].url.endsWith('/sendMessage'));
  assert.deepEqual(vistas[0].cuerpo, { chat_id: '42', text: 'hola <b>Lety</b>', parse_mode: 'HTML', disable_web_page_preview: true });
});

test('mandaMensaje: un texto vacío NO se manda', async () => {
  let llamadas = 0;
  const fetchImpl = async () => { llamadas++; return respuesta(200, { ok: true, result: {} }); };
  for (const t of ['', '   \n ', null, undefined]) {
    await assert.rejects(() => mandaMensaje(t, { chatId: '42', token: TOKEN, fetchImpl }), /vacío/);
  }
  assert.equal(llamadas, 0);
});

test('el token no aparece en ningún error', async () => {
  // Telegram rechaza, y además cita la URL (que lleva el token).
  const rechaza = async (url) => respuesta(401, { ok: false, description: `Unauthorized at ${url}` });
  await assert.rejects(() => llamaTelegram('sendMessage', {}, { token: TOKEN, fetchImpl: rechaza }), (e) => {
    assert.ok(!e.message.includes(TOKEN), 'el token viajó en el error');
    assert.ok(!e.message.includes('AAFake'));
    assert.match(e.message, /Unauthorized/);
    return true;
  });
  // La red falla con un error que cita la URL completa.
  const seCae = async (url) => { throw new Error(`fetch failed: ${url}`); };
  await assert.rejects(() => llamaTelegram('getUpdates', {}, { token: TOKEN, fetchImpl: seCae }), (e) => {
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  await assert.rejects(() => llamaTelegram('getMe', {}, { token: null }), /Falta TELEGRAM_BOT_TOKEN/);
  assert.equal(sinToken(`x ${TOKEN} y`, null), 'x <token> y');
});

test('chatsDeUpdates: sólo chats privados, sin repetir, el más reciente primero', () => {
  const chats = chatsDeUpdates([
    { message: { date: 10, chat: { id: 111, type: 'private', first_name: 'Lety' } } },
    { message: { date: 30, chat: { id: 111, type: 'private', first_name: 'Lety' } } },
    { message: { date: 20, chat: { id: -500, type: 'group', title: 'grupo' } } },
    { message: { date: 25, chat: { id: 222, type: 'private', first_name: 'Otro' } } },
    { channel_post: { chat: { id: 9, type: 'channel' } } },
  ]);
  assert.deepEqual(chats.map((c) => c.chat_id), ['111', '222']);
});

test('descubreChatId: guarda si hay UN chat; con varios no adivina', async () => {
  const con = (updates) => async () => respuesta(200, { ok: true, result: updates });
  const guardados = [];
  const guardar = async (k, v) => { guardados.push([k, v]); };
  const uno = [{ message: { date: 1, chat: { id: 111, type: 'private', first_name: 'Lety' } } }];
  const dos = [...uno, { message: { date: 2, chat: { id: 222, type: 'private', first_name: 'Otro' } } }];

  const a = await descubreChatId({ token: TOKEN, fetchImpl: con(uno), guardar });
  assert.equal(a.ok, true);
  assert.deepEqual(guardados, [['TELEGRAM_CHAT_ID', '111']]);

  const b = await descubreChatId({ token: TOKEN, fetchImpl: con(dos), guardar });
  assert.equal(b.ok, false);
  assert.equal(b.chats.length, 2);
  assert.equal(guardados.length, 1, 'con dos chats no se guarda ninguno');

  const c = await descubreChatId({ token: TOKEN, fetchImpl: con(dos), guardar, elegido: '222' });
  assert.equal(c.chat_id, '222');

  const d = await descubreChatId({ token: TOKEN, fetchImpl: con([]), guardar });
  assert.equal(d.ok, false);
  assert.match(d.motivo, /24 horas/);
});

test('resuelveChatId: la env var gana; si no, lo guardado', async () => {
  assert.deepEqual(await resuelveChatId({ env: { TELEGRAM_CHAT_ID: ' 9 ' }, leer: async () => '5' }), { chatId: '9', fuente: 'env:TELEGRAM_CHAT_ID' });
  assert.equal((await resuelveChatId({ env: {}, leer: async () => '5' })).chatId, '5');
  assert.equal((await resuelveChatId({ env: {}, leer: async () => null })).chatId, null);
});

// ── el candado de repetidos ──────────────────────────────────────────
function candadoDeMentira() {
  const claves = new Set();
  return {
    claves,
    async aparta(k) { if (claves.has(k)) return false; claves.add(k); return true; },
    async suelta(k) { claves.delete(k); },
  };
}

test('enviaUnaVez: la misma clave se manda UNA vez', async () => {
  const candado = candadoDeMentira();
  const mandados = [];
  const manda = async (t) => { mandados.push(t); };
  const a = await enviaUnaVez({ clave: 'cierre:2026-12-01', tipo: 'cierre', texto: 'hola' }, { candado, manda });
  const b = await enviaUnaVez({ clave: 'cierre:2026-12-01', tipo: 'cierre', texto: 'hola otra vez' }, { candado, manda });
  assert.equal(a.estado, 'enviada');
  assert.equal(b.estado, 'ya_enviada');
  assert.deepEqual(mandados, ['hola']);
});

test('enviaUnaVez: dos corridas a la vez no mandan dos', async () => {
  const candado = candadoDeMentira();
  let n = 0;
  const manda = async () => { n++; await new Promise((r) => setTimeout(r, 5)); };
  const rs = await Promise.all([1, 2, 3].map(() => enviaUnaVez({ clave: 'k', tipo: 't', texto: 'x' }, { candado, manda })));
  assert.equal(n, 1);
  assert.equal(rs.filter((r) => r.estado === 'enviada').length, 1);
});

test('enviaUnaVez: si el envío falla, la clave se suelta y el error no trae el token', async () => {
  const candado = candadoDeMentira();
  let intento = 0;
  const manda = async () => { intento++; if (intento === 1) throw new Error(`boom ${TOKEN}`); };
  const a = await enviaUnaVez({ clave: 'k', tipo: 't', texto: 'x' }, { candado, manda });
  assert.equal(a.estado, 'error');
  assert.ok(!a.error.includes(TOKEN));
  assert.equal(candado.claves.size, 0);
  const b = await enviaUnaVez({ clave: 'k', tipo: 't', texto: 'x' }, { candado, manda });
  assert.equal(b.estado, 'enviada');
});

test('enviaUnaVez: sin texto no aparta la clave ni manda', async () => {
  const candado = candadoDeMentira();
  let n = 0;
  for (const texto of [null, '', '  ']) {
    const r = await enviaUnaVez({ clave: 'k', tipo: 't', texto }, { candado, manda: async () => { n++; } });
    assert.equal(r.estado, 'sin_contenido');
  }
  assert.equal(n, 0);
  assert.equal(candado.claves.size, 0);
});

// ── la mañana ────────────────────────────────────────────────────────
const FUT = [{ nombre: 'S&P 500', precio: 7244.75, pct: 0.68 }, { nombre: 'Nasdaq', precio: 26306.5, pct: 0.79 }];

test('textoManana: futuros, apertura y calendario', () => {
  const cpi = CALENDARIO_OFICIAL.find((e) => e.category === 'inflacion');
  const t = textoManana({
    fecha: cpi.event_date, futuros: FUT, apertura: { hora: '8:30', ya_abrio: false },
    macro: [cpi], reportes: [{ ticker: 'ADBE', time: 'AMC' }, { ticker: 'AVGO', time: 'AMC' }, { ticker: 'COST', time: 'TBD' }],
  });
  assert.match(t, /Buenos días/);
  assert.match(t, /🟢 S&amp;P 500: 7,244\.75 \(\+0\.68%\)/);
  assert.match(t, /apunta a abrir al alza/);
  assert.match(t, /El mercado abre a las 8:30 am\./);
  assert.match(t, /• 7:30 am · Inflación de EE\.UU\./);
  assert.match(t, /Reportan resultados después del cierre: ADBE, AVGO/);
  assert.match(t, /Reportan resultados: COST/);
  assert.match(t, LINK);
});

test('textoManana: un día sin calendario NO dice que no hay nada; sin datos es null', () => {
  const t = textoManana({ fecha: '2026-12-01', futuros: FUT });
  assert.ok(!/calendario/i.test(t), 'la sección vacía se omite');
  assert.ok(!VACIO.test(t));
  assert.match(t, LINK);
  assert.equal(textoManana({ fecha: '2026-12-01', futuros: [], macro: [], reportes: [] }), null);
  assert.equal(textoManana({ fecha: '2026-12-01', futuros: [{ nombre: 'S&P 500', precio: NaN, pct: null }] }), null);
});

test('textoManana: en verano, a las 8:00 el mercado ya abrió y lo dice', () => {
  const t = textoManana({ fecha: '2027-06-01', futuros: [{ nombre: 'S&P 500', precio: 7000, pct: -0.4 }, { nombre: 'Nasdaq', precio: 25000, pct: 0.3 }], apertura: { hora: '7:30', ya_abrio: true } });
  assert.match(t, /el mercado ya abrió/);
  assert.match(t, /El mercado abrió a las 7:30 am\./);
  assert.ok(!/apunta a abrir/.test(t));
});

// ── el cierre ────────────────────────────────────────────────────────
const SESION = '2026-11-25';
const foto = (prev, cierre, fecha = SESION) => ({ price: cierre, prev_close: prev, day_close: cierre, day_fecha: fecha });
const UNIVERSO = [
  { symbol: 'META', nombre: 'Meta Platforms Inc' }, { symbol: 'ORCL', nombre: 'Oracle Corp' },
  { symbol: 'NVDA', nombre: 'NVIDIA Corp' }, { symbol: 'DIS', nombre: 'Walt Disney Co' },
  { symbol: 'PSKY', nombre: 'Paramount Skydance Corp' }, { symbol: 'KO', nombre: 'Coca-Cola Co' },
  { symbol: 'XXX', nombre: 'Sin foto' },
];
const SNAPS = {
  META: foto(100, 103.4), ORCL: foto(100, 94.87), NVDA: foto(100, 96.09), DIS: foto(100, 102.52), KO: foto(100, 100),
  // PSKY: su última barra es de hace un mes. Entre esos dos cierres viejos "subió" 40%.
  PSKY: foto(10, 14, '2026-10-22'),
};

test('eligeMovimientos: una serie atrasada (PSKY) NO entra aunque sea el mayor cambio', () => {
  const m = eligeMovimientos(UNIVERSO, SNAPS, SESION, 3);
  assert.deepEqual(m.suben.map((x) => x.symbol), ['META', 'DIS']);
  assert.deepEqual(m.bajan.map((x) => x.symbol), ['ORCL', 'NVDA']);
  assert.deepEqual(m.atrasadas, ['PSKY']);
  assert.equal(m.al_dia, 5);
  // Y si TODAS están atrasadas (feriado, cosecha caída) la lista queda vacía.
  const viejo = eligeMovimientos(UNIVERSO, SNAPS, '2026-11-26', 3);
  assert.deepEqual([viejo.suben, viejo.bajan], [[], []]);
});

test('eligeSectores: mejor y peor, sólo con barras de hoy', () => {
  const s = eligeSectores({ XLK: foto(100, 99.17), XLB: foto(100, 101.49), XLF: foto(100, 100.71), XLE: foto(100, 80, '2026-11-20') }, SESION);
  assert.equal(s.mejor.nombre, 'Materiales');
  assert.equal(s.peor.nombre, 'Tecnología');
  assert.equal(eligeSectores({ XLK: foto(100, 99) }, SESION).mejor, null);
});

test('textoCierre: índices, top 3, sectores y link; sin datos es null', () => {
  const m = eligeMovimientos(UNIVERSO, SNAPS, SESION, 3);
  const t = textoCierre({
    fecha: SESION, indices: [{ nombre: 'S&P 500', precio: 7182.78, pct: -0.25 }, { nombre: 'Nasdaq', precio: 23585.8, pct: -0.62 }],
    suben: m.suben, bajan: m.bajan, sectores: eligeSectores({ XLK: foto(100, 99.17), XLB: foto(100, 101.49) }, SESION),
  });
  assert.match(t, /Cierre del mercado<\/b> · miércoles 25 de noviembre/);
  assert.match(t, /🔴 S&amp;P 500: 7,182\.78 \(-0\.25%\)/);
  assert.match(t, /1\. <b>META<\/b> · Meta Platforms {2}\+3\.40%/);
  assert.match(t, /1\. <b>ORCL<\/b> · Oracle {2}-5\.13%/);
  assert.ok(!t.includes('PSKY'));
  assert.match(t, /Mejor: Materiales \(\+1\.49%\)/);
  assert.match(t, /Peor: Tecnología \(-0\.83%\)/);
  assert.match(t, LINK);
  assert.equal(textoCierre({ fecha: SESION }), null);
  // Sin sectores medidos, la sección se omite en vez de decir que falta.
  const sin = textoCierre({ fecha: SESION, indices: [{ nombre: 'S&P 500', precio: 1, pct: 1 }], sectores: { mejor: null, peor: null } });
  assert.ok(!/Sectores/.test(sin) && !VACIO.test(sin));
});

// ── mis acciones ─────────────────────────────────────────────────────
test('movimientoDelDia: avisa de 5% para arriba o para abajo, sólo con la barra de hoy', () => {
  const o = { sesion: SESION, abierto: true };
  assert.equal(movimientoDelDia('NVDA', foto(100, 104.99), o), null);
  assert.equal(movimientoDelDia('NVDA', foto(100, 105), o).sube, true);
  assert.equal(movimientoDelDia('NVDA', foto(100, 94), o).sube, false);
  assert.equal(movimientoDelDia('NVDA', foto(100, 120, '2026-11-24'), o), null, 'la barra es de ayer');
  assert.equal(movimientoDelDia('NVDA', undefined, o), null);
  // Con el mercado cerrado manda el cierre, no un precio de fuera de horario.
  const tarde = { price: 120, prev_close: 100, day_close: 101, day_fecha: SESION };
  assert.equal(movimientoDelDia('NVDA', tarde, { sesion: SESION, abierto: false }), null);
  // Sube y baja el mismo día son dos alertas distintas; la misma dirección, una.
  assert.notEqual(claveMovimiento('NVDA', SESION, true), claveMovimiento('NVDA', SESION, false));
});

test('textoMovimiento', () => {
  const t = textoMovimiento(movimientoDelDia('NVDA', foto(149.3, 158.56), { sesion: SESION, abierto: true }));
  assert.match(t, /🚀 <b>NVDA sube 6\.2% hoy<\/b>/);
  assert.match(t, /Nvidia va en US\$158\.56\. Ayer cerró en US\$149\.30\./);
  assert.match(t, /quantdesk2\.vercel\.app\/analiza\/NVDA/);
  assert.equal(textoMovimiento(null), null);
});

test('resumenesDeInsider: sólo compras y ventas en mercado, de mis acciones, una por filing', () => {
  const base = { accession: '0001-26-000001', ticker: 'NVDA', quien: 'Jen-Hsun Huang', cargo: 'CEO', plan_estado: 'programada', derivada: false };
  const filas = [
    { ...base, tipo: 'venta', acciones: 1000, valor: 150000, fecha: '2026-11-23' },
    { ...base, tipo: 'venta', acciones: 3000, valor: 453000, fecha: '2026-11-24' },
    { ...base, tipo: 'opcion', acciones: 4000, valor: null },            // ejercicio: no avisa
    { ...base, tipo: 'impuesto', acciones: 500, valor: 75000 },          // retención: no avisa
    { ...base, tipo: 'venta', acciones: 10, valor: 1, derivada: true },  // derivado: no avisa
    { ...base, accession: '0001-26-000002', ticker: 'AAPL', tipo: 'compra', acciones: 10, valor: 10 }, // no es mía
    { ...base, accession: '0001-26-000003', ticker: 'SMMT', tipo: 'compra', acciones: 200, valor: null, plan_estado: 'sin_dato' },
  ];
  const r = resumenesDeInsider(filas);
  assert.equal(r.length, 2);
  const venta = r.find((x) => x.symbol === 'NVDA');
  assert.equal(venta.acciones, 4000);
  assert.equal(venta.valor, 603000);
  assert.equal(venta.fecha, '2026-11-24');
  const t = textoInsider(venta);
  assert.match(t, /Alguien de adentro vendió NVDA \(Nvidia\)/);
  assert.match(t, /Jen-Hsun Huang \(CEO\) vendió 4,000 acciones, unos US\$603,000 \(a US\$150\.75 cada una en promedio\)\./);
  assert.match(t, /venta programada/);
  assert.match(t, LINK);
  const compra = textoInsider(r.find((x) => x.symbol === 'SMMT'));
  assert.match(compra, /🟢 <b>Alguien de adentro compró SMMT/);
  assert.match(compra, /compró 200 acciones\./, 'sin precio declarado no se inventa un monto');
});

test('accionDeNoticia: por ticker etiquetado o por nombre, sin confundir palabras', () => {
  assert.equal(accionDeNoticia({ titular: 'Nvidia anuncia nuevos chips', tickers: [] }), 'NVDA');
  assert.equal(accionDeNoticia({ titular: 'El cohete de SpaceX despega', tickers: [] }), 'SPCX');
  assert.equal(accionDeNoticia({ titular: 'Chips rally', tickers: ['NVDA', 'AMD'] }), 'NVDA');
  assert.equal(accionDeNoticia({ titular: 'Antes de la Fed, el mercado espera', tickers: [] }), null, '"Antes" no es ANT');
  assert.equal(accionDeNoticia({ titular: 'Los misántropos', tickers: [] }), null);
  assert.equal(accionDeNoticia({ titular: 'Anthropic lanza un modelo', tickers: [] }), 'ANT');
  // El mismo hecho en dos medios, con el titular normalizado igual → una clave.
  assert.equal(claveNoticia('NVDA', 'nvidia anuncia chips'), claveNoticia('NVDA', 'nvidia anuncia chips'));
  const t = textoNoticia({ symbol: 'NVDA', titular: 'Nvidia <sube> & gana', fuente: 'Reuters', url: 'https://x.test/a?b=1&c=2' });
  assert.match(t, /Nvidia &lt;sube&gt; &amp; gana/);
  assert.match(t, /href="https:\/\/x\.test\/a\?b=1&amp;c=2"/);
  assert.match(t, LINK);
  assert.equal(textoNoticia({ symbol: 'NVDA', titular: '  ' }), null);
});

test('avisosDeSubmissions + texto8K: sólo 8-K con algo que decir, en español', () => {
  const sub = { filings: { recent: {
    form: ['8-K', '4', '8-K', '8-K', '10-Q'],
    filingDate: ['2026-11-24', '2026-11-24', '2026-11-23', '2026-10-01', '2026-11-20'],
    items: ['2.02,9.01', '', '9.01', '5.02', ''],
    accessionNumber: ['0001045810-26-000111', 'x', '0001045810-26-000110', '0001045810-26-000090', 'y'],
    primaryDocument: ['nvda-8k.htm', '', 'a.htm', 'b.htm', ''],
  } } };
  const avisos = avisosDeSubmissions(sub, { symbol: 'NVDA', cik: '0001045810', desde: '2026-11-20' });
  assert.equal(avisos.length, 1, 'el de sólo anexos y el viejo quedan fuera');
  assert.equal(avisos[0].url, 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000111/nvda-8k.htm');
  const t = texto8K(avisos[0]);
  assert.match(t, /Aviso oficial de NVDA \(Nvidia\)/);
  assert.match(t, /publicó sus resultados financieros\./);
  assert.match(t, LINK);
  assert.match(texto8K({ symbol: 'ANT', items: ['1.01', '5.02'] }), /firmó un acuerdo importante y anunció cambios en sus directivos o consejeros/);
  assert.equal(texto8K({ symbol: 'ANT', items: [] }), null);
  assert.deepEqual(avisosDeSubmissions(null, {}), []);
});

// ── la víspera ───────────────────────────────────────────────────────
test('eventosDeVispera: avisa lo que cae antes de la próxima sesión', () => {
  const ev = [
    { event_date: '2026-12-04', category: 'empleo', title: 'Empleo de EE.UU. (nóminas) de noviembre', note: 'BLS · 7:30 hora de CDMX' },
    { event_date: '2026-12-09', category: 'fed', title: 'Decisión de la Fed (FOMC)', note: 'comunicado 13:00 hora de CDMX' },
    { event_date: '2026-12-09', category: 'fed', title: 'FOMC (duplicado curado)' },
    { event_date: '2026-12-09', category: 'subasta', title: 'Subasta de bonos a 10 años' },
  ];
  assert.deepEqual(eventosDeVispera(ev, '2026-12-03', '2026-12-04').map((x) => x.categoria), ['empleo']);
  assert.deepEqual(eventosDeVispera(ev, '2026-12-04', '2026-12-07'), [], 'el mismo día ya no es víspera');
  assert.equal(eventosDeVispera(ev, '2026-12-08', '2026-12-09').length, 1, 'uno por categoría y fecha');
  // Viernes → lunes: el evento del lunes se avisa el viernes.
  const lunes = [{ event_date: '2026-12-14', category: 'inflacion', title: 'CPI' }];
  assert.equal(eventosDeVispera(lunes, '2026-12-11', '2026-12-14').length, 1);
  assert.equal(eventosDeVispera(lunes, '2026-12-10', '2026-12-11').length, 0);
});

test('categoriaDeEvento: por categoría, y por título en lo curado a mano', () => {
  assert.equal(categoriaDeEvento({ category: 'Fed' }), 'fed');
  assert.equal(categoriaDeEvento({ category: 'macro', title: 'Decisión de tasa de la Fed' }), 'fed');
  assert.equal(categoriaDeEvento({ title: 'CPI de noviembre' }), 'inflacion');
  assert.equal(categoriaDeEvento({ title: 'Nóminas no agrícolas' }), 'empleo');
  assert.equal(categoriaDeEvento({ title: 'Discurso de Powell, presidente de la Fed' }), null);
  assert.equal(categoriaDeEvento({ title: 'Inflación de México (INPC)' }), null);
  assert.equal(categoriaDeEvento({ title: 'PIB del tercer trimestre' }), null);
});

test('textoVispera: qué es y por qué importa, corto', () => {
  const [v] = eventosDeVispera([{ event_date: '2026-12-09', category: 'fed', title: 'Decisión de la Fed (FOMC)', note: 'comunicado 13:00 hora de CDMX' }], '2026-12-08', '2026-12-09');
  const t = textoVispera({ ...v, hoy: '2026-12-08' });
  assert.match(t, /⏰ <b>Mañana: decisión de la Fed<\/b>/);
  assert.match(t, /Miércoles 9 de diciembre, 1:00 pm/);
  assert.match(t, /<b>Qué es:<\/b>/);
  assert.match(t, /<b>Por qué importa:<\/b>/);
  assert.match(t, LINK);
  assert.ok(t.length < 700, 'es un aviso corto');
  assert.match(textoVispera({ categoria: 'inflacion', fecha: '2026-12-14', hoy: '2026-12-11' }), /El lunes: dato de inflación/);
  assert.equal(textoVispera({ categoria: 'pib', fecha: '2026-12-14', hoy: '2026-12-11' }), null);
});

// ── fuentes ──────────────────────────────────────────────────────────
test('sesionDe: feriado, y la hora de apertura en Monterrey en invierno y en verano', async () => {
  const cal = (filas) => async () => filas;
  // Día de Acción de Gracias: el calendario no trae la fecha de hoy.
  const feriado = await sesionDe(new Date('2026-11-26T14:00:00Z'), { calendario: cal([{ date: '2026-11-27', open: '09:30', close: '13:00' }]) });
  assert.equal(feriado.habil, false);
  assert.equal(feriado.proxima, '2026-11-27');

  const invierno = await sesionDe(new Date('2026-12-01T14:00:00Z'), { calendario: cal([{ date: '2026-12-01', open: '09:30', close: '16:00' }, { date: '2026-12-02', open: '09:30', close: '16:00' }]) });
  assert.deepEqual([invierno.habil, invierno.abre_hora, invierno.ya_abrio, invierno.proxima], [true, '8:30', false, '2026-12-02']);
  const cierreInvierno = await sesionDe(new Date('2026-12-01T21:15:00Z'), { calendario: cal([{ date: '2026-12-01', open: '09:30', close: '16:00' }]) });
  assert.deepEqual([cierreInvierno.ya_cerro, cierreInvierno.abierto], [true, false]);

  const verano = await sesionDe(new Date('2027-06-01T14:00:00Z'), { calendario: cal([{ date: '2027-06-01', open: '09:30', close: '16:00' }]) });
  assert.deepEqual([verano.abre_hora, verano.ya_abrio, verano.abierto], ['7:30', true, true]);
});

test('cotizaYahoo: precio contra cierre previo, con la fecha del precio; el que falla se omite', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('NQ%3DF')) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 7244.75, chartPreviousClose: 7195.75, regularMarketTime: Date.parse('2026-11-25T21:00:00Z') / 1000 } }] } }) };
  };
  const r = await cotizaYahoo([{ symbol: 'ES=F', nombre: 'S&P 500' }, { symbol: 'NQ=F', nombre: 'Nasdaq' }], { fetchImpl });
  assert.deepEqual(r, [{ symbol: 'ES=F', nombre: 'S&P 500', precio: 7244.75, pct: 0.68, fecha: '2026-11-25' }]);
});

test('fotos: la fecha de la barra se lee en hora de Nueva York', async () => {
  const f = await fotos(['NVDA'], { snapshots: async () => ({ NVDA: { price: 1, day_t: '2026-11-25T05:00:00Z' }, X: { price: 1, day_t: null } }) });
  assert.equal(f.NVDA.day_fecha, '2026-11-25');
  assert.equal(f.X.day_fecha, null);
});

// ── el endpoint ──────────────────────────────────────────────────────
test('autoriza: sin llaves configuradas no queda abierto; con llave mala, 401', () => {
  const req = (headers = {}, query = {}) => ({ headers, query });
  assert.equal(autoriza(req(), {}).status, 503);
  const env = { CRON_SECRET: 'cron-123', ARENA_ADMIN_KEY: 'admin-456' };
  assert.equal(autoriza(req(), env).status, 401);
  assert.equal(autoriza(req({ authorization: 'Bearer nope' }), env).status, 401);
  assert.equal(autoriza(req({ authorization: 'Bearer cron-123' }), env).via, 'CRON_SECRET');
  assert.equal(autoriza(req({ 'x-admin-key': 'admin-456' }), env).via, 'ARENA_ADMIN_KEY');
  assert.equal(autoriza(req({}, { key: 'admin-456' }), env).ok, true);
  assert.ok(!JSON.stringify(autoriza(req({ 'x-admin-key': 'x' }), env).body).includes('admin-456'));
});

// ── utilerías ────────────────────────────────────────────────────────
test('fechas y números como se dicen', () => {
  assert.equal(fechaLarga('2026-12-09'), 'miércoles 9 de diciembre');
  assert.equal(hora12('13:00'), '1:00 pm');
  assert.equal(hora12('7:30'), '7:30 am');
  assert.equal(hora12('12:05'), '12:05 pm');
  assert.equal(hora12('nada'), null);
  assert.equal(dinero(1500000), 'US$1.5 millones');
  assert.equal(dinero(2.3e9), 'US$2.3 mil millones');
  assert.equal(dinero(350000), 'US$350,000');
  assert.equal(escapaHtml('a<b>&'), 'a&lt;b&gt;&amp;');
  // 03:00 UTC ya es "mañana" en UTC, pero en Monterrey y Nueva York sigue siendo hoy.
  assert.equal(fechaMonterrey(new Date('2026-12-02T03:00:00Z')), '2026-12-01');
  assert.equal(fechaNuevaYork(new Date('2026-12-02T03:00:00Z')), '2026-12-01');
});
