// ═══════════════════════════════════════════════════════════════
// api/_lib/tecnicos.js — RSI(14), precio vs SMA50/SMA200 y retornos a
// 1m/3m/6m de un símbolo, desde sus cierres diarios de Alpaca.
//
// SOLO LECTURA. Lo publica /liga por posición de cada agente; la ficha lo
// puede incluir detrás de ARENA_FICHA_TECNICOS (apagado en la T3).
//
// FALTA HISTORIA → null, NUNCA 0. Un RSI de 0 es "sobreventa extrema", un
// "vs SMA200 0%" es "justo en la media": los dos son afirmaciones. Un nombre
// que cotiza hace 80 sesiones no tiene SMA200, y se dice así.
//
// LAS VENTANAS, en sesiones (no días de calendario):
//   1m = 21 · 3m = 63 · 6m = 126 — las mismas convenciones de
//   `RET_1M_SESIONES` (alpaca.js). El retorno a N sesiones necesita N+1
//   cierres: el de hoy y el de hace N.
//
// TODO SE MIDE AL ÚLTIMO CIERRE (velas cerradas, point-in-time), no contra el
// precio intradía: el RSI y las medias son de cierres, y mezclar un precio vivo
// con una media de cierres da un número que nadie puede reproducir.
// ═══════════════════════════════════════════════════════════════

import { computeRSI, computeSMA } from '../signal-backtester.js';
import { getCierresDiarios } from './alpaca.js';

export const VENTANAS = { ret_1m: 21, ret_3m: 63, ret_6m: 126 };
// Cuántas sesiones se piden: SMA200 necesita 200 cierres, y un margen por si
// el feed se salta alguna.
export const SESIONES_TECNICOS = 215;

const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const ultimo = (arr) => (arr.length ? arr[arr.length - 1] : null);

// Pura. `cierres` en orden cronológico, solo velas cerradas.
export function tecnicosDeCierres(cierres) {
  const c = (Array.isArray(cierres) ? cierres : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const n = c.length;
  const precio = n ? c[n - 1] : null;
  const vsMedia = (periodo) => {
    const sma = n >= periodo ? ultimo(computeSMA(c, periodo)) : null;
    return sma ? r2(((precio - sma) / sma) * 100) : null;
  };
  const retorno = (k) => (n > k ? r2(((precio - c[n - 1 - k]) / c[n - 1 - k]) * 100) : null);
  return {
    rsi14: n > 14 ? r2(ultimo(computeRSI(c, 14))) : null,
    vs_sma50_pct: vsMedia(50),
    vs_sma200_pct: vsMedia(200),
    ret_1m_pct: retorno(VENTANAS.ret_1m),
    ret_3m_pct: retorno(VENTANAS.ret_3m),
    ret_6m_pct: retorno(VENTANAS.ret_6m),
    ultimo_cierre: precio,
    sesiones: n,
  };
}

// Los técnicos de varios símbolos en UNA consulta a Alpaca. Nunca lanza: si
// Alpaca no contesta, cada símbolo sale con todo en null y el motivo arriba.
export async function tecnicosPorSimbolo(symbols, { creds = null, now = new Date(), deps = {} } = {}) {
  const wanted = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return { por_simbolo: {}, feed: null, error: null };
  let cierres = {};
  let feed = null;
  let error = null;
  try {
    const r = await (deps.getCierresDiarios || getCierresDiarios)(wanted, { creds, now, sesiones: SESIONES_TECNICOS });
    cierres = (r && r.data) || {};
    feed = (r && r.feed) || null;
  } catch (e) { error = String((e && e.message) || e); }
  const por_simbolo = {};
  for (const s of wanted) por_simbolo[s] = tecnicosDeCierres(cierres[s] || []);
  return { por_simbolo, feed, error };
}

// La línea que entra a la ficha (detrás de ARENA_FICHA_TECNICOS).
const sg = (x) => (x == null ? 'n/d' : (x > 0 ? '+' : '') + x.toFixed(1) + '%');
export function lineaTecnicos(t) {
  if (!t) return null;
  return `técnicos (al último cierre, ${t.sesiones} sesiones): RSI14 ${t.rsi14 == null ? 'n/d' : t.rsi14.toFixed(1)}`
    + ` · vs SMA50 ${sg(t.vs_sma50_pct)} · vs SMA200 ${sg(t.vs_sma200_pct)}`
    + ` · ret 1m ${sg(t.ret_1m_pct)} · 3m ${sg(t.ret_3m_pct)} · 6m ${sg(t.ret_6m_pct)}`
    + ' (n/d = no hay historia suficiente, no es cero)';
}

// Apagado por defecto. Solo '1' lo enciende: un valor raro no lo prende.
export function fichaTecnicosActiva(env = process.env) {
  return String((env && env.ARENA_FICHA_TECNICOS) || '').trim() === '1';
}
