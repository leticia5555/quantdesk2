// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-tools-historia.js — la SEXTA herramienta: historia(ticker).
//
// Devuelve la narración de HISTORIA que YA EXISTE para el emisor —la que
// escribió /api/historia-narrar y vive en `company_narracion`— acotada a ~2
// párrafos, con su hash y su fecha. **No narra**: cero llamadas a modelos.
// Narrar bajo demanda dentro del loop de un agente sería pagar Opus por cada
// consulta y comerse el reloj de la corrida.
//
// ── LA FECHA Y EL HASH VIAJAN CON EL TEXTO ───────────────────────────
// /api/historia sirve la narración SOLO si su hash coincide con la evidencia
// de hoy, porque servir una vieja como actual sería un dato viejo con citas
// correctas. Acá se toma la ÚLTIMA servible sin recalcular la evidencia (eso
// cuesta leer cientos de filings por llamada), así que la regla se cumple de
// otra forma: el agente recibe la fecha y el hash pegados al texto, y la
// cabecera le dice que es una lectura de esa fecha, no de hoy.
//
// ── "sin_cobertura" ES UNA RESPUESTA, NO UN HUECO ────────────────────
// Si HISTORIA no cubre el ticker —no está en `company_emisor`, o está y
// todavía no tiene narración servible— la herramienta lo dice con esa
// palabra. Un resultado vacío se leería como "no hay nada que contar".
// Una base caída es OTRA cosa: `error: true`, no se cachea, la publica
// `avisos`.
//
// Cacheada por día con la caché del ejecutor, como las demás.
// ═══════════════════════════════════════════════════════════════

import { sql as sqlReal } from './db.js';

// Qué secciones, en qué orden. Para un PM que decide hoy, lo primero es si la
// empresa cumple lo que promete y qué podría moverla; dirección y propiedad
// después. Se toman las DOS primeras que tengan texto.
export const ORDEN_SECCIONES = ['prometido_vs_entregado', 'catalizador', 'donde_se_rompe', 'direccion', 'propiedad'];
export const TITULO_SECCION = {
  prometido_vs_entregado: 'Lo prometido vs. lo entregado',
  catalizador: 'Catalizador',
  donde_se_rompe: 'Dónde se rompe',
  direccion: 'Dirección',
  propiedad: 'Propiedad',
};
export const PARRAFOS = 2;
export const CARACTERES_POR_PARRAFO = 700;

// Corta en el último fin de oración antes del techo; si no hay, en el techo.
// El recorte se MARCA: un párrafo cortado que se lee entero es la misma
// mentira que una lista truncada sin aviso.
export function acotarParrafo(texto, cap = CARACTERES_POR_PARRAFO) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim();
  if (s.length <= cap) return s;
  const corte = s.slice(0, cap);
  const fin = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('.] '), corte.lastIndexOf('; '));
  return (fin > cap * 0.5 ? corte.slice(0, fin + 1) : corte).trim() + ' […recortado]';
}

export function resumenDeSecciones(secciones, { parrafos = PARRAFOS } = {}) {
  const porId = new Map((Array.isArray(secciones) ? secciones : []).filter((x) => x && x.id && x.texto).map((x) => [x.id, x.texto]));
  const elegidas = ORDEN_SECCIONES.filter((id) => porId.has(id)).slice(0, parrafos);
  return elegidas.map((id) => `${TITULO_SECCION[id] || id}: ${acotarParrafo(porId.get(id))}`);
}

export const CONSULTA_HISTORIA = `select e.cik, e.ticker, e.nombre, e.estado as estado_ingesta,
       n.hash, n.secciones, n.creado_en, n.modelo, n.prompt_version
  from company_emisor e
  left join lateral (
    select hash, secciones, creado_en, modelo, prompt_version
      from company_narracion
     where cik = e.cik and estado = 'ok'
     order by creado_en desc limit 1
  ) n on true
 where upper(e.ticker) = $1
 limit 1`;

export async function runHistoria(args, ctx) {
  const tk = String(args.ticker || '').trim().toUpperCase();
  if (!tk) return { text: 'historia necesita un ticker.', rows: 0, error: true };
  const deps = (ctx && ctx.deps) || {};
  const sql = deps.historiaSql || sqlReal;

  let fila;
  try {
    const filas = await sql(CONSULTA_HISTORIA, [tk]);
    fila = (filas && filas[0]) || null;
  } catch (e) {
    return {
      text: `historia: sin datos hoy — la base de HISTORIA no respondió (${String((e && e.message) || e).slice(0, 160)}). NO significa que no haya historia de ${tk}: no se pudo consultar.`,
      rows: null, error: true,
    };
  }

  if (!fila) {
    return {
      text: `historia: sin_cobertura — HISTORIA no cubre ${tk} (no está entre los emisores ingeridos). No es que no haya historia: es que no la leímos.`,
      rows: 0, sin_cobertura: 'no_ingerido',
    };
  }
  const parrafos = fila.hash ? resumenDeSecciones(fila.secciones) : [];
  if (!parrafos.length) {
    return {
      text: `historia: sin_cobertura — ${tk} está ingerido (estado ${fila.estado_ingesta || 'desconocido'}) pero todavía no tiene una narración servible.`,
      rows: 0, sin_cobertura: 'sin_narracion',
    };
  }
  const fecha = String(fila.creado_en instanceof Date ? fila.creado_en.toISOString() : (fila.creado_en || '')).slice(0, 10) || 'fecha desconocida';
  const header = `HISTORIA de ${tk}${fila.nombre ? ` (${fila.nombre})` : ''} — narración del ${fecha}, hash ${String(fila.hash).slice(0, 12)}. `
    + `Es la lectura de los filings de la SEC hasta esa fecha, no de hoy; acotada a ${parrafos.length} párrafo(s). Las citas [accession] son filings.`;
  return { text: [header, ...parrafos].join('\n'), rows: parrafos.length, hash: fila.hash, fecha };
}
