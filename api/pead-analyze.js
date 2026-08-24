// ═══════════════════════════════════════════════════════════════════
// /api/pead-analyze — FASE 2 del PEAD, SOLO LECTURA.
//
// Una sola pregunta: ¿existe drift post-earnings OPERABLE con nuestra
// infraestructura (entrada en la primera apertura posterior al reporte, sin
// look-ahead)? Los umbrales están CONGELADOS en _lib/pead-analyze.js
// (CRITERIOS) — se fijaron antes de correr y no se mueven.
//
//   GET /api/pead-analyze                 → JSON completo
//   GET /api/pead-analyze?format=md       → resumen en español
//   GET /api/pead-analyze?anios=3         → ventana de análisis (default 3)
//   GET /api/pead-analyze?trades=1        → incluye el detalle trade a trade
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes a Neon: puros SELECT sobre pead_earnings + pead_event_hour.
// NO llama a ensurePeadSchema() (hace CREATE TABLE) ni a beat() — latir acá
// enmascararía un cron muerto. Los precios NO viven en Neon: se bajan de
// Yahoo en vivo (candles diarias ajustadas) y NO se cachean en la DB.
// tests/pead-analyze.test.mjs captura toda query que pase por la frontera y
// falla si alguna no empieza con SELECT.
//
// ── Gate ───────────────────────────────────────────────────────────
// Mismo patrón que arena-audit/arena-run: si CRON_SECRET está puesta, sin el
// secret correcto → 401. Se acepta por header (`Authorization: Bearer ...`) o
// por query (`?secret=...`), porque el caso de uso es abrir el markdown
// directo en el navegador. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional, mismo patrón de la casa)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import {
  CRITERIOS, corre, corteSubmuestra, recortaVelasIncompletas, alineaAlCalendario,
  renderResumenMarkdown,
} from './_lib/pead-analyze.js';
import { extraeSerieAjustada, bajaSerie, bajaSeries } from './_lib/yahoo-daily.js';

// ~100 símbolos de Yahoo + el análisis completo (3 políticas de hora × 3
// holds + splits + exploratorios). El default de 60s de Vercel no alcanza;
// misma medicina que arena-run/pead-harvest/arena-audit.
export const maxDuration = 300;

const BENCHMARK = 'SPY';
const TIENE_HORA = (e) => ['bmo', 'amc', 'dmh'].includes((e.hour || '').toLowerCase());

// Velas diarias AJUSTADAS: _lib/yahoo-daily.js (extraído de acá cuando
// /api/rotation-analyze necesitó exactamente el mismo fetch — una sola
// implementación del ajuste por dividendos, no dos que se desincronizan).

// ─────────────────── handler ───────────────────

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
  const conTrades = String(q.trades || '') === '1';
  const range = anios <= 4 ? '5y' : '10y';   // holgura para el hold + el cierre previo

  try {
    // ── 1. Eventos desde Neon. UN SOLO SELECT, sin escribir nada. ──
    // El filtro temporal va acá (la tabla guarda ~30 años a propósito: el
    // recorte es del análisis, no de la ingesta — docs/pead-backtest-scope.md).
    const eventos = await sql(
      `select e.symbol, to_char(e.reported_date, 'YYYY-MM-DD') as reported_date,
              e.reported_eps, e.estimated_eps, e.surprise, e.surprise_pct,
              h.hour, h.source as hour_source
         from pead_earnings e
         left join pead_event_hour h
           on h.symbol = e.symbol and h.reported_date = e.reported_date
        where e.reported_date >= (current_date - ($1 || ' years')::interval)
          and e.reported_date <= current_date
        order by e.reported_date asc, e.symbol asc`,
      [String(anios + 1)]   // +1 año de colchón: la ventana final se recorta en JS
    );

    if (!eventos.length) {
      return res.status(200).json({
        error: 'pead_earnings vacío en la ventana pedida — corre primero la cosecha (Fase 1).',
        solo_lectura: true, anios,
      });
    }

    const simbolos = [...new Set(eventos.map((e) => e.symbol))];

    // ── 2. Precios: Yahoo en vivo (NO viven en Neon). ──
    const crudas = await bajaSeries([BENCHMARK, ...simbolos], range);
    const spy = crudas[BENCHMARK] ? recortaVelasIncompletas(crudas[BENCHMARK]) : null;
    if (!spy) {
      return res.status(502).json({ error: `Sin serie de ${BENCHMARK}: no hay benchmark, no hay análisis.` });
    }

    // El calendario canónico de sesiones es el de SPY. Cada símbolo se alinea
    // contra él; los huecos quedan null y se arrastra el último cierre.
    const calendario = spy.fechas;
    const seriesAlineadas = {};
    const sinPrecios = [];
    for (const s of simbolos) {
      if (!crudas[s]) { sinPrecios.push(s); continue; }
      seriesAlineadas[s] = alineaAlCalendario(recortaVelasIncompletas(crudas[s]), calendario);
    }
    const spyCloses = alineaAlCalendario(spy, calendario).closes;

    // Ventana de análisis: los últimos `anios` años del calendario real.
    const hasta = calendario[calendario.length - 1];
    const desdeD = new Date(hasta + 'T00:00:00Z');
    desdeD.setUTCFullYear(desdeD.getUTCFullYear() - anios);
    const desde = desdeD.toISOString().slice(0, 10);

    const enVentana = eventos.filter((e) => e.reported_date >= desde);
    const base = { eventos, calendario, seriesAlineadas, spyCloses, criterios: CRITERIOS, desde };

    // ── 3. ESPECIFICACIÓN PRINCIPAL (la única que decide el veredicto) ──
    // Hora sin etiquetar → AMC: nunca mete look-ahead (a lo sumo entra un día
    // tarde). Ver el comentario de horaEfectiva() en _lib/pead-analyze.js.
    const principal = corre({ ...base, politicaHora: 'amc', N: CRITERIOS.hold_principal });

    // ── 4. Sensibilidades OBLIGATORIAS (§4 del encargo) ──
    const sinHoraTodoBmo = corre({ ...base, politicaHora: 'bmo', N: CRITERIOS.hold_principal });
    const sinHoraDescartada = corre({ ...base, politicaHora: 'drop', N: CRITERIOS.hold_principal });
    const splitBmo = corteSubmuestra({ ...base, politicaHora: 'amc', N: CRITERIOS.hold_principal,
      filtro: (e) => (e.hour || '').toLowerCase() === 'bmo' });
    const splitAmc = corteSubmuestra({ ...base, politicaHora: 'amc', N: CRITERIOS.hold_principal,
      filtro: (e) => ['amc', 'dmh'].includes((e.hour || '').toLowerCase()) });
    const holds = CRITERIOS.holds_sensibilidad.map((N) => corre({ ...base, politicaHora: 'amc', N }));

    const veredictoCambia = principal.veredicto !== sinHoraTodoBmo.veredicto;

    // ── 5. EXPLORATORIO — no cuenta para el veredicto, va etiquetado ──
    // Único corte extra: rankear la sorpresa escalada por PRECIO en vez de por
    // el estimado. `surprise_pct` explota (miles de %) cuando estimated_eps
    // ronda cero, así que el "decil superior" puede estar poblado por ruido de
    // denominador y no por sorpresas económicamente grandes.
    const exploratorio = [{
      etiqueta: 'EXPLORATORIO',
      nombre: 'decil por sorpresa escalada por precio (surprise/close_previo) en vez de surprise_pct',
      por_que: 'surprise_pct explota cuando estimated_eps ≈ 0; este ranking no depende del denominador.',
      resultado: corre({ ...base, politicaHora: 'amc', N: CRITERIOS.hold_principal, campoSenal: 'surprise_sobre_precio' }),
    }];

    const salida = {
      pregunta: '¿Existe drift post-earnings operable con nuestra infraestructura?',
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      especificacion: {
        entrada: 'primera apertura posterior al reporte — BMO: open del mismo día; AMC/DMH: open del día siguiente',
        sin_hora_en_principal: 'AMC (conservador: nunca mete look-ahead)',
        senal: `decil superior (p${Math.round(CRITERIOS.decil * 100)}) de sorpresa positiva, corte sobre la muestra operable`,
        benchmark: `${BENCHMARK}, vía cartera calendar-time (no promedio por evento)`,
        tenencia_dias: CRITERIOS.hold_principal,
        max_concurrentes: CRITERIOS.max_concurrentes,
        costo_por_lado_bp: CRITERIOS.costo_por_lado * 10000,
        ventana_anios: anios,
      },
      criterios: CRITERIOS,
      datos: {
        eventos_en_tabla: eventos.length,
        simbolos: simbolos.length,
        sin_precios: sinPrecios,
        calendario: { sesiones: calendario.length, desde: calendario[0], hasta },
        ventana_analisis: { desde, hasta },
        // Contados DENTRO de la ventana de análisis (no sobre el colchón):
        // el "~96% etiquetado" tiene que referirse a los eventos que se operan.
        con_hora_etiquetada: enVentana.filter((e) => TIENE_HORA(e)).length,
        sin_hora: enVentana.filter((e) => !TIENE_HORA(e)).length,
        pct_con_hora: enVentana.length ? enVentana.filter((e) => TIENE_HORA(e)).length / enVentana.length : null,
      },
      principal,
      veredicto: principal.veredicto,
      sensibilidades: {
        sin_hora_todo_amc: { nota: 'coincide con la principal por construcción', veredicto: principal.veredicto },
        sin_hora_todo_bmo: sinHoraTodoBmo,
        sin_hora_descartada: sinHoraDescartada,
        veredicto_cambia_entre_bmo_y_amc: veredictoCambia,
        split_bmo: splitBmo,
        split_amc: splitAmc,
        holds: holds,
      },
      exploratorio,
    };

    if (!conTrades) {
      // El detalle trade a trade se omite salvo ?trades=1: con ~100 símbolos
      // engorda la respuesta y el veredicto no lo necesita.
      for (const b of [principal, sinHoraTodoBmo, sinHoraDescartada, splitBmo, splitAmc, ...holds,
        ...exploratorio.map((e) => e.resultado)]) {
        delete b.operabilidad.detalle_trades;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'pead-analyze: ' + ((err && err.message) || 'unknown') });
  }
}

export { extraeSerieAjustada, bajaSerie, bajaSeries };
