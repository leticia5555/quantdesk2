// ═══════════════════════════════════════════════════════════════
// /api/config — configuración pública que el frontend necesita saber
// en tiempo de carga. Hoy solo expone el kill-switch del paywall.
//
// app.html es estático (no se renderiza con env vars), así que este
// endpoint es el puente: el front lo consulta al arrancar y decide si
// muestra el paywall o abre todo como Pro.
//
//   GET /api/config → { paywall_enabled: boolean }
//
// paywall_enabled=false (default, env var ausente) → todo usuario es Pro.
// Ver _lib/paywall.js para la semántica del flag.
//
// ENV VARS: PAYWALL_ENABLED
// ═══════════════════════════════════════════════════════════════

import { paywallEnabled } from './_lib/paywall.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Config trivial y de baja frecuencia; cache corto en el edge está bien.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({ paywall_enabled: paywallEnabled() });
}
