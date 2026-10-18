// ═══════════════════════════════════════════════════════════════
// tests/arena-corte-cierre.test.mjs — UN JSON QUE MUERE EN EL CARÁCTER
// 771 NO ES "MAL JSON": ES UN JSON CORTADO.
//
// EL DATO (segunda tanda de humo, 2026-10-02). Dos agentes abortaron con el
// MISMO `status` y los dos errores se leían como el mismo hallazgo:
//
//   deepseek · aborted_malformed_target · JSON inválido: Expected ',' or '}'
//              after property value in JSON at position 771
//   qwen     · aborted_malformed_target · la respuesta no contiene un objeto JSON
//
// El primero arranca bien, nombra propiedades bien, y se termina a mitad de un
// valor. Eso es una respuesta CORTADA, y quien la cortó puede ser NUESTRO
// techo de tokens. El segundo no tiene JSON en ningún lado. Son diagnósticos
// opuestos —uno se arregla subiendo `ARENA_MAX_TOKENS`, el otro es un hallazgo
// sobre el agente— y salían con el mismo texto.
//
// Lo peor: la sonda de /api/arena-smoke YA separaba las dos cosas desde
// siempre (`stop_reason` → `truncated`). El camino de arena-shadow, el que
// corre la liga, NO. La liga medía con un instrumento más ciego que el de la
// prueba de conectividad.
//
// LO QUE ESTE ARCHIVO FIJA:
//   1. TRES ESTADOS, NO DOS. `truncado: false` cuando no se puede saber es el
//      patrón que ya nos mordió dos veces: un chequeo que confirma la
//      propiedad débil y se lee como si confirmara la fuerte.
//   2. EL HUECO SE DECLARA. Si `truncado` es null, SIEMPRE viene el motivo.
//   3. DOS TESTIGOS INDEPENDIENTES. Los proveedores que no mandan
//      `finish_reason` son justo los que hay que diagnosticar, así que los
//      tokens tienen que alcanzar para decirlo solos.
//   4. EL RELOJ DEL RESCATE NO TOCA EL MARGEN. Un reintento que se come los
//      15s que separan de el deadline deja la corrida SIN journal, que es peor
//      que una corrida malformada.
//   5. UNA SOLA FORMA DE RESUMEN para las tres salidas, también la abortada.
//
// Correr con `node tests/arena-corte-cierre.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { diagnosticoDeCorte } from '../api/_lib/arena-model.js';
import { relojDeReintento, resumenDelLoop } from '../api/arena-shadow.js';
import { RESERVA_CIERRE_MS, PISO_VUELTA_MS, MARGEN_MS } from '../api/_lib/arena-tool-loop.js';
import { ARENA_AGENT_DEADLINE_MS, ARENA_REINTENTO_JSON } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const resp = (stop, out, { reasoning = 0 } = {}) => ({
  stop_reason: stop,
  usage: { output_tokens: out, reasoning_tokens: reasoning },
});

// ── 1) LOS TRES ESTADOS ──────────────────────────────────────────────
console.log('\n── truncado es true, false o NO SE SABE ──');
{
  const cortado = diagnosticoDeCorte(resp('max_tokens', 4000), { maxTokens: 8000, texto: '{"weights":{"AAPL":0.1' });
  ok(cortado.truncado === true, 'stop_reason=max_tokens → truncado', JSON.stringify(cortado.truncado));
  ok(/stop_reason/.test(cortado.truncado_por || ''), 'y dice por qué testigo', cortado.truncado_por);

  const limpio = diagnosticoDeCorte(resp('end_turn', 1200), { maxTokens: 8000, texto: 'no es json' });
  ok(limpio.truncado === false, 'end_turn → NO truncado: el modelo cerró solo', JSON.stringify(limpio.truncado));

  // EL CASO DE QWEN. OpenRouter con un proveedor que no manda finish_reason.
  const mudo = diagnosticoDeCorte(resp(null, 900), { maxTokens: 8000, texto: 'bla' });
  ok(mudo.truncado === null, 'sin finish_reason y lejos del techo → null, no false', JSON.stringify(mudo.truncado));

  // Y EL QUE IMPORTA: `!null` es `true` en JS, así que cualquier consumidor que
  // escriba `!truncado` lee un "no se sabe" como "está sano". El tri-estado
  // sólo sirve si nadie lo colapsa con una negación.
  ok(!mudo.truncado === true,
    'recordatorio ejecutable: `!truncado` da true sobre null — comparar contra `=== true`/`=== false` SIEMPRE');
}

// ── 2) EL HUECO SE DECLARA ───────────────────────────────────────────
console.log('\n── un hueco declarado es un dato; uno silencioso es un bug ──');
{
  for (const [etiqueta, data] of [
    ['sin finish_reason', resp(null, 900)],
    ['finish_reason raro', resp('content_filter', 900)],
    ['sin tokens', { stop_reason: null, usage: {} }],
  ]) {
    const d = diagnosticoDeCorte(data, { maxTokens: 8000, texto: 'x' });
    ok(d.truncado === null && typeof d.por_que_no_se_sabe === 'string' && d.por_que_no_se_sabe.length > 20,
      `${etiqueta}: null viene con motivo`, d.por_que_no_se_sabe);
    ok(typeof d.como_se_sabría === 'string', `${etiqueta}: y con cómo se sabría`, d.como_se_sabría);
  }
  // Al revés: cuando SÍ se sabe, no se publica un motivo de duda que no existe.
  const sabido = diagnosticoDeCorte(resp('end_turn', 10), { maxTokens: 8000, texto: 'x' });
  ok(sabido.por_que_no_se_sabe === undefined, 'cuando se sabe, no hay campo de duda');
}

// ── 3) EL TESTIGO DE TOKENS ES INDEPENDIENTE ─────────────────────────
console.log('\n── los tokens dicen el corte aunque el proveedor se calle ──');
{
  const d = diagnosticoDeCorte(resp(null, 8000), { maxTokens: 8000, texto: '{"weights"' });
  ok(d.truncado === true, 'output_tokens == techo y sin finish_reason → truncado igual', JSON.stringify(d));
  ok(/tokens/.test(d.truncado_por || ''), 'y el testigo nombrado es el de tokens', d.truncado_por);
  ok(d.techo_usado === 1, 'techo_usado publica la fracción', String(d.techo_usado));

  // `>=`, no `===`: algunos proveedores cuentan el razonamiento aparte y el
  // total se pasa por unos tokens. Que lo ALCANCE ya es el hecho.
  const pasado = diagnosticoDeCorte(resp(null, 8137), { maxTokens: 8000, texto: 'x' });
  ok(pasado.truncado === true, 'y pasarse del techo también cuenta', String(pasado.output_tokens));

  // EL CASO QUE MANDA A OTRO LUGAR: el techo se gastó PENSANDO.
  const pensando = diagnosticoDeCorte(resp('max_tokens', 8000, { reasoning: 7400 }), { maxTokens: 8000, texto: 'x' });
  ok(/RAZONAMIENTO/.test(pensando.nota || ''), 'si el razonamiento se comió el techo, lo dice', pensando.nota);
  const escribiendo = diagnosticoDeCorte(resp('max_tokens', 8000, { reasoning: 100 }), { maxTokens: 8000, texto: 'x' });
  ok(escribiendo.nota === undefined, 'y no lo dice cuando no fue eso');
}

// ── 4) LA COLA, NO LA CABEZA ─────────────────────────────────────────
console.log('\n── donde se murió el texto es donde está la prueba ──');
{
  const largo = 'a'.repeat(3000) + 'FINAL';
  const d = diagnosticoDeCorte(resp('max_tokens', 8000), { maxTokens: 8000, texto: largo });
  ok(d.chars === largo.length, 'publica el largo entero', String(d.chars));
  ok(d.cola.endsWith('FINAL') && d.cola.length <= 160, 'y una cola acotada que incluye el final', String(d.cola.length));
}

// ── 5) EL RELOJ DEL RESCATE ──────────────────────────────────────────
console.log('\n── el reintento no se come el margen ──');
{
  const budget = ARENA_AGENT_DEADLINE_MS - RESERVA_CIERRE_MS - MARGEN_MS;
  const total = budget + RESERVA_CIERRE_MS;

  ok(relojDeReintento({ budgetMs: budget, elapsedMs: 0 }) === total,
    'sin gastar, el rescate ve loop + reserva y NADA del margen', String(total));
  ok(total + MARGEN_MS === ARENA_AGENT_DEADLINE_MS,
    'y ese total es exactamente el deadline menos el margen, con igualdad',
    `${total} + ${MARGEN_MS} vs ${ARENA_AGENT_DEADLINE_MS}`);

  // EL CASO DE GEMINI contra EL CASO DE QWEN, que es la desigualdad que hay
  // que publicar: el mismo riel, dos resultados.
  const gemini = relojDeReintento({ budgetMs: budget, elapsedMs: 42000 });
  const qwen = relojDeReintento({ budgetMs: budget, elapsedMs: 253000 });
  ok(gemini >= PISO_VUELTA_MS, 'el que cierra a los 42s alcanza a reintentar', String(gemini));
  ok(qwen < PISO_VUELTA_MS, 'el que cierra a los 253s NO, y por eso se declara `omitido_por_reloj`', String(qwen));

  // Y nunca se vuelve positivo por redondeo: un loop desbordado da negativo, y
  // negativo es "no hay", no "hay un poco".
  ok(relojDeReintento({ budgetMs: budget, elapsedMs: total + 5000 }) < 0,
    'un loop desbordado da negativo, no cero', String(relojDeReintento({ budgetMs: budget, elapsedMs: total + 5000 })));
}

// ── 6) EL RIEL ES UNO PARA LOS SIETE ─────────────────────────────────
console.log('\n── un riel que se enciende para uno solo no es un riel ──');
{
  ok(typeof ARENA_REINTENTO_JSON === 'boolean', 'la bandera existe y es booleana', String(ARENA_REINTENTO_JSON));
  // Se mira el CÓDIGO, no los comentarios: el comentario de arriba NOMBRA la
  // variante que no existe (para explicar por qué no existe) y un grep crudo
  // la encontraría ahí. Un test que pasa por leer su propia explicación no
  // prueba nada.
  const fuente = String((await import('node:fs')).readFileSync('api/_lib/arena-registry.js', 'utf8'))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/ARENA_REINTENTO_JSON_/.test(fuente),
    'y NO hay variante por agente: `ARENA_REINTENTO_JSON_<AGENTE>` no existe, a propósito');
  // Y la bandera se lee de UN nombre fijo, no de uno armado con el id.
  ok(/process\.env\.ARENA_REINTENTO_JSON\b/.test(fuente),
    'se lee de `process.env.ARENA_REINTENTO_JSON` literal, no de un nombre compuesto');
}

// ── 7) UNA SOLA FORMA DE RESUMEN, TAMBIÉN EN EL ABORTO ───────────────
console.log('\n── la fila de la puerta se arma igual haya salido bien o mal ──');
{
  const CLAVES = ['vueltas', 'cortó_por', 'herramientas', 'reloj_pct', 'lectura_max_ms', 'vacias', 'cortes_nuestros'];
  const lleno = resumenDelLoop({
    turns: 9, stopped_by: 'call_budget', limites: { reloj_ms: { pct: 84 } },
    vueltas_medidas: [{ ms: 12000 }, { ms: 61000, vacio: true }, { ms: 9000, reloj_nuestro: true }],
  }, { used: 20 });
  ok(CLAVES.every((k) => k in lleno), 'el resumen trae las siete claves', Object.keys(lleno).join(','));
  ok(lleno.lectura_max_ms === 61000 && lleno.vacias === 1 && lleno.cortes_nuestros === 1,
    'y las cuenta bien', JSON.stringify(lleno));

  // EL CASO QUE ROMPÍA LA TABLA: un aborto temprano, sin loop y sin executor.
  // La respuesta HTTP de un aborto traía `{agent,status,error,cost_usd}` y la
  // tabla de la puerta no se podía armar justo en las filas que importan.
  const vacio = resumenDelLoop(null, null);
  ok(CLAVES.every((k) => k in vacio), 'y las MISMAS siete con loop nulo: el script no puede tener un `if` por estado', JSON.stringify(vacio));
  ok(vacio.lectura_max_ms === null && vacio.vueltas === 0,
    'sin vueltas medidas, la lectura máxima es null y no 0 (no medimos 0ms, no medimos)', JSON.stringify(vacio));
}

// ── 8) LA ESTADÍSTICA DEL RIEL ───────────────────────────────────────
console.log('\n── "necesitó reintento" se cuenta, no se esconde ──');
{
  const { reintentoPublicable, conteoDeReintentos } = await import('../api/liga-libros.js');

  // `jsonb_build_object` SIEMPRE construye el objeto: una corrida sin reintento
  // vuelve con los cuatro campos en null, y eso en pantalla se lee como "hubo
  // reintento y no sabemos qué pasó" — lo contrario de lo que pasó.
  ok(reintentoPublicable({}) === null, 'sin contexto → null');
  ok(reintentoPublicable({ reintento_json: { concedido: null, resuelto: null, causa: null, omitido_por_reloj: null } }) === null,
    'los cuatro campos en null (la fila sin reintento) → null, no un objeto vacío');
  const r = reintentoPublicable({ reintento_json: { concedido: true, resuelto: true, causa: 'corte' } });
  ok(r && r.concedido === true && r.resuelto === true && r.causa === 'corte', 'y un rescate real se publica entero', JSON.stringify(r));

  const c = conteoDeReintentos([
    { agente: { id: 'deepseek' }, reintento: { concedido: true, resuelto: true, causa: 'corte' } },
    { agente: { id: 'deepseek' }, reintento: { concedido: true, resuelto: false, causa: 'formato' } },
    { agente: { id: 'qwen' }, reintento: { concedido: false, resuelto: null, causa: 'desconocida', omitido_por_reloj: true } },
    { agente: { id: 'claude' }, reintento: null },
  ]);
  ok(c.total === 3 && c.resueltos === 1 && c.omitidos_por_reloj === 1,
    'el total separa resueltos, fallados y omitidos por reloj', JSON.stringify(c));
  ok(c.por_agente.claude === undefined, 'y un agente que nunca lo necesitó no aparece inflado con ceros');
  ok(c.por_agente.deepseek.por_causa.corte === 1 && c.por_agente.deepseek.por_causa.formato === 1,
    'la causa se cuenta por separado: `corte` es nuestro techo, `formato` es el agente',
    JSON.stringify(c.por_agente.deepseek.por_causa));
  // LA DESIGUALDAD DECLARADA: el omitido por reloj tiene que estar en el mismo
  // objeto que el "necesitó", o publicar uno sin el otro haría pasar por
  // igualdad algo que en la práctica alcanza a cinco de siete.
  ok(c.por_agente.qwen.omitido_por_reloj === 1 && c.por_agente.qwen.necesito === 1,
    'y el que no alcanzó a usarlo se cuenta igual: el riel es desigual y se dice',
    JSON.stringify(c.por_agente.qwen));
}

console.log(failures ? `\n${failures} FALLARON\n` : '\nTODO VERDE\n');
process.exit(failures ? 1 : 0);
