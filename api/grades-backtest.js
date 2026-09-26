// ═══════════════════════════════════════════════════════════════════
// /api/grades-backtest — ¿el enfriamiento de los analistas antes del reporte
// predice beat/miss? BACKTEST PRE-REGISTRADO.
//
//   GET /api/grades-backtest?fase=0            → CENSO (Fase 0), antes de nada
//   GET /api/grades-backtest                   → el backtest (Fase 1)
//   GET /api/grades-backtest?format=md         → resumen en español
//   GET /api/grades-backtest?simbolos=20       → recorta el censo (ahorra cuota)
//
// ── EL ORDEN NO SE SALTEA ──────────────────────────────────────────
// La Fase 0 mide si hay con qué. Si la muestra real queda bajo
// `min_eventos` (100), el veredicto es INCONCLUSO y se para ahí: el candado
// está en `analizaGrades`, no en la buena voluntad de quien lee.
//
// ── SOLO LECTURA en Neon ───────────────────────────────────────────
// Un SELECT a pm_earnings_markets y otro a pead_earnings. NO llama a
// ensureSchema() ni a beat(): latir acá enmascararía un cron muerto. Los grades
// se leen de FMP en vivo y NO se guardan — esta tanda no crea tabla.
//
// ── CUOTA ──────────────────────────────────────────────────────────
// Una corrida completa son ~99 requests a FMP (uno por símbolo). El plan
// gratis de FMP suele cortar por DÍA, así que la Fase 0 MIDE lo que gasta y lo
// reporta; con `?simbolos=N` se prueba con menos. Los rate limits se miden, no
// se asumen: es el encargo.
//
// ENV VARS: DATABASE_URL · FMP_API_KEY · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { gradesHistorical } from './_lib/fmp-grades.js';
import {
  CRITERIOS_GRADES, seleccionaVentana, analizaGrades, renderGradesMd, ADVERTENCIA,
} from './_lib/grades-backtest.js';

export const maxDuration = 300;

// Requests a FMP en paralelo. BAJO a propósito: el objetivo de la Fase 0 es
// MEDIR el rate limit, y pegarle con 20 hilos mide el rate limit de otra cosa.
const CONCURRENCIA = 4;
// Si llegan tantos 429 seguidos, se corta y se DECLARA. Seguir pegándole
// gastaría cuota para aprender lo mismo dos veces.
const MAX_429 = 5;
const PRESUPUESTO_MS = 240000;

// ── Los grades de varios símbolos, midiendo el camino ──
async function traeGrades(simbolos, { limite = null, fetchImpl = fetch } = {}) {
  const lista = limite ? simbolos.slice(0, limite) : simbolos;
  const porSimbolo = new Map();
  const telemetria = [];
  let n429 = 0, cortado = null;
  const t0 = Date.now();

  let i = 0;
  const worker = async () => {
    while (i < lista.length) {
      if (n429 >= MAX_429) { cortado = cortado || 'rate_limit'; return; }
      if (Date.now() - t0 > PRESUPUESTO_MS) { cortado = cortado || 'presupuesto'; return; }
      const sym = lista[i++];
      const r = await gradesHistorical(sym, { fetchImpl });
      if (r.motivo === 'rate_limit') n429++;
      if (r.ok) porSimbolo.set(sym, r.filas);
      telemetria.push({
        symbol: sym, ok: r.ok, motivo: r.motivo || null, status: r.status ?? null, ms: r.ms ?? null,
        meses: r.meses ?? null, desde: r.desde ?? null, hasta: r.hasta ?? null,
        posible_tope: r.posible_tope ?? null, fmp_message: r.fmp_message || null,
        detalle: r.detalle || null, body_sample: r.ok ? null : (r.body_sample || null),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, lista.length) }, worker));

  const ms = telemetria.map((t) => t.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const pedidos = telemetria.length;
  const duracion = Date.now() - t0;
  return {
    porSimbolo, telemetria,
    // Los rate limits MEDIDOS, no asumidos.
    limites: {
      pedidos, ok: telemetria.filter((t) => t.ok).length,
      rate_limit_429: n429,
      cortado_por: cortado,
      concurrencia: CONCURRENCIA,
      duracion_ms: duracion,
      requests_por_segundo: duracion ? +(pedidos / (duracion / 1000)).toFixed(2) : null,
      latencia_ms: ms.length ? { min: ms[0], mediana: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] } : null,
      // Lo que esta corrida GASTÓ de cuota. El plan gratis suele cortar por día.
      cuota_gastada_requests: pedidos,
      nota: 'Medido en esta corrida, no asumido. Un 429 se reporta aparte de un http_error: son cosas distintas.',
      motivos: telemetria.filter((t) => !t.ok).reduce((a, t) => { a[t.motivo] = (a[t.motivo] || 0) + 1; return a; }, {}),
    },
  };
}

// ── Los eventos etiquetados, de Neon ──
//
// LA MUESTRA: mercados de `pm_earnings_markets` con outcome resuelto. Se
// reportan DOS conteos a propósito:
//   · `con_outcome` — todos los resueltos con report_date. Es la muestra que
//     usa este backtest.
//   · `con_filtros_de_la_fase_2` — los que además tienen precio válido a T-24h
//     y volumen ≥ $500, o sea los ~231 del veredicto del earnings-beat.
// Se usa el primero porque la validez del PRECIO es un requisito de la pregunta
// del precio, y acá el precio no juega: exigirlo tiraría eventos etiquetados sin
// ninguna razón. Los dos números van en la respuesta para que se pueda auditar.
async function cargaEventos() {
  const filas = await sql(
    `select market_id, symbol,
            to_char(report_date, 'YYYY-MM-DD') as report_date,
            outcome, yes_price_estado, volume
       from pm_earnings_markets
      where outcome is not null and report_date is not null
      order by report_date asc, symbol asc`
  );
  const conFiltrosF2 = filas.filter((f) =>
    f.yes_price_estado === 'valido' && Number(f.volume) >= 500).length;
  return {
    eventos: filas.map((f) => ({
      market_id: f.market_id, symbol: f.symbol, report_date: f.report_date,
      beat: String(f.outcome).toLowerCase() === 'yes',
    })),
    conteos: { con_outcome: filas.length, con_filtros_de_la_fase_2: conFiltrosF2 },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const esCenso = String(q.fase || '') === '0';
  const formato = String(q.format || '').toLowerCase();
  const esMd = formato === 'md' || formato === 'markdown';
  const limite = (() => {
    const n = Number(q.simbolos);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  })();

  try {
    const { eventos, conteos } = await cargaEventos();
    const universo = [...new Set(V0_UNIVERSE)];
    // Solo los símbolos que hacen falta: los del universo que además tienen
    // algún evento etiquetado. Pedirle a FMP los 99 cuando 40 no tienen evento
    // gasta cuota para nada.
    const conEventos = [...new Set(eventos.map((e) => e.symbol))].filter((s) => universo.includes(s)).sort();

    const { porSimbolo, telemetria, limites } = await traeGrades(conEventos, { limite });

    // Los grades se pegan a cada evento. La ventana la decide `seleccionaVentana`
    // (corte ESTRICTO en report_date) — acá no se filtra nada a ojo.
    const conGrades = eventos.map((e) => ({ ...e, grades: porSimbolo.get(e.symbol) || [] }));

    if (esCenso) {
      // ── FASE 0: el CENSO. Mide si hay con qué, y no dictamina la señal. ──
      const ventanas = conGrades.map((e) => ({ e, v: seleccionaVentana(e.grades, e.report_date) }));
      const validos = ventanas.filter((x) => x.v.ok);
      const descartes = {};
      for (const x of ventanas) if (!x.v.ok) descartes[x.v.motivo] = (descartes[x.v.motivo] || 0) + 1;

      const conDatos = telemetria.filter((t) => t.ok);
      const meses = conDatos.map((t) => t.meses).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      const alcanza = validos.length >= CRITERIOS_GRADES.min_eventos;

      const salida = {
        fase: 0,
        pregunta: '¿Hay con qué correr el backtest? (historia de grades, cobertura del universo, rate limits y tamaño de muestra REAL)',
        generado_en: new Date().toISOString(),
        solo_lectura_en_neon: true,
        // 1. ¿Cuántos meses de historia devuelve grades-historical?
        historia: {
          simbolos_con_datos: conDatos.length,
          meses_por_simbolo: meses.length ? { min: meses[0], mediana: meses[Math.floor(meses.length / 2)], max: meses[meses.length - 1] } : null,
          mas_antiguo: conDatos.map((t) => t.desde).filter(Boolean).sort()[0] || null,
          mas_reciente: conDatos.map((t) => t.hasta).filter(Boolean).sort().pop() || null,
          alguno_en_el_tope_del_limit: conDatos.some((t) => t.posible_tope),
          nota_tope: 'Si alguno toca el `limit`, la historia puede estar cortada por el límite y no por la fuente. Es la cicatriz del `limit=5` del censo de Polymarket.',
        },
        // 2. ¿Cubre los 99 símbolos del universo v0?
        cobertura: {
          universo_v0: universo.length,
          con_evento_etiquetado: conEventos.length,
          pedidos: limites.pedidos,
          con_grades: conDatos.length,
          sin_grades: limites.pedidos - conDatos.length,
          recortado_a: limite,
          simbolos_sin_grades: telemetria.filter((t) => !t.ok).map((t) => ({ symbol: t.symbol, motivo: t.motivo, fmp_message: t.fmp_message })),
        },
        // 3. Rate limits, MEDIDOS.
        limites,
        // 4. El tamaño de muestra REAL.
        muestra: {
          eventos_etiquetados: conteos.con_outcome,
          con_filtros_de_la_fase_2: conteos.con_filtros_de_la_fase_2,
          nota_muestra: 'Este backtest usa TODOS los mercados con outcome resuelto: la validez del precio a T-24h es un requisito de la pregunta del precio, y acá el precio no juega. El conteo con los filtros de la Fase 2 va al lado para poder auditar la diferencia.',
          con_ventana_valida: validos.length,
          min_eventos: CRITERIOS_GRADES.min_eventos,
          alcanza,
          descartes,
        },
        veredicto_fase_0: alcanza ? 'HAY CON QUÉ — se puede correr la Fase 1'
          : `INCONCLUSO POR MUESTRA — ${validos.length} eventos con ventana válida, el candado son ${CRITERIOS_GRADES.min_eventos}. Se para acá.`,
        criterios: CRITERIOS_GRADES,
        advertencia: ADVERTENCIA,
        telemetria_por_simbolo: telemetria,
      };
      if (esMd) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(renderCensoMd(salida));
      }
      return res.status(200).json(salida);
    }

    // ── FASE 1: el backtest. El candado de muestra vive en analizaGrades. ──
    const a = analizaGrades(conGrades);
    const salida = {
      fase: 1,
      pregunta: '¿El enfriamiento de los analistas entre T-3 y T-1 meses predice beat/miss?',
      pre_registrado: true,
      generado_en: new Date().toISOString(),
      solo_lectura_en_neon: true,
      conteos_de_la_fuente: conteos,
      fmp: limites,
      ...a,
    };
    // El detalle evento por evento engorda la respuesta y el veredicto no lo
    // necesita. ?eventos=1 para verlo.
    if (String(q.eventos || '') !== '1') delete salida.eventos;

    if (esMd) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderGradesMd(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'grades-backtest: ' + ((err && err.message) || 'unknown') });
  }
}

function renderCensoMd(c) {
  const L = [];
  L.push('# FASE 0 — ¿hay con qué correr el backtest de enfriamiento?');
  L.push('');
  L.push(`Generado: ${c.generado_en}`);
  L.push('');
  L.push(`## ${c.veredicto_fase_0}`);
  L.push('');
  const h = c.historia, m = c.muestra, lim = c.limites, cob = c.cobertura;
  L.push('## 1. Historia de `grades-historical`');
  L.push('');
  L.push(`Símbolos con datos: **${h.simbolos_con_datos}** · meses por símbolo: ${h.meses_por_simbolo ? `min ${h.meses_por_simbolo.min} · mediana ${h.meses_por_simbolo.mediana} · max ${h.meses_por_simbolo.max}` : '—'}`);
  L.push(`Rango: ${h.mas_antiguo || '—'} → ${h.mas_reciente || '—'}`);
  if (h.alguno_en_el_tope_del_limit) { L.push(''); L.push(`> ⚠ ${h.nota_tope}`); }
  L.push('');
  L.push('## 2. Cobertura del universo v0');
  L.push('');
  L.push(`Universo: ${cob.universo_v0} · con evento etiquetado: ${cob.con_evento_etiquetado} · pedidos: ${cob.pedidos} · **con grades: ${cob.con_grades}** · sin grades: ${cob.sin_grades}`);
  if (cob.recortado_a) L.push(`(recortado a ${cob.recortado_a} símbolos con \`?simbolos=\`)`);
  if ((cob.simbolos_sin_grades || []).length) {
    L.push('');
    L.push('| Símbolo | Motivo | Mensaje de FMP |');
    L.push('|---|---|---|');
    for (const s of cob.simbolos_sin_grades.slice(0, 30)) L.push(`| ${s.symbol} | ${s.motivo} | ${s.fmp_message || '—'} |`);
  }
  L.push('');
  L.push('## 3. Rate limits (MEDIDOS en esta corrida)');
  L.push('');
  L.push(`Pedidos: ${lim.pedidos} · ok: ${lim.ok} · **429: ${lim.rate_limit_429}** · cortado por: ${lim.cortado_por || 'nada'}`);
  L.push(`Concurrencia ${lim.concurrencia} · ${lim.requests_por_segundo ?? '—'} req/s · latencia ${lim.latencia_ms ? `${lim.latencia_ms.min}/${lim.latencia_ms.mediana}/${lim.latencia_ms.max} ms` : '—'}`);
  L.push(`**Cuota gastada en esta corrida: ${lim.cuota_gastada_requests} requests.**`);
  if (Object.keys(lim.motivos || {}).length) L.push(`Motivos de fallo: ${Object.entries(lim.motivos).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
  L.push('');
  L.push('## 4. Tamaño de muestra REAL');
  L.push('');
  L.push(`Eventos etiquetados: **${m.eventos_etiquetados}** (con los filtros de la Fase 2 serían ${m.con_filtros_de_la_fase_2})`);
  L.push('');
  L.push(`> ${m.nota_muestra}`);
  L.push('');
  L.push(`Con ventana válida (≥ ${c.criterios.min_meses_grades} meses previos, T-1 fresco, ventana en rango): **${m.con_ventana_valida}** · candado: ${m.min_eventos} → ${m.alcanza ? '**alcanza**' : '**NO alcanza**'}`);
  if (Object.keys(m.descartes || {}).length) {
    L.push('');
    L.push('| Motivo de descarte | Eventos |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(m.descartes).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  }
  L.push('');
  L.push(`> ⚠ ${c.advertencia}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('Este censo NO dictamina la señal: mide si hay con qué. Los criterios de la Fase 1 ya están congelados en `CRITERIOS_GRADES` y pineados por test — se fijaron antes de correr esto.');
  return L.join('\n');
}
