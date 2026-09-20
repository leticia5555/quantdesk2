// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-lectura.js — las 7 secciones, como DOCUMENTOS.
//
// Esta fase no narra. Cada sección devuelve los filings que le corresponden
// con su fecha, su enlace y su cita; la serie trimestral devuelve los números
// que salieron de un filing, con el `accession` del que salieron. Nada más.
// El lector con prompt congelado es la Fase B y acá no existe.
//
// ── LAS TRES MANERAS DE NO TENER ALGO, Y POR QUÉ SE DISTINGUEN ──────
// Un hueco sin etiqueta es indistinguible de un error, y el usuario que ve un
// vacío asume lo que le conviene. Por eso hay tres estados y significan cosas
// distintas:
//
//   · `sin_documentos`  — la sección SÍ se cubre, se buscó, y no hay nada.
//                         Es una afirmación falsable sobre la empresa.
//   · `no_cubierta`     — el módulo no cubre esa fuente (transcripts, alt
//                         data). Es una afirmación sobre NOSOTROS, no sobre
//                         la empresa, y decirla es obligación (§8).
//   · `fuera_del_modulo`— el dato existe en QuantDesk pero no sale de EDGAR
//                         (el próximo earnings, el short volume). Se dice de
//                         dónde sale en vez de fingir que no existe.
//
// Confundir el primero con el segundo sería lo más fácil y lo más dañino:
// "no hay 13D" y "no miramos 13D" llevan a decisiones opuestas.
//
// ── LA CITA ES EL PRODUCTO ──────────────────────────────────────────
// Decisión 8 de §10: el identificador se VE — `[0000320193-25-000073]`,
// enlazado al documento primario. No un "fuente: SEC" genérico. Que el
// usuario pueda abrir el papel y contar los mismos números es lo que separa
// esto de un resumen bonito.
//
// Un Q4 derivado lleva DOS citas porque salió de una resta entre dos filings
// (§5). Se muestran las dos; mostrar solo el 10-K sería citar la mitad.
//
// ── LO QUE ACÁ NO PASA ──────────────────────────────────────────────
// No se escribe nada. No se dispara ingesta. Un emisor que no está ingerido
// devuelve `sin_ingesta` y se dice — no se ingiere al vuelo, porque la
// corrida 2 midió 42 s por ticker (§11, G4) y eso no entra en un request.
// ═══════════════════════════════════════════════════════════════

import { sql as sqlReal } from './db.js';
import { NUCLEO } from './historia-db.js';
import { urlIndice } from './edgar.js';
import { glosarItem, glosarForma, agruparEpisodios, resumirDocumentos, esContienda } from './historia-glosario.js';

// ─────────────────────────────────────────────────────────────────────────
// El catálogo de declaraciones. Los textos de §8 viven acá UNA vez: el
// endpoint los resuelve y la página los reusa, en vez de que cada capa
// escriba su propia versión de "no cubrimos transcripts".
// ─────────────────────────────────────────────────────────────────────────
export const DECLARACIONES = {
  transcripts: {
    es: 'Pregunta 4 — no cubierta. Lo que la gerencia dice en las llamadas viene de transcripciones con licencia comercial. QuantDesk no las incluye.',
    en: 'Question 4 — not covered. What management says on earnings calls comes from commercially licensed transcripts. QuantDesk does not include them.',
  },
  competidores_privados: {
    es: 'Solo competidores que cotizan en EE.UU. Los privados no presentan filings y no aparecen acá.',
    en: 'Only US-listed competitors. Private companies file nothing with the SEC and do not appear here.',
  },
  pares_sin_mapa: {
    es: 'El mapa de pares todavía no existe: la lista curada es una decisión pendiente, no un resultado vacío.',
    en: 'The peer map does not exist yet: the curated list is a pending decision, not an empty result.',
  },
  alt_data: { es: 'Sin datos alternativos (tráfico, tarjetas, satélite).', en: 'No alternative data (traffic, card, satellite).' },
  expert_networks: { es: 'Sin expert networks.', en: 'No expert networks.' },
  cobertura_parcial: {
    es: 'Cobertura parcial: este emisor presenta 20-F. La serie es anual, no trimestral.',
    en: 'Partial coverage: this issuer files 20-F. The series is annual, not quarterly.',
  },
  guia_no_estructurada: {
    es: 'La guía no viene estructurada: se enlaza el 8-K donde la empresa la dio. No se guarda ningún número de guía.',
    en: 'Guidance is not tagged: the 8-K where the company gave it is linked. No guidance figure is stored.',
  },
  fts_desde_2001: { es: 'La búsqueda de texto completo cubre desde 2001.', en: 'Full-text search covers 2001 onwards.' },
  earnings_no_edgar: {
    es: 'La fecha del próximo reporte no está en EDGAR: EDGAR archiva lo que ya pasó. Sale del calendario de earnings.',
    en: 'The next earnings date is not in EDGAR: EDGAR archives what already happened. It comes from the earnings calendar.',
  },
  mercado_fuera_de_modulo: {
    es: 'Lo que el mercado ya cree (precio, opciones, short volume) no sale de EDGAR y vive en el panel SMART $.',
    en: 'What the market already believes (price, options, short volume) does not come from EDGAR and lives in the SMART $ panel.',
  },
  short_volume_no_es_short_interest: {
    es: 'Se usa short volume (Reg SHO, diario). No es short interest (FINRA, quincenal): no son lo mismo y no se mezclan.',
    en: 'Short volume (Reg SHO, daily) is used. It is not short interest (FINRA, biweekly): they are different and are not mixed.',
  },
  sin_contraevidencia: {
    es: 'No encontramos contraevidencia en los filings.',
    en: 'We found no counter-evidence in the filings.',
  },
};

export const declarar = (codigo, lang = 'es') => ({
  codigo,
  texto: (DECLARACIONES[codigo] || {})[lang] || (DECLARACIONES[codigo] || {}).es || codigo,
});

// ─────────────────────────────────────────────────────────────────────────
// Qué formas e items alimentan cada sección.
// ─────────────────────────────────────────────────────────────────────────
export const ITEMS_DIRECCION = ['5.02'];                 // altas y bajas de directivos
export const ITEMS_RESULTADOS = ['2.02', '7.01'];        // resultados y la guía en prosa
export const ITEMS_CATALIZADOR = ['1.01', '2.01', '8.01']; // acuerdos, adquisiciones, otros eventos
export const ITEMS_RUPTURA = ['4.02'];                   // "no confíen en los estados anteriores"
export const FORMAS_DIRECCION = ['DEF 14A'];
export const FORMAS_PROPIEDAD = ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A'];
export const FORMAS_PELEA = ['PREC14A', 'DEFC14A', 'PRRN14A', 'DFAN14A'];

const LIMITE_DOCS = 40;
// La pelea por el consejo se trae ENTERA, no paginada: un episodio calculado
// sobre 40 de 34… o sobre 40 de 200 empezaría y terminaría donde no es.
const LIMITE_CONTIENDA = 500;

// `[0000320193-25-000073]` — el identificador visible de la decisión 8.
export const cita = (accession) => (accession ? `[${accession}]` : null);

// ─────────────────────────────────────────────────────────────────────────
// Las consultas. `sql` entra por parámetro, como en toda la fase.
// ─────────────────────────────────────────────────────────────────────────

// Lista de valores como placeholders explícitos. `= any($n)` dependería de
// cómo el driver HTTP de Neon serializa un arreglo, y eso es una suposición
// que no hace falta hacer.
function enLista(valores, desde) {
  return valores.map((_, i) => `$${desde + i}`).join(', ');
}

export function crearLectura({ sql = sqlReal, lang = 'es' } = {}) {
  const doc = (r) => {
    const items = r.items_raw ? String(r.items_raw).split(',').map((s) => s.trim()).filter(Boolean) : [];
    return {
      accession: r.accession,
      form: r.form,
      // El código se queda Y se traduce. `oficial` es la cita textual de la
      // SEC; `glosa` es nuestra y va marcada como tal en el glosario.
      forma_glosa: glosarForma(r.form, lang),
      items,
      items_glosa: items.map((i) => glosarItem(i, lang)),
      contienda: esContienda(r.form),
      filed: r.filed,
      report_date: r.report_date ?? null,
      url: r.url,
      index_url: r.index_url,
      cita: cita(r.accession),
    };
  };

  // El total y el rango salen de TODOS los que matchearon, no de la página
  // que se alcanza a mostrar. Las funciones de ventana se evalúan antes del
  // LIMIT, así que esto no cuesta una consulta extra.
  const AGREGADOS = `count(*) over () as total_general,
                     min(filed) over () as primero,
                     max(filed) over () as ultimo`;
  const conAgregados = (filas) => ({
    documentos: filas.map(doc),
    total: filas.length ? Number(filas[0].total_general) : 0,
    desde: filas.length ? filas[0].primero : null,
    hasta: filas.length ? filas[0].ultimo : null,
  });

  return {
    async emisorPorTicker(ticker) {
      const filas = await sql(
        `select cik, ticker, nombre, forma_anual, cobertura, ultima_ingesta, estado
           from company_emisor where upper(ticker) = upper($1) limit 1`,
        [ticker],
      );
      return filas[0] || null;
    },

    async porItems(cik, items, limite = LIMITE_DOCS) {
      if (!items.length) return { documentos: [], total: 0, desde: null, hasta: null };
      const filas = await sql(
        `select distinct f.accession, f.form, f.items_raw, f.filed, f.report_date, f.url, f.index_url,
                ${AGREGADOS}
           from company_filings f
           join company_filing_items i on i.cik = f.cik and i.accession = f.accession
          where f.cik = $1 and i.item in (${enLista(items, 2)})
          order by f.filed desc
          limit ${Number(limite)}`,
        [cik, ...items],
      );
      return conAgregados(filas);
    },

    async porFormas(cik, formas, limite = LIMITE_DOCS) {
      if (!formas.length) return { documentos: [], total: 0, desde: null, hasta: null };
      const filas = await sql(
        `select accession, form, items_raw, filed, report_date, url, index_url,
                ${AGREGADOS}
           from company_filings
          where cik = $1 and form in (${enLista(formas, 2)})
          order by filed desc
          limit ${Number(limite)}`,
        [cik, ...formas],
      );
      return conAgregados(filas);
    },

    // La serie sale de la VISTA, no de la tabla: la vista ya eligió qué tag
    // manda en cada periodo, contó las revisiones dentro de ese tag y decidió
    // si el YoY es comparable (§5). Leer la tabla acá sería rehacer —y volver
    // a equivocar— las tres cosas.
    async serie(cik, familias = NUCLEO, limite = 400) {
      if (!familias.length) return [];
      // El join con company_filings es lo que hace que la cita ENLACE. Una
      // cita que no se puede abrir es un identificador bonito: el producto es
      // que el usuario vaya al papel y cuente los mismos números.
      const filas = await sql(
        `select q.familia, q.concept, q.unit, q.period_start, q.period_end, q.val,
                q.yoy_pct, q.revisado, q.derived, q.accession, q.accession_aux,
                q.filed, q.form, f.url as url, fa.url as url_aux
           from company_quarterly q
           left join company_filings f  on f.cik  = q.cik and f.accession  = q.accession
           left join company_filings fa on fa.cik = q.cik and fa.accession = q.accession_aux
          where q.cik = $1 and q.familia in (${enLista(familias, 2)})
          order by q.familia asc, q.period_end desc
          limit ${Number(limite)}`,
        [cik, ...familias],
      );
      return filas.map((r) => ({
        ...r,
        cita: cita(r.accession),
        // Un Q4 derivado salió de una resta entre dos filings: se muestran las
        // dos citas, porque enseñar solo el 10-K sería citar la mitad.
        cita_aux: cita(r.accession_aux),
        // La serie mira 3 años y el índice de filings 5, así que normalmente
        // el join encuentra la URL. Cuando no —un hecho re-expresado que cita
        // un filing más viejo que la ventana— se arma la del directorio, que
        // lleva al mismo lugar. Nunca se devuelve una cita sin destino.
        url: r.url || urlIndice(cik, r.accession),
        url_aux: r.accession_aux ? (r.url_aux || urlIndice(cik, r.accession_aux)) : null,
      }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// El armado de las secciones. Puro: recibe datos, devuelve la respuesta.
// ─────────────────────────────────────────────────────────────────────────

// Un grupo de documentos puede llegar como arreglo (los tests, y cualquier
// llamador viejo) o como {documentos, total, desde, hasta} desde la consulta.
// Normalizar acá evita que el total verdadero se pierda por el camino.
const norm = (x) => (Array.isArray(x)
  ? { documentos: x, total: x.length, desde: null, hasta: null }
  : { documentos: [], total: 0, desde: null, hasta: null, ...(x || {}) });

const unir = (...grupos) => {
  const documentos = grupos.flatMap((g) => g.documentos);
  documentos.sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
  const fechas = grupos.flatMap((g) => [g.desde, g.hasta]).filter(Boolean).sort();
  return {
    documentos,
    total: grupos.reduce((a, g) => a + g.total, 0),
    desde: fechas[0] || null,
    hasta: fechas[fechas.length - 1] || null,
  };
};

const seccion = (id, pregunta, datos, lang) => {
  const grupo = norm(datos.grupo || datos.documentos);
  const docs = grupo.documentos;
  const serie = datos.serie || [];
  const decls = (datos.declaraciones || []).map((c) => declarar(c, lang));

  let estado = datos.estado;
  if (!estado) estado = (docs.length || serie.length) ? 'con_documentos' : 'sin_documentos';

  return {
    id,
    pregunta,
    estado,
    // Contar lo que ya está es aritmética sobre los documentos, de la misma
    // clase que derivar un Q4. No dice qué significan: dice cuántos hay y
    // entre qué fechas.
    resumen: resumirDocumentos(docs, { total: grupo.total, desde: grupo.desde, hasta: grupo.hasta }),
    documentos: docs,
    ...(datos.serie ? { serie } : {}),
    ...(datos.episodios ? { episodios: datos.episodios } : {}),
    declaraciones: decls,
  };
};

export function armarSecciones({ emisor, direccion = [], proxies = [], propiedad = [], pelea = [],
  resultados = [], serie = [], catalizador = [], ruptura = [] }, { lang = 'es' } = {}) {
  const parcial = emisor.cobertura === 'parcial';

  // La serie re-expresada es contraevidencia de primera: la empresa se
  // corrigió a sí misma, con fecha y documento.
  const revisados = serie.filter((s) => s.revisado);

  const gDireccion = unir(norm(direccion), norm(proxies));
  const gPropiedad = unir(norm(propiedad), norm(pelea));

  const secciones = [
    seccion('direccion', 1, { grupo: gDireccion }, lang),

    seccion('propiedad', 2, {
      grupo: gPropiedad,
      // La pelea por el consejo se pierde en una lista plana: hay que contar
      // 34 filings a mano para darse cuenta de que pasó algo. Agruparlos por
      // rachas contiguas los vuelve visibles sin afirmar quién ganó.
      episodios: agruparEpisodios(gPropiedad.documentos),
    }, lang),

    seccion('prometido_vs_entregado', 3, {
      grupo: norm(resultados),
      serie,
      // G5 midió 0/4 emisores con guía etiquetada: no se guarda ni se muestra
      // un número de guía. Se enlaza el 8-K y el usuario lee el documento.
      declaraciones: ['guia_no_estructurada', ...(parcial ? ['cobertura_parcial'] : [])],
    }, lang),

    seccion('gerencia', 4, {
      estado: 'no_cubierta',
      declaraciones: ['transcripts'],
    }, lang),

    seccion('competencia', 5, {
      estado: 'no_cubierta',
      declaraciones: ['pares_sin_mapa', 'competidores_privados'],
    }, lang),

    seccion('mercado', 6, {
      estado: 'fuera_del_modulo',
      declaraciones: ['mercado_fuera_de_modulo', 'short_volume_no_es_short_interest'],
    }, lang),

    seccion('catalizador', 7, {
      grupo: norm(catalizador),
      declaraciones: ['earnings_no_edgar'],
    }, lang),
  ];

  // No es opcional (§8). Sin contraevidencia el módulo es un generador de
  // sesgo de confirmación CON citas, que es peor que uno sin citas porque
  // parece riguroso. Si no hay nada, se dice — y eso es falsable.
  const hayRuptura = ruptura.length > 0 || revisados.length > 0;
  const contraevidencia = {
    id: 'donde_se_rompe',
    estado: hayRuptura ? 'con_documentos' : 'sin_contraevidencia',
    documentos: norm(ruptura).documentos,
    periodos_reexpresados: revisados.map((r) => ({
      familia: r.familia, period_end: r.period_end, cita: r.cita, url: r.url, filed: r.filed,
    })),
    declaraciones: hayRuptura ? [] : [declarar('sin_contraevidencia', lang)],
  };

  return { secciones, contraevidencia };
}

// ─────────────────────────────────────────────────────────────────────────
// La historia entera. Vive acá y no en el endpoint para que los estados
// `sin_ingesta` y `desconocido` —los dos que más fácil mienten— se puedan
// probar sin una base de datos.
// ─────────────────────────────────────────────────────────────────────────
export async function armarHistoria(L, ticker, { lang = 'es' } = {}) {
  const emisor = await L.emisorPorTicker(ticker);

  // "No ingerido" no es "no existe", y ninguno de los dos es un error del
  // usuario. Devolver 404 aquí haría que "todavía no la bajamos" se leyera
  // como "esta empresa no tiene historia", que es una afirmación sobre la
  // empresa que no tenemos derecho a hacer.
  if (!emisor || !emisor.ultima_ingesta) {
    return {
      status: 200,
      cuerpo: {
        ticker,
        estado: emisor ? 'sin_ingesta' : 'desconocido',
        detalle: emisor
          ? 'El emisor está en el catálogo pero todavía no se ingirió. La ingesta corre por goteo en /api/historia-harvest.'
          : 'Este ticker no está en el catálogo de Historia. Se siembra con /api/historia-harvest?job=sembrar.',
        secciones: [],
      },
    };
  }

  const { cik } = emisor;
  // Lecturas independientes: secuenciarlas solo sumaría latencia.
  const [direccion, proxies, propiedad, pelea, resultados, catalizador, ruptura, serie] = await Promise.all([
    L.porItems(cik, ITEMS_DIRECCION),
    L.porFormas(cik, FORMAS_DIRECCION),
    L.porFormas(cik, FORMAS_PROPIEDAD),
    L.porFormas(cik, FORMAS_PELEA, LIMITE_CONTIENDA),
    L.porItems(cik, ITEMS_RESULTADOS),
    L.porItems(cik, ITEMS_CATALIZADOR),
    L.porItems(cik, ITEMS_RUPTURA),
    L.serie(cik, NUCLEO),
  ]);

  const { secciones, contraevidencia } = armarSecciones(
    { emisor, direccion, proxies, propiedad, pelea, resultados, serie, catalizador, ruptura },
    { lang },
  );

  return {
    status: 200,
    cuerpo: {
      ticker,
      estado: 'ok',
      emisor: {
        cik: emisor.cik,
        nombre: emisor.nombre,
        forma_anual: emisor.forma_anual,
        cobertura: emisor.cobertura,
        ultima_ingesta: emisor.ultima_ingesta,
      },
      formato_cita: '[0000320193-25-000073] — el identificador se ve y enlaza al documento primario',
      secciones,
      contraevidencia,
      no_cubierto: declaracionesGlobales(emisor, lang),
      fuente: 'SEC EDGAR',
    },
  };
}

// Lo que el módulo no cubre, a nivel de la historia entera. Va en la
// respuesta siempre, no solo cuando algo falta: el usuario tiene que poder
// ver el perímetro antes de sacar una conclusión, no después.
export function declaracionesGlobales(emisor, lang = 'es') {
  const codigos = ['transcripts', 'alt_data', 'expert_networks', 'competidores_privados', 'fts_desde_2001'];
  if (emisor.cobertura === 'parcial') codigos.unshift('cobertura_parcial');
  return codigos.map((c) => declarar(c, lang));
}
