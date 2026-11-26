// ═══════════════════════════════════════════════════════════════════
// api/_lib/alertas.js — EL módulo de alertas a Telegram. Uno solo.
//
// Todo lo que sale hacia Telegram pasa por `enviarAlerta()`. No hay otro
// `fetch` a api.telegram.org en el repo, y no debe haberlo: el día que haya
// dos, uno va a mandar sin deduplicar y el otro va a imprimir el token en un
// error.
//
// LAS CUATRO ALERTAS (los textos se arman acá, en funciones puras):
//   1. saldo de OpenRouter bajo el piso ......... máximo UNA por día
//   2. un cron que falla ........................ UNA por episodio de falla
//   3. una emisora que se mueve > 30% en 1D ..... UNA por emisora y cierre
//   4. resumen diario, 20:00 de Monterrey ....... UNO por día
//
// ── "SIN REPETIR" ES UNA TABLA, NO UNA PROMESA ──────────────────────
// Cada alerta tiene una CLAVE. Antes de mandar se RECLAMA la clave con un
// insert en `alertas_enviadas`; si la fila ya existe, no se manda. Dos
// lambdas que corren a la vez no pueden mandar la misma: el insert de una
// de las dos no devuelve fila. Si Telegram falla, la fila queda sin
// `enviada_at` y el siguiente tick la vuelve a reclamar (pasados dos
// minutos, para no pisar a una lambda que todavía está mandando).
//
// ── EL TOKEN NO SE IMPRIME ──────────────────────────────────────────
// Telegram lleva el token EN LA URL. Por eso ningún error de este módulo
// incluye la URL, y todo texto de error pasa por `sinToken()` antes de
// salir. `estadoDeConfig()` dice si el token existe, nunca cuál es.
//
// ENV VARS: TELEGRAM_BOT_TOKEN (obligatoria para mandar)
//           TELEGRAM_CHAT_ID   (opcional: si no está, se usa el que guardó
//                               `?job=chat-id` en la tabla `alertas_config`)
//           ALERTA_MOVIMIENTO_PCT (opcional, default 30)
// ═══════════════════════════════════════════════════════════════════

import { sql as sqlNeon } from './db.js';

export const UMBRAL_MOVIMIENTO_PCT = 30;
export const TZ_ALERTAS = 'America/Monterrey';
export const CLAVE_CHAT_ID = 'TELEGRAM_CHAT_ID';
// Un reclamo sin enviar más viejo que esto se considera abandonado (la lambda
// murió entre el insert y Telegram) y se puede volver a reclamar.
export const RECLAMO_VENCE_MIN = 2;
// Telegram corta en 4096 caracteres; se deja margen.
const TOPE_TEXTO = 3900;
const TIMEOUT_MS = 10000;

export const SCHEMA_ALERTAS = [
  `create table if not exists alertas_enviadas (
     clave          text primary key,
     tipo           text not null,
     texto          text,
     reclamada_at   timestamptz not null default now(),
     enviada_at     timestamptz,
     intentos       int not null default 1,
     ultimo_error   text,
     message_id     bigint
   )`,
  `create table if not exists alertas_config (
     clave       text primary key,
     valor       text,
     updated_at  timestamptz not null default now()
   )`,
];

let listo = false;
export async function ensureAlertasSchema(sql = sqlNeon) {
  if (listo && sql === sqlNeon) return;
  for (const q of SCHEMA_ALERTAS) await sql(q);
  if (sql === sqlNeon) listo = true;
}

// ─────────────────────────── fechas ───────────────────────────

/** 'YYYY-MM-DD' del día en Monterrey. Es la fecha de las claves diarias. */
export function fechaMonterrey(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_ALERTAS, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

/** "miércoles 25 de noviembre" — para el encabezado del resumen. */
export function fechaLarga(ahora = new Date()) {
  return new Intl.DateTimeFormat('es-MX', { timeZone: TZ_ALERTAS, weekday: 'long', day: 'numeric', month: 'long' }).format(ahora);
}

// ─────────────────────────── Telegram ───────────────────────────

/** Borra el token de cualquier texto. Todo error pasa por acá antes de salir. */
export function sinToken(texto, token) {
  let s = String(texto == null ? '' : texto);
  if (token) s = s.split(token).join('<token>');
  // Por si el token llegó con otra forma (espacios, otra env): el patrón de
  // un token de bot es <dígitos>:<35 caracteres>. Sin `\b` adelante: en la
  // URL va pegado a "bot", y entre dos letras no hay borde de palabra.
  return s.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '<token>');
}

function tokenDe(env) {
  return String((env && env.TELEGRAM_BOT_TOKEN) || '').trim();
}

/**
 * Una llamada a la API del bot. Devuelve `result` o lanza un Error cuyo
 * mensaje NUNCA trae la URL ni el token.
 */
export async function telegram(metodo, cuerpo = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const token = tokenDe(env);
  if (!token) throw new Error('falta TELEGRAM_BOT_TOKEN en las env vars de este deploy');
  let r, data;
  try {
    r = await fetchImpl(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await r.json().catch(() => null);
  } catch (e) {
    throw new Error(sinToken(`Telegram ${metodo}: ${(e && e.message) || e}`, token));
  }
  if (!r.ok || !data || data.ok !== true) {
    const desc = (data && data.description) || `HTTP ${r.status}`;
    throw new Error(sinToken(`Telegram ${metodo}: ${desc}`, token));
  }
  return data.result;
}

// ─────────────────────────── el chat ───────────────────────────

/** A quién se le manda: la env var gana; si no, lo que guardó `?job=chat-id`. */
export async function chatIdDestino({ env = process.env, sql = sqlNeon } = {}) {
  const deEnv = String((env && env.TELEGRAM_CHAT_ID) || '').trim();
  if (deEnv) return { chat_id: deEnv, fuente: 'env TELEGRAM_CHAT_ID' };
  await ensureAlertasSchema(sql);
  const filas = await sql(`select valor from alertas_config where clave = $1`, [CLAVE_CHAT_ID]);
  const v = filas[0] && String(filas[0].valor || '').trim();
  return v ? { chat_id: v, fuente: 'tabla alertas_config' } : { chat_id: null, fuente: null };
}

export async function guardarChatId(chatId, { sql = sqlNeon } = {}) {
  await ensureAlertasSchema(sql);
  await sql(
    `insert into alertas_config (clave, valor, updated_at) values ($1, $2, now())
     on conflict (clave) do update set valor = excluded.valor, updated_at = now()`,
    [CLAVE_CHAT_ID, String(chatId)]
  );
}

/** "…1234": para confirmar cuál chat es sin publicar el id entero. */
export function enmascara(id) {
  const s = String(id == null ? '' : id);
  return s.length <= 4 ? '…' + s : '…' + s.slice(-4);
}

/**
 * PURA. De la respuesta de getUpdates, los chats PRIVADOS que le escribieron
 * al bot (el más reciente primero). Un grupo o un canal no cuentan: las
 * alertas van a una persona.
 */
export function chatsDeUpdates(updates = []) {
  const porId = new Map();
  for (const u of updates || []) {
    const m = u && (u.message || u.edited_message);
    const c = m && m.chat;
    if (!c || c.type !== 'private' || c.id == null) continue;
    const previo = porId.get(c.id);
    const fecha = Number(m.date) || 0;
    if (!previo || fecha >= previo.fecha) {
      porId.set(c.id, { id: c.id, nombre: c.first_name || null, usuario: c.username || null, fecha });
    }
  }
  return [...porId.values()].sort((a, b) => b.fecha - a.fecha);
}

/**
 * PURA. Elige el chat. Con uno solo no hay nada que elegir. Con varios NO se
 * adivina: cualquiera puede escribirle a un bot, y mandarle las alertas al
 * último que escribió sería regalárselas a un desconocido.
 */
export function elegirChat(chats = [], { usuario = null } = {}) {
  const filtro = String(usuario || '').replace(/^@/, '').trim().toLowerCase();
  const cands = filtro
    ? chats.filter((c) => String(c.usuario || '').toLowerCase() === filtro || String(c.nombre || '').toLowerCase() === filtro)
    : chats;
  if (cands.length === 1) return { ok: true, chat: cands[0] };
  const publicos = chats.map((c) => ({ chat: enmascara(c.id), nombre: c.nombre, usuario: c.usuario }));
  if (!chats.length) {
    return { ok: false, motivo: 'getUpdates no trae ningún mensaje privado. Telegram sólo guarda 24 h: escribile de nuevo al bot (cualquier texto) y repetí este job.', candidatos: [] };
  }
  if (!cands.length) {
    return { ok: false, motivo: `ningún chat coincide con "${usuario}".`, candidatos: publicos };
  }
  return { ok: false, motivo: 'le escribió más de una persona al bot: decí cuál con &usuario=<username o nombre>.', candidatos: publicos };
}

// ─────────────────────────── enviar, sin repetir ───────────────────────────

function recorta(texto) {
  const s = String(texto || '');
  return s.length <= TOPE_TEXTO ? s : s.slice(0, TOPE_TEXTO) + '\n… (recortado)';
}

/**
 * Manda UNA alerta, una sola vez por `clave`.
 *
 *   { enviada: true,  message_id }
 *   { enviada: false, motivo: 'repetida' }          ← ya se mandó (o la está mandando otra lambda)
 *   { enviada: false, motivo: 'error', error }      ← queda sin `enviada_at`: se reintenta
 *   { enviada: false, motivo: 'seco', texto }       ← `seco: true`: no reclama ni manda
 *
 * `clave: null` manda SIN deduplicar (sólo para el mensaje de prueba).
 * Nunca lanza: una alerta que no sale no tumba al job que la disparó.
 */
export async function enviarAlerta({ clave = null, tipo = 'otra', texto }, {
  env = process.env, sql = sqlNeon, fetchImpl = fetch, seco = false,
} = {}) {
  const cuerpoTexto = recorta(texto);
  if (seco) return { enviada: false, motivo: 'seco', clave, tipo, texto: cuerpoTexto };
  const token = tokenDe(env);
  try {
    const { chat_id: chatId } = await chatIdDestino({ env, sql });
    if (!token) throw new Error('falta TELEGRAM_BOT_TOKEN en las env vars de este deploy');
    if (!chatId) throw new Error('no hay chat_id: corré /api/alertas?job=chat-id o poné TELEGRAM_CHAT_ID');

    if (clave) {
      await ensureAlertasSchema(sql);
      const reclamo = await sql(
        `insert into alertas_enviadas (clave, tipo, texto) values ($1, $2, $3)
         on conflict (clave) do update
           set reclamada_at = now(), intentos = alertas_enviadas.intentos + 1, texto = excluded.texto
           where alertas_enviadas.enviada_at is null
             and alertas_enviadas.reclamada_at < now() - interval '${RECLAMO_VENCE_MIN} minutes'
         returning clave`,
        [clave, tipo, cuerpoTexto]
      );
      if (!reclamo.length) return { enviada: false, motivo: 'repetida', clave, tipo };
    }

    let msg;
    try {
      msg = await telegram('sendMessage', {
        chat_id: chatId, text: cuerpoTexto, disable_web_page_preview: true,
      }, { env, fetchImpl });
    } catch (e) {
      if (clave) {
        await sql(`update alertas_enviadas set ultimo_error = $2 where clave = $1`,
          [clave, sinToken((e && e.message) || e, token).slice(0, 500)]).catch(() => {});
      }
      throw e;
    }
    const messageId = msg && msg.message_id != null ? Number(msg.message_id) : null;
    if (clave) {
      await sql(`update alertas_enviadas set enviada_at = now(), message_id = $2, ultimo_error = null where clave = $1`,
        [clave, messageId]).catch(() => {});
    }
    return { enviada: true, clave, tipo, message_id: messageId };
  } catch (e) {
    return { enviada: false, motivo: 'error', clave, tipo, error: sinToken((e && e.message) || e, token) };
  }
}

/**
 * Los episodios de cron que YA TERMINARON se archivan: si el job se recuperó,
 * su clave `cron:<job>` se libera para que la PRÓXIMA falla vuelva a avisar.
 * `enFalla` son las claves que siguen rotas ahora. Devuelve los jobs
 * recuperados.
 *
 * Es un UPDATE y no un borrado a propósito: la fila pasa a `cron-cerrado` con
 * la hora en que se cerró, así queda el historial de cuándo falló cada cron,
 * y este módulo no necesita permiso para borrar nada.
 */
const MARCA_CIERRE = ' · cerrado ';
export async function cerrarEpisodiosDeCron(enFalla = [], { sql = sqlNeon } = {}) {
  await ensureAlertasSchema(sql);
  const filas = await sql(
    `update alertas_enviadas
        set tipo = 'cron-cerrado',
            clave = clave || '${MARCA_CIERRE}' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      where tipo = 'cron'
        and clave not in (select jsonb_array_elements_text($1::jsonb))
      returning clave`,
    [JSON.stringify(enFalla)]
  );
  return filas.map((f) => String(f.clave).split(MARCA_CIERRE)[0].replace(/^cron:/, ''));
}

// ═══════════════════════ LAS CUATRO ALERTAS (puras) ═══════════════════════

const signo = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
const pct = (n, dec = 2) => (n == null || !Number.isFinite(Number(n)) ? 's/d' : `${signo(Number(n))}${Math.abs(Number(n)).toFixed(dec)}%`);
const usd = (n) => `${Number(n) < 0 ? '−' : ''}$${Math.abs(Number(n)).toFixed(2)}`;

// ── 1. Saldo de OpenRouter ──────────────────────────────────────────
// `estado` es lo que devuelve `estadoSaldo()` de openrouter-saldo.js. Una
// lectura fallida (`usd: null`) NO es saldo bajo: no sabemos, y no se alerta.
export function alertaSaldo(estado, ahora = new Date()) {
  if (!estado || estado.usd == null || !estado.bajo) return null;
  return {
    clave: `saldo-openrouter:${fechaMonterrey(ahora)}`,
    tipo: 'saldo',
    texto: [
      '🔴 Saldo de OpenRouter bajo',
      `Quedan ${usd(estado.usd)} (el piso es $${estado.piso}).`,
      'Los agentes de la Liga que corren por OpenRouter abortan cuando la cuenta se queda sin créditos.',
      'Recarga: https://openrouter.ai/settings/credits',
    ].join('\n'),
  };
}

// ── 2. Un cron que falla ────────────────────────────────────────────
// Falla = su último latido dijo `error`, o lleva más de `stale_after_h` sin
// latir. `disabled` y `skipped` son estados configurados, no fallas.
//
// Un job que NUNCA latió no se alerta acá: un cron recién agregado todavía
// no corrió, y avisar "falló" el minuto en que se despliega enseña a ignorar
// el aviso. Ese caso sigue en rojo en /api/cron-status.
export function cronsEnFalla({ expected = [], beats = [], ahora = new Date() } = {}) {
  const porJob = new Map(beats.map((b) => [b.job, b]));
  const out = [];
  for (const e of expected) {
    const b = porJob.get(e.job);
    if (!b || !b.last_run_at) continue;
    const horas = (ahora.getTime() - new Date(b.last_run_at).getTime()) / 3600000;
    const tarde = Number.isFinite(horas) && horas > e.stale_after_h;
    const error = b.last_status === 'error';
    if (!tarde && !error) continue;
    out.push({
      job: e.job, path: e.path, cadencia: e.cadence || e.schedule,
      causa: error ? 'error' : 'sin_latido',
      horas_sin_latir: Number.isFinite(horas) ? +horas.toFixed(1) : null,
      detalle: error ? detalleDeError(b.detail) : null,
    });
  }
  return out;
}

function detalleDeError(detail) {
  if (detail == null) return null;
  const crudo = typeof detail === 'string' ? detail
    : (detail.error || detail.motivo || detail.message || JSON.stringify(detail));
  return sinToken(String(crudo)).slice(0, 300);
}

export function alertaCron(falla) {
  const cabeza = falla.causa === 'error'
    ? `⚠️ Falló el cron ${falla.job}`
    : `⚠️ El cron ${falla.job} dejó de correr`;
  const lineas = [cabeza];
  if (falla.causa === 'error') lineas.push(falla.detalle ? `Error: ${falla.detalle}` : 'Su último latido fue "error", sin detalle.');
  else lineas.push(`Lleva ${falla.horas_sin_latir} h sin latir (cadencia esperada: ${falla.cadencia}).`);
  lineas.push(`Endpoint: ${falla.path}`);
  lineas.push('No vuelvo a avisar de este cron hasta que se recupere y falle otra vez.');
  return { clave: `cron:${falla.job}`, tipo: 'cron', texto: lineas.join('\n') };
}

// ── 3. Una emisora que se mueve más de 30% en 1D ────────────────────
// `mapa` es la respuesta de /api/mercado-mapa (US o MX). 1D = último cierre
// contra el cierre anterior DE LA SERIE, igual que el período 1D del mapa.
//
// DOS GUARDAS, las dos por un caso real:
//   • el último punto de la serie tiene que ser EL último cierre del mapa.
//     Una serie atrasada (PSKY, 2026-11-25: su último punto era de octubre)
//     tiene un "1D" que es de hace un mes — no es noticia de hoy.
//   • entre los dos puntos no puede haber más de 5 días de calendario. Una
//     serie con un hueco mide el cambio de semanas y lo rotularía "1D".
export const MAX_HUECO_DIAS = 5;
const isoDe = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10);

export function movimientosFuertes(mapa, { umbral = UMBRAL_MOVIMIENTO_PCT } = {}) {
  const cierre = mapa && mapa.ultimo_cierre;
  if (!cierre || !Array.isArray(mapa.cuadros)) return [];
  const out = [];
  for (const c of mapa.cuadros) {
    const s = Array.isArray(c.serie) ? c.serie : [];
    if (s.length < 2) continue;
    const ult = s[s.length - 1], ant = s[s.length - 2];
    if (!ult || !ant || !(Number(ant.c) > 0) || !(Number(ult.c) > 0)) continue;
    if (isoDe(ult.t) !== cierre) continue;
    if ((Number(ult.t) - Number(ant.t)) / 86400 > MAX_HUECO_DIAS) continue;
    // Redondeado ANTES de comparar: 13/10 − 1 da 30.000000000000004 en coma
    // flotante, y "más de 30%" no puede depender de eso.
    const cambio = +((Number(ult.c) / Number(ant.c) - 1) * 100).toFixed(2);
    if (Math.abs(cambio) <= umbral) continue;
    out.push({
      mercado: mapa.mapa || mapa.bolsa || 'us', symbol: c.symbol, nombre: c.nombre || null,
      cambio_pct: cambio, cierre: Number(ult.c), anterior: Number(ant.c),
      fecha: cierre, fecha_anterior: isoDe(ant.t),
    });
  }
  return out.sort((a, b) => Math.abs(b.cambio_pct) - Math.abs(a.cambio_pct));
}

export function alertaMovimiento(m, { umbral = UMBRAL_MOVIMIENTO_PCT } = {}) {
  const mx = m.mercado === 'mx';
  const precio = (n) => `$${Number(n).toFixed(2)}${mx ? ' MXN' : ''}`;
  return {
    clave: `movimiento:${m.mercado}:${m.symbol}:${m.fecha}`,
    tipo: 'movimiento',
    texto: [
      `${m.cambio_pct > 0 ? '🚀' : '📉'} ${m.symbol} ${pct(m.cambio_pct, 1)} en 1D`,
      m.nombre ? `${m.nombre} · ${mx ? 'BMV' : 'EE. UU.'}` : (mx ? 'BMV' : 'EE. UU.'),
      `Cierre del ${m.fecha}: ${precio(m.cierre)} (el ${m.fecha_anterior} cerró en ${precio(m.anterior)}).`,
      `Se movió más de ${umbral}% en un día.`,
    ].join('\n'),
  };
}

// ── 4. El resumen diario ────────────────────────────────────────────
// `liga` es la respuesta de /api/leaderboard; `cobertura` la de
// /api/stock-tracker?job=cobertura. Cualquiera de las dos puede venir como
// `{ error }`: el resumen sale igual y DICE qué no pudo leer — un resumen
// que no llega se confunde con un cron muerto.
export function textoLiga(liga) {
  if (!liga || liga.error) return ['🏆 LA LIGA', `No se pudo leer: ${(liga && liga.error) || 'sin respuesta'}.`];
  const t = liga.temporada || {};
  const cab = ['🏆 LA LIGA', [t.name, t.corrida_dias != null ? `día ${t.corrida_dias}` : null].filter(Boolean).join(' · ')].filter(Boolean);
  const hoy = new Map((liga.agents || []).map((a) => [a.id, a.day_change_pct]));
  const filas = (liga.ranking || []).map((r) => {
    if (r.compite === false) return `— ${r.name}: ${pct(r.return_pct)} (índice, no compite)`;
    const d = hoy.get(r.id);
    const puesto = r.rank != null ? `${r.rank}.` : '·';
    return `${puesto} ${r.name}: ${pct(r.return_pct)}${d != null ? ` (hoy ${pct(d)})` : ''}`;
  });
  if (!filas.length) filas.push('La tabla vino vacía.');
  const ind = liga.margen_de_la_tabla && liga.margen_de_la_tabla.indice;
  const pie = ind && ind.disponible ? [`Le ganan al índice ${ind.ganan} de ${ind.total}.`] : [];
  return [...cab, ...filas, ...pie];
}

export function textoForm4(cobertura) {
  if (!cobertura || cobertura.error) return ['📄 FORM 4', `No se pudo leer la cobertura: ${(cobertura && cobertura.error) || 'sin respuesta'}.`];
  const u = cobertura.ultimo;
  if (!u) return ['📄 FORM 4', 'Todavía no hay ningún día cerrado medido.'];
  const lineas = ['📄 FORM 4', `${u.texto} (día ${u.fecha}).`];
  // Los días cerrados anteriores, en una línea: es lo que dice si el atraso
  // es de hoy o viene de arrastre.
  const previos = (cobertura.dias || [])
    .filter((d) => d.pct != null && d.fecha !== u.fecha)
    .slice(0, 4)
    .map((d) => `${d.fecha.slice(5)}: ${Number(d.pct).toFixed(0)}%`);
  if (previos.length) lineas.push(`Días anteriores — ${previos.join(' · ')}`);
  if (cobertura.cerrados_con_error) lineas.push(`${cobertura.cerrados_con_error} día(s) cerrado(s) no se pudieron medir.`);
  return lineas;
}

export function alertaResumen({ liga, cobertura, ahora = new Date() } = {}) {
  return {
    clave: `resumen:${fechaMonterrey(ahora)}`,
    tipo: 'resumen',
    texto: [
      `📊 Resumen del ${fechaLarga(ahora)}`,
      '',
      ...textoLiga(liga),
      '',
      ...textoForm4(cobertura),
    ].join('\n'),
  };
}

// ── El mensaje de prueba ────────────────────────────────────────────
export function alertaDePrueba(ahora = new Date(), origen = null) {
  const hora = new Intl.DateTimeFormat('es-MX', { timeZone: TZ_ALERTAS, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora);
  return {
    clave: null,
    tipo: 'prueba',
    texto: [
      '✅ Prueba de alertas de QuantDesk',
      `Si lees esto, el bot ya te puede escribir. Enviado a las ${hora} (hora de Monterrey)${origen ? ` desde ${origen}` : ''}.`,
      'Te voy a avisar de: saldo de OpenRouter bajo $10, crons que fallen, emisoras que se muevan más de 30% en un día y el resumen diario de las 8 pm.',
    ].join('\n'),
  };
}

/** Qué hay configurado. Nunca valores: sólo si existen y de dónde salen. */
export async function estadoDeConfig({ env = process.env, sql = sqlNeon } = {}) {
  let chat = { chat_id: null, fuente: null }, errorDb = null;
  try { chat = await chatIdDestino({ env, sql }); } catch (e) { errorDb = sinToken((e && e.message) || e, tokenDe(env)); }
  return {
    token_configurado: !!tokenDe(env),
    chat_id_configurado: !!chat.chat_id,
    chat_id_fuente: chat.fuente,
    chat: chat.chat_id ? enmascara(chat.chat_id) : null,
    ...(errorDb ? { error_db: errorDb } : {}),
  };
}
