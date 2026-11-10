// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-backtest-http.js — gate y respuesta comunes de los endpoints
// pm-fechas-av, pm-centavos2-analyze y pm-drift2h-analyze (los de PM-DRIFT y
// PM-CENTAVOS tienen la suya y no se tocan).
//
// Con CRON_SECRET puesta, sin el secret (header `Authorization: Bearer ...`
// o `?secret=`) → 401. Respuesta `no-store`; `?format=md` → texto.
// ═══════════════════════════════════════════════════════════════════

// Devuelve las opciones de la query, o null si ya respondió (OPTIONS/405/401).
function abre(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return null; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método no soportado.' }); return null; }
  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) { res.status(401).json({ error: 'No autorizado.' }); return null; }
  }
  return {
    md: ['md', 'markdown'].includes(String(q.format || 'json').toLowerCase()),
    soloCobertura: String(q.solo || '') === 'cobertura',
    conObs: String(q.obs || '') === '1',
    bajar: String(q.bajar || '1') !== '0',
  };
}

function responde(res, op, salida, render) {
  res.setHeader('Cache-Control', 'no-store');
  if (op.md) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(render(salida));
  }
  return res.status(200).json(salida);
}

// En modo cobertura no hay veredicto: solo frontera, incompleta o lista.
function soloCobertura(resultado) {
  for (const k of Object.keys(resultado)) if (!['estado', 'motivo', 'cobertura'].includes(k)) delete resultado[k];
  if (!['FALLA DE FRONTERA', 'COBERTURA INCOMPLETA'].includes(resultado.estado)) {
    resultado.estado = 'COBERTURA LISTA';
    resultado.motivo = 'todos los historiales bajados; abre el link sin ?solo=cobertura para el resultado';
  }
  return resultado;
}

export { abre, responde, soloCobertura };
