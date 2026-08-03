// ═══════════════════════════════════════════════════════════════════
// api/cron-status.js — salud de los crons de un vistazo.
//
//   GET /api/cron-status        — JSON con cada job esperado, su último
//                                 latido, la edad y si está STALE (rojo).
//
// El objetivo (issue "el cron del PEAD no corría 3 días sin que nadie lo
// notara"): que un cron muerto se vea al instante. `stale_after_h` por job
// da margen sobre su cadencia real (los crons de días hábiles toleran el fin
// de semana). Si algo está stale, `ok:false` → fácil de monitorear/alertar.
//
// Metadata operativa (nombres de job + timestamps), sin secretos → sin gate.
// ═══════════════════════════════════════════════════════════════════

import { readHeartbeats } from './_lib/heartbeat.js';

// Cadencia esperada por job, alineada con vercel.json. `stale_after_h` es el
// umbral de "algo anda mal": > 2× el intervalo, y para los crons de 1-5
// (lun-vie) se estira para cubrir el hueco del fin de semana (vie→lun ≈ 72h).
const EXPECTED = [
  { job: 'agents:run',      schedule: '30 22 * * 1-5',         cadence: 'días hábiles ~22:30', stale_after_h: 80 },
  { job: 'arena:decide',    schedule: '40 22 * * 1-5',         cadence: 'días hábiles ~22:40', stale_after_h: 80 },
  { job: 'arena:reconcile', schedule: '40 14 * * 1-5',         cadence: 'días hábiles ~14:40', stale_after_h: 80 },
  { job: 'pead:earnings',   schedule: '0 12,14,16,18,20 * * *', cadence: '5×/día (goteo AV)',   stale_after_h: 8 },
  { job: 'pead:hour',       schedule: '30 21 * * *',           cadence: '1×/día (SEC 8-K)',    stale_after_h: 30 },
  { job: 'screener:refresh',schedule: '0 */4 * * *',           cadence: 'cada 4h',             stale_after_h: 9 },
];

const HOUR_MS = 3600 * 1000;

function fmtAge(ms) {
  if (ms == null) return null;
  const h = ms / HOUR_MS;
  if (h < 1) return `${Math.round(ms / 60000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  try {
    const beats = await readHeartbeats();
    const byJob = new Map(beats.map((b) => [b.job, b]));
    const now = Date.now();

    const jobs = EXPECTED.map((exp) => {
      const b = byJob.get(exp.job);
      const lastRun = b && b.last_run_at ? new Date(b.last_run_at).getTime() : null;
      const ageMs = lastRun == null ? null : now - lastRun;
      const stale = ageMs == null || ageMs > exp.stale_after_h * HOUR_MS;
      return {
        job: exp.job,
        schedule: exp.schedule,
        cadence: exp.cadence,
        last_run_at: b ? b.last_run_at : null,
        last_status: b ? b.last_status : null,
        run_count: b ? b.run_count : 0,
        age: fmtAge(ageMs),
        age_hours: ageMs == null ? null : +(ageMs / HOUR_MS).toFixed(2),
        stale,
        detail: b ? b.detail : null,
      };
    });

    // Latidos de jobs que no están en EXPECTED (p.ej. corridas manuales nuevas).
    const known = new Set(EXPECTED.map((e) => e.job));
    const extra = beats.filter((b) => !known.has(b.job)).map((b) => ({
      job: b.job, last_run_at: b.last_run_at, last_status: b.last_status,
      run_count: b.run_count, tracked: false,
    }));

    const staleJobs = jobs.filter((j) => j.stale).map((j) => j.job);
    return res.status(200).json({
      ok: staleJobs.length === 0,
      checked_at: new Date(now).toISOString(),
      stale: staleJobs,
      jobs,
      untracked: extra,
    });
  } catch (err) {
    return res.status(500).json({ error: 'cron-status: ' + (err && err.message ? err.message : 'unknown') });
  }
}
