// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-benchmark.js — EL BENCHMARK PASIVO: $100k en SPY, y nada más.
//
// La pregunta que contesta es la única que le importa a alguien de afuera:
// ¿los siete modelos le ganan a comprar el índice y no hacer nada? Sin este
// número, "claude subió 3%" no significa nada — puede ser un mercado que subió
// 4%.
//
// ── POR QUÉ ES UNA LÍNEA CALCULADA Y NO UNA OCTAVA CUENTA ────────────
// Lety prefería una cuenta Alpaca real "si no complica". Complica, y de una
// forma que lo vuelve PEOR benchmark:
//
//   1. UNA ORDEN PUEDE NO LLENAR. La regla de la casa prohíbe órdenes a
//      mercado (cicatriz Polymarket), así que sería una límite marketable — y
//      una límite puede no ejecutarse, o llenar parcial. Un benchmark cuyo
//      valor depende de si una orden llenó no es un benchmark: es un octavo
//      agente con riesgo de ejecución.
//   2. ES DE UN SOLO TIRO. Si no llena el miércoles a la apertura, no hay
//      segunda oportunidad de arrancar la temporada al precio correcto.
//   3. NO SE PUEDE AUDITAR DESDE AFUERA. `acciones × precio` lo verifica
//      cualquiera contra datos públicos; el equity de una cuenta paper, no. En
//      un experimento cuyo entregable es la credibilidad, eso pesa.
//
// El precio sigue saliendo de Alpaca, que es la misma fuente que alimenta a los
// siete. Lo único que no existe es el envoltorio de la cuenta.
//
// Si algún día se quiere la cuenta real igual, el camino está abierto:
// `ALPACA_BENCH_KEY`/`SECRET` hacen que el equity se lea de ahí (ver
// `benchmarkEquity`). La línea calculada queda como respaldo y como auditoría.
//
// ── FRACCIONES, Y POR QUÉ ────────────────────────────────────────────
// $100.000 / SPY no da un número entero de acciones. Con acciones enteras
// quedarían unos cientos de dólares en efectivo, y ese efectivo haría que el
// benchmark rinda un poco MENOS que el índice por una razón que no tiene nada
// que ver con la comparación. Se usan fracciones: el benchmark tiene que ser el
// retorno del índice, no el de una cartera que casi lo replica.
//
// ── NO DECIDE NADA, NUNCA ────────────────────────────────────────────
// Cero LLM, cero herramientas, cero rebalanceo. Se abre UNA vez el día del
// reset y no se toca en toda la temporada. Si algún día este archivo importa
// algo del camino de decisión, algo se rompió.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { getSnapshots, alpacaCreds } from './alpaca.js';

export const BENCHMARK = {
  id: 'benchmark-spy',
  label: 'S&P 500 · SPY',
  symbol: 'SPY',
  capital_usd: 100000,
  kind: 'BENCHMARK',
};

const CLAVE = 'benchmark:spy';

const SCHEMA = `create table if not exists arena_benchmark (
   key        text primary key,
   symbol     text not null,
   capital    numeric not null,
   entry      numeric not null,
   shares     numeric not null,
   opened_at  timestamptz not null,
   note       text
 )`;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql(SCHEMA);
  ready = true;
}

// ── APERTURA, UNA SOLA VEZ ───────────────────────────────────────────
// Idempotente por construcción: si ya hay entrada, NO se pisa. Un benchmark que
// se re-abre a un precio nuevo deja de medir la temporada y pasa a medir desde
// la última vez que alguien corrió el reset — que es justo el error que haría
// inútil la comparación, y en silencio.
export async function abrirBenchmark({ price, now = new Date(), capital = BENCHMARK.capital_usd, note = null } = {}) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'sin_precio', detail: 'no se pudo leer el precio de SPY: el benchmark NO se abre con un precio inventado' };
  }
  try {
    await ensure();
    const ya = await leerBenchmark();
    if (ya) return { ok: true, ya_estaba: true, ...ya };

    const shares = +(capital / p).toFixed(6);
    await sql(
      `insert into arena_benchmark (key, symbol, capital, entry, shares, opened_at, note)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (key) do nothing`,
      [CLAVE, BENCHMARK.symbol, capital, p, shares, now.toISOString(), note],
    );
    // Se relee: si dos resets corrieron a la vez, gana el que insertó primero y
    // los dos devuelven la MISMA entrada. Confiar en lo que se acaba de escribir
    // sin releer es cómo dos procesos terminan reportando precios distintos.
    const guardado = await leerBenchmark();
    return { ok: true, ya_estaba: false, ...(guardado || { symbol: BENCHMARK.symbol, entry: p, shares, capital }) };
  } catch (e) {
    return { ok: false, reason: 'db', detail: String((e && e.message) || e) };
  }
}

// ── EL PRECIO DE ENTRADA: la APERTURA, no el último trade ────────────
// Lety pidió "$100.000 comprados en SPY en la apertura del miércoles 16, misma
// hora que el reset". El snapshot de Alpaca trae las dos cosas: `day_open` (la
// apertura de HOY) y `price` (el último trade). Para ABRIR se prefiere la
// apertura — es el precio que hace que el benchmark y las siete cuentas
// arranquen del mismo instante, aunque el reset se dispare a las 9:35.
//
// Si el reset corre ANTES del open, `day_open` todavía no existe. Ahí no se
// inventa: se devuelve `fuente: 'ultimo_trade'` y queda escrito en la fila. Un
// benchmark abierto al cierre del día anterior sigue siendo un benchmark
// honesto; uno que dice "apertura" sin serlo, no.
export async function precioBenchmark({ creds = null, preferOpen = true } = {}) {
  const c = creds || alpacaCreds();
  try {
    const snaps = await getSnapshots([BENCHMARK.symbol], c);
    const s = snaps && snaps[BENCHMARK.symbol];
    if (!s) return { ok: false, reason: 'sin_snapshot', detail: `Alpaca no devolvió snapshot de ${BENCHMARK.symbol}.` };
    const open = Number(s.day_open);
    const last = Number(s.price);
    const usaOpen = preferOpen && Number.isFinite(open) && open > 0;
    const price = usaOpen ? open : last;
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, reason: 'sin_precio', detail: `El snapshot de ${BENCHMARK.symbol} llegó sin precio usable.` };
    }
    return {
      ok: true, price,
      fuente: usaOpen ? 'apertura' : 'ultimo_trade',
      day_open: Number.isFinite(open) && open > 0 ? open : null,
      last: Number.isFinite(last) && last > 0 ? last : null,
      as_of: s.as_of || null,
    };
  } catch (e) {
    return { ok: false, reason: 'alpaca', detail: String((e && e.message) || e) };
  }
}

// `migrar: false` LEE sin crear la tabla. Es para el dry run del reset, que
// promete cero escrituras — y `create table if not exists` es una escritura,
// por más inofensiva que suene. Sin la tabla, la lectura falla y cae en el
// catch: null, que es exactamente lo que significa "no hay benchmark abierto".
export async function leerBenchmark({ migrar = true } = {}) {
  try {
    if (migrar) await ensure();
    const rows = await sql(`select symbol, capital, entry, shares, opened_at, note from arena_benchmark where key = $1`, [CLAVE]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      symbol: r.symbol, capital: Number(r.capital), entry: Number(r.entry),
      shares: Number(r.shares), opened_at: r.opened_at, note: r.note || null,
    };
  } catch { return null; }
}

// ── EL EQUITY DE HOY ─────────────────────────────────────────────────
// `acciones × precio`. Sin efectivo, sin comisiones, sin dividendos — y las
// tres ausencias se declaran, porque las tres mueven el número en la misma
// dirección: SPY paga ~1,2% anual de dividendos que este cálculo NO cuenta, así
// que el benchmark queda levemente SUBESTIMADO. Decirlo es mejor que simularlo
// mal: un ajuste por dividendos hecho a ojo sería un número inventado en la
// línea que existe para que nadie invente números.
export function benchmarkEquity(estado, price) {
  const p = Number(price);
  if (!estado || !Number.isFinite(p) || p <= 0) return null;
  return +(estado.shares * p).toFixed(2);
}

export function benchmarkReturnPct(estado, price) {
  const eq = benchmarkEquity(estado, price);
  if (eq == null || !estado.capital) return null;
  return +(((eq - estado.capital) / estado.capital) * 100).toFixed(2);
}

// ── LA FILA PARA EL RANKING ──────────────────────────────────────────
// Se ordena por equity JUNTO a los agentes —Lety lo pidió así y tiene razón:
// un benchmark que aparece aparte se lee como una nota al pie— pero lleva
// `kind: 'BENCHMARK'` y `compite: false` para que ninguna narrativa de "quién
// va ganando" lo cuente como competidor. No decidió nada; no puede ganar.
export function filaBenchmark(estado, price) {
  const base = {
    id: BENCHMARK.id, name: BENCHMARK.label, kind: BENCHMARK.kind,
    compite: false, model: null, model_label: 'índice, sin modelo',
    nota: 'Compra única de SPY el día del reset, sin tocar en toda la temporada. Cero LLM, cero herramientas, cero decisiones. Está para contestar si los modelos le ganan al índice — sin esta fila, "subió 3%" no significa nada.',
  };
  if (!estado) {
    return { ...base, abierto: false, account: null, return_pct: null,
      detalle: 'El benchmark todavía no se abrió: se abre con el reset que arranca la temporada.' };
  }
  const equity = benchmarkEquity(estado, price);
  return {
    ...base,
    abierto: true,
    entry: estado.entry, shares: estado.shares, opened_at: estado.opened_at,
    account: equity == null ? null : { equity, cash: 0 },
    return_pct: benchmarkReturnPct(estado, price),
    // ── LA VISTA INDEXADA ────────────────────────────────────────────
    // El benchmark se indexa contra SU PROPIO capital inicial (shares × entry),
    // no contra el baseline de ningún agente: es lo que hace que la línea del
    // índice y la de los agentes se puedan leer en la misma escala sin que una
    // arrastre a la otra. Su retorno no cambia — indexar es multiplicar por una
    // constante.
    // `estado.capital` es el mismo denominador que usa `benchmarkReturnPct`:
    // se reusa en vez de recalcular shares × entry, para que el retorno y el
    // equity indexado NO puedan discrepar por un redondeo distinto.
    equity_indexado: (() => {
      const capital = Number(estado.capital);
      if (!Number.isFinite(equity) || !Number.isFinite(capital) || capital <= 0) return null;
      return +((100000 * equity) / capital).toFixed(2);
    })(),
    caveat_dividendos: 'No incluye dividendos (SPY paga ~1,2% anual), así que este número SUBESTIMA levemente al índice. Se declara en vez de estimarse: un ajuste a ojo sería un número inventado justo en la línea que existe para no inventar números.',
  };
}

// ── EL EXCESO: lo que de verdad se quiere saber ──────────────────────
// Retorno del agente MENOS retorno del benchmark. Y —la parte que importa— ese
// exceso comparado contra el PISO DE RUIDO (claude↔control): si el exceso es
// más chico que lo que difieren dos corridas idénticas, no es habilidad, es
// ruido con otro nombre.
export function excesoVsBenchmark({ agentes = [], benchmarkReturn = null, pisoDeRuido = null } = {}) {
  const filas = agentes
    .filter((a) => a && Number.isFinite(a.return_pct))
    .map((a) => ({
      id: a.id, name: a.name,
      return_pct: a.return_pct,
      exceso_pp: benchmarkReturn == null ? null : +(a.return_pct - benchmarkReturn).toFixed(2),
    }))
    .sort((a, b) => (b.exceso_pp ?? -Infinity) - (a.exceso_pp ?? -Infinity));

  const out = { benchmark_return_pct: benchmarkReturn, agentes: filas };

  if (benchmarkReturn == null) {
    out.note = 'Sin retorno del benchmark no hay exceso que calcular. El benchmark se abre con el reset.';
    return out;
  }

  // El piso de ruido en PUNTOS PORCENTUALES. El coseno mide parecido entre
  // libros, no diferencia de retorno, así que NO se convierte uno en otro: se
  // publica el dato que hay y se dice qué se puede concluir con él.
  const piso = pisoDeRuido && pisoDeRuido.comparable ? pisoDeRuido : null;
  out.piso_de_ruido = piso
    ? { cosine: piso.cosine, enfoque: piso.enfoque, comparable: true }
    : { comparable: false, motivo: (pisoDeRuido && pisoDeRuido.motivo) || 'el piso de ruido no está disponible para este día' };

  out.lectura = piso
    ? `El exceso de cada agente es su retorno menos el ${benchmarkReturn}% del índice. Leélo CONTRA el piso de ruido: claude y control corren el mismo modelo con el mismo prompt, así que lo que los separa a ELLOS es el ruido del sistema. Un exceso que no supera esa distancia no es habilidad.`
    : `El exceso de cada agente es su retorno menos el ${benchmarkReturn}% del índice. OJO: sin un piso de ruido comparable este día, no hay contra qué medir si un exceso chico es habilidad o azar. El piso solo vale cuando claude y control comparten enfoque Y libro de arranque.`;
  return out;
}
