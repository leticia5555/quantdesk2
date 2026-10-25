// ═══════════════════════════════════════════════════════════════════════
// api/_lib/form4.js — R5: TODAS las transacciones de un Form 4.
//
// POR QUÉ EXISTE, si `stock-tracker.js` ya parsea Form 4. Ese parser hace
// una cosa muy concreta y la hace bien: encontrar COMPRAS DESTACADAS —
// `code === 'P'`, adquiridas, de un oficial o director, ≥ $100k—. Es el
// filtro de la tarjeta de TRACKER y no se toca.
//
// R5 pide lo contrario: "default Todas las transacciones", con los códigos
// A/S/M/F/P y con la columna "le quedan". Eso NO es aflojar el filtro del
// otro: es otra lectura del mismo documento. Vivir en un archivo aparte es
// lo que permite que la tarjeta de TRACKER siga midiendo exactamente lo
// mismo que ayer mientras la pantalla nueva ve todo.
//
// PURO: entra XML, salen filas. Ni red, ni Neon, ni reloj.
//
// LA CICATRIZ QUE SE HEREDA: el tamaño de una transacción es lo que SE MUEVE
// (`transactionShares`), nunca la tenencia resultante. Confundirlas infló un
// renglón de TSLA a $287 mil millones. Acá la tenencia resultante viaja
// aparte y con su propio nombre: `le_quedan`.
// ═══════════════════════════════════════════════════════════════════════

// ── UN SOLO PAR DE ACCESORES PARA TODO EL REPO ──────────────────────────
// `xtag` saca un TROZO de XML y se queda CRUDO a propósito: si decodificara,
// un `&lt;foo&gt;` del texto se volvería `<foo>` y el regex siguiente casaría
// una etiqueta que el filing no tenía. El decodificado va en la HOJA, o sea
// en `xval`, que es lo que devuelve texto para leer.
//
// Estaban duplicados en `api/stock-tracker.js`, idénticos. Por eso arreglar
// el doble escape en uno dejó el otro intacto y la pantalla siguió mostrando
// `&amp;` después de limpiar la base (Lety, 2026-10-21): el endpoint de la
// pantalla mezcla lo de Neon con un acumulador en memoria que llena el
// escaneo vivo, y el escaneo vivo usaba la copia sin arreglar.
export function xtag(block, tag) {
  const m = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>', 'i').exec(block);
  return m ? m[1].trim() : '';
}
/**
 * LAS ENTIDADES DEL XML SE DECODIFICAN ACÁ, UNA SOLA VEZ.
 *
 * Lety, mirando `/mercado/insiders` en producción (2026-10-20): el cargo
 * salía *"EVP, CFO &amp;amp; COO"*. El Form 4 trae `&amp;amp;` —es XML, ahí un
 * `&amp;` se escribe así—, `xval` lo devolvía tal cual, se guardaba tal cual, y
 * la pantalla lo escapaba OTRA VEZ al pintarlo: `&amp;` → `&amp;amp;`. Doble
 * escape, y el usuario leyendo la segunda capa.
 *
 * El arreglo va en `xval` y no en la pantalla a propósito: lo que se guarda
 * tiene que ser el texto REAL ("EVP, CFO & COO"), y escapar al pintar es
 * correcto —es lo que impide que un titular con `<script>` se ejecute—. Si se
 * arreglara en la pantalla, la base quedaría con basura y cualquier otro
 * consumidor —el PNG de compartir, un export— heredaría el problema.
 *
 * NO afecta sólo al cargo: los nombres de emisora con `&` son de lo más
 * común (AT&T, Procter & Gamble), y salían igual de mal.
 *
 * `&amp;amp;` se decodifica AL FINAL. Si se hiciera primero, `&amp;amp;lt;`
 * —que es la forma de escribir un `&lt;` literal— terminaría convertido en
 * `<` y habríamos inventado una etiqueta que el filing no tenía.
 */
export function desentidad(s) {
  return String(s)
    .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|lt|gt|quot|apos|nbsp);/g, (m, dec, hex) => {
      // UNA NUMÉRICA QUE DA UN CARÁCTER DE CONTROL SE QUEDA COMO TEXTO.
      // `&#0;` decodificado es un NUL, y un NUL no se puede guardar en un
      // `jsonb` de Postgres —"unsupported Unicode escape sequence"—: la
      // escritura entera falla. Dejarlo como el texto que vino es la opción
      // que no pierde nada y no rompe nada.
      const cp = dec ? Number(dec) : (hex ? parseInt(hex, 16) : NaN);
      if (Number.isFinite(cp)) {
        if (cp === 9 || cp === 10 || cp === 13) return String.fromCodePoint(cp);
        if (cp < 32 || cp === 127 || cp > 0x10ffff) return m;
        return String.fromCodePoint(cp);
      }
      return { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[m] || m;
    })
    .replace(/&amp;/g, '&');
}

export function xval(block, tag) {
  const inner = xtag(block, tag);
  const v = xtag(inner, 'value');
  return desentidad((v || inner).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

/**
 * El código de la SEC → qué pasó, en español y en una palabra.
 *
 * Los códigos están en la tabla del Form 4. Lo que NO se hace es adivinar por
 * el signo cuando el código es desconocido: un código que no conocemos se
 * reporta como lo que es —`otro`, con su letra— para que se pueda buscar y
 * agregar. "Adivinado por el signo" es como una compra de un plan de empleados
 * termina contada como compra de mercado abierto.
 */
// ── SÓLO LA `S` ES UNA VENTA EN EL MERCADO ───────────────────────────
// Acá `D` decía `tipo: 'venta'`, y por eso ATKR salía con 15 personas que
// "vendieron todo", 38 ventas y −$60.81 M en la semana: era el cierre de una
// fusión. `D` es una disposición A LA EMISORA (Rule 16b-3(e)) —lo que pasa
// cuando una fusión paga en efectivo las acciones—, y `F` son acciones
// retenidas para pagar impuestos de un vesting. En las dos el insider
// entrega papel, pero NINGUNA es alguien decidiendo vender en el mercado,
// que es lo único que esta pantalla viene a mostrar (Lety, 2026-10-23).
//
// No desaparecen: cambian de tipo, se cuentan aparte y tienen su chip. Lo que
// no pueden es sumar al neto ni empujar un ticker al Top de la semana.
export const CODIGOS = {
  P: { tipo: 'compra', nombre: 'Compra en mercado abierto' },
  S: { tipo: 'venta', nombre: 'Venta en mercado abierto' },
  D: { tipo: 'entrega_emisora', nombre: 'Entregó a la emisora (fusión o recompra forzada)' },
  A: { tipo: 'otorgado', nombre: 'Otorgamiento o premio' },
  M: { tipo: 'opcion', nombre: 'Ejercicio de opción' },
  X: { tipo: 'opcion', nombre: 'Ejercicio de opción en el dinero' },
  C: { tipo: 'opcion', nombre: 'Conversión' },
  F: { tipo: 'impuesto', nombre: 'Acciones retenidas para impuestos' },
  G: { tipo: 'regalo', nombre: 'Regalo' },
  J: { tipo: 'otro', nombre: 'Otra adquisición o disposición' },
  K: { tipo: 'otro', nombre: 'Operación con instrumento vinculado' },
  V: { tipo: 'otro', nombre: 'Transacción reportada voluntariamente' },
};

export function tipoDeCodigo(code) {
  const c = String(code || '').toUpperCase();
  const d = CODIGOS[c];
  if (d) return { codigo: c, ...d };
  return { codigo: c || null, tipo: 'otro', nombre: c ? `Código ${c}, sin descripción conocida` : 'Sin código declarado' };
}

/** Los dueños que reporta el filing, con su cargo REAL (no inferido). */
export function duenosDe(xml) {
  return (String(xml).match(/<(?:\w+:)?reportingOwner>[\s\S]*?<\/(?:\w+:)?reportingOwner>/gi) || []).map((b) => {
    const si = (tag) => /^(1|true)$/i.test(xval(b, tag));
    const esDirector = si('isDirector');
    const esOficial = si('isOfficer');
    const esDiez = si('isTenPercentOwner');
    const titulo = xval(b, 'officerTitle') || null;
    return {
      nombre: xval(b, 'rptOwnerName') || null,
      cik: xval(b, 'rptOwnerCik') || null,
      es_director: esDirector,
      es_oficial: esOficial,
      es_duenio_10: esDiez,
      // El cargo que SE DECLARA. Sin `officerTitle`, se dice el rol que marcó
      // el filing — y si no marcó ninguno, se dice eso, no "Insider".
      cargo: titulo || (esDirector ? 'Director' : (esOficial ? 'Oficial' : (esDiez ? 'Dueño del 10%' : null))),
      cargo_motivo: titulo ? null : (esDirector || esOficial || esDiez ? 'el filing no declaró el puesto, sólo el rol' : 'el filing no declaró rol ni puesto'),
    };
  });
}

function transaccionesDeBloques(bloques, derivada) {
  return bloques.map((b) => {
    const code = xval(b, 'transactionCode');
    const ad = (xval(b, 'transactionAcquiredDisposedCode') || '').toUpperCase();
    const acciones = num(xval(b, 'transactionShares'));
    const precio = num(xval(b, 'transactionPricePerShare'));
    const post = xtag(b, 'postTransactionAmounts');
    const own = xtag(b, 'ownershipNature');
    const dio = (xval(own, 'directOrIndirectOwnership') || '').toUpperCase();
    // ── "LE QUEDAN" ────────────────────────────────────────────────────
    // `sharesOwnedFollowingTransaction` es la tenencia DESPUÉS, y es el dato
    // que hace que "vendió todo" se pueda afirmar. Cuando el filing no lo
    // trae, va null CON su causa: un 0 inventado diría que el insider se
    // salió por completo, que es la afirmación más fuerte de la pantalla.
    const quedanRaw = xval(post, 'sharesOwnedFollowingTransaction');
    const quedan = quedanRaw === '' ? null : num(quedanRaw);
    return {
      ...tipoDeCodigo(code),
      derivada,
      adquirida: ad === 'A' ? true : (ad === 'D' ? false : null),
      fecha: xval(b, 'transactionDate') || null,
      acciones,
      precio,
      // El VALOR es lo que se movió por su precio. Nunca la tenencia.
      valor: acciones != null && precio != null ? acciones * precio : null,
      valor_motivo: acciones != null && precio != null ? null
        : (acciones == null ? 'el filing no declaró acciones' : 'el filing no declaró precio (suele ser un otorgamiento o un regalo)'),
      le_quedan: quedan,
      le_quedan_motivo: quedan == null ? 'el filing no declaró la tenencia posterior' : null,
      // "Vendió todo" SÓLO se puede afirmar con el dato en la mano.
      salio_del_todo: quedan === 0,
      titulo: xval(b, 'securityTitle') || null,
      indirecta: dio === 'I',
      naturaleza: dio === 'I' ? (xval(own, 'natureOfOwnership') || null) : null,
    };
  });
}

/**
 * Un Form 4 → TODAS sus transacciones, con dueños y emisora.
 *
 * Devuelve null si el XML no es un Form 4: "no es un ownershipDocument" y
 * "es un Form 4 sin transacciones" son cosas distintas, y la segunda SÍ pasa
 * (un filing que sólo reporta tenencias).
 */
export function form4Completo(xml) {
  const s = String(xml || '');
  if (!/<(?:\w+:)?ownershipDocument/i.test(s)) return null;
  const ib = xtag(s, 'issuer');
  const ticker = (xval(ib, 'issuerTradingSymbol') || '').toUpperCase();
  const noDeriv = s.match(/<(?:\w+:)?nonDerivativeTransaction>[\s\S]*?<\/(?:\w+:)?nonDerivativeTransaction>/gi) || [];
  const deriv = s.match(/<(?:\w+:)?derivativeTransaction>[\s\S]*?<\/(?:\w+:)?derivativeTransaction>/gi) || [];
  return {
    emisora: {
      nombre: xval(ib, 'issuerName') || null,
      ticker: (ticker === 'N/A' || ticker === 'NONE') ? null : (ticker || null),
      cik: xval(ib, 'issuerCik') || null,
    },
    duenos: duenosDe(s),
    plan: planDeForm4(s),
    // Se conserva el booleano para quien ya lo leía, pero la pantalla usa
    // `plan.estado`: `false` acá NO quiere decir "no programada".
    plan_10b5: planDeForm4(s).estado === PLAN_10B5.PROGRAMADA,
    transacciones: [
      ...transaccionesDeBloques(noDeriv, false),
      ...transaccionesDeBloques(deriv, true),
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ¿FUE UNA VENTA PROGRAMADA? (plan 10b5-1)
//
// Un plan 10b5-1 se adopta con meses de anticipación y las ventas salen
// solas, en fechas fijadas de antemano. Leerlas como "el CEO vendió" es leer
// una decisión donde hubo un calendario. Slootman vendió $94.93 M el
// 2026-10-19 bajo un plan que adoptó el 19 de septiembre de 2025 — trece
// meses antes (Lety, 2026-10-23).
//
// TRES ESTADOS, NO DOS. `sin_dato` existe porque la casilla del encabezado
// (`aff10b5One`) sólo aparece en los formularios desde abril de 2023: en uno
// anterior, "no viene marcada" no quiere decir "no fue programada", quiere
// decir que el formulario no tenía dónde decirlo. Un booleano convertía esa
// ausencia en una afirmación — "no programada" por descarte, que es justo lo
// que el encargo prohíbe.
//
// EL ORDEN DE LAS FUENTES, y por qué:
//   1. la casilla marcada → programada. Es una declaración del firmante en
//      el encabezado, bajo la misma firma que el resto del documento;
//   2. la casilla SIN marcar, pero una nota al pie que menciona 10b5-1 →
//      programada igual. La nota es una afirmación; la casilla vacía puede
//      ser un descuido del que llenó el formulario, y entre un dato que
//      AFIRMA y uno que CALLA, manda el que afirma;
//   3. la casilla sin marcar y ninguna nota → no programada, y acá sí se
//      puede decir: el formulario tenía dónde declararlo y no lo declaró;
//   4. sin casilla en el documento y sin nota → `sin_dato`.
// ═══════════════════════════════════════════════════════════════════════
export const PLAN_10B5 = { PROGRAMADA: 'programada', NO: 'no_programada', SIN_DATO: 'sin_dato' };

const MESES_EN = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/** "September 19, 2025" o "9/19/2025" → "2025-09-19". null si no se entiende. */
export function fechaDeAdopcion(texto) {
  const t = String(texto || '');
  const m1 = new RegExp('(' + MESES_EN.join('|') + ')\\s+(\\d{1,2}),?\\s+(\\d{4})', 'i').exec(t);
  if (m1) {
    const mes = MESES_EN.indexOf(m1[1].toLowerCase()) + 1;
    return `${m1[3]}-${String(mes).padStart(2, '0')}-${String(Number(m1[2])).padStart(2, '0')}`;
  }
  const m2 = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  if (m2) return `${m2[3]}-${String(Number(m2[1])).padStart(2, '0')}-${String(Number(m2[2])).padStart(2, '0')}`;
  return null;
}

export function planDeForm4(xml) {
  const s = String(xml || '');
  // ── ¿EXISTE LA ETIQUETA, O SÓLO ESTÁ VACÍA? ────────────────────────
  // Hace falta distinguirlo: un documento SIN la casilla (anterior a abril de
  // 2023) no es lo mismo que uno con la casilla en 0. `xtag` no sirve para
  // preguntarlo —devuelve `''` tanto para "no está" como para "está vacía"—,
  // así que se busca la etiqueta en el texto. Lo encontró la prueba del
  // `sin_dato`: con `xtag(...) != null`, un filing sin casilla salía
  // "no programada", que es la afirmación por descarte que el encargo
  // prohíbe. El tipo de `xtag` me hizo creer que ya lo tenía resuelto.
  const hayCasilla = /<(?:\w+:)?aff10b5One[\s>]/i.test(s);
  const marcada = hayCasilla && /^(1|true)$/i.test(xval(s, 'aff10b5One'));

  // `<footnote(\s…)?>` y NO `<footnote[^>]*>`: el segundo también casa con
  // `<footnoteId id="F1"/>`, que es la REFERENCIA inline dentro de una
  // transacción, no la nota. Con eso el "texto de la nota" salía siendo medio
  // documento —precios, códigos y cantidades— y la fecha de adopción se
  // sacaba de cualquier lado. Lo marcó el fixture real de SNOW.
  const notas = (s.match(/<footnote(?:\s[^>]*)?>[\s\S]*?<\/footnote>/gi) || [])
    .map((n) => desentidad(n.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  const nota = notas.find((n) => /10b5-?1/i.test(n)) || null;

  if (marcada) {
    return { estado: PLAN_10B5.PROGRAMADA, fuente: 'casilla del encabezado',
      adoptado_en: nota ? fechaDeAdopcion(nota) : null, nota };
  }
  if (nota) {
    return { estado: PLAN_10B5.PROGRAMADA,
      fuente: hayCasilla ? 'nota al pie (la casilla no venía marcada)' : 'nota al pie',
      adoptado_en: fechaDeAdopcion(nota), nota };
  }
  if (hayCasilla) {
    return { estado: PLAN_10B5.NO, fuente: 'casilla del encabezado, sin marcar',
      adoptado_en: null, nota: null };
  }
  return { estado: PLAN_10B5.SIN_DATO,
    fuente: null, adoptado_en: null, nota: null,
    motivo: 'el formulario no trae la casilla de 10b5-1 (es anterior a abril de 2023) y ninguna nota la menciona' }; /* date-lint-ok: la fecha en que la SEC agregó la casilla al Form 4, un hecho fijo — no es una referencia a "hoy" */
}

/**
 * LO QUE LE QUEDA DESPUÉS DE TODO, para poder decir "vendió todo".
 *
 * `sharesOwnedFollowingTransaction` es POR TENENCIA, no por persona: una línea
 * que deja un fideicomiso en cero decía "vendió todo" mientras el firmante
 * seguía con acciones en otros cuatro y con millones en opciones. A Slootman
 * le quedan 19.024 acciones directas y 3.836.655 opciones, y el Form 4 lo
 * dice — pero había que sumarlo (Lety, 2026-10-23).
 *
 * Se agrupa por tenencia (título + directa/indirecta + naturaleza), se toma la
 * ÚLTIMA línea de cada grupo y se suman. Derivadas aparte: vender todas las
 * acciones y quedarse con las opciones no es salirse.
 */
export function tenenciaFinal(transacciones = []) {
  const ultima = new Map();
  for (const t of transacciones) {
    const k = [t.derivada ? 'D' : 'N', t.titulo || '', t.indirecta ? 'I' : 'X', t.naturaleza || ''].join('|');
    ultima.set(k, t);   // el orden del documento manda: la última gana
  }
  let acciones = 0, derivados = 0, sinDato = 0;
  for (const t of ultima.values()) {
    if (t.le_quedan == null) { sinDato++; continue; }
    if (t.derivada) derivados += t.le_quedan; else acciones += t.le_quedan;
  }
  return {
    acciones, derivados, tenencias: ultima.size, sin_dato: sinDato,
    // Con una tenencia sin declarar NO se puede afirmar que no queda nada.
    salio_del_todo: sinDato === 0 && acciones === 0 && derivados === 0,
    motivo: sinDato ? `${sinDato} tenencia(s) no declararon lo que queda después` : null,
  };
}

/**
 * EJERCIÓ Y VENDIÓ EL MISMO DÍA.
 *
 * No es lo mismo que vender acciones que ya se tenían: es convertir opciones
 * en efectivo sin pasar por tener la acción. En el Form 4 son dos filas (M y
 * S) que la pantalla mostraba sueltas, como si fueran dos decisiones.
 *
 * Se compara por SUMA y no línea a línea: Slootman ejerció 300.000 en dos
 * líneas y vendió 300.000 en diez. Ninguna pareja coincide; los totales sí.
 */
export function ejercicioYVenta(transacciones = []) {
  const porFecha = new Map();
  for (const t of transacciones) {
    if (t.derivada || !t.fecha || t.acciones == null) continue;
    if (t.codigo !== 'M' && t.codigo !== 'S') continue;
    if (!porFecha.has(t.fecha)) porFecha.set(t.fecha, { M: 0, S: 0 });
    porFecha.get(t.fecha)[t.codigo] += t.acciones;
  }
  for (const [fecha, g] of porFecha) {
    if (g.M > 0 && g.M === g.S) return { hubo: true, fecha, acciones: g.M };
  }
  return { hubo: false, fecha: null, acciones: null };
}

/**
 * El documento → una fila por transacción, lista para la tabla.
 *
 * Un Form 4 puede traer varias transacciones y varios dueños. Cuando hay más
 * de un dueño se usa el PRIMERO que declaró un rol y se dice cuántos más
 * firman: inventar una fila por cada combinación multiplicaría el mismo
 * hecho por tres.
 */
export function filasDeForm4(doc, meta = {}) {
  if (!doc) return [];
  const lider = doc.duenos.find((o) => o.es_oficial || o.es_director || o.es_duenio_10) || doc.duenos[0] || null;
  const tenencia = tenenciaFinal(doc.transacciones);
  const combo = ejercicioYVenta(doc.transacciones);
  return doc.transacciones.map((t, i) => ({
    id: `${meta.accession || 'sin-accession'}#${i}`,
    accession: meta.accession || null,
    ticker: doc.emisora.ticker,
    emisora: doc.emisora.nombre,
    emisora_cik: doc.emisora.cik,
    quien: lider ? lider.nombre : null,
    quien_cik: lider ? lider.cik : null,
    cargo: lider ? lider.cargo : null,
    cargo_motivo: lider ? lider.cargo_motivo : 'el filing no declaró dueños',
    es_duenio_10: !!(lider && lider.es_duenio_10),
    firmantes: doc.duenos.length,
    plan_10b5: doc.plan_10b5,
    // El plan completo, con sus tres estados y la fecha de adopción si la
    // nota la trae. La pantalla ordena por esto.
    plan_estado: (doc.plan || {}).estado || PLAN_10B5.SIN_DATO,
    plan_adoptado_en: (doc.plan || {}).adoptado_en || null,
    plan_fuente: (doc.plan || {}).fuente || null,
    ...t,
    // ── DOS COSAS QUE SON DEL DOCUMENTO, NO DE LA LÍNEA ───────────────
    // `salio_del_todo` venía de `le_quedan === 0` de ESA línea, y
    // `sharesOwnedFollowingTransaction` es por TENENCIA: una línea que deja
    // un fideicomiso en cero decía "vendió todo" con el firmante todavía
    // adentro. Se recalcula sumando todas las tenencias del filing.
    salio_del_todo: tenencia.salio_del_todo,
    salio_del_todo_motivo: tenencia.motivo,
    le_quedan_total: tenencia.acciones,
    le_quedan_derivados: tenencia.derivados,
    // Ejercer y vender el mismo día no es vender acciones que ya se tenían.
    ejercio_y_vendio: combo.hubo && !t.derivada && (t.codigo === 'M' || t.codigo === 'S')
      && t.fecha === combo.fecha,
    ejercio_y_vendio_acciones: combo.hubo ? combo.acciones : null,
    // La hora de ACEPTACIÓN del filing, que es por lo que ordena la pantalla.
    // No es la fecha de la operación: entre una y otra hay hasta dos días
    // hábiles, y mezclarlas desordena la lista.
    filing_en: meta.updated || null,
    filing_fecha: meta.updated ? String(meta.updated).slice(0, 10) : null,
    link: meta.link || null,
  }));
}

/**
 * EL TOP DE LA SEMANA POR TICKER: neto en dólares, conteos y "vendió todo".
 *
 * El neto suma compras y resta ventas, y SÓLO cuenta lo que tiene valor: un
 * otorgamiento sin precio no es dinero que entró ni salió, y meterlo con
 * precio 0 ensuciaría el neto sin que se note.
 *
 * `vendio_todo` es por PERSONA, no por ticker: que un director se salga no
 * significa que la mesa entera lo haya hecho.
 */
export function topDeLaSemana(filas, { tope = 8 } = {}) {
  const porTicker = new Map();
  let sinValor = 0;
  for (const f of filas || []) {
    const k = f.ticker || f.emisora || '—';
    if (!porTicker.has(k)) {
      porTicker.set(k, {
        ticker: f.ticker, emisora: f.emisora,
        neto_usd: 0, compras: 0, ventas: 0, personas: new Set(),
        vendio_todo: [], con_valor: 0, sin_valor: 0,
        // ── PROGRAMADAS APARTE ────────────────────────────────────────
        // Una venta bajo un plan 10b5-1 se fijó con meses de anticipación:
        // leerla junto a una decisión de hoy es mezclar un calendario con
        // una señal. No se esconde —sigue en el neto total— pero el orden lo
        // decide lo NO programado (Lety, 2026-10-23).
        neto_no_programado: 0, neto_programado: 0,
        programadas: 0, no_programadas: 0, sin_dato_plan: 0,
      });
    }
    const g = porTicker.get(k);
    g.personas.add(f.quien || '?');
    if (f.tipo === 'compra') g.compras++;
    if (f.tipo === 'venta') g.ventas++;
    if (f.tipo === 'compra' || f.tipo === 'venta') {
      if (f.plan_estado === PLAN_10B5.PROGRAMADA) g.programadas++;
      else if (f.plan_estado === PLAN_10B5.NO) g.no_programadas++;
      else g.sin_dato_plan++;
    }
    if (Number.isFinite(f.valor) && (f.tipo === 'compra' || f.tipo === 'venta')) {
      const firmado = f.tipo === 'compra' ? f.valor : -f.valor;
      g.neto_usd += firmado;
      // `sin_dato` NO cuenta como no programada: no sabemos qué fue, y
      // meterlo del lado de las decisiones sería la misma afirmación por
      // descarte que el encargo prohíbe.
      if (f.plan_estado === PLAN_10B5.PROGRAMADA) g.neto_programado += firmado;
      else if (f.plan_estado === PLAN_10B5.NO) g.neto_no_programado += firmado;
      g.con_valor++;
    } else if (f.tipo === 'compra' || f.tipo === 'venta') {
      g.sin_valor++; sinValor++;
    }
    if (f.salio_del_todo && f.quien && !g.vendio_todo.includes(f.quien)) g.vendio_todo.push(f.quien);
  }
  const grupos = [...porTicker.values()].map((g) => ({
    ...g, personas: g.personas.size,
    // Sólo se afirma si hubo al menos una operación con valor.
    neto_usd: g.con_valor ? g.neto_usd : null,
    neto_motivo: g.con_valor ? null : 'ninguna compra ni venta del periodo declaró precio',
  }));
  // ── PRIMERO LO QUE NO SABEMOS QUE ESTABA PROGRAMADO ──────────────────
  // Un ticker cuyo movimiento entero salió de un plan adoptado hace un año no
  // encabeza la semana por tamaño: el tamaño ya estaba decidido.
  //
  // Pero el criterio NO puede ser "primero las `no_programada`". Lo midió una
  // prueba: con eso, un filing viejo —sin la casilla, o sea `sin_dato`— caía
  // DEBAJO de cualquier otro con la casilla en blanco, por grande que fuera
  // su neto. Enterrar un movimiento porque su formulario es anterior a 2023 es
  // la misma afirmación por descarte que el encargo prohíbe, sólo que en el
  // orden en vez de en la etiqueta.
  //
  // Así que se descuenta SÓLO lo que consta programado. `sin_dato` pesa como
  // lo que es: algo que no sabemos, y que por lo tanto todavía puede importar.
  const pesoDe = (g) => Math.abs((g.neto_usd || 0) - (g.neto_programado || 0));
  grupos.sort((a, b) => {
    const d = pesoDe(b) - pesoDe(a);
    return d !== 0 ? d : Math.abs(b.neto_usd || 0) - Math.abs(a.neto_usd || 0);
  });
  return { grupos: grupos.slice(0, tope), tickers: grupos.length, sin_valor: sinValor };
}

/** Los chips de la pantalla. `venta_propuesta` NO tiene fuente todavía. */
export const CHIPS = [
  { id: 'compra', nombre: 'Compras', tipos: ['compra'] },
  { id: 'venta', nombre: 'Ventas', tipos: ['venta'] },
  { id: 'opcion', nombre: 'Opciones', tipos: ['opcion'] },
  // Las dos que NO son decisiones de vender. Tienen chip propio para que se
  // puedan ver, pero no entran al neto ni al Top: ver el comentario de
  // `CODIGOS`.
  { id: 'entrega_emisora', nombre: 'Entregó en fusión', tipos: ['entrega_emisora'] },
  { id: 'impuesto', nombre: 'Retención fiscal', tipos: ['impuesto'] },
  // El Form 4 reporta lo que YA pasó. Una venta PROPUESTA es un Form 144,
  // que es otro documento y que hoy no cosechamos. El chip existe —está en
  // el artboard— y va punteado con su causa, como Cripto y ETFs en el mapa.
  { id: 'venta_propuesta', nombre: 'Venta propuesta', tipos: [], sin_fuente: true,
    motivo: 'la venta propuesta se reporta en el Form 144, que todavía no cosechamos' },
  { id: 'duenio_10', nombre: 'Dueño 10%', tipos: null, por_duenio: true },
];

export function filtraFilas(filas, { chips = [], q = '' } = {}) {
  const activos = CHIPS.filter((c) => chips.includes(c.id) && !c.sin_fuente);
  const aguja = String(q || '').trim().toUpperCase();
  return (filas || []).filter((f) => {
    if (activos.length) {
      const porTipo = activos.some((c) => c.tipos && c.tipos.includes(f.tipo));
      const porDuenio = activos.some((c) => c.por_duenio) && f.es_duenio_10;
      if (!porTipo && !porDuenio) return false;
    }
    if (aguja) {
      const heno = [f.ticker, f.emisora, f.quien, f.cargo].filter(Boolean).join(' ').toUpperCase();
      if (!heno.includes(aguja)) return false;
    }
    return true;
  });
}
