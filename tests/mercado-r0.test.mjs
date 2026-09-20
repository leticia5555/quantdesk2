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
} from '../api/_lib/mercado-r0.js';
import { congelar, resumen } from '../scripts/mercado-congelar-fuentes.mjs';
import EMISORAS from '../api/_lib/emisoras.json' with { type: 'json' };

const AHORA = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));

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

test('emisoras.json: las 30 tienen divisor y serie líquida, y el default es 1', () => {
  for (const e of EMISORAS.emisoras) {
    assert.ok(Number.isInteger(e.acciones_por_unidad) && e.acciones_por_unidad >= 1, `${e.clave}: divisor inválido`);
    assert.ok(e.serie_liquida, `${e.clave}: sin serie líquida`);
    assert.equal(e.unidad_verificado, false, `${e.clave}: nada está verificado hasta la corrida`);
  }
  const conDivisor = EMISORAS.emisoras.filter((e) => e.acciones_por_unidad > 1).map((e) => e.clave).sort();
  assert.deepEqual(conDivisor, ['CEMEX', 'FEMSA', 'KOF', 'TLEVISA']);
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
