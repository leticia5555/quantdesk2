// ═══════════════════════════════════════════════════════════════════
// tests/mercado-precios.test.mjs — la serie fechada, que es la pieza que
// YTD necesitaba y ninguna fuente existente daba.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aplanarChartYahoo, serieDesdeFilas, planPreciosUs, cubreYtd,
  MIN_PUNTOS_SERIE, RANGO_SIEMBRA, SCHEMA_PRECIOS_US,
} from '../api/_lib/mercado-precios.js';

const T = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

const chart = (ts, closes, adj, vol) => ({
  chart: {
    result: [{
      timestamp: ts,
      indicators: {
        quote: [{ close: closes, ...(vol ? { volume: vol } : {}) }],
        ...(adj ? { adjclose: [{ adjclose: adj }] } : {}),
      },
    }],
  },
});

/** Dos días con cierre, y el volumen que se le pase (o ninguno). */
const chartVol = ({ volume } = {}) =>
  chart([T('2026-09-17'), T('2026-09-18')], [10, 11], null, volume);

test('aplana el chart de Yahoo a filas FECHADAS, con cierre y ajustado', () => {
  const r = aplanarChartYahoo(chart(
    [T('2026-09-16'), T('2026-09-17'), T('2026-09-18')],
    [10, 11, 12], [9.5, 10.4, 11.3]));
  assert.equal(r.filas.length, 3);
  assert.deepEqual(r.filas.map((f) => f.fecha), ['2026-09-16', '2026-09-17', '2026-09-18']);
  assert.equal(r.filas[0].cierre, 10);
  assert.equal(r.filas[0].cierre_ajustado, 9.5);
  assert.equal(r.descartadas, 0);
  assert.equal(r.sin_adjclose, false);
  assert.equal(r.ultima_fecha, '2026-09-18');
});

test('una fila sin cierre se descarta y se CUENTA: "no llegó" ≠ "llegó mal"', () => {
  const r = aplanarChartYahoo(chart(
    [T('2026-09-16'), T('2026-09-17'), T('2026-09-18')],
    [10, null, 0], [9.5, null, null]));
  assert.equal(r.filas.length, 1);
  assert.equal(r.descartadas, 2);
});

test('sin adjclose la serie es de PRECIO, no de retorno — y lo declara', () => {
  const r = aplanarChartYahoo(chart([T('2026-09-16')], [10]));
  assert.equal(r.sin_adjclose, true);
  assert.equal(r.filas[0].cierre_ajustado, null);
});

test('una respuesta sin resultado trae su motivo, no una lista vacía muda', () => {
  assert.match(aplanarChartYahoo({}).motivo, /sin chart\.result/);
  assert.match(aplanarChartYahoo({ chart: { error: { code: 'Not Found' } } }).motivo, /Not Found/);
  assert.match(aplanarChartYahoo(chart([T('2026-09-16')], [null])).motivo, /ningún cierre utilizable/);
});

test('la serie para el % usa el AJUSTADO, y reporta lo que no lo tenía', () => {
  const filas = [
    { fecha: '2026-09-16', t: T('2026-09-16'), cierre: 10, cierre_ajustado: 9.5 },
    { fecha: '2026-09-17', t: T('2026-09-17'), cierre: 11, cierre_ajustado: null },
  ];
  const s = serieDesdeFilas(filas);
  assert.deepEqual(s.serie.map((p) => p.c), [9.5, 11]);
  assert.equal(s.puntos_sin_ajuste, 1, 'una serie medio ajustada y medio no es un % inventado');
  // Y se puede pedir el precio de pantalla a propósito.
  assert.deepEqual(serieDesdeFilas(filas, { base: 'cierre' }).serie.map((p) => p.c), [10, 11]);
});

test('la serie sale en orden cronológico aunque las filas lleguen al revés', () => {
  const s = serieDesdeFilas([
    { fecha: '2026-09-18', t: T('2026-09-18'), cierre: 12 },
    { fecha: '2026-09-16', t: T('2026-09-16'), cierre: 10 },
  ]);
  assert.deepEqual(s.serie.map((p) => p.c), [10, 12]);
});

test('sin `t`, la fecha basta: el timestamp se deriva', () => {
  const s = serieDesdeFilas([{ fecha: '2026-09-16', cierre: 10 }]);
  assert.equal(s.serie[0].t, T('2026-09-16'));
});

test('plan: sin serie se siembra entera; con serie corta también', () => {
  const p = planPreciosUs({
    simbolos: ['AAPL', 'MSFT', 'NVDA'],
    yaTengo: new Map([['MSFT', '2026-09-18'], ['NVDA', '2026-09-18']]),
    cuenta: new Map([['MSFT', 250], ['NVDA', 5]]),
    conVolumen: new Map([['MSFT', '2026-09-18'], ['NVDA', '2026-09-18']]),
    hasta: '2026-09-18',
  });
  assert.deepEqual(p.siembra.map((x) => x.symbol), ['AAPL', 'NVDA']);
  assert.match(p.siembra[0].motivo, /sin serie/);
  assert.match(p.siembra[1].motivo, /serie corta \(5 puntos\)/);
  assert.equal(p.al_dia, 1);
  assert.deepEqual(p.cola, []);
});

test('plan: con serie completa y atrasada, cola corta desde su última fecha', () => {
  const p = planPreciosUs({
    simbolos: ['AAPL'],
    yaTengo: new Map([['AAPL', '2026-09-15']]),
    cuenta: new Map([['AAPL', 250]]),
    hasta: '2026-09-18',
  });
  assert.deepEqual(p.cola, [{ symbol: 'AAPL', desde: '2026-09-15', hasta: '2026-09-18' }]);
  assert.equal(p.siembra.length, 0);
});

test('plan: correrlo dos veces el mismo día no pide nada la segunda', () => {
  const args = {
    simbolos: ['AAPL'], yaTengo: new Map([['AAPL', '2026-09-18']]),
    cuenta: new Map([['AAPL', 250]]),
    conVolumen: new Map([['AAPL', '2026-09-18']]),
    hasta: '2026-09-18',
  };
  assert.equal(planPreciosUs(args).cola.length, 0);
  assert.equal(planPreciosUs(args).al_dia, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// EL VOLUMEN, PARA "MÁS OPERADAS"
//
// La columna nació después que la tabla: un símbolo con un año de cierres no
// tiene ni un día de volumen y, por el criterio de "al día", nunca se volvería
// a pedir — se quedaría fuera de la tabla para siempre. El relleno no cuesta
// una petición nueva: el mismo `range=1mo` de la cola ya trae el volumen.
// ═══════════════════════════════════════════════════════════════════════
test('plan: al día en cierres pero SIN volumen entra a la cola igual', () => {
  const p = planPreciosUs({
    simbolos: ['AAPL'],
    yaTengo: new Map([['AAPL', '2026-09-18']]),
    cuenta: new Map([['AAPL', 250]]),
    conVolumen: new Map(),                      // la columna recién nace
    hasta: '2026-09-18',
  });
  assert.equal(p.al_dia, 0);
  assert.equal(p.cola.length, 1);
  assert.equal(p.cola[0].symbol, 'AAPL');
  assert.match(p.cola[0].motivo, /sin volumen/);
});

test('plan: con el volumen a medio llenar, se pide desde donde se quedó', () => {
  const p = planPreciosUs({
    simbolos: ['AAPL'],
    yaTengo: new Map([['AAPL', '2026-09-18']]),
    cuenta: new Map([['AAPL', 250]]),
    conVolumen: new Map([['AAPL', '2026-07-01']]),   // más de 30 días atrás
    hasta: '2026-09-18',
  });
  assert.equal(p.cola.length, 1);
  assert.equal(p.cola[0].desde, '2026-07-01');
  assert.match(p.cola[0].motivo, /volumen sólo hasta 2026-07-01/);
});

test('plan: con la ventana de volumen cubierta, se apaga solo', () => {
  // El relleno NO es permanente: en cuanto los últimos 30 días tienen volumen,
  // el símbolo vuelve a "al día" y deja de pedir. Si no, cada corrida pediría
  // los 300 nombres completos para siempre.
  const p = planPreciosUs({
    simbolos: ['AAPL'],
    yaTengo: new Map([['AAPL', '2026-09-18']]),
    cuenta: new Map([['AAPL', 250]]),
    conVolumen: new Map([['AAPL', '2026-09-18']]),
    hasta: '2026-09-18',
  });
  assert.equal(p.cola.length, 0);
  assert.equal(p.al_dia, 1);

  // Y un hueco DENTRO de la ventana que ya se cerró tampoco la reabre: lo que
  // manda es hasta dónde llega el volumen, no cuántos días traiga.
  const casi = planPreciosUs({
    simbolos: ['AAPL'],
    yaTengo: new Map([['AAPL', '2026-09-18']]),
    cuenta: new Map([['AAPL', 250]]),
    conVolumen: new Map([['AAPL', '2026-09-17']]),
    hasta: '2026-09-18',
  });
  assert.equal(casi.cola.length, 0, 'un día de rezago no vuelve a pedir un mes');
});

test('el volumen viaja en las filas, y su ausencia NO descarta el cierre', () => {
  const con = aplanarChartYahoo(chartVol({ volume: [1_000_000, 2_500_000] }));
  assert.deepEqual(con.filas.map((f) => f.volumen), [1_000_000, 2_500_000]);
  assert.equal(con.sin_volumen, false);

  // Yahoo sin `volume`: los cierres siguen sirviendo, que es para lo que nació
  // la tabla. La causa viaja para que el cuadro pueda decirla.
  const sin = aplanarChartYahoo(chartVol());
  assert.equal(sin.filas.length, 2);
  assert.deepEqual(sin.filas.map((f) => f.volumen), [null, null]);
  assert.equal(sin.sin_volumen, true);

  // Un 0 es un DATO (día sin operaciones), no un hueco.
  const cero = aplanarChartYahoo(chartVol({ volume: [0, 5] }));
  assert.deepEqual(cero.filas.map((f) => f.volumen), [0, 5]);
});

test('cubreYtd: dice SÍ con la fecha del ancla, y NO con el porqué', () => {
  const buena = [{ t: T('2025-12-31'), c: 100 }, { t: T('2026-02-01'), c: 110 }];
  const r = cubreYtd(buena, new Date('2026-03-01T12:00:00Z'));
  assert.equal(r.cubre, true);
  assert.equal(r.ancla_fecha, '2025-12-31');

  const corta = [{ t: T('2026-02-01'), c: 100 }, { t: T('2026-02-02'), c: 110 }];
  const m = cubreYtd(corta, new Date('2026-03-01T12:00:00Z'));
  assert.equal(m.cubre, false);
  assert.match(m.motivo, /empieza en 2026-02-01/);
});

test('las constantes dicen lo que el mapa necesita', () => {
  assert.equal(RANGO_SIEMBRA, '1y', 'YTD necesita el cierre del 31-dic anterior');
  assert.ok(MIN_PUNTOS_SERIE >= 30);
  assert.ok(SCHEMA_PRECIOS_US.some((q) => /primary key \(symbol, fecha\)/.test(q)),
    'la llave (symbol, fecha) es lo que hace la cosecha idempotente');
});

// ───── la barra del día en curso no es un cierre ─────

import { esCierreDefinitivo, soloCierresDefinitivos, horaEnZona, CIERRE_ET_H } from '../api/_lib/mercado-precios.js';

test('la barra de HOY antes del cierre no se guarda: es el precio vivo', () => {
  const medioDia = new Date('2026-09-21T15:00:00Z');   // 11:00 ET, mercado abierto
  assert.equal(esCierreDefinitivo('2026-09-21', medioDia), false);
  assert.equal(esCierreDefinitivo('2026-09-18', medioDia), true);
  assert.equal(esCierreDefinitivo('2026-09-21', new Date('2026-09-21T21:30:00Z')), true);
  assert.equal(CIERRE_ET_H, 16);
});

test('el cierre se mide en la hora DEL ESTE, no en un UTC fijo', () => {
  // EL BUG: con el tope fijo en 21 UTC, en septiembre (EDT) el mercado cerraba
  // a las 20:00 UTC y la barra seguía marcada como provisional una hora más.
  const sept = new Date('2026-09-21T20:30:00Z');       // 16:30 ET — cerrado
  assert.equal(horaEnZona(sept).hora, 16.5);
  assert.equal(esCierreDefinitivo('2026-09-21', sept), true, 'a las 16:30 del Este la barra ya es un cierre');

  // Y en enero (EST) las 20:30 UTC son las 15:30 ET: todavía abierto.
  const enero = new Date('2027-01-19T20:30:00Z');
  assert.equal(horaEnZona(enero).hora, 15.5);
  assert.equal(esCierreDefinitivo('2027-01-19', enero), false, 'a las 15:30 del Este todavía es precio vivo');
  assert.equal(esCierreDefinitivo('2027-01-19', new Date('2027-01-19T21:15:00Z')), true);
});

test('el día se toma del calendario del MERCADO, no del UTC', () => {
  // 00:30 UTC del martes son las 20:30 del lunes en Nueva York: la barra del
  // lunes ya cerró, y la del martes todavía no existe.
  const t = new Date('2026-09-22T00:30:00Z');
  assert.equal(horaEnZona(t).fecha, '2026-09-21');
  assert.equal(esCierreDefinitivo('2026-09-21', t), true);
  assert.equal(esCierreDefinitivo('2026-09-22', t), false);
});

test('una barra con fecha futura no se guarda nunca', () => {
  assert.equal(esCierreDefinitivo('2026-09-22', new Date('2026-09-21T23:00:00Z')), false);
});

test('el filtro reporta cuántas barras quitó, no las tira en silencio', () => {
  const filas = [{ fecha: '2026-09-18' }, { fecha: '2026-09-21' }];
  const r = soloCierresDefinitivos(filas, new Date('2026-09-21T15:00:00Z'));
  assert.equal(r.filas.length, 1);
  assert.equal(r.provisionales, 1);
  assert.deepEqual(r.fechas_provisionales, ['2026-09-21']);
});
