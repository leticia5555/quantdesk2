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

function xtag(block, tag) {
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

function xval(block, tag) {
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
export const CODIGOS = {
  P: { tipo: 'compra', nombre: 'Compra en mercado abierto' },
  S: { tipo: 'venta', nombre: 'Venta en mercado abierto' },
  D: { tipo: 'venta', nombre: 'Venta a la emisora' },
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
    plan_10b5: /^(1|true)$/i.test(xval(s, 'aff10b5One')),
    transacciones: [
      ...transaccionesDeBloques(noDeriv, false),
      ...transaccionesDeBloques(deriv, true),
    ],
  };
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
    ...t,
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
      });
    }
    const g = porTicker.get(k);
    g.personas.add(f.quien || '?');
    if (f.tipo === 'compra') g.compras++;
    if (f.tipo === 'venta') g.ventas++;
    if (Number.isFinite(f.valor) && (f.tipo === 'compra' || f.tipo === 'venta')) {
      g.neto_usd += f.tipo === 'compra' ? f.valor : -f.valor;
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
  grupos.sort((a, b) => Math.abs(b.neto_usd || 0) - Math.abs(a.neto_usd || 0));
  return { grupos: grupos.slice(0, tope), tickers: grupos.length, sin_valor: sinValor };
}

/** Los chips de la pantalla. `venta_propuesta` NO tiene fuente todavía. */
export const CHIPS = [
  { id: 'compra', nombre: 'Compras', tipos: ['compra'] },
  { id: 'venta', nombre: 'Ventas', tipos: ['venta'] },
  { id: 'opcion', nombre: 'Opciones', tipos: ['opcion'] },
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
