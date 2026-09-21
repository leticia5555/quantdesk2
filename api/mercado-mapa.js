// ═══════════════════════════════════════════════════════════════════
// /api/mercado-mapa — R1(b): UN endpoint por mapa, y el endpoint LEE.
//
//   GET ?map=us   → top 300 por capitalización + "+N más = X%"
//   GET ?map=mx   → las 30 emisoras con su estado de verificación
//
// Público y cacheado en el edge. NO pide nada a ninguna API: lee Neon, que
// es donde los crons dejaron los precios. La Fase 0 midió la diferencia —
// ~6.2 s on-request contra ~120 ms leyendo— y la regla 7 del encargo prohíbe
// un fetch por cuadro. Acá eso además es aritmética: 300 cuadros × 6 s no
// cabe en ninguna página.
//
// CERO llamadas a IA, por contrato.
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import REFERENCIAS_CAP from './_lib/mercado-cap-referencia.json' with { type: 'json' };
import { CRITERIOS } from './_lib/mercado-fase0.js';
import {
  evaluaG2, SQL_G2, VENTANA_DIAS_G2, rangoDeCapturas, recorteMapa,
} from './_lib/mercado-r0.js';
import { frescuraPrecios } from './_lib/bmv-frescura.js';
import { armaMapaUs, armaMapaMx, resumenFaltantes, CIERRES_RECIENTES } from './_lib/mercado-mapa.js';
import { MIN_PUNTOS_SERIE } from './_lib/mercado-precios.js';

export const maxDuration = 60;

// Cuántos cuadros pinta el treemap. El resto viaja como "+N más = X%".
const TOP_MAPA = 300;
// Cuánta historia hace falta: el ancla YTD es el último cierre del año
// pasado, así que la ventana arranca en el 1-dic anterior con margen.
function desdeParaYtd(ahora) {
  return `${ahora.getUTCFullYear() - 1}-12-01`;
}

// El edge sirve la misma foto mientras el cron no haya dejado una nueva. Los
// precios se cosechan una vez al día tras el cierre, así que 10 minutos de
// caché no envejecen nada y sacan al origen de la ruta del teléfono.
const CACHE = 'public, s-maxage=600, stale-while-revalidate=3600';

async function mapaUs(ahora) {
  const desde = desdeParaYtd(ahora);
  const [universo, precios] = await Promise.all([
    sql(`select symbol, nombre, sector_etf, market_cap, cap_fuente, cap_actualizado
           from mercado_universo_us
          where sector_etf is not null and market_cap is not null`).catch(() => []),
    // UNA consulta para todas las series, acotada a los nombres que se van a
    // pintar y a la ventana que YTD necesita.
    sql(`select p.symbol, p.fecha::text as fecha, p.cierre, p.cierre_ajustado
           from mercado_precios_us p
           join (select symbol from mercado_universo_us
                  where sector_etf is not null and market_cap is not null
                  order by market_cap desc limit $1) top using (symbol)
          where p.fecha >= $2::date
          order by p.symbol, p.fecha`, [TOP_MAPA, desde]).catch(() => []),
  ]);

  if (!universo.length) {
    return {
      mapa: 'us', cuadros: [], mas: null,
      error: 'mercado_universo_us está vacía: corré /api/mercado-r0?job=universo',
    };
  }

  const recorte = recorteMapa(universo, TOP_MAPA);
  const { cuadros, faltantes } = armaMapaUs({ universo, precios, recorte, ahora });

  return {
    mapa: 'us',
    bolsa: 'us',
    cuadros,
    // El "+N más = X%" NO es decoración: sin él, un mapa de 300 se lee como
    // si fuera el mercado entero. El % se mide sobre los que quedaron fuera.
    mas: recorte.resto,
    fuente: {
      cuadros: 'neon:mercado_universo_us (sector y cap)',
      series: 'neon:mercado_precios_us (cierre y cierre ajustado, cosecha diaria)',
      cap_por_fuente: universo.reduce((a, u) => { const k = u.cap_fuente || 'sin fuente'; a[k] = (a[k] || 0) + 1; return a; }, {}),
    },
    faltantes: resumenFaltantes(faltantes),
  };
}

async function mapaMx(ahora) {
  const desde = desdeParaYtd(ahora);
  const rango = rangoDeCapturas(REFERENCIAS_CAP);
  const [acciones, ultimos, volumenes, corteFilas, periodos, cierresCaptura, series] = await Promise.all([
    sql(SQL_G2.acciones).catch(() => []),
    sql(SQL_G2.precios).catch(() => []),
    sql(SQL_G2.ventana, [VENTANA_DIAS_G2]).catch(() => []),
    sql(SQL_G2.corte).catch(() => [{}]),
    sql(SQL_G2.periodos).catch(() => []),
    rango ? sql(SQL_G2.cierres_captura, [rango.desde, rango.hasta]).catch(() => []) : Promise.resolve([]),
    sql(`select emisora_serie, fecha::text as fecha, cierre
           from bmv_precios where fecha >= $1::date
          order by emisora_serie, fecha`, [desde]).catch(() => []),
  ]);

  const corte = corteFilas[0] || {};
  const hasta = corte && corte.hasta ? String(corte.hasta).slice(0, 10) : null;
  const frescura = frescuraPrecios({ ultima_fecha: hasta, ahora });

  // EL MISMO evaluador que `?job=unidades` y que el censo. El mapa no puede
  // tener su propia opinión sobre qué está verificado.
  // EL MISMO evaluador CON LAS MISMAS ENTRADAS. `periodos` y
  // `cierres_captura` no son opcionales en la práctica aunque lo sean en la
  // firma: sin ellos la referencia se compara contra el cálculo de HOY y no
  // contra el de su fecha de captura, y el mapa empieza a discrepar del
  // censo. Medido con el precio movido 8% desde la captura: `?job=unidades`
  // decía `verificada` con 0% de error y el mapa `gris_punteado` con 8%.
  const g2 = evaluaG2({
    emisoras: EMISORAS.emisoras,
    acciones, precios: ultimos, volumenes, periodos, cierres_captura: cierresCaptura,
    referencias: REFERENCIAS_CAP, frescura, ahora,
    criterios: CRITERIOS, ventana_dias: VENTANA_DIAS_G2,
  });

  const { cuadros, faltantes } = armaMapaMx({ detalleG2: g2.detalle, precios: series, ahora });

  return {
    mapa: 'mx',
    bolsa: 'mx',
    cuadros,
    mas: null,   // México son 30 emisoras: se pintan todas, no hay recorte.
    fuente: {
      cuadros: 'emisoras.json + xbrl_reports (acciones) + bmv_precios (precio)',
      series: 'neon:bmv_precios (cierre diario por serie)',
      verificacion: 'evaluaG2 — el mismo que /api/mercado-r0?job=unidades y el censo',
      referencias: `${REFERENCIAS_CAP.referencias.length} manuales, caducan por trimestre XBRL`,
    },
    cosecha: {
      ultima_fecha: hasta,
      sesiones_de_atraso: frescura.dias_habiles_atraso,
      alerta: frescura.alerta,
      lectura: frescura.motivo,
    },
    verificacion: {
      verificadas: g2.verificadas,
      piso: g2.piso,
      verde: g2.verde,
      vigencia_referencias: g2.vigencia_referencias ? {
        vigentes: g2.vigencia_referencias.vigentes,
        en_gracia: g2.vigencia_referencias.en_gracia,
        vencidas: g2.vigencia_referencias.vencidas,
        a_recapturar: g2.vigencia_referencias.a_recapturar,
      } : null,
    },
    faltantes: resumenFaltantes(faltantes),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const t0 = Date.now();
  const ahora = new Date();
  const map = String((req.query && req.query.map) || 'us').toLowerCase();

  try {
    if (map !== 'us' && map !== 'mx') {
      return res.status(400).json({ error: `mapa desconocido: ${map}`, acepta: ['us', 'mx'] });
    }
    const out = map === 'us' ? await mapaUs(ahora) : await mapaMx(ahora);
    out.generado_en = ahora.toISOString();
    out.periodos = ['1D', '1S', '1M', 'YTD'];
    out.cierres_por_cuadro = CIERRES_RECIENTES;
    out.min_puntos_serie = MIN_PUNTOS_SERIE;
    out.ms = Date.now() - t0;
    res.setHeader('Cache-Control', CACHE);
    return res.status(200).json(out);
  } catch (e) {
    // Un error no se cachea: el próximo pedido tiene que volver a intentar.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'mercado-mapa: ' + String((e && e.message) || e), ms: Date.now() - t0 });
  }
}
