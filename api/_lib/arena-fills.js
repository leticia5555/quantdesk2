// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-fills.js — A CUÁNTO SE COMPRÓ Y A CUÁNTO SE VENDIÓ.
//
// EL PUNTO CIEGO: la pantalla decía "PGR buy · filled" y nada más. Sabemos que
// pasó algo; no a qué precio, ni cuántas acciones, ni a qué hora, ni si la
// venta ganó o perdió. Es el mismo agujero del viernes en otra forma — un
// estado que se lee como si fuera una explicación.
//
// ── EL DATO YA ESTABA, EN DOS MITADES QUE NADIE JUNTABA ──────────────
// La ORDEN (qué se pidió: cantidad, límite, intención, delta de peso) vive en
// `context.ejecucion.ordenes_calculadas`. El FILL (a cuánto llenó, cuántas y
// cuándo) lo escribe `runArenaReconcile` sobre la columna `actions`, que es
// otra estructura y la única que se re-escribe después de la corrida.
//
// Juntarlas ACÁ y no en cada endpoint es lo de siempre: dos implementaciones
// del mismo cálculo terminan difiriendo, y ésta produce un número de dinero.
//
// ── LA ENTRADA SALE DEL LIBRO DE ANTES, NO DE UN PROMEDIO NUEVO ──────
// `arena_journal.account.holdings[].avg_entry_price` es la foto del libro
// ANTES de que esta corrida operara. Para una venta, ése es exactamente el
// costo contra el que se mide el resultado. Si se recalculara después, ya
// estaría contaminado por la propia venta.
//
// ── LO QUE ESTE CÁLCULO NO ES, dicho acá y no en la letra chica ──────
//   · `avg_entry_price` es un PROMEDIO. Una posición armada en tres compras
//     no tiene "el" precio de entrada, y el resultado de vender la mitad se
//     mide contra el promedio — que es la contabilidad correcta, y aun así no
//     es "lo que pagué por estas acciones".
//   · Es BRUTO: sin comisiones (la cuenta paper no cobra) y SIN DIVIDENDOS.
//     Una venta de un nombre que pagó dividendo tiene un resultado real mayor
//     que el que sale acá.
//   · Solo las SALIDAS realizan. Una compra no tiene "resultado contra la
//     entrada": está abriendo, no cerrando. Devuelve null y lo dice.
// ═══════════════════════════════════════════════════════════════

const up = (s) => String(s || '').trim().toUpperCase();

// `Number(null)` es 0 y 0 es finito. Un precio de ejecución ausente NO es un
// precio de cero, y un `filled_qty` ausente no es "se llenaron cero acciones":
// es "no sabemos". La distinción decide si la pantalla dice "no se llenó" o
// "todavía no lo conciliamos".
export const num = (x) => {
  if (x == null || x === '' || typeof x === 'boolean' || Array.isArray(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// Estados en los que Alpaca ya no va a mover la orden. Espejo del set de
// `runArenaReconcile`: si los dos divergen, una orden terminal seguiría
// apareciendo como "pendiente" para siempre en la pantalla.
export const TERMINALES = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day']);

// Por qué una orden terminal no se llenó, en español y sin adornos. Un
// `canceled` a secas no dice si lo canceló el motor o el broker.
const MOTIVO_TERMINAL = {
  canceled: 'cancelada antes de llenar (el motor cancela las órdenes vivas que contradicen el libro de la corrida siguiente)',
  expired: 'expiró sin llenar: la orden era `day` y el límite nunca se tocó',
  rejected: 'rechazada por Alpaca',
  replaced: 'reemplazada por otra orden',
  done_for_day: 'la sesión cerró con la orden sin llenar',
};

// ── LA CLAVE ─────────────────────────────────────────────────────────
// `client_order_id` es la clave real: la arma `enviarOrdenes` con agente,
// corrida, símbolo y lado, así que dos ventas del mismo símbolo en corridas
// distintas no colisionan. El respaldo `SÍMBOLO|lado` existe para las filas
// viejas que no lo llevaban — y es AMBIGUO a propósito conocido: si una corrida
// mandó dos órdenes del mismo símbolo y lado, la segunda pisa a la primera.
// Con `client_order_id` eso no puede pasar.
export function claveDeOrden(o) {
  const cid = o && o.client_order_id ? String(o.client_order_id) : null;
  if (cid) return cid;
  const sym = up(o && o.symbol);
  const lado = String((o && o.side) || '').toLowerCase();
  return sym ? `${sym}|${lado}` : '';
}

// Las filas de `actions` (que el reconcile re-escribe) indexadas por clave.
// Se indexa por las DOS claves para que una orden calculada sin
// `client_order_id` igual encuentre su fill.
export function fillsDeActions(actions = []) {
  const m = new Map();
  for (const a of (Array.isArray(actions) ? actions : [])) {
    if (!a) continue;
    const fill = {
      symbol: up(a.symbol), side: String(a.side || '').toLowerCase(),
      qty: num(a.qty),
      filled_qty: num(a.filled_qty),
      filled_avg_price: num(a.filled_avg_price),
      filled_at: a.filled_at || null,
      order_status: a.order_status || null,
      result: a.result || null,
      error: a.error || null,
      intencion: a.intencion || null,
      client_order_id: a.client_order_id || null,
      alpaca_order_id: a.alpaca_order_id || null,
    };
    const cid = a.client_order_id ? String(a.client_order_id) : null;
    if (cid) m.set(cid, fill);
    const alt = fill.symbol ? `${fill.symbol}|${fill.side}` : '';
    // La clave de respaldo NO pisa a una que ya está: la primera orden del
    // símbolo se queda con ella, que es el comportamiento menos sorprendente.
    if (alt && !m.has(alt)) m.set(alt, fill);
  }
  return m;
}

// El libro de ANTES de operar → { SÍMBOLO: { entrada, cantidad, lado } }.
// `qty` negativo en Alpaca es un corto: el lado viaja para que el resultado de
// un `cover` se calcule al revés y no salga con el signo cambiado.
export function entradasDeCuenta(account) {
  const out = {};
  const holdings = (account && Array.isArray(account.holdings)) ? account.holdings : [];
  for (const h of holdings) {
    const sym = up(h && h.symbol);
    if (!sym) continue;
    const qty = num(h.qty);
    out[sym] = {
      entrada: num(h.avg_entry_price),
      cantidad: qty,
      lado: qty != null && qty < 0 ? 'corto' : 'largo',
    };
  }
  return out;
}

// ── EL RESULTADO DE UNA SALIDA ───────────────────────────────────────
// Una fórmula para los dos lados: el P&L es `(salida − entrada) × cantidad`
// para un largo y `(entrada − salida) × cantidad` para un corto, y el
// porcentaje es el P&L sobre la BASE (`entrada × cantidad`) en los dos casos.
// Escribirlo así evita la trampa clásica de invertir el cociente para el corto
// y publicar un porcentaje que no corresponde al dinero de al lado.
export function resultadoContraEntrada({ intencion, lado, entrada, salida, cantidad, ladoPosicion = null } = {}) {
  const e = num(entrada), s = num(salida), q = num(cantidad);
  // Qué cierra: `sell` cierra un largo, `cover` cierra un corto. Sin intención
  // journaleada (filas viejas del contrato objetivo) se cae al lado de la
  // POSICIÓN que había antes, que es el mismo dato por otro camino.
  const cierraCorto = intencion === 'cover' || (!intencion && ladoPosicion === 'corto' && lado === 'buy');
  const cierraLargo = intencion === 'sell' || (!intencion && ladoPosicion !== 'corto' && lado === 'sell');
  if (!cierraCorto && !cierraLargo) return null;      // una apertura no realiza nada
  if (e == null || s == null || q == null || q <= 0 || e <= 0) {
    return {
      calculable: false,
      cierra: cierraCorto ? 'corto' : 'largo',
      entrada: e, salida: s,
      motivo: e == null
        ? 'el libro de antes de la corrida no traía precio de entrada para este nombre, así que el resultado no se puede calcular sin inventarlo'
        : 'falta el precio o la cantidad de ejecución',
    };
  }
  const pnl = cierraCorto ? (e - s) * q : (s - e) * q;
  const base = e * q;
  return {
    calculable: true,
    cierra: cierraCorto ? 'corto' : 'largo',
    entrada: +e.toFixed(4), salida: +s.toFixed(4), cantidad: q,
    base_usd: +base.toFixed(2),
    pnl_usd: +pnl.toFixed(2),
    pnl_pct: +((pnl / base) * 100).toFixed(2),
    nota: 'La entrada es el COSTO PROMEDIO de la posición antes de esta corrida. Bruto: sin comisiones y sin dividendos.',
  };
}

// ── UNA ORDEN, PUBLICABLE ────────────────────────────────────────────
// `orden` es lo que se PIDIÓ (de `ordenes_calculadas` o de la propia fila de
// `actions`); `fill` es lo que PASÓ (lo que dejó el reconcile); `entrada` es el
// costo de la posición antes de operar.
//
// Las cinco situaciones se nombran distinto porque llevan a mirar cosas
// distintas: `llena`, `parcial`, `sin_llenar` (terminal y no llenó),
// `pendiente` (Alpaca todavía la tiene viva o el reconcile no pasó) y
// `no_enviada` (el envío falló) / `sin_enviar` (la bandera estaba en seco).
export function detalleDeOrden({ orden = {}, fill = null, entrada = null } = {}) {
  const sym = up(orden.symbol || (fill && fill.symbol));
  const lado = String(orden.side || (fill && fill.side) || '').toLowerCase();
  const intencion = orden.intencion || (fill && fill.intencion) || null;
  const pedida = num(orden.qty) ?? (fill ? fill.qty : null);
  const limite = num(orden.limit_price);
  const referencia = num(orden.referencia);

  const llena = fill ? fill.filled_qty : null;
  const precio = fill ? fill.filled_avg_price : null;
  const estadoAlpaca = fill ? fill.order_status : null;
  const resultado = fill ? fill.result : null;
  const error = fill ? fill.error : null;

  let estado;
  let motivo = null;
  if (!fill) {
    estado = 'sin_enviar';
    motivo = 'la corrida calculó esta orden y no la mandó (bandera en seco, candado, o freno por turnover mínimo).';
  } else if (resultado === 'submit_failed') {
    estado = 'no_enviada';
    motivo = error || 'el envío a Alpaca falló';
  } else if (llena != null && pedida != null && llena > 0 && llena < pedida) {
    estado = 'parcial';
    motivo = TERMINALES.has(String(estadoAlpaca))
      ? `se llenaron ${llena} de ${pedida} y la orden ya cerró (${estadoAlpaca}): las ${+(pedida - llena).toFixed(4)} restantes NO se van a llenar`
      : `se llenaron ${llena} de ${pedida}; la orden sigue viva`;
  } else if (llena != null && llena > 0) {
    estado = 'llena';
  } else if (TERMINALES.has(String(estadoAlpaca))) {
    estado = 'sin_llenar';
    motivo = MOTIVO_TERMINAL[String(estadoAlpaca)] || `terminó en ${estadoAlpaca} sin llenar`;
  } else {
    estado = 'pendiente';
    motivo = estadoAlpaca
      ? `Alpaca la tiene en ${estadoAlpaca}; el reconcile todavía no la cerró`
      : 'sin estado de Alpaca todavía: el reconcile no pasó por esta orden';
  }

  const llenaN = llena != null && llena > 0 ? llena : null;
  const monto = (llenaN != null && precio != null) ? +(llenaN * precio).toFixed(2) : null;

  return {
    ticker: sym,
    lado,
    // `sell` y `short` son ambos `sell` para Alpaca y significan cosas
    // opuestas. Sin la intención, una venta de cierre y la apertura de un
    // corto se ven idénticas en la pantalla.
    intencion,
    cierra_posicion: !!orden.closes_position,
    estado,
    motivo,
    cantidad_pedida: pedida,
    cantidad_llena: llenaN,
    // Lo que NO se llenó, explícito. Una parcial que solo muestra lo llenado
    // se lee como una orden completa más chica.
    cantidad_sin_llenar: (pedida != null && llena != null) ? +(pedida - llena).toFixed(4) : null,
    limite,
    referencia,
    precio_ejecucion: precio,
    monto_usd: monto,
    // Lo que se iba a mover si llenaba entera, al límite. Sirve para leer una
    // parcial: "$4,200 de $9,000".
    monto_pedido_usd: (pedida != null && limite != null) ? +(pedida * limite).toFixed(2) : null,
    // ── DESLIZAMIENTO: el límite es un TECHO, no una promesa ──────────
    // La diferencia entre la referencia que aprobó el riel y el precio real de
    // ejecución es lo único que dice si el límite marketable está haciendo su
    // trabajo. Se publica en pp para que se lea contra la banda.
    deslizamiento_pp: (precio != null && referencia != null && referencia > 0)
      ? +(((precio - referencia) / referencia) * 100 * (lado === 'buy' ? 1 : -1)).toFixed(3)
      : null,
    hora: fill ? (fill.filled_at || null) : null,
    estado_alpaca: estadoAlpaca,
    resultado,
    ...(error ? { error } : {}),
    delta_pp: Number.isFinite(orden.delta_weight) ? +(orden.delta_weight * 100).toFixed(2) : null,
    resultado_contra_entrada: resultadoContraEntrada({
      intencion, lado,
      entrada: entrada ? entrada.entrada : null,
      ladoPosicion: entrada ? entrada.lado : null,
      salida: precio, cantidad: llenaN,
    }),
    alpaca_order_id: (fill && fill.alpaca_order_id) || orden.alpaca_order_id || null,
    client_order_id: (fill && fill.client_order_id) || orden.client_order_id || null,
  };
}

// ── EL DÍA EN UNA LÍNEA ──────────────────────────────────────────────
// Cuánto se compró, cuánto se vendió, cuánto se realizó, y cuántas órdenes no
// llegaron a llenar. El realizado SOLO suma las salidas calculables: una venta
// cuya entrada no se pudo leer se cuenta aparte (`sin_base`) en vez de entrar
// como 0 y aplanar el total.
export function resumenDeOrdenes(ordenes = []) {
  const r = {
    ordenes: ordenes.length,
    llenas: 0, parciales: 0, sin_llenar: 0, pendientes: 0, no_enviadas: 0, sin_enviar: 0,
    comprado_usd: 0, vendido_usd: 0,
    realizado_usd: 0, salidas_calculadas: 0, salidas_sin_base: 0,
  };
  for (const o of ordenes) {
    if (o.estado === 'llena') r.llenas++;
    else if (o.estado === 'parcial') r.parciales++;
    else if (o.estado === 'sin_llenar') r.sin_llenar++;
    else if (o.estado === 'pendiente') r.pendientes++;
    else if (o.estado === 'no_enviada') r.no_enviadas++;
    else if (o.estado === 'sin_enviar') r.sin_enviar++;

    if (o.monto_usd != null) {
      if (o.lado === 'buy') r.comprado_usd += o.monto_usd;
      else r.vendido_usd += o.monto_usd;
    }
    const res = o.resultado_contra_entrada;
    if (res && res.calculable) { r.realizado_usd += res.pnl_usd; r.salidas_calculadas++; }
    else if (res) r.salidas_sin_base++;
  }
  r.comprado_usd = +r.comprado_usd.toFixed(2);
  r.vendido_usd = +r.vendido_usd.toFixed(2);
  r.realizado_usd = +r.realizado_usd.toFixed(2);
  r.parcial = r.salidas_sin_base > 0;
  r.nota = r.salidas_sin_base
    ? `El realizado suma ${r.salidas_calculadas} salida(s); ${r.salidas_sin_base} no traían precio de entrada en el libro de antes y NO se cuentan como cero.`
    : null;
  return r;
}

// ── EL DESLIZAMIENTO, AGREGADO ───────────────────────────────────────
// La pregunta que contesta: ¿algún agente paga sistemáticamente más que los
// otros por el mismo mecanismo? Si sí, **eso no es el modelo** — es el límite
// marketable trabajando mal para él, y se arregla en el motor, no en el prompt.
//
// ── LO QUE MIDE, Y LO QUE NO ─────────────────────────────────────────
// Es `precio_ejecución` contra la `referencia` que aprobó el riel, con el signo
// puesto para que POSITIVO SIEMPRE SEA PEOR (pagar de más comprando, cobrar de
// menos vendiendo). Entre esa referencia y el fill pasa tiempo, así que el
// número mezcla DOS cosas: la calidad de la ejecución y la deriva del precio
// mientras la orden viajaba. No se pueden separar con lo que hay, y por eso el
// número sirve para COMPARAR AGENTES —que corren el mismo mecanismo el mismo
// día— y no como medida absoluta de slippage.
//
// ── POR QUÉ LA PONDERADA VA AL LADO DE LA MEDIA ──────────────────────
// Un agente que desliza 0.4pp en una orden de $200 y 0.02pp en una de $20,000
// tiene una media horrible y un costo real ínfimo. La media dice cómo ejecuta;
// la ponderada por monto dice cuánto le costó. Las dos, o ninguna.
//
// ── Y EL TOPE, QUE ES LO QUE DE VERDAD DELATA ────────────────────────
// El límite marketable es un TECHO: un fill no puede pasarlo. Un agente cuyos
// fills se pegan al límite no está "deslizando más", está tocando el tope todas
// las veces — que es la firma de una banda demasiado angosta o demasiado ancha
// para su libro. Se cuenta sin conocer la banda: se compara el precio de
// ejecución con el límite de ESA orden, que ya viaja en la fila.
const CENTAVO = 0.005;   // medio centavo: el tick de Alpaca es $0.01

const mediana = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3);
};

export function resumenDeslizamiento(ordenes = []) {
  const medibles = (Array.isArray(ordenes) ? ordenes : [])
    .filter((o) => o && Number.isFinite(o.deslizamiento_pp) && o.cantidad_llena != null);
  if (!medibles.length) {
    return {
      fills: 0, media_pp: null, mediana_pp: null, ponderada_pp: null,
      // Un cero acá se leería como "ejecuta perfecto". Es "no hay con qué".
      nota: 'Ninguna orden con precio de ejecución Y referencia del riel en esta ventana: sin las dos no hay deslizamiento que medir.',
    };
  }

  const pps = medibles.map((o) => o.deslizamiento_pp);
  const suma = pps.reduce((a, b) => a + b, 0);
  let pesoTotal = 0, pondSuma = 0;
  for (const o of medibles) {
    const w = Number(o.monto_usd);
    if (Number.isFinite(w) && w > 0) { pesoTotal += w; pondSuma += o.deslizamiento_pp * w; }
  }
  const porLado = {};
  for (const o of medibles) {
    const k = o.lado === 'buy' ? 'compras' : 'ventas';
    (porLado[k] = porLado[k] || { fills: 0, suma: 0 }).fills++;
    porLado[k].suma += o.deslizamiento_pp;
  }
  for (const k of Object.keys(porLado)) {
    porLado[k] = { fills: porLado[k].fills, media_pp: +(porLado[k].suma / porLado[k].fills).toFixed(3) };
  }
  const enElTope = medibles.filter((o) => Number.isFinite(o.limite) && Number.isFinite(o.precio_ejecucion)
    && (o.lado === 'buy'
      ? o.precio_ejecucion >= o.limite - CENTAVO
      : o.precio_ejecucion <= o.limite + CENTAVO)).length;
  const ordenado = [...medibles].sort((a, b) => b.deslizamiento_pp - a.deslizamiento_pp);
  const cara = (o) => ({ ticker: o.ticker, lado: o.lado, pp: o.deslizamiento_pp, monto_usd: o.monto_usd, hora: o.hora });

  return {
    fills: medibles.length,
    media_pp: +(suma / medibles.length).toFixed(3),
    mediana_pp: mediana(pps),
    // null, no 0: sin montos legibles la ponderada no existe.
    ponderada_pp: pesoTotal > 0 ? +(pondSuma / pesoTotal).toFixed(3) : null,
    monto_total_usd: pesoTotal > 0 ? +pesoTotal.toFixed(2) : null,
    // El costo en DÓLARES de deslizar: pp sobre el notional movido. Es el
    // número que vuelve accionable al porcentaje.
    costo_estimado_usd: pesoTotal > 0 ? +((pondSuma / 100)).toFixed(2) : null,
    por_lado: porLado,
    en_el_tope: enElTope,
    en_el_tope_pct: +((enElTope / medibles.length) * 100).toFixed(1),
    peor: cara(ordenado[0]),
    mejor: cara(ordenado[ordenado.length - 1]),
    nota: 'POSITIVO = peor (se pagó de más comprando o se cobró de menos vendiendo). Mide el fill contra la referencia que aprobó el riel, así que mezcla ejecución con la deriva del precio mientras la orden viajaba: sirve para COMPARAR AGENTES del mismo día, no como slippage absoluto.',
  };
}

// ── EL CAMINO CORTO: de `actions` a órdenes publicables ──────────────
// Para /liga, que no lee `context.ejecucion`: la propia fila de `actions` es la
// orden Y el fill. Sirve igual para el contrato VIEJO, cuyas filas nunca
// tuvieron `ordenes_calculadas`.
export function ordenesDeActions(actions = [], account = null) {
  const entradas = entradasDeCuenta(account);
  return (Array.isArray(actions) ? actions : [])
    .filter((a) => a && a.symbol)
    // El contrato viejo journalea también las DESCARTADAS por el guard
    // (`result: 'rejected'`), y ésas nunca tocaron el mercado. Se dejan pasar:
    // "las órdenes que NO se llenaron también aparecen, con su motivo".
    .map((a) => {
      const fill = {
        symbol: up(a.symbol), side: String(a.side || '').toLowerCase(),
        qty: num(a.qty), filled_qty: num(a.filled_qty), filled_avg_price: num(a.filled_avg_price),
        filled_at: a.filled_at || null, order_status: a.order_status || null,
        result: a.result || null, error: a.error || null, intencion: a.intencion || null,
        client_order_id: a.client_order_id || null, alpaca_order_id: a.alpaca_order_id || null,
      };
      // Una acción sin id de Alpaca y sin estado nunca se mandó: el guard viejo
      // la descartó. Se publica como `no_enviada` con su motivo, no como una
      // orden pendiente que alguien va a esperar.
      const nuncaSalio = !a.alpaca_order_id && !a.order_status;
      return detalleDeOrden({
        orden: {
          symbol: a.symbol, side: a.side, qty: a.qty, limit_price: a.limit_price,
          intencion: a.intencion || null, closes_position: !!a.closes_position,
          referencia: a.referencia ?? null, delta_weight: a.delta_weight,
          alpaca_order_id: a.alpaca_order_id || null, client_order_id: a.client_order_id || null,
        },
        fill: nuncaSalio
          ? { ...fill, result: 'submit_failed', error: a.reason || a.error || `el guard la descartó (${a.result || 'sin resultado'})` }
          : fill,
        entrada: entradas[up(a.symbol)] || null,
      });
    });
}
