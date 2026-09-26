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
// ── Y TAMBIÉN EL DATO, no sólo el latido ───────────────────────────
// Un latido contesta "¿corrió el cron?". La pregunta que costó seis días el
// 2026-09-21 fue otra: "¿está al día la tabla?". `bmv_precios` llevaba desde
// el martes 15 sin una fila nueva y nada acá se puso rojo, porque no había
// cron que latiera — y un cron que corre, contesta 200 y no escribe nada
// habría dejado el latido igual de verde. Por eso `datos[]` mide la tabla,
// que es lo que el consumidor realmente necesita.
//
// ── Y LAS TAREAS HUMANAS CON VENCIMIENTO ───────────────────────────
// `referencias_cap` vigila las capitalizaciones de referencia MX, que las
// captura una persona a mano y caducan cuando la emisora publica un trimestre
// nuevo de acciones. No es un cron, pero se descuida igual — y cuando caduca
// una, su emisora se va a gris en el mapa. Acá se ve venir con días de
// gracia, en vez de descubrirse cuando G2 ya está rojo.
//
// Metadata operativa (nombres de job + timestamps), sin secretos → sin gate.
// ═══════════════════════════════════════════════════════════════════

import { readHeartbeats } from './_lib/heartbeat.js';
import { sql } from './_lib/db.js';
import { frescuraPrecios } from './_lib/bmv-frescura.js';
import { vigenciaDelRegistro, SQL_G2 } from './_lib/mercado-r0.js';
import REFERENCIAS_CAP from './_lib/mercado-cap-referencia.json' with { type: 'json' };
import REFERENCIAS_CAP_US from './_lib/mercado-cap-us-referencia.json' with { type: 'json' };
import { vigenciaReferenciasUs } from './_lib/mercado-cap-us.js';

// Cadencia esperada por job, alineada con vercel.json. `stale_after_h` es el
// umbral de "algo anda mal": > 2× el intervalo, y para los crons de 1-5
// (lun-vie) se estira para cubrir el hueco del fin de semana (vie→lun ≈ 72h).
export const EXPECTED = [
  { job: 'agents:run',      path: '/api/agents-run',                 schedule: '30 22 * * 1-5',         cadence: 'días hábiles ~22:30', stale_after_h: 80 },
  { job: 'arena:decide',    path: '/api/arena-run',                  schedule: '40 22 * * 1-5',         cadence: 'días hábiles ~22:40', stale_after_h: 80 },
  { job: 'arena:reconcile', path: '/api/arena-run?phase=reconcile',  schedule: '40 14 * * 1-5',         cadence: 'días hábiles ~14:40', stale_after_h: 80 },
  // T2 #7: corrida matutina POR EVENTO. Late TODOS los días hábiles aunque no
  // haya evento (el latido dice "el cron corrió", no "operó") — por eso la
  // ventana de stale es la misma que la de los otros diarios.
  { job: 'arena:morning',   path: '/api/arena-run?phase=morning',    schedule: '50 14 * * 1-5',         cadence: 'días hábiles ~14:50', stale_after_h: 80 },
  // CADENCIA: el VIGILANTE. Late en CADA tick, incluidos los que caen fuera de sesión
  // (la ventana UTC 13-21 cubre EDT y EST) y los que no disparan nada — el
  // latido dice "el vigilante corrió", no "operó".
  // La ventana de stale la manda el FIN DE SEMANA, no la cadencia: el último
  // tick es viernes ~21:00 UTC y el primero lunes ~13:00 UTC, 64h de hueco
  // legítimo. 72h le da margen sin dar un falso rojo cada lunes. Es un umbral
  // GRUESO a propósito — detecta "el cron murió", no "se perdieron unos ticks";
  // para eso último el instrumento fino es `run_count`, que con esta cadencia
  // debería subir ~108 por día hábil.
  { job: 'arena:watch',     path: '/api/arena-watch',                schedule: '*/5 13-21 * * 1-5',     cadence: 'cada 5 min en mercado', stale_after_h: 72 },
  // pead:earnings retirado con el NO-GO del PEAD: sin schedule no hay latido,
  // y dejarlo acá daba ok:false permanente. Ver docs/wheel-fase0.md §4.3.
  { job: 'pead:hour',       path: '/api/pead-harvest?job=hour',      schedule: '30 21 * * *',           cadence: '1×/día (SEC 8-K)',    stale_after_h: 30 },
  // Fase 1 de earnings-beat. Dos jobs separados a propósito: `mercados`
  // descubre y filtra (Gamma), `precios` completa el T-24h de lo que quedó
  // pendiente y re-mira los abiertos (CLOB). Partirlos evita que un CLOB lento
  // se coma el presupuesto del descubrimiento, y deja que cada uno late por su
  // cuenta: si el que se muere es `precios`, la tabla sigue creciendo y se ve.
  { job: 'earnings-beat:mercados', path: '/api/earnings-beat-harvest?job=mercados', schedule: '0 23 * * *',  cadence: '1×/día (Polymarket)', stale_after_h: 30 },
  { job: 'earnings-beat:precios',  path: '/api/earnings-beat-harvest?job=precios',  schedule: '40 23 * * *', cadence: '1×/día (CLOB)',       stale_after_h: 30 },
  { job: 'screener:refresh',path: '/api/arena-screener?job=refresh', schedule: '0 */4 * * *',           cadence: 'cada 4h',             stale_after_h: 9, vive_en: 'github-actions' },
  // R0(a): puebla mercado_universo_us (sector + cap) antes de la apertura, 30
  // min después del arena:universe que le da los símbolos. La ventana de stale
  // la manda el fin de semana, igual que los otros diarios hábiles.
  // Dos veces por hora en horario de mercado, y AUTO-GATEADO: cuando no hay
  // nada pendiente cuesta tres consultas a Neon y devuelve `completo`. Es
  // frecuente porque el backfill inicial no cabe en una corrida (553 símbolos
  // × 2 llamadas a 55 req/min son ~19 min contra un maxDuration de 300 s), y
  // un cron diario habría tardado cinco días en sembrar la tabla.
  // La ventana de stale la manda el FIN DE SEMANA: viernes 21:45 → lunes
  // 13:30 son ~64 h.
  { job: 'mercado:universo',path: '/api/mercado-r0?job=universo',    schedule: '30,45 13-21 * * 1-5',   cadence: '2×/hora en mercado', stale_after_h: 80 },
  // Estaba agendado en vercel.json y latiendo, pero NO en esta lista: salía
  // en `untracked`, que no pone nada en rojo. El universo es el insumo de
  // mercado:universo y de la corrida del Arena.
  { job: 'arena:universe',  path: '/api/arena-universe',             schedule: '0 13 * * 1-5',          cadence: 'días hábiles ~13:00', stale_after_h: 80 },
  // La cola diaria de precios BMV. Corre 22:10 UTC = 16:10 CDMX, una hora
  // después del cierre de la bolsa. Hasta el 2026-09-21 NO EXISTÍA: la
  // cosecha de Fase 1b fue a mano y nunca se agendó, así que la tabla se
  // quedó en el 15-sep sin que nada lo dijera. El latido vigila que el cron
  // corra; `datos[]` vigila que además traiga algo.
  // DOS CORRIDAS, no una. El sábado 2026-09-26 la tabla terminaba el jueves
  // habiendo cerrado el viernes: con una sola pasada a las 22:10 UTC (16:10 en
  // Ciudad de México, 1h10 después del cierre), si el proveedor todavía no
  // publicó el día, no hay segunda oportunidad hasta el lunes. El mapa de EE.UU.
  // corre tres veces por esta misma razón. Acá se agrega UNA sola —no dos— para
  // no triplicar el consumo de DataBursatil, cuyo presupuesto de requests ya
  // dio problemas de medición.
  { job: 'bmv:precios',     path: '/api/bmv-harvest?job=precios',    schedule: '10,40 22 * * 1-5',      cadence: 'días hábiles 22:10 y 22:40', stale_after_h: 80 },
  // R1(a): la serie diaria fechada de EE.UU., que es lo que YTD necesita.
  // Tres veces por hora después del cierre (21:00 UTC) porque la SIEMBRA de
  // 300 nombres a 100/min no cabe en una corrida; una vez sembrada, la cola
  // diaria termina en la primera y las otras dos no piden nada.
  { job: 'mercado:precios', path: '/api/mercado-precios?job=us',      schedule: '20,35,50 21 * * 1-5',   cadence: '3×/hora tras el cierre US', stale_after_h: 80 },
];

// Crons de vercel.json que a propósito NO se vigilan acá, con el porqué. La
// lista existe para que `tests/crons-declarados.test.mjs` pueda exigir que
// todo lo demás esté vigilado: un cron sin latido y sin excepción declarada
// es justo cómo `bmv_precios` se quedó seis días atrás sin que nada lo dijera.
export const SIN_VIGILANCIA = [
  {
    path: '/api/xbrl-capture?run=1',
    porque: 'no emite latido. Su salud se lee en la cobertura de xbrl_reports, no en un heartbeat; meterlo acá lo dejaría en rojo permanente, que es peor que no avisar.',
  },
];

// ── Frescura de DATOS (no de latidos) ───────────────────────────────
// Cada entrada es una tabla cuyo atraso se mide contra el calendario de su
// mercado. `alerta: true` baja el `ok` del endpoint igual que un stale.
const DATOS = [
  {
    clave: 'bmv_precios',
    que_es: 'cierre diario de la BMV — lo que usan las caps MX de /mercado y el backtest',
    sql: 'select max(fecha)::text as hasta from bmv_precios',
    lo_llena: 'bmv:precios',
  },
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

    // El dato. Si la consulta falla, la tabla queda como NO MEDIDA y eso
    // cuenta como alerta: "no sé" y "está al día" no son lo mismo, y el
    // silencio es justo el modo de falla que este bloque existe para cerrar.
    const datos = [];
    for (const d of DATOS) {
      try {
        const r = await sql(d.sql);
        const hasta = r && r[0] ? r[0].hasta : null;
        datos.push({ ...frescuraPrecios({ ultima_fecha: hasta, ahora: new Date(now), tabla: d.clave }),
          que_es: d.que_es, lo_llena: d.lo_llena });
      } catch (e) {
        datos.push({
          tabla: d.clave, que_es: d.que_es, lo_llena: d.lo_llena,
          ultima_fecha: null, dias_habiles_atraso: null, alerta: true,
          motivo: `no se pudo medir: ${String((e && e.message) || e)}`,
        });
      }
    }

    // ── Las referencias de capitalización MX ────────────────────────
    // No es un cron ni una tabla: es una TAREA HUMANA con vencimiento. Cada
    // referencia caduca cuando la emisora publica un trimestre nuevo de
    // acciones, y cuando caduca su emisora se va a gris. Acá se ve venir,
    // con días de gracia, en vez de descubrirlo cuando G2 se pone rojo.
    let referencias = null;
    try {
      const periodos = await sql(SQL_G2.periodos);
      referencias = vigenciaDelRegistro(REFERENCIAS_CAP, new Date(now), { periodos });
    } catch (e) {
      referencias = {
        filas: (REFERENCIAS_CAP.referencias || []).length,
        alerta: true,
        lectura: `no se pudo medir la vigencia de las referencias: ${String((e && e.message) || e)}`,
      };
    }

    // ── Las referencias de ADR de EE.UU. ────────────────────────────
    // Distinto de México a propósito: acá vencer NO apaga el cuadro. La razón
    // del ADR es estructural, así que la referencia vencida sigue sirviendo y
    // lo único que hace falta es reconfirmarla. Por eso NO entra en `ok`: es
    // una tarea con fecha, no una falla, y meter tareas en el rojo es cómo se
    // aprende a ignorar el rojo.
    const referenciasUs = vigenciaReferenciasUs(REFERENCIAS_CAP_US, new Date(now));

    const staleJobs = jobs.filter((j) => j.stale).map((j) => j.job);
    const datosEnAlerta = datos.filter((d) => d.alerta).map((d) => d.tabla);
    return res.status(200).json({
      ok: staleJobs.length === 0 && datosEnAlerta.length === 0 && !(referencias && referencias.alerta),
      checked_at: new Date(now).toISOString(),
      stale: staleJobs,
      datos_en_alerta: datosEnAlerta,
      // Lo que hay que re-capturar a mano, si hay algo. Vacío = nada que hacer.
      referencias_a_recapturar: [
        ...((referencias && referencias.a_recapturar) || []),
        ...referenciasUs.a_recapturar,
      ],
      jobs,
      datos,
      referencias_cap: referencias,
      referencias_cap_us: referenciasUs,
      untracked: extra,
    });
  } catch (err) {
    return res.status(500).json({ error: 'cron-status: ' + (err && err.message ? err.message : 'unknown') });
  }
}
