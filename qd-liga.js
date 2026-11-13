// ═══════════════════════════════════════════════════════════════════════
// qd-liga.js — LA TARJETA DE LA LIGA, PARA LAS DOS PANTALLAS QUE LA ENSEÑAN
//
// La portada (`/`) y `/mercado` pintan la misma tabla corta de La Liga. Hasta
// acá `/mercado` la armaba de `/api/mercado-paneles`, que le pregunta al
// leaderboard por dentro con un reloj de 6 s, se queda con cinco agentes y
// se guarda en caché hasta veinte minutos: la tarjeta de `/mercado` podía
// decir otra cosa que la de la portada, o no decir nada (Lety, 2026-11-11).
//
// Ahora las dos leen `/api/leaderboard` y las dos pasan la respuesta por
// `qdLigaModelo`. UNA función decide el orden, quién va sin datos y con qué
// causa; cada pantalla sólo le pone su HTML.
//
// ACÁ NO SE CALCULA NI UN RENDIMIENTO NI UN PUESTO. Es dinero: el número y el
// `rank` son los del leaderboard, y la frase contra el índice también.
//
// Patrón doble, como `qd-tablas.js`: el navegador lo carga con <script src> y
// las pruebas con `require`.
// ═══════════════════════════════════════════════════════════════════════

/* eslint-disable no-var */

var QD_LIGA_MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** '2026-10-20' → '20 oct'. Sin `Date`: una fecha ISO no tiene zona que correr. */
function qdLigaDia(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m || !QD_LIGA_MESES[Number(m[2]) - 1]) return null;
  return Number(m[3]) + ' ' + QD_LIGA_MESES[Number(m[2]) - 1];
}

function qdLigaNum(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * POR QUÉ A ESTE AGENTE LE FALTA EL RENDIMIENTO, en una línea sin jerga.
 *
 * ESPEJO de `causaSinRetorno` (api/_lib/mercado-paneles.js): las mismas
 * claves y las mismas frases, en el mismo orden. Aquel módulo es ESM de
 * servidor y el navegador no lo puede cargar; `tests/qd-liga.test.mjs` compara
 * las dos funciones caso por caso para que no se separen.
 *
 * La única diferencia es de dónde sale el capital: el leaderboard lo publica
 * en `account.equity`, y acá se lee de ahí.
 */
function qdLigaCausa(a) {
  if (a && a.temporada_abierta === false) {
    return { clave: 'sin_temporada', frase: 'Temporada nueva sin arrancar · el reset no ha corrido' };
  }
  if (a && a.has_keys === false) {
    return { clave: 'sin_llaves', frase: 'Sin llaves de Alpaca conectadas' };
  }
  var equity = a && a.account ? qdLigaNum(a.account.equity) : qdLigaNum(a && a.equity);
  if (equity == null) {
    return { clave: 'sin_cuenta', frase: 'No se pudo leer su cuenta de Alpaca' };
  }
  if (qdLigaNum(a && a.baseline_equity) == null) {
    return { clave: 'sin_baseline', frase: 'No se pudo leer su capital inicial' };
  }
  return { clave: 'sin_dato', frase: 'Sin rendimiento publicado' };
}

/**
 * La respuesta de `/api/leaderboard` → lo que la tarjeta pinta.
 *
 * Devuelve:
 *   error        string | null   no se pudo leer, y por qué
 *   vacio        string | null   se leyó y no hay filas, y por qué
 *   temporada    string          "Temporada 3 · 20 oct → 18 nov"
 *   filas        [{ id, puesto, nombre, modelo, empate, pct, sinDatos, causa, causa_clave }]
 *                en el orden del leaderboard, con los SIN DATOS al final
 *   causaComun   string | null   cuando NINGUNO tiene número y todos por lo mismo
 *   indice       { nombre, pct, sinDatos, causa } | null   el benchmark, que no compite
 *   lectura      string | null   la frase contra el índice, redactada por el servidor
 */
function qdLigaModelo(j) {
  var d = j || {};
  var agentes = Array.isArray(d.agents) ? d.agents : [];
  var base = { error: null, vacio: null, temporada: '', filas: [], causaComun: null, indice: null, lectura: null };

  if (d.error && !agentes.length) {
    base.error = 'no se pudo leer la tabla: ' + String(d.error);
    return base;
  }

  var t = d.temporada || {};
  var partes = [];
  if (t.name) partes.push(String(t.name));
  var a = qdLigaDia(t.start), b = qdLigaDia(t.end);
  if (a && b) partes.push(a + ' → ' + b);
  if (t.abierta === false) partes.push('todavía no abre');
  base.temporada = partes.join(' · ');

  if (!agentes.length) {
    base.vacio = d.enabled === false ? 'la liga todavía no arranca' : 'el leaderboard no devolvió agentes';
    return base;
  }

  var filas = agentes.map(function (g, i) {
    var pct = qdLigaNum(g.return_pct);
    var hay = pct != null;
    var causa = hay ? null : qdLigaCausa(g);
    return {
      id: g.id || null,
      nombre: g.name || g.id || '—',
      modelo: g.model_label || g.model || '',
      // Un modelo SIN DATOS no tiene puesto: no se le puede comparar con nadie.
      puesto: hay && qdLigaNum(g.rank) != null ? g.rank : null,
      empate: !!(hay && g.margen && g.margen.empate_tecnico),
      pct: pct,
      sinDatos: !hay,
      causa: causa ? causa.frase : null,
      causa_clave: causa ? causa.clave : null,
      _orden: i,
    };
  });
  // Con datos primero, por `rank`; sin datos al final, en el orden en que
  // llegaron. El orden es el del servidor: acá sólo se manda lo mudo al fondo.
  filas.sort(function (x, y) {
    if (x.sinDatos !== y.sinDatos) return x.sinDatos ? 1 : -1;
    var rx = x.puesto == null ? Infinity : x.puesto, ry = y.puesto == null ? Infinity : y.puesto;
    if (rx !== ry) return rx - ry;
    return x._orden - y._orden;
  });
  filas.forEach(function (f) { delete f._orden; });
  base.filas = filas;

  // UNA LÍNEA, UNA VEZ, ARRIBA: cuando ninguno tiene número y todos por lo
  // mismo —el caso real: la temporada no se ha reiniciado—, repetir la causa
  // en cada fila no informa siete veces, tapa la tarjeta.
  if (filas.every(function (f) { return f.sinDatos; })) {
    var claves = {};
    filas.forEach(function (f) { claves[f.causa_clave] = 1; });
    if (Object.keys(claves).length === 1) base.causaComun = filas[0].causa;
  }

  var bm = d.benchmark;
  if (bm) {
    var bp = qdLigaNum(bm.return_pct);
    base.indice = {
      nombre: bm.name || 'S&P 500',
      pct: bp,
      sinDatos: bp == null,
      causa: bp == null
        ? (bm.abierto === false ? 'El índice se abre con el reset que arranca la temporada'
          : (bm.error ? 'No se pudo leer el precio del índice' : 'Sin rendimiento publicado'))
        : null,
    };
  }

  var idx = d.margen_de_la_tabla && d.margen_de_la_tabla.indice;
  base.lectura = idx && idx.lectura ? String(idx.lectura) : null;
  return base;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { qdLigaModelo, qdLigaCausa, qdLigaDia };
}
