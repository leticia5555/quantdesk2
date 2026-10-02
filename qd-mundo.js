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
// `/api/macro-markets` trae 39 símbolos y acá se pintan 18. Los demás no
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

/** Las cuatro regiones, en el orden en que se pintan (artboard 4). */
const REGIONES = [
  { clave: 'america', nombre: 'América' },
  { clave: 'europa', nombre: 'Europa' },
  { clave: 'asia', nombre: 'Asia' },
  { clave: 'otros', nombre: 'Cripto · FX · Materias primas' },
];

/**
 * CÓMO SE LLEGA DE CADA MONEDA AL PESO.
 *
 * `qd-pesos.js` necesita el rendimiento de "unidades de la moneda por dólar"
 * para armar el cruce. Yahoo publica las divisas de dos formas y confundirlas
 * invierte el signo del cruce:
 *
 *   · `JPY=X`, `KRW=X`, `CAD=X`… → YENES POR DÓLAR. Se usa tal cual.
 *   · `EURUSD=X`, `GBPUSD=X`     → DÓLARES POR EURO. Hay que invertir.
 *
 * Así que la forma va declarada por moneda y no se adivina del nombre del
 * símbolo. `MXN` no tiene entrada porque el cruce del peso contra el peso es 0,
 * y `USD` tampoco porque ahí el cruce ES el FIX.
 */
const MONEDAS = {
  JPY: { symbol: 'JPY=X', invertir: false },
  KRW: { symbol: 'KRW=X', invertir: false },
  HKD: { symbol: 'HKD=X', invertir: false },
  BRL: { symbol: 'BRL=X', invertir: false },
  CAD: { symbol: 'CAD=X', invertir: false },
  CNY: { symbol: 'CNY=X', invertir: false },
  INR: { symbol: 'INR=X', invertir: false },
  AUD: { symbol: 'AUD=X', invertir: false },
  EUR: { symbol: 'EURUSD=X', invertir: true },
  GBP: { symbol: 'GBPUSD=X', invertir: true },
};

/**
 * Los 18 cuadros del artboard 4: nombre, PAÍS, región, bolsa y moneda.
 *
 * `tipo` decide qué va en la línea chica: en un índice va el rendimiento local
 * —"local +0.7%"— y en Bitcoin, el dólar y el oro va el PRECIO, como en el
 * mockup ("$114,240", "18.21", "$3,684"). Un índice no tiene precio que
 * mostrar: 45,800 puntos del Nikkei no son pesos ni dólares.
 *
 * `moneda` es la que se ESPERA; manda la que el endpoint declara en `currency`.
 * Si no coinciden, el cuadro lo dice en vez de convertir con la suposición.
 */
const CATALOGO = [
  // ── América ─────────────────────────────────────────────────────────
  { symbol: '^GSPC', nombre: 'S&P 500', pais: 'EE.UU.', region: 'america', bolsa: 'nyse', moneda: 'USD' },
  { symbol: '^NDX', nombre: 'Nasdaq 100', pais: 'EE.UU.', region: 'america', bolsa: 'nyse', moneda: 'USD' },
  { symbol: '^MXX', nombre: 'IPC', pais: 'México', region: 'america', bolsa: 'bmv', moneda: 'MXN' },
  { symbol: '^BVSP', nombre: 'Bovespa', pais: 'Brasil', region: 'america', bolsa: 'saopaulo', moneda: 'BRL' },
  { symbol: '^GSPTSE', nombre: 'S&P/TSX', pais: 'Canadá', region: 'america', bolsa: 'toronto', moneda: 'CAD' },
  // ── Europa ──────────────────────────────────────────────────────────
  { symbol: '^GDAXI', nombre: 'DAX', pais: 'Alemania', region: 'europa', bolsa: 'francfort', moneda: 'EUR' },
  { symbol: '^FTSE', nombre: 'FTSE 100', pais: 'Reino Unido', region: 'europa', bolsa: 'londres', moneda: 'GBP' },
  { symbol: '^FCHI', nombre: 'CAC 40', pais: 'Francia', region: 'europa', bolsa: 'paris', moneda: 'EUR' },
  // ── Asia ────────────────────────────────────────────────────────────
  { symbol: '^N225', nombre: 'Nikkei 225', pais: 'Japón', region: 'asia', bolsa: 'tokio', moneda: 'JPY' },
  { symbol: '^KS11', nombre: 'KOSPI', pais: 'Corea', region: 'asia', bolsa: 'seul', moneda: 'KRW' },
  { symbol: '^HSI', nombre: 'Hang Seng', pais: 'Hong Kong', region: 'asia', bolsa: 'hongkong', moneda: 'HKD' },
  { symbol: '000001.SS', nombre: 'Shanghai', pais: 'China', region: 'asia', bolsa: 'shanghai', moneda: 'CNY' },
  { symbol: '^NSEI', nombre: 'Nifty 50', pais: 'India', region: 'asia', bolsa: 'mumbai', moneda: 'INR' },
  { symbol: '^AXJO', nombre: 'ASX 200', pais: 'Australia', region: 'asia', bolsa: 'sidney', moneda: 'AUD' },
  // ── Cripto · FX · Materias primas ───────────────────────────────────
  { symbol: 'BTC-USD', nombre: 'Bitcoin', pais: 'BTC/USD', region: 'otros', bolsa: '24h', moneda: 'USD', tipo: 'precio', prefijo: '$' },
  // EL PESO TIENE UNA SOLA FUENTE DE VERDAD. Este cuadro salía de `MXN=X` de
  // Yahoo y daba +2.19% 1D mientras la conversión a pesos, que usa el FIX de
  // Banxico, daba +0.74%: dos números del mismo peso en la misma pantalla,
  // porque a la serie de Yahoo le faltaba un día. El cuadro pasa a salir del
  // MISMO FIX que convierte, con su fecha.
  { symbol: 'MXN=X', nombre: 'USD/MXN', pais: 'FIX Banxico', region: 'otros', bolsa: '24h', moneda: 'MXN', tipo: 'precio', desde_fix: true },
  { symbol: 'GC=F', nombre: 'Oro', pais: 'USD/oz', region: 'otros', bolsa: '24h', moneda: 'USD', tipo: 'precio', prefijo: '$' },
  // ── Insumos del rendimiento en pesos: NO ocupan cuadro ──────────────
  { symbol: 'GBPUSD=X', nombre: 'GBP/USD', region: null, bolsa: '24h', moneda: 'USD', solo_insumo: true },
  { symbol: 'EURUSD=X', nombre: 'EUR/USD', region: null, bolsa: '24h', moneda: 'USD', solo_insumo: true },
  { symbol: 'JPY=X', nombre: 'USD/JPY', region: null, bolsa: '24h', moneda: 'JPY', solo_insumo: true },
  { symbol: 'KRW=X', nombre: 'USD/KRW', region: null, bolsa: '24h', moneda: 'KRW', solo_insumo: true },
  { symbol: 'HKD=X', nombre: 'USD/HKD', region: null, bolsa: '24h', moneda: 'HKD', solo_insumo: true },
  { symbol: 'BRL=X', nombre: 'USD/BRL', region: null, bolsa: '24h', moneda: 'BRL', solo_insumo: true },
  { symbol: 'CAD=X', nombre: 'USD/CAD', region: null, bolsa: '24h', moneda: 'CAD', solo_insumo: true },
  { symbol: 'CNY=X', nombre: 'USD/CNY', region: null, bolsa: '24h', moneda: 'CNY', solo_insumo: true },
  { symbol: 'INR=X', nombre: 'USD/INR', region: null, bolsa: '24h', moneda: 'INR', solo_insumo: true },
  { symbol: 'AUD=X', nombre: 'USD/AUD', region: null, bolsa: '24h', moneda: 'AUD', solo_insumo: true },
];

/** Los cinco de la tira de arriba (artboard 4), en su orden. */
const TIRA = ['^GSPC', '^MXX', '^N225', '^KS11', '^GDAXI'];

/** Los símbolos que sólo sirven para el cruce contra el peso. */
const SOLO_INSUMO = CATALOGO.filter((c) => c.solo_insumo).map((c) => c.symbol);

const numMundo = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** El último día con cierre de una serie `[{t,c}]`, en AAAA-MM-DD y UTC. */
function ultimoDiaDeSerie(serie = []) {
  let mejor = null;
  for (const p of serie) {
    const t = numMundo(p && p.t);
    if (t == null) continue;
    if (mejor == null || t > mejor) mejor = t;
  }
  if (mejor == null) return null;
  const d = new Date(mejor * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/** El día UTC de un timestamp en segundos, o null. */
function diaDe(t) {
  const n = numMundo(t);
  if (n == null) return null;
  const d = new Date(n * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/**
 * EL PRECIO Y EL % TIENEN QUE SER DEL MISMO DÍA.
 *
 * `price` es el último precio de mercado y la serie diaria termina en el
 * último CIERRE. Cuando la sesión de hoy ya corrió pero su cierre todavía no
 * entró a la serie, son de días distintos — y el cuadro mostraba el precio de
 * HOY con el % de AYER. El KOSPI: 6,870.81 de hoy con −2.70%, que era el 1D del
 * lunes (6,889.74 contra 7,080.92); el de hoy era −0.27%.
 *
 * La regla de Lety, 2026-09-29:
 *
 *   · si `price` es MÁS NUEVO que el último punto → entra como el punto de hoy
 *     antes de calcular, y el % pasa a ser el de hoy;
 *   · si no → el precio que se muestra es el del último punto, y la etiqueta
 *     dice de qué fecha es.
 *
 * Sin `precio_t` no se adivina: se usa el último cierre y se dice su fecha,
 * que es la mitad segura de la regla.
 */
function serieConPrecio(serie = [], precio, precioT) {
  const ultimo = serie.length ? serie[serie.length - 1] : null;
  const diaUltimo = ultimo ? diaDe(ultimo.t) : null;
  const diaPrecio = diaDe(precioT);
  const px = numMundo(precio);

  if (px != null && diaPrecio && diaUltimo && diaPrecio > diaUltimo) {
    return {
      serie: serie.concat([{ t: numMundo(precioT), c: px }]),
      precio: px, precio_fecha: diaPrecio, precio_es_de_hoy: true,
    };
  }
  // El precio que se muestra es el del último cierre: mostrar el de mercado
  // junto a un % que no lo incluye es pintar dos días como si fueran uno.
  return {
    serie,
    precio: ultimo ? ultimo.c : px,
    precio_fecha: diaUltimo,
    precio_es_de_hoy: false,
  };
}

/**
 * La rejilla de Mundo a partir de la respuesta de `/api/macro-markets`.
 *
 * NO calcula ningún porcentaje: entrega la serie y el navegador la pasa por
 * `qdPeriodChange`, que es la regla 1. Y lo que falta se cuenta con su causa,
 * que es la regla 2: un símbolo que el endpoint no devolvió no es un cuadro
 * ausente, es un cuadro que dice por qué no está.
 */
function armaMundo({ data = {}, catalogo = CATALOGO, regiones = REGIONES, fix = null, omitidos = {} } = {}) {
  const faltantes = [];
  const porRegion = new Map(regiones.map((r) => [r.clave, []]));

  for (const c of catalogo) {
    if (c.solo_insumo || !c.region) continue;
    // El cuadro del peso NO sale de Yahoo: sale del MISMO FIX que convierte a
    // pesos. Dos fuentes para el peso en la misma pantalla es dos verdades.
    const d = c.desde_fix
      ? (fix && Array.isArray(fix.serie) && fix.serie.length >= 2
        ? { price: fix.valor, precio_t: null, currency: 'MXN', series: fix.serie, fuente: 'banxico:SF43718', fecha_fix: fix.fecha }
        : null)
      : data[c.symbol];
    const serie = (d && Array.isArray(d.series)) ? d.series : [];
    const precio = numMundo(d && d.price);

    if (!d) {
      if (c.desde_fix) {
        faltantes.push({ symbol: c.symbol, nombre: c.nombre, motivo: (fix && fix.motivo) || 'no llegó el FIX de Banxico' });
        continue;
      }
      // La razón la da el endpoint cuando la tiene: "Yahoo respondió HTTP 404"
      // se arregla cambiando el ticker, y "no se pudo consultar" no. Sin razón
      // declarada, se dice eso y no una inventada.
      faltantes.push({
        symbol: c.symbol, nombre: c.nombre,
        motivo: omitidos[c.symbol] || 'el endpoint no devolvió este símbolo ni dijo por qué',
      });
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
    const px = serieConPrecio(serie, precio, d.precio_t);
    porRegion.get(c.region).push({
      symbol: c.symbol,
      nombre: c.nombre,
      pais: c.pais || null,
      // 'indice' → la línea chica lleva el rendimiento local; 'precio' → el
      // precio, como en el mockup. Un índice no tiene precio que mostrar.
      tipo: c.tipo || 'indice',
      prefijo: c.prefijo || '',
      bolsa: c.bolsa,
      es24h: c.bolsa === '24h',
      precio: px.precio,
      precio_fecha: px.precio_fecha,
      precio_es_de_hoy: px.precio_es_de_hoy,
      // LA FECHA DEL DATO QUE SE ESTÁ MOSTRANDO, que no siempre es la del
      // último cierre: cuando el precio de hoy entró a la serie, el número que
      // se ve es de hoy. El encabezado de la región decía "cierre del lunes"
      // mientras los cuadros mostraban martes, porque miraba `ultimo_cierre` y
      // los cuadros miraban el precio. El estado sale de la MISMA fecha que el
      // número.
      fecha_dato: px.precio_fecha || ultimoDiaDeSerie(serie),
      // La moneda que manda es la que declaró la fuente. La esperada viaja al
      // lado para poder decirlo cuando no coinciden, en vez de elegir una.
      moneda: monedaReal,
      moneda_esperada: c.moneda,
      moneda_discrepa: monedaReal != null && monedaReal !== c.moneda,
      // La serie con la que se calcula el %: lleva el precio de hoy pegado
      // cuando es más nuevo que el último cierre.
      serie: px.serie,
      puntos: px.serie.length,
      ultimo_cierre: ultimoDiaDeSerie(serie),
      fuente: d.fuente || 'yahoo:v8/chart',
      fecha_fix: d.fecha_fix || null,
    });
  }

  return {
    regiones: regiones.map((r) => ({
      ...r,
      cuadros: porRegion.get(r.clave) || [],
      // El aviso de "cripto todavía no" se fue con Bitcoin: ya está en la
      // rejilla, así que decirlo sería falso.
      aviso: null,
    })),
    faltantes,
    solo_insumo: SOLO_INSUMO,
    fuente: 'yahoo:v8/chart vía /api/macro-markets (precio y serie; los % los calcula el navegador)',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REGIONES, CATALOGO, MONEDAS, TIRA, SOLO_INSUMO,
    ultimoDiaDeSerie, diaDe, serieConPrecio, armaMundo };
}
