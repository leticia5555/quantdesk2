// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/vc-feed: parsing RSS/Atom, extracción de metadata
// del titular, clasificación de sector (validada, jamás inventada),
// caché en memoria + stale, y modo ?smoke=1. Fetch mockeado — sin red.
// Correr con `node tests/vc-feed.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, {
  parseRss, parseEdgarAtom, extractAmount, extractStage, extractLead,
  extractCompany, extractCountry, classifySectors,
  _resetVcFeedCache, _expireVcFeedCache,
} from '../api/vc-feed.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}

const realFetch = global.fetch;
const realAnthropicKey = process.env.ANTHROPIC_API_KEY;
const realFinnhubKey = process.env.FINNHUB_API_KEY;

// Fechas dinámicas para los fixtures (el date-lint exime tests, pero pubDate
// dinámico además prueba el parseo RFC-822 real).
const rfc822 = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toUTCString();
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);

function rssXml(items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>' +
    items.map((i) =>
      `<item><title>${i.title}</title><link>${i.link || 'https://example.com/x'}</link>` +
      `<pubDate>${i.pubDate || rfc822(1)}</pubDate>` +
      `<description>${i.desc || ''}</description>` +
      (i.cats || []).map((c) => `<category><![CDATA[${c}]]></category>`).join('') +
      '</item>').join('') +
    '</channel></rss>';
}

function textResponse(text, status = 200, ct = 'application/rss+xml') {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    text: async () => text, json: async () => JSON.parse(text) };
}

// ─────────────────── extracción de metadata ───────────────────
console.log('extractAmount: montos del titular');
{
  ok(JSON.stringify(extractAmount('Acme Raises $12M in Series A')) ===
    JSON.stringify({ raw: '$12M', currency: 'USD', millions: 12 }), '$12M', JSON.stringify(extractAmount('Acme Raises $12M in Series A')));
  ok(extractAmount('raises $3.5 million')?.millions === 3.5, '$3.5 million → 3.5', JSON.stringify(extractAmount('raises $3.5 million')));
  ok(extractAmount('lands $1.2B')?.millions === 1200, '$1.2B → 1200', JSON.stringify(extractAmount('lands $1.2B')));
  ok(extractAmount('secures €2M')?.currency === 'EUR', '€2M → EUR', JSON.stringify(extractAmount('secures €2M')));
  ok(extractAmount('raises US$5,000,000')?.millions === 5, '$5,000,000 sin unidad → 5', JSON.stringify(extractAmount('raises US$5,000,000')));
  ok(extractAmount('closes $750K round')?.millions === 0.75, '$750K → 0.75', JSON.stringify(extractAmount('closes $750K round')));
  ok(extractAmount('a $5 coffee') === null, '"$5" pelado (ambiguo) → null', JSON.stringify(extractAmount('a $5 coffee')));
  ok(extractAmount('no money here') === null && extractAmount('') === null && extractAmount(null) === null,
    'sin monto/vacío/null → null');
}

console.log('extractStage: taxonomía pre-seed/seed/A/B+');
{
  ok(extractStage('closes Pre-Seed round') === 'pre-seed', 'Pre-Seed', extractStage('closes Pre-Seed round'));
  ok(extractStage('raises pre seed funding') === 'pre-seed', 'pre seed (espacio)', extractStage('raises pre seed funding'));
  ok(extractStage('raises $4M Seed') === 'seed', 'Seed', extractStage('raises $4M Seed'));
  ok(extractStage('Series A led by X') === 'A', 'Series A → A', extractStage('Series A led by X'));
  ok(extractStage('closes Series B') === 'B+', 'Series B → B+', extractStage('closes Series B'));
  ok(extractStage('$90M Series D round') === 'B+', 'Series D → B+', extractStage('$90M Series D round'));
  ok(extractStage('acquires a startup') === null && extractStage(null) === null, 'sin etapa/null → null');
}

console.log('extractLead / extractCompany / extractCountry');
{
  ok(extractLead('the round was led by Sequoia Capital, with participation from Y') === 'Sequoia Capital',
    'led by X, with…', extractLead('the round was led by Sequoia Capital, with participation from Y'));
  ok(extractLead('co-led by Kaszek and Monashees') === 'Kaszek', 'co-led by X and Y → X',
    extractLead('co-led by Kaszek and Monashees'));
  ok(extractLead('nobody leads here') === null, 'sin lead → null');
  ok(extractCompany('Acme Raises $12M in Series A Funding') === 'Acme', 'Acme Raises… → Acme',
    extractCompany('Acme Raises $12M in Series A Funding'));
  ok(extractCompany('Acme, a SF-based fintech, Raises $12M') === 'Acme', 'con aposición → Acme',
    extractCompany('Acme, a SF-based fintech, Raises $12M'));
  ok(extractCompany('Wibond levanta US$5M para expandirse') === 'Wibond', 'verbo en español',
    extractCompany('Wibond levanta US$5M para expandirse'));
  ok(extractCompany('The Top 10 VC Trends This Year') === null, 'sin verbo de ronda → null (no se adivina)',
    extractCompany('The Top 10 VC Trends This Year'));
  ok(extractCountry('Mexican fintech raises round') === 'Mexico', 'Mexican → Mexico');
  ok(extractCountry('startup brasileña expande en Brasil') === 'Brazil', 'Brasil → Brazil');
  ok(extractCountry('a Bogotá-based Colombian startup') === 'Colombia', 'Colombian → Colombia');
  ok(extractCountry('a Berlin-based startup') === null, 'no-LATAM → null');
}

// ─────────────────── parseRss / parseEdgarAtom ───────────────────
console.log('parseRss: CDATA, entities, pubDate → ISO (jamás hoy)');
{
  const xml = rssXml([
    { title: '<![CDATA[Acme Raises $7M Seed]]>', desc: 'Round led by Foo Ventures.', pubDate: rfc822(3), cats: ['Funding'] },
    { title: 'Beta &amp; Co Secures &#8364;2M', pubDate: 'not a date' },
  ]);
  const items = parseRss(xml);
  ok(items.length === 2, '2 items', items.length);
  ok(items[0].title === 'Acme Raises $7M Seed', 'CDATA decodificado', items[0].title);
  ok(items[0].date === iso(3), 'pubDate → ISO del feed', `${items[0].date} vs ${iso(3)}`);
  ok(items[0].categories.includes('Funding'), 'categorías parseadas', JSON.stringify(items[0].categories));
  ok(items[1].title === 'Beta & Co Secures €2M', 'entities (&amp;, &#8364;) decodificadas', items[1].title);
  ok(items[1].date === null, 'pubDate no parseable → null, nunca hoy', items[1].date);
  ok(parseRss('<html>not a feed</html>').length === 0 && parseRss('').length === 0, 'no-feed/vacío → []');
}

console.log('parseEdgarAtom: getcurrent type=S-1');
{
  const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
    `<entry><title>S-1 - ACME ROBOTICS INC (0001234567) (Filer)</title>` +
    `<link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1234567/x-index.htm"/>` +
    `<updated>${new Date(Date.now() - 2 * 864e5).toISOString()}</updated></entry>` +
    `<entry><title>S-1/A - BETA BIO CORP (0007654321) (Filer)</title>` +
    `<link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/7654321/y-index.htm"/>` +
    `<updated>${new Date(Date.now() - 864e5).toISOString()}</updated></entry>` +
    `<entry><title>S-1MEF - GAMMA LLC (0009999999) (Filer)</title>` +
    `<updated>${new Date().toISOString()}</updated></entry>` +
    '</feed>';
  const filings = parseEdgarAtom(atom);
  ok(filings.length === 2, 'S-1 y S-1/A entran, S-1MEF fuera', JSON.stringify(filings.map((f) => f.form)));
  ok(filings[0].company === 'ACME ROBOTICS INC' && filings[0].cik === '0001234567' && filings[0].amended === false,
    'company/cik/amended del título', JSON.stringify(filings[0]));
  ok(filings[1].amended === true, 'S-1/A → amended:true');
  ok(filings[0].link && filings[0].link.includes('sec.gov'), 'link al index del filing', filings[0].link);
  ok(filings[0].date === iso(2), 'updated → ISO', filings[0].date);
}

// ─────────────────── classifySectors: valida, jamás inventa ───────────────────
console.log('classifySectors: la respuesta se valida contra la lista o se descarta');
{
  const titles = ['Acme Raises $12M for AI agents', 'PayCo lands $5M Seed', 'ClinicX Series A'];
  const mockCall = (reply) => async () => ({ status: 200, data: { content: [{ type: 'text', text: reply }] } });

  let sectors = await classifySectors(titles, 'k', mockCall('["AI","fintech","salud"]'));
  ok(JSON.stringify(sectors) === JSON.stringify(['AI', 'fintech', 'salud']), 'array válido → sectores', JSON.stringify(sectors));

  sectors = await classifySectors(titles, 'k', mockCall('["AI","fintech"]'));
  ok(sectors === null, 'longitud distinta (item inventado/omitido) → null entero', JSON.stringify(sectors));

  sectors = await classifySectors(titles, 'k', mockCall('["AI","crypto","salud"]'));
  ok(JSON.stringify(sectors) === JSON.stringify(['AI', 'otro', 'salud']), 'valor fuera de whitelist → "otro"', JSON.stringify(sectors));

  sectors = await classifySectors(titles, 'k', mockCall('sorry, no puedo'));
  ok(sectors === null, 'sin JSON en la respuesta → null');

  sectors = await classifySectors(titles, 'k', async () => { throw new Error('api down'); });
  ok(sectors === null, 'excepción de la IA → null, nunca revienta');

  sectors = await classifySectors([], 'k', async () => { throw new Error('no debería llamarse'); });
  ok(JSON.stringify(sectors) === '[]', 'lista vacía → [] sin llamar a la IA');
}

// ─────────────────── handler: cat=rounds ───────────────────
console.log('handler cat=rounds: parsea, filtra, marca fuente caída, cachea');
{
  _resetVcFeedCache();
  delete process.env.ANTHROPIC_API_KEY; // sin key → ai:'unavailable', sector null
  let fetchCount = 0;
  global.fetch = async (url) => {
    const u = String(url);
    fetchCount++;
    if (u.includes('finsmes.com')) {
      return textResponse(rssXml([
        { title: 'Acme Raises $12M in Series A Funding', desc: 'The round was led by Sequoia Capital.', pubDate: rfc822(1) },
        { title: 'Interview: a chat with a founder', pubDate: rfc822(1) },
      ]));
    }
    if (u.includes('techcrunch.com')) return textResponse('cloudflare says no', 403, 'text/html');
    throw new Error('fetch inesperado: ' + u);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'rounds' } }, res);
  const b = res.body;
  ok(res.code === 200, 'status 200', res.code);
  ok(b.items.length === 1, 'solo el titular con pinta de ronda (la entrevista fuera)', JSON.stringify(b.items.map((i) => i.title)));
  const it = b.items[0];
  ok(it.company === 'Acme' && it.amount === '$12M' && it.amount_millions === 12 && it.stage === 'A',
    'company/amount/stage extraídos', JSON.stringify(it));
  ok(it.lead === 'Sequoia Capital', 'lead del snippet (solo metadata)', it.lead);
  ok(it.date === iso(1), 'date = pubDate del feed', it.date);
  ok(it.link === 'https://example.com/x', 'link a la fuente', it.link);
  ok(!('snippet' in it) && !('desc' in it), 'el cuerpo NO viaja en el payload');
  ok(it.sector === null && b.ai === 'unavailable', 'sin ANTHROPIC_API_KEY → sector null, ai unavailable', b.ai);
  ok(b.sources.finsmes.ok === true && b.sources.techcrunch.ok === false && /403/.test(b.sources.techcrunch.error),
    'flags honestos por fuente', JSON.stringify(b.sources));
  ok(/s-maxage=7200/.test(res.headers['Cache-Control']), 'Cache-Control de rounds (2h)', res.headers['Cache-Control']);

  // segunda llamada: cache en memoria, cero fetches nuevos
  const before = fetchCount;
  const res2 = mockRes();
  await handler({ method: 'GET', query: { cat: 'rounds' } }, res2);
  ok(fetchCount === before && res2.body.items.length === 1, 'cache caliente → 0 fetches', fetchCount - before);
}

// ─────────────────── handler: stale cuando TODO cae ───────────────────
console.log('handler: todas las fuentes caídas → sirve stale con flags frescos');
{
  _expireVcFeedCache('rounds');
  global.fetch = async () => { throw new Error('network down'); };
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'rounds' } }, res);
  ok(res.code === 200 && res.body.stale === true && res.body.items.length === 1,
    'stale:true con los items del último build bueno', JSON.stringify({ stale: res.body.stale, n: res.body.items.length }));
  ok(res.body.sources.finsmes.ok === false && res.body.sources.techcrunch.ok === false,
    'flags frescos de qué falló', JSON.stringify(res.body.sources));

  // sin stale disponible → payload vacío honesto, nunca inventa
  _resetVcFeedCache();
  const res2 = mockRes();
  await handler({ method: 'GET', query: { cat: 'rounds' } }, res2);
  ok(res2.code === 200 && res2.body.items.length === 0 && res2.body.stale === false,
    'sin stale → vacío honesto', JSON.stringify(res2.body.items));
}

// ─────────────────── handler: cat=latam ───────────────────
console.log('handler cat=latam: país destacado + fallback de slug');
{
  _resetVcFeedCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('latamlist.com/category/funding/feed')) return textResponse('nope', 404, 'text/html');
    if (u.includes('latamlist.com/feed')) {
      return textResponse(rssXml([
        { title: 'Kredi raises $20M Series A to expand in Mexico', desc: 'Led by Kaszek.', cats: ['Funding'], pubDate: rfc822(2) },
      ]));
    }
    if (u.includes('contxto.com')) {
      return textResponse(rssXml([
        { title: 'Fintech brasileña Nomad levanta US$60M', desc: 'ronda liderada por Tiger', pubDate: rfc822(4) },
      ]));
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'latam' } }, res);
  const b = res.body;
  ok(b.items.length === 2, '2 items de 2 fuentes', JSON.stringify(b.items.map((i) => i.title)));
  ok(b.items[0].country === 'Mexico', 'país del titular (Mexico)', JSON.stringify(b.items.map((i) => i.country)));
  ok(b.items[1].country === 'Brazil', 'país del titular (Brazil, en español)', b.items[1].country);
  ok(b.sources.latamlist.ok === true && /latamlist\.com\/feed/.test(b.sources.latamlist.url),
    'slug de categoría 404 → fallback al feed principal, flag con URL usada', JSON.stringify(b.sources.latamlist));
  ok(/s-maxage=28800/.test(res.headers['Cache-Control']), 'Cache-Control de latam (8h)', res.headers['Cache-Control']);
}

// ─────────────────── handler: cat=ipo ───────────────────
console.log('handler cat=ipo: Finnhub calendar + pipeline S-1 de EDGAR');
{
  _resetVcFeedCache();
  process.env.FINNHUB_API_KEY = 'test-key';
  const atom = '<feed>' +
    `<entry><title>S-1 - NEWCO INC (0001111111) (Filer)</title>` +
    `<link href="https://www.sec.gov/Archives/edgar/data/1111111/z-index.htm"/>` +
    `<updated>${new Date(Date.now() - 864e5).toISOString()}</updated></entry></feed>`;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('finnhub.io/api/v1/calendar/ipo')) {
      return textResponse(JSON.stringify({ ipoCalendar: [
        { symbol: 'NEW', name: 'Newco Inc', date: iso(-10), exchange: 'NASDAQ', status: 'expected', price: '$10-$12', numberOfShares: 5000000 },
      ] }), 200, 'application/json');
    }
    if (u.includes('sec.gov')) return textResponse(atom, 200, 'application/atom+xml');
    throw new Error('fetch inesperado: ' + u);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'ipo' } }, res);
  const b = res.body;
  ok(b.items.length === 1 && b.items[0].symbol === 'NEW' && b.items[0].price_range === '$10-$12',
    'calendario Finnhub mapeado', JSON.stringify(b.items));
  ok(b.pipeline.length === 1 && b.pipeline[0].company === 'NEWCO INC' && b.pipeline[0].form === 'S-1',
    'pipeline S-1 de EDGAR', JSON.stringify(b.pipeline));
  ok(b.sources.finnhub.ok === true && b.sources.edgar.ok === true, 'flags de ambas fuentes', JSON.stringify(b.sources));
  ok(/s-maxage=86400/.test(res.headers['Cache-Control']), 'Cache-Control de ipo (24h)', res.headers['Cache-Control']);
}

// ─────────────────── handler: ?smoke=1 ───────────────────
console.log('handler ?smoke=1: status + primeros bytes de cada fuente, sin cache');
{
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('finsmes.com')) return textResponse(rssXml([{ title: 'X raises $1M Seed' }]));
    if (u.includes('techcrunch.com')) return textResponse('<html>Attention Required! | Cloudflare</html>', 403, 'text/html');
    if (u.includes('sec.gov')) return textResponse('<feed><entry><title>S-1 - A CO (0001111111) (Filer)</title><updated>' + new Date().toISOString() + '</updated></entry></feed>', 200, 'application/atom+xml');
    throw new Error('ECONNRESET');
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { smoke: '1' } }, res);
  const b = res.body;
  ok(res.code === 200 && b.smoke === true, 'smoke responde 200 con smoke:true');
  ok(res.headers['Cache-Control'] === 'no-store', 'smoke jamás se cachea', res.headers['Cache-Control']);
  const names = b.results.map((r) => r.name);
  ok(['finsmes', 'techcrunch_venture', 'latamlist_funding', 'latamlist_main', 'contxto_en', 'contxto_main', 'crunchbase_news', 'edgar_s1_atom']
    .every((n) => names.includes(n)), 'cubre todas las fuentes candidatas', JSON.stringify(names));
  const fin = b.results.find((r) => r.name === 'finsmes');
  ok(fin.ok === true && fin.looks_like_feed === true && fin.items_parsed === 1 && fin.sample.length > 0,
    'fuente sana: ok + feed detectado + items parseados + sample', JSON.stringify(fin));
  const tc = b.results.find((r) => r.name === 'techcrunch_venture');
  ok(tc.ok === false && tc.status === 403 && /Cloudflare/.test(tc.sample),
    'fuente bloqueada: status 403 + sample delata a Cloudflare', JSON.stringify(tc));
  const cx = b.results.find((r) => r.name === 'contxto_en');
  ok(cx.ok === false && /ECONNRESET/.test(cx.error), 'fuente que revienta: error capturado', JSON.stringify(cx));
}

// ─────────────────── validación de cat ───────────────────
console.log('handler: cat inválida → 400 con uso');
{
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'nope' } }, res);
  ok(res.code === 400 && /rounds \| latam \| ipo/.test(res.body.error), '400 con hint', JSON.stringify(res.body));
  const res2 = mockRes();
  await handler({ method: 'GET', query: {} }, res2);
  ok(res2.code === 400, 'sin cat → 400', res2.code);
}

global.fetch = realFetch;
if (realAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realAnthropicKey;
if (realFinnhubKey === undefined) delete process.env.FINNHUB_API_KEY; else process.env.FINNHUB_API_KEY = realFinnhubKey;
console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
