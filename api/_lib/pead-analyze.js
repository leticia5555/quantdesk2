// ═══════════════════════════════════════════════════════════════════
// api/_lib/pead-analyze.js — Fase 2 del PEAD: ¿existe drift OPERABLE?
//
// Lógica PURA (cero I/O): recibe eventos de `pead_earnings` + horas de
// `pead_event_hour` + series diarias ajustadas de Yahoo, y devuelve el
// veredicto contra umbrales FIJADOS ANTES DE CORRER (§CRITERIOS). El
// endpoint /api/pead-analyze solo hace de plomería (SELECT + fetch).
//
// ── La única especificación principal ──────────────────────────────
//   Entrada  : PRIMERA APERTURA POSTERIOR AL REPORTE, sin look-ahead.
//              BMO → open del MISMO día del reporte.
//              AMC → open del día siguiente.
//              DMH → como AMC (la primera apertura posterior es la del
//                    día siguiente; el anuncio salió con el mercado abierto).
//              Sin hora → como AMC en la principal. Tratarlo como BMO
//              METERÍA look-ahead si en realidad fue AMC (compraríamos en
//              una apertura anterior al anuncio); AMC nunca lo mete —
//              a lo sumo entra un día tarde. Las dos sensibilidades del
//              §4 (todo-BMO / todo-AMC) acotan cuánto pesa esa decisión.
//   Señal    : decil superior de sorpresa positiva (percentil 90 calculado
//              SOBRE los eventos de sorpresa > 0 de la muestra operable).
//   Tenencia : 10 sesiones — entrada open(d0), salida close(d0+9).
//              5 y 20 solo como sensibilidad.
//   Costos   : 10 bp por lado (compra al open ×1.001, venta al close ×0.999).
//   Cartera  : long-only, máximo 8 posiciones concurrentes.
//
// ── Por qué calendar-time y no promedio de eventos ─────────────────
// Los earnings se apelotonan en 4 ventanas al año: los retornos de eventos
// simultáneos están correlacionados y un t-stat por evento infla la
// significancia. Se forma una cartera DIARIA equiponderada de todo lo
// abierto, se le resta el retorno de SPY ese día, y el t-stat sale de esa
// serie (Fama-French calendar-time). Ver docs/pead-backtest-scope.md §3.6.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────── CRITERIOS (congelados) ───────────────────
// Se exportan para que el test los verifique y para que salgan en el JSON:
// si alguien los mueve después de ver los números, el diff lo delata.
const CRITERIOS = {
  min_eventos_operables: 300,   // §1 — si no se alcanza → INCONCLUSO
  // §1b — candado pre-registrado: un decil con menos de 30 trades no alcanza
  // para emitir GO por bueno que se vea. Con ~10% de las sorpresas positivas,
  // el decil puede quedarse en un puñado de eventos: ahí el retorno medio y el
  // Sharpe son ruido con forma de resultado. Por debajo → INCONCLUSO, sin
  // importar los números. Se cuenta sobre los trades EJECUTADOS (después del
  // tope de concurrentes), que es el más estricto de los dos conteos.
  min_trades_decil: 30,
  t_minimo: 2,                  // §2 — |t| del abnormal calendar-time
  ret_neto_min_por_trade: 0.0030, // §3 — +0.30% neto promedio
  sharpe_min: 0.7,              // §3 — Sharpe de la estrategia
  decil: 0.90,                  // §2 — percentil de corte de la sorpresa
  hold_principal: 10,           // §3 — sesiones de tenencia
  holds_sensibilidad: [5, 20],
  max_concurrentes: 8,
  costo_por_lado: 0.0010,       // 10 bp
  anios_ventana: 3,
};

const DIA_MS = 86400000;

// ─────────────────── utilidades numéricas ───────────────────

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Desviación estándar MUESTRAL (n−1): es una muestra, no la población.
function desvest(a) {
  if (a.length < 2) return null;
  const m = media(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function mediana(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// t = media / (sd/√n). Devuelve nulls (no NaN, no 0) si no hay muestra:
// un t inventado es peor que un t ausente.
function tStat(a) {
  const n = a.length;
  if (n < 2) return { n, media: n ? a[0] : null, sd: null, t: null };
  const m = media(a), sd = desvest(a);
  return { n, media: m, sd, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
}

// Sharpe anualizado desde retornos DIARIOS (×√252, convención de la casa —
// sharpeRatio en signal-backtester.js). Rf = 0, igual que el resto del repo.
function sharpeAnual(retornosDiarios) {
  if (retornosDiarios.length < 2) return null;
  const m = media(retornosDiarios), sd = desvest(retornosDiarios);
  if (!sd || sd <= 0) return null;
  return (m / sd) * Math.sqrt(252);
}

// Percentil por rango-más-cercano sobre un arreglo YA ordenado ascendente.
// Sin interpolación a propósito: el corte tiene que ser un valor de sorpresa
// REAL de la muestra, no un promedio inventado entre dos eventos.
function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil(p * ordenados.length) - 1));
  return ordenados[i];
}

// ─────────────────── series de precio ───────────────────

// La vela del día en curso está incompleta hasta el cierre: se corta todo lo
// que sea >= hoy (UTC) antes de las 22:00 UTC. Misma medicina que
// completedSlice() en _lib/sim.js — es la convención anti look-ahead de la casa.
function recortaVelasIncompletas(serie, now = new Date()) {
  const hoy = now.toISOString().slice(0, 10);
  const incluyeHoy = now.getUTCHours() >= 22;
  const fuera = (d) => d > hoy || (d === hoy && !incluyeHoy);
  const keep = serie.fechas.map((d) => !fuera(d));
  return {
    fechas: serie.fechas.filter((_, i) => keep[i]),
    opens: serie.opens.filter((_, i) => keep[i]),
    closes: serie.closes.filter((_, i) => keep[i]),
  };
}

// Alinea una serie {fechas,opens,closes} al calendario canónico (el de SPY).
// Devuelve arreglos del largo del calendario con null donde el símbolo no
// tuvo vela (halt, feriado propio, listado posterior).
function alineaAlCalendario(serie, calendario) {
  const porFecha = new Map();
  for (let i = 0; i < serie.fechas.length; i++) {
    porFecha.set(serie.fechas[i], { o: serie.opens[i], c: serie.closes[i] });
  }
  const opens = new Array(calendario.length).fill(null);
  const closes = new Array(calendario.length).fill(null);
  for (let i = 0; i < calendario.length; i++) {
    const v = porFecha.get(calendario[i]);
    if (v && Number.isFinite(v.o) && v.o > 0 && Number.isFinite(v.c) && v.c > 0) {
      opens[i] = v.o; closes[i] = v.c;
    }
  }
  return { opens, closes };
}

// Cierre vigente en el índice i: el último conocido <= i. Si un símbolo no
// cotizó ese día se arrastra el anterior (retorno 0), que es exactamente lo
// que le pasa a la posición — no se inventa precio ni se la saca del libro.
function cierreVigente(closes, i) {
  for (let k = i; k >= 0; k--) if (closes[k] != null) return closes[k];
  return null;
}

// ─────────────────── alineación del evento ───────────────────

// Hora efectiva según la política de la corrida.
//   'amc'  (principal) → los null se tratan como AMC
//   'bmo'  (sensibilidad) → los null se tratan como BMO
//   'drop' (sensibilidad) → los null se descartan
// 'dmh' SIEMPRE cae a AMC: si el anuncio salió con el mercado abierto, la
// primera apertura posterior es la del día siguiente.
function horaEfectiva(hour, politica) {
  const h = (hour || '').toLowerCase();
  if (h === 'bmo') return 'bmo';
  if (h === 'amc' || h === 'dmh') return 'amc';
  if (politica === 'drop') return null;
  return politica === 'bmo' ? 'bmo' : 'amc';
}

// Índice de la sesión de ENTRADA en el calendario.
//   BMO → primera sesión con fecha >= reported_date (el mismo día si opera;
//         si el reporte cayó en sábado/feriado, la siguiente sesión).
//   AMC → primera sesión con fecha  > reported_date.
// Búsqueda binaria: el calendario está ordenado y esto corre por evento.
function indiceEntrada(calendario, reportedDate, hora) {
  const estricto = hora === 'amc';
  let lo = 0, hi = calendario.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ok = estricto ? calendario[mid] > reportedDate : calendario[mid] >= reportedDate;
    if (ok) hi = mid; else lo = mid + 1;
  }
  return lo < calendario.length ? lo : -1;
}

// ─────────────────── construcción de la muestra ───────────────────

// eventos crudos: [{symbol, reported_date, surprise, surprise_pct, hour, hour_source}]
// seriesAlineadas: { SYM: {opens, closes} } ya sobre el calendario
//
// Un evento es OPERABLE si, con la hora de esta corrida: cae en la ventana,
// hay open en la sesión de entrada, hay close en la sesión de salida del hold
// principal, y hay un close previo (para medir el gap incapturable). Todo lo
// que se cae se cuenta y se reporta — nada desaparece en silencio.
function construyeMuestra({ eventos, calendario, seriesAlineadas, politicaHora, criterios = CRITERIOS, desde = null }) {
  const N = criterios.hold_principal;
  const ultimo = calendario.length - 1;
  const descartes = {
    sin_hora_descartada: 0, fuera_de_ventana: 0, sin_serie: 0,
    sin_open_entrada: 0, sin_close_previo: 0, sin_salida_completa: 0,
  };
  const operables = [];

  for (const ev of eventos) {
    const hora = horaEfectiva(ev.hour, politicaHora);
    if (!hora) { descartes.sin_hora_descartada++; continue; }
    if (desde && ev.reported_date < desde) { descartes.fuera_de_ventana++; continue; }

    const serie = seriesAlineadas[ev.symbol];
    if (!serie) { descartes.sin_serie++; continue; }

    const i = indiceEntrada(calendario, ev.reported_date, hora);
    if (i < 0 || i === 0) { descartes.sin_open_entrada++; continue; }   // i=0 no tiene close previo
    if (serie.opens[i] == null) { descartes.sin_open_entrada++; continue; }

    const cierrePrevio = cierreVigente(serie.closes, i - 1);
    if (cierrePrevio == null) { descartes.sin_close_previo++; continue; }

    const iSalida = i + N - 1;
    if (iSalida > ultimo || serie.closes[iSalida] == null) { descartes.sin_salida_completa++; continue; }

    const open = serie.opens[i];
    operables.push({
      symbol: ev.symbol,
      reported_date: ev.reported_date,
      hour_original: ev.hour || null,
      hour_source: ev.hour_source || null,
      hora_efectiva: hora,
      hora_imputada: !(ev.hour === 'bmo' || ev.hour === 'amc' || ev.hour === 'dmh'),
      surprise: ev.surprise,
      surprise_pct: ev.surprise_pct,
      // Sorpresa escalada por precio: robusta a estimados ~0 (donde surprise_pct
      // explota a miles de %). Solo se usa en cortes EXPLORATORIOS.
      surprise_sobre_precio: Number.isFinite(ev.surprise) ? (ev.surprise / cierrePrevio) * 100 : null,
      i_entrada: i,
      fecha_entrada: calendario[i],
      open_entrada: open,
      close_previo: cierrePrevio,
      // Gap overnight que ya no se puede capturar aunque entres en la primera
      // apertura: entre el cierre previo al anuncio y el open al que compras.
      gap_incapturable: open / cierrePrevio - 1,
    });
  }
  return { operables, descartes };
}

// Retorno bruto/neto de un trade con tenencia de N sesiones.
// Entrada al open de i (×(1+c) — el costo siempre en contra), salida al close
// de i+N−1 (×(1−c)). Devuelve null si la salida no existe en los datos.
function retornoTrade(ev, serie, N, costo) {
  const iSalida = ev.i_entrada + N - 1;
  if (iSalida >= serie.closes.length) return null;
  const salida = cierreVigente(serie.closes, iSalida);
  if (salida == null) return null;
  const bruto = salida / ev.open_entrada - 1;
  const neto = (salida * (1 - costo)) / (ev.open_entrada * (1 + costo)) - 1;
  return { bruto, neto, i_salida: iSalida, close_salida: salida };
}

// ─────────────────── señal: decil superior ───────────────────

// "Decil superior de sorpresa positiva": el corte es el percentil 90 calculado
// SOBRE la población de sorpresas > 0 de la muestra operable. Se devuelve el
// corte para que quede auditable (y para poder discutir si el ranking por
// surprise_pct está contaminado por estimados cerca de cero — ver `campo`).
function seleccionaDecil(operables, { campo = 'surprise_pct', p = CRITERIOS.decil } = {}) {
  const positivos = operables.filter((e) => Number.isFinite(e[campo]) && e[campo] > 0);
  const corte = percentil(positivos.map((e) => e[campo]).sort((a, b) => a - b), p);
  const seleccion = corte == null ? [] : positivos.filter((e) => e[campo] >= corte);
  return { corte, positivos: positivos.length, seleccion };
}

// ─────────────────── cartera calendar-time ───────────────────

// Serie DIARIA equiponderada de todo lo abierto, menos SPY el mismo día.
// El retorno de la posición el día de entrada es close(i)/open(i)−1 (se compra
// al open); los días siguientes close(d)/close(d−1)−1. Compuestos dan exacto
// close(i+N−1)/open(i)−1. Se saltan los días SIN posiciones abiertas: el
// abnormal de una cartera vacía es 0 por construcción y meterlo solo diluiría
// la varianza y regalaría un t-stat más grande.
function carteraCalendarTime({ seleccion, seriesAlineadas, spyCloses, calendario, N, costo = 0 }) {
  const abiertas = new Map();  // índice de día → [posiciones que abren]
  for (const ev of seleccion) {
    if (!abiertas.has(ev.i_entrada)) abiertas.set(ev.i_entrada, []);
    abiertas.get(ev.i_entrada).push(ev);
  }
  const dias = [];
  for (let d = 1; d < calendario.length; d++) {
    const retornos = [];
    for (const [iEnt, evs] of abiertas) {
      if (d < iEnt || d > iEnt + N - 1) continue;
      for (const ev of evs) {
        const s = seriesAlineadas[ev.symbol];
        if (!s) continue;
        const hoy = cierreVigente(s.closes, d);
        if (hoy == null) continue;
        let r;
        if (d === iEnt) {
          // Costo de entrada cargado el día 1 (compra al open ×(1+c)).
          r = hoy / (ev.open_entrada * (1 + costo)) - 1;
        } else {
          const ayer = cierreVigente(s.closes, d - 1);
          if (ayer == null) continue;
          r = hoy / ayer - 1;
        }
        // Costo de salida cargado el último día (venta al close ×(1−c)).
        if (d === iEnt + N - 1 && costo) r = (1 + r) * (1 - costo) - 1;
        retornos.push(r);
      }
    }
    if (!retornos.length) continue;
    const spyHoy = cierreVigente(spyCloses, d), spyAyer = cierreVigente(spyCloses, d - 1);
    if (spyHoy == null || spyAyer == null) continue;
    const rCartera = media(retornos);
    const rSpy = spyHoy / spyAyer - 1;
    dias.push({ fecha: calendario[d], n: retornos.length, cartera: rCartera, spy: rSpy, abnormal: rCartera - rSpy });
  }
  return dias;
}

// ─────────────────── simulación operable ───────────────────

// Long-only, tenencia fija de N sesiones, tope de posiciones concurrentes,
// costo por lado. Capital fraccionado: cada entrada toma equity/max_pos.
// Si en una sesión hay más candidatos que cupos, entran los de MAYOR sorpresa
// (desempate por símbolo, para que la corrida sea determinista); el resto se
// cuenta en `rechazados_por_cupo` — un backtest que se "olvida" de los
// descartados finge una capacidad que no tiene.
function simula({ seleccion, seriesAlineadas, calendario, N, maxPos, costo, campoOrden = 'surprise_pct' }) {
  const porDia = new Map();
  for (const ev of seleccion) {
    if (!porDia.has(ev.i_entrada)) porDia.set(ev.i_entrada, []);
    porDia.get(ev.i_entrada).push(ev);
  }
  for (const [, evs] of porDia) {
    evs.sort((a, b) => (b[campoOrden] - a[campoOrden]) || (a.symbol < b.symbol ? -1 : 1));
  }

  let equity = 1, cash = 1;
  const abiertas = [];
  const trades = [];
  let rechazadosPorCupo = 0;
  let rechazadosPorCash = 0;
  const curva = [];   // {fecha, equity}
  let equityPrev = 1;
  const retornosDiarios = [];
  const ocupacion = [];   // cupos usados al cierre de cada sesión

  for (let d = 0; d < calendario.length; d++) {
    // 1) Entradas al OPEN de d (los cupos liberados al close de d−1 ya están libres).
    const candidatos = porDia.get(d) || [];
    for (const ev of candidatos) {
      if (abiertas.length >= maxPos) { rechazadosPorCupo++; continue; }
      const s = seriesAlineadas[ev.symbol];
      if (!s || s.opens[d] == null) { continue; }
      const notional = equity / maxPos;
      // Distinto del tope de cupos: el capital ya está comprometido en las
      // otras posiciones. Se cuenta aparte para no disfrazar de "tope de 8"
      // lo que en realidad es falta de efectivo.
      if (notional > cash + 1e-12) { rechazadosPorCash++; continue; }
      const precio = ev.open_entrada * (1 + costo);
      cash -= notional;
      abiertas.push({ ev, qty: notional / precio, notional, i_salida: d + N - 1, precio_entrada: precio });
    }

    // 2) Marca a mercado al CLOSE de d.
    let valorAbiertas = 0;
    for (const p of abiertas) {
      const c = cierreVigente(seriesAlineadas[p.ev.symbol].closes, d);
      valorAbiertas += p.qty * (c == null ? p.precio_entrada : c);
    }
    equity = cash + valorAbiertas;

    // 3) Salidas al CLOSE de d.
    for (let k = abiertas.length - 1; k >= 0; k--) {
      const p = abiertas[k];
      if (p.i_salida !== d) continue;
      const c = cierreVigente(seriesAlineadas[p.ev.symbol].closes, d);
      if (c == null) continue;               // sin close no se liquida: se arrastra
      const precioSalida = c * (1 - costo);
      cash += p.qty * precioSalida;
      trades.push({
        symbol: p.ev.symbol, reported_date: p.ev.reported_date, hora: p.ev.hora_efectiva,
        surprise_pct: p.ev.surprise_pct, fecha_entrada: p.ev.fecha_entrada, fecha_salida: calendario[d],
        bruto: c / p.ev.open_entrada - 1,
        neto: precioSalida / p.precio_entrada - 1,
      });
      abiertas.splice(k, 1);
    }

    // Equity al cierre, ya con las salidas liquidadas.
    valorAbiertas = 0;
    for (const p of abiertas) {
      const c = cierreVigente(seriesAlineadas[p.ev.symbol].closes, d);
      valorAbiertas += p.qty * (c == null ? p.precio_entrada : c);
    }
    equity = cash + valorAbiertas;
    curva.push({ fecha: calendario[d], equity });
    ocupacion.push(abiertas.length);
    if (d > 0) retornosDiarios.push(equity / equityPrev - 1);
    equityPrev = equity;
  }

  const netos = trades.map((t) => t.neto);
  const brutos = trades.map((t) => t.bruto);
  // Exposición media: cuántos de los `maxPos` cupos estuvieron ocupados. Un
  // Sharpe bajo con exposición baja NO es lo mismo que un edge inexistente,
  // y la diferencia tiene que quedar a la vista.
  const diasConPos = curva.length;
  return {
    trades: trades.length,
    rechazados_por_cupo: rechazadosPorCupo,
    rechazados_por_cash: rechazadosPorCash,
    ret_neto_medio: media(netos),
    ret_neto_mediana: mediana(netos),
    ret_bruto_medio: media(brutos),
    t_por_trade: tStat(netos),           // informativo: NO es el t del veredicto
    ganadores: netos.filter((x) => x > 0).length,
    equity_final: equity,
    sharpe: sharpeAnual(retornosDiarios),
    ret_total: equity - 1,
    max_drawdown: maxDrawdown(curva.map((c) => c.equity)),
    dias: diasConPos,
    ocupacion_media_cupos: media(ocupacion),
    detalle_trades: trades,
  };
}

function maxDrawdown(equities) {
  let pico = -Infinity, dd = 0;
  for (const e of equities) { if (e > pico) pico = e; if (pico > 0) dd = Math.min(dd, e / pico - 1); }
  return dd;
}

// ─────────────────── una especificación completa ───────────────────

// Corre la cadena entera para UNA política de hora + UN hold y devuelve el
// bloque de métricas contra los 3 criterios numéricos.
function corre({ eventos, calendario, seriesAlineadas, spyCloses, politicaHora, N, criterios = CRITERIOS, desde = null, campoSenal = 'surprise_pct' }) {
  const { operables, descartes } = construyeMuestra({ eventos, calendario, seriesAlineadas, politicaHora, criterios, desde });
  const { corte, positivos, seleccion } = seleccionaDecil(operables, { campo: campoSenal, p: criterios.decil });

  // §2 — señal: abnormal calendar-time, BRUTO (el criterio de costos es el §3).
  const dias = carteraCalendarTime({ seleccion, seriesAlineadas, spyCloses, calendario, N });
  const abn = tStat(dias.map((d) => d.abnormal));
  const diasNeto = carteraCalendarTime({ seleccion, seriesAlineadas, spyCloses, calendario, N, costo: criterios.costo_por_lado });
  const abnNeto = tStat(diasNeto.map((d) => d.abnormal));

  // §3 — operabilidad.
  const sim = simula({
    seleccion, seriesAlineadas, calendario, N,
    maxPos: criterios.max_concurrentes, costo: criterios.costo_por_lado, campoOrden: campoSenal,
  });

  const cumple = {
    muestra: operables.length >= criterios.min_eventos_operables,
    trades_decil: sim.trades >= criterios.min_trades_decil,
    t: abn.t != null && Math.abs(abn.t) >= criterios.t_minimo,
    ret_neto: sim.ret_neto_medio != null && sim.ret_neto_medio >= criterios.ret_neto_min_por_trade,
    sharpe: sim.sharpe != null && sim.sharpe >= criterios.sharpe_min,
  };
  // Los dos candados de muestra mandan sobre todo lo demás: si no hay con qué
  // medir, el veredicto es INCONCLUSO — no "NO-GO" (que afirmaría que NO hay
  // edge) ni "casi GO".
  const veredicto = (!cumple.muestra || !cumple.trades_decil) ? 'INCONCLUSO'
    : (cumple.t && cumple.ret_neto && cumple.sharpe) ? 'GO' : 'NO-GO';

  return {
    politica_hora: politicaHora,
    hold_dias: N,
    campo_senal: campoSenal,
    muestra: {
      eventos_operables: operables.length,
      con_sorpresa_positiva: positivos,
      eventos_senal: seleccion.length,
      corte_decil: corte,
      descartes,
      por_hora: contarPorHora(operables),
      hora_imputada: operables.filter((e) => e.hora_imputada).length,
      rango: seleccion.length
        ? { desde: seleccion[0].fecha_entrada, hasta: seleccion[seleccion.length - 1].fecha_entrada }
        : null,
    },
    // Descomposición: cuánto del movimiento se va en el gap que NO se captura
    // ni entrando en la primera apertura, vs lo que sí queda por delante.
    descomposicion: {
      gap_incapturable_medio: media(seleccion.map((e) => e.gap_incapturable)),
      drift_bruto_medio: sim.ret_bruto_medio,
      drift_neto_medio: sim.ret_neto_medio,
    },
    senal: {
      dias_cartera: dias.length,
      exposicion_media_nombres: media(dias.map((d) => d.n)),
      abnormal_diario_medio: abn.media,
      t: abn.t,
      abnormal_diario_medio_neto: abnNeto.media,
      t_neto: abnNeto.t,
      ret_cartera_diario_medio: media(dias.map((d) => d.cartera)),
      ret_spy_diario_medio: media(dias.map((d) => d.spy)),
    },
    operabilidad: {
      trades: sim.trades,
      rechazados_por_cupo: sim.rechazados_por_cupo,
      rechazados_por_cash: sim.rechazados_por_cash,
      ret_neto_medio_por_trade: sim.ret_neto_medio,
      ret_neto_mediana_por_trade: sim.ret_neto_mediana,
      ret_bruto_medio_por_trade: sim.ret_bruto_medio,
      pct_ganadores: sim.trades ? sim.ganadores / sim.trades : null,
      sharpe_estrategia: sim.sharpe,
      // El Sharpe del criterio §3 es el de LA ESTRATEGIA: 8 cupos de capital,
      // los vacíos en efectivo al 0%. Si la señal dispara poco, ese Sharpe sale
      // bajo aunque cada trade sea bueno — así que se publica al lado el Sharpe
      // del capital REALMENTE invertido (cartera equiponderada de lo abierto,
      // neta de costos). No sustituye al criterio: lo hace interpretable.
      sharpe_capital_invertido: sharpeAnual(diasNeto.map((d) => d.cartera)),
      ocupacion_media_cupos: sim.ocupacion_media_cupos,
      ocupacion_media_pct: sim.ocupacion_media_cupos == null ? null : sim.ocupacion_media_cupos / criterios.max_concurrentes,
      ret_total: sim.ret_total,
      max_drawdown: sim.max_drawdown,
      t_por_trade_informativo: sim.t_por_trade.t,
      // Se puebla solo con ?trades=1 — el endpoint lo borra por default.
      detalle_trades: sim.detalle_trades,
    },
    cumple,
    veredicto,
  };
}

function contarPorHora(operables) {
  const out = { bmo: 0, amc: 0 };
  for (const e of operables) out[e.hora_efectiva] = (out[e.hora_efectiva] || 0) + 1;
  return out;
}

// Split BMO vs AMC (§4): misma cadena, pero restringiendo la muestra por
// hora efectiva. Se re-calcula el decil DENTRO de cada rama (si no, el corte
// global podría vaciar una de las dos y el split no diría nada).
function corteSubmuestra({ eventos, filtro, ...resto }) {
  return corre({ ...resto, eventos: eventos.filter(filtro) });
}


// ─────────────────── resumen en español ───────────────────

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : (x * 100).toFixed(d) + '%');
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : x.toFixed(d));
const marca = (ok) => (ok ? '✅' : '❌');

// Una línea por criterio: qué pedía, qué salió, si pasa. Es la tabla que se
// mira primero — por eso el umbral y el valor van pegados, no en secciones
// distintas donde haya que cruzarlos a mano.
function filasCriterios(b, c) {
  return [
    ['1 · Muestra ≥ ' + c.min_eventos_operables + ' operables', String(b.muestra.eventos_operables), b.cumple.muestra],
    ['1b · ≥ ' + c.min_trades_decil + ' trades en el decil', String(b.operabilidad.trades), b.cumple.trades_decil],
    ['2 · t ≥ ' + c.t_minimo + ' en valor absoluto (abnormal calendar-time vs SPY)', num(b.senal.t), b.cumple.t],
    ['3a · Retorno neto ≥ ' + pct(c.ret_neto_min_por_trade) + ' por trade', pct(b.operabilidad.ret_neto_medio_por_trade), b.cumple.ret_neto],
    ['3b · Sharpe estrategia ≥ ' + num(c.sharpe_min, 1), num(b.operabilidad.sharpe_estrategia), b.cumple.sharpe],
  ];
}

function bloqueCorto(titulo, b) {
  return `**${titulo}** → ${b.veredicto} · operables ${b.muestra.eventos_operables}`
    + ` · señal ${b.muestra.eventos_senal} · trades ${b.operabilidad.trades}`
    + ` · t ${num(b.senal.t)} · neto/trade ${pct(b.operabilidad.ret_neto_medio_por_trade)}`
    + ` · Sharpe ${num(b.operabilidad.sharpe_estrategia)}`;
}

function renderResumenMarkdown(s) {
  const c = s.criterios, p = s.principal, L = [];
  L.push('# PEAD Fase 2 — ¿hay drift operable?');
  L.push('');
  L.push(`**VEREDICTO: ${s.veredicto}**`);
  L.push('');
  L.push(`Generado ${s.generado_en} · solo lectura · ventana ${s.datos.ventana_analisis.desde} → ${s.datos.ventana_analisis.hasta}`);
  L.push('');
  L.push('## Especificación principal (una sola, fijada antes de correr)');
  L.push('');
  L.push(`- Entrada: ${s.especificacion.entrada}.`);
  L.push(`- Eventos sin hora en la principal: ${s.especificacion.sin_hora_en_principal}.`);
  L.push(`- Señal: ${s.especificacion.senal}. Corte del decil: ${num(p.muestra.corte_decil, 2)}.`);
  L.push(`- Benchmark: ${s.especificacion.benchmark}.`);
  L.push(`- Tenencia ${s.especificacion.tenencia_dias} sesiones · máx ${s.especificacion.max_concurrentes} concurrentes · ${s.especificacion.costo_por_lado_bp} bp por lado.`);
  L.push('');
  L.push('## Criterios de éxito');
  L.push('');
  L.push('| Criterio | Resultado | ¿Pasa? |');
  L.push('|---|---|---|');
  for (const [k, v, ok] of filasCriterios(p, c)) L.push(`| ${k} | ${v} | ${marca(ok)} |`);
  L.push('');
  if (!p.cumple.muestra) {
    L.push(`> La muestra base no llega al piso (${p.muestra.eventos_operables} < ${c.min_eventos_operables}).`);
    L.push('> Por la regla fijada de antemano el veredicto es **INCONCLUSO** — no "casi".');
    L.push('');
  }
  if (p.cumple.muestra && !p.cumple.trades_decil) {
    L.push(`> El decil deja ${p.operabilidad.trades} trades (< ${c.min_trades_decil}): por debajo del candado`);
    L.push('> pre-registrado, el retorno medio y el Sharpe son ruido con forma de resultado.');
    L.push('> Veredicto **INCONCLUSO** sin importar los números de arriba.');
    L.push('');
  }
  L.push('## Muestra');
  L.push('');
  L.push(`- Eventos en \`pead_earnings\` (ventana + colchón): ${s.datos.eventos_en_tabla} · símbolos: ${s.datos.simbolos}`
    + (s.datos.sin_precios.length ? ` · sin precios en Yahoo: ${s.datos.sin_precios.join(', ')}` : ''));
  L.push(`- En la ventana, con hora etiquetada: ${s.datos.con_hora_etiquetada} (${pct(s.datos.pct_con_hora, 1)}) · sin hora: ${s.datos.sin_hora}`);
  L.push(`- Operables en la principal: **${p.muestra.eventos_operables}** (BMO ${p.muestra.por_hora.bmo || 0} · AMC ${p.muestra.por_hora.amc || 0}; hora imputada ${p.muestra.hora_imputada})`);
  L.push(`- Con sorpresa positiva: ${p.muestra.con_sorpresa_positiva} → decil superior: **${p.muestra.eventos_senal}** eventos de señal`);
  L.push(`- Descartes: ${Object.entries(p.muestra.descartes).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  L.push('');
  L.push('## Descomposición del movimiento');
  L.push('');
  L.push(`- Gap incapturable (cierre previo → apertura de entrada): ${pct(p.descomposicion.gap_incapturable_medio)}`);
  L.push(`- Drift bruto capturado (${c.hold_principal} sesiones): ${pct(p.descomposicion.drift_bruto_medio)}`);
  L.push(`- Drift neto de costos: ${pct(p.descomposicion.drift_neto_medio)}`);
  L.push('');
  L.push('## Señal (cartera calendar-time, bruto)');
  L.push('');
  L.push(`- Días con cartera abierta: ${p.senal.dias_cartera} · exposición media: ${num(p.senal.exposicion_media_nombres)} nombres`);
  L.push(`- Abnormal diario medio: ${pct(p.senal.abnormal_diario_medio, 4)} · **t = ${num(p.senal.t)}**`);
  L.push(`- Neto de costos: ${pct(p.senal.abnormal_diario_medio_neto, 4)} · t = ${num(p.senal.t_neto)}`);
  L.push(`- Cartera ${pct(p.senal.ret_cartera_diario_medio, 4)}/día vs SPY ${pct(p.senal.ret_spy_diario_medio, 4)}/día`);
  L.push('');
  L.push('## Operabilidad (simulación long-only)');
  L.push('');
  L.push(`- Trades ejecutados: ${p.operabilidad.trades} · rechazados por cupo (>${c.max_concurrentes} concurrentes): ${p.operabilidad.rechazados_por_cupo} · rechazados por efectivo: ${p.operabilidad.rechazados_por_cash}`);
  L.push(`- Retorno neto medio: **${pct(p.operabilidad.ret_neto_medio_por_trade)}** · mediana ${pct(p.operabilidad.ret_neto_mediana_por_trade)} · ganadores ${pct(p.operabilidad.pct_ganadores, 1)}`);
  L.push(`- Sharpe de la estrategia (8 cupos, los vacíos en efectivo): **${num(p.operabilidad.sharpe_estrategia)}** · retorno total ${pct(p.operabilidad.ret_total)} · max DD ${pct(p.operabilidad.max_drawdown)}`);
  L.push(`- Ocupación media: ${num(p.operabilidad.ocupacion_media_cupos)} de ${c.max_concurrentes} cupos (${pct(p.operabilidad.ocupacion_media_pct, 1)}) · Sharpe del capital REALMENTE invertido: ${num(p.operabilidad.sharpe_capital_invertido)} (informativo, no es el criterio)`);
  L.push('');
  L.push('## Sensibilidades obligatorias');
  L.push('');
  L.push(bloqueCorto('Sin hora → todo-AMC (= principal)', p));
  L.push('');
  L.push(bloqueCorto('Sin hora → todo-BMO', s.sensibilidades.sin_hora_todo_bmo));
  L.push('');
  L.push(bloqueCorto('Sin hora → descartados', s.sensibilidades.sin_hora_descartada));
  L.push('');
  L.push(s.sensibilidades.veredicto_cambia_entre_bmo_y_amc
    ? `> ⚠️ **El veredicto CAMBIA** entre todo-BMO (${s.sensibilidades.sin_hora_todo_bmo.veredicto}) y todo-AMC (${p.veredicto}): la incertidumbre de hora está manejando el resultado.`
    : `> El veredicto NO cambia entre todo-BMO y todo-AMC: la incertidumbre de hora no maneja el resultado.`);
  L.push('');
  L.push(bloqueCorto('Split BMO', s.sensibilidades.split_bmo));
  L.push('');
  L.push(bloqueCorto('Split AMC', s.sensibilidades.split_amc));
  L.push('');
  for (const h of s.sensibilidades.holds) L.push(bloqueCorto(`Tenencia ${h.hold_dias} sesiones`, h) + '\n');
  L.push('## Cortes EXPLORATORIOS (no cuentan para el veredicto)');
  L.push('');
  for (const e of s.exploratorio) {
    L.push(`**[${e.etiqueta}] ${e.nombre}**`);
    L.push(`- Por qué: ${e.por_que}`);
    L.push(`- ${bloqueCorto('Resultado', e.resultado)}`);
    L.push('');
  }
  return L.join('\n');
}

export {
  CRITERIOS, DIA_MS,
  media, mediana, desvest, tStat, sharpeAnual, percentil, maxDrawdown,
  recortaVelasIncompletas, alineaAlCalendario, cierreVigente,
  horaEfectiva, indiceEntrada, construyeMuestra, retornoTrade,
  seleccionaDecil, carteraCalendarTime, simula, corre, corteSubmuestra, contarPorHora,
  renderResumenMarkdown, filasCriterios, pct, num,
};
