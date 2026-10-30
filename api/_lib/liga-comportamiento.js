// ═══════════════════════════════════════════════════════════════
// api/_lib/liga-comportamiento.js — CÓMO juega cada agente, con Control al
// lado: la diferencia claude − control es el RUIDO del sistema (mismo modelo,
// mismo prompt, mismo enfoque), y cualquier diferencia entre dos modelos que
// no supere ese ruido no dice nada.
//
// SOLO LECTURA. Todo sale de lo que ya se guarda:
//   · las órdenes llenas y su resultado → vista `liga_decisiones`;
//   · el equity diario → `arena_equity_intraday`, la ÚLTIMA muestra de cada
//     sesión (el vigilante muestrea cada 5 min);
//   · los libros → `arena_journal.account` (snapshotCuenta: equity, cash,
//     holdings con qty y market_value) de cada corrida;
//   · aperturas del día y SPY → barras diarias de Alpaca.
//
// NULL CUANDO NO HAY DATOS, NUNCA 0. Un 0 en estas métricas es una afirmación
// ("no rotó", "no cayó", "no persigue"): solo sale cuando los datos lo dicen.
// Un día con equity y sin órdenes SÍ es rotación 0 — eso es un dato, no una
// ausencia.
//
// Este módulo es PURO: recibe los datos ya leídos y no toca la red. Lo que lee
// y de dónde está en api/liga-comportamiento.js.
// ═══════════════════════════════════════════════════════════════

import { enfoqueDelDia, ENFOQUES } from './arena-herding.js';

const num = (x) => (x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
const prom = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const DIA_MS = 86400000;

// Desviación estándar MUESTRAL (n − 1). Con menos de 2 puntos no existe.
function desvio(xs) {
  if (xs.length < 2) return null;
  const m = prom(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// La serie diaria ordenada, sin días repetidos ni equity inválido.
function serieDiaria(equityDiario) {
  const porDia = new Map();
  for (const d of equityDiario || []) {
    const e = num(d && d.equity);
    if (d && d.fecha && e != null && e > 0) porDia.set(String(d.fecha).slice(0, 10), { fecha: String(d.fecha).slice(0, 10), equity: e, cash: num(d.cash) });
  }
  return [...porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Retornos diarios entre sesiones CONSECUTIVAS de la serie (en fracción).
function retornosDiarios(serie) {
  const out = [];
  for (let i = 1; i < serie.length; i++) out.push({ fecha: serie[i].fecha, r: serie[i].equity / serie[i - 1].equity - 1 });
  return out;
}

// ── ROTACIÓN DIARIA ──────────────────────────────────────────────────
// % del equity movido por día = Σ |cantidad llena × precio| / equity del día.
// Un día con equity y sin órdenes es rotación 0 (dato). Un día con órdenes y
// sin equity guardado queda null (no se puede dividir por nada).
export function rotacion(fills, serie) {
  const nocional = new Map();
  for (const f of fills) {
    const v = Math.abs((num(f.cantidad) || 0) * (num(f.precio_ejecucion) || 0));
    nocional.set(f.dia_fill, (nocional.get(f.dia_fill) || 0) + v);
  }
  const equityDe = new Map(serie.map((d) => [d.fecha, d.equity]));
  const dias = [...new Set([...serie.map((d) => d.fecha), ...nocional.keys()])].sort();
  const por_dia = dias.map((fecha) => {
    const e = equityDe.get(fecha);
    const n = nocional.get(fecha) || 0;
    return { fecha, nocional_usd: r2(n), equity: e ?? null, rotacion_pct: e ? r2((n / e) * 100) : null };
  });
  const validos = por_dia.map((d) => d.rotacion_pct).filter((x) => x != null);
  return { promedio_pct: r2(prom(validos)), dias: validos.length, por_dia };
}

// ── ACIERTO A 5 SESIONES ─────────────────────────────────────────────
// De las COMPRAS con resultado a 5 sesiones: qué % terminó arriba, y el
// tamaño promedio del acierto (>0) contra el del error (<0).
export function acierto5(fills) {
  const rs = fills.filter((f) => f.lado === 'buy').map((f) => num(f.resultado_5_pct)).filter((x) => x != null);
  const ganan = rs.filter((x) => x > 0);
  const pierden = rs.filter((x) => x < 0);
  return {
    compras_medidas: rs.length,
    pct_arriba: rs.length ? r2((ganan.length / rs.length) * 100) : null,
    acierto_prom_pct: r2(prom(ganan)),
    error_prom_pct: r2(prom(pierden)),
  };
}

// ── DÍAS POR POSICIÓN ────────────────────────────────────────────────
// Episodios por símbolo con la cantidad CON SIGNO (compra +, venta −; los
// cortos son negativos): empieza cuando sale de 0 y termina cuando vuelve.
// El libro con el que arranca la ventana (el primer snapshot) inicializa la
// cantidad: esas posiciones se abrieron ANTES de que haya datos, así que su
// inicio es desconocido y NO entran al promedio (se cuentan aparte).
export function diasPorPosicion(fills, librosIniciales, ahora) {
  const qty = new Map();
  const inicio = new Map(); // null = abierta antes de la ventana
  for (const h of librosIniciales || []) {
    const q = num(h.qty);
    if (h.symbol && q) { qty.set(h.symbol, q); inicio.set(h.symbol, null); }
  }
  const cerradas = [];
  let cerradasSinInicio = 0;
  const orden = [...fills].sort((a, b) => String(a.filled_at).localeCompare(String(b.filled_at)));
  for (const f of orden) {
    const antes = qty.get(f.symbol) || 0;
    const despues = antes + (f.lado === 'sell' ? -1 : 1) * (num(f.cantidad) || 0);
    const t = Date.parse(f.filled_at);
    if (Math.abs(antes) < 1e-9 && Math.abs(despues) >= 1e-9) inicio.set(f.symbol, t);
    if (Math.abs(antes) >= 1e-9 && (Math.abs(despues) < 1e-9 || Math.sign(despues) !== Math.sign(antes))) {
      const t0 = inicio.get(f.symbol);
      if (t0 == null) cerradasSinInicio++; else cerradas.push((t - t0) / DIA_MS);
      // Cruzar de largo a corto en una sola orden abre un episodio nuevo.
      if (Math.abs(despues) >= 1e-9) inicio.set(f.symbol, t); else inicio.delete(f.symbol);
    }
    qty.set(f.symbol, despues);
  }
  const abiertas = [];
  let abiertasSinInicio = 0;
  const tAhora = ahora.getTime();
  for (const [s, q] of qty) {
    if (Math.abs(q) < 1e-9) continue;
    const t0 = inicio.get(s);
    if (t0 == null) abiertasSinInicio++; else abiertas.push((tAhora - t0) / DIA_MS);
  }
  return {
    cerradas: { n: cerradas.length, dias_prom: r2(prom(cerradas)), sin_inicio_conocido: cerradasSinInicio },
    abiertas: { n: abiertas.length, dias_prom: r2(prom(abiertas)), sin_inicio_conocido: abiertasSinInicio },
  };
}

// ── CONCENTRACIÓN ────────────────────────────────────────────────────
// Por día, el libro de la ÚLTIMA corrida (snapshot al inicio de esa corrida):
// peso máximo = |market_value| máximo / equity, y número de posiciones.
// Un día sin posiciones tiene 0 posiciones (dato) y peso máximo null (no hay
// "mayor posición" de un libro vacío).
export function concentracion(librosPorDia) {
  const por_dia = librosPorDia.map((l) => {
    const e = num(l.equity);
    const hs = (l.holdings || []).filter((h) => num(h.market_value) != null);
    const max = hs.length ? Math.max(...hs.map((h) => Math.abs(num(h.market_value)))) : null;
    return { fecha: l.fecha, posiciones: (l.holdings || []).length, peso_max_pct: max != null && e ? r2((max / e) * 100) : null };
  });
  const pesos = por_dia.map((d) => d.peso_max_pct).filter((x) => x != null);
  return {
    peso_max_prom_pct: r2(prom(pesos)),
    posiciones_prom: por_dia.length ? r2(prom(por_dia.map((d) => d.posiciones))) : null,
    dias: por_dia.length,
    por_dia,
  };
}

export function cajaPromedio(serie) {
  const xs = serie.filter((d) => d.cash != null).map((d) => (d.cash / d.equity) * 100);
  return { promedio_pct: r2(prom(xs)), dias: xs.length };
}

// ── CAÍDA MÁXIMA DESDE EL PICO ───────────────────────────────────────
// Sobre el equity diario. Con menos de 2 días no hay caída que medir.
export function caidaMaxima(serie) {
  if (serie.length < 2) return { pct: null, dias: serie.length };
  let pico = serie[0].equity;
  let peor = 0;
  let enPico = serie[0].fecha;
  let desde = null, hasta = null;
  for (const d of serie) {
    if (d.equity > pico) { pico = d.equity; enPico = d.fecha; }
    const c = (pico - d.equity) / pico;
    if (c > peor) { peor = c; desde = enPico; hasta = d.fecha; }
  }
  return { pct: r2(peor * 100), desde, hasta, dias: serie.length };
}

// ── SHARPE DIARIO, SIN ANUALIZAR ─────────────────────────────────────
// media / desvío de los retornos diarios. Sin tasa libre de riesgo y SIN
// anualizar (no se multiplica por √252): con días, no meses, de historia,
// anualizar inventa una precisión que no hay.
export function sharpeDiario(serie) {
  const rs = retornosDiarios(serie).map((x) => x.r);
  const s = desvio(rs);
  return {
    valor: s ? r4(prom(rs) / s) : null,
    retornos: rs.length,
    nota: 'diario, sin anualizar y sin tasa libre de riesgo: media / desvío muestral de los retornos diarios del equity.',
  };
}

// ── BETA CONTRA SPY ──────────────────────────────────────────────────
// cov(r_agente, r_spy) / var(r_spy), sobre los días en que existen los dos
// retornos (misma fecha, sesión anterior en las dos series).
export function betaSpy(serie, spyCierres) {
  const spy = new Map(Object.entries(spyCierres || {}).map(([f, c]) => [String(f).slice(0, 10), num(c)]).filter(([, c]) => c));
  const pares = [];
  for (let i = 1; i < serie.length; i++) {
    const a = spy.get(serie[i - 1].fecha), b = spy.get(serie[i].fecha);
    if (a && b) pares.push([serie[i].equity / serie[i - 1].equity - 1, b / a - 1]);
  }
  if (pares.length < 2) return { valor: null, dias: pares.length };
  const mx = prom(pares.map((p) => p[0])), my = prom(pares.map((p) => p[1]));
  const cov = pares.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / (pares.length - 1);
  const v = pares.reduce((s, [, y]) => s + (y - my) ** 2, 0) / (pares.length - 1);
  return { valor: v > 0 ? r4(cov / v) : null, dias: pares.length };
}

// ── ÍNDICE DE PERSECUCIÓN ────────────────────────────────────────────
// En las compras: (precio de ejecución − apertura del día) / apertura, en %.
// Positivo = compró por encima de cómo abrió el día (persiguió el movimiento).
export function persecucion(fills, aperturas) {
  const xs = [];
  for (const f of fills) {
    if (f.lado !== 'buy') continue;
    const o = num(aperturas && aperturas[f.symbol] && aperturas[f.symbol][f.dia_fill]);
    const p = num(f.precio_ejecucion);
    if (o && p) xs.push(((p - o) / o) * 100);
  }
  return { promedio_pct: r2(prom(xs)), compras_medidas: xs.length };
}

// ── RETORNO POR ENFOQUE ────────────────────────────────────────────────
// El enfoque de una compra es el ENFOQUE del agente el día del fill (rotativo y
// determinista: `enfoqueDelDia`; control hereda el de claude). Por enfoque: el
// resultado promedio de sus compras a 1 y a 5 sesiones (liga_decisiones).
export function retornoPorEnfoque(fills, agentId) {
  const out = {};
  for (const e of ENFOQUES) out[e.id] = { compras: 0, ret_1_prom_pct: null, ret_5_prom_pct: null, _r1: [], _r5: [] };
  for (const f of fills) {
    if (f.lado !== 'buy') continue;
    const enf = enfoqueDelDia(agentId, new Date(f.filled_at)).id;
    const b = out[enf];
    b.compras++;
    if (num(f.resultado_1_pct) != null) b._r1.push(num(f.resultado_1_pct));
    if (num(f.resultado_5_pct) != null) b._r5.push(num(f.resultado_5_pct));
  }
  for (const b of Object.values(out)) {
    b.ret_1_prom_pct = r2(prom(b._r1)); b.ret_5_prom_pct = r2(prom(b._r5));
    delete b._r1; delete b._r5;
  }
  return out;
}

// ── TODO JUNTO, PARA UN AGENTE ───────────────────────────────────────
// `datos`: { decisiones, equityDiario, libros: [{fecha, creado, equity, cash,
// holdings}], spy: {fecha: cierre}, aperturas: {SYM: {fecha: apertura}} }.
export function comportamientoDe(agentId, datos, { ahora = new Date() } = {}) {
  const fills = (datos.decisiones || []).filter((f) => f.agent_id === agentId);
  const serie = serieDiaria((datos.equityDiario || []).filter((d) => d.agent_id === agentId));
  const libros = (datos.libros || []).filter((l) => l.agent_id === agentId)
    .sort((a, b) => String(a.creado).localeCompare(String(b.creado)));
  // Último libro de cada día, y el PRIMERO de la ventana para las posiciones
  // heredadas.
  const ultimoDelDia = new Map();
  for (const l of libros) ultimoDelDia.set(l.fecha, l);
  return {
    rotacion: rotacion(fills, serie),
    acierto_5: acierto5(fills),
    dias_por_posicion: diasPorPosicion(fills, libros.length ? libros[0].holdings : [], ahora),
    concentracion: concentracion([...ultimoDelDia.values()]),
    caja: cajaPromedio(serie),
    caida_maxima: caidaMaxima(serie),
    sharpe: sharpeDiario(serie),
    beta_spy: betaSpy(serie, datos.spy),
    persecucion: persecucion(fills, datos.aperturas),
    retorno_por_enfoque: retornoPorEnfoque(fills, agentId),
  };
}

// Los números que se comparan contra Control, con la ruta a cada uno.
export const ESCALARES = [
  ['rotacion_prom_pct', (m) => m.rotacion.promedio_pct],
  ['acierto_5_pct_arriba', (m) => m.acierto_5.pct_arriba],
  ['acierto_5_prom_pct', (m) => m.acierto_5.acierto_prom_pct],
  ['error_5_prom_pct', (m) => m.acierto_5.error_prom_pct],
  ['dias_cerradas_prom', (m) => m.dias_por_posicion.cerradas.dias_prom],
  ['dias_abiertas_prom', (m) => m.dias_por_posicion.abiertas.dias_prom],
  ['peso_max_prom_pct', (m) => m.concentracion.peso_max_prom_pct],
  ['posiciones_prom', (m) => m.concentracion.posiciones_prom],
  ['caja_prom_pct', (m) => m.caja.promedio_pct],
  ['caida_maxima_pct', (m) => m.caida_maxima.pct],
  ['sharpe_diario', (m) => m.sharpe.valor],
  ['beta_spy', (m) => m.beta_spy.valor],
  ['persecucion_prom_pct', (m) => m.persecucion.promedio_pct],
  ...ENFOQUES.map((e) => [`enfoque_${e.id}_ret_1_pct`, (m) => m.retorno_por_enfoque[e.id].ret_1_prom_pct]),
  ...ENFOQUES.map((e) => [`enfoque_${e.id}_ret_5_pct`, (m) => m.retorno_por_enfoque[e.id].ret_5_prom_pct]),
];

// Agente y Control lado a lado: cada escalar con su valor, el de Control y la
// diferencia (null si falta cualquiera de los dos — nunca 0).
export function ladoALado(m, c) {
  const out = {};
  for (const [k, f] of ESCALARES) {
    const a = m ? f(m) : null, b = c ? f(c) : null;
    out[k] = { agente: a, control: b, diferencia: a != null && b != null ? r4(a - b) : null };
  }
  return out;
}
