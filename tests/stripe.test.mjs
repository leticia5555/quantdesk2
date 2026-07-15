// ═══════════════════════════════════════════════════════════════
// Unit tests de la integración Stripe (sin red: fetch mockeado).
// Correr con `node tests/stripe.test.mjs`; sale con código ≠ 0 si falla.
// ═══════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import webhookHandler, { verifyStripeSignature, TOLERANCE_SECONDS } from '../api/stripe-webhook.js';
import statusHandler, { pickSubscription } from '../api/stripe-status.js';
import checkoutHandler from '../api/stripe-checkout.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// res mínimo estilo Vercel.
function mockRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

// req de webhook: stream async-iterable con el body crudo.
function mockWebhookReq(rawBody, headers) {
  return {
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(rawBody, 'utf8'); },
  };
}

function signPayload(rawBody, secret, t) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

// ─────────────────── verifyStripeSignature ───────────────────
console.log('webhook: verificación de firma');
{
  const secret = 'whsec_test_abc123';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1750000000;

  ok(verifyStripeSignature(body, signPayload(body, secret, now), secret, now) === true,
    'firma válida pasa');
  ok(verifyStripeSignature(body + ' ', signPayload(body, secret, now), secret, now) === false,
    'body alterado falla');
  ok(verifyStripeSignature(body, signPayload(body, 'whsec_otro', now), secret, now) === false,
    'secret equivocado falla');
  ok(verifyStripeSignature(body, signPayload(body, secret, now - TOLERANCE_SECONDS - 1), secret, now) === false,
    'timestamp fuera de tolerancia (replay) falla');
  ok(verifyStripeSignature(body, 'v1=deadbeef', secret, now) === false,
    'header sin timestamp falla');
  ok(verifyStripeSignature(body, '', secret, now) === false, 'header vacío falla');
  // varias v1 (rotación de secrets en Stripe): basta que una coincida.
  const good = signPayload(body, secret, now);
  const multi = good.replace('v1=', 'v1=badbadbad,v1=');
  ok(verifyStripeSignature(body, multi, secret, now) === true,
    'múltiples v1: una válida basta');
}

// ─────────────────── webhook handler end-to-end ───────────────────
console.log('webhook: handler');
{
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_abc123';
  const now = Math.floor(Date.now() / 1000);

  const event = JSON.stringify({
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'a@b.c' } } },
  });
  let res = mockRes();
  await webhookHandler(mockWebhookReq(event, { 'stripe-signature': signPayload(event, 'whsec_test_abc123', now) }), res);
  ok(res.code === 200 && res.body && res.body.received === true, 'evento firmado → 200 received', JSON.stringify([res.code, res.body]));

  res = mockRes();
  await webhookHandler(mockWebhookReq(event, { 'stripe-signature': signPayload(event, 'whsec_INTRUSO', now) }), res);
  ok(res.code === 400, 'firma inválida → 400', res.code);

  const baja = JSON.stringify({
    id: 'evt_2', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_1', ended_at: now } },
  });
  res = mockRes();
  await webhookHandler(mockWebhookReq(baja, { 'stripe-signature': signPayload(baja, 'whsec_test_abc123', now) }), res);
  ok(res.code === 200, 'subscription.deleted firmado → 200', res.code);

  res = mockRes();
  await webhookHandler({ method: 'GET', headers: {} }, res);
  ok(res.code === 405, 'GET → 405', res.code);
}

// ─────────────────── pickSubscription ───────────────────
console.log('status: pickSubscription');
{
  const sub = (id, status, created) => ({ id, status, created });
  ok(pickSubscription([]) === null, 'sin suscripciones → null');
  ok(pickSubscription([sub('a', 'canceled', 1), sub('b', 'active', 2)]).id === 'b',
    'activa gana sobre cancelada');
  ok(pickSubscription([sub('a', 'active', 1), sub('b', 'active', 9)]).id === 'b',
    'entre dos vivas gana la más reciente');
  ok(pickSubscription([sub('a', 'canceled', 5), sub('b', 'canceled', 9)]).id === 'b',
    'solo muertas: reporta la más reciente (status=canceled)');
  ok(pickSubscription([sub('a', 'trialing', 1)]).status === 'trialing', 'trialing cuenta como viva');
}

// ─────────────────── status handler (fetch mockeado) ───────────────────
console.log('status: handler');
{
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const body =
      url.includes('/customers?') ? { data: [{ id: 'cus_1', created: 1 }] } :
      url.includes('/subscriptions?') ? { data: [{ id: 'sub_1', status: 'active', created: 5, current_period_end: 1760000000 }] } :
      url.includes('/checkout/sessions/') ? {
        status: 'complete',
        customer_details: { email: 'Pago@Test.Com' },
        subscription: { status: 'active', current_period_end: 1760000000, created: 5 },
      } : {};
    return { ok: true, json: async () => body };
  };

  let res = mockRes();
  await statusHandler({ method: 'GET', query: { email: 'A@B.C' } }, res);
  ok(res.code === 200 && res.body.pro === true && res.body.status === 'active' && res.body.email === 'a@b.c',
    'email con sub activa → pro:true (email normalizado)', JSON.stringify(res.body));
  ok(calls.some((u) => u.includes('email=a%40b.c')), 'consulta a Stripe con el email en minúsculas');

  res = mockRes();
  await statusHandler({ method: 'GET', query: { session_id: 'cs_test_1' } }, res);
  ok(res.code === 200 && res.body.pro === true && res.body.email === 'pago@test.com',
    'session_id post-checkout → pro:true + email del pago', JSON.stringify(res.body));

  res = mockRes();
  await statusHandler({ method: 'GET', query: {} }, res);
  ok(res.code === 400, 'sin email ni session_id → 400', res.code);

  // email sin suscripciones
  global.fetch = async (url) => ({ ok: true, json: async () => (url.includes('/customers?') ? { data: [] } : { data: [] }) });
  res = mockRes();
  await statusHandler({ method: 'GET', query: { email: 'nadie@x.y' } }, res);
  ok(res.code === 200 && res.body.pro === false && res.body.status === 'none',
    'email sin customer → pro:false status:none', JSON.stringify(res.body));

  global.fetch = realFetch;
}

// ─────────────────── checkout handler (fetch mockeado) ───────────────────
console.log('checkout: handler');
{
  const realFetch = global.fetch;

  delete process.env.STRIPE_PRICE_ID;
  let res = mockRes();
  await checkoutHandler({ method: 'POST', headers: {}, body: {} }, res);
  ok(res.code === 500, 'sin STRIPE_PRICE_ID → 500 con mensaje claro', res.code);

  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_PRICE_ID = 'price_test_29';
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
  };

  res = mockRes();
  await checkoutHandler({
    method: 'POST',
    headers: { 'x-forwarded-proto': 'https', host: 'quantdesk.app' },
    body: { email: 'Y O@x.com '.trim() && 'yo@x.com' },
  }, res);
  const form = new URLSearchParams(captured.body);
  ok(res.code === 200 && res.body.url && res.body.url.includes('checkout.stripe.com'),
    'devuelve la URL de la sesión', JSON.stringify(res.body));
  ok(form.get('mode') === 'subscription' && form.get('line_items[0][price]') === 'price_test_29',
    'mode=subscription con el price de la env var', captured.body);
  ok(form.get('success_url') === 'https://quantdesk.app/app?stripe=success&session_id={CHECKOUT_SESSION_ID}',
    'success_url regresa a /app con {CHECKOUT_SESSION_ID} sin encodear', form.get('success_url'));
  ok(form.get('customer_email') === 'yo@x.com', 'precarga el email si viene', form.get('customer_email'));

  res = mockRes();
  await checkoutHandler({ method: 'GET', headers: {}, query: {} }, res);
  ok(res.code === 405, 'GET → 405', res.code);

  global.fetch = realFetch;
}

// ─────────────────── periodEnd: shapes pre y post-Basil ───────────────────
console.log('periodEnd (Renews on): shape viejo y nuevo de la API de Stripe');
{
  const { periodEnd } = await import('../api/stripe-status.js');
  ok(periodEnd({ current_period_end: 1780000000 }) === 1780000000,
    'shape pre-Basil: current_period_end en la suscripción');
  ok(periodEnd({ items: { data: [{ current_period_end: 1790000000 }] } }) === 1790000000,
    'shape post-Basil (2025-03-31+): el campo vive en items.data[0]');
  ok(periodEnd({ current_period_end: 1780000000, items: { data: [{ current_period_end: 1790000000 }] } }) === 1780000000,
    'si vienen ambos, gana el de la suscripción');
  ok(periodEnd({ items: { data: [] } }) === null && periodEnd(null) === null,
    'sin datos → null (el panel muestra —, no crashea)');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
