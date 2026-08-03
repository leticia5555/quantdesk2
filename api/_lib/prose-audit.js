// ═══════════════════════════════════════════════════════════════
// api/_lib/prose-audit.js — auditoría post-hoc de los % en la prosa del PM.
//
// El `plan` del Arena se publica VERBATIM y NO pasa por el guard (que solo
// valida ÓRDENES). En prod el PM ha inventado porcentajes en la narrativa
// (p. ej. "MU -2.14%" sin correspondencia con ningún dato inyectado) y ha
// mal-escalado los que sí recibía. Esto NO censura ni corrige el plan —
// solo DETECTA y deja rastro en el journal: cada token "%" del plan se coteja
// contra los números que el PM realmente vio (el texto del prompt del DIVE).
// Un token sin match se marca como no anclado.
//
// ── Journal-only, arrancado como INSTRUMENTO DE MEDICIÓN ──────────────────
// El diseño está cerrado (acuerdo de producto): al inicio esto NO se muestra
// en el panel; su única meta las primeras ~2 semanas es MEDIR LA TASA DE
// FALSOS POSITIVOS — un % legítimo (derivado, sumado o redondeado por el PM)
// marcado como inventado. Con ese número se decide después si el flag se
// vuelve visible. Por eso el resultado journalea el DETALLE CRUDO por token
// (value, nearest, delta): permite recomputar la tasa con otra tolerancia,
// sin re-correr el modelo ni la corrida. Determinista, sin I/O, sin LLM.
//
// Sesgo deliberado hacia UNDER-FLAG (favorece no gritar "lobo"): el pool de
// referencia es TODO número del prompt, así que una coincidencia fortuita
// (el % citado cae cerca de un precio/ratio/año no relacionado) hace que NO
// se marque. Eso baja los falsos positivos a costa de perder algún inventado
// real — la dirección segura para un flag que aún no es visible.
// ═══════════════════════════════════════════════════════════════

// Tolerancia de match: |abs(plan) - abs(prompt)| <= max(ABS, abs(plan)*REL).
// Permisiva a propósito (tolera el redondeo del PM: "6%" por 6.1%). Se
// journalea junto al resultado para poder re-tunear el post-mortem.
export const AUDIT_ABS_TOL = 0.05;   // puntos porcentuales
export const AUDIT_REL_TOL = 0.02;   // 2% del valor citado

// Todos los % del plan: captura el número (con signo opcional) pegado a un
// '%'. "6.1%" / "+6.1%" / "-2.14%" / "15 %" → 6.1 / 6.1 / -2.14 / 15.
const PLAN_PCT = /([+-]?\d+(?:\.\d+)?)\s*%/g;
// Todos los números del prompt (años, días, precios, ratios, los % ya
// formateados como "+6.1%"): el pool contra el que se cotejan los % del plan.
const ANY_NUM = /[+-]?\d+(?:\.\d+)?/g;

// Magnitudes (abs) de todos los números de un texto. Abs porque el signo se
// guarda de forma inconsistente entre fuentes (un P&L "+6.1%" vs un margen
// 6.1) y el cotejo es por magnitud.
function magnitudesIn(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const m = text.match(ANY_NUM);
  if (m) for (const s of m) { const n = Number(s); if (Number.isFinite(n)) out.push(Math.abs(n)); }
  return out;
}

// plan: la prosa del PM (string). promptText: TODO lo que el PM vio (system +
// user del DIVE concatenados). Devuelve:
//   { tolerance:{abs,rel}, checked, unmatched, tokens:[{token,value,matched,nearest,delta}] }
// checked = # de tokens % hallados; unmatched = # sin ancla en el prompt.
// Nunca lanza: entradas no-string → cero tokens.
export function auditPlanPercentages(plan, promptText) {
  const pool = magnitudesIn(promptText);
  const tokens = [];
  if (typeof plan === 'string') {
    PLAN_PCT.lastIndex = 0;
    let m;
    while ((m = PLAN_PCT.exec(plan)) !== null) {
      const value = Number(m[1]);
      if (!Number.isFinite(value)) continue;
      const target = Math.abs(value);
      const tol = Math.max(AUDIT_ABS_TOL, target * AUDIT_REL_TOL);
      let nearest = null;
      let best = Infinity;
      for (const p of pool) {
        const d = Math.abs(target - p);
        if (d < best) { best = d; nearest = p; }
      }
      tokens.push({
        token: m[0].trim(),
        value,
        matched: nearest != null && best <= tol,
        nearest,
        delta: nearest != null ? +best.toFixed(4) : null,
      });
    }
  }
  const unmatched = tokens.filter((t) => !t.matched).length;
  return { tolerance: { abs: AUDIT_ABS_TOL, rel: AUDIT_REL_TOL }, checked: tokens.length, unmatched, tokens };
}
