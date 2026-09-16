// ═══════════════════════════════════════════════════════════════
// api/_lib/build-info.js — QUÉ BUILD ESTÁ CONTESTANDO.
//
// El 2026-09-16 Lety corrió `?diag=DELL,COP` a las 16:24 UTC y recibió una
// corrida normal, sin la sección de diagnóstico. La pregunta razonable fue
// "¿se ignora el parámetro?". No: el PR se mergeó a las 16:24:36 y Vercel
// todavía no había construido. El parámetro llegó a un build que no lo conocía.
//
// Eso costó una ronda entera de ida y vuelta para una pregunta que la propia
// respuesta podía contestar. Ahora la contesta: cada endpoint del Arena
// devuelve el commit que la sirvió.
//
// Es observabilidad pura: no decide nada y nunca lanza. Si las env vars de
// Vercel no están (local, otro host), devuelve nulls en vez de inventar.
// ═══════════════════════════════════════════════════════════════

export function buildInfo() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || null;
  return {
    commit: sha ? String(sha).slice(0, 7) : null,
    commit_full: sha || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    // El asunto del commit alcanza para reconocer un PR sin abrir GitHub.
    mensaje: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0].slice(0, 120) || null,
    entorno: process.env.VERCEL_ENV || null,
    nota: sha
      ? 'Si este commit no es el que esperabas, el deploy todavía no salió: la respuesta viene del build anterior, no de un parámetro ignorado.'
      : 'Sin env vars de Vercel: corriendo fuera de Vercel o en un entorno sin la integración de git.',
  };
}
