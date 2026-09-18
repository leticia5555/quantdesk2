// ═══════════════════════════════════════════════════════════════════
// api/_lib/bmv-rotation.js — Fase B: la rotación Value + Momentum sobre BMV.
//
// Lógica PURA, cero I/O. Todo lo que decide el veredicto vive acá y se puede
// correr con datos de juguete en un test; el endpoint sólo trae filas de Neon
// y las pasa por estas funciones.
//
// LOS CRITERIOS NO SE DEFINEN AQUÍ: se importan de `bmv-elegibilidad.js` o se
// declaran como constantes que copian, número por número, lo congelado en
// docs/bmv-rotation.md §3. El diff contra ese documento es la verificación —
// si alguien afloja un umbral, el diff lo enseña.
//
// Lo que este archivo NO hace, y es deliberado:
//   · No filtra retornos, no recorta colas, no quita "outliers".
//   · No elige entre especificaciones. El caso base es UNO; las
//     sensibilidades (§3.5) son atribución y NUNCA promueven un veredicto.
//   · No convierte moneda. Los repartos en USD/EUR quedan fuera y se reporta
//     cuántos puntos base de retorno se dejaron sin contar (§3.3).
// ═══════════════════════════════════════════════════════════════════

import {
  LAG_DIAS, UMBRAL_IMPORTE, PISO_CANASTA, TECHO_CANASTA, FRACCION_QUINTIL,
  TRIMESTRES_TTM, SERIES_SIN_PRECIOS, mediana, sumaDias, tamanoCanasta,
  etiquetaDeRegimen,
} from './bmv-elegibilidad.js';

import { media, desvest, tStat, sharpeAnual, maxDrawdown } from './pead-analyze.js';

/* ═══════════════ los criterios congelados (§3.3, §3.4, §3.5) ═══════════════ */

const COSTO_BP_POR_LADO = 10;          // §3.3 — sobre el turnover real
const DIAS_ANIO = 252;                 // convención de la casa
const MIN_REBALANCEOS = 30;            // §3.4 puerta 1
const MIN_UNIVERSO_MEDIANO = 16;       // §3.4 puerta 1
const UMBRAL_T = 2;                    // §3.4 puerta 2
const UMBRAL_T_FRAGIL = 2.5;           // §3.4 — GO FRÁGIL por debajo de esto
const PRIMA_SHARPE = 0.15;             // §3.4 puerta 3 — sobre el Sharpe de NAFTRAC
const FRACCION_DECIL = 0.10;           // §3.5 sensibilidad
const LAG_SENSIBILIDAD = 90;           // §3.5 sensibilidad
const UMBRAL_BP_DIVISA = 50;           // §3.3 — por serie, acumulado

// Los meses de momentum, literales de §3.3: «12-1 sobre precios diarios (de
// t−12m a t−1m)». Se restan al día de REBALANCEO, no al ancla de precio, para
// que la definición no dependa de dónde caiga el calendario.
const MOM_DESDE_MESES = 12;
const MOM_HASTA_MESES = 1;

// Cuántos meses hacia atrás se puede arrastrar un cierre para las anclas de
// momentum. Existe porque una serie puede no haber operado en un mes suelto;
// sin arrastre, un hueco de un día mataría el momentum de un nombre vivo.
// Con más de esto, el precio ya no describe al nombre y el momentum sería
// invención: se devuelve null y el nombre no entra (no se rellena con cero).
const MAX_ARRASTRE_MESES = 1;

/* ═══════════════ calendario mensual ═══════════════ */

/** Mes como entero comparable: 2020-03 → 24243. Evita comparar cadenas. */
function mesIndice(fecha) {
  const a = Number(String(fecha).slice(0, 4));
  const m = Number(String(fecha).slice(5, 7));
  if (!Number.isFinite(a) || !Number.isFinite(m)) return null;
  return a * 12 + (m - 1);
}

/**
 * Resta meses a 'AAAA-MM-DD' sin desbordar el día.
 *
 * `new Date(2020,0,31)` menos un mes daría 2 de marzo en aritmética ingenua.
 * Acá el día se recorta al último del mes destino, que es lo que uno quiere
 * decir con «hace un mes».
 */
function restaMeses(fecha, meses) {
  const a = Number(String(fecha).slice(0, 4));
  const m = Number(String(fecha).slice(5, 7));
  const d = Number(String(fecha).slice(8, 10));
  if (!Number.isFinite(a) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const total = a * 12 + (m - 1) - meses;
  const a2 = Math.floor(total / 12);
  const m2 = (total % 12 + 12) % 12;
  const ultimo = new Date(Date.UTC(a2, m2 + 1, 0)).getUTCDate();
  const d2 = Math.min(d, ultimo);
  return `${String(a2).padStart(4, '0')}-${String(m2 + 1).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
}

/**
 * El último cierre mensual con fecha ≤ `limite`, con arrastre acotado.
 *
 * `cierresMensuales` es un Map mes(int) → {fecha, cierre}: un renglón por mes
 * con el ÚLTIMO día operado de ese mes. Para un rebalanceo en el primer día
 * hábil del mes M, el cierre del día anterior ES el cierre mensual de M−1;
 * por eso el mismo mapa sirve para el precio del ranking y para las anclas de
 * momentum, sin traerse 462,000 filas diarias.
 */
function cierreMensualHasta(cierresMensuales, limite, maxArrastre = MAX_ARRASTRE_MESES) {
  const objetivo = mesIndice(limite);
  if (objetivo === null) return null;
  for (let k = 0; k <= maxArrastre; k++) {
    const c = cierresMensuales.get(objetivo - k);
    // Un cierre del propio mes objetivo puede ser POSTERIOR al límite (el
    // límite cae a media mes). En ese caso no sirve: usarlo sería mirar
    // precios que en la fecha del ranking todavía no existían.
    if (c && c.fecha <= limite) return c;
  }
  return null;
}

/* ═══════════════ value: EPS TTM con el corte de 65 días ═══════════════ */

/**
 * EPS TTM point-in-time: la suma de los `trimestres` cierres más recientes
 * cuya **fecha de cierre + lag ≤ fecha de rebalanceo** (§3.2).
 *
 * `cierres` viene ordenado ascendente por fecha y trae el EPS **total**
 * (`basicearningslosspershare`), no el de operaciones continuas — §3.2
 * congela esa decisión y la razón de peso es que el total es el único campo
 * que todas las emisoras traen.
 *
 * Devuelve también la antigüedad del trimestre más viejo de los cuatro. NO se
 * usa para filtrar —§3.2 no pone tope de antigüedad y no se toca un criterio
 * congelado— pero sí se reporta: un TTM armado con trimestres de hace cuatro
 * años describe a una empresa que ya no existe, y eso el lector tiene que
 * poder verlo.
 */
function epsTtm(cierres, fecha, { lagDias = LAG_DIAS, trimestres = TRIMESTRES_TTM } = {}) {
  const corte = sumaDias(fecha, -lagDias);
  if (corte === null) return null;
  const usables = [];
  for (let i = cierres.length - 1; i >= 0 && usables.length < trimestres; i--) {
    if (cierres[i].fecha_cierre <= corte) usables.push(cierres[i]);
  }
  if (usables.length < trimestres) return null;
  let suma = 0;
  for (const c of usables) {
    if (c.eps === null || c.eps === undefined || !Number.isFinite(Number(c.eps))) return null;
    suma += Number(c.eps);
  }
  const masViejo = usables[usables.length - 1].fecha_cierre;
  return {
    eps_ttm: suma,
    cierres: usables.map((c) => c.fecha_cierre).reverse(),
    antiguedad_dias: Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${masViejo}T00:00:00Z`)) / 86400000),
  };
}

/* ═══════════════ momentum 12-1 ═══════════════ */

/** Retorno de t−12m a t−1m sobre cierres mensuales (§3.3). */
function momentum121(cierresMensuales, fecha) {
  const ini = cierreMensualHasta(cierresMensuales, restaMeses(fecha, MOM_DESDE_MESES));
  const fin = cierreMensualHasta(cierresMensuales, restaMeses(fecha, MOM_HASTA_MESES));
  if (!ini || !fin) return null;
  if (!(ini.cierre > 0) || !(fin.cierre > 0)) return null;
  if (fin.fecha <= ini.fecha) return null;
  return fin.cierre / ini.cierre - 1;
}

/* ═══════════════ ranks percentiles ═══════════════ */

/**
 * Rank percentil en [0,1] con empates promediados.
 *
 * El score es el promedio de los DOS ranks, no de los dos valores crudos
 * (§3.3): un earnings yield y un retorno a 11 meses no viven en la misma
 * escala, y promediarlos crudos dejaría que el de mayor varianza mande solo.
 */
function rankPercentil(valores) {
  const n = valores.length;
  if (!n) return [];
  if (n === 1) return [0.5];
  const orden = valores.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && orden[j + 1][0] === orden[i][0]) j++;
    const rango = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[orden[k][1]] = rango;
    i = j + 1;
  }
  return out;
}

/* ═══════════════ canastas ═══════════════ */

/**
 * Las canastas de cada rebalanceo.
 *
 * Población elegible, en este orden (§3.1, §3.2, §3.3):
 *   1. serie ICS del censo, menos las que no tienen precios (§5.8);
 *   2. EPS TTM completo con el corte de cierre + 65 días;
 *   3. precio del ranking = cierre del día anterior (= cierre mensual de M−1);
 *   4. momentum 12-1 calculable;
 *   5. mediana de importe operado de 3 meses ≥ umbral.
 *
 * Las TRES variantes de score (combo / value / momentum) comparten
 * EXACTAMENTE la misma población: si cada pierna corriera sobre su propio
 * universo, la diferencia entre ellas mezclaría señal con cobertura de datos
 * y no diría nada sobre la señal.
 */
function construyeCanastas({
  fechas, series, epsPorEmisora, mensualesPorSerie, medianas,
  umbralImporte = UMBRAL_IMPORTE, lagDias = LAG_DIAS,
  fraccion = FRACCION_QUINTIL, score = 'combo',
  excluidas = SERIES_SIN_PRECIOS,
} = {}) {
  const universo = series.filter((s) => !excluidas.has(s.emisora_serie));
  const motivos = {
    sin_ttm: 0, sin_precio_ranking: 0, sin_momentum: 0, sin_importe: 0, iliquida: 0,
  };
  const canastas = [];

  for (const fecha of fechas) {
    const elegibles = [];
    for (const s of universo) {
      const cierres = epsPorEmisora.get(s.emisora);
      const ttm = cierres ? epsTtm(cierres, fecha, { lagDias }) : null;
      if (!ttm) { motivos.sin_ttm += 1; continue; }

      const mensuales = mensualesPorSerie.get(s.emisora_serie);
      if (!mensuales) { motivos.sin_precio_ranking += 1; continue; }

      // El precio del ranking es el cierre del día ANTERIOR al rebalanceo
      // (§3.3): la canasta tiene que quedar armada antes de la sesión en que
      // se ejecuta, o el backtest no es replicable en vivo.
      //
      // Como los rebalanceos son el PRIMER día operado de cada mes —así los
      // define `fechasRebalanceo`, agrupando por mes y tomando el mínimo—, el
      // día operado anterior es exactamente el ÚLTIMO del mes previo, que es
      // justo lo que guarda el mapa mensual. Se toma así, por índice de mes, y
      // no restándole un día a la fecha: el 1 de julio de 2017 cae en sábado y
      // «fecha − 1 día» seguiría cayendo en julio, donde el único cierre
      // mensual es el del 31 — un precio del FUTURO.
      const previo = mensuales.get(mesIndice(fecha) - 1);
      // La red que sobrevive a cualquier cambio de arriba: el precio del
      // ranking tiene que ser anterior al rebalanceo. Si algún día las fechas
      // dejan de ser el primer día del mes, esto falla cerrado en vez de
      // colarse con un cierre del mismo día.
      if (!previo || !(previo.cierre > 0) || !(previo.fecha < fecha)) {
        motivos.sin_precio_ranking += 1; continue;
      }

      const mom = momentum121(mensuales, fecha);
      if (mom === null) { motivos.sin_momentum += 1; continue; }

      const med = medianas.get(`${fecha}|${s.emisora_serie}`);
      if (med === null || med === undefined) { motivos.sin_importe += 1; continue; }
      if (med < umbralImporte) { motivos.iliquida += 1; continue; }

      elegibles.push({
        emisora_serie: s.emisora_serie,
        emisora: s.emisora,
        // Value = EPS TTM ÷ precio (§3.2). Se deja con su signo: un EPS
        // negativo es un yield negativo y su lugar es el fondo del ranking,
        // no fuera de la muestra.
        value: ttm.eps_ttm / previo.cierre,
        eps_ttm: ttm.eps_ttm,
        precio_ranking: previo.cierre,
        fecha_precio_ranking: previo.fecha,
        momentum: mom,
        antiguedad_ttm_dias: ttm.antiguedad_dias,
        importe_mediano: med,
      });
    }

    const rv = rankPercentil(elegibles.map((e) => e.value));
    const rm = rankPercentil(elegibles.map((e) => e.momentum));
    elegibles.forEach((e, i) => {
      e.rank_value = rv[i];
      e.rank_momentum = rm[i];
      e.score = score === 'value' ? rv[i] : score === 'momentum' ? rm[i] : (rv[i] + rm[i]) / 2;
    });

    const { canasta: n, regimen } = tamanoCanasta(elegibles.length, fraccion);
    const ordenados = elegibles.slice().sort((a, b) => b.score - a.score);
    canastas.push({
      fecha,
      elegibles: elegibles.length,
      tamano: n,
      regimen,
      nombres: ordenados.slice(0, n).map((e) => e.emisora_serie),
      detalle: ordenados.slice(0, n),
      antiguedad_ttm_mediana: mediana(elegibles.map((e) => e.antiguedad_ttm_dias)),
    });
  }

  return { canastas, motivos };
}

/* ═══════════════ la simulación ═══════════════ */

/**
 * Retorno diario de una serie entre dos días consecutivos de SU calendario.
 *
 * Con `conDividendos`, el reparto de la fecha ex entra al numerador: es el
 * retorno total (§3.3). Reinvertir en la fecha de PAGO adelantaría el flujo y
 * metería look-ahead por la puerta de atrás — justo lo que los 65 días cierran
 * del otro lado.
 */
function retornoDia(precioPrev, precio, dividendo = 0) {
  if (!(precioPrev > 0) || !(precio > 0)) return null;
  return (precio + dividendo) / precioPrev - 1;
}

/**
 * La curva de la canasta, día por día.
 *
 * Mecánica, y por qué así:
 *   · El ranking usa el cierre de t−1 y la ejecución es al CIERRE de t. En BMV
 *     no hay precio de apertura en la fuente (`/v2/historicos` devuelve
 *     `[cierre, importe]`), así que fingir una apertura sería inventar un
 *     dato. Cerrar contra cerrar es replicable: se calcula de noche, se opera
 *     durante la sesión, se marca al cierre.
 *   · Equal-weight EN EL REBALANCEO. Entre rebalanceos los pesos derivan con
 *     los precios, que es lo que de verdad le pasa a una cartera que no se
 *     toca.
 *   · El costo se cobra al cierre del día de rebalanceo, sobre el turnover
 *     REAL (Σ|peso objetivo − peso actual|), y sale del capital que se
 *     reinvierte. Financiarlo con caja negativa apalancaría la cartera por el
 *     monto de sus propias comisiones.
 *   · Un nombre sin precio ese día conserva su valor anterior (no cotizó); si
 *     nunca aparece, su parte se queda en EFECTIVO en vez de desaparecer —
 *     hacerla desaparecer le regalaría retorno a la curva.
 */
function simula({
  canastas, calendario, preciosPorSerie, dividendosPorSerie = new Map(),
  costoBp = COSTO_BP_POR_LADO, conDividendos = true,
}) {
  if (!canastas.length || !calendario.length) return null;
  const porFecha = new Map(canastas.map((c) => [c.fecha, c]));
  const iInicio = calendario.indexOf(canastas[0].fecha);
  if (iInicio < 0) return null;
  const costo = costoBp / 10000;

  let efectivo = 1;
  const posiciones = new Map();      // serie → { titulos, ultimoPrecio }
  const retornos = [];
  const fechas = [];
  const curva = [];
  const turnovers = [];
  let costoTotal = 0;
  let equityPrev = 1;
  let dividendosCobrados = 0;

  const precioDe = (serie, fecha) => {
    const m = preciosPorSerie.get(serie);
    const p = m ? m.get(fecha) : undefined;
    return p === undefined || p === null || !(p > 0) ? null : p;
  };
  const dividendoDe = (serie, fecha) => {
    if (!conDividendos) return 0;
    const m = dividendosPorSerie.get(serie);
    const d = m ? m.get(fecha) : undefined;
    return d === undefined || d === null ? 0 : Number(d);
  };

  for (let i = iInicio; i < calendario.length; i++) {
    const fecha = calendario[i];

    // ── 1. Marca a mercado del día: precios y dividendo de la fecha ex ──
    for (const [serie, pos] of posiciones) {
      const px = precioDe(serie, fecha);
      const div = dividendoDe(serie, fecha);
      if (div > 0) {
        // El reparto se reinvierte en la MISMA serie, en la fecha ex: es lo
        // que hace un índice de retorno total, y es lo que hace el benchmark.
        const base = px !== null ? px : pos.ultimoPrecio;
        if (base > 0) {
          pos.titulos += (pos.titulos * div) / base;
          dividendosCobrados += pos.titulos * div;
        }
      }
      if (px !== null) pos.ultimoPrecio = px;
    }

    const valorPosiciones = () => {
      let v = 0;
      for (const pos of posiciones.values()) v += pos.titulos * pos.ultimoPrecio;
      return v;
    };

    // ── 2. Rebalanceo, al cierre del día ──
    const c = porFecha.get(fecha);
    if (c) {
      const equityAntes = efectivo + valorPosiciones();
      // Un nombre sin precio hoy NO se puede negociar: se arrastra con su
      // último precio y su notional sale del reparto, en vez de fingir que se
      // vendió a un precio que nadie vio.
      const negociables = c.nombres.filter((s) => precioDe(s, fecha) !== null);
      let arrastrado = 0;
      for (const [serie, pos] of posiciones) {
        if (precioDe(serie, fecha) === null) arrastrado += pos.titulos * pos.ultimoPrecio;
      }
      const repartible = Math.max(0, equityAntes - arrastrado);
      const porNombre = negociables.length ? repartible / negociables.length : 0;

      // Turnover real sobre los pesos OBJETIVO, antes del costo.
      const objetivo = new Map(negociables.map((s) => [s, porNombre]));
      let negociado = 0;
      for (const [serie, pos] of posiciones) {
        if (precioDe(serie, fecha) === null) continue;
        negociado += Math.abs((objetivo.get(serie) || 0) - pos.titulos * pos.ultimoPrecio);
      }
      for (const [serie, notional] of objetivo) {
        if (!posiciones.has(serie)) negociado += notional;
      }
      const costoRebal = costo * negociado;
      costoTotal += costoRebal;
      turnovers.push(equityAntes > 0 ? negociado / equityAntes : 0);

      const asignable = Math.max(0, repartible - costoRebal);
      const porNombreNeto = negociables.length ? asignable / negociables.length : 0;
      for (const serie of [...posiciones.keys()]) {
        if (precioDe(serie, fecha) !== null) posiciones.delete(serie);
      }
      let asignado = 0;
      for (const serie of negociables) {
        const px = precioDe(serie, fecha);
        if (porNombreNeto <= 0) continue;
        posiciones.set(serie, { titulos: porNombreNeto / px, ultimoPrecio: px });
        asignado += porNombreNeto;
      }
      efectivo = Math.max(0, asignable - asignado);
    }

    // ── 3. Cierre del día ──
    const equity = efectivo + valorPosiciones();
    curva.push({ fecha, equity });
    retornos.push(equityPrev > 0 ? equity / equityPrev - 1 : 0);
    fechas.push(fecha);
    equityPrev = equity;
  }

  return {
    fechas,
    retornos,
    curva,
    equity_final: equityPrev,
    costo_total: costoTotal,
    dividendos_reinvertidos: dividendosCobrados,
    turnover_medio: media(turnovers),
    turnover_mediana: mediana(turnovers),
    max_drawdown: maxDrawdown(curva.map((x) => x.equity)),
  };
}

/**
 * La serie del benchmark, alineada a las MISMAS fechas de la canasta.
 *
 * Alinear importa: un t de exceso calculado sobre calendarios distintos
 * compara días que no son el mismo día.
 */
function serieBenchmark({ precios, dividendos = new Map(), fechas, conDividendos = true }) {
  const retornos = [];
  const curva = [];
  let equity = 1;
  let prev = null;
  for (const fecha of fechas) {
    const px = precios.get(fecha);
    const div = conDividendos ? Number(dividendos.get(fecha) || 0) : 0;
    if (px === undefined || px === null || !(px > 0)) {
      retornos.push(0);
      curva.push({ fecha, equity });
      continue;
    }
    const r = prev === null ? 0 : retornoDia(prev, px, div);
    const rr = r === null ? 0 : r;
    equity *= 1 + rr;
    retornos.push(rr);
    curva.push({ fecha, equity });
    prev = px;
  }
  return { fechas, retornos, curva, equity_final: equity, max_drawdown: maxDrawdown(curva.map((x) => x.equity)) };
}

/* ═══════════════ estadísticas y veredicto ═══════════════ */

/** Retorno anualizado compuesto desde retornos diarios. */
function anualizado(retornos) {
  if (!retornos.length) return null;
  const total = retornos.reduce((a, r) => a * (1 + r), 1);
  if (total <= 0) return -1;
  return total ** (DIAS_ANIO / retornos.length) - 1;
}

/**
 * El exceso diario en CALENDAR-TIME (§3.4): la diferencia día a día entre la
 * canasta y el benchmark, no la diferencia de dos promedios. Es la que tiene
 * un t interpretable, porque cada día es una observación.
 */
function excesoDiario(retCanasta, retBenchmark) {
  const n = Math.min(retCanasta.length, retBenchmark.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = retCanasta[i] - retBenchmark[i];
  return out;
}

function estadisticas(retornos, curva = null) {
  return {
    dias: retornos.length,
    retorno_anualizado: anualizado(retornos),
    vol_anualizada: retornos.length > 1 ? desvest(retornos) * Math.sqrt(DIAS_ANIO) : null,
    sharpe: sharpeAnual(retornos),
    max_drawdown: curva ? maxDrawdown(curva.map((x) => x.equity)) : null,
  };
}

/**
 * La etiqueta de régimen (§3.4) leída sobre las canastas de ESTA corrida.
 *
 * Es la misma función que usa `?job=elegibilidad`, a propósito: el régimen que
 * reporta la Fase B y el que anticipó la elegibilidad tienen que ser el mismo
 * número calculado por el mismo código, o uno de los dos miente.
 */
function regimenDeCanastas(canastas) {
  return etiquetaDeRegimen(canastas);
}

/**
 * El veredicto, con las tres puertas de §3.4 y la advertencia de signo.
 *
 * **La advertencia de signo no es decorativa.** Un |t| alto sólo dice que el
 * exceso no es ruido — no dice de qué lado está. Un t significativo con exceso
 * NEGATIVO no es GO: es un NO-GO fuerte. Se calcula acá, no se deja al lector.
 */
function veredicto({
  exceso, sharpeCanasta, sharpeBenchmark, rebalanceos, universoMediano, regimen,
}) {
  const t = tStat(exceso);
  const excesoMedio = t.media;
  const primaSharpe = (sharpeCanasta === null || sharpeBenchmark === null)
    ? null : sharpeCanasta - sharpeBenchmark;

  const puertas = [];
  puertas.push({
    puerta: `rebalanceos ≥ ${MIN_REBALANCEOS}`,
    valor: rebalanceos,
    pasa: rebalanceos >= MIN_REBALANCEOS,
    consecuencia: rebalanceos >= MIN_REBALANCEOS ? null : 'INCONCLUSO por muestra insuficiente',
  });
  puertas.push({
    puerta: `universo elegible mediano ≥ ${MIN_UNIVERSO_MEDIANO}`,
    valor: universoMediano,
    pasa: universoMediano !== null && universoMediano >= MIN_UNIVERSO_MEDIANO,
    consecuencia: universoMediano !== null && universoMediano >= MIN_UNIVERSO_MEDIANO
      ? null : 'INCONCLUSO por universo insuficiente',
  });
  puertas.push({
    puerta: `|t| ≥ ${UMBRAL_T} del exceso diario vs NAFTRAC`,
    valor: t.t,
    pasa: t.t !== null && Math.abs(t.t) >= UMBRAL_T,
    consecuencia: null,
  });
  puertas.push({
    puerta: `Sharpe neto ≥ NAFTRAC + ${PRIMA_SHARPE}`,
    valor: primaSharpe,
    pasa: primaSharpe !== null && primaSharpe >= PRIMA_SHARPE,
    consecuencia: null,
  });

  const inconcluso = puertas.filter((p) => !p.pasa && /INCONCLUSO/.test(p.consecuencia || ''));
  const señal = t.t !== null && Math.abs(t.t) >= UMBRAL_T;
  const economia = primaSharpe !== null && primaSharpe >= PRIMA_SHARPE;
  // El signo se evalúa ANTES de decidir: un exceso negativo no puede producir
  // un GO por más que |t| y la prima de Sharpe pasen.
  const signoNegativo = excesoMedio !== null && excesoMedio < 0;

  let dictamen;
  let porque;
  if (inconcluso.length) {
    dictamen = 'INCONCLUSO';
    porque = inconcluso.map((p) => p.consecuencia).join('; ');
  } else if (señal && signoNegativo) {
    dictamen = 'NO-GO FUERTE';
    porque = 'el exceso es SIGNIFICATIVO y NEGATIVO: la canasta pierde contra NAFTRAC de forma que no es ruido';
  } else if (señal && economia) {
    dictamen = (t.t !== null && Math.abs(t.t) < UMBRAL_T_FRAGIL) ? 'GO FRÁGIL' : 'GO';
    porque = dictamen === 'GO FRÁGIL'
      ? `|t| = ${Math.abs(t.t).toFixed(2)} pasa el 2 pero no llega a ${UMBRAL_T_FRAGIL}`
      : 'señal y economía pasan las dos';
  } else {
    dictamen = 'NO-GO';
    porque = !señal && !economia ? 'no pasa ni señal ni economía'
      : !señal ? 'el exceso no se distingue del ruido' : 'el exceso no paga la prima de Sharpe exigida';
  }

  return {
    dictamen,
    porque,
    etiqueta_regimen: regimen ? regimen.etiqueta : null,
    observacion_regimen: regimen ? regimen.observacion : null,
    t: t.t,
    exceso_medio_diario: excesoMedio,
    exceso_anualizado: excesoMedio === null ? null : excesoMedio * DIAS_ANIO,
    sharpe_canasta: sharpeCanasta,
    sharpe_benchmark: sharpeBenchmark,
    prima_sharpe: primaSharpe,
    puertas,
    advertencia_signo: señal && signoNegativo
      ? '⚠️ EXCESO SIGNIFICATIVO Y NEGATIVO — esto NO es GO, es un NO-GO fuerte.'
      : 'Un |t| alto no dice de qué lado está el exceso. Acá el signo se verificó explícitamente.',
  };
}

/* ═══════════════ los bp que quedaron sin contar ═══════════════ */

/**
 * Puntos base de retorno NO contados por los repartos en moneda extranjera
 * (§3.3): `Σ (monto / precio_en_fecha_ex) × 10,000`, por serie.
 *
 * Se divide entre el precio de la fecha ex porque eso es lo que el reparto
 * habría valido como rendimiento ese día — el mismo instante en que se habría
 * reinvertido.
 */
function bpNoContados(filas, { umbral = UMBRAL_BP_DIVISA } = {}) {
  const porSerie = new Map();
  let sinPrecio = 0;
  for (const f of filas) {
    const px = Number(f.precio);
    const monto = Number(f.monto);
    if (!(px > 0) || !Number.isFinite(monto)) { sinPrecio += 1; continue; }
    const bp = (monto / px) * 10000;
    const prev = porSerie.get(f.emisora_serie) || { emisora_serie: f.emisora_serie, bp: 0, repartos: 0, divisas: new Set() };
    prev.bp += bp;
    prev.repartos += 1;
    if (f.divisa) prev.divisas.add(f.divisa);
    porSerie.set(f.emisora_serie, prev);
  }
  const series = [...porSerie.values()]
    .map((s) => ({ ...s, divisas: [...s.divisas].sort(), supera_umbral: s.bp > umbral }))
    .sort((a, b) => b.bp - a.bp);
  return {
    umbral_bp: umbral,
    total_bp: series.reduce((a, s) => a + s.bp, 0),
    series,
    series_sobre_umbral: series.filter((s) => s.supera_umbral).map((s) => s.emisora_serie),
    repartos_sin_precio_en_fecha_ex: sinPrecio,
  };
}

export {
  COSTO_BP_POR_LADO, DIAS_ANIO, MIN_REBALANCEOS, MIN_UNIVERSO_MEDIANO,
  UMBRAL_T, UMBRAL_T_FRAGIL, PRIMA_SHARPE, FRACCION_DECIL, LAG_SENSIBILIDAD,
  UMBRAL_BP_DIVISA, MOM_DESDE_MESES, MOM_HASTA_MESES, MAX_ARRASTRE_MESES,
  anualizado, bpNoContados, cierreMensualHasta, construyeCanastas, epsTtm,
  estadisticas, excesoDiario, mesIndice, momentum121, rankPercentil,
  regimenDeCanastas, restaMeses, retornoDia, serieBenchmark, simula, veredicto,
};
