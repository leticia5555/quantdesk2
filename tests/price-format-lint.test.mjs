// ═══════════════════════════════════════════════════════════════
// tests/price-format-lint.test.mjs — lint anti "precio redondeado a entero".
//
// El bug: la tarjeta de sims guardadas y la tabla SESSION COMPARISON del tab
// SIM pintaban el precio con `toLocaleString(...,{maximumFractionDigits:0})`,
// así que $13.86 salía como "NU LONG $14". Regla de la casa: los precios van
// SIEMPRE con 2 decimales — la gente tradea centavos y en tickers de $5–$15
// (NU, ITUB, VALE — audiencia LATAM) redondear a entero es un número FALSO.
//
// Misma forma que el date-lint (tests/no-hardcoded-dates.test.mjs) y el
// pct-lint (tests/period-label-lint.test.mjs):
//
//   1. Garantía de comportamiento — extrae fmtPrice() del app.html real y
//      verifica que NUNCA redondea a entero: 13.86 → "13.86", 14 → "14.00",
//      y sub-$1 → 4 decimales (0.4235). Es la única forma de pintar un precio.
//   2. Escáner FILE-WIDE (todo app.html): FALLA si un identificador de PRECIO
//      (entryPrice, currentPrice, current_price, .price, S0, low52w/high52w,
//      priceBot/priceTop…) se formatea con redondeo a entero
//      (`maximumFractionDigits:0` o `.toFixed(0)`). El único camino es
//      fmtPrice(). Los montos AGREGADOS en dólares (P&L, capital, market cap)
//      NO llevan nombre de precio y siguen redondeando a dólar entero — es
//      correcto y queda fuera de alcance a propósito.
//
// Exento: líneas marcadas con `price-lint-ok` (waiver explícito, dejá el
// porqué al lado) y comentarios.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'app.html'), 'utf8');

// ─── 1. garantía de comportamiento: fmtPrice REAL de app.html ───
// Se extrae la función tal cual corre en producción y se evalúa en un sandbox
// (solo usa Number/Math/toLocaleString, autocontenida). Probamos el comporta-
// miento — el separador de miles/decimales depende del locale del runner, así
// que las aserciones toleran '.' o ',' y jamás dependen del agrupador.
function loadFmtPrice() {
  const m = /function fmtPrice\(v\)\{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(m, 'no encuentro function fmtPrice(v) en app.html');
  const factory = new Function(m[0] + '\n; return fmtPrice;');
  return factory();
}

test('fmtPrice: SIEMPRE 2 decimales, nunca redondea un precio a entero', () => {
  const fmtPrice = loadFmtPrice();
  // el bug exacto: $13.86 jamás debe volverse "14"
  assert.match(fmtPrice(13.86), /^13[.,]86$/, '13.86 conserva los centavos');
  assert.notEqual(fmtPrice(13.86), '14', 'nunca redondea a entero');
  // un precio "redondo" igual muestra los 2 decimales (no "14", sino "14.00")
  assert.match(fmtPrice(14), /^14[.,]00$/, 'entero → dos decimales explícitos');
  assert.match(fmtPrice(9.2), /^9[.,]20$/, 'un decimal → se completa a dos');
  // separador de miles + 2 decimales
  assert.match(fmtPrice(1234.5), /234[.,]50$/, 'miles con 2 decimales');
  // sub-$1 → 4 decimales (los centavos pesan aún más)
  assert.match(fmtPrice(0.4235), /^0[.,]4235$/, 'sub-$1 → 4 decimales');
  assert.match(fmtPrice(0.5), /^0[.,]5000$/, 'sub-$1 completa a 4 decimales');
  // no-finito → guion, nunca inventa un número
  for (const bad of [null, undefined, NaN, 'x', Infinity])
    assert.equal(fmtPrice(bad), '—', 'no-finito → "—" (' + String(bad) + ')');
});

test('los dos sitios del bug reportado ya pasan por fmtPrice', () => {
  assert.ok(SRC.includes('function fmtPrice('), 'falta el helper compartido fmtPrice');
  // tabla SESSION COMPARISON (y su gemela en el modal de comparación)
  assert.ok(SRC.includes('<td>$${fmtPrice(c.price)}</td>'),
    'la tabla de comparación debe pintar el precio con fmtPrice');
  // tarjeta de sims guardadas
  assert.ok(SRC.includes('$${fmtPrice(s.entryPrice)}'),
    'la tarjeta de sim guardada debe pintar el precio con fmtPrice');
});

// ─── 2. escáner file-wide (estilo date-lint) ────────────────────
// Un identificador de PRECIO formateado con redondeo a entero. Los agregados
// en dólares (pnlDollar, newVal, capital, market cap) no llevan nombre de
// precio → no caen aquí, que es lo correcto.
const PRICE_ID = /(entryPrice|entry_price|currentPrice|current_price|exitPrice|exit_price|lastPrice|lastLivePrice|livePrice|entryPx|\bS0\b|low52w|high52w|priceBot|priceTop|\.price\b|\bprice\b)/;
const INT_ROUND = /(maximumFractionDigits:\s*0\b|toFixed\(0\))/;

function scanLine(line) {
  // comentario de línea completa (JS o HTML) → exento
  if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return null;
  if (/price-lint-ok/.test(line)) return null; // waiver explícito
  const code = line.replace(/\s\/\/.*$/, ''); // corta comentario al final de línea
  return PRICE_ID.test(code) && INT_ROUND.test(code);
}

test('el propio linter reconoce las formas que motivaron el bug', () => {
  // las formas exactas del bug:
  assert.ok(scanLine('  <td>$${Number(c.price).toLocaleString(undefined,{maximumFractionDigits:0})}</td>'));
  assert.ok(scanLine('  $${Number(s.entryPrice).toLocaleString(undefined,{maximumFractionDigits:0})}'));
  assert.ok(scanLine("  'Now $' + currentPrice.toLocaleString(undefined,{maximumFractionDigits:0})"));
  assert.ok(scanLine('  Trade: ${dir} ${ticker} at $${price.toFixed(0)}'));
  assert.ok(scanLine('  cd.low52w.toFixed(0)+"-$"+cd.high52w.toFixed(0)'));
  // y NO grita con lo legítimo:
  assert.ok(!scanLine('  <td>$${fmtPrice(c.price)}</td>'), 'fmtPrice es el camino permitido');
  assert.ok(!scanLine('  $${fmtPrice(s.entryPrice)}'), 'fmtPrice es el camino permitido');
  assert.ok(!scanLine("  '+$'+Math.abs(pnlDollar).toLocaleString(undefined,{maximumFractionDigits:0})"),
    'P&L agregado en dólares no es un precio por acción');
  assert.ok(!scanLine('  Capital: $${SP.capital.toLocaleString()}'), 'capital entero sin forzar redondeo');
  assert.ok(!scanLine("  ${(winRate*100).toFixed(0)}%"), 'un % no es un precio');
  assert.ok(!scanLine("  const p = price.toFixed(0); // price-lint-ok: eje del gráfico"),
    'el waiver price-lint-ok exime');
});

test('cero precios redondeados a entero en TODO app.html', () => {
  const violations = [];
  SRC.split('\n').forEach((line, i) => {
    if (scanLine(line))
      violations.push(`app.html:${i + 1} → usa fmtPrice(v) (o marca price-lint-ok con el porqué)\n    ${line.trim()}`);
  });
  assert.deepEqual(violations, [], '\n' + violations.join('\n'));
});
