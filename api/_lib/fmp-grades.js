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

// ═══════════════════════════════════════════════════════════════════
// EL HALLAZGO CONTRAINTUITIVO: **NO SE MANDA `limit`.**
//
// Medido, no supuesto:
//   · `limit=1000`  → HTTP 402, el plan acepta `limit` solo entre 0 y 10.
//   · `limit=10`    → 10 meses.
//   · SIN `limit`   → **88 meses** (2019-01 → 2026-09).
//
// O sea que el parámetro que existe para "traer más" es el que RECORTA: pedir
// sin él da 8.8× más historia que pedir el máximo que el plan acepta. Se olvida
// fácil y se "arregla" fácil en la dirección equivocada (subir el limit), así que
// queda escrito acá y en docs/grades-backtest-scope.md.
//
// La versión anterior de este comentario decía que el limit iba "alto a
// propósito" para medir la historia. Era exactamente al revés: cualquier limit
// la recorta o hace que FMP rechace la llamada.
//
// `limit` sigue siendo un parámetro de `gradesHistorical` porque el smoke tiene
// que poder probar las variantes; el DEFECTO es null.
// ═══════════════════════════════════════════════════════════════════
const LIMIT_POR_DEFECTO = null;          // sin el parámetro: la historia completa
const LIMIT_MAXIMO_DEL_PLAN = 10;        // medido: el plan acepta 0..10
const LIMIT_SMOKE_ALTO = 1000;           // el valor que el smoke usa para provocar el 402

const VALID_TICKER = /^[A-Z][A-Z.\-]{0,9}$/;

// ¿El cuerpo de un 402 habla de un PARÁMETRO o de un plan? Lo decide el texto,
// no una corazonada. Se exige el NOMBRE de un parámetro conocido, y se excluye
// cualquier mención a la key para no confundir un rechazo de credencial.
const PARAMETROS_CONOCIDOS = ['limit', 'symbol', 'from', 'to', 'page', 'period', 'datatype'];

function mencionaParametro(texto) {
  const t = String(texto || '');
  if (!t) return { menciona: false, parametro: null, rango: null };
  // "Invalid API key" nombra una credencial, no un parámetro de consulta.
  if (/\bapi\s*-?\s?keys?\b/i.test(t)) return { menciona: false, parametro: null, rango: null };
  // EL NOMBRE SOLO NO ALCANZA. `to`, `from`, `page` y `period` son palabras
  // comunes del inglés, y el mensaje real de plan de FMP termina en "…please
  // visit our subscription PAGE TO upgrade your plan". La primera versión de
  // esta función buscaba la palabra suelta y clasificaba ESE mensaje como
  // "parámetro `to` fuera de rango, NO es un problema de plan" — el espejo del
  // diagnóstico falso que esta misma función vino a corregir.
  //
  // Ahora el nombre tiene que aparecer EN CONTEXTO DE PARÁMETRO: entre
  // comillas ('period'), con `=`, o pegado a una frase que solo se usa para
  // parámetros. Gana el que aparece entre comillas, que es como FMP los nombra.
  const alt = PARAMETROS_CONOCIDOS.join('|');
  const entreComillas = t.match(new RegExp(`['"\`](${alt})['"\`]`, 'i'));
  const enContexto = entreComillas
    || t.match(new RegExp(`\\b(${alt})\\s*=`, 'i'))
    || t.match(new RegExp(`\\b(?:invalid|parameter|param)\\s+(${alt})\\b`, 'i'))
    || t.match(new RegExp(`\\b(${alt})\\s+(?:must|is required|is invalid|parameter|out of range|should)\\b`, 'i'));
  const encontrado = enContexto ? enContexto[1].toLowerCase() : null;
  if (!encontrado) return { menciona: false, parametro: null, rango: null };
  // El rango, si el mensaje lo trae ("between 0 and 10", "0 to 10", "max 10").
  let rango = null;
  const entre = t.match(/between\s+(-?\d+)\s+and\s+(-?\d+)/i) || t.match(/\b(-?\d+)\s*(?:to|-|–)\s*(-?\d+)\b/);
  const maximo = t.match(/\bmax(?:imum)?(?:\s+is)?\s*[:=]?\s*(-?\d+)/i);
  if (entre) rango = { min: Number(entre[1]), max: Number(entre[2]) };
  else if (maximo) rango = { min: null, max: Number(maximo[1]) };
  return { menciona: true, parametro: encontrado, rango };
}

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
  apiKey = process.env.FMP_API_KEY, limit = LIMIT_POR_DEFECTO, timeoutMs = 15000, fetchImpl = fetch,
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
    // ── AUTH: 401 y 403, y NADA MÁS ────────────────────────────────
    // Una key ausente, vencida o sin permiso se arregla en las env vars, no en
    // el código, y por eso no puede salir como un `http_error` mudo.
    if (r.status === 401 || r.status === 403) {
      return { ok: false, symbol: sym, url_sin_key: url, status: r.status, ms, ...cuerpo,
        motivo: 'auth_error',
        detalle: 'HTTP ' + r.status + ': la key fue RECHAZADA (ausente para FMP, vencida, o sin permiso para este endpoint). Se arregla en las env vars, no en el código.' };
    }

    // ── EL 402 NO ES AUTH ──────────────────────────────────────────
    //
    // Esta rama existe por un diagnóstico FALSO que escribí antes: el 402 se
    // clasificaba como `auth_error` con el texto "el plan de la key no cubre
    // este endpoint". El 402 real venía por `limit=1000`, y el cuerpo de FMP lo
    // decía con todas las letras — pero mi texto mandaba a rotar la llave.
    //
    // Ahora el CUERPO decide, y cuando el cuerpo no alcanza para decidir, se
    // dice que no alcanza en vez de elegir una de las dos.
    if (r.status === 402) {
      const p = mencionaParametro(muestra);
      return { ok: false, symbol: sym, url_sin_key: url, status: 402, ms, ...cuerpo,
        motivo: p.menciona ? 'parametro_fuera_de_rango' : 'pago_requerido',
        parametro: p.parametro, rango: p.rango,
        detalle: p.menciona
          ? `HTTP 402, pero el cuerpo nombra el parámetro \`${p.parametro}\`${p.rango ? ` y su rango aceptado (${p.rango.min}..${p.rango.max})` : ''}: es un VALOR fuera de rango, NO un problema de plan. No se toca la key.`
          : 'HTTP 402 y el cuerpo no nombra ningún parámetro. Puede ser el plan, pero NO se afirma: el cuerpo va completo arriba y lo lee una persona.' };
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
      // ── LA HEURÍSTICA DEL TOPE, ARREGLADA ──
      // Antes era `j.length >= limit`, y con `limit: null` eso se vuelve
      // `88 >= 0` → TRUE: toda respuesta sin límite salía marcada como "tocó el
      // límite". Sin límite NO HAY límite que tocar, así que es false, y el
      // límite enviado se publica al lado para que el aviso sea auditable.
      posible_tope: limit === null || limit === undefined ? false : j.length >= limit,
      limite_enviado: limit ?? null,
      limit: limit ?? null,
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
    const rangos = fallanConLimit.map((x) => x.rango).filter(Boolean);
    const rango = rangos.length ? `${rangos[0].min ?? 0}..${rangos[0].max}` : null;
    // El CONTRASTE DE MESES, que es el hallazgo de verdad: la variante sin
    // parámetro puede traer muchísimo más que la que lleva el máximo aceptado.
    const sinL = andanSinLimit[0];
    const conL = conLimit.filter((x) => x.ok).sort((a, b) => (b.meses || 0) - (a.meses || 0))[0] || null;
    const contraste = (sinL && sinL.meses && conL && conL.meses)
      ? ` Y el hallazgo que importa: sin \`limit\` son ${sinL.meses} meses contra ${conL.meses} con \`limit=${conL.limit}\` — o sea ${(sinL.meses / conL.meses).toFixed(1)}× más historia. El parámetro que parece traer más es el que RECORTA.`
      : (sinL && sinL.meses ? ` Sin \`limit\` son ${sinL.meses} meses.` : '');
    return { causa: 'limit_rechazado',
      lectura: `La URL SIN \`limit\` trae filas y la que lleva \`limit=${fallanConLimit.map((x) => x.limit).join('/')}\` falla con HTTP ${[...new Set(fallanConLimit.map((x) => x.status))].join('/')}`
        + (rango ? `, y el cuerpo dice que el rango aceptado es ${rango}` : '')
        + `. Es el PARÁMETRO, no la key.${contraste} Arreglo: pedir SIN limit.` };
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

export {
  gradesHistorical, normalizaGrades, interpretaSmoke, mencionaParametro,
  BASE, LIMIT_POR_DEFECTO, LIMIT_MAXIMO_DEL_PLAN, LIMIT_SMOKE_ALTO, VALID_TICKER,
};
