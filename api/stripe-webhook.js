// ═══════════════════════════════════════════════════════════════
// /api/stripe-webhook — recibe eventos de Stripe con firma verificada.
//
// Eventos manejados:
//   checkout.session.completed     → alta de la suscripción Pro
//   customer.subscription.deleted  → baja de la suscripción
//
// Decisión de diseño (v1): SIN base de datos — el estado de suscripción
// se consulta en vivo contra Stripe en /api/stripe-status, así que aquí
// no hay nada que persistir y es imposible desincronizarse. El webhook
// igual verifica la firma y procesa ambos eventos: es el registro en los
// logs de Vercel y el punto de extensión donde se conectaría un KV,
// un email de bienvenida o analytics cuando haga falta.
//
// FIRMA: verificación manual del header Stripe-Signature (HMAC-SHA256
// sobre `${timestamp}.${rawBody}` con el signing secret), sin SDK.
// El body se lee CRUDO del stream — la firma es sobre los bytes exactos.
//
// CONFIGURACIÓN EN STRIPE (dashboard → Developers → Webhooks):
//   endpoint:  https://<tu-dominio>/api/stripe-webhook
//   eventos:   checkout.session.completed, customer.subscription.deleted
//   el "Signing secret" (whsec_...) va en la env var STRIPE_WEBHOOK_SECRET.
//
// ENV VARS: STRIPE_WEBHOOK_SECRET
// ═══════════════════════════════════════════════════════════════

import crypto from 'node:crypto';

const TOLERANCE_SECONDS = 300; // 5 min contra replay de eventos viejos

// Parsea "t=...,v1=...,v0=..." del header Stripe-Signature.
function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of (header || '').split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') out.t = parseInt(v, 10);
    if (k === 'v1' && v) out.v1.push(v);
  }
  return out;
}

// Verificación estilo Stripe: HMAC-SHA256(secret, `${t}.${payload}`) debe
// coincidir con alguna firma v1, y el timestamp caer dentro de la tolerancia.
// `nowSeconds` es inyectable para poder testearla con firmas sintéticas.
function verifyStripeSignature(rawBody, header, secret, nowSeconds) {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || !v1.length) return false;
  const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  return v1.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

// Body crudo del stream: la firma es sobre los bytes exactos, no sobre
// el JSON re-serializado (JSON.stringify(req.body) NO reproduce el original).
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Falta STRIPE_WEBHOOK_SECRET en las env vars.' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el body.' });
  }

  if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'Firma de Stripe inválida.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Body no es JSON válido.' });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data?.object || {};
      const email = s.customer_details?.email || s.customer_email || '?';
      // Sin DB no hay nada que escribir: Stripe ya ES el estado. El log
      // deja rastro auditable en Vercel de cada alta.
      console.log(`[stripe-webhook] Pro ALTA: ${email} (customer ${s.customer || '?'}, sub ${s.subscription || '?'})`);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data?.object || {};
      console.log(`[stripe-webhook] Pro BAJA: customer ${sub.customer || '?'} (sub ${sub.id || '?'}, fin ${sub.ended_at || '?'})`);
      break;
    }
    default:
      // Evento no suscrito o futuro: se reconoce sin procesar para que
      // Stripe no lo reintente.
      console.log(`[stripe-webhook] evento ignorado: ${event.type}`);
  }

  return res.status(200).json({ received: true });
}

// Export para unit tests.
export { verifyStripeSignature, parseSignatureHeader, TOLERANCE_SECONDS };
