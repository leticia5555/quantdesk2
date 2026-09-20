// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-glosario.js — qué dice el código, sin decir qué significa.
//
// "8-K · 2026-02-20 · 5.02 · [0001-26-1]" es un dato correcto y una pantalla
// inútil: un código legal sin traducir no le dice nada a nadie. Traducirlo NO
// es narrar — es un diccionario, y el diccionario lo publica la SEC.
//
// ── LA LÍNEA, Y DÓNDE PASA EXACTAMENTE ──────────────────────────────
// Traducir `5.02` a su nombre no agrega información: la quita del código y la
// pone en palabras. Lo que SÍ cruzaría es decir qué implica ese 5.02 para la
// empresa — si el que se fue era clave, si la salida fue forzada, si la pelea
// se ganó. Eso es lectura, y la lectura es Fase B.
//
// Dos precauciones que hacen que la traducción no se convierta en conclusión:
//
// **1. El título oficial va en inglés y textual.** Es una cita, no una
// traducción: traducirlo lo convertiría en nuestra versión de lo que dice la
// SEC. La glosa en español/inglés está aparte y es NUESTRA — se marca así.
//
// **2. La glosa no puede decir más que el item.** Es la parte fácil de
// arruinar, y hay dos casos en esta lista donde la versión corriente
// sobre-afirma:
//
//   · **5.02 no es solo "cambio de directivos".** El item cubre salidas,
//     nombramientos Y arreglos de compensación. Un 5.02 puede ser un ajuste
//     de paquete salarial sin que nadie se haya ido. Glosarlo como "cambio de
//     directivos" haría leer una salida donde no la hubo.
//   · **8.01 no es "otro evento relevante".** El texto de la SEC es "Other
//     Events", y el item es explícitamente OPCIONAL: la empresa divulga lo
//     que quiera que no encaje en otro item. "Relevante" agrega una
//     materialidad que el item no afirma.
//
// Lo mismo con las formas: `SC 13D` es el esquema que NO se acoge al régimen
// pasivo. "Con intención de influir" es la lectura habitual y suele ser
// cierta, pero es una inferencia legal sobre la intención de un tercero. La
// glosa dice qué régimen usó, que es el hecho.
//
// ── PROCEDENCIA ─────────────────────────────────────────────────────
// Los títulos oficiales están transcritos de los encabezados de item del
// Formulario 8-K y de los nombres de formulario de EDGAR. **No se bajaron de
// la red**: este contenedor no alcanza sec.gov (docs/historia-fase0.md §0).
// Verificables contra https://www.sec.gov/fast-answers/answersform8khtm.html
// y el índice de formularios de EDGAR.
// ═══════════════════════════════════════════════════════════════

export const FUENTE_ITEMS = 'https://www.sec.gov/fast-answers/answersform8khtm.html';

// `oficial`: el encabezado de la SEC, en inglés y textual. Es una cita.
// `es` / `en`: la glosa corta, NUESTRA, marcada como tal en la respuesta.
export const ITEMS_8K = {
  '1.01': { oficial: 'Entry into a Material Definitive Agreement',
    es: 'firmó un contrato material', en: 'entered a material agreement' },
  '1.02': { oficial: 'Termination of a Material Definitive Agreement',
    es: 'terminó un contrato material', en: 'terminated a material agreement' },
  '1.03': { oficial: 'Bankruptcy or Receivership',
    es: 'quiebra o administración judicial', en: 'bankruptcy or receivership' },
  '1.05': { oficial: 'Material Cybersecurity Incidents',
    es: 'incidente de ciberseguridad material', en: 'material cybersecurity incident' },
  '2.01': { oficial: 'Completion of Acquisition or Disposition of Assets',
    es: 'completó una compra o venta de activos', en: 'completed an acquisition or disposal' },
  '2.02': { oficial: 'Results of Operations and Financial Condition',
    es: 'resultados del periodo', en: 'results of operations' },
  '2.03': { oficial: 'Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement',
    es: 'asumió una obligación financiera', en: 'took on a financial obligation' },
  '2.04': { oficial: 'Triggering Events That Accelerate or Increase a Direct Financial Obligation',
    es: 'se gatilló una aceleración de deuda', en: 'debt acceleration triggered' },
  '2.05': { oficial: 'Costs Associated with Exit or Disposal Activities',
    es: 'costos de cierre o desinversión', en: 'exit or disposal costs' },
  '2.06': { oficial: 'Material Impairments',
    es: 'deterioro material de activos', en: 'material impairment' },
  '3.01': { oficial: 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard',
    es: 'aviso de deslistado o incumplimiento de cotización', en: 'delisting notice or listing failure' },
  '3.02': { oficial: 'Unregistered Sales of Equity Securities',
    es: 'vendió acciones sin registrar', en: 'unregistered equity sales' },
  '3.03': { oficial: 'Material Modification to Rights of Security Holders',
    es: 'cambió los derechos de los accionistas', en: 'modified security holder rights' },
  '4.01': { oficial: "Changes in Registrant's Certifying Accountant",
    es: 'cambió de auditor', en: 'changed auditors' },
  // El item más literal que EDGAR produce como contraevidencia.
  '4.02': { oficial: 'Non-Reliance on Previously Issued Financial Statements or a Related Audit Report',
    es: 'los estados financieros anteriores ya no son confiables',
    en: 'previously issued financial statements are no longer reliable' },
  '5.01': { oficial: 'Changes in Control of Registrant',
    es: 'cambio de control de la empresa', en: 'change in control' },
  // OJO: el item cubre TRES cosas, y glosarlo solo como "cambio de
  // directivos" haría leer una salida donde pudo haber solo un ajuste de
  // compensación.
  '5.02': { oficial: 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers',
    es: 'salida, nombramiento o compensación de directivos o consejeros',
    en: 'departure, appointment or compensation of directors or officers' },
  '5.03': { oficial: 'Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year',
    es: 'cambió estatutos o año fiscal', en: 'amended bylaws or fiscal year' },
  '5.05': { oficial: "Amendment to Registrant's Code of Ethics, or Waiver of a Provision of the Code of Ethics",
    es: 'cambió o dispensó el código de ética', en: 'amended or waived code of ethics' },
  '5.07': { oficial: 'Submission of Matters to a Vote of Security Holders',
    es: 'resultados de la votación de accionistas', en: 'shareholder vote results' },
  '5.08': { oficial: 'Shareholder Director Nominations',
    es: 'nominaciones de consejeros por accionistas', en: 'shareholder director nominations' },
  '7.01': { oficial: 'Regulation FD Disclosure',
    es: 'divulgación bajo Regulation FD', en: 'Regulation FD disclosure' },
  // "Other Events", y es OPCIONAL: la empresa divulga lo que quiera que no
  // encaje en otro item. Llamarlo "relevante" agrega una materialidad que el
  // item no afirma.
  '8.01': { oficial: 'Other Events',
    es: 'otro evento que la empresa eligió divulgar', en: 'another event the company chose to disclose' },
  '9.01': { oficial: 'Financial Statements and Exhibits',
    es: 'estados financieros y anexos', en: 'financial statements and exhibits' },
};

export const FORMAS = {
  '8-K': { oficial: 'Current Report', es: 'reporte de evento', en: 'current report' },
  '10-K': { oficial: 'Annual Report', es: 'reporte anual', en: 'annual report' },
  '10-Q': { oficial: 'Quarterly Report', es: 'reporte trimestral', en: 'quarterly report' },
  '20-F': { oficial: 'Annual Report (foreign private issuer)',
    es: 'reporte anual de emisor extranjero', en: 'annual report (foreign private issuer)' },
  '6-K': { oficial: 'Report of Foreign Private Issuer',
    es: 'reporte de emisor extranjero', en: 'foreign private issuer report' },
  '3': { oficial: 'Initial Statement of Beneficial Ownership',
    es: 'alta de insider', en: 'initial insider statement' },
  '4': { oficial: 'Statement of Changes in Beneficial Ownership',
    es: 'compra o venta de un insider', en: 'insider transaction' },
  '5': { oficial: 'Annual Statement of Changes in Beneficial Ownership',
    es: 'resumen anual de un insider', en: 'annual insider statement' },
  // 13D vs 13G: el hecho es QUÉ RÉGIMEN usó, no qué pretende. "Con intención
  // de influir" es la lectura habitual de un 13D y suele ser cierta, pero es
  // una inferencia sobre la intención de un tercero.
  'SC 13D': { oficial: 'Beneficial Ownership Report (over 5%, not eligible for the passive schedule)',
    es: 'más del 5%, sin acogerse al régimen pasivo',
    en: 'over 5%, not filing under the passive schedule' },
  'SC 13D/A': { oficial: 'Amended Beneficial Ownership Report (over 5%, non-passive)',
    es: 'actualización de una posición de más del 5% no pasiva',
    en: 'amended non-passive over-5% position' },
  'SC 13G': { oficial: 'Beneficial Ownership Report (over 5%, passive or exempt)',
    es: 'posición pasiva de más del 5%', en: 'passive over-5% position' },
  'SC 13G/A': { oficial: 'Amended Beneficial Ownership Report (over 5%, passive or exempt)',
    es: 'actualización de una posición pasiva de más del 5%', en: 'amended passive over-5% position' },
  'DEF 14A': { oficial: 'Definitive Proxy Statement',
    es: 'convocatoria definitiva a junta de accionistas', en: 'definitive proxy statement' },
  'DEFA14A': { oficial: 'Additional Definitive Proxy Soliciting Materials',
    es: 'material adicional de la empresa para la junta', en: 'additional proxy material from the company' },
  'PRE 14A': { oficial: 'Preliminary Proxy Statement',
    es: 'convocatoria preliminar a junta', en: 'preliminary proxy statement' },
  // La "C" es de contested. Eso NO es inferencia nuestra: está en el nombre
  // del formulario.
  PREC14A: { oficial: 'Preliminary Proxy Statement — Contested Solicitation',
    es: 'convocatoria preliminar, solicitación impugnada', en: 'preliminary proxy — contested solicitation' },
  DEFC14A: { oficial: 'Definitive Proxy Statement — Contested Solicitation',
    es: 'convocatoria definitiva, solicitación impugnada', en: 'definitive proxy — contested solicitation' },
  PRRN14A: { oficial: 'Revised Preliminary Proxy Statement — Non-Management',
    es: 'convocatoria preliminar revisada, presentada por un tercero',
    en: 'revised preliminary proxy filed by a non-management party' },
  DFAN14A: { oficial: 'Additional Definitive Proxy Soliciting Materials Filed by Non-Management',
    es: 'material de solicitación presentado por un tercero, no por la empresa',
    en: 'soliciting material filed by a non-management party' },
};

const vacio = (codigo) => ({ codigo, oficial: null, glosa: null, glosa_es: null });

// Un código desconocido NO se inventa: se devuelve tal cual, con la glosa en
// null. Un diccionario que adivina deja de ser un diccionario.
export function glosarItem(codigo, lang = 'es') {
  const e = ITEMS_8K[String(codigo).trim()];
  if (!e) return vacio(codigo);
  return { codigo, oficial: e.oficial, glosa: e[lang] || e.es };
}

export function glosarForma(forma, lang = 'es') {
  const e = FORMAS[String(forma).trim().toUpperCase()] || FORMAS[String(forma).trim()];
  if (!e) return vacio(forma);
  return { codigo: forma, oficial: e.oficial, glosa: e[lang] || e.es };
}

// ─────────────────────────────────────────────────────────────────────────
// La pelea por el consejo
// ─────────────────────────────────────────────────────────────────────────

// Son las formas cuyo NOMBRE dice que la solicitación está impugnada o viene
// de un tercero. No se infiere de nada: la "C" es de contested y el "N" de
// DFAN es de non-management.
export const FORMAS_CONTIENDA = ['PREC14A', 'DEFC14A', 'PRRN14A', 'DFAN14A'];
export const esContienda = (forma) => FORMAS_CONTIENDA.includes(String(forma || '').trim().toUpperCase());

// El hueco que separa dos episodios. **Es NUESTRO, no de la SEC**, y por eso
// viaja en la respuesta: agrupar dos peleas distintas en una sería afirmar
// algo que ningún documento dice.
export const UMBRAL_EPISODIO_DIAS = 120;

const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Agrupa filings de solicitación impugnada en rachas contiguas.
//
// Lo que esto afirma: "hubo N documentos de solicitación impugnada entre esta
// fecha y esta otra". Es aritmética sobre los documentos, de la misma clase
// que derivar un Q4.
//
// Lo que NO afirma, y no puede: quién ganó, si sigue abierta, si fue seria, o
// si dos rachas separadas son la misma pelea. Eso es lectura.
export function agruparEpisodios(documentos, { umbralDias = UMBRAL_EPISODIO_DIAS } = {}) {
  const contienda = (documentos || [])
    .filter((d) => esContienda(d.form) && d.filed)
    .sort((a, b) => String(a.filed).localeCompare(String(b.filed)));
  if (!contienda.length) return [];

  const episodios = [];
  let actual = null;
  for (const d of contienda) {
    if (actual && diasEntre(actual.hasta, d.filed) <= umbralDias) {
      actual.documentos.push(d);
      actual.hasta = d.filed;
    } else {
      actual = { desde: d.filed, hasta: d.filed, documentos: [d] };
      episodios.push(actual);
    }
  }

  return episodios.map((e) => {
    const porForma = {};
    for (const d of e.documentos) porForma[d.form] = (porForma[d.form] || 0) + 1;
    return {
      desde: e.desde,
      hasta: e.hasta,
      dias: diasEntre(e.desde, e.hasta),
      total: e.documentos.length,
      por_forma: porForma,
      // El umbral viaja con el episodio: quien lo lea tiene que poder ver que
      // el agrupamiento es una decisión nuestra y cuál fue.
      umbral_dias: umbralDias,
      documentos: e.documentos,
    };
  }).sort((a, b) => String(b.hasta).localeCompare(String(a.hasta)));
}

// ─────────────────────────────────────────────────────────────────────────
// El resumen de una sección: contar lo que ya está.
// ─────────────────────────────────────────────────────────────────────────

// `total` y el rango se calculan sobre TODOS los filings que matchearon, no
// sobre los que se alcanzan a mostrar. Contar los 40 de una página y decir
// "40 filings" cuando hay 196 sería una cifra correcta sobre el subconjunto
// equivocado — la peor clase de número, porque nadie la revisa.
export function resumirDocumentos(documentos, { total = null, desde = null, hasta = null } = {}) {
  const docs = documentos || [];
  const porForma = {};
  const porItem = {};
  for (const d of docs) {
    porForma[d.form] = (porForma[d.form] || 0) + 1;
    for (const i of d.items || []) porItem[i] = (porItem[i] || 0) + 1;
  }
  const fechas = docs.map((d) => d.filed).filter(Boolean).sort();
  return {
    total: total == null ? docs.length : Number(total),
    mostrados: docs.length,
    desde: desde || fechas[0] || null,
    hasta: hasta || fechas[fechas.length - 1] || null,
    por_forma: porForma,
    por_item: porItem,
    // Si se mostró menos de lo que hay, se dice: el conteo es del total y la
    // lista es una muestra, y confundirlos es lo que hay que evitar.
    truncado: total != null && Number(total) > docs.length,
  };
}
