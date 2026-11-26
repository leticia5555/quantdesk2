// ═══════════════════════════════════════════════════════════════════════
// /api/alertas — las alertas del mercado que QuantDesk le manda a Lety por
// Telegram. Horas de Monterrey, sólo días en que abre el mercado de EE.UU.
//
//   ?job=manana    8:00   futuros del S&P 500 y el Nasdaq + calendario de hoy
//   ?job=cierre    15:15  cómo cerraron, las 3 que más subieron y bajaron,
//                         mejor y peor sector
//   ?job=vispera   15:30  aviso corto si la próxima sesión trae Fed,
//                         inflación o reporte de empleo
//   ?job=acciones  cada 10 min, 6:00–17:50: SPCX, NVDA, SMMT y ANT — si se
//                         mueven más de 5%, si sale una noticia o un aviso
//                         oficial, o si un insider compra o vende
//
//   ?job=muestra   manda UN EJEMPLO de cada alerta (marcado como ejemplo; no
//                  cuenta para el candado de repetidos). &tipo= para una sola.
//   ?job=chat-id   saca el chat_id con getUpdates y lo guarda
//   ?job=estado    qué está configurado y qué se mandó últimamente
//
// ── LAS TRES REGLAS ──────────────────────────────────────────────────
//   · NUNCA DOS VECES: `enviaUnaVez` APARTA la clave en `alertas_enviadas`
//     (insert … on conflict do nothing) ANTES de mandar. Si dos corridas
//     chocan, sólo una consigue la fila. Si el envío falla, la fila queda
//     marcada `fallo` y la siguiente corrida lo vuelve a intentar.
//   · NADA VACÍO: los `texto*` devuelven null sin datos y eso NO se manda.
//   · SIEMPRE CON LINK: lo pone `_lib/alertas.js` en cada texto.
//
// Monterrey no cambia de horario y Vercel agenda en UTC, así que los crons son
// fijos: 8:00 = 14:00 UTC y 15:15 = 21:15 UTC todo el año. Lo que SÍ se mueve
// es Nueva York: de marzo a noviembre el mercado abre 7:30 y cierra 14:00 de
// Monterrey, así que en verano el mensaje de las 8:00 llega con el mercado ya
// abierto (y lo dice).
//
// Un feriado no se adivina: se le pregunta al calendario de Alpaca. Si hoy no
// hay sesión, el job late `skipped` y no manda nada.
//
// AUTH: `Authorization: Bearer <CRON_SECRET>` (el cron de Vercel) o la llave de
// admin (`x-admin-key`, `?key=`). Sin ninguna de las dos configurada → 503:
// este endpoint manda mensajes, no puede quedar abierto.
//
// ENV VARS: TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID (opc; si falta se lee de
//   Neon) · ALERTAS_ENABLED (opc, `0` apaga) · CRON_SECRET · ARENA_ADMIN_KEY ·
//   DATABASE_URL · ALPACA_PAPER_KEY/SECRET · FINNHUB_API_KEY · PUBLIC_BASE_URL
// ═══════════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { beat } from './_lib/heartbeat.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import {
  mandaMensaje, resuelveChatId, descubreChatId, tokenDeEnv, sinToken,
} from './_lib/telegram.js';
import {
  MIS_ACCIONES, fechaMonterrey,
  textoManana, claveManana,
  textoCierre, claveCierre, eligeMovimientos, eligeSectores,
  movimientoDelDia, textoMovimiento, claveMovimiento,
  resumenesDeInsider, textoInsider, claveInsider,
  textoNoticia, claveNoticia, texto8K, clave8K,
  eventosDeVispera, textoVispera, claveVispera, categoriaDeEvento,
} from './_lib/alertas.js';
import {
  FUTUROS, INDICES, ETFS_DE_SECTOR, cotizaYahoo, sesionDe, fotos, universoGrande,
  calendarioMacro, reportesDe, insidersRecientes, noticiasRecientes, avisosRecientes,
} from './_lib/alertas-fuentes.js';

const SIMBOLOS = MIS_ACCIONES.map((a) => a.symbol);
const MAX_NOTICIAS_POR_CORRIDA = 3;
const sumaDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dicho = (e) => sinToken(String((e && e.message) || e), tokenDeEnv());

// ── EL CANDADO DE REPETIDOS ──────────────────────────────────────────
// Una fila por alerta. `estado` es `apartada` (se está mandando), `enviada` o
// `fallo`. No se borra nunca: una alerta que falló se queda con su marca y la
// siguiente corrida la vuelve a apartar. Una fila que se quedó en `apartada`
// (la función murió a medio envío) NO se reintenta: ante la duda de si salió,
// gana "nunca dos veces".
export const SCHEMA_ALERTAS = `create table if not exists alertas_enviadas (
   clave       text primary key,
   tipo        text not null,
   estado      text not null default 'apartada',
   intentos    int not null default 1,
   enviada_en  timestamptz not null default now(),
   texto       text
 )`;
let lista = false;
async function ensureAlertas() {
  if (lista) return;
  await sql(SCHEMA_ALERTAS);
  lista = true;
}

const candadoNeon = {
  // Sólo UNA corrida consigue la fila: la que la inserta, o la que la retoma
  // de un `fallo`. Las demás reciben cero filas.
  async aparta(clave, tipo, texto) {
    await ensureAlertas();
    const r = await sql(
      `insert into alertas_enviadas (clave, tipo, texto) values ($1, $2, $3)
       on conflict (clave) do update
         set estado = 'apartada', intentos = alertas_enviadas.intentos + 1,
             enviada_en = now(), texto = excluded.texto
         where alertas_enviadas.estado = 'fallo'
       returning clave`, [clave, tipo, texto]);
    return r.length > 0;
  },
  async confirma(clave) {
    await sql(`update alertas_enviadas set estado = 'enviada', enviada_en = now() where clave = $1`, [clave]);
  },
  async suelta(clave) {
    await sql(`update alertas_enviadas set estado = 'fallo' where clave = $1`, [clave]);
  },
};

/**
 * Manda `texto` SÓLO si esa `clave` no se mandó antes.
 * Devuelve { clave, estado }: enviada | ya_enviada | sin_contenido | error.
 */
export async function enviaUnaVez({ clave, tipo, texto }, { candado = candadoNeon, manda = mandaMensaje } = {}) {
  if (!texto || !String(texto).trim()) return { clave, estado: 'sin_contenido' };
  if (!(await candado.aparta(clave, tipo, texto))) return { clave, estado: 'ya_enviada' };
  try {
    await manda(texto);
    if (candado.confirma) await candado.confirma(clave).catch(() => {});
    return { clave, estado: 'enviada' };
  } catch (e) {
    // No salió: se suelta la clave para que la próxima corrida lo intente.
    await candado.suelta(clave).catch(() => {});
    return { clave, estado: 'error', error: dicho(e) };
  }
}

// ── LOS DATOS DE CADA ALERTA (los usan el job real y la muestra) ─────
async function datosManana(sesion, hoy) {
  const [futuros, macro, reportes] = await Promise.all([
    cotizaYahoo(FUTUROS),
    calendarioMacro(hoy, hoy).catch(() => []),
    reportesDe(hoy).catch(() => []),
  ]);
  return {
    fecha: hoy, futuros, macro, reportes,
    apertura: sesion.abre_hora ? { hora: sesion.abre_hora, ya_abrio: sesion.ya_abrio } : null,
  };
}

async function datosCierre(sesionFecha) {
  const universo = await universoGrande();
  const [snaps, indicesCrudos] = await Promise.all([
    fotos([...universo.map((u) => u.symbol), ...ETFS_DE_SECTOR, 'SPY', 'QQQ']),
    cotizaYahoo(INDICES),
  ]);
  // El índice tiene que ser DE ESTA SESIÓN. Si Yahoo todavía trae el de ayer,
  // o no contestó, se usa el ETF que lo replica y se dice que es el ETF.
  let indices = indicesCrudos.filter((i) => i.fecha === sesionFecha);
  if (indices.length < INDICES.length) {
    indices = [['SPY', 'S&P 500 (ETF SPY)'], ['QQQ', 'Nasdaq 100 (ETF QQQ)']].map(([sym, nombre]) => {
      const s = snaps[sym];
      if (!s || s.day_fecha !== sesionFecha || !(s.prev_close > 0) || !(s.day_close > 0)) return null;
      return { nombre, precio: s.day_close, pct: ((s.day_close - s.prev_close) / s.prev_close) * 100 };
    }).filter(Boolean);
  }
  const mov = eligeMovimientos(universo, snaps, sesionFecha, 3);
  return {
    fecha: sesionFecha, indices, suben: mov.suben, bajan: mov.bajan,
    sectores: eligeSectores(snaps, sesionFecha),
    medicion: { universo: universo.length, al_dia: mov.al_dia, atrasadas: mov.atrasadas },
    snaps,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LOS JOBS
// ═══════════════════════════════════════════════════════════════════════
async function jobManana(ahora) {
  const sesion = await sesionDe(ahora);
  if (!sesion.habil) return { status: 'skipped', motivo: 'hoy no abre el mercado', sesion };
  const hoy = sesion.hoy;
  const d = await datosManana(sesion, hoy);
  const r = await enviaUnaVez({ clave: claveManana(hoy), tipo: 'manana', texto: textoManana(d) });
  return { status: r.estado === 'error' ? 'error' : 'ok', envios: [r], futuros: d.futuros.length, macro: d.macro.length, reportes: d.reportes.length };
}

async function jobCierre(ahora) {
  const sesion = await sesionDe(ahora);
  if (!sesion.habil) return { status: 'skipped', motivo: 'hoy no abre el mercado', sesion };
  if (!sesion.ya_cerro) return { status: 'skipped', motivo: 'el mercado todavía no cierra', sesion };
  const d = await datosCierre(sesion.hoy);
  const r = await enviaUnaVez({ clave: claveCierre(sesion.hoy), tipo: 'cierre', texto: textoCierre(d) });
  return { status: r.estado === 'error' ? 'error' : 'ok', envios: [r], indices: d.indices.length, medicion: d.medicion };
}

async function jobVispera(ahora) {
  const sesion = await sesionDe(ahora);
  if (!sesion.habil) return { status: 'skipped', motivo: 'hoy no abre el mercado', sesion };
  if (!sesion.proxima) return { status: 'error', motivo: 'el calendario no dijo cuál es la próxima sesión' };
  const hoy = sesion.hoy;
  const eventos = await calendarioMacro(sumaDias(hoy, 1), sesion.proxima);
  const envios = [];
  for (const v of eventosDeVispera(eventos, hoy, sesion.proxima)) {
    envios.push(await enviaUnaVez({
      clave: claveVispera(v.categoria, v.fecha), tipo: 'vispera', texto: textoVispera({ ...v, hoy }),
    }));
  }
  return { status: envios.some((e) => e.estado === 'error') ? 'error' : 'ok', envios, proxima_sesion: sesion.proxima };
}

async function jobAcciones(ahora) {
  const sesion = await sesionDe(ahora);
  if (!sesion.habil) return { status: 'skipped', motivo: 'hoy no abre el mercado', sesion };
  const hoy = sesion.hoy;
  const envios = [];
  const errores = [];
  const intenta = async (nombre, fn) => { try { await fn(); } catch (e) { errores.push({ fuente: nombre, error: dicho(e) }); } };

  await intenta('precios', async () => {
    if (!sesion.ya_abrio) return;
    const snaps = await fotos(SIMBOLOS);
    for (const symbol of SIMBOLOS) {
      const m = movimientoDelDia(symbol, snaps[symbol], { sesion: hoy, abierto: sesion.abierto });
      if (m) envios.push(await enviaUnaVez({ clave: claveMovimiento(symbol, hoy, m.sube), tipo: 'movimiento', texto: textoMovimiento(m) }));
    }
  });
  await intenta('insiders', async () => {
    for (const r of resumenesDeInsider(await insidersRecientes(SIMBOLOS, 5))) {
      envios.push(await enviaUnaVez({ clave: claveInsider(r.accession, r.tipo), tipo: 'insider', texto: textoInsider(r) }));
    }
  });
  await intenta('noticias', async () => {
    let nuevas = 0;
    for (const n of await noticiasRecientes(MIS_ACCIONES, 18)) {
      if (nuevas >= MAX_NOTICIAS_POR_CORRIDA) break;
      const r = await enviaUnaVez({
        clave: claveNoticia(n.symbol, n.titulo_norm), tipo: 'noticia',
        texto: textoNoticia({ symbol: n.symbol, titular: n.titular, fuente: n.fuente_nombre, url: n.url }),
      });
      if (r.estado === 'enviada') nuevas++;
      envios.push(r);
    }
  });
  await intenta('avisos_sec', async () => {
    const { avisos, fallas } = await avisosRecientes(SIMBOLOS, { desde: sumaDias(hoy, -3) });
    for (const f of fallas) errores.push({ fuente: `avisos_sec:${f.symbol}`, error: f.motivo });
    for (const a of avisos) envios.push(await enviaUnaVez({ clave: clave8K(a.accession), tipo: 'aviso_sec', texto: texto8K(a) }));
  });

  const cuenta = {};
  for (const e of envios) cuenta[e.estado] = (cuenta[e.estado] || 0) + 1;
  return {
    status: envios.some((e) => e.estado === 'error') || errores.length >= 4 ? 'error' : 'ok',
    envios: envios.filter((e) => e.estado !== 'ya_enviada'), cuenta, errores,
    sesion: { hoy, abierto: sesion.abierto },
  };
}

// ── LA MUESTRA: un ejemplo de cada alerta ────────────────────────────
// Usa datos REALES siempre que existen. Cuando hoy no hay con qué (nadie se
// movió 5%, no hubo insider), arma el ejemplo con datos inventados Y LO DICE
// arriba del mensaje: una muestra que se hace pasar por alerta real sería la
// primera alerta falsa del sistema.
const REAL = '🧪 <i>Ejemplo · con datos reales</i>\n\n';
const INVENTADO = '🧪 <i>Ejemplo · datos inventados, sólo para ver el formato</i>\n\n';

async function jobMuestra(ahora, tipo) {
  const hoy = fechaMonterrey(ahora);
  const sesion = await sesionDe(ahora).catch(() => ({ hoy, habil: false, proxima: null, abre_hora: null, ya_abrio: false }));
  const piezas = [];
  const pon = (nombre, real, texto) => { if (texto) piezas.push({ nombre, real, texto: (real ? REAL : INVENTADO) + texto }); };
  const quiere = (t) => !tipo || tipo === t;
  const errores = [];
  const intenta = async (nombre, fn) => { try { await fn(); } catch (e) { errores.push({ muestra: nombre, error: dicho(e) }); } };

  if (quiere('manana')) await intenta('manana', async () => {
    const d = await datosManana(sesion, hoy);
    let real = true;
    if (!d.macro.length && !d.reportes.length) {
      // Hoy no hay nada en el calendario: se enseña con el próximo evento real.
      const prox = (await calendarioMacro(hoy, sumaDias(hoy, 45))).slice(0, 1);
      d.macro = prox; d.reportes = [{ ticker: 'NVDA', time: 'AMC' }]; real = false;
    }
    if (!d.apertura) d.apertura = { hora: '8:30', ya_abrio: false };
    pon('manana', real, textoManana(d));
  });

  if (quiere('cierre')) await intenta('cierre', async () => {
    // La última sesión que Alpaca conoce, sea hoy o la anterior.
    const guia = await fotos(['SPY']);
    const ultima = guia.SPY && guia.SPY.day_fecha;
    if (!ultima) throw new Error('Alpaca no devolvió la barra diaria de SPY');
    pon('cierre', true, textoCierre(await datosCierre(ultima)));
  });

  if (quiere('acciones')) {
    await intenta('movimiento', async () => {
      const snaps = await fotos(SIMBOLOS);
      const reales = SIMBOLOS.map((s) => movimientoDelDia(s, snaps[s], { sesion: snaps[s] && snaps[s].day_fecha, abierto: false })).filter(Boolean);
      if (reales.length) return pon('movimiento', true, textoMovimiento(reales[0]));
      const previo = (snaps.NVDA && snaps.NVDA.prev_close) || 150;
      pon('movimiento', false, textoMovimiento({ symbol: 'NVDA', pct: 6.2, precio: previo * 1.062, previo, abierto: true, sube: true }));
    });
    await intenta('insider', async () => {
      const reales = resumenesDeInsider(await insidersRecientes(SIMBOLOS, 120));
      if (reales.length) return pon('insider', true, textoInsider(reales[reales.length - 1]));
      pon('insider', false, textoInsider({
        symbol: 'SMMT', tipo: 'compra', quien: 'Nombre del directivo', cargo: 'Director general', acciones: 50000,
        valor: 1250000, precio: 25, fecha: sumaDias(hoy, -1), programada: false, link: null,
      }));
    });
    await intenta('noticia', async () => {
      const reales = await noticiasRecientes(MIS_ACCIONES, 24 * 14);
      const n = reales[reales.length - 1];
      if (n) return pon('noticia', true, textoNoticia({ symbol: n.symbol, titular: n.titular, fuente: n.fuente_nombre, url: n.url }));
      pon('noticia', false, textoNoticia({ symbol: 'NVDA', titular: 'Nvidia presenta su nueva generación de chips para inteligencia artificial', fuente: 'Ejemplo' }));
    });
    await intenta('aviso_sec', async () => {
      const { avisos } = await avisosRecientes(SIMBOLOS, { desde: sumaDias(hoy, -120) });
      const a = avisos.sort((x, y) => (x.fecha < y.fecha ? 1 : -1))[0];
      if (a) return pon('aviso_sec', true, texto8K(a));
      pon('aviso_sec', false, texto8K({ symbol: 'NVDA', items: ['2.02'], url: null }));
    });
  }

  if (quiere('vispera')) await intenta('vispera', async () => {
    // El próximo evento real de los tres, contado como si fuera mañana.
    const prox = (await calendarioMacro(sumaDias(hoy, 1), sumaDias(hoy, 120))).find((e) => categoriaDeEvento(e));
    if (!prox) return;
    const fecha = String(prox.event_date).slice(0, 10);
    pon('vispera', true, textoVispera({ categoria: categoriaDeEvento(prox), fecha, evento: prox, hoy: sumaDias(fecha, -1) }));
  });

  const envios = [];
  for (const p of piezas) {
    try {
      await mandaMensaje(p.texto);
      envios.push({ muestra: p.nombre, datos: p.real ? 'reales' : 'inventados', estado: 'enviada' });
    } catch (e) {
      envios.push({ muestra: p.nombre, estado: 'error', error: dicho(e) });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const fallo = envios.some((e) => e.estado === 'error') || (!envios.length && errores.length > 0);
  return { status: fallo ? 'error' : 'ok', envios, errores };
}

async function jobEstado() {
  const chat = await resuelveChatId().catch((e) => ({ chatId: null, fuente: null, error: dicho(e) }));
  await ensureAlertas();
  const ultimas = await sql(
    `select clave, tipo, estado, intentos, enviada_en from alertas_enviadas order by enviada_en desc limit 25`);
  return {
    status: 'ok',
    // Del token sólo se dice si está. Del chat, de dónde salió.
    token_configurado: !!tokenDeEnv(),
    chat_configurado: !!chat.chatId,
    chat_fuente: chat.fuente,
    apagado: process.env.ALERTAS_ENABLED === '0',
    acciones: SIMBOLOS,
    ultimas,
  };
}

// ═══════════════════════════════════════════════════════════════════════
const JOBS = { manana: jobManana, cierre: jobCierre, vispera: jobVispera, acciones: jobAcciones };
const una = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export function autoriza(req, env = process.env) {
  const cron = String(env.CRON_SECRET || '').trim();
  const admin = String(env.ARENA_ADMIN_KEY || '').trim();
  if (!cron && !admin) {
    return { ok: false, status: 503, body: { error: 'Faltan CRON_SECRET y ARENA_ADMIN_KEY: este endpoint manda mensajes y no queda abierto.' } };
  }
  const auth = String((req.headers && req.headers.authorization) || '').trim();
  if (cron && auth === `Bearer ${cron}`) return { ok: true, via: 'CRON_SECRET' };
  if (admin) {
    const a = checkAdminAuth(req, admin);
    if (a.ok) return { ok: true, via: 'ARENA_ADMIN_KEY' };
  }
  return { ok: false, status: 401, body: { error: 'No autorizado.', acepta: ['Authorization: Bearer <CRON_SECRET>', 'x-admin-key: <ARENA_ADMIN_KEY>', '?key=<ARENA_ADMIN_KEY>'] } };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const job = String(una(q.job) || '').trim();

  const auth = autoriza(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const conocidos = [...Object.keys(JOBS), 'muestra', 'chat-id', 'estado'];
  if (!conocidos.includes(job)) return res.status(400).json({ error: 'Falta ?job=', jobs: conocidos });

  const ahora = new Date();
  try {
    if (job === 'estado') return res.status(200).json({ job, ...(await jobEstado()), ms: Date.now() - t0 });

    if (!tokenDeEnv()) {
      if (JOBS[job]) await beat(`alertas:${job}`, 'error', { motivo: 'falta TELEGRAM_BOT_TOKEN' });
      return res.status(503).json({ job, error: 'Falta TELEGRAM_BOT_TOKEN en las env vars de ESTE deploy (Production y Preview se configuran aparte en Vercel).' });
    }

    if (job === 'chat-id') {
      const out = await descubreChatId({ elegido: una(q.chat_id) || null });
      return res.status(out.ok ? 200 : 409).json({ job, ...out, ms: Date.now() - t0 });
    }

    // De acá para abajo se MANDA: hace falta saber a quién. Si todavía no hay
    // chat guardado, se intenta sacar una vez con getUpdates.
    let chat = await resuelveChatId();
    if (!chat.chatId) {
      const hallado = await descubreChatId().catch((e) => ({ ok: false, motivo: dicho(e) }));
      if (hallado.ok) chat = { chatId: hallado.chat_id, fuente: 'getUpdates' };
      else {
        if (JOBS[job]) await beat(`alertas:${job}`, 'error', { motivo: 'falta TELEGRAM_CHAT_ID' });
        return res.status(503).json({ job, error: 'Falta TELEGRAM_CHAT_ID y no se pudo sacar con getUpdates.', detalle: hallado.motivo, chats: hallado.chats });
      }
    }

    if (job === 'muestra') {
      const out = await jobMuestra(ahora, String(una(q.tipo) || '').trim() || null);
      return res.status(out.status === 'error' ? 502 : 200).json({ job, ...out, ms: Date.now() - t0 });
    }

    if (process.env.ALERTAS_ENABLED === '0') {
      await beat(`alertas:${job}`, 'disabled', { motivo: 'ALERTAS_ENABLED=0' });
      return res.status(200).json({ job, disabled: true, motivo: 'ALERTAS_ENABLED=0' });
    }

    const out = await JOBS[job](ahora);
    await beat(`alertas:${job}`, out.status, {
      motivo: out.motivo || null,
      enviadas: (out.envios || []).filter((e) => e.estado === 'enviada').length,
      errores: (out.errores || []).length + (out.envios || []).filter((e) => e.estado === 'error').length,
    });
    // Un job que falla responde 5xx: con 200 el cron lo cuenta como corrida buena.
    return res.status(out.status === 'error' ? 502 : 200).json({ job, ...out, ms: Date.now() - t0 });
  } catch (e) {
    if (JOBS[job]) await beat(`alertas:${job}`, 'error', { error: dicho(e).slice(0, 300) });
    return res.status(500).json({ job, error: dicho(e), ms: Date.now() - t0 });
  }
}
