// ═══════════════════════════════════════════════════════════════════════
// scripts/mercado-alto.mjs — ¿QUÉ TAN LARGO TIENE QUE SER EL MAPA?
//
// El alto del mapa en celular salió calibrado contra un fixture de 552 cuadros
// con capitalizaciones inventadas. Producción tiene 307 y otra distribución, y
// calibrar contra datos inventados es exactamente el error que este repo evita
// en todo lo demás: el número sale de la medición o no sale.
//
// Este script corre el MISMO reparto que el navegador —`agrupaPorSector` +
// `squarify` + `etiquetaCuadro` de qd-treemap.js, con la misma cabecera de
// sector— sobre la respuesta REAL de /api/mercado-mapa, y dice para cada
// factor cuántos cuadros se quedan sin ticker.
//
// USO
//   curl -s 'https://<host>/api/mercado-mapa?mapa=us' > /tmp/mapa.json
//   node scripts/mercado-alto.mjs /tmp/mapa.json [--ancho 358] [--umbral 16]
//
// El ancho por defecto es 358px: los 390 del iPhone menos los 16 de margen a
// cada lado que pone `main`. `--umbral` es el tamaño a partir del cual un
// cuadro DEBE llevar su ticker.
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TM = require('../qd-treemap.js');

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
if (!archivo) {
  console.error('falta el archivo con la respuesta de /api/mercado-mapa');
  process.exit(2);
}

const ANCHO = opt('ancho', 358);
const UMBRAL = opt('umbral', 16);
const ALTO_CABECERA = 14;     // el mismo que mercado.html
const FONT_MIN = opt('font', 6);   // el piso del ticker; `--font 5` prueba bajarlo
const ALTO_MIN = 2000;        // el piso del alto, decisión de Lety

const datos = JSON.parse(readFileSync(archivo, 'utf8'));
const cuadros = (datos.cuadros || []).filter(
  (c) => Number(c.cap) > 0 || Number.isFinite(Number(c.precio)),
);

/** El reparto del primer nivel, igual que `pintarPrimerNivel`. */
function reparte(w, h) {
  const { grupos } = TM.agrupaPorSector(cuadros);
  const out = [];
  const rs = TM.squarify(
    grupos.map((g) => ({ key: g.sector, value: g.cap_total, grupo: g })),
    { x: 0, y: 0, w, h },
  );
  for (const r of rs) {
    const g = r.item.grupo;
    const conCabecera = r.h >= ALTO_CABECERA + 12;
    const y0 = r.y + (conCabecera ? ALTO_CABECERA : 0);
    const h0 = r.h - (conCabecera ? ALTO_CABECERA : 0);
    const items = g.items.map((c) => ({ key: c.symbol, value: c.area, cuadro: c }));
    for (const q of TM.squarify(items, { x: r.x, y: y0, w: r.w, h: h0 })) out.push(q);
  }
  return out;
}

function mide(factor) {
  const h = Math.max(ALTO_MIN, Math.round(ANCHO * factor));
  const rects = reparte(ANCHO, h);
  let sin = 0, mudosGrandes = 0, bajoUmbral = 0;
  let minLado = Infinity;
  const ejemplos = [];
  for (const r of rects) {
    // Sin el %: lo que se calibra es el TICKER, que es lo que Lety pidió que
    // no falte. Pasarle el % haría que un cuadro con sitio para las dos líneas
    // se contara distinto, y no es lo que se está midiendo.
    const e = TM.etiquetaCuadro(r.w, r.h, { ticker: r.item.key, pct: null, fontMin: FONT_MIN, fontMinDos: 8 });
    minLado = Math.min(minLado, r.w, r.h);
    if (e.ticker) continue;
    sin++;
    if (r.w < UMBRAL || r.h < UMBRAL) { bajoUmbral++; continue; }
    mudosGrandes++;
    if (ejemplos.length < 5) {
      ejemplos.push(`${r.item.key} ${r.w.toFixed(1)}×${r.h.toFixed(1)} (necesita ${(TM.anchoTexto(r.item.key, FONT_MIN) + 2).toFixed(1)}px)`);
    }
  }
  return { factor, h, total: rects.length, sin, mudosGrandes, bajoUmbral, minLado: +minLado.toFixed(1), ejemplos };
}

console.log(`${cuadros.length} cuadros · ancho ${ANCHO}px · umbral ${UMBRAL}px · ticker desde ${FONT_MIN}px\n`);
console.log('factor    alto   sin ticker   <umbral   ≥umbral y mudos   lado mín');
// OJO CON LA NO-MONOTONÍA: el conteo NO baja siempre al subir el factor.
// `squarify` reacomoda las filas al cambiar la proporción, así que un cuadro
// puede salir más angosto en un mapa más alto — en el barrido del fixture, ×9
// daba 0 mudos y ×10 daba 1. Por eso se elige el primer factor a partir del
// cual el cero SE SOSTIENE, no el primero que da cero: un cero que el
// siguiente medio punto rompe no es una calibración, es una coincidencia.
const barrido = [];
for (let f = 2; f <= 20; f += 0.5) barrido.push(mide(f));
let elegido = null;
for (let i = 0; i < barrido.length; i++) {
  if (barrido.slice(i).every((m) => m.mudosGrandes === 0)) { elegido = barrido[i]; break; }
}
for (const m of barrido) {
  const f = m.factor;
  if (f % 1 === 0 || (elegido && elegido.factor === f)) {
    console.log(
      `× ${String(f).padStart(4)}  ${String(m.h).padStart(6)}  ${String(m.sin).padStart(10)}`
      + `  ${String(m.bajoUmbral).padStart(8)}  ${String(m.mudosGrandes).padStart(16)}  ${String(m.minLado).padStart(8)}`,
    );
  }
}
if (elegido) {
  console.log(`\nFACTOR MÁS CHICO CON 0 MUDOS DE ≥${UMBRAL}px, SOSTENIDO: × ${elegido.factor}`);
  console.log(`  alto del mapa: ${elegido.h}px  (${(elegido.h / 844).toFixed(1)} pantallas de iPhone)`);
  console.log(`  quedan ${elegido.sin} sin ticker, todos por debajo de ${UMBRAL}px de lado`);
  console.log(`  el cuadro más chico mide ${elegido.minLado}px de lado`);
} else {
  const peor = mide(20);
  console.log(`\nNINGÚN factor hasta ×20 deja 0 mudos de ≥${UMBRAL}px.`);
  console.log(`  a ×20 (alto ${peor.h}px) todavía quedan ${peor.mudosGrandes}: ${peor.ejemplos.join(' · ')}`);
  console.log(`  un ticker de 4 letras a ${FONT_MIN}px necesita ${(TM.anchoTexto('AAAA', FONT_MIN) + 2).toFixed(1)}px de cuadro,`);
  console.log(`  y uno de 5, ${(TM.anchoTexto('AAAAA', FONT_MIN) + 2).toFixed(1)}px: por eso el umbral de ${UMBRAL} no se puede cumplir para ésos.`);
}
