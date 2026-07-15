// ═══════════════════════════════════════════════════════════════
// /api/stripe-status — ¿este usuario es Pro?
//
// Decisión de diseño (v1): SIN base de datos. La fuente de verdad es
// Stripe: aquí se consulta en vivo. El frontend cachea la respuesta unas
// horas en localStorage, así que el volumen de llamadas es trivial.
//
// Dos modos:
//   ?session_id=cs_...  justo después del Checkout: recupera la sesión,
//                       devuelve el email pagado y su estado. Así la app
//                       "aprende" la identidad sin que el usuario re-escriba
//                       su correo.
//   ?email=...          verificación normal: busca los customers de ese
//                       email y revisa si alguno tiene suscripción viva.
//
// "Pro" = suscripción en estado active, trialing o past_due (gracia
// mientras Stripe reintenta el cobro). canceled/unpaid/incomplete no.
//
// ENV VARS: STRIPE_SECRET_KEY
// OUTPUT   { pro, status, current_period_end, email }
// ═══════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1';
const PRO_STATUSES = ['active', 'trialing', 'past_due'];

async function stripeGet(path, key) {
  const r = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Stripe HTTP ${r.status}`);
  return data;
}

// Mejor suscripción de un customer: la Pro más reciente, o la más reciente
// a secas si ninguna está viva (para poder reportar status=canceled).
function pickSubscription(subs) {
  if (!subs.length) return null;
  const alive = subs.filter((s) => PRO_STATUSES.includes(s.status));
  const pool = alive.length ? alive : subs;
  return pool.sort((a, b) => (b.created || 0) - (a.created || 0))[0];
}

// current_period_end vive en el objeto Subscription hasta la versión de API
// 2025-03-31 ('Basil'); desde ahí Stripe lo movió a los Subscription Items.
// Esta integración no pina versión (usa el default de la cuenta, post-Basil
// en cuentas nuevas), así que el campo llegaba undefined y el panel PRO
// mostraba 'Renews on —'. Se leen AMBOS shapes.
function periodEnd(sub) {
  if (!sub) return null;
  return sub.current_period_end
    ?? sub.items?.data?.[0]?.current_period_end
    ?? null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY en las env vars.' });

  const q = req.query || {};
  const sessionId = (q.session_id || '').toString().trim();
  const email = (q.email || '').toString().trim().toLowerCase();

  try {
    // ── Modo post-checkout: sesión → email + estado de su suscripción. ──
    if (sessionId) {
      const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, key);
      const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      const paidEmail = (session.customer_details?.email || session.customer_email || '').toLowerCase();
      return res.status(200).json({
        pro: session.status === 'complete' && (!sub || PRO_STATUSES.includes(sub.status)),
        status: sub ? sub.status : session.status,
        current_period_end: periodEnd(sub),
        email: paidEmail || null,
      });
    }

    // ── Modo normal: email → customers → ¿alguna suscripción viva? ──
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Falta email (o session_id).', usage: '/api/stripe-status?email=tu@correo.com' });
    }

    const { data: customers = [] } = await stripeGet(`/customers?email=${encodeURIComponent(email)}&limit=10`, key);
    let allSubs = [];
    for (const c of customers) {
      const { data: subs = [] } = await stripeGet(`/subscriptions?customer=${encodeURIComponent(c.id)}&status=all&limit=10`, key);
      allSubs = allSubs.concat(subs);
    }
    const sub = pickSubscription(allSubs);

    return res.status(200).json({
      pro: sub ? PRO_STATUSES.includes(sub.status) : false,
      status: sub ? sub.status : 'none',
      current_period_end: periodEnd(sub),
      email,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Stripe: ' + (err && err.message ? err.message : 'unknown') });
  }
}

// Export para unit tests.
export { pickSubscription, periodEnd, PRO_STATUSES };
