// ═══════════════════════════════════════════════════════════════════
// tests/alertas-sql.test.mjs — el SQL de las alertas, contra un Postgres REAL.
//
// El candado de "nunca dos veces" ES una consulta: si el `on conflict` está
// mal escrito, la prueba con un candado de mentira pasa igual y en producción
// la alerta sale doble o no sale nunca. Acá corre la consulta de verdad, y de
// paso las lecturas de noticias, insiders, calendario y universo.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { puenteNeon } from './_neon-psql.mjs';
import { SCHEMA as SCHEMA_BASE } from '../api/_lib/db.js';
import { SCHEMA_NOTICIAS } from '../api/noticias.js';
import { SCHEMA_FORM4 } from '../api/stock-tracker.js';
import { SCHEMA_UNIVERSO_US } from '../api/mercado-r0.js';
import { enviaUnaVez } from '../api/alertas.js';
import { guardaConfig, leeConfig, resuelveChatId } from '../api/_lib/telegram.js';
import { resumenesDeInsider } from '../api/_lib/alertas.js';
import {
  noticiasRecientes, insidersRecientes, calendarioMacro, universoGrande,
} from '../api/_lib/alertas-fuentes.js';

test('el SQL de las alertas, contra Postgres', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55461 });
  for (const q of [...SCHEMA_BASE.filter((x) => /macro_events/.test(x)), ...SCHEMA_NOTICIAS, ...SCHEMA_FORM4, ...SCHEMA_UNIVERSO_US]) {
    try { psql(q + ';'); } catch { /* alters que dependen de tablas que acá no hacen falta */ }
  }
  const fetchReal = globalThis.fetch;
  const urlReal = process.env.DATABASE_URL;
  globalThis.fetch = puenteNeon(psql);
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.us-east-1.aws.neon.tech/db';
  t.after(() => { globalThis.fetch = fetchReal; if (urlReal === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = urlReal; });

  await t.test('el candado: una vez, y un fallo se puede reintentar UNA vez más', async () => {
    const mandados = [];
    const manda = async (x) => { mandados.push(x); };
    const a = await enviaUnaVez({ clave: 'cierre:2026-12-01', tipo: 'cierre', texto: 'primero' }, { manda });
    const b = await enviaUnaVez({ clave: 'cierre:2026-12-01', tipo: 'cierre', texto: 'segundo' }, { manda });
    assert.deepEqual([a.estado, b.estado], ['enviada', 'ya_enviada']);
    assert.deepEqual(mandados, ['primero']);
    assert.equal(psql(`select estado || ':' || intentos from alertas_enviadas where clave = 'cierre:2026-12-01';`).trim(), 'enviada:1');

    // Falla el envío: queda en `fallo`, y la siguiente corrida sí lo manda.
    let caido = true;
    const inestable = async (x) => { if (caido) throw new Error('Telegram caído'); mandados.push(x); };
    const c = await enviaUnaVez({ clave: 'mov:NVDA:2026-12-01:sube', tipo: 'movimiento', texto: 'nvda' }, { manda: inestable });
    assert.equal(c.estado, 'error');
    assert.equal(psql(`select estado from alertas_enviadas where clave = 'mov:NVDA:2026-12-01:sube';`).trim(), 'fallo');
    caido = false;
    const d = await enviaUnaVez({ clave: 'mov:NVDA:2026-12-01:sube', tipo: 'movimiento', texto: 'nvda' }, { manda: inestable });
    const e = await enviaUnaVez({ clave: 'mov:NVDA:2026-12-01:sube', tipo: 'movimiento', texto: 'nvda' }, { manda: inestable });
    assert.deepEqual([d.estado, e.estado], ['enviada', 'ya_enviada']);
    assert.equal(psql(`select estado || ':' || intentos from alertas_enviadas where clave = 'mov:NVDA:2026-12-01:sube';`).trim(), 'enviada:2');
    assert.equal(mandados.filter((x) => x === 'nvda').length, 1);

    // Una fila que se quedó `apartada` (la función murió a medio envío) no se reintenta.
    psql(`insert into alertas_enviadas (clave, tipo) values ('8k:colgada', 'aviso_sec');`);
    const f = await enviaUnaVez({ clave: '8k:colgada', tipo: 'aviso_sec', texto: 'x' }, { manda });
    assert.equal(f.estado, 'ya_enviada');
  });

  await t.test('el chat_id guardado se lee de vuelta', async () => {
    assert.equal(await leeConfig('TELEGRAM_CHAT_ID'), null);
    await guardaConfig('TELEGRAM_CHAT_ID', '111');
    await guardaConfig('TELEGRAM_CHAT_ID', '222');
    assert.deepEqual(await resuelveChatId({ env: {} }), { chatId: '222', fuente: 'neon:alertas_config' });
  });

  await t.test('noticias: por ticker etiquetado o por nombre en el titular, sólo las recientes', async () => {
    psql(`insert into mercado_noticias (url, titular, titulo_norm, fuente_id, fuente_nombre, publicado_en, tickers) values
      ('https://a.test/1', 'Chips rally lifts the market', 'chips rally lifts the market', 'r', 'Reuters', now() - interval '2 hours', '{NVDA,AMD}'),
      ('https://a.test/2', 'El cohete de SpaceX despega con éxito', 'el cohete de spacex despega con exito', 'e', 'El Financiero', now() - interval '3 hours', '{}'),
      ('https://a.test/3', 'Antes de la Fed, cautela', 'antes de la fed cautela', 'e', 'El Financiero', now() - interval '1 hours', '{}'),
      ('https://a.test/4', 'Nvidia: nota de la semana pasada', 'nvidia nota vieja', 'r', 'Reuters', now() - interval '90 hours', '{NVDA}'),
      ('https://a.test/5', 'Apple presenta un teléfono', 'apple presenta un telefono', 'r', 'Reuters', now() - interval '1 hours', '{AAPL}');`);
    const n = await noticiasRecientes();
    assert.deepEqual(n.map((x) => [x.symbol, x.url]), [['SPCX', 'https://a.test/2'], ['NVDA', 'https://a.test/1']]);
    assert.deepEqual(n[1].tickers, ['NVDA', 'AMD']);
    assert.equal(n[0].fuente_nombre, 'El Financiero');
  });

  await t.test('insiders: los Form 4 recientes de mis acciones', async () => {
    const fila = (o) => JSON.stringify([{ ticker: 'NVDA', tipo: 'venta', derivada: false, acciones: 1000, valor: 150000, fecha: '2026-11-24', quien: "Mark O'Brien", cargo: 'CFO', plan_estado: 'programada', ...o }]);
    psql(`insert into mercado_form4_tx (accession, filing_fecha, filas) values
      ('0001-26-000001', current_date - 1, '${fila({ accession: '0001-26-000001' }).replace(/'/g, "''")}'),
      ('0001-26-000002', current_date - 1, '${fila({ ticker: 'AAPL' }).replace(/'/g, "''")}'),
      ('0001-26-000003', current_date - 40, '${fila({}).replace(/'/g, "''")}'),
      ('0001-26-000004', current_date, '${fila({ ticker: 'smmt', tipo: 'compra' }).replace(/'/g, "''")}');`);
    const filas = await insidersRecientes(['SPCX', 'NVDA', 'SMMT', 'ANT'], 5);
    assert.deepEqual(filas.map((f) => f.accession), ['0001-26-000001', '0001-26-000004']);
    const r = resumenesDeInsider(filas);
    assert.deepEqual(r.map((x) => [x.symbol, x.tipo, x.quien]), [['NVDA', 'venta', "Mark O'Brien"], ['SMMT', 'compra', "Mark O'Brien"]]);
  });

  await t.test('calendario: lo curado se suma a las fechas oficiales', async () => {
    psql(`insert into macro_events (id, event_date, title, category, importance) values
      ('me_1', '2026-12-09', 'FOMC: decisión de tasas', 'fed', 'high'),
      ('me_2', '2026-12-09', 'Subasta de bonos a 10 años', 'subasta', 'med');`);
    const ev = await calendarioMacro('2026-12-09', '2026-12-10');
    assert.deepEqual(ev.map((e) => `${e.event_date} ${e.category}`).sort(),
      ['2026-12-09 fed', '2026-12-09 subasta', '2026-12-10 inflacion']);
    assert.equal(ev.find((e) => e.category === 'fed').title, 'FOMC: decisión de tasas', 'lo curado gana');
  });

  await t.test('universo: sólo las empresas grandes', async () => {
    psql(`insert into mercado_universo_us (symbol, nombre, sector_etf, market_cap) values
      ('NVDA', 'NVIDIA Corp', 'XLK', 3600000000000), ('KO', 'Coca-Cola Co', 'XLP', 300000000000),
      ('TINY', 'Movida del día', 'XLV', 250000000), ('NULA', 'Sin cap', 'XLK', null);`);
    assert.deepEqual((await universoGrande()).map((u) => u.symbol), ['NVDA', 'KO']);
  });
});
