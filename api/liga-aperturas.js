// ═══════════════════════════════════════════════════════════════
// /api/liga/aperturas — EL CONTEXTO DE CADA POSICIÓN ABIERTA.
//
// Por cada posición que un agente abrió: el precio y la hora de entrada, el
// enfoque del día, la tesis, el momentum (1d/5d/1m), el sector, las noticias
// del nombre en ese momento y lo que el mercado de opciones cobraba por que
// terminara arriba de la entrada.
//
// Para poder contestar después la pregunta que motiva todo esto: ¿en qué
// CONDICIONES le va bien a cada modelo? "Compró NVDA y ganó 4%" no distingue
// al que entra en rupturas con volumen del que entra en nombres castigados.
//
// Solo lectura. Query: ?dias=N (default 7) · ?agente=<id> · ?simbolo=<TICKER>
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { leerAperturas } from './_lib/arena-apertura.js';
import { ARENA_AGENTS } from './_lib/arena-registry.js';

const nombre = (id) => {
  const a = ARENA_AGENTS.find((x) => x.id === id);
  return a ? a.name : id;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const dias = Math.max(1, Math.min(365, parseInt(q.dias, 10) || 7));
  const agente = String(q.agente || '').trim().toLowerCase() || null;
  const simbolo = String(q.simbolo || q.ticker || '').trim().toUpperCase() || null;

  const { ok, filas, motivo } = await leerAperturas({ dias, agentId: agente, symbol: simbolo });

  const aperturas = (filas || []).map((f) => ({
    agente: { id: f.agent_id, nombre: nombre(f.agent_id) },
    symbol: f.symbol,
    abierta_en: f.abierta_en,
    run_date: f.run_date,
    entrada: { qty: f.qty != null ? Number(f.qty) : null, limite: f.limit_price != null ? Number(f.limit_price) : null, referencia: f.referencia != null ? Number(f.referencia) : null },
    peso: { objetivo: f.peso_objetivo != null ? Number(f.peso_objetivo) : null, desde: f.peso_desde != null ? Number(f.peso_desde) : null },
    enfoque: f.enfoque, tesis: f.tesis, contrato: f.contrato,
    sector: f.sector, momentum: f.momentum, opciones: f.opciones, noticias: f.noticias,
  }));

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    ventana: { dias },
    filtros: { agente, simbolo },
    n: aperturas.length,
    nota_opciones: 'La probabilidad implícita es RISK-NEUTRAL y del vencimiento MÁS CERCANO: es lo que el mercado COBRA por que cierre arriba de la entrada ese día, no lo que el mercado CREE. `metodo` dice si salió de la CDF del mercado (model-free) o de Black-Scholes con IV at-the-money.',
    nota_apertura: 'Sólo APERTURAS: un agregado a una posición viva es la misma tesis promediada, no una decisión nueva. `peso.desde` guarda el peso anterior para que se pueda filtrar.',
    aperturas,
    ...(ok ? {} : { aviso: 'No se pudieron leer las aperturas: ' + motivo }),
  });
}
