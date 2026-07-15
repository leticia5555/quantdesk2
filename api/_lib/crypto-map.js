// ═══════════════════════════════════════════════════════════════
// api/_lib/crypto-map.js — mapeo canónico símbolo crypto → Yahoo Finance.
//
// FUENTE ÚNICA DE VERDAD. Cubre TODOS los type:'crypto' del catálogo
// TICKERS del frontend (app.html), incluidos MATIC y LTC, que faltaban en
// las listas duplicadas y hacían que SEÑALES validara LTC Properties (REIT)
// cuando el usuario pedía Litecoin, y que PARES validara Ethan Allen (ETH)
// o el ETF de Grayscale (BTC) en silencio.
//
// Si el catálogo del frontend gana un crypto nuevo, se agrega AQUÍ y los
// consumidores (pairs-validator, signal-backtester, ticker-search, _lib/sim,
// backtest) lo heredan. tests/crypto-map.test.mjs recorre el catálogo del
// frontend y falla si esta lista se desincroniza.
// ═══════════════════════════════════════════════════════════════

const CRYPTO = [
  'BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'AVAX',
  'DOT', 'DOGE', 'XRP', 'MATIC', 'LINK', 'LTC',
];
const CRYPTO_SET = new Set(CRYPTO);

// 'BTC', 'btc', ' BTC/USD ' → 'BTC-USD'; todo lo demás pasa intacto.
function toYahooSymbol(ticker) {
  const t = (ticker || '').toString().trim().toUpperCase().replace(/\/USD$/, '');
  return CRYPTO_SET.has(t) ? `${t}-USD` : t;
}

function isCrypto(ticker) {
  const t = (ticker || '').toString().trim().toUpperCase().replace(/\/USD$/, '');
  return CRYPTO_SET.has(t);
}

export { CRYPTO, toYahooSymbol, isCrypto };
