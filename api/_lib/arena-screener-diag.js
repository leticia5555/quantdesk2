// ═══════════════════════════════════════════════════════════════════
// api/_lib/arena-screener-diag.js — el screener de los agentes, a mano.
//
// /api/arena-screener?job=screener arma el tablero de HOY y le corre los
// mismos filtros que pidió openai el 29-sep (`rvol_top:true` sin sector y con
// `sector:XLK`), con el MISMO ejecutor que usan los agentes. Existe para
// contestar desde el navegador "¿qué devuelve el screener hoy?" sin una
// corrida de la liga y sin SQL.
//
// Esto es la parte PURA (tablero + universo → resultados), para probarla sin
// Alpaca ni Neon. El endpoint sólo carga y cablea.
// ═══════════════════════════════════════════════════════════════════

import { createToolExecutor } from './arena-tools.js';
import { sectorFromGics } from './arena-meta.js';

// Los dos pedidos de openai del 29-sep, literales.
export const PEDIDOS_OPENAI = [
  { rvol_top: true },
  { rvol_top: true, sector: 'XLK' },
];

export async function diagnosticoScreener({ universe = null, board = null, pedidos = PEDIDOS_OPENAI } = {}) {
  // El sector sale del universo (GICS de IVV), igual que en la corrida.
  const sectorPorSimbolo = {};
  for (const [tk, gics] of Object.entries((universe && universe.sectores) || {})) {
    const etf = sectorFromGics(gics);
    if (etf) sectorPorSimbolo[tk] = etf;
  }
  const ex = createToolExecutor({
    budget: pedidos.length, board, universe, cache: false,
    deps: { sectorOf: (sym) => sectorPorSimbolo[sym] || null },
  });
  const resultados = [];
  for (const p of pedidos) {
    const out = await ex.call('screener', p);
    resultados.push({
      pedido: p, filas: out.rows ?? null,
      ...(out.datos_faltantes ? { datos_faltantes: out.datos_faltantes } : {}),
      ...(out.embudo ? { embudo: out.embudo } : {}),
      texto: out.text,
    });
  }
  const conRvol = board ? (board.rvol || []).length : 0;
  return {
    universo: universe ? {
      fuente: universe.universe_source || null, built_at: universe.built_at || null,
      dia: universe.loaded_from || null, es_de_hoy: universe.is_today ?? null,
      nombres: (universe.symbols || []).length,
      con_sector: Object.keys(sectorPorSimbolo).length,
    } : null,
    tablero: board ? {
      cubiertos: board.covered ?? null, universo: board.universe_size ?? null,
      con_rvol_top: conRvol, sin_rvol: board.sin_rvol || null,
      feed: board.feed_datos || null, sesion_pct: board.sesion_pct ?? null,
      errores: board.errors || {}, avisos: board.avisos || [],
    } : null,
    resultados,
    // La lectura, en una línea: si da 0 y no hay sin_rvol, el problema es otro.
    lectura: !board ? 'Sin tablero: no hay sobre qué filtrar.'
      : board.sin_rvol ? `El tablero salió SIN RVOL (${board.sin_rvol.motivo}). Ése es el bug del 29-sep: rvol_top no tiene sobre qué rankear.`
        : resultados.every((r) => r.filas > 0) ? `Los dos filtros devuelven filas (${resultados.map((r) => r.filas).join(' / ')}). El screener funciona hoy.`
          : 'Algún filtro dio 0 con RVOL presente: mirá `embudo` para ver cuál se llevó las filas.',
  };
}
