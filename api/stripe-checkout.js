// ═══════════════════════════════════════════════════════════════
// /api/stripe-checkout — crea una Stripe Checkout Session para la
// suscripción Pro ($29/mes) y devuelve su URL; el frontend solo redirige.
//
// Sin SDK de Stripe: el repo no tiene package.json y todos los endpoints
// hablan HTTP con fetch — aquí igual, contra la API REST de Stripe.
// Sin Stripe.js ni publishable key: la sesión se crea server-side y el
// cliente navega a session.url.
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   sk_live_... o sk_test_...
//   STRIPE_PRICE_ID     price_... (el price recurrente de $29/mes)
//
// INPUT   POST /api/stripe-checkout   { "email": "opcional@..." }
//         (si viene email, Checkout lo precarga; si no, Stripe lo pide)
// OUTPUT  { url }  → redirigir ahí. Tras pagar, Stripe regresa a
//         /app?stripe=success&session_id={CHECKOUT_SESSION_ID}
// ═══════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1';

// Origen público de la app (para success/cancel URLs), derivado del request.
function appOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function stripePost(path, form, key) {
  const r = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Stripe HTTP ${r.status}`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Usa POST.', usage: "POST /api/stripe-checkout {email?}" });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  if (!key || !price) {
    return res.status(500).json({ error: 'Faltan STRIPE_SECRET_KEY / STRIPE_PRICE_ID en las env vars.' });
  }

  const email = ((req.body || {}).email || '').toString().trim().toLowerCase();
  const origin = appOrigin(req);

  try {
    const form = {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      // {CHECKOUT_SESSION_ID} lo sustituye Stripe — no debe ir URL-encoded.
      success_url: origin + '/app?stripe=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/app?stripe=cancel',
    };
    if (email) form.customer_email = email;

    const session = await stripePost('/checkout/sessions', form, key);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: 'Stripe: ' + (err && err.message ? err.message : 'unknown') });
  }
}
