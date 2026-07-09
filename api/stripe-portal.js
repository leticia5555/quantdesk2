// ═══════════════════════════════════════════════════════════════
// /api/stripe-portal — sesión del Customer Portal de Stripe.
//
// Gestión y cancelación de la suscripción SIN construir nada propio:
// se busca el customer por email y se le abre su portal oficial de
// Stripe (cancelar, cambiar tarjeta, ver facturas). Al salir, Stripe
// lo regresa a /app.
//
// ENV VARS: STRIPE_SECRET_KEY
// INPUT    POST /api/stripe-portal { "email": "..." }
// OUTPUT   { url } → redirigir ahí.
// ═══════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1';

function appOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function stripeCall(path, key, form) {
  const r = await fetch(`${STRIPE_API}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
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
    return res.status(405).json({ error: 'Usa POST.', usage: "POST /api/stripe-portal {email}" });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY en las env vars.' });

  const email = ((req.body || {}).email || '').toString().trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Falta el email de la suscripción.' });
  }

  try {
    const { data: customers = [] } = await stripeCall(`/customers?email=${encodeURIComponent(email)}&limit=10`, key);
    if (!customers.length) {
      return res.status(404).json({ error: `No hay ningún cliente de Stripe con el email ${email}.` });
    }
    // Con varios customers del mismo email, el más reciente gana.
    const customer = customers.sort((a, b) => (b.created || 0) - (a.created || 0))[0];

    const session = await stripeCall('/billing_portal/sessions', key, {
      customer: customer.id,
      return_url: appOrigin(req) + '/app',
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: 'Stripe: ' + (err && err.message ? err.message : 'unknown') });
  }
}
