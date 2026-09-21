// ═══════════════════════════════════════════════════════════════
// Tests de historia-prompt.js + historia-narrador.js — la llamada.
//
//   1. **El hash cubre la versión del prompt y el modelo**, no solo la
//      evidencia. Sin eso, cambiar una línea del prompt deja pasar todas las
//      narraciones guardadas —el hash no se movió— y quedan sirviéndose
//      textos del prompt viejo, para siempre, sin que nada lo diga.
//   2. **Y la versión no se puede olvidar de subir:** la huella del texto
//      está clavada acá. Si alguien edita el prompt sin tocar la versión,
//      esta prueba falla y dice qué hacer.
//   3. **El corte del caché va después del prompt congelado**, y la directiva
//      de fecha queda AFUERA del prefijo — si entrara, el caché se
//      invalidaría cada medianoche.
//   4. **Los tres finales que no son un éxito** se distinguen y ninguno se
//      guarda como narración: `refusal`, `max_tokens` y JSON inválido. El de
//      `max_tokens` es el peligroso: una narración cortada a la mitad, con
//      las citas correctas hasta donde llegó, se lee como completa.
//   5. **La respuesta cruda se guarda SIEMPRE**, incluso cuando falla. Si un
//      guardia la rechaza hay que poder ver qué dijo, no solo que la rechazó.
//   6. **El prompt dice cómo se cita un episodio.** El modelo solo tiene dos
//      anclas de una racha de 34; si narra el medio, el guardia de la I le va
//      a rechazar una frase que es cierta.
//
// Correr con `node tests/historia-narrador.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { PROMPT, PROMPT_VERSION, MODELO, HUELLA_PROMPT, identidadPrompt } from '../api/_lib/historia-prompt.js';
import {
  MAX_TOKENS, ESQUEMA_SALIDA, hashNarracion, armarRequest, costoDe, narrar,
} from '../api/_lib/historia-narrador.js';
import { ANTHROPIC_PRICES } from '../api/_lib/model.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const EV = { version: 'historia-evidencia-1', narrable: true, emisor: { ticker: 'MELI' }, linea: { eventos: [] } };

// Un doble de fetch que captura el request y devuelve lo que se le diga.
const doble = (respuesta, status = 200) => {
  const visto = {};
  const f = async (url, opts) => {
    visto.url = url;
    visto.headers = opts.headers;
    visto.cuerpo = JSON.parse(opts.body);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(respuesta) };
  };
  return { visto, f };
};

const RESPUESTA_OK = {
  id: 'msg_1', model: 'claude-opus-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ secciones: [{ id: 'direccion', texto: 'Nombró un CFO [acc-1].' }] }) }],
  usage: { input_tokens: 12000, output_tokens: 1400, cache_creation_input_tokens: 1430, cache_read_input_tokens: 0 },
};

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El prompt congelado, y la versión que no se puede olvidar');
{
  eq(MODELO, 'claude-opus-5', 'el modelo es explícito y viaja con la narración');
  ok(PROMPT_VERSION >= 1 && Number.isInteger(PROMPT_VERSION), 'la versión es un entero, legible en una columna');

  // ⚠️ SI ESTA PRUEBA FALLA: editaste el PROMPT. Subí PROMPT_VERSION en
  // api/_lib/historia-prompt.js y pegá acá la huella nueva. Las dos cosas.
  // Si solo actualizás la huella, las narraciones viejas van a seguir
  // sirviéndose con el prompt nuevo en la etiqueta.
  const HUELLA_ESPERADA = '9d6d123714bdb68d';
  const VERSION_ESPERADA = 1;
  ok(HUELLA_PROMPT === HUELLA_ESPERADA && PROMPT_VERSION === VERSION_ESPERADA,
    'la huella del prompt coincide con la versión declarada',
    `huella ${HUELLA_PROMPT} (esperaba ${HUELLA_ESPERADA}) · versión ${PROMPT_VERSION} (esperaba ${VERSION_ESPERADA})`);

  // La huella es del TEXTO, no del archivo: un comentario que cambia no
  // re-narra cuatro mil empresas.
  ok(!PROMPT.includes('═══════════════════════════════════════════════════════════════'),
    'la huella cubre las instrucciones, no la cabecera del archivo');

  hondo(identidadPrompt(), { prompt_version: PROMPT_VERSION, modelo: MODELO, huella_prompt: HUELLA_PROMPT },
    'lo que se guarda junto a la narración son las tres cosas');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Lo que el prompt prohíbe, y lo que manda');
{
  for (const frase of ['comprar', 'vender', 'sobreponderar', 'No predecir el precio', 'No recomendar']) {
    ok(PROMPT.includes(frase), `el prompt nombra la prohibición: ${frase}`);
  }
  ok(/No calcular/.test(PROMPT), 'prohíbe calcular: la aritmética ya viene resuelta');
  ok(/lenguaje relativo a hoy/.test(PROMPT),
    'y prohíbe lo relativo a hoy: sin eso, una narración cacheada envejece mintiendo');
  ok(/Sin documentos\./.test(PROMPT), 'manda decir "Sin documentos." en vez de rellenar');
  ok(/OBLIGATORIA/.test(PROMPT) && /Dónde se rompe la historia/.test(PROMPT),
    'la contraevidencia es obligatoria y va al final');
  ok(/no_cubierta/.test(PROMPT) && /hecho sobre nosotros/.test(PROMPT),
    'y distingue "no hay" de "no miramos", que es la distinción del módulo');

  // EL PUNTO 3: el modelo solo tiene DOS anclas de una racha de 34. Si narra
  // el medio, el guardia de la rebanada I le va a rechazar una frase que es
  // cierta — y eso es culpa del prompt, no del modelo.
  ok(/CÓMO SE CITA UN EPISODIO/.test(PROMPT), 'el prompt tiene la regla del episodio adentro, no como nota aparte');
  ok(/COMO BLOQUE/.test(PROMPT), 'dice que el episodio se cita como bloque');
  ok(/NO narres lo que pasó adentro del episodio/.test(PROMPT), 'y que no se narra su interior');
  ok(/Incorrecto:/.test(PROMPT) && /Correcto:/.test(PROMPT), 'con un ejemplo de cada lado, que es lo que se sigue');
  ok(/no tenés los documentos del medio|no podés citarlos/i.test(PROMPT), 'y explica POR QUÉ, que es lo que se recuerda');
  ok(/NO dice quién ganó/.test(PROMPT), 'el episodio no dice quién ganó');
  ok(/5\.07/.test(PROMPT) && /trae los votos/.test(PROMPT),
    'y el 5.07 se cita como el documento que es: interpretar el margen no le toca');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El hash cubre el prompt y el modelo, no solo la evidencia');
{
  const h = hashNarracion(EV);
  eq(h, hashNarracion(EV), 'el mismo insumo da el mismo hash');
  eq(h.length, 32, 'y es corto y estable');

  // El agujero que el punto 1 cierra: con el hash solo sobre la evidencia,
  // una narración del prompt viejo seguía pasando.
  const { hashDe } = await import('../api/_lib/historia-evidencia.js');
  const soloEvidencia = hashDe(EV);
  ok(h !== soloEvidencia, 'el hash NO es el de la evidencia sola');
  ok(h !== hashDe({ evidencia: EV, prompt_version: PROMPT_VERSION + 1, modelo: MODELO }),
    'subir la versión del prompt cambia el hash: las narraciones viejas dejan de servir');
  ok(h !== hashDe({ evidencia: EV, prompt_version: PROMPT_VERSION, modelo: 'claude-sonnet-5' }),
    'y cambiar el modelo también');
  eq(h, hashDe({ evidencia: EV, prompt_version: PROMPT_VERSION, modelo: MODELO }),
    'las tres cosas, y nada más: la fecha NO entra o se re-narraría cada medianoche');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El request: dónde cae el corte del caché');
{
  const req = armarRequest(EV, { ahora: new Date('2026-09-20T12:00:00Z') });

  eq(req.model, MODELO, 'el modelo es el configurado');
  eq(req.max_tokens, MAX_TOKENS, 'con techo generoso: una narración cortada es el peor modo de falla');
  hondo(req.thinking, { type: 'adaptive' }, 'pensamiento adaptativo, que es el modo de Opus 5');
  ok(!('budget_tokens' in (req.thinking || {})), 'y sin budget_tokens, que devuelve 400 en este modelo');
  eq(req.output_config.format.type, 'json_schema', 'salida estructurada: no se parsea prosa buscando secciones');
  hondo(req.output_config.format.schema, ESQUEMA_SALIDA, 'contra el esquema declarado');

  // EL CORTE. El prefijo estable es el prompt congelado y nada más.
  eq(req.system.length, 2, 'el system son dos bloques');
  eq(req.system[0].text, PROMPT, 'el primero es el prompt congelado, textual');
  hondo(req.system[0].cache_control, { type: 'ephemeral' }, 'y lleva el corte del caché');
  ok(!req.system[1].cache_control, 'el segundo NO lleva corte: queda afuera del prefijo');
  ok(/2026/.test(req.system[1].text), 'porque es la directiva de fecha, que cambia todos los días');

  // Si la fecha estuviera en el prefijo, el caché moriría cada medianoche.
  const otroDia = armarRequest(EV, { ahora: new Date('2026-09-21T12:00:00Z') });
  eq(otroDia.system[0].text, req.system[0].text, 'el prefijo es idéntico de un día para el otro');
  ok(otroDia.system[1].text !== req.system[1].text, 'y lo que cambia queda después del corte');

  // La evidencia va en el mensaje, no en el prompt: si estuviera adentro, el
  // prefijo sería distinto por empresa y no cachearía nunca.
  ok(req.messages[0].content.includes('historia-evidencia-1'), 'la evidencia viaja en el mensaje');
  ok(!PROMPT.includes('MELI'), 'y el prompt no lleva nada de la empresa: por eso es un prefijo');
  ok(/no existe ningún otro documento/i.test(req.messages[0].content),
    'con el recordatorio de que la evidencia es todo lo que hay');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El costo, desglosado');
{
  const c = costoDe({ input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  eq(c.usd.entrada, 5, 'un millón de tokens de entrada son 5 dólares');
  eq(costoDe({ output_tokens: 1000000 }).usd.salida, 25, 'y un millón de salida, 25');
  eq(costoDe({ cache_creation_input_tokens: 1000000 }).usd.cache_escritura, 6.25, 'escribir caché cuesta 1,25×');
  eq(costoDe({ cache_read_input_tokens: 1000000 }).usd.cache_lectura, 0.5, 'y leerlo, 0,1×');

  // Sin separar la lectura de caché de la entrada fresca no hay manera de
  // saber si el prefijo está pegando: se pagaría 10× de más sin que falle nada.
  const fria = costoDe(RESPUESTA_OK.usage);
  eq(fria.cache_pego_pct, 0, 'la primera corrida escribe caché y no lee nada');
  const tibia = costoDe({ input_tokens: 11000, output_tokens: 1400, cache_creation_input_tokens: 0, cache_read_input_tokens: 1430 });
  eq(tibia.cache_pego_pct, 100, 'la segunda lee el prefijo entero');
  ok(tibia.usd_total < fria.usd_total, 'y sale más barata');

  // DOS medidas, porque una sola se lee mal. "100% del caché pegó" suena a
  // que el caché hace todo el trabajo; lo que importa es qué fracción de la
  // ENTRADA vino de ahí, y son cosas muy distintas.
  eq(tibia.cache_del_total_pct, 11.5, 'pero solo el 11,5% de la entrada vino del caché');
  ok(tibia.cache_pego_pct > tibia.cache_del_total_pct * 5,
    'las dos medidas difieren mucho: por eso van juntas y no sola la primera');

  // Los números REALES de la corrida de MELI (2026-09-21, §11.7).
  const meli = costoDe({ input_tokens: 14344, output_tokens: 3957, cache_creation_input_tokens: 0, cache_read_input_tokens: 2487 });
  eq(meli.usd_total, 0.171889, 'el costo de la corrida real de MELI');
  eq(meli.cache_del_total_pct, 14.8, 'con el caché aportando el 14,8% de la entrada');
  ok(meli.usd.salida > meli.usd.entrada, 'y la SALIDA pesando más que la entrada: ahí está el costo');

  eq(costoDe({}).usd_total, 0, 'un usage vacío no inventa un costo');
  ok(ANTHROPIC_PRICES[MODELO], 'hay precio para el modelo configurado, en la tabla única del repo');

  // La doctrina de la tabla de precios: un modelo ausente devuelve null,
  // jamás un precio supuesto. Un número inventado en una factura es peor que
  // no tener número, porque nadie lo revisa.
  const desconocido = costoDe({ input_tokens: 1000 }, 'claude-que-no-existe');
  eq(desconocido.usd_total, null, 'un modelo sin precio NO inventa un costo');
  eq(desconocido.sin_precio, true, 'y lo dice');
  eq(desconocido.tokens.entrada, 1000, 'pero los tokens sí se reportan: eso sí lo sabemos');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Los finales que NO son un éxito');
{
  // El camino feliz, primero.
  {
    const { visto, f } = doble(RESPUESTA_OK);
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'ok', 'una respuesta completa sale ok');
    eq(r.secciones.length, 1, 'con sus secciones parseadas');
    eq(r.hash, hashNarracion(EV), 'y el hash con el que se guarda');
    eq(r.prompt_version, PROMPT_VERSION, 'más la versión del prompt que la produjo');
    ok(r.costo.usd_total > 0, 'y el costo de la corrida');
    eq(visto.headers['x-api-key'], 'k', 'la llave va en el header, no en la URL');
    eq(visto.headers['anthropic-version'], '2023-06-01', 'con la versión de la API');
    ok(visto.url.startsWith('https://api.anthropic.com/'), 'y pega a Anthropic por fetch crudo');
  }

  // EL PELIGROSO. El texto que llegó puede tener todas sus citas bien y
  // leerse como una narración completa: no hay nada adentro que diga "acá me
  // cortaron".
  {
    const cortada = {
      ...RESPUESTA_OK, stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"secciones":[{"id":"direccion","texto":"Nombró un CFO [acc-1]. Después' }],
    };
    const { f } = doble(cortada);
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'cortada', 'una narración cortada NO sale ok');
    ok(!r.secciones, 'y no se devuelve texto servible, aunque el que llegó se leyera bien');
    ok(/techo/.test(r.detalle), 'con el motivo registrado');
    ok(r.crudo, 'la respuesta cruda se guarda igual');
    ok(r.costo.usd_total > 0, 'y el costo también: se pagó lo mismo');
  }

  // El clasificador declinó.
  {
    const { f } = doble({ ...RESPUESTA_OK, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'frontier_llm' }, content: [] });
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'rechazo_modelo', 'un rechazo del modelo tiene su propio estado');
    eq(r.categoria, 'frontier_llm', 'con la categoría, que solo viene poblada en este caso');
    ok(r.crudo, 'y la cruda guardada');
  }

  // Salida que no parsea.
  {
    const { f } = doble({ ...RESPUESTA_OK, content: [{ type: 'text', text: 'Bueno, mirá, la empresa...' }] });
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'json_invalido', 'prosa donde iba JSON no se acepta');
    ok(r.crudo, 'y se guarda para poder ver qué dijo');
  }
  {
    const { f } = doble({ ...RESPUESTA_OK, content: [{ type: 'text', text: '{"secciones":[]}' }] });
    eq((await narrar(EV, { apiKey: 'k', fetchImpl: f })).estado, 'json_invalido', 'ni un JSON válido pero vacío');
  }

  // Otro modelo sirvió. El hash dice claude-opus-5; guardar el texto bajo ese
  // hash sería mentir sobre su procedencia.
  {
    const { f } = doble({ ...RESPUESTA_OK, model: 'claude-opus-4-8' });
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'modelo_distinto', 'si contestó otro modelo, no se guarda bajo este hash');
    eq(r.modelo_servido, 'claude-opus-4-8', 'y se dice cuál fue');
    ok(r.crudo, 'con la cruda guardada');
  }

  // HTTP y red.
  {
    const { f } = doble({ error: { message: 'overloaded' } }, 529);
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
    eq(r.estado, 'http', 'un error HTTP tiene su estado');
    eq(r.http, 529, 'con el código');
    ok(r.crudo, 'y el cuerpo del error guardado: ahí está el motivo');
  }
  {
    const r = await narrar(EV, { apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    eq(r.estado, 'red', 'una caída de red no se confunde con un rechazo');
    ok(/ECONNRESET/.test(r.detalle), 'con el detalle');
  }

  // Sin llave no se llama. Fail-closed: no hay una versión "chiquita" honesta
  // de narrar sin poder llamar.
  {
    let llamado = false;
    const r = await narrar(EV, { apiKey: '', fetchImpl: async () => { llamado = true; } });
    eq(r.estado, 'sin_llave', 'sin llave se dice, no se revienta');
    eq(llamado, false, 'y NO se llama a nadie');
    eq(r.costo, null, 'ni se inventa un costo');
  }

  // Ningún camino de falla pierde la cruda. Es la regla: si un guardia la
  // rechaza hay que poder ver qué dijo, no solo que la rechazó.
  {
    const casos = [
      { ...RESPUESTA_OK, stop_reason: 'max_tokens' },
      { ...RESPUESTA_OK, stop_reason: 'refusal' },
      { ...RESPUESTA_OK, content: [{ type: 'text', text: 'no json' }] },
      { ...RESPUESTA_OK, model: 'otro' },
    ];
    for (const c of casos) {
      const { f } = doble(c);
      const r = await narrar(EV, { apiKey: 'k', fetchImpl: f });
      ok(r.estado !== 'ok' && r.crudo, `la cruda sobrevive al camino "${r.estado}"`);
    }
    // Y hasta cuando la respuesta no es JSON en absoluto.
    const r = await narrar(EV, {
      apiKey: 'k',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }),
    });
    ok(r.crudo && r.crudo._sin_parsear, 'una respuesta que ni siquiera es JSON se guarda como texto');
  }
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
