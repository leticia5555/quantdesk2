// ═══════════════════════════════════════════════════════════════
// tests/arena-manos.test.mjs — CUÁNTAS MANOS JUGÓ CADA UNO.
//
// EL DATO (2026-09-25, siete días):
//
//     control 37 vivas / 0 abortadas       deepseek  9 / 25
//     claude  30 / 0                       qwen      3 / 22
//     grok    18 / 7                       ──────────────────
//     ChatGPT 13 / 13                      liga    123 / 77
//     gemini  13 / 10
//
// **Qwen decidió TRES veces en la semana. Control decidió 37.** El ranking los
// ponía en la misma tabla y publicaba la diferencia como si midiera al modelo.
//
// Y es una objeción DISTINTA del piso de ruido: el piso dice cuánta de la
// distancia entre dos puestos es azar; esto dice que dos agentes no jugaron el
// mismo juego. Un modelo que decide tres veces en cinco sesiones tiene una
// cartera que es sobre todo deriva de precio.
//
// Lo que este archivo fija:
//   1. UNA ABORTADA NO ES UNA DECISIÓN DE NO OPERAR. `ok_no_actions` es el
//      modelo actuando; `aborted_cuerpo_vacio` es el modelo ausente.
//   2. EL CRITERIO ES EL COCIENTE, no la diferencia.
//   3. CERO CORRIDAS VIVAS ES EL CASO MÁS GRAVE, y no puede salir como un
//      cociente indefinido que la pantalla ignore.
//   4. LA DIRECCIÓN DEL SESGO NO SE INSINÚA.
//
// Correr con `node tests/arena-manos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { manosPorAgente, comparabilidad, manosDeLaLiga, RATIO_INCOMPARABLE } from '../api/_lib/arena-manos.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// La semana real, expandida a filas del journal.
const SEMANA = [];
const meter = (agente, vivas, abortadas) => {
  for (let i = 0; i < vivas; i++) SEMANA.push({ agent_id: agente, status: 'ok_target' });
  for (let i = 0; i < abortadas; i++) SEMANA.push({ agent_id: agente, status: 'aborted_cuerpo_vacio' });
};
meter('control', 37, 0); meter('claude', 30, 0); meter('grok', 18, 7);
meter('openai', 13, 13); meter('gemini', 13, 10); meter('deepseek', 9, 25); meter('qwen', 3, 22);

// ── 1) EL CONTEO ─────────────────────────────────────────────────────
console.log('\n── vivas contra abortadas ──');
{
  const m = manosPorAgente(SEMANA);
  ok(m.get('qwen').vivas === 3 && m.get('qwen').abortadas === 22, 'qwen: 3 vivas, 22 abortadas');
  ok(m.get('control').vivas === 37 && m.get('control').abortadas === 0, 'control: 37 vivas, 0 abortadas');
  ok(m.get('qwen').pct_abortos === 88, 'y el porcentaje de abortos por agente', String(m.get('qwen').pct_abortos));

  // Una fila de LIGA (`rules_changed`, `season_started`) no es la corrida de
  // nadie: contarla le regalaría manos a un agente que no decidió.
  const conLiga = manosPorAgente([...SEMANA, { agent_id: 'league', status: 'rules_changed' }]);
  ok(!conLiga.has('league'), 'las filas de liga no cuentan como corridas de un agente');
}

// ── 2) ABORTAR NO ES DECIDIR QUEDARSE QUIETO ─────────────────────────
// Es la distinción que hace que el número signifique algo: `ok_no_actions` es
// el modelo mirando y decidiendo no tocar nada; `aborted_*` es el modelo que no
// llegó. Contarlas juntas haría parecer prudente una falla de infraestructura.
console.log('\n── el modelo quieto y el modelo ausente ──');
{
  const m = manosPorAgente([
    { agent_id: 'x', status: 'ok_no_actions' },
    { agent_id: 'x', status: 'ok_target' },
    { agent_id: 'x', status: 'rejected_rails' },
    { agent_id: 'x', status: 'ejecutado_parcial' },
    { agent_id: 'x', status: 'aborted_cuerpo_vacio' },
    { agent_id: 'x', status: 'aborted_llm_error' },
  ]);
  ok(m.get('x').vivas === 4,
    'quedarse quieto, operar, que lo rechacen los rieles y ejecutar parcial son CUATRO decisiones: el modelo llegó',
    String(m.get('x').vivas));
  ok(m.get('x').abortadas === 2, 'y solo los `aborted_*` cuentan como ausencia', String(m.get('x').abortadas));
}

// ── 3) LA COMPARABILIDAD ─────────────────────────────────────────────
console.log('\n── ¿se pueden comparar estos dos? ──');
{
  const r = comparabilidad(manosPorAgente(SEMANA));
  ok(r.mas.agente === 'control' && r.mas.vivas === 37, 'el que más jugó');
  ok(r.menos.agente === 'qwen' && r.menos.vivas === 3, 'y el que menos');
  ok(r.ratio === 12.3, 'control jugó 12.3× más manos que qwen', String(r.ratio));
  ok(r.comparables === false, 'así que la tabla NO es una comparación');
  ok(/NO SON COMPARABLES/.test(r.lectura) && /deriva de precio/.test(r.lectura),
    'y la lectura dice por qué: pocas manos = la cartera la movió el mercado, no el modelo', r.lectura);
  ok(r.vivas_totales === 123 && r.abortadas_totales === 77, 'los totales de la liga', JSON.stringify([r.vivas_totales, r.abortadas_totales]));
  ok(r.pct_abortos_liga === 38.5, 'y el 38.5% de abortos de la liga', String(r.pct_abortos_liga));

  // EL CRITERIO ES EL COCIENTE, NO LA DIFERENCIA: 37 vs 3 y 370 vs 30 son el
  // mismo problema, y 40 vs 37 no lo es aunque la diferencia sea parecida.
  const parejo = comparabilidad(manosPorAgente([
    ...Array(40).fill({ agent_id: 'a', status: 'ok_target' }),
    ...Array(37).fill({ agent_id: 'b', status: 'ok_target' }),
  ]));
  ok(parejo.comparables === true && /se puede leer como una comparación/.test(parejo.lectura),
    '40 contra 37 sí se compara: 3 manos de diferencia no es 12×', parejo.lectura);
  const diezVeces = comparabilidad(manosPorAgente([
    ...Array(370).fill({ agent_id: 'a', status: 'ok_target' }),
    ...Array(30).fill({ agent_id: 'b', status: 'ok_target' }),
  ]));
  ok(diezVeces.comparables === false, 'y 370 contra 30 no, aunque los números sean otros');
  ok(RATIO_INCOMPARABLE === 2, 'el corte está declarado como una constante, no escondido en un if', String(RATIO_INCOMPARABLE));
}

// ── 4) CERO CORRIDAS VIVAS ES EL PEOR CASO, NO UN HUECO ──────────────
// Un cociente con denominador cero no existe. Si eso saliera como `null` y la
// pantalla lo ignorara, el agente MÁS roto sería el único sin advertencia.
console.log('\n── el que no jugó ninguna ──');
{
  const r = comparabilidad(manosPorAgente([
    ...Array(20).fill({ agent_id: 'a', status: 'ok_target' }),
    ...Array(9).fill({ agent_id: 'z', status: 'aborted_cuerpo_vacio' }),
  ]));
  ok(r.ratio === null, 'el cociente no existe con cero manos');
  ok(r.comparables === false, 'pero eso NO lo vuelve comparable: es el caso más grave');
  ok(/no completó NINGUNA corrida/.test(r.lectura) && /o está midiendo al modelo/.test(r.lectura),
    'y se dice con todas las letras', r.lectura);
}

// ── 5) LA DIRECCIÓN DEL SESGO NO SE INSINÚA ──────────────────────────
console.log('\n── lo que no se afirma ──');
{
  const r = comparabilidad(manosPorAgente(SEMANA));
  ok(/puede ahorrarle a un agente una decisión mala tanto como impedirle una buena/.test(r.caveat),
    'abortar no es ni bueno ni malo para el resultado, y el bloque lo dice en vez de sugerir una dirección');
  ok(!/perjudica|beneficia|ventaja|desventaja/i.test(r.lectura),
    'la lectura no insinúa a quién favorece: lo único afirmable es que no midieron lo mismo', r.lectura);

  const solo = comparabilidad(manosPorAgente([{ agent_id: 'a', status: 'ok_target' }]));
  ok(solo.disponible === false, 'con un solo agente no hay comparación que declarar');
}

// ── 6) EL CONTRATO CON LA PANTALLA ───────────────────────────────────
console.log('\n── /liga muestra las manos al lado del retorno ──');
{
  const api = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');

  ok(/manos: manos,/.test(api), 'el endpoint publica el bloque de manos');
  ok(/out\.manos = \(manos && manos\.por_agente\[agent\.id\]\) \|\| null;/.test(api),
    'y las cuelga de CADA fila: un puesto no se lee sin saber cuántas veces jugó el que lo tiene');
  ok(/ARENA_SEASON\.start/.test(api), 'contadas desde la apertura de la temporada, la misma ventana que el retorno');
  ok(/data\.manos/.test(page) && /function manosHtml/.test(page), 'la página lo lee y lo pinta');
  ok(/manosTag/.test(page) && /' manos'/.test(page), 'con la etiqueta en la fila de cada agente');
  ok(/tag manos pocas|manos'\+\(pocas/.test(page), 'y marcada distinto cuando el agente jugó muy pocas');

  // El bloque va DENTRO del margen, que está arriba del ranking: las dos
  // objeciones a la tabla se leen juntas y antes que la tabla.
  const iManos = page.indexOf('manosHtml(MANOS)');
  const iBoard = page.indexOf('id="board"');
  ok(iManos > 0 && iBoard > 0 && iManos < page.indexOf('function rowHtml'),
    'y se pinta dentro del bloque del margen, arriba del ranking');
}

// ── 7) EL BLOQUE COMPLETO ────────────────────────────────────────────
console.log('\n── el bloque que publica el endpoint ──');
{
  const b = manosDeLaLiga(SEMANA);
  ok(b.por_agente.qwen.vivas === 3 && b.resumen.ratio === 12.3, 'trae el detalle por agente y el resumen juntos');
  ok(manosDeLaLiga([]).resumen.disponible === false, 'y sin filas no inventa una comparación');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
