// ═══════════════════════════════════════════════════════════════════
// /api/earnings-beat-analyze — FASE 2 del earnings-beat, SOLO LECTURA.
//
// Una sola pregunta: ¿el modelo de QuantDesk predice beat/miss mejor que el
// precio de Polymarket a T-24h? Los umbrales están CONGELADOS en
// _lib/earnings-beat-analyze.js (CRITERIOS_F2) — se fijaron antes de correr y
// no se mueven, incluidos el umbral de liquidez y el tratamiento de la
// sorpresa que explota por escala.
//
//   GET /api/earnings-beat-analyze                → JSON completo
//   GET /api/earnings-beat-analyze?format=md      → resumen en español
//   GET /api/earnings-beat-analyze?apuestas=1     → detalle apuesta por apuesta
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes a Neon: tres SELECT (pm_earnings_markets, pead_earnings,
// mercado_universo_us). NO llama a ensureSchema() ni a beat() — latir acá
// enmascararía un cron muerto. Mismo contrato que /api/pead-analyze.
//
// ── Gate ───────────────────────────────────────────────────────────
// CRON_SECRET por header o por ?secret= (para abrir el markdown en el
// navegador). Respuesta no-store.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import {
  CRITERIOS_F2, featuresDeEvento, analiza, renderResumenF2,
} from './_lib/earnings-beat-analyze.js';

// Tres SELECT grandes + el ajuste del modelo. El default de 60s alcanza, pero
// el patrón de la casa para análisis es 300 y acá el dataset puede crecer.
export const maxDuration = 300;

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

  try {
    // ── 1. Los mercados etiquetados. El WHERE es el candado de calidad. ──
    // outcome resuelto + precio VÁLIDO a T-24h (no rancio: un precio rancio
    // existe pero no dice lo que creemos) + cruce con pead_earnings.
    const mercados = await sql(
      `select market_id, symbol,
              to_char(report_date, 'YYYY-MM-DD') as report_date,
              to_char(resolved_date, 'YYYY-MM-DD') as resolved_date,
              outcome, yes_price_t24h, yes_price_estado, volume, consensus_pm
         from pm_earnings_markets
        where outcome is not null
          and report_date is not null
          and yes_price_estado = 'valido'
          and yes_price_t24h is not null
        order by report_date asc, symbol asc`
    );

    if (!mercados.length) {
      return res.status(200).json({
        error: 'pm_earnings_markets no tiene mercados resueltos con precio válido a T-24h — corré primero la cosecha (Fase 1).',
        solo_lectura: true, criterios: CRITERIOS_F2,
      });
    }

    // ── 2. Filtro de LIQUIDEZ, con el umbral congelado ──
    // Se aplica acá y se reporta cuántos sobreviven. Si quedan menos que
    // `min_mercados`, el veredicto sale INCONCLUSO — NO se baja el umbral.
    const antes = mercados.length;
    const liquidos = mercados.filter((m) => Number(m.volume) >= CRITERIOS_F2.min_volumen_usd);
    const liquidez = {
      umbral_usd: CRITERIOS_F2.min_volumen_usd,
      piso_de_ruido_declarado_usd: CRITERIOS_F2.piso_de_ruido_declarado_usd,
      antes, sobreviven: liquidos.length, descartados: antes - liquidos.length,
      sin_volumen: mercados.filter((m) => m.volume === null || m.volume === undefined).length,
    };

    // ── 3. Historial de EPS para los features (SELECT, nada más) ──
    const simbolos = [...new Set(liquidos.map((m) => m.symbol))];
    const hist = simbolos.length ? await sql(
      `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date,
              reported_eps, estimated_eps, surprise_pct
         from pead_earnings
        where symbol in (${simbolos.map((_, i) => `$${i + 1}`).join(', ')})
        order by reported_date asc`,
      simbolos
    ) : [];
    const porSimbolo = new Map();
    for (const h of hist) {
      if (!porSimbolo.has(h.symbol)) porSimbolo.set(h.symbol, []);
      porSimbolo.get(h.symbol).push(h);
    }

    // ── 4. Sector Finnhub para los pares ──
    // `mercado_universo_us.industria` ES la clasificación de Finnhub
    // (`finnhubIndustry` de profile2). Si un símbolo no está en esa tabla su
    // feature de pares queda null y se cuenta: null es un dato, no un cero.
    let sectores = new Map();
    let sectorError = null;
    try {
      const filas = simbolos.length ? await sql(
        `select symbol, industria from mercado_universo_us
          where symbol in (${simbolos.map((_, i) => `$${i + 1}`).join(', ')})`,
        simbolos
      ) : [];
      for (const f of filas) if (f.industria) sectores.set(f.symbol, f.industria);
    } catch (e) {
      sectorError = String((e && e.message) || e).slice(0, 200);
    }

    // Beats de TODA la historia, por sector, para el feature de pares. Se
    // arma una vez: el filtro temporal (mismo mes, estrictamente antes) lo
    // aplica featuresDeEvento por evento.
    const porSector = new Map();
    for (const [sym, industria] of sectores) {
      for (const h of porSimbolo.get(sym) || []) {
        const rep = Number(h.reported_eps), est = Number(h.estimated_eps);
        if (!Number.isFinite(rep) || !Number.isFinite(est)) continue;
        if (!porSector.has(industria)) porSector.set(industria, []);
        porSector.get(industria).push({ symbol: sym, reported_date: h.reported_date, beat: rep > est });
      }
    }

    // ── 5. Features por evento. Solo datos ANTERIORES a report_date. ──
    const eventos = liquidos.map((m) => {
      const industria = sectores.get(m.symbol) || null;
      // Los pares EXCLUYEN a la propia empresa: si no, el feature se estaría
      // mirando a sí mismo.
      const pares = (porSector.get(industria) || []).filter((p) => p.symbol !== m.symbol);
      return {
        market_id: m.market_id, symbol: m.symbol, report_date: m.report_date,
        industria,
        beat: String(m.outcome).toLowerCase() === 'yes',
        mercado: Number(m.yes_price_t24h),
        volumen: Number(m.volume),
        features: featuresDeEvento({
          report_date: m.report_date,
          historial: porSimbolo.get(m.symbol) || [],
          paresDelSector: pares,
        }),
      };
    });

    const resultado = analiza(eventos);
    const salida = {
      pregunta: '¿El modelo de QuantDesk predice beat/miss mejor que el precio de Polymarket a T-24h?',
      fase: 2, solo_lectura: true,
      generado_en: new Date().toISOString(),
      liquidez,
      sectores: { con_sector: sectores.size, de: simbolos.length, error: sectorError },
      ...resultado,
    };
    if (String(q.apuestas || '') !== '1' && salida.simulacion) {
      // El detalle apuesta por apuesta engorda la respuesta y el veredicto no
      // lo necesita. ?apuestas=1 para verlo.
      delete salida.simulacion.detalle;
    }

    if (String(q.format || '').toLowerCase() === 'md' || String(q.format || '').toLowerCase() === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenF2(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'earnings-beat-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
