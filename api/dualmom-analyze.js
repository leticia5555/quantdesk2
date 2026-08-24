// ═══════════════════════════════════════════════════════════════════
// /api/dualmom-analyze — Dual Momentum con gate de tendencia, SOLO LECTURA.
//
// Dos preguntas de una: ¿sirve como agente DEFENSIVO, y sirve como evidencia
// para el breaker macro de la liga? Los umbrales están CONGELADOS en
// _lib/dualmom-analyze.js (CRITERIOS) — se fijaron antes de correr y no se
// mueven. Tercer backtest con el mismo playbook (PEAD → rotación → este).
//
//   GET /api/dualmom-analyze                → JSON completo
//   GET /api/dualmom-analyze?format=md      → resumen en español
//   GET /api/dualmom-analyze?anios=3        → ventana de análisis (default 3)
//   GET /api/dualmom-analyze?canastas=1     → detalle canasta a canasta + serie del gate
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes a Neon: un único SELECT DISTINCT sobre pead_earnings, y solo
// para quedarse con el MISMO universo que rotation-analyze (esta estrategia no
// usa EPS: la comparabilidad es el punto). NO llama a ensurePeadSchema() (hace
// CREATE TABLE) ni a beat() — latir acá enmascararía un cron muerto. Los
// precios NO viven en Neon: se bajan de Yahoo en vivo (_lib/yahoo-daily.js).
// tests/dualmom-analyze.test.mjs captura toda query que pase por la frontera y
// falla si alguna no empieza con SELECT.
//
// ── Gate del endpoint (no confundir con el gate macro) ─────────────
// Mismo patrón que pead-analyze/rotation-analyze: si CRON_SECRET está puesta,
// sin el secret correcto → 401, por header o por query. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional, mismo patrón de la casa)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { CRITERIOS, corre, renderResumenMarkdown } from './_lib/dualmom-analyze.js';
import { recortaVelasIncompletas, alineaAlCalendario } from './_lib/rotation-analyze.js';
import { bajaSeries } from './_lib/yahoo-daily.js';

// ~99 símbolos de Yahoo + la cadena completa (principal + 4 sensibilidades +
// exploratorio). El default de 60s de Vercel no alcanza; misma medicina que
// pead-analyze/rotation-analyze/arena-run.
export const maxDuration = 300;

const BENCHMARK = 'SPY';

// El caveat va en la respuesta, no en la cabeza de quien la lee.
const CAVEAT_NO_INDEPENDIENTE =
  'ESTO NO ES UNA PRUEBA INDEPENDIENTE DEL MOMENTUM. Corre sobre el MISMO universo y la '
  + 'MISMA ventana que /api/rotation-analyze, así que hereda entero su sesgo de supervivencia '
  + '(el universo es la lista de HOY mirada hacia atrás: los que quebraron o fueron deslistados '
  + 'no están) y el MISMO régimen de mercado. Si el momentum funcionó allá, acá va a funcionar '
  + 'otra vez por construcción — no es confirmación, es el mismo experimento con otro envoltorio. '
  + 'El puente honesto entre los dos backtests es la sensibilidad "sin filtro absoluto": es '
  + 'momentum relativo puro, con la misma definición 12-1, y debería parecerse al corte '
  + '"solo momentum" del rotation-analyze. Lo ÚNICO genuinamente nuevo acá es el gate: si '
  + 'gate_activaciones = 0, esta corrida no aporta ninguna evidencia nueva sobre defensa.';

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

  const format = String(q.format || 'json').toLowerCase();
  const anios = Math.max(1, Math.min(10, Number(q.anios) || CRITERIOS.anios_ventana));
  const conCanastas = String(q.canastas || '') === '1';
  // La ventana de precios necesita la de análisis + 13 meses para el momentum
  // 12-1 del primer rebalanceo, + 200 sesiones para la primera SMA del gate.
  const range = anios <= 3 ? '5y' : '10y';

  try {
    // ── 1. El universo, desde Neon. UN SOLO SELECT, sin escribir nada. ──
    // Mismo filtro temporal que rotation-analyze para que el set de símbolos
    // sea EL MISMO: la comparabilidad entre los dos backtests es el punto.
    const filas = await sql(
      `select distinct e.symbol
         from pead_earnings e
        where e.reported_date >= (current_date - ($1 || ' years')::interval)
          and e.reported_date <= current_date
        order by e.symbol asc`,
      [String(anios + 2)]
    );

    if (!filas.length) {
      return res.status(200).json({
        error: 'pead_earnings vacío en la ventana pedida — corre primero la cosecha (Fase 1 del PEAD).',
        solo_lectura: true, anios,
      });
    }
    const simbolosDb = filas.map((f) => f.symbol);

    // ── 2. Precios: Yahoo en vivo (NO viven en Neon). ──
    const crudas = await bajaSeries([BENCHMARK, ...simbolosDb], range);
    const spyCrudo = crudas[BENCHMARK] ? recortaVelasIncompletas(crudas[BENCHMARK]) : null;
    if (!spyCrudo) {
      return res.status(502).json({ error: `Sin serie de ${BENCHMARK}: no hay benchmark NI gate macro, no hay análisis.` });
    }

    const calendario = spyCrudo.fechas;
    const seriesAlineadas = {};
    const sinPrecios = [];
    for (const s of simbolosDb) {
      if (!crudas[s]) { sinPrecios.push(s); continue; }
      seriesAlineadas[s] = alineaAlCalendario(recortaVelasIncompletas(crudas[s]), calendario);
    }
    const simbolos = simbolosDb.filter((s) => seriesAlineadas[s]);
    const spyAlineado = alineaAlCalendario(spyCrudo, calendario);

    const hasta = calendario[calendario.length - 1];
    const desdeD = new Date(hasta + 'T00:00:00Z');
    desdeD.setUTCFullYear(desdeD.getUTCFullYear() - anios);
    const desde = desdeD.toISOString().slice(0, 10);

    const base = {
      simbolos, calendario, seriesAlineadas,
      spyOpens: spyAlineado.opens, spyCloses: spyAlineado.closes,
      desde, criterios: CRITERIOS,
    };

    // ── 3. ESPECIFICACIÓN PRINCIPAL (la única que decide el veredicto) ──
    const principal = corre({ ...base, etiqueta: 'principal' });

    // ── 4. Sensibilidades OBLIGATORIAS ──
    const sensibilidades = [
      { nombre: 'Sin gate macro (atribución: cuánto es el gate)',
        resultado: corre({ ...base, conGate: false, etiqueta: 'sin_gate' }) },
      { nombre: 'Sin filtro absoluto (momentum relativo puro — puente con rotation-analyze)',
        resultado: corre({ ...base, conFiltroAbsoluto: false, etiqueta: 'sin_filtro_absoluto' }) },
      { nombre: `SMA de ${CRITERIOS.sma_meses_faber} meses en vez de ${CRITERIOS.sma_dias} días (variante Faber)`,
        resultado: corre({ ...base, tipoSma: 'meses', etiqueta: 'sma_faber' }) },
      { nombre: 'Rebalanceo cada 2 meses',
        resultado: corre({ ...base, cadaMeses: CRITERIOS.meses_rebalanceo_sensibilidad, etiqueta: 'bimestral' }) },
    ];

    // El bimestral produce la MITAD de rebalanceos: con la ventana de la casa
    // queda bajo el piso de muestra por aritmética, no por falta de señal.
    const bimestral = sensibilidades[3].resultado;
    const notaBimestral = bimestral.muestra.rebalanceos_completos < CRITERIOS.min_rebalanceos
      ? `El rebalanceo bimestral deja ${bimestral.muestra.rebalanceos_completos} rebalanceos completos `
        + `(piso ${CRITERIOS.min_rebalanceos}): su INCONCLUSO es ARITMÉTICO — con una ventana de ${anios} años, `
        + 'rebalancear cada 2 meses no puede alcanzar el piso. Léase por sus números (Sharpe, drawdown, '
        + 'retorno y activaciones del gate), no por su veredicto.'
      : null;

    // ── 5. EXPLORATORIO — no cuenta para el veredicto, va etiquetado ──
    const exploratorio = [{
      etiqueta: 'EXPLORATORIO',
      nombre: 'gate evaluado con el cierre DEL MISMO día de rebalanceo (en vez del cierre previo)',
      por_que: 'Es la lectura literal del encargo ("si SPY cierra debajo de su SMA en la fecha de '
        + 'rebalanceo"), pero ese cierre todavía no existe cuando hay que mandar la orden a la '
        + 'apertura de ese mismo día. La principal usa el cierre previo — que en el primer día '
        + 'hábil del mes es el último cierre del mes anterior, la señal mensual clásica. Este '
        + 'corte mide cuánto valdría el dato que no se conoce a tiempo.',
      resultado: corre({ ...base, gateEnCierreDelDia: true, etiqueta: 'gate_mismo_dia' }),
    }];

    const salida = {
      pregunta: '¿El Dual Momentum con gate de tendencia defiende de verdad, y sirve de evidencia para el breaker macro?',
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      especificacion: {
        universo: `los ${simbolos.length} símbolos con historial de EPS en pead_earnings (el MISMO set que `
          + '/api/rotation-analyze, por comparabilidad — esta estrategia no usa los EPS)',
        rebalanceo: 'primer día hábil del mes, fills a la APERTURA de ese día',
        seleccion: `rank por momentum 12-1 → top decil (~${Math.round(simbolos.length * CRITERIOS.fraccion_decil)} nombres), equal-weight`,
        filtro_absoluto: 'un nombre entra solo si su propio 12-1 > 0 (se aplica DESPUÉS de cortar el decil: '
          + 'el punto es quedarse con menos nombres, no con los diez menos malos)',
        gate: `si el último cierre conocido de ${BENCHMARK} está debajo de su SMA de ${CRITERIOS.sma_dias} `
          + 'sesiones, la cartera COMPLETA se va a efectivo ese mes (efectivo rinde 0)',
        costo_por_lado_bp: CRITERIOS.costo_por_lado * 10000,
        benchmark: `${BENCHMARK} comprado y mantenido sobre los MISMOS días`,
        ventana_anios: anios,
      },
      criterios: CRITERIOS,
      datos: {
        simbolos: simbolos.length,
        simbolos_en_db: simbolosDb.length,
        sin_precios: sinPrecios,
        calendario: { sesiones: calendario.length, desde: calendario[0], hasta },
        ventana_analisis: { desde, hasta },
      },
      principal,
      veredicto: principal.veredicto,
      go_fragil: principal.fragil,
      motivo_fragil: principal.motivo_fragil,
      gate_activaciones: principal.gate.activaciones,
      sensibilidades,
      nota_bimestral: notaBimestral,
      exploratorio,
      caveat: CAVEAT_NO_INDEPENDIENTE,
    };

    if (!conCanastas) {
      // El detalle canasta a canasta y la serie del gate engordan la respuesta
      // (36 meses × 6 corridas) y el veredicto no los necesita.
      for (const b of [principal, ...sensibilidades.map((s) => s.resultado),
        ...exploratorio.map((e) => e.resultado)]) {
        delete b.detalle_canastas;
        delete b.gate_serie;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'dualmom-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
