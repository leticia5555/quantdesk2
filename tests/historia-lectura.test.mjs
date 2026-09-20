// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-lectura.js — las 7 secciones como documentos.
//
// Lo que se prueba acá es lo que decide si el módulo miente o no:
//
//   1. **Los tres vacíos se distinguen.** `sin_documentos` (se cubre, se
//      buscó, no hay) · `no_cubierta` (no miramos esa fuente) ·
//      `fuera_del_modulo` (existe en QuantDesk, no en EDGAR). "No hay 13D" y
//      "no miramos 13D" llevan a decisiones opuestas, y un hueco sin etiqueta
//      es indistinguible de un error.
//   2. **Nada sale sin cita.** Todo documento trae `[accession]` y todo punto
//      de la serie también; un Q4 derivado trae las DOS, porque salió de una
//      resta entre dos filings y enseñar solo el 10-K sería citar la mitad.
//   3. **La contraevidencia no es opcional** (§8). Sin ella el módulo es un
//      generador de sesgo de confirmación con citas. Cuando no hay, lo dice
//      con una frase falsable en vez de dejar el hueco.
//   4. **No se muestra ningún número de guía.** G5 midió 0/4 emisores con
//      guía etiquetada: se enlaza el 8-K y se declara.
//   5. **La cobertura parcial se declara en la sección de la serie**, que es
//      donde el 20-F duele: ahí la película tiene la mitad de fotogramas.
//   6. **Las consultas leen la VISTA, no la tabla** — la vista ya resolvió el
//      alias, la re-expresión y el YoY (rebanada B). Rehacerlo acá sería
//      volver a equivocarlo.
//
// Correr con `node tests/historia-lectura.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  DECLARACIONES, declarar, cita, crearLectura, armarSecciones, armarHistoria, declaracionesGlobales,
  ITEMS_DIRECCION, ITEMS_RESULTADOS, ITEMS_RUPTURA, FORMAS_PROPIEDAD, FORMAS_PELEA,
} from '../api/_lib/historia-lectura.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const sec = (r, id) => r.secciones.find((s) => s.id === id);
const doc = (accession, form, items = '', filed = '2026-02-20') => ({
  accession, form, items_raw: items, filed, report_date: null,
  url: `https://www.sec.gov/Archives/${accession}.htm`,
  index_url: `https://www.sec.gov/Archives/${accession}/index.json`,
});

const EMISOR = { cik: '0001099590', ticker: 'MELI', nombre: 'MERCADOLIBRE INC', forma_anual: '10-K', cobertura: 'completa', ultima_ingesta: '2026-09-20T00:00:00Z' };
const EMISOR_PARCIAL = { ...EMISOR, cik: '0001762506', ticker: 'VIST', nombre: 'Vista Energy', forma_anual: '20-F', cobertura: 'parcial' };

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El catálogo de declaraciones');
{
  ok(Object.values(DECLARACIONES).every((d) => d.es && d.en), 'toda declaración está en los dos idiomas');
  eq(declarar('transcripts', 'es').texto, DECLARACIONES.transcripts.es, 'resuelve en español');
  eq(declarar('transcripts', 'en').texto, DECLARACIONES.transcripts.en, 'y en inglés');
  eq(declarar('transcripts').codigo, 'transcripts', 'el código viaja junto al texto: la página puede traducir sin reescribirlo');
  eq(declarar('inventado', 'es').texto, 'inventado', 'un código desconocido no rompe');

  // Los textos de §8 no son decorativos: dicen qué NO sabemos.
  ok(/licencia comercial/.test(DECLARACIONES.transcripts.es), 'transcripts dice por qué no están');
  ok(/20-F/.test(DECLARACIONES.cobertura_parcial.es), 'la cobertura parcial nombra la forma');
  ok(/No es short interest/.test(DECLARACIONES.short_volume_no_es_short_interest.es),
    'short volume y short interest no se confunden: la UI lo dice');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La cita (decisión 8 de §10)');
{
  eq(cita('0000320193-25-000073'), '[0000320193-25-000073]', 'el identificador se VE, con corchetes');
  eq(cita(null), null, 'sin accession no hay cita inventada');
  eq(cita(''), null, 'ni con cadena vacía');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las 7 secciones con documentos');
{
  const r = armarSecciones({
    emisor: EMISOR,
    direccion: [{ ...doc('acc-502', '8-K', '5.02'), cita: '[acc-502]' }],
    proxies: [{ ...doc('acc-def', 'DEF 14A'), cita: '[acc-def]' }],
    propiedad: [{ ...doc('acc-13d', 'SC 13D'), cita: '[acc-13d]' }],
    pelea: [{ ...doc('acc-prec', 'PREC14A'), cita: '[acc-prec]' }],
    resultados: [{ ...doc('acc-202', '8-K', '2.02'), cita: '[acc-202]' }],
    catalizador: [{ ...doc('acc-101', '8-K', '1.01'), cita: '[acc-101]' }],
    serie: [{ familia: 'ingresos', period_end: '2025-12-31', val: 6000, yoy_pct: 12.3, revisado: false, derived: false, accession: 'acc-10k', cita: '[acc-10k]', cita_aux: null, filed: '2026-02-20' }],
    ruptura: [],
  }, {});

  eq(r.secciones.length, 7, 'son siete secciones, siempre');
  hondo(r.secciones.map((s) => s.pregunta), [1, 2, 3, 4, 5, 6, 7], 'y van en el orden del esqueleto');

  eq(sec(r, 'direccion').documentos.length, 2, 'la pregunta 1 junta el 8-K 5.02 con el proxy');
  eq(sec(r, 'direccion').estado, 'con_documentos', 'y se marca como cubierta con documentos');
  eq(sec(r, 'propiedad').documentos.length, 2, 'la pregunta 2 junta 13D con la pelea de proxies');
  eq(sec(r, 'prometido_vs_entregado').serie.length, 1, 'la pregunta 3 trae la serie');
  eq(sec(r, 'catalizador').documentos.length, 1, 'la pregunta 7 trae los eventos anunciados');

  ok(r.secciones.every((s) => Array.isArray(s.declaraciones)), 'toda sección trae su lista de declaraciones');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Los tres vacíos NO son el mismo vacío');
{
  const r = armarSecciones({ emisor: EMISOR }, {});

  // Se cubre, se buscó, no hay. Es una afirmación sobre LA EMPRESA.
  eq(sec(r, 'direccion').estado, 'sin_documentos', 'sin 8-K 5.02: "sin documentos", no "no cubierta"');
  eq(sec(r, 'propiedad').estado, 'sin_documentos', 'lo mismo para 13D y proxies');
  eq(sec(r, 'catalizador').estado, 'sin_documentos', 'y para los eventos');
  hondo(sec(r, 'direccion').documentos, [], 'y el hueco queda vacío: nunca relleno');

  // No miramos esa fuente. Es una afirmación sobre NOSOTROS.
  eq(sec(r, 'gerencia').estado, 'no_cubierta', 'la pregunta 4 es NO CUBIERTA, no "sin documentos"');
  eq(sec(r, 'gerencia').declaraciones[0].codigo, 'transcripts', 'y dice por qué');
  eq(sec(r, 'competencia').estado, 'no_cubierta', 'la pregunta 5 también');
  hondo(sec(r, 'competencia').declaraciones.map((d) => d.codigo), ['pares_sin_mapa', 'competidores_privados'],
    'con sus dos motivos: la lista curada no existe Y los privados no reportan');

  // Existe en QuantDesk, pero no sale de EDGAR.
  eq(sec(r, 'mercado').estado, 'fuera_del_modulo', 'la pregunta 6 no es "no cubierta": está en otro panel');
  ok(sec(r, 'mercado').declaraciones.some((d) => d.codigo === 'short_volume_no_es_short_interest'),
    'y aclara que short volume no es short interest');

  // El que más importa: una sección cubierta y vacía NUNCA dice "no cubierta".
  const estados = new Set(r.secciones.map((s) => s.estado));
  ok(!estados.has('con_documentos'), 'sin datos, ninguna sección finge tenerlos');
  eq(sec(r, 'gerencia').documentos.length, 0, 'una sección no cubierta tampoco inventa documentos');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La pregunta 3: la guía se enlaza, no se guarda');
{
  const r = armarSecciones({
    emisor: EMISOR,
    resultados: [{ ...doc('acc-202', '8-K', '2.02'), cita: '[acc-202]' }],
    serie: [{ familia: 'ingresos', period_end: '2025-12-31', val: 6000, accession: 'a', cita: '[a]', revisado: false, derived: false }],
  }, {});
  const s3 = sec(r, 'prometido_vs_entregado');

  ok(s3.declaraciones.some((d) => d.codigo === 'guia_no_estructurada'),
    'la sección declara que la guía no viene estructurada');
  ok(/No se guarda ningún número de guía/.test(s3.declaraciones.find((d) => d.codigo === 'guia_no_estructurada').texto),
    'y lo dice explícito: G5 midió 0/4 emisores con guía etiquetada');

  // La prueba de fondo: en la sección no hay ningún campo de guía.
  const json = JSON.stringify(s3);
  ok(!/"guia_valor"|"guidance"|"guia_min"|"guia_max"/.test(json),
    'no hay ningún número de guía en la respuesta, solo el enlace al 8-K');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La cobertura parcial se declara donde duele');
{
  const conSerie = { serie: [{ familia: 'ingresos', period_end: '2025-12-31', val: 1, accession: 'a', cita: '[a]', revisado: false }] };

  const parcial = armarSecciones({ emisor: EMISOR_PARCIAL, ...conSerie }, {});
  ok(sec(parcial, 'prometido_vs_entregado').declaraciones.some((d) => d.codigo === 'cobertura_parcial'),
    'un 20-F declara cobertura parcial EN la sección de la serie');
  ok(declaracionesGlobales(EMISOR_PARCIAL, 'es')[0].codigo === 'cobertura_parcial',
    'y encabeza las declaraciones globales: se ve antes de sacar conclusiones');

  const completa = armarSecciones({ emisor: EMISOR, ...conSerie }, {});
  ok(!sec(completa, 'prometido_vs_entregado').declaraciones.some((d) => d.codigo === 'cobertura_parcial'),
    'un 10-K filer no lleva esa etiqueta');
  ok(!declaracionesGlobales(EMISOR, 'es').some((d) => d.codigo === 'cobertura_parcial'), 'ni en las globales');

  // El emisor parcial SÍ aparece: se etiqueta, no se esconde.
  eq(sec(parcial, 'prometido_vs_entregado').estado, 'con_documentos',
    'y su sección se muestra igual: el extranjero se etiqueta, no se oculta');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── "Dónde se rompe la historia" no es opcional (§8)');
{
  // Sin contraevidencia: se dice, con una frase falsable.
  const limpia = armarSecciones({ emisor: EMISOR }, {});
  eq(limpia.contraevidencia.estado, 'sin_contraevidencia', 'sin contraevidencia el estado lo dice');
  eq(limpia.contraevidencia.declaraciones[0].codigo, 'sin_contraevidencia', 'con su declaración');
  ok(/No encontramos contraevidencia/.test(limpia.contraevidencia.declaraciones[0].texto),
    'y la frase es falsable: no es un hueco en blanco ni un relleno');

  // Con un 8-K 4.02 — "no confíen en los estados financieros anteriores" —
  // que es la contraevidencia más literal que EDGAR produce.
  const conRuptura = armarSecciones({
    emisor: EMISOR,
    ruptura: [{ ...doc('acc-402', '8-K', '4.02'), cita: '[acc-402]' }],
  }, {});
  eq(conRuptura.contraevidencia.estado, 'con_documentos', 'un 8-K 4.02 es contraevidencia');
  eq(conRuptura.contraevidencia.documentos[0].cita, '[acc-402]', 'con su cita');
  eq(conRuptura.contraevidencia.declaraciones.length, 0, 'y ya no hace falta la frase de "no encontramos"');

  // La re-expresión también es contraevidencia: la empresa se corrigió sola.
  const conRevision = armarSecciones({
    emisor: EMISOR,
    serie: [
      { familia: 'ingresos', period_end: '2025-03-31', val: 100, revisado: true, accession: 'a1', cita: '[a1]', filed: '2025-05-01' },
      { familia: 'ingresos', period_end: '2025-06-30', val: 200, revisado: false, accession: 'a2', cita: '[a2]', filed: '2025-08-01' },
    ],
  }, {});
  eq(conRevision.contraevidencia.estado, 'con_documentos', 'un periodo re-expresado también rompe la historia');
  eq(conRevision.contraevidencia.periodos_reexpresados.length, 1, 'y se lista solo el revisado');
  eq(conRevision.contraevidencia.periodos_reexpresados[0].cita, '[a1]', 'con su cita y su fecha de presentación');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Nada sale sin cita');
{
  const r = armarSecciones({
    emisor: EMISOR,
    direccion: [{ ...doc('acc-1', '8-K', '5.02'), cita: '[acc-1]' }],
    serie: [
      { familia: 'ingresos', period_end: '2025-12-31', val: 300, revisado: false, derived: true, accession: 'acc-10k', accession_aux: 'acc-10q', cita: '[acc-10k]', cita_aux: '[acc-10q]' },
      { familia: 'ingresos', period_end: '2025-09-30', val: 700, revisado: false, derived: false, accession: 'acc-10q', accession_aux: null, cita: '[acc-10q]', cita_aux: null },
    ],
  }, {});

  const docs = r.secciones.flatMap((s) => s.documentos);
  ok(docs.length > 0 && docs.every((d) => d.cita), 'todo documento que sale lleva su cita');

  const serie = sec(r, 'prometido_vs_entregado').serie;
  ok(serie.every((p) => p.cita), 'todo punto de la serie lleva su cita');

  const derivado = serie.find((p) => p.derived);
  eq(derivado.cita_aux, '[acc-10q]', 'y el Q4 derivado lleva la SEGUNDA: salió de una resta entre dos filings');
  ok(serie.find((p) => !p.derived).cita_aux === null, 'un trimestre directo no inventa una segunda cita');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las consultas');
{
  const capturar = () => {
    const hechas = [];
    return { hechas, lectura: crearLectura({ sql: async (q, p) => { hechas.push([q.replace(/\s+/g, ' ').trim(), p]); return []; } }) };
  };

  {
    const { hechas, lectura } = capturar();
    await lectura.emisorPorTicker('meli');
    ok(/upper\(ticker\) = upper\(\$1\)/.test(hechas[0][0]), 'el ticker se compara sin importar mayúsculas');
    hondo(hechas[0][1], ['meli'], 'y viaja como parámetro, no concatenado');
  }

  {
    const { hechas, lectura } = capturar();
    await lectura.porItems('0001099590', ITEMS_RESULTADOS);
    const [q, p] = hechas[0];
    ok(/join company_filing_items/.test(q), 'los items se buscan en la tabla hija, no con un like frágil');
    ok(/i\.item in \(\$2, \$3\)/.test(q), 'con placeholders explícitos, no con un any() que dependa del driver');
    hondo(p, ['0001099590', '2.02', '7.01'], 'los items van como parámetros');
    ok(/order by f\.filed desc/.test(q), 'y ordenados por fecha de presentación');
  }

  {
    const { hechas, lectura } = capturar();
    await lectura.porFormas('1', [...FORMAS_PROPIEDAD, ...FORMAS_PELEA]);
    hondo(hechas[0][1].slice(1), [...FORMAS_PROPIEDAD, ...FORMAS_PELEA], 'las formas de la pregunta 2, completas');
  }

  {
    const { hechas, lectura } = capturar();
    await lectura.serie('1', ['ingresos']);
    const [q] = hechas[0];
    // La vista ya resolvió el alias, la re-expresión y el YoY (rebanada B).
    // Leer company_facts acá sería rehacer —y volver a equivocar— las tres.
    ok(/from company_quarterly/.test(q), 'la serie sale de la VISTA, no de company_facts');
    ok(/yoy_pct/.test(q) && /revisado/.test(q), 'y trae el YoY y la marca de revisado ya calculados');
    ok(/accession_aux/.test(q), 'más la segunda cita del Q4 derivado');
  }

  // Ninguna consulta escribe. Es la restricción del endpoint entero.
  {
    const { hechas, lectura } = capturar();
    await lectura.emisorPorTicker('X');
    await lectura.porItems('1', ITEMS_DIRECCION);
    await lectura.porItems('1', ITEMS_RUPTURA);
    await lectura.porFormas('1', ['DEF 14A']);
    await lectura.serie('1');
    ok(hechas.every(([q]) => /^select/i.test(q)), 'todas las consultas son SELECT: cero escrituras');
  }

  // Una lista vacía no genera una consulta con un `in ()` inválido.
  {
    const { hechas, lectura } = capturar();
    hondo(await lectura.porItems('1', []), [], 'sin items no hay consulta');
    hondo(await lectura.porFormas('1', []), [], 'sin formas tampoco');
    eq(hechas.length, 0, 'y no se manda un `in ()` que Postgres rechazaría');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las declaraciones globales van siempre, no solo cuando falta algo');
{
  const g = declaracionesGlobales(EMISOR, 'es');
  const codigos = g.map((d) => d.codigo);
  for (const c of ['transcripts', 'alt_data', 'expert_networks', 'competidores_privados', 'fts_desde_2001']) {
    ok(codigos.includes(c), `el perímetro declara: ${c}`);
  }
  ok(g.every((d) => d.texto && d.texto !== d.codigo), 'y cada una con su texto resuelto');
  ok(declaracionesGlobales(EMISOR, 'en').every((d) => d.texto), 'también en inglés');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── armarHistoria: los dos estados que más fácil mienten');
{
  const lecturaFalsa = (emisor) => ({
    emisorPorTicker: async () => emisor,
    porItems: async () => [],
    porFormas: async () => [],
    serie: async () => [],
  });

  // Un ticker que no está en el catálogo.
  {
    const { status, cuerpo } = await armarHistoria(lecturaFalsa(null), 'NOEXISTE', {});
    eq(status, 200, 'no es un 404: que no lo tengamos no es un error del usuario');
    eq(cuerpo.estado, 'desconocido', 'el estado lo dice');
    ok(/se siembra con/i.test(cuerpo.detalle), 'y el detalle dice cómo agregarlo');
    hondo(cuerpo.secciones, [], 'sin secciones inventadas');
  }

  // En el catálogo pero sin ingerir. Es LA distinción: "todavía no la bajamos"
  // no es "esta empresa no tiene historia".
  {
    const { cuerpo } = await armarHistoria(
      lecturaFalsa({ ...EMISOR, ultima_ingesta: null }), 'MELI', {});
    eq(cuerpo.estado, 'sin_ingesta', 'sembrado pero sin ingerir tiene su propio estado');
    ok(/goteo/.test(cuerpo.detalle), 'y apunta al goteo, que es lo que falta correr');
    ok(!cuerpo.emisor, 'no se devuelve un perfil a medias que parezca completo');
  }

  // Ingerido: la historia entera.
  {
    const { cuerpo } = await armarHistoria(lecturaFalsa(EMISOR), 'MELI', {});
    eq(cuerpo.estado, 'ok', 'con ingesta, la historia sale');
    eq(cuerpo.emisor.cik, EMISOR.cik, 'con su emisor');
    eq(cuerpo.secciones.length, 7, 'las siete secciones');
    ok(cuerpo.contraevidencia, 'la contraevidencia, que no es opcional');
    ok(cuerpo.no_cubierto.length >= 5, 'y el perímetro de lo que NO cubrimos');
    ok(/0000320193-25-000073/.test(cuerpo.formato_cita), 'con el formato de cita a la vista');
    eq(cuerpo.fuente, 'SEC EDGAR', 'y la fuente declarada');
  }

  // El idioma llega hasta las declaraciones.
  {
    const { cuerpo } = await armarHistoria(lecturaFalsa(EMISOR), 'MELI', { lang: 'en' });
    ok(cuerpo.no_cubierto.some((d) => /not covered/i.test(d.texto)), 'en inglés las declaraciones vienen en inglés');
  }
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
