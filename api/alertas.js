// ═══════════════════════════════════════════════════════════════════
// api/alertas.js — los jobs que DISPARAN las alertas de Telegram.
//
// El módulo que manda es `api/_lib/alertas.js`; esto sólo decide CUÁNDO.
//
//   GET /api/alertas?job=vigia     cron, cada 10 min. Mira tres cosas:
//                                    · saldo de OpenRouter bajo el piso
//                                    · crons en falla (latido `error` o sin latir)
//                                    · emisoras que cerraron con > 30% en 1D
//   GET /api/alertas?job=resumen   cron, 02:00 UTC = 20:00 en Monterrey
//                                  (UTC−6 todo el año: México no cambia de
//                                  horario desde 2022). La Liga + cobertura
//                                  de Form 4.
//   GET /api/alertas?job=chat-id   a mano, una vez: lee getUpdates, toma el
//                                  chat privado que le escribió al bot y lo
//                                  guarda como TELEGRAM_CHAT_ID.
//   GET /api/alertas?job=prueba    a mano: manda un mensaje de prueba.
//   GET /api/alertas?job=estado    qué hay configurado y las últimas alertas.
//
//   &seco=1 en vigia/resumen: arma los textos y NO manda ni marca nada.
//
// COMPUERTA: CRON_SECRET (el `Authorization: Bearer` que pone Vercel en sus
// crons) o ARENA_ADMIN_KEY. Sin ninguna de las dos configurada contesta 503:
// un endpoint que le escribe a un teléfono no queda abierto por omisión.
//
// ENV VARS: TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID (opc.) · DATABASE_URL ·
//           OPENROUTER_API_KEY · CRON_SECRET / ARENA_ADMIN_KEY ·
//           ARENA_OPENROUTER_PISO_USD (opc., default 10) ·
//           ALERTA_MOVIMIENTO_PCT (opc., default 30)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { beat, readHeartbeats } from './_lib/heartbeat.js';
import { checkLecturaAuth } from './_lib/arena-admin.js';
import { leerSaldoOpenRouter, estadoSaldo, pisoSaldo } from './_lib/openrouter-saldo.js';
import {
  enviarAlerta, cerrarEpisodiosDeCron, ensureAlertasSchema, estadoDeConfig,
  alertaSaldo, cronsEnFalla, alertaCron, movimientosFuertes, alertaMovimiento,
  alertaResumen, alertaDePrueba, fechaMonterrey, telegram, chatsDeUpdates, elegirChat,
  guardarChatId, enmascara, sinToken, UMBRAL_MOVIMIENTO_PCT,
} from './_lib/alertas.js';
import { EXPECTED } from './cron-status.js';
import mercadoMapa from './mercado-mapa.js';
import leaderboard from './leaderboard.js';
import stockTracker from './stock-tracker.js';

export const maxDuration = 60;

// ── Los datos se piden A LOS MISMOS HANDLERS que pintan las páginas ──
// En proceso, sin HTTP: el número del resumen es el de /liga y el de
// /mercado/insiders porque sale del mismo código, y no depende de adivinar la
// URL del deploy ni de pasar por la protección de los previews.
export async function llamar(handler, query = {}) {
  const r = { code: 200, cuerpo: null };
  const res = {
    setHeader() { return res; },
    status(c) { r.code = c; return res; },
    json(b) { r.cuerpo = b; return res; },
    send(b) { r.cuerpo = b; return res; },
    end() { return res; },
  };
  try {
    await handler({ method: 'GET', query, headers: {} }, res);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  if (r.code >= 400 || !r.cuerpo || typeof r.cuerpo !== 'object') {
    return { error: (r.cuerpo && r.cuerpo.error) || `HTTP ${r.code}` };
  }
  return r.cuerpo;
}

function umbralMovimiento(env = process.env) {
  const n = Number(env.ALERTA_MOVIMIENTO_PCT);
  return Number.isFinite(n) && n > 0 ? n : UMBRAL_MOVIMIENTO_PCT;
}

// ─────────────────────────── vigía ───────────────────────────
// Cada revisión es independiente: si una revienta, las otras dos corren
// igual y el error queda en la respuesta y en el latido.
export async function jobVigia({ seco = false, ahora = new Date(), deps = {} } = {}) {
  const d = {
    sql, env: process.env, fetchImpl: fetch,
    leerSaldo: leerSaldoOpenRouter, latidos: readHeartbeats,
    mapa: (map) => llamar(mercadoMapa, { map }),
    ...deps,
  };
  const envio = { env: d.env, sql: d.sql, fetchImpl: d.fetchImpl, seco };
  const out = { saldo: null, crons: null, movimientos: null, alertas: [], errores: [] };
  if (!seco) await ensureAlertasSchema(d.sql);

  // 1. Saldo de OpenRouter. Si la alerta de hoy ya salió, ni se consulta.
  try {
    const clave = `saldo-openrouter:${fechaMonterrey(ahora)}`;
    const ya = seco ? [] : await d.sql(`select 1 as x from alertas_enviadas where clave = $1 and enviada_at is not null`, [clave]);
    if (ya.length) out.saldo = { ya_avisado_hoy: true };
    else {
      const estado = estadoSaldo(await d.leerSaldo({ now: ahora }), pisoSaldo(d.env));
      out.saldo = { usd: estado.usd, piso: estado.piso, bajo: estado.bajo, ...(estado.error ? { error: estado.error } : {}) };
      const a = alertaSaldo(estado, ahora);
      if (a) out.alertas.push(await enviarAlerta(a, envio));
    }
  } catch (e) { out.errores.push('saldo: ' + sinToken((e && e.message) || e)); }

  // 2. Crons en falla. Los que se recuperaron se olvidan, para que la
  //    próxima falla vuelva a avisar.
  try {
    const fallas = cronsEnFalla({ expected: EXPECTED, beats: await d.latidos(), ahora });
    out.crons = { en_falla: fallas.map((f) => ({ job: f.job, causa: f.causa })) };
    const alertas = fallas.map(alertaCron);
    if (!seco) {
      out.crons.recuperados = await cerrarEpisodiosDeCron(alertas.map((a) => a.clave), { sql: d.sql });
    }
    for (const a of alertas) out.alertas.push(await enviarAlerta(a, envio));
  } catch (e) { out.errores.push('crons: ' + sinToken((e && e.message) || e)); }

  // 3. Movimientos de más de 30% en 1D, en los dos mapas.
  try {
    const umbral = umbralMovimiento(d.env);
    out.movimientos = { umbral_pct: umbral, mercados: {} };
    for (const map of ['us', 'mx']) {
      const mapa = await d.mapa(map);
      if (mapa.error) { out.errores.push(`mapa ${map}: ${mapa.error}`); continue; }
      const movs = movimientosFuertes(mapa, { umbral });
      out.movimientos.mercados[map] = { ultimo_cierre: mapa.ultimo_cierre, emisoras: movs.map((m) => `${m.symbol} ${m.cambio_pct}%`) };
      for (const m of movs) out.alertas.push(await enviarAlerta(alertaMovimiento(m, { umbral }), envio));
    }
  } catch (e) { out.errores.push('movimientos: ' + sinToken((e && e.message) || e)); }

  out.enviadas = out.alertas.filter((a) => a.enviada).length;
  out.repetidas = out.alertas.filter((a) => a.motivo === 'repetida').length;
  for (const a of out.alertas) if (a.motivo === 'error') out.errores.push(`envío ${a.clave}: ${a.error}`);
  out.ok = out.errores.length === 0;
  return out;
}

// ─────────────────────────── resumen ───────────────────────────
export async function jobResumen({ seco = false, ahora = new Date(), deps = {} } = {}) {
  const d = {
    sql, env: process.env, fetchImpl: fetch,
    liga: () => llamar(leaderboard, {}),
    cobertura: () => llamar(stockTracker, { job: 'cobertura' }),
    ...deps,
  };
  const [liga, cobertura] = await Promise.all([d.liga(), d.cobertura()]);
  const alerta = alertaResumen({ liga, cobertura, ahora });
  const r = await enviarAlerta(alerta, { env: d.env, sql: d.sql, fetchImpl: d.fetchImpl, seco });
  const errores = [];
  if (liga.error) errores.push('liga: ' + liga.error);
  if (cobertura.error) errores.push('form4: ' + cobertura.error);
  if (r.motivo === 'error') errores.push('envío: ' + r.error);
  return { ok: errores.length === 0, alerta: r, errores };
}

// ─────────────────────────── chat-id ───────────────────────────
export async function jobChatId({ usuario = null, deps = {} } = {}) {
  const d = { sql, env: process.env, fetchImpl: fetch, ...deps };
  const updates = await telegram('getUpdates', { allowed_updates: ['message'], limit: 100 }, { env: d.env, fetchImpl: d.fetchImpl });
  const eleccion = elegirChat(chatsDeUpdates(updates), { usuario });
  if (!eleccion.ok) return { ok: false, guardado: false, motivo: eleccion.motivo, candidatos: eleccion.candidatos };
  await guardarChatId(eleccion.chat.id, { sql: d.sql });
  const enEnv = String(d.env.TELEGRAM_CHAT_ID || '').trim();
  return {
    ok: true, guardado: true,
    donde: 'tabla alertas_config, clave TELEGRAM_CHAT_ID',
    chat: enmascara(eleccion.chat.id), nombre: eleccion.chat.nombre, usuario: eleccion.chat.usuario,
    ...(enEnv && enEnv !== String(eleccion.chat.id)
      ? { aviso: 'OJO: la env var TELEGRAM_CHAT_ID existe con OTRO valor, y la env var gana. Borrala o corregila en Vercel.' }
      : {}),
  };
}

async function jobEstado() {
  const config = await estadoDeConfig({});
  let ultimas = [];
  try {
    await ensureAlertasSchema();
    ultimas = await sql(
      `select clave, tipo, reclamada_at, enviada_at, intentos, ultimo_error
         from alertas_enviadas order by reclamada_at desc limit 20`
    );
  } catch (e) { config.error_db = String((e && e.message) || e); }
  return { ...config, ultimas };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Método no soportado.' });

  const auth = checkLecturaAuth(req);
  if (auth.abierto) {
    return res.status(503).json({ error: 'Falta CRON_SECRET o ARENA_ADMIN_KEY: /api/alertas no corre sin compuerta.' });
  }
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const job = String(q.job || '').toLowerCase();
  const seco = q.seco === '1' || q.seco === 'true';

  try {
    if (job === 'vigia') {
      const out = await jobVigia({ seco });
      if (!seco) await beat('alertas:vigia', out.ok ? 'ok' : 'error', { enviadas: out.enviadas, repetidas: out.repetidas, ...(out.errores.length ? { error: out.errores.join(' · ').slice(0, 400) } : {}) });
      // Un job que falla contesta 5xx: un 200 con errores adentro es un cron verde que miente.
      return res.status(out.ok ? 200 : 500).json(out);
    }
    if (job === 'resumen') {
      const out = await jobResumen({ seco });
      // Liga o Form 4 ilegibles NO son falla del cron si el resumen salió
      // diciéndolo: la falla del cron es no poder mandar.
      const mando = out.alerta.enviada || out.alerta.motivo === 'repetida' || out.alerta.motivo === 'seco';
      if (!seco) await beat('alertas:resumen', mando ? 'ok' : 'error', { motivo: out.alerta.motivo || 'enviada', ...(out.errores.length ? { error: out.errores.join(' · ').slice(0, 400) } : {}) });
      return res.status(mando ? 200 : 500).json(out);
    }
    if (job === 'chat-id') {
      const out = await jobChatId({ usuario: q.usuario || null });
      return res.status(out.ok ? 200 : 409).json(out);
    }
    if (job === 'prueba') {
      const r = await enviarAlerta(alertaDePrueba(new Date(), process.env.VERCEL_ENV || null), {});
      return res.status(r.enviada ? 200 : 502).json(r);
    }
    if (job === 'estado') return res.status(200).json(await jobEstado());
    return res.status(400).json({ error: 'job debe ser vigia | resumen | chat-id | prueba | estado' });
  } catch (e) {
    const msg = sinToken((e && e.message) || e, process.env.TELEGRAM_BOT_TOKEN);
    if (job === 'vigia' || job === 'resumen') await beat('alertas:' + job, 'error', { error: msg.slice(0, 400) });
    return res.status(500).json({ error: 'alertas: ' + msg });
  }
}
