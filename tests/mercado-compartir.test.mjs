// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-compartir.test.mjs — R7: la imagen para compartir.
//
// Dibujar en un canvas no se puede probar en Node sin una librería. Por eso
// la tarjeta se arma en dos pasos y acá se prueba el PRIMERO: qué se dibuja
// y dónde. El segundo —ejecutar las operaciones— son veinte líneas sin
// decisiones, y lo mira el Chromium.
//
// LO QUE MÁS IMPORTA: una imagen que circula por WhatsApp sin decir DE
// CUÁNDO es y DE DÓNDE salió es exactamente la captura que termina citada
// como si fuera de hoy. Por eso la fecha, el periodo, la moneda, la fuente y
// la firma son obligatorias, y su ausencia se ESCRIBE.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { QD_FORMATOS, qdCortaTexto, opsDeTarjeta, qdFechaLegible } =
  require(join(ROOT, 'qd-compartir.js'));

const BASE = {
  titulo: 'Mapa de EE.UU.',
  subtitulo: '300 emisoras por capitalización',
  filas: [{ k: 'NVDA', v: '+2.10%' }, { k: 'AAPL', v: '−0.40%' }],
  periodo: '1D', moneda: 'USD',
  fuente: 'neon:mercado_precios_us (cierre y cierre ajustado)',
  fecha: '2026-10-20T16:30:00.000Z',
  url: 'quantdesk.app/mercado?mapa=us&periodo=1D',
};
const rol = (plan, r) => plan.ops.filter((o) => o.rol === r);
const texto = (plan, r) => rol(plan, r).map((o) => o.texto).join(' ');

test('los dos formatos del encargo, con sus medidas exactas', () => {
  assert.equal(QD_FORMATOS.historia.w, 1080);
  assert.equal(QD_FORMATOS.historia.h, 1920);
  assert.equal(QD_FORMATOS.cuadrado.w, 1080);
  assert.equal(QD_FORMATOS.cuadrado.h, 1080);
});

test('un formato desconocido cae al vertical, no revienta', () => {
  assert.equal(opsDeTarjeta(BASE, 'inventado').formato.id, 'historia');
});

// ── LOS CINCO DATOS QUE LA IMAGEN NO PUEDE OMITIR ────────────────────
test('la tarjeta lleva fecha, periodo, moneda, fuente y la firma', () => {
  const p = opsDeTarjeta(BASE, 'historia');
  assert.match(texto(p, 'meta'), /2026/);
  assert.match(texto(p, 'meta'), /periodo 1D/);
  assert.match(texto(p, 'meta'), /en USD/);
  assert.match(texto(p, 'fuente'), /neon:mercado_precios_us/);
  assert.match(texto(p, 'firma'), /Información, no asesoría/);
  assert.match(texto(p, 'firma'), /quantdesk/);
});

test('sin fuente lo ESCRIBE, no deja el renglón vacío', () => {
  // Una imagen sin procedencia circulando es peor que una imagen fea.
  const p = opsDeTarjeta({ ...BASE, fuente: null }, 'historia');
  assert.match(texto(p, 'fuente'), /sin fuente declarada/);
});

test('y sin fecha también lo dice', () => {
  const p = opsDeTarjeta({ ...BASE, fecha: null }, 'historia');
  assert.match(texto(p, 'meta'), /sin fecha declarada/);
});

test('la URL con estado viaja en la imagen: así se puede volver a la vista', () => {
  const p = opsDeTarjeta(BASE, 'historia');
  assert.match(texto(p, 'url'), /mapa=us/);
  assert.match(texto(p, 'url'), /periodo=1D/);
});

// ── EL ALTO MANDA CUÁNTAS FILAS CABEN ────────────────────────────────
test('el cuadrado lleva MENOS filas que el vertical, y lo calcula', () => {
  const muchas = { ...BASE, filas: Array.from({ length: 40 }, (_, i) => ({ k: 'S' + i, v: '+1.0%' })) };
  const v = opsDeTarjeta(muchas, 'historia');
  const c = opsDeTarjeta(muchas, 'cuadrado');
  assert.ok(v.filas_dibujadas > c.filas_dibujadas,
    `vertical ${v.filas_dibujadas} vs cuadrado ${c.filas_dibujadas}`);
  // Y ninguna fila se dibuja encima del pie.
  const pieY = v.formato.h - 72 - 96;
  const ultimaFila = v.ops.filter((o) => o.rol === 'fila-k').pop();
  assert.ok(ultimaFila.y < pieY - 20, `la última fila en ${ultimaFila.y}, el pie en ${pieY}`);
});

test('lo que no cupo se DICE, no desaparece en silencio', () => {
  const muchas = { ...BASE, filas: Array.from({ length: 40 }, (_, i) => ({ k: 'S' + i, v: '+1.0%' })) };
  const c = opsDeTarjeta(muchas, 'cuadrado');
  assert.match(texto(c, 'resto'), /\+\d+ más en la pantalla/);
  assert.equal(c.filas_totales, 40);
});

test('con pocas filas no se inventa un "+0 más"', () => {
  const p = opsDeTarjeta(BASE, 'historia');
  assert.equal(rol(p, 'resto').length, 0);
});

// ── TEXTO ────────────────────────────────────────────────────────────
test('un título largo se corta por PALABRAS, no a la mitad de una', () => {
  const p = opsDeTarjeta({ ...BASE, titulo: 'Mapa de capitalización' }, 'historia');
  const lineas = rol(p, 'titulo').map((o) => o.texto);
  assert.equal(lineas.join(' '), 'Mapa de capitalización', 'nada se pierde cuando cabe');
  assert.ok(lineas.every((l) => !l.endsWith('…')), 'y sin puntos suspensivos de más');
});

test('y si NO cabe en tres renglones, el recorte SE VE', () => {
  // Un recorte invisible es un texto cambiado: "…de la bolsa mexicana por
  // sector" cortado en seco afirma otra cosa que el título original.
  const p = opsDeTarjeta({ ...BASE, titulo: 'Mapa de capitalización de la bolsa mexicana por sector y por tamaño' }, 'historia');
  const lineas = rol(p, 'titulo').map((o) => o.texto);
  assert.equal(lineas.length, 3);
  assert.ok(lineas[2].endsWith('…'), JSON.stringify(lineas));
});

test('el cortador respeta el máximo y no deja palabras partidas', () => {
  const l = qdCortaTexto('uno dos tres cuatro cinco seis', 10);
  assert.ok(l.every((x) => x.length <= 10 || !x.includes(' ')), JSON.stringify(l));
  assert.equal(l.join(' '), 'uno dos tres cuatro cinco seis');
});

test('un valor nulo en una fila sale como "—", no como "null"', () => {
  const p = opsDeTarjeta({ ...BASE, filas: [{ k: 'SIN', v: null }] }, 'historia');
  assert.equal(rol(p, 'fila-v')[0].texto, '—');
});

test('una fecha que no parsea se muestra tal cual, no se inventa una', () => {
  assert.equal(qdFechaLegible('no-es-fecha'), 'no-es-fecha');
  assert.match(qdFechaLegible('2026-10-20T16:30:00.000Z'), /2026/);
});

// ── GEOMETRÍA ────────────────────────────────────────────────────────
test('nada se dibuja fuera del lienzo', () => {
  const muchas = { ...BASE, filas: Array.from({ length: 40 }, (_, i) => ({ k: 'S' + i, v: '+1.0%' })) };
  for (const f of ['historia', 'cuadrado']) {
    const p = opsDeTarjeta(muchas, f);
    for (const o of p.ops) {
      assert.ok(o.x >= 0 && o.x <= p.formato.w, `${f}: x=${o.x} fuera de 0..${p.formato.w}`);
      assert.ok(o.y >= 0 && o.y <= p.formato.h, `${f}: y=${o.y} fuera de 0..${p.formato.h} (${o.rol})`);
    }
  }
});

test('el fondo cubre el lienzo entero: ningún borde transparente', () => {
  const p = opsDeTarjeta(BASE, 'cuadrado');
  const f = p.ops.find((o) => o.tipo === 'fondo');
  assert.equal(f.w, 1080);
  assert.equal(f.h, 1080);
});

// ── LA FUENTE, QUE A VECES LLEGA COMO OBJETO ─────────────────────────
test('una fuente que llega como OBJETO no se escribe "[object Object]"', () => {
  // El mapa manda `{cuadros, series, cap_por_fuente}` — una fuente por
  // bloque. Concatenarlo a una cadena escribía "[object Object]" en la
  // tarjeta descargada. Lo encontró el PNG de verdad, no una prueba.
  const p = opsDeTarjeta({ ...BASE, fuente: {
    cuadros: 'neon:mercado_universo_us (sector y cap)',
    series: 'neon:mercado_precios_us (cierre ajustado)',
    cap_por_fuente: { edgar: 120, yahoo: 30 },
  } }, 'historia');
  const t = texto(p, 'fuente');
  assert.ok(!/\[object Object\]/.test(t), t);
  assert.match(t, /neon:mercado_universo_us/);
  // La segunda fuente puede no caber en el renglón —la tarjeta recorta con
  // "…" a la vista— y eso está bien: la URL de la tarjeta lleva a la
  // pantalla, donde el pie las dice todas. Lo que NO puede pasar es que la
  // línea diga "[object Object]".
  assert.ok(/neon:mercado_precios_us/.test(t) || t.endsWith('…'), t);
});

test('y un objeto SIN ninguna cadena adentro se declara como sin fuente', () => {
  const p = opsDeTarjeta({ ...BASE, fuente: { conteos: { a: 1 } } }, 'historia');
  assert.match(texto(p, 'fuente'), /sin fuente declarada/);
});

test('la URL y la firma NO comparten renglón: con una URL larga se encimaban', () => {
  const p = opsDeTarjeta({ ...BASE,
    url: 'quantdesk.app/mercado?mapa=us&periodo=1M&agrupar=plano&symbol=NVDA' }, 'historia');
  const url = rol(p, 'url')[0];
  const firma = rol(p, 'firma')[0];
  assert.ok(url.y !== firma.y, `url en ${url.y}, firma en ${firma.y}`);
  assert.ok(firma.y > url.y, 'la firma va debajo');
});

// ── NADA SE SALE DEL LIENZO ──────────────────────────────────────────
test('la línea de la fuente se recorta al ancho, con el recorte VISIBLE', () => {
  // El PNG descargado enseñó la fuente saliéndose por el borde derecho: un
  // texto cortado por el lienzo parece un texto completo.
  const larga = {
    cuadros: 'neon:mercado_universo_us (sector y capitalización verificada)',
    series: 'neon:mercado_precios_us (cierre y cierre ajustado, cosecha diaria)',
    extra: 'y todavía más procedencia para que no quepa de ninguna manera',
  };
  const p = opsDeTarjeta({ ...BASE, fuente: larga }, 'cuadrado');
  const t = texto(p, 'fuente');
  assert.ok(t.endsWith('…'), t.slice(-30));
  assert.match(t, /^Fuente: neon:mercado_universo_us/);
});

test('NINGÚN texto de la tarjeta se sale del lienzo', () => {
  // Se mide con el avance de la monoespaciada (0.6 × tamaño), que es como
  // avanza IBM Plex Mono. Para el título, que va en la condensada, se usa el
  // mismo factor: la condensada es MÁS angosta, así que la cota es segura.
  const { qdCabenCaracteres } = require(join(ROOT, 'qd-compartir.js'));
  const larga = {
    ...BASE,
    titulo: 'Mapa de capitalización de la bolsa mexicana por sector y por tamaño',
    subtitulo: 'trescientas cincuenta y cuatro emisoras ordenadas por su capitalización de mercado verificada',
    fuente: { a: 'neon:' + 'x'.repeat(200) },
    url: 'quantdesk.app/mercado?' + 'p=1&'.repeat(60),
  };
  for (const f of ['historia', 'cuadrado']) {
    const p = opsDeTarjeta(larga, f);
    const margen = 72;
    for (const o of p.ops) {
      if (o.tipo !== 'texto') continue;
      const ancho = o.texto.length * o.tam * 0.6;
      const der = o.alinear === 'derecha' ? o.x : o.x + ancho;
      assert.ok(der <= p.formato.w + 1,
        `${f}: "${o.texto.slice(0, 40)}" (${o.rol}) llega a ${Math.round(der)} y el lienzo mide ${p.formato.w}`);
    }
  }
});

test('el recortador no deja un texto vacío ni rompe uno corto', () => {
  const { qdRecortaALinea } = require(join(ROOT, 'qd-compartir.js'));
  assert.equal(qdRecortaALinea('corto', 20), 'corto');
  assert.equal(qdRecortaALinea('abcdef', 4), 'abc…');
  assert.equal(qdRecortaALinea('', 10), '');
});
