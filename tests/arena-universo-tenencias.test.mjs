// ═══════════════════════════════════════════════════════════════
// tests/arena-universo-tenencias.test.mjs — LO QUE PUEDE VER ≠ LO QUE PUEDE TENER.
//
// EL CASO (2026-09-22): deepseek compró NKE al 25% por la mañana y lo liquidó
// por la tarde "porque el universo admisible de hoy fuerza la salida". No fue
// una decisión de cartera: era la verdad del sistema. El universo del día era
// a la vez lo que el agente podía MIRAR y lo que podía TENER, y el prompt se lo
// decía con todas las letras.
//
// Lo que este archivo fija:
//
//   1. UNA POSICIÓN ABIERTA NO LA CIERRA LA ROTACIÓN DE UNA LISTA. Un nombre
//      que se tiene se puede mantener aunque no esté en el universo de hoy.
//   2. PERO NO SE PUEDE AGRANDAR. Si tener bastara para comprar, una acción
//      heredada sería la llave para meter el 30% en un nombre que el universo
//      rechazó por liquidez.
//   3. EL CORTE ES LA BANDA DE NO-NEGOCIACIÓN, NO UN EPSILON. Por debajo de la
//      banda el motor no manda una orden: descartar una pata por 0.3pp
//      mandaría la posición ENTERA a cash — la liquidación forzada otra vez,
//      por la puerta de atrás.
//   4. EL PROMPT NO PUEDE DECIR "no podés tenerlo". Tres textos lo decían.
//
// Correr con `node tests/arena-universo-tenencias.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { normalizarTickersObjetivo, rescatarObjetivo, RAILS } from '../api/_lib/arena-rails.js';
import { marcarNoAdmitidos } from '../api/arena-run.js';
import { bloqueDeRechazos } from '../api/_lib/arena-rechazos.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// El universo de HOY no tiene NKE. El libro SÍ, al 25%.
const UNIVERSO = ['AAPL', 'MSFT', 'NVDA', 'XOM', 'PGR'];
const LIBRO = { NKE: 0.25, AAPL: 0.10 };

// ── 1) EL CASO DE DEEPSEEK, ANTES Y DESPUÉS ──────────────────────────
console.log('\n── una posición abierta no la cierra la rotación de la lista ──');
{
  // ANTES: sin tenencias, NKE es un nombre inventado, y el objetivo se rompe
  // por pedir un nombre que el agente YA TIENE. Las dos salidas posibles son
  // malas, y por eso el bug no se veía como un bug — había un camino "sano"
  // para cada caso:
  const libroLleno = { NKE: 0.25, AAPL: 0.20, MSFT: 0.20, NVDA: 0.20, XOM: 0.15 };
  const antes = normalizarTickersObjetivo(libroLleno, { universo: UNIVERSO });
  ok(antes.ok === false, 'sin tenencias, pedir NKE rompe el objetivo aunque el agente lo tenga');
  ok(antes.weights.NKE === undefined, 'y NKE sale de los pesos');

  // (a) LA LIQUIDACIÓN FORZADA: si lo descartado cabe bajo el tope, el rescate
  // ejecuta el resto del libro SIN NKE — y "sin NKE" en el contrato objetivo
  // significa vender NKE. Nadie decidió esa venta.
  const rescate = rescatarObjetivo(antes);
  ok(rescate.rescatable === true && rescate.pesos.NKE === undefined,
    'el rescate ejecuta el libro sin NKE: en el contrato objetivo eso ES venderlo, y nadie decidió esa venta',
    JSON.stringify({ rescatable: rescate.rescatable, fraccion: rescate.fraccion }));

  // (b) Y CON EL NOMBRE PESANDO MÁS, el otro final: el objetivo se rechaza
  // entero y el libro se queda congelado en el de ayer. Distinto síntoma,
  // misma causa.
  const congela = rescatarObjetivo(normalizarTickersObjetivo({ NKE: 0.25, AAPL: 0.10 }, { universo: UNIVERSO }));
  ok(congela.rescatable === false && congela.motivo === 'demasiado_peso',
    'y con NKE pesando más, el objetivo se rechaza entero y el libro queda congelado: el otro final del mismo bug',
    congela.motivo);

  // DESPUÉS: con el libro en la mano, NKE es legal.
  const d = normalizarTickersObjetivo({ NKE: 0.25, AAPL: 0.10 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(d.ok === true, 'con el libro en la mano, el objetivo pasa entero');
  ok(d.weights.NKE === 0.25, 'y NKE se mantiene al peso que el PM escribió', String(d.weights.NKE));
  ok(d.admitidos_por_tenencia.length === 1 && d.admitidos_por_tenencia[0].simbolo === 'NKE',
    'el nombre que vivió SOLO por estar en el libro queda contado: sin eso el arreglo sería invisible',
    JSON.stringify(d.admitidos_por_tenencia));
  ok(/no está en el universo de HOY/.test(d.admitidos_por_tenencia[0].nota), 'con la razón escrita al lado');
}

// ── 2) REDUCIR SIEMPRE SE PUEDE ──────────────────────────────────────
console.log('\n── mantener, reducir, cerrar ──');
{
  const baja = normalizarTickersObjetivo({ NKE: 0.08, AAPL: 0.10 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(baja.ok === true && baja.weights.NKE === 0.08, 'reducir de 25% a 8% es legal: sigue siendo una salida parcial');

  // Cerrarlo del todo NO pasa por acá: omitirlo del objetivo ya es venderlo
  // (regla del contrato), y un 0% explícito lo descarta `parseTarget`.
  const cierra = normalizarTickersObjetivo({ AAPL: 0.10 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(cierra.ok === true && cierra.weights.NKE === undefined,
    'y cerrarlo sigue siendo omitirlo: el permiso de tener no obliga a tener');
}

// ── 3) NO SE PUEDE AGRANDAR ──────────────────────────────────────────
console.log('\n── tener no es poder comprar ──');
{
  const sube = normalizarTickersObjetivo({ NKE: 0.30, AAPL: 0.10 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(sube.ok === false, 'pedir 30% de un nombre que se tiene al 25% y no está en el universo NO pasa');
  const d = sube.desconocidos[0];
  ok(d.fuera_del_universo_pero_en_libro === true, 'y se marca como lo que es: lo tiene, pero está fuera del universo');
  ok(/MANTENER o REDUCIR, no aumentar/.test(d.motivo), 'con el motivo exacto, no un "no existe" genérico', d.motivo);
  ok(d.peso_actual === 0.25, 'y el peso actual viaja, para poder leer cuánto quería agrandar', String(d.peso_actual));

  // Sin este límite, una acción heredada sería la llave para meter el 30% del
  // libro en un nombre que el universo rechazó.
  const heredada = normalizarTickersObjetivo({ ZZZZ: 0.30 }, { universo: UNIVERSO, tenencias: { ZZZZ: 0.001 } });
  ok(heredada.ok === false, 'una posición testimonial no habilita una compra grande');
}

// ── 4) EL CORTE ES LA BANDA, NO UN EPSILON ───────────────────────────
// Éste es el que importa: con un epsilon, un objetivo que pide 25.3% sobre una
// posición del 25.0% se descartaría, y descartar manda la posición ENTERA a
// cash. O sea: la liquidación forzada volvería por la puerta de atrás, por
// 0.3pp que el motor ni siquiera habría operado.
console.log('\n── el corte es la banda de no-negociación ──');
{
  ok(RAILS.no_trade_band > 0.001, 'la banda existe y no es un epsilon', String(RAILS.no_trade_band));
  const drift = normalizarTickersObjetivo({ NKE: 0.25 + RAILS.no_trade_band - 0.001 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(drift.ok === true, 'un aumento MENOR que la banda no es un aumento: el motor no lo operaría');
  ok(drift.admitidos_por_tenencia.length === 1, 'y se admite por tenencia, no se descarta');

  const real = normalizarTickersObjetivo({ NKE: 0.25 + RAILS.no_trade_band + 0.01 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(real.ok === false, 'pasada la banda ya es una compra, y ahí sí se descarta');
}

// ── 5) SIN TENENCIAS, EL COMPORTAMIENTO ES EL DE ANTES ───────────────
console.log('\n── degrada, no se rompe ──');
{
  const sin = normalizarTickersObjetivo({ AAPL: 0.1 }, { universo: UNIVERSO });
  ok(sin.ok === true && sin.validado_contra_tenencias === false,
    'sin libro se valida solo contra el universo, y se dice que fue así');
  const ticker = normalizarTickersObjetivo({ 'EO G': 0.15 }, { universo: [...UNIVERSO, 'EOG'], tenencias: LIBRO });
  ok(ticker.ok === true && ticker.weights.EOG === 0.15,
    'y la normalización del ticker corrupto de deepseek sigue funcionando igual');
  const inventado = normalizarTickersObjetivo({ FAKE: 0.1 }, { universo: UNIVERSO, tenencias: LIBRO });
  ok(inventado.ok === false && /no lo tenés en el libro/.test(inventado.desconocidos[0].motivo),
    'un ticker inventado que tampoco se tiene se rechaza igual que siempre, y el motivo lo dice',
    inventado.desconocidos[0].motivo);
}

// ── 6) LOS TRES TEXTOS QUE ENSEÑABAN LA REGLA FALSA ──────────────────
console.log('\n── el prompt ya no dice "no podés tenerlo" ──');
{
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');

  // (a) El system prompt del contrato objetivo.
  ok(!/You CANNOT hold them today/.test(run),
    'la línea del prompt que decía "You CANNOT hold them today" salió: era la instrucción que producía la liquidación');
  ok(/You CANNOT OPEN a position in them today/.test(run), 'y la reemplaza una sobre ABRIR, que es lo que el universo decide');
  ok(/WHAT YOU CAN HOLD IS NOT WHAT YOU CAN SEE/.test(run), 'con la regla dicha aparte y en mayúsculas, como las otras que deciden un libro');
  ok(/rail rejects it, a deterministic stop fires, or YOU decide to sell it/.test(run),
    'nombrando las TRES únicas salidas: riel, stop, o decisión del agente');
  ok(/is NOT a reason to exit/.test(run),
    'y cerrando la puerta al razonamiento exacto que usó deepseek ("el universo de hoy fuerza la salida")');

  // (b) La nota que viaja EN LA FILA de cada nombre marcado.
  const m = marcarNoAdmitidos(
    { movers: { gainers: [{ symbol: 'NKE', price: 70 }], losers: [], actives: [] }, screener: {}, notable_insider_buys: [] },
    UNIVERSO,
  );
  ok(m.total === 1, 'NKE se sigue marcando: el PM tiene que saber que no lo puede comprar hoy');
  ok(!/CANNOT hold/i.test(JSON.stringify(m)), 'pero la nota ya no dice que no lo pueda tener');
  ok(/no puede ABRIR ni AGRANDAR/.test(m.nota), 'dice lo correcto: no puede abrir ni agrandar', m.nota);

  // (c) La memoria de rechazos, que repetía la misma regla falsa.
  const bloque = bloqueDeRechazos(
    [{ status: 'rejected_tickers', tickers: { desconocidos: [{ pedido: 'ZM', motivo: 'no está en el universo de hoy' }] } }],
    { universo: UNIVERSO },
  );
  ok(/cannot be OPENED today/.test(bloque), 'el aviso de rechazos habla de abrir, no de tener');
  ok(/says nothing about the positions you already hold/.test(bloque),
    'y aclara que no dice nada sobre lo que el agente ya tiene — que era justo lo que se leía al revés', bloque.slice(-200));
}

// ── 7) EL CAMINO VIVO PASA EL LIBRO ──────────────────────────────────
console.log('\n── la corrida en vivo le pasa su libro al validador ──');
{
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  ok(/normalizarTickersObjetivo\(parsed\.weights, \{ universo: universoSimbolos, tenencias \}\)/.test(shadow),
    'el objetivo se valida contra el universo Y contra el libro del agente');
  ok(/tenencias\[sym\] = mv \/ equity/.test(shadow), 'con el peso actual de cada posición, no solo su nombre');
  ok(/admitidos_por_tenencia: tick\.admitidos_por_tenencia/.test(shadow),
    'y el journal guarda cuáles vivieron solo por estar en el libro: es lo que hace auditable el conteo de salidas por rotación');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
