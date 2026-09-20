// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-evidencia.js — lo que el lector va a ver, ya resuelto.
//
// Esta es la rebanada G: el paquete que la Fase B le pasa al modelo. No hay
// llamada a Anthropic acá y no hay prompt — eso es la H. Acá se decide QUÉ
// evidencia entra, con la aritmética hecha y con la lista explícita de qué
// se puede citar.
//
// ── LA DOCTRINA QUE SE COPIA, Y DE DÓNDE ────────────────────────────
// De `api/_lib/ai-guard.js`, que la aprendió con un bug: al PM del Arena las
// noticias le llegaban con fecha absoluta y "calculá vos qué tan vieja es", y
// el modelo narró unos earnings a DOS DÍAS como "post-market today". La regla
// que salió de ahí: **la aritmética no se delega al LLM**. Acá eso significa
// que al prompt no llega nada que haya que restar, dividir ni comparar:
//
//   · el YoY ya viene de la vista, y cuando NO es comparable viaja el motivo
//     en vez de un hueco que el modelo llene con una resta suya;
//   · el margen bruto y el neto en porcentaje se calculan acá, con las citas
//     de los DOS hechos que entraron a la división;
//   · la distancia entre dos documentos viene en días, ya contada;
//   · una racha de 34 filings de campaña entra como UN episodio con su
//     conteo, no como 34 renglones para que el modelo los cuente.
//
// ── POR QUÉ NO HAY NADA RELATIVO A HOY ──────────────────────────────
// La tentación era mandar "hace 3 días" como hace `relativeDayLabel` en el
// Arena. Acá no, y la razón es la decisión 3 de la Fase B: *la historia
// cambia cuando cambia un filing, no cuando alguien abre la página*. La
// narración se guarda con el hash de su evidencia; si la evidencia dijera
// "hace 3 días", el hash cambiaría todos los días —y si no cambiara, la
// narración cacheada diría "hace 3 días" cuando ya pasaron cuarenta. Una
// mentira con cita, que es la peor clase.
//
// Así que el paquete lleva **fechas absolutas** y **distancias entre eventos**
// (que son estables: el 4.02 siempre llegó 41 días después del 10-K). Lo
// relativo a hoy lo pone la página, que se repinta sola. `dateDirective` sí
// se inyecta en la llamada —para que el modelo no ancle al presente de su
// entrenamiento— pero queda FUERA del hash, por la misma razón.
//
// ── LO QUE ENTRA AL PROMPT ES LO QUE LA PÁGINA MUESTRA ──────────────
// El paquete se arma del cuerpo de `/api/historia`, no de la base. Eso hace
// imposible que la narración cite algo que el usuario no pueda encontrar en
// la pantalla: si está en el prompt, está en la página. La alternativa —leer
// la base por separado— habría dejado que las dos vistas se separaran sin
// que nadie se enterara.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

export const VERSION_EVIDENCIA = 'historia-evidencia-1';

// Cuántos eventos entran. No es un límite de la línea (la página muestra
// todos): es el presupuesto del prompt. Lo que no entra se DECLARA — un hueco
// declarado es un dato, uno silencioso es un bug.
export const LIMITE_EVENTOS = 150;

// El techo del paquete, medido y no estimado. Un emisor duro —159 filings en
// la ventana, una pelea de 34, 12 trimestres por familia— da ~41 KB. El techo
// deja margen y existe para que crecer el paquete sea una decisión visible:
// si una rebanada futura lo empuja arriba de esto, la prueba lo dice antes de
// que aparezca en la factura.
export const TECHO_BYTES = 80 * 1024;

// A partir de cuántos filings una racha de campaña entra como episodio en vez
// de como renglones. Tres documentos se leen; treinta y cuatro se cuentan, y
// contar es justamente lo que no se delega.
export const MIN_EPISODIO_COLAPSA = 4;

const dia = 86400000;
const aFecha = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);

// Días entre dos fechas ISO. null si alguna no parsea — nunca un 0 que se
// lea como "el mismo día".
export function diasEntre(a, b) {
  const x = aFecha(a); const y = aFecha(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.round((y - x) / dia);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Redondeo a un decimal. Devolver 12.299999999999999 sería darle al modelo un
// número que se ve calculado a mano y lo invita a "limpiarlo" él.
const pct = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ─────────────────────────────────────────────────────────────────────────
// Las razones que el modelo NO tiene que dividir
// ─────────────────────────────────────────────────────────────────────────
//
// Un margen en porcentaje es el número más útil de la pregunta 3 y el más
// fácil de errar: hay que emparejar dos hechos del MISMO periodo y la misma
// unidad, y un trimestre derivado arrastra sus dos citas. Si se lo dejáramos
// al modelo tendríamos una división con cuatro maneras de salir mal y ninguna
// de verificarse.
//
// Solo se calcula cuando el periodo coincide EXACTO (inicio, fin y unidad).
// Si no coincide, no sale nada: un margen de un trimestre dividido por los
// ingresos de otro es un número redondo y falso.
export const RAZONES = [
  { id: 'margen_bruto_pct', num: 'margen', den: 'ingresos', formula: 'margen bruto ÷ ingresos' },
  { id: 'margen_neto_pct', num: 'neto', den: 'ingresos', formula: 'resultado neto ÷ ingresos' },
];

const clavePeriodo = (p) => `${p.period_start || ''}|${p.period_end || ''}|${p.unit || ''}`;

const citasDe = (p) => [p.accession, p.accession_aux].filter(Boolean);

export function razonesDe(serie = []) {
  const porFamilia = new Map();
  for (const p of serie) {
    if (!porFamilia.has(p.familia)) porFamilia.set(p.familia, new Map());
    porFamilia.get(p.familia).set(clavePeriodo(p), p);
  }

  const salida = [];
  for (const r of RAZONES) {
    const arriba = porFamilia.get(r.num);
    const abajo = porFamilia.get(r.den);
    if (!arriba || !abajo) continue;
    for (const [clave, n] of arriba) {
      const d = abajo.get(clave);
      if (!d) continue;                       // otro periodo: no se divide
      const vn = num(n.val); const vd = num(d.val);
      if (vn == null || vd == null || vd === 0) continue;
      salida.push({
        id: r.id,
        formula: r.formula,
        period_start: n.period_start ?? null,
        period_end: n.period_end,
        valor_pct: pct((vn / vd) * 100),
        // Las citas de los DOS hechos que entraron a la división. Enseñar
        // solo la del numerador sería citar la mitad, igual que un Q4.
        citas: [...new Set([...citasDe(n), ...citasDe(d)])].sort(),
        // Si alguno de los dos salió de una resta, la razón también es
        // derivada. Que se vea, porque cambia cuánto pesa.
        ...(n.derived || d.derived ? { derivado: true } : {}),
        ...(n.revisado || d.revisado ? { revisado: true } : {}),
      });
    }
  }
  return salida.sort((a, b) => (a.id === b.id
    ? String(b.period_end).localeCompare(String(a.period_end))
    : a.id.localeCompare(b.id)));
}

// ─────────────────────────────────────────────────────────────────────────
// La serie, en la forma en que el modelo no tiene que recalcularla
// ─────────────────────────────────────────────────────────────────────────
export const MOTIVO_SIN_YOY = 'sin trimestre comparable en la ventana';

// Los campos que solo dicen algo cuando están presentes se OMITEN cuando no.
// Un `"revisado":false` repetido en cuarenta y ocho renglones es peso sin
// información —su ausencia dice exactamente lo mismo— y el presupuesto del
// prompt se gasta en eso antes que en un hecho.
export function serieParaPrompt(serie = []) {
  return serie.map((p) => {
    const yoy = p.yoy_pct == null ? null : pct(num(p.yoy_pct));
    return {
      familia: p.familia,
      ...(p.period_start ? { period_start: p.period_start } : {}),
      period_end: p.period_end,
      valor: num(p.val),
      unidad: p.unit,
      // El YoY viene de la vista, que ya decidió si los dos trimestres son
      // comparables (330–400 días de distancia, §5). Cuando NO lo son viaja
      // el MOTIVO: un null pelado invita a que el modelo haga su propia resta
      // con el trimestre que tenga a mano, que es exactamente el error.
      ...(yoy == null ? { yoy_motivo: MOTIVO_SIN_YOY } : { yoy_pct: yoy }),
      ...(p.revisado ? { revisado: true } : {}),
      ...(p.derived ? { derivado: true } : {}),
      citas: citasDe(p),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Los eventos: qué entra entero y qué entra contado
// ─────────────────────────────────────────────────────────────────────────
//
// Una pelea por el consejo son 34 filings que dicen casi lo mismo. Mandarlos
// uno por uno gasta el presupuesto del prompt en repetición Y le pide al
// modelo que los cuente. Entra el episodio —con su conteo, su rango y su
// desglose, ya calculados— más el primero y el último como anclas citables.
//
// El resto de los eventos entra entero, del más nuevo al más viejo, hasta el
// límite. Lo que se cae se cuenta y se declara.
export function eventosParaPrompt(eventos = [], episodios = [], { limite = LIMITE_EVENTOS } = {}) {
  const colapsados = new Set();
  const anclas = new Set();
  const resumenes = [];

  for (const ep of episodios) {
    const docs = (ep.documentos || []).filter((d) => d && d.accession);
    if (docs.length < MIN_EPISODIO_COLAPSA) continue;
    const orden = [...docs].sort((a, b) => String(a.filed).localeCompare(String(b.filed)));
    for (const d of orden) colapsados.add(d.accession);
    anclas.add(orden[0].accession);
    anclas.add(orden[orden.length - 1].accession);
    resumenes.push({
      tipo: 'solicitacion_impugnada',
      desde: ep.desde,
      hasta: ep.hasta,
      dias: ep.dias,
      total: ep.total,
      por_forma: ep.por_forma,
      // El umbral viaja para que el modelo pueda decir que el agrupamiento es
      // NUESTRO. Lo que el episodio afirma es cuántos documentos hubo y entre
      // qué fechas; quién ganó no está acá y no se puede deducir de acá.
      umbral_dias: ep.umbral_dias,
      citas: [orden[0].accession, orden[orden.length - 1].accession],
    });
  }

  const sueltos = eventos.filter((e) => !colapsados.has(e.accession) || anclas.has(e.accession));
  const elegidos = sueltos.slice(0, limite);

  // La distancia al papel anterior, ya contada, Y CONTRA QUÉ PAPEL. Sin el
  // accession, "45 días desde el anterior" es un número que el modelo no
  // puede citar y el lector no puede verificar. Con él se puede escribir "la
  // renuncia llegó nueve días después del [0001-26-9]".
  //
  // El anterior se busca en la línea COMPLETA, no en la recortada: si entre
  // los dos hubo treinta filings que se colapsaron en un episodio, decir
  // "45 días desde el anterior" sería cierto sobre el paquete y falso sobre
  // la empresa.
  const orden = new Map(eventos.map((e, i) => [e.accession, i]));
  // El glosario va UNA vez, arriba, y los eventos llevan solo el código.
  //
  // No es solo ahorro: "salida, nombramiento o compensación de directivos o
  // consejeros" son 60 caracteres que se repetían en cada 5.02 de la línea —
  // en un emisor con 120 filings, la mitad del peso del paquete eran glosas
  // copiadas. Y un diccionario al principio se lee mejor que la misma frase
  // pegada ciento veinte veces.
  const glosario = { items: {}, formas: {} };
  const anotarGlosas = (e) => {
    for (const g of [...(e.items_destacados_glosa || []), ...(e.items_secundarios_glosa || [])]) {
      if (g && g.codigo && g.glosa && !glosario.items[g.codigo]) glosario.items[g.codigo] = g.glosa;
    }
    const f = e.forma_glosa;
    if (f && f.codigo && f.glosa && !glosario.formas[f.codigo]) glosario.formas[f.codigo] = f.glosa;
  };

  const filas = elegidos.map((e) => {
    anotarGlosas(e);
    const previo = eventos[(orden.get(e.accession) ?? -1) + 1];
    const destacados = e.items_destacados && e.items_destacados.length ? e.items_destacados : e.items;
    const adjuntos = e.items_secundarios || [];
    return {
      fecha: e.filed,
      form: e.form,
      // Solo los códigos. La traducción está en el glosario, y es NUESTRA:
      // el título oficial de la SEC es una cita en inglés que el modelo no
      // debe parafrasear, así que no entra al prompt.
      items: destacados,
      // Los adjuntos solo cuando hay: `[]` repetido en 120 renglones es peso
      // sin información, y su ausencia dice lo mismo.
      ...(adjuntos.length ? { items_adjuntos: adjuntos } : {}),
      preguntas: e.preguntas || [],
      // Igual: la marca solo cuando es true. Un `false` en el 99% de los
      // renglones enseña ruido, no un hecho.
      ...(e.contraevidencia ? { contraevidencia: true } : {}),
      ...(previo
        ? { anterior: { accession: previo.accession, fecha: previo.filed, dias: diasEntre(previo.filed, e.filed) } }
        : {}),
      accession: e.accession,
    };
  });

  return {
    eventos: filas,
    episodios: resumenes,
    glosario,
    omitidos: sueltos.length - elegidos.length,
    colapsados: colapsados.size - anclas.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// El paquete
// ─────────────────────────────────────────────────────────────────────────
export function armarEvidencia(cuerpo, { limite = LIMITE_EVENTOS } = {}) {
  if (!cuerpo || cuerpo.estado !== 'ok') {
    // Sin ingesta no hay evidencia, y no hay una versión "chiquita" honesta
    // de eso. El caller corta; no se narra un emisor que no bajamos.
    return { version: VERSION_EVIDENCIA, estado: cuerpo ? cuerpo.estado : 'desconocido', narrable: false };
  }

  const linea = cuerpo.linea_de_tiempo || { eventos: [] };
  const secciones = cuerpo.secciones || [];
  const s2 = secciones.find((s) => s.pregunta === 2) || {};
  const s3 = secciones.find((s) => s.pregunta === 3) || {};
  const serie = s3.serie || [];

  const { eventos, episodios, glosario, omitidos, colapsados } = eventosParaPrompt(
    linea.eventos, s2.episodios || [], { limite },
  );

  const c = cuerpo.contraevidencia || {};
  const reexpresados = (c.periodos_reexpresados || []).map((p) => ({
    familia: p.familia,
    period_end: p.period_end,
    corregido_el: p.filed ?? null,
    // Cuánto tardó la corrección. Es el número que dice si la empresa se
    // corrigió al mes siguiente o dos años después, y nadie tiene que restar.
    dias_hasta_la_correccion: p.filed ? diasEntre(p.period_end, p.filed) : null,
    citas: [p.cita ? String(p.cita).replace(/^\[|\]$/g, '') : null].filter(Boolean),
  }));

  return {
    version: VERSION_EVIDENCIA,
    estado: 'ok',
    narrable: true,
    emisor: {
      cik: cuerpo.emisor.cik,
      ticker: cuerpo.ticker,
      nombre: cuerpo.emisor.nombre,
      forma_anual: cuerpo.emisor.forma_anual,
      cobertura: cuerpo.emisor.cobertura,
    },
    // El perímetro, dentro del paquete. Si el modelo no lo tiene, el "no hay
    // documentos" de la pregunta 4 se le va a leer como un hecho sobre la
    // empresa en vez de como uno sobre nosotros.
    preguntas: secciones.map((s) => ({
      pregunta: s.pregunta,
      id: s.id,
      estado: s.estado,
      documentos: (s.accessions || []).length,
      declaraciones: (s.declaraciones || []).map((d) => d.texto),
    })),
    linea: {
      total: linea.total ?? eventos.length,
      desde: linea.desde ?? null,
      hasta: linea.hasta ?? null,
      eventos,
      episodios,
      // El diccionario de los códigos que aparecen arriba. Una sola vez.
      glosario,
      // Los dos huecos, separados porque significan cosas distintas: uno es
      // "no cupo", el otro es "entró contado en vez de listado".
      omitidos_por_presupuesto: omitidos,
      colapsados_en_episodios: colapsados,
    },
    serie: serieParaPrompt(serie),
    razones: razonesDe(serie),
    contraevidencia: {
      estado: c.estado || 'sin_contraevidencia',
      accessions: c.accessions || [],
      periodos_reexpresados: reexpresados,
      declaraciones: (c.declaraciones || []).map((d) => d.texto),
    },
    no_cubierto: (cuerpo.no_cubierto || []).map((d) => d.texto),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// El inventario de lo citable
// ─────────────────────────────────────────────────────────────────────────
//
// La pieza sobre la que descansa el guard de citas (rebanada I): la lista
// cerrada de accessions que el modelo puede nombrar. Se construye RECORRIENDO
// el paquete, no en paralelo. Una segunda lista escrita a mano se separaría
// del paquete en el primer cambio y nadie lo notaría hasta que una cita
// válida quedara rechazada —o peor, una inválida aceptada.
const CLAVES_CITA = new Set(['accession', 'accession_aux', 'citas', 'accessions']);

export function accessionsDe(x, acc = new Set()) {
  if (!x || typeof x !== 'object') return acc;
  if (Array.isArray(x)) { for (const v of x) accessionsDe(v, acc); return acc; }
  for (const [k, v] of Object.entries(x)) {
    if (CLAVES_CITA.has(k)) {
      for (const s of (Array.isArray(v) ? v : [v])) {
        if (typeof s === 'string' && s.trim()) acc.add(s.trim().replace(/^\[|\]$/g, ''));
      }
    } else if (v && typeof v === 'object') accessionsDe(v, acc);
  }
  return acc;
}

// `cuerpo` aporta la metadata (forma, fecha, URL). Un accession del paquete
// sin metadata es un defecto del armado, no un dato: sale por `huerfanos`
// para que el caller lo vea, nunca en silencio. Sin URL no hay cita abrible,
// y una cita que no abre es un identificador bonito.
export function inventarioDe(paquete, cuerpo) {
  const meta = new Map();
  const anotar = (accession, datos) => {
    if (!accession) return;
    const a = String(accession).replace(/^\[|\]$/g, '');
    if (!meta.has(a)) meta.set(a, { accession: a, ...datos });
  };

  for (const e of ((cuerpo && cuerpo.linea_de_tiempo && cuerpo.linea_de_tiempo.eventos) || [])) {
    anotar(e.accession, { form: e.form, fecha: e.filed, url: e.url });
  }
  for (const s of (cuerpo && cuerpo.secciones) || []) {
    for (const p of s.serie || []) {
      anotar(p.accession, { form: p.form, fecha: p.filed, url: p.url });
      anotar(p.accession_aux, { form: null, fecha: null, url: p.url_aux });
    }
  }
  for (const p of ((cuerpo && cuerpo.contraevidencia && cuerpo.contraevidencia.periodos_reexpresados) || [])) {
    anotar(p.cita, { form: null, fecha: p.filed, url: p.url });
  }

  const usados = [...accessionsDe(paquete)].sort();
  const inventario = [];
  const huerfanos = [];
  for (const a of usados) {
    const m = meta.get(a);
    if (m && m.url) inventario.push(m);
    else huerfanos.push(a);
  }
  return { inventario, huerfanos };
}

// ─────────────────────────────────────────────────────────────────────────
// El hash: la historia cambia cuando cambia un filing
// ─────────────────────────────────────────────────────────────────────────
//
// Decisión 3 de la Fase B. La narración se guarda junto al hash de la
// evidencia que la produjo; si el hash coincide, se sirve la guardada y no se
// vuelve a llamar al modelo. Abrir la página no cambia nada — presentar un
// filing sí.
//
// Las claves se ordenan al serializar. Así el hash depende del CONTENIDO y no
// del orden en que se escribieron los campos: mover una línea en el armado no
// re-narra las cuatro mil empresas.
export function canonico(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x === undefined ? null : x);
  if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
  const claves = Object.keys(x).filter((k) => x[k] !== undefined).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonico(x[k])}`).join(',')}}`;
}

export const hashDe = (x) => createHash('sha256').update(canonico(x)).digest('hex').slice(0, 32);

export const hashEvidencia = (paquete) => hashDe(paquete);

// ─────────────────────────────────────────────────────────────────────────
// Lo que no se puede citar, no entra
// ─────────────────────────────────────────────────────────────────────────
//
// **La decisión, tomada antes de la llamada y no después.** Un hecho cuyo
// accession no resuelve a un documento abrible no tiene contra qué
// verificarse en el guard de citas. Hay dos salidas:
//
//   (a) marcarlo como "no citable" y dejarlo entrar, o
//   (b) sacarlo del paquete.
//
// Va la (b). La (a) le pide al prompt que cargue una segunda regla —"este
// dato lo podés mencionar pero no citar"— en un módulo cuya promesa entera es
// *toda afirmación lleva su accession*. Un hecho sin cita ahí no vale menos:
// no vale. Y una regla más en el prompt es una regla más que el modelo puede
// no seguir, con el guard rechazando después una frase que nosotros
// habilitamos.
//
// Lo que se saca se CUENTA y se declara en `excluidos_sin_cita`. Un hueco
// declarado es un dato; uno silencioso es un bug. Y como hoy `huerfanos`
// siempre sale vacío, cualquier cosa que aparezca acá es un defecto del
// armado —no de los datos— y tiene que verse.
//
// Un matiz que importa: si lo que no resuelve es el VECINO de un evento (su
// `anterior`), el evento se queda y lo que se cae es la referencia al vecino.
// Tirar un papel bueno porque el de al lado no abre sería pagar dos veces.
//
// **Y se cae ENTERA, no solo el accession.** La tentación es dejar el número
// de días sin la referencia —"45 días desde el anterior"— pero eso sería una
// afirmación que el modelo puede escribir y no puede citar, que es
// exactamente lo que este módulo no hace. Un evento sin `anterior` se lee
// igual que el más viejo de la ventana; lo que se perdió se cuenta en
// `excluidos.vecinos`, a nivel del paquete, donde sí se puede declarar.
//
// La invariante que sale de acá y que hay una prueba que la fija: **después
// de podar, ningún accession que el paquete nombre como cita puede quedar sin
// resolver en el inventario.** Vale para los eventos, los vecinos, las anclas
// de los episodios, las citas de la serie y las de la contraevidencia.
export function podarSinCita(paquete, huerfanos = []) {
  const malo = new Set(huerfanos);
  if (!malo.size || !paquete || !paquete.narrable) return { paquete, excluidos: null };

  const limpio = (x) => !(x.citas || []).some((c) => malo.has(c));
  const linea = paquete.linea || {};
  const eventos = (linea.eventos || [])
    .filter((e) => !malo.has(e.accession))
    .map((e) => (e.anterior && malo.has(e.anterior.accession)
      ? (({ anterior, ...resto }) => resto)(e)
      : e));
  const episodios = (linea.episodios || []).filter(limpio);
  const serie = (paquete.serie || []).filter(limpio);
  const razones = (paquete.razones || []).filter(limpio);
  const c = paquete.contraevidencia || {};
  const reexpresados = (c.periodos_reexpresados || []).filter(limpio);

  const sobrevivientes = (linea.eventos || []).filter((e) => !malo.has(e.accession));
  const excluidos = {
    eventos: (linea.eventos || []).length - eventos.length,
    episodios: (linea.episodios || []).length - episodios.length,
    serie: (paquete.serie || []).length - serie.length,
    razones: (paquete.razones || []).length - razones.length,
    periodos_reexpresados: (c.periodos_reexpresados || []).length - reexpresados.length,
    // Sobre los que SOBREVIVEN. Contar sobre la lista original sumaría los
    // eventos que se podaron enteros, y el mismo papel quedaría contado dos
    // veces: una como evento excluido y otra como vecino perdido.
    vecinos: sobrevivientes.filter((e) => e.anterior && malo.has(e.anterior.accession)).length,
    // OJO con el nombre. Esta lista DECLARA lo que se sacó por no ser
    // citable; si se llamara `accessions`, `accessionsDe` la recorrería como
    // si fuera una cita y el huérfano volvería a entrar al inventario — que
    // es justo lo contrario de lo que esta función hace. El nombre distinto
    // no es cosmético: es lo que separa una cita de un descargo.
    accessions_excluidos: [...malo].sort(),
  };

  return {
    paquete: {
      ...paquete,
      linea: { ...linea, eventos, episodios, excluidos_sin_cita: excluidos },
      serie,
      razones,
      contraevidencia: {
        ...c,
        accessions: (c.accessions || []).filter((a) => !malo.has(a)),
        periodos_reexpresados: reexpresados,
      },
    },
    excluidos,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// La respuesta de la puerta de inspección
// ─────────────────────────────────────────────────────────────────────────
//
// Vive acá y no en el endpoint por la misma razón que `armarHistoria`: el
// endpoint es cableado HTTP y lo que se puede probar sin una base de datos se
// prueba sin una base de datos. Meterle un seam de prueba al handler habría
// sido una puerta trasera en producción para ahorrarse una función.
export function respuestaEvidencia(cuerpo, { ticker = null, limite = LIMITE_EVENTOS } = {}) {
  const crudo = armarEvidencia(cuerpo, { limite });
  const { huerfanos } = inventarioDe(crudo, cuerpo);
  // Se poda ANTES de cualquier cosa: lo que no se puede citar no entra al
  // paquete, así que tampoco entra al hash ni al prompt.
  const { paquete: evidencia, excluidos } = podarSinCita(crudo, huerfanos);
  const { inventario } = inventarioDe(evidencia, cuerpo);
  return {
    ticker: ticker || (cuerpo && cuerpo.ticker) || null,
    narrable: evidencia.narrable,
    // Lo que se sacó por no tener contra qué verificarse. `null` cuando no se
    // sacó nada, que es lo normal: un huérfano es un defecto del armado.
    excluidos_sin_cita: excluidos,
    // El hash con el que se guarda la narración: la historia cambia cuando
    // cambia un filing, no cuando alguien abre la página.
    hash: evidencia.narrable ? hashEvidencia(evidencia) : null,
    // El presupuesto, medido y no estimado.
    bytes: Buffer.byteLength(canonico(evidencia), 'utf8'),
    // La lista cerrada de lo citable. Un huérfano es un defecto del armado,
    // no un dato: se ve acá antes de que llegue al guard de la rebanada I.
    inventario,
    huerfanos,
    evidencia,
  };
}
