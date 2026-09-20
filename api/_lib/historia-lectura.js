// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-lectura.js — UNA línea de tiempo, siete filtros.
//
// Esta fase no narra. Lo que devuelve son los filings con su fecha, su enlace
// y su cita, y la serie trimestral con el `accession` del que salió cada
// número. El lector con prompt congelado es la Fase B y acá no existe.
//
// ── POR QUÉ UNA LÍNEA Y NO SIETE LISTAS ─────────────────────────────
// La versión anterior corría siete consultas, una por pregunta, y armaba
// siete listas. Eso tenía tres problemas, y el tercero no se veía:
//
//   1. **El mismo documento salía tres veces.** Un 8-K con 2.02, 5.02 y 1.01
//      aparecía en la sección 1, en la 3 y en la 7 sin decir que era el mismo
//      papel. Un documento es UN evento: o se muestra una vez con todos sus
//      temas, o miente sobre cuántas cosas pasaron.
//   2. **Siete cubetas no son una historia.** El orden cronológico cuenta más
//      que el orden por categoría: lo que pasó en marzo de 2022 se entiende
//      junto a lo de abril, no junto a otro 5.02 de 2019.
//   3. **Los resúmenes contaban ese documento tres veces.** "12 filings" en
//      tres secciones sobre un universo de 20 papeles distintos es un número
//      correcto sobre el conjunto equivocado, que es la peor clase.
//
// Ahora hay UNA consulta y UNA lista. Las secciones son filtros: cada una
// dice qué `accessions` de la línea le tocan, no una copia de los documentos.
// Que un evento aparezca exactamente una vez deja de ser una convención y
// pasa a ser una propiedad de la estructura.
//
// ── LOS ITEMS NO PESAN LO MISMO ─────────────────────────────────────
// El 9.01 aparece en casi todos los 8-K y solo dice "adjunté un archivo".
// Mostrarlo al mismo nivel que un 4.02 es ruido con formato de señal. La
// jerarquía vive en el glosario (`partirItems`) y acá solo se usa: el item
// principal manda, los secundarios viajan aparte y la página los apaga.
//
// ── LAS TRES MANERAS DE NO TENER ALGO, Y POR QUÉ SE DISTINGUEN ──────
//   · `sin_documentos`  — la sección SÍ se cubre, se buscó, y no hay nada.
//                         Es una afirmación falsable sobre la empresa.
//   · `no_cubierta`     — el módulo no cubre esa fuente (transcripts, alt
//                         data). Es una afirmación sobre NOSOTROS, no sobre
//                         la empresa, y decirla es obligación (§8).
//   · `fuera_del_modulo`— el dato existe en QuantDesk pero no sale de EDGAR.
//
// Confundir el primero con el segundo sería lo más fácil y lo más dañino:
// "no hay 13D" y "no miramos 13D" llevan a decisiones opuestas.
//
// ── LA CITA ES EL PRODUCTO ──────────────────────────────────────────
// Decisión 8 de §10: el identificador se VE — `[0000320193-25-000073]`,
// enlazado al documento primario. Un Q4 derivado lleva DOS citas porque salió
// de una resta entre dos filings (§5); mostrar solo el 10-K sería citar la
// mitad.
//
// ── LO QUE ACÁ NO PASA ──────────────────────────────────────────────
// No se escribe nada. No se dispara ingesta. Un emisor que no está ingerido
// devuelve `sin_ingesta` y se dice — no se ingiere al vuelo, porque la
// corrida 2 midió 42 s por ticker (§11, G4) y eso no entra en un request.
// ═══════════════════════════════════════════════════════════════

import { sql as sqlReal } from './db.js';
import { NUCLEO } from './historia-db.js';
import { urlIndice } from './edgar.js';
import {
  glosarItem, glosarForma, agruparEpisodios, resumirDocumentos, esContienda,
  partirItems, preguntasDe, ITEMS_CONTRAEVIDENCIA,
} from './historia-glosario.js';

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
  // La línea de tiempo no es "todo lo que la empresa presentó": es lo que
  // alimenta las siete preguntas. Decirlo importa porque el vacío se lee como
  // ausencia. Las Formas 3/4/5 —las compras y ventas de los insiders— son el
  // caso ruidoso: LULU tiene 196 y taparían la línea entera.
  linea_perimetro: {
    es: 'La línea de tiempo muestra los documentos que alimentan las siete preguntas, no todos los filings del emisor. Quedan fuera, entre otros, los 10-K y 10-Q completos y las Formas 3/4/5 de insiders.',
    en: 'The timeline shows the documents that feed the seven questions, not every filing. Full 10-Ks and 10-Qs and insider Forms 3/4/5 are among those left out.',
  },
  linea_truncada: {
    es: 'La línea de tiempo está recortada: hay más documentos de los que se muestran. El conteo es del total; la lista es una muestra.',
    en: 'The timeline is truncated: there are more documents than shown. The count is of the total; the list is a sample.',
  },
};

export const declarar = (codigo, lang = 'es') => ({
  codigo,
  texto: (DECLARACIONES[codigo] || {})[lang] || (DECLARACIONES[codigo] || {}).es || codigo,
});

// ─────────────────────────────────────────────────────────────────────────
// Qué formas e items entran a la línea. El mapa item/forma → pregunta vive en
// el glosario (`preguntasDe`); acá solo se define el perímetro de la consulta.
// Las dos cosas tienen que cuadrar: un item que entre y no mapee a ninguna
// pregunta aparecería en la línea sin filtro que lo alcance, y la prueba
// `todo evento cae en al menos una pregunta` es la que lo caza.
// ─────────────────────────────────────────────────────────────────────────
export const ITEMS_DIRECCION = ['5.02'];                 // altas, bajas y paquetes
// El 5.07 es el DESENLACE de la pelea: sin él la línea mostraba 34 filings de
// campaña y cero del resultado de la votación, que sí está en EDGAR. Mostrarlo
// no es decir quién ganó — el documento trae los votos y punto; interpretarlos
// es Fase B.
export const ITEMS_PROPIEDAD = ['5.07'];                 // resultados de la asamblea
export const ITEMS_RESULTADOS = ['2.02', '7.01'];        // resultados y la guía en prosa
export const ITEMS_CATALIZADOR = ['1.01', '2.01', '8.01']; // acuerdos, adquisiciones, otros
export const ITEMS_RUPTURA = ITEMS_CONTRAEVIDENCIA;      // 4.02 — "no confíen en lo anterior"
export const FORMAS_DIRECCION = ['DEF 14A'];
export const FORMAS_PROPIEDAD = ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A'];
export const FORMAS_PELEA = ['PREC14A', 'DEFC14A', 'PRRN14A', 'DFAN14A'];

export const ITEMS_INTERES = [...new Set([
  ...ITEMS_DIRECCION, ...ITEMS_PROPIEDAD, ...ITEMS_RESULTADOS,
  ...ITEMS_CATALIZADOR, ...ITEMS_RUPTURA,
])];
export const FORMAS_INTERES = [...new Set([
  ...FORMAS_DIRECCION, ...FORMAS_PROPIEDAD, ...FORMAS_PELEA,
])];

// Tope de seguridad, no paginación. La pelea por el consejo se trae ENTERA
// —un episodio calculado sobre 40 de 200 empezaría y terminaría donde no es—
// y los conteos por sección solo son exactos si la línea vino completa. Si
// alguna vez se pasa, el total verdadero viaja igual y se declara `truncado`.
export const LIMITE_EVENTOS = 1500;

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
  return {
    async emisorPorTicker(ticker) {
      const filas = await sql(
        `select cik, ticker, nombre, forma_anual, cobertura, ultima_ingesta, estado
           from company_emisor where upper(ticker) = upper($1) limit 1`,
        [ticker],
      );
      return filas[0] || null;
    },

    // UNA consulta para toda la línea. El `exists` sobre company_filing_items
    // —en vez del join con distinct de antes— es lo que garantiza un renglón
    // por filing aunque el filing tenga tres items de interés: el duplicado se
    // evita en la consulta, no a mano después.
    async eventos(cik, { limite = LIMITE_EVENTOS } = {}) {
      const params = [cik, ...FORMAS_INTERES, ...ITEMS_INTERES];
      const pForm = enLista(FORMAS_INTERES, 2);
      const pItem = enLista(ITEMS_INTERES, 2 + FORMAS_INTERES.length);
      const filas = await sql(
        `select f.accession, f.form, f.items_raw, f.filed, f.report_date, f.url, f.index_url,
                count(*) over () as total_general
           from company_filings f
          where f.cik = $1
            and (f.form in (${pForm})
                 or exists (select 1 from company_filing_items i
                             where i.cik = f.cik and i.accession = f.accession
                               and i.item in (${pItem})))
          order by f.filed desc, f.accession desc
          limit ${Number(limite)}`,
        params,
      );
      return {
        filas,
        total: filas.length ? Number(filas[0].total_general) : 0,
      };
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

    lang,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// De renglón a evento. Un evento es UN documento con TODOS sus temas.
// ─────────────────────────────────────────────────────────────────────────
export function armarEvento(r, lang = 'es') {
  const items = r.items_raw
    ? String(r.items_raw).split(',').map((s) => s.trim()).filter(Boolean)
    : (r.items || []);
  const { principal, destacados, secundarios } = partirItems(items);
  const preguntas = preguntasDe({ form: r.form, items });

  return {
    accession: r.accession,
    form: r.form,
    // El código se queda Y se traduce. `oficial` es la cita textual de la
    // SEC; `glosa` es nuestra y va marcada como tal en el glosario.
    forma_glosa: glosarForma(r.form, lang),
    items,
    items_glosa: items.map((i) => glosarItem(i, lang)),
    // El 9.01 no es el evento: es el adjunto del evento. Separarlos acá es lo
    // que le permite a la página mandarlo al final en gris sin esconderlo.
    // Los destacados pueden ser varios —un 8-K con 5.02 y 1.01 anunció dos
    // cosas— y se muestran todos: quedarse con uno sería elegir por el lector.
    item_principal: principal,
    items_destacados: destacados,
    items_destacados_glosa: destacados.map((i) => glosarItem(i, lang)),
    items_secundarios: secundarios,
    items_secundarios_glosa: secundarios.map((i) => glosarItem(i, lang)),
    // Bajo qué preguntas se puede ver este mismo evento. Es la lista de
    // filtros que lo alcanzan, no una copia por cada uno.
    preguntas,
    contraevidencia: items.some((i) => ITEMS_CONTRAEVIDENCIA.includes(i)),
    contienda: esContienda(r.form),
    filed: r.filed,
    report_date: r.report_date ?? null,
    url: r.url,
    index_url: r.index_url,
    cita: cita(r.accession),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// El armado. Puro: recibe datos, devuelve la respuesta.
// ─────────────────────────────────────────────────────────────────────────

const seccion = (id, pregunta, datos, lang) => {
  const eventos = datos.eventos || [];
  const serie = datos.serie || [];
  const decls = (datos.declaraciones || []).map((c) => declarar(c, lang));

  let estado = datos.estado;
  if (!estado) estado = (eventos.length || serie.length) ? 'con_documentos' : 'sin_documentos';

  return {
    id,
    pregunta,
    estado,
    // Contar lo que ya está es aritmética sobre los documentos, de la misma
    // clase que derivar un Q4. No dice qué significan: dice cuántos hay y
    // entre qué fechas.
    resumen: resumirDocumentos(eventos, { truncado: !!datos.truncado }),
    // La sección es un FILTRO, no una cubeta: apunta a los eventos de la
    // línea en vez de copiarlos. Por eso un 8-K con tres temas se cuenta una
    // vez en la línea y aparece bajo las tres preguntas sin multiplicarse.
    accessions: eventos.map((e) => e.accession),
    ...(datos.serie ? { serie } : {}),
    ...(datos.episodios ? { episodios: datos.episodios } : {}),
    declaraciones: decls,
  };
};

export function armarSecciones({ emisor, eventos = [], serie = [], truncado = false }, { lang = 'es' } = {}) {
  const parcial = emisor.cobertura === 'parcial';

  // La serie re-expresada es contraevidencia de primera: la empresa se
  // corrigió a sí misma, con fecha y documento.
  const revisados = serie.filter((s) => s.revisado);

  const de = (q) => eventos.filter((e) => e.preguntas.includes(q));
  const ruptura = eventos.filter((e) => e.contraevidencia);

  const secciones = [
    seccion('direccion', 1, { eventos: de(1), truncado }, lang),

    seccion('propiedad', 2, {
      eventos: de(2),
      truncado,
      // La pelea por el consejo se pierde en una lista plana: hay que contar
      // 34 filings a mano para darse cuenta de que pasó algo. Agruparlos por
      // rachas contiguas los vuelve visibles sin afirmar quién ganó.
      episodios: agruparEpisodios(de(2)),
    }, lang),

    seccion('prometido_vs_entregado', 3, {
      eventos: de(3),
      truncado,
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
      eventos: de(7),
      truncado,
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
    accessions: ruptura.map((e) => e.accession),
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
  // Dos lecturas, no ocho. Independientes: secuenciarlas solo sumaría latencia.
  const [crudo, serie] = await Promise.all([
    L.eventos(cik),
    L.serie(cik, NUCLEO),
  ]);

  const eventos = crudo.filas.map((r) => armarEvento(r, lang));
  const truncado = crudo.total > eventos.length;

  const { secciones, contraevidencia } = armarSecciones(
    { emisor, eventos, serie, truncado },
    { lang },
  );

  const fechas = eventos.map((e) => e.filed).filter(Boolean).sort();

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
      // La línea es la respuesta; las secciones son vistas de la línea. Los
      // eventos viven acá UNA vez y las siete preguntas los referencian por
      // accession.
      linea_de_tiempo: {
        eventos,
        total: crudo.total,
        mostrados: eventos.length,
        truncado,
        desde: fechas[0] || null,
        hasta: fechas[fechas.length - 1] || null,
        declaraciones: [
          declarar('linea_perimetro', lang),
          ...(truncado ? [declarar('linea_truncada', lang)] : []),
        ],
      },
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
