// ═══════════════════════════════════════════════════════════════
// tests/arena-nasdaq100.test.mjs — constituyentes del Nasdaq 100, gratis.
//
// CONTEXTO QUE IMPORTA PARA LEER ESTE ARCHIVO: el entorno donde se escribió
// NO pudo alcanzar ni Wikipedia ni slickcharts (la política de egress rechazó
// el CONNECT a las dos). Los parsers se escribieron a ciegas, contra estas
// fixtures. Por eso los tests no se limitan al camino feliz: la mayoría son
// intentos de romper el parser con lo que una página real trae alrededor de la
// tabla, y el cruce entre fuentes es lo que se prueba como GUARD, no como
// adorno.
// Correr con `node tests/arena-nasdaq100.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  parseWikitextNasdaq, parseSlickcharts, esTickerPlausible, fetchNasdaq100,
  desdeEnv, ENV_SIMBOLOS, MIN_NOMBRES, MAX_NOMBRES, CRUCE_MINIMO, RUIDO,
} from '../api/_lib/arena-nasdaq100.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// 100 tickers sintéticos, con forma legal y distintos entre sí.
const cien = Array.from({ length: 100 }, (_, i) => 'T' + String(i).padStart(3, '0').replace(/(\d)(\d)(\d)/, (m, a, b, c) => 'ABCDEFGHIJ'[a] + 'ABCDEFGHIJ'[b] + 'ABCDEFGHIJ'[c]));
const wikiDe = (syms) => syms.map((t) => `|-\n| [[${t} Corporation|${t} Corp]] || ${t} || Technology`).join('\n');
const slickDe = (syms) => syms.map((t) => `<tr><td><a href="/symbol/${t}">${t}</a></td></tr>`).join('');

console.log('\n── el discriminante: mayúscula antes de normalizar ──');
{
  ok(esTickerPlausible('AAPL'), 'AAPL es ticker');
  ok(!esTickerPlausible('Apple'), 'Apple NO: viene en Title Case, y ése es el dato que lo separa de un ticker');
  ok(!esTickerPlausible('APPLE'.slice(0, 5)) === false, 'APPLE en mayúsculas sí pasa la forma — por eso el caso se mira ANTES de normalizar');
  ok(!esTickerPlausible('GICS') && !esTickerPlausible('USD'), 'el ruido conocido se filtra por lista, porque la forma no lo distingue');
  ok(!esTickerPlausible('TOOLONG'), 'siete letras no es un ticker de Nasdaq');
  ok(!esTickerPlausible(''), 'vacío tampoco');
  ok(esTickerPlausible('aapl', { yaNormalizado: true }), 'con yaNormalizado se salta la prueba de caso (el href de slickcharts)');
}

console.log('\n── la lista de ruido NO puede comerse nombres verdaderos ──');
{
  // EL BUG: la primera versión traía las abreviaturas de los meses. MAR es
  // Marriott International, constituyente REAL del Nasdaq 100 — se habría
  // borrado en silencio de las DOS fuentes, o sea sin que el cruce lo notara,
  // porque las dos se filtran igual. Un nombre desaparecido que ningún guard
  // puede ver es el peor tipo de bug acá.
  ok(esTickerPlausible('MAR'), 'MAR pasa: es Marriott, no el mes de marzo');
  ok(['JAN', 'MAY', 'JUN', 'AUG', 'DEC'].every((t) => esTickerPlausible(t)),
    'y ninguna abreviatura de mes se filtra: una columna de fechas trae "2019-11-21", no "MAR"');
  ok(['ON', 'CO', 'ALL', 'IT', 'SA', 'AG'].every((t) => esTickerPlausible(t)),
    'los sufijos societarios tampoco: varios son tickers reales, y uno solo en una celda nunca es un sufijo');
  ok(!esTickerPlausible('GICS') && !esTickerPlausible('CUSIP') && !esTickerPlausible('USD'),
    'en la lista solo queda lo que NO PUEDE ser un ticker de este índice');
}

console.log('\n── el parser de wikitext contra lo que rodea a la tabla ──');
{
  const sucio = `
{{Short description|Stock market index}}
'''Nasdaq-100''' is a [[stock market index]].
== Components ==
{| class="wikitable sortable"
! Company !! Ticker !! GICS Sector
|-
| [[Apple Inc.|Apple]] || AAPL || Information Technology
|-
| [[Microsoft]] || MSFT || Information Technology
|-
| [[Alphabet Inc.|Alphabet]] || GOOGL || Communication Services
|}
== See also ==
* [[NASDAQ Composite]]
[[Category:NASDAQ]]`;
  const r = parseWikitextNasdaq(sucio);
  ok(r.join(',') === 'AAPL,MSFT,GOOGL', 'saca los tres tickers y nada más', JSON.stringify(r));
  ok(!r.includes('GICS'), 'el encabezado "GICS" no se cuela (empieza con ! y además está en la lista de ruido)');
  ok(!r.some((t) => /APPLE|MICROSOFT|ALPHABET/.test(t)), 'ningún nombre de empresa se cuela');
  ok(parseWikitextNasdaq('').length === 0 && parseWikitextNasdaq(null).length === 0, 'vacío o null → lista vacía, sin explotar');

  const dup = parseWikitextNasdaq('|-\n| [[Apple]] || AAPL || Tech\n|-\n| [[Apple dup]] || AAPL || Tech');
  ok(dup.length === 1 && dup[0] === 'AAPL', 'un ticker repetido sale una sola vez', JSON.stringify(dup));

  // ── LA COLUMNA GANA POR CONSISTENCIA, NO POR PARECER ──────────────
  // Una celda de UNA letra mayúscula cumple la forma de ticker. Si el parser
  // tomara "cualquier celda que parece", esa columna se colaría entera.
  const conSenuelo = parseWikitextNasdaq(
    '|-\n| [[Apple Inc.|Apple]] || AAPL || Information Technology || A\n'
    + '|-\n| [[Microsoft]] || MSFT || Information Technology || B\n'
    + '|-\n| [[Alphabet]] || GOOGL || Communication Services || C');
  ok(conSenuelo.join(',') === 'AAPL,MSFT,GOOGL',
    'con una columna señuelo de una sola letra, gana la columna que es ticker en TODAS las filas',
    JSON.stringify(conSenuelo));

  // Y si la columna del ticker se mueve de lugar, el parser la sigue.
  const movida = parseWikitextNasdaq(
    '|-\n| AAPL || [[Apple Inc.|Apple]] || Information Technology\n'
    + '|-\n| MSFT || [[Microsoft]] || Information Technology\n'
    + '|-\n| GOOGL || [[Alphabet]] || Communication Services');
  ok(movida.join(',') === 'AAPL,MSFT,GOOGL',
    'y si Wikipedia reordena las columnas, el parser la sigue sin tocar código',
    JSON.stringify(movida));
}

console.log('\n── el parser de slickcharts ──');
{
  const html = '<table><tr><td>1</td><td><a href="/symbol/AAPL">Apple</a></td></tr><tr><td><a href="/symbol/MSFT">Microsoft</a></td></tr></table><a href="/nasdaq100">otra cosa</a>';
  const r = parseSlickcharts(html);
  ok(r.join(',') === 'AAPL,MSFT', 'se ancla a /symbol/TICKER, no a la posición de la columna', JSON.stringify(r));
  ok(!r.includes('NASDAQ100'), 'un enlace que no es /symbol/ no entra');
}

console.log('\n── la horquilla: el techo atrapa el parser que agarra de más ──');
{
  const corta = cien.slice(0, 40);
  const larga = Array.from({ length: 300 }, (_, i) => 'Z' + String(i));
  const r1 = await fetchNasdaq100({ deps: { fetchWikipedia: async () => corta, fetchSlickcharts: async () => corta } });
  ok(r1 === null, `${corta.length} nombres < piso ${MIN_NOMBRES} → no se publica`);

  const diag = [];
  const r2 = await fetchNasdaq100({ diag, deps: { fetchWikipedia: async () => larga, fetchSlickcharts: async () => larga } });
  ok(r2 === null, `300 nombres > techo ${MAX_NOMBRES} → tampoco: 300 no son un índice de 100, son basura con forma de ticker`);
  ok(diag.some((d) => d.reason === 'lista_larga'), 'y el journal nombra el techo, no un "falló" mudo', JSON.stringify(diag.filter((d) => d.reason)));
}

console.log('\n── EL CRUCE es el guard ──');
{
  const diag = [];
  const r = await fetchNasdaq100({ diag, deps: { fetchWikipedia: async () => cien, fetchSlickcharts: async () => cien } });
  ok(r && r.symbols.length === 100, 'dos fuentes que coinciden → se publica', r && String(r.symbols.length));
  ok(r.cruce.estado === 'cruzado' && r.cruce.ratio === 1, 'con el ratio journaleado', JSON.stringify(r.cruce));
  ok(r.source === 'tabla_publica' && r.origen === 'wikipedia+slickcharts', 'y diciendo de dónde salió');

  // Un rebalanceo: una fuente ya lo reflejó, la otra no. 5 de 100 difieren.
  const conRebalanceo = [...cien.slice(0, 95), 'NEWA', 'NEWB', 'NEWC', 'NEWD', 'NEWE'];
  const r2 = await fetchNasdaq100({ deps: { fetchWikipedia: async () => cien, fetchSlickcharts: async () => conRebalanceo } });
  ok(r2 && r2.symbols.length === 95,
    'un rebalanceo que una fuente todavía no refleja NO tumba la lista: se publica la intersección y los nuevos entran solos la semana que viene',
    r2 && String(r2.symbols.length));

  // Dos listas que pasan la horquilla y no se parecen: al menos una lee otra cosa.
  const otraCosa = Array.from({ length: 100 }, (_, i) => 'Q' + String(i).padStart(3, '0').replace(/(\d)(\d)(\d)/, (m, a, b, c) => 'ABCDEFGHIJ'[a] + 'ABCDEFGHIJ'[b] + 'ABCDEFGHIJ'[c]));
  const diag3 = [];
  const r3 = await fetchNasdaq100({ diag: diag3, deps: { fetchWikipedia: async () => cien, fetchSlickcharts: async () => otraCosa } });
  ok(r3 === null,
    `dos listas del tamaño correcto que no coinciden (< ${CRUCE_MINIMO}) → NO se publica ninguna: no hay forma de saber cuál está mal`);
  ok(diag3.some((d) => d.reason === 'cruce_insuficiente'), 'y queda dicho por qué', JSON.stringify(diag3.filter((d) => d.reason)));
}

console.log('\n── una sola fuente: se acepta, pero con asterisco ──');
{
  const diag = [];
  const r = await fetchNasdaq100({ diag, deps: {
    fetchWikipedia: async () => cien,
    fetchSlickcharts: async () => { const e = new Error('HTTP 503'); e.status = 503; throw e; },
  } });
  ok(r && r.symbols.length === 100, 'si slickcharts se cae, la lista de Wikipedia igual se publica (el índice es opcional: a medias es mejor que nada)');
  ok(r.cruce.estado === 'sin_cruce', 'pero el journal dice que NADIE la corroboró', JSON.stringify(r.cruce));
  ok(diag.some((d) => d.origen === 'slickcharts' && d.ok === false), 'y la caída de la otra fuente queda registrada con su status');
}

console.log('\n── nada puede tumbar el universo desde acá ──');
{
  const r = await fetchNasdaq100({ deps: {
    fetchWikipedia: async () => { throw new Error('red'); },
    fetchSlickcharts: async () => { throw new Error('red'); },
  } });
  ok(r === null, 'las dos caídas → null, y el caller baja un escalón como con cualquier otra fuente');

  const basura = await fetchNasdaq100({ deps: {
    fetchWikipedia: async () => [...RUIDO],
    fetchSlickcharts: async () => [...RUIDO],
  } });
  ok(basura === null, 'y una lista hecha solo de ruido no llega a ningún lado');
}

console.log('\n── REGRESIÓN: el sobre del diagnóstico no puede ser pisado ──');
{
  // EL BUG (producción, 2026-09-18): `anota` armaba { fuente:'tabla_publica',
  // ...fila } con el spread AL FINAL, y `horquilla` devolvía una clave llamada
  // `fuente` con el valor 'wikipedia'. La fila de Wikipedia se guardaba con
  // `fuente: 'wikipedia'`, el filtro del endpoint busca 'tabla_publica', y la
  // fila EXISTÍA sin verse. Se leyó como "Wikipedia no se está llamando" —
  // conclusión falsa sobre la única fuente primaria que hay.
  const diag = [];
  await fetchNasdaq100({ diag, deps: {
    fetchWikipedia: async () => ['AAPL', 'MSFT'],                              // pasa, pero corta
    fetchSlickcharts: async () => { const e = new Error('HTTP 403'); e.status = 403; throw e; },
  } });

  ok(diag.every((d) => d.fuente === 'tabla_publica'),
    'TODAS las filas llevan el sobre correcto, incluida la que falló por horquilla',
    JSON.stringify(diag.map((d) => d.fuente)));

  const fw = diag.find((d) => d.origen === 'wikipedia');
  ok(fw, 'la fila de Wikipedia aparece — antes se perdía y parecía que la fuente no se llamaba');
  ok(fw.reason === 'lista_corta' && fw.recibidos === 2, 'con su motivo y cuántos llegaron', JSON.stringify(fw));
  ok(Array.isArray(fw.muestra) && fw.muestra.join(',') === 'AAPL,MSFT',
    'y con la MUESTRA de lo que extrajo: saber que llegaron 2 no arregla nada, saber cuáles sí',
    JSON.stringify(fw.muestra));

  const fs = diag.find((d) => d.origen === 'slickcharts');
  ok(fs && fs.status === 403, 'y la de slickcharts con su status', JSON.stringify(fs));
}

console.log('\n── la lista pegada a mano: la salida si producción no alcanza las fuentes ──');
{
  ok(desdeEnv({}) === null && desdeEnv({ [ENV_SIMBOLOS]: '   ' }) === null, 'sin la env var no pasa nada');
  const parseada = desdeEnv({ [ENV_SIMBOLOS]: 'aapl, MSFT;GOOGL  NVDA' });
  ok(parseada.join(',') === 'AAPL,MSFT,GOOGL,NVDA',
    'tolera comas, puntoycoma, espacios y minúsculas: quien la pega no debería pelear con el formato', JSON.stringify(parseada));
  ok(desdeEnv({ [ENV_SIMBOLOS]: 'AAPL,AAPL,MSFT' }).length === 2, 'y deduplica');

  // GANA sobre las fuentes, y no pide NADA por red.
  const diag = [];
  const r = await fetchNasdaq100({ diag, env: { [ENV_SIMBOLOS]: cien.join(',') }, deps: {
    fetchWikipedia: async () => { throw new Error('no debería llamarse'); },
    fetchSlickcharts: async () => { throw new Error('no debería llamarse'); },
  } });
  ok(r && r.symbols.length === 100, 'la lista pegada gana: es lo único que alguien escribió a propósito');
  ok(r.cruce.estado === 'pegada_a_mano', 'y el journal no la disfraza de cruce', JSON.stringify(r.cruce));
  ok(diag.some((d) => d.origen === 'env' && d.ok), 'con su fila de diagnóstico');

  // Pero pasa por la MISMA horquilla: venir de una persona no la exime.
  const diag2 = [];
  const corta = await fetchNasdaq100({ diag: diag2, env: { [ENV_SIMBOLOS]: 'AAPL,MSFT' }, deps: {
    fetchWikipedia: async () => null, fetchSlickcharts: async () => null,
  } });
  ok(corta === null, 'una lista pegada con un error de copiar y pegar NO entra por venir de una persona');
  ok(diag2.some((d) => d.origen === 'env' && d.ok === false && d.reason === 'lista_corta'),
    'y se dice por qué se ignoró, en vez de usarla en silencio o descartarla en silencio',
    JSON.stringify(diag2.filter((d) => d.origen === 'env')));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
