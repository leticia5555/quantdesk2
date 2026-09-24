// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-piso-retorno.js — EL PISO DE RUIDO EN LAS UNIDADES DEL RANKING.
//
// Ya existían DOS pisos de ruido, los dos en coseno (`_lib/arena-herding.js`):
// entre LIBROS (qué tiene cada uno) y entre DELTAS (qué cambió cada uno). Los
// dos contestan "¿se parecen las decisiones de dos corridas idénticas?".
//
// NINGUNO contesta la pregunta que hace cualquiera que abre /liga: **el que va
// 2º, ¿le ganó de verdad al que va 6º?** Esa se mide en PUNTOS DE RETORNO, y un
// coseno no se convierte a puntos porcentuales — `_lib/arena-benchmark.js` ya lo
// decía con todas las letras y por eso publicaba el coseno al lado del exceso
// sin mezclarlos.
//
// Lo que faltaba no era una conversión: era el piso MEDIDO EN LA MISMA UNIDAD.
// Y está a una resta de distancia, porque ya está en la tabla:
//
//     piso = | retorno(claude) − retorno(control) |
//
// `claude` y `control` son el MISMO modelo, el MISMO prompt byte a byte, la
// MISMA temperatura y el MISMO tablero. Todo lo que los separa —el orden de los
// fills, el estado del libro, el enfoque que le tocó a cada uno ese día— es el
// sistema difiriendo consigo mismo. Esa distancia es el margen de error de la
// tabla, y una tabla de posiciones que no publica el suyo es una tabla
// inventada.
//
// ── NO SE COMPARA CON LOS OTROS DOS PISOS ────────────────────────────
// Puntos porcentuales de retorno acumulado, no coseno. Un piso de 0.99 pp y un
// piso de 0.62 de deltas no se pueden ni sumar ni ordenar entre sí: miden cosas
// distintas en escalas distintas. Por eso este número viaja con
// `metodo: 'retorno'` y con su unidad pegada, igual que los otros dos viajan
// con el suyo.
//
// ── EL RELOJ ES EL MISMO PARA LOS DOS LADOS ──────────────────────────
// `return_pct` se mide desde el baseline de cada cuenta (el reset), así que el
// piso es ACUMULADO desde el reset — no es un número del día. El spread entre
// modelos se mide sobre exactamente los mismos retornos, así que el cociente
// entre los dos es legítimo: mismo origen, misma unidad, misma ventana. Si un
// día se quisiera el piso DEL DÍA habría que armarlo con `day_change_pct` de
// los dos, que es otra serie y otra pregunta.
//
// ── LO QUE ESTE PISO NO ARREGLA ──────────────────────────────────────
// Es UNA observación de UN par, no una desviación estándar de muchas corridas.
// Dice "dos corridas idénticas terminaron a 0.99 pp" — no "el 95% de las
// corridas idénticas caen dentro de 0.99 pp". Con siete agentes y una sola
// réplica no hay con qué estimar lo segundo, y fingir que sí lo hay sería el
// mismo invento que esto existe para impedir. Se publica como cota observada.
// ═══════════════════════════════════════════════════════════════

export const METODO_RETORNO = 'retorno';
export const UNIDAD = 'pp';

// `Number(null)` es 0 y 0 es finito: sin la guarda de arriba, un agente SIN
// retorno (cuenta caída, baseline ilegible) entraba a la tabla como un 0.00%
// perfectamente creíble — y el piso, el spread y el conteo contra el índice se
// calculaban sobre un número que nadie midió. Es la misma trampa que el RVOL
// con `dayVolume == null` y la que `filaBenchmark` evita con `abierto`.
// `''` y `[]` caen en lo mismo por el mismo camino.
const num = (x) => {
  if (x == null || x === '' || typeof x === 'boolean' || Array.isArray(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const r2 = (x) => +Number(x).toFixed(2);

// Compite y tiene retorno legible. El benchmark NO entra: no decidió nada, y su
// distancia a un agente no es ruido del sistema — es la pregunta del experimento.
function competidores(agentes) {
  return (agentes || [])
    .filter((a) => a && a.compite !== false && num(a.return_pct) != null)
    .map((a) => ({ id: a.id, name: a.name || a.id, return_pct: num(a.return_pct), control: !!a.control }));
}

// ── EL PISO: la distancia entre las dos corridas idénticas ───────────
// Devuelve null con motivo si falta cualquiera de las dos. Un piso que se
// calcula "con lo que haya" no es un piso.
export function pisoDeRetorno({ agentes = [], insignia = 'claude', testigo = 'control' } = {}) {
  const filas = competidores(agentes);
  const a = filas.find((x) => x.id === insignia) || null;
  const b = filas.find((x) => x.id === testigo) || null;
  if (!a || !b) {
    return {
      disponible: false, metodo: METODO_RETORNO, unidad: UNIDAD, piso_pp: null,
      motivo: `falta el retorno de ${!a ? insignia : ''}${!a && !b ? ' y de ' : ''}${!b ? testigo : ''}: sin el par idéntico completo no hay piso, y sin piso ninguna distancia entre puestos es interpretable.`,
    };
  }
  return {
    disponible: true, metodo: METODO_RETORNO, unidad: UNIDAD,
    piso_pp: r2(Math.abs(a.return_pct - b.return_pct)),
    par: {
      insignia: { id: a.id, name: a.name, return_pct: a.return_pct },
      testigo: { id: b.id, name: b.name, return_pct: b.return_pct },
    },
    nota: 'Mismo modelo, mismo prompt, misma temperatura, distinta cuenta. Lo que los separa es el sistema difiriendo consigo mismo.',
  };
}

// ── EL SPREAD ENTRE MODELOS, y cuánto de él es piso ──────────────────
// `spread_pp` es el rango COMPLETO (1º a último) entre los que compiten. El
// rango sin el líder viaja aparte (`spread_sin_lider_pp`) porque es la lectura
// que importa cuando uno solo se despega: "los otros seis caben en X".
export function spreadDeModelos(agentes = []) {
  const filas = competidores(agentes).sort((x, y) => y.return_pct - x.return_pct);
  if (filas.length < 2) {
    return { disponible: false, modelos: filas.length, spread_pp: null, motivo: 'hacen falta al menos DOS agentes con retorno para que exista un spread.' };
  }
  const lider = filas[0];
  const ultimo = filas[filas.length - 1];
  const segundo = filas[1];
  return {
    disponible: true,
    modelos: filas.length,
    spread_pp: r2(lider.return_pct - ultimo.return_pct),
    lider: { id: lider.id, name: lider.name, return_pct: lider.return_pct },
    ultimo: { id: ultimo.id, name: ultimo.name, return_pct: ultimo.return_pct },
    // El rango de los que NO son el líder. Con uno solo despegado, es el número
    // que dice de verdad cuánto separa al resto de la tabla.
    spread_sin_lider_pp: filas.length >= 3 ? r2(segundo.return_pct - ultimo.return_pct) : null,
    desde_el_2: filas.length >= 3 ? { id: segundo.id, name: segundo.name, return_pct: segundo.return_pct } : null,
    orden: filas.map((f) => ({ id: f.id, name: f.name, return_pct: f.return_pct })),
  };
}

// ── LOS EMPATES TÉCNICOS ─────────────────────────────────────────────
// Un par ADYACENTE cuya brecha es menor que el piso no está ordenado: está
// dentro del margen de error, y la tabla lo tiene que decir en la fila, no en
// la letra chica. `separado` es lo contrario: un agente cuya distancia al
// vecino MÁS CERCANO (arriba o abajo) alcanza o supera el piso — el único caso
// en que su puesto significa algo.
export function empatesTecnicos({ agentes = [], pisoPp = null } = {}) {
  const filas = competidores(agentes).sort((x, y) => y.return_pct - x.return_pct);
  const piso = num(pisoPp);
  const brechas = [];
  for (let i = 0; i + 1 < filas.length; i++) {
    brechas.push({
      arriba: filas[i].id, arriba_name: filas[i].name,
      abajo: filas[i + 1].id, abajo_name: filas[i + 1].name,
      brecha_pp: r2(filas[i].return_pct - filas[i + 1].return_pct),
    });
  }
  if (piso == null) {
    return { disponible: false, brechas, empates: [], separados: [], por_agente: {}, motivo: 'sin piso no se puede decir qué brecha es ruido.' };
  }
  const empates = brechas.filter((b) => b.brecha_pp < piso);
  const por_agente = {};
  filas.forEach((f, i) => {
    const arriba = i > 0 ? brechas[i - 1].brecha_pp : null;
    const abajo = i + 1 < filas.length ? brechas[i].brecha_pp : null;
    const vecinos = [arriba, abajo].filter((x) => x != null);
    const masCercano = vecinos.length ? Math.min(...vecinos) : null;
    por_agente[f.id] = {
      brecha_arriba_pp: arriba, brecha_abajo_pp: abajo,
      brecha_min_pp: masCercano,
      // Fuera de la banda = su puesto es distinguible del ruido por AMBOS lados
      // que tiene. Un agente solo (sin vecinos) no se declara separado: no hay
      // de qué separarse.
      separado: masCercano != null && masCercano >= piso,
      empate_tecnico: masCercano != null && masCercano < piso,
    };
  });
  return {
    disponible: true,
    brechas,
    empates,
    separados: filas.filter((f) => por_agente[f.id].separado).map((f) => f.id),
    por_agente,
    puestos: filas.length,
    // Cuántos puestos NO se distinguen del ruido por ningún lado.
    indistinguibles: filas.filter((f) => por_agente[f.id].empate_tecnico).length,
  };
}

// ── ¿LE GANAN AL ÍNDICE? ─────────────────────────────────────────────
// Se cuenta, no se deja para que el lector reste fila por fila. El benchmark no
// compite, pero es la única vara que le importa a alguien de afuera.
export function contraElIndice({ agentes = [], benchmarkReturn = null } = {}) {
  const filas = competidores(agentes);
  const bench = num(benchmarkReturn);
  if (bench == null || !filas.length) {
    return {
      disponible: false, total: filas.length,
      motivo: bench == null
        ? 'el índice todavía no tiene retorno: se abre con el reset que arranca la temporada.'
        : 'ningún agente tiene retorno legible.',
    };
  }
  const pierden = filas.filter((f) => f.return_pct < bench);
  const ganan = filas.filter((f) => f.return_pct > bench);
  return {
    disponible: true,
    benchmark_return_pct: bench,
    total: filas.length,
    pierden: pierden.length,
    ganan: ganan.length,
    empatan: filas.length - pierden.length - ganan.length,
    pierden_ids: pierden.map((f) => f.id),
    ganan_ids: ganan.map((f) => f.id),
    lectura: pierden.length === filas.length
      ? `Los ${filas.length} van por debajo del índice (${bench >= 0 ? '+' : ''}${bench}%). Ninguno le gana a comprar SPY y no hacer nada.`
      : ganan.length === filas.length
        ? `Los ${filas.length} van por encima del índice (${bench >= 0 ? '+' : ''}${bench}%).`
        : `${pierden.length} de ${filas.length} van por DEBAJO del índice (${bench >= 0 ? '+' : ''}${bench}%). Le ganan ${ganan.length}.`,
  };
}

// ── EL BLOQUE COMPLETO, que es lo que la pantalla publica arriba ─────
// Una sola función porque los tres números se leen JUNTOS o no se leen: el piso
// solo, sin el spread, no dice si es grande; el spread solo, sin el piso, es la
// tabla de posiciones inventada que esto viene a cerrar.
export function margenDeLaTabla({ agentes = [], benchmarkReturn = null, insignia = 'claude', testigo = 'control' } = {}) {
  const piso = pisoDeRetorno({ agentes, insignia, testigo });
  const spread = spreadDeModelos(agentes);
  const empates = empatesTecnicos({ agentes, pisoPp: piso.piso_pp });
  const indice = contraElIndice({ agentes, benchmarkReturn });

  const pct = (piso.piso_pp != null && spread.spread_pp)
    ? +((piso.piso_pp / spread.spread_pp) * 100).toFixed(0) : null;
  const pctSinLider = (piso.piso_pp != null && spread.spread_sin_lider_pp)
    ? +((piso.piso_pp / spread.spread_sin_lider_pp) * 100).toFixed(0) : null;

  let lectura;
  if (!piso.disponible) {
    lectura = `SIN MARGEN DECLARADO: ${piso.motivo} Cualquier orden de esta tabla se está leyendo sin saber cuánto vale su propio error.`;
  } else if (!spread.disponible) {
    lectura = `El piso de ruido es ${piso.piso_pp} pp, pero todavía no hay dos agentes con retorno para medir un spread contra él.`;
  } else if (pct != null && pct >= 100) {
    lectura = `EL RUIDO SE COME LA TABLA: dos corridas IDÉNTICAS terminaron a ${piso.piso_pp} pp una de otra, y los ${spread.modelos} modelos caben en ${spread.spread_pp} pp. El margen de error es MÁS GRANDE que todo el spread: ningún puesto de esta tabla es interpretable hoy.`;
  } else if (pct != null && pct >= 50) {
    lectura = `EL RUIDO SE COME EL RANKING: dos corridas IDÉNTICAS (mismo modelo, mismo prompt) terminaron a ${piso.piso_pp} pp una de otra. Los ${spread.modelos} modelos caben en ${spread.spread_pp} pp, así que el ${pct}% del spread entre modelos es ruido de la misma configuración consigo misma.`;
  } else {
    lectura = `El piso de ruido vale ${piso.piso_pp} pp y el spread entre los ${spread.modelos} modelos es ${spread.spread_pp} pp: el ruido explica el ${pct}% de la distancia entre el primero y el último.`;
  }

  const separados = empates.disponible ? empates.separados : [];
  const detalleSeparados = !empates.disponible ? null
    : separados.length === 0
      ? `NINGÚN puesto se distingue del ruido: las ${empates.brechas.length} brechas entre puestos consecutivos son menores que el piso de ${piso.piso_pp} pp.`
      : separados.length === empates.puestos
        ? 'Todos los puestos están separados por más que el piso.'
        : `Se separan del ruido ${separados.length} de ${empates.puestos}. Los otros ${empates.indistinguibles} están a menos de ${piso.piso_pp} pp de su vecino más cercano: su puesto no se distingue del azar.`;

  return {
    metodo: METODO_RETORNO, unidad: UNIDAD,
    piso, spread,
    piso_sobre_spread_pct: pct,
    piso_sobre_spread_sin_lider_pct: pctSinLider,
    empates,
    indice,
    lectura,
    detalle_separados: detalleSeparados,
    // Dicho una vez, acá, para que ninguna pantalla lo tenga que reescribir y
    // para que nadie ponga este número al lado de un coseno.
    caveat: 'Este piso está en PUNTOS DE RETORNO acumulado desde el reset. NO es el piso de ruido en coseno de /liga/libros (entre libros y entre deltas): son unidades distintas y no se comparan entre sí. Y es UNA observación de UN par, no una desviación estándar: dice a qué distancia terminaron dos corridas idénticas, no qué tan seguido terminan así.',
  };
}
