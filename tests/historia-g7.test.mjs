// ═══════════════════════════════════════════════════════════════
// Tests del criterio de G7 (scripts/historia-g7.mjs).
//
// El script lee Neon; el CRITERIO no necesita base, y separarlo es lo que
// permite probar que la compuerta se pone roja cuando tiene que ponerse. Una
// compuerta que solo se ha visto en verde no está probada: es la lección que
// la Fase 0 del Congreso pagó con dos corridas (§0.1 del memo).
//
// Lo que se fija acá:
//
//   1. **El arreglo del alias tiene un rojo real.** Si LULU vuelve a salir con
//      inventario revisado al 100% —los 12/12 de la corrida 2— G7 NO cierra.
//      Es el caso exacto que la rebanada B arregló.
//   2. **La cita es innegociable.** Un hecho sin accession o un derivado sin
//      su segunda cita ponen la compuerta en rojo.
//   3. **El emisor extranjero queda FUERA DE CRITERIO, no en rojo.** Es la
//      enmienda de §4: medir a VIST con la vara doméstica convertía al control
//      en falla.
//   4. **Las re-expresiones de MELI se reportan, no se juzgan.** El 19 de la
//      sonda mezclaba alias con revisión; el número separado por tag es un
//      hallazgo que se mira, no un umbral que se aprueba.
//
// Correr con `node tests/historia-g7.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { veredictoG7 } from '../scripts/historia-g7.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

// El escenario sano: lo que la corrida 2 y el goteo limpio deberían producir.
const SANO = {
  citas: { sin_accession: 0, derivados_sin_aux: 0, total: 17000 },
  cobertura: [
    { ticker: 'LULU', cobertura: 'completa', ingresos: 12, margen: 12, inventario: 12, neto: 12 },
    { ticker: 'MSFT', cobertura: 'completa', ingresos: 12, margen: 12, inventario: 12, neto: 12 },
    { ticker: 'MELI', cobertura: 'completa', ingresos: 13, margen: 13, inventario: 12, neto: 13 },
    { ticker: 'VIST', cobertura: 'parcial', ingresos: 0, margen: 0, inventario: 2, neto: 0 },
  ],
  // El arreglo puesto: inventario ya NO está al 100%.
  aliasLulu: [
    { familia: 'ingresos', trimestres: 12, revisados: 0 },
    { familia: 'inventario', trimestres: 12, revisados: 0 },
    { familia: 'margen', trimestres: 12, revisados: 0 },
    { familia: 'neto', trimestres: 12, revisados: 0 },
  ],
  reexpresionesMeli: [{ concept: 'Revenues', periodos: 3, revisiones_totales: 16 }],
};

const conFalla = (parche) => veredictoG7({ ...SANO, ...parche });
const linea = (v, id) => v.lineas.filter((l) => l.id === id);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El escenario sano cierra');
{
  const v = veredictoG7(SANO);
  eq(v.rojo, false, 'con todo en su lugar, G7 cierra');
  ok(linea(v, 'citas')[0].estado === 'VERDE', 'la cita pasa');
  ok(linea(v, 'cita_doble')[0].estado === 'VERDE', 'la doble cita del derivado pasa');
  eq(linea(v, 'cobertura').filter((l) => l.estado === 'VERDE').length, 3, 'los tres domésticos pasan la cobertura');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El arreglo del alias: el rojo que importa');
{
  // El caso EXACTO de la corrida 2: LULU inventario, 12 de 12 revisados,
  // porque la vista mezclaba InventoryNet con InventoryFinishedGoods.
  const v = conFalla({ aliasLulu: [{ familia: 'inventario', trimestres: 12, revisados: 12 }] });
  eq(v.rojo, true, 'LULU inventario al 100% pone G7 en ROJO');
  const l = linea(v, 'alias')[0];
  eq(l.estado, 'ROJO', 'la línea sale roja');
  ok(/el arreglo del alias NO llegó/.test(l.texto), 'y dice exactamente qué no llegó');
  ok(/12\/12/.test(l.detalle), 'con el número a la vista');

  // Revisiones parciales son normales: una empresa se re-expresa.
  eq(conFalla({ aliasLulu: [{ familia: 'inventario', trimestres: 12, revisados: 3 }] }).rojo, false,
    'tres periodos re-expresados de doce NO es el bug: es una empresa corrigiéndose');

  // Otra familia al 100% no es el bug conocido, pero no se traga en silencio.
  const otra = conFalla({ aliasLulu: [{ familia: 'deuda', trimestres: 12, revisados: 12 }] });
  eq(otra.rojo, false, 'otra familia al 100% no tumba la compuerta…');
  eq(linea(otra, 'alias')[0].estado, 'NOTA', '…pero queda anotada para mirarla');

  // Con pocos trimestres, el 100% no significa nada.
  eq(linea(conFalla({ aliasLulu: [{ familia: 'caja', trimestres: 2, revisados: 2 }] }), 'alias')[0].estado,
    'VERDE', 'dos de dos en una familia corta no dispara la alarma');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La cita es innegociable');
{
  const v = conFalla({ citas: { sin_accession: 1, derivados_sin_aux: 0, total: 17000 } });
  eq(v.rojo, true, 'UN solo hecho sin accession pone G7 en rojo');
  ok(/1 filas/.test(linea(v, 'citas')[0].detalle), 'y dice cuántos');

  const v2 = conFalla({ citas: { sin_accession: 0, derivados_sin_aux: 4, total: 17000 } });
  eq(v2.rojo, true, 'un derivado sin su segunda cita también: estaría citando media resta');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El extranjero queda FUERA DE CRITERIO, no en rojo');
{
  const v = veredictoG7(SANO);
  const vist = linea(v, 'cobertura').find((l) => /VIST/.test(l.texto));
  eq(vist.estado, 'NOTA', 'VIST no se mide con la vara doméstica');
  ok(/fuera de criterio/i.test(vist.texto), 'y se dice por qué');
  ok(/G6/.test(vist.detalle), 'con la compuerta que sí lo clasifica');

  // Y un doméstico con la serie incompleta SÍ es rojo.
  const roto = conFalla({
    cobertura: [{ ticker: 'MSFT', cobertura: 'completa', ingresos: 12, margen: 7, inventario: 12, neto: 12 }],
  });
  eq(roto.rojo, true, 'un doméstico con 7/12 en una familia del núcleo es rojo');
  ok(/§11 midió 12/.test(linea(roto, 'cobertura')[0].texto), 'contra lo que midió la sonda');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las re-expresiones de MELI se reportan, no se juzgan');
{
  const v = veredictoG7(SANO);
  const r = linea(v, 'reexpresiones');
  eq(r[0].estado, 'NOTA', 'el conteo por tag es un hallazgo, no un umbral');
  ok(/Revenues/.test(r[0].texto), 'con el concepto nombrado');
  eq(v.rojo, false, 'y no decide la compuerta en ningún sentido');

  // Cero también se dice, en vez de dejar el hueco.
  const sin = conFalla({ reexpresionesMeli: [] });
  ok(/no tiene periodos re-expresados/.test(linea(sin, 'reexpresiones')[0].texto),
    'sin re-expresiones se dice explícito');
  ok(/alias, no revisiones/.test(linea(sin, 'reexpresiones')[0].detalle),
    'y se recuerda que el 19 de la sonda contaba otra cosa');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
