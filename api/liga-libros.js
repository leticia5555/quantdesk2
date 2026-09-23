// ═══════════════════════════════════════════════════════════════
// /api/liga/libros — B11: el LIBRO de cada agente, y CÓMO llegó a él.
//
// Hermano de `/api/liga/eventos`. Aquel cuenta lo que PASÓ (órdenes, rechazos,
// cambios de líder); éste cuenta lo que el agente DECIDIÓ y, sobre todo, **cómo
// investigó** — que es lo más publicable de todo el proyecto y lo que nadie más
// está mostrando.
//
// Por agente: portafolio objetivo · tesis por posición · secuencia de
// investigación · enfoque del día. El control MARCADO y las etiquetas de modelo
// correctas — la etiqueta legible del registry (`model_label`), nunca el slug
// crudo de la API. El slug es un detalle de implementación que además cambia
// con un override de env var, y publicarlo haría que la tabla de la liga dijera
// cosas distintas según qué env vars estuvieran puestas ese día. (Además, la
// regla de la casa es que un ID de modelo vive en UN solo archivo: _lib/model.js.)
//
// ── LA SECUENCIA ES UNA HISTORIA, NO OCHO VOLCADOS ───────────────────
//
//   "buscó semis con RVOL alto → leyó las noticias de NVDA → pidió la ficha de
//    AMD → no compró ninguna"
//
// Eso es una historia. Ocho volcados de datos no lo son. Acá viaja el RESUMEN
// de cada llamada (herramienta, argumentos, cuántas filas, si se truncó), nunca
// el resultado completo. El resultado completo sí se journalea —el replay lo
// necesita— pero mover megabytes por un feed público que no los usa sería
// pagarlos en cada carga.
//
// ── LAS DOS FUENTES, SIEMPRE ETIQUETADAS ─────────────────────────────
// Lee `arena_journal` (la liga viva) Y `arena_shadow_journal` (la sombra), y
// CADA fila dice de cuál vino. Mientras el contrato nuevo corra solo en sombra,
// éste es el único lugar donde se puede ver un portafolio objetivo — y
// confundir una decisión de sombra con una real sería exactamente el error que
// las tablas separadas existen para impedir. Por eso `fuente` no es opcional ni
// se infiere: viaja en cada libro.
//
// ── RESTRICCIONES (las mismas que /eventos y /audit, por el mismo motivo) ──
//   · CERO writes. Puros SELECT. NO llama a ensureSchema() (hace CREATE/ALTER)
//     ni a beat() — latir acá enmascararía un cron muerto.
//   · NO importa arena-run ni el guard: el camino de decisión no se toca ni de
//     lectura.
//   · Del `context` se proyecta SOLO lo publicable. Los prompts completos NO
//     salen: son el material con el que se reconstruye la corrida, no material
//     de show, y algunos llevan el libro entero del agente.
//
// Query: ?dias=N (default 3, máx 30) · ?agente=<id> · ?fuente=viva|sombra|ambas
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { ARENA_AGENTS, ARENA_SEASON, seasonStatus, seasonDay } from './_lib/arena-registry.js';
import { pairwiseOverlap, sharedTopTicker, pisoDeRuido, deltaDePesos, lecturaDeCoincidencia, CAVEAT_ENFOQUE } from './_lib/arena-herding.js';
import { claveDeOrden, detalleDeOrden, fillsDeActions, entradasDeCuenta, resumenDeOrdenes, resumenDeslizamiento, ordenesDeActions } from './_lib/arena-fills.js';

const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

// Identidad publicable de un agente. La ETIQUETA, no el slug: el slug es un
// detalle de implementación que además cambia con un override de env var, y
// publicarlo haría que la tabla de la liga dijera cosas distintas según qué
// env vars estuvieran puestas ese día.
export function identidad(agentId) {
  const a = ARENA_AGENTS.find((x) => x.id === agentId) || null;
  if (!a) return { id: agentId, nombre: agentId, modelo: null, control: false, casa: null };
  return {
    id: a.id,
    nombre: a.name,
    modelo: a.model_label,
    // EL CONTROL VA MARCADO SIEMPRE. Es el piso de ruido: leer su resultado
    // como el de un competidor más invalida la única referencia que hace
    // significativo cualquier delta entre modelos.
    control: !!a.control,
    ...(a.control ? { control_nota: 'CONTROL: mismo modelo, mismo prompt y mismos parámetros que Claude, distinta cuenta. Es el piso de ruido — su resultado NO es el de un competidor, es la medida de cuánto varía el mismo modelo consigo mismo.' } : {}),
    casa: a.house,
    arquetipo: a.archetype ? a.archetype.name : null,
  };
}

// La secuencia, en forma de historia. Cada paso con lo justo para leerse.
export function secuenciaPublicable(ctx) {
  const t = ctx && ctx.tools;
  if (!t) return null;
  if (t.enabled === false) return { usó_herramientas: false, motivo: t.reason || null, pasos: [] };
  const pasos = (t.summary || t.sequence || []).map((s) => ({
    n: s.n, herramienta: s.tool,
    // Los argumentos YA acotados (lo que de verdad se ejecutó), no lo que pidió.
    argumentos: s.args || null,
    filas: s.rows ?? null,
    truncado: !!s.truncated,
    ms: s.ms ?? null,
    ...(s.refused ? { rechazada: s.refused } : {}),
  }));
  return {
    usó_herramientas: pasos.length > 0,
    presupuesto: t.budget ?? null,
    usadas: t.used ?? pasos.length,
    vueltas: t.turns ?? null,
    terminó_por: t.stopped_by || null,
    pasos,
  };
}

// ── EL SELLO: DOS COSAS DISTINTAS EN UNA ETIQUETA ────────────────────
// Un libro tiene que decir DOS cosas que no son la misma:
//
//   1. QUÉ CAMINO corrió: la liga de verdad (`en_vivo`) o el contrato nuevo
//      corriendo en paralelo sobre el mismo mercado (`prueba`).
//   2. SI SALIÓ UNA ORDEN. Una corrida en vivo con la bandera en seco calculó
//      las órdenes completas y no mandó ninguna — es la MISMA tabla y el mismo
//      camino que una que sí movió dinero.
//
// Antes eran dos chips sueltos y la segunda se leía como una aclaración de la
// primera. Ahora es UNA etiqueta que dice las dos: "EN VIVO · SIN ENVIAR".
//
// Se calcula ACÁ y no en la página: la auditoría en markdown dice lo mismo, y
// dos lugares armando la etiqueta es la forma de que un día difieran.
export const SELLOS = { en_vivo: 'EN VIVO', prueba: 'PRUEBA', sin_enviar: 'EN VIVO · SIN ENVIAR' };

export function selloDe(fuente, ejecucion) {
  if (fuente === FUENTE_PRUEBA) return SELLOS.prueba;
  // `dry` es el valor journaleado; "SIN ENVIAR" es cómo se lee.
  return ejecucion && ejecucion.modo === 'dry' ? SELLOS.sin_enviar : SELLOS.en_vivo;
}

// Los dos valores de `fuente`, que son los dos JOURNALES. Se publican con el
// nombre que se lee, no con el de la tabla: `arena_shadow_journal` sigue
// llamándose así —renombrar una tabla es una migración— pero nadie que lea la
// liga tiene que saber eso para entender la etiqueta.
export const FUENTE_VIVA = 'en_vivo';
export const FUENTE_PRUEBA = 'prueba';

// Una fila del journal (en vivo o de prueba) → el libro publicable.
export function libroDeFila(row, fuente) {
  const ctx = row.context || {};
  // ── LOS FILLS Y EL LIBRO DE ANTES ─────────────────────────────────
  // `actions` es la única estructura que el reconcile RE-ESCRIBE después de la
  // corrida: ahí viven el precio de ejecución, la cantidad llenada y la hora.
  // `account` es la foto del libro ANTES de operar, que es contra lo que se
  // mide el resultado de una venta. Las corridas de PRUEBA no tienen ninguno
  // de los dos —no mandan órdenes—, y ahí el fill sale null, que es correcto.
  const fills = fillsDeActions(row.actions || []);
  const entradas = entradasDeCuenta(row.account || null);
  const target = row.target || null;
  const reb = row.rebalance || null;
  return {
    fuente,                                   // 'en_vivo' | 'prueba' — NUNCA se infiere
    // La etiqueta ya armada, con las dos cosas que tiene que decir.
    sello: selloDe(fuente, ctx.ejecucion),
    fecha: row.created_at || row.run_date,
    agente: identidad(row.agent_id),
    estado: row.status,
    plan: row.plan || null,
    // El portafolio objetivo. null cuando la corrida usó el contrato viejo
    // (órdenes) — y eso también es información: dice qué contrato corrió ese día.
    portafolio: target ? {
      pesos: target.weights || null,
      cash: target.cash ?? null,
      tesis: target.theses || null,
    } : null,
    // El ENFOQUE del día (B8). Es un confound deliberado y se publica como tal:
    // dos agentes con enfoques distintos el mismo día no son comparables ese día.
    enfoque: ctx.lens || null,
    enfoque_nota: ctx.lens ? 'El enfoque rota por agente y por día (momentum/catalizador/valor/reversión). Es un confound DELIBERADO: dos agentes con enfoques distintos el mismo día no son comparables ese día.' : null,
    // CÓMO INVESTIGÓ.
    investigacion: secuenciaPublicable(ctx),
    // ── LOS PESOS ACTUALES, que son la otra mitad del delta ──────────
    // `objetivo − actual` es lo que el agente DECIDIÓ CAMBIAR, y es lo único
    // comparable entre dos cuentas que heredaron carteras distintas. Sin los
    // actuales, sólo se puede comparar lo que cada uno TIENE — que a mitad de
    // temporada mide herencia.
    pesos_actuales: reb && reb.current ? reb.current : null,
    // Qué habría hecho el motor con ese objetivo.
    rebalanceo: reb ? {
      ordenes: (reb.legs || []).length,
      turnover: reb.turnover ?? null,
      recortes_de_riel: (reb.rail_trims || []).length,
      canceladas: (reb.cancel || []).length,
    } : null,
    // ── LOS RIELES ───────────────────────────────────────────────────
    // `status: 'rejected_rails'` dice QUE se rechazó; esto dice CUÁL riel y
    // por qué. Es la diferencia entre "el agente falló" y "pidió un 15% en un
    // nombre con tope de 12%".
    rieles: ctx.rails ? {
      ok: !!ctx.rails.ok,
      violaciones: (ctx.rails.violations || []).map((v) => ({
        riel: v.rail, ticker: v.symbol || null, detalle: v.detail || null,
        // Una caída mayorista de /v2/assets NO es un objetivo malo: es una
        // falla nuestra, y la página tiene que decirlo con esas palabras.
        ...(v.es_falla_nuestra ? { es_falla_nuestra: true } : {}),
      })),
    } : null,
    // ── LAS ÓRDENES ──────────────────────────────────────────────────
    // `modo` NO es decorativo: 'dry' significa que se calcularon COMPLETAS y
    // no se mandó ninguna. Una corrida SIN ENVIAR y una que movió dinero se
    // journalean en la misma tabla, y confundirlas sería el mismo error que
    // las tablas separadas existen para impedir del lado de la sombra.
    // ── SIN `ejecucion` PERO CON ÓRDENES: LAS SALIDAS DE RIESGO ──────
    // Una fila `risk_exit` (stop catastrófico, trailing, breaker) NO tiene
    // `context.ejecucion` — no la escribió el contrato objetivo, la escribió la
    // red determinista— pero SÍ tiene `actions`, y el reconcile les pone su
    // precio de ejecución como a cualquier otra. Sin este respaldo, las ventas
    // que más importan —las que disparó un stop— eran las únicas que seguían
    // sin decir a cuánto se vendieron. Vale igual para las filas del contrato
    // VIEJO, que nunca tuvieron `ordenes_calculadas`.
    ordenes: ctx.ejecucion
      ? ejecucionPublicable(ctx.ejecucion, { fills, entradas })
      : ordenesSueltas(row.actions || [], row.account || null, row.status),
    // Qué contrato corrió esa vuelta, tal como se journaleó. NO se infiere del
    // contenido: una fila vieja sin el campo sale null, y null es un dato.
    contrato: ctx.contrato || null,
    posiciones_iniciales: Array.isArray(ctx.posiciones_iniciales) ? ctx.posiciones_iniciales : null,
    error: row.error || null,
  };
}

// La ejecución, publicable. Las órdenes CALCULADAS son la lista (existen en
// sin enviar y en vivo); el resultado de cada una se pega encima cuando se mandó.
//
// ── EL FILL VIVE EN OTRA ESTRUCTURA, Y POR ESO FALTABA EL PRECIO ─────
// `context.ejecucion.enviadas` se escribe UNA vez, cuando la orden se manda:
// ahí el estado es `accepted` y todavía no hay precio de ejecución. Quien
// escribe el precio, la cantidad llenada y la hora es `runArenaReconcile`, y lo
// hace sobre la columna `actions` — otra estructura, que esta proyección no
// miraba. El dato estaba en el journal y no llegaba a la pantalla.
//
// `fills` son esas filas de `actions` y `entradas` es el libro de ANTES de la
// corrida (`account.holdings`), que es contra lo que se mide una venta. Sin
// ellos la función degrada a lo de antes en vez de romperse: las órdenes salen
// con su cantidad y su límite y el fill sale en null, que es lo que significa.
export function ejecucionPublicable(e, { fills = null, entradas = null } = {}) {
  if (!e) return null;
  // ── EL MAPA DE `enviadas` NECESITA LAS DOS CLAVES ─────────────────
  // Las filas de `enviadas` SÍ llevan `client_order_id` (lo pone `enviarOrdenes`);
  // las de `ordenes_calculadas` NO (lo pone el envío, después). Así que buscar
  // por `client_order_id || symbol` desde el lado calculado nunca acertaba: el
  // resultado del envío salía null en TODA corrida viva, y la página mostraba
  // "calculada" para órdenes que sí se habían mandado. Se indexa por las dos.
  const enviadas = new Map();
  for (const o of e.enviadas || []) {
    const cid = o.client_order_id ? String(o.client_order_id) : null;
    if (cid) enviadas.set(cid, o);
    const alt = o.symbol ? `${String(o.symbol).toUpperCase()}|${String(o.side || '').toLowerCase()}` : '';
    if (alt && !enviadas.has(alt)) enviadas.set(alt, o);
  }
  const porFill = fills || new Map();
  const ordenes = (e.ordenes_calculadas || []).map((o) => {
    const clave = claveDeOrden(o);
    const r = enviadas.get(clave) || enviadas.get(String(o.client_order_id || '')) || null;
    // El fill reconciliado gana sobre el eco del envío: el segundo dice
    // `accepted` para siempre, el primero dice a cuánto llenó.
    const fill = porFill.get(clave)
      || (o.symbol ? porFill.get(`${String(o.symbol).toUpperCase()}|${String(o.side || '').toLowerCase()}`) : null)
      // Sin fila conciliada se usa el eco del envío, que al menos trae
      // `result` y el estado inicial. `enviadas` vacío (modo seco) → null, y
      // `detalleDeOrden` lo publica como `sin_enviar`.
      || (r ? { symbol: String(o.symbol || '').toUpperCase(), side: o.side, qty: o.qty,
        filled_qty: null, filled_avg_price: null, filled_at: null,
        order_status: r.order_status || null, result: r.result || null, error: r.error || null,
        intencion: o.intencion || null, client_order_id: r.client_order_id || null,
        alpaca_order_id: r.alpaca_order_id || null } : null);
    const d = detalleDeOrden({
      orden: o, fill,
      entrada: entradas ? entradas[String(o.symbol || '').toUpperCase()] || null : null,
    });
    return {
      ...d,
      // Nombres que la página ya usaba. Se conservan para no romper un
      // consumidor viejo por un renombre: `monto` es lo que se PIDIÓ al
      // límite; `monto_usd` es lo que de verdad se movió.
      cantidad: d.cantidad_pedida,
      monto: o.notional_real ?? d.monto_pedido_usd,
    };
  });
  return {
    modo: e.modo || null,
    modo_nota: e.modo === 'dry'
      ? 'SIN ENVIAR: las órdenes se calcularon completas y NO se mandó ninguna.'
      : e.modo === 'enviado' ? 'EN VIVO: estas órdenes se mandaron a Alpaca.' : null,
    // El candado: si alguna orden no correspondía a ningún peso, no se mandó
    // NINGUNA de esa corrida. Que se vea cuando frenó.
    candado_ok: e.candado ? !!e.candado.ok : null,
    freno: e.freno || null,
    nota: e.nota || null,
    ordenes,
    // Cuánto se compró, cuánto se vendió, cuánto se realizó y cuántas no
    // llenaron. Se calcula acá y no en la página: es dinero.
    resumen: resumenDeOrdenes(ordenes),
    descartadas: (e.descartadas || []).map((d) => ({
      ticker: d.symbol || null, lado: d.side || null, motivo: d.motivo || null,
    })),
  };
}

// Órdenes de una fila que no pasó por el contrato objetivo: se arman de
// `actions` sola. Devuelve la MISMA forma que `ejecucionPublicable` para que la
// página no tenga que distinguir de dónde salieron — lo que sí cambia es la
// nota, porque el origen es un hecho y no un detalle.
export function ordenesSueltas(actions = [], account = null, estado = null) {
  const ordenes = ordenesDeActions(actions, account);
  if (!ordenes.length) return null;
  const esRiesgo = String(estado || '') === 'risk_exit';
  return {
    modo: 'enviado',
    modo_nota: esRiesgo
      ? 'RED DETERMINISTA: estas ventas las disparó un stop, no el PM. Corren sin LLM y no se pueden apagar.'
      : 'Órdenes journaleadas sin el detalle del contrato objetivo (fila del contrato viejo): sale lo que hay.',
    candado_ok: null, freno: null, nota: null,
    ordenes, resumen: resumenDeOrdenes(ordenes), descartadas: [],
  };
}

// ── QUIÉN USA QUÉ HERRAMIENTA, Y CUÁNTAS VECES ───────────────────────
// LA PREGUNTA QUE CONTESTA (2026-09-23): el tablero es una MUESTRA del universo
// —los top-30 por cambio, los top-20 por RVOL, los extremos de 52 semanas— y el
// universo completo (~600 nombres) está a una llamada de `screener`. Meter esa
// lista entera en el tablero cuesta ~4,000 tokens por corrida y por agente.
//
// Antes de pagarlos hay que saber si el acceso es el problema. Si los agentes
// casi no llaman al screener, **no les falta acceso: no saben que lo tienen**, y
// eso se arregla con una línea de veinte tokens en vez de cuatro mil.
//
// Tres números distintos, porque contestan cosas distintas:
//   · `llamadas` — cuántas veces la llamó en total. Un agente que la llama seis
//     veces en una corrida y ninguna en las otras cinco no "la usa".
//   · `corridas_con_uso` — en cuántas corridas la tocó AL MENOS una vez. Éste es
//     el que dice si la herramienta está en su repertorio.
//   · `abortadas` — una corrida que murió antes de investigar no cuenta como
//     "decidió no usarla". Mezclarlas haría parecer desuso lo que es una falla
//     del proveedor.
export const HERRAMIENTAS = ['screener', 'noticias', 'ficha', 'sector'];

export function resumenDeHerramientas(libros = []) {
  const porAgente = new Map();
  const vacio = () => ({
    corridas: 0, abortadas: 0, con_investigacion: 0, sin_uso: 0,
    llamadas: 0, por_herramienta: {}, corridas_con_uso: {},
  });

  for (const l of (Array.isArray(libros) ? libros : [])) {
    const id = (l.agente && l.agente.id) || 'desconocido';
    if (!porAgente.has(id)) porAgente.set(id, { agente: id, nombre: (l.agente && l.agente.nombre) || id, ...vacio() });
    const a = porAgente.get(id);
    a.corridas++;
    if (String(l.estado || '').startsWith('aborted')) { a.abortadas++; continue; }
    const pasos = (l.investigacion && l.investigacion.pasos) || [];
    if (!pasos.length) { a.sin_uso++; continue; }
    a.con_investigacion++;
    const enEstaCorrida = new Set();
    for (const p of pasos) {
      const t = String((p && p.herramienta) || '').trim().toLowerCase();
      if (!t) continue;
      a.llamadas++;
      a.por_herramienta[t] = (a.por_herramienta[t] || 0) + 1;
      enEstaCorrida.add(t);
    }
    for (const t of enEstaCorrida) a.corridas_con_uso[t] = (a.corridas_con_uso[t] || 0) + 1;
  }

  const filas = [...porAgente.values()].map((a) => {
    // El denominador son las corridas que PUDIERON investigar: una abortada no
    // decidió no usar el screener, se murió antes.
    const vivas = a.corridas - a.abortadas;
    const screener = a.por_herramienta.screener || 0;
    const conScreener = a.corridas_con_uso.screener || 0;
    return {
      ...a,
      corridas_vivas: vivas,
      screener_llamadas: screener,
      screener_corridas: conScreener,
      screener_pct_corridas: vivas > 0 ? +((conScreener / vivas) * 100).toFixed(1) : null,
      screener_por_corrida: vivas > 0 ? +(screener / vivas).toFixed(2) : null,
    };
  }).sort((x, y) => (y.screener_pct_corridas ?? -1) - (x.screener_pct_corridas ?? -1));

  const vivasTotal = filas.reduce((s, f) => s + f.corridas_vivas, 0);
  const conScreenerTotal = filas.reduce((s, f) => s + f.screener_corridas, 0);
  const porHerramienta = {};
  for (const f of filas) {
    for (const [t, n] of Object.entries(f.por_herramienta)) porHerramienta[t] = (porHerramienta[t] || 0) + n;
  }
  const pct = vivasTotal > 0 ? +((conScreenerTotal / vivasTotal) * 100).toFixed(1) : null;

  return {
    por_agente: filas,
    liga: {
      corridas_vivas: vivasTotal,
      abortadas: filas.reduce((s, f) => s + f.abortadas, 0),
      llamadas: filas.reduce((s, f) => s + f.llamadas, 0),
      por_herramienta: porHerramienta,
      screener_pct_corridas: pct,
      // La lectura, para que el número no haya que interpretarlo dos veces.
      lectura: pct == null
        ? 'Sin corridas vivas en la ventana: no hay uso que contar.'
        : pct >= 70
          ? `El screener se usa en el ${pct}% de las corridas: el acceso al universo NO es el cuello de botella. Si igual se quiere el universo en el tablero, que sea por otra razón.`
          : pct >= 30
            ? `El screener se usa en el ${pct}% de las corridas: lo conocen y no siempre lo usan. Antes de pagar el tablero completo, conviene ver QUÉ filtran cuando lo llaman.`
            : `El screener se usa en el ${pct}% de las corridas. No les falta ACCESO al universo: les falta saber que lo tienen. Una línea en el prompt cuesta ~20 tokens; meter el universo en el tablero cuesta ~4,000 por agente y por corrida.`,
    },
    nota: 'Cuenta los pasos journaleados en `context.tools.summary`. Una corrida ABORTADA no cuenta como "decidió no investigar": no llegó. Por eso el denominador son las corridas vivas.',
  };
}

// Deslizamiento por agente sobre la ventana. Reusa `resumenDeslizamiento` —el
// cálculo vive en `_lib/arena-fills.js` con el resto del dinero— y acá solo se
// agrupa. Las corridas de PRUEBA quedan fuera: no mandan órdenes, así que no
// tienen fills y meterlas solo diluiría el denominador.
export function deslizamientoPorAgente(libros = []) {
  const porAgente = new Map();
  for (const l of (Array.isArray(libros) ? libros : [])) {
    if (l.fuente === FUENTE_PRUEBA) continue;
    const ordenes = (l.ordenes && l.ordenes.ordenes) || [];
    if (!ordenes.length) continue;
    const id = (l.agente && l.agente.id) || 'desconocido';
    if (!porAgente.has(id)) porAgente.set(id, { agente: id, nombre: (l.agente && l.agente.nombre) || id, ordenes: [] });
    porAgente.get(id).ordenes.push(...ordenes);
  }
  const filas = [...porAgente.values()]
    .map((a) => ({ agente: a.agente, nombre: a.nombre, ...resumenDeslizamiento(a.ordenes) }))
    .filter((a) => a.fills > 0)
    .sort((x, y) => y.media_pp - x.media_pp);

  // El par claude↔control es el que hace legible la tabla: los dos corren el
  // MISMO modelo con el mismo prompt, así que lo que los separa acá es el
  // mecanismo, no el modelo. Un agente que desliza más que ESA distancia es el
  // candidato real a "el límite marketable le trabaja mal".
  const de = (id) => filas.find((f) => f.agente === id) || null;
  const a = de('claude'), b = de('control');
  const piso = (a && b && a.media_pp != null && b.media_pp != null)
    ? +Math.abs(a.media_pp - b.media_pp).toFixed(3) : null;

  return {
    por_agente: filas,
    // Mismo criterio que el piso de ruido del ranking: un delta entre agentes
    // que no supera lo que separa a dos corridas idénticas no significa nada.
    piso_claude_control_pp: piso,
    lectura: !filas.length
      ? 'Todavía no hay fills con referencia del riel en esta ventana.'
      : piso == null
        ? `${filas.length} agente(s) con fills. Sin el par claude↔control completo no hay piso contra el cual leer las diferencias: una brecha chica entre dos modelos puede ser el mecanismo y no el modelo.`
        : `El par claude↔control —mismo modelo, mismo prompt— se separa ${piso} pp. Una diferencia de deslizamiento menor que eso entre dos agentes distintos no es atribuible a nadie.`,
    nota: 'Solo corridas EN VIVO: las de prueba no mandan órdenes. Una semana de sesiones es el mínimo para que la media por agente signifique algo — con dos o tres fills, un nombre ilíquido mueve el promedio entero.',
  };
}

// ── EL DÍA, NO LA VENTANA ────────────────────────────────────────────
// La coincidencia y el piso de ruido son hechos de UN DÍA. Promediarlos sobre
// tres días daría un número que no corresponde a ninguna corrida y que además
// mezcla enfoques: el 16 claude miró momentum y el 17 valor.
//
// Se agrupa por día Y POR FUENTE. Un libro de sombra y uno vivo del mismo día
// no son el mismo experimento —uno movió dinero y el otro no— y meterlos en el
// mismo coseno sería comparar dos corridas distintas del mismo agente.
//
// De cada agente cuenta su ÚLTIMA corrida del día: con tres rondas fijas hay
// varias filas por agente y por día, y el libro que quedó en pie es el último.
//
// CERO writes: el piso se calcula (misma función que el reporte de la sombra)
// y NO se archiva. Archivar es del reporte, que sí escribe.
export function resumenPorDia(libros) {
  const dias = new Map();
  for (const l of libros) {
    const dia = String(l.fecha || '').slice(0, 10);
    if (!dia) continue;
    const clave = dia + '|' + l.fuente;
    if (!dias.has(clave)) dias.set(clave, { dia, fuente: l.fuente, ultimos: new Map() });
    const g = dias.get(clave);
    // `libros` viene ordenado de más nuevo a más viejo: el primero que aparece
    // por agente ES el último del día.
    if (!g.ultimos.has(l.agente.id)) g.ultimos.set(l.agente.id, l);
  }

  const out = [];
  for (const g of dias.values()) {
    const pesos = {};
    for (const [id, l] of g.ultimos) {
      const w = l.portafolio && l.portafolio.pesos;
      if (w && Object.keys(w).length) pesos[id] = w;
    }
    const n = Object.keys(pesos).length;

    // ── QUIÉN ENTRÓ Y QUIÉN QUEDÓ FUERA ──────────────────────────────
    // La coincidencia se calcula sobre los que TERMINARON con un libro. El
    // número no está mal; estaba mal ROTULADO: "entre 4 libros" se lee como un
    // hecho del día cuando es un hecho de un subconjunto que cambia solo — el
    // día que tres agentes abortan, el denominador se mueve sin que nada lo
    // diga y la serie deja de ser comparable consigo misma.
    //
    // Así que viaja con el censo del día: cuántos agentes corrieron, cuántos
    // dejaron libro, y quién quedó afuera CON SU MOTIVO. Un aborto es un
    // resultado del experimento, no una fila que falta.
    const fuera = [];
    for (const [id, l] of g.ultimos) {
      if (pesos[id]) continue;
      const estado = String(l.estado || '');
      fuera.push({
        agente: id,
        nombre: (l.agente && l.agente.nombre) || id,
        estado: estado || null,
        // `aborted_*` es un aborto de la corrida; cualquier otro estado sin
        // pesos es un libro vacío o una corrida del contrato viejo, y NO es lo
        // mismo. Se distinguen porque llevan a arreglar cosas distintas.
        aborto: estado.startsWith('aborted'),
        motivo: l.error || null,
      });
    }
    const censo = {
      agentes_en_la_corrida: g.ultimos.size,
      con_libro: n,
      fuera: fuera.length,
      abortados: fuera.filter((f) => f.aborto).length,
      detalle_fuera: fuera,
      // La frase, armada una sola vez acá: la página y la auditoría dicen lo
      // mismo o un día difieren.
      etiqueta: fuera.length
        ? `entre ${n} de ${g.ultimos.size} libros · ${fuera.length} fuera (${fuera.map((f) => `${f.agente}: ${f.estado || 'sin libro'}`).join(', ')})`
        : `entre los ${n} libros de la corrida (ningún agente quedó fuera)`,
    };

    const coincidencia = n >= 2
      ? {
        ...pairwiseOverlap(pesos),
        nombre_mas_compartido: sharedTopTicker(pesos),
        libros: n,
        ...censo,
        lectura: null,
        caveat: CAVEAT_ENFOQUE,
      }
      : { pairs: [], mean: null, max: null, libros: n,
        ...censo,
        note: 'Hacen falta al menos DOS libros con pesos para que la coincidencia signifique algo.' };
    if (coincidencia.mean != null) coincidencia.lectura = lecturaDeCoincidencia(coincidencia.mean);

    const deAgente = (id) => {
      const l = g.ultimos.get(id);
      return l ? { enfoque: l.enfoque, posiciones_iniciales: l.posiciones_iniciales } : null;
    };
    // Los DELTAS: qué cambió cada uno. Es el piso que funciona cuando las
    // cuentas ya no arrancan iguales, y no exige tocarlas.
    const deltas = {};
    for (const [id, l] of g.ultimos) {
      const objetivo = l.portafolio && l.portafolio.pesos;
      const actual = l.pesos_actuales;
      if (objetivo && actual) deltas[id] = deltaDePesos(actual, objetivo);
    }
    const piso = pisoDeRuido({ insignia: deAgente('claude'), testigo: deAgente('control'), pesos, deltas });

    out.push({
      dia: g.dia, fuente: g.fuente,
      agentes: [...g.ultimos.keys()],
      corridas: g.ultimos.size,
      // El censo también a nivel del día: quién entró, quién quedó fuera y por
      // qué. Duplica lo que va dentro de `coincidencia` a propósito — un
      // consumidor que solo mira el resumen del día no debería tener que
      // entrar al bloque de la métrica para saber cuántos agentes hubo.
      censo: {
        agentes_en_la_corrida: coincidencia.agentes_en_la_corrida,
        con_libro: coincidencia.con_libro,
        fuera: coincidencia.fuera,
        abortados: coincidencia.abortados,
        detalle_fuera: coincidencia.detalle_fuera,
      },
      enfoques: Object.fromEntries([...g.ultimos].map(([id, l]) => [id, l.enfoque || null])),
      coincidencia,
      piso_de_ruido: piso,
    });
  }
  out.sort((a, b) => (b.dia.localeCompare(a.dia) || a.fuente.localeCompare(b.fuente)));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const dias = int(q.dias, 3, 1, 30);
  const agente = String(q.agente || '').trim().toLowerCase() || null;
  // Los nombres VIEJOS siguen funcionando como alias: un curl guardado no se
  // rompe porque la etiqueta se lea distinto. Lo que devuelve la respuesta es
  // siempre el nombre nuevo.
  const ALIAS_FUENTE = { viva: FUENTE_VIVA, sombra: FUENTE_PRUEBA, en_vivo: FUENTE_VIVA, prueba: FUENTE_PRUEBA, ambas: 'ambas' };
  const fuente = ALIAS_FUENTE[String(q.fuente || '').trim().toLowerCase()] || 'ambas';
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

  const libros = [];
  const avisos = [];

  if (fuente === FUENTE_VIVA || fuente === 'ambas') {
    try {
      // ── DÓNDE VIVE EL OBJETIVO EN LA TABLA VIVA ───────────────────
      // `arena_journal` no tiene columnas `target` ni `rebalance` (es la tabla
      // del contrato viejo, que journaleaba ÓRDENES). El contrato objetivo las
      // mete DENTRO de `context` — y esta proyección no las sacaba, así que
      // toda corrida viva salía con `portafolio: null` y la página habría
      // dibujado siete tarjetas vacías el día del encendido. La sombra se veía
      // bien porque allá sí son columnas.
      const rows = await sql(
        `select run_date, created_at, agent_id, status, plan, error,
                -- actions es la UNICA columna que el reconcile re-escribe:
                -- sin ella no hay precio de ejecucion ni hora. account es el
                -- libro de ANTES de operar, que es contra lo que se mide una
                -- venta. Las dos faltaban, y por eso la pantalla solo decia
                -- que la orden estaba llena y no a cuanto.
                actions, account,
                context->'target' as target,
                context->'rebalance' as rebalance,
                jsonb_build_object(
                  'lens', context->>'lens',
                  'tools', context->'tools',
                  'rails', context->'rails',
                  'ejecucion', context->'ejecucion',
                  'contrato', context->>'contrato',
                  'posiciones_iniciales', context->'posiciones_iniciales'
                ) as context
         from arena_journal
         where phase = 'decide' and agent_id <> 'league' and run_date >= $1::date
           ${agente ? 'and agent_id = $2' : ''}
         order by created_at desc limit 200`,
        agente ? [desde, agente] : [desde],
      );
      for (const r of rows || []) libros.push(libroDeFila(r, FUENTE_VIVA));
    } catch (e) {
      avisos.push('No se pudo leer el journal EN VIVO: ' + String((e && e.message) || e));
    }
  }

  if (fuente === FUENTE_PRUEBA || fuente === 'ambas') {
    try {
      const rows = await sql(
        `select run_date, created_at, agent_id, status, plan, error, target, rebalance,
                jsonb_build_object(
                  'lens', context->>'lens',
                  'tools', context->'tools',
                  'rails', context->'rails',
                  'ejecucion', context->'ejecucion',
                  'posiciones_iniciales', context->'posiciones_iniciales'
                ) as context
         from arena_shadow_journal
         where run_date >= $1::date ${agente ? 'and agent_id = $2' : ''}
         order by created_at desc limit 200`,
        agente ? [desde, agente] : [desde],
      );
      for (const r of rows || []) libros.push(libroDeFila(r, FUENTE_PRUEBA));
    } catch (e) {
      // La tabla puede no existir todavía (la sombra nunca corrió). Eso NO es
      // un error del endpoint: es un estado, y se dice como tal.
      avisos.push('Todavía no hay corridas de PRUEBA (nunca se corrió el contrato nuevo en paralelo, o la tabla no existe).');
    }
  }

  libros.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  const conObjetivo = libros.filter((l) => l.portafolio);
  const conHerramientas = libros.filter((l) => l.investigacion && l.investigacion.usó_herramientas);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    temporada: {
      id: ARENA_SEASON.id, nombre: ARENA_SEASON.name,
      start: ARENA_SEASON.start, end: ARENA_SEASON.end,
      estado: seasonStatus(), dia: seasonDay(),
    },
    ventana: { dias, desde },
    filtros: { agente, fuente },
    conteos: {
      libros: libros.length,
      con_portafolio_objetivo: conObjetivo.length,
      con_investigacion: conHerramientas.length,
      de_prueba: libros.filter((l) => l.fuente === FUENTE_PRUEBA).length,
    },
    nota_fuente: 'Cada libro trae su sello. EN VIVO es la liga de verdad. PRUEBA es el contrato nuevo corriendo en paralelo sobre el mismo mercado y sin mandar una sola orden. EN VIVO · SIN ENVIAR es la liga de verdad con la bandera en seco: las órdenes se calcularon completas y no salió ninguna.',
    // Por día y por fuente: la coincidencia entre los libros de ese día y el
    // piso de ruido claude↔control. El piso se CALCULA acá y no se archiva —
    // archivar escribe, y este endpoint no escribe. El archivo histórico vive
    // en /api/leaderboard?postmortem=1, que lo lee de `arena_noise_floor`.
    por_dia: resumenPorDia(libros),
    // ── EL USO DE HERRAMIENTAS EN LA VENTANA ─────────────────────────
    // Cuántas veces llamó cada agente a cada herramienta, y en cuántas
    // corridas. Contesta si el universo completo hace falta en el tablero o si
    // el screener ya está ahí y nadie lo llama. `?dias=7` da la semana.
    herramientas: resumenDeHerramientas(libros),
    // ── EL DESLIZAMIENTO POR AGENTE ──────────────────────────────────
    // Si uno paga sistemáticamente más que los otros por el MISMO mecanismo,
    // eso no es el modelo: es el límite marketable trabajando mal para él.
    // Sale de las mismas órdenes que ya se publican, así que no cuesta una
    // consulta más.
    deslizamiento: deslizamientoPorAgente(libros),
    avisos: avisos.length ? avisos : null,
    libros,
  });
}
