// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat-descubrir.js — descubrimiento dirigido de mercados
// de earnings en Polymarket. UNA sola implementación, usada por los dos:
//   · /api/earnings-beat?smoke=1     (censo, Fase 0)
//   · /api/earnings-beat-harvest     (cosecha, Fase 1)
//
// Se extrajo del endpoint del censo cuando la cosecha necesitó exactamente el
// mismo descubrimiento: dos copias se desincronizan, y acá la que se
// desincronizara decidiría QUÉ ENTRA A LA TABLA. Mismo movimiento que
// _lib/yahoo-daily.js cuando rotation-analyze necesitó el fetch de pead.
//
// No habla con la red por su cuenta: recibe `gamma1`/`clob1` ya envueltos por
// quien llama (con sus contadores de rate limit y de topes de offset), así que
// sigue siendo testeable con dobles.
// ═══════════════════════════════════════════════════════════════════

import {
  FRASES_BUSQUEDA, normalizaMercado, pareceEarnings, extraeTags, extraeCluster,
  precioEnT24h, clasificaT24h, ts,
} from './earnings-beat.js';

// ── CICATRIZ #2: el "5" que hacía ver un catálogo como una muestra ────────
// La corrida anterior devolvió EXACTAMENTE 5 filas en toda respuesta. Dos
// causas distintas, y conviene no confundirlas porque se arreglan distinto:
//   · las sondas del §1 llevaban un `limit: 5` MÍO (probes baratas);
//   · la búsqueda iba con solo `q` — quité `limit_per_type` en la vuelta
//     anterior "para no inventar parámetros", y sin él public-search sirve su
//     DEFAULT, que resultó ser 5 por tipo.
// O sea que la prudencia de no mandar el parámetro NO fue neutral: eligió el
// default del servidor y lo disfrazó de resultado. La lección no es "inventar
// parámetros", es: **mandarlo y verificar que funcionó**, con reintento pelado
// si el servidor lo rechaza. Un límite implícito es peor que uno explícito:
// el explícito se ve en el diff.
// Gamma devuelve a veces un array pelado y a veces {data:[...]}. Y /events
// trae los mercados anidados. Esta función aplana las dos formas sin decidir
// de antemano cuál vino.
function filasDe(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && Array.isArray(body.markets)) return body.markets;
  return [];
}

function aplanaMercados(item) {
  if (item && Array.isArray(item.markets) && item.markets.length) {
    // Evento: cada mercado hereda la descripción del evento si no trae la suya
    // (el consenso a veces vive en el texto del evento, no del mercado).
    return item.markets.map((m) => ({ ...m, description: m.description || item.description, _evento: item.slug || item.title || null }));
  }
  return [item];
}

// El CLOB se pide en paralelo de a pocos: cientos de requests en serie no
// entran en el presupuesto, y cientos de golpe es una forma elegante de que te
// limiten. Mismo criterio que CONCURRENCIA en _lib/yahoo-daily.js.
const CONCURRENCIA_CLOB = 6;
const PAGINAS_BUSQUEDA = 12;      // tope de páginas por frase
const LIMITE_BUSQUEDA = 100;      // explícito, y verificado abajo
const PAGINAS_POR_SIMBOLO = 3;    // 99 búsquedas: acá el presupuesto manda

async function buscaFrase(gamma1, frase, restante, etiqueta, maxPaginas = PAGINAS_BUSQUEDA) {
  const intentos = [];
  const filas = [];
  const idsVistos = new Set();
  let conLimite = true;

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    if (restante() < 40000) { intentos.push({ frase, etiqueta, nota: 'corte por presupuesto de tiempo' }); break; }
    const params = { q: frase };
    if (conLimite) params.limit_per_type = LIMITE_BUSQUEDA;
    if (pagina > 0) params.page = pagina + 1;

    let r = await gamma1('/public-search', params);
    // Si el parámetro explícito es el problema, se cae al pelado UNA vez y
    // queda registrado — pero entonces el conteo sale con el default del
    // servidor y hay que leerlo como tal.
    if (r.status !== 'ok' && conLimite && pagina === 0) {
      intentos.push({ frase, etiqueta, pagina, status: r.status, http: r.http ?? null,
        nota: `limit_per_type=${LIMITE_BUSQUEDA} rechazado — reintento sin parámetros` });
      conLimite = false;
      r = await gamma1('/public-search', { q: frase });
    }

    const encontradas = r.status === 'ok' ? cosechaDeBusqueda(r.body) : [];
    const ids = encontradas.map(idDeMercado).filter(Boolean);
    const nuevos = ids.filter((i) => !idsVistos.has(i));
    for (const i of ids) idsVistos.add(i);

    intentos.push({
      frase, etiqueta, pagina, status: r.status, http: r.http ?? null, ms: r.ms,
      filas: encontradas.length, nuevos: nuevos.length,
      limite: conLimite ? LIMITE_BUSQUEDA : 'default del servidor',
      forma: r.status === 'ok' ? formaDe(r.body) : null,
    });
    filas.push(...encontradas);

    if (r.status !== 'ok') break;
    if (!encontradas.length) break;
    // ¿La paginación AVANZA de verdad? Si la página 2 trae lo mismo que la 1,
    // public-search no pagina y seguir pidiendo es gastar presupuesto en el
    // mismo lote. Se declara, no se asume.
    if (pagina > 0 && nuevos.length === 0) {
      intentos.push({ frase, etiqueta, nota: 'la página no trajo ids nuevos: public-search no pagina — se corta' });
      break;
    }
    // Página incompleta = última página.
    if (conLimite && encontradas.length < LIMITE_BUSQUEDA) break;
  }
  return { intentos, filas };
}

function idDeMercado(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.id !== undefined && raw.id !== null) return String(raw.id);
  return raw.slug ? 'slug:' + raw.slug : null;
}

async function descubrePorBusqueda(ctx, gamma1, restante) {
  const intentos = [];
  const filas = [];
  for (const frase of FRASES_BUSQUEDA) {
    if (restante() < 40000) break;
    const r = await buscaFrase(gamma1, frase, restante, 'frase');
    intentos.push(...r.intentos);
    filas.push(...r.filas);
  }
  return { camino: 'busqueda', intentos, filas };
}

// ── Camino D: una búsqueda POR SÍMBOLO de nuestro universo ────────────────
// Es el camino que apunta directo a la pregunta que decide el candado: no
// "cuántos mercados de earnings hay en Polymarket", sino **cuántos hay de las
// empresas que nosotros podemos modelar**. Las plantillas conocidas
// ("Will X (TICKER) beat quarterly earnings?" y el slug estilo
// "nke-quarterly-earnings-gaap-eps-…") ponen el ticker en el texto, así que
// buscar por ticker es la consulta más específica que podemos hacer.
async function descubrePorSimbolo(ctx, gamma1, restante, universo) {
  const intentos = [];
  const filas = [];
  const simbolos = [...universo].slice(0, ctx.simbolos);
  const traidas = {};   // filas crudas por símbolo, ANTES de filtrar intentos
  let probados = 0;
  for (const sym of simbolos) {
    if (restante() < 60000) break;
    // Tope de páginas MÁS BAJO que el de las frases: son 99 búsquedas, y un
    // ticker que es palabra común ("NOW", "ON") puede paginar sin fin sin
    // aportar un solo mercado de earnings. El presupuesto vale más que la
    // página 4 de "Now You See Me".
    const r = await buscaFrase(gamma1, `${sym} quarterly earnings`, restante, sym, PAGINAS_POR_SIMBOLO);
    probados++;
    traidas[sym] = r.intentos.reduce((a, i) => a + (typeof i.filas === 'number' ? i.filas : 0), 0);
    // Solo se reportan los intentos que trajeron algo o fallaron: 99 filas de
    // "0 resultados" tapan el reporte sin decir nada que el total no diga.
    for (const i of r.intentos) {
      if (i.nota || i.status !== 'ok' || (i.filas ?? 0) > 0) intentos.push(i);
    }
    // Cada fila recuerda QUÉ búsqueda la trajo: la búsqueda por símbolo es por
    // SUBCADENA y hay tickers que son palabras comunes (NOW, ON, ALL). Sin la
    // etiqueta no se puede auditar si por ahí se coló basura.
    filas.push(...r.filas.map((f) => ({ ...f, _etiqueta: sym })));
  }
  return { camino: 'simbolo', intentos, filas, traidas, probados, de: simbolos.length, universo: universo.size };
}

// public-search devuelve varios tipos a la vez (eventos, tags, perfiles). Se
// toma lo que tenga mercados adentro, venga como venga.
function cosechaDeBusqueda(body) {
  const out = [];
  const candidatos = [];
  if (Array.isArray(body)) candidatos.push(...body);
  else if (body && typeof body === 'object') {
    for (const k of ['events', 'markets', 'data', 'results']) {
      if (Array.isArray(body[k])) candidatos.push(...body[k]);
    }
  }
  for (const item of candidatos) for (const m of aplanaMercados(item)) out.push(m);
  return out;
}

async function descubrePorTags(ctx, gamma1, restante, semillas) {
  const intentos = [];
  const filas = [];
  // Tags de los mercados de earnings que ya encontramos: los que importan son
  // los que esos mercados comparten, no los que a mí me parezcan.
  const cuenta = new Map();
  for (const raw of semillas) {
    for (const t of extraeTags(raw)) {
      const k = (t.id || '') + '|' + (t.slug || '');
      const prev = cuenta.get(k) || { ...t, n: 0 };
      prev.n++;
      cuenta.set(k, prev);
    }
  }
  const top = [...cuenta.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  if (!top.length) {
    return { camino: 'tags', intentos: [{ nota: 'ningún mercado semilla trajo tags — camino no disponible' }], filas, tags_vistos: [] };
  }

  for (const tag of top) {
    // Con id se filtra `/markets` (tag_id); sin id, el slug se le pregunta a
    // `/events`, que es quien los entiende. Pedirle un slug a /markets sería
    // inventar un parámetro, y un filtro ignorado devuelve catálogo suelto.
    const path = tag.id ? '/markets' : '/events';
    // Paginado DENTRO del filtro: acá el offset se queda corto y no topa.
    for (let pagina = 0; pagina < 4; pagina++) {
      if (restante() < 40000) break;
      const params = tag.id
        ? { tag_id: tag.id, closed: 'true', limit: 100, offset: pagina * 100 }
        : { tag_slug: tag.slug, closed: 'true', limit: 100, offset: pagina * 100 };
      const r = await gamma1(path, params);
      const encontradas = r.status === 'ok' ? filasDe(r.body).flatMap(aplanaMercados) : [];
      const deEarnings = encontradas.filter((raw) => pareceEarnings(normalizaMercado(raw)).si).length;
      intentos.push({ tag: tag.label || tag.slug || tag.id, endpoint: 'gamma' + path, pagina,
        status: r.status, http: r.http ?? null, filas: encontradas.length, de_earnings: deEarnings });
      filas.push(...encontradas);
      if (r.status !== 'ok' || encontradas.length === 0) break;
      // Filas sí, earnings no → el filtro se está ignorando y esto es catálogo
      // suelto. Seguir paginando sería gastar presupuesto en ruido.
      if (deEarnings === 0) {
        intentos.push({ tag: tag.label || tag.slug || tag.id, nota: 'trajo filas pero ninguna de earnings: el filtro parece ignorado — se corta' });
        break;
      }
    }
  }
  return { camino: 'tags', intentos, filas, tags_vistos: top.map((t) => ({ id: t.id, slug: t.slug, veces: t.n })) };
}

async function descubrePorCluster(ctx, gamma1, restante, semillas) {
  const intentos = [];
  const filas = [];
  const clusters = semillas.map(extraeCluster).filter((c) => c.evento_slug || c.evento_id || c.serie_id || c.serie_slug);
  if (!clusters.length) {
    return { camino: 'cluster', intentos: [{ nota: 'los mercados semilla no exponen evento ni serie — camino no disponible' }], filas };
  }
  const probados = new Set();
  for (const c of clusters.slice(0, 3)) {
    const tiros = [
      c.serie_id ? { que: 'serie_id', path: '/markets', params: { series_id: c.serie_id, closed: 'true', limit: 200 } } : null,
      c.serie_slug ? { que: 'serie_slug', path: '/events', params: { series_slug: c.serie_slug, closed: 'true', limit: 200 } } : null,
      c.evento_slug ? { que: 'evento_slug', path: '/events', params: { slug: c.evento_slug } } : null,
    ].filter(Boolean);
    for (const t of tiros) {
      const clave = t.que + ':' + JSON.stringify(t.params);
      if (probados.has(clave) || restante() < 35000) continue;
      probados.add(clave);
      const r = await gamma1(t.path, t.params);
      const encontradas = r.status === 'ok' ? filasDe(r.body).flatMap(aplanaMercados) : [];
      intentos.push({ via: t.que, endpoint: 'gamma' + t.path, status: r.status, http: r.http ?? null, filas: encontradas.length });
      filas.push(...encontradas);
    }
  }
  return { camino: 'cluster', intentos, filas };
}

function formaDe(body) {
  if (Array.isArray(body)) return 'array';
  if (body && typeof body === 'object') return 'objeto:' + Object.keys(body).slice(0, 8).join(',');
  return typeof body;
}

// Precio del Yes a T-24h de UN mercado. Dos formas de parámetros probadas en
// orden; se reporta cuál funcionó. Nunca lanza: un fallo del CLOB es una
// categoría del conteo, no el final del censo.
async function precioDeUnMercado(m, clob1) {
  const base = { slug: m.slug, pregunta: m.pregunta, symbol: m.symbol, fecha_resolucion: m.fecha_resolucion,
    outcome: m.outcome, consenso_pm: m.consenso_pm, reported_date: m.cruce ? m.cruce.reported_date : null };
  if (!m.token_yes) return { clase: 'sin_token', forma: 'n/a', fila: { ...base, yes_t24h: null, motivo: 'sin_token_yes' } };
  const finMs = ts(m.fin_real || m.fin_declarado);
  if (!finMs) return { clase: 'sin_precio', forma: 'n/a', fila: { ...base, yes_t24h: null, motivo: 'sin_fecha_de_resolucion' } };

  const desdeTs = Math.floor((finMs - 72 * 3600 * 1000) / 1000);
  const hastaTs = Math.floor(finMs / 1000);
  let r = await clob1('/prices-history', { market: m.token_yes, startTs: desdeTs, endTs: hastaTs, fidelity: 60 });
  let forma = 'startTs/endTs';
  if (r.status !== 'ok' || !(r.body && Array.isArray(r.body.history) && r.body.history.length)) {
    r = await clob1('/prices-history', { market: m.token_yes, interval: 'max', fidelity: 60 });
    forma = 'interval=max';
  }
  if (r.status !== 'ok') {
    return { clase: 'error', forma, fila: { ...base, yes_t24h: null, clob: { status: r.status, http: r.http ?? null } } };
  }
  const history = r.body ? (Array.isArray(r.body.history) ? r.body.history : filasDe(r.body)) : [];
  const precio = precioEnT24h(history, finMs);
  return {
    clase: clasificaT24h(precio), forma,
    fila: { ...base, clob: { status: r.status, http: r.http ?? null, ms: r.ms, forma, puntos: history.length }, yes_t24h: precio },
  };
}


export {
  buscaFrase, descubrePorBusqueda, descubrePorSimbolo, descubrePorTags, descubrePorCluster,
  cosechaDeBusqueda, filasDe, aplanaMercados, formaDe, idDeMercado, precioDeUnMercado,
  PAGINAS_BUSQUEDA, LIMITE_BUSQUEDA, PAGINAS_POR_SIMBOLO, CONCURRENCIA_CLOB,
};
