// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-db.js — el esquema y los upserts de HISTORIA.
//
// **Lo que estos tests NO son.** Este contenedor no tiene `DATABASE_URL`, así
// que ninguna vista corrió contra Postgres. Nada de acá autoriza a decir que
// `company_quarterly` devuelve lo correcto — eso es G7 (§10 del memo) y se
// gana cuando la ingesta de la rebanada C corra contra Neon.
//
// **Lo que sí son.** Con el ejecutor inyectado —igual que edgar.js inyecta su
// fetch— el SQL que se genera y los parámetros que viajan son observables, y
// ahí sí hay aserciones de verdad:
//
//   1. **El catálogo de familias y sus rangos.** El orden de los alias no es
//      cosmético: decide qué tag gana un periodo. Que `…ExcludingAssessedTax`
//      vaya antes que `…IncludingAssessedTax` es la diferencia entre la serie
//      de ingresos de MELI y una serie que mezcla dos mediciones distintas.
//   2. **Las invariantes de la cita.** Un hecho derivado sin su segunda
//      `accession` no sale de este proceso: se rechaza antes de tocar la red,
//      con el ticker y el periodo en el mensaje.
//   3. **La forma de los upserts**: columnas, parámetros, troceado y el
//      objetivo del `on conflict`.
//   4. **Candados de regresión sobre el SQL de las vistas.** Un test que lee
//      texto no prueba que la vista funcione; sí impide que el arreglo del
//      alias desaparezca en una edición distraída. Están marcados como lo que
//      son y no se cuentan como cobertura de la vista.
//
// Correr con `node tests/historia-db.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  FAMILIAS, NUCLEO, HISTORIA_SCHEMA, FILAS_POR_SENTENCIA,
  mapearConcepto, crearRepo,
} from '../api/_lib/historia-db.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

async function tira(fn, name, comprobar) {
  try {
    await fn();
    failures++;
    console.error('  FAIL', name, '→ no lanzó');
  } catch (e) {
    if (comprobar) comprobar(e, name); else console.log('  PASS', name);
  }
}

// ── Ejecutor falso: guarda cada sentencia y sus parámetros ────────────────
function repoDePrueba() {
  const sueltas = [];   // [query, params]
  const lotes = [];     // [[query, params], …]
  const repo = crearRepo({
    sql: async (query, params = []) => { sueltas.push([query, params]); return []; },
    sqlBatch: async (queries) => { lotes.push(queries); return queries.map(() => []); },
  });
  return { repo, sueltas, lotes, todas: () => [...sueltas, ...lotes.flat()] };
}

const unaLinea = (s) => String(s).replace(/\s+/g, ' ').trim();
const vista = (nombre) => unaLinea(HISTORIA_SCHEMA.find((q) => q.includes(`create or replace view ${nombre}`)));
const tabla = (nombre) => unaLinea(HISTORIA_SCHEMA.find((q) => q.includes(`create table if not exists ${nombre}`)));

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El catálogo de familias: el orden de los alias ES el rango');
{
  eq(new Set(FAMILIAS.map((f) => f.id)).size, FAMILIAS.length, 'los ids de familia son únicos');
  ok(FAMILIAS.every((f) => (f.tags || []).length > 0), 'toda familia trae al menos un tag us-gaap');
  ok(FAMILIAS.every((f) => f.tipo === 'duracion' || f.tipo === 'instante'), 'todo tipo es duración o instante');
  for (const id of NUCLEO) ok(FAMILIAS.some((f) => f.id === id), `el núcleo de la cobertura incluye "${id}"`);

  // Un mismo (taxonomía, tag) en dos familias sería una ambigüedad que el
  // mapeo resuelve en silencio. Mejor que no exista.
  const vistos = new Map();
  let choques = 0;
  for (const f of FAMILIAS) {
    for (const [tax, tags] of [['us-gaap', f.tags || []], ['dei', f.dei || []], ['ifrs-full', f.ifrs || []]]) {
      for (const t of tags) {
        const k = `${tax}:${t}`;
        if (vistos.has(k) && vistos.get(k) !== f.id) choques++;
        vistos.set(k, f.id);
      }
    }
  }
  eq(choques, 0, 'ningún (taxonomía, tag) pertenece a dos familias');

  // Los rangos que deciden la corrección de la serie.
  hondo(mapearConcepto('us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'),
    { familia: 'ingresos', rango: 1, tipo: 'duracion' }, 'ingresos: Excluding manda');
  eq(mapearConcepto('us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax').rango, 2,
    'ingresos: Including es respaldo — es la MISMA venta con impuesto, no otra medición');
  eq(mapearConcepto('us-gaap', 'Revenues').rango, 3, 'ingresos: Revenues (pre-ASC 606) queda tercero');

  eq(mapearConcepto('us-gaap', 'InventoryNet').rango, 1, 'inventario: InventoryNet manda');
  eq(mapearConcepto('us-gaap', 'InventoryFinishedGoods').rango, 2,
    'inventario: FinishedGoods es una PARTE, solo entra si falta el neto');
  eq(mapearConcepto('us-gaap', 'LongTermDebt').rango, 1, 'deuda: el total antes que la porción no corriente');

  // El hueco que encontró la corrida 2: LULU salió con 0 conceptos de caja
  // porque usa el tag posterior a ASU 2016-18 (§11).
  eq(mapearConcepto('us-gaap', 'CashAndCashEquivalentsAtCarryingValue').rango, 1, 'caja: el tag limpio manda');
  eq(mapearConcepto('us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents').rango, 2,
    'caja: el tag post-ASU-2016-18 existe — sin él, LULU daba un "sin documentos" FALSO');

  eq(mapearConcepto('ifrs-full', 'Revenue').familia, 'ingresos', 'las familias cruzan a ifrs-full (VIST reporta ahí)');
  eq(mapearConcepto('dei', 'EntityCommonStockSharesOutstanding').familia, 'acciones', 'y a dei');
  eq(mapearConcepto('us-gaap', 'AlgoQueNoExiste'), null, 'un concepto sin familia devuelve null, no rompe');
  eq(mapearConcepto('ifrs-full', 'InventoryNet'), null, 'el tag correcto en la taxonomía equivocada no mapea');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El esquema: las invariantes que el memo aprendió a la mala');
{
  const facts = tabla('company_facts');
  ok(/check \(derived = false or accession_aux is not null\)/.test(facts),
    'un Q4 derivado no entra sin su segunda cita: el CHECK lo vuelve invariante');
  ok(/period_start_k date generated always as \(coalesce\(period_start, date '1900-01-01'\)\) stored/.test(facts),
    'period_start_k es generada: la clave natural necesita una columna no nula');
  ok(/check \(\(familia is null\) = \(familia_rango is null\)\)/.test(facts),
    'familia y familia_rango viajan juntos: una familia sin rango no se puede ordenar');
  ok(/val +numeric not null/.test(facts), 'val es not null: un hecho sin valor no es un hecho');
  ok(/accession +text not null/.test(facts), 'accession es not null: sin cita el hecho no se puede afirmar');

  const natural = unaLinea(HISTORIA_SCHEMA.find((q) => q.includes('company_facts_natural')));
  ok(natural.includes('period_start_k'), 'la clave natural usa la columna generada, no la expresión');
  ok(natural.includes('accession'), 'y el accession: la re-expresión es una fila más, no un update');

  const emisor = tabla('company_emisor');
  ok(/check \(cobertura in \('completa', 'parcial'\)\)/.test(emisor),
    'la cobertura solo admite completa o parcial: no hay tercer estado silencioso');

  const items = tabla('company_filing_items');
  ok(/references company_filings \(cik, accession\) on delete cascade/.test(items),
    'los items cuelgan del filing y se van con él');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Candados sobre el SQL de las vistas (regresión, NO cobertura)');
{
  const q = vista('company_quarterly');

  // El arreglo del alias, mitad 1: por periodo gana un solo tag, por rango.
  ok(/order by cik, familia, period_end, familia_rango asc, filed desc/.test(q),
    'elegido ordena por familia_rango ANTES que por filed: gana el tag, no la fecha');

  // El arreglo del alias, mitad 2: las revisiones se cuentan dentro del tag.
  ok(/f\.concept = e\.concept/.test(q) && /f\.taxonomy = e\.taxonomy/.test(q),
    'versiones se une por concept y taxonomy: las revisiones se cuentan DENTRO del tag');
  ok(!/count\(distinct val\)[\s\S]*group by cik, familia, period_end\b(?![\s\S]*concept)/.test(q),
    'no queda ningún conteo por familia suelto');

  // El arreglo del YoY: cuatro filas atrás no es un año atrás.
  ok(/lag\(e\.period_end, 4\)/.test(q),
    'la vista trae el period_end comparado, no solo el valor');
  ok(/not between 330 and 400/.test(q),
    'y solo emite yoy_pct si ese periodo está a un año de distancia');
  ok(/val_hace_un_anio <= 0/.test(q),
    'un YoY sobre base negativa o cero sale null: no es interpretable');

  const c = vista('company_cobertura');
  ok(/\(e\.cobertura = 'completa'\) as cuenta_para_cobertura/.test(c),
    'la regla del 20-F está escrita UNA vez y es consultable');
  ok(/left join company_quarterly/.test(c),
    'es left join: un emisor sin un solo trimestre aparece en cero, no desaparece');
  for (const f of NUCLEO) ok(c.includes(`('${f}')`), `la vista de cobertura mide el núcleo: ${f}`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── asegurarEsquema');
{
  const { repo, lotes } = repoDePrueba();
  await repo.asegurarEsquema();
  await repo.asegurarEsquema();
  eq(lotes.length, 1, 'el esquema se asegura una vez por instancia, no en cada request');
  eq(lotes[0].length, HISTORIA_SCHEMA.length, 'y manda todas las sentencias en una transacción');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── guardarEmisor');
{
  const { repo, sueltas } = repoDePrueba();
  await repo.guardarEmisor({ cik: '0001762506', ticker: 'VIST', nombre: 'Vista Energy', formaAnual: '20-F', cobertura: 'parcial' });
  const [q, p] = sueltas[0];
  hondo(p, ['0001762506', 'VIST', 'Vista Energy', '20-F', 'parcial', null, 'pendiente'], 'los parámetros van en orden');
  ok(unaLinea(q).includes('on conflict (cik) do update'), 're-ingerir actualiza el perfil');
  ok(/sic = coalesce\(excluded\.sic, company_emisor\.sic\)/.test(unaLinea(q)),
    'un sic nulo entrante no borra el que ya estaba');

  const { repo: r2, sueltas: s2 } = repoDePrueba();
  await r2.guardarEmisor({ cik: '1' });
  eq(s2[0][1][4], 'completa', 'sin etiqueta explícita, la cobertura es completa');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── guardarFilings');
{
  const filing = (n) => ({
    cik: '0001099590', accession: `0001-24-${n}`, form: '8-K', items_raw: '2.02,9.01',
    filed: '2026-02-20', report_date: '2026-02-19', primary_doc: 'a.htm',
    url: 'https://sec.gov/a.htm', index_url: 'https://sec.gov/index.json',
    is_xbrl: true, size_bytes: 1234,
  });

  const { repo, lotes } = repoDePrueba();
  const n = await repo.guardarFilings([filing(1), filing(2)]);
  eq(n, 2, 'devuelve cuántos guardó');
  eq(lotes[0].length, 1, 'dos filings caben en una sentencia');
  const [q, p] = lotes[0][0];
  eq(p.length, 22, '11 columnas × 2 filas = 22 parámetros');
  eq(p[0], '0001099590', 'el primer parámetro es el cik');
  eq(p[11], '0001099590', 'la segunda tupla arranca donde termina la primera');
  ok(unaLinea(q).includes('values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11), ($12,'),
    'las marcas se numeran corridas entre tuplas');
  ok(unaLinea(q).includes('on conflict (cik, accession) do update'),
    'do update y no do nothing: el índice de EDGAR se corrige y la última lectura manda');

  // Un campo ausente es null explícito, no `undefined` viajando al driver.
  const { repo: r2, lotes: l2 } = repoDePrueba();
  await r2.guardarFilings([{ cik: 'x', accession: 'y', form: '4', filed: '2026-01-01', url: 'u', index_url: 'i' }]);
  const params = l2[0][0][1];
  eq(params[5], null, 'report_date ausente viaja como null');
  eq(params.filter((v) => v === undefined).length, 0, 'ningún undefined llega al driver');

  // El troceado: MELI trae miles de hechos y un solo insert sería un cuerpo
  // HTTP enorme cuyo fallo tira la transacción entera.
  const { repo: r3, lotes: l3 } = repoDePrueba();
  const muchos = Array.from({ length: FILAS_POR_SENTENCIA * 2 + 1 }, (_, i) => filing(i));
  eq(await r3.guardarFilings(muchos), 1001, 'devuelve el total, no el del último lote');
  eq(l3[0].length, 3, `${FILAS_POR_SENTENCIA * 2 + 1} filas se parten en 3 sentencias`);

  const { repo: r4, lotes: l4 } = repoDePrueba();
  eq(await r4.guardarFilings([]), 0, 'una lista vacía no genera sentencia');
  eq(l4.length, 0, 'ni siquiera abre una transacción');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── guardarFacts: la cita es una invariante, no una buena intención');
{
  const hecho = (extra = {}) => ({
    cik: '0001099590', taxonomy: 'us-gaap',
    concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
    familia: 'ingresos', familia_rango: 1, unit: 'USD',
    period_start: '2025-10-01', period_end: '2025-12-31', period_class: 'Q',
    fy: 2025, fp: 'Q4', form: '10-K', filed: '2026-02-20',
    accession: '0001-26-1', accession_aux: null, val: 6000000000, derived: false,
    ...extra,
  });

  const { repo, lotes } = repoDePrueba();
  eq(await repo.guardarFacts([hecho()]), 1, 'guarda un hecho');
  const [q, p] = lotes[0][0];
  eq(p.length, 17, '17 columnas por fila');
  // Ojo con el grep ingenuo: `period_start_k` SÍ aparece en el `on conflict`.
  // Lo que se comprueba es la lista de columnas del insert, que es donde
  // nombrarla sería un error de sintaxis y no un detalle.
  const columnasInsert = unaLinea(q).match(/insert into company_facts \(([^)]*)\)/)[1];
  ok(!columnasInsert.includes('period_start_k'), 'period_start_k NO se inserta: Postgres la genera');
  ok(columnasInsert.includes('period_start'), 'pero period_start sí, que es de donde sale');
  ok(unaLinea(q).includes('on conflict (cik, taxonomy, concept, unit, period_end, period_start_k, accession)'),
    'pero SÍ se nombra en el conflicto: es la clave natural');
  ok(unaLinea(q).includes('familia_rango = excluded.familia_rango'),
    're-ingerir actualiza el rango: si el catálogo cambia, la serie se reordena sin borrar nada');

  // La invariante de la cita, que es el punto entero del módulo.
  await tira(
    () => repoDePrueba().repo.guardarFacts([hecho({ derived: true, accession_aux: null })]),
    'un derivado sin accession_aux se rechaza',
    (e, name) => {
      ok(/derivado sin accession_aux/.test(e.message), name + ' con un mensaje que dice qué falta');
      ok(/0001099590/.test(e.message) && /2025-12-31/.test(e.message), name + ' y qué fila exactamente');
    },
  );

  // Y se rechaza ANTES de mandar nada: medio lote guardado sería peor.
  const { repo: r2, lotes: l2 } = repoDePrueba();
  await tira(
    () => r2.guardarFacts([hecho(), hecho({ period_end: '2025-09-30', derived: true })]),
    'un lote con un derivado inválido no manda nada',
    () => eq(l2.length, 0, 'la validación corre sobre el lote entero antes del primer insert'),
  );

  const { repo: r3 } = repoDePrueba();
  await tira(
    () => r3.guardarFacts([hecho({ familia: 'ingresos', familia_rango: null })]),
    'una familia sin rango se rechaza',
  );

  // Un derivado bien formado sí pasa.
  const { repo: r4, lotes: l4 } = repoDePrueba();
  await r4.guardarFacts([hecho({ derived: true, accession: '0001-26-1', accession_aux: '0001-25-3' })]);
  const pd = l4[0][0][1];
  eq(pd[13], '0001-26-1', 'el derivado cita el 10-K…');
  eq(pd[14], '0001-25-3', '…y el 10-Q de los nueve meses');

  // Un hecho sin familia se guarda igual: el crudo no se tira.
  const { repo: r5, lotes: l5 } = repoDePrueba();
  await r5.guardarFacts([hecho({ familia: null, familia_rango: null, concept: 'AlgoRaro' })]);
  eq(l5[0][0][1][3], null, 'un concepto que no mapea se guarda con familia null, no se descarta');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── guardarItems: se reemplazan en bloque');
{
  const { repo, lotes } = repoDePrueba();
  eq(await repo.guardarItems('1', 'acc-1', ['5.02', '9.01', '5.02', ' 7.01 ', '']), 3, 'deduplica y recorta');
  const [borrado, inserto] = lotes[0];
  ok(unaLinea(borrado[0]).startsWith('delete from company_filing_items'), 'primero borra los viejos');
  hondo(borrado[1], ['1', 'acc-1'], 'solo los de ese filing');
  hondo(inserto[1], ['1', 'acc-1', '5.02', '1', 'acc-1', '9.01', '1', 'acc-1', '7.01'], 'y después inserta los vigentes');
  eq(lotes[0].length, 2, 'las dos van en la MISMA transacción: nunca queda un filing sin items');

  const { repo: r2, lotes: l2 } = repoDePrueba();
  eq(await r2.guardarItems('1', 'acc-1', []), 0, 'sin items no inserta');
  eq(l2[0].length, 1, 'pero sí borra: un 8-K que perdió sus items no los conserva de antes');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El ledger del goteo (decisión 1 de §10: 42 s por ticker)');
{
  const { repo, sueltas } = repoDePrueba();
  await repo.marcarIngesta('1', { estado: 'ok' });
  hondo(sueltas[0][1], ['1', 'ok', null], 'un final feliz no guarda error');
  ok(/intentos = intentos \+ 1/.test(unaLinea(sueltas[0][0])), 'cuenta el intento siempre');
  ok(/ultima_ingesta = case when \$2 = 'ok' then now\(\) else ultima_ingesta end/.test(unaLinea(sueltas[0][0])),
    'un fallo NO adelanta ultima_ingesta: si no, un emisor roto parecería fresco');

  const { repo: r2, sueltas: s2 } = repoDePrueba();
  await r2.marcarIngesta('1', { estado: 'error', error: 'HTTP 429' });
  hondo(s2[0][1], ['1', 'error', 'HTTP 429'], 'el error se guarda en la fila, no en un log que nadie mira');

  const { repo: r3, sueltas: s3 } = repoDePrueba();
  await r3.pendientes();
  eq(s3[0][1][0], 7, 'el default son 7 emisores: lo que entra en un lambda de 300 s a 42 s cada uno');
  ok(/nulls first/.test(unaLinea(s3[0][0])), 'los que nunca se ingirieron van primero');

  const { repo: r4, sueltas: s4 } = repoDePrueba();
  await r4.pendientes(3, { masViejoQue: '2026-09-19T00:00:00Z' });
  hondo(s4[0][1], [3, '2026-09-19T00:00:00Z'], 'la frescura de la decisión 2 entra por parámetro');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── docs/sql/historia.sql no se separa del esquema');
{
  // El .sql existe para poder leer y aplicar el esquema sin levantar la app,
  // y es exactamente la clase de archivo que se queda viejo en silencio: se
  // agrega una columna en el JS, nadie toca el .sql, y seis meses después
  // alguien levanta un entorno nuevo con una tabla que le falta algo.
  const archivo = unaLinea(readFileSync(new URL('../docs/sql/historia.sql', import.meta.url), 'utf8'));
  let ausentes = 0;
  for (const sentencia of HISTORIA_SCHEMA) {
    if (!archivo.includes(unaLinea(sentencia))) { ausentes++; console.error('    falta:', unaLinea(sentencia).slice(0, 70)); }
  }
  eq(ausentes, 0, 'cada sentencia del esquema está en el .sql');
  ok(archivo.includes('SE GENERA DESDE'), 'y el archivo dice que se genera, para que nadie lo edite a mano');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
