// ═══════════════════════════════════════════════════════════════
// tests/xbrl-capture-fila.test.mjs — lectura de la fila del XBRL en la
// página de la emisora. Es la parte más frágil del capturador: si BMV
// rediseña la tabla, se rompe aquí y no en el parser.
//
//   node tests/xbrl-capture-fila.test.mjs
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { filasXbrl, parseFechaBmv } from '../api/xbrl-capture.js';

/* ── parseFechaBmv ──────────────────────────────────────────────── */

test('parseFechaBmv lee el formato del listado de BMV', () => {
  assert.equal(parseFechaBmv('23-Jul-2026 14:11'), '2026-07-23T14:11:00Z');
  assert.equal(parseFechaBmv('01-Ene-2026 09:05'), '2026-01-01T09:05:00Z');
  assert.equal(parseFechaBmv('28-Feb-2025 23:59'), '2025-02-28T23:59:00Z');
});

test('parseFechaBmv aguanta los meses en español que BMV escribe raro', () => {
  assert.equal(parseFechaBmv('15-Dic-2026 10:00'), '2026-12-15T10:00:00Z');
  assert.equal(parseFechaBmv('03-Sept-2026 08:30'), '2026-09-03T08:30:00Z');
  assert.equal(parseFechaBmv('03-Set-2026 08:30'), '2026-09-03T08:30:00Z');
  assert.equal(parseFechaBmv('09-Abr.-2026 11:00'), '2026-04-09T11:00:00Z');
});

test('parseFechaBmv acepta fecha sin hora, y rechaza lo que no reconoce', () => {
  assert.equal(parseFechaBmv('23-Jul-2026'), '2026-07-23T00:00:00Z');
  assert.equal(parseFechaBmv('2026-07-23'), null);       // ISO no es este formato
  assert.equal(parseFechaBmv('23-Xyz-2026 10:00'), null); // mes inventado
  assert.equal(parseFechaBmv(''), null);
  assert.equal(parseFechaBmv(null), null);
});

/* ── filasXbrl ──────────────────────────────────────────────────── */

const fila = (fecha, titulo, archivo) => `
  <tr>
    <td>${fecha}</td>
    <td>${titulo}</td>
    <td><a href="visorXbrl.html?docins=../ifrsxbrl/${archivo}">Ver</a></td>
  </tr>`;

const PAGINA = `<html><body>
  <h2>ESTADOS FINANCIEROS BÁSICOS</h2>
  <table>
    ${fila('23-Jul-2026 14:11', 'Información Del Trimestre 2 Del Año 2026', 'ifrsxbrl_1576474_2026-02_1.zip')}
    ${fila('24-Abr-2026 09:30', 'Información Del Trimestre 1 Del Año 2026', 'ifrsxbrl_1576474_2026-01_1.zip')}
  </table>
</body></html>`;

test('filasXbrl encuentra la fila, su zip, su periodo y su fecha de publicación', () => {
  const filas = filasXbrl(PAGINA);
  assert.equal(filas.length, 2);
  const f = filas[0];
  assert.equal(f.doc_id, '1576474');
  assert.equal(f.anio, 2026);
  assert.equal(f.trimestre, 2);
  assert.equal(f.secuencia, 1);
  assert.equal(f.fecha_publicacion, '2026-07-23T14:11:00Z');
  assert.equal(f.zip_url, 'https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_1576474_2026-02_1.zip');
});

test('la fila más reciente va primero aunque el HTML venga desordenado', () => {
  const alReves = `<table>
    ${fila('24-Abr-2026 09:30', 'Trimestre 1 Del Año 2026', 'ifrsxbrl_9_2026-01_1.zip')}
    ${fila('23-Jul-2026 14:11', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_1.zip')}
    ${fila('20-Oct-2025 12:00', 'Trimestre 3 Del Año 2025', 'ifrsxbrl_9_2025-03_1.zip')}
  </table>`;
  const filas = filasXbrl(alReves);
  assert.deepEqual(filas.map((f) => `${f.anio}T${f.trimestre}`), ['2026T2', '2026T1', '2025T3']);
});

test('con dos envíos del mismo trimestre gana la secuencia más alta (reexpresión)', () => {
  const html = `<table>
    ${fila('23-Jul-2026 14:11', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_1.zip')}
    ${fila('30-Jul-2026 10:00', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_2.zip')}
  </table>`;
  const filas = filasXbrl(html);
  assert.equal(filas[0].secuencia, 2);
  assert.equal(filas[0].fecha_publicacion, '2026-07-30T10:00:00Z');
});

test('cada fila se queda con SU fecha, no con la de la fila de al lado', () => {
  const filas = filasXbrl(PAGINA);
  assert.equal(filas.find((f) => f.trimestre === 1).fecha_publicacion, '2026-04-24T09:30:00Z');
});

test('el mismo zip repetido en la página no produce filas duplicadas', () => {
  const html = `<table>
    ${fila('23-Jul-2026 14:11', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_1.zip')}
    ${fila('23-Jul-2026 14:11', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_1.zip')}
  </table>`;
  assert.equal(filasXbrl(html).length, 1);
});

test('una fila sin fecha legible no se descarta: el zip sigue sirviendo', () => {
  const html = `<table>${fila('', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_9_2026-02_1.zip')}</table>`;
  const f = filasXbrl(html)[0];
  assert.equal(f.fecha_publicacion, null);
  assert.equal(f.trimestre, 2);
});

test('una página sin XBRL devuelve lista vacía, no explota', () => {
  assert.deepEqual(filasXbrl('<html><body>Sin nada</body></html>'), []);
  assert.deepEqual(filasXbrl(''), []);
});

test('links a otros documentos de BMV no se confunden con el XBRL', () => {
  const html = `<table>
    <tr><td>22-Jul-2026 10:00</td><td>Evento relevante</td>
        <td><a href="/docs-pub/eventoca/eventemi_1576009_1.pdf">PDF</a></td></tr>
    ${fila('23-Jul-2026 14:11', 'Trimestre 2 Del Año 2026', 'ifrsxbrl_1576474_2026-02_1.zip')}
  </table>`;
  const filas = filasXbrl(html);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].doc_id, '1576474');
});
