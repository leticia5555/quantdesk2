// ═══════════════════════════════════════════════════════════════════
// /api/rotation-analyze — candidato a Agente #7 v2, SOLO LECTURA.
//
// Una sola pregunta: ¿una rotación mensual Value + Momentum sobre el universo
// con historial de EPS bate al SPY de forma OPERABLE, sin look-ahead? Los
// umbrales están CONGELADOS en _lib/rotation-analyze.js (CRITERIOS) — se
// fijaron antes de correr y no se mueven.
//
//   GET /api/rotation-analyze                → JSON completo
//   GET /api/rotation-analyze?format=md      → resumen en español
//   GET /api/rotation-analyze?anios=3        → ventana de análisis (default 3)
//   GET /api/rotation-analyze?canastas=1     → incluye el detalle canasta a canasta
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes a Neon: un único SELECT sobre pead_earnings. NO llama a
// ensurePeadSchema() (hace CREATE TABLE) ni a beat() — latir acá enmascararía
// un cron muerto. Los precios NO viven en Neon: se bajan de Yahoo en vivo
// (velas diarias ajustadas, el mismo _lib/yahoo-daily.js del pead-analyze) y
// NO se cachean en la DB. tests/rotation-analyze.test.mjs captura toda query
// que pase por la frontera y falla si alguna no empieza con SELECT.
//
// ── Gate ───────────────────────────────────────────────────────────
// Mismo patrón que pead-analyze/arena-audit: si CRON_SECRET está puesta, sin
// el secret correcto → 401. Se acepta por header (`Authorization: Bearer ...`)
// o por query (`?secret=...`), porque el caso de uso es abrir el markdown
// directo en el navegador. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional, mismo patrón de la casa)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import {
  CRITERIOS, corre, viabilidadTtm, renderResumenMarkdown,
  recortaVelasIncompletas, alineaAlCalendario,
} from './_lib/rotation-analyze.js';
import { bajaSeries } from './_lib/yahoo-daily.js';

// ~99 símbolos de Yahoo + la cadena completa (principal + 4 sensibilidades +
// exploratorio). El default de 60s de Vercel no alcanza; misma medicina que
// pead-analyze/arena-run/arena-audit.
export const maxDuration = 300;

const BENCHMARK = 'SPY';

// El caveat va en la respuesta, no en la cabeza de quien la lee.
const CAVEAT_SUPERVIVENCIA =
  'SESGO DE SUPERVIVENCIA. El universo es la lista de HOY mirada hacia atrás: los nombres que quebraron, '
  + 'fueron adquiridos o deslistados NO están en `pead_earnings`, y los que sobrevivieron '
  + 'llegaron hasta hoy justamente porque les fue bien. Eso INFLA todo lo de arriba — '
  + 'retorno, Sharpe y exceso sobre SPY — y no hay forma de corregirlo con estos datos '
  + '(haría falta un universo point-in-time). Por eso el umbral económico se fijó con '
  + 'margen (SPY + 2 puntos porcentuales, no SPY + 0) y un GO con t apenas arriba de 2 '
  + 'se reporta como GO FRÁGIL. Un NO-GO acá es MÁS creíble que un GO: el sesgo empuja '
  + 'hacia el GO, así que si ni siquiera con el viento a favor pasa, no pasa.';

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
  // La ventana de precios necesita la ventana de análisis + 13 meses de
  // colchón para el momentum 12-1 del PRIMER rebalanceo.
  const range = anios <= 3 ? '5y' : '10y';

  try {
    // ── 1. EPS trimestrales desde Neon. UN SOLO SELECT, sin escribir nada. ──
    // Se piden `anios + 2` de historia: el TTM del primer rebalanceo necesita
    // 4 trimestres ANTERIORES al inicio de la ventana de análisis.
    const filas = await sql(
      `select e.symbol,
              to_char(e.fiscal_date_ending, 'YYYY-MM-DD') as fiscal_date_ending,
              to_char(e.reported_date, 'YYYY-MM-DD') as reported_date,
              e.reported_eps
         from pead_earnings e
        where e.reported_date >= (current_date - ($1 || ' years')::interval)
          and e.reported_date <= current_date
        order by e.symbol asc, e.reported_date asc`,
      [String(anios + 2)]
    );

    if (!filas.length) {
      return res.status(200).json({
        error: 'pead_earnings vacío en la ventana pedida — corre primero la cosecha (Fase 1 del PEAD).',
        solo_lectura: true, anios,
      });
    }

    // Agrupado por símbolo, ordenado asc por reported_date (lo que espera el lib).
    const eventosPorSimbolo = {};
    for (const f of filas) {
      (eventosPorSimbolo[f.symbol] ||= []).push({
        fiscal_date_ending: f.fiscal_date_ending,
        reported_date: f.reported_date,
        reported_eps: Number.isFinite(f.reported_eps) ? f.reported_eps : null,
      });
    }
    const simbolosDb = Object.keys(eventosPorSimbolo).sort();

    // ── 2. Precios: Yahoo en vivo (NO viven en Neon). ──
    const crudas = await bajaSeries([BENCHMARK, ...simbolosDb], range);
    const spyCrudo = crudas[BENCHMARK] ? recortaVelasIncompletas(crudas[BENCHMARK]) : null;
    if (!spyCrudo) {
      return res.status(502).json({ error: `Sin serie de ${BENCHMARK}: no hay benchmark, no hay análisis.` });
    }

    // El calendario canónico de sesiones es el de SPY (y por lo tanto también
    // el que define cuál es el "primer día hábil del mes").
    const calendario = spyCrudo.fechas;
    const seriesAlineadas = {};
    const sinPrecios = [];
    for (const s of simbolosDb) {
      if (!crudas[s]) { sinPrecios.push(s); continue; }
      seriesAlineadas[s] = alineaAlCalendario(recortaVelasIncompletas(crudas[s]), calendario);
    }
    const simbolos = simbolosDb.filter((s) => seriesAlineadas[s]);
    const spyAlineado = alineaAlCalendario(spyCrudo, calendario);

    // Ventana de análisis: los últimos `anios` años del calendario real.
    const hasta = calendario[calendario.length - 1];
    const desdeD = new Date(hasta + 'T00:00:00Z');
    desdeD.setUTCFullYear(desdeD.getUTCFullYear() - anios);
    const desde = desdeD.toISOString().slice(0, 10);

    const base = {
      eventosPorSimbolo, simbolos, calendario, seriesAlineadas,
      spyOpens: spyAlineado.opens, spyCloses: spyAlineado.closes,
      desde, criterios: CRITERIOS,
    };

    // ── 3. ESPECIFICACIÓN PRINCIPAL (la única que decide el veredicto) ──
    const principal = corre({ ...base, etiqueta: 'principal' });

    // ── 4. Sensibilidades OBLIGATORIAS ──
    const sensibilidades = [
      { nombre: 'Quintil superior (~20 nombres) en vez del decil',
        resultado: corre({ ...base, fraccion: CRITERIOS.fraccion_quintil, etiqueta: 'quintil' }) },
      { nombre: 'Solo VALUE (earnings yield point-in-time)',
        resultado: corre({ ...base, score: 'value', etiqueta: 'solo_value' }) },
      { nombre: 'Solo MOMENTUM (12-1)',
        resultado: corre({ ...base, score: 'momentum', etiqueta: 'solo_momentum' }) },
      { nombre: 'Rebalanceo cada 2 meses',
        resultado: corre({ ...base, cadaMeses: CRITERIOS.meses_rebalanceo_sensibilidad, etiqueta: 'bimestral' }) },
    ];

    // El rebalanceo bimestral produce la MITAD de rebalanceos que el mensual:
    // con la ventana de la casa (~3 años) queda por debajo del piso de muestra
    // por construcción. Decirlo evita leer ese INCONCLUSO como "no hay señal".
    const bimestral = sensibilidades[3].resultado;
    const notaBimestral = bimestral.muestra.rebalanceos_completos < CRITERIOS.min_rebalanceos
      ? `El rebalanceo bimestral deja ${bimestral.muestra.rebalanceos_completos} rebalanceos completos `
        + `(piso ${CRITERIOS.min_rebalanceos}): su INCONCLUSO es ARITMÉTICO — con una ventana de ${anios} años, `
        + 'rebalancear cada 2 meses no puede alcanzar el piso. Léase por sus números (t, Sharpe, exceso), '
        + 'no por su veredicto.'
      : null;

    // ── 5. EXPLORATORIO — no cuenta para el veredicto, va etiquetado ──
    const exploratorio = [{
      etiqueta: 'EXPLORATORIO',
      nombre: 'earnings yield contra el OPEN del día de rebalanceo (en vez del cierre previo)',
      por_que: 'El encargo dice "el precio de ese día"; la principal usa el cierre ANTERIOR porque la '
        + 'canasta tiene que estar armada antes de la apertura en la que se ejecuta. Este corte mide '
        + 'cuánto de la diferencia es el gap overnight — si el veredicto cambiara acá, el resultado '
        + 'estaría colgado de un precio que no se conoce a tiempo.',
      resultado: corre({ ...base, precioYield: 'open', etiqueta: 'yield_open' }),
    }];

    const salida = {
      pregunta: '¿La rotación mensual Value + Momentum bate al SPY de forma operable, sin look-ahead?',
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      especificacion: {
        universo: `los ${simbolos.length} símbolos con historial de EPS en pead_earnings y precios en Yahoo`,
        rebalanceo: 'primer día hábil del mes, fills a la APERTURA de ese día',
        value: 'earnings yield point-in-time = TTM EPS (4 trimestres con reported_date ANTERIOR a la fecha '
          + 'de rebalanceo) / cierre de la sesión previa',
        momentum: 'retorno 12-1 (de t−12m a t−1m, se salta el último mes)',
        score: 'promedio de los dos ranks percentiles, calculados DENTRO de cada rebalanceo',
        cartera: `decil superior (~${Math.round(simbolos.length * CRITERIOS.fraccion_decil)} nombres), equal-weight`,
        costo_por_lado_bp: CRITERIOS.costo_por_lado * 10000,
        benchmark: `${BENCHMARK}, retorno anormal diario (calendar-time)`,
        ventana_anios: anios,
      },
      criterios: CRITERIOS,
      datos: {
        filas_eps: filas.length,
        simbolos: simbolos.length,
        simbolos_en_db: simbolosDb.length,
        sin_precios: sinPrecios,
        calendario: { sesiones: calendario.length, desde: calendario[0], hasta },
        ventana_analisis: { desde, hasta },
      },
      viabilidad_ttm: viabilidadTtm(principal, CRITERIOS),
      principal,
      veredicto: principal.veredicto,
      go_fragil: principal.fragil,
      sensibilidades,
      nota_bimestral: notaBimestral,
      exploratorio,
      caveat: CAVEAT_SUPERVIVENCIA,
    };

    if (!conCanastas) {
      // El detalle canasta a canasta engorda la respuesta (36 × ~10 nombres ×
      // 6 corridas) y el veredicto no lo necesita.
      for (const b of [principal, ...sensibilidades.map((s) => s.resultado),
        ...exploratorio.map((e) => e.resultado)]) {
        delete b.detalle_canastas;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'rotation-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
