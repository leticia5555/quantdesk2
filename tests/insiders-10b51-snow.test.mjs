// ═══════════════════════════════════════════════════════════════════════
// EL 10b5-1, CONTRA EL FORM 4 REAL DE SLOOTMAN
//
// `tests/fixtures/sec/snow-0001402348-26-000020-form4.xml` es el documento
// que sirve EDGAR, bajado tal cual, no uno que yo haya redactado. Lo pidió
// así Lety y es la condición correcta: un Form 4 escrito a mano no puede
// contradecirme — y en este repo los fixtures de mi mano ya costaron el
// `lineas: 0` del índice, el `&quot;` de la limpieza y las seis consultas
// del diagnóstico.
//
// El caso: Slootman ejerció 300.000 opciones a $8.88 y vendió las mismas
// 300.000 el 2026-10-19 entre $310,705 y $320,270. $94,93 M. Bajo un plan
// 10b5-1 adoptado trece meses antes.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  form4Completo, filasDeForm4, planDeForm4, tenenciaFinal, ejercicioYVenta,
  fechaDeAdopcion, PLAN_10B5, topDeLaSemana,
} from '../api/_lib/form4.js';

const XML = readFileSync(new URL('./fixtures/sec/snow-0001402348-26-000020-form4.xml', import.meta.url), 'utf8');
const DOC = form4Completo(XML);
const FILAS = filasDeForm4(DOC, { accession: '0001402348-26-000020', updated: '2026-10-21T20:00:00Z' });

test('el fixture es el filing de verdad, no una maqueta', () => {
  assert.equal(DOC.emisora.ticker, 'SNOW');
  assert.equal(DOC.duenos[0].nombre, 'Slootman Frank');
  assert.equal(DOC.duenos[0].es_director, true);
  assert.equal(DOC.duenos[0].es_oficial, false);
  // DOCE transacciones: M×2 y S×10. El resumen que circuló decía una sola M.
  assert.equal(DOC.transacciones.length, 12);
  const cods = DOC.transacciones.map((t) => t.codigo).join('');
  assert.equal((cods.match(/M/g) || []).length, 2);
  assert.equal((cods.match(/S/g) || []).length, 10);
});

// ── 1. LA FUENTE DEL DATO, EN ORDEN ───────────────────────────────────
test('la casilla del encabezado manda, y la nota da la fecha de adopción', () => {
  const p = planDeForm4(XML);
  assert.equal(p.estado, PLAN_10B5.PROGRAMADA);
  assert.equal(p.fuente, 'casilla del encabezado');
  assert.equal(p.adoptado_en, '2025-09-19');
  assert.match(p.nota, /^The sales reported in this Form 4 were effected pursuant to a 10b5-1/);
});

test('sin casilla NI nota es `sin_dato`, nunca "no programada"', () => {
  // Un Form 4 anterior a abril de 2023 no tiene dónde declararlo: "no viene
  // marcada" no es "no fue programada". Es la regla que pidió Lety.
  const viejo = XML.replace(/<aff10b5One>[\s\S]*?<\/aff10b5One>/i, '')
    .replace(/<footnotes>[\s\S]*?<\/footnotes>/i, '');
  const p = planDeForm4(viejo);
  assert.equal(p.estado, PLAN_10B5.SIN_DATO);
  assert.match(p.motivo, /abril de 2023/);
});

test('casilla sin marcar pero nota que la menciona → programada igual', () => {
  // Entre un dato que AFIRMA y uno que CALLA, manda el que afirma: la casilla
  // vacía puede ser un descuido de quien llenó el formulario.
  const p = planDeForm4(XML.replace(/<aff10b5One>1<\/aff10b5One>/i, '<aff10b5One>0</aff10b5One>'));
  assert.equal(p.estado, PLAN_10B5.PROGRAMADA);
  assert.match(p.fuente, /nota al pie/);
  assert.equal(p.adoptado_en, '2025-09-19');
});

test('casilla sin marcar y sin nota → ahí sí, no programada', () => {
  // El formulario tenía dónde declararlo y no lo declaró. Eso no es descarte.
  const p = planDeForm4(XML.replace(/<aff10b5One>1<\/aff10b5One>/i, '<aff10b5One>0</aff10b5One>')
    .replace(/<footnotes>[\s\S]*?<\/footnotes>/i, ''));
  assert.equal(p.estado, PLAN_10B5.NO);
});

test('la fecha de adopción se lee en los dos formatos que usa EDGAR', () => {
  assert.equal(fechaDeAdopcion('adopted by the Reporting Person on September 19, 2025'), '2025-09-19');
  assert.equal(fechaDeAdopcion('plan adopted on 9/19/2025'), '2025-09-19');
  assert.equal(fechaDeAdopcion('una nota sin fecha'), null);
});

// ── 2. EJERCIÓ Y VENDIÓ EL MISMO DÍA ──────────────────────────────────
test('M + S por la misma cantidad el mismo día se dice, y se compara por SUMA', () => {
  // Ninguna pareja de líneas coincide: ejerció en 2 y vendió en 10. Los
  // totales sí. Una comparación línea a línea no lo habría visto.
  const c = ejercicioYVenta(DOC.transacciones);
  assert.deepEqual(c, { hubo: true, fecha: '2026-10-19', acciones: 300000 });
  assert.equal(FILAS.find((f) => f.codigo === 'S').ejercio_y_vendio, true);
  assert.equal(FILAS.find((f) => f.codigo === 'M' && !f.derivada).ejercio_y_vendio, true);
});

// ── 3. "VENDIÓ TODO" ──────────────────────────────────────────────────
test('NO vendió todo: le quedan acciones Y opciones', () => {
  const t = tenenciaFinal(DOC.transacciones);
  assert.equal(t.acciones, 19024);
  assert.equal(t.derivados, 3836655, 'las opciones que le quedan, del propio filing');
  assert.equal(t.salio_del_todo, false);
  assert.ok(FILAS.every((f) => f.salio_del_todo === false));
});

test('ni siquiera con las acciones en cero, si le quedan derivados', () => {
  // Vender todas las acciones y quedarse con millones en opciones no es
  // salirse. Es la mitad de la regla que Lety pidió explícitamente.
  const t = tenenciaFinal(DOC.transacciones.map((x) => (x.derivada ? x : { ...x, le_quedan: 0 })));
  assert.equal(t.acciones, 0);
  assert.ok(t.derivados > 0);
  assert.equal(t.salio_del_todo, false);
});

test('y con una tenencia sin declarar NO se afirma nada', () => {
  const t = tenenciaFinal(DOC.transacciones.map((x) => ({ ...x, le_quedan: null })));
  assert.equal(t.salio_del_todo, false);
  assert.match(t.motivo, /no declararon/);
});

// ── 4. EL ORDEN ───────────────────────────────────────────────────────
test('la venta de Slootman no encabeza la semana: estaba programada', () => {
  const otra = FILAS.map((f) => ({
    ...f, ticker: 'OTRA', valor: 1_000_000, tipo: 'venta', codigo: 'S',
    plan_estado: PLAN_10B5.NO, salio_del_todo: false,
  }));
  const t = topDeLaSemana([...FILAS, ...otra]);
  assert.equal(t.grupos[0].ticker, 'OTRA',
    '$94,93 M programados pesan menos que $1 M que alguien decidió hoy');
  const snow = t.grupos.find((g) => g.ticker === 'SNOW');
  // No se esconde: sigue con su número y con la cuenta de programadas.
  assert.ok(snow.programadas > 0);
  assert.equal(snow.no_programadas, 0);
  assert.ok(Math.abs(snow.neto_usd) > 94_000_000, String(snow.neto_usd));
});

// ═══════════════════════════════════════════════════════════════════════
// LAS FILAS QUE YA ESTABAN GUARDADAS
//
// Lo vi al sacar la captura de producción, no antes: `mercado_form4_tx.filas`
// es JSONB con la forma del día en que se parseó. Las 400 filas de producción
// traían `plan_10b5` (121 en true) pero ninguno de los campos nuevos, y la
// pantalla —que ya sólo miraba los nuevos— dejó de mostrar hasta el `10b5-1`
// que mostraba antes. Una mejora que en producción QUITÓ información.
// ═══════════════════════════════════════════════════════════════════════
import { completaFilasViejas } from '../api/_lib/form4.js';

// La forma EXACTA que sirve producción hoy: sin plan_estado, sin
// ejercio_y_vendio, y con el `salio_del_todo` viejo (por línea).
const VIEJAS = [
  { accession: 'A', codigo: 'M', fecha: '2026-10-19', acciones: 300000, derivada: false, le_quedan: 319024, plan_10b5: true, salio_del_todo: false, tipo: 'opcion' },
  { accession: 'A', codigo: 'S', fecha: '2026-10-19', acciones: 300000, derivada: false, le_quedan: 0, plan_10b5: true, salio_del_todo: true, tipo: 'venta', quien: 'X' },
  { accession: 'A', codigo: 'M', fecha: '2026-10-19', acciones: 300000, derivada: true, le_quedan: 3836655, plan_10b5: true, salio_del_todo: false, tipo: 'opcion' },
  { accession: 'B', codigo: 'S', fecha: '2026-10-20', acciones: 10, derivada: false, le_quedan: 5, plan_10b5: false, salio_del_todo: false, tipo: 'venta' },
];

test('una fila vieja con la casilla marcada se resuelve como programada', () => {
  const r = completaFilasViejas(VIEJAS);
  assert.ok(r.filter((f) => f.accession === 'A').every((f) => f.plan_estado === 'programada'));
  // Sin fecha: vive en la nota al pie, que no se guardó. No se inventa.
  assert.ok(r.every((f) => f.plan_adoptado_en === null));
});

test('y un `plan_10b5: false` viejo es `sin_dato`, NUNCA "no programada"', () => {
  // Ese booleano valía false tanto con la casilla vacía como cuando el
  // formulario no la tenía. Mirando sólo la fila son indistinguibles.
  const b = completaFilasViejas(VIEJAS).find((f) => f.accession === 'B');
  assert.equal(b.plan_estado, 'sin_dato');
});

test('el "vendió todo" viejo, que era por línea, se recalcula por documento', () => {
  // La fila S traía `salio_del_todo: true` porque esa TENENCIA quedó en cero.
  // Con las tres del filing a la vista, quedan 3.836.655 derivados.
  const s = completaFilasViejas(VIEJAS).find((f) => f.accession === 'A' && f.codigo === 'S');
  assert.equal(s.salio_del_todo, false, 'le quedan derivados: no se salió');
  assert.equal(s.le_quedan_derivados, 3836655);
});

test('y "ejerció y vendió" se deriva de las filas guardadas, sin re-leer EDGAR', () => {
  const r = completaFilasViejas(VIEJAS);
  assert.equal(r.find((f) => f.codigo === 'S' && f.accession === 'A').ejercio_y_vendio, true);
  assert.equal(r.find((f) => f.accession === 'B').ejercio_y_vendio, false);
});

test('una fila NUEVA no se toca: lo que ya trae manda', () => {
  const nueva = { accession: 'C', codigo: 'S', plan_estado: 'no_programada', plan_adoptado_en: null,
    ejercio_y_vendio: false, derivada: false, le_quedan: 100, fecha: '2026-10-21' };
  const r = completaFilasViejas([nueva])[0];
  assert.equal(r.plan_estado, 'no_programada', 'no se degrada a sin_dato');
  assert.equal(r.ejercio_y_vendio, false);
});
