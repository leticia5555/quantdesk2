// ═══════════════════════════════════════════════════════════════
// e2e/historia.mjs — la página de HISTORIA, en Chromium, con la API stubbeada.
//
// Los tests de node prueban lo que el endpoint DEVUELVE. Esto prueba lo que el
// usuario VE, que es donde las reglas del módulo se rompen de verdad: un hueco
// sin etiqueta, un YoY nulo dibujado como 0%, una cita que no enlaza a nada.
//
// Las cinco cosas que se verifican en el DOM, no en el JSON:
//
//   1. Los TRES vacíos se ven distinto. "Sin documentos" (buscamos y no hay)
//      no puede parecerse a "no cubierta" (no miramos esa fuente).
//   2. Un YoY nulo sale "—", NUNCA 0%. Un cero inventado en una serie de
//      ingresos no se ve nunca.
//   3. Toda cita enlaza a un documento abrible.
//   4. El Q4 derivado muestra SUS DOS citas.
//   5. Cobertura parcial arriba y visible, antes de todo lo demás.
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

// ── La respuesta stubbeada: un emisor con de todo un poco ────────────────
const D = (lang = 'es') => ({
  ticker: 'MELI',
  estado: 'ok',
  emisor: { cik: '0001099590', nombre: 'MERCADOLIBRE INC', forma_anual: '10-K', cobertura: 'completa', ultima_ingesta: '2026-09-20T00:00:00Z' },
  formato_cita: '[0000320193-25-000073]',
  secciones: [
    { id: 'direccion', pregunta: 1, estado: 'con_documentos', declaraciones: [],
      resumen: { total: 14, mostrados: 1, desde: '2021-12-03', hasta: '2026-09-15', por_item: { '5.02': 14 }, por_forma: { '8-K': 14 }, truncado: true },
      documentos: [{ accession: '0001-26-1', form: '8-K', items: ['5.02'], filed: '2026-02-20',
        url: 'https://www.sec.gov/x.htm', cita: '[0001-26-1]',
        forma_glosa: { codigo: '8-K', oficial: 'Current Report', glosa: 'reporte de evento' },
        items_glosa: [{ codigo: '5.02', oficial: 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers', glosa: 'salida, nombramiento o compensación de directivos o consejeros' }] }] },
    // La pelea por el consejo, que en una lista plana se pierde.
    { id: 'propiedad', pregunta: 2, estado: 'con_documentos', declaraciones: [],
      resumen: { total: 34, mostrados: 2, desde: '2025-12-15', hasta: '2026-05-20', por_forma: { DFAN14A: 30, PREC14A: 2, DEFC14A: 2 }, por_item: {}, truncado: true },
      episodios: [{ desde: '2025-12-15', hasta: '2026-05-20', dias: 156, total: 34,
        por_forma: { DFAN14A: 30, PREC14A: 2, DEFC14A: 2 }, umbral_dias: 120, documentos: [] }],
      documentos: [
        { accession: '0001-26-3', form: 'DFAN14A', items: [], filed: '2026-05-20', url: 'https://www.sec.gov/p.htm', cita: '[0001-26-3]',
          forma_glosa: { codigo: 'DFAN14A', oficial: 'Additional Definitive Proxy Soliciting Materials Filed by Non-Management', glosa: 'material de solicitación presentado por un tercero, no por la empresa' }, items_glosa: [] },
        // Un código que NO está en el diccionario: se muestra crudo y se dice.
        { accession: '0001-26-4', form: 'SC 14D9', items: [], filed: '2026-04-01', url: 'https://www.sec.gov/q.htm', cita: '[0001-26-4]',
          forma_glosa: { codigo: 'SC 14D9', oficial: null, glosa: null }, items_glosa: [] },
      ] },
    { id: 'prometido_vs_entregado', pregunta: 3, estado: 'con_documentos',
      documentos: [{ accession: '0001-26-2', form: '8-K', items: ['2.02'], filed: '2026-02-20', url: 'https://www.sec.gov/y.htm', cita: '[0001-26-2]' }],
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
    { id: 'gerencia', pregunta: 4, estado: 'no_cubierta', documentos: [],
      declaraciones: [{ codigo: 'transcripts', texto: lang === 'en' ? 'Question 4 — not covered.' : 'Pregunta 4 — no cubierta.' }] },
    { id: 'competencia', pregunta: 5, estado: 'no_cubierta', documentos: [],
      declaraciones: [{ codigo: 'pares_sin_mapa', texto: 'El mapa de pares todavía no existe.' }] },
    // El que manda a otro panel.
    { id: 'mercado', pregunta: 6, estado: 'fuera_del_modulo', documentos: [],
      declaraciones: [{ codigo: 'mercado_fuera_de_modulo', texto: 'Vive en el panel SMART $.' }] },
    { id: 'catalizador', pregunta: 7, estado: 'sin_documentos', documentos: [], declaraciones: [] },
  ],
  contraevidencia: {
    id: 'donde_se_rompe', estado: 'con_documentos',
    documentos: [{ accession: '0001-26-9', form: '8-K', items: ['4.02'], filed: '2026-03-01', url: 'https://www.sec.gov/w.htm', cita: '[0001-26-9]' }],
    periodos_reexpresados: [{ familia: 'ingresos', period_end: '2025-09-30', cita: '[0001-25-9]', url: 'https://www.sec.gov/z.htm', filed: '2025-11-01' }],
    declaraciones: [],
  },
  no_cubierto: [
    { codigo: 'transcripts', texto: 'Transcripciones con licencia comercial: no se incluyen.' },
    { codigo: 'alt_data', texto: 'Sin datos alternativos.' },
    { codigo: 'expert_networks', texto: 'Sin expert networks.' },
  ],
  fuente: 'SEC EDGAR',
});

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
  await page.waitForSelector('.sec', { timeout: 8000 }).catch(() => {});
  return { page, errores };
}

// ═════════════════════════════════════════════════════════════════════════
{
  const { page, errores } = await abrir(D);

  report('la página carga sin errores de JS', errores.length === 0, errores.join(' · '));
  report('se pintan las 7 secciones', (await page.locator('.sec').count()) === 7);

  // 1. Los tres vacíos se ven distinto.
  const txtSinDocs = await page.locator('.sec', { hasText: 'Cuál es el catalizador' }).locator('.sindocs').innerText();
  report('el vacío de la empresa dice "Sin documentos"', /Sin documentos/.test(txtSinDocs));
  report('una sección con documentos NO muestra el bloque de vacío',
    (await page.locator('.sec', { hasText: 'Quién la posee' }).locator('.sindocs').count()) === 0);
  report('…y aclara que SÍ se buscó', /no es que no lo hayamos mirado/i.test(txtSinDocs));

  const gerencia = page.locator('.sec', { hasText: 'gerencia' });
  report('la no cubierta NO usa el bloque de "sin documentos"', (await gerencia.locator('.sindocs').count()) === 0);
  report('la no cubierta usa su propio bloque ámbar', (await gerencia.locator('.decl.nocubre').count()) === 1);
  report('la de fuera del módulo usa el azul', (await page.locator('.decl.fuera').count()) >= 1);
  report('los badges de estado son distintos',
    (await page.locator('.badge.vacio').count()) >= 1
    && (await page.locator('.badge.nocubre').count()) >= 1
    && (await page.locator('.badge.fuera').count()) === 1);

  // 2. El YoY nulo NO es 0%.
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
  const dir = page.locator('.sec', { hasText: 'Quién la dirige' });
  const glosa = await dir.locator('.doc .glosa').first().innerText();
  report('el item 5.02 sale traducido, no como código pelado', /salida, nombramiento o compensación/i.test(glosa), glosa);
  report('…y el código crudo sigue visible al lado', (await dir.locator('.doc .cod').first().innerText()).includes('5.02'));
  const oficial = await dir.locator('.doc .glosa span').first().getAttribute('title');
  report('el nombre OFICIAL de la SEC está en el hover, textual',
    /Departure of Directors/.test(oficial || '') && /Compensatory Arrangements/.test(oficial || ''), oficial);

  // La glosa de 5.02 NO puede decir solo "cambio de directivos": el item
  // cubre también la compensación, y un 5.02 puede ser solo eso.
  report('la glosa de 5.02 nombra la compensación', /compensaci/i.test(glosa));

  // Un código sin traducción se dice, no se inventa.
  const prop = page.locator('.sec', { hasText: 'Quién la posee' });
  const sinGlosa = await prop.locator('.doc .glosa .sin').first().innerText();
  report('un código que no está en el diccionario se muestra crudo y se declara',
    /SC 14D9/.test(sinGlosa) && /sin traducción/i.test(sinGlosa), sinGlosa);

  // Contar lo que ya está.
  const resumen = await dir.locator('.resumen').first().innerText();
  report('la sección dice cuántos filings hay', /14 filings/.test(resumen), resumen.replace(/\n/g, ' '));
  report('…y entre qué fechas', /2021/.test(resumen) && /2026/.test(resumen));
  report('…y avisa que está mostrando una muestra', /mostrando 1 de 14/i.test(resumen));

  // La pelea por el consejo, agrupada.
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

  // 3. Toda cita enlaza.
  const citas = page.locator('.citas a, .doc .cita');
  const n = await citas.count();
  let sinHref = 0;
  for (let i = 0; i < n; i++) {
    const href = await citas.nth(i).getAttribute('href');
    if (!href || href === '#') sinHref++;
  }
  report('toda cita visible enlaza a un documento', n > 0 && sinHref === 0, `${n} citas · ${sinHref} sin destino`);

  // 4. El Q4 derivado muestra las dos.
  const fila = page.locator('.pt').filter({ hasText: '2025-12-31' }).first();
  report('el Q4 derivado lleva la etiqueta "derivado"', (await fila.locator('.tag.der').count()) === 1);
  report('…y muestra SUS DOS citas', (await fila.locator('.citas a').count()) === 2);
  const filaDirecta = page.locator('.pt').filter({ hasText: '2025-09-30' }).first();
  report('un trimestre directo muestra UNA cita', (await filaDirecta.locator('.citas a').count()) === 1);
  report('un periodo re-expresado se marca', (await filaDirecta.locator('.tag.rev').count()) === 1);

  // 5. El perímetro arriba.
  report('el perímetro de lo NO cubierto está en la página', (await page.locator('.perimetro li').count()) === 3);
  const ordenPerimetro = await page.evaluate(() => {
    const p = document.querySelector('.perimetro'); const s = document.querySelector('.sec');
    return p && s ? (p.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  });
  report('…y va ANTES de las secciones, no en el pie', ordenPerimetro);

  // La contraevidencia, que no es opcional.
  report('"Dónde se rompe la historia" se pinta', (await page.locator('.rompe').count()) === 1);
  report('…con el 8-K 4.02', /4\.02/.test(await page.locator('.rompe').innerText()));

  // La regla que no se negocia.
  const texto = (await page.locator('body').innerText()).toLowerCase();
  const prohibidas = ['comprar', 'vender', 'recomendamos', 'precio objetivo', 'strong buy', 'sobreponderar', 'infraponderar'];
  const halladas = prohibidas.filter((w) => texto.includes(w));
  report('cero vocabulario de recomendación en pantalla', halladas.length === 0, halladas.join(', '));

  await page.screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-es.png', fullPage: true });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir(PARCIAL, '/historia.html?ticker=VIST');
  report('cobertura parcial: se pinta el aviso', (await page.locator('.cobertura').count()) === 1);
  report('…nombrando el 20-F', /20-F/.test(await page.locator('.cobertura').innerText()));
  const antes = await page.evaluate(() => {
    const c = document.querySelector('.cobertura'); const s = document.querySelector('.sec');
    return c && s ? (c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false;
  });
  report('…y va antes de las secciones: cambia cómo se lee todo lo de abajo', antes);
  report('el emisor parcial NO se esconde: sus secciones se pintan igual', (await page.locator('.sec').count()) === 7);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-quantdesk2/c183cedc-10de-5593-8388-72ecf3a8e2f4/scratchpad/historia-parcial.png', fullPage: true });
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir(D);
  await page.click('#lang');
  await page.waitForTimeout(400);
  const t = await page.locator('body').innerText();
  report('el switch de idioma repinta en inglés', /What they promised/.test(t) && /not covered/i.test(t));
  report('…y el botón ahora ofrece volver a ES', (await page.locator('#lang').innerText()) === 'ES');
  report('el idioma se guarda', (await page.evaluate(() => localStorage.getItem('historia:lang'))) === 'en');
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════
{
  const { page } = await abrir({ ticker: 'NOEXISTE', estado: 'desconocido', detalle: 'Este ticker no está en el catálogo.', secciones: [] }, '/historia.html?ticker=NOEXISTE');
  const t = await page.locator('.estado').innerText();
  report('un ticker desconocido no dice que la empresa no tenga historia', /no la sembramos/i.test(t), t.slice(0, 120));
  report('…y no pinta secciones vacías como si fueran datos', (await page.locator('.sec').count()) === 0);
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
