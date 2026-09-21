// ═══════════════════════════════════════════════════════════════
// e2e/historia.mjs — la página de HISTORIA, en Chromium, con la API stubbeada.
//
// Los tests de node prueban lo que el endpoint DEVUELVE. Esto prueba lo que el
// usuario VE, que es donde las reglas del módulo se rompen de verdad: un hueco
// sin etiqueta, un YoY nulo dibujado como 0%, una cita que no enlaza a nada.
//
// Lo que se verifica en el DOM, no en el JSON:
//
//   1. **Un documento sale UNA vez.** El 8-K con 5.02, 2.02 y 1.01 aparece en
//      un solo renglón con sus tres etiquetas. La versión de siete listas lo
//      pintaba tres veces sin decir que era el mismo papel.
//   2. **El 9.01 se apaga, no se borra.** Baja a la línea gris de "además
//      adjunta" y no cuenta como tema en el resumen.
//   3. **Los chips filtran la MISMA línea**, no abren siete listas.
//   4. Los TRES vacíos se ven distinto — y una pregunta NO CUBIERTA nunca
//      dice "buscamos y no hay", que es afirmar sobre la empresa algo que es
//      sobre nosotros.
//   5. Un YoY nulo sale "—", NUNCA 0%.
//   6. Toda cita enlaza a un documento abrible, y el Q4 derivado muestra SUS
//      DOS citas.
//   7. Cobertura parcial arriba y visible, antes de todo lo demás.
//
// Más la regla que no se negocia: **cero vocabulario de recomendación**.
//
//   node e2e/server.mjs &        # sirve el repo en :8931
//   node e2e/historia.mjs
// ═══════════════════════════════════════════════════════════════

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const BASE = 'http://127.0.0.1:8931/historia.html';
let fallas = 0;
const report = (nombre, ok, detalle) => {
  if (!ok) fallas++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + nombre + (detalle ? ' | ' + detalle : ''));
};

// ── Las glosas, como las manda el servidor ───────────────────────────────
const G = {
  '5.02': { codigo: '5.02', oficial: 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers', glosa: 'salida, nombramiento o compensación de directivos o consejeros' },
  '2.02': { codigo: '2.02', oficial: 'Results of Operations and Financial Condition', glosa: 'publicó resultados del periodo' },
  '1.01': { codigo: '1.01', oficial: 'Entry into a Material Definitive Agreement', glosa: 'firmó un contrato material' },
  '4.02': { codigo: '4.02', oficial: 'Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review', glosa: 'avisó que no se puede confiar en estados financieros ya publicados' },
  '7.01': { codigo: '7.01', oficial: 'Regulation FD Disclosure', glosa: 'divulgación bajo Regulation FD' },
  '5.07': { codigo: '5.07', oficial: 'Submission of Matters to a Vote of Security Holders', glosa: 'resultados de la votación de accionistas' },
  '9.01': { codigo: '9.01', oficial: 'Financial Statements and Exhibits', glosa: 'estados financieros y anexos' },
};
const F = {
  '8-K': { codigo: '8-K', oficial: 'Current Report', glosa: 'reporte de evento' },
  DFAN14A: { codigo: 'DFAN14A', oficial: 'Additional Definitive Proxy Soliciting Materials Filed by Non-Management', glosa: 'material de solicitación presentado por un tercero, no por la empresa' },
  // Una forma que SÍ está en el perímetro y que NO glosamos. Es el caso real
  // de un diccionario incompleto, no un formulario inventado.
  PRRN14A: { codigo: 'PRRN14A', oficial: null, glosa: null },
};

// El armado de un evento, igual que armarEvento() del servidor: el 9.01
// siempre baja, el 7.01 solo cuando lo acompaña otro item.
const evento = (accession, form, items, filed, preguntas, { contraevidencia = false } = {}) => {
  const sec = items.filter((i) => i === '9.01'
    || (i === '7.01' && items.some((o) => o !== '7.01' && o !== '9.01')));
  const des = items.filter((i) => !sec.includes(i));
  return {
    accession, form, filed, report_date: null,
    forma_glosa: F[form] || { codigo: form, oficial: null, glosa: null },
    items, items_glosa: items.map((i) => G[i]),
    item_principal: des[0] || items[0] || null,
    items_destacados: des, items_destacados_glosa: des.map((i) => G[i]),
    items_secundarios: sec, items_secundarios_glosa: sec.map((i) => G[i]),
    preguntas, contraevidencia, contienda: /14A$/.test(form),
    url: `https://www.sec.gov/${accession}.htm`,
    index_url: `https://www.sec.gov/${accession}/`,
    cita: `[${accession}]`,
  };
};

// El caso que da nombre a la rebanada: UN 8-K con tres temas, que antes salía
// tres veces y se contaba tres veces.
const MULTI = evento('0001-26-1', '8-K', ['5.02', '2.02', '1.01', '9.01'], '2026-02-20', [1, 3, 7]);
const EVENTOS = [
  // El cierre de la pelea: el único documento que dice cómo terminó la
  // votación. Va en la línea con los filings de campaña, en su lugar
  // cronológico — y sin decir quién ganó, que es Fase B.
  evento('0001-26-7', '8-K', ['5.07', '9.01'], '2026-06-10', [2]),
  evento('0001-26-3', 'DFAN14A', [], '2026-05-20', [2]),
  evento('0001-26-5', 'PRRN14A', [], '2026-04-01', [2]),
  evento('0001-26-9', '8-K', ['4.02'], '2026-03-01', [3], { contraevidencia: true }),
  MULTI,
  evento('0001-26-2', '8-K', ['2.02', '9.01'], '2026-01-15', [3]),
  // Un 7.01 SOLO: acá la empresa no reportó ni firmó nada, lo único que hizo
  // fue decir algo. Degradarlo escondería el único contenido del filing.
  evento('0001-25-7', '8-K', ['7.01', '9.01'], '2025-11-20', [3]),
];

const D = (lang = 'es') => ({
  ticker: 'MELI',
  estado: 'ok',
  emisor: { cik: '0001099590', nombre: 'MERCADOLIBRE INC', forma_anual: '10-K', cobertura: 'completa', ultima_ingesta: '2026-09-20T00:00:00Z' },
  formato_cita: '[0000320193-25-000073]',
  linea_de_tiempo: {
    eventos: EVENTOS, total: EVENTOS.length, mostrados: EVENTOS.length, truncado: false,
    desde: '2025-11-20', hasta: '2026-05-20',
    declaraciones: [{ codigo: 'linea_perimetro', texto: 'La línea muestra los documentos que alimentan las siete preguntas, no todos los filings. Quedan fuera las Formas 3/4/5 de insiders.' }],
  },
  secciones: [
    { id: 'direccion', pregunta: 1, estado: 'con_documentos', declaraciones: [],
      accessions: ['0001-26-1'],
      resumen: { total: 14, mostrados: 1, desde: '2021-12-03', hasta: '2026-09-15', por_item: { '5.02': 14 }, por_item_secundario: { '9.01': 14 }, por_forma: { '8-K': 14 }, truncado: true } },
    // La pelea por el consejo, que en una lista plana se pierde.
    { id: 'propiedad', pregunta: 2, estado: 'con_documentos', declaraciones: [],
      accessions: ['0001-26-7', '0001-26-3', '0001-26-5'],
      resumen: { total: 35, mostrados: 3, desde: '2025-12-15', hasta: '2026-06-10', por_forma: { DFAN14A: 30, PRRN14A: 2, DEFC14A: 2, '8-K': 1 }, por_item: { '5.07': 1 }, por_item_secundario: { '9.01': 1 }, truncado: true },
      episodios: [{ desde: '2025-12-15', hasta: '2026-05-20', dias: 156, total: 34,
        por_forma: { DFAN14A: 30, PRRN14A: 2, DEFC14A: 2 }, umbral_dias: 120, documentos: [] }] },
    { id: 'prometido_vs_entregado', pregunta: 3, estado: 'con_documentos',
      accessions: ['0001-26-9', '0001-26-1', '0001-26-2', '0001-25-7'],
      resumen: { total: 4, mostrados: 4, desde: '2025-11-20', hasta: '2026-03-01', por_forma: { '8-K': 4 }, por_item: { '4.02': 1, '2.02': 2, '5.02': 1, '1.01': 1, '7.01': 1 }, por_item_secundario: { '9.01': 3 }, truncado: false },
      serie: [
        // Un Q4 derivado: dos citas.
        { familia: 'ingresos', period_end: '2025-12-31', val: 6100000000, unit: 'USD', yoy_pct: 12.3, revisado: false, derived: true,
          accession: '0001-26-2', accession_aux: '0001-25-9', cita: '[0001-26-2]', cita_aux: '[0001-25-9]',
          url: 'https://www.sec.gov/y.htm', url_aux: 'https://www.sec.gov/z.htm', filed: '2026-02-20', form: '10-K' },
        // Un trimestre SIN YoY comparable: tiene que salir "—", no 0%.
        { familia: 'ingresos', period_end: '2025-09-30', val: 5200000000, unit: 'USD', yoy_pct: null, revisado: true, derived: false,
          accession: '0001-25-9', accession_aux: null, cita: '[0001-25-9]', cita_aux: null,
          url: 'https://www.sec.gov/z.htm', url_aux: null, filed: '2025-11-01', form: '10-Q' },
      ],
      declaraciones: [{ codigo: 'guia_no_estructurada', texto: lang === 'en' ? 'Guidance is not tagged.' : 'La guía no viene estructurada.' }] },
    // El vacío que habla de NOSOTROS.
    { id: 'gerencia', pregunta: 4, estado: 'no_cubierta', accessions: [],
      declaraciones: [{ codigo: 'transcripts', texto: lang === 'en' ? 'Question 4 — not covered.' : 'Pregunta 4 — no cubierta.' }] },
    { id: 'competencia', pregunta: 5, estado: 'no_cubierta', accessions: [],
      declaraciones: [{ codigo: 'pares_sin_mapa', texto: 'El mapa de pares todavía no existe.' }] },
    // El que manda a otro panel.
    { id: 'mercado', pregunta: 6, estado: 'fuera_del_modulo', accessions: [],
      declaraciones: [{ codigo: 'mercado_fuera_de_modulo', texto: 'Vive en el panel SMART $.' }] },
    { id: 'catalizador', pregunta: 7, estado: 'con_documentos', accessions: ['0001-26-1'], declaraciones: [],
      resumen: { total: 1, mostrados: 1, desde: '2026-02-20', hasta: '2026-02-20', por_forma: { '8-K': 1 }, por_item: { '5.02': 1, '2.02': 1, '1.01': 1 }, por_item_secundario: { '9.01': 1 }, truncado: false } },
  ],
  contraevidencia: {
    id: 'donde_se_rompe', estado: 'con_documentos',
    accessions: ['0001-26-9'],
    periodos_reexpresados: [{ familia: 'ingresos', period_end: '2025-09-30', cita: '[0001-25-9]', url: 'https://www.sec.gov/z.htm', filed: '2025-11-01' }],
    declaraciones: [],
  },
  no_cubierto: [
    { codigo: 'transcripts', texto: 'Transcripciones con licencia comercial: no se incluyen.' },
    { codigo: 'alt_data', texto: 'Sin datos alternativos.' },
    { codigo: 'expert_networks', texto: 'Sin expert networks.' },
  ],
  narracion: {
    estado: 'ok', hash: 'abc123', modelo: 'claude-opus-5', prompt_version: 1, creado_en: '2026-09-20T10:00:00Z',
    secciones: [
      { id: 'direccion', texto: 'El 2026-02-20 la empresa reportó un cambio de directivos junto con sus resultados [0001-26-1]. La misma presentación trae tres temas [0001-26-1] y se suma a los documentos de solicitación [0001-26-3] [0001-26-5] del mismo periodo, más la divulgación de noviembre [0001-25-7] y el reporte de enero [0001-26-2].' },
      { id: 'donde_se_rompe', texto: 'El 2026-03-01 avisó que no se puede confiar en estados financieros ya publicados [0001-26-9].' },
    ],
    declaraciones: [],
  },
  fuente: 'SEC EDGAR',
});

// El emisor sin nada: las siete preguntas vacías y una línea sin eventos.
const VACIO = () => {
  const d = D();
  d.ticker = 'NADA';
  d.linea_de_tiempo = { eventos: [], total: 0, mostrados: 0, truncado: false, desde: null, hasta: null, declaraciones: [] };
  d.secciones = d.secciones.map((s) => (s.estado === 'con_documentos'
    ? { ...s, estado: 'sin_documentos', accessions: [], resumen: undefined, serie: undefined, episodios: undefined }
    : { ...s, accessions: [] }));
  d.contraevidencia = { id: 'donde_se_rompe', estado: 'sin_contraevidencia', accessions: [], periodos_reexpresados: [],
    declaraciones: [{ codigo: 'sin_contraevidencia', texto: 'No encontramos contraevidencia en los filings.' }] };
  return d;
};

// El guardia cortó algo: se muestra lo que quedó Y se declara el hueco.
const CON_CORTES = () => {
  const d = D();
  d.narracion = {
    ...d.narracion,
    cortes: { afirmaciones_cortadas: 2, secciones_cortadas: 1,
      por_motivo: { cita_desconocida: 1, opinion: 1, seccion_vacia: 1 } },
    declaraciones: [{ codigo: 'narracion_cortada', texto: 'El guardia de citas cortó parte de esta lectura antes de guardarla. Lo que se muestra es lo que sobrevivió; lo cortado se cuenta abajo. Un hueco declarado es un dato, uno silencioso es un bug.' }],
  };
  return d;
};

// Sin lectura escrita: se declara, no se esconde.
const SIN_LECTURA = () => {
  const d = D();
  d.narracion = { estado: 'sin_narracion', hash: 'abc123', secciones: [],
    declaraciones: [{ codigo: 'sin_narracion', texto: 'Todavía no hay una lectura escrita de esta empresa. La narración se genera aparte y se guarda, no se escribe cada vez que alguien abre la página.' }] };
  return d;
};

// Con una cita que no resuelve: se retiene ENTERA.
const RETENIDA = () => {
  const d = D();
  d.narracion = { estado: 'retenida', hash: 'abc123', secciones: [], citas_desconocidas: ['0009-99-9'],
    declaraciones: [{ codigo: 'narracion_retenida', texto: 'La lectura escrita existe pero no se muestra: una de sus citas no resuelve a un documento de esta página.' }] };
  return d;
};

// Se intentó y falló. NO es lo mismo que no haberlo intentado.
const FALLIDA = () => {
  const d = D();
  d.narracion = { estado: 'fallida', hash: 'abc123', secciones: [], motivo: 'cortada', intentos: 2,
    declaraciones: [{ codigo: 'narracion_fallida', texto: 'Se intentó escribir la lectura y falló. No se muestra nada a medias: una narración cortada o rechazada, con las citas correctas hasta donde llegó, se lee como completa.' }] };
  return d;
};

const PARCIAL = () => {
  const d = D();
  d.ticker = 'VIST';
  d.emisor = { cik: '0001762506', nombre: 'Vista Energy', forma_anual: '20-F', cobertura: 'parcial', ultima_ingesta: '2026-09-20T00:00:00Z' };
  d.no_cubierto = [{ codigo: 'cobertura_parcial', texto: 'Cobertura parcial: este emisor presenta 20-F. La serie es anual, no trimestral.' }, ...d.no_cubierto];
  return d;
};

const nav = globalThis.process;
const browser = await chromium.launch();

async function abrir(respuesta, ruta = '/historia.html?ticker=MELI') {
  const page = await browser.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.route('**/api/historia?**', async (route) => {
    const lang = new URL(route.request().url()).searchParams.get('lang') || 'es';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(typeof respuesta === 'function' ? respuesta(lang) : respuesta) });
  });
  // Fuentes externas bloqueadas a propósito, como en e2e/run.mjs.
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
  await page.goto('http://127.0.0.1:8931' + ruta, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chips, .estado', { timeout: 8000 }).catch(() => {});
  return { page, errores };
}

// ═════════════════════════════════════════════════════════════════════════
// 1. UN DOCUMENTO, UN EVENTO — el bug que la rebanada F existe para cerrar
// ═════════════════════════════════════════════════════════════════════════
{
  const { page, errores } = await abrir(D);

  report('la página carga sin errores de JS', errores.length === 0, errores.join(' · '));
  report('se pinta la línea de tiempo', (await page.locator('.linea').count()) === 1);
  report('un renglón por documento', (await page.locator('.linea .ev').count()) === EVENTOS.length,
    `${await page.locator('.linea .ev').count()} renglones para ${EVENTOS.length} eventos`);

  // El 8-K de tres temas: UNA vez en la línea, con sus tres etiquetas.
  const multi = page.locator('.linea .ev').filter({ hasText: '[0001-26-1]' });
  report('el 8-K de tres temas sale UNA sola vez', (await multi.count()) === 1,
    `salió ${await multi.count()} vez/veces`);
  const etiquetas = await multi.locator('.qs span').allInnerTexts();
  report('…y lleva las etiquetas de las tres preguntas que contesta',
    etiquetas.length === 3 && /^1 /.test(etiquetas[0]) && /^3 /.test(etiquetas[1]) && /^7 /.test(etiquetas[2]),
    etiquetas.join(' | '));
  const cods = await multi.locator('.cod').first().innerText();
  report('…con sus tres temas destacados, no uno elegido por nosotros',
    /5\.02/.test(cods) && /2\.02/.test(cods) && /1\.01/.test(cods), cods);

  // 2. El 9.01 se apaga, no se borra.
  report('el 9.01 NO sale entre los temas destacados', !/9\.01/.test(cods), cods);
  const sobre = await multi.locator('.sobre').first().innerText();
  report('…sale en la línea gris de "además adjunta"', /9\.01/.test(sobre) && /adjunta/i.test(sobre), sobre);
  report('…traducido, no como código pelado', /anexos/i.test(sobre), sobre);

  // El 7.01 SOLO sí es el evento: no baja al gris.
  const solo701 = page.locator('.linea .ev').filter({ hasText: '[0001-25-7]' });
  report('un 7.01 solo SÍ es el evento: sale destacado', /7\.01/.test(await solo701.locator('.cod').first().innerText()));
  report('…y solo el adjunto baja al gris', /9\.01/.test(await solo701.locator('.sobre').first().innerText()));

  // El resumen no puede decir que el tema más frecuente es "adjunté un archivo".
  const desgloses = await page.locator('.sec[data-sec="direccion"] .desglose').allInnerTexts();
  report('el desglose del resumen cuenta temas, no adjuntos',
    /14× 5\.02/.test(desgloses[0] || '') && !/9\.01/.test(desgloses[0] || ''), desgloses.join(' | '));
  report('…y los adjuntos se cuentan aparte, en su propia línea',
    /adjunta/i.test(desgloses[1] || '') && /14× 9\.01/.test(desgloses[1] || ''), desgloses.join(' | '));

  // La línea es cronológica y agrupada por año.
  const fechas = await page.locator('.linea .ev-d').allInnerTexts();
  report('la línea va de lo más nuevo a lo más viejo',
    fechas.join() === [...fechas].sort().reverse().join(), fechas.join(' | '));
  report('…y marca los años', (await page.locator('.anio').count()) === 2);

  // EL DESENLACE. Sin el 5.07 la línea mostraba la campaña y no el resultado.
  const cierre = page.locator('.linea .ev').filter({ hasText: '[0001-26-7]' });
  report('el resultado de la votación está en la línea', (await cierre.count()) === 1);
  report('…traducido a qué ES el documento', /resultados de la votación/i.test(await cierre.locator('.glosa').first().innerText()));
  report('…bajo la pregunta 2, con la campaña', /2 · Quién posee/.test((await cierre.locator('.qs span').allInnerTexts()).join(' ')));
  // La línea que no se cruza: el papel se muestra, el veredicto no se saca.
  const txtCierre = await cierre.innerText();
  report('…y NO dice cómo salió la votación',
    !/(gan[óo]|perdi[óo]|aprob|rechaz|derrot|triunf)/i.test(txtCierre), txtCierre.replace(/\n/g, ' '));
  report('…va después de los filings de campaña, en su lugar cronológico',
    (await page.locator('.linea .ev-d').allInnerTexts())[0] === '2026-06-10');
  report('la línea declara su perímetro', /Formas 3\/4\/5/.test(await page.locator('.linea').innerText()));

  await page.screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-es.png', fullPage: true });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
// 2. LOS CHIPS FILTRAN LA MISMA LÍNEA
// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir(D);

  report('hay ocho chips: "todo" más las siete preguntas', (await page.locator('.chip').count()) === 8);
  report('sin filtro se muestran los siete paneles', (await page.locator('.sec').count()) === 7);
  report('los chips dicen que son filtros de UNA línea, no siete listas',
    /no son siete listas/i.test(await page.locator('.chips-nota').innerText()));

  // Filtrar por la pregunta 3.
  await page.locator('.chip', { hasText: 'Prometido vs. entregado' }).click();
  await page.waitForTimeout(200);
  report('al filtrar, la línea se recorta a los de esa pregunta',
    (await page.locator('.linea .ev').count()) === 4, `${await page.locator('.linea .ev').count()} renglones`);
  report('…el 8-K multitema sigue ahí (contesta la 3)',
    (await page.locator('.linea .ev').filter({ hasText: '[0001-26-1]' }).count()) === 1);
  report('…y el DFAN14A no', (await page.locator('.linea .ev').filter({ hasText: '[0001-26-3]' }).count()) === 0);
  report('…se muestra SOLO el panel de esa pregunta', (await page.locator('.sec').count()) === 1);
  report('…que va ARRIBA de la línea filtrada', await page.evaluate(() => {
    const s = document.querySelector('.sec'); const l = document.querySelector('.linea');
    return s && l ? (s.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  }));
  report('…y la serie trimestral viaja con su pregunta', (await page.locator('.pt').count()) > 0);

  // Volver a todo.
  await page.locator('.chip', { hasText: 'Todo' }).click();
  await page.waitForTimeout(200);
  report('"Todo" devuelve la línea entera', (await page.locator('.linea .ev').count()) === EVENTOS.length);
  report('…y los siete paneles', (await page.locator('.sec').count()) === 7);

  // Desde el renglón: la etiqueta lleva al mismo filtro.
  await page.locator('.linea .ev').filter({ hasText: '[0001-26-1]' }).locator('.qs span').first().click();
  await page.waitForTimeout(200);
  report('la etiqueta de un renglón filtra por esa pregunta', (await page.locator('.sec').count()) === 1);
  report('…y es la pregunta 1', /Quién la dirige/.test(await page.locator('.sec').innerText()));

  // Una pregunta NO CUBIERTA se puede filtrar igual: ahí vive la explicación.
  await page.locator('.chip', { hasText: 'Qué dice la gerencia' }).click();
  await page.waitForTimeout(200);
  const vacio = await page.locator('.linea .sindocs').innerText();
  report('una pregunta no cubierta se puede seleccionar', (await page.locator('.sec').count()) === 1);
  // EL ERROR QUE ESTE MÓDULO EXISTE PARA NO COMETER: decir "buscamos y no
  // hay" de una fuente que no miramos es afirmar sobre la empresa algo que
  // en realidad es sobre nosotros.
  report('…y la línea vacía NO dice "buscamos y no hay"',
    !/no es que no lo hayamos mirado/i.test(vacio) && /no es que hayamos buscado|no se contesta con documentos/i.test(vacio), vacio);
  report('…el panel sigue explicando por qué', (await page.locator('.decl.nocubre').count()) === 1);

  await page.screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-filtro.png', fullPage: true });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
// 3. LOS TRES VACÍOS, LA SERIE Y LAS CITAS
// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir(D);

  const gerencia = page.locator('.sec[data-sec="gerencia"]');
  report('la no cubierta NO usa el bloque de "sin documentos"', (await gerencia.locator('.sindocs').count()) === 0);
  report('la no cubierta usa su propio bloque ámbar', (await gerencia.locator('.decl.nocubre').count()) === 1);
  report('la de fuera del módulo usa el azul', (await page.locator('.decl.fuera').count()) >= 1);
  report('los badges de estado son distintos',
    (await page.locator('.badge.ok').count()) >= 1
    && (await page.locator('.badge.nocubre').count()) === 2
    && (await page.locator('.badge.fuera').count()) === 1);

  // El YoY nulo NO es 0%.
  const yoys = await page.locator('.pt .yoy').allInnerTexts();
  report('un YoY nulo se dibuja como "—"', yoys.includes('—'), yoys.join(' | '));
  report('…y NUNCA como 0%', !yoys.some((y) => /^\+?0(\.0+)?%$/.test(y.trim())), yoys.join(' | '));
  report('el YoY que sí existe se muestra con signo', yoys.some((y) => /\+12\.3%/.test(y)));
  const na = await page.locator('.pt .yoy.na').first().getAttribute('title');
  report('el "—" explica por qué en el hover', /sin trimestre comparable/i.test(na || ''), na);

  // El número se lee completo: "6100 MUSD" era un dígito mal leído esperando.
  const vals = await page.locator('.pt .val').allInnerTexts();
  report('la cifra se muestra completa, sin escala corta ambigua',
    vals.some((v) => /6[.,]100[.,]000[.,]000/.test(v)), vals.join(' | '));
  report('…y ningún valor usa un sufijo de escala',
    !vals.some((v) => /\b(M|MM|B|K|mil M)\b/.test(v)), vals.join(' | '));

  // El código legal traducido: lo que hacía la pantalla ilegible.
  const multi = page.locator('.linea .ev').filter({ hasText: '[0001-26-1]' });
  const glosa = await multi.locator('.glosa').first().innerText();
  report('el item 5.02 sale traducido, no como código pelado', /salida, nombramiento o compensación/i.test(glosa), glosa);
  report('…y el código crudo sigue visible al lado', (await multi.locator('.cod').first().innerText()).includes('5.02'));
  const oficial = await multi.locator('.glosa span').first().getAttribute('title');
  report('el nombre OFICIAL de la SEC está en el hover, textual',
    /Departure of Directors/.test(oficial || '') && /Compensatory Arrangements/.test(oficial || ''), oficial);
  // La glosa de 5.02 NO puede decir solo "cambio de directivos": el item
  // cubre también la compensación, y un 5.02 puede ser solo eso.
  report('la glosa de 5.02 nombra la compensación', /compensaci/i.test(glosa));

  // Un código sin traducción se dice, no se inventa.
  const sinGlosa = await page.locator('.linea .ev').filter({ hasText: '[0001-26-5]' }).locator('.glosa .sin').first().innerText();
  report('una forma que no está en el diccionario se muestra cruda y se declara',
    /PRRN14A/.test(sinGlosa) && /sin traducción/i.test(sinGlosa), sinGlosa);

  // Contar lo que ya está.
  const resumen = await page.locator('.sec[data-sec="direccion"] .resumen').first().innerText();
  report('el panel dice cuántos filings hay', /14 filings/.test(resumen), resumen.replace(/\n/g, ' '));
  report('…y entre qué fechas', /2021/.test(resumen) && /2026/.test(resumen));
  report('…y avisa que está mostrando una muestra', /mostrando 1 de 14/i.test(resumen));

  // La pelea por el consejo, agrupada.
  const prop = page.locator('.sec[data-sec="propiedad"]');
  const ep = await prop.locator('.episodio').first().innerText();
  report('la pelea por el consejo se agrupa como episodio', /impugnada/i.test(ep), ep.replace(/\n/g, ' ').slice(0, 90));
  report('…con su conteo', /34 filings/.test(ep));
  report('…su rango de fechas', /2025/.test(ep) && /2026/.test(ep));
  report('…su desglose por forma', /30× DFAN14A/.test(ep));
  report('…y el umbral declarado como NUESTRO', /120 días/.test(ep) && /no de la SEC/i.test(ep), null);
  // Ojo con el grep ingenuo: el descargo del umbral SÍ dice "no quién ganó",
  // y eso es correcto. Lo que no puede tener vocabulario de desenlace son las
  // líneas que AFIRMAN — el conteo y el desglose.
  const afirma = (await prop.locator('.episodio .cuenta').first().innerText())
    + ' ' + (await prop.locator('.episodio .formas').first().innerText());
  report('las líneas que afirman no dicen quién ganó',
    !/(ganó|gano|perdió|perdio|exitos|fracas|activista)/i.test(afirma), afirma);
  report('…y el descargo sí aclara que no lo dice',
    /no quién ganó/i.test(await prop.locator('.episodio .umbral').first().innerText()));

  // Toda cita enlaza.
  const citas = page.locator('.citas a, .ev .cita');
  const n = await citas.count();
  let sinHref = 0;
  for (let i = 0; i < n; i++) {
    const href = await citas.nth(i).getAttribute('href');
    if (!href || href === '#') sinHref++;
  }
  report('toda cita visible enlaza a un documento', n > 0 && sinHref === 0, `${n} citas · ${sinHref} sin destino`);

  // El Q4 derivado muestra las dos.
  const fila = page.locator('.pt').filter({ hasText: '2025-12-31' }).first();
  report('el Q4 derivado lleva la etiqueta "derivado"', (await fila.locator('.tag.der').count()) === 1);
  report('…y muestra SUS DOS citas', (await fila.locator('.citas a').count()) === 2);
  const filaDirecta = page.locator('.pt').filter({ hasText: '2025-09-30' }).first();
  report('un trimestre directo muestra UNA cita', (await filaDirecta.locator('.citas a').count()) === 1);
  report('un periodo re-expresado se marca', (await filaDirecta.locator('.tag.rev').count()) === 1);

  // El perímetro arriba.
  report('el perímetro de lo NO cubierto está en la página', (await page.locator('.perimetro li').count()) === 3);
  const ordenPerimetro = await page.evaluate(() => {
    const p = document.querySelector('.perimetro'); const l = document.querySelector('.linea');
    return p && l ? (p.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  });
  report('…y va ANTES de la línea, no en el pie', ordenPerimetro);

  // La contraevidencia, que no es opcional. Apunta a la línea, no copia.
  report('"Dónde se rompe la historia" se pinta', (await page.locator('.rompe').count()) === 1);
  report('…con el 8-K 4.02', /4\.02/.test(await page.locator('.rompe').innerText()));
  report('…y el 4.02 se marca en la línea como ruptura',
    (await page.locator('.linea .ev.rota').count()) === 1);
  // El mismo papel en dos lugares es una repetición DECLARADA, no una copia
  // silenciosa: la regla es "una vez, o se dice que es el mismo".
  report('…y el bloque avisa que es el mismo papel de la línea, no uno nuevo',
    /ya están en la línea/i.test(await page.locator('.rompe .repetido').innerText()));

  // La regla que no se negocia.
  const texto = (await page.locator('body').innerText()).toLowerCase();
  const prohibidas = ['comprar', 'vender', 'recomendamos', 'precio objetivo', 'strong buy', 'sobreponderar', 'infraponderar'];
  const halladas = prohibidas.filter((w) => texto.includes(w));
  report('cero vocabulario de recomendación en pantalla', halladas.length === 0, halladas.join(', '));

  // Y cero vocabulario de DESENLACE. El 5.07 trae los votos; quién ganó la
  // pelea es una lectura, y la lectura es Fase B. La única mención permitida
  // es el descargo del episodio, que dice justamente que NO lo dice.
  const sinDescargo = texto.replace(/no qui[ée]n gan[óo][^.]*\./g, '');
  const desenlace = ['ganó', 'gano la', 'perdió', 'fue derrotad', 'se aprobó', 'fue rechazad', 'triunf'];
  const veredicto = desenlace.filter((w) => sinDescargo.includes(w));
  report('cero vocabulario de desenlace: el 5.07 se muestra, no se interpreta', veredicto.length === 0, veredicto.join(', '));

  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
// 3b. LA LECTURA ESCRITA, Y LAS DOS MANERAS DE NO MOSTRARLA
// ═════════════════════════════════════════════════════════════════════════
{
  const { page, errores } = await abrir(D);
  report('la lectura escrita se pinta', (await page.locator('.lectura').count()) === 1);
  report('…sin errores de JS', errores.length === 0, errores.join(' · '));
  report('…con sus secciones', (await page.locator('.lectura .parte').count()) === 2);

  // LA CITA SALE DE LA FRASE, PERO NO DEJA DE ESTAR.
  // Nueve accessions dentro de una oración la vuelven ilegible; era la razón
  // número uno de que no se leyera como historia.
  const marcas = page.locator('.lectura sup.c a');
  report('las citas son marcas numeradas, no cadenas en la frase', (await marcas.count()) === 7);
  report('…que abren el documento', /sec\.gov/.test(await marcas.first().getAttribute('href') || ''));
  report('…y el hover dice qué papel es', /8-K/.test(await marcas.first().getAttribute('title') || ''));

  const prosa = await page.locator('.lectura .parte p').first().innerText();
  report('el párrafo ya NO lleva accessions adentro', !/\[\d{4}-\d{2}-\d\]/.test(prosa), prosa.slice(0, 100));
  report('…y se lee como una oración', /reportó un cambio de directivos/.test(prosa));

  // El mismo documento citado dos veces lleva el MISMO número: dos números
  // harían parecer que son dos papeles.
  const nums = await marcas.allInnerTexts();
  report('el mismo documento repetido lleva el mismo número', nums[0] === nums[1], nums.join(','));
  report('…y documentos distintos, números distintos', new Set(nums).size === 6, nums.join(','));

  // El accession completo no desaparece: baja a la línea de fuentes.
  const fuentes = await page.locator('.lectura .fuentes').first().innerText();
  report('el accession completo vive en la línea de fuentes', /\[0001-26-1\]/.test(fuentes), fuentes.slice(0, 90));
  report('…numerado igual que la marca del texto', new RegExp('\\b' + nums[0] + '\\s*\\[0001-26-1\\]').test(fuentes.replace(/\s+/g, ' ')));
  report('…y enlazado', (await page.locator('.lectura .fuentes a').first().getAttribute('href') || '').includes('sec.gov'));
  // Los números son inline: `.parte b` es block (es el título de la sección)
  // y sin un display explícito cada fuente se iba a su propia línea.
  report('…y la lista de fuentes es UNA línea que fluye, no una por renglón',
    await page.evaluate(() => getComputedStyle(document.querySelector('.lectura .fuentes b')).display === 'inline'));

  // La procedencia. Una narración sin procedencia es una opinión anónima.
  const proc = await page.locator('.lectura .proc').innerText();
  report('la lectura declara qué modelo la escribió', /claude-opus-5/.test(proc), proc);
  report('…y con qué versión de prompt', /prompt v1/.test(proc));
  report('…y que no predice ni recomienda', /Sin predicciones/.test(proc));

  // QUÉ GARANTIZA LA CITA Y QUÉ NO. El lector tiene el mismo derecho a
  // saberlo que el memo: el guardia verifica que el documento exista en la
  // evidencia, no que la afirmación diga lo que el documento dice.
  const alcance = await page.locator('.lectura .alcance').innerText();
  report('la página declara qué verifica el guardia', /exista en la evidencia/.test(alcance), alcance);
  report('…y qué NO verifica', /no que la afirmación diga lo que el documento dice/.test(alcance));
  report('…diciendo cómo se comprueba eso', /abriéndolo/.test(alcance));
  // Una clase, una cosa. `.proc` llegó a nombrar la procedencia Y el alcance,
  // y el modo estricto de Playwright lo cazó — el mismo tropiezo que el
  // `.vacio` de la Fase A.
  report('cada bloque del pie tiene su propia clase', (await page.locator('.lectura .proc').count()) === 1);

  // Va ARRIBA: es el producto, no una nota al pie.
  report('la lectura va antes de la línea', await page.evaluate(() => {
    const l = document.querySelector('.lectura'); const t = document.querySelector('.linea');
    return l && t ? (l.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  }));

  // La contraevidencia también va en la lectura, y al final.
  report('"dónde se rompe" es la última parte de la lectura',
    (await page.locator('.lectura .parte').last().innerText()).includes('no se puede confiar'));

  const texto = (await page.locator('.lectura').innerText()).toLowerCase();
  const prohibidas = ['comprar', 'vender', 'recomendamos', 'precio objetivo', 'atractiv', 'barata', 'cara'];
  report('cero vocabulario de recomendación en la lectura',
    prohibidas.filter((w) => texto.includes(w)).length === 0);

  // El pie decía "sin IA" desde la Fase A. Ahora la página SÍ muestra una
  // lectura escrita por un modelo: esa línea pasó a ser falsa, y una promesa
  // falsa en el pie es peor que no tener pie.
  const pie = await page.locator('#foot').innerText();
  report('el pie ya no dice "sin IA": la página ahora narra', !/sin IA/i.test(pie), pie.replace(/\n/g, ' '));
  report('…y sí dice lo que sigue siendo cierto', /sin predicciones de precio/i.test(pie) && /sin recomendaciones/i.test(pie));

  await page.locator('.lectura').screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-lectura.png' });
  await page.close();
}
{
  const { page } = await abrir(CON_CORTES);
  report('con cortes, la lectura se muestra igual', (await page.locator('.lectura .parte').count()) === 2);
  report('…y el hueco se DECLARA, no se esconde', (await page.locator('.lectura .cortado').count()) === 1);
  const c = await page.locator('.lectura .cortado').innerText();
  report('…diciendo cuántas afirmaciones se cortaron', /2 afirmaciones cortadas/.test(c), c.replace(/\n/g, ' '));
  report('…y por qué motivo cada una', /citas que no existen/.test(c) && /opinión/.test(c), c.replace(/\n/g, ' '));
  report('…incluida la sección que quedó sin nada', /1 secciones que quedaron sin nada/.test(c));
  report('…con la explicación de la regla', /un hueco declarado es un dato/i.test(c));
  await page.close();
}
{
  const { page } = await abrir(D);
  report('sin cortes NO se pinta el bloque de cortado', (await page.locator('.lectura .cortado').count()) === 0);
  await page.close();
}
{
  const { page } = await abrir(SIN_LECTURA);
  report('sin lectura escrita se DECLARA, no se esconde', (await page.locator('.lectura.falta').count()) === 1);
  report('…diciendo que no se escribe al abrir la página',
    /no se escribe cada vez/.test(await page.locator('.lectura.falta').innerText()));
  report('…y los documentos siguen estando', (await page.locator('.linea .ev').count()) === EVENTOS.length);
  await page.close();
}
{
  const { page } = await abrir(FALLIDA);
  report('una lectura que falló tiene su propio bloque', (await page.locator('.lectura.fallida').count()) === 1);
  report('…distinto del de "todavía no hay"', (await page.locator('.lectura.falta').count()) === 0);
  const t = await page.locator('.lectura.fallida').innerText();
  report('…con el motivo en palabras', /techo de tokens/.test(t), t.replace(/\n/g, ' ').slice(0, 120));
  report('…y cuántas llamadas se pagaron', /2 intento/.test(t));
  report('…diciendo por qué no se muestra el pedazo que llegó', /se lee como completa/.test(t));
  report('…y los documentos siguen estando', (await page.locator('.linea .ev').count()) === EVENTOS.length);
  await page.close();
}
{
  const { page } = await abrir(RETENIDA);
  report('una cita que no resuelve retiene la lectura', (await page.locator('.lectura.retenida').count()) === 1);
  report('…y NO se muestra ninguna sección', (await page.locator('.lectura .parte').count()) === 0);
  report('…se dice cuál cita falló', /0009-99-9/.test(await page.locator('.lectura.retenida').innerText()));
  report('…y los documentos siguen estando: se cae a la Fase A',
    (await page.locator('.linea .ev').count()) === EVENTOS.length);
  await page.close();
}
{
  // LAS TRES SE VEN DISTINTO. Si dos colapsaran, la página mostraría lo mismo
  // para situaciones que piden acciones opuestas: esperar a que corra el job,
  // ir a mirar qué falló, o arreglar un inventario nuestro.
  const clases = [];
  for (const [nombre, datos] of [['falta', SIN_LECTURA], ['fallida', FALLIDA], ['retenida', RETENIDA]]) {
    const { page } = await abrir(datos);
    clases.push(await page.evaluate(() => document.querySelector('.lectura').className));
    await page.close();
  }
  report('las tres maneras de no mostrar una lectura se ven distinto',
    new Set(clases).size === 3, clases.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════
// 4. UN EMISOR SIN NADA: el vacío que habla de la EMPRESA
// ═════════════════════════════════════════════════════════════════════════
{
  const { page, errores } = await abrir(VACIO, '/historia.html?ticker=NADA');
  report('un emisor sin eventos no rompe la página', errores.length === 0, errores.join(' · '));
  report('…la línea vacía dice "Sin documentos"', /Sin documentos/.test(await page.locator('.linea .sindocs').innerText()));
  report('…y aclara que SÍ se buscó', /no es que no lo hayamos mirado/i.test(await page.locator('.linea .sindocs').innerText()));
  report('…los chips de las preguntas vacías se marcan', (await page.locator('.chip.nada').count()) >= 4);
  report('…y las siete preguntas siguen a la vista', (await page.locator('.sec').count()) === 7);
  report('sin contraevidencia se dice, con una frase falsable',
    /No encontramos contraevidencia/.test(await page.locator('.rompe').innerText()));
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
// 5. COBERTURA PARCIAL, IDIOMA Y LOS DOS ESTADOS QUE MÁS FÁCIL MIENTEN
// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir(PARCIAL, '/historia.html?ticker=VIST');
  report('cobertura parcial: se pinta el aviso', (await page.locator('.cobertura').count()) === 1);
  report('…nombrando el 20-F', /20-F/.test(await page.locator('.cobertura').innerText()));
  const antes = await page.evaluate(() => {
    const c = document.querySelector('.cobertura'); const l = document.querySelector('.linea');
    return c && l ? (c.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  });
  report('…y va antes de la línea: cambia cómo se lee todo lo de abajo', antes);
  report('el emisor parcial NO se esconde: su línea se pinta igual', (await page.locator('.linea .ev').count()) === EVENTOS.length);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-parcial.png', fullPage: true });
  await page.close();
}

{
  const { page } = await abrir(D);
  await page.click('#lang');
  await page.waitForTimeout(400);
  const t = await page.locator('body').innerText();
  report('el switch de idioma repinta en inglés', /Promised vs\. delivered/.test(t) && /not covered/i.test(t));
  report('…y el botón ahora ofrece volver a ES', (await page.locator('#lang').innerText()) === 'ES');
  report('el idioma se guarda', (await page.evaluate(() => localStorage.getItem('historia:lang'))) === 'en');
  await page.close();
}

{
  const { page } = await abrir({ ticker: 'NOEXISTE', estado: 'desconocido', detalle: 'Este ticker no está en el catálogo.', secciones: [] }, '/historia.html?ticker=NOEXISTE');
  const t = await page.locator('.estado').innerText();
  report('un ticker desconocido no dice que la empresa no tenga historia', /no la sembramos/i.test(t), t.slice(0, 120));
  report('…y no pinta una línea vacía como si fuera un dato', (await page.locator('.linea').count()) === 0);
  await page.close();
}
{
  const { page } = await abrir({ ticker: 'LULU', estado: 'sin_ingesta', detalle: 'x', secciones: [] }, '/historia.html?ticker=LULU');
  const t = await page.locator('.estado').innerText();
  report('sin ingesta se distingue de desconocido', /todavía no se ingirió/i.test(t), t.slice(0, 120));
  await page.close();
}

await browser.close();
console.log(fallas ? `\n${fallas} FALLA(S)\n` : '\nTODO EN VERDE\n');
nav.exit(fallas ? 1 : 0);
