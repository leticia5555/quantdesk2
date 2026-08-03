// ═══════════════════════════════════════════════════════════════
// tests/prose-audit.test.mjs — auditoría post-hoc de los % de la prosa del PM.
// Función pura, determinista: cada token "%" del plan se coteja (por magnitud,
// con tolerancia de redondeo) contra los números del prompt del DIVE. Journal-
// only; aquí solo se prueba la detección y el detalle crudo por token.
// Correr con `node tests/prose-audit.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { auditPlanPercentages, AUDIT_ABS_TOL, AUDIT_REL_TOL } from '../api/_lib/prose-audit.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}

console.log('prose-audit: % anclado en un número del prompt → matched');
{
  const prompt = 'PORTFOLIO {"symbol":"GNTX","pnl_since_entry_pct":"+6.1%","market_value":1600}';
  const r = auditPlanPercentages('Mantengo GNTX, +6.1% de P&L desde entrada.', prompt);
  ok(r.checked === 1 && r.unmatched === 0, 'un token, anclado', r);
  ok(r.tokens[0].value === 6.1 && r.tokens[0].matched === true, 'value 6.1, matched', r.tokens[0]);
  ok(r.tokens[0].nearest === 6.1 && r.tokens[0].delta === 0, 'nearest/delta crudos journaleados', r.tokens[0]);
}

console.log('prose-audit: FABRICACIÓN — % sin ningún número cercano en el prompt → unmatched');
{
  const prompt = 'PORTFOLIO {"symbol":"MU","pnl_since_entry_pct":"+1.5%","market_value":11000} last_close 840.51';
  const r = auditPlanPercentages('MU cae -2.14% en la sesión, mantengo.', prompt);
  ok(r.checked === 1 && r.unmatched === 1, 'el -2.14% se marca como no anclado (no existe 2.14 en el prompt)', r);
  ok(r.tokens[0].value === -2.14 && r.tokens[0].matched === false, 'captura el signo y lo marca', r.tokens[0]);
}

console.log('prose-audit: redondeo del PM tolerado ("6%" por 6.1%)');
{
  const r = auditPlanPercentages('Subió ~6% desde que entré.', '{"pnl_since_entry_pct":"+6.1%"}');
  ok(r.tokens[0].matched === true, '6% matchea 6.1 dentro de tolerancia', r.tokens[0]);
}

console.log('prose-audit: signo-insensible (la magnitud es lo que ancla)');
{
  const r = auditPlanPercentages('Perdí -6.1%.', 'margen bruto 6.1');
  ok(r.tokens[0].matched === true, '-6.1% ancla contra 6.1 (magnitud)', r.tokens[0]);
}

console.log('prose-audit: fuera de tolerancia → unmatched, con nearest/delta para el post-mortem');
{
  const r = auditPlanPercentages('Asumo 10% de upside.', 'valores: 2 y 6.1 y 840.51');
  ok(r.tokens[0].matched === false && r.tokens[0].nearest === 6.1 && r.tokens[0].delta === 3.9,
    '10% no ancla; nearest=6.1 delta=3.9 quedan crudos', r.tokens[0]);
}

console.log('prose-audit: varios tokens, cuenta mixta');
{
  const prompt = 'pnl "+6.1%", regla ±2%, cash floor 10%';
  const r = auditPlanPercentages('Mantengo 10% en cash, GNTX +6.1%, pero AZO -3.77% no cuadra.', prompt);
  ok(r.checked === 3 && r.unmatched === 1, '3 tokens, solo el -3.77% sin ancla', r);
  ok(r.tokens.find((t) => t.value === -3.77 && !t.matched) != null, 'el inventado (-3.77%) es el marcado', r.tokens);
}

console.log('prose-audit: entradas no-string → cero tokens, nunca lanza');
{
  const r = auditPlanPercentages(null, undefined);
  ok(r.checked === 0 && r.unmatched === 0 && Array.isArray(r.tokens), 'plan/prompt nulos → resultado vacío', r);
}

console.log('prose-audit: la tolerancia se journalea (para re-tunear el post-mortem sin re-correr)');
{
  const r = auditPlanPercentages('x 6.1%', '6.1');
  ok(r.tolerance.abs === AUDIT_ABS_TOL && r.tolerance.rel === AUDIT_REL_TOL, 'tolerance {abs,rel} presente', r.tolerance);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
