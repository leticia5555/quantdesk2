// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-noticias-pagina.test.mjs — R3b: la página de noticias.
//
// LO QUE SE FIJA ACÁ es el contrato de `armaPagina`, que es lo que la pantalla
// pinta. Está en un módulo y no dentro del HTML a propósito: así "Solo
// español filtra bien" se prueba sin levantar un navegador, y el Chromium se
// queda para lo que sólo se ve en un navegador (el tap, el layout, la caída
// de la foto).
//
// Las tres que más importan, y por qué:
//   · LAS DESTACADAS NO INVENTAN FOTO. El encargo prohíbe scrapear og:image,
//     así que con menos de cuatro fotos se completan SIN foto y se dice.
//   · UNA SECCIÓN SIN FUENTE SE DECLARA. Cripto y ETFs están en la cabecera
//     del artboard y ninguna fuente del registro publica ahí: la pestaña va
//     punteada con "pronto", calculado, no escrito a mano.
//   · "ACCIONES" NO ES UNA FUENTE. El encargo la define como las notas con al
//     menos un ticker, y eso es por nota.
// ═══════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECCIONES, seccionesSinFuente, enSeccion, filtra, destacadasDe,
  porFuente, chipsDeFuente, armaPagina, paraBuscar,
} from '../api/_lib/noticias-pagina.js';

const nota = (o = {}) => ({
  url: 'https://x/' + (o.url || Math.random().toString(36).slice(2)),
  titular: 'Un titular', fuente_id: 'cnbc', fuente_nombre: 'CNBC',
  tipo: 'medio', idioma: 'en', seccion: 'mercado',
  publicado_en: '2026-10-20T12:00:00.000Z', imagen: null, tickers: [], fuente_dato: null,
  ...o,
});

test('las seis secciones del artboard, en su orden', () => {
  assert.deepEqual(SECCIONES.map((s) => s.id),
    ['mercado', 'mexico_latam', 'acciones', 'etfs', 'cripto', 'oficiales']);
});

test('una sección sin ninguna fuente que la alimente se calcula, no se escribe a mano', () => {
  const fuentes = [
    { id: 'cnbc', seccion: 'mercado' },
    { id: 'el_financiero', seccion: 'mexico_latam' },
    { id: 'sec_8k', seccion: 'oficiales' },
  ];
  // Cripto y ETFs: ninguna fuente del registro publica ahí → "pronto".
  assert.deepEqual(seccionesSinFuente(fuentes), ['etfs', 'cripto']);
  // Y "Acciones" NUNCA sale como sin fuente: se alimenta de las demás.
  assert.ok(!seccionesSinFuente(fuentes).includes('acciones'));
});

test('el registro REAL no deja Cripto ni ETFs con fuente: la pestaña va punteada', async () => {
  const { fuentesGo } = await import('../api/noticias.js');
  const sin = seccionesSinFuente(fuentesGo());
  assert.ok(sin.includes('etfs'), 'ETFs sin fuente declarada');
  assert.ok(sin.includes('cripto'), 'Cripto sin fuente declarada');
  assert.ok(!sin.includes('mercado'), 'Mercado sí tiene fuentes');
  assert.ok(!sin.includes('oficiales'), 'Oficiales sí tiene fuentes');
});

test('"Acciones" es por NOTA (tiene ticker), no por fuente', () => {
  assert.equal(enSeccion(nota({ tickers: ['NVDA'] }), 'acciones'), true);
  assert.equal(enSeccion(nota({ tickers: [] }), 'acciones'), false);
  // Y no importa en qué sección venga la fuente: una nota de México con
  // ticker cuenta como acción.
  assert.equal(enSeccion(nota({ seccion: 'mexico_latam', tickers: ['WALMEX'] }), 'acciones'), true);
});

test('"Solo español" filtra por el idioma de la FUENTE, no del titular', () => {
  const ns = [nota({ idioma: 'es' }), nota({ idioma: 'en' }), nota({ idioma: 'pt' })];
  assert.equal(filtra(ns, { idioma: 'es' }).length, 1);
  assert.equal(filtra(ns, { idioma: 'todo' }).length, 3);
});

test('la búsqueda ignora acentos y mayúsculas, y alcanza al ticker y a la fuente', () => {
  const ns = [
    nota({ titular: 'Banxico recortó la tasa', fuente_nombre: 'El Economista' }),
    nota({ titular: 'Nvidia sube', tickers: ['NVDA'] }),
  ];
  assert.equal(filtra(ns, { q: 'recorto' }).length, 1, 'sin acento encuentra "recortó"');
  assert.equal(filtra(ns, { q: 'ECONOMISTA' }).length, 1, 'encuentra por fuente');
  assert.equal(filtra(ns, { q: 'nvda' }).length, 1, 'encuentra por ticker');
  assert.equal(filtra(ns, { q: 'zzz' }).length, 0);
  // La ñ también se descompone: "ñoño" → "nono". Es lo correcto para buscar,
  // porque los dos lados pasan por la misma normalización — quien escribe
  // "nono" o "ñoño" encuentra lo mismo. Es lo que ya hace `tituloNormalizado`.
  assert.equal(paraBuscar('Ñoño ÁÉÍ'), 'nono aei');
  assert.equal(filtra([nota({ titular: 'Peña y el peso' })], { q: 'pena' }).length, 1);
});

test('un chip de fuente filtra a esa fuente y a ninguna otra', () => {
  const ns = [nota({ fuente_id: 'cnbc' }), nota({ fuente_id: 'doomberg' })];
  assert.equal(filtra(ns, { fuente: 'doomberg' }).length, 1);
});

// ── LAS DESTACADAS ───────────────────────────────────────────────────
test('cuatro destacadas: primero las que SÍ traen foto', () => {
  const ns = [
    nota({ url: 'a', imagen: null }),
    nota({ url: 'b', imagen: 'https://i/1.jpg' }),
    nota({ url: 'c', imagen: null }),
    nota({ url: 'd', imagen: 'https://i/2.jpg' }),
    nota({ url: 'e', imagen: null }),
  ];
  const r = destacadasDe(ns);
  assert.equal(r.destacadas.length, 4);
  assert.equal(r.con_foto, 2);
  assert.equal(r.sin_foto, 2);
  assert.ok(r.destacadas[0].imagen && r.destacadas[1].imagen, 'las dos con foto van primero');
});

test('sin ninguna foto salen cuatro destacadas igual, y se dice por qué no hay foto', () => {
  const r = destacadasDe(Array.from({ length: 6 }, (_, i) => nota({ url: 'n' + i })));
  assert.equal(r.destacadas.length, 4);
  assert.equal(r.con_foto, 0);
  // Regla 2: el hueco dice su causa real, no "sin imagen".
  assert.match(r.motivo_sin_foto, /media:content|enclosure/);
});

test('con menos de cuatro notas no se rellena con nada: salen las que hay', () => {
  const r = destacadasDe([nota({ url: 'a' }), nota({ url: 'b' })]);
  assert.equal(r.destacadas.length, 2);
});

// ── POR FUENTE ───────────────────────────────────────────────────────
test('"Por fuente" agrupa y pone adelante a la que más publicó', () => {
  const ns = [
    nota({ fuente_id: 'cnbc', fuente_nombre: 'CNBC' }),
    nota({ fuente_id: 'mw', fuente_nombre: 'MarketWatch' }),
    nota({ fuente_id: 'cnbc', fuente_nombre: 'CNBC' }),
  ];
  const g = porFuente(ns);
  assert.equal(g.length, 2);
  assert.equal(g[0].fuente_id, 'cnbc');
  assert.equal(g[0].notas.length, 2);
});

test('y un empate de conteo se rompe por alfabeto, no por el orden de llegada', () => {
  // Sin desempate declarado, dos fuentes con el mismo número de notas salen
  // en el orden en que el `Map` las vio —o sea, en el orden de la tabla—, y la
  // columna se reordena sola entre dos cargas sin que nada haya cambiado.
  const ns = [
    nota({ url: 'z1', fuente_id: 'zebra', fuente_nombre: 'Zebra' }),
    nota({ url: 'a1', fuente_id: 'alfa', fuente_nombre: 'Alfa' }),
    nota({ url: 'z2', fuente_id: 'zebra', fuente_nombre: 'Zebra' }),
    nota({ url: 'a2', fuente_id: 'alfa', fuente_nombre: 'Alfa' }),
  ];
  assert.deepEqual(porFuente(ns).map((g) => g.fuente_nombre), ['Alfa', 'Zebra']);
});

// ── LOS CHIPS ────────────────────────────────────────────────────────
test('el chip distingue caída de "no se ha cosechado": se arreglan distinto', () => {
  const go = [
    { id: 'cnbc', nombre: 'CNBC', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
    { id: 'zerohedge', nombre: 'ZeroHedge', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
    { id: 'klement', nombre: 'Klement', idioma: 'en', tipo: 'newsletter', seccion: 'mercado' },
  ];
  const chips = chipsDeFuente(go, [
    { fuente_id: 'cnbc', ok: true, motivo: null, guardadas: 12, ultima_corrida: '2026-10-20T12:00:00Z' },
    { fuente_id: 'zerohedge', ok: false, motivo: 'HTTP 403 (bloqueo de datacenter)', guardadas: 0, ultima_corrida: '2026-10-20T12:00:00Z' },
  ]);
  const por = Object.fromEntries(chips.map((c) => [c.id, c]));
  assert.equal(por.cnbc.estado, 'ok');
  assert.equal(por.zerohedge.estado, 'source_down');
  assert.match(por.zerohedge.motivo, /403/);
  assert.equal(por.klement.estado, 'sin_cosechar');
  assert.equal(por.klement.ok, null, 'tri-estado: null no es false');
  assert.match(por.klement.motivo, /no se ha cosechado/);
});

// ── EL ARMADO COMPLETO ───────────────────────────────────────────────
test('armaPagina reparte en medios / newsletters / oficiales y cuenta cada sección', () => {
  const ns = [
    nota({ url: 'm1', tipo: 'medio', seccion: 'mercado', tickers: ['NVDA'] }),
    nota({ url: 'm2', tipo: 'medio', seccion: 'mexico_latam', idioma: 'es' }),
    nota({ url: 'n1', tipo: 'newsletter', seccion: 'mercado' }),
    nota({ url: 'o1', tipo: 'oficial', seccion: 'oficiales' }),
    nota({ url: 'o2', tipo: 'oficial_derivado', seccion: 'oficiales', fuente_dato: 'banxico:SF61745' }),
  ];
  const r = armaPagina(ns);
  assert.equal(r.medios.length, 2);
  assert.equal(r.newsletters.length, 1);
  // `oficial_derivado` ENTRA en oficiales: es lo que arma `cambiosDeTasa`
  // desde el SIE, y sin esta línea se perdía de su columna.
  assert.equal(r.oficiales.length, 2);
  assert.equal(r.otros.length, 0);
  assert.equal(r.conteos.acciones, 1, 'una sola nota trae ticker');
  assert.equal(r.conteos.mexico_latam, 1);
  assert.equal(r.conteos.cripto, 0);
  assert.equal(r.total, 5);
});

test('un tipo desconocido NO se tira en silencio: queda en `otros`', () => {
  const r = armaPagina([nota({ tipo: 'bitacora' })]);
  assert.equal(r.otros.length, 1);
  assert.equal(r.medios.length, 0);
});

test('"Por fuente" devuelve los grupos y deja la lista plana vacía: la pantalla pinta una u otra', () => {
  const ns = [nota({ url: 'a' }), nota({ url: 'b', fuente_id: 'mw', fuente_nombre: 'MarketWatch' })];
  const r = armaPagina(ns, { orden: 'fuente' });
  assert.equal(r.medios.length, 0);
  assert.equal(r.medios_por_fuente.length, 2);
  // El TOTAL sigue siendo el real: el toggle cambia la forma, no el universo.
  assert.equal(r.medios_total, 2);
});

test('el tope por columna recorta pero el total dice cuántas había: así "cargar más" sabe', () => {
  const ns = Array.from({ length: 40 }, (_, i) => nota({ url: 'm' + i }));
  const r = armaPagina(ns, { porColumna: 10 });
  assert.equal(r.medios.length, 10);
  assert.equal(r.medios_total, 40);
});

test('las destacadas se repiten en la columna a propósito: sacarlas descuadra el conteo', () => {
  const ns = Array.from({ length: 6 }, (_, i) => nota({ url: 'm' + i, imagen: 'https://i/' + i }));
  const r = armaPagina(ns);
  const urls = new Set(r.medios.map((n) => n.url));
  assert.ok(r.destacadas.every((d) => urls.has(d.url)),
    'cada destacada sigue estando en su lista');
  assert.equal(r.medios_total, 6);
});

test('un filtro que no deja nada da listas vacías, no un error', () => {
  const r = armaPagina([nota({ idioma: 'en' })], { idioma: 'es' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.destacadas, []);
  assert.equal(r.medios_total, 0);
});
