// ═══════════════════════════════════════════════════════════════════════
// EL ÍNDICE DIARIO DE EDGAR — la lista completa, no la ventana
//
// Lety, 2026-10-22: *"Insiders completos, no solo la ventana de
// `getcurrent`."* El feed de lo recién presentado son los últimos ~200
// filings de TODOS los formularios: en un día de temporada de reportes se
// presentan más de mil Form 4, así que esa ventana cubre menos de una hora.
//
// El índice diario sí es la lista completa del día, y con ella hay
// DENOMINADOR. Sin denominador, "cobertura" es una palabra.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimestreDe, urlIndiceDiario, diasHabiles, accessionDeArchivo,
  parseIndiceEdgar, form4DelIndice, coberturaDeDia,
} from '../api/_lib/edgar-indice.js';

// ── LA RUTA ──────────────────────────────────────────────────────────
test('la URL del índice lleva el trimestre, que es parte de la ruta', () => {
  assert.equal(urlIndiceDiario('2026-10-21'),
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261021.idx');
  assert.equal(urlIndiceDiario('2026-01-02'),
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR1/form.20260102.idx');
  // El `master.idx` del trimestre sirve para el relleno inicial.
  assert.match(urlIndiceDiario('2026-07-01', { tipo: 'master' }), /master\.20260701\.idx$/);
});

test('los límites del trimestre no se corren por un mes', () => {
  assert.equal(trimestreDe('2026-03-31'), 1);
  assert.equal(trimestreDe('2026-04-01'), 2);
  assert.equal(trimestreDe('2026-09-30'), 3);
  assert.equal(trimestreDe('2026-10-01'), 4);
  assert.equal(trimestreDe('no-es-fecha'), null);
});

// ── LOS DÍAS ─────────────────────────────────────────────────────────
test('los días hábiles saltan el fin de semana, del más nuevo al más viejo', () => {
  // 2026-10-21 es miércoles.
  assert.deepEqual(diasHabiles('2026-10-21', 5),
    ['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-16', '2026-10-15']);
});

test('los FERIADOS no se modelan, y es deliberado', () => {
  // EDGAR no publica índice los días que no abre, así que el 404 ES la
  // respuesta. Un calendario de feriados escrito a mano se pudre solo — ya
  // costó un chip mintiendo tres días — y acá no hace falta.
  const dias = diasHabiles('2026-12-25', 3);   // 25-dic es viernes y feriado
  assert.ok(dias.includes('2026-12-25'), 'se pide igual: la ausencia del archivo contesta');
});

// ── EL PARSER ────────────────────────────────────────────────────────
const FORM_IDX = `Description:           Daily Index of EDGAR Dissemination Feed
Last Data Received:    October 21, 2026
Comments:              webmaster@sec.gov

Form Type   Company Name                                   CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------
4           Aadi Bioscience, Inc.                          1422142     2026-10-21  edgar/data/1422142/0001209191-26-012345.txt
4           A  DOUBLE  SPACE CORP                          99          2026-10-21  edgar/data/99/0000000099-26-000001.txt
4/A         ENMIENDA CORP                                  1234        2026-10-21  edgar/data/1234/0000001234-26-000002.txt
8-K         OTRA COSA INC                                  5678        2026-10-21  edgar/data/5678/0000005678-26-000003.txt
40-APP      FONDO RARO                                     9999        2026-10-21  edgar/data/9999/0000009999-26-000004.txt`;

const MASTER_IDX = `CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
1422142|Aadi Bioscience, Inc.|4|2026-10-21|edgar/data/1422142/0001209191-26-012345.txt
5678|OTRA COSA INC|8-K|2026-10-21|edgar/data/5678/0000005678-26-000003.txt`;

test('parsea el índice de columnas, con la cabecera y los separadores fuera', () => {
  const r = parseIndiceEdgar(FORM_IDX);
  assert.equal(r.filas.length, 5);
  assert.equal(r.descartadas, 0);
  assert.equal(r.filas[0].form, '4');
  assert.equal(r.filas[0].cik, '1422142');
  assert.equal(r.filas[0].accession, '0001209191-26-012345');
  assert.equal(r.filas[0].empresa, 'Aadi Bioscience, Inc.');
});

test('y el nombre con DOS espacios seguidos no lo rompe', () => {
  // Partir por `\\s{2,}` parece razonable y se cae con esto, que existe.
  // Por eso se lee desde la derecha, donde los tres últimos campos tienen
  // forma inconfundible.
  const fila = parseIndiceEdgar(FORM_IDX).filas.find((f) => f.cik === '99');
  assert.equal(fila.empresa, 'A  DOUBLE  SPACE CORP');
  assert.equal(fila.form, '4');
});

test('parsea también el de barras (master.idx), que es otra forma del mismo día', () => {
  const r = parseIndiceEdgar(MASTER_IDX);
  assert.equal(r.filas.length, 2);
  assert.equal(r.filas[0].form, '4');
  assert.equal(r.filas[0].accession, '0001209191-26-012345');
  assert.equal(r.filas[0].empresa, 'Aadi Bioscience, Inc.');
});

test('un 40-APP no es un Form 4, por más que empiece con 4', () => {
  // `startsWith('4')` habría metido 40-APP, 40-17G y compañía en el
  // denominador, y la cobertura no habría cerrado nunca.
  const f4 = form4DelIndice(parseIndiceEdgar(FORM_IDX).filas);
  assert.equal(f4.total, 2);
  assert.ok(f4.filas.every((f) => f.form === '4'));
});

test('las enmiendas (4/A) quedan fuera de los dos lados del quebrado, y se cuentan', () => {
  // Una 4/A corrige un Form 4 anterior. En el denominador haría que la
  // cobertura pidiera guardar dos veces el mismo hecho; sólo en el
  // denominador, no cerraría nunca.
  const f4 = form4DelIndice(parseIndiceEdgar(FORM_IDX).filas);
  assert.equal(f4.enmiendas, 1);
  assert.ok(!f4.filas.some((f) => f.form === '4/A'));
});

test('el accession sale de la ruta del documento', () => {
  assert.equal(accessionDeArchivo('edgar/data/320193/0000320193-26-000070.txt'), '0000320193-26-000070');
  assert.equal(accessionDeArchivo('no-tiene'), null);
});

// ── LA COBERTURA ─────────────────────────────────────────────────────
//
// La prueba que pidió Lety: para un día cerrado, lo que guardamos tiene que
// ser igual a las líneas de Form 4 del índice de ese día.
test('un día cerrado con todo guardado dice 100% CON los dos números', () => {
  const idx = parseIndiceEdgar(FORM_IDX);
  const f4 = form4DelIndice(idx.filas);
  // Se guardaron los dos Form 4 del índice.
  const c = coberturaDeDia({ fecha: '2026-10-21', enIndice: f4.total, guardados: 2 });
  assert.equal(c.completa, true);
  assert.equal(c.pct, 100);
  assert.equal(c.texto, 'Cobertura: 100% de los Form 4 del día (2 de 2)');
});

test('si falta uno, lo dice con el número que falta', () => {
  const c = coberturaDeDia({ fecha: '2026-10-21', enIndice: 1842, guardados: 1700 });
  assert.equal(c.completa, false);
  assert.match(c.texto, /92\.3%/);
  assert.match(c.texto, /\(1700 de 1842\)/);
  assert.match(c.texto, /faltan 142/);
});

test('un porcentaje sin los dos números no se puede auditar, así que nunca va solo', () => {
  // "100%" de un denominador equivocado también dice 100%.
  for (const [n, d] of [[0, 10], [5, 10], [10, 10], [12, 10]]) {
    assert.ok(coberturaDeDia({ fecha: 'x', enIndice: d, guardados: n }).texto.includes(`(${n} de ${d})`),
      `${n}/${d}: ` + coberturaDeDia({ fecha: 'x', enIndice: d, guardados: n }).texto);
  }
});

test('un día sin índice no es 0%: es que EDGAR no publicó', () => {
  // Decir "0% de cobertura" un feriado sería acusarnos de un hueco que no
  // existe. Son dos cosas distintas y se arreglan distinto.
  const c = coberturaDeDia({ fecha: '2026-12-25', enIndice: null, guardados: 0 });
  assert.equal(c.pct, null);
  assert.equal(c.completa, false);
  assert.match(c.texto, /no publicó/);
  const conMotivo = coberturaDeDia({ fecha: '2026-12-25', motivo: 'EDGAR no publicó índice ese día (feriado o fin de semana)' });
  assert.match(conMotivo.texto, /feriado/);
});

test('guardar MÁS de los que el índice trae sigue siendo completa, no 120%', () => {
  // Pasa cuando una enmienda trae filas de un filing que ya teníamos.
  const c = coberturaDeDia({ fecha: 'x', enIndice: 10, guardados: 12 });
  assert.equal(c.completa, true);
});
