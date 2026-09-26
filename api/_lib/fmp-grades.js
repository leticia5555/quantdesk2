// ═══════════════════════════════════════════════════════════════════
// api/_lib/fmp-grades.js — frontera de red con FMP `/stable/grades-historical`.
//
// ESTE ES EL ÚNICO DATO POINT-IN-TIME QUE SE ENCONTRÓ. Una fila por MES con los
// conteos de strongBuy/buy/hold/sell/strongSell, y las filas viejas NO se
// sobrescriben — verificado con NKE: 6 strongBuy + 20 buy en dic-2025 contra
// 1 + 10 en sep-2026.
//
// `analyst-estimates` de FMP NO sirve para esto: una fila por período fiscal con
// el número de HOY, igual que Alpha Vantage. Un backtest con eso mide el futuro.
//
// ── LO QUE SE HEREDA DE api/_lib/arena-universe.js ─────────────────
// Esa frontera ya pagó las lecciones de FMP y acá se aplican las mismas:
//
//   1. **HTTP 200 con un objeto de error.** Es el caso que más engaña: FMP
//      contesta 200 y en el cuerpo pone `Error Message`. Sin mirarlo, "FMP no
//      contestó" se vuelve indistinguible de "FMP contestó y dijo por qué".
//   2. **Los primeros bytes SIEMPRE**, salga bien o mal: es donde FMP explica.
//   3. **La env var vive por ENTORNO en Vercel.** Que `FMP_API_KEY` esté en
//      Production no la pone en Preview — y sin key el diagnóstico tiene que
//      decir eso y no "sin datos".
//   4. **No lanza.** Clasifica y devuelve el motivo. Una fuente caída se
//      DECLARA; nunca se inventa.
//
// La key es la MISMA `FMP_API_KEY` que ya usa el universo de la arena: no hace
// falta una env var nueva si ya está puesta en el entorno donde corre esto.
//
// ENV VARS: FMP_API_KEY
// ═══════════════════════════════════════════════════════════════════

const BASE = 'https://financialmodelingprep.com/stable';

// Tope de filas por símbolo. La serie es mensual, así que 1000 son ~83 años:
// alto a propósito, porque la Fase 0 tiene que MEDIR hasta dónde llega la
// historia y un límite bajo contestaría la pregunta con el límite. Es la
// cicatriz del `limit=5` del censo de Polymarket, que disfrazó un tope propio
// de un hallazgo sobre la fuente.
//
// PERO un `limit` fuera del rango que acepta el plan es una de las formas en que
// FMP contesta 400, así que `gradesHistorical` acepta `limit: null` (URL sin el
// parámetro) y el smoke prueba las variantes. "Alto a propósito" no sirve si el
// servidor rechaza el número.
const LIMIT_ALTO = 1000;

const VALID_TICKER = /^[A-Z][A-Z.\-]{0,9}$/;

// Una sola forma de fila, con los cinco conteos numéricos y la fecha en ISO.
// Lo que no se puede leer se descarta CONTADO, no en silencio.
function normalizaGrades(crudo) {
  const filas = [], descartes = { sin_fecha: 0, sin_conteos: 0 };
  for (const g of Array.isArray(crudo) ? crudo : []) {
    const fecha = g && g.date ? String(g.date).slice(0, 10) : null;
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { descartes.sin_fecha++; continue; }
    const num = (x) => { const v = Number(x); return Number.isFinite(v) && v >= 0 ? v : 0; };
    const fila = {
      date: fecha,
      strongBuy: num(g.analystRatingsStrongBuy ?? g.strongBuy),
      buy: num(g.analystRatingsBuy ?? g.buy),
      hold: num(g.analystRatingsHold ?? g.hold),
      sell: num(g.analystRatingsSell ?? g.sell),
      strongSell: num(g.analystRatingsStrongSell ?? g.strongSell),
    };
    if (!(fila.strongBuy + fila.buy + fila.hold + fila.sell + fila.strongSell)) { descartes.sin_conteos++; continue; }
    filas.push(fila);
  }
  // Más viejo primero: es el orden en que se lee una serie.
  filas.sort((a, b) => a.date.localeCompare(b.date));
  return { filas, descartes };
}

// Devuelve SIEMPRE un objeto con `ok` y, si falló, el motivo y la muestra del
// cuerpo. Nunca lanza.
async function gradesHistorical(symbol, {
  apiKey = process.env.FMP_API_KEY, limit = LIMIT_ALTO, timeoutMs = 15000, fetchImpl = fetch,
} = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!VALID_TICKER.test(sym)) return { ok: false, symbol: sym, motivo: 'ticker_invalido' };
  if (!apiKey) {
    return { ok: false, symbol: sym, motivo: 'sin_key',
      detalle: 'process.env.FMP_API_KEY está vacía EN ESTE ENTORNO. En Vercel una env var vive por entorno: que esté en Production no la pone en Preview.' };
  }

  // `limit` OPCIONAL: pasar `limit: null` arma la URL sin el parámetro. Existe
  // porque un `limit` fuera de rango es una de las formas en que FMP contesta
  // 400, y sin poder probar las dos variantes no se puede distinguir.
  const url = `${BASE}/grades-historical?symbol=${encodeURIComponent(sym)}`
    + (limit === null || limit === undefined ? '' : `&limit=${limit}`);
  const t0 = Date.now();
  try {
    const r = await fetchImpl(`${url}&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const texto = await r.text().catch(() => '');
    // 500 bytes, no 200: con 200 un mensaje de FMP envuelto en JSON se corta
    // antes de la parte que explica. Y `longitud_cuerpo` va aparte porque un
    // cuerpo VACÍO es en sí mismo un dato (no es lo mismo que uno que no se leyó).
    const muestra = String(texto || '').slice(0, 500);
    const cuerpo = { body_sample: muestra, longitud_cuerpo: String(texto || '').length,
      content_type: (r.headers && r.headers.get && r.headers.get('content-type')) || null };
    const ms = Date.now() - t0;
    // El 429 se distingue del resto: es el dato que la Fase 0 vino a medir.
    if (r.status === 429) {
      return { ok: false, symbol: sym, url_sin_key: url, motivo: 'rate_limit', status: 429, ms, ...cuerpo,
        retry_after: (r.headers && r.headers.get && r.headers.get('retry-after')) || null };
    }
    // AUTH APARTE. Una key ausente, muerta, o de un plan que no cubre el
    // endpoint NO puede salir como un `http_error` mudo: son las tres cosas que
    // se arreglan en otro lado (en Vercel, no en el código), y confundirlas con
    // "la fuente falló" manda a buscar donde no está.
    if (r.status === 401 || r.status === 403 || r.status === 402) {
      return { ok: false, symbol: sym, url_sin_key: url, status: r.status, ms, ...cuerpo,
        motivo: 'auth_error',
        detalle: r.status === 402
          ? 'HTTP 402: el plan de la key no cubre este endpoint.'
          : 'HTTP ' + r.status + ': la key fue RECHAZADA (ausente para FMP, vencida, o sin permiso para este endpoint). Se arregla en las env vars, no en el código.' };
    }
    if (!r.ok) {
      return { ok: false, symbol: sym, url_sin_key: url, motivo: 'http_error', status: r.status, ms, ...cuerpo };
    }

    let j = null;
    try { j = JSON.parse(texto); } catch { return { ok: false, symbol: sym, url_sin_key: url, motivo: 'json_invalido', status: r.status, ms, ...cuerpo }; }

    if (!Array.isArray(j)) {
      // HTTP 200 con objeto de error: el caso que más engaña.
      const msg = (j && (j['Error Message'] || j.error || j.message)) || null;
      return { ok: false, symbol: sym, url_sin_key: url, status: r.status, ms, ...cuerpo,
        motivo: msg ? 'fmp_error_message' : 'cuerpo_no_es_lista', fmp_message: msg };
    }

    const { filas, descartes } = normalizaGrades(j);
    return {
      ok: true, symbol: sym, url_sin_key: url, status: r.status, ms,
      recibidas: j.length, filas, descartes,
      // Hasta dónde llega la historia: lo que la Fase 0 tiene que reportar.
      desde: filas.length ? filas[0].date : null,
      hasta: filas.length ? filas[filas.length - 1].date : null,
      meses: filas.length,
      // Si `recibidas` toca el límite, la historia puede estar CORTADA por el
      // límite y no por la fuente. Se avisa en vez de concluir.
      posible_tope: j.length >= limit,
      limit,
    };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, symbol: sym, ms: Date.now() - t0,
      motivo: /abort|timeout/i.test(m) ? 'timeout' : 'red', detalle: m.slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// LECTURA DEL SMOKE — qué significa el patrón de respuestas
//
// Pura y testeada: la interpretación NO la improvisa el endpoint. Y no adivina:
// si el patrón no encaja en ninguno de los casos conocidos, dice que no sabe y
// devuelve el status y el cuerpo para que decida una persona. Un diagnóstico
// inventado es peor que "no sé, acá está la fila".
// ═══════════════════════════════════════════════════════════════════

// variantes: [{ id, limit, ok, status, motivo, body_sample, meses }]
function interpretaSmoke(variantes, { key = null } = {}) {
  const v = Array.isArray(variantes) ? variantes : [];
  if (!v.length) return { causa: 'sin_variantes', lectura: 'No se probó ninguna variante.' };

  const todas = (f) => v.every(f);
  const alguna = (f) => v.some(f);
  const conLimit = v.filter((x) => x.limit !== null && x.limit !== undefined);
  const sinLimit = v.filter((x) => x.limit === null || x.limit === undefined);

  if (key && key.presente === false) {
    return { causa: 'sin_key',
      lectura: 'No hay FMP_API_KEY en ESTE entorno. En Vercel una env var vive por entorno: que esté en Production no la pone en Preview. No es un problema del código.' };
  }
  if (todas((x) => x.motivo === 'auth_error')) {
    const st = [...new Set(v.map((x) => x.status))].join('/');
    return { causa: 'auth_error',
      lectura: `Todas las variantes fallan con HTTP ${st}: la key fue RECHAZADA por FMP (vencida, revocada, o de un plan que no cubre este endpoint). Se arregla en las env vars de Vercel, no en el código. El cuerpo de la respuesta está abajo y suele decir cuál de las tres.` };
  }
  // El 429 va ANTES del chequeo de "mismo status en todas": tres 429 tienen el
  // mismo status, y sin este orden caían en `http_error_uniforme` — o sea que la
  // causa conocida se perdía dentro de la desconocida.
  if (alguna((x) => x.motivo === 'rate_limit')) {
    return { causa: 'rate_limit',
      lectura: 'Alguna variante recibió HTTP 429: la cuota está agotada. Esperar y volver a probar; no es un problema del código ni de la key.' };
  }
  if (todas((x) => x.ok)) {
    return { causa: 'frontera_ok',
      lectura: 'Todas las variantes traen filas. La frontera funciona: si el censo dijo lo contrario, el problema está entre el censo y esta llamada (concurrencia, cuota agotada a mitad de corrida, o el símbolo pedido).' };
  }
  // El caso del parámetro: falla CON limit y anda SIN limit (o con uno chico).
  const fallanConLimit = conLimit.filter((x) => !x.ok);
  const andanSinLimit = sinLimit.filter((x) => x.ok);
  if (fallanConLimit.length && andanSinLimit.length) {
    return { causa: 'limit_rechazado',
      lectura: `La URL SIN \`limit\` trae filas y la que lleva \`limit=${fallanConLimit.map((x) => x.limit).join('/')}\` falla con HTTP ${[...new Set(fallanConLimit.map((x) => x.status))].join('/')}. Es el PARÁMETRO, no la key: el plan no acepta ese valor de limit. Arreglo: pedir sin limit, o con el valor más alto que sí acepte.` };
  }
  const limitChicoAnda = conLimit.filter((x) => x.ok).sort((a, b) => a.limit - b.limit);
  if (fallanConLimit.length && limitChicoAnda.length) {
    return { causa: 'limit_fuera_de_rango',
      lectura: `\`limit=${limitChicoAnda[0].limit}\` trae filas y \`limit=${fallanConLimit.map((x) => x.limit).join('/')}\` falla con HTTP ${[...new Set(fallanConLimit.map((x) => x.status))].join('/')}. El límite tiene un techo: hay que bajarlo y DECLARAR que la historia puede estar cortada por el límite.` };
  }
  // HTTP 200 con `Error Message` en TODAS: FMP contestó y dijo por qué. No es
  // un "http_error uniforme" — llamarlo así escondería el mensaje que ya está.
  if (todas((x) => x.motivo === 'fmp_error_message')) {
    const msgs = [...new Set(v.map((x) => x.fmp_message).filter(Boolean))];
    return { causa: 'fmp_error_message',
      lectura: `FMP contestó HTTP 200 y en el cuerpo puso un mensaje de error en todas las variantes: ${msgs.join(' · ') || '(sin mensaje)'}. Es el caso que más engaña, porque un 200 parece éxito. Lo que dice el mensaje manda.` };
  }
  if (todas((x) => !x.ok) && new Set(v.map((x) => x.status)).size === 1) {
    return { causa: 'http_error_uniforme',
      lectura: `Todas las variantes fallan con el MISMO HTTP ${v[0].status}. No es el \`limit\` ni el símbolo. El cuerpo de la respuesta va abajo completo: ahí está la causa, y no se adivina desde acá.` };
  }
  return { causa: 'no_concluyente',
    lectura: 'El patrón no encaja en ningún caso conocido. Los status y los cuerpos de cada variante van abajo sin interpretar: eso lo lee una persona.' };
}

export { gradesHistorical, normalizaGrades, interpretaSmoke, BASE, LIMIT_ALTO, VALID_TICKER };
