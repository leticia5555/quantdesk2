// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-narrador.js — la llamada. Fase B, rebanada H.
//
// `fetch` crudo a /v1/messages, como `ai-guard.js` y `arena-model.js`. El
// repo no tiene package.json a propósito y meter node_modules por un módulo
// no vale el cambio.
//
// ── NO PASA POR guardedClaudeCall ───────────────────────────────────
// Se reusan las piezas exportadas (`dateDirective`), igual que hizo el
// Arena, pero no el envoltorio: `guardedClaudeCall` reintenta una vez ante
// fechas prospectivas y devuelve `stale` — un contrato pensado para un
// análisis de mercado. Acá el contrato es otro: una narración con una cita
// rota o cortada a la mitad no se reintenta a ciegas, se descarta y se dice.
//
// ── DÓNDE VA EL CORTE DEL CACHÉ, Y POR QUÉ AHÍ ──────────────────────
// El caché de Anthropic es por PREFIJO y el orden de render es
// tools → system → messages. El prompt congelado (~1.400 tokens, arriba del
// mínimo de 512 de Opus 5) va como primer bloque de `system` con el
// `cache_control`; todo lo volátil va DESPUÉS:
//
//   · la directiva de fecha, que cambia todos los días — si fuera parte del
//     prefijo, el caché se invalidaría cada medianoche;
//   · la evidencia, que cambia por empresa.
//
// Un byte que cambie antes del corte tira todo lo que sigue, así que el
// prompt es una constante y no una plantilla con el ticker adentro.
//
// ── LOS TRES FINALES QUE NO SON UN ÉXITO ────────────────────────────
//   · `refusal`    — el clasificador declinó. Se descarta y se registra.
//   · `max_tokens` — **el peligroso**. Una narración cortada a la mitad, con
//                    las citas correctas hasta donde llegó, se lee como
//                    completa: no hay nada en el texto que diga "acá me
//                    cortaron". Se descarta, se registra el motivo, y NO se
//                    guarda como narración servible.
//   · JSON inválido — el modelo devolvió algo que no parsea contra el
//                    esquema. Mismo trato.
//
// En los tres casos **la respuesta cruda se guarda igual**. Si un guardia la
// rechaza hay que poder ver qué dijo, no solamente que la rechazó.
// ═══════════════════════════════════════════════════════════════

import { dateDirective } from './ai-guard.js';
import { ANTHROPIC_PRICES } from './model.js';
import { PROMPT, PROMPT_VERSION, MODELO, HUELLA_PROMPT, identidadPrompt } from './historia-prompt.js';
import { canonico, hashDe } from './historia-evidencia.js';

const URL_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
// No es una fecha: es el identificador de versión de la API de Anthropic, un
// literal fijo del protocolo.
const VERSION_API = /* date-lint-ok: versión del protocolo de Anthropic, no una referencia a "hoy" */ '2023-06-01';

// No se baja: una narración cortada es el modo de falla que este módulo más
// tiene que evitar, y ahorrar tokens de techo no ahorra ni un centavo — solo
// se paga lo que se genera.
export const MAX_TOKENS = 16000;

// Los precios salen de _lib/model.js, que es la tabla única del repo. No se
// duplica acá: dos tablas de precios son dos tablas que con el tiempo dicen
// cosas distintas, y la que miente es siempre la que nadie mira.

export const ESQUEMA_SALIDA = {
  type: 'object',
  additionalProperties: false,
  required: ['secciones'],
  properties: {
    secciones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'texto'],
        properties: {
          id: { type: 'string', enum: ['direccion', 'propiedad', 'prometido_vs_entregado', 'catalizador', 'donde_se_rompe'] },
          texto: { type: 'string' },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// El hash con el que se guarda una narración
// ─────────────────────────────────────────────────────────────────────────
//
// Cubre la evidencia, la VERSIÓN DEL PROMPT y el MODELO. Con solo la
// evidencia, cambiar una línea del prompt dejaba pasar todas las narraciones
// guardadas —el hash no se movía— y quedaban sirviéndose textos del prompt
// viejo sin que nada lo dijera.
//
// La directiva de fecha NO entra, a propósito: se inyecta en cada llamada
// para que el modelo no ancle al presente de su entrenamiento, pero si
// entrara al hash se re-narraría todo cada medianoche. Lo que la sostiene es
// que la narración tiene prohibido el lenguaje relativo a hoy.
export const hashNarracion = (evidencia) => hashDe({
  evidencia,
  prompt_version: PROMPT_VERSION,
  modelo: MODELO,
});

// ─────────────────────────────────────────────────────────────────────────
// El cuerpo del request
// ─────────────────────────────────────────────────────────────────────────
export function armarRequest(evidencia, { ahora = new Date() } = {}) {
  return {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    // Adaptativo: es el modo de Opus 5 y `budget_tokens` devuelve 400.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      // El esquema evita tener que parsear prosa buscando secciones. Lo que
      // NO evita es que el texto adentro tenga una cita inventada: eso es el
      // guardia de la rebanada I.
      format: { type: 'json_schema', schema: ESQUEMA_SALIDA },
    },
    system: [
      // EL PREFIJO ESTABLE. El corte del caché va acá y no más adelante.
      { type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } },
      // Después del corte: cambia todos los días y no debe entrar al prefijo.
      { type: 'text', text: dateDirective(ahora) },
    ],
    messages: [{
      role: 'user',
      content: `Acá está la evidencia de esta empresa. Es todo lo que hay: no existe ningún otro documento.\n\n${canonico(evidencia)}`,
    }],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// El costo de una corrida, desglosado
// ─────────────────────────────────────────────────────────────────────────
//
// El desglose no es decorativo: sin separar la lectura de caché de la
// entrada fresca no hay manera de saber si el prefijo está pegando. Si
// `cache_lectura` sale en cero corrida tras corrida, algo está invalidando el
// prefijo y se está pagando 10× de más sin que nada falle.
export function costoDe(usage = {}, modelo = MODELO) {
  const p = ANTHROPIC_PRICES[modelo];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tokens = {
    entrada: n(usage.input_tokens),
    salida: n(usage.output_tokens),
    cache_escritura: n(usage.cache_creation_input_tokens),
    cache_lectura: n(usage.cache_read_input_tokens),
  };
  // La doctrina de la tabla: un modelo ausente devuelve costo null, jamás un
  // precio supuesto. Un número inventado en una factura es peor que no tener
  // número, porque nadie lo revisa.
  if (!p) return { modelo, tokens, usd: null, usd_total: null, cache_pego_pct: null, sin_precio: true };
  const tok = tokens;
  const usd = (t, precio) => (Number.isFinite(precio) ? (t / 1e6) * precio : 0);
  const partes = {
    entrada: usd(tok.entrada, p.in),
    salida: usd(tok.salida, p.out),
    cache_escritura: usd(tok.cache_escritura, p.cache_write),
    cache_lectura: usd(tok.cache_lectura, p.cache_read),
  };
  const total = partes.entrada + partes.salida + partes.cache_escritura + partes.cache_lectura;
  // Cuánto del prefijo pegó. Con el prompt congelado de ~1.400 tokens, la
  // segunda corrida en adelante debería leer caché en vez de entrada fresca.
  const cacheables = tok.cache_lectura + tok.cache_escritura;
  return {
    modelo,
    tokens: tok,
    usd: partes,
    // Redondeado a seis decimales: a estos precios, un centésimo de centavo
    // por corrida es una cifra real cuando se multiplica por cuatro mil.
    usd_total: Math.round(total * 1e6) / 1e6,
    cache_pego_pct: cacheables ? Math.round((tok.cache_lectura / cacheables) * 1000) / 10 : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// La llamada
// ─────────────────────────────────────────────────────────────────────────
//
// `fetch` entra por parámetro, como en toda la fase: este contenedor no tiene
// llave de Anthropic y todo se prueba con un doble.
export async function narrar(evidencia, {
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = globalThis.fetch,
  ahora = new Date(),
  timeoutMs = 120000,
} = {}) {
  const base = {
    ...identidadPrompt(),
    hash: hashNarracion(evidencia),
  };

  if (!apiKey) {
    return { ...base, estado: 'sin_llave', detalle: 'falta ANTHROPIC_API_KEY', crudo: null, costo: null };
  }

  const cuerpo = armarRequest(evidencia, { ahora });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);

  let r; let texto;
  try {
    r = await fetchImpl(URL_ANTHROPIC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': VERSION_API,
      },
      body: JSON.stringify(cuerpo),
      signal: ctl.signal,
    });
    texto = await r.text();
  } catch (e) {
    clearTimeout(t);
    return { ...base, estado: 'red', detalle: String((e && e.message) || e), crudo: null, costo: null };
  }
  clearTimeout(t);

  let crudo = null;
  try { crudo = JSON.parse(texto); } catch { crudo = { _sin_parsear: texto.slice(0, 4000) }; }

  // LA RESPUESTA CRUDA SE GUARDA SIEMPRE, incluso en los caminos de falla.
  // Si un guardia rechaza la narración hay que poder ver qué dijo el modelo,
  // no solamente que fue rechazada.
  const conCrudo = (extra) => ({ ...base, crudo, ...extra });

  if (!r.ok) {
    return conCrudo({
      estado: 'http',
      http: r.status,
      detalle: (crudo && crudo.error && crudo.error.message) || `HTTP ${r.status}`,
      costo: null,
    });
  }

  const costo = costoDe(crudo.usage || {}, crudo.model || MODELO);

  // El modelo que SIRVIÓ puede no ser el configurado. El hash lleva el
  // modelo adentro; si contestó otro, guardar el texto bajo ese hash sería
  // mentir sobre su procedencia. Se conserva crudo y se marca.
  if (crudo.model && crudo.model !== MODELO) {
    return conCrudo({ estado: 'modelo_distinto', modelo_servido: crudo.model, costo });
  }

  // `refusal`: el clasificador declinó. `stop_details` solo viene poblado en
  // este caso, así que se lee con guarda.
  if (crudo.stop_reason === 'refusal') {
    return conCrudo({
      estado: 'rechazo_modelo',
      categoria: (crudo.stop_details && crudo.stop_details.category) || null,
      costo,
    });
  }

  // `max_tokens`: EL PELIGROSO. El texto que llegó puede tener todas sus
  // citas bien y leerse como una narración completa. No hay nada adentro que
  // diga "acá me cortaron", así que la única defensa es esta.
  if (crudo.stop_reason === 'max_tokens') {
    return conCrudo({ estado: 'cortada', detalle: `el modelo llegó al techo de ${MAX_TOKENS} tokens`, costo });
  }

  const bloques = Array.isArray(crudo.content) ? crudo.content : [];
  const salida = bloques.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let datos = null;
  try { datos = JSON.parse(salida); } catch {
    return conCrudo({ estado: 'json_invalido', detalle: 'la salida no parsea como JSON', costo });
  }

  const secciones = Array.isArray(datos && datos.secciones) ? datos.secciones : null;
  if (!secciones || !secciones.length) {
    return conCrudo({ estado: 'json_invalido', detalle: 'la salida no trae secciones', costo });
  }

  return conCrudo({ estado: 'ok', secciones, costo });
}

export { PROMPT_VERSION, MODELO, HUELLA_PROMPT };
