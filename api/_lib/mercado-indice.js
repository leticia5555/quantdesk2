// ═══════════════════════════════════════════════════════════════════════
// api/_lib/mercado-indice.js — R4: la ficha de índice (artboard 6).
//
// TODO ACÁ ES PURO: entra una serie, salen números. Ni red, ni Neon, ni
// `Date.now()`. Es lo que permite probar la media de 200 días y la
// volatilidad con una serie escrita a mano, en vez de contra el mercado de
// ayer — una prueba que depende del mercado no distingue un bug de un martes.
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO:
//   · no calcula NINGÚN porcentaje de periodo. Eso es `qdPeriodChange`
//     (regla 1) y vive en `qd-periods.js`, que la pantalla ya carga;
//   · no dibuja líneas de tendencia ni detecta patrones. El encargo las deja
//     fuera con todas las letras: "una línea mal trazada es un número mal".
//     Acá sólo hay medias, máximos, mínimos y desviación — aritmética sobre
//     cierres, no interpretación.
// ═══════════════════════════════════════════════════════════════════════

/**
 * LOS NUEVE ÍNDICES DE R4.
 *
 * `etf` es el que lo replica y `sic` dice si se compra en México por el SIC —
 * los dos son datos de la ficha, no adorno. Lo que no sabemos de verdad se
 * queda en null y la pantalla lo dice.
 */
export const INDICES = [
  { id: 'SPX', symbol: '^GSPC', nombre: 'S&P 500', pais: 'EE.UU.', bolsa: 'nyse', moneda: 'USD',
    etf: 'IVV / SPY / VOO', holdings: 'sp500', sic: true },
  { id: 'NDX', symbol: '^NDX', nombre: 'Nasdaq 100', pais: 'EE.UU.', bolsa: 'nyse', moneda: 'USD',
    etf: 'QQQ', holdings: 'nasdaq100', sic: true },
  { id: 'DJI', symbol: '^DJI', nombre: 'Dow Jones', pais: 'EE.UU.', bolsa: 'nyse', moneda: 'USD',
    etf: 'DIA', holdings: null, sic: true },
  { id: 'IPC', symbol: '^MXX', nombre: 'IPC', pais: 'México', bolsa: 'bmv', moneda: 'MXN',
    etf: 'NAFTRAC', holdings: null, sic: false },
  { id: 'BOVESPA', symbol: '^BVSP', nombre: 'Bovespa', pais: 'Brasil', bolsa: 'saopaulo', moneda: 'BRL',
    etf: 'BOVA11 / EWZ', holdings: null, sic: true },
  { id: 'KOSPI', symbol: '^KS11', nombre: 'KOSPI', pais: 'Corea', bolsa: 'seul', moneda: 'KRW',
    etf: 'EWY', holdings: null, sic: true },
  { id: 'NIKKEI', symbol: '^N225', nombre: 'Nikkei 225', pais: 'Japón', bolsa: 'tokio', moneda: 'JPY',
    etf: 'EWJ', holdings: null, sic: true },
  { id: 'DAX', symbol: '^GDAXI', nombre: 'DAX', pais: 'Alemania', bolsa: 'francfort', moneda: 'EUR',
    etf: 'EWG', holdings: null, sic: true },
  { id: 'HSI', symbol: '^HSI', nombre: 'Hang Seng', pais: 'Hong Kong', bolsa: 'hongkong', moneda: 'HKD',
    etf: 'EWH', holdings: null, sic: true },
];

export const POR_ID = Object.fromEntries(INDICES.map((i) => [i.id, i]));

/** El índice pedido, o null. Nunca "el primero" como consuelo. */
export function indiceDe(id) {
  return POR_ID[String(id || '').toUpperCase()] || null;
}

const cierre = (p) => (p && Number.isFinite(p.c) ? p.c : (p && Number.isFinite(p.close) ? p.close : null));

/**
 * MEDIA MÓVIL SIMPLE de `n` cierres, alineada al final.
 *
 * Devuelve un arreglo del mismo largo que la serie, con `null` donde todavía
 * no hay `n` puntos. El null NO es un hueco que la pantalla tape: es la
 * declaración de que ahí la media no existe. Una media de 200 días dibujada
 * sobre 60 puntos es una línea inventada.
 */
export function mediaMovil(serie, n) {
  const out = new Array((serie || []).length).fill(null);
  if (!Array.isArray(serie) || !n || n < 1) return out;
  let suma = 0;
  let dentro = 0;
  for (let i = 0; i < serie.length; i++) {
    const c = cierre(serie[i]);
    // Un punto sin cierre rompe la ventana: se reinicia en vez de arrastrar
    // una suma que ya no corresponde a `n` puntos.
    if (!Number.isFinite(c)) { suma = 0; dentro = 0; continue; }
    suma += c; dentro++;
    if (dentro > n) { const viejo = cierre(serie[i - n]); suma -= Number.isFinite(viejo) ? viejo : 0; dentro = n; }
    if (dentro === n) out[i] = suma / n;
  }
  return out;
}

/** El último valor no nulo de una media, con cuántos puntos hicieron falta. */
export function ultimaMedia(serie, n) {
  const m = mediaMovil(serie, n);
  for (let i = m.length - 1; i >= 0; i--) if (m[i] != null) return { valor: m[i], en: i };
  return {
    valor: null,
    en: null,
    motivo: `la serie trae ${(serie || []).length} cierres y la media de ${n} días necesita ${n}`,
  };
}

/**
 * MÁXIMO Y MÍNIMO DE 52 SEMANAS, y la distancia al máximo.
 *
 * `dias` es la ventana en SESIONES, no en días naturales: 252 es el año
 * bursátil. Si la serie trae menos, se dice cuántas hay en vez de llamar
 * "52 semanas" a ocho meses.
 */
export function rango52(serie, { dias = 252 } = {}) {
  const puntos = (serie || []).map((p) => ({ t: p.t, c: cierre(p) })).filter((p) => Number.isFinite(p.c));
  if (!puntos.length) return { max: null, min: null, motivo: 'la serie no trae ningún cierre' };
  const ventana = puntos.slice(-dias);
  let max = ventana[0]; let min = ventana[0];
  for (const p of ventana) { if (p.c > max.c) max = p; if (p.c < min.c) min = p; }
  const ultimo = ventana[ventana.length - 1];
  return {
    max: max.c, max_t: max.t, min: min.c, min_t: min.t,
    ultimo: ultimo.c,
    sesiones: ventana.length,
    completa: ventana.length >= dias,
    // Negativa = por debajo del máximo. Se guarda con signo para que la
    // pantalla no tenga que decidir cómo leerla.
    desde_max_pct: max.c > 0 ? ((ultimo.c - max.c) / max.c) * 100 : null,
    desde_min_pct: min.c > 0 ? ((ultimo.c - min.c) / min.c) * 100 : null,
    motivo: ventana.length >= dias ? null
      : `la ventana trae ${ventana.length} sesiones de las ${dias} de un año bursátil`,
  };
}

/**
 * VOLATILIDAD DE 30 SESIONES, ANUALIZADA.
 *
 * Desviación estándar de los rendimientos LOGARÍTMICOS diarios × √252. El log
 * y no la diferencia porcentual porque es lo que hace que la medida sea
 * simétrica: +10% y −10% tienen que pesar igual, y con rendimientos simples
 * no pesan.
 *
 * Se usa la desviación MUESTRAL (n−1): son una muestra de los rendimientos
 * posibles, no la población entera.
 */
export function volatilidad(serie, { ventana = 30, anualizar = 252 } = {}) {
  const cierres = (serie || []).map(cierre).filter((c) => Number.isFinite(c) && c > 0);
  if (cierres.length < ventana + 1) {
    return {
      pct: null,
      motivo: `hacen falta ${ventana + 1} cierres y hay ${cierres.length}`,
    };
  }
  const usados = cierres.slice(-(ventana + 1));
  const rend = [];
  for (let i = 1; i < usados.length; i++) rend.push(Math.log(usados[i] / usados[i - 1]));
  const media = rend.reduce((a, b) => a + b, 0) / rend.length;
  const varianza = rend.reduce((a, r) => a + (r - media) ** 2, 0) / (rend.length - 1);
  return {
    pct: Math.sqrt(varianza) * Math.sqrt(anualizar) * 100,
    ventana,
    fuente: 'calc',
    metodo: `desviación de ${rend.length} rendimientos logarítmicos diarios × √${anualizar}`,
    motivo: null,
  };
}

/** ¿Arriba o abajo de su media? Con la distancia, que es lo accionable. */
export function contraMedia(serie, n) {
  const m = ultimaMedia(serie, n);
  const cierres = (serie || []).map(cierre).filter(Number.isFinite);
  const ultimo = cierres.length ? cierres[cierres.length - 1] : null;
  if (m.valor == null || ultimo == null) {
    return { media: null, pct: null, arriba: null, motivo: m.motivo || 'la serie no trae cierres' };
  }
  return {
    media: m.valor,
    pct: ((ultimo - m.valor) / m.valor) * 100,
    arriba: ultimo >= m.valor,
    motivo: null,
  };
}

/**
 * LOS PESOS DE LOS COMPONENTES, declarados como lo que son.
 *
 * El peso OFICIAL de un índice lo publica quien lo calcula, y no lo tenemos.
 * Lo que sí tenemos es la capitalización verificada de parte de los miembros,
 * y de ahí sale un peso POR CAPITALIZACIÓN — que para un índice ponderado por
 * capitalización se le parece mucho, pero NO es el mismo número.
 *
 * Por eso esta función devuelve `metodo: 'cap'` y la cobertura: cuántos
 * miembros tienen cap verificada y qué parte de la capitalización total
 * representan. Un peso sin cobertura declarada es un peso inventado.
 */
export function pesosPorCapitalizacion(miembros, caps, { tope = 12 } = {}) {
  const lista = (miembros || []).map((s) => String(s).toUpperCase());
  const conCap = lista.map((s) => ({ symbol: s, cap: Number(caps && caps[s]) }))
    .filter((x) => Number.isFinite(x.cap) && x.cap > 0);
  if (!conCap.length) {
    return {
      componentes: [], metodo: 'cap', cubiertos: 0, miembros: lista.length, cap_total: null,
      motivo: lista.length
        ? `tenemos la lista de ${lista.length} miembros pero ninguno con capitalización verificada`
        : 'no tenemos la lista de miembros de este índice',
    };
  }
  const total = conCap.reduce((a, b) => a + b.cap, 0);
  conCap.sort((a, b) => b.cap - a.cap);
  const arriba = conCap.slice(0, tope).map((x) => ({ ...x, peso_pct: (x.cap / total) * 100 }));
  const resto = conCap.slice(tope);
  return {
    componentes: arriba,
    resto: resto.length,
    resto_pct: resto.length ? (resto.reduce((a, b) => a + b.cap, 0) / total) * 100 : 0,
    metodo: 'cap',
    fuente: 'calc · peso por capitalización verificada, NO el peso oficial del índice',
    cubiertos: conCap.length,
    miembros: lista.length,
    cap_total: total,
    cobertura_pct: lista.length ? (conCap.length / lista.length) * 100 : null,
    motivo: conCap.length < lista.length
      ? `${conCap.length} de ${lista.length} miembros tienen capitalización verificada; los demás no pesan en esta tira`
      : null,
  };
}

/**
 * Los periodos de la tabla de rendimiento, y cuáles PUEDE calcular la serie.
 *
 * La tabla del artboard tiene una fila por periodo; con un año de historia,
 * 3A y 5A no existen. Se devuelven igual, marcados, para que la pantalla
 * pinte la fila con su causa en vez de esconderla: una tabla a la que le
 * faltan filas sin decirlo se lee como si esos periodos no importaran.
 */
export const PERIODOS_FICHA = ['1D', '1S', '1M', '3M', '6M', 'YTD', '1A', '3A', '5A'];

/**
 * `periodosDisponibles` SE FUE, Y NO SE REEMPLAZA.
 *
 * Era una tabla propia de sesiones mínimas —`{'1A': 252, '3A': 756…}`— o sea
 * una SEGUNDA opinión sobre la misma pregunta que contesta `qdPeriodChange`.
 * Y las dos no coincidían: ésta decía que con 252 cierres "1A" alcanzaba, y
 * el calculador devolvía "—". La ficha pinta lo que dice el calculador, así
 * que la discrepancia salía en pantalla (Lety, 2026-10-21).
 *
 * No se delega al calculador desde acá porque `qd-periods.js` es un
 * `<script>` clásico y traerlo pediría `createRequire(import.meta.url)`, y
 * `import.meta` está prohibido en `api/`: tumbó `/api/arena-universe` el
 * 2026-09-15 y hay una prueba que lo vigila.
 *
 * Tampoco hacía falta: ni el endpoint ni la pantalla la llamaban. La pantalla
 * ya pinta las nueve filas y deja que `qdPeriodChange` diga cuál alcanza y
 * cuál no, que es exactamente lo que esta función intentaba adivinar por su
 * cuenta. Dos tablas decidiendo lo mismo es el bug que este proyecto ya pagó
 * dos veces (#241 y #245).
 */

/**
 * LA SERIE DEL ÍNDICE, EXPRESADA EN OTRA MONEDA.
 *
 * Lo pide el toggle USD|MXN del artboard 6, y existe porque un toggle que no
 * hace nada es un bug —ya pasó con el de moneda en el mapa de México—.
 *
 * Cada cierre se multiplica por el tipo de cambio DE SU DÍA, no por el último:
 * convertir un año de historia con el dólar de hoy daría una curva con la
 * forma correcta y los niveles equivocados, y el cambio de un periodo saldría
 * idéntico al local — o sea, el toggle seguiría sin hacer nada.
 *
 * El tipo de cambio se arrastra hacia adelante (el último conocido ≤ la fecha
 * del cierre) porque el FIX no se publica los días inhábiles mientras que la
 * bolsa de otro país sí opera. Lo que NO se hace es arrastrarlo hacia ATRÁS:
 * un cierre anterior al primer tipo de cambio conocido se descarta y se
 * cuenta, en vez de inventarle un cambio que todavía no existía.
 *
 * `fx` son puntos {t, c} con el MISMO formato que la serie, en unidades de la
 * moneda destino por una unidad de la moneda origen.
 */
export function serieConvertida(velas, fx) {
  const puntos = (fx || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.c) && p.c > 0)
    .sort((a, b) => a.t - b.t);
  if (puntos.length < 2) {
    return { velas: [], descartadas: 0, motivo: `el tipo de cambio trae ${puntos.length} punto(s): sin dos no hay con qué convertir una serie` };
  }
  const out = [];
  let descartadas = 0;
  let i = 0;
  for (const v of velas || []) {
    const t = Number(v.time ?? v.t);
    if (!Number.isFinite(t)) { descartadas++; continue; }
    // Avanza el cursor del FX hasta el último punto ≤ t.
    while (i + 1 < puntos.length && puntos[i + 1].t <= t) i++;
    if (puntos[i].t > t) { descartadas++; continue; }   // antes del primer FX conocido
    const k = puntos[i].c;
    const conv = { time: t };
    for (const campo of ['open', 'high', 'low', 'close']) {
      if (Number.isFinite(v[campo])) conv[campo] = v[campo] * k;
    }
    if (!Number.isFinite(conv.close)) {
      const c = Number(v.c);
      if (Number.isFinite(c)) conv.close = c * k; else { descartadas++; continue; }
    }
    out.push(conv);
  }
  return {
    velas: out,
    descartadas,
    motivo: descartadas
      ? `${descartadas} cierre(s) quedaron fuera: son anteriores al primer tipo de cambio conocido`
      : null,
  };
}
