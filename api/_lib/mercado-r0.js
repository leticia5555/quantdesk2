// ═══════════════════════════════════════════════════════════════════
// api/_lib/mercado-r0.js — R0: cimientos del mapa. Lógica PURA.
//
// R0 existe para abrir las dos compuertas que la Fase 0 dejó rojas y que sí
// dependen de datos nuestros (docs/mercado-r0.md):
//
//   G1 — universo US con sector y cap precomputados.
//   G2 — capitalización MX correcta, o sea: la trampa de las unidades.
//
// G9 (Form 4) NO se toca acá: sigue siendo el pipeline de R5.
//
// Todo lo de este archivo es puro —sin fetch, sin DB, sin Date.now()— por la
// misma razón que el medidor de la Fase 0: el sandbox donde se escribe no
// llega a Neon ni a DataBursatil, y un medidor sin probar es cómo la Fase 0
// del Congreso perdió dos corridas.
// ═══════════════════════════════════════════════════════════════════

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const up = (s) => String(s || '').trim().toUpperCase();

// ═══════════════════════════════════════════════════════════════════
// R0(b) — la trampa de las unidades, resuelta con un divisor
// ═══════════════════════════════════════════════════════════════════

/**
 * La fórmula del encargo:
 *
 *   cap = acciones_circulacion × precio_serie_liquida / acciones_por_unidad
 *
 * `acciones_circulacion` (del XBRL) cuenta ACCIONES. El precio de la BMV es
 * el de un TÍTULO COTIZADO, que en varias emisoras es una UNIDAD VINCULADA
 * (un paquete de N acciones). Dividir entre N pone las dos mitades en la
 * misma unidad, que era todo el problema de la Fase 0 §3.2.
 *
 * `acciones_por_unidad = 1` es el caso normal (una acción = un título) y NO
 * es un caso especial: la fórmula es la misma.
 *
 * Devuelve `null` con motivo, nunca un cero ni un estimado.
 */
export function capConUnidades({ clave, acciones_circulacion, precio, serie_liquida, acciones_por_unidad = 1 }) {
  const acciones = num(acciones_circulacion);
  const p = num(precio);
  const apu = num(acciones_por_unidad);
  const base = { clave, serie_liquida: serie_liquida || null, acciones_por_unidad: apu };

  if (acciones == null || acciones <= 0) return { ...base, cap: null, motivo: 'sin acciones_circulacion' };
  if (p == null || p <= 0) return { ...base, cap: null, motivo: `sin precio de la serie líquida (${serie_liquida || '—'})` };
  if (apu == null || apu <= 0) return { ...base, cap: null, motivo: 'acciones_por_unidad inválido' };

  return { ...base, cap: (acciones * p) / apu, precio: p, acciones, motivo: null };
}

/**
 * EL VERIFICADOR DEL DIVISOR — y la parte de R0(b) que no depende de que yo
 * haya leído bien un prospecto.
 *
 * Este contenedor no llega a la BMV ni a un prospecto, así que los cuatro
 * divisores del encargo (FEMSA UBD=5, KOF UBL=8, CEMEX CPO=3, TLEVISA
 * CPO=117) entran como **declarados por el operador**, no como verificados
 * por mí. Decir otra cosa sería inventar una fuente.
 *
 * Pero un divisor sí se puede MEDIR, y contra el dato mismo: si el divisor es
 * correcto, `acciones × precio / apu` tiene que cuadrar con la cap pública. Y
 * si NO cuadra, el cociente entre lo calculado y la referencia da el divisor
 * IMPLÍCITO, que es la respuesta empírica.
 *
 * Tres desenlaces, y los tres se reportan distinto:
 *   · `cuadra`           — el divisor declarado produce la cap correcta.
 *   · `divisor_corregido`— el implícito es otro ENTERO limpio: el declarado
 *                          está mal y el dato dice cuál es. Accionable.
 *   · `no_es_de_unidad`  — el implícito no es un entero limpio, así que el
 *                          error NO viene del empaquetado. Puede ser acciones
 *                          en circulación mal extraídas, una serie sin
 *                          cotizar, o recompras. Es el caso que hay que mirar
 *                          a mano, y el que un "redondeá al entero más
 *                          cercano" escondería.
 *
 * `tolerancia_pct` es el 5% del encargo. `max_divisor` acota el redondeo: un
 * implícito de 117 es real (TLEVISA CPO), uno de 4,812 es un error de unidades
 * (miles vs unidades) disfrazado de divisor.
 */
export function verificaDivisor({ capCalculada, capReferencia, acciones_por_unidad = 1, tolerancia_pct = 5, max_divisor = 500 }) {
  const c = num(capCalculada), r = num(capReferencia), apu = num(acciones_por_unidad);
  if (c == null || r == null || r === 0) {
    return { estado: 'sin_referencia', error_pct: null, divisor_declarado: apu, divisor_implicito: null };
  }
  const errorPct = ((c - r) / Math.abs(r)) * 100;
  if (Math.abs(errorPct) <= tolerancia_pct) {
    return { estado: 'cuadra', error_pct: errorPct, divisor_declarado: apu, divisor_implicito: apu };
  }

  // El implícito: por cuánto MÁS habría que dividir para llegar a la
  // referencia. Se compone con el declarado, porque `capCalculada` ya lo
  // aplicó — olvidarse de eso daba divisores al cuadrado.
  const factor = c / r;
  const implicito = (apu || 1) * factor;
  const redondeado = Math.round(implicito);
  const limpio = redondeado >= 1 && redondeado <= max_divisor
    && Math.abs(implicito - redondeado) / redondeado <= tolerancia_pct / 100;

  if (limpio && redondeado !== apu) {
    return {
      estado: 'divisor_corregido', error_pct: errorPct,
      divisor_declarado: apu, divisor_implicito: redondeado,
      exacto: implicito,
      motivo: `el divisor declarado (${apu}) no cuadra; el dato implica ${redondeado}`,
    };
  }
  return {
    estado: 'no_es_de_unidad', error_pct: errorPct,
    divisor_declarado: apu, divisor_implicito: null, exacto: implicito,
    motivo: `error ${errorPct.toFixed(1)}% y el divisor implícito (${implicito.toFixed(3)}) no es un entero limpio: el problema NO es el empaquetado`,
  };
}

/** Estado de render de una emisora: lo que el mapa pinta, y con qué etiqueta. */
export function estadoEmisora(verificacion, { cap, fuente_cap = 'calc' } = {}) {
  if (!verificacion || verificacion.estado === 'sin_referencia') {
    return { estado: 'gris_punteado', etiqueta: null, motivo: 'sin capitalización de referencia para verificar' };
  }
  if (verificacion.estado === 'cuadra' && num(cap) != null) {
    return { estado: 'verificada', etiqueta: `cap: ${fuente_cap}`, motivo: null };
  }
  return {
    estado: 'gris_punteado', etiqueta: null,
    motivo: verificacion.motivo || `error ${Number(verificacion.error_pct).toFixed(1)}%`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(c) — ¿de dónde sale la capitalización de referencia?
// ═══════════════════════════════════════════════════════════════════

// Llaves que, en un JSON de estados financieros, pueden estar hablando de
// acciones o de capitalización. Se buscan NORMALIZADAS (sin mayúsculas ni
// separadores) porque cada fuente las escribe distinto.
//
// Esto NO adivina cuál es la buena: las encuentra TODAS y las reporta con su
// ruta y su valor, para que la decisión la tome quien mira los números. Es el
// mismo criterio del `?job=diagnostico&que=eps` de bmv-rotation, que saca
// todas las llaves de acciones y marca cuál reproduce el EPS guardado.
export const PISTAS_ACCIONES = [
  'numberofshares', 'numberofsharesoutstanding', 'sharesoutstanding',
  'numerodeaccionesencirculacion', 'accionesencirculacion', 'acciones',
  'issuedcapital', 'ordinarysharesissued', 'weightedaverageshares',
  'weightedaveragenumberofordinarysharesoutstanding',
];
export const PISTAS_CAP = [
  'marketcap', 'marketcapitalization', 'capitalizacion', 'capitalizacionbursatil',
  'valordemercado', 'valorcapitalizacion',
];

const normLlave = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Recorre un JSON crudo y devuelve TODA llave que parezca acciones o cap, con
 * su ruta y su valor numérico.
 *
 * Por qué importa para R0(c): el censo de Fase 1b ya midió que las acciones en
 * circulación **no están en `ifrs-full`** de DataBursatil (docs/bmv-rotation.md
 * §4.4: "sin acciones no hay capitalización"). Eso hace que la instrucción
 * "referencia de cap vía DataBursatil" necesite una verificación antes de
 * construir sobre ella — y la verificación puede correrse **sobre el crudo ya
 * guardado en `bmv_financieros`, sin gastar un solo crédito**.
 *
 * Si encuentra llaves: la referencia existe y R0(c) procede.
 * Si no encuentra ninguna en ninguna emisora: está medido que no está, y ahí
 * hay que elegir otra referencia — decisión del operador, no mía.
 */
export function buscarPistas(raw, { pistas = [...PISTAS_ACCIONES, ...PISTAS_CAP], maxProfundidad = 8 } = {}) {
  const objetivo = new Set(pistas.map(normLlave));
  const hallazgos = [];
  const visto = new Set();

  const caminar = (nodo, ruta) => {
    if (!nodo || typeof nodo !== 'object' || visto.has(nodo) || ruta.length > maxProfundidad) return;
    visto.add(nodo);
    for (const [k, v] of Object.entries(nodo)) {
      const aqui = [...ruta, k];
      const nk = normLlave(k);
      if (objetivo.has(nk)) {
        hallazgos.push({
          ruta: aqui.join('.'), llave: k, llave_normalizada: nk,
          valor: num(v && typeof v === 'object' ? (v.valor ?? v.value ?? v.monto) : v),
          // Un hallazgo con valor null es igual de informativo: dice que la
          // llave EXISTE y viene vacía, que no es lo mismo que no existir.
          crudo: typeof v === 'object' ? undefined : v,
        });
      }
      if (v && typeof v === 'object') caminar(v, aqui);
    }
  };
  caminar(raw, []);
  return {
    hallazgos,
    con_valor: hallazgos.filter((h) => h.valor != null).length,
    llaves_distintas: [...new Set(hallazgos.map((h) => h.llave))].sort(),
  };
}

/**
 * La referencia MANUAL: lee el JSON de referencias y devuelve la cap vigente
 * de una emisora, o null con motivo.
 *
 * Por qué existe: la corrida del 2026-09-20 cerró las dos fuentes
 * automáticas a la vez. Yahoo `quoteSummary` devolvió **401 Invalid Crumb**
 * para las cinco emisoras Y para el precio objetivo de AAPL — o sea que no es
 * el símbolo `.MX`, es el endpoint entero. Y el censo de Fase 1b ya había
 * medido que DataBursatil no trae acciones en circulación.
 *
 * Una referencia capturada a mano y FECHADA es más auditable que una API que
 * contesta 401: se sabe quién la vio y cuándo. Lo que no puede pasar es que se
 * use sin decir que es manual — de ahí que `fuente` y `capturada_en` sean
 * obligatorias y que una fila sin ellas se rechace.
 *
 * `vigencia_dias` acota cuánto vale: una cap de referencia envejece con el
 * precio, y arrastrar un verde viejo es peor que volver a gris punteado.
 */
export function referenciaManual(registro, clave, ahora) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const filas = (registro && registro.referencias) || [];
  const vigenciaDias = num(registro && registro.vigencia_dias) ?? 14;
  const fila = filas.find((f) => up(f && f.clave) === up(clave));
  if (!fila) return { cap: null, motivo: 'sin referencia manual para esta emisora' };

  const cap = num(fila.market_cap);
  if (cap == null || cap <= 0) return { cap: null, motivo: 'la referencia no trae market_cap numérico' };
  // Las tres cosas que separan una referencia de un número suelto.
  if (!fila.fuente) return { cap: null, motivo: 'la referencia no dice de dónde salió (`fuente`)' };
  if (!fila.capturada_en) return { cap: null, motivo: 'la referencia no dice cuándo se capturó (`capturada_en`)' };

  const t = Date.parse(fila.capturada_en);
  if (!Number.isFinite(t)) return { cap: null, motivo: `\`capturada_en\` no es una fecha: ${fila.capturada_en}` };
  const dias = (now.getTime() - t) / 86400000;
  if (dias < 0) return { cap: null, motivo: 'la referencia está fechada en el futuro' };
  if (dias > vigenciaDias) {
    return {
      cap: null, dias: Math.round(dias),
      motivo: `referencia vencida: ${Math.round(dias)} días (vigencia ${vigenciaDias})`,
      vencida: true,
    };
  }
  return {
    cap, motivo: null, dias: Math.round(dias),
    fuente: fila.fuente, capturada_en: fila.capturada_en,
    capturada_por: fila.capturada_por || null,
    // Lo que viaja al render: la etiqueta dice que el número que se PINTA es
    // calc, y que lo que vino de afuera fue solo el verificador.
    etiqueta_verificacion: `verificada vs ${fila.fuente} (${fila.capturada_en})`,
  };
}

/**
 * Parsea `?job=...&manual=CLAVE:CAP,CLAVE:CAP` para una verificación puntual
 * sin redeploy. `fuente` y `capturada_en` se pasan aparte y valen para todas
 * las de esa corrida — porque si vinieron en la misma sesión, vinieron del
 * mismo lado y el mismo día.
 */
export function parseManualParam(raw, { fuente, capturada_en } = {}) {
  const txt = String(raw || '').trim();
  if (!txt) return { referencias: [], invalidas: [] };
  const referencias = [], invalidas = [];
  for (const parte of txt.split(',')) {
    const t = parte.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i <= 0) { invalidas.push({ entrada: t, motivo: 'falta el ":" entre clave y capitalización' }); continue; }
    const clave = up(t.slice(0, i));
    const cap = num(t.slice(i + 1).replace(/[\s,_]/g, ''));
    if (cap == null || cap <= 0) { invalidas.push({ entrada: t, motivo: 'la capitalización no es un número positivo' }); continue; }
    referencias.push({
      clave, market_cap: cap,
      fuente: fuente || 'manual (sin fuente declarada)',
      capturada_en: capturada_en || null,
    });
  }
  return { referencias, invalidas };
}

// ═══════════════════════════════════════════════════════════════════
// R0(a) — la fila del universo US
// ═══════════════════════════════════════════════════════════════════

/**
 * Normaliza lo que va a `mercado_universo_us`. Un símbolo entra a la tabla
 * aunque le falte algo: la fila dice QUÉ le falta, y el render decide. Lo que
 * NO se hace es dejarlo fuera en silencio — un símbolo ausente y uno sin cap
 * se ven igual en un `select count(*)` y son problemas distintos.
 */
export function filaUniversoUs({ symbol, nombre, industria, sector_etf, market_cap, cap_fuente, ahora }) {
  const sym = up(symbol);
  const cap = num(market_cap);
  const faltan = [];
  if (!sector_etf) faltan.push('sector');
  if (cap == null || cap <= 0) faltan.push('cap');
  if (!nombre) faltan.push('nombre');
  return {
    symbol: sym,
    nombre: nombre || null,
    industria: industria || null,
    sector_etf: sector_etf || null,
    market_cap: cap != null && cap > 0 ? cap : null,
    cap_fuente: cap != null && cap > 0 ? (cap_fuente || null) : null,
    actualizado: (ahora instanceof Date ? ahora : new Date(ahora)).toISOString(),
    completa: faltan.length === 0,
    faltan,
  };
}

/**
 * El recorte del mapa: top N por capitalización + el cuadro "+N más = X%".
 *
 * El "+N más" no es decoración. Sin él, un mapa de 300 nombres se lee como si
 * fuera el mercado entero. Y el X% se calcula sobre la suma de caps de los que
 * quedaron fuera — **nunca estimado**. Los que no tienen cap no pueden entrar
 * en esa suma, así que se cuentan aparte: decir "+200 más = 12%" cuando 40 de
 * esos 200 no tienen cap sería afirmar un porcentaje que no se midió.
 */
export function recorteMapa(filas, n = 300) {
  const conCap = filas.filter((f) => num(f.market_cap) != null && f.market_cap > 0);
  const sinCap = filas.length - conCap.length;
  const ordenadas = conCap.slice().sort((a, b) => b.market_cap - a.market_cap);
  const dentro = ordenadas.slice(0, n);
  const fuera = ordenadas.slice(n);
  const capTotal = conCap.reduce((a, f) => a + f.market_cap, 0);
  const capFuera = fuera.reduce((a, f) => a + f.market_cap, 0);
  return {
    dentro,
    resto: {
      n: fuera.length,
      cap: capFuera,
      pct: capTotal > 0 ? (capFuera / capTotal) * 100 : null,
      // La honestidad del porcentaje: sobre cuántos se pudo medir.
      sin_cap_excluidos: sinCap,
      nota: sinCap
        ? `${sinCap} nombres quedan fuera del porcentaje porque no tienen capitalización medida`
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// R0(e) — el parser de fechas del feed, revisado
// ═══════════════════════════════════════════════════════════════════

// Zonas alfabéticas que `Date.parse` NO resuelve, con su offset en minutos.
//
// MEDIDO, no supuesto: en Node 22, `Date.parse` SÍ resuelve EST, EDT, CST,
// CDT, MST, MDT, PST, PDT, GMT, UT y Z — el parser heredado de V8 los conoce.
// Lo que NO resuelve son las europeas y las asiáticas (CET, CEST, BST, JST,
// IST…), que devuelven NaN. La tabla cubre eso y nada más: agregar una
// entrada para EST sería código muerto que disimula que ya funcionaba.
export const ZONAS_EXTRA = {
  CET: 60, CEST: 120, WET: 0, WEST: 60, EET: 120, EEST: 180,
  BST: 60, IST: 330, JST: 540, KST: 540, HKT: 480, SGT: 480,
  AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
  // BRT/BRST: Brasil. ART: Argentina. CLT/CLST: Chile. Nos importan porque
  // Valor (BR) y La República (CO) están en el registro de noticias.
  BRT: -180, BRST: -120, ART: -180, CLT: -240, CLST: -180, COT: -300,
};

/**
 * Fecha de un item de feed → epoch ms, o null CON MOTIVO.
 *
 * El motivo es el punto. La versión anterior devolvía solo "parseable o no",
 * así que un feed sin fechas se reportaba igual estuviera vacío el campo,
 * tuviera una zona rara o mandara basura. Con el motivo, la próxima corrida
 * dice **por qué** en vez de dejarnos adivinar — que es justo lo que pasó con
 * el feed de la Fed.
 */
export function parseFechaFeed(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ms: null, motivo: 'campo de fecha vacío o ausente' };

  // ¿La cadena trae HORA? `Date.parse` acepta muchas formas sin hora y las
  // aterriza en medianoche sin chistar — incluido "17 septiembre 2026", que
  // V8 resuelve por el prefijo "sep". El resultado es correcto como FECHA y
  // mudo como HORA, y "lo de hoy" ordena por hora: un feed entero a las 00:00
  // se ordena al azar mientras se ve perfecto. Se marca, no se rechaza.
  const viaSegunHora = (txt, via) => (/\d{1,2}:\d{2}/.test(txt)
    ? via
    : `${via} — SIN HORA en el feed: se aterriza a medianoche y el orden por hora no es real`);

  // La fecha SOLA va primero, antes del Date.parse genérico. `Date.parse`
  // resuelve '2026-09-17' sin chistar (medianoche UTC), así que si se lo
  // dejáramos atender él, el aviso de "la hora no viene" no se emitiría
  // nunca — y "lo de hoy" ordena por hora. Lo cazó un test.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return {
      ms: Date.parse(s + 'T00:00:00Z'), motivo: null,
      via: 'fecha sin hora → medianoche UTC (la hora del titular no viene en el feed)',
    };
  }

  const directo = Date.parse(s);
  if (Number.isFinite(directo)) return { ms: directo, motivo: null, via: viaSegunHora(s, 'Date.parse') };

  // Zona alfabética al final que Date.parse no conoce → se cambia por su
  // offset numérico y se reintenta. No se ADIVINA la zona: solo se traduce una
  // que el texto declara.
  const m = /\s([A-Z]{2,5})$/.exec(s);
  if (m && Object.prototype.hasOwnProperty.call(ZONAS_EXTRA, m[1])) {
    const off = ZONAS_EXTRA[m[1]];
    const signo = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const t = Date.parse(s.replace(/\s[A-Z]{2,5}$/, ` ${signo}${hh}${mm}`));
    if (Number.isFinite(t)) return { ms: t, motivo: null, via: viaSegunHora(s, `zona ${m[1]} traducida a ${signo}${hh}${mm}`) };
  }
  if (m) return { ms: null, motivo: `zona horaria desconocida: "${m[1]}"` };

  return { ms: null, motivo: `formato no reconocido: ${s.slice(0, 40)}` };
}

/**
 * Diagnóstico de por qué un feed no trae fechas usables: junta las CADENAS
 * CRUDAS que no se pudieron parsear, agrupadas por motivo.
 *
 * Sin esto, "0% con fecha" es un callejón sin salida. Con esto, la corrida
 * entrega las tres cadenas que fallaron y el motivo se ve a simple vista.
 */
export function diagnosticoFechas(crudas = []) {
  const porMotivo = {};
  let ok = 0;
  for (const c of crudas) {
    const r = parseFechaFeed(c);
    if (r.ms != null) { ok++; continue; }
    if (!porMotivo[r.motivo]) porMotivo[r.motivo] = [];
    if (porMotivo[r.motivo].length < 3) porMotivo[r.motivo].push(String(c).slice(0, 60));
  }
  return {
    total: crudas.length, parseadas: ok, fallidas: crudas.length - ok,
    por_motivo: porMotivo,
  };
}
