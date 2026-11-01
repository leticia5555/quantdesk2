// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-drift-analyze.js — "PM-DRIFT", backtest pre-registrado.
//
// ¿El movimiento del precio del "Yes" de Polymarket ANTES del reporte
// (Δ = p(T-24h) − p(T-72h)) agrega información SOBRE el propio p(T-24h)
// para predecir si la empresa hace beat? Ver docs/pm-drift-scope.md.
//
// Este archivo es PURO (sin red, sin DB): criterios congelados, horas del
// reporte, elección del precio en cada hora, estadística, veredicto y
// markdown. La red (CLOB) y Neon viven en api/pm-drift-analyze.js; el loop
// de descarga está acá con sus dependencias inyectadas para poder probarlo.
//
// ── LO QUE NO SE MUEVE ─────────────────────────────────────────────
// CRITERIOS_PM_DRIFT se fijó ANTES de bajar un solo precio y
// tests/pm-drift-analyze.test.mjs lo pinea valor por valor. Cambiar un
// umbral después de ver el resultado invalida el estudio: se corre otro
// estudio con otro nombre, no se edita este.
// ═══════════════════════════════════════════════════════════════════

const CRITERIOS_PM_DRIFT = Object.freeze({
  // Universo
  min_volumen_usd: 500,                 // mismo umbral que Fase 2 (CRITERIOS_F2.min_volumen_usd)
  // Hora del reporte (hora del Este). Sin hora → AMC.
  hora_reporte_et: Object.freeze({ bmo: '07:00', dmh: '12:00', amc: '16:00' }),
  hora_por_defecto: 'amc',
  // Precios: el punto más cercano ANTERIOR (o igual) a cada hora.
  horas_antes: Object.freeze({ t72: 72, t24: 24, t2: 2 }),
  max_hueco_horas: 3,                   // más lejos que esto = faltante
  // Señal
  umbral_drift_pts: 5,                  // Δ ≥ +5 / Δ ≤ −5, en puntos (0–100)
  tramos_p24: Object.freeze([[0, 30], [30, 50], [50, 70], [70, 100]]),
  // Simulación en papel
  apuesta_usd: 1,
  costo_por_operacion_usd: 0.02,
  // Regresión
  logit_clip: 0.01,                     // p24 se acota a [0.01, 0.99] antes del logit
  // Criterios del veredicto
  min_n_delta: 150,
  t_go: 2.5,
  t_fragil: 2,
  hipotesis_previa: 'NO-GO o INCONCLUSO: esperamos que el precio ya incluya el movimiento.',
});

// Ventana que se baja y se guarda por mercado, relativa a la FECHA del
// reporte (no a la hora): cubre cualquier hora BMO/DMH/AMC. El punto más
// temprano que se necesita es BMO −72h −3h de tolerancia = fecha−3d 08:00Z;
// la ventana arranca en fecha−4d 00:00Z, así que un punto anterior a la
// ventana nunca podría haber sido válido. No es un criterio, es plomería.
const VENTANA_DESCARGA = Object.freeze({ dias_antes: 4, dias_despues: 1 });

const H = 3600 * 1000;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ─────────────────── hora del reporte ───────────────────

// ¿Está este instante UTC en horario de verano de EE.UU.? Regla vigente desde
// 2007: del 2º domingo de marzo a las 2:00 locales (07:00Z) al 1er domingo de
// noviembre a las 2:00 locales (06:00Z).
function enHorarioVerano(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const domingo = (mes, n) => {
    const d = new Date(Date.UTC(y, mes, 1));
    const primero = (7 - d.getUTCDay()) % 7 + 1;
    return primero + 7 * (n - 1);
  };
  const ini = Date.UTC(y, 2, domingo(2, 2), 7);
  const fin = Date.UTC(y, 10, domingo(10, 1), 6);
  return utcMs >= ini && utcMs < fin;
}

// 'YYYY-MM-DD' + 'HH:MM' hora del Este → ms UTC.
function etAUtcMs(fecha, hhmm) {
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  const comoEst = Date.UTC(y, m - 1, d, hh + 5, mm);
  return enHorarioVerano(comoEst - H) ? comoEst - H : comoEst;
}

// hora: 'bmo' | 'amc' | 'dmh' | null. Devuelve el instante del reporte y si
// la hora fue imputada.
function horaDelReporte(fecha, hora, C = CRITERIOS_PM_DRIFT) {
  const h = String(hora || '').toLowerCase();
  const conocida = Object.prototype.hasOwnProperty.call(C.hora_reporte_et, h);
  const efectiva = conocida ? h : C.hora_por_defecto;
  const ms = etAUtcMs(fecha, C.hora_reporte_et[efectiva]);
  return { ms, hora_efectiva: efectiva, imputada: !conocida };
}

function ventanaDescarga(fecha) {
  const base = Date.parse(String(fecha).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(base)) return null;
  return { desdeMs: base - VENTANA_DESCARGA.dias_antes * 24 * H, hastaMs: base + VENTANA_DESCARGA.dias_despues * 24 * H };
}

// ─────────────────── historial y precios ───────────────────

// history del CLOB ([{t, p}], t en segundos o ms) → puntos ordenados.
// EMPATE: dos puntos con el MISMO timestamp → gana el último que llegó (igual
// que el ON CONFLICT DO UPDATE de pm_price_hist). Precios fuera de [0,1] se
// descartan.
function normalizaPuntos(history) {
  const porTs = new Map();
  for (const x of Array.isArray(history) ? history : []) {
    if (!x) continue;
    let t = num(x.t !== undefined ? x.t : x.ts !== undefined ? x.ts : x.timestamp);
    if (t === null && typeof x.ts === 'string') t = Date.parse(x.ts);
    const p = num(x.p !== undefined ? x.p : x.price);
    if (t === null || !Number.isFinite(t) || p === null || p < 0 || p > 1) continue;
    if (t < 1e12) t *= 1000;
    porTs.set(t, p);
  }
  return [...porTs.entries()].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}

// El punto más cercano ANTERIOR (o igual) a objetivoMs. Nunca uno posterior:
// ese sería un precio del futuro. A más de max_hueco_horas → faltante.
function precioEn(puntos, objetivoMs, { maxHuecoHoras = CRITERIOS_PM_DRIFT.max_hueco_horas } = {}) {
  if (!puntos || !puntos.length) return { precio: null, motivo: 'sin_historial' };
  let elegido = null;
  for (const pt of puntos) {
    if (pt.t <= objetivoMs) elegido = pt; else break;
  }
  if (!elegido) return { precio: null, motivo: 'sin_punto_anterior' };
  const hueco = (objetivoMs - elegido.t) / H;
  if (hueco > maxHuecoHoras) return { precio: null, motivo: 'hueco_mayor_3h', hueco_horas: Number(hueco.toFixed(2)) };
  return { precio: elegido.p, ts: elegido.t, hueco_horas: Number(hueco.toFixed(2)) };
}

// ─────────────────── universo ───────────────────

// filas = SELECT de la unión v2 + v1 (v2 primero). Dedup por market_id: gana
// la primera que aparece (v2). Cada exclusión con su motivo, en este orden.
function construyeUniverso(filas, C = CRITERIOS_PM_DRIFT) {
  const vistos = new Set();
  const universo = [];
  const excluidos = { duplicado: 0, no_resuelto: 0, liquidez: 0, sin_token: 0, sin_fecha_reporte: 0 };
  for (const f of filas || []) {
    const id = f && f.market_id != null ? String(f.market_id) : null;
    if (!id) continue;
    if (vistos.has(id)) { excluidos.duplicado++; continue; }
    vistos.add(id);
    const outcome = String(f.outcome || '').toLowerCase();
    if (outcome !== 'yes' && outcome !== 'no') { excluidos.no_resuelto++; continue; }
    const vol = num(f.volume);
    if (vol === null || vol < C.min_volumen_usd) { excluidos.liquidez++; continue; }
    if (!f.yes_token_id) { excluidos.sin_token++; continue; }
    // Sin fecha de reporte no hay T-24h. NO se usa la fecha de resolución
    // como sustituto: es posterior al reporte y metería precios del futuro.
    if (!f.report_date) { excluidos.sin_fecha_reporte++; continue; }
    const fecha = String(f.report_date).slice(0, 10);
    const rep = horaDelReporte(fecha, f.hour, C);
    universo.push({
      market_id: id, symbol: f.symbol || null, cosecha: f.cosecha || null, fecha,
      hora: f.hour ? String(f.hour).toLowerCase() : null, hora_efectiva: rep.hora_efectiva, hora_imputada: rep.imputada,
      reporte_ms: rep.ms, token: String(f.yes_token_id), y: outcome === 'yes' ? 1 : 0, volume: vol,
    });
  }
  return { universo, excluidos, filas: (filas || []).length };
}

// Mercado del universo + sus puntos → observación con los 3 precios y Δ.
function observacion(m, puntos, C = CRITERIOS_PM_DRIFT) {
  const pr = {};
  for (const [k, h] of Object.entries(C.horas_antes)) pr[k] = precioEn(puntos, m.reporte_ms - h * H, { maxHuecoHoras: C.max_hueco_horas });
  const p72 = pr.t72.precio, p24 = pr.t24.precio, p2 = pr.t2.precio;
  const pts = (x) => Number((x * 100).toFixed(6));
  return {
    market_id: m.market_id, symbol: m.symbol, fecha: m.fecha, hora_efectiva: m.hora_efectiva, hora_imputada: m.hora_imputada, y: m.y,
    p72, p24, p2,
    motivo72: pr.t72.motivo || null, motivo24: pr.t24.motivo || null, motivo2: pr.t2.motivo || null,
    d: p72 !== null && p24 !== null ? pts(p24 - p72) : null,
    d2: p24 !== null && p2 !== null ? pts(p2 - p24) : null,
  };
}

// ─────────────────── cobertura ───────────────────

// estados: Map market_id → estado de descarga ('ok' | 'error' | ...), o
// ausente si nunca se bajó. obs: observaciones de los que tienen historial.
function cobertura(universo, obsPorId, estados) {
  const c = {
    universo: universo.length, con_3_precios: 0, con_delta: 0, con_delta2: 0, con_p24: 0,
    pendiente_descarga: 0, error_descarga: 0,
    faltan: { t72: {}, t24: {}, t2: {} },
    sin_hora_imputada_amc: universo.filter((m) => m.hora_imputada).length,
    puntos_totales: 0,
  };
  for (const m of universo) {
    const est = estados.get(m.market_id);
    if (!est) { c.pendiente_descarga++; continue; }
    if (est !== 'ok') { c.error_descarga++; continue; }
    const o = obsPorId.get(m.market_id);
    if (!o) continue;
    if (o.p72 !== null && o.p24 !== null && o.p2 !== null) c.con_3_precios++;
    if (o.d !== null) c.con_delta++;
    if (o.d2 !== null) c.con_delta2++;
    if (o.p24 !== null) c.con_p24++;
    for (const k of ['t72', 't24', 't2']) {
      const mot = o['motivo' + k.slice(1)];
      if (mot) c.faltan[k][mot] = (c.faltan[k][mot] || 0) + 1;
    }
  }
  return c;
}

// ─────────────────── estadística ───────────────────

const sigmoide = (z) => 1 / (1 + Math.exp(-z));
function logit(p, clip = CRITERIOS_PM_DRIFT.logit_clip) {
  const q = Math.min(1 - clip, Math.max(clip, p));
  return Math.log(q / (1 - q));
}

// Inversa por Gauss-Jordan con pivoteo parcial; null si es singular.
function inversa(A) {
  const n = A.length;
  const M = A.map((fila, i) => [...fila, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((fila) => fila.slice(n));
}
const mulMat = (A, B) => A.map((fila) => B[0].map((_, j) => fila.reduce((s, a, k) => s + a * B[k][j], 0)));

// Logística por Newton-Raphson; errores estándar agrupados (CR1, el de Stata:
// G/(G−1)·(N−1)/(N−K)). X sin intercepto (se agrega). grupos[i] = clave.
function logistica(X, y, grupos, { maxIter = 100, tol = 1e-10 } = {}) {
  const n = y.length;
  const Z = X.map((x) => [1, ...x]);
  const k = Z[0] ? Z[0].length : 0;
  if (n <= k) return { convergio: false, motivo: 'pocos_datos', n };
  let b = Array(k).fill(0);
  let Hinv = null;
  let convergio = false;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const mu = Z.map((z) => sigmoide(z.reduce((s, v, j) => s + v * b[j], 0)));
    const Hm = Array.from({ length: k }, () => Array(k).fill(0));
    const g = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const w = mu[i] * (1 - mu[i]);
      for (let a = 0; a < k; a++) {
        g[a] += Z[i][a] * (y[i] - mu[i]);
        for (let c = 0; c < k; c++) Hm[a][c] += w * Z[i][a] * Z[i][c];
      }
    }
    Hinv = inversa(Hm);
    if (!Hinv) return { convergio: false, motivo: 'matriz_singular', n };
    const paso = Hinv.map((fila) => fila.reduce((s, v, j) => s + v * g[j], 0));
    b = b.map((v, j) => v + paso[j]);
    if (b.some((v) => !Number.isFinite(v) || Math.abs(v) > 50)) return { convergio: false, motivo: 'separacion', n };
    if (Math.max(...paso.map(Math.abs)) < tol) { convergio = true; break; }
  }
  if (!convergio) return { convergio: false, motivo: 'no_convergio', n };
  // Hinv del último paso, recalculado en el b final.
  const mu = Z.map((z) => sigmoide(z.reduce((s, v, j) => s + v * b[j], 0)));
  const Hm = Array.from({ length: k }, () => Array(k).fill(0));
  const porGrupo = new Map();
  for (let i = 0; i < n; i++) {
    const w = mu[i] * (1 - mu[i]);
    for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) Hm[a][c] += w * Z[i][a] * Z[i][c];
    const key = grupos[i];
    if (!porGrupo.has(key)) porGrupo.set(key, Array(k).fill(0));
    const u = porGrupo.get(key);
    for (let a = 0; a < k; a++) u[a] += Z[i][a] * (y[i] - mu[i]);
  }
  Hinv = inversa(Hm);
  if (!Hinv) return { convergio: false, motivo: 'matriz_singular', n };
  const G = porGrupo.size;
  if (G < 2) return { convergio: false, motivo: 'un_solo_grupo', n, grupos: G };
  const meat = Array.from({ length: k }, () => Array(k).fill(0));
  for (const u of porGrupo.values()) for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) meat[a][c] += u[a] * u[c];
  const corr = (G / (G - 1)) * ((n - 1) / (n - k));
  const V = mulMat(mulMat(Hinv, meat), Hinv).map((fila) => fila.map((v) => v * corr));
  const se = V.map((fila, j) => Math.sqrt(Math.max(0, fila[j])));
  return { convergio: true, n, grupos: G, iter, coef: b, se, t: b.map((v, j) => (se[j] > 0 ? v / se[j] : null)) };
}

// resultado ~ logit(p24) + <var>. Devuelve el coeficiente de <var>.
function regresion(obs, variable = 'd', C = CRITERIOS_PM_DRIFT) {
  const v = obs.filter((o) => o.p24 !== null && o[variable] !== null);
  const r = logistica(v.map((o) => [logit(o.p24, C.logit_clip), o[variable]]), v.map((o) => o.y), v.map((o) => o.fecha));
  if (!r.convergio) return { n: v.length, convergio: false, motivo: r.motivo, coef: null, se: null, t: null };
  const f = (x) => (x === null ? null : Number(x.toFixed(6)));
  return {
    n: r.n, grupos: r.grupos, convergio: true,
    intercepto: f(r.coef[0]), coef_logit_p24: f(r.coef[1]),
    coef: f(r.coef[2]), se: f(r.se[2]), t: r.t[2] === null ? null : f(r.t[2]),
  };
}

function tablaTramos(obs, C = CRITERIOS_PM_DRIFT) {
  const u = C.umbral_drift_pts;
  return C.tramos_p24.map(([lo, hi], i) => {
    const ultimo = i === C.tramos_p24.length - 1;
    const en = obs.filter((o) => o.d !== null && o.p24 * 100 >= lo && (ultimo ? o.p24 * 100 <= hi : o.p24 * 100 < hi));
    const grupo = (g) => ({ n: g.length, tasa_yes: g.length ? g.reduce((s, o) => s + o.y, 0) / g.length : null,
      p24_medio: g.length ? g.reduce((s, o) => s + o.p24, 0) / g.length : null });
    return { tramo: `${lo}-${hi}`, n: en.length, sube: grupo(en.filter((o) => o.d >= u)), baja: grupo(en.filter((o) => o.d <= -u)) };
  });
}

// $1 por apuesta al precio p24; costo fijo por operación.
//   Δ ≥ +u → compra Yes a p24: gana y/p24 − 1
//   Δ ≤ −u → compra No a 1−p24: gana (1−y)/(1−p24) − 1
function simulacion(obs, C = CRITERIOS_PM_DRIFT) {
  const u = C.umbral_drift_pts;
  const ops = [];
  for (const o of obs) {
    if (o.d === null || o.p24 === null) continue;
    let lado = null;
    if (o.d >= u && o.p24 > 0) lado = 'yes';
    else if (o.d <= -u && o.p24 < 1) lado = 'no';
    if (!lado) continue;
    const bruto = lado === 'yes' ? C.apuesta_usd * (o.y / o.p24 - 1) : C.apuesta_usd * ((1 - o.y) / (1 - o.p24) - 1);
    ops.push({ lado, bruto, neto: bruto - C.costo_por_operacion_usd, gana: lado === 'yes' ? o.y === 1 : o.y === 0 });
  }
  const s = (k) => ops.reduce((a, x) => a + x[k], 0);
  return {
    operaciones: ops.length,
    compra_yes: ops.filter((x) => x.lado === 'yes').length,
    compra_no: ops.filter((x) => x.lado === 'no').length,
    aciertos: ops.filter((x) => x.gana).length,
    bruto_usd: Number(s('bruto').toFixed(4)),
    costos_usd: Number((ops.length * C.costo_por_operacion_usd).toFixed(4)),
    neto_usd: Number(s('neto').toFixed(4)),
    neto_por_apuesta: ops.length ? Number((s('neto') / ops.length).toFixed(4)) : null,
  };
}

// Mitades por fecha: mediana = la fecha del medio (la menor si n es par).
// Antes = fecha ≤ mediana; después = fecha > mediana.
function mitades(obs) {
  const v = obs.filter((o) => o.d !== null);
  if (!v.length) return { mediana: null, antes: [], despues: [] };
  const fechas = v.map((o) => o.fecha).sort();
  const mediana = fechas[Math.floor((fechas.length - 1) / 2)];
  return { mediana, antes: v.filter((o) => o.fecha <= mediana), despues: v.filter((o) => o.fecha > mediana) };
}

// Calibración de p24 por deciles (grupos de igual tamaño, ordenados por p24)
// y Brier. Referencia: no decide.
function calibracion(obs) {
  const v = obs.filter((o) => o.p24 !== null).sort((a, b) => a.p24 - b.p24);
  const n = v.length;
  if (!n) return { n: 0, brier: null, deciles: [] };
  const deciles = [];
  for (let k = 0; k < 10; k++) {
    const g = v.filter((_, i) => Math.floor((i * 10) / n) === k);
    if (!g.length) continue;
    deciles.push({ decil: k + 1, n: g.length, p24_min: g[0].p24, p24_max: g[g.length - 1].p24,
      p24_medio: g.reduce((s, o) => s + o.p24, 0) / g.length, tasa_yes: g.reduce((s, o) => s + o.y, 0) / g.length });
  }
  return { n, brier: Number((v.reduce((s, o) => s + (o.p24 - o.y) ** 2, 0) / n).toFixed(6)), tasa_yes: v.reduce((s, o) => s + o.y, 0) / n, deciles };
}

// ─────────────────── veredicto ───────────────────

const ESTADOS = Object.freeze({
  FRONTERA: 'FALLA DE FRONTERA', INCOMPLETA: 'COBERTURA INCOMPLETA',
  INCONCLUSO: 'INCONCLUSO', GO: 'GO', FRAGIL: 'GO FRÁGIL', NOGO: 'NO-GO',
});

// a = { regresion, mitad_antes: {regresion, simulacion}, mitad_despues: {...} }
function veredicto({ n_delta, regresion: r, mitad_antes: m1, mitad_despues: m2 }, C = CRITERIOS_PM_DRIFT) {
  const cumple = {
    n_suficiente: n_delta >= C.min_n_delta,
    coef_positivo: !!(r && r.convergio && r.coef > 0),
    t: r && r.convergio ? r.t : null,
    positivo_mitad_antes: !!(m1 && m1.regresion.convergio && m1.regresion.coef > 0),
    positivo_mitad_despues: !!(m2 && m2.regresion.convergio && m2.regresion.coef > 0),
    sim_neta_antes: m1 ? m1.simulacion.neto_usd : null,
    sim_neta_despues: m2 ? m2.simulacion.neto_usd : null,
  };
  if (!cumple.n_suficiente) return { veredicto: ESTADOS.INCONCLUSO, motivo: `N con Δ válido = ${n_delta} < ${C.min_n_delta}`, cumple };
  const resto = cumple.coef_positivo && cumple.positivo_mitad_antes && cumple.positivo_mitad_despues
    && cumple.sim_neta_antes > 0 && cumple.sim_neta_despues > 0;
  if (resto && cumple.t >= C.t_go) return { veredicto: ESTADOS.GO, motivo: `t = ${cumple.t.toFixed(2)} ≥ ${C.t_go}, positivo y rentable en ambas mitades`, cumple };
  if (resto && cumple.t >= C.t_fragil) return { veredicto: ESTADOS.FRAGIL, motivo: `${C.t_fragil} ≤ t = ${cumple.t.toFixed(2)} < ${C.t_go}`, cumple };
  const fallas = [];
  if (!(r && r.convergio)) fallas.push(`regresión sin convergencia (${r ? r.motivo : 'sin datos'})`);
  else if (!cumple.coef_positivo) fallas.push('coeficiente de Δ ≤ 0');
  else if (cumple.t < C.t_fragil) fallas.push(`t = ${cumple.t.toFixed(2)} < ${C.t_fragil}`);
  if (!cumple.positivo_mitad_antes) fallas.push('no positivo en la 1ª mitad');
  if (!cumple.positivo_mitad_despues) fallas.push('no positivo en la 2ª mitad');
  if (!(cumple.sim_neta_antes > 0)) fallas.push('simulación neta ≤ 0 en la 1ª mitad');
  if (!(cumple.sim_neta_despues > 0)) fallas.push('simulación neta ≤ 0 en la 2ª mitad');
  return { veredicto: ESTADOS.NOGO, motivo: fallas.join('; '), cumple };
}

// Corrida completa sobre el universo + historiales ya cargados.
//   puntosPorId: Map market_id → [{t, p}] (normalizados)
//   estados:     Map market_id → estado de descarga
function corre({ universo, puntosPorId, estados, C = CRITERIOS_PM_DRIFT }) {
  const obs = [];
  const obsPorId = new Map();
  let puntosTotales = 0;
  for (const m of universo) {
    if (estados.get(m.market_id) !== 'ok') continue;
    const pts = puntosPorId.get(m.market_id) || [];
    puntosTotales += pts.length;
    const o = observacion(m, pts, C);
    obs.push(o);
    obsPorId.set(m.market_id, o);
  }
  const cob = cobertura(universo, obsPorId, estados);
  cob.puntos_totales = puntosTotales;

  // Frontera: cero datos del CLOB (o cero universo) → nunca veredicto.
  if (!universo.length) return { estado: ESTADOS.FRONTERA, motivo: 'universo vacío: no hay mercados resueltos con liquidez y fecha de reporte', cobertura: cob, obs };
  if (puntosTotales === 0 && cob.pendiente_descarga === 0) {
    return { estado: ESTADOS.FRONTERA, motivo: 'cero puntos de precio del CLOB para todo el universo', cobertura: cob, obs };
  }
  if (cob.pendiente_descarga > 0) {
    return { estado: ESTADOS.INCOMPLETA, motivo: `faltan ${cob.pendiente_descarga} historiales por bajar: vuelve a abrir el link`, cobertura: cob, obs };
  }

  const conD = obs.filter((o) => o.d !== null);
  const m = mitades(obs);
  const mitad = (g) => ({ n: g.length, desde: g.length ? g[0].fecha : null, regresion: regresion(g, 'd', C), simulacion: simulacion(g, C) });
  const ordenFecha = (g) => [...g].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const res = {
    n_delta: conD.length,
    regresion: regresion(obs, 'd', C),
    tramos: tablaTramos(obs, C),
    simulacion: simulacion(obs, C),
    mediana_fecha: m.mediana,
    mitad_antes: mitad(ordenFecha(m.antes)),
    mitad_despues: mitad(ordenFecha(m.despues)),
    calibracion: calibracion(obs),
    // Reportado, NO decide.
    secundario: {
      n_delta2: obs.filter((o) => o.d2 !== null).length,
      delta2_medio: (() => { const v = obs.filter((o) => o.d2 !== null); return v.length ? v.reduce((s, o) => s + o.d2, 0) / v.length : null; })(),
      regresion_delta2: regresion(obs, 'd2', C),
      regresion_delta_sin_hora_imputada: regresion(obs.filter((o) => !o.hora_imputada), 'd', C),
    },
  };
  const v = veredicto(res, C);
  return { estado: v.veredicto, motivo: v.motivo, cumple: v.cumple, cobertura: cob, ...res, obs };
}

// ─────────────────── descarga (deps inyectadas) ───────────────────

// pendientes: [{market_id, token, fecha}]. clob(path, params) = la frontera
// (_lib/polymarket.js). guarda({market_id, token, estado, puntos, http, forma,
// desdeMs, hastaMs}) escribe en Neon. Un 429 corta TODO el loop: lo que
// quedó se baja en la siguiente corrida.
async function bajaHistoriales(pendientes, { clob, guarda, presupuestoMs = 200000, concurrencia = 4, pausaMs = 250,
  ahora = () => Date.now(), espera = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = ahora();
  const resumen = { intentados: 0, ok: 0, vacios: 0, errores: 0, ratelimit: false, por_presupuesto: 0, puntos: 0 };
  const una = async (m) => {
    const v = ventanaDescarga(m.fecha);
    const startTs = Math.floor(v.desdeMs / 1000), endTs = Math.floor(v.hastaMs / 1000);
    let r = await clob('/prices-history', { market: m.token, startTs, endTs, fidelity: 60 });
    let forma = 'startTs/endTs';
    const hist = (x) => (x && x.status === 'ok' && x.body && Array.isArray(x.body.history) ? x.body.history : null);
    if (r.status === 'ratelimit') return { m, estado: 'ratelimit', r, forma };
    if (!hist(r) || !hist(r).length) {
      const r2 = await clob('/prices-history', { market: m.token, interval: 'max', fidelity: 60 });
      if (r2.status === 'ratelimit') return { m, estado: 'ratelimit', r: r2, forma: 'interval=max' };
      if (r2.status === 'ok' || r.status !== 'ok') { r = r2; forma = 'interval=max'; }
    }
    if (r.status !== 'ok') return { m, estado: 'error', r, forma, v };
    const puntos = normalizaPuntos(hist(r) || []).filter((p) => p.t >= v.desdeMs && p.t < v.hastaMs);
    return { m, estado: 'ok', r, forma, v, puntos };
  };
  for (let i = 0; i < pendientes.length; i += concurrencia) {
    if (ahora() - t0 > presupuestoMs) { resumen.por_presupuesto = pendientes.length - i; break; }
    const lote = pendientes.slice(i, i + concurrencia);
    const res = await Promise.all(lote.map(una));
    for (const x of res) {
      resumen.intentados++;
      if (x.estado === 'ratelimit') { resumen.ratelimit = true; continue; }   // sin registro: se reintenta
      const puntos = x.puntos || [];
      if (x.estado === 'ok') { resumen.ok++; if (!puntos.length) resumen.vacios++; resumen.puntos += puntos.length; } else resumen.errores++;
      await guarda({ market_id: x.m.market_id, token: x.m.token, estado: x.estado, puntos, http: x.r.http ?? null,
        forma: x.forma, desdeMs: x.v ? x.v.desdeMs : null, hastaMs: x.v ? x.v.hastaMs : null });
    }
    if (resumen.ratelimit) { resumen.por_presupuesto = pendientes.length - i - lote.length; break; }
    if (pausaMs && i + concurrencia < pendientes.length) await espera(pausaMs);
  }
  return resumen;
}

// ─────────────────── SQL ───────────────────
// docs/sql/pm-drift.sql == SCHEMA (lo exige el test).

const SCHEMA = [
  `create table if not exists pm_price_hist (
     market_id  text not null,
     ts         timestamptz not null,
     price      numeric not null,
     primary key (market_id, ts)
   )`,
  `create table if not exists pm_price_hist_fetch (
     market_id  text primary key,
     token_id   text,
     estado     text not null,
     puntos     int not null default 0,
     http       int,
     forma      text,
     desde      timestamptz,
     hasta      timestamptz,
     bajado_en  timestamptz not null default now()
   )`,
];

const COLS_U = `market_id, symbol, to_char(report_date, 'YYYY-MM-DD') as report_date, outcome, volume, yes_token_id`;
// v2 primero; de v1 solo lo que v2 no tiene. Solo SELECT sobre v1/v2.
const SQL_UNIVERSO = `select u.*, h.hour from (
    select ${COLS_U}, 'v2' as cosecha, 0 as orden from pm_earnings_markets_v2
    union all
    select ${COLS_U}, 'v1' as cosecha, 1 as orden from pm_earnings_markets m
     where not exists (select 1 from pm_earnings_markets_v2 v where v.market_id = m.market_id)
  ) u
  left join pead_event_hour h on h.symbol = u.symbol and h.reported_date = to_date(u.report_date, 'YYYY-MM-DD')
  order by u.orden, u.market_id`;

const SQL_ESTADOS = `select market_id, estado from pm_price_hist_fetch`;

const ph = (n, desde = 1) => Array.from({ length: n }, (_, i) => `$${i + desde}`).join(', ');
const sqlPuntos = (n) => `select market_id, (extract(epoch from ts) * 1000)::bigint as t, price as p
    from pm_price_hist where market_id in (${ph(n)}) order by market_id, ts`;

// Puntos → un INSERT con ON CONFLICT. El último precio de un mismo ts gana.
function sqlInsertPuntos(market_id, puntos) {
  const params = [];
  const values = puntos.map((p) => {
    params.push(market_id, new Date(p.t).toISOString(), p.p);
    const k = params.length;
    return `($${k - 2}, $${k - 1}, $${k})`;
  });
  return {
    query: `insert into pm_price_hist (market_id, ts, price) values ${values.join(', ')}
      on conflict (market_id, ts) do update set price = excluded.price`,
    params,
  };
}

// Un 'ok' no se degrada a 'error' (un reintento con el CLOB caído no borra lo bueno).
function sqlRegistraDescarga({ market_id, token, estado, puntos, http, forma, desdeMs, hastaMs }) {
  return {
    query: `insert into pm_price_hist_fetch (market_id, token_id, estado, puntos, http, forma, desde, hasta)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (market_id) do update set
        token_id = excluded.token_id,
        estado = case when pm_price_hist_fetch.estado = 'ok' and excluded.estado <> 'ok' then pm_price_hist_fetch.estado else excluded.estado end,
        puntos = case when pm_price_hist_fetch.estado = 'ok' and excluded.estado <> 'ok' then pm_price_hist_fetch.puntos else excluded.puntos end,
        http = excluded.http, forma = excluded.forma, desde = excluded.desde, hasta = excluded.hasta,
        bajado_en = now()`,
    params: [market_id, token, estado, (puntos || []).length, http ?? null, forma || null,
      desdeMs ? new Date(desdeMs).toISOString() : null, hastaMs ? new Date(hastaMs).toISOString() : null],
  };
}

// ─────────────────── markdown ───────────────────

const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%');
const f2 = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const usd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toFixed(2));

function renderResumenMarkdown(s) {
  const L = [];
  const C = s.criterios || CRITERIOS_PM_DRIFT;
  const r = s.resultado || {};
  const c = r.cobertura || {};
  L.push('# PM-DRIFT — ¿el movimiento previo del precio de Polymarket predice el beat?');
  L.push('');
  L.push(`Generado: ${s.generado_en}`);
  L.push('');
  L.push(`## Estado: **${r.estado}**${s.solo_cobertura ? ' (modo cobertura: sin veredicto)' : ''}`);
  if (r.motivo) L.push(`> ${r.motivo}`);
  L.push('');
  L.push(`Hipótesis previa registrada: ${C.hipotesis_previa}`);
  L.push('');
  const u = s.universo || {};
  L.push('## Universo');
  L.push(`- Filas leídas (v2 ∪ v1): **${u.filas ?? '—'}** → universo: **${c.universo ?? '—'}**`);
  if (u.excluidos) {
    const e = u.excluidos;
    L.push(`- Excluidos: duplicados ${e.duplicado} · no resueltos ${e.no_resuelto} · liquidez < $${C.min_volumen_usd} ${e.liquidez} · sin token ${e.sin_token} · sin fecha de reporte ${e.sin_fecha_reporte}`);
  }
  L.push(`- Sin hora de reporte (imputados AMC 16:00 ET): **${c.sin_hora_imputada_amc ?? '—'}**`);
  L.push('');
  L.push('## Cobertura');
  if (s.descarga) {
    const d = s.descarga;
    L.push(`- Esta corrida bajó: ${d.intentados} intentos · ${d.ok} ok (${d.vacios} vacíos) · ${d.errores} errores · ${d.puntos} puntos${d.ratelimit ? ' · **cortado por 429**' : ''}${d.por_presupuesto ? ` · ${d.por_presupuesto} quedan para la próxima` : ''}`);
  }
  L.push(`- Con los 3 precios (T-72h, T-24h, T-2h): **${c.con_3_precios ?? '—'}**`);
  L.push(`- Con Δ válido (T-72h y T-24h): **${c.con_delta ?? '—'}** (mínimo ${C.min_n_delta}) · con p24: ${c.con_p24 ?? '—'} · con Δ2: ${c.con_delta2 ?? '—'}`);
  L.push(`- Pendientes de bajar: ${c.pendiente_descarga ?? '—'} · error de descarga: ${c.error_descarga ?? '—'} · puntos en caché: ${c.puntos_totales ?? '—'}`);
  if (c.faltan) {
    L.push('');
    L.push('| precio | sin historial | sin punto anterior | hueco > 3h |');
    L.push('|---|---|---|---|');
    for (const k of ['t72', 't24', 't2']) {
      const x = c.faltan[k] || {};
      L.push(`| ${k.toUpperCase().replace('T', 'T-')}h | ${x.sin_historial || 0} | ${x.sin_punto_anterior || 0} | ${x.hueco_mayor_3h || 0} |`);
    }
  }
  L.push('');
  if (s.solo_cobertura || !r.regresion) {
    L.push('_Sin resultados en este modo/estado. Los criterios están congelados en `CRITERIOS_PM_DRIFT`._');
    return L.join('\n');
  }

  const reg = (x) => (x && x.convergio ? `coef ${f2(x.coef, 4)} · se ${f2(x.se, 4)} · **t ${f2(x.t)}** · N ${x.n} · grupos ${x.grupos}` : `sin convergencia (${x ? x.motivo : '—'}) · N ${x ? x.n : 0}`);
  L.push('## a) Regresión logística: resultado ~ logit(p24) + Δ');
  L.push(`- Δ (por punto): ${reg(r.regresion)}`);
  if (r.regresion && r.regresion.convergio) L.push(`- logit(p24): ${f2(r.regresion.coef_logit_p24, 4)} · intercepto ${f2(r.regresion.intercepto, 4)}`);
  L.push('- Errores agrupados por fecha de reporte.');
  L.push('');
  L.push(`## b) Tasa de Yes por tramo de p24 (Δ ≥ +${C.umbral_drift_pts} vs Δ ≤ −${C.umbral_drift_pts})`);
  L.push('| tramo p24 | N | sube: n | sube: Yes | sube: p24 medio | baja: n | baja: Yes | baja: p24 medio |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const t of r.tramos || []) L.push(`| ${t.tramo} | ${t.n} | ${t.sube.n} | ${pct(t.sube.tasa_yes)} | ${pct(t.sube.p24_medio)} | ${t.baja.n} | ${pct(t.baja.tasa_yes)} | ${pct(t.baja.p24_medio)} |`);
  L.push('');
  const sim = (x) => `${x.operaciones} ops (${x.compra_yes} Yes / ${x.compra_no} No) · aciertos ${x.aciertos} · bruto ${usd(x.bruto_usd)} · costos ${usd(-x.costos_usd)} · **neto ${usd(x.neto_usd)}** (${f2(x.neto_por_apuesta, 4)}/apuesta)`;
  L.push(`## c) Simulación en papel ($${C.apuesta_usd}/apuesta, $${C.costo_por_operacion_usd} por operación)`);
  L.push(`- Todo: ${sim(r.simulacion)}`);
  L.push('');
  L.push(`## d) Fuera de muestra (mediana de fecha: ${r.mediana_fecha})`);
  for (const [nom, m] of [['1ª mitad (≤ mediana)', r.mitad_antes], ['2ª mitad (> mediana)', r.mitad_despues]]) {
    L.push(`- **${nom}** — N ${m.n}`);
    L.push(`  - regresión: ${reg(m.regresion)}`);
    L.push(`  - simulación: ${sim(m.simulacion)}`);
  }
  L.push('');
  const cal = r.calibracion || {};
  L.push(`## e) Calibración de p24 (referencia) — Brier **${f2(cal.brier, 4)}** · N ${cal.n} · tasa Yes ${pct(cal.tasa_yes)}`);
  L.push('| decil | N | p24 rango | p24 medio | tasa Yes |');
  L.push('|---|---|---|---|---|');
  for (const d of cal.deciles || []) L.push(`| ${d.decil} | ${d.n} | ${pct(d.p24_min)}–${pct(d.p24_max)} | ${pct(d.p24_medio)} | ${pct(d.tasa_yes)} |`);
  L.push('');
  const sec = r.secundario || {};
  L.push('## Secundario (se reporta, NO decide)');
  L.push(`- Δ2 = p(T-2h) − p(T-24h): N ${sec.n_delta2} · media ${f2(sec.delta2_medio)} pts · resultado ~ logit(p24) + Δ2: ${reg(sec.regresion_delta2)}`);
  L.push(`- Δ sin los mercados con hora imputada: ${reg(sec.regresion_delta_sin_hora_imputada)}`);
  L.push('');
  L.push('## Veredicto');
  const k = r.cumple || {};
  L.push(`- N con Δ ≥ ${C.min_n_delta}: ${k.n_suficiente ? '✅' : '❌'} (${r.n_delta})`);
  L.push(`- coef Δ > 0: ${k.coef_positivo ? '✅' : '❌'} · t = ${f2(k.t)} (GO ≥ ${C.t_go}; FRÁGIL ≥ ${C.t_fragil})`);
  L.push(`- positivo en ambas mitades: ${k.positivo_mitad_antes ? '✅' : '❌'} / ${k.positivo_mitad_despues ? '✅' : '❌'}`);
  L.push(`- simulación neta > 0 en ambas mitades: ${k.sim_neta_antes > 0 ? '✅' : '❌'} ${usd(k.sim_neta_antes)} / ${k.sim_neta_despues > 0 ? '✅' : '❌'} ${usd(k.sim_neta_despues)}`);
  L.push('');
  L.push(`**${r.estado}** — ${r.motivo}`);
  L.push('');
  L.push('_Criterios congelados antes de correr (`CRITERIOS_PM_DRIFT` en `api/_lib/pm-drift-analyze.js`, pineados por test). Ver docs/pm-drift-scope.md._');
  return L.join('\n');
}

export {
  CRITERIOS_PM_DRIFT, VENTANA_DESCARGA, ESTADOS,
  enHorarioVerano, etAUtcMs, horaDelReporte, ventanaDescarga,
  normalizaPuntos, precioEn, construyeUniverso, observacion, cobertura,
  logit, logistica, regresion, tablaTramos, simulacion, mitades, calibracion, veredicto, corre,
  bajaHistoriales,
  SCHEMA, SQL_UNIVERSO, SQL_ESTADOS, sqlPuntos, sqlInsertPuntos, sqlRegistraDescarga,
  renderResumenMarkdown,
};
