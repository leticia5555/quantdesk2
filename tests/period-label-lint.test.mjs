// ═══════════════════════════════════════════════════════════════
// tests/period-label-lint.test.mjs — lint anti "% sin periodo".
//
// El bug del % de periodo volvió 3 veces: un porcentaje calculado a mano
// en un componente (cambio de 30 días pintado como si fuera diario). La
// causa raíz era que CADA componente calculaba y pintaba su propio %.
//
// Este lint lo hace IMPOSIBLE de repetir, con la misma forma que el
// date-lint (tests/no-hardcoded-dates.test.mjs):
//
//   1. Garantía de comportamiento — extrae qdPeriodChange/qdPctTag del
//      código real de app.html y verifica que qdPctTag LANZA si le falta
//      la etiqueta de periodo. Es estructuralmente imposible pintar un %
//      mudo de periodo.
//   2. Recorre la zona de render MACRO (entre los sellos ⟦pct-lint⟧) y
//      FALLA si alguien reintroduce un % calculado/pintado a mano
//      (`+'%'`) o vuelve a leer el `changePct` del server. El único
//      camino permitido es qdPctTag(pct, periodLabel).
//   3. Escáner FILE-WIDE (todo app.html, no solo la zona MACRO): el bug
//      volvió en el strip QUANTDESK MARKETS justamente porque vivía FUERA
//      de los sellos. Ahora, viva donde viva, NINGÚN componente puede:
//        · leer `d.dayChange` de /api/price (en fin de semana arrastra un
//          prevClose viejo y sale un % gigante mudo) — hay que anclar el
//          cambio con qdDailyChange/qdPeriodChange; ni
//        · pintar un `return30d`/`change30d` como % a mano — va por qdPctTag.
//      Y comprueba que los widgets de cotización (strip, tarjetas, context
//      strip) efectivamente usan la fuente compartida.
//
// Fuera de alcance a propósito: el `changePct` DIARIO close-vs-prevClose de
// vistas dedicadas de hoy (cinta viva /api/tape, heatmap de sectores
// /api/sectores) — es un cambio del día por construcción, no un periodo
// confundible. Dentro de la zona MACRO igual está prohibido (regla 2).
//
// Exento: líneas marcadas con `pct-lint-ok` (waiver explícito, dejá el
// porqué al lado) y comentarios.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'app.html'), 'utf8');

const START = '⟦pct-lint:start⟧';
const END = '⟦pct-lint:end⟧';

// ─── piezas compartidas (definidas ANTES del sello start) ───
// Se extrae el bloque desde QD_PERIODS hasta el sello de inicio de la zona
// y se evalúa en un sandbox con un qdEscHTML de stub, para probar las
// funciones REALES que corren en producción (no una reimplementación).
function loadShared() {
  const from = SRC.indexOf('const QD_PERIODS=');
  const to = SRC.indexOf('/* ' + START);
  assert.ok(from > 0 && to > from, 'no encuentro el bloque compartido qdPeriodChange/qdPctTag');
  const src = SRC.slice(from, to);
  const factory = new Function('qdEscHTML',
    src + '\n; return { QD_PERIODS, qdPeriodChange, qdPctTag };');
  return factory((s) => String(s == null ? '' : s));
}

test('qdPctTag: la etiqueta de periodo es OBLIGATORIA (throw sin ella)', () => {
  const { qdPctTag } = loadShared();
  // con etiqueta: pinta el % y la etiqueta
  const html = qdPctTag(1.234, '1M');
  assert.match(html, /\+1\.23%/, 'muestra el % con signo');
  assert.match(html, />1M</, 'incluye la etiqueta de periodo en el render');
  // sin etiqueta: lanza, en todas sus formas
  assert.throws(() => qdPctTag(1.23), /periodo/i, 'undefined → throw');
  assert.throws(() => qdPctTag(1.23, ''), /periodo/i, 'string vacío → throw');
  assert.throws(() => qdPctTag(1.23, '   '), /periodo/i, 'solo espacios → throw');
  assert.throws(() => qdPctTag(1.23, null), /periodo/i, 'null → throw');
  // valor no finito: sigue exigiendo etiqueta y pinta "—"
  assert.throws(() => qdPctTag(NaN), /periodo/i, 'NaN sin etiqueta → throw igual');
  assert.match(qdPctTag(NaN, '1S'), /—/, 'NaN con etiqueta → "—" (nunca inventa +0.00%)');
});

test('qdPeriodChange: única fuente del % — ancla contra el inicio del periodo', () => {
  const { qdPeriodChange } = loadShared();
  // serie de 22 cierres: 100..121 (1 por sesión)
  const series = Array.from({ length: 22 }, (_, i) => ({ t: i, c: 100 + i }));
  const m1 = qdPeriodChange(series, '1M'); // ancla 21 sesiones atrás → 100
  assert.equal(m1.periodLabel, '1M');
  assert.ok(Math.abs(m1.pct - 21) < 1e-9, '1M: (121-100)/100 = 21%  → ' + m1.pct);
  const w = qdPeriodChange(series, '1S'); // ancla 5 sesiones atrás → 116
  assert.ok(Math.abs(w.pct - ((121 - 116) / 116) * 100) < 1e-9, '1S usa un ancla distinta → ' + w.pct);
  assert.equal(w.window.length, 6, '1S recorta la ventana de la sparkline al mismo periodo');
  assert.throws(() => qdPeriodChange(series, 'XX'), /periodo/i, 'periodo desconocido → throw');
  // sin suficientes puntos: sin pct, pero con etiqueta
  const thin = qdPeriodChange([{ t: 0, c: 5 }], '1M');
  assert.equal(thin.pct, null);
  assert.equal(thin.periodLabel, '1M');
});

// ─── scanner de la zona de render (estilo date-lint) ───
// Prohibido en la zona MACRO: pintar un % a mano (`+'%'`) o leer el
// changePct del server. El único camino es qdPctTag.
const FORBIDDEN = [
  { name: '% pintado a mano (usa qdPctTag)', re: /\+\s*['"`]\s*%/ },
  { name: 'changePct del server (usa qdPeriodChange)', re: /\.changePct\b/ },
];

function scanLine(line) {
  // comentarios de línea completa (JS o HTML) → exentos
  if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return null;
  if (/pct-lint-ok/.test(line)) return null;
  const code = line.replace(/\s\/\/.*$/, '');
  for (const p of FORBIDDEN) {
    if (p.re.test(code)) return p.name;
  }
  return null;
}

test('el propio linter reconoce las formas que motivaron el bug', () => {
  assert.ok(scanLine("      +'<div class=\"mx-chg\">'+chgPct.toFixed(2)+'%'"), 'toFixed()+% → flag');
  assert.ok(scanLine('      const chg = pct + \"%\";'), 'variable + "%" → flag');
  assert.ok(scanLine('      return mxCard(it.sym, d.changePct, d.spark);'), 'lee .changePct → flag');
  // y NO grita con lo legítimo:
  assert.equal(scanLine("    {sym:'^TNX', lbl:'10Y', unit:'%', scale:mxYield},"), null, "unit:'%' es una unidad, no un cambio");
  assert.equal(scanLine("      +'<div class=\"mx-chg\">'+qdPctTag(pc.pct, pc.periodLabel)+'</div>'"), null, 'qdPctTag es el camino permitido');
  assert.equal(scanLine("  const fmtVal=c=>it.fmt(c)+(it.unit?(' '+it.unit):'');"), null, 'concatena la unidad, no un %');
});

test('cero porcentajes pintados a mano en la zona de render MACRO', () => {
  const from = SRC.indexOf(START);
  const to = SRC.indexOf(END);
  assert.ok(from > 0 && to > from, 'no encuentro los sellos ⟦pct-lint⟧ en app.html');
  const region = SRC.slice(from, to);

  // prueba positiva: el render SÍ pasa por el camino guardado
  assert.ok(region.includes('qdPctTag('), 'la zona MACRO debe pintar % vía qdPctTag');

  const violations = [];
  const base = SRC.slice(0, from).split('\n').length; // nº de línea real en app.html
  region.split('\n').forEach((line, i) => {
    const hit = scanLine(line);
    if (hit) violations.push(`app.html:${base + i} [${hit}] → usa qdPctTag(pct, periodLabel) / qdPeriodChange, o marca pct-lint-ok con el porqué\n    ${line.trim()}`);
  });
  assert.deepEqual(violations, [], '\n' + violations.join('\n'));
});

// ═══ escáner FILE-WIDE (estilo date-lint) ═══════════════════════
// El bug reaparece donde no estás mirando si el lint solo cubre la zona
// MACRO. Estas reglas recorren TODO app.html: ningún componente, viva donde
// viva, pinta un cambio/retorno de mercado como % sin rotular su periodo.
const FILEWIDE = [
  // El campo que causó el bug: /api/price.dayChange. En fin de semana arrastra
  // un prevClose viejo → un ~20% que se pinta como si fuera diario. Prohibido
  // leerlo: el cambio 1D se ancla a la serie con qdDailyChange/qdPeriodChange.
  { name: '.dayChange crudo de /api/price (usa qdDailyChange/qdPeriodChange)', re: /\.dayChange\b/ },
  // Un retorno de periodo (return30d/change30d) formateado como % a mano.
  // El único camino es qdPctTag, que obliga a la etiqueta.
  { name: 'return30d/change30d pintado como % a mano (usa qdPctTag)',
    re: /(return30d|change30d)[\s\S]*?\.toFixed\([^)]*\)\s*\+\s*['"`]\s*%/ },
];

function scanFilewide(line) {
  if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return null; // comentario
  if (/pct-lint-ok/.test(line)) return null;             // waiver explícito
  const code = line.replace(/\s\/\/.*$/, '');            // corta comentario al final de línea
  for (const p of FILEWIDE) if (p.re.test(code)) return p.name;
  return null;
}

test('el escáner file-wide reconoce las formas del bug (y no grita con lo legítimo)', () => {
  // el strip original: dayChange lavado en un local y pintado como % mudo
  assert.ok(scanFilewide("    const ret=(typeof d.dayChange==='number')?d.dayChange:0;"), 'lee .dayChange → flag');
  assert.ok(scanFilewide("      const r30Txt=(r30>=0?'+':'')+(d.return30d*100).toFixed(1)+'%';"), 'return30d pintado a mano → flag');
  // y NO grita con lo legítimo:
  assert.equal(scanFilewide("    const pc=qdDailyChange(d);"), null, 'qdDailyChange es el camino permitido');
  assert.equal(scanFilewide("      '+qdPctTag(pc.pct,pc.periodLabel)+'"), null, 'qdPctTag es el camino permitido');
  assert.equal(scanFilewide("  const m=btc.return30d;"), null, 'leer return30d para SCORING (sin pintar %) es legítimo');
  assert.equal(scanFilewide("    return30d: ret30 != null ? parseFloat(ret30.toFixed(1)) : null,"), null, 'guardar return30d (sin +%) es legítimo');
  assert.equal(scanFilewide("      { name: '30d return > +10%', get: c => c.return30d > 10 },"), null, 'nombre de filtro con % literal, no un valor pintado');
  assert.equal(scanFilewide("    const ret = d.dayChange != null ? d.dayChange : 0; // pct-lint-ok: cinta viva"), null, 'waiver pct-lint-ok exime');
  assert.equal(scanFilewide("      +'<div>'+s.changePct.toFixed(2)+'%</div>'"), null, 'changePct diario (tape/sectores) está fuera de alcance file-wide');
});

test('cero cambios/retornos de mercado pintados como % mudo en TODO app.html', () => {
  const violations = [];
  SRC.split('\n').forEach((line, i) => {
    const hit = scanFilewide(line);
    if (hit) violations.push(`app.html:${i + 1} [${hit}]\n    ${line.trim()}`);
  });
  assert.deepEqual(violations, [], '\n' + violations.join('\n'));
});

test('los widgets de cotización usan la fuente compartida (no dayChange crudo)', () => {
  const shared = ['function qdDailyChange', 'function qdMarketStatus'];
  for (const s of shared) assert.ok(SRC.includes(s), 'falta el helper compartido: ' + s);

  // Cada widget que antes leía d.dayChange debe anclar el cambio 1D vía
  // qdDailyChange y pintar vía qdPctTag (nunca .dayChange crudo).
  const widgets = ['function loadTopBarTickers', 'function loadMarketSummary', 'function renderContextStrip'];
  for (const w of widgets) {
    const i = SRC.indexOf(w);
    assert.ok(i > 0, 'no encuentro ' + w);
    const body = SRC.slice(i, i + 5200);
    assert.match(body, /qdDailyChange\(/, w + ' debe anclar el cambio 1D con qdDailyChange');
    assert.match(body, /qdPctTag\(/, w + ' debe pintar el % con qdPctTag');
    // (que NO lea .dayChange crudo lo garantiza el escáner file-wide de arriba)
  }

  // El strip además rotula el estado de mercado (abierto/cerrado) por instrumento.
  const strip = SRC.slice(SRC.indexOf('function loadTopBarTickers'), SRC.indexOf('function loadTopBarTickers') + 2600);
  assert.match(strip, /qdMarketStatus\(/, 'el strip debe rotular el estado del mercado');
});
