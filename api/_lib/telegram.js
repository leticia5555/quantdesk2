// ═══════════════════════════════════════════════════════════════════════
// api/_lib/telegram.js — EL ÚNICO lugar que le habla a Telegram.
//
// Todo mensaje que QuantDesk le manda a Lety pasa por `mandaMensaje`. Las
// alertas (api/alertas.js) arman el texto; acá se manda. Si mañana hay que
// cambiar de bot, de formato o de canal, es este archivo y ninguno más.
//
// ── EL TOKEN NO SE IMPRIME. NUNCA. ───────────────────────────────────
// La API de Telegram lleva el token EN LA URL (`/bot<token>/sendMessage`), así
// que cualquier error de red que cite la URL lo filtraría a un log o a una
// respuesta HTTP. Por eso:
//   · ningún error de este módulo incluye la URL;
//   · todo texto que sale de acá pasa por `sinToken`, que tacha el token si
//     alguna librería lo metió en su mensaje;
//   · lo único que se reporta del token es SI ESTÁ (true/false).
//
// ── EL CHAT ──────────────────────────────────────────────────────────
// `TELEGRAM_CHAT_ID` se lee primero de las env vars. Si no está, de Neon
// (`alertas_config`), que es donde lo deja `?job=chat-id` después de sacarlo
// con `getUpdates`. La env var gana: así se puede corregir desde Vercel sin
// tocar la base.
//
// ENV VARS: TELEGRAM_BOT_TOKEN (obligatoria) · TELEGRAM_CHAT_ID (opcional, ver
//   arriba) · PUBLIC_BASE_URL (opcional, para los links) · DATABASE_URL
// ═══════════════════════════════════════════════════════════════════════

import { sql } from './db.js';

const API = 'https://api.telegram.org';
const TOPE_TELEGRAM = 4096;          // largo máximo de un mensaje de texto
const TIMEOUT_MS = 10_000;
export const CLAVE_CHAT = 'TELEGRAM_CHAT_ID';

export function baseQuantDesk(env = process.env) {
  return String(env.PUBLIC_BASE_URL || 'https://quantdesk2.vercel.app').trim().replace(/\/+$/, '');
}

export function tokenDeEnv(env = process.env) {
  const t = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  return t || null;
}

/** Tacha el token de cualquier texto. Lo que salga de este módulo pasa por acá. */
export function sinToken(texto, token) {
  let s = String(texto == null ? '' : texto);
  if (token) s = s.split(token).join('<token>');
  // Y por si viajó otro: cualquier cosa con forma de token de bot.
  return s.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<token>');
}

/** El texto va con `parse_mode: HTML`: estos tres caracteres hay que escaparlos. */
export function escapaHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** El link a QuantDesk que lleva TODO mensaje. `ruta` empieza con `/`. */
export function linkQuantDesk(ruta = '/mercado', etiqueta = 'Ver más en QuantDesk', env = process.env) {
  const href = baseQuantDesk(env) + (String(ruta).startsWith('/') ? ruta : '/' + ruta);
  return `<a href="${href.replace(/"/g, '%22')}">${escapaHtml(etiqueta)} →</a>`;
}

/**
 * Una llamada a la Bot API. Devuelve `result` o lanza un Error SIN el token.
 */
export async function llamaTelegram(metodo, cuerpo = {}, { token = tokenDeEnv(), fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('Falta TELEGRAM_BOT_TOKEN en las env vars de este deploy.');
  let r;
  let data = null;
  try {
    r = await fetchImpl(`${API}/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await r.json().catch(() => null);
  } catch (e) {
    throw new Error(`Telegram ${metodo}: no se pudo conectar (${sinToken((e && e.message) || e, token)})`);
  }
  if (!r.ok || !data || data.ok !== true) {
    const dicho = data && data.description ? data.description : `HTTP ${r.status}`;
    const err = new Error(`Telegram ${metodo}: ${sinToken(dicho, token)}`);
    err.status = r.status;
    throw err;
  }
  return data.result;
}

// ── EL CHAT_ID ───────────────────────────────────────────────────────
const SCHEMA_CONFIG = `create table if not exists alertas_config (
   clave        text primary key,
   valor        text not null,
   actualizado  timestamptz not null default now()
 )`;

let configLista = false;
async function ensureConfig() {
  if (configLista) return;
  await sql(SCHEMA_CONFIG);
  configLista = true;
}

export async function leeConfig(clave) {
  await ensureConfig();
  const filas = await sql('select valor from alertas_config where clave = $1', [clave]);
  return filas.length ? filas[0].valor : null;
}

export async function guardaConfig(clave, valor) {
  await ensureConfig();
  await sql(
    `insert into alertas_config (clave, valor, actualizado) values ($1, $2, now())
     on conflict (clave) do update set valor = excluded.valor, actualizado = now()`,
    [clave, String(valor)]);
}

/** De dónde sale el chat: la env var gana; si no, lo guardado en Neon. */
export async function resuelveChatId({ env = process.env, leer = leeConfig } = {}) {
  const deEnv = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (deEnv) return { chatId: deEnv, fuente: 'env:TELEGRAM_CHAT_ID' };
  const guardado = await leer(CLAVE_CHAT).catch(() => null);
  if (guardado) return { chatId: guardado, fuente: 'neon:alertas_config' };
  return { chatId: null, fuente: null };
}

/**
 * Los chats PRIVADOS que le escribieron al bot, sacados de `getUpdates`.
 * Sin repetir, el más reciente primero.
 */
export function chatsDeUpdates(updates = []) {
  const porId = new Map();
  for (const u of updates || []) {
    const m = u && (u.message || u.edited_message);
    const chat = m && m.chat;
    if (!chat || chat.type !== 'private' || chat.id == null) continue;
    const previo = porId.get(String(chat.id));
    const cuando = Number(m.date) || 0;
    if (previo && previo.ultimo_mensaje >= cuando) continue;
    porId.set(String(chat.id), {
      chat_id: String(chat.id),
      nombre: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null,
      usuario: chat.username || null,
      ultimo_mensaje: cuando,
    });
  }
  return [...porId.values()].sort((a, b) => b.ultimo_mensaje - a.ultimo_mensaje);
}

/**
 * Saca el chat_id con `getUpdates` y lo guarda como TELEGRAM_CHAT_ID.
 *
 * NO ADIVINA. Cualquiera puede escribirle a un bot, así que si le escribió más
 * de una persona no se elige "la primera": se devuelve la lista y se guarda
 * sólo cuando se dice cuál (`elegido`). Con un solo chat, se guarda ése.
 */
export async function descubreChatId({ elegido = null, token = tokenDeEnv(), fetchImpl = globalThis.fetch, guardar = guardaConfig } = {}) {
  const updates = await llamaTelegram('getUpdates', { allowed_updates: ['message'], limit: 100 }, { token, fetchImpl });
  const chats = chatsDeUpdates(updates);
  if (!chats.length) {
    return {
      ok: false,
      motivo: 'El bot no tiene mensajes recientes. Telegram sólo guarda los de las últimas 24 horas: escríbele cualquier cosa al bot y vuelve a correr esto.',
      chats: [],
    };
  }
  const uno = elegido
    ? chats.find((c) => c.chat_id === String(elegido))
    : (chats.length === 1 ? chats[0] : null);
  if (!uno) {
    return {
      ok: false,
      motivo: elegido
        ? `El chat ${elegido} no está entre los que le escribieron al bot.`
        : 'Más de una persona le escribió al bot. Vuelve a llamar con &chat_id=<el tuyo> para guardar el correcto.',
      chats,
    };
  }
  await guardar(CLAVE_CHAT, uno.chat_id);
  return { ok: true, chat_id: uno.chat_id, nombre: uno.nombre, usuario: uno.usuario, guardado_en: 'neon:alertas_config', chats };
}

/**
 * MANDA UN MENSAJE. La única función que las alertas usan.
 *
 * Un texto vacío NO se manda: lanza. "No hay nada que decir" se resuelve antes,
 * no mandando un mensaje en blanco.
 */
export async function mandaMensaje(texto, { chatId = null, token = tokenDeEnv(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const limpio = String(texto == null ? '' : texto).trim();
  if (!limpio) throw new Error('mandaMensaje: el texto está vacío, no se manda nada.');
  let destino = chatId;
  if (!destino) destino = (await resuelveChatId({ env })).chatId;
  if (!destino) throw new Error('Falta TELEGRAM_CHAT_ID: corre /api/alertas?job=chat-id para sacarlo con getUpdates.');
  const recortado = limpio.length > TOPE_TELEGRAM ? limpio.slice(0, TOPE_TELEGRAM - 1) + '…' : limpio;
  const r = await llamaTelegram('sendMessage', {
    chat_id: destino,
    text: recortado,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, { token, fetchImpl });
  return { message_id: r && r.message_id, chars: recortado.length };
}
