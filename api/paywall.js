// ═══════════════════════════════════════════════════════════════
// /api/paywall — expone el kill-switch del paywall al frontend estático.
//
// app.html es HTML estático (sin templating server-side), así que no puede
// leer env vars directamente: las consulta aquí al arrancar. El front tiene
// un default seguro APAGADO (todos Pro), y solo re-activa el gate si este
// endpoint responde { enabled: true }.
//
// ENV VAR: PAYWALL_ENABLED  ('true' → paywall activo; ausente/otra = off)
// OUTPUT   { enabled: boolean }
// ═══════════════════════════════════════════════════════════════

import { paywallEnabled } from './_lib/paywall.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Sin caché: el flag debe poder cambiar al instante desde Vercel.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json({ enabled: paywallEnabled() });
}
