// ═══════════════════════════════════════════════════════════════════
// tests/mercado-r0.test.mjs — R0: cimientos del mapa.
//
// Mismo criterio que la Fase 0: el sandbox no llega a Neon ni a
// DataBursatil, así que lo que se prueba acá es que el instrumento MIDE
// BIEN. Cada función tiene su caso que cuadra, su caso que no, y su caso de
// "no se pudo medir" — que no es lo mismo que rojo.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capConUnidades, verificaDivisor, estadoEmisora,
  buscarPistas, PISTAS_ACCIONES,
  filaUniversoUs, recorteMapa,
  parseFechaFeed, diagnosticoFechas, ZONAS_EXTRA,
  referenciaManual, parseManualParam,
  proximaRanura, intervaloDe, penalizarPor429, planCorrida,
} from '../api/_lib/mercado-r0.js';
import { contarItemsFeed } from '../api/_lib/mercado-fase0.js';
import REFERENCIAS from '../api/_lib/mercado-cap-referencia.json' with { type: 'json' };
import { congelar, resumen } from '../scripts/mercado-congelar-fuentes.mjs';
import EMISORAS from '../api/_lib/emisoras.json' with { type: 'json' };

const AHORA = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));

// Constructores de feed para los tests de fecha. Locales a propósito: la
// suite de Fase 0 tiene los suyos y compartirlos por import acoplaría dos
// suites que se leen por separado.
const itemRss = (t, l, f) => `<item><title>${t}</title><link>${l}</link><pubDate>${f}</pubDate></item>`;
const feedRss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;
const FECHA_RSS = 'Sat, 19 Sep 2026 14:30:00 GMT';

// ───────────────── R0(b) · unidades vinculadas ──────────────────────

test('R0b: el divisor arregla exactamente el caso que tumbó G2', () => {
  // FEMSA de la Fase 0 §3.2: acciones totales × precio de la UNIDAD daba 5×.
  // Con el divisor, cuadra.
  const acciones = 17_891_000_000, precioUbd = 200, apu = 5;
  const capReal = (acciones / apu) * precioUbd;
  const r = capConUnidades({
    clave: 'FEMSA', acciones_circulacion: acciones, precio: precioUbd,
    serie_liquida: 'FEMSAUBD', acciones_por_unidad: apu,
  });
  assert.equal(r.cap, capReal);
  assert.equal(r.motivo, null);
  const v = verificaDivisor({ capCalculada: r.cap, capReferencia: capReal, acciones_por_unidad: apu });
  assert.equal(v.estado, 'cuadra');
});

test('R0b: apu=1 no es un caso especial — es la misma fórmula', () => {
  const r = capConUnidades({ clave: 'WALMEX', acciones_circulacion: 17_461_000_000, precio: 61, serie_liquida: 'WALMEX*' });
  assert.equal(r.cap, 17_461_000_000 * 61);
  assert.equal(r.acciones_por_unidad, 1);
});

test('R0b: un divisor DECLARADO mal se corrige con el dato, y se dice cuál es', () => {
  // Se declara 5 pero la emisora empaqueta de a 8 (el caso KOF UBL). El
  // verificador no dice "está mal": dice cuánto vale.
  const acciones = 8_000_000_000, precio = 100;
  const capCalc = (acciones * precio) / 5;     // con el divisor equivocado
  const capRef = (acciones * precio) / 8;      // la verdad
  const v = verificaDivisor({ capCalculada: capCalc, capReferencia: capRef, acciones_por_unidad: 5 });
  assert.equal(v.estado, 'divisor_corregido');
  assert.equal(v.divisor_implicito, 8);
  assert.match(v.motivo, /implica 8/);
});

test('R0b: un error que NO es de empaquetado no se disfraza de divisor', () => {
  // ÉSTE es el caso que un "redondeá al entero más cercano" escondería: el
  // implícito es 1.37, o sea que el problema está en otro lado (acciones mal
  // extraídas, recompras, una serie que no cotiza). Hay que mirarlo a mano.
  const v = verificaDivisor({ capCalculada: 137, capReferencia: 100, acciones_por_unidad: 1 });
  assert.equal(v.estado, 'no_es_de_unidad');
  assert.equal(v.divisor_implicito, null);
  assert.match(v.motivo, /no es un entero limpio/);
});

test('R0b: el divisor implícito se compone con el declarado, no lo reemplaza', () => {
  // Con apu=5 declarado y un factor de 2 sobrante, el real es 10 — no 2.
  // Olvidarse de componer daba divisores al cuadrado.
  const v = verificaDivisor({ capCalculada: 200, capReferencia: 100, acciones_por_unidad: 5 });
  assert.equal(v.estado, 'divisor_corregido');
  assert.equal(v.divisor_implicito, 10);
});

test('R0b: TLEVISA CPO=117 es un divisor legítimo; 4812 es un error de unidades', () => {
  // El techo de `max_divisor` separa un empaquetado real de un "miles vs
  // unidades" disfrazado de divisor.
  const legitimo = verificaDivisor({ capCalculada: 117, capReferencia: 1, acciones_por_unidad: 1 });
  assert.equal(legitimo.estado, 'divisor_corregido');
  assert.equal(legitimo.divisor_implicito, 117);

  const absurdo = verificaDivisor({ capCalculada: 4812, capReferencia: 1, acciones_por_unidad: 1 });
  assert.equal(absurdo.estado, 'no_es_de_unidad');
});

test('R0b: sin referencia NO se declara verificada — se declara no medida', () => {
  const v = verificaDivisor({ capCalculada: 1e9, capReferencia: null });
  assert.equal(v.estado, 'sin_referencia');
  assert.equal(estadoEmisora(v, { cap: 1e9 }).estado, 'gris_punteado');
});

test('R0b: sin acciones o sin precio → null CON MOTIVO, nunca un cero', () => {
  assert.match(capConUnidades({ clave: 'X', acciones_circulacion: null, precio: 10 }).motivo, /sin acciones/);
  const sinPrecio = capConUnidades({ clave: 'Y', acciones_circulacion: 1e9, precio: null, serie_liquida: 'YB' });
  assert.equal(sinPrecio.cap, null);
  assert.match(sinPrecio.motivo, /sin precio de la serie líquida \(YB\)/);
});

test('R0b: la etiqueta de fuente viaja con el estado (GFNORTE → "cap: databursatil")', () => {
  const v = verificaDivisor({ capCalculada: 100, capReferencia: 100 });
  const e = estadoEmisora(v, { cap: 100, fuente_cap: 'databursatil' });
  assert.equal(e.estado, 'verificada');
  assert.equal(e.etiqueta, 'cap: databursatil');
});

// ───────── el registro de unidades en emisoras.json ─────────────────

test('emisoras.json: los cuatro divisores del encargo están, y NINGUNO se declara verificado', () => {
  const por = Object.fromEntries(EMISORAS.emisoras.map((e) => [e.clave, e]));
  assert.equal(por.FEMSA.acciones_por_unidad, 5);
  assert.equal(por.KOF.acciones_por_unidad, 8);
  assert.equal(por.CEMEX.acciones_por_unidad, 3);
  assert.equal(por.TLEVISA.acciones_por_unidad, 117);
  assert.equal(por.FEMSA.serie_liquida, 'FEMSAUBD');
  assert.equal(por.KOF.serie_liquida, 'KOFUBL');
  // Lo que más importa de este test: ninguno miente sobre su procedencia.
  // Este contenedor no llega a la BMV ni a un prospecto.
  for (const c of ['FEMSA', 'KOF', 'CEMEX', 'TLEVISA']) {
    assert.equal(por[c].unidad_verificado, false, `${c} se declara verificado sin haberlo medido`);
    assert.match(por[c].unidad_fuente, /operador/);
  }
});

test('emisoras.json: las 30 tienen divisor; la serie puede faltar, pero solo CON MOTIVO', () => {
  for (const e of EMISORAS.emisoras) {
    assert.ok(Number.isInteger(e.acciones_por_unidad) && e.acciones_por_unidad >= 1, `${e.clave}: divisor inválido`);
    assert.equal(e.unidad_verificado, false, `${e.clave}: nada está verificado hasta la corrida`);
    // Una serie ausente es aceptable; una serie ausente Y MUDA, no. Sin el
    // motivo, "sin cap" no se distingue de un typo — que es exactamente lo
    // que pasó con LASITE antes de la corrida.
    assert.ok(e.serie_liquida || e.sin_precio, `${e.clave}: sin serie líquida y sin motivo`);
  }
  const conDivisor = EMISORAS.emisoras.filter((e) => e.acciones_por_unidad > 1).map((e) => e.clave).sort();
  assert.deepEqual(conDivisor, ['CEMEX', 'FEMSA', 'KOF', 'TLEVISA']);
  // 29 con serie, 1 (PE&OLES) sin ninguna en bmv_precios — medido, no supuesto.
  assert.equal(EMISORAS.emisoras.filter((e) => e.serie_liquida).length, 29);
});

// ───────────────── R0(c) · la referencia de cap ─────────────────────

test('R0c: buscarPistas encuentra TODAS las llaves de acciones, con su ruta', () => {
  const raw = {
    posicion_financiera: { equity: 100, NumeroDeAccionesEnCirculacion: 16_935_974_370 },
    resultado_trimestre: { revenue: 5, WeightedAverageShares: 19_800_000_000 },
  };
  const r = buscarPistas(raw, { pistas: PISTAS_ACCIONES });
  assert.equal(r.hallazgos.length, 2);
  assert.equal(r.con_valor, 2);
  const rutas = r.hallazgos.map((h) => h.ruta).sort();
  assert.deepEqual(rutas, [
    'posicion_financiera.NumeroDeAccionesEnCirculacion',
    'resultado_trimestre.WeightedAverageShares',
  ]);
});

test('R0c: una llave presente y VACÍA se reporta igual — existe y viene sin valor', () => {
  // No es lo mismo "la fuente no tiene el campo" que "lo tiene en null".
  // La primera cierra la puerta; la segunda dice que se pida distinto.
  const r = buscarPistas({ bloque: { sharesOutstanding: null } }, { pistas: PISTAS_ACCIONES });
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.con_valor, 0);
  assert.equal(r.hallazgos[0].valor, null);
});

test('R0c: sin ninguna llave, el resultado es vacío y NO explota', () => {
  const r = buscarPistas({ revenue: 1, equity: 2 });
  assert.deepEqual(r.hallazgos, []);
  assert.deepEqual(r.llaves_distintas, []);
});

test('R0c: un JSON con ciclos no cuelga el recorrido', () => {
  const a = { bloque: { sharesOutstanding: 10 } };
  a.self = a;
  assert.equal(buscarPistas(a).hallazgos.length, 1);
});

// ───────────────── R0(a) · universo US y recorte ────────────────────

test('R0a: una fila incompleta ENTRA a la tabla y dice qué le falta', () => {
  // Un símbolo ausente y uno sin cap se ven igual en un count(*) y son
  // problemas distintos.
  const f = filaUniversoUs({ symbol: 'nvda', nombre: null, sector_etf: 'XLK', market_cap: 0, ahora: AHORA });
  assert.equal(f.symbol, 'NVDA');
  assert.equal(f.market_cap, null);
  assert.equal(f.cap_fuente, null);
  assert.equal(f.completa, false);
  assert.deepEqual(f.faltan.sort(), ['cap', 'nombre']);
});

test('R0a: el recorte da top 300 y el "+N más" con su porcentaje medido', () => {
  const filas = Array.from({ length: 350 }, (_, i) => ({ symbol: `S${i}`, market_cap: 1000 - i }));
  const r = recorteMapa(filas, 300);
  assert.equal(r.dentro.length, 300);
  assert.equal(r.resto.n, 50);
  assert.equal(r.dentro[0].symbol, 'S0');
  const capTotal = filas.reduce((a, f) => a + f.market_cap, 0);
  const capFuera = filas.slice(300).reduce((a, f) => a + f.market_cap, 0);
  assert.ok(Math.abs(r.resto.pct - (capFuera / capTotal) * 100) < 1e-9);
  assert.equal(r.resto.sin_cap_excluidos, 0);
});

test('R0a: los nombres SIN cap no entran al porcentaje, y el cuadro lo dice', () => {
  // "+200 más = 12%" cuando 40 de esos 200 no tienen cap sería afirmar un
  // porcentaje que no se midió.
  const filas = [
    ...Array.from({ length: 10 }, (_, i) => ({ symbol: `A${i}`, market_cap: 100 - i })),
    { symbol: 'SIN1', market_cap: null }, { symbol: 'SIN2', market_cap: 0 },
  ];
  const r = recorteMapa(filas, 5);
  assert.equal(r.dentro.length, 5);
  assert.equal(r.resto.n, 5);
  assert.equal(r.resto.sin_cap_excluidos, 2);
  assert.match(r.resto.nota, /no tienen capitalización medida/);
});

test('R0a: con menos nombres que el tope, el "+N más" es 0 y el pct también', () => {
  const r = recorteMapa([{ symbol: 'A', market_cap: 5 }], 300);
  assert.equal(r.dentro.length, 1);
  assert.equal(r.resto.n, 0);
  assert.equal(r.resto.pct, 0);
});

// ───────────────── R0(e) · el parser de fechas ──────────────────────

test('R0e: EDT y EST ya los parseaba Node — la hipótesis del encargo no se sostiene', () => {
  // MEDIDO antes de escribir una línea de arreglo: el parser heredado de V8
  // conoce las zonas de EE.UU. Si el feed de la Fed falló, NO fue por esto, y
  // "arreglarlo" habría sido código muerto que disimula el problema real.
  for (const z of ['EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT', 'GMT']) {
    const r = parseFechaFeed(`Wed, 17 Sep 2026 14:00:00 ${z}`);
    assert.ok(r.ms != null, `Date.parse no resolvió ${z}, la tabla tendría que cubrirlo`);
    assert.equal(r.via, 'Date.parse');
  }
  // Y por eso la tabla de zonas extra NO trae las de EE.UU.
  for (const z of ['EST', 'EDT', 'PST']) {
    assert.ok(!(z in ZONAS_EXTRA), `${z} en ZONAS_EXTRA sería código muerto`);
  }
});

test('R0e: las zonas que Date.parse SÍ falla (CET, JST, BRT) ahora se traducen', () => {
  const cet = parseFechaFeed('Wed, 17 Sep 2026 14:00:00 CET');
  assert.ok(cet.ms != null);
  assert.equal(new Date(cet.ms).toISOString(), '2026-09-17T13:00:00.000Z');
  assert.match(cet.via, /CET traducida a \+0100/);

  // Brasil: Valor (BR) está en el registro de noticias, y su offset es negativo.
  const brt = parseFechaFeed('Wed, 17 Sep 2026 14:00:00 BRT');
  assert.equal(new Date(brt.ms).toISOString(), '2026-09-17T17:00:00.000Z');
});

test('R0e: una zona desconocida se nombra, no se adivina', () => {
  const r = parseFechaFeed('Wed, 17 Sep 2026 14:00:00 XYZ');
  assert.equal(r.ms, null);
  assert.match(r.motivo, /zona horaria desconocida: "XYZ"/);
});

test('R0e: una fecha sin hora se acepta y se ADVIERTE que la hora no viene', () => {
  // Un titular fechado a medianoche no es un titular de medianoche, y "lo de
  // hoy" ordena por hora.
  const r = parseFechaFeed('2026-09-17');
  assert.equal(new Date(r.ms).toISOString(), '2026-09-17T00:00:00.000Z');
  assert.match(r.via, /la hora del titular no viene en el feed/);
});

test('R0e: campo vacío y basura se distinguen entre sí', () => {
  assert.match(parseFechaFeed('').motivo, /vacío o ausente/);
  assert.match(parseFechaFeed(null).motivo, /vacío o ausente/);
  assert.match(parseFechaFeed('ayer por la tarde').motivo, /formato no reconocido/);
});

test('R0e: el diagnóstico agrupa por motivo y guarda las cadenas crudas', () => {
  // Sin esto, "0% con fecha" es un callejón sin salida. Con esto, la corrida
  // entrega las cadenas que fallaron y el motivo se ve solo.
  const d = diagnosticoFechas([
    'Wed, 17 Sep 2026 14:00:00 EDT',
    'Wed, 17 Sep 2026 15:00:00 XYZ',
    'Wed, 17 Sep 2026 16:00:00 XYZ',
    '', 'ayer',
  ]);
  assert.equal(d.total, 5);
  assert.equal(d.parseadas, 1);
  assert.equal(d.fallidas, 4);
  assert.equal(d.por_motivo['zona horaria desconocida: "XYZ"'].length, 2);
  assert.ok(d.por_motivo['campo de fecha vacío o ausente']);
});

// ───────────────── R0(f) · congelar las ganadoras ───────────────────

const REGISTRO_FIXTURE = {
  _doc: 'x',
  fuentes: [
    { id: 'a', nombre: 'A', idioma: 'en', tipo: 'medio', seccion: 'mercado', feeds: ['https://a/1', 'https://a/2'], smoke: null },
    { id: 'b', nombre: 'B', idioma: 'es', tipo: 'medio', seccion: 'mexico_latam', feeds: ['https://b/1'], smoke: null },
    { id: 'bbg', nombre: 'Bloomberg', idioma: 'en', tipo: 'medio', seccion: 'mercado', feeds: [], asumido_no: 'declarado NO', smoke: null },
    { id: 'z', nombre: 'Z', idioma: 'en', tipo: 'newsletter', seccion: 'mercado', feeds: ['https://z/1'], smoke: null },
  ],
};

test('R0f: congela la url GANADORA y la deja primera, sin borrar las candidatas', () => {
  // Si mañana la ganadora muere, la siguiente ya está escrita y probada.
  const censo = { q11_feeds_noticias: { tabla: [
    { id: 'a', veredicto: 'GO', feed: 'https://a/2', items: 20, usables: 20, dialecto: 'rss', pct_con_fecha: 100, pct_con_imagen: 80 },
    { id: 'b', veredicto: 'NO-GO', motivo: 'bloqueado_cloudflare', bloqueado_cloudflare: true, candidatas: [{}] },
    { id: 'bbg', veredicto: 'ASUMIDO_NO', motivo: 'declarado NO' },
  ] } };
  const { registro, reporte } = congelar(REGISTRO_FIXTURE, censo);
  const a = registro.fuentes.find((f) => f.id === 'a');
  assert.equal(a.feed, 'https://a/2');
  assert.deepEqual(a.feeds, ['https://a/2', 'https://a/1']);
  assert.equal(a.smoke.veredicto, 'GO');
  assert.equal(a.smoke.pct_con_imagen, 80);
  // Y el reporte avisa que ganó la SEGUNDA candidata — dato que vale guardar.
  assert.equal(reporte.congeladas[0].era_candidata_n, 2);
});

test('R0f: un NO-GO deja feed en null CON motivo, no borra la fuente', () => {
  const censo = { q11_feeds_noticias: { tabla: [
    { id: 'b', veredicto: 'NO-GO', motivo: 'bloqueado_cloudflare', bloqueado_cloudflare: true, candidatas: [{}, {}] },
  ] } };
  const { registro, reporte } = congelar(REGISTRO_FIXTURE, censo);
  const b = registro.fuentes.find((f) => f.id === 'b');
  assert.equal(b.feed, null);
  assert.equal(b.smoke.veredicto, 'NO-GO');
  assert.equal(b.smoke.bloqueado_cloudflare, true);
  assert.equal(b.smoke.candidatas_probadas, 2);
  assert.deepEqual(b.feeds, ['https://b/1']);   // las candidatas siguen ahí
  assert.equal(reporte.sin_ganadora.length, 1);
});

test('R0f: una fuente que el JSON no menciona se deja INTACTA y se reporta', () => {
  const { registro, reporte } = congelar(REGISTRO_FIXTURE, { q11_feeds_noticias: { tabla: [] } });
  assert.deepEqual(registro.fuentes, REGISTRO_FIXTURE.fuentes);
  assert.deepEqual(reporte.no_mencionadas.sort(), ['a', 'b', 'bbg', 'z']);
});

test('R0f: un GO sin url ganadora es un JSON roto — se reporta y NO se escribe', () => {
  // Preferimos un registro viejo a uno con un feed indefinido que después
  // nadie sabe de dónde salió.
  const censo = { q11_feeds_noticias: { tabla: [{ id: 'a', veredicto: 'GO', feed: null }] } };
  const { registro, reporte } = congelar(REGISTRO_FIXTURE, censo);
  assert.equal(registro.fuentes.find((f) => f.id === 'a').feed, undefined);
  assert.equal(reporte.invalidas.length, 1);
  assert.match(reporte.invalidas[0].motivo, /sin url ganadora/);
});

test('R0f: acepta el JSON completo del censo o solo su bloque q11', () => {
  const tabla = [{ id: 'a', veredicto: 'GO', feed: 'https://a/1', items: 9, usables: 9 }];
  const conWrapper = congelar(REGISTRO_FIXTURE, { q11_feeds_noticias: { tabla } });
  const sinWrapper = congelar(REGISTRO_FIXTURE, { tabla });
  assert.deepEqual(conWrapper.registro, sinWrapper.registro);
});

test('R0f: el resumen nombra las que ganaron con una candidata que no era la primera', () => {
  const censo = { tabla: [{ id: 'a', veredicto: 'GO', feed: 'https://a/2', items: 9, usables: 9 }] };
  const { reporte } = congelar(REGISTRO_FIXTURE, censo);
  const txt = resumen(reporte);
  assert.match(txt, /ganó una candidata que NO era la primera/);
  assert.match(txt, /a → candidata #2/);
});

// ───── R0(c bis) · la referencia MANUAL que la corrida hizo necesaria ─────

const REG_REF = {
  vigencia_dias: 14,
  referencias: [
    { clave: 'WALMEX', market_cap: 784e9, fuente: 'Yahoo Finance (web)', capturada_en: '2026-09-20', capturada_por: 'Lety' },
    { clave: 'FEMSA', market_cap: 700e9, fuente: 'Yahoo Finance (web)', capturada_en: '2026-08-01' },
    { clave: 'AMX', market_cap: 1e12, capturada_en: '2026-09-20' },
    { clave: 'GMEXICO', market_cap: 1.6e12, fuente: 'Yahoo Finance (web)' },
  ],
};
const HOY_REF = new Date('2026-09-25T00:00:00Z');

test('R0c: una referencia vigente trae cap Y la etiqueta que dice que el número pintado es calc', () => {
  const r = referenciaManual(REG_REF, 'walmex', HOY_REF);
  assert.equal(r.cap, 784e9);
  assert.equal(r.dias, 5);
  assert.match(r.etiqueta_verificacion, /verificada vs Yahoo Finance \(web\) \(2026-09-20\)/);
});

test('R0c: una referencia VENCIDA no vale — arrastrar un verde viejo es peor que gris', () => {
  // Una cap de referencia envejece con el precio.
  const r = referenciaManual(REG_REF, 'FEMSA', HOY_REF);
  assert.equal(r.cap, null);
  assert.equal(r.vencida, true);
  assert.match(r.motivo, /vencida: 55 días/);
});

test('R0c: sin fuente o sin fecha de captura NO es una referencia, es un número suelto', () => {
  assert.match(referenciaManual(REG_REF, 'AMX', HOY_REF).motivo, /no dice de dónde salió/);
  assert.match(referenciaManual(REG_REF, 'GMEXICO', HOY_REF).motivo, /no dice cuándo se capturó/);
});

test('R0c: una emisora sin referencia se distingue de una con referencia mala', () => {
  assert.match(referenciaManual(REG_REF, 'GAP', HOY_REF).motivo, /sin referencia manual/);
});

test('R0c: una referencia fechada en el futuro se rechaza', () => {
  const reg = { vigencia_dias: 14, referencias: [{ clave: 'X', market_cap: 1e9, fuente: 'y', capturada_en: '2027-01-01' }] };
  assert.match(referenciaManual(reg, 'X', HOY_REF).motivo, /fechada en el futuro/);
});

test('R0c: ?manual= parsea claves y caps, y reporta lo mal formado', () => {
  const { referencias, invalidas } = parseManualParam('WALMEX:784000000000,FEMSA:7.0e11,malo,GAP:-5', {
    fuente: 'Yahoo Finance (web)', capturada_en: '2026-09-20',
  });
  assert.equal(referencias.length, 2);
  assert.equal(referencias[0].clave, 'WALMEX');
  assert.equal(referencias[1].market_cap, 7e11);
  assert.equal(referencias[0].fuente, 'Yahoo Finance (web)');
  assert.equal(invalidas.length, 2);
});

test('el JSON de referencias nace VACÍO y con vigencia declarada', () => {
  // Nace vacío a propósito: una referencia inventada es peor que ninguna.
  assert.deepEqual(REFERENCIAS.referencias, []);
  assert.equal(REFERENCIAS.vigencia_dias, 14);
  assert.ok(REFERENCIAS._reglas.no_se_pinta);
});

// ───── R0(e bis) · el diagnóstico que va a hacer hablar a la Fed ─────

test('R0e: un feed con fechas ilegibles entrega las CADENAS CRUDAS y los tags presentes', () => {
  // Éste es el caso Fed: HTTP 200, items de sobra, 0% de fechas parseables y
  // ni una pista de por qué. Ahora la corrida trae la cadena y el motivo.
  const items = [1, 2, 3].map((i) =>
    `<item><title>T${i}</title><link>https://f/${i}</link><pubDate>el 17 del mes pasado</pubDate></item>`);
  const r = contarItemsFeed(`<rss><channel>${items.join('')}</channel></rss>`);
  assert.equal(r.items, 3);
  assert.equal(r.pct_con_fecha, 0);
  assert.equal(r.fechas_que_fallaron.length, 3);
  assert.deepEqual(r.fechas_que_fallaron[0].tags_presentes, ['pubDate']);
  assert.equal(r.fechas_que_fallaron[0].cruda, 'el 17 del mes pasado');
  assert.match(r.fechas_que_fallaron[0].motivo, /formato no reconocido/);
});

test('R0e: "no hay campo de fecha" se distingue de "hay uno y no se deja leer"', () => {
  const sinTag = contarItemsFeed('<rss><channel><item><title>A</title><link>https://x/a</link></item></channel></rss>');
  assert.deepEqual(sinTag.fechas_que_fallaron[0].tags_presentes, []);
  assert.match(sinTag.fechas_que_fallaron[0].motivo, /vacío o ausente/);
});

test('R0e: un feed sano NO arrastra el diagnóstico', () => {
  const ok = contarItemsFeed(feedRss([itemRss('A', 'https://x/a', FECHA_RSS)]));
  assert.equal(ok.fechas_que_fallaron, undefined);
});

test('R0e: una fecha sin hora EN CUALQUIER formato se marca, no solo la ISO', () => {
  // V8 resuelve "17 septiembre 2026" por el prefijo "sep" y la aterriza a
  // medianoche. La fecha sale bien y la HORA es una ficción — y "lo de hoy"
  // ordena por hora, así que un feed entero a las 00:00 se ordena al azar
  // mientras se ve perfecto.
  const r = parseFechaFeed('17 septiembre 2026');
  assert.ok(r.ms != null);
  assert.match(r.via, /SIN HORA en el feed/);

  const conHora = parseFechaFeed('Wed, 17 Sep 2026 14:00:00 EDT');
  assert.equal(conHora.via, 'Date.parse');
});

test('R0e: el diagnóstico se apoya en el MISMO parser que el censo — no en una copia', () => {
  // Dos parsers de fecha que se desincronizan es cómo un feed pasa en un lado
  // y falla en el otro sin que nadie entienda por qué.
  const cet = contarItemsFeed(feedRss([
    '<item><title>A</title><link>https://x/a</link><pubDate>Wed, 17 Sep 2026 14:00:00 CET</pubDate></item>',
  ]));
  assert.equal(cet.pct_con_fecha, 100);
  assert.equal(cet.fechas_que_fallaron, undefined);
});

// ───── lo que la corrida del 2026-09-20 corrigió en el registro ─────

test('registro: LASITE apunta a una serie que EXISTE', () => {
  // La corrida lo cazó: el registro declaraba LASITEB, que no existe en
  // bmv_precios (las reales son LASITE*, LASITEB-1, LASITEB-2), así que
  // LASITE salía sin cap por un typo y no por falta de datos.
  const l = EMISORAS.emisoras.find((e) => e.clave === 'LASITE');
  assert.equal(l.serie_liquida, 'LASITE*');
  assert.match(l.unidad_fuente, /corregida por la corrida/);
});

test('registro: PE&OLES queda SIN serie y con el motivo, no con una inventada', () => {
  // bmv_precios no tiene ninguna serie de PE&OLES. Poner una para que la fila
  // se vea completa habría producido una cap de una serie que no cotiza.
  const p = EMISORAS.emisoras.find((e) => e.clave === 'PE&OLES');
  assert.equal(p.serie_liquida, null);
  assert.match(p.sin_precio, /no tiene NINGUNA serie/);
});

// ───────── R0(a bis) · el RITMO, y el error que costó una corrida ─────────

test('R0a: el limitador da EXACTAMENTE el ritmo pedido, no un múltiplo', () => {
  // ÉSTE es el test que habría evitado la corrida del 2026-09-21. La versión
  // vieja hacía 8 en vuelo con 1.1 s entre tandas y el comentario decía "deja
  // margen": eran 436 req/min contra un techo de 60, y 433 de 553 llamadas
  // volvieron 429.
  const intervalo = intervaloDe(55);
  let estado = { proxima: 0 };
  const t0 = 1_000_000;
  const arranques = [];
  // 60 solicitudes pedidas TODAS en el mismo instante: el peor caso, y el que
  // la versión vieja convertía en ráfaga.
  for (let i = 0; i < 60; i++) {
    const r = proximaRanura(estado, t0, intervalo);
    estado = r.estado;
    arranques.push(t0 + r.espera);
  }
  const ventana = arranques[arranques.length - 1] - arranques[0];
  const porMinuto = (60 / ventana) * 60000;
  assert.ok(porMinuto <= 60, `el limitador deja pasar ${porMinuto.toFixed(0)} req/min, por encima del techo de Finnhub`);
  assert.ok(porMinuto >= 50, `el limitador va a ${porMinuto.toFixed(0)} req/min: innecesariamente lento`);
});

test('R0a: la ranura se reserva al PEDIRLA, no al terminar', () => {
  // Si se reservara al terminar, una llamada lenta correría a las de atrás y
  // el ritmo dependería de la latencia de Finnhub en vez del techo.
  const intervalo = intervaloDe(55);
  let e = { proxima: 0 };
  const a = proximaRanura(e, 1000, intervalo); e = a.estado;
  const b = proximaRanura(e, 1000, intervalo); e = b.estado;
  assert.equal(a.espera, 0);
  assert.equal(b.espera, intervalo);
});

test('R0a: una llamada que tarda MÁS que el intervalo no atrasa a la siguiente', () => {
  const intervalo = intervaloDe(55);
  let e = { proxima: 0 };
  proximaRanura(e, 1000, intervalo);
  e = proximaRanura(e, 1000, intervalo).estado;
  // La siguiente se pide 10 s después (la anterior tardó mucho): no espera.
  const c = proximaRanura(e, 11000, intervalo);
  assert.equal(c.espera, 0);
});

test('R0a: intervaloDe redondea HACIA ARRIBA — 55/min nunca son 56', () => {
  assert.equal(intervaloDe(55), 1091);
  assert.ok(60000 / intervaloDe(55) <= 55);
  assert.equal(intervaloDe(60), 1000);
  // Defensivo: un valor absurdo no produce una ráfaga.
  assert.equal(intervaloDe(0), 60000);
  assert.equal(intervaloDe(null), 60000);
});

test('R0a: un 429 CORRE la ranura en vez de reintentar en el acto', () => {
  // Reintentar un 429 inmediatamente es pedirle a un servidor saturado que se
  // sature más. El símbolo queda pendiente y lo toma la próxima corrida —
  // para eso el job es reanudable.
  const e = penalizarPor429({ proxima: 0 }, 5000, 5000);
  assert.equal(e.proxima, 10000);
  // Y respeta una ranura futura ya reservada en vez de pisarla.
  const f = penalizarPor429({ proxima: 20000 }, 5000, 5000);
  assert.equal(f.proxima, 25000);
});

test('R0a: el plan dice cuántas corridas faltan — y con 1061 pendientes son 5', () => {
  // El número que decide si un cron DIARIO alcanza. Con 5 corridas, un cron
  // diario habría tardado cinco días en sembrar la tabla; por eso pasó a
  // 2×/hora auto-gateado.
  const p = planCorrida({ pendientes: 1061, presupuesto_ms: 250000, por_minuto: 55 });
  assert.equal(p.caben_por_corrida, 229);
  assert.equal(p.en_esta_corrida, 229);
  assert.equal(p.restantes_despues, 832);
  assert.equal(p.corridas_estimadas, 5);
});

test('R0a: sin pendientes, el plan es cero corridas — el cron se auto-gatea', () => {
  const p = planCorrida({ pendientes: 0 });
  assert.equal(p.en_esta_corrida, 0);
  assert.equal(p.corridas_estimadas, 0);
  assert.equal(p.restantes_despues, 0);
});

test('R0a: el presupuesto de la corrida queda por debajo del maxDuration', () => {
  // Una corrida que muere por timeout pierde TODO lo que juntó, porque el
  // upsert va al final. 250 s contra los 300 de Vercel dejan 50 s para la
  // escritura y la respuesta.
  const p = planCorrida({ pendientes: 10000, presupuesto_ms: 250000, por_minuto: 55 });
  assert.ok(p.caben_por_corrida * p.intervalo_ms <= 250000);
  assert.ok(250000 < 300000);
});
