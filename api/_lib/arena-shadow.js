// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-shadow.js — B13: LA SOMBRA.
//
// El contrato nuevo (B5: portafolio objetivo) no puede estrenarse contra siete
// libros reales. La sombra lo corre con el MISMO tablero, las MISMAS
// herramientas y el MISMO mercado — y CERO órdenes.
//
// ── DOS CONDICIONES, Y LAS DOS SON ESTRUCTURALES ─────────────────────
//
// 1. `shadow=true` TIENE QUE SER IMPOSIBLE DE CONFUNDIR CON UNA CORRIDA REAL.
//    Por eso son TABLAS APARTE (`arena_shadow_journal`) y no una columna
//    booleana en `arena_journal`. Una bandera en la misma tabla está a UNA
//    CONSULTA MAL ESCRITA de contaminar el post-mortem: basta que alguien
//    olvide un `where shadow = false` una sola vez y las métricas de la
//    temporada quedan mezcladas para siempre, sin que nada falle a la vista.
//
//    Con tablas separadas, esa consulta mal escrita no devuelve datos de
//    sombra: devuelve un error de tabla inexistente, o nada. El modo de falla
//    pasa de "silencioso y permanente" a "ruidoso e inmediato".
//
// 2. LA SOMBRA GASTA DINERO DE VERDAD. Son llamadas reales a siete
//    proveedores. Va contra el MISMO `ARENA_DAILY_BUDGET_USD` que la liga viva
//    — si no, "la sombra es gratis" sería una creencia que se desmiente con la
//    factura. Su gasto se registra con `phase='shadow'` en el mismo contador.
//
// ── EL CANDADO DE LAS ÓRDENES ────────────────────────────────────────
// No alcanza con "no llamar a createLimitOrder": alcanza con que NO SE PUEDA.
// `shadowBroker()` devuelve un objeto con la misma forma que el cliente de
// Alpaca donde toda escritura LANZA. Si algún camino intenta mandar una orden
// en sombra, la corrida falla ruidosamente en vez de operar en silencio sobre
// una cuenta real. Hay un test que lo verifica.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { pairwiseOverlap, sharedTopTicker } from './arena-herding.js';
import { marketDay } from './arena-buffet-cache.js';

const SCHEMA = [
  `create table if not exists arena_shadow_journal (
     id            text primary key,
     run_date      date not null,
     agent_id      text not null,
     phase         text,
     status        text not null,
     prompt_version text,
     prompt_hash   text,
     model         text,
     plan          text,
     llm_response  text,
     target        jsonb,
     rebalance     jsonb,
     context       jsonb,
     error         text,
     created_at    timestamptz not null default now()
   )`,
  `create index if not exists arena_shadow_journal_idx on arena_shadow_journal (run_date, agent_id)`,
];

let ready = false;
export async function ensureShadowSchema() {
  if (ready) return;
  for (const q of SCHEMA) await sql(q);
  ready = true;
}

// ── EL BROKER QUE NO OPERA ───────────────────────────────────────────
// Misma FORMA que _lib/alpaca.js para lo que el runner usa, pero toda escritura
// lanza. Las LECTURAS sí pasan: la sombra necesita el libro real para calcular
// un diff realista — un rebalanceo contra un libro inventado no prueba nada.
export function shadowBroker(real) {
  const prohibido = (nombre) => () => {
    throw new Error(
      `SOMBRA: se intentó ${nombre} durante una corrida en sombra. La sombra NO opera, por diseño. ` +
      'Que esto lance en vez de ejecutar es el candado: una sombra que manda una orden es una corrida real mal etiquetada.',
    );
  };
  return {
    // lecturas: pasan al cliente real
    getAccount: real.getAccount, getPositions: real.getPositions, getOrders: real.getOrders,
    getOrder: real.getOrder, getClock: real.getClock, getCalendar: real.getCalendar,
    // escrituras: LANZAN
    createLimitOrder: prohibido('createLimitOrder'),
    cancelOrder: prohibido('cancelOrder'),
    cancelAllOrders: prohibido('cancelAllOrders'),
    closeAllPositions: prohibido('closeAllPositions'),
    __shadow: true,
  };
}

// ── EL JOURNAL DE LA SOMBRA ──────────────────────────────────────────
export async function shadowJournalInsert(row) {
  await ensureShadowSchema();
  await sql(
    `insert into arena_shadow_journal
       (id, run_date, agent_id, phase, status, prompt_version, prompt_hash, model, plan, llm_response, target, rebalance, context, error)
     values ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (id) do nothing`,
    [row.id, row.run_date, row.agent_id, row.phase || 'decide', row.status,
     row.prompt_version || null, row.prompt_hash || null, row.model || null,
     row.plan || null, row.llm_response || null,
     row.target ? JSON.stringify(row.target) : null,
     row.rebalance ? JSON.stringify(row.rebalance) : null,
     row.context ? JSON.stringify(row.context) : null,
     row.error || null],
  );
}

export function shadowRunId(agentId, now = new Date()) {
  return `shadow-${agentId}-${now.toISOString()}`;
}

// ── EL REPORTE DE LA SOMBRA ──────────────────────────────────────────
// Lo que hay que mirar ANTES de encender el contrato nuevo en producción. No es
// "¿corrió?": es "¿qué habría pasado?".
export async function shadowReport(day = marketDay()) {
  await ensureShadowSchema();
  const rows = await sql(
    `select agent_id, status, plan, target, rebalance, error, context, created_at
     from arena_shadow_journal where run_date = $1::date order by created_at`, [day],
  );
  const porAgente = {};
  for (const r of rows || []) {
    const a = (porAgente[r.agent_id] = porAgente[r.agent_id] || { corridas: 0, estados: {}, ultimo: null });
    a.corridas++;
    a.estados[r.status] = (a.estados[r.status] || 0) + 1;
    const ctx = r.context || {};
    a.ultimo = {
      status: r.status,
      plan: r.plan ? String(r.plan).slice(0, 200) : null,
      pesos: r.target && r.target.weights ? r.target.weights : null,
      ordenes_que_habria_mandado: r.rebalance && r.rebalance.legs ? r.rebalance.legs.length : null,
      turnover: r.rebalance ? r.rebalance.turnover : null,
      error: r.error || null,
      // EL CUERPO CRUDO DEL FALLO. Se journaleaba y el reporte no lo mostraba,
      // así que para verlo había que entrar a Neon a mano — justo cuando lo que
      // hace falta es leerlo rápido.
      llm_error: ctx.llm_error || null,
      lente: ctx.lens || null,
      costo_usd: ctx.cost ? ctx.cost.usd : null,
      // ── LA SECUENCIA DE HERRAMIENTAS, NO EL CONTEO ──────────────────
      // La corrida en vivo solo devuelve `tools_used` (un número). Con qué
      // filtró y en qué orden es lo que distingue a un modelo que investigó de
      // uno que pidió ocho veces lo mismo — y eso ya se journalea, solo que
      // nadie lo leía. Reconstruirlo acá es GRATIS: son filas que ya están.
      herramientas: ctx.tools && Array.isArray(ctx.tools.sequence)
        ? ctx.tools.sequence.map((t) => ({
          n: t.n ?? null, herramienta: t.name || t.tool || null,
          args: t.input || t.args || null,
          filas: t.rows ?? (t.result && t.result.rows) ?? null,
          truncado: !!(t.truncated || (t.result && t.result.truncated)),
        }))
        : null,
      herramientas_usadas: ctx.tools ? ctx.tools.used ?? null : null,
      herramientas_tope: ctx.tools ? ctx.tools.budget ?? null : null,
      herramientas_corte: ctx.tools ? ctx.tools.stopped_by || null : null,
    };
  }
  const total = rows ? rows.length : 0;
  const abortadas = (rows || []).filter((r) => String(r.status).startsWith('aborted')).length;

  // ── EL SOLAPAMIENTO ENTRE LOS SIETE ──────────────────────────────────
  // `pairwiseOverlap` estaba escrito y probado desde B8 y NINGÚN endpoint lo
  // llamaba: código muerto, igual que las rondas fijas antes de conectarlas. Un
  // test que ejercita la función exportada no prueba que alguien la use.
  //
  // Es la métrica que dice si la liga está midiendo SIETE opiniones o una
  // opinión repetida siete veces — que es la pregunta entera del experimento.
  // Con portafolio objetivo deja de ser una aproximación: el coseno entre
  // vectores de peso es un número directo.
  const libros = {};
  for (const [id, a] of Object.entries(porAgente)) {
    if (a.ultimo && a.ultimo.pesos && Object.keys(a.ultimo.pesos).length) libros[id] = a.ultimo.pesos;
  }
  const solapamiento = Object.keys(libros).length >= 2
    ? { ...pairwiseOverlap(libros), nombre_mas_compartido: sharedTopTicker(libros), libros: Object.keys(libros).length }
    : { pairs: [], mean: null, max: null, libros: Object.keys(libros).length,
      note: 'Hacen falta al menos DOS libros con pesos para que el solapamiento signifique algo.' };

  // ── EL PISO DE RUIDO: claude ↔ control ─────────────────────────────
  // Los dos corren el MISMO modelo con el MISMO prompt byte a byte. Su coseno
  // NO es un dato más del solapamiento: es la referencia contra la que vale
  // cualquier delta entre modelos distintos. Si es 0.4, dos modelos que
  // difieren 0.4 no difieren en nada.
  //
  // SOLO CUENTA SI COMPARTEN LENTE. El 2026-09-15 claude corrió con `momentum`
  // y control con `catalizador`, y ese par no medía ruido: medía la lente. Por
  // eso la línea sale con la condición explícita en vez de publicarse siempre.
  const insignia = (porAgente.claude && porAgente.claude.ultimo) || null;
  const testigo = (porAgente.control && porAgente.control.ultimo) || null;
  const mismaLente = !!(insignia && testigo && insignia.lente && insignia.lente === testigo.lente);
  const parRuido = (libros.claude && libros.control)
    ? (pairwiseOverlap({ claude: libros.claude, control: libros.control }).pairs[0] || {}).cosine
    : null;

  const pisoDeRuido = !insignia || !testigo
    ? { disponible: false, motivo: 'falta el libro de claude o el de control en este día' }
    : !mismaLente
      ? {
        disponible: false,
        motivo: `claude corrió con lente "${insignia.lente}" y control con "${testigo.lente}". El par NO mide ruido: mide la lente. Este caso es un BUG y está corregido — el control hereda la lente del insignia.`,
        lente_claude: insignia.lente, lente_control: testigo.lente,
      }
      : {
        disponible: true, lente: insignia.lente, cosine: parRuido,
        lectura: parRuido == null ? 'sin pesos en alguno de los dos'
          : parRuido >= 0.9
            ? `PISO SÓLIDO (${parRuido}): dos corridas idénticas dan casi el mismo libro, así que un delta entre modelos distintos significa algo.`
            : parRuido >= 0.7
              ? `PISO MEDIO (${parRuido}): hay ruido apreciable entre dos corridas idénticas. Un delta menor a ${(1 - parRuido).toFixed(2)} entre modelos distintos no se puede distinguir del ruido.`
              : `PISO BAJO (${parRuido}): dos corridas IDÉNTICAS difieren tanto que casi ningún delta entre modelos distintos es interpretable. Es el resultado más importante del día si sale así.`,
      };

  if (solapamiento.mean != null) {
    // El número solo no dice nada sin la lectura. Un coseno de 0.9 entre siete
    // modelos distintos no es "la liga funciona": es la liga midiendo ruido
    // alrededor de una sola opinión.
    solapamiento.lectura = solapamiento.mean >= 0.8
      ? `ALTO (${solapamiento.mean}): los siete están construyendo casi el mismo libro. La liga estaría midiendo una opinión repetida siete veces, no siete opiniones.`
      : solapamiento.mean >= 0.5
        ? `MEDIO (${solapamiento.mean}): hay un núcleo común y diferencias reales en los bordes.`
        : `BAJO (${solapamiento.mean}): los libros difieren de verdad. Es lo que hace comparable el experimento.`;
    solapamiento.caveat = 'OJO con la LENTE: dos agentes con lentes distintas el mismo día NO son comparables ese día — el confound es deliberado (B8). Mirá `por_agente[].ultimo.lente` antes de leer el par.';
  }

  const costos = Object.values(porAgente).map((a) => (a.ultimo && a.ultimo.costo_usd)).filter((x) => Number.isFinite(x));
  return {
    day, total, abortadas,
    por_agente: porAgente,
    piso_de_ruido: pisoDeRuido,
    solapamiento,
    // Todos los abortos con su cuerpo crudo, juntos: es lo primero que se mira
    // cuando algo falló y no hay que ir a buscarlo agente por agente.
    abortos: Object.entries(porAgente)
      .filter(([, a]) => a.ultimo && String(a.ultimo.status || '').startsWith('aborted'))
      .map(([id, a]) => ({
        agente: id, status: a.ultimo.status, error: a.ultimo.error,
        herramientas_usadas: a.ultimo.herramientas_usadas ?? null,
        herramientas_corte: a.ultimo.herramientas_corte || null,
        llm_error: a.ultimo.llm_error || null,
      })),
    costo: {
      total_usd: costos.length ? +costos.reduce((x, y) => x + y, 0).toFixed(4) : null,
      con_costo: costos.length,
      sin_costo: Object.keys(porAgente).length - costos.length,
      note: costos.length < Object.keys(porAgente).length
        ? 'Hay agentes sin costo reportado: el total está SUBESTIMADO. Un costo ausente es un dato; uno inventado sería una mentira que después alguien presupuesta.'
        : null,
    },
    // EL VEREDICTO ES EXPLÍCITO. Una sombra que "corrió" no es una sombra que
    // pasó: lo que la hace pasar es que los siete produjeran un objetivo
    // legible, y que el motor supiera qué órdenes habría mandado.
    veredicto: total === 0
      ? 'La sombra no corrió todavía: no hay nada que evaluar.'
      : abortadas === 0
        ? `VERDE: ${total} corridas en sombra, ninguna abortada. Los objetivos son legibles y el motor pudo calcular el rebalanceo.`
        : `ROJO: ${abortadas} de ${total} corridas abortaron. NO encender el contrato nuevo hasta entender por qué — revisá `
          + Object.entries(porAgente).filter(([, v]) => Object.keys(v.estados).some((s) => s.startsWith('aborted'))).map(([k]) => k).join(', ') + '.',
    orders_placed: 0,
    orders_note: 'La sombra no manda órdenes por construcción: el broker de sombra LANZA en cualquier escritura. Ver _lib/arena-shadow.js.',
  };
}
