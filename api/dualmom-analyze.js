// ═══════════════════════════════════════════════════════════════════
// /api/dualmom-analyze — backtest pre-registrado #2, SOLO LECTURA.
//
// Una sola pregunta: ¿un Dual Momentum (momentum relativo + momentum absoluto
// + gate de tendencia sobre SPY) DEFIENDE de verdad — menos drawdown que el
// SPY sin costar más de 1 punto de retorno al año? Los umbrales están
// CONGELADOS en _lib/dualmom-analyze.js (CRITERIOS) — se fijaron antes de
// correr y no se mueven. Candidato a agente defensivo y evidencia para el
// breaker macro de la liga.
//
//   GET /api/dualmom-analyze                → JSON completo
//   GET /api/dualmom-analyze?format=md      → resumen en español
//   GET /api/dualmom-analyze?anios=3        → ventana de análisis (default 3)
//   GET /api/dualmom-analyze?canastas=1     → incluye el detalle canasta a canasta
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes a Neon: un único SELECT DISTINCT sobre pead_earnings, y solo
// para heredar EL MISMO UNIVERSO que /api/rotation-analyze (esta estrategia no
// usa EPS; usa la lista de símbolos para que las dos corridas sean
// comparables). NO llama a ensurePeadSchema() (hace CREATE TABLE) ni a beat()
// — latir acá enmascararía un cron muerto. Los precios NO viven en Neon: se
// bajan de Yahoo en vivo (el mismo _lib/yahoo-daily.js del pead/rotation) y NO
// se cachean. tests/dualmom-analyze.test.mjs captura toda query que pase por la
// frontera y falla si alguna no empieza con SELECT.
//
// ── Gate ───────────────────────────────────────────────────────────
// Mismo patrón que pead-analyze/rotation-analyze/arena-audit: si CRON_SECRET
// está puesta, sin el secret correcto → 401. Se acepta por header
// (`Authorization: Bearer ...`) o por query (`?secret=...`), porque el caso de
// uso es abrir el markdown directo en el navegador. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional, mismo patrón de la casa)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import {
  CRITERIOS, GATE_PRINCIPAL, GATE_FABER, GATE_OFF,
  corre, renderResumenMarkdown, ultimosHabilesDelMes,
  recortaVelasIncompletas, alineaAlCalendario, pct,
} from './_lib/dualmom-analyze.js';
import { bajaSeries } from './_lib/yahoo-daily.js';

// ~99 símbolos de Yahoo + la cadena completa (principal + 5 sensibilidades +
// exploratorios). El default de 60s de Vercel no alcanza; misma medicina que
// pead-analyze/rotation-analyze/arena-run.
export const maxDuration = 300;

const BENCHMARK = 'SPY';

// El caveat va en la respuesta, no en la cabeza de quien la lee.
const CAVEAT_NO_INDEPENDIENTE =
  'NO ES UNA PRUEBA INDEPENDIENTE DEL MOMENTUM. Esta corrida usa LA MISMA VENTANA y EL MISMO '
  + 'UNIVERSO que /api/rotation-analyze, así que hereda entera su contaminación: (1) SESGO DE '
  + 'SUPERVIVENCIA — el universo es la lista de HOY mirada hacia atrás, los nombres que quebraron, '
  + 'fueron adquiridos o deslistados NO están en `pead_earnings`, y los que sobrevivieron llegaron '
  + 'hasta hoy justamente porque les fue bien; y (2) RÉGIMEN COMPARTIDO — son los mismos ~3 años '
  + 'de mercado, en su mayoría alcistas. El momentum-solo del rotation y el split "sin filtros" de '
  + 'acá miden esencialmente lo mismo sobre los mismos datos: si coinciden, eso NO es confirmación '
  + 'independiente, es la misma medición dos veces. Úsese el split "sin filtros" como PUENTE entre '
  + 'los dos reportes, no como réplica. Diferencia menor a declarar: el momentum-solo del rotation '
  + 'exige además TTM válido para ser elegible (comparte población con la pierna value), y acá no '
  + '— esta estrategia no usa EPS, así que su población elegible es algo más amplia. '
  + 'Y el sesgo NO empuja parejo en los cuatro criterios: infla el retorno y el Sharpe (§2, §4) '
  + 'pero también infla los de SPY, que es la vara; sobre el drawdown (§3) el efecto es más '
  + 'sutil — un universo sin quiebras tiene menos cola izquierda idiosincrática, así que la '
  + 'defensa medida acá es, si acaso, MÁS fácil de lo que sería en vivo.';

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
  // La ventana de precios necesita la ventana de análisis + 13 meses de colchón
  // para el momentum 12-1 del PRIMER rebalanceo + 200 sesiones para su SMA200.
  // '5y' cubre ambos para la ventana de la casa (3 años).
  const range = anios <= 3 ? '5y' : '10y';

  try {
    // ── 1. EL UNIVERSO. UN SOLO SELECT, sin escribir nada. ──
    // Se pide `anios + 2` de historia con el MISMO filtro que rotation-analyze
    // para que el set de símbolos sea idéntico — es la razón de tocar la DB en
    // un backtest que no usa un solo EPS.
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
        error: 'pead_earnings vacío en la ventana pedida — corre primero la cosecha (Fase 1 del PEAD). '
          + 'El universo de este backtest se hereda de ahí para ser comparable con /api/rotation-analyze.',
        solo_lectura: true, anios,
      });
    }

    const simbolosDb = filas.map((f) => f.symbol).sort();

    // ── 2. Precios: Yahoo en vivo (NO viven en Neon). ──
    const crudas = await bajaSeries([BENCHMARK, ...simbolosDb], range);
    const spyCrudo = crudas[BENCHMARK] ? recortaVelasIncompletas(crudas[BENCHMARK]) : null;
    if (!spyCrudo) {
      return res.status(502).json({
        error: `Sin serie de ${BENCHMARK}: no hay benchmark NI gate macro, así que no hay análisis.`,
      });
    }

    // El calendario canónico de sesiones es el de SPY (y por lo tanto también
    // el que define cuál es el "primer día hábil del mes" y el "cierre de fin
    // de mes" del gate Faber).
    const calendario = spyCrudo.fechas;
    const finesDeMes = ultimosHabilesDelMes(calendario);
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
      simbolos, calendario, seriesAlineadas, finesDeMes,
      spyOpens: spyAlineado.opens, spyCloses: spyAlineado.closes,
      desde, criterios: CRITERIOS,
    };

    // ── 3. ESPECIFICACIÓN PRINCIPAL (la única que decide el veredicto) ──
    const principal = corre({ ...base, etiqueta: 'principal' });

    // ── 4. Sensibilidades OBLIGATORIAS ──
    const sinGate = corre({ ...base, gate: GATE_OFF, etiqueta: 'sin_gate' });
    const sinAbsoluto = corre({ ...base, absoluto: false, etiqueta: 'sin_absoluto' });
    const faber = corre({ ...base, gate: GATE_FABER, etiqueta: 'faber_10m' });
    const bimestral = corre({ ...base, cadaMeses: CRITERIOS.meses_rebalanceo_sensibilidad, etiqueta: 'bimestral' });
    const sinFiltros = corre({ ...base, gate: GATE_OFF, absoluto: false, etiqueta: 'sin_filtros' });

    const sensibilidades = [
      { nombre: 'Sin gate macro (atribución: cuánto del §3 lo pone el gate)',
        lectura: 'Si el drawdown de acá es igual al de la principal, el gate no aportó nada en esta ventana.',
        resultado: sinGate },
      { nombre: 'Sin filtro de momentum absoluto (momentum relativo puro + gate)',
        lectura: 'Aísla el filtro (a). Si no cambia nada, el decil superior nunca tuvo un 12-1 negativo.',
        resultado: sinAbsoluto },
      { nombre: `SMA de ${CRITERIOS.gate_sma_meses} meses en vez de ${CRITERIOS.gate_sma_dias} días (variante Faber)`,
        lectura: 'Misma idea de tendencia, otra ventana. Si el veredicto se voltea acá, colgaba de la elección de SMA.',
        resultado: faber },
      { nombre: 'Rebalanceo cada 2 meses',
        lectura: 'Se anticipa INCONCLUSO ARITMÉTICO: la mitad de rebalanceos que el mensual. Léase por sus números.',
        resultado: bimestral },
      { nombre: 'SIN FILTROS: sin gate y sin absoluto (momentum relativo puro) — PUENTE con el rotation',
        lectura: 'Es la pierna comparable al corte "solo momentum" de /api/rotation-analyze. '
          + 'Ojo: el rotation exige además TTM válido para ser elegible; acá no.',
        resultado: sinFiltros },
    ];

    // El rebalanceo bimestral produce la MITAD de rebalanceos que el mensual:
    // con la ventana de la casa (~3 años) queda por debajo del piso de muestra
    // por construcción. Decirlo evita leer ese INCONCLUSO como "no hay señal".
    const notaBimestral = bimestral.muestra.rebalanceos_completos < CRITERIOS.min_rebalanceos
      ? `El rebalanceo bimestral deja ${bimestral.muestra.rebalanceos_completos} rebalanceos completos `
        + `(piso ${CRITERIOS.min_rebalanceos}): su INCONCLUSO es ARITMÉTICO — con una ventana de ${anios} años, `
        + 'rebalancear cada 2 meses no puede alcanzar el piso. Léase por sus números (Sharpe, drawdown, '
        + 'retorno anual contra los mismos de SPY), no por su veredicto.'
      : null;

    // ── Atribución del gate, calculada, no narrada ──
    const atribucion = (principal.economia && sinGate.economia)
      ? `con gate el max drawdown es ${pct(principal.economia.max_drawdown)} y sin gate `
        + `${pct(sinGate.economia.max_drawdown)} (SPY ${pct(principal.economia.max_drawdown_spy)}); `
        + `el retorno anual neto pasa de ${pct(principal.economia.ret_anual_neto)} (con gate) a `
        + `${pct(sinGate.economia.ret_anual_neto)} (sin gate). `
        + (principal.gate_activaciones === 0
          ? 'Con gate_activaciones = 0 las dos corridas son la MISMA cartera: cualquier diferencia acá '
            + 'sería un bug, no un hallazgo.'
          : `Esa diferencia ES el gate, y son ${principal.gate_activaciones} mes(es) de efectivo.`)
      : null;

    // ── 5. EXPLORATORIO — no cuenta para el veredicto, va etiquetado ──
    const exploratorio = [
      {
        etiqueta: 'EXPLORATORIO',
        nombre: 'gate evaluado con el CIERRE DEL PROPIO DÍA de rebalanceo (lectura literal, con look-ahead)',
        por_que: 'El encargo dice "si SPY cierra debajo de su SMA en la fecha de rebalanceo"; la '
          + 'principal usa el cierre de la sesión PREVIA porque el fill es a la apertura de esa fecha y el '
          + 'cierre de ese día todavía no existe. Este corte mide cuánto valía ese look-ahead. Si el '
          + 'veredicto cambiara acá, el resultado estaría colgado de un dato que no se conoce a tiempo.',
        resultado: corre({ ...base, gate: { ...GATE_PRINCIPAL, precio: 'cierre_del_dia' }, etiqueta: 'gate_cierre_del_dia' }),
      },
      {
        etiqueta: 'EXPLORATORIO',
        nombre: 'filtro absoluto ANTES del decil (la otra lectura del orden)',
        por_que: 'La principal saca el decil de TODA la población elegible y recorta después, así que '
          + '"top decil (~10)" sigue queriendo decir ~10. La otra lectura filtra primero y saca el decil '
          + 'del subconjunto positivo, lo que encoge la canasta justo cuando el mercado va mal. Se mide '
          + 'para que la decisión de orden quede a la vista en vez de escondida en el código.',
        resultado: corre({ ...base, orden: 'filtro_primero', etiqueta: 'filtro_primero' }),
      },
      {
        etiqueta: 'EXPLORATORIO',
        nombre: `quintil superior (~${Math.round(simbolos.length * CRITERIOS.fraccion_quintil)} nombres) en vez del decil`,
        por_que: 'Una canasta del doble de ancha diluye el momentum pero también la varianza. No es '
          + 'criterio: la especificación pre-registrada dice decil.',
        resultado: corre({ ...base, fraccion: CRITERIOS.fraccion_quintil, etiqueta: 'quintil' }),
      },
    ];

    const salida = {
      pregunta: '¿El Dual Momentum con gate de tendencia DEFIENDE de verdad — menos drawdown que SPY '
        + 'sin costar más de 1 punto de retorno al año?',
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      especificacion: {
        universo: `los ${simbolos.length} símbolos del universo de /api/rotation-analyze (historial de EPS `
          + 'en pead_earnings + precios en Yahoo). Esta estrategia NO usa EPS: el universo se hereda por '
          + 'COMPARABILIDAD, y la elegibilidad por rebalanceo solo exige momentum 12-1 calculable, cierre '
          + 'previo y apertura el día del fill',
        rebalanceo: 'primer día hábil del mes, fills a la APERTURA de ese día',
        seleccion: `rank por momentum 12-1 (de t−12m a t−1m) → top decil (~${Math.round(simbolos.length * CRITERIOS.fraccion_decil)} nombres), equal-weight`,
        filtro_absoluto: 'un nombre solo entra si su propio 12-1 > 0. Se aplica SOBRE el decil ya elegido '
          + '(el decil se calcula sobre toda la población elegible); los sobrevivientes se equiponderan '
          + 'entre ellos y si no sobrevive ninguno el mes es de efectivo',
        gate_macro: `si el cierre de SPY de la sesión PREVIA al rebalanceo está debajo de su SMA de `
          + `${CRITERIOS.gate_sma_dias} días (calculada hasta esa misma sesión), la cartera ENTERA se va a `
          + 'efectivo ese mes. Se usa el cierre previo y no el del propio día porque el fill es a la '
          + 'apertura: el cierre de ese día todavía no existe (ver corte EXPLORATORIO)',
        efectivo: 'rinde 0 (conservador: no se le regala al backtest un T-bill que habría que elegir y modelar)',
        costo_por_lado_bp: CRITERIOS.costo_por_lado * 10000,
        benchmark: `${BENCHMARK}, mismos días, misma ventana. Los §2, §3 y §4 son RELATIVOS a él`,
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
      gate_activaciones: principal.gate_activaciones,
      gate_probado: principal.gate_activaciones != null && principal.gate_activaciones > 0,
      go_fragil: principal.fragil,
      go_fragil_motivo: principal.fragil_motivo,
      sensibilidades,
      atribucion,
      nota_bimestral: notaBimestral,
      exploratorio,
      caveat: CAVEAT_NO_INDEPENDIENTE,
    };

    if (!conCanastas) {
      // El detalle canasta a canasta engorda la respuesta (36 × ~10 nombres ×
      // 9 corridas) y el veredicto no lo necesita.
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
    return res.status(500).json({ error: 'dualmom-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
