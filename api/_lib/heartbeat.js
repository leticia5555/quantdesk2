// ═══════════════════════════════════════════════════════════════════
// api/_lib/heartbeat.js — latido de los crons ("¿cuándo corrió cada job?").
//
// Un cron muerto no debe volver a pasar días desapercibido. Cada job de
// cron llama a beat(...) al terminar; /api/cron-status lee la tabla y marca
// en rojo lo que lleva más de lo esperado sin latir.
//
// Una sola tabla, una fila por job:
//   cron_heartbeat(job, last_run_at, last_status, last_ok_at, run_count, detail)
//
// Diseño defensivo: beat() NUNCA lanza. Si la DB falla, el latido se pierde
// pero el job sigue su curso — el heartbeat es observabilidad, no la tarea.
// ═══════════════════════════════════════════════════════════════════

import { sql } from './db.js';

const HEARTBEAT_SCHEMA = `create table if not exists cron_heartbeat (
   job          text primary key,
   last_run_at  timestamptz not null default now(),
   last_status  text,                       -- 'ok' | 'skipped' | 'error' | 'disabled'
   last_ok_at   timestamptz,                -- último latido con status='ok'
   run_count    int not null default 0,
   detail       jsonb                       -- resumen chico de la última corrida
 )`;

let ready = false;
async function ensureHeartbeatSchema() {
  if (ready) return;
  await sql(HEARTBEAT_SCHEMA);
  ready = true;
}

// Registra que `job` acaba de correr. status: 'ok' (default) | 'skipped' |
// 'error' | 'disabled'. `detail` es un objeto chico (se serializa a jsonb).
// Traga sus propios errores: el latido jamás tumba al job.
async function beat(job, status = 'ok', detail = null) {
  try {
    await ensureHeartbeatSchema();
    await sql(
      `insert into cron_heartbeat (job, last_run_at, last_status, last_ok_at, run_count, detail)
       values ($1, now(), $2, case when $2 = 'ok' then now() else null end, 1, $3)
       on conflict (job) do update set
         last_run_at = now(),
         last_status = excluded.last_status,
         last_ok_at  = case when excluded.last_status = 'ok' then now() else cron_heartbeat.last_ok_at end,
         run_count   = cron_heartbeat.run_count + 1,
         detail      = excluded.detail`,
      [job, status, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    // Silencio deliberado: observabilidad best-effort.
  }
}

async function readHeartbeats() {
  await ensureHeartbeatSchema();
  return sql(
    `select job, last_run_at, last_status, last_ok_at, run_count, detail
       from cron_heartbeat order by job`
  );
}

export { beat, readHeartbeats, ensureHeartbeatSchema, HEARTBEAT_SCHEMA };
