// ═══════════════════════════════════════════════════════════════════
// api/_lib/rotation-analyze.js — candidato a Agente #7 v2:
// ¿la rotación mensual Value + Momentum bate al SPY de forma OPERABLE?
//
// Lógica PURA (cero I/O): recibe los EPS trimestrales de `pead_earnings`
// (con su `reported_date`) + las velas diarias ajustadas de Yahoo, y
// devuelve el veredicto contra umbrales FIJADOS ANTES DE CORRER (§CRITERIOS).
// El endpoint /api/rotation-analyze solo hace de plomería (SELECT + fetch).
// Mismo playbook que /api/pead-analyze: los umbrales se congelan en código,
// las sensibilidades son las pre-registradas, y todo corte extra va
// etiquetado EXPLORATORIO y NO cuenta para el veredicto.
//
// ── La única especificación principal ──────────────────────────────
//   Universo : los símbolos con historial de EPS en `pead_earnings` (~98).
//   Rebalanceo: primer día hábil del mes, FILLS A LA APERTURA.
//   Value    : earnings yield POINT-IN-TIME = (suma de los EPS de los 4
//              trimestres cuyo reported_date es ANTERIOR a la fecha de
//              rebalanceo) / precio. CERO look-ahead: es la regla dura.
//   Momentum : 12-1 = retorno de t−12m a t−1m (se salta el último mes).
//   Score    : promedio de los dos ranks PERCENTILES dentro del rebalanceo.
//   Cartera  : decil superior (~10 nombres), equal-weight.
//   Costos   : 10 bp por lado sobre el TURNOVER REAL de cada rebalanceo
//              (Σ|Δnotional| / equity, que ya cuenta compras Y ventas).
//
// ── El "precio de ese día" es el CIERRE ANTERIOR, y por qué ────────
// El encargo dice "dividido entre el precio de ese día". Se usa el CIERRE DE
// LA SESIÓN ANTERIOR, no el open del propio día de rebalanceo: la canasta
// tiene que quedar armada ANTES de la apertura en la que se ejecuta. Con el
// open del mismo día el ranking solo se podría calcular en el instante del
// fill (o después), y el backtest dejaría de ser replicable en vivo. La
// diferencia económica es un gap overnight; se mide igual, como corte
// EXPLORATORIO (yield contra el open) para que quede a la vista.
//
// ── Por qué calendar-time y no promedio por canasta ────────────────
// El t del §2 sale de la serie DIARIA de retorno anormal (cartera − SPY) de
// la cartera efectivamente rotada. Es la misma convención que el PEAD: un t
// sobre 36 retornos mensuales de canastas solapadas exagera la significancia.
// Y como en el PEAD, el t del §2 se mide BRUTO — los costos son el §3.
//
// ── SESGO DE SUPERVIVENCIA (caveat pre-registrado) ─────────────────
// El universo es la lista de HOY mirada hacia atrás: los nombres que
// quebraron o fueron deslistados no están. Eso INFLA los resultados. Por eso
// el umbral económico lleva margen (SPY + 2 puntos porcentuales) y un GO
// marginal (t apenas arriba de 2) se reporta como GO FRÁGIL.
// ═══════════════════════════════════════════════════════════════════

import {
  media, mediana, desvest, tStat, sharpeAnual, maxDrawdown,
  alineaAlCalendario, cierreVigente, recortaVelasIncompletas,
} from './pead-analyze.js';

// ─────────────────── CRITERIOS (congelados) ───────────────────
// Se exportan para que el test los verifique y para que salgan en el JSON:
// si alguien los mueve después de ver los números, el diff lo delata.
const CRITERIOS = {
  // §1 — MUESTRA. Si no se cumple → INCONCLUSO (no NO-GO: NO-GO afirmaría
  // que la estrategia no sirve, y sin muestra no se afirma nada).
  min_rebalanceos: 30,            // rebalanceos mensuales COMPLETOS (con periodo cerrado)
  min_nombres_promedio: 8,        // nombres promedio por canasta

  // §2 — SEÑAL. |t| del retorno anormal diario vs SPY (calendar-time, bruto).
  t_minimo: 2,

  // §3 — ECONOMÍA (significancia económica, no solo estadística).
  sharpe_min: 0.9,                // Sharpe NETO anualizado de la estrategia
  exceso_anual_min: 0.02,         // retorno neto anualizado ≥ SPY + 2 pp

  // §4 — GO FRÁGIL: un t apenas arriba del umbral, con el sesgo de
  // supervivencia inflando por detrás, no es un GO limpio.
  t_go_fragil_max: 2.5,

  // Construcción de la cartera.
  fraccion_decil: 0.10,           // top decil (~10 nombres de ~98)
  fraccion_quintil: 0.20,         // sensibilidad obligatoria
  meses_rebalanceo: 1,
  meses_rebalanceo_sensibilidad: 2,
  momentum_desde_meses: 12,       // 12-1: de t−12m …
  momentum_hasta_meses: 1,        // … a t−1m
  costo_por_lado: 0.0010,         // 10 bp
  anios_ventana: 3,               // universo de HOY ⇒ ~3 años (docs/pead-backtest-scope.md §2.2)

  // TTM point-in-time: qué se acepta como "4 trimestres buenos".
  ttm_trimestres: 4,
  max_dias_desde_ultimo_reporte: 200,  // sin reporte en ~7 meses → dato rancio, fuera
  max_span_ttm_dias: 500,              // 4 trimestres tienen que caber en ~16 meses

  // Piso de elegibles para EJECUTAR un rebalanceo. Con ~98 símbolos esto solo
  // se dispara si los datos están rotos; ahí el rebalanceo se salta (se
  // arrastra la canasta anterior) y se CUENTA — no se inventa una canasta de 2.
  min_elegibles_rebalanceo: 20,
};

const DIA_MS = 86400000;

// ─────────────────── utilidades de fecha/calendario ───────────────────

// 'YYYY-MM-DD' menos N meses, con clamp de fin de mes (31 − 1 mes → 28/29/30).
function restaMeses(fecha, meses) {
  const d = new Date(fecha + 'T00:00:00Z');
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString().slice(0, 10);
}

const diasEntre = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA_MS;

// Último índice del calendario con fecha <= `fecha` (−1 si no hay).
// Binaria: corre una vez por símbolo por rebalanceo.
function indiceHasta(calendario, fecha) {
  let lo = 0, hi = calendario.length - 1, out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (calendario[mid] <= fecha) { out = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return out;
}

// Índices del PRIMER DÍA HÁBIL de cada mes en el calendario (el de SPY).
// El índice 0 se salta a propósito: el calendario puede empezar a mitad de
// mes y ese día NO es el primer hábil de su mes — sería un rebalanceo falso.
// `cadaMeses` toma 1 de cada N (rebalanceo bimestral = la sensibilidad §4).
function primerosHabilesDelMes(calendario, { desde = null, cadaMeses = 1 } = {}) {
  const primeros = [];
  for (let i = 1; i < calendario.length; i++) {
    if (calendario[i].slice(0, 7) !== calendario[i - 1].slice(0, 7)) primeros.push(i);
  }
  const enVentana = desde ? primeros.filter((i) => calendario[i] >= desde) : primeros;
  return cadaMeses <= 1 ? enVentana : enVentana.filter((_, k) => k % cadaMeses === 0);
}

// ─────────────────── value: TTM EPS point-in-time ───────────────────

// LA REGLA DURA. Sólo se suman trimestres cuyo `reported_date` es ESTRICTAMENTE
// ANTERIOR a la fecha de rebalanceo: un reporte del mismo día puede haber salido
// después de la apertura en la que compramos, y no hay hora en esta tabla.
// A lo sumo se entra un mes tarde; nunca antes de que el dato existiera.
//
// Devuelve {ttm, motivo}. `motivo` no-nulo = por qué NO hay TTM, y se cuenta:
// un símbolo que desaparece en silencio es una muestra distinta a la reportada.
//   pocos_trimestres  — menos de 4 reportes previos (nombre nuevo / cosecha corta)
//   eps_nulo          — alguno de los 4 viene sin reported_eps
//   trimestres_duplicados — dos filas del mismo fiscal_date_ending (restatement)
//   rancio            — el último reporte tiene más de max_dias_desde_ultimo_reporte
//   span_excedido     — los 4 no caben en max_span_ttm_dias (falta un trimestre)
function ttmPointInTime(eventosSym, fecha, criterios = CRITERIOS) {
  const n = criterios.ttm_trimestres;
  const previos = [];
  for (const e of eventosSym) {
    if (e.reported_date >= fecha) break;   // eventosSym viene ordenado asc
    previos.push(e);
  }
  if (previos.length < n) return { ttm: null, motivo: 'pocos_trimestres' };
  const ult = previos.slice(-n);
  if (ult.some((e) => !Number.isFinite(e.reported_eps))) return { ttm: null, motivo: 'eps_nulo' };
  if (new Set(ult.map((e) => e.fiscal_date_ending)).size !== n) {
    return { ttm: null, motivo: 'trimestres_duplicados' };
  }
  const ultimo = ult[n - 1].reported_date;
  if (diasEntre(ultimo, fecha) > criterios.max_dias_desde_ultimo_reporte) {
    return { ttm: null, motivo: 'rancio' };
  }
  if (diasEntre(ult[0].reported_date, ultimo) > criterios.max_span_ttm_dias) {
    return { ttm: null, motivo: 'span_excedido' };
  }
  return {
    ttm: ult.reduce((s, e) => s + e.reported_eps, 0),
    ultimo_reporte: ultimo,
    motivo: null,
  };
}

// ─────────────────── momentum 12-1 ───────────────────

// Retorno de t−12m a t−1m. Se SALTA el último mes (la reversión de corto plazo
// contamina el momentum). Ambos extremos usan el último cierre conocido <= la
// fecha objetivo; si el símbolo no cotizaba todavía, cierreVigente devuelve
// null y el nombre queda fuera (contado como sin_momentum).
function momentum121(closes, fecha, criterios = CRITERIOS, calendario) {
  const fIni = restaMeses(fecha, criterios.momentum_desde_meses);
  const fFin = restaMeses(fecha, criterios.momentum_hasta_meses);
  const iIni = indiceHasta(calendario, fIni);
  const iFin = indiceHasta(calendario, fFin);
  if (iIni < 0 || iFin <= iIni) return null;
  const pIni = cierreVigente(closes, iIni);
  const pFin = cierreVigente(closes, iFin);
  if (pIni == null || pFin == null || pIni <= 0) return null;
  return pFin / pIni - 1;
}

// ─────────────────── ranks percentiles ───────────────────

// Rank percentil en [0,1] con empates promediados. El score combinado es el
// PROMEDIO de los dos ranks (no de los dos valores crudos): un earnings yield
// y un retorno a 11 meses no viven en la misma escala, promediarlos crudos
// dejaría que el de mayor varianza mande solo.
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

// ─────────────────── canastas ───────────────────

// Para cada rebalanceo: elegibles → ranks → score → top `fraccion`.
//
// Las TRES variantes de score (combo / value / momentum) comparten EXACTAMENTE
// la misma población elegible: un nombre entra solo si tiene TTM válido Y
// momentum válido Y precio. Así la comparación combo-vs-piernas aísla el
// score; si cada pierna corriera sobre su propio universo, la diferencia
// mezclaría señal con cobertura de datos y no diría nada.
function construyeCanastas({
  eventosPorSimbolo, simbolos, calendario, seriesAlineadas, iRebalanceos,
  criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil, score = 'combo',
  precioYield = 'cierre_previo',
}) {
  const motivos = {
    sin_serie: 0, sin_precio_previo: 0, sin_open_rebalanceo: 0, sin_eventos: 0,
    pocos_trimestres: 0, eps_nulo: 0, trimestres_duplicados: 0, rancio: 0,
    span_excedido: 0, sin_momentum: 0,
  };
  const canastas = [];
  const saltados = [];

  for (const i of iRebalanceos) {
    const fecha = calendario[i];
    const elegibles = [];
    for (const sym of simbolos) {
      const serie = seriesAlineadas[sym];
      if (!serie) { motivos.sin_serie++; continue; }
      // El fill es a la apertura: sin open ese día el nombre no es comprable.
      if (serie.opens[i] == null) { motivos.sin_open_rebalanceo++; continue; }
      // Precio del ranking = último cierre CONOCIDO antes de la apertura.
      // 'open' solo existe para el corte EXPLORATORIO (ver cabecera): el
      // ranking con el open del propio día no se puede armar antes del fill.
      const precio = precioYield === 'open' ? serie.opens[i] : cierreVigente(serie.closes, i - 1);
      if (precio == null || precio <= 0) { motivos.sin_precio_previo++; continue; }

      const evs = eventosPorSimbolo[sym];
      if (!evs || !evs.length) { motivos.sin_eventos++; continue; }
      const { ttm, motivo } = ttmPointInTime(evs, fecha, criterios);
      if (motivo) { motivos[motivo]++; continue; }

      const mom = momentum121(serie.closes, fecha, criterios, calendario);
      if (mom == null) { motivos.sin_momentum++; continue; }

      // Earnings yield: TTM EPS / precio. Un EPS negativo da yield negativo y
      // rankea abajo — es información real (la empresa perdió plata), no un
      // dato faltante, así que NO se descarta.
      elegibles.push({ symbol: sym, yield: ttm / precio, momentum: mom, ttm, precio });
    }

    if (elegibles.length < criterios.min_elegibles_rebalanceo) {
      saltados.push({ fecha, elegibles: elegibles.length });
      continue;
    }

    const rv = rankPercentil(elegibles.map((e) => e.yield));
    const rm = rankPercentil(elegibles.map((e) => e.momentum));
    for (let k = 0; k < elegibles.length; k++) {
      elegibles[k].rank_value = rv[k];
      elegibles[k].rank_momentum = rm[k];
      elegibles[k].score = score === 'value' ? rv[k]
        : score === 'momentum' ? rm[k]
        : (rv[k] + rm[k]) / 2;
    }
    // Desempate por símbolo: la corrida tiene que ser determinista.
    const ordenados = [...elegibles].sort((a, b) => (b.score - a.score) || (a.symbol < b.symbol ? -1 : 1));
    const k = Math.max(1, Math.round(elegibles.length * fraccion));
    const canasta = ordenados.slice(0, k);
    canastas.push({
      i, fecha, elegibles: elegibles.length,
      nombres: canasta.map((e) => e.symbol),
      detalle: canasta.map((e) => ({
        symbol: e.symbol, yield: e.yield, momentum: e.momentum,
        rank_value: e.rank_value, rank_momentum: e.rank_momentum, score: e.score,
      })),
    });
  }

  return { canastas, motivos, saltados };
}

// ─────────────────── simulación de la rotación ───────────────────

// Equal-weight, rebalanceo a la APERTURA del día objetivo, costo de 10 bp por
// lado sobre el turnover REAL (Σ|Δnotional|/equity — compras y ventas). Entre
// rebalanceos los pesos DERIVAN (no se re-equiponderan a diario: eso sería un
// turnover diario que nadie paga en el backtest y todos pagan en la vida).
//
// Un nombre en cartera sin open ese día no se puede vender: se ARRASTRA con su
// marca anterior y se cuenta. No se inventa una liquidación a un precio que no
// existió.
//
// RANURAS (opcional, `canasta.ranuras`). Por default el capital se reparte
// entre los nombres de la canasta: N nombres → 1/N cada uno. Si la canasta
// declara `ranuras`, el denominador es ESE número y no la cantidad de nombres,
// así que las ranuras sin nombre quedan en EFECTIVO. Lo usa el dual momentum
// para la variante Antonacci: un nombre recortado por el filtro de momentum
// absoluto deja su 1/N en efectivo en vez de que los sobrevivientes se lo
// repartan. Sin el campo el comportamiento es idéntico al de siempre — la
// rotación Value+Momentum no lo pasa y no cambia ni un decimal.
//
// Detalle declarado: si algún nombre se ARRASTRA (sin open, no negociable), su
// notional ya sale de `repartible` y el denominador de ranuras NO se reduce.
// Eso deja algo MÁS de efectivo del estrictamente necesario — el lado
// conservador del error, que es el correcto para una variante defensiva.
function simulaRotacion({ canastas, seriesAlineadas, calendario, costo = 0 }) {
  if (!canastas.length) return null;
  const porDia = new Map(canastas.map((c) => [c.i, c]));
  const iInicio = canastas[0].i;

  let cash = 1;
  let equity = 1;
  let equityPrev = 1;
  const pos = new Map();          // symbol → qty
  const retornos = [];            // retorno diario de la estrategia
  const fechas = [];
  const curva = [];
  const turnovers = [];
  let costoTotal = 0;
  let arrastresNoNegociables = 0;

  for (let d = iInicio; d < calendario.length; d++) {
    const c = porDia.get(d);
    if (c) {
      // ── Valuación al OPEN de d ──
      const marca = new Map();
      let valor = 0;
      for (const [sym, qty] of pos) {
        const s = seriesAlineadas[sym];
        const o = s.opens[d];
        const px = o != null ? o : cierreVigente(s.closes, d - 1);
        marca.set(sym, { px, negociable: o != null });
        valor += qty * px;
      }
      const equityOpen = cash + valor;

      // Lo que no se puede vender se queda: su notional sale del reparto.
      let valorArrastrado = 0;
      const arrastrados = new Set();
      for (const [sym, qty] of pos) {
        const m = marca.get(sym);
        if (!m.negociable) {
          arrastrados.add(sym);
          valorArrastrado += qty * m.px;
          arrastresNoNegociables++;
        }
      }

      const objetivoNombres = c.nombres.filter((s) => !arrastrados.has(s));
      const repartible = Math.max(0, equityOpen - valorArrastrado);
      // Sin `ranuras` el denominador es la cantidad de nombres (equal-weight de
      // toda la vida). Con `ranuras`, las que quedan sin nombre van a efectivo.
      const ranuras = Math.max(objetivoNombres.length, Number(c.ranuras) || 0);
      const porNombre = ranuras ? repartible / ranuras : 0;

      // ── Turnover REAL: Σ|notional objetivo − notional actual| ──
      // Se mide sobre los pesos objetivo ANTES del costo (los pesos que se
      // ordenan); el costo sale después, del notional efectivamente negociado.
      let negociado = 0;
      const objetivo = new Map(objetivoNombres.map((s) => [s, porNombre]));
      for (const [sym, qty] of pos) {
        if (arrastrados.has(sym)) continue;
        const actual = qty * marca.get(sym).px;
        negociado += Math.abs((objetivo.get(sym) || 0) - actual);
      }
      for (const [sym, notional] of objetivo) {
        if (!pos.has(sym)) negociado += notional;
      }

      const costoRebal = costo * negociado;
      costoTotal += costoRebal;
      turnovers.push(equityOpen > 0 ? negociado / equityOpen : 0);

      // ── Nuevas posiciones (los arrastrados conservan su qty) ──
      // El costo se descuenta del capital que se REINVIERTE, no se financia
      // con caja negativa: si no, la cartera quedaría apalancada por el monto
      // de sus propias comisiones y el turnover del siguiente rebalanceo
      // saldría inflado. equity_post = equity_open − costo, cash = 0.
      const asignable = Math.max(0, repartible - costoRebal);
      const porNombreNeto = ranuras ? asignable / ranuras : 0;
      for (const sym of [...pos.keys()]) if (!arrastrados.has(sym)) pos.delete(sym);
      let asignado = 0;
      for (const sym of objetivoNombres) {
        const px = seriesAlineadas[sym].opens[d];
        if (px == null || px <= 0 || porNombreNeto <= 0) continue;
        pos.set(sym, (pos.get(sym) || 0) + porNombreNeto / px);
        asignado += porNombreNeto;
      }
      // Lo que no se pudo colocar (canasta vacía, nombre sin open) se queda en
      // EFECTIVO. Ponerlo en cero haría desaparecer capital y le regalaría a la
      // curva un retorno que nadie ganó.
      cash = Math.max(0, asignable - asignado);
    }

    // ── Marca a mercado al CIERRE de d ──
    let valorCierre = 0;
    for (const [sym, qty] of pos) {
      const cl = cierreVigente(seriesAlineadas[sym].closes, d);
      valorCierre += qty * (cl == null ? 0 : cl);
    }
    equity = cash + valorCierre;
    curva.push({ fecha: calendario[d], equity });
    // El primer día se mide desde el OPEN (equity 1 al abrir), no desde un
    // cierre anterior en el que la cartera todavía no existía.
    retornos.push(equity / equityPrev - 1);
    fechas.push(calendario[d]);
    equityPrev = equity;
  }

  return {
    fechas, retornos, curva,
    equity_final: equity,
    costo_total: costoTotal,
    turnover_medio: media(turnovers),
    turnover_mediana: mediana(turnovers),
    arrastres_no_negociables: arrastresNoNegociables,
    max_drawdown: maxDrawdown(curva.map((c) => c.equity)),
  };
}

// Serie diaria de SPY alineada a los MISMOS días de la estrategia. El primer
// día se mide open→close (la estrategia entra en esa apertura); si se midiera
// close(d−1)→close(d) se le regalaría/quitaría a SPY un gap overnight que la
// cartera no vivió.
function serieSpy({ spyOpens, spyCloses, calendario, iInicio, nDias }) {
  const out = [];
  for (let k = 0; k < nDias; k++) {
    const d = iInicio + k;
    if (d >= calendario.length) break;
    const cl = cierreVigente(spyCloses, d);
    if (cl == null) { out.push(0); continue; }
    if (k === 0) {
      const op = spyOpens[d] != null ? spyOpens[d] : cierreVigente(spyCloses, d - 1);
      out.push(op ? cl / op - 1 : 0);
    } else {
      const prev = cierreVigente(spyCloses, d - 1);
      out.push(prev ? cl / prev - 1 : 0);
    }
  }
  return out;
}

// Retorno anualizado a partir de retornos diarios compuestos (252 sesiones).
function anualizado(retornos) {
  if (!retornos.length) return null;
  const total = retornos.reduce((a, r) => a * (1 + r), 1);
  if (total <= 0) return -1;
  return total ** (252 / retornos.length) - 1;
}

// ─────────────────── una especificación completa ───────────────────

function corre({
  eventosPorSimbolo, simbolos, calendario, seriesAlineadas, spyOpens, spyCloses,
  desde, criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil,
  score = 'combo', cadaMeses = CRITERIOS.meses_rebalanceo, etiqueta = 'principal',
  precioYield = 'cierre_previo',
}) {
  const iRebalanceos = primerosHabilesDelMes(calendario, { desde, cadaMeses });
  const { canastas, motivos, saltados } = construyeCanastas({
    eventosPorSimbolo, simbolos, calendario, seriesAlineadas, iRebalanceos,
    criterios, fraccion, score, precioYield,
  });

  const vacio = {
    etiqueta, score, fraccion, cada_meses: cadaMeses, precio_yield: precioYield,
    muestra: {
      rebalanceos_programados: iRebalanceos.length,
      rebalanceos_ejecutados: 0, rebalanceos_completos: 0,
      rebalanceos_saltados: saltados.length, saltados,
      nombres_promedio: null, elegibles_promedio: null,
      motivos_exclusion: motivos, rango: null,
    },
    senal: null, economia: null,
    cumple: { muestra: false, senal: false, economia: false },
    veredicto: 'INCONCLUSO', fragil: false,
  };
  if (!canastas.length) return vacio;

  const bruto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: 0 });
  const neto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: criterios.costo_por_lado });
  const spy = serieSpy({ spyOpens, spyCloses, calendario, iInicio: canastas[0].i, nDias: neto.retornos.length });

  // §2 — señal: abnormal calendar-time BRUTO (los costos son el §3, igual
  // que en el PEAD). El neto se reporta al lado, no se esconde.
  const abnormal = bruto.retornos.map((r, k) => r - (spy[k] ?? 0));
  const abnormalNeto = neto.retornos.map((r, k) => r - (spy[k] ?? 0));
  const t = tStat(abnormal);
  const tNeto = tStat(abnormalNeto);

  // §3 — economía, SIEMPRE neta de costos.
  const retAnualNeto = anualizado(neto.retornos);
  const retAnualSpy = anualizado(spy);
  const exceso = (retAnualNeto == null || retAnualSpy == null) ? null : retAnualNeto - retAnualSpy;
  const sharpeNeto = sharpeAnual(neto.retornos);

  // Un rebalanceo es COMPLETO si tiene otro rebalanceo después (su periodo de
  // tenencia se cerró). El último queda abierto contra el fin del calendario.
  const completos = Math.max(0, canastas.length - 1);
  const nombresProm = media(canastas.map((c) => c.nombres.length));

  const cumple = {
    muestra: completos >= criterios.min_rebalanceos
      && nombresProm != null && nombresProm >= criterios.min_nombres_promedio,
    senal: t.t != null && Math.abs(t.t) >= criterios.t_minimo,
    economia: sharpeNeto != null && sharpeNeto >= criterios.sharpe_min
      && exceso != null && exceso >= criterios.exceso_anual_min,
  };
  const veredicto = !cumple.muestra ? 'INCONCLUSO'
    : (cumple.senal && cumple.economia) ? 'GO' : 'NO-GO';
  // GO FRÁGIL: pasa, pero por poco — y el sesgo de supervivencia empuja para
  // el mismo lado. Se marca en el veredicto, no en una nota al pie.
  const fragil = veredicto === 'GO' && Math.abs(t.t) < criterios.t_go_fragil_max;

  return {
    etiqueta, score, fraccion, cada_meses: cadaMeses, precio_yield: precioYield,
    muestra: {
      rebalanceos_programados: iRebalanceos.length,
      rebalanceos_ejecutados: canastas.length,
      rebalanceos_completos: completos,
      rebalanceos_saltados: saltados.length,
      saltados,
      nombres_promedio: nombresProm,
      nombres_min: Math.min(...canastas.map((c) => c.nombres.length)),
      nombres_max: Math.max(...canastas.map((c) => c.nombres.length)),
      elegibles_promedio: media(canastas.map((c) => c.elegibles)),
      motivos_exclusion: motivos,
      rango: { desde: canastas[0].fecha, hasta: canastas[canastas.length - 1].fecha },
      dias_cartera: neto.retornos.length,
    },
    senal: {
      abnormal_diario_medio: t.media,
      t: t.t,
      abnormal_diario_medio_neto: tNeto.media,
      t_neto: tNeto.t,
      dias: t.n,
    },
    economia: {
      ret_anual_neto: retAnualNeto,
      ret_anual_spy: retAnualSpy,
      exceso_anual: exceso,
      sharpe_neto: sharpeNeto,
      sharpe_spy: sharpeAnual(spy),
      sharpe_bruto: sharpeAnual(bruto.retornos),
      ret_total_neto: neto.equity_final - 1,
      ret_total_bruto: bruto.equity_final - 1,
      max_drawdown: neto.max_drawdown,
      turnover_medio: neto.turnover_medio,
      turnover_mediana: neto.turnover_mediana,
      costo_total: neto.costo_total,
      arrastres_no_negociables: neto.arrastres_no_negociables,
    },
    cumple,
    veredicto,
    fragil,
    // Se puebla siempre; el endpoint lo borra salvo ?canastas=1.
    detalle_canastas: canastas,
  };
}

// ─────────────────── viabilidad de los datos ───────────────────

// La pregunta que hay que contestar ANTES de improvisar otra fuente: ¿el TTM
// point-in-time desde `pead_earnings` alcanza? Se contesta con la cobertura
// REAL medida en los rebalanceos, no con una impresión.
function viabilidadTtm(bloque, criterios = CRITERIOS) {
  const m = bloque.muestra;
  const elegibles = m.elegibles_promedio;
  const viable = m.rebalanceos_ejecutados > 0
    && elegibles != null && elegibles >= criterios.min_elegibles_rebalanceo
    && m.nombres_promedio != null && m.nombres_promedio >= criterios.min_nombres_promedio;
  const motivos = m.motivos_exclusion || {};
  const huecosTtm = (motivos.pocos_trimestres || 0) + (motivos.eps_nulo || 0)
    + (motivos.rancio || 0) + (motivos.span_excedido || 0) + (motivos.trimestres_duplicados || 0);
  return {
    viable,
    elegibles_promedio: elegibles,
    rebalanceos_saltados_por_falta_de_elegibles: m.rebalanceos_saltados,
    exclusiones_por_hueco_de_ttm: huecosTtm,
    exclusiones_por_momentum: motivos.sin_momentum || 0,
    exclusiones_por_precio: (motivos.sin_serie || 0) + (motivos.sin_precio_previo || 0) + (motivos.sin_open_rebalanceo || 0),
    detalle: motivos,
    nota: viable
      ? 'El TTM point-in-time desde pead_earnings alcanza: la canasta se arma con la cobertura medida arriba.'
      : 'HUECOS DE DATOS: el TTM point-in-time desde pead_earnings NO sostiene el backtest. '
        + 'Se reporta INCONCLUSO y NO se improvisa otra fuente de EPS.',
  };
}

// ─────────────────── resumen en español ───────────────────

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : (x * 100).toFixed(d) + '%');
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : x.toFixed(d));
const marca = (ok) => (ok ? '✅' : '❌');
const etiquetaVeredicto = (b) => (b.veredicto === 'GO' && b.fragil ? 'GO FRÁGIL' : b.veredicto);

// Una fila por criterio: qué pedía, qué salió, si pasa. Es la tabla que se
// mira primero, así que el umbral y el valor van pegados.
function filasCriterios(b, c) {
  const m = b.muestra, e = b.economia || {}, s = b.senal || {};
  return [
    ['1a · ≥ ' + c.min_rebalanceos + ' rebalanceos mensuales completos', String(m.rebalanceos_completos), m.rebalanceos_completos >= c.min_rebalanceos],
    ['1b · ≥ ' + c.min_nombres_promedio + ' nombres promedio por canasta', num(m.nombres_promedio, 1), m.nombres_promedio != null && m.nombres_promedio >= c.min_nombres_promedio],
    ['2 · t ≥ ' + c.t_minimo + ' en valor absoluto (abnormal diario vs SPY)', num(s.t), b.cumple.senal],
    ['3a · Sharpe neto ≥ ' + num(c.sharpe_min, 1), num(e.sharpe_neto), e.sharpe_neto != null && e.sharpe_neto >= c.sharpe_min],
    ['3b · Retorno neto anual ≥ SPY + ' + pct(c.exceso_anual_min, 0), pct(e.exceso_anual) + ' de exceso', e.exceso_anual != null && e.exceso_anual >= c.exceso_anual_min],
  ];
}

function bloqueCorto(titulo, b) {
  if (!b.senal) return `**${titulo}** → ${etiquetaVeredicto(b)} · sin canastas ejecutadas`;
  return `**${titulo}** → ${etiquetaVeredicto(b)}`
    + ` · rebalanceos ${b.muestra.rebalanceos_completos} · nombres ${num(b.muestra.nombres_promedio, 1)}`
    + ` · t ${num(b.senal.t)} · Sharpe neto ${num(b.economia.sharpe_neto)}`
    + ` · exceso ${pct(b.economia.exceso_anual)} · turnover ${pct(b.economia.turnover_medio, 0)}`;
}

function renderResumenMarkdown(s) {
  const c = s.criterios, p = s.principal, L = [];
  L.push('# Rotación Value + Momentum — ¿bate al SPY de forma operable?');
  L.push('');
  L.push(`**VEREDICTO: ${etiquetaVeredicto(p)}**`);
  L.push('');
  L.push(`Generado ${s.generado_en} · solo lectura · ventana ${s.datos.ventana_analisis.desde} → ${s.datos.ventana_analisis.hasta}`);
  L.push('');
  if (p.veredicto === 'GO' && p.fragil) {
    L.push(`> **GO FRÁGIL**: el t (${num(p.senal.t)}) apenas pasa el umbral de ${c.t_minimo}`);
    L.push(`> (por debajo de ${num(c.t_go_fragil_max, 1)}, el corte pre-registrado de fragilidad) y el sesgo de`);
    L.push('> supervivencia empuja para el mismo lado. No es un GO limpio.');
    L.push('');
  }
  L.push('## Especificación principal (una sola, fijada antes de correr)');
  L.push('');
  L.push(`- Universo: ${s.especificacion.universo}.`);
  L.push(`- Rebalanceo: ${s.especificacion.rebalanceo}.`);
  L.push(`- Value: ${s.especificacion.value}.`);
  L.push(`- Momentum: ${s.especificacion.momentum}.`);
  L.push(`- Score: ${s.especificacion.score}.`);
  L.push(`- Cartera: ${s.especificacion.cartera} · costos ${s.especificacion.costo_por_lado_bp} bp por lado sobre el turnover real.`);
  L.push(`- Benchmark: ${s.especificacion.benchmark}.`);
  L.push('');
  L.push('## Criterios de éxito (congelados en CRITERIOS antes de correr)');
  L.push('');
  L.push('| Criterio | Resultado | ¿Pasa? |');
  L.push('|---|---|---|');
  for (const [k, v, ok] of filasCriterios(p, c)) L.push(`| ${k} | ${v} | ${marca(ok)} |`);
  L.push('');
  L.push(`> Regla del veredicto: GO exige §2 **y** §3. Falla de muestra (§1) → INCONCLUSO`);
  L.push('> (no NO-GO: sin muestra no se afirma que la estrategia no sirve). El resto → NO-GO.');
  L.push('');
  // El §2 es de DOS COLAS (|t| ≥ 2): un t muy negativo lo "pasa" y sale ✅ en la
  // tabla. Es correcto — hay señal — pero la señal es que la cartera PIERDE
  // contra SPY, y eso no puede leerse como media victoria.
  if (p.senal && p.senal.t != null && p.senal.t <= -c.t_minimo) {
    L.push(`> ⚠️ El criterio §2 es de dos colas y este t es NEGATIVO (${num(p.senal.t)}): hay señal,`);
    L.push('> pero apunta en contra — la cartera rotada pierde contra SPY de forma significativa.');
    L.push('');
  }
  if (!p.cumple.muestra) {
    L.push(`> La muestra no alcanza: ${p.muestra.rebalanceos_completos} rebalanceos completos`);
    L.push(`> (piso ${c.min_rebalanceos}) y ${num(p.muestra.nombres_promedio, 1)} nombres promedio por canasta`);
    L.push(`> (piso ${c.min_nombres_promedio}). Por la regla fijada de antemano: **INCONCLUSO**, no "casi".`);
    L.push('');
  }
  L.push('## ¿El TTM point-in-time desde `pead_earnings` es viable?');
  L.push('');
  const v = s.viabilidad_ttm;
  L.push(`**${v.viable ? 'SÍ' : 'NO'}** — ${v.nota}`);
  L.push('');
  L.push(`- Elegibles promedio por rebalanceo: **${num(v.elegibles_promedio, 1)}** de ${s.datos.simbolos} símbolos del universo.`);
  L.push(`- Rebalanceos saltados por falta de elegibles (< ${c.min_elegibles_rebalanceo}): ${v.rebalanceos_saltados_por_falta_de_elegibles}`);
  L.push(`- Exclusiones acumuladas (símbolo × rebalanceo) por hueco de TTM: ${v.exclusiones_por_hueco_de_ttm}`
    + ` · por momentum: ${v.exclusiones_por_momentum} · por precio: ${v.exclusiones_por_precio}`);
  L.push(`- Desglose: ${Object.entries(v.detalle).map(([k, n]) => `${k}=${n}`).join(' · ')}`);
  L.push('');
  if (!p.senal) {
    // Sin un solo rebalanceo ejecutado no hay números que reportar: se corta
    // acá en vez de pintar "n/d" en veinte renglones.
    L.push('## Sin canastas ejecutadas');
    L.push('');
    L.push(`Ningún rebalanceo llegó al piso de ${c.min_elegibles_rebalanceo} nombres elegibles`);
    L.push(`(${p.muestra.rebalanceos_programados} programados, ${p.muestra.rebalanceos_saltados} saltados).`);
    L.push('No hay señal ni economía que medir: **INCONCLUSO**.');
    L.push('');
    L.push('## Caveat pre-registrado: sesgo de supervivencia');
    L.push('');
    L.push(s.caveat);
    L.push('');
    return L.join('\n');
  }
  L.push('## Muestra y cartera');
  L.push('');
  L.push(`- Símbolos con historial de EPS en \`pead_earnings\`: ${s.datos.simbolos}`
    + (s.datos.sin_precios.length ? ` · sin precios en Yahoo: ${s.datos.sin_precios.join(', ')}` : ''));
  L.push(`- Rebalanceos programados ${p.muestra.rebalanceos_programados} · ejecutados ${p.muestra.rebalanceos_ejecutados} · completos **${p.muestra.rebalanceos_completos}**`);
  L.push(`- Nombres por canasta: promedio **${num(p.muestra.nombres_promedio, 1)}** (min ${p.muestra.nombres_min} · max ${p.muestra.nombres_max})`);
  L.push(`- Rango operado: ${p.muestra.rango.desde} → ${p.muestra.rango.hasta} · ${p.muestra.dias_cartera} sesiones con cartera`);
  L.push('');
  L.push('## Señal (retorno anormal diario vs SPY, calendar-time)');
  L.push('');
  L.push(`- Abnormal diario medio (bruto): ${pct(p.senal.abnormal_diario_medio, 4)} · **t = ${num(p.senal.t)}**`);
  L.push(`- Neto de costos: ${pct(p.senal.abnormal_diario_medio_neto, 4)} · t = ${num(p.senal.t_neto)}`);
  L.push('');
  L.push('## Economía (siempre neta de costos)');
  L.push('');
  L.push(`- Retorno anualizado neto: **${pct(p.economia.ret_anual_neto)}** vs SPY ${pct(p.economia.ret_anual_spy)} → exceso **${pct(p.economia.exceso_anual)}**`);
  L.push(`- Sharpe neto: **${num(p.economia.sharpe_neto)}** (bruto ${num(p.economia.sharpe_bruto)} · SPY ${num(p.economia.sharpe_spy)})`);
  L.push(`- Retorno total neto ${pct(p.economia.ret_total_neto)} · max drawdown ${pct(p.economia.max_drawdown)}`);
  L.push(`- Turnover medio por rebalanceo: ${pct(p.economia.turnover_medio, 1)} (mediana ${pct(p.economia.turnover_mediana, 1)}) · costo acumulado ${pct(p.economia.costo_total, 2)} del capital inicial`);
  if (p.economia.arrastres_no_negociables) {
    L.push(`- Posiciones arrastradas por falta de apertura (no se pudieron rotar): ${p.economia.arrastres_no_negociables}`);
  }
  L.push('');
  L.push('## Sensibilidades obligatorias');
  L.push('');
  for (const b of s.sensibilidades) L.push(bloqueCorto(b.nombre, b.resultado) + '\n');
  L.push('> Lectura del combo vs las piernas: si una pierna sola iguala o supera al combo,');
  L.push('> el promedio de ranks no está aportando — está cargando a la pierna buena.');
  L.push('');
  if (s.nota_bimestral) { L.push('> ' + s.nota_bimestral); L.push(''); }
  L.push('## Cortes EXPLORATORIOS (no cuentan para el veredicto)');
  L.push('');
  for (const e of s.exploratorio) {
    L.push(`**[${e.etiqueta}] ${e.nombre}**`);
    L.push(`- Por qué: ${e.por_que}`);
    L.push(`- ${bloqueCorto('Resultado', e.resultado)}`);
    L.push('');
  }
  L.push('## Caveat pre-registrado: sesgo de supervivencia');
  L.push('');
  L.push(s.caveat);
  L.push('');
  return L.join('\n');
}

export {
  CRITERIOS, DIA_MS,
  restaMeses, diasEntre, indiceHasta, primerosHabilesDelMes,
  ttmPointInTime, momentum121, rankPercentil,
  construyeCanastas, simulaRotacion, serieSpy, anualizado,
  corre, viabilidadTtm,
  renderResumenMarkdown, filasCriterios, bloqueCorto, etiquetaVeredicto, pct, num,
  // re-exportadas para el endpoint (mismas primitivas que el PEAD)
  alineaAlCalendario, recortaVelasIncompletas, cierreVigente, media, mediana, desvest, tStat, sharpeAnual, maxDrawdown,
};
