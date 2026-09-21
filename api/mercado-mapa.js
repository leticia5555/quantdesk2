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
/** El 1 de enero del año en curso: todo lo anterior es "año pasado". */
function inicioDeAnio(ahora) {
  return `${ahora.getUTCFullYear()}-01-01`;
}

// El edge sirve la misma foto mientras el cron no haya dejado una nueva. Los
// precios se cosechan una vez al día tras el cierre, así que 10 minutos de
// caché no envejecen nada y sacan al origen de la ruta del teléfono.
const CACHE = 'public, s-maxage=600, stale-while-revalidate=3600';

async function mapaUs(ahora) {
  const anio = inicioDeAnio(ahora);
  const errores = {};
  // NO se traga el error. Un `catch(() => [])` acá convertía una consulta que
  // falló en "300 cuadros sin serie": el mapa culpaba a los datos de un
  // problema de lectura, y el pie lo reportaba como si faltara la cosecha.
  const leer = async (nombre, q, params = []) => {
    try { return await sql(q, params); } catch (e) { errores[nombre] = String((e && e.message) || e); return []; }
  };

  const [universo, precios] = await Promise.all([
    leer('mercado_universo_us',
      `select symbol, nombre, sector_etf, market_cap, cap_fuente, cap_actualizado
         from mercado_universo_us
        where sector_etf is not null and market_cap is not null`),
    // UNA consulta, y acotada a lo que el navegador necesita: los últimos N
    // cierres de cada símbolo más su ancla YTD. Traer la ventana entera desde
    // diciembre eran ~60,000 filas por petición — el orden de magnitud en el
    // que una lectura deja de ser barata y empieza a fallar.
    leer('mercado_precios_us',
      `with top as (
         select symbol from mercado_universo_us
          where sector_etf is not null and market_cap is not null
          order by market_cap desc limit $1
       ), r as (
         select p.symbol, p.fecha, p.cierre, p.cierre_ajustado,
                row_number() over (partition by p.symbol order by p.fecha desc) recientes,
                row_number() over (partition by p.symbol order by p.fecha desc)
                  filter (where p.fecha < $2::date) ancla
           from mercado_precios_us p join top using (symbol)
       )
       select symbol, fecha::text as fecha, cierre, cierre_ajustado
         from r
        where recientes <= $3 or ancla = 1
        order by symbol, fecha`,
      [TOP_MAPA, anio, CIERRES_RECIENTES + 1]),
  ]);

  // Fail closed y EN VOZ ALTA: un mapa que no pudo leer sus datos no es un
  // mapa vacío, es un mapa roto, y decir lo primero manda a buscar el
  // problema al lugar equivocado.
  if (Object.keys(errores).length) {
    return { mapa: 'us', cuadros: [], mas: null, error: 'no se pudieron leer los datos del mapa', detalle: errores };
  }
  if (!universo.length) {
    return {
      mapa: 'us', cuadros: [], mas: null,
      error: 'mercado_universo_us está vacía: corré /api/mercado-r0?job=universo',
    };
  }
  if (!precios.length) {
    return {
      mapa: 'us', cuadros: [], mas: null,
      error: 'mercado_precios_us no tiene series para los nombres del mapa: corré /api/mercado-precios?job=us hasta que `completo` sea true',
    };
  }

  const recorte = recorteMapa(universo, TOP_MAPA);
  const { cuadros, faltantes } = armaMapaUs({ universo, precios, recorte, ahora });

  // EL ÚLTIMO CIERRE QUE HAY, que no es el que el calendario dice que
  // debería haber. El chip y el pie se rotulan con ESTE: un lunes a las
  // 17:00, con la cosecha del día aún sin correr, lo que se está mirando es
  // el cierre del viernes y hay que decirlo así.
  let ultimoCierre = null;
  for (const c of cuadros) if (c.fecha_precio && (!ultimoCierre || c.fecha_precio > ultimoCierre)) ultimoCierre = c.fecha_precio;

  return {
    mapa: 'us',
    bolsa: 'us',
    ultimo_cierre: ultimoCierre,
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
  const desde = `${ahora.getUTCFullYear() - 1}-12-01`;
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
  let ultimoCierre = null;
  for (const c of cuadros) if (c.fecha_precio && (!ultimoCierre || c.fecha_precio > ultimoCierre)) ultimoCierre = c.fecha_precio;

  return {
    mapa: 'mx',
    bolsa: 'mx',
    ultimo_cierre: ultimoCierre,
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
