// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-glosario.js — traducir sin concluir.
//
// Un código legal sin traducir no le dice nada a nadie, y traducirlo no es
// narrar: el diccionario lo publica la SEC. Lo que estos tests fijan es la
// línea — que la glosa no diga MÁS que el item, que es la forma fácil de
// convertir un diccionario en una conclusión.
//
// Los tres casos donde la versión corriente sobre-afirma, y que acá quedan
// clavados:
//
//   · **5.02** no es solo "cambio de directivos": cubre salidas,
//     nombramientos Y compensación. Un 5.02 puede ser un ajuste salarial sin
//     que nadie se haya ido.
//   · **8.01** no es "otro evento relevante": el texto de la SEC es "Other
//     Events" y el item es opcional. "Relevante" agrega materialidad.
//   · **SC 13D** no es "con intención de influir": eso es una inferencia
//     sobre la intención de un tercero. El hecho es qué régimen usó.
//
// Y el agrupamiento de la pelea: cuenta documentos y fechas (aritmética), no
// quién ganó ni si sigue abierta (lectura).
//
// Correr con `node tests/historia-glosario.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  ITEMS_8K, FORMAS, FORMAS_CONTIENDA, UMBRAL_EPISODIO_DIAS,
  glosarItem, glosarForma, esContienda, agruparEpisodios, resumirDocumentos,
} from '../api/_lib/historia-glosario.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El diccionario: forma, no fondo');
{
  eq(glosarItem('5.02').codigo, '5.02', 'el código se conserva, no se reemplaza');
  ok(glosarItem('2.02').oficial.includes('Results of Operations'), 'el título oficial es la cita textual de la SEC');
  eq(glosarItem('2.02', 'es').glosa, 'resultados del periodo', 'y la glosa va aparte, en español');
  eq(glosarItem('2.02', 'en').glosa, 'results of operations', 'y en inglés');

  // El oficial NO se traduce: es una cita. Traducirlo lo convertiría en
  // nuestra versión de lo que dice la SEC.
  ok(ITEMS_8K['5.02'].oficial === ITEMS_8K['5.02'].oficial.normalize(), 'el oficial es un solo string, sin variante por idioma');
  ok(Object.values(ITEMS_8K).every((e) => e.oficial && e.es && e.en), 'todo item tiene oficial, es y en');
  ok(Object.values(FORMAS).every((e) => e.oficial && e.es && e.en), 'toda forma también');

  // Un código desconocido no se inventa.
  hondo(glosarItem('9.99'), { codigo: '9.99', oficial: null, glosa: null, glosa_es: null },
    'un item que no está en el diccionario devuelve glosa null, no una inventada');
  hondo(glosarForma('SC 14D9'), { codigo: 'SC 14D9', oficial: null, glosa: null, glosa_es: null },
    'y una forma desconocida igual');

  eq(glosarForma('def 14a').glosa, glosarForma('DEF 14A').glosa, 'la forma se busca sin importar mayúsculas');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La glosa no puede decir MÁS que el item');
{
  // 5.02 cubre tres cosas, no una.
  const g502 = glosarItem('5.02', 'es');
  ok(/compensaci/i.test(g502.glosa), '5.02 nombra la compensación: un 5.02 puede ser solo un ajuste salarial');
  ok(/salida|nombramiento/i.test(g502.glosa), '…y también las salidas y nombramientos');
  ok(/Compensatory Arrangements/.test(g502.oficial), 'el oficial lo confirma');

  // 8.01 es opcional y no afirma materialidad.
  const g801 = glosarItem('8.01', 'es');
  eq(g801.oficial, 'Other Events', 'el oficial de 8.01 es "Other Events", sin más');
  ok(!/relevante|material/i.test(g801.glosa), '8.01 NO dice "relevante": el item no afirma materialidad');
  ok(/eligió divulgar/i.test(g801.glosa), 'dice lo que sí es: que la empresa eligió divulgarlo');

  // 13D: el hecho es el régimen, no la intención.
  const g13d = glosarForma('SC 13D', 'es');
  ok(!/intención|influir|activis/i.test(g13d.glosa), 'SC 13D no infiere la intención de un tercero');
  ok(/pasivo/i.test(g13d.glosa), 'dice qué régimen NO usó, que es el hecho');
  ok(/pasiva/i.test(glosarForma('SC 13G', 'es').glosa), 'y 13G sí es pasiva, que también es el hecho');

  // 4.02 es la contraevidencia más literal que EDGAR produce, y se dice
  // entera: el item ES esa afirmación.
  ok(/ya no son confiables/i.test(glosarItem('4.02', 'es').glosa), '4.02 dice lo que el item dice');

  // Nada de vocabulario de recomendación en todo el diccionario.
  const todo = JSON.stringify({ ITEMS_8K, FORMAS }).toLowerCase();
  for (const w of ['comprar', 'vender', 'recomend', 'bueno', 'malo', 'riesgo de']) {
    ok(!todo.includes(w), `el diccionario no contiene "${w}"`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La contienda sale del NOMBRE de la forma, no de una inferencia');
{
  hondo(FORMAS_CONTIENDA, ['PREC14A', 'DEFC14A', 'PRRN14A', 'DFAN14A'], 'las cuatro formas de solicitación impugnada');
  ok(esContienda('DFAN14A'), 'DFAN14A es contienda: la N es de non-management');
  ok(esContienda('dfan14a'), 'sin importar mayúsculas');
  ok(!esContienda('DEF 14A'), 'una convocatoria normal NO es contienda');
  ok(!esContienda('DEFA14A'), 'ni el material adicional de la propia empresa');
  ok(!esContienda(null), 'ni null');
  ok(/Contested/.test(FORMAS.DEFC14A.oficial), 'y el oficial de DEFC14A lo dice: la C es de contested');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Los episodios: aritmética sobre documentos');
{
  const d = (form, filed) => ({ form, filed, accession: `a-${filed}` });

  // El caso de LULU: 34 filings de contienda en ~5 meses.
  const lulu = [
    ...Array.from({ length: 30 }, (_, i) => d('DFAN14A', `2026-0${1 + (i % 4)}-${String(1 + (i % 27)).padStart(2, '0')}`)),
    d('PREC14A', '2025-12-15'), d('PREC14A', '2025-12-22'),
    d('DEFC14A', '2026-02-10'), d('DEFC14A', '2026-05-20'),
    // Ruido que no es contienda y no debe entrar.
    d('DEF 14A', '2026-03-01'), d('SC 13G', '2026-01-10'),
  ];
  const eps = agruparEpisodios(lulu);
  eq(eps.length, 1, 'una racha contigua es UN episodio');
  eq(eps[0].total, 34, 'con los 34 filings de contienda…');
  eq(eps[0].desde, '2025-12-15', '…su primera fecha…');
  eq(eps[0].hasta, '2026-05-20', '…y su última');
  eq(eps[0].por_forma.DFAN14A, 30, 'desglosado por forma: 30 DFAN14A');
  eq(eps[0].por_forma.PREC14A, 2, '2 PREC14A');
  eq(eps[0].por_forma.DEFC14A, 2, 'y 2 DEFC14A');
  ok(!eps[0].documentos.some((x) => x.form === 'DEF 14A'), 'la convocatoria normal no se cuela');
  ok(!eps[0].documentos.some((x) => x.form === 'SC 13G'), 'ni la posición pasiva');

  // El umbral es NUESTRO y viaja con el episodio.
  eq(eps[0].umbral_dias, UMBRAL_EPISODIO_DIAS, 'el umbral de agrupamiento viaja en la respuesta');
  ok(UMBRAL_EPISODIO_DIAS > 0, 'y es un número, no una corazonada sin nombre');

  // Dos peleas separadas por años NO son una.
  const dos = agruparEpisodios([d('DEFC14A', '2020-03-01'), d('DEFC14A', '2026-03-01')]);
  eq(dos.length, 2, 'seis años de hueco son dos episodios, no uno');
  eq(dos[0].hasta, '2026-03-01', 'y el más reciente va primero');

  // Justo en el borde del umbral.
  eq(agruparEpisodios([d('DEFC14A', '2026-01-01'), d('DEFC14A', '2026-04-30')]).length, 1,
    '119 días siguen siendo el mismo episodio');
  eq(agruparEpisodios([d('DEFC14A', '2026-01-01'), d('DEFC14A', '2026-05-02')]).length, 2,
    '121 días ya son dos');

  hondo(agruparEpisodios([]), [], 'sin documentos no hay episodios');
  hondo(agruparEpisodios([d('DEF 14A', '2026-01-01')]), [], 'sin contienda tampoco');
  hondo(agruparEpisodios([d('DEFC14A', null)]), [], 'un filing sin fecha no arma un episodio');

  // Lo que el episodio NO dice.
  const json = JSON.stringify(eps[0]).toLowerCase();
  for (const w of ['ganó', 'gano', 'perdió', 'exitos', 'fracas', 'activista', 'abierta']) {
    ok(!json.includes(w), `el episodio no afirma "${w}"`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El resumen cuenta el TOTAL, no la página');
{
  const docs = [
    { form: '8-K', filed: '2026-02-20', items: ['5.02', '9.01'] },
    { form: '8-K', filed: '2025-06-01', items: ['5.02'] },
    { form: 'DEF 14A', filed: '2024-04-01', items: [] },
  ];

  const r = resumirDocumentos(docs);
  eq(r.total, 3, 'sin total externo cuenta los que hay');
  eq(r.desde, '2024-04-01', 'la fecha más vieja');
  eq(r.hasta, '2026-02-20', 'y la más nueva');
  eq(r.por_item['5.02'], 2, 'cuenta por item');
  eq(r.por_forma['8-K'], 2, 'y por forma');
  eq(r.truncado, false, 'nada truncado');

  // El caso que importa: se muestran 40 de 196.
  const t = resumirDocumentos(docs, { total: 196, desde: '2021-12-03', hasta: '2026-09-15' });
  eq(t.total, 196, 'el conteo es del TOTAL, no de los mostrados');
  eq(t.mostrados, 3, 'y se dice cuántos se muestran');
  eq(t.truncado, true, 'marcado como truncado');
  eq(t.desde, '2021-12-03', 'el rango también es el verdadero, no el de la página');
  eq(t.hasta, '2026-09-15', 'de punta a punta');

  const v = resumirDocumentos([]);
  eq(v.total, 0, 'sin documentos, cero');
  eq(v.desde, null, 'y sin rango inventado');
  eq(v.hasta, null, 'ninguna de las dos puntas');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
