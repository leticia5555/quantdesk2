// ═══════════════════════════════════════════════════════════════════
// api/_lib/dualmom-analyze.js — Dual Momentum con gate de tendencia:
// ¿es un agente DEFENSIVO que vale la pena (y sirve de evidencia para el
// breaker macro de la liga)?
//
// Lógica PURA (cero I/O): recibe el universo de símbolos + las velas diarias
// ajustadas de Yahoo y devuelve el veredicto contra umbrales FIJADOS ANTES DE
// CORRER (§CRITERIOS). El endpoint /api/dualmom-analyze solo hace de plomería
// (SELECT + fetch). Tercer backtest con el mismo playbook (PEAD → rotación →
// este): criterios congelados en código, sensibilidades pre-registradas, y
// todo corte extra etiquetado EXPLORATORIO que NO cuenta para el veredicto.
//
// Reusa la maquinaria de la rotación (_lib/rotation-analyze.js): el calendario
// de rebalanceos, el momentum 12-1, la simulación con costos sobre turnover
// real y la serie de SPY calendar-time son LOS MISMOS — si el motor cambia,
// cambia para los dos backtests a la vez y no se desincronizan.
//
// ── La única especificación principal ──────────────────────────────
//   Universo : el MISMO set de símbolos que rotation-analyze (los que tienen
//              historial de EPS en pead_earnings), por comparabilidad.
//   Rebalanceo: primer día hábil del mes, FILLS A LA APERTURA.
//   Selección: rank por momentum 12-1 → top decil (~10), equal-weight.
//   Filtro (a): momentum ABSOLUTO — un nombre solo entra si su propio 12-1 > 0.
//   Filtro (b): GATE MACRO — si SPY está debajo de su SMA de 200 días, la
//              cartera COMPLETA se va a efectivo ese mes (efectivo rinde 0).
//   Costos   : 10 bp por lado sobre el turnover real (irse a efectivo y volver
//              paga las dos veces — es justamente el costo de la defensa).
//
// ── El orden de los dos filtros IMPORTA (y está pre-registrado) ────
// Primero se corta el decil sobre TODOS los elegibles, y RECIÉN DESPUÉS se
// aplica el momentum absoluto. Al revés (rankear solo entre los positivos) la
// canasta tendría ~10 nombres siempre y el filtro absoluto no defendería de
// nada: en un mercado donde casi nada sube, el punto es quedarse con MENOS
// nombres, no con los diez menos malos.
//
// ── Sin look-ahead: la señal se lee al CIERRE ANTERIOR ─────────────
// El gate compara el cierre de la sesión PREVIA contra la SMA calculada hasta
// esa misma sesión, y se ejecuta en la apertura siguiente. Como el rebalanceo
// cae en el primer día hábil del mes, ese cierre previo es el ÚLTIMO DEL MES
// ANTERIOR: es exactamente la señal mensual clásica (Faber), y es la única
// versión implementable — el cierre del propio día de rebalanceo no existe
// todavía cuando hay que mandar la orden a la apertura. La variante literal
// ("el cierre de la fecha de rebalanceo") va como corte EXPLORATORIO para
// medir cuánto cambiaría un dato que no se conoce a tiempo.
//
// ── La vara es RELATIVA a SPY, y por qué ───────────────────────────
// Esta estrategia promete DEFENSA, no alfa. Un umbral absoluto de Sharpe
// (como el 0.9 del rotation-analyze) premia el régimen, no la estrategia: en
// una ventana dorada cualquier cosa larga lo pasa, y en una mala ninguna
// defensa lo alcanza. Por eso los tres criterios económicos se miden CONTRA
// SPY en la misma ventana: Sharpe +0.15, drawdown ≤ 70% del suyo, y retorno
// que no puede costar más de 1 punto al año.
// ═══════════════════════════════════════════════════════════════════

import {
  momentum121, primerosHabilesDelMes, simulaRotacion, serieSpy, anualizado,
  media, mediana, cierreVigente, sharpeAnual, maxDrawdown, pct, num,
} from './rotation-analyze.js';

// ─────────────────── CRITERIOS (congelados) ───────────────────
// Se exportan para que el test los verifique y para que salgan en el JSON:
// si alguien los mueve después de ver los números, el diff lo delata.
const CRITERIOS = {
  // §1 — MUESTRA. Si no se cumple → INCONCLUSO (no NO-GO: sin muestra no se
  // afirma que la estrategia no sirve).
  min_rebalanceos: 30,

  // §2/§3/§4 — ECONOMÍA, toda RELATIVA a SPY en la MISMA ventana.
  sharpe_sobre_spy_min: 0.15,     // Sharpe neto ≥ Sharpe(SPY) + 0.15
  dd_max_fraccion_spy: 0.70,      // |max DD| ≤ 70% del |max DD| de SPY
  ret_vs_spy_min: -0.01,          // retorno anual neto ≥ SPY − 1 punto porcentual

  // Construcción.
  fraccion_decil: 0.10,           // top decil del universo elegible
  momentum_desde_meses: 12,       // 12-1: de t−12m …
  momentum_hasta_meses: 1,        // … a t−1m
  sma_dias: 200,                  // gate macro: SPY vs SMA de 200 sesiones
  sma_meses_faber: 10,            // sensibilidad: SMA de 10 cierres mensuales
  costo_por_lado: 0.0010,         // 10 bp
  meses_rebalanceo: 1,
  meses_rebalanceo_sensibilidad: 2,
  anios_ventana: 3,               // misma ventana que rotation-analyze (comparabilidad)
  min_elegibles_rebalanceo: 20,
};

// ─────────────────── el gate de tendencia ───────────────────

// SMA de las últimas `n` sesiones CON DATO hasta el índice i (inclusive).
// Si no hay n cierres, devuelve null: una SMA de 200 calculada con 40 datos no
// es una SMA de 200, es otra señal con el mismo nombre.
function smaDiaria(closes, i, n) {
  const vals = [];
  for (let k = i; k >= 0 && vals.length < n; k--) if (closes[k] != null) vals.push(closes[k]);
  return vals.length < n ? null : media(vals);
}

// Índices de los cierres de FIN DE MES hasta i (inclusive), del más reciente
// al más viejo. `i` entra como ancla: en la corrida real es el último cierre
// del mes anterior al rebalanceo, que es justo el cierre mensual de Faber.
function finesDeMesHasta(calendario, i, n) {
  const out = [];
  for (let k = i; k >= 0 && out.length < n; k--) {
    const esFinDeMes = k === i
      || (k + 1 < calendario.length && calendario[k].slice(0, 7) !== calendario[k + 1].slice(0, 7));
    if (esFinDeMes) out.push(k);
  }
  return out;
}

// SMA de los últimos `meses` cierres MENSUALES (variante Faber del §4).
function smaMensual(closes, calendario, i, meses) {
  const idx = finesDeMesHasta(calendario, i, meses);
  if (idx.length < meses) return null;
  const vals = idx.map((k) => cierreVigente(closes, k)).filter((v) => v != null);
  return vals.length < meses ? null : media(vals);
}

// ¿Risk-on? Compara el cierre de la sesión de DECISIÓN contra su SMA.
//   tipoSma 'dias'  → SMA de `sma_dias` sesiones (la principal)
//   tipoSma 'meses' → SMA de `sma_meses_faber` cierres mensuales (sensibilidad)
// Sin SMA computable el gate NO se puede evaluar: se va a EFECTIVO (la
// política conservadora del encargo) y se cuenta aparte — un gate mudo que se
// asume risk-on sería una defensa que no defendió y nadie se enteró.
function evaluaGate(spyCloses, calendario, iDecision, criterios = CRITERIOS, tipoSma = 'dias') {
  const cierre = cierreVigente(spyCloses, iDecision);
  const sma = tipoSma === 'meses'
    ? smaMensual(spyCloses, calendario, iDecision, criterios.sma_meses_faber)
    : smaDiaria(spyCloses, iDecision, criterios.sma_dias);
  if (cierre == null || sma == null) return { risk_on: false, evaluable: false, cierre, sma };
  return { risk_on: cierre >= sma, evaluable: true, cierre, sma };
}

// ─────────────────── canastas ───────────────────

// Para cada rebalanceo: gate → elegibles → decil por momentum → filtro
// absoluto. Una canasta VACÍA significa efectivo (simulaRotacion ya lo trata
// así: liquida, paga el turnover y deja el capital en caja al 0%).
function construyeCanastasDual({
  simbolos, calendario, seriesAlineadas, spyCloses, iRebalanceos,
  criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil,
  conGate = true, conFiltroAbsoluto = true, tipoSma = 'dias',
  gateEnCierreDelDia = false,
}) {
  const motivos = { sin_serie: 0, sin_open_rebalanceo: 0, sin_momentum: 0 };
  const canastas = [];
  const saltados = [];
  let gateActivaciones = 0;
  let gateNoEvaluable = 0;
  let mesesEfectivoPorFiltro = 0;
  let descartadosPorAbsoluto = 0;
  const gateSerie = [];

  for (const i of iRebalanceos) {
    const fecha = calendario[i];
    // La decisión se toma con el ÚLTIMO cierre conocido antes de la apertura
    // en la que se ejecuta. 'gateEnCierreDelDia' (solo EXPLORATORIO) usa el
    // cierre del propio día, que no existe cuando hay que mandar la orden.
    const iDecision = gateEnCierreDelDia ? i : i - 1;
    if (iDecision < 0) { saltados.push({ fecha, motivo: 'sin_cierre_previo' }); continue; }

    let riskOn = true;
    let gate = null;
    if (conGate) {
      gate = evaluaGate(spyCloses, calendario, iDecision, criterios, tipoSma);
      riskOn = gate.risk_on;
      if (!gate.evaluable) gateNoEvaluable++;
      if (!riskOn) gateActivaciones++;
      gateSerie.push({ fecha, risk_on: gate.risk_on, evaluable: gate.evaluable, cierre: gate.cierre, sma: gate.sma });
    }

    if (!riskOn) {
      canastas.push({ i, fecha, nombres: [], elegibles: 0, en_efectivo: true, motivo_efectivo: 'gate' });
      continue;
    }

    const elegibles = [];
    for (const sym of simbolos) {
      const serie = seriesAlineadas[sym];
      if (!serie) { motivos.sin_serie++; continue; }
      if (serie.opens[i] == null) { motivos.sin_open_rebalanceo++; continue; }
      const mom = momentum121(serie.closes, fecha, criterios, calendario);
      if (mom == null) { motivos.sin_momentum++; continue; }
      elegibles.push({ symbol: sym, momentum: mom });
    }

    if (elegibles.length < criterios.min_elegibles_rebalanceo) {
      saltados.push({ fecha, motivo: 'pocos_elegibles', elegibles: elegibles.length });
      continue;
    }

    // Decil sobre TODOS los elegibles (desempate por símbolo: determinismo)…
    const ordenados = [...elegibles].sort((a, b) => (b.momentum - a.momentum) || (a.symbol < b.symbol ? -1 : 1));
    const k = Math.max(1, Math.round(elegibles.length * fraccion));
    const decil = ordenados.slice(0, k);
    // …y RECIÉN AHORA el momentum absoluto (ver cabecera: el orden importa).
    const seleccion = conFiltroAbsoluto ? decil.filter((e) => e.momentum > 0) : decil;
    descartadosPorAbsoluto += decil.length - seleccion.length;
    if (!seleccion.length) mesesEfectivoPorFiltro++;

    canastas.push({
      i, fecha,
      nombres: seleccion.map((e) => e.symbol),
      elegibles: elegibles.length,
      nombres_antes_del_filtro_absoluto: decil.length,
      en_efectivo: seleccion.length === 0,
      motivo_efectivo: seleccion.length === 0 ? 'momentum_absoluto' : null,
      detalle: seleccion.map((e) => ({ symbol: e.symbol, momentum: e.momentum })),
    });
  }

  return {
    canastas, motivos, saltados,
    gate: {
      activaciones: gateActivaciones,
      no_evaluable: gateNoEvaluable,
      meses_efectivo_por_momentum_absoluto: mesesEfectivoPorFiltro,
      descartados_por_momentum_absoluto: descartadosPorAbsoluto,
      serie: gateSerie,
    },
  };
}

// ─────────────────── una especificación completa ───────────────────

function corre({
  simbolos, calendario, seriesAlineadas, spyOpens, spyCloses, desde,
  criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil,
  cadaMeses = CRITERIOS.meses_rebalanceo, conGate = true, conFiltroAbsoluto = true,
  tipoSma = 'dias', gateEnCierreDelDia = false, etiqueta = 'principal',
}) {
  const iRebalanceos = primerosHabilesDelMes(calendario, { desde, cadaMeses });
  const { canastas, motivos, saltados, gate } = construyeCanastasDual({
    simbolos, calendario, seriesAlineadas, spyCloses, iRebalanceos,
    criterios, fraccion, conGate, conFiltroAbsoluto, tipoSma, gateEnCierreDelDia,
  });

  const config = {
    etiqueta, fraccion, cada_meses: cadaMeses,
    con_gate: conGate, con_filtro_absoluto: conFiltroAbsoluto,
    tipo_sma: conGate ? tipoSma : null,
    gate_en_cierre_del_dia: gateEnCierreDelDia,
  };

  if (!canastas.length) {
    return {
      ...config,
      muestra: {
        rebalanceos_programados: iRebalanceos.length, rebalanceos_ejecutados: 0,
        rebalanceos_completos: 0, rebalanceos_saltados: saltados.length, saltados,
        motivos_exclusion: motivos, rango: null,
      },
      gate: { ...gate, serie: undefined },
      economia: null,
      cumple: { muestra: false, sharpe: false, drawdown: false, retorno: false },
      veredicto: 'INCONCLUSO', fragil: false, motivo_fragil: null,
    };
  }

  const neto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: criterios.costo_por_lado });
  const bruto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: 0 });
  const spy = serieSpy({ spyOpens, spyCloses, calendario, iInicio: canastas[0].i, nDias: neto.retornos.length });

  // Curva de SPY comprado y mantenido sobre EXACTAMENTE los mismos días: su
  // drawdown y su Sharpe son la vara de los §2–§4.
  const curvaSpy = [];
  let eq = 1;
  for (const r of spy) { eq *= 1 + r; curvaSpy.push(eq); }

  const retAnualNeto = anualizado(neto.retornos);
  const retAnualSpy = anualizado(spy);
  const sharpeNeto = sharpeAnual(neto.retornos);
  const sharpeSpy = sharpeAnual(spy);
  const ddNeto = neto.max_drawdown;
  const ddSpy = maxDrawdown(curvaSpy);

  const completos = Math.max(0, canastas.length - 1);
  const enEfectivo = canastas.filter((c) => !c.nombres.length).length;
  const invertidos = canastas.length - enEfectivo;

  // §3 se compara en VALOR ABSOLUTO: ambos drawdowns son negativos.
  // Si SPY no tuvo drawdown en la ventana, el criterio se vuelve vacuo
  // (cualquier caída lo violaría): se marca no evaluable y se dice.
  const ddSpyAbs = ddSpy == null ? null : Math.abs(ddSpy);
  const ddNetoAbs = ddNeto == null ? null : Math.abs(ddNeto);
  const ddEvaluable = ddSpyAbs != null && ddSpyAbs > 0 && ddNetoAbs != null;

  const cumple = {
    muestra: completos >= criterios.min_rebalanceos,
    sharpe: sharpeNeto != null && sharpeSpy != null && sharpeNeto >= sharpeSpy + criterios.sharpe_sobre_spy_min,
    drawdown: ddEvaluable && ddNetoAbs <= criterios.dd_max_fraccion_spy * ddSpyAbs,
    retorno: retAnualNeto != null && retAnualSpy != null && retAnualNeto >= retAnualSpy + criterios.ret_vs_spy_min,
  };
  let veredicto = !cumple.muestra ? 'INCONCLUSO'
    : (cumple.sharpe && cumple.drawdown && cumple.retorno) ? 'GO' : 'NO-GO';

  // ── CANDADO DE HONESTIDAD (pre-registrado) ──
  // El mecanismo defensivo de esta estrategia es el gate. Si NUNCA se activó
  // en la ventana, la defensa no se probó: los números de arriba son los del
  // momentum a secas en un régimen que nunca lo puso a prueba. El GO se topa
  // en FRÁGIL y se dice por qué. No aplica cuando la corrida NO lleva gate
  // (la sensibilidad de atribución): ahí no hay mecanismo que probar.
  let fragil = false;
  let motivoFragil = null;
  if (veredicto === 'GO' && conGate && gate.activaciones === 0) {
    fragil = true;
    motivoFragil = 'gate sin evento en ventana';
  }

  return {
    ...config,
    muestra: {
      rebalanceos_programados: iRebalanceos.length,
      rebalanceos_ejecutados: canastas.length,
      rebalanceos_completos: completos,
      rebalanceos_saltados: saltados.length,
      saltados,
      nombres_promedio: media(canastas.map((c) => c.nombres.length)),
      nombres_promedio_invertido: invertidos
        ? media(canastas.filter((c) => c.nombres.length).map((c) => c.nombres.length)) : null,
      meses_en_efectivo: enEfectivo,
      meses_invertido: invertidos,
      exposicion_meses: canastas.length ? invertidos / canastas.length : null,
      elegibles_promedio: media(canastas.filter((c) => !c.en_efectivo || c.motivo_efectivo === 'momentum_absoluto').map((c) => c.elegibles)),
      motivos_exclusion: motivos,
      rango: { desde: canastas[0].fecha, hasta: canastas[canastas.length - 1].fecha },
      dias_cartera: neto.retornos.length,
    },
    gate: {
      activaciones: gate.activaciones,
      no_evaluable: gate.no_evaluable,
      meses_efectivo_por_momentum_absoluto: gate.meses_efectivo_por_momentum_absoluto,
      descartados_por_momentum_absoluto: gate.descartados_por_momentum_absoluto,
      pct_meses_gate: canastas.length ? gate.activaciones / canastas.length : null,
    },
    economia: {
      sharpe_neto: sharpeNeto,
      sharpe_spy: sharpeSpy,
      sharpe_menos_spy: (sharpeNeto == null || sharpeSpy == null) ? null : sharpeNeto - sharpeSpy,
      sharpe_bruto: sharpeAnual(bruto.retornos),
      max_drawdown: ddNeto,
      max_drawdown_spy: ddSpy,
      dd_fraccion_de_spy: ddEvaluable ? ddNetoAbs / ddSpyAbs : null,
      dd_evaluable: ddEvaluable,
      ret_anual_neto: retAnualNeto,
      ret_anual_spy: retAnualSpy,
      ret_menos_spy: (retAnualNeto == null || retAnualSpy == null) ? null : retAnualNeto - retAnualSpy,
      ret_total_neto: neto.equity_final - 1,
      ret_total_bruto: bruto.equity_final - 1,
      turnover_medio: neto.turnover_medio,
      turnover_mediana: neto.turnover_mediana,
      costo_total: neto.costo_total,
    },
    cumple,
    veredicto,
    fragil,
    motivo_fragil: motivoFragil,
    detalle_canastas: canastas,
    gate_serie: gate.serie,
  };
}

// ─────────────────── resumen en español ───────────────────

const marca = (ok) => (ok ? '✅' : '❌');
const etiquetaVeredicto = (b) =>
  (b.veredicto === 'GO' && b.fragil ? `GO FRÁGIL (${b.motivo_fragil})` : b.veredicto);

function filasCriterios(b, c) {
  const m = b.muestra, e = b.economia || {};
  return [
    ['1 · ≥ ' + c.min_rebalanceos + ' rebalanceos completos', String(m.rebalanceos_completos), b.cumple.muestra],
    ['2 · Sharpe neto ≥ Sharpe SPY + ' + num(c.sharpe_sobre_spy_min, 2),
      `${num(e.sharpe_neto)} vs ${num(e.sharpe_spy)} (+${num(e.sharpe_menos_spy)})`, b.cumple.sharpe],
    ['3 · Max drawdown ≤ ' + pct(c.dd_max_fraccion_spy, 0) + ' del de SPY',
      `${pct(e.max_drawdown)} vs ${pct(e.max_drawdown_spy)} (${pct(e.dd_fraccion_de_spy, 0)} del suyo)`, b.cumple.drawdown],
    ['4 · Retorno anual neto ≥ SPY − ' + pct(Math.abs(c.ret_vs_spy_min), 0),
      `${pct(e.ret_anual_neto)} vs ${pct(e.ret_anual_spy)} (${pct(e.ret_menos_spy)})`, b.cumple.retorno],
  ];
}

function bloqueCorto(titulo, b) {
  if (!b.economia) return `**${titulo}** → ${etiquetaVeredicto(b)} · sin canastas ejecutadas`;
  return `**${titulo}** → ${etiquetaVeredicto(b)}`
    + ` · rebalanceos ${b.muestra.rebalanceos_completos} · gate ${b.gate.activaciones} meses`
    + ` · efectivo ${b.muestra.meses_en_efectivo} meses · Sharpe ${num(b.economia.sharpe_neto)} (SPY ${num(b.economia.sharpe_spy)})`
    + ` · DD ${pct(b.economia.max_drawdown)} · ret ${pct(b.economia.ret_anual_neto)}`;
}

function renderResumenMarkdown(s) {
  const c = s.criterios, p = s.principal, L = [];
  L.push('# Dual Momentum con gate de tendencia — ¿defiende de verdad?');
  L.push('');
  L.push(`**VEREDICTO: ${etiquetaVeredicto(p)}**`);
  L.push('');
  L.push(`Generado ${s.generado_en} · solo lectura · ventana ${s.datos.ventana_analisis.desde} → ${s.datos.ventana_analisis.hasta}`);
  L.push('');
  if (p.fragil) {
    L.push(`> **GO FRÁGIL — ${p.motivo_fragil}.** El gate macro NUNCA se activó en esta ventana:`);
    L.push('> el mecanismo defensivo de esta estrategia NO se probó. Lo que pasaron los criterios');
    L.push('> es el momentum a secas en un régimen que nunca lo puso a prueba. Como evidencia para');
    L.push('> el breaker macro de la liga, esta corrida NO alcanza: hace falta una ventana con');
    L.push('> mercado bajista adentro.');
    L.push('');
  }
  L.push('## Especificación principal (una sola, fijada antes de correr)');
  L.push('');
  L.push(`- Universo: ${s.especificacion.universo}.`);
  L.push(`- Rebalanceo: ${s.especificacion.rebalanceo}.`);
  L.push(`- Selección: ${s.especificacion.seleccion}.`);
  L.push(`- Filtro (a) momentum absoluto: ${s.especificacion.filtro_absoluto}.`);
  L.push(`- Filtro (b) gate macro: ${s.especificacion.gate}.`);
  L.push(`- Costos: ${s.especificacion.costo_por_lado_bp} bp por lado sobre el turnover real.`);
  L.push('');
  L.push('## Criterios de éxito (congelados en CRITERIOS antes de correr)');
  L.push('');
  L.push('| Criterio | Resultado | ¿Pasa? |');
  L.push('|---|---|---|');
  for (const [k, v, ok] of filasCriterios(p, c)) L.push(`| ${k} | ${v} | ${marca(ok)} |`);
  L.push('');
  L.push('> Regla del veredicto: GO exige §2 **y** §3 **y** §4. Falla de muestra (§1) → INCONCLUSO');
  L.push('> (no NO-GO: sin muestra no se afirma que la estrategia no sirve). El resto → NO-GO.');
  L.push('> La vara es RELATIVA a SPY a propósito: esto promete defensa, no alfa, y un umbral');
  L.push('> absoluto de Sharpe premiaría el régimen (la lección del rotation-analyze).');
  L.push('');
  if (!p.cumple.muestra) {
    L.push(`> La muestra no alcanza: ${p.muestra.rebalanceos_completos} rebalanceos completos`);
    L.push(`> (piso ${c.min_rebalanceos}). Por la regla fijada de antemano: **INCONCLUSO**, no "casi".`);
    L.push('');
  }
  if (p.economia && p.economia.dd_evaluable === false) {
    L.push('> ⚠️ SPY no tuvo drawdown medible en la ventana: el §3 queda VACUO (cualquier caída');
    L.push('> lo violaría). Se reporta como no cumplido y se dice — no se aprueba por defecto.');
    L.push('');
  }
  L.push('## El gate: ¿se activó?');
  L.push('');
  L.push(`- **Activaciones del gate macro (meses en efectivo por SPY < SMA${c.sma_dias}): ${p.gate.activaciones}**`
    + (p.muestra.rebalanceos_ejecutados ? ` de ${p.muestra.rebalanceos_ejecutados} rebalanceos (${pct(p.gate.pct_meses_gate, 0)})` : ''));
  L.push(`- Meses en efectivo por el filtro de momentum absoluto (decil sin ningún nombre positivo): ${p.gate.meses_efectivo_por_momentum_absoluto}`);
  L.push(`- Nombres descartados del decil por momentum ≤ 0: ${p.gate.descartados_por_momentum_absoluto}`);
  if (p.gate.no_evaluable) L.push(`- Meses con SMA no computable (a efectivo, conservador): ${p.gate.no_evaluable}`);
  L.push(`- Exposición: ${p.muestra.meses_invertido} meses invertido de ${p.muestra.rebalanceos_ejecutados} (${pct(p.muestra.exposicion_meses, 0)})`
    + ` · nombres promedio cuando está invertido: ${num(p.muestra.nombres_promedio_invertido, 1)}`);
  L.push('');
  L.push('## Economía (siempre neta de costos, siempre contra SPY)');
  L.push('');
  L.push(`- Sharpe neto **${num(p.economia.sharpe_neto)}** vs SPY ${num(p.economia.sharpe_spy)} → diferencia ${num(p.economia.sharpe_menos_spy)} (bruto ${num(p.economia.sharpe_bruto)})`);
  L.push(`- Max drawdown **${pct(p.economia.max_drawdown)}** vs SPY ${pct(p.economia.max_drawdown_spy)} → ${pct(p.economia.dd_fraccion_de_spy, 0)} del suyo`);
  L.push(`- Retorno anualizado neto **${pct(p.economia.ret_anual_neto)}** vs SPY ${pct(p.economia.ret_anual_spy)} → ${pct(p.economia.ret_menos_spy)}`);
  L.push(`- Retorno total neto ${pct(p.economia.ret_total_neto)} · turnover medio ${pct(p.economia.turnover_medio, 1)} por rebalanceo · costo acumulado ${pct(p.economia.costo_total, 2)} del capital inicial`);
  L.push('');
  L.push('## Sensibilidades obligatorias');
  L.push('');
  for (const b of s.sensibilidades) L.push(bloqueCorto(b.nombre, b.resultado) + '\n');
  L.push('> Atribución: la corrida **sin gate** aísla cuánto del resultado es el gate y cuánto');
  L.push('> el momentum. La corrida **sin filtro absoluto** es momentum relativo puro — y es el');
  L.push('> puente con el "solo momentum" de `/api/rotation-analyze`: mismo universo, misma');
  L.push('> ventana, misma definición 12-1.');
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
  L.push('## Caveat pre-registrado: esto NO es evidencia independiente');
  L.push('');
  L.push(s.caveat);
  L.push('');
  return L.join('\n');
}

export {
  CRITERIOS,
  smaDiaria, smaMensual, finesDeMesHasta, evaluaGate,
  construyeCanastasDual, corre,
  renderResumenMarkdown, filasCriterios, bloqueCorto, etiquetaVeredicto,
  // re-exportadas para el endpoint / los tests (mismo motor que la rotación)
  momentum121, primerosHabilesDelMes, simulaRotacion, serieSpy, anualizado,
  media, mediana, cierreVigente, sharpeAnual, maxDrawdown, pct, num,
};
