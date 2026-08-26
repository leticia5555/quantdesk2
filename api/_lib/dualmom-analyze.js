// ═══════════════════════════════════════════════════════════════════
// api/_lib/dualmom-analyze.js — backtest pre-registrado #2:
// DUAL MOMENTUM con gate de tendencia. Candidato a agente DEFENSIVO y
// evidencia para el breaker macro de la liga.
//
// Lógica PURA (cero I/O): recibe el universo (los mismos símbolos que
// /api/rotation-analyze) + las velas diarias ajustadas de Yahoo y devuelve el
// veredicto contra umbrales FIJADOS ANTES DE CORRER (§CRITERIOS). El endpoint
// /api/dualmom-analyze solo hace de plomería (un SELECT + el fetch a Yahoo).
//
// REUSA los helpers del rotation-analyze — no se reimplementa nada: el
// calendario de rebalanceos, el momentum 12-1, el simulador de rotación con
// turnover real, la serie calendar-time de SPY y la anualización son
// EXACTAMENTE los mismos. Si un helper cambia, cambian los dos backtests a la
// vez, que es justamente el punto.
//
// ── La única especificación principal ──────────────────────────────
//   Universo  : el mismo set de símbolos de /api/rotation-analyze (los que
//               tienen historial de EPS en `pead_earnings`) — por
//               COMPARABILIDAD, aunque esta estrategia no use EPS.
//   Rebalanceo: primer día hábil del mes, FILLS A LA APERTURA.
//   Selección : rank por momentum 12-1 → top DECIL (~10), equal-weight …
//   Filtro (a): … momentum ABSOLUTO — un nombre solo entra si su propio
//               12-1 > 0.
//   Filtro (b): GATE MACRO — si SPY está debajo de su SMA de 200 días en la
//               fecha de rebalanceo, la cartera ENTERA se va a EFECTIVO ese
//               mes. El efectivo rinde 0 (conservador: no se le regala al
//               backtest un T-bill que habría que elegir y modelar).
//   Costos    : 10 bp por lado sobre el TURNOVER REAL de cada rebalanceo.
//
// ── La vara es RELATIVA a SPY, y por qué ──────────────────────────
// Esta estrategia promete DEFENSA, no alfa. Un umbral absoluto de Sharpe
// (como el 0.9 del rotation) premia el régimen, no la estrategia: en un año
// dorado cualquier cosa larga lo pasa, y en uno malo nada lo pasa. Así que los
// tres criterios económicos se fijaron CONTRA SPY EN LA MISMA VENTANA:
// Sharpe + 0.15, drawdown ≤ 70% del suyo, y retorno anual no más de 1 pp
// abajo. La defensa tiene que verse en el drawdown y no puede costar más de un
// punto al año.
//
// ── El gate se evalúa con el CIERRE PREVIO, y por qué ─────────────
// El encargo dice "si SPY cierra debajo de su SMA de 200 días en la fecha de
// rebalanceo". El fill es a la APERTURA de esa fecha: el cierre de ESE día
// todavía no existe cuando se ejecuta. Usarlo sería look-ahead puro — y
// justamente en la variable que decide si se está en el mercado o en
// efectivo, que es donde más duele. Se usa el CIERRE DE LA SESIÓN PREVIA
// contra la SMA200 calculada hasta esa misma sesión. Como el rebalanceo es el
// primer día hábil del mes, ese cierre previo es el CIERRE DE FIN DE MES
// anterior, que es además la convención de la literatura (Faber). La
// diferencia contra la lectura literal se mide igual, como corte
// EXPLORATORIO, para que quede a la vista cuánto valía el look-ahead.
//
// ── Candado de honestidad pre-registrado ──────────────────────────
// Se reporta `gate_activaciones` (meses en efectivo por el gate macro). Si es
// 0, el mecanismo defensivo NO SE PROBÓ en esta ventana: el veredicto se topa
// en "GO frágil (gate sin evento en ventana)" aunque los cuatro criterios
// pasen, y el reporte lo dice explícito. Un GO sin un solo evento de gate es
// un GO sobre una estrategia que, en esta ventana, fue idéntica a su versión
// sin defensa.
//
// ── Caveat pre-registrado ─────────────────────────────────────────
// MISMA VENTANA y MISMO UNIVERSO que rotation-analyze ⇒ esto NO es una prueba
// independiente del momentum: comparte el sesgo de supervivencia y el régimen
// alcista. El split "sin filtros" (sin gate y sin absoluto) es el puente
// explícito con el momentum-solo del rotation.
// ═══════════════════════════════════════════════════════════════════

import {
  restaMeses, indiceHasta, primerosHabilesDelMes, momentum121,
  simulaRotacion, serieSpy, anualizado,
  media, mediana, tStat, sharpeAnual, maxDrawdown, cierreVigente,
  alineaAlCalendario, recortaVelasIncompletas,
} from './rotation-analyze.js';

// ─────────────────── CRITERIOS (congelados) ───────────────────
// Se exportan para que el test los verifique y para que salgan en cada
// respuesta: si alguien los mueve después de ver los números, el diff lo
// delata. Los §2–§4 son RELATIVOS a SPY a propósito (ver cabecera).
const CRITERIOS = {
  // §1 — MUESTRA. Si no se cumple → INCONCLUSO (no NO-GO: sin muestra no se
  // afirma que la estrategia no sirve).
  min_rebalanceos: 30,              // rebalanceos mensuales COMPLETOS

  // §2 — Sharpe neto ≥ Sharpe de SPY + esta prima, en la MISMA ventana.
  sharpe_prima_min: 0.15,

  // §3 — Max drawdown (en magnitud) ≤ esta fracción del de SPY.
  drawdown_max_fraccion_spy: 0.70,

  // §4 — Retorno anualizado neto ≥ SPY − esta holgura. La defensa no puede
  // costar más de 1 punto porcentual al año.
  ret_anual_holgura_max: 0.01,

  // Construcción de la cartera.
  fraccion_decil: 0.10,             // top decil (~10 nombres de ~98)
  fraccion_quintil: 0.20,           // solo para cortes EXPLORATORIOS
  meses_rebalanceo: 1,
  meses_rebalanceo_sensibilidad: 2, // sensibilidad obligatoria (bimestral)
  momentum_desde_meses: 12,         // 12-1: de t−12m …
  momentum_hasta_meses: 1,          // … a t−1m
  momentum_absoluto_min: 0,         // un nombre entra solo si su 12-1 > 0
  costo_por_lado: 0.0010,           // 10 bp
  anios_ventana: 3,                 // MISMA ventana que rotation-analyze

  // Gate macro.
  gate_sma_dias: 200,               // principal: SMA de 200 días de SPY
  gate_sma_meses: 10,               // sensibilidad Faber: SMA de 10 meses

  // PUENTE con /api/rotation-analyze. El corte "solo momentum" de aquel
  // reporte, sobre la MISMA ventana y el MISMO universo, dio t = 1.87. El
  // split "sin filtros" de acá (sin gate y sin absoluto) mide esencialmente lo
  // mismo, así que TIENE QUE REPRODUCIRLO aproximadamente. No se espera
  // igualdad exacta — el rotation exige además TTM válido para ser elegible,
  // así que su población es un poco más chica, y las dos corridas se ejecutan
  // en fechas distintas — por eso la tolerancia. Si la brecha se sale de la
  // banda, la sospecha NO es "el momentum cambió": es que la HERENCIA DEL
  // UNIVERSO está mal (otro set de símbolos, otra ventana, otro calendario), y
  // el reporte lo dice en vez de publicar un número que no cuadra.
  puente_rotation_t_referencia: 1.87,
  puente_tolerancia_t: 0.5,

  // Piso de elegibles para EJECUTAR un rebalanceo INVERTIDO. Con ~98 símbolos
  // solo se dispara si los datos están rotos; ahí el rebalanceo se salta (se
  // arrastra la canasta anterior) y se CUENTA. El gate NO depende de esto: si
  // el gate manda a efectivo, se va a efectivo aunque no haya un solo
  // elegible — no hace falta rankear nada para no comprar nada.
  min_elegibles_rebalanceo: 20,
};

// El gate de la especificación principal, en un solo objeto para que las
// sensibilidades se lean como lo que son: el mismo motor con otro gate.
const GATE_PRINCIPAL = { tipo: 'sma_dias', n: CRITERIOS.gate_sma_dias, precio: 'cierre_previo' };
const GATE_FABER = { tipo: 'sma_meses', n: CRITERIOS.gate_sma_meses, precio: 'cierre_previo' };
const GATE_OFF = { tipo: 'off', n: 0, precio: 'cierre_previo' };

// ─────────────────── gate de tendencia ───────────────────

// Índices del ÚLTIMO día hábil de cada mes del calendario. El último elemento
// del calendario se excluye a propósito salvo que cierre mes: la vela más
// reciente puede ser de un mes en curso y ese no es un cierre mensual.
function ultimosHabilesDelMes(calendario) {
  const out = [];
  for (let i = 0; i + 1 < calendario.length; i++) {
    if (calendario[i].slice(0, 7) !== calendario[i + 1].slice(0, 7)) out.push(i);
  }
  return out;
}

// SMA de los últimos `n` cierres CONOCIDOS con índice <= i. Devuelve null si no
// hay n observaciones: una SMA200 calculada con 40 días no es una SMA200, y
// rellenarla sería inventar la señal que decide si estamos en el mercado.
function smaDias(closes, i, n) {
  if (i < 0 || n <= 0) return null;
  let suma = 0, vistos = 0;
  for (let k = i; k >= 0 && vistos < n; k--) {
    if (closes[k] != null) { suma += closes[k]; vistos++; }
  }
  return vistos === n ? suma / n : null;
}

// SMA de los últimos `n` CIERRES MENSUALES (último hábil de cada mes) con
// índice <= i. Es la variante Faber: 10 meses, no 200 días.
function smaMeses(closes, finesDeMes, i, n) {
  if (i < 0 || n <= 0) return null;
  const usables = [];
  for (let k = finesDeMes.length - 1; k >= 0 && usables.length < n; k--) {
    const j = finesDeMes[k];
    if (j > i) continue;
    const c = closes[j];
    if (c != null) usables.push(c);
  }
  return usables.length === n ? usables.reduce((a, b) => a + b, 0) / n : null;
}

// ¿El gate manda a EFECTIVO en el rebalanceo del índice i?
//
// `precio`:
//   'cierre_previo'   (PRINCIPAL) — cierre de la sesión i−1 contra la SMA
//                     hasta i−1. Es lo único conocido al abrir el día i.
//   'cierre_del_dia'  (EXPLORATORIO) — la lectura literal del encargo, que
//                     usa un cierre que no existe cuando se ejecuta el fill.
//
// Devuelve {activo, precio, sma, motivo}. `motivo: 'sin_sma'` = no hubo
// historia suficiente para calcular la media: el gate NO se pudo evaluar y el
// mes se va a EFECTIVO (conservador, coherente con una estrategia defensiva),
// pero se cuenta APARTE de las activaciones reales — si no, un hueco de datos
// se leería como "el mecanismo defensivo se probó".
function evaluaGate({ spyCloses, calendario, finesDeMes, i, gate = GATE_PRINCIPAL }) {
  if (!gate || gate.tipo === 'off') return { activo: false, precio: null, sma: null, motivo: 'gate_apagado' };
  const iRef = gate.precio === 'cierre_del_dia' ? i : i - 1;
  const precio = cierreVigente(spyCloses, iRef);
  const sma = gate.tipo === 'sma_meses'
    ? smaMeses(spyCloses, finesDeMes, iRef, gate.n)
    : smaDias(spyCloses, iRef, gate.n);
  if (precio == null || sma == null) return { activo: true, precio, sma, motivo: 'sin_sma' };
  return { activo: precio < sma, precio, sma, motivo: null };
}

// ─────────────────── canastas ───────────────────

// Para cada rebalanceo:
//   1. GATE primero. Si está activo → canasta VACÍA (efectivo). No se rankea
//      nada: no hace falta elegir nombres para no comprar ninguno.
//   2. Elegibles: precio previo + open del día (el fill es a la apertura) +
//      momentum 12-1 calculable.
//   3. Rank por momentum 12-1, top decil.
//   4. Filtro ABSOLUTO sobre la canasta ya elegida: fuera los que tengan
//      12-1 <= 0. Los sobrevivientes se equiponderan ENTRE ELLOS.
//
// El orden del paso 3-4 es una decisión que hay que declarar: el decil se
// calcula sobre TODA la población elegible y el filtro absoluto recorta
// DESPUÉS. Así "top decil (~10)" sigue queriendo decir ~10 y el filtro se ve
// como lo que es — un recorte, medido en `absoluto.nombres_recortados`. La
// otra lectura (filtrar primero y sacar el decil del subconjunto positivo) va
// como corte EXPLORATORIO.
//
// Y la tercera decisión declarada, `pesoRecorte`, que es una SENSIBILIDAD
// OBLIGATORIA porque mueve el §3 justo en los meses de momentum roto:
//   'reparte'  (PRINCIPAL) — los nombres que caen por el filtro NO dejan su
//              ranura en efectivo: los sobrevivientes se reparten el capital.
//              Es la lectura literal de "un nombre solo ENTRA si…" — habla de
//              entrada, no de pesos.
//   'efectivo' (SENSIBILIDAD, convención Antonacci) — cada nombre recortado
//              deja su ranura vacía: el peso es 1/N sobre N = TAMAÑO DEL
//              DECIL, no sobre los sobrevivientes, y el resto queda en
//              efectivo. Es la variante que de verdad des-arriesga cuando el
//              momentum se rompe, en vez de concentrar en los pocos que
//              quedan.
// En los dos casos, si no sobrevive nadie la canasta queda vacía y el mes es
// de efectivo entero.
function construyeCanastasDual({
  simbolos, calendario, seriesAlineadas, iRebalanceos, spyCloses, finesDeMes,
  criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil,
  gate = GATE_PRINCIPAL, absoluto = true, orden = 'decil_primero',
  pesoRecorte = 'reparte',
}) {
  const motivos = {
    sin_serie: 0, sin_precio_previo: 0, sin_open_rebalanceo: 0, sin_momentum: 0,
    gate_efectivo: 0, momentum_absoluto: 0,
  };
  const canastas = [];
  const saltados = [];
  const gateMeses = [];
  let gateActivaciones = 0;
  let gateSinSma = 0;
  let gateEvaluaciones = 0;
  let recortados = 0;
  let rebalanceosConRecorte = 0;
  let vaciasPorAbsoluto = 0;
  let ranurasReservadas = 0;

  for (const i of iRebalanceos) {
    const fecha = calendario[i];

    // ── 1. GATE MACRO ──
    const g = evaluaGate({ spyCloses, calendario, finesDeMes, i, gate });
    if (gate && gate.tipo !== 'off') {
      gateEvaluaciones++;
      if (g.activo) {
        if (g.motivo === 'sin_sma') gateSinSma++; else gateActivaciones++;
        gateMeses.push({ fecha, precio_spy: g.precio, sma: g.sma, motivo: g.motivo || 'spy_bajo_sma' });
        // El universo entero queda fuera ese mes: se cuenta para que la
        // contabilidad de exclusiones siga cuadrando contra símbolos ×
        // rebalanceos.
        motivos.gate_efectivo += simbolos.length;
        canastas.push({
          i, fecha, elegibles: 0, nombres: [], detalle: [],
          efectivo: true, motivo_efectivo: g.motivo === 'sin_sma' ? 'gate_sin_sma' : 'gate',
          gate: { activo: true, precio_spy: g.precio, sma: g.sma },
          recortados_por_absoluto: 0,
        });
        continue;
      }
    }

    // ── 2. ELEGIBLES ──
    const elegibles = [];
    for (const sym of simbolos) {
      const serie = seriesAlineadas[sym];
      if (!serie) { motivos.sin_serie++; continue; }
      // El fill es a la apertura: sin open ese día el nombre no es comprable.
      if (serie.opens[i] == null) { motivos.sin_open_rebalanceo++; continue; }
      if (cierreVigente(serie.closes, i - 1) == null) { motivos.sin_precio_previo++; continue; }
      const mom = momentum121(serie.closes, fecha, criterios, calendario);
      if (mom == null) { motivos.sin_momentum++; continue; }
      elegibles.push({ symbol: sym, momentum: mom });
    }

    if (elegibles.length < criterios.min_elegibles_rebalanceo) {
      saltados.push({ fecha, elegibles: elegibles.length });
      continue;
    }

    // ── 3-4. DECIL + FILTRO ABSOLUTO ──
    // Desempate por símbolo: la corrida tiene que ser determinista.
    const porMomentum = (a, b) => (b.momentum - a.momentum) || (a.symbol < b.symbol ? -1 : 1);
    let canasta, recorte = 0, elegiblesUsados = elegibles.length, ranurasDecil = null;

    if (absoluto && orden === 'filtro_primero') {
      // Lectura EXPLORATORIA: el universo se filtra ANTES de cortar el decil,
      // así que el decil se saca del subconjunto positivo (canastas más chicas
      // cuando pocos nombres tienen momentum positivo).
      const positivos = elegibles.filter((e) => e.momentum > criterios.momentum_absoluto_min);
      recorte = elegibles.length - positivos.length;
      elegiblesUsados = positivos.length;
      const k = Math.max(1, Math.round(positivos.length * fraccion));
      canasta = [...positivos].sort(porMomentum).slice(0, positivos.length ? k : 0);
    } else {
      const k = Math.max(1, Math.round(elegibles.length * fraccion));
      const decil = [...elegibles].sort(porMomentum).slice(0, k);
      if (absoluto) {
        canasta = decil.filter((e) => e.momentum > criterios.momentum_absoluto_min);
        recorte = decil.length - canasta.length;
        // Variante Antonacci: el denominador sigue siendo el DECIL COMPLETO,
        // así que las ranuras recortadas quedan en efectivo (lo aplica
        // simulaRotacion vía `canasta.ranuras`).
        if (pesoRecorte === 'efectivo') ranurasDecil = decil.length;
      } else {
        canasta = decil;
      }
    }

    if (recorte > 0) { recortados += recorte; rebalanceosConRecorte++; motivos.momentum_absoluto += recorte; }
    if (absoluto && !canasta.length) vaciasPorAbsoluto++;
    if (ranurasDecil != null) ranurasReservadas += ranurasDecil - canasta.length;

    canastas.push({
      i, fecha, elegibles: elegiblesUsados,
      nombres: canasta.map((e) => e.symbol),
      detalle: canasta.map((e) => ({ symbol: e.symbol, momentum: e.momentum })),
      efectivo: canasta.length === 0,
      motivo_efectivo: canasta.length === 0 ? 'momentum_absoluto' : null,
      gate: { activo: false, precio_spy: g.precio, sma: g.sma },
      recortados_por_absoluto: recorte,
      // Solo la variante Antonacci lo puebla; sin el campo, simulaRotacion
      // reparte entre los nombres como siempre.
      ...(ranurasDecil != null ? { ranuras: ranurasDecil } : {}),
    });
  }

  return {
    canastas, motivos, saltados,
    gate: {
      tipo: gate ? gate.tipo : 'off',
      n: gate ? gate.n : 0,
      precio: gate ? gate.precio : null,
      evaluaciones: gateEvaluaciones,
      activaciones: gate && gate.tipo !== 'off' ? gateActivaciones : null,
      sin_sma: gateSinSma,
      meses: gateMeses,
    },
    absoluto: {
      aplicado: !!absoluto,
      orden: absoluto ? orden : null,
      peso_recorte: absoluto ? pesoRecorte : null,
      nombres_recortados: recortados,
      rebalanceos_con_recorte: rebalanceosConRecorte,
      canastas_vaciadas: vaciasPorAbsoluto,
      ranuras_a_efectivo: ranurasReservadas,
    },
  };
}

// ─────────────────── curva y drawdown ───────────────────

// Curva de equity desde retornos diarios compuestos (base 1).
function curvaDesdeRetornos(retornos) {
  let e = 1;
  return retornos.map((r) => (e *= 1 + r));
}

// ─────────────────── una especificación completa ───────────────────

function corre({
  simbolos, calendario, seriesAlineadas, spyOpens, spyCloses, finesDeMes,
  desde, criterios = CRITERIOS, fraccion = CRITERIOS.fraccion_decil,
  gate = GATE_PRINCIPAL, absoluto = true, orden = 'decil_primero',
  pesoRecorte = 'reparte',
  cadaMeses = CRITERIOS.meses_rebalanceo, etiqueta = 'principal',
}) {
  const iRebalanceos = primerosHabilesDelMes(calendario, { desde, cadaMeses });
  const { canastas, motivos, saltados, gate: gateInfo, absoluto: absInfo } = construyeCanastasDual({
    simbolos, calendario, seriesAlineadas, iRebalanceos, spyCloses, finesDeMes,
    criterios, fraccion, gate, absoluto, orden, pesoRecorte,
  });

  const comun = {
    etiqueta, fraccion, cada_meses: cadaMeses,
    gate: gateInfo, filtro_absoluto: absInfo,
    gate_activaciones: gateInfo.activaciones,
  };

  if (!canastas.length) {
    return {
      ...comun,
      muestra: {
        rebalanceos_programados: iRebalanceos.length,
        rebalanceos_ejecutados: 0, rebalanceos_completos: 0,
        rebalanceos_saltados: saltados.length, saltados,
        meses_en_efectivo: 0, meses_invertidos: 0,
        nombres_promedio_invertido: null, elegibles_promedio: null,
        motivos_exclusion: motivos, rango: null,
      },
      senal: null, economia: null,
      cumple: { muestra: false, sharpe: false, drawdown: false, retorno: false },
      veredicto: 'INCONCLUSO', fragil: false, fragil_motivo: null,
    };
  }

  const bruto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: 0 });
  const neto = simulaRotacion({ canastas, seriesAlineadas, calendario, costo: criterios.costo_por_lado });
  const spy = serieSpy({ spyOpens, spyCloses, calendario, iInicio: canastas[0].i, nDias: neto.retornos.length });

  // DIAGNÓSTICO (no es criterio): abnormal calendar-time contra SPY. Se
  // reporta porque informa, pero el veredicto de esta estrategia NO cuelga de
  // él — lo que promete es defensa, y eso se mide en el §3.
  const abnormal = bruto.retornos.map((r, k) => r - (spy[k] ?? 0));
  const abnormalNeto = neto.retornos.map((r, k) => r - (spy[k] ?? 0));
  const t = tStat(abnormal);
  const tNeto = tStat(abnormalNeto);

  const retAnualNeto = anualizado(neto.retornos);
  const retAnualSpy = anualizado(spy);
  const exceso = (retAnualNeto == null || retAnualSpy == null) ? null : retAnualNeto - retAnualSpy;
  const sharpeNeto = sharpeAnual(neto.retornos);
  const sharpeSpy = sharpeAnual(spy);
  const ddEstrategia = neto.max_drawdown;                       // negativo
  const ddSpy = maxDrawdown(curvaDesdeRetornos(spy));           // negativo

  // §2 · §3 · §4 — TODOS relativos a SPY en la misma ventana.
  const sharpeUmbral = sharpeSpy == null ? null : sharpeSpy + criterios.sharpe_prima_min;
  // Drawdowns en magnitud: |estrategia| ≤ fracción × |SPY|. En el signo
  // original (ambos negativos) equivale a dd_est >= tope.
  const ddTope = ddSpy == null ? null : ddSpy * criterios.drawdown_max_fraccion_spy;
  const retPiso = retAnualSpy == null ? null : retAnualSpy - criterios.ret_anual_holgura_max;

  const completos = Math.max(0, canastas.length - 1);
  const invertidas = canastas.filter((c) => c.nombres.length > 0);
  const enEfectivo = canastas.length - invertidas.length;

  const cumple = {
    muestra: completos >= criterios.min_rebalanceos,
    sharpe: sharpeNeto != null && sharpeUmbral != null && sharpeNeto >= sharpeUmbral,
    drawdown: ddEstrategia != null && ddTope != null && ddEstrategia >= ddTope,
    retorno: retAnualNeto != null && retPiso != null && retAnualNeto >= retPiso,
  };
  const veredicto = !cumple.muestra ? 'INCONCLUSO'
    : (cumple.sharpe && cumple.drawdown && cumple.retorno) ? 'GO' : 'NO-GO';

  // CANDADO DE HONESTIDAD PRE-REGISTRADO: un GO con cero activaciones del gate
  // es un GO sobre un mecanismo defensivo QUE NO SE PROBÓ en esta ventana. Se
  // topa en GO FRÁGIL. No aplica a los cortes sin gate (no hay mecanismo que
  // probar ahí, y decir "frágil" ahí sería ruido).
  const gateProbado = gateInfo.activaciones == null || gateInfo.activaciones > 0;
  const fragil = veredicto === 'GO' && !gateProbado;

  return {
    ...comun,
    muestra: {
      rebalanceos_programados: iRebalanceos.length,
      rebalanceos_ejecutados: canastas.length,
      rebalanceos_completos: completos,
      rebalanceos_saltados: saltados.length,
      saltados,
      meses_en_efectivo: enEfectivo,
      meses_invertidos: invertidas.length,
      nombres_promedio_invertido: media(invertidas.map((c) => c.nombres.length)),
      nombres_min: invertidas.length ? Math.min(...invertidas.map((c) => c.nombres.length)) : 0,
      nombres_max: invertidas.length ? Math.max(...invertidas.map((c) => c.nombres.length)) : 0,
      elegibles_promedio: media(invertidas.map((c) => c.elegibles)),
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
      nota: 'DIAGNÓSTICO, no criterio: esta estrategia promete defensa, no alfa.',
    },
    economia: {
      ret_anual_neto: retAnualNeto,
      ret_anual_spy: retAnualSpy,
      ret_anual_piso: retPiso,
      exceso_anual: exceso,
      sharpe_neto: sharpeNeto,
      sharpe_spy: sharpeSpy,
      sharpe_umbral: sharpeUmbral,
      sharpe_bruto: sharpeAnual(bruto.retornos),
      max_drawdown: ddEstrategia,
      max_drawdown_spy: ddSpy,
      max_drawdown_tope: ddTope,
      drawdown_relativo: (ddEstrategia == null || !ddSpy) ? null : ddEstrategia / ddSpy,
      ret_total_neto: neto.equity_final - 1,
      ret_total_bruto: bruto.equity_final - 1,
      turnover_medio: neto.turnover_medio,
      turnover_mediana: neto.turnover_mediana,
      costo_total: neto.costo_total,
      arrastres_no_negociables: neto.arrastres_no_negociables,
    },
    cumple,
    veredicto,
    fragil,
    fragil_motivo: fragil ? 'gate sin evento en ventana' : null,
    // Se puebla siempre; el endpoint lo borra salvo ?canastas=1.
    detalle_canastas: canastas,
  };
}

// ─────────────────── puente con /api/rotation-analyze ───────────────────

// El split "sin filtros" (sin gate, sin absoluto) es momentum relativo puro
// sobre el MISMO universo y la MISMA ventana que el corte "solo momentum" del
// rotation, que reportó t = 1.87. Tiene que REPRODUCIRLO aproximadamente.
//
// Esto NO es un criterio de éxito de la estrategia: es un chequeo de
// INTEGRIDAD de la herencia del universo. Si la brecha se sale de la banda
// pre-registrada, la lectura correcta no es "el momentum cambió" — las dos
// corridas miden lo mismo sobre los mismos datos — sino que algo se rompió en
// la herencia: otro set de símbolos, otra ventana, otro calendario. Y el
// reporte lo dice, en vez de publicar un número que no cuadra con su gemelo.
function evaluaPuente(bloque, criterios = CRITERIOS) {
  const esperado = criterios.puente_rotation_t_referencia;
  const tolerancia = criterios.puente_tolerancia_t;
  const observado = bloque && bloque.senal ? bloque.senal.t : null;
  if (observado == null) {
    return {
      t_esperado: esperado, tolerancia, t_observado: null, brecha: null, reproduce: null,
      nota: 'El split "sin filtros" no produjo una serie con la que comparar (sin canastas ejecutadas): '
        + 'el puente con /api/rotation-analyze NO se pudo verificar en esta corrida.',
    };
  }
  const brecha = observado - esperado;
  const reproduce = Math.abs(brecha) <= tolerancia;
  return {
    t_esperado: esperado, tolerancia, t_observado: observado, brecha, reproduce,
    nota: reproduce
      ? `El puente cuadra: t = ${num(observado)} contra el t = ${num(esperado)} del corte "solo momentum" `
        + `de /api/rotation-analyze (brecha ${num(brecha)}, banda ±${num(tolerancia)}). Se esperaba que `
        + 'cuadrara: es la MISMA medición sobre los MISMOS datos, así que esto CONFIRMA la herencia del '
        + 'universo — NO confirma el momentum. Recordar el caveat: no es evidencia independiente.'
      : `EL PUENTE NO CUADRA: t = ${num(observado)} contra el t = ${num(esperado)} esperado del corte `
        + `"solo momentum" de /api/rotation-analyze (brecha ${num(brecha)}, fuera de la banda `
        + `±${num(tolerancia)}). Las dos corridas deberían medir esencialmente LO MISMO sobre los MISMOS `
        + 'datos, así que la sospecha NO es que el momentum haya cambiado: es que la HERENCIA DEL '
        + 'UNIVERSO está mal — otro set de símbolos, otra ventana o otro calendario. Revisar eso ANTES '
        + 'de creerle un solo número a este reporte.',
  };
}

// ─────────────────── resumen en español ───────────────────

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : (x * 100).toFixed(d) + '%');
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : x.toFixed(d));
const marca = (ok) => (ok ? '✅' : '❌');
const etiquetaVeredicto = (b) =>
  (b.veredicto === 'GO' && b.fragil ? `GO frágil (${b.fragil_motivo})` : b.veredicto);

// Una fila por criterio: qué pedía, qué salió, si pasa. El umbral va calculado
// con los números de SPY DE ESTA VENTANA, no en abstracto — la vara es
// relativa, así que mostrarla en abstracto no diría nada.
function filasCriterios(b, c) {
  const m = b.muestra, e = b.economia || {};
  return [
    [`1 · ≥ ${c.min_rebalanceos} rebalanceos mensuales completos`,
      String(m.rebalanceos_completos), m.rebalanceos_completos >= c.min_rebalanceos],
    [`2 · Sharpe neto ≥ Sharpe SPY + ${num(c.sharpe_prima_min, 2)}`,
      `${num(e.sharpe_neto)} vs umbral ${num(e.sharpe_umbral)} (SPY ${num(e.sharpe_spy)})`, b.cumple.sharpe],
    [`3 · Max drawdown ≤ ${(c.drawdown_max_fraccion_spy * 100).toFixed(0)}% del de SPY`,
      `${pct(e.max_drawdown)} vs tope ${pct(e.max_drawdown_tope)} (SPY ${pct(e.max_drawdown_spy)})`, b.cumple.drawdown],
    [`4 · Retorno anual neto ≥ SPY − ${pct(c.ret_anual_holgura_max, 0)}`,
      `${pct(e.ret_anual_neto)} vs piso ${pct(e.ret_anual_piso)} (SPY ${pct(e.ret_anual_spy)})`, b.cumple.retorno],
  ];
}

function bloqueCorto(titulo, b) {
  if (!b.economia) return `**${titulo}** → ${etiquetaVeredicto(b)} · sin canastas ejecutadas`;
  const g = b.gate_activaciones == null ? 'sin gate' : `gate ${b.gate_activaciones}`;
  return `**${titulo}** → ${etiquetaVeredicto(b)}`
    + ` · rebalanceos ${b.muestra.rebalanceos_completos} · ${g}`
    + ` · efectivo ${b.muestra.meses_en_efectivo} m`
    + ` · Sharpe neto ${num(b.economia.sharpe_neto)} (SPY ${num(b.economia.sharpe_spy)})`
    + ` · maxDD ${pct(b.economia.max_drawdown)} (SPY ${pct(b.economia.max_drawdown_spy)})`
    + ` · anual ${pct(b.economia.ret_anual_neto)} (SPY ${pct(b.economia.ret_anual_spy)})`
    + ` · turnover ${pct(b.economia.turnover_medio, 0)}`;
}

function renderResumenMarkdown(s) {
  const c = s.criterios, p = s.principal, L = [];
  L.push('# Dual Momentum con gate de tendencia — ¿defiende sin costar alfa?');
  L.push('');
  L.push(`**VEREDICTO: ${etiquetaVeredicto(p)}**`);
  L.push('');
  L.push(`Generado ${s.generado_en} · solo lectura · ventana ${s.datos.ventana_analisis.desde} → ${s.datos.ventana_analisis.hasta}`);
  L.push('');

  // El candado de honestidad va ARRIBA del todo: es lo primero que cambia la
  // lectura de los números que siguen.
  L.push('## Candado de honestidad: ¿se probó el mecanismo defensivo?');
  L.push('');
  const act = p.gate_activaciones;
  if (act == null) {
    L.push('La corrida principal no lleva gate (no debería pasar: la principal SIEMPRE lo lleva).');
  } else if (act === 0) {
    L.push('**NO. `gate_activaciones = 0`**: en toda la ventana el SPY nunca cerró debajo de su');
    L.push(`SMA de ${c.gate_sma_dias} días en una fecha de rebalanceo, así que la cartera **nunca se fue a`);
    L.push('efectivo por el gate macro**. El mecanismo que esta estrategia vende como su defensa');
    L.push('**no se ejerció ni una vez**: en esta ventana fue idéntica a su versión sin gate.');
    L.push('Por la regla pre-registrada, el veredicto se topa en **GO frágil (gate sin evento en');
    L.push('ventana)** aunque los cuatro criterios pasen — y si no pasan, el NO-GO tampoco es');
    L.push('sobre el gate, porque el gate no hizo nada.');
  } else {
    L.push(`**SÍ. \`gate_activaciones = ${act}\`**: el gate macro mandó la cartera entera a efectivo en`);
    L.push(`${act} rebalanceo${act === 1 ? '' : 's'} de la ventana. El mecanismo defensivo se ejerció y los`);
    L.push('números de abajo sí lo incluyen.');
    const meses = (p.gate.meses || []).filter((m) => m.motivo === 'spy_bajo_sma').map((m) => m.fecha);
    if (meses.length) L.push(`Meses en efectivo por el gate: ${meses.join(', ')}.`);
  }
  if (p.gate && p.gate.sin_sma) {
    L.push('');
    L.push(`> ⚠️ ${p.gate.sin_sma} rebalanceo(s) se fueron a efectivo porque NO se pudo calcular la SMA`);
    L.push('> (falta de historia), no porque el SPY estuviera debajo. Van contados APARTE de');
    L.push('> `gate_activaciones`: un hueco de datos no es una prueba del mecanismo.');
  }
  L.push('');

  L.push('## Especificación principal (una sola, fijada antes de correr)');
  L.push('');
  L.push(`- Universo: ${s.especificacion.universo}.`);
  L.push(`- Rebalanceo: ${s.especificacion.rebalanceo}.`);
  L.push(`- Selección: ${s.especificacion.seleccion}.`);
  L.push(`- Filtro (a) momentum absoluto: ${s.especificacion.filtro_absoluto}.`);
  L.push(`- Filtro (b) gate macro: ${s.especificacion.gate_macro}.`);
  L.push(`- Efectivo: ${s.especificacion.efectivo}.`);
  L.push(`- Costos: ${s.especificacion.costo_por_lado_bp} bp por lado sobre el turnover real.`);
  L.push(`- Benchmark: ${s.especificacion.benchmark}.`);
  L.push('');
  L.push('## Criterios de éxito (congelados en CRITERIOS antes de correr)');
  L.push('');
  L.push('| Criterio | Resultado | ¿Pasa? |');
  L.push('|---|---|---|');
  for (const [k, v, ok] of filasCriterios(p, c)) L.push(`| ${k} | ${v} | ${marca(ok)} |`);
  L.push('');
  L.push('> Regla del veredicto: **GO = §2 y §3 y §4**. Falla de muestra (§1) → INCONCLUSO');
  L.push('> (no NO-GO: sin muestra no se afirma que la estrategia no sirve). El resto → NO-GO.');
  L.push('> Los tres criterios económicos son **relativos a SPY en la misma ventana**: esta');
  L.push('> estrategia promete DEFENSA, no alfa, y un umbral absoluto de Sharpe premia el');
  L.push('> régimen (lección del rotation: en un año dorado la vara absoluta se queda corta).');
  L.push('');
  if (!p.cumple.muestra) {
    L.push(`> La muestra no alcanza: ${p.muestra.rebalanceos_completos} rebalanceos completos`);
    L.push(`> (piso ${c.min_rebalanceos}). Por la regla fijada de antemano: **INCONCLUSO**, no "casi".`);
    L.push('');
  }
  if (!p.economia) {
    L.push('## Sin canastas ejecutadas');
    L.push('');
    L.push(`Ningún rebalanceo llegó al piso de ${c.min_elegibles_rebalanceo} nombres elegibles`);
    L.push(`(${p.muestra.rebalanceos_programados} programados, ${p.muestra.rebalanceos_saltados} saltados).`);
    L.push('No hay economía que medir: **INCONCLUSO**.');
    L.push('');
    if (s.puente) { L.push(`> Puente con /api/rotation-analyze: ${s.puente.nota}`); L.push(''); }
    L.push('## Caveat pre-registrado');
    L.push('');
    L.push(s.caveat);
    L.push('');
    return L.join('\n');
  }
  L.push('## Muestra y cartera');
  L.push('');
  L.push(`- Símbolos del universo (los mismos de rotation-analyze): ${s.datos.simbolos}`
    + (s.datos.sin_precios.length ? ` · sin precios en Yahoo: ${s.datos.sin_precios.join(', ')}` : ''));
  L.push(`- Rebalanceos programados ${p.muestra.rebalanceos_programados} · ejecutados ${p.muestra.rebalanceos_ejecutados} · completos **${p.muestra.rebalanceos_completos}**`);
  L.push(`- Meses INVERTIDO ${p.muestra.meses_invertidos} · meses en EFECTIVO **${p.muestra.meses_en_efectivo}**`
    + ` (gate ${p.gate_activaciones == null ? 'n/a' : p.gate_activaciones}`
    + `${p.gate && p.gate.sin_sma ? ` + ${p.gate.sin_sma} sin SMA` : ''}`
    + `${p.filtro_absoluto.canastas_vaciadas ? ` + ${p.filtro_absoluto.canastas_vaciadas} por momentum absoluto` : ''})`);
  L.push(`- Nombres por canasta invertida: promedio **${num(p.muestra.nombres_promedio_invertido, 1)}** (min ${p.muestra.nombres_min} · max ${p.muestra.nombres_max})`);
  L.push(`- Filtro absoluto: recortó ${p.filtro_absoluto.nombres_recortados} nombre(s) del decil en `
    + `${p.filtro_absoluto.rebalanceos_con_recorte} rebalanceo(s)`
    + (p.filtro_absoluto.nombres_recortados === 0
      ? ' — es decir, **no se ejerció**: el decil superior por momentum relativo nunca tuvo un 12-1 negativo.'
      : '.'));
  L.push(`- Rango operado: ${p.muestra.rango.desde} → ${p.muestra.rango.hasta} · ${p.muestra.dias_cartera} sesiones`);
  L.push('');
  L.push('## Economía (siempre neta de costos)');
  L.push('');
  L.push(`- Retorno anualizado neto: **${pct(p.economia.ret_anual_neto)}** vs SPY ${pct(p.economia.ret_anual_spy)} → diferencia ${pct(p.economia.exceso_anual)}`);
  L.push(`- Sharpe neto: **${num(p.economia.sharpe_neto)}** vs SPY ${num(p.economia.sharpe_spy)} (bruto ${num(p.economia.sharpe_bruto)})`);
  L.push(`- Max drawdown: **${pct(p.economia.max_drawdown)}** vs SPY ${pct(p.economia.max_drawdown_spy)}`
    + ` → ${num(p.economia.drawdown_relativo, 2)}× el de SPY (tope pre-registrado ${num(c.drawdown_max_fraccion_spy, 2)}×)`);
  L.push(`- Retorno total neto ${pct(p.economia.ret_total_neto)} (bruto ${pct(p.economia.ret_total_bruto)})`);
  L.push(`- Turnover medio por rebalanceo: ${pct(p.economia.turnover_medio, 1)} (mediana ${pct(p.economia.turnover_mediana, 1)}) · costo acumulado ${pct(p.economia.costo_total, 2)} del capital inicial`);
  if (p.economia.arrastres_no_negociables) {
    L.push(`- Posiciones arrastradas por falta de apertura (no se pudieron rotar): ${p.economia.arrastres_no_negociables}`);
  }
  L.push('');
  L.push('## Diagnóstico (NO es criterio): retorno anormal vs SPY');
  L.push('');
  L.push(`- Abnormal diario medio (bruto): ${pct(p.senal.abnormal_diario_medio, 4)} · t = ${num(p.senal.t)}`);
  L.push(`- Neto de costos: ${pct(p.senal.abnormal_diario_medio_neto, 4)} · t = ${num(p.senal.t_neto)}`);
  L.push('- Se reporta porque informa, pero el veredicto NO cuelga de él: lo que promete esta');
  L.push('  estrategia es defensa (§3), no alfa.');
  L.push('');
  L.push('## Sensibilidades obligatorias');
  L.push('');
  for (const b of s.sensibilidades) {
    L.push(bloqueCorto(b.nombre, b.resultado));
    if (b.lectura) L.push(`  - ${b.lectura}`);
    L.push('');
  }
  if (s.atribucion) { L.push(`> **Atribución del gate**: ${s.atribucion}`); L.push(''); }
  if (s.atribucion_recorte) { L.push(`> **Atribución del filtro absoluto (pesos)**: ${s.atribucion_recorte}`); L.push(''); }
  if (s.nota_bimestral) { L.push('> ' + s.nota_bimestral); L.push(''); }
  L.push('## Cortes EXPLORATORIOS (no cuentan para el veredicto)');
  L.push('');
  for (const e of s.exploratorio) {
    L.push(`**[${e.etiqueta}] ${e.nombre}**`);
    L.push(`- Por qué: ${e.por_que}`);
    L.push(`- ${bloqueCorto('Resultado', e.resultado)}`);
    L.push('');
  }
  if (s.puente) {
    L.push('## Puente con `/api/rotation-analyze` (chequeo de integridad, no criterio)');
    L.push('');
    L.push(`**${s.puente.reproduce === null ? 'NO VERIFICABLE' : s.puente.reproduce ? 'CUADRA' : '⚠️ NO CUADRA'}**`
      + ` — t observado ${num(s.puente.t_observado)} · t esperado ${num(s.puente.t_esperado)}`
      + ` · brecha ${num(s.puente.brecha)} · banda ±${num(s.puente.tolerancia)}`);
    L.push('');
    L.push(s.puente.nota);
    L.push('');
  }
  L.push('## Caveat pre-registrado: no es una prueba independiente');
  L.push('');
  L.push(s.caveat);
  L.push('');
  return L.join('\n');
}

export {
  CRITERIOS, GATE_PRINCIPAL, GATE_FABER, GATE_OFF,
  ultimosHabilesDelMes, smaDias, smaMeses, evaluaGate,
  construyeCanastasDual, curvaDesdeRetornos, corre, evaluaPuente,
  renderResumenMarkdown, filasCriterios, bloqueCorto, etiquetaVeredicto, pct, num,
  // re-exportadas para el endpoint (mismas primitivas que rotation/pead)
  alineaAlCalendario, recortaVelasIncompletas, cierreVigente,
  media, mediana, tStat, sharpeAnual, maxDrawdown, anualizado,
  restaMeses, indiceHasta, primerosHabilesDelMes, momentum121, simulaRotacion, serieSpy,
};
