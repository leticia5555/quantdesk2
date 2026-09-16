// ═══════════════════════════════════════════════════════════════
// tests/xbrl-parse.test.mjs — el lector del XBRL de BMV.
//
//   node tests/xbrl-parse.test.mjs
//
// Los fixtures son sintéticos y con valores obviamente falsos: prueban la
// MECÁNICA del parser (contextos, ventanas, sumas, identidades), no los datos
// de ninguna emisora.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  extraerDeZip, cierreDeTrimestre, leerZip, parsearJsonBmv, identidadesContables,
} from '../api/_lib/xbrl-parse.js';

/* ── utilidades del fixture ─────────────────────────────────────── */

function zipDe(nombre, texto) {
  const data = Buffer.from(texto, 'utf8');
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const nb = Buffer.from(nombre, 'utf8');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nb.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(0, 42);
  const lb = Buffer.concat([lh, nb, comp]), cb = Buffer.concat([ch, nb]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cb.length, 12); eocd.writeUInt32LE(lb.length, 16);
  return Buffer.concat([lb, cb, eocd]);
}

const CTX = (id, extra) => ({ Id: id, ContieneInformacionDimensional: false, ...extra });
const INST = (id, fecha) => CTX(id, { Periodo: { Tipo: 1, FechaInstante: fecha + 'T00:00:00Z' } });
const DUR = (id, ini, fin) => CTX(id, { Periodo: { Tipo: 2, FechaInicio: ini + 'T00:00:00Z', FechaFin: fin + 'T00:00:00Z' } });

let n = 0;
const hecho = (prefijo, local, ctx, valor, texto) => {
  const id = 'H' + (++n);
  return [id, { Id: id, IdConcepto: `${prefijo}_${local}`, NombreConcepto: local, EspacioNombres: `http://x/${prefijo}`,
                IdContexto: ctx, ValorNumerico: valor, Valor: texto ?? String(valor ?? ''), EsValorNil: valor == null && texto == null }];
};

const IFRS = 'ifrs-full', MX = 'ifrs_mx-cor_20141205';

function instanciaBase() {
  const contextos = {
    I: INST('I', '2026-06-30'),
    D3: DUR('D3', '2026-04-01', '2026-06-30'),
    D6: DUR('D6', '2026-01-01', '2026-06-30'),
    D12: DUR('D12', '2025-07-01', '2026-06-30'),
    SEG: { Id: 'SEG', ContieneInformacionDimensional: true, Periodo: { Tipo: 1, FechaInstante: '2026-06-30T00:00:00Z' } },
  };
  const hechos = Object.fromEntries([
    hecho(IFRS, 'Revenue', 'D3', 1000),
    hecho(IFRS, 'Revenue', 'D6', 1900),
    hecho(IFRS, 'Revenue', 'D12', 3700),
    hecho(IFRS, 'ProfitLossAttributableToOwnersOfParent', 'D3', 200),
    hecho(IFRS, 'Assets', 'I', 5000),
    hecho(IFRS, 'Assets', 'SEG', 999999),          // segmento: debe ignorarse
    hecho(IFRS, 'Liabilities', 'I', 3000),
    hecho(IFRS, 'Equity', 'I', 2000),
    hecho(IFRS, 'EquityAttributableToOwnersOfParent', 'I', 1800),
    hecho(IFRS, 'NoncontrollingInterests', 'I', 200),
    hecho(IFRS, 'CashAndCashEquivalents', 'I', 400),
    hecho(MX, 'CreditosBancariosACortoPlazo', 'I', 300),
    hecho(MX, 'CreditosBursatilesACortoPlazo', 'I', 150),
    // OtrosCreditosConCostoACortoPlazo AUSENTE a propósito
    hecho(MX, 'CreditosBancariosALargoPlazo', 'I', 900),
    hecho(MX, 'CreditosBursatilesALargoPlazo', 'I', 100),
    hecho(MX, 'OtrosCreditosConCostoALargoPlazo', 'I', 0),
    hecho(MX, 'NumeroDeAccionesEnCirculacion', 'I', 17400000000),
    hecho(IFRS, 'DateOfAuthorisationForIssueOfFinancialStatements', 'I', null, '2026-07-23'),
  ]);
  return {
    EspacioNombresPrincipal: 'http://www.cnbv.gob.mx/taxonomy/ifrs_mx/full_ifrs_mc_mx_ics_entry_point_2019-01-01',
    ContextosPorId: contextos, HechosPorId: hechos,
  };
}

const zipBase = () => zipDe('ifrsxbrl_123_2026-02_1.json', JSON.stringify(instanciaBase()));

/* ── cierreDeTrimestre ──────────────────────────────────────────── */

test('cierreDeTrimestre mapea los cuatro trimestres y rechaza basura', () => {
  assert.equal(cierreDeTrimestre(2026, 1), '2026-03-31');
  assert.equal(cierreDeTrimestre(2026, 2), '2026-06-30');
  assert.equal(cierreDeTrimestre(2026, 3), '2026-09-30');
  assert.equal(cierreDeTrimestre(2026, 4), '2026-12-31');
  assert.equal(cierreDeTrimestre(2026, 5), null);
  assert.equal(cierreDeTrimestre(2026, 'x'), null);
});

/* ── ZIP ────────────────────────────────────────────────────────── */

test('leerZip descomprime el .json de adentro', () => {
  const archivos = leerZip(zipBase());
  assert.equal(archivos.length, 1);
  assert.match(archivos[0].nombre, /\.json$/);
  assert.ok(JSON.parse(archivos[0].datos.toString('utf8')).HechosPorId);
});

test('un zip sin .json falla con el contenido en el mensaje', () => {
  assert.throws(() => extraerDeZip(zipDe('otra.cosa.txt', 'hola'), { anio: 2026, trimestre: 2 }),
    /no trae \.json.*otra\.cosa\.txt/s);
});

/* ── parsearJsonBmv ─────────────────────────────────────────────── */

test('parsearJsonBmv distingue instante (Tipo 1) de duración (Tipo 2)', () => {
  const { contextos } = parsearJsonBmv(instanciaBase());
  assert.equal(contextos.get('I').instant, '2026-06-30');
  assert.equal(contextos.get('I').startDate, null);
  assert.equal(contextos.get('D3').endDate, '2026-06-30');
  assert.equal(contextos.get('D3').instant, null);
  assert.equal(contextos.get('SEG').dimensionado, true);
});

test('parsearJsonBmv rechaza un JSON que no es de BMV', () => {
  assert.throws(() => parsearJsonBmv({ foo: 1 }), /no es el formato de BMV/);
});

/* ── los 9 campos ───────────────────────────────────────────────── */

test('extraerDeZip resuelve los 9 campos del trimestre pedido', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.equal(r.periodEnd, '2026-06-30');
  assert.equal(r.valores.activos_totales, 5000);
  assert.equal(r.valores.pasivos_totales, 3000);
  assert.equal(r.valores.capital_contable, 2000);
  assert.equal(r.valores.efectivo, 400);
  assert.equal(r.valores.acciones_circulacion, 17400000000);
  assert.equal(r.fecha_autorizacion, '2026-07-23');
  assert.match(r.entryPoint, /ics/);
});

test('un contexto con dimensiones NO se usa: activos son el consolidado', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.equal(r.valores.activos_totales, 5000);   // no 999999 del segmento
  assert.equal(r.campos.activos_totales.tag, 'ifrs-full:Assets');
});

test('la ventana de 3 meses manda; las otras quedan como secundarias', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  const ing = r.campos.ingresos;
  assert.equal(ing.valor, 1000);
  assert.equal(ing.ventana, '3m');
  assert.deepEqual(ing.otras_ventanas.map((o) => o.ventana).sort(), ['12m', '6m']);
  assert.equal(ing.otras_ventanas.find((o) => o.ventana === '6m').valor, 1900);
});

test('sin columna de 3m, la principal es la que haya con su ventana real', () => {
  const inst = instanciaBase();
  for (const [k, h] of Object.entries(inst.HechosPorId)) {
    if (h.NombreConcepto === 'Revenue' && h.IdContexto !== 'D6') delete inst.HechosPorId[k];
  }
  const r = extraerDeZip(zipDe('x.json', JSON.stringify(inst)), { anio: 2026, trimestre: 2 });
  assert.equal(r.campos.ingresos.ventana, '6m');
  assert.equal(r.campos.ingresos.valor, 1900);
  assert.deepEqual(r.campos.ingresos.otras_ventanas, []);
});

/* ── deuda con costo: suma, y ausente ≠ cero ────────────────────── */

test('deuda con costo suma los componentes presentes', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.equal(r.valores.deuda_corto, 450);        // 300 + 150
  assert.equal(r.valores.deuda_largo, 1000);       // 900 + 100 + 0
  assert.equal(r.campos.deuda_corto.componentes.length, 2);
});

test('un componente ausente se reporta, no se cuenta como cero', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.deepEqual(r.campos.deuda_corto.faltantes, ['OtrosCreditosConCostoACortoPlazo']);
  assert.match(r.campos.deuda_corto.motivo, /no reportados/);
  // el que sí vino en cero NO aparece como faltante
  assert.deepEqual(r.campos.deuda_largo.faltantes, []);
});

test('sin ningún componente de deuda, el campo es null con motivo', () => {
  const inst = instanciaBase();
  for (const [k, h] of Object.entries(inst.HechosPorId)) {
    if (/^Creditos|^OtrosCreditos/.test(h.NombreConcepto)) delete inst.HechosPorId[k];
  }
  const r = extraerDeZip(zipDe('x.json', JSON.stringify(inst)), { anio: 2026, trimestre: 2 });
  assert.equal(r.valores.deuda_corto, null);
  assert.equal(r.campos.deuda_corto.ok, false);
  assert.match(r.campos.deuda_corto.motivo, /ningún componente/);
});

/* ── fail-closed ────────────────────────────────────────────────── */

test('un campo que no resuelve queda null con motivo, nunca con un proxy', () => {
  const inst = instanciaBase();
  for (const [k, h] of Object.entries(inst.HechosPorId)) {
    if (h.NombreConcepto === 'CashAndCashEquivalents') delete inst.HechosPorId[k];
  }
  const r = extraerDeZip(zipDe('x.json', JSON.stringify(inst)), { anio: 2026, trimestre: 2 });
  assert.equal(r.valores.efectivo, null);
  assert.equal(r.campos.efectivo.ok, false);
  assert.match(r.campos.efectivo.motivo, /ningún tag resolvió/);
  assert.ok(r.alertas.some((a) => /efectivo/.test(a)));
});

test('pedir un trimestre que el archivo no cubre no devuelve el de otro periodo', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 4 });  // cierre 2026-12-31
  assert.equal(r.periodEnd, '2026-12-31');
  assert.equal(r.valores.activos_totales, null);
  assert.equal(r.valores.ingresos, null);
});

/* ── identidades ────────────────────────────────────────────────── */

test('las identidades que cuadran salen ok y las que faltan salen n/d', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.equal(r.identidades.activos_eq_pasivos_capital.estado, 'ok');   // 5000 = 3000+2000
  assert.equal(r.identidades.capital_eq_ctrl_nocrtl.estado, 'ok');       // 2000 = 1800+200
  assert.equal(r.identidades.activos_eq_circ_nocirc.estado, 'n/d');      // sin subtotales
});

test('una identidad que descuadra se reporta con la diferencia y alerta', () => {
  const inst = instanciaBase();
  for (const h of Object.values(inst.HechosPorId)) {
    if (h.NombreConcepto === 'Liabilities') h.ValorNumerico = 3001;
  }
  const r = extraerDeZip(zipDe('x.json', JSON.stringify(inst)), { anio: 2026, trimestre: 2 });
  assert.equal(r.identidades.activos_eq_pasivos_capital.estado, 'dif');
  assert.equal(r.identidades.activos_eq_pasivos_capital.dif, -1);
  assert.ok(r.alertas.some((a) => /descuadra/.test(a)));
});

test('identidadesContables no inventa cuando falta una parte', () => {
  const r = identidadesContables({ activos_totales: 100, pasivos_totales: 60, capital_contable: null });
  assert.equal(r.activos_eq_pasivos_capital.estado, 'n/d');
  assert.equal(r.activos_eq_pasivos_capital.dif, null);
});

/* ── raw ────────────────────────────────────────────────────────── */

test('el raw completo viaja intacto para poder re-parsear después', () => {
  const r = extraerDeZip(zipBase(), { anio: 2026, trimestre: 2 });
  assert.ok(r.raw.HechosPorId);
  assert.ok(r.raw.ContextosPorId);
  assert.equal(Object.keys(r.raw.HechosPorId).length, Object.keys(instanciaBase().HechosPorId).length);
});
