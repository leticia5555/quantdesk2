// ═══════════════════════════════════════════════════════════════════════
// qd-mundo.js — EL CATÁLOGO DE MUNDO, Y LO QUE NO SE PINTA
//
// Encargo §3/R2: "rejilla por región (América / Europa / Asia /
// Cripto-FX-materias primas), un cuadro por índice, **tamaño fijo** (los
// índices no tienen cap; no fingir), color por %".
//
// Tamaño fijo no es una comodidad: es la regla 2 aplicada al tamaño. En el mapa
// de acciones el área ES un dato —la capitalización— y un cuadro grande afirma
// algo. Un índice no tiene con qué dimensionarse: el Nikkei son 225 empresas
// japonesas y el DAX 40 alemanas, y no hay número que los haga comparables de
// tamaño. Así que todos miden igual y el único dato que el cuadro afirma es su
// color.
//
// ── QUÉ NO ESTÁ EN MUNDO, Y POR QUÉ ───────────────────────────────────
// `/api/macro-markets` trae 23 símbolos y acá se pintan 15. Los otros ocho no
// se esconden: se declaran.
//
//   · `^VIX`, `^TNX`, `2YY=F`, `^TYX` — la volatilidad y las tasas del Tesoro
//     no son índices de ninguna región, y las cuatro regiones que Lety fijó no
//     tienen un cajón donde ponerlas. Meterlas en "Cripto-FX-materias primas"
//     sería acomodar el dato al mueble. Siguen en el tab MACRO de `app.html`,
//     que es donde viven hoy.
//   · `GBPUSD=X`, `KRW=X`, `HKD=X`, `BRL=X` — entraron al endpoint en R2(a)
//     como INSUMO del rendimiento en pesos (sin ellos el FTSE, el KOSPI, el
//     Hang Seng y el Bovespa no pueden convertirse). Son el cruce de una
//     moneda, no un activo que alguien quiera mirar: van marcados
//     `solo_insumo` y no ocupan un cuadro.
//
// Y CRIPTO NO SE INVENTA. La región se llama "Cripto · FX · materias primas"
// porque así la nombró el encargo, y hoy no hay ni un símbolo de cripto en el
// endpoint. La rejilla lo dice con el aviso de la región en vez de dejar el
// hueco mudo — igual que los tabs Cripto/ETFs del encargo van "vacíos con
// 'pronto', no fingir".
// ═══════════════════════════════════════════════════════════════════════

/** Las cuatro regiones, en el orden en que se pintan. */
const REGIONES = [
  { clave: 'america', nombre: 'América' },
  { clave: 'europa', nombre: 'Europa' },
  { clave: 'asia', nombre: 'Asia' },
  { clave: 'otros', nombre: 'Cripto · FX · materias primas' },
];

/**
 * Un renglón por símbolo: cómo se llama en español, en qué región va, y en qué
 * bolsa cotiza —o `24h` si no abre ni cierra, que es la etiqueta que Lety pidió
 * para futuros, divisas y cripto.
 *
 * `moneda` es la que se ESPERA; la que manda es la que el endpoint devuelve en
 * `currency`. Si no coinciden, el cuadro lo dice en vez de convertir con la
 * suposición: es la misma lección del ADR que salía del tamaño de NVDA.
 */
const CATALOGO = [
  // ── América ─────────────────────────────────────────────────────────
  { symbol: '^MXX', nombre: 'IPC', region: 'america', bolsa: 'bmv', moneda: 'MXN' },
  { symbol: '^BVSP', nombre: 'Bovespa', region: 'america', bolsa: 'saopaulo', moneda: 'BRL' },
  { symbol: 'ES=F', nombre: 'S&P 500 fut.', region: 'america', bolsa: '24h', moneda: 'USD' },
  { symbol: 'NQ=F', nombre: 'Nasdaq 100 fut.', region: 'america', bolsa: '24h', moneda: 'USD' },
  { symbol: 'YM=F', nombre: 'Dow fut.', region: 'america', bolsa: '24h', moneda: 'USD' },
  // ── Europa ──────────────────────────────────────────────────────────
  { symbol: '^GDAXI', nombre: 'DAX', region: 'europa', bolsa: 'francfort', moneda: 'EUR' },
  { symbol: '^FTSE', nombre: 'FTSE 100', region: 'europa', bolsa: 'londres', moneda: 'GBP' },
  // ── Asia ────────────────────────────────────────────────────────────
  { symbol: '^N225', nombre: 'Nikkei 225', region: 'asia', bolsa: 'tokio', moneda: 'JPY' },
  { symbol: '^KS11', nombre: 'KOSPI', region: 'asia', bolsa: 'seul', moneda: 'KRW' },
  { symbol: '^HSI', nombre: 'Hang Seng', region: 'asia', bolsa: 'hongkong', moneda: 'HKD' },
  // ── Cripto · FX · materias primas ───────────────────────────────────
  { symbol: 'DX-Y.NYB', nombre: 'Índice dólar', region: 'otros', bolsa: '24h', moneda: 'USD' },
  { symbol: 'EURUSD=X', nombre: 'EUR/USD', region: 'otros', bolsa: '24h', moneda: 'USD' },
  { symbol: 'JPY=X', nombre: 'USD/JPY', region: 'otros', bolsa: '24h', moneda: 'JPY' },
  { symbol: 'CL=F', nombre: 'Petróleo WTI', region: 'otros', bolsa: '24h', moneda: 'USD' },
  { symbol: 'BZ=F', nombre: 'Petróleo Brent', region: 'otros', bolsa: '24h', moneda: 'USD' },
  // ── Insumos del rendimiento en pesos: NO ocupan cuadro ──────────────
  { symbol: 'GBPUSD=X', nombre: 'GBP/USD', region: null, bolsa: '24h', moneda: 'USD', solo_insumo: true },
  { symbol: 'KRW=X', nombre: 'USD/KRW', region: null, bolsa: '24h', moneda: 'KRW', solo_insumo: true },
  { symbol: 'HKD=X', nombre: 'USD/HKD', region: null, bolsa: '24h', moneda: 'HKD', solo_insumo: true },
  { symbol: 'BRL=X', nombre: 'USD/BRL', region: null, bolsa: '24h', moneda: 'BRL', solo_insumo: true },
];

/** Los símbolos que sólo sirven para el cruce contra el peso. */
const SOLO_INSUMO = CATALOGO.filter((c) => c.solo_insumo).map((c) => c.symbol);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** El último día con cierre de una serie `[{t,c}]`, en AAAA-MM-DD y UTC. */
function ultimoDiaDeSerie(serie = []) {
  let mejor = null;
  for (const p of serie) {
    const t = num(p && p.t);
    if (t == null) continue;
    if (mejor == null || t > mejor) mejor = t;
  }
  if (mejor == null) return null;
  const d = new Date(mejor * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/**
 * La rejilla de Mundo a partir de la respuesta de `/api/macro-markets`.
 *
 * NO calcula ningún porcentaje: entrega la serie y el navegador la pasa por
 * `qdPeriodChange`, que es la regla 1. Y lo que falta se cuenta con su causa,
 * que es la regla 2: un símbolo que el endpoint no devolvió no es un cuadro
 * ausente, es un cuadro que dice por qué no está.
 */
function armaMundo({ data = {}, catalogo = CATALOGO, regiones = REGIONES } = {}) {
  const faltantes = [];
  const porRegion = new Map(regiones.map((r) => [r.clave, []]));

  for (const c of catalogo) {
    if (c.solo_insumo || !c.region) continue;
    const d = data[c.symbol];
    const serie = (d && Array.isArray(d.series)) ? d.series : [];
    const precio = num(d && d.price);

    if (!d) {
      faltantes.push({ symbol: c.symbol, nombre: c.nombre, motivo: 'el endpoint no devolvió este símbolo' });
      continue;
    }
    if (precio == null) {
      faltantes.push({ symbol: c.symbol, nombre: c.nombre, motivo: 'llegó sin precio actual' });
      continue;
    }
    if (serie.length < 2) {
      faltantes.push({
        symbol: c.symbol, nombre: c.nombre,
        motivo: `llegó con ${serie.length} punto${serie.length === 1 ? '' : 's'} de serie: sin dos cierres no hay periodo que calcular`,
      });
      continue;
    }

    const monedaReal = d.currency ? String(d.currency).toUpperCase() : null;
    porRegion.get(c.region).push({
      symbol: c.symbol,
      nombre: c.nombre,
      bolsa: c.bolsa,
      es24h: c.bolsa === '24h',
      precio,
      // La moneda que manda es la que declaró la fuente. La esperada viaja al
      // lado para poder decirlo cuando no coinciden, en vez de elegir una.
      moneda: monedaReal,
      moneda_esperada: c.moneda,
      moneda_discrepa: monedaReal != null && monedaReal !== c.moneda,
      serie,
      puntos: serie.length,
      ultimo_cierre: ultimoDiaDeSerie(serie),
      fuente: 'yahoo:v8/chart',
    });
  }

  return {
    regiones: regiones.map((r) => ({
      ...r,
      cuadros: porRegion.get(r.clave) || [],
      // Cripto todavía no tiene ni un símbolo en el endpoint. Se dice en la
      // región, no se deja el hueco mudo.
      aviso: r.clave === 'otros' ? 'cripto todavía no: no hay ni un símbolo de cripto en la fuente' : null,
    })),
    faltantes,
    solo_insumo: SOLO_INSUMO,
    fuente: 'yahoo:v8/chart vía /api/macro-markets (precio y serie; los % los calcula el navegador)',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REGIONES, CATALOGO, SOLO_INSUMO, ultimoDiaDeSerie, armaMundo };
}
