// ═══════════════════════════════════════════════════════════════
// tests/arena-metadata.test.mjs — la metadata POR NOMBRE que los rieles leen.
//
// EL AGUJERO QUE CIERRA. `validateTarget` decide R6 (sector), R9 (corto
// confirmado) y R10 (piso de precio del corto) a partir de
// `meta[sym] = { price, sector, shortable, easy_to_borrow }`. La sombra le
// pasaba `{}`, y con el mapa vacío pasaban DOS cosas:
//
//   · R9 rechazaba TODOS los cortos. Eso estaba dicho y era correcto como
//     regla, pero como estado permanente convertía al riel en una mordaza: la
//     sombra no podía decir NADA sobre cómo cortan los siete modelos.
//   · R6 —y esto NO saltaba a la vista— mandaba todos los nombres al bucket
//     UNKNOWN, que sumaba el bruto entero. Cualquier cartera de más del 50%
//     bruto violaba un tope de concentración sectorial calculado sobre un solo
//     sector que la ausencia de datos había inventado.
//
// Lo que se blinda acá:
//   1. El mapeo industria → sector es por REGLAS y las trampas de orden están
//      fijadas ("Biotechnology" no puede caer en Technology).
//   2. FAIL CLOSED de verdad: sin fila de Alpaca, el corto sigue rechazado.
//      Que ahora haya datos no puede AFLOJAR ningún riel.
//   3. Un nombre que falla NO se cachea como "no shortable" — eso volvería
//      permanente un fallo de red.
//
// Correr con `node tests/arena-metadata.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { sectorFromIndustry, SECTOR_RULES, buildRailMeta } from '../api/_lib/arena-meta.js';
import { validateTarget, RAILS, SECTOR_UNKNOWN } from '../api/_lib/arena-rails.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── industria → sector: el ORDEN de las reglas es el test ──');
{
  // La trampa: "Biotechnology" contiene "technolog". Si la regla de XLK corriera
  // antes que la de salud, todas las biotecs serían tecnológicas y la
  // concentración por sector estaría midiendo otra cosa. Es la misma familia de
  // bug que "Broker upgrades NVDA to Buy" cayendo en el patrón de fusiones por
  // el "to buy".
  ok(sectorFromIndustry('Biotechnology').etf === 'XLV',
    'Biotechnology → salud, aunque contenga "technolog"', sectorFromIndustry('Biotechnology').etf);
  ok(sectorFromIndustry('Financial Services').etf === 'XLF',
    'Financial Services → financieras, no al bucket genérico de servicios');
  ok(sectorFromIndustry('Professional Services').etf === 'XLI',
    'Professional Services → industriales');
  ok(sectorFromIndustry('Diversified Consumer Services').etf === 'XLY',
    'Diversified Consumer Services → consumo discrecional');
  ok(sectorFromIndustry('Semiconductors').etf === 'XLK', 'Semiconductors → tecnología');
  ok(sectorFromIndustry('Pharmaceuticals').etf === 'XLV', 'Pharmaceuticals → salud');
  ok(sectorFromIndustry('Metals & Mining').etf === 'XLB', 'Metals & Mining → materiales');
  ok(sectorFromIndustry('Hotels Restaurants & Leisure').etf === 'XLY', 'Hoteles y restaurantes → discrecional');

  // Lo que NINGUNA regla toca queda sin sector — y eso es una respuesta, no un
  // hueco. Inventarle un sector a una etiqueta desconocida sería peor que
  // decir que no se sabe.
  ok(sectorFromIndustry('Blockchain').etf === null,
    'una etiqueta que ninguna regla cubre NO se adivina: queda sin sector y se cuenta aparte');
  ok(sectorFromIndustry('').etf === null && sectorFromIndustry(null).etf === null,
    'sin industria, sin sector');
  ok(SECTOR_RULES.length >= 10, 'las once familias sectoriales están cubiertas', String(SECTOR_RULES.length));
}

console.log('\n── R9 sigue fallando CERRADO: los datos no aflojan el riel ──');
{
  const peso = { ZM: -0.10 };

  // (a) Sin metadata — el estado de antes de este bloque.
  const sinNada = validateTarget(peso, {}, RAILS);
  ok(sinNada.violations.some((x) => x.rail === 'R9'),
    'sin datos, el corto NO se abre (es el comportamiento de siempre)');

  // (b) CON fila de Alpaca pero que dice que no: sigue rechazado, y ahora con
  //     el motivo REAL en vez de "sin dato".
  const noPrestable = validateTarget(peso, { ZM: { sector: 'XLK', price: 80, shortable: false, easy_to_borrow: false } }, RAILS);
  ok(noPrestable.violations.some((x) => x.rail === 'R9'),
    'con fila que dice shortable=false, tampoco');
  ok(/shortable=false/.test(noPrestable.violations.find((x) => x.rail === 'R9').detail),
    'y el detalle dice el valor REAL, no "sin dato": ahora se distingue "no se puede" de "no se sabe"',
    noPrestable.violations.find((x) => x.rail === 'R9').detail);

  // (c) shortable pero NO easy-to-borrow: rechazado. Los dos, o ninguno —
  //     un hard-to-borrow es exactamente donde vive el buy-in forzado.
  const duro = validateTarget(peso, { ZM: { sector: 'XLK', price: 80, shortable: true, easy_to_borrow: false } }, RAILS);
  ok(duro.violations.some((x) => x.rail === 'R9'),
    'shortable pero hard-to-borrow: RECHAZADO — hacen falta los dos');

  // (d) Con los dos confirmados, el corto pasa. Ésta es la línea que la sombra
  //     no podía cruzar antes.
  const bueno = validateTarget(peso, { ZM: { sector: 'XLK', price: 80, shortable: true, easy_to_borrow: true } }, RAILS);
  ok(!bueno.violations.some((x) => x.rail === 'R9'),
    'con shortable + easy-to-borrow confirmados, R9 deja pasar el corto');
  ok(bueno.ok, 'y el objetivo entero pasa los rieles', JSON.stringify(bueno.violations));
}

console.log('\n── R6: sin sector, TODO caía en un bucket inventado ──');
{
  // Cuatro nombres de cuatro sectores distintos, 22% cada uno: 88% bruto.
  const pesos = { AAPL: 0.22, JPM: 0.22, XOM: 0.22, JNJ: 0.22 };

  // ESTE BLOQUE DOCUMENTABA EL BUG, y por eso cambió. Antes se verificaba que
  // sin sector R6 VIOLARA. En producción eso rechazó a openai y a gemini por
  // "concentración" cuando lo único que pasaba es que no teníamos el dato. Un
  // riel que castiga al PM por una falla NUESTRA mide otra cosa.
  const aCiegas = validateTarget(pesos, {}, RAILS);
  ok(!aCiegas.violations.some((x) => x.rail === 'R6'),
    'SIN sector, R6 ya NO viola: los cuatro en el bucket UNKNOWN son una falla de cobertura, no concentración');
  const avisoCiego = (aCiegas.warnings || []).find((x) => x.rail === 'R6');
  ok(avisoCiego && avisoCiego.sector === SECTOR_UNKNOWN && avisoCiego.es_falla_nuestra,
    '...sale como AVISO marcado como falla nuestra, que es lo que de verdad es',
    JSON.stringify(avisoCiego && { s: avisoCiego.sector, n: avisoCiego.es_falla_nuestra }));

  const conSector = validateTarget(pesos, {
    AAPL: { sector: 'XLK' }, JPM: { sector: 'XLF' }, XOM: { sector: 'XLE' }, JNJ: { sector: 'XLV' },
  }, RAILS);
  ok(!conSector.violations.some((x) => x.rail === 'R6'),
    'CON sector: la misma cartera pasa — estaba repartida de verdad, el bucket era el que mentía');

  // Y el tope sigue existiendo: concentrada de verdad, sigue rechazada.
  const concentrada = validateTarget({ AAPL: 0.30, MSFT: 0.30 }, {
    AAPL: { sector: 'XLK' }, MSFT: { sector: 'XLK' },
  }, RAILS);
  ok(concentrada.violations.some((x) => x.rail === 'R6'),
    'y 60% en un solo sector REAL sigue violando R6: se arregló la ceguera, no se aflojó el tope');
}

console.log('\n── buildRailMeta: qué arma, y qué NO afirma ──');
{
  const llamadas = { assets: 0, industry: 0, snapshots: 0 };
  const deps = {
    getSnapshots: async (syms) => {
      llamadas.snapshots++;
      return Object.fromEntries(syms.filter((s) => s !== 'SINPRECIO').map((s) => [s, { price: 100 }]));
    },
    getAssets: async (syms) => {
      llamadas.assets++;
      // TIESO falla (no vuelve en el mapa) — Alpaca no contestó por ese nombre.
      return Object.fromEntries(syms.filter((s) => s !== 'TIESO').map((s) => [s, {
        shortable: s !== 'NOPREST', easy_to_borrow: s !== 'NOPREST', tradable: true,
      }]));
    },
    fetchIndustry: async (sym) => { llamadas.industry++; return sym === 'RARO' ? 'Blockchain' : 'Semiconductors'; },
  };
  const { meta, diagnostics } = await buildRailMeta(['NVDA', 'NOPREST', 'TIESO', 'RARO', 'SINPRECIO'], { deps, now: new Date('2026-09-15T18:00:00Z') });

  ok(llamadas.snapshots === 1,
    'el precio se pide UNA vez para todos los nombres, no uno por uno', String(llamadas.snapshots));
  ok(meta.NVDA.shortable === true && meta.NVDA.easy_to_borrow === true && meta.NVDA.sector === 'XLK' && meta.NVDA.price === 100,
    'un nombre completo llega con los cuatro campos', JSON.stringify(meta.NVDA));
  ok(meta.NOPREST.shortable === false,
    'un nombre que Alpaca dice que NO es prestable llega con false — un dato, no un hueco');
  ok(meta.TIESO.shortable === undefined && meta.TIESO.easy_to_borrow === undefined,
    'un nombre que Alpaca no contestó llega SIN el campo: `undefined` es lo que R9 lee como "sin dato" y rechaza. Guardarlo como false volvería permanente un fallo de red',
    JSON.stringify(meta.TIESO));
  ok(meta.RARO.sector === undefined && meta.RARO.industry === 'Blockchain',
    'una industria sin regla viaja como industria pero NO como sector: se ve el dato crudo y se ve que no se pudo mapear',
    JSON.stringify(meta.RARO));
  ok(meta.SINPRECIO.price === undefined,
    'sin precio, el campo no viaja (R10 no puede comparar contra un precio inventado)');

  ok(diagnostics.shortable_ok === 3,
    'el diagnóstico cuenta cuántos quedaron habilitados para corto (NVDA, RARO y SINPRECIO)', String(diagnostics.shortable_ok));
  ok(diagnostics.borrow_missing.includes('TIESO'),
    'y NOMBRA al que quedó sin dato de borrow, en vez de dejarlo como un número',
    JSON.stringify(diagnostics.borrow_missing));
  ok(diagnostics.sector_unmapped.includes('RARO'),
    'lo mismo con el que no se pudo mapear a sector: una falla de cobertura tiene que verse como falla de cobertura',
    JSON.stringify(diagnostics.sector_unmapped));
  ok(/fail closed/i.test(diagnostics.note || ''),
    'y la nota dice explícitamente que el rechazo que viene es fail closed, no un bug', diagnostics.note);

  // El corto sobre TIESO sigue rechazado con esta metadata puesta.
  const v = validateTarget({ TIESO: -0.05 }, meta, RAILS);
  ok(v.violations.some((x) => x.rail === 'R9'),
    'con la metadata REAL en la mano, el nombre sin confirmar sigue sin poder cortarse');
}

// ═══════════════════════════════════════════════════════════════
// R6 RECHAZÓ POR UNA FALLA NUESTRA, NO POR CONCENTRACIÓN.
//
// Lo que pasó el 2026-09-15: la sombra rechazó a openai y a gemini por R6 con
// `sector: UNKNOWN`. No estaban concentrados — es que NINGÚN nombre tenía
// sector, los catorce cayeron al mismo bucket y la suma dio 100% "en un sector".
//
// Rechazar el objetivo entero por eso le carga al PM un error que no cometió.
// Es el mismo problema que tenía `data_unavailable` en el canal del día: el
// motivo equivocado manda a buscar al lugar equivocado.
// ═══════════════════════════════════════════════════════════════
console.log('\n── UNKNOWN es aviso; un sector real sigue violando ──');
{
  const pesos = { A: 0.2, B: 0.2, C: 0.2, D: 0.2, E: 0.2 };
  const ciego = validateTarget(pesos, {}, RAILS);
  ok(ciego.ok === true,
    'sin sector para nadie, el objetivo PASA: la falla es nuestra y no invalida su decisión', JSON.stringify(ciego.violations));
  ok(ciego.warnings.length === 1 && ciego.warnings[0].rail === 'R6' && ciego.warnings[0].es_falla_nuestra === true,
    'pero sale un AVISO de R6 marcado como falla nuestra — no desaparece en silencio',
    JSON.stringify(ciego.warnings.map((w) => w.rail)));
  ok(/NO es concentración sectorial/i.test(ciego.warnings[0].detail),
    'y el aviso lo dice con todas las letras', ciego.warnings[0].detail.slice(0, 80));
  ok(Array.isArray(ciego.warnings[0].symbols) && ciego.warnings[0].symbols.length === 5,
    'nombrando los símbolos sin clasificar, para poder ir a buscarlos');

  // Y el tope sigue existiendo donde el dato SÍ está.
  const concentrada = validateTarget({ A: 0.3, B: 0.3 }, { A: { sector: 'XLK' }, B: { sector: 'XLK' } }, RAILS);
  ok(!concentrada.ok && concentrada.violations.some((x) => x.rail === 'R6'),
    '60% en un sector REAL sigue siendo violación: se arregló la ceguera, no se aflojó el riel');

  // Mezcla: un sector real concentrado Y nombres sin clasificar.
  const mixta = validateTarget({ A: 0.3, B: 0.3, C: 0.2 }, { A: { sector: 'XLK' }, B: { sector: 'XLK' } }, RAILS);
  ok(mixta.violations.some((x) => x.rail === 'R6' && x.sector === 'XLK'),
    'con las dos cosas a la vez, el sector real viola');
  ok(!mixta.violations.some((x) => x.sector === 'UNKNOWN'),
    'y el bucket UNKNOWN no se suma a las violaciones');
}

console.log('\n── el sector del ÍNDICE gana sobre la heurística ──');
{
  const { sectorFromGics, buildRailMeta } = await import('../api/_lib/arena-meta.js');
  ok(sectorFromGics('Information Technology') === 'XLK' && sectorFromGics('Communication Services') === 'XLC',
    'los once nombres GICS del CSV de IVV se mapean uno a uno — no es heurística, es la clasificación del índice');
  ok(sectorFromGics('Vaya a saber') === null, 'y un nombre que no es GICS no se adivina');

  // El CSV dice Financials; Finnhub diría otra cosa. Gana el índice.
  const { meta, diagnostics } = await buildRailMeta(['JPM', 'DIADELDIA'], {
    sectoresConocidos: { JPM: 'Financials' },
    deps: {
      getSnapshots: async (syms) => Object.fromEntries(syms.map((x) => [x, { price: 100 }])),
      getAssets: async (syms) => Object.fromEntries(syms.map((x) => [x, { shortable: true, easy_to_borrow: true, tradable: true }])),
      fetchIndustry: async () => 'Semiconductors',
    },
    now: new Date('2026-09-16T18:00:00Z'),
  });
  ok(meta.JPM.sector === 'XLF',
    'JPM toma XLF del CSV del índice, NO el XLK que habría salido de la industria de Finnhub', meta.JPM.sector);
  ok(meta.DIADELDIA.sector === 'XLK',
    'y un nombre del día, que no está en ningún índice, sí cae a Finnhub', meta.DIADELDIA.sector);
  ok(diagnostics.sector_del_indice === 1 && diagnostics.sector_de_finnhub === 1,
    'el diagnóstico separa de dónde salió cada sector',
    JSON.stringify({ i: diagnostics.sector_del_indice, f: diagnostics.sector_de_finnhub }));
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
