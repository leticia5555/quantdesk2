// ═══════════════════════════════════════════════════════════════
// Tests del censo earnings-beat (Fase 0). JS puro, SIN RED:
//   - CRITERIOS congelados (si alguien mueve una portería, este test grita)
//   - normalizaMercado: los arrays que Gamma manda como string JSON
//   - outcomeResuelto: resuelto vs en disputa (no adivinar)
//   - pareceEarnings: el filtro y sus falsos positivos obvios
//   - resuelveSimbolo: ticker explícito, alias, nombre más largo, ambigüedad
//   - extraeConsensoEps: el consenso que Polymarket declara en la descripción
//   - precioEnT24h: NUNCA un tick posterior a T-24h (look-ahead)
//   - cruzaConPead: símbolo + fecha ±1 día, gana el más cercano
//   - evaluaFuentePIT: "el estimado de hoy" NO es point-in-time, y un CONTEO
//     de revisiones tampoco (regresión del falso positivo de la 1ª corrida)
//   - descubrimiento dirigido: tags, racimo y cosecha de public-search
// Correr con `node tests/earnings-beat.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  CRITERIOS, normalizaMercado, indiceYes, tokenYes, outcomeResuelto, pareceEarnings,
  construyeIndiceNombres, resuelveSimbolo, tickerExplicito, extraeConsensoEps,
  precioEnT24h, cruzaConPead, evaluaFuentePIT, resumenMarkdown, diasEntre, isoDia,
  esFecha, extraeTags, extraeCluster, FRASES_BUSQUEDA, detectaTopeUniforme,
} from '../api/_lib/earnings-beat.js';
import { filasDe, aplanaMercados, cosechaDeBusqueda, formaDe } from '../api/earnings-beat.js';
import { qs, rateHeaders } from '../api/_lib/polymarket.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('CRITERIOS congelados (mover una portería se ve en el diff Y acá)');

ok(CRITERIOS.min_mercados_cruzados === 100, 'candado de muestra = 100 mercados cruzados', CRITERIOS.min_mercados_cruzados);
ok(CRITERIOS.min_apuestas === 30, 'candado de apuestas = 30', CRITERIOS.min_apuestas);
ok(CRITERIOS.umbral_desacuerdo === 0.15, 'apuesta solo con |modelo − mercado| ≥ 15 pts', CRITERIOS.umbral_desacuerdo);
ok(CRITERIOS.costo_por_apuesta === 0.03, 'costo 3% por apuesta', CRITERIOS.costo_por_apuesta);
ok(CRITERIOS.horas_antes_precio === 24, 'precio del Yes a T-24h', CRITERIOS.horas_antes_precio);
ok(CRITERIOS.tolerancia_dias_cruce === 1, 'cruce con pead_earnings ±1 día', CRITERIOS.tolerancia_dias_cruce);
ok(CRITERIOS.frontera_eps === 0.01, 'beats de ≤ $0.01 se etiquetan frontera', CRITERIOS.frontera_eps);
ok(CRITERIOS.corte_entrenamiento === '2023-08-31', 'corte entrena/prueba congelado', CRITERIOS.corte_entrenamiento);
ok(CRITERIOS.baselines.join(',') === 'siempre_si,tasa_por_empresa', 'los dos baselines obligatorios', CRITERIOS.baselines.join(','));

console.log('normalizaMercado: Gamma manda arrays como string JSON');

const CRUDO = {
  id: 512345,
  slug: 'nvidia-beat-earnings-q3',
  question: 'Will NVIDIA beat earnings estimates?',
  description: 'This market resolves YES if NVIDIA reports quarterly EPS above the analyst consensus estimate of $0.75 per share.',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["1", "0"]',
  clobTokenIds: '["111222", "333444"]',
  endDate: '2026-02-26T00:00:00Z',
  closedTime: '2026-02-26T21:04:11Z',
  closed: true, active: false,
  volumeNum: 412000.5,
  umaResolutionStatus: 'resolved',
};
const m = normalizaMercado(CRUDO);
ok(Array.isArray(m.outcomes) && m.outcomes.length === 2, 'outcomes string-JSON → array', JSON.stringify(m.outcomes));
ok(m.precios_outcome[0] === 1 && m.precios_outcome[1] === 0, 'outcomePrices → números');
ok(m.token_ids[0] === '111222', 'clobTokenIds → strings (no se pierde precisión del id)');
ok(m.fin === '2026-02-26T21:04:11Z', 'fin = closedTime cuando existe (la resolución REAL)', m.fin);
ok(m.fin_declarado === '2026-02-26T00:00:00Z', 'fin_declarado conserva endDate');
ok(m.volumen === 412000.5 && m.cerrado === true, 'volumen y cerrado');
ok(Array.isArray(m.claves) && m.claves.includes('umaResolutionStatus'), 'guarda las claves crudas observadas');
ok(normalizaMercado(null) === null && normalizaMercado('x') === null, 'basura → null (no crashea)');

const sinArrays = normalizaMercado({ id: 1, question: 'x', outcomes: 'no-es-json' });
ok(sinArrays.outcomes.length === 0 && sinArrays.token_ids.length === 0, 'string no-JSON → arrays vacíos');

console.log('indiceYes / tokenYes / outcomeResuelto');

ok(indiceYes(['Yes', 'No']) === 0 && indiceYes(['No', 'Yes']) === 1, 'ubica el Yes en cualquier orden');
ok(indiceYes(['Up', 'Down']) === null, 'sin Yes → null');
ok(tokenYes(m) === '111222', 'token del Yes = el del índice del Yes', tokenYes(m));
ok(tokenYes(normalizaMercado({ ...CRUDO, outcomes: '["No", "Yes"]' })) === '333444', 'Yes en segundo lugar → segundo token');

const resuelto = outcomeResuelto(m);
ok(resuelto && resuelto.outcome === 'Yes' && resuelto.es_yes === true, 'precio 1/0 → resolvió Yes');
const resueltoNo = outcomeResuelto(normalizaMercado({ ...CRUDO, outcomePrices: '["0", "1"]' }));
ok(resueltoNo && resueltoNo.outcome === 'No' && resueltoNo.es_yes === false, 'precio 0/1 → resolvió No');
ok(outcomeResuelto(normalizaMercado({ ...CRUDO, outcomePrices: '["0.52", "0.48"]' })) === null, 'mercado vivo (0.52/0.48) → null, no se adivina');
ok(outcomeResuelto(normalizaMercado({ ...CRUDO, outcomePrices: '["1", "1"]' })) === null, 'dos ganadores → null (dato roto)');
ok(outcomeResuelto(normalizaMercado({ ...CRUDO, outcomePrices: '["1"]' })) === null, 'largos distintos → null');

console.log('pareceEarnings: el filtro del censo');

ok(pareceEarnings({ pregunta: 'Will NVIDIA beat earnings estimates?' }).si, 'pregunta de earnings → sí');
ok(pareceEarnings({ pregunta: 'Apple EPS above $1.50?' }).si, 'EPS en la pregunta → sí');
ok(pareceEarnings({ pregunta: 'Will Tesla beat consensus expectations?' }).si, 'beat + expectations → sí');
ok(!pareceEarnings({ pregunta: 'Will the Fed cut rates in March?' }).si, 'macro → no');
ok(!pareceEarnings({ pregunta: 'Who wins the Super Bowl?' }).si, 'deportes → no');
ok(!pareceEarnings({}).si, 'sin texto → no (no crashea)');
ok(pareceEarnings({ pregunta: 'Will NVIDIA beat earnings estimates?' }).senales.includes('earnings'), 'reporta qué señal matcheó');

console.log('resuelveSimbolo: ticker explícito, alias, nombre largo, ambigüedad');

const UNIV = new Set(['NVDA', 'AAPL', 'META', 'GOOGL', 'AMD', 'TSLA', 'GE']);
const idx = construyeIndiceNombres({ universo: UNIV });

ok(tickerExplicito('Will $NVDA beat?', UNIV) === 'NVDA', '$TICKER explícito');
ok(tickerExplicito('Nvidia (NVDA) earnings', UNIV) === 'NVDA', '(TICKER) explícito');
ok(tickerExplicito('Will THE FED cut?', UNIV) === null, 'palabra en mayúsculas que no está en el universo → null');
ok(tickerExplicito('Will T beat earnings?', UNIV) === null, 'ticker de 1 letra suelto → NO se acepta (T no es AT&T acá)');

ok(resuelveSimbolo({ pregunta: 'Will $NVDA beat earnings?' }, idx, UNIV).via === 'ticker', 'vía ticker');
const porAlias = resuelveSimbolo({ pregunta: 'Will Nvidia beat earnings estimates?' }, idx, UNIV);
ok(porAlias.symbol === 'NVDA' && porAlias.via === 'alias', 'vía alias (nombre comercial)', porAlias.symbol);
const porSlug = resuelveSimbolo({ slug: 'advanced-micro-devices-earnings-q4' }, idx, UNIV);
ok(porSlug.symbol === 'AMD', 'resuelve desde el slug (guiones → espacios)', porSlug.symbol);
const largo = resuelveSimbolo({ pregunta: 'Will General Electric beat earnings?' }, idx, UNIV);
ok(largo.symbol === 'GE', 'nombre largo gana al corto', largo.symbol);
const ambig = resuelveSimbolo({ pregunta: 'Meta and Alphabet both beat earnings?' }, idx, UNIV);
ok(ambig.ambiguo === true, 'dos empresas en un título → marcado ambiguo (no se resuelve a la brava)');
ok(resuelveSimbolo({ pregunta: 'Will the Fed cut rates?' }, idx, UNIV).symbol === null, 'sin empresa → null');

const idxMapa = construyeIndiceNombres({ alias: {}, nombres: { NVDA: 'NVIDIA CORP', ZZZZ: 'ZZZ HOLDINGS' }, universo: UNIV });
ok(idxMapa.some((e) => e.symbol === 'NVDA') && !idxMapa.some((e) => e.symbol === 'ZZZZ'), 'symbol map: recorta al universo (evita coincidencias absurdas)');

console.log('extraeConsensoEps: el consenso que Polymarket DECLARA');

const c1 = extraeConsensoEps(CRUDO.description);
ok(c1 && c1.valor === 0.75, 'lee "consensus estimate of $0.75"', c1 && c1.valor);
ok(c1 && typeof c1.fragmento === 'string' && c1.fragmento.includes('0.75'), 'guarda el fragmento (auditable a ojo)');
const c2 = extraeConsensoEps('Resolves YES if reported EPS is above $1.23 per share.');
ok(c2 && c2.valor === 1.23, 'lee "$1.23 per share"', c2 && c2.valor);
const c3 = extraeConsensoEps('Analysts forecast a loss of ($0.12) per share this quarter.');
ok(c3 && c3.valor === -0.12, 'notación contable ($0.12) → negativo', c3 && c3.valor);
ok(extraeConsensoEps('Will the Fed cut rates?') === null, 'sin monto → null');
ok(extraeConsensoEps(null) === null && extraeConsensoEps('') === null, 'null/vacío → null');

console.log('precioEnT24h: el look-ahead es el modo de falla que mata el estudio');

const FIN = Date.parse('2026-02-26T21:00:00Z');
const H = (horasAntes, p) => ({ t: Math.floor((FIN - horasAntes * 3600000) / 1000), p });
const hist = [H(72, 0.40), H(30, 0.55), H(25, 0.61), H(23, 0.70), H(1, 0.95)];
const p24 = precioEnT24h(hist, FIN);
ok(p24.precio === 0.61, 'toma el último tick ≤ T-24h (0.61), NO el de 23h (0.70)', p24.precio);
ok(p24.horas_antes_real === 25, 'reporta cuántas horas antes fue de verdad', p24.horas_antes_real);
ok(p24.rancio === false, 'tick de 25h con fin a 24h → no rancio');
ok(precioEnT24h([H(1, 0.95)], FIN).precio === null, 'solo ticks posteriores a T-24h → null (jamás el del futuro)');
ok(precioEnT24h([H(1, 0.95)], FIN).motivo === 'sin_ticks_antes_de_t24h', 'y dice por qué');
ok(precioEnT24h([], FIN).motivo === 'historial_vacio', 'historial vacío → motivo declarado');
ok(precioEnT24h(hist, null).motivo === 'sin_fecha_de_resolucion', 'sin fecha de resolución → motivo declarado');
const rancio = precioEnT24h([H(72, 0.4)], FIN);
ok(rancio.precio === 0.4 && rancio.rancio === true, 'último tick 72h antes → precio SÍ, marcado rancio', rancio.rancio);
const enMs = precioEnT24h([{ t: FIN - 30 * 3600000, p: 0.5 }], FIN);
ok(enMs.precio === 0.5, 'acepta timestamps en milisegundos igual que en segundos');

console.log('cruzaConPead: símbolo + fecha ±1 día');

const FILAS = [
  { symbol: 'NVDA', reported_date: '2026-02-26' },
  { symbol: 'NVDA', reported_date: '2025-11-19' },
  { symbol: 'AAPL', reported_date: '2026-01-29' },
];
const cruce = cruzaConPead([
  { symbol: 'NVDA', fecha_resolucion: '2026-02-27' },   // resolvió 1 día después
  { symbol: 'AAPL', fecha_resolucion: '2026-01-29' },   // mismo día
  { symbol: 'AAPL', fecha_resolucion: '2026-03-15' },   // fuera de tolerancia
  { symbol: 'ZZZZ', fecha_resolucion: '2026-01-29' },   // símbolo que no cosechamos
  { symbol: null, fecha_resolucion: '2026-01-29' },     // sin símbolo
], FILAS);
ok(cruce[0].cruce && cruce[0].cruce.dias === 1, 'resolución a +1 día cruza', cruce[0].cruce && cruce[0].cruce.dias);
ok(cruce[1].cruce && cruce[1].cruce.dias === 0, 'mismo día cruza');
ok(!cruce[2].cruce && cruce[2].motivo_sin_cruce === 'fecha_fuera_de_tolerancia', 'fuera de ±1 → motivo declarado', cruce[2].motivo_sin_cruce);
ok(!cruce[3].cruce && cruce[3].motivo_sin_cruce === 'simbolo_no_esta_en_pead_earnings', 'símbolo ausente → motivo declarado');
ok(!cruce[4].cruce && cruce[4].motivo_sin_cruce === 'sin_simbolo_o_fecha', 'sin símbolo → motivo declarado');
const cercano = cruzaConPead([{ symbol: 'NVDA', fecha_resolucion: '2025-11-19' }], [
  { symbol: 'NVDA', reported_date: '2025-11-18' }, { symbol: 'NVDA', reported_date: '2025-11-19' },
]);
ok(cercano[0].cruce.dias === 0, 'con dos candidatos gana el más cercano', cercano[0].cruce.dias);
ok(cruzaConPead([], []).length === 0 && cruzaConPead(null, null).length === 0, 'vacío/null → [] (no crashea)');
ok(diasEntre('2026-01-02', '2026-01-01') === 1 && isoDia('2026-02-26T21:04:11Z') === '2026-02-26', 'primitivas de fecha');

console.log('evaluaFuentePIT: ni "el estimado de hoy" ni un CONTEO son point-in-time');

const actual = { data: [{ period: '2026-03-31', epsAvg: 1.2 }, { period: '2026-06-30', epsAvg: 1.4 }] };
ok(evaluaFuentePIT(actual).pit === false, 'estimados actuales por período futuro → NO es PIT');
ok(evaluaFuentePIT(actual).motivo === 'sin_fecha_de_corte_por_estimado', 'y dice por qué', evaluaFuentePIT(actual).motivo);

// ── REGRESIÓN del falso positivo de la primera corrida ────────────────────
// La sonda marcó `pit: SÍ` una respuesta cuyas "revisiones" son CONTEOS de
// analistas (up/down últimos 7/30 días), no valores fechados. Dos filas del
// mismo período con conteos distintos parecían "dos cortes". No lo son: un
// conteo de hoy no dice qué se creía antes de un reporte de hace dos años.
const conteos = { estimates: [
  { horizon: 'next fiscal quarter', date: '2026-09-30', eps_estimate_average: '2.35',
    eps_estimate_revision_up_trailing_7_days: '2', eps_estimate_revision_down_trailing_7_days: '0',
    eps_estimate_revision_up_trailing_30_days: '5', eps_estimate_analyst_count: '12' },
  { horizon: 'current fiscal year', date: '2026-09-30', eps_estimate_average: '9.10',
    eps_estimate_revision_up_trailing_7_days: '4', eps_estimate_revision_down_trailing_7_days: '1',
    eps_estimate_revision_up_trailing_30_days: '9', eps_estimate_analyst_count: '14' },
]};
const rc = evaluaFuentePIT(conteos);
ok(rc.pit === false, 'CONTEOS de revisiones → NO es PIT (el falso positivo queda cerrado)', rc.pit);
ok(rc.motivo === 'las_revisiones_vienen_como_CONTEOS_no_como_valores_fechados', 'y nombra el hallazgo', rc.motivo);
ok(rc.revisiones_como_conteo === true, 'marca que la fuente trae revisiones como conteo');
ok(rc.fila_cruda && rc.fila_cruda.eps_estimate_average === '2.35', 'devuelve la FILA CRUDA para revisar a ojo');

// Una clave con nombre de fecha pero VALOR numérico tampoco alcanza.
const fechaFalsa = { data: [
  { period: '2026-03-31', as_of: 7, epsAvg: 1.1 }, { period: '2026-03-31', as_of: 30, epsAvg: 1.2 },
]};
ok(evaluaFuentePIT(fechaFalsa).pit === false, 'as_of numérico (no fecha) → NO es PIT', evaluaFuentePIT(fechaFalsa).motivo);

const conCorte = { data: [
  { period: '2026-03-31', asOf: '2026-01-15', eps_estimate_average: 1.10 },
  { period: '2026-03-31', asOf: '2026-02-15', eps_estimate_average: 1.18 },
] };
const rp = evaluaFuentePIT(conCorte);
ok(rp.pit === true, 'dos VALORES fechados del MISMO período → sí es PIT');
ok(rp.clave_corte === 'asOf' && rp.clave_valor === 'eps_estimate_average', 'reporta qué claves usó', rp.clave_corte + '/' + rp.clave_valor);
const unCorte = { data: [{ period: '2026-03-31', asOf: '2026-02-15', eps_estimate_average: 1.18 }] };
ok(evaluaFuentePIT(unCorte).pit === false && evaluaFuentePIT(unCorte).motivo === 'un_solo_corte_por_periodo_no_es_point_in_time', 'un corte por período → NO alcanza');
ok(evaluaFuentePIT({}).pit === false && evaluaFuentePIT(null).pit === false, 'vacío/null → no PIT (no crashea)');

ok(esFecha('2026-02-26') && esFecha('2026-02-26T21:00:00Z'), 'esFecha: ISO sí');
ok(!esFecha(7) && !esFecha('7') && !esFecha('') && !esFecha(null), 'esFecha: números y basura, no');

console.log('descubrimiento dirigido: tags, racimo y cosecha de la búsqueda');

ok(FRASES_BUSQUEDA.includes('beat quarterly earnings') && FRASES_BUSQUEDA.includes('beat its quarterly EPS estimate'),
  'las frases reales de estos mercados están en la lista');
// La plantilla del slug de NKE no dice "beat" en ninguna parte: si todas las
// frases lo exigen, esa mitad de la población no se ve y nada falla.
ok(FRASES_BUSQUEDA.some((f) => !/beat/i.test(f) && /earnings|EPS/i.test(f)),
  'hay al menos una frase SIN "beat" (la plantilla tipo nke-quarterly-earnings-gaap-eps)');
ok(FRASES_BUSQUEDA.some((f) => /GAAP/i.test(f)), 'y una que busca la forma GAAP EPS');

const conTags = { id: 1, tags: [{ id: '101', slug: 'earnings', label: 'Earnings' }], events: [{ id: '9', slug: 'ev', tags: [{ id: '2', slug: 'finance' }] }] };
const tags = extraeTags(conTags);
ok(tags.length === 2 && tags.some((t) => t.slug === 'earnings') && tags.some((t) => t.slug === 'finance'),
  'junta tags del mercado Y del evento que lo contiene', JSON.stringify(tags));
ok(extraeTags({ tags: [{ id: '1', slug: 'a' }, { id: '1', slug: 'a' }] }).length === 1, 'deduplica tags');
ok(extraeTags({}).length === 0 && extraeTags(null).length === 0, 'sin tags → [] (no crashea)');

const cl = extraeCluster({ id: 1, eventId: 77, events: [{ id: '77', slug: 'nvda-earnings' }], seriesId: 5, groupItemTitle: 'Q3' });
ok(cl.evento_id === '77' && cl.evento_slug === 'nvda-earnings' && cl.serie_id === '5' && cl.grupo === 'Q3',
  'extrae evento/serie/grupo del racimo', JSON.stringify(cl));
ok(Object.values(extraeCluster({ id: 1 })).every((v) => v === null), 'mercado sin racimo → todo null');
ok(Object.keys(extraeCluster(null)).length === 0, 'null → {} (no crashea)');

const busq = cosechaDeBusqueda({ events: [{ slug: 'e1', markets: [{ id: 1 }, { id: 2 }] }], tags: [{ id: 9 }] });
ok(busq.length === 2, 'public-search: saca los mercados de adentro de los eventos', busq.length);
ok(cosechaDeBusqueda({ nada: 1 }).length === 0 && cosechaDeBusqueda(null).length === 0, 'forma desconocida → [] (no crashea)');
ok(formaDe([]) === 'array' && formaDe({ a: 1 }).startsWith('objeto:'), 'formaDe describe la forma cruda');

console.log('detectaTopeUniforme: el "5" no se vuelve a colar');

// El modo de falla real: 8 respuestas, TODAS con 5 filas, con límite pedido 100.
const uniforme = detectaTopeUniforme(
  Array.from({ length: 8 }, () => ({ status: 'ok', filas: 5 })), 100);
ok(uniforme !== null, 'todas iguales y por debajo del límite → avisa');
ok(uniforme.valor === 5 && uniforme.intentos === 8, 'reporta el valor y cuántas respuestas', uniforme && uniforme.valor);
ok(/no es un catálogo, es un tope/.test(uniforme.aviso), 'y lo dice en castellano, no en un campo booleano');

ok(detectaTopeUniforme([{ status: 'ok', filas: 100 }, { status: 'ok', filas: 100 }, { status: 'ok', filas: 100 }], 100) === null,
  'todas llenas AL límite → normal, no avisa (páginas completas)');
ok(detectaTopeUniforme([{ status: 'ok', filas: 5 }, { status: 'ok', filas: 12 }, { status: 'ok', filas: 3 }], 100) === null,
  'conteos distintos → no avisa');
ok(detectaTopeUniforme([{ status: 'ok', filas: 5 }, { status: 'ok', filas: 5 }], 100) === null,
  'menos de 3 respuestas → muestra insuficiente para acusar');
ok(detectaTopeUniforme([{ status: 'ok', filas: 0 }, { status: 'ok', filas: 0 }, { status: 'ok', filas: 0 }], 100) === null,
  'ceros uniformes → es otra cosa (no hay resultados), no un tope');
ok(detectaTopeUniforme([], 100) === null && detectaTopeUniforme(null, 100) === null, 'vacío/null → null (no crashea)');

console.log('endpoint: plomería de formas de respuesta (sin red)');

ok(filasDe([{ a: 1 }]).length === 1, 'array pelado');
ok(filasDe({ data: [{ a: 1 }, { a: 2 }] }).length === 2, '{data:[...]}');
ok(filasDe({ nada: 1 }).length === 0, 'forma desconocida → [] (no crashea)');
const evento = aplanaMercados({ slug: 'ev', description: 'desc del evento', markets: [{ id: 1 }, { id: 2, description: 'propia' }] });
ok(evento.length === 2 && evento[0].description === 'desc del evento' && evento[1].description === 'propia',
  'evento → mercados, heredando la descripción solo si falta');
ok(aplanaMercados({ id: 9 }).length === 1, 'mercado suelto → él mismo');
ok(qs({ a: 1, b: null, c: '' }) === '?a=1', 'qs omite null/vacío');
const fakeHeaders = { forEach: (cb) => { cb('10', 'x-ratelimit-remaining'); cb('gzip', 'content-encoding'); cb('5', 'retry-after'); } };
const rh = rateHeaders(fakeHeaders);
ok(rh['x-ratelimit-remaining'] === '10' && rh['retry-after'] === '5' && !rh['content-encoding'], 'captura solo headers de rate limit');

console.log('resumenMarkdown: no se cae con un censo a medias');

const md = resumenMarkdown({
  generado_en: '2026-09-16T00:00:00Z',
  ventana: { desde: '2025-09-16', hasta: '2026-09-16', meses: 12 },
  criterios_congelados: CRITERIOS,
  sondas: [{ estrategia: 'markets_cerrados', endpoint: 'gamma/markets', status: 'ok', http: 200, ms: 120, filas: 100, limite_de_la_sonda: 100 }],
  descubrimiento: {
    metodo: 'dirigido',
    busqueda: { intentos: [{ frase: 'beat quarterly earnings', status: 'ok', http: 200, filas: 12 }] },
    tags: { intentos: [{ tag: 'Earnings', pagina: 0, status: 'ok', http: 200, filas: 80 }], tags_vistos: [{ id: '101', slug: 'earnings', veces: 12 }] },
    cluster: { intentos: [{ via: 'serie_id', status: 'httperror', http: 404, filas: 0 }] },
    simbolo: { intentos: [{ etiqueta: 'COST', status: 'ok', http: 200, filas: 3, nuevos: 3 }], probados: 99, de: 99 },
    semillas: { total: 40, usadas: 8, con_tags: 40, con_racimo: 12 },
    mercados_de_earnings_por_camino: { busqueda: 12, tags: 128 },
    estrategia_ganadora: { camino: 'tags', mercados_de_earnings: 128 },
  },
  sospecha_de_tope: { valor: 5, intentos: 8, limite_pedido: 100, aviso: 'Las 8 respuestas trajeron EXACTAMENTE 5 filas…' },
  topes_de_offset: [{ endpoint: 'gamma/markets', offset: 2500, limit: 500, mensaje: 'offset too large' }],
  barrido: { corrido: false, nota: 'apagado por defecto' },
  conteos: { mercados_de_earnings_en_ventana: 140, resueltos: 130, con_simbolo: 120, en_universo_v0: 90, universo_v0: 99, con_consenso_en_descripcion: 100, con_token_yes: 140 },
  ejemplos: [{ slug: 'nvda', symbol: 'NVDA', fecha_resolucion: '2026-02-26', outcome: 'Yes', clob: { status: 'ok', forma: 'startTs/endTs', puntos: 200 }, yes_t24h: { precio: 0.61, horas_antes_real: 25, rancio: false } }],
  cruce: { consultado: true, filas_pead: 400, cruzados: 88, en_universo_v0: 80, sin_cruce: { simbolo_no_esta_en_pead_earnings: 40 } },
  revisiones: [
    { fuente: 'finnhub/stock/revision', status: 'premium_o_sin_permiso', http: 403, pit: false, motivo: 'HTTP 403' },
    { fuente: 'alphavantage/EARNINGS_ESTIMATES', status: 'ok', http: 200, pit: false, filas: 4,
      motivo: 'las_revisiones_vienen_como_CONTEOS_no_como_valores_fechados', revisiones_como_conteo: true,
      fila_cruda: { horizon: 'next fiscal quarter', date: '2026-09-30', eps_estimate_revision_up_trailing_7_days: '2' } },
  ],
  rate_limit: { headers_observados: {}, hubo_429: false },
  muestras: { earnings: [{ pregunta: 'Will NVIDIA beat?', symbol: 'NVDA', via: 'alias', fecha: '2026-02-26', outcome: 'Yes', consenso: 0.75 }], sin_simbolo: [], descartados_por_el_filtro: [] },
});
ok(md.includes('CENSO earnings-beat') && md.includes('NVDA'), 'renderiza el censo');
ok(md.includes('Ganó') && md.includes('tags'), 'nombra el camino que encontró más');
ok(md.includes('LOS CONTEOS NO SON LEGIBLES'), 'el aviso de tope uniforme va ARRIBA de todo, no en una nota al pie');
ok(md.includes('tope 100'), 'las sondas publican su propio tope al lado del conteo');
ok(md.includes('99') && md.includes('símbolo'), 'reporta cuántos símbolos se buscaron uno por uno');
ok(md.includes('CERRADO'), 'las revisiones salen marcadas como CERRADO / fuera de v1');
ok(md.includes('cuello de botella es NUESTRO universo'), 'interpreta el motivo dominante de no-cruce');
ok(md.includes('tope de offset') || md.includes('Tope de offset'), 'documenta el tope de offset como hecho del censo');
ok(md.includes('422 no es rate limit'), 'y aclara que el 422 no es rate limit');
ok(md.includes('eps_estimate_revision_up_trailing_7_days'), 'enseña la FILA CRUDA de la sonda de revisiones');
ok(resumenMarkdown({ error: 'todo caído', sondas: [], revisiones: [] }).includes('FUENTE CAÍDA'), 'censo con fuente caída → lo dice');
ok(typeof resumenMarkdown({}) === 'string', 'censo vacío → string, no excepción');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
