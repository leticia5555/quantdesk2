// ═══════════════════════════════════════════════════════════════
// tests/bmv-inspect.test.mjs — parsers del censo del histórico.
//
//   node tests/bmv-inspect.test.mjs
//
// OJO: los fixtures son sintéticos, escritos contra una DESCRIPCIÓN de las
// páginas de BMV, no contra el HTML real. Prueban la mecánica, no que yo haya
// adivinado bien la página. Por eso el endpoint devuelve `estructura` cruda:
// si estos parsers fallan contra la página de verdad, esa sección lo dice.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  limpiar, estructuraCruda, documentos, periodoDeNombre, periodoDeTitulo,
  clasificarEvento, idDeArchivo, analizarIds, resumirPorTipo,
} from '../api/_lib/bmv-inspect.js';
import { parseFechaBmv } from '../api/xbrl-capture.js';

/* ── limpiar ────────────────────────────────────────────────────── */

test('limpiar resuelve entidades y colapsa espacios', () => {
  assert.equal(limpiar('<td>PE&amp;OLES</td>'), 'PE&OLES');
  assert.equal(limpiar('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(limpiar('<b>x</b>\n\n  <i>y</i>'), 'x y');
  assert.equal(limpiar('&#65;&#66;'), 'AB');
  assert.equal(limpiar(null), '');
});

/* ── estructuraCruda: el seguro contra mis propios parsers ─────── */

const PAGINA = `<html><body>
  <h2>ESTADOS FINANCIEROS BÁSICOS</h2>
  <table><tr><td>23-Jul-2026 14:11</td><td>Información Del Trimestre 2 Del Año 2026</td>
    <td><a href="visorXbrl.html?docins=../ifrsxbrl/ifrsxbrl_1576474_2026-02_1.zip">Ver</a></td></tr></table>
  <h2>REPORTES ANUALES</h2>
  <table>
    <tr><td>30-Abr-2025 10:00</td><td>Reporte Anual 2024</td><td><a href="/docs-pub/anexon/anexon_998877_2024.zip">zip</a></td></tr>
    <tr><td>29-Abr-2024 10:00</td><td>Reporte Anual 2023</td><td><a href="/docs-pub/infoanua/infoanua_998800_2023.pdf">pdf</a></td></tr>
  </table>
</body></html>`;

test('estructuraCruda describe la página sin interpretarla', () => {
  const e = estructuraCruda(PAGINA);
  assert.deepEqual(e.encabezados, ['ESTADOS FINANCIEROS BÁSICOS', 'REPORTES ANUALES']);
  assert.deepEqual(Object.keys(e.docs_pub_por_tipo).sort(), ['anexon', 'ifrsxbrl', 'infoanua']);
  assert.equal(e.docs_pub_por_tipo.anexon.n, 1);
  assert.ok(e.docs_pub_por_tipo.anexon.ejemplos[0].startsWith('anexon_'));
  assert.equal(e.tiene_listado_en_html, true);
  assert.ok(e.anios_vistos.includes(2026) && e.anios_vistos.includes(2023));
});

test('una página cargada por JavaScript se distingue de una vacía', () => {
  const e = estructuraCruda('<html><body><div id="app"></div><script src="app.js"></script></body></html>');
  assert.equal(e.tiene_listado_en_html, false);
  assert.deepEqual(e.docs_pub_por_tipo, {});
  assert.equal(e.filas_tr, 0);
});

/* ── documentos ─────────────────────────────────────────────────── */

test('documentos encuentra cualquier tipo bajo docs-pub, no sólo ifrsxbrl', () => {
  const d = documentos(PAGINA, parseFechaBmv);
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((x) => x.tipo).sort(), ['anexon', 'ifrsxbrl', 'infoanua']);
  const anual = d.find((x) => x.tipo === 'anexon');
  assert.equal(anual.url, 'https://www.bmv.com.mx/docs-pub/anexon/anexon_998877_2024.zip');
  assert.equal(anual.fecha_publicacion, '2025-04-30T10:00:00Z');
  assert.equal(anual.anio_archivo, 2024);
});

test('el mismo archivo repetido no duplica filas', () => {
  const html = PAGINA + PAGINA;
  assert.equal(documentos(html, parseFechaBmv).length, 3);
});

/* ── periodo desde nombre y título ──────────────────────────────── */

test('periodoDeNombre lee el AAAA-TT del XBRL y el año suelto de un anual', () => {
  assert.deepEqual(periodoDeNombre('ifrsxbrl_1576474_2026-02_1.zip'), { anio_archivo: 2026, trimestre_archivo: 2 });
  assert.deepEqual(periodoDeNombre('anexon_998877_2019.zip'), { anio_archivo: 2019, trimestre_archivo: null });
  assert.deepEqual(periodoDeNombre('eventemi_1576009_1.pdf'), { anio_archivo: null, trimestre_archivo: null });
});

test('periodoDeTitulo entiende las tres formas que usa BMV', () => {
  assert.deepEqual(periodoDeTitulo('Información Del Trimestre 2 Del Año 2026'), { anio_titulo: 2026, trimestre_titulo: 2 });
  assert.deepEqual(periodoDeTitulo('Reporta Resultados del Segundo Trimestre de 2022'), { anio_titulo: 2022, trimestre_titulo: 2 });
  assert.deepEqual(periodoDeTitulo('Resultados 4T21'), { anio_titulo: 2021, trimestre_titulo: 4 });
  assert.deepEqual(periodoDeTitulo('Aviso a los accionistas'), { anio_titulo: null, trimestre_titulo: null });
});

/* ── clasificar eventos relevantes ──────────────────────────────── */

test('reconoce los comunicados de resultados reales de WALMEX y FEMSA', () => {
  const w = clasificarEvento('Walmart de México y Centroamérica Reporta Resultados del Cuarto Trimestre de 2021');
  assert.equal(w.clase, 'resultados_trimestrales');
  assert.equal(w.confianza, 'alta');
  assert.equal(w.anio_titulo, 2021);
  assert.equal(w.trimestre_titulo, 4);

  const f = clasificarEvento('FEMSA Anuncia Resultados del Segundo Trimestre 2018');
  assert.equal(f.clase, 'resultados_trimestrales');
  assert.equal(f.trimestre_titulo, 2);
});

test('NO confunde otros eventos relevantes con reportes de resultados', () => {
  for (const t of [
    'Aviso de pago de dividendo',
    'Cambios en el Consejo de Administración',
    'Emisión de certificados bursátiles',
    'Convocatoria a Asamblea General Ordinaria de Accionistas',
    'Resultados de la Asamblea de Accionistas',
  ]) {
    assert.equal(clasificarEvento(t).clase, 'otro', `no debería clasificar: ${t}`);
  }
});

test('un título ambiguo sale como media confianza, no como alta', () => {
  const r = clasificarEvento('La empresa reporta resultados');
  assert.equal(r.clase, 'resultados_trimestrales');
  assert.equal(r.confianza, 'media');   // sin periodo detectable
});

/* ── ids: contigüidad ───────────────────────────────────────────── */

test('idDeArchivo saca el id de los nombres de BMV', () => {
  assert.equal(idDeArchivo('ifrsxbrl_1576010_2026-02_1.zip'), 1576010);
  assert.equal(idDeArchivo('eventemi_1576009_1.pdf'), 1576009);
  assert.equal(idDeArchivo('sin_id.pdf'), null);
});

test('analizarIds detecta el par contiguo evento/XBRL de WALMEX', () => {
  const r = analizarIds([
    { tipo: 'eventemi', archivo: 'eventemi_1576009_1.pdf' },
    { tipo: 'ifrsxbrl', archivo: 'ifrsxbrl_1576010_2026-02_1.zip' },
    { tipo: 'eventemi', archivo: 'eventemi_1400000_1.pdf' },
  ]);
  assert.equal(r.n, 3);
  assert.equal(r.pares_contiguos.length, 1);
  assert.equal(r.pares_contiguos[0].delta, 1);
  assert.deepEqual(r.pares_contiguos[0].tipos, ['eventemi', 'ifrsxbrl']);
});

test('analizarIds SIEMPRE advierte que contiguo no es adivinable', () => {
  const r = analizarIds([
    { tipo: 'eventemi', archivo: 'eventemi_100000_1.pdf' },
    { tipo: 'eventemi', archivo: 'eventemi_200000_1.pdf' },
  ]);
  assert.match(r.advertencia, /NO implican URLs adivinables/);
  assert.equal(r.pares_contiguos.length, 0);
  assert.equal(r.rango.span, 100000);
});

test('con menos de dos ids no se concluye nada', () => {
  const r = analizarIds([{ tipo: 'x', archivo: 'x_123456_1.pdf' }]);
  assert.match(r.conclusion, /muy pocos/);
});

/* ── resumen por tipo ───────────────────────────────────────────── */

test('resumirPorTipo dice desde y hasta qué año llega cada tipo', () => {
  const d = documentos(PAGINA, parseFechaBmv);
  const r = resumirPorTipo(d);
  assert.equal(r.ifrsxbrl.n, 1);
  assert.equal(r.ifrsxbrl.anio_max, 2026);
  assert.equal(r.anexon.anio_min, 2024);
  assert.equal(r.infoanua.anio_min, 2023);
  assert.equal(r.ifrsxbrl.con_fecha, 1);
});

test('un documento sin fecha legible se cuenta aparte, no se pierde', () => {
  const html = `<tr><td>sin fecha</td><td>Reporte</td><td><a href="/docs-pub/anexon/anexon_1_2020.zip">z</a></td></tr>`;
  const r = resumirPorTipo(documentos(html, parseFechaBmv));
  assert.equal(r.anexon.sin_fecha, 1);
  assert.equal(r.anexon.con_fecha, 0);
});
