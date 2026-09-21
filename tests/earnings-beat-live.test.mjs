// ═══════════════════════════════════════════════════════════════
// Tests de la VISTA EN VIVO de earnings-beat. JS puro, sin red ni DB:
//   - estadisticasHistoricas: conteo, racha, sorpresa, últimos trimestres
//   - LINT de honestidad: el histórico NUNCA se pinta como probabilidad, y
//     QuantDesk no emite una propia hasta que la Fase 2 la valide
//
// El lint es lo importante. El riesgo real de esta pantalla no es un bug de
// render: es que alguien, con buena intención, convierta "superó 26 de 32
// (81%)" en "81% de probabilidad" — que es el mismo número diciendo algo que
// nadie validó. Un comentario pidiendo que no se haga se ignora; un test que
// falla, no.
// Correr con `node tests/earnings-beat-live.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { estadisticasHistoricas, CRITERIOS } from '../api/_lib/earnings-beat.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('estadisticasHistoricas: un CONTEO, no una probabilidad');

const q = (fecha, rep, est, sp) => ({ reported_date: fecha, reported_eps: rep, estimated_eps: est, surprise_pct: sp });
const base = estadisticasHistoricas([
  q('2026-06-25', 1.20, 1.10, 9.1), q('2026-03-25', 1.05, 1.00, 5.0),
  q('2025-12-20', 0.80, 0.90, -11.1), q('2025-09-20', 1.00, 0.95, 5.3),
]);
ok(base.total === 4 && base.beats === 3 && base.pct === 75, 'cuenta beats sobre trimestres comparables', `${base.beats}/${base.total}=${base.pct}%`);
ok(base.racha.tipo === 'beats' && base.racha.largo === 2, 'racha actual: tipo Y largo (un "2" solo no dice nada)', JSON.stringify(base.racha));
ok(base.sorpresa_promedio_pct === 2.08, 'sorpresa promedio %', base.sorpresa_promedio_pct);
ok(base.ultimos.length === 4 && base.ultimos[0].fecha === '2026-06-25', 'últimos trimestres, más reciente primero');
ok(base.ultimos[0].beat === true && base.ultimos[2].beat === false, 'cada trimestre marcado ✓/✗');

const empate = estadisticasHistoricas([q('2026-06-25', 1.00, 1.00, 0)]);
ok(empate.beats === 0, 'un empate NO es un beat (reportado > estimado, estricto)', empate.beats);
const frontera = estadisticasHistoricas([q('2026-06-25', 1.005, 1.00, 0.5)]);
ok(frontera.beats === 1 && frontera.frontera === 1,
  'un beat de menos de un centavo cuenta pero se marca frontera (ahí la definición depende del consenso)', frontera.frontera);
ok(CRITERIOS.frontera_eps === 0.01, 'y la frontera es la misma constante congelada del scope');

const incompletos = estadisticasHistoricas([
  q('2026-06-25', 1.2, null, null), q('2026-03-25', 1.1, 1.0, 10),
]);
ok(incompletos.total === 1, 'un trimestre sin estimado no puede decir si superó: no se cuenta', incompletos.total);
const vacio = estadisticasHistoricas([]);
ok(vacio.sin_datos === true && vacio.pct === null && typeof vacio.motivo === 'string',
  'sin datos → lo dice con motivo, no inventa un 0%');
ok(estadisticasHistoricas(null).total === 0, 'null → no crashea');
ok(estadisticasHistoricas([q('2026-06-25', 1.2, 1.1, 9)], { ultimos: 1 }).ultimos.length === 1, 'respeta el tope de trimestres');

console.log('LINT de honestidad sobre el código real');

const app = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api/earnings-beat.js', import.meta.url), 'utf8');

// La tarjeta se recorta del archivo real: lo que se testea es lo que se sirve.
const iCard = app.indexOf('function ebLiveCard(');
ok(iCard > 0, 'la tarjeta existe en app.html');
const card = app.slice(iCard, app.indexOf('\nfunction ebDiasHasta', iCard));

ok(card.includes("'Histórico: superó '"), 'la etiqueta es EXACTAMENTE "Histórico: superó N de M (P%)"');
ok(card.includes("'Track record: beat '"), 'y su par en inglés');
ok(card.includes("'Polymarket hoy: '") || card.includes("'Polymarket hoy: '+"), 'la etiqueta del mercado es "Polymarket hoy: N%"');
ok(/fuente/.test(card) && /source/.test(card), 'la fuente se cita en las dos lenguas');

// LA REGLA: el histórico no se pinta como probabilidad. Se prohíben las formas
// que lo dirían, no una cadena puntual — para que renombrar no la esquive.
// La NEGACIÓN de un pronóstico ("no es predicción" / "is not a forecast") es
// justamente lo que queremos que esté. Se aparta antes de buscar afirmaciones,
// y se comprueba por separado que siga ahí — si no, el lint se volvería
// trivial de pasar borrando el aviso.
const lineasAviso = card.split('\n').filter((l) => /no es predicci|not a forecast/i.test(l));
ok(lineasAviso.length > 0, 'la tarjeta lleva su propia nota "no es predicción" (sobrevive a un recorte de pantalla)');
const cardSinAvisos = card.split('\n').filter((l) => !/no es predicci|not a forecast/i.test(l)).join('\n');

const PROHIBIDO = [
  { nombre: 'probabilidad del histórico', re: /probabilidad[^']{0,20}'\s*\+\s*h\./i },
  { nombre: 'probability del histórico', re: /probability[^']{0,20}'\s*\+\s*h\./i },
  { nombre: 'chance/odds del histórico', re: /(chance|odds)[^']{0,20}'\s*\+\s*h\./i },
  { nombre: 'el número presentado como pronóstico', re: /(predice|pronóstico|forecast|expected probability|probabilidad de que)/i },
];
for (const p of PROHIBIDO) {
  ok(!p.re.test(cardSinAvisos), `la tarjeta NO dice ${p.nombre}`, p.re.exec(cardSinAvisos) && p.re.exec(cardSinAvisos)[0]);
}
ok(!/probabilidad_quantdesk\s*\|\||probabilidad_quantdesk\s*\?/.test(card),
  'la tarjeta no intenta pintar una probabilidad de QuantDesk (todavía no existe)');

// El disclaimer bilingüe, obligatorio y con las dos lenguas.
const iDisc = app.indexOf('function ebLiveDisclaimer(');
const disc = app.slice(iDisc, app.indexOf('\nfunction ebLiveAviso', iDisc));
ok(/no una predicción/.test(disc) && /not a forecast/.test(disc), 'el disclaimer va en español Y en inglés');
ok(/en validación/.test(disc) && /being validated/.test(disc), 'y dice que QuantDesk está en validación, en las dos');
ok(/const primero=smL\(es,en\), segundo=smL\(en,es\)/.test(disc), 'se pintan las DOS lenguas, no solo la activa');

// El endpoint: la ausencia de probabilidad propia es explícita, no un olvido.
ok(/probabilidad_quantdesk: null/.test(api), 'el endpoint devuelve probabilidad_quantdesk: null, explícito');
ok(/probabilidad_quantdesk_estado/.test(api), 'con su estado escrito al lado');
ok(!/probabilidad_quantdesk:\s*(?!null)[a-z0-9_.]/i.test(api), 'y NADIE le asignó un número');

// El estado vacío no puede ser un error disfrazado (ni al revés).
ok(/d && d\.error/.test(app.slice(app.indexOf('function renderEbLive('), app.indexOf('function ebLiveCard('))),
  'un error se pinta como error, no como "no hay mercados"');
ok(/vacio\.motivo/.test(app), 'el estado vacío muestra el MOTIVO que dio el endpoint');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
