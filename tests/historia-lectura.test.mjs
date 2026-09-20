// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-lectura.js — UNA línea de tiempo, siete filtros.
//
// Lo que se prueba acá es lo que decide si el módulo miente o no:
//
//   1. **Un documento es UN evento.** Un 8-K con 5.02, 2.02 y 1.01 aparece
//      una sola vez en la línea y las tres preguntas lo apuntan por
//      accession. La versión vieja lo copiaba tres veces y lo contaba tres
//      veces; eso decía "pasaron tres cosas" cuando pasó una.
//   2. **Todo evento cae bajo al menos una pregunta.** Un evento sin pregunta
//      sería invisible con los filtros puestos: entra a la consulta y no lo
//      alcanza ningún chip. Es la prueba que amarra el perímetro de la
//      consulta con el mapa item→pregunta.
//   3. **El 9.01 no es el evento.** Aparece en casi todos los 8-K y solo dice
//      "adjunté un archivo". Va como secundario, y el resumen no lo cuenta
//      como tema. Un 7.01 SOLO sí es el evento: ahí la empresa no anunció
//      nada más.
//   4. **Los tres vacíos se distinguen.** `sin_documentos` (se cubre, se
//      buscó, no hay) · `no_cubierta` (no miramos esa fuente) ·
//      `fuera_del_modulo` (existe en QuantDesk, no en EDGAR).
//   5. **Nada sale sin cita.** Todo evento trae `[accession]` y todo punto de
//      la serie también; un Q4 derivado trae las DOS.
//   6. **La contraevidencia no es opcional** (§8).
//   7. **No se muestra ningún número de guía.** G5 midió 0/4 emisores con
//      guía etiquetada: se enlaza el 8-K y se declara.
//   8. **Las consultas leen la VISTA, no la tabla** — la vista ya resolvió el
//      alias, la re-expresión y el YoY (rebanada B).
//
// Correr con `node tests/historia-lectura.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  DECLARACIONES, declarar, cita, crearLectura, armarEvento, armarSecciones, armarHistoria,
  declaracionesGlobales, ITEMS_INTERES, FORMAS_INTERES, FORMAS_PROPIEDAD, FORMAS_PELEA,
} from '../api/_lib/historia-lectura.js';
import { preguntasDe, PREGUNTAS_DE_ITEM, PREGUNTAS_DE_FORMA } from '../api/_lib/historia-glosario.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const sec = (r, id) => r.secciones.find((s) => s.id === id);
const fila = (accession, form, items = '', filed = '2026-02-20') => ({
  accession, form, items_raw: items, filed, report_date: null,
  url: `https://www.sec.gov/Archives/${accession}.htm`,
  index_url: `https://www.sec.gov/Archives/${accession}/index.json`,
});
const ev = (...args) => armarEvento(fila(...args));

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

  ok(/licencia comercial/.test(DECLARACIONES.transcripts.es), 'transcripts dice por qué no están');
  ok(/20-F/.test(DECLARACIONES.cobertura_parcial.es), 'la cobertura parcial nombra la forma');
  ok(/No es short interest/.test(DECLARACIONES.short_volume_no_es_short_interest.es),
    'short volume y short interest no se confunden: la UI lo dice');
  // La línea es un recorte, y el recorte se declara: un vacío se lee como
  // ausencia si nadie dice que ahí no se miró.
  ok(/Formas 3\/4\/5/.test(DECLARACIONES.linea_perimetro.es),
    'el perímetro de la línea nombra lo que deja fuera, empezando por los insiders');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La cita (decisión 8 de §10)');
{
  eq(cita('0000320193-25-000073'), '[0000320193-25-000073]', 'el identificador se VE, con corchetes');
  eq(cita(null), null, 'sin accession no hay cita inventada');
  eq(cita(''), null, 'ni con cadena vacía');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Un documento es UN evento, con todos sus temas');
{
  const e = ev('acc-multi', '8-K', '5.02,2.02,1.01,9.01', '2022-03-29');

  hondo(e.preguntas, [1, 3, 7], 'el 8-K de tres temas alcanza las tres preguntas');
  hondo(e.items_destacados, ['5.02', '2.02', '1.01'], 'los tres temas quedan destacados: ninguno se elige por el lector');
  hondo(e.items_secundarios, ['9.01'], 'y solo el adjunto baja');
  eq(e.accession, 'acc-multi', 'y es un solo objeto, no tres copias');
  eq(e.cita, '[acc-multi]', 'con su cita');

  const r = armarSecciones({ emisor: EMISOR, eventos: [e] }, {});
  hondo(sec(r, 'direccion').accessions, ['acc-multi'], 'la pregunta 1 lo apunta');
  hondo(sec(r, 'prometido_vs_entregado').accessions, ['acc-multi'], 'la 3 también');
  hondo(sec(r, 'catalizador').accessions, ['acc-multi'], 'y la 7');

  // El bug que la estructura vieja tenía y nadie veía: el mismo papel sumaba
  // 1 en tres resúmenes distintos, y "12 filings" en tres secciones sobre 20
  // papeles es una cifra correcta sobre el conjunto equivocado.
  const totales = r.secciones.map((s) => s.resumen.total).reduce((a, b) => a + b, 0);
  eq(totales, 3, 'suma 3 apariciones de UN documento — y eso se ve, porque la línea dice que es uno');
  const json = JSON.stringify(r.secciones);
  eq(json.split('"acc-multi"').length - 1, 3, 'el accession aparece 3 veces como referencia');
  ok(!/"url"/.test(json), 'pero el documento NO se copia: las secciones no llevan urls ni glosas duplicadas');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Todo evento cae bajo al menos una pregunta');
{
  // Si un item entra al perímetro de la consulta y no mapea a ninguna
  // pregunta, ese evento aparece en la línea y ningún filtro lo alcanza.
  for (const item of ITEMS_INTERES) {
    const e = ev('a', '8-K', item);
    ok(e.preguntas.length > 0, `el item ${item} tiene al menos una pregunta`);
  }
  for (const forma of FORMAS_INTERES) {
    ok(preguntasDe({ form: forma }).length > 0, `la forma ${forma} tiene al menos una pregunta`);
  }

  // Y al revés, que es el que se olvida: una pregunta declarada para un item
  // que la consulta nunca trae es cobertura anunciada que no existe. Si algún
  // día el 5.07 entra al mapa, esta prueba obliga a meterlo también al
  // perímetro — o a sacarlo del mapa.
  for (const item of Object.keys(PREGUNTAS_DE_ITEM)) {
    ok(ITEMS_INTERES.includes(item), `el item ${item} del mapa está en el perímetro de la consulta`);
  }
  for (const forma of Object.keys(PREGUNTAS_DE_FORMA)) {
    ok(FORMAS_INTERES.includes(forma), `la forma ${forma} del mapa está en el perímetro de la consulta`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El 9.01 no es el evento (y un 7.01 solo, sí)');
{
  const conAdjunto = ev('a1', '8-K', '2.02,9.01');
  eq(conAdjunto.item_principal, '2.02', 'con un 2.02 al lado, el 9.01 no es el tema');
  hondo(conAdjunto.items_destacados, ['2.02'], 'y el tema queda destacado');
  hondo(conAdjunto.items_secundarios, ['9.01'], 'el adjunto queda como secundario, no escondido');
  ok(conAdjunto.items.includes('9.01'), 'y sigue en la lista completa: se apaga, no se borra');

  const guiaConResultados = ev('a2', '8-K', '2.02,7.01,9.01');
  eq(guiaConResultados.item_principal, '2.02', 'un 7.01 que acompaña a un 2.02 es el complemento');
  hondo(guiaConResultados.items_secundarios, ['7.01', '9.01'], 'y baja con el adjunto');

  // La corrección que importa: el 7.01 SOLO es el evento. Ahí la empresa no
  // presentó resultados ni firmó nada — lo único que hizo fue decir algo.
  const soloGuia = ev('a3', '8-K', '7.01,9.01');
  eq(soloGuia.item_principal, '7.01', 'un 7.01 sin nada más SÍ es el evento');
  hondo(soloGuia.items_secundarios, ['9.01'], 'con el adjunto abajo');
  hondo(soloGuia.preguntas, [3], 'y cuenta para la pregunta 3');

  // El resumen no puede decir que el tema más frecuente de la empresa es
  // "adjunté un archivo".
  const r = armarSecciones({ emisor: EMISOR, eventos: [conAdjunto, guiaConResultados, soloGuia] }, {});
  const resumen = sec(r, 'prometido_vs_entregado').resumen;
  eq(resumen.por_item['9.01'], undefined, 'el 9.01 no cuenta como tema en el resumen');
  eq(resumen.por_item['2.02'], 2, 'los 2.02 sí');
  eq(resumen.por_item['7.01'], 1, 'y el 7.01 solo cuenta como tema una vez: el que iba solo');
  eq(resumen.por_item_secundario['9.01'], 3, 'y los adjuntos se cuentan aparte, a la vista');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las 7 secciones con documentos');
{
  const eventos = [
    ev('acc-502', '8-K', '5.02', '2026-02-20'),
    ev('acc-def', 'DEF 14A', '', '2026-02-19'),
    ev('acc-13d', 'SC 13D', '', '2026-02-18'),
    ev('acc-prec', 'PREC14A', '', '2026-02-17'),
    ev('acc-202', '8-K', '2.02', '2026-02-16'),
    ev('acc-101', '8-K', '1.01', '2026-02-15'),
  ];
  const r = armarSecciones({
    emisor: EMISOR,
    eventos,
    serie: [{ familia: 'ingresos', period_end: '2025-12-31', val: 6000, yoy_pct: 12.3, revisado: false, derived: false, accession: 'acc-10k', cita: '[acc-10k]', cita_aux: null, filed: '2026-02-20' }],
  }, {});

  eq(r.secciones.length, 7, 'son siete secciones, siempre');
  hondo(r.secciones.map((s) => s.pregunta), [1, 2, 3, 4, 5, 6, 7], 'y van en el orden del esqueleto');

  hondo(sec(r, 'direccion').accessions, ['acc-502', 'acc-def'], 'la pregunta 1 junta el 8-K 5.02 con el proxy');
  eq(sec(r, 'direccion').estado, 'con_documentos', 'y se marca como cubierta con documentos');
  hondo(sec(r, 'propiedad').accessions, ['acc-13d', 'acc-prec'], 'la pregunta 2 junta 13D con la pelea de proxies');
  eq(sec(r, 'prometido_vs_entregado').serie.length, 1, 'la pregunta 3 trae la serie');
  hondo(sec(r, 'catalizador').accessions, ['acc-101'], 'la pregunta 7 trae los eventos anunciados');

  eq(sec(r, 'propiedad').episodios.length, 1, 'la pelea por el consejo se agrupa en un episodio');
  ok(r.secciones.every((s) => Array.isArray(s.declaraciones)), 'toda sección trae su lista de declaraciones');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El 5.07: el desenlace entra a la línea, el veredicto no');
{
  // Sin el 5.07, la pregunta 2 mostraba 34 filings de campaña y CERO del
  // resultado de la votación. El desenlace existe en EDGAR.
  ok(ITEMS_INTERES.includes('5.07'), 'el 5.07 está en el perímetro de la consulta');

  const campania = ev('acc-dfan', 'DFAN14A', '', '2026-05-20');
  const cierre = ev('acc-507', '8-K', '5.07,9.01', '2026-06-10');
  hondo(cierre.preguntas, [2], 'el resultado de la asamblea cae bajo la pregunta 2');
  eq(cierre.item_principal, '5.07', 'y el 5.07 es el tema, no el adjunto');

  const r = armarSecciones({ emisor: EMISOR, eventos: [cierre, campania] }, {});
  const s2 = sec(r, 'propiedad');
  hondo(s2.accessions, ['acc-507', 'acc-dfan'], 'la pregunta 2 ahora tiene la campaña Y su cierre');

  // La línea que no se cruza: mostrar el documento no es decir quién ganó.
  // El 5.07 trae los votos; interpretarlos es Fase B.
  const json = JSON.stringify({ evento: cierre, seccion: s2 });
  ok(!/(gan[óo]|perdi[óo]|aprob|rechaz|derrot|triunf|won|lost|approv|reject|defeat)/i.test(json),
    'ni el evento ni la sección dicen cómo salió la votación');
  ok(!/"resultado_votacion"|"votos"|"a_favor"|"en_contra"|"margen"/.test(json),
    'y no se inventa ningún campo de votos: el papel se enlaza, no se resume');

  // El 5.07 NO es un filing de campaña: el episodio no lo cuenta.
  eq(s2.episodios.length, 1, 'el episodio de la pelea sigue existiendo');
  eq(s2.episodios[0].total, 1, 'y cuenta solo el filing de solicitación, no el cierre');
  eq(s2.episodios[0].por_forma['8-K'], undefined, 'el 8-K del resultado no engorda el conteo de la pelea');

  // Y sigue siendo UN documento: el 5.07 con adjunto no se parte en dos.
  hondo(cierre.items_destacados, ['5.07'], 'el tema queda destacado');
  hondo(cierre.items_secundarios, ['9.01'], 'y el adjunto baja, como en cualquier otro 8-K');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Los tres vacíos NO son el mismo vacío');
{
  const r = armarSecciones({ emisor: EMISOR }, {});

  // Se cubre, se buscó, no hay. Es una afirmación sobre LA EMPRESA.
  eq(sec(r, 'direccion').estado, 'sin_documentos', 'sin 8-K 5.02: "sin documentos", no "no cubierta"');
  eq(sec(r, 'propiedad').estado, 'sin_documentos', 'lo mismo para 13D y proxies');
  eq(sec(r, 'catalizador').estado, 'sin_documentos', 'y para los eventos');
  hondo(sec(r, 'direccion').accessions, [], 'y el hueco queda vacío: nunca relleno');

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
  eq(sec(r, 'gerencia').accessions.length, 0, 'una sección no cubierta tampoco inventa documentos');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La pregunta 3: la guía se enlaza, no se guarda');
{
  const r = armarSecciones({
    emisor: EMISOR,
    eventos: [ev('acc-202', '8-K', '2.02')],
    serie: [{ familia: 'ingresos', period_end: '2025-12-31', val: 6000, accession: 'a', cita: '[a]', revisado: false, derived: false }],
  }, {});
  const s3 = sec(r, 'prometido_vs_entregado');

  ok(s3.declaraciones.some((d) => d.codigo === 'guia_no_estructurada'),
    'la sección declara que la guía no viene estructurada');
  ok(/No se guarda ningún número de guía/.test(s3.declaraciones.find((d) => d.codigo === 'guia_no_estructurada').texto),
    'y lo dice explícito: G5 midió 0/4 emisores con guía etiquetada');

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

  eq(sec(parcial, 'prometido_vs_entregado').estado, 'con_documentos',
    'y su sección se muestra igual: el extranjero se etiqueta, no se oculta');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── "Dónde se rompe la historia" no es opcional (§8)');
{
  const limpia = armarSecciones({ emisor: EMISOR }, {});
  eq(limpia.contraevidencia.estado, 'sin_contraevidencia', 'sin contraevidencia el estado lo dice');
  eq(limpia.contraevidencia.declaraciones[0].codigo, 'sin_contraevidencia', 'con su declaración');
  ok(/No encontramos contraevidencia/.test(limpia.contraevidencia.declaraciones[0].texto),
    'y la frase es falsable: no es un hueco en blanco ni un relleno');

  // Un 8-K 4.02 — "no confíen en los estados financieros anteriores" — es la
  // contraevidencia más literal que EDGAR produce. Y es el caso donde el
  // filtro importa: el mismo papel cuenta en la pregunta 3 Y en la ruptura,
  // sin duplicarse.
  const e402 = ev('acc-402', '8-K', '4.02');
  const conRuptura = armarSecciones({ emisor: EMISOR, eventos: [e402] }, {});
  eq(conRuptura.contraevidencia.estado, 'con_documentos', 'un 8-K 4.02 es contraevidencia');
  hondo(conRuptura.contraevidencia.accessions, ['acc-402'], 'con su accession, que enlaza a la línea');
  eq(e402.contraevidencia, true, 'y el evento viene marcado desde la línea');
  eq(conRuptura.contraevidencia.declaraciones.length, 0, 'y ya no hace falta la frase de "no encontramos"');

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
  const eventos = [ev('acc-1', '8-K', '5.02')];
  const r = armarSecciones({
    emisor: EMISOR,
    eventos,
    serie: [
      { familia: 'ingresos', period_end: '2025-12-31', val: 300, revisado: false, derived: true, accession: 'acc-10k', accession_aux: 'acc-10q', cita: '[acc-10k]', cita_aux: '[acc-10q]' },
      { familia: 'ingresos', period_end: '2025-09-30', val: 700, revisado: false, derived: false, accession: 'acc-10q', accession_aux: null, cita: '[acc-10q]', cita_aux: null },
    ],
  }, {});

  ok(eventos.length > 0 && eventos.every((e) => e.cita && e.url), 'todo evento lleva su cita Y su enlace');

  const serie = sec(r, 'prometido_vs_entregado').serie;
  ok(serie.every((p) => p.cita), 'todo punto de la serie lleva su cita');

  const derivado = serie.find((p) => p.derived);
  eq(derivado.cita_aux, '[acc-10q]', 'y el Q4 derivado lleva la SEGUNDA: salió de una resta entre dos filings');
  ok(serie.find((p) => !p.derived).cita_aux === null, 'un trimestre directo no inventa una segunda cita');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las consultas: dos, no ocho');
{
  const capturar = (filas = []) => {
    const hechas = [];
    return { hechas, lectura: crearLectura({ sql: async (q, p) => { hechas.push([q.replace(/\s+/g, ' ').trim(), p]); return filas; } }) };
  };

  {
    const { hechas, lectura } = capturar();
    await lectura.emisorPorTicker('meli');
    ok(/upper\(ticker\) = upper\(\$1\)/.test(hechas[0][0]), 'el ticker se compara sin importar mayúsculas');
    hondo(hechas[0][1], ['meli'], 'y viaja como parámetro, no concatenado');
  }

  {
    const { hechas, lectura } = capturar();
    await lectura.eventos('0001099590');
    const [q, p] = hechas[0];
    // El `exists` en vez del join con distinct: un filing con tres items de
    // interés devuelve UN renglón por construcción, no por deduplicar a mano.
    ok(/exists \(select 1 from company_filing_items/.test(q),
      'los items se buscan con exists: un filing con tres items da UN renglón');
    ok(!/distinct/.test(q), 'no hace falta distinct, y por eso no hay que confiar en él');
    ok(/f\.form in \(/.test(q) && /i\.item in \(/.test(q), 'entran las formas de interés O los items de interés');
    ok(/\$2/.test(q) && !/'DEF 14A'/.test(q), 'con placeholders explícitos, no valores concatenados');
    hondo(p, ['0001099590', ...FORMAS_INTERES, ...ITEMS_INTERES], 'el perímetro entero viaja como parámetros');
    ok(/order by f\.filed desc/.test(q), 'y ordenados por fecha de presentación: la línea es cronológica');
  }

  {
    const { hechas, lectura } = capturar();
    await lectura.serie('1', ['ingresos']);
    const [q] = hechas[0];
    // La vista ya resolvió el alias, la re-expresión y el YoY (rebanada B).
    ok(/from company_quarterly/.test(q), 'la serie sale de la VISTA, no de company_facts');
    ok(/yoy_pct/.test(q) && /revisado/.test(q), 'y trae el YoY y la marca de revisado ya calculados');
    ok(/accession_aux/.test(q), 'más la segunda cita del Q4 derivado');
  }

  // Ninguna consulta escribe. Es la restricción del endpoint entero.
  {
    const { hechas, lectura } = capturar();
    await lectura.emisorPorTicker('X');
    await lectura.eventos('1');
    await lectura.serie('1');
    ok(hechas.every(([q]) => /^select/i.test(q)), 'todas las consultas son SELECT: cero escrituras');
  }

  // Una lista vacía de familias no genera un `in ()` que Postgres rechazaría.
  {
    const { hechas, lectura } = capturar();
    hondo(await lectura.serie('1', []), [], 'sin familias no hay consulta');
    eq(hechas.length, 0, 'y no se manda un `in ()` inválido');
  }

  // El total verdadero sale de la ventana, no del largo de la página.
  {
    const { lectura } = capturar([{ ...fila('a', '8-K', '5.02'), total_general: '412' }]);
    const { filas, total } = await lectura.eventos('1');
    eq(total, 412, 'el total es el de TODOS los que matchearon, no el de la muestra');
    eq(filas.length, 1, 'aunque solo venga uno');
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
console.log('\n── armarHistoria: la línea, y los dos estados que más fácil mienten');
{
  const lecturaFalsa = (emisor, filas = [], total = null) => ({
    emisorPorTicker: async () => emisor,
    eventos: async () => ({ filas, total: total == null ? filas.length : total }),
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

  // En el catálogo pero sin ingerir.
  {
    const { cuerpo } = await armarHistoria(lecturaFalsa({ ...EMISOR, ultima_ingesta: null }), 'MELI', {});
    eq(cuerpo.estado, 'sin_ingesta', 'sembrado pero sin ingerir tiene su propio estado');
    ok(/goteo/.test(cuerpo.detalle), 'y apunta al goteo, que es lo que falta correr');
    ok(!cuerpo.emisor, 'no se devuelve un perfil a medias que parezca completo');
  }

  // Ingerido: la historia entera, con su línea.
  {
    const filas = [
      fila('acc-a', '8-K', '5.02,2.02,9.01', '2026-03-01'),
      fila('acc-b', 'SC 13D', '', '2026-01-15'),
    ];
    const { cuerpo } = await armarHistoria(lecturaFalsa(EMISOR, filas), 'MELI', {});
    eq(cuerpo.estado, 'ok', 'con ingesta, la historia sale');
    eq(cuerpo.emisor.cik, EMISOR.cik, 'con su emisor');
    eq(cuerpo.secciones.length, 7, 'las siete secciones');

    const L = cuerpo.linea_de_tiempo;
    eq(L.eventos.length, 2, 'la línea trae los eventos UNA vez cada uno');
    eq(L.total, 2, 'con su total');
    eq(L.truncado, false, 'y sin recorte');
    eq(L.desde, '2026-01-15', 'la línea declara desde cuándo');
    eq(L.hasta, '2026-03-01', 'y hasta cuándo');
    hondo(L.eventos.map((e) => e.filed), ['2026-03-01', '2026-01-15'], 'en orden cronológico inverso: lo último primero');
    ok(L.declaraciones.some((d) => d.codigo === 'linea_perimetro'),
      'y declara su perímetro: lo que NO está en la línea no es lo que no pasó');

    // Cada evento es alcanzable por al menos un filtro.
    const alcanzados = new Set(cuerpo.secciones.flatMap((s) => s.accessions));
    ok(L.eventos.every((e) => alcanzados.has(e.accession)),
      'todo evento de la línea lo alcanza al menos una pregunta: ninguno queda invisible con los filtros puestos');

    ok(cuerpo.contraevidencia, 'la contraevidencia, que no es opcional');
    ok(cuerpo.no_cubierto.length >= 5, 'y el perímetro de lo que NO cubrimos');
    ok(/0000320193-25-000073/.test(cuerpo.formato_cita), 'con el formato de cita a la vista');
    eq(cuerpo.fuente, 'SEC EDGAR', 'y la fuente declarada');
  }

  // Si la línea se recorta, se dice. Un conteo de 900 con 2 renglones a la
  // vista es correcto sobre el total y mentira sobre la lista.
  {
    const filas = [fila('acc-a', '8-K', '5.02', '2026-03-01')];
    const { cuerpo } = await armarHistoria(lecturaFalsa(EMISOR, filas, 900), 'MELI', {});
    eq(cuerpo.linea_de_tiempo.truncado, true, 'la línea recortada se marca');
    eq(cuerpo.linea_de_tiempo.total, 900, 'con el total verdadero');
    eq(cuerpo.linea_de_tiempo.mostrados, 1, 'y con cuántos se muestran');
    ok(cuerpo.linea_de_tiempo.declaraciones.some((d) => d.codigo === 'linea_truncada'), 'y se declara en texto');
    ok(sec(cuerpo, 'direccion').resumen.truncado, 'y el resumen de cada sección hereda la duda: puede faltar');
  }

  // El idioma llega hasta las declaraciones.
  {
    const { cuerpo } = await armarHistoria(lecturaFalsa(EMISOR), 'MELI', { lang: 'en' });
    ok(cuerpo.no_cubierto.some((d) => /not covered/i.test(d.texto)), 'en inglés las declaraciones vienen en inglés');
  }
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
