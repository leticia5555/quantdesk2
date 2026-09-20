// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-evidencia.js — la aritmética, antes del prompt.
//
// Lo que se prueba acá decide si la Fase B puede sostener su promesa:
//
//   1. **Nada que haya que restar o dividir llega al prompt.** El YoY viene
//      de la vista, y cuando NO es comparable viaja el MOTIVO — un null
//      pelado invita a que el modelo haga su propia resta con el trimestre
//      que tenga a mano, que es exactamente el bug que ai-guard documentó.
//   2. **Una razón lleva las citas de los DOS hechos** que entraron a la
//      división, y no se calcula si los periodos no coinciden exacto.
//   3. **Una racha de 34 filings entra contada, no listada** — con dos anclas
//      citables. Contar es justamente lo que no se delega.
//   4. **La distancia al papel anterior se mide en la línea COMPLETA.** Si
//      entre dos eventos se colapsaron treinta, decir "45 días desde el
//      anterior" sería cierto sobre el paquete y falso sobre la empresa.
//   5. **El inventario se construye RECORRIENDO el paquete**, no en paralelo.
//      Es la lista cerrada sobre la que descansa el guard de citas, y una
//      segunda lista escrita a mano se separaría en el primer cambio.
//   6. **Nada relativo a HOY.** La narración se guarda con el hash de su
//      evidencia: si dijera "hace 3 días", o el hash cambia todos los días o
//      la narración cacheada miente. Fechas absolutas y distancias entre
//      eventos, que son estables.
//   7. **El hash depende del contenido, no del orden de los campos.**
//
// Correr con `node tests/historia-evidencia.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  VERSION_EVIDENCIA, LIMITE_EVENTOS, MIN_EPISODIO_COLAPSA, RAZONES, MOTIVO_SIN_YOY, TECHO_BYTES,
  diasEntre, razonesDe, serieParaPrompt, eventosParaPrompt,
  armarEvidencia, accessionsDe, inventarioDe, canonico, hashDe, hashEvidencia, respuestaEvidencia,
  podarSinCita,
} from '../api/_lib/historia-evidencia.js';
import { armarHistoria, armarEvento } from '../api/_lib/historia-lectura.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const EMISOR = { cik: '0001099590', ticker: 'MELI', nombre: 'MERCADOLIBRE INC', forma_anual: '10-K', cobertura: 'completa', ultima_ingesta: '2026-09-20T00:00:00Z' };

const fila = (accession, form, items = '', filed = '2026-02-20') => ({
  accession, form, items_raw: items, filed, report_date: null,
  url: `https://www.sec.gov/Archives/${accession}.htm`,
  index_url: `https://www.sec.gov/Archives/${accession}/`,
});
const ev = (...a) => armarEvento(fila(...a));

const punto = (familia, period_end, val, extra = {}) => ({
  familia, period_start: extra.period_start ?? null, period_end, val, unit: 'USD',
  yoy_pct: extra.yoy_pct ?? null, revisado: !!extra.revisado, derived: !!extra.derived,
  accession: extra.accession || 'acc-10q', accession_aux: extra.accession_aux || null,
  filed: extra.filed || '2026-02-20', form: extra.form || '10-Q',
  url: `https://www.sec.gov/Archives/${extra.accession || 'acc-10q'}.htm`,
  url_aux: extra.accession_aux ? `https://www.sec.gov/Archives/${extra.accession_aux}.htm` : null,
  cita: `[${extra.accession || 'acc-10q'}]`,
  cita_aux: extra.accession_aux ? `[${extra.accession_aux}]` : null,
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Contar días es aritmética, y se hace acá');
{
  eq(diasEntre('2026-01-01', '2026-01-10'), 9, 'cuenta los días entre dos fechas');
  eq(diasEntre('2026-01-10', '2026-01-01'), -9, 'y el signo dice hacia dónde');
  eq(diasEntre('2026-01-01', '2026-01-01'), 0, 'el mismo día es cero');
  // Un 0 por fecha rota se leería como "el mismo día", que es un hecho falso.
  eq(diasEntre(null, '2026-01-01'), null, 'una fecha que no parsea devuelve null, nunca 0');
  eq(diasEntre('no-es-fecha', '2026-01-01'), null, 'ni con basura');
  eq(diasEntre('2026-01-01T23:59:00Z', '2026-01-02'), 1, 'la hora no corre el día: todo en UTC');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El YoY llega resuelto, y cuando no se puede llega el motivo');
{
  const s = serieParaPrompt([
    punto('ingresos', '2025-12-31', 6100000000, { yoy_pct: 12.34567 }),
    punto('ingresos', '2025-09-30', 5200000000, { yoy_pct: null }),
  ]);

  eq(s[0].yoy_pct, 12.3, 'el YoY se redondea: 12.34567 se ve calculado a mano e invita a "limpiarlo"');
  ok(!('yoy_motivo' in s[0]), 'cuando hay YoY no viaja ningún motivo');

  // EL PUNTO. El campo del YoY no existe cuando no se puede calcular, y en su
  // lugar está el motivo. Un `yoy_pct: null` dejaría el hueco para que el
  // modelo lo llene con su propia resta contra el trimestre que tenga a mano.
  ok(!('yoy_pct' in s[1]), 'sin trimestre comparable no hay campo de YoY que llenar');
  eq(s[1].yoy_motivo, MOTIVO_SIN_YOY, 'y viaja el MOTIVO en su lugar');
  ok(/sin trimestre comparable/.test(s[1].yoy_motivo), 'que dice por qué, no solo que falta');

  hondo(s[0].citas, ['acc-10q'], 'cada punto lleva su cita');
  const der = serieParaPrompt([punto('ingresos', '2025-12-31', 300, { derived: true, accession: 'acc-10k', accession_aux: 'acc-10q' })]);
  hondo(der[0].citas, ['acc-10k', 'acc-10q'], 'un Q4 derivado lleva las DOS: salió de una resta entre dos filings');
  eq(der[0].derivado, true, 'y se marca como derivado');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las razones: el modelo no divide');
{
  const serie = [
    punto('ingresos', '2025-12-31', 1000, { period_start: '2025-10-01', accession: 'a1' }),
    punto('margen', '2025-12-31', 420, { period_start: '2025-10-01', accession: 'a1' }),
    punto('neto', '2025-12-31', 95, { period_start: '2025-10-01', accession: 'a1' }),
  ];
  const r = razonesDe(serie);
  const bruto = r.find((x) => x.id === 'margen_bruto_pct');
  const neto = r.find((x) => x.id === 'margen_neto_pct');

  eq(bruto.valor_pct, 42, 'el margen bruto en porcentaje, ya dividido');
  eq(neto.valor_pct, 9.5, 'y el neto');
  ok(/÷/.test(bruto.formula), 'con la fórmula a la vista: el modelo cita, no recalcula');
  hondo(bruto.citas, ['a1'], 'con las citas de los dos hechos que entraron');

  // Periodos que no coinciden: NO se divide. Un margen de un trimestre sobre
  // los ingresos de otro es un número redondo y falso.
  const cruzado = razonesDe([
    punto('ingresos', '2025-12-31', 1000, { period_start: '2025-10-01' }),
    punto('margen', '2025-09-30', 420, { period_start: '2025-07-01' }),
  ]);
  eq(cruzado.length, 0, 'periodos distintos no se dividen entre sí');

  // Misma fecha de fin pero distinto inicio: un trimestre contra un acumulado
  // de nueve meses. Se ve parecido y es otro número.
  const distintoInicio = razonesDe([
    punto('ingresos', '2025-12-31', 3000, { period_start: '2025-04-01' }),
    punto('margen', '2025-12-31', 420, { period_start: '2025-10-01' }),
  ]);
  eq(distintoInicio.length, 0, 'mismo fin y distinto inicio tampoco: trimestre contra acumulado no es un margen');

  eq(razonesDe([punto('ingresos', '2025-12-31', 0, { period_start: '2025-10-01' }),
    punto('margen', '2025-12-31', 5, { period_start: '2025-10-01' })]).length, 0,
  'no se divide entre cero');
  eq(razonesDe([punto('ingresos', '2025-12-31', null, { period_start: '2025-10-01' }),
    punto('margen', '2025-12-31', 5, { period_start: '2025-10-01' })]).length, 0,
  'ni con un valor ausente, que Number() convertiría en 0');

  // Una razón hecha con un Q4 derivado arrastra las cuatro citas y se marca.
  const conDerivado = razonesDe([
    punto('ingresos', '2025-12-31', 1000, { period_start: '2025-01-01', derived: true, accession: 'fy', accession_aux: 'q3' }),
    punto('margen', '2025-12-31', 400, { period_start: '2025-01-01', accession: 'fy' }),
  ]);
  eq(conDerivado[0].derivado, true, 'si un insumo es derivado, la razón también');
  hondo(conDerivado[0].citas, ['fy', 'q3'], 'y lleva las citas de todo lo que entró, sin repetir');

  ok(RAZONES.every((x) => x.num && x.den && x.formula), 'toda razón declara numerador, denominador y fórmula');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Una racha de 34 filings entra contada, no listada');
{
  const campania = [];
  for (let i = 0; i < 34; i++) {
    const d = new Date(Date.UTC(2025, 11, 15 + i * 4)).toISOString().slice(0, 10);
    campania.push(ev(`camp-${String(i).padStart(2, '0')}`, 'DFAN14A', '', d));
  }
  const orden = [...campania].sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
  const episodio = {
    desde: campania[0].filed, hasta: campania[33].filed, dias: 132, total: 34,
    por_forma: { DFAN14A: 34 }, umbral_dias: 120, documentos: campania,
  };
  const cierre = ev('acc-507', '8-K', '5.07', '2026-06-10');
  const linea = [cierre, ...orden];

  const r = eventosParaPrompt(linea, [episodio]);
  eq(r.episodios.length, 1, 'la racha entra como UN episodio');
  const e0 = r.episodios[0] || {};
  eq(e0.total, 34, 'con su conteo ya hecho');
  eq(e0.umbral_dias, 120, 'y con el umbral, que es NUESTRO y tiene que poder declararse');
  eq(r.colapsados, 32, '32 renglones se ahorran');
  eq(r.eventos.length, 3, 'quedan el cierre y las dos anclas del episodio');

  // Las anclas existen para que el episodio sea citable: un conteo sin un
  // documento que abrir es una afirmación sin respaldo.
  hondo(e0.citas, ['camp-00', 'camp-33'], 'el episodio cita su primer y su último filing');
  const enPaquete = new Set(r.eventos.map((e) => e.accession));
  ok((e0.citas || []).length > 0 && e0.citas.every((c) => enPaquete.has(c)),
    'y las dos anclas están en el paquete, abribles');

  // El episodio cuenta y fecha. No dice quién ganó, y no se puede deducir.
  ok(!/(gan|perdi|triunf|derrot|won|lost)/i.test(JSON.stringify(e0)),
    'el episodio no trae vocabulario de desenlace');

  // Bajo el umbral, los filings entran enteros: tres documentos se leen.
  const cortito = eventosParaPrompt(orden.slice(0, 3), [{ ...episodio, total: 3, documentos: campania.slice(0, 3) }]);
  eq(cortito.episodios.length, 0, `menos de ${MIN_EPISODIO_COLAPSA} no se colapsa`);
  eq(cortito.eventos.length, 3, 'y los tres entran enteros');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La distancia se mide en la línea COMPLETA');
{
  const a = ev('e-1', '8-K', '5.02', '2026-01-01');
  const b = ev('e-2', 'DFAN14A', '', '2026-02-01');
  const c = ev('e-3', 'DFAN14A', '', '2026-02-05');
  const d = ev('e-4', 'DFAN14A', '', '2026-02-09');
  const e = ev('e-5', 'DFAN14A', '', '2026-02-13');
  const f = ev('e-6', '8-K', '5.07', '2026-03-01');
  const linea = [f, e, d, c, b, a];                       // más nuevo primero
  const episodio = { desde: '2026-02-01', hasta: '2026-02-13', dias: 12, total: 4,
    por_forma: { DFAN14A: 4 }, umbral_dias: 120, documentos: [b, c, d, e] };

  const r = eventosParaPrompt(linea, [episodio]);
  const porAcc = Object.fromEntries(r.eventos.map((x) => [x.accession, x]));

  eq(r.eventos.length, 4, 'entran el 5.07, las dos anclas y el 5.02');
  eq(porAcc['e-2'].anterior.accession, 'e-1', 'el anterior sale de la línea completa');
  eq(porAcc['e-2'].anterior.dias, 31, 'con los días ya contados');

  // EL CASO QUE IMPORTA, y que hay que buscar adentro del episodio: el ancla
  // nueva (e-5, 02-13). En el paquete su vecino es la otra ancla (e-2,
  // 02-01, 12 días); en la línea real es e-4 (02-09, 4 días), que se
  // colapsó. Decir 12 sería cierto sobre el paquete y falso sobre la
  // empresa — y el papel citado ni siquiera sería el de al lado.
  eq(porAcc['e-5'].anterior.accession, 'e-4', 'el vecino es el papel REAL, no el que sobrevivió al recorte');
  eq(porAcc['e-5'].anterior.dias, 4, 'y los días son los reales: 4, no los 12 del paquete recortado');

  // Y el vecino colapsado sigue siendo citable: está en el paquete como
  // accession, así que entra al inventario y el lector lo puede abrir.
  ok([...accessionsDe(r)].includes('e-4'),
    'el papel colapsado que se nombra como vecino queda igual en lo citable');

  // El más viejo no tiene vecino, y el campo no existe. Un 0 se leería como
  // "el mismo día"; un null, como "hay uno y no lo sé".
  ok(!('anterior' in porAcc['e-1']), 'el primer papel de la ventana no inventa un vecino');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El paquete completo, armado del cuerpo real del endpoint');

const lecturaFalsa = (filas, serie) => ({
  emisorPorTicker: async () => EMISOR,
  eventos: async () => ({ filas, total: filas.length }),
  serie: async () => serie,
});

const FILAS = [
  fila('acc-507', '8-K', '5.07,9.01', '2026-06-10'),
  fila('acc-402', '8-K', '4.02', '2026-03-01'),
  fila('acc-502', '8-K', '5.02,2.02,1.01,9.01', '2026-02-20'),
  fila('acc-13d', 'SC 13D', '', '2025-11-04'),
];
const SERIE = [
  punto('ingresos', '2025-12-31', 1000, { period_start: '2025-10-01', yoy_pct: 12.3, accession: 'acc-10k' }),
  punto('ingresos', '2025-09-30', 900, { period_start: '2025-07-01', yoy_pct: null, revisado: true, accession: 'acc-10q' }),
  punto('margen', '2025-12-31', 420, { period_start: '2025-10-01', yoy_pct: 3.1, accession: 'acc-10k' }),
];

const { cuerpo } = await armarHistoria(lecturaFalsa(FILAS, SERIE), 'MELI', {});
const P = armarEvidencia(cuerpo);

{
  eq(P.version, VERSION_EVIDENCIA, 'el paquete se versiona: un cambio de forma tiene que poder verse');
  eq(P.narrable, true, 'con ingesta, es narrable');
  eq(P.emisor.ticker, 'MELI', 'con su emisor');
  eq(P.linea.eventos.length, 4, 'los cuatro eventos');
  eq(P.serie.length, 3, 'la serie entera');
  eq(P.razones.length, 1, 'y la razón que se puede calcular');
  eq(P.razones[0].valor_pct, 42, 'el margen bruto, ya dividido');

  // El perímetro viaja DENTRO del paquete. Sin él, el "sin documentos" de la
  // pregunta 4 se le lee al modelo como un hecho sobre la empresa.
  eq(P.preguntas.length, 7, 'las siete preguntas con su estado');
  const p4 = P.preguntas.find((x) => x.pregunta === 4);
  eq(p4.estado, 'no_cubierta', 'la 4 llega marcada como NO cubierta, no como vacía');
  ok(p4.declaraciones.some((t) => /licencia comercial/.test(t)), 'y con el texto que dice por qué');
  ok(P.no_cubierto.length >= 5, 'más el perímetro global');

  // La contraevidencia y su aritmética.
  eq(P.contraevidencia.estado, 'con_documentos', 'el 4.02 y la re-expresión rompen la historia');
  const rx = P.contraevidencia.periodos_reexpresados[0];
  eq(rx.period_end, '2025-09-30', 'el periodo re-expresado');
  eq(rx.dias_hasta_la_correccion, diasEntre('2025-09-30', '2026-02-20'),
    'con cuánto tardó la corrección, ya contado');

  // Un emisor sin ingerir no se narra "en chiquito": no se narra.
  const vacio = armarEvidencia({ ticker: 'X', estado: 'sin_ingesta' });
  eq(vacio.narrable, false, 'sin ingesta no hay evidencia y no se inventa una');
  eq(vacio.estado, 'sin_ingesta', 'y el estado viaja para que el caller corte');
  eq(armarEvidencia(null).narrable, false, 'ni con un cuerpo nulo');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Nada relativo a HOY');
{
  const txt = JSON.stringify(P);
  // Si el paquete dijera "hace 3 días", o el hash cambia todos los días —y
  // se re-narra la empresa entera por abrir la página— o la narración
  // cacheada dice "hace 3 días" cuando ya pasaron cuarenta.
  ok(!/hace_dias|dias_desde_hoy|"hoy"|antiguedad|reciente/i.test(txt),
    'el paquete no trae nada anclado al día de hoy', txt.slice(0, 120));

  // Dos armados del mismo cuerpo en días distintos dan el mismo hash. Se
  // prueba con el hash, que es lo que decide si se vuelve a llamar al modelo.
  const otra = armarEvidencia(cuerpo);
  eq(hashEvidencia(otra), hashEvidencia(P), 'armar dos veces el mismo cuerpo da el mismo hash');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El paquete no opina: es la ENTRADA, y entra limpia');
{
  // El guard anti-opinión de la rebanada I mira la SALIDA. Pero si la
  // entrada ya trae una calificación, el guard tendría que distinguir lo que
  // el modelo inventó de lo que nosotros le dimos — y esa distinción no se
  // puede hacer desde el texto. Más barato: que no entre.
  const txt = JSON.stringify(P).toLowerCase();
  const prohibidas = ['comprar', 'vender', 'recomend', 'precio objetivo', 'sobrevalorad',
    'infravalorad', 'oportunidad', 'riesgo alto', 'buy', 'sell', 'overweight', 'underweight'];
  const halladas = prohibidas.filter((w) => txt.includes(w));
  hondo(halladas, [], 'cero vocabulario de recomendación o calificación en la evidencia');

  ok(!/"veredicto"|"score"|"puntaje"|"calificacion"|"rating"|"senial"|"signal"/.test(txt),
    'y ningún campo de veredicto: el paquete son hechos con su cita, nada más');

  // Tampoco precio. HISTORIA no mira el mercado (§8, pregunta 6) y darle
  // precio al modelo es pedirle que lo relacione con lo demás.
  ok(!/"precio"|"price"|"cotizacion"|"market_cap"/.test(txt),
    'ni precio: lo que el mercado ya cree vive en otro panel y no entra al prompt');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El inventario: la lista cerrada de lo citable');
{
  const { inventario, huerfanos } = inventarioDe(P, cuerpo);

  hondo(huerfanos, [], 'todo accession del paquete tiene su metadata: cero huérfanos');
  ok(inventario.length >= 5, `el inventario tiene los filings y los de la serie (${inventario.length})`);
  ok(inventario.every((x) => x.accession && x.url), 'y cada entrada trae una URL abrible: una cita que no abre no es cita');

  const ids = inventario.map((x) => x.accession);
  for (const a of ['acc-507', 'acc-402', 'acc-502', 'acc-13d', 'acc-10k', 'acc-10q']) {
    ok(ids.includes(a), `el inventario incluye ${a}`);
  }
  hondo(ids, [...ids].sort(), 'y va ordenado: el mismo paquete da el mismo inventario');

  // Se construye RECORRIENDO el paquete. Una lista escrita en paralelo se
  // separaría en el primer cambio, y nadie lo notaría hasta que una cita
  // válida quedara rechazada — o peor, una inválida aceptada.
  const conExtra = { ...P, linea: { ...P.linea, eventos: [...P.linea.eventos, { accession: 'acc-fantasma' }] } };
  const r2 = inventarioDe(conExtra, cuerpo);
  hondo(r2.huerfanos, ['acc-fantasma'],
    'un accession sin metadata sale por huérfanos: el caller lo ve, no pasa en silencio');
  ok(!r2.inventario.some((x) => x.accession === 'acc-fantasma'),
    'y NO entra al inventario: lo citable es lo que se puede abrir');

  // El recorrido agarra las citas donde estén, incluidas las anidadas.
  const enc = accessionsDe({ a: { citas: ['x-1'] }, b: [{ accession_aux: 'x-2' }], c: { d: { accessions: ['x-3'] } } });
  hondo([...enc].sort(), ['x-1', 'x-2', 'x-3'], 'encuentra citas anidadas a cualquier profundidad');
  hondo([...accessionsDe({ nota: 'acc-999 va en un texto' })], [],
    'y NO recoge un accession suelto en prosa: solo los campos que SON citas');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Lo que no se puede citar, NO entra (se decide antes de la llamada)');
{
  // Un hecho sin accession válido no tiene contra qué verificarse en el
  // guard. La alternativa —dejarlo entrar marcado "no citable"— le pide al
  // prompt una segunda regla en un módulo cuya promesa entera es que toda
  // afirmación lleva su accession. Un hecho sin cita ahí no vale menos: no
  // vale.
  const sucio = {
    ...P,
    linea: {
      ...P.linea,
      eventos: [
        { fecha: '2026-08-01', form: '8-K', items: ['5.02'], preguntas: [1], accession: 'fantasma' },
        { fecha: '2026-07-01', form: '8-K', items: ['2.02'], preguntas: [3], accession: 'acc-502',
          anterior: { accession: 'fantasma', fecha: '2026-06-01', dias: 30 } },
        ...P.linea.eventos,
      ],
    },
    serie: [{ familia: 'ingresos', period_end: '2024-12-31', valor: 1, unidad: 'USD', citas: ['fantasma'] }, ...P.serie],
  };

  const { paquete: limpio, excluidos } = podarSinCita(sucio, ['fantasma']);

  // Lo que importa no es que la cadena desaparezca del JSON —el descargo la
  // nombra, y debe nombrarla— sino que deje de ser una CITA.
  ok(![...accessionsDe(limpio)].includes('fantasma'),
    'el accession sin documento abrible deja de contar como cita');
  eq(excluidos.eventos, 1, 'se cuenta el evento excluido');
  eq(excluidos.serie, 1, 'y el punto de serie');
  hondo(excluidos.accessions_excluidos, ['fantasma'], 'con el accession que lo causó, a la vista');

  // La trampa que esto evita: si el descargo se llamara `accessions`, el
  // recorrido lo leería como cita y el huérfano volvería al inventario — la
  // puerta diría "podé esto" y seguiría reportándolo como huérfano, para
  // siempre.
  const inv = inventarioDe(limpio, cuerpo);
  ok(!inv.huerfanos.includes('fantasma'),
    'y después de podar ya no vuelve a salir como huérfano: el descargo no es una cita');

  // El matiz que importa: si lo que no resuelve es el VECINO, el evento se
  // queda y lo que se cae es la referencia. Tirar un papel bueno porque el de
  // al lado no abre sería pagar dos veces.
  const sobrevive = limpio.linea.eventos.find((e) => e.accession === 'acc-502');
  ok(sobrevive, 'un evento citable NO se cae porque su vecino no lo sea');
  ok(!('anterior' in sobrevive), 'lo que se cae es la referencia al vecino, no el papel');
  eq(excluidos.vecinos, 1, 'y eso también se cuenta');

  // Sin huérfanos no se toca nada, y no se inventa un campo de exclusiones.
  const { paquete: igual, excluidos: nada } = podarSinCita(P, []);
  eq(nada, null, 'sin huérfanos no hay nada que declarar');
  eq(hashEvidencia(igual), hashEvidencia(P), 'y el paquete queda idéntico: el hash no se mueve');

  // La puerta de inspección poda ANTES de hashear: lo que no se puede citar
  // no entra al paquete, así que tampoco entra al hash ni al prompt.
  const r = respuestaEvidencia(cuerpo, { ticker: 'MELI' });
  eq(r.excluidos_sin_cita, null, 'con datos sanos no se excluye nada');
  hondo(r.huerfanos, [], 'y no hay huérfanos que podar');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El hash: la historia cambia cuando cambia un filing');
{
  // Mover un campo de lugar no re-narra cuatro mil empresas.
  eq(hashDe({ a: 1, b: 2 }), hashDe({ b: 2, a: 1 }), 'el hash no depende del orden de las claves');
  eq(hashDe({ a: [1, 2] }) === hashDe({ a: [2, 1] }), false, 'pero sí del orden de un arreglo, que es contenido');
  eq(canonico({ b: 1, a: undefined }), '{"b":1}', 'un campo undefined no entra al canónico');
  eq(canonico([1, 'a', null]), '[1,"a",null]', 'y los arreglos se serializan en orden');

  // Un filing nuevo cambia la historia. Eso SÍ tiene que re-narrar.
  const { cuerpo: c2 } = await armarHistoria(
    lecturaFalsa([fila('acc-nuevo', '8-K', '1.01', '2026-07-01'), ...FILAS], SERIE), 'MELI', {});
  ok(hashEvidencia(armarEvidencia(c2)) !== hashEvidencia(P), 'un filing nuevo cambia el hash');

  // Un valor re-expresado también: es el caso que la contraevidencia existe
  // para atrapar, y narrar el número viejo sería el peor de los errores.
  const serieRx = SERIE.map((p) => (p.familia === 'ingresos' && p.period_end === '2025-12-31'
    ? { ...p, val: 980 } : p));
  const { cuerpo: c3 } = await armarHistoria(lecturaFalsa(FILAS, serieRx), 'MELI', {});
  ok(hashEvidencia(armarEvidencia(c3)) !== hashEvidencia(P), 'un número re-expresado cambia el hash');

  eq(hashEvidencia(P).length, 32, 'el hash es corto y estable: entra en una columna sin drama');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El presupuesto: lo que no cabe se declara');
{
  const muchos = [];
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i * 3)).toISOString().slice(0, 10);
    muchos.push(fila(`m-${String(i).padStart(3, '0')}`, '8-K', '5.02', d));
  }
  muchos.sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
  const { cuerpo: c4 } = await armarHistoria(lecturaFalsa(muchos, []), 'MELI', {});
  const P4 = armarEvidencia(c4);

  eq(P4.linea.eventos.length, LIMITE_EVENTOS, 'el paquete se corta en el límite del presupuesto');
  eq(P4.linea.omitidos_por_presupuesto, 50, 'y dice cuántos no entraron');
  eq(P4.linea.total, 200, 'el total sigue siendo el verdadero, no el de la muestra');
  // Los dos huecos son distintos y se cuentan aparte: uno es "no cupo", el
  // otro es "entró contado en vez de listado".
  eq(P4.linea.colapsados_en_episodios, 0, 'sin episodios no hay nada colapsado');
  eq(P4.linea.eventos[0].fecha, muchos[0].filed, 'y lo que entra es lo más nuevo');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El presupuesto, medido con un emisor duro');
{
  // 159 filings en la ventana, una pelea de 34, 12 trimestres por familia.
  const duras = [];
  const its = ['5.02', '2.02,9.01', '1.01,9.01', '8.01', '2.02,7.01,9.01', '5.07,9.01', '4.02'];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2021, 8, 20 + i * 15)).toISOString().slice(0, 10);
    duras.push(fila(`0000320193-2${String(i).padStart(2, '0')}-00012${i % 10}`, '8-K', its[i % its.length], d));
  }
  const campania = [];
  for (let i = 0; i < 34; i++) {
    const d = new Date(Date.UTC(2025, 11, 15 + i * 4)).toISOString().slice(0, 10);
    const f = fila(`0001111111-25-0000${String(i).padStart(2, '0')}`, 'DFAN14A', '', d);
    duras.push(f); campania.push(armarEvento(f));
  }
  for (let i = 0; i < 5; i++) duras.push(fila(`0000320193-2${i}-000999`, 'DEF 14A', '', `202${1 + i}-10-01`));
  duras.sort((a, b) => String(b.filed).localeCompare(String(a.filed)));

  const serieDura = [];
  for (const fam of ['ingresos', 'margen', 'inventario', 'neto']) {
    for (let q = 0; q < 12; q++) {
      const fin = new Date(Date.UTC(2026, 5 - q * 3, 30)).toISOString().slice(0, 10);
      const ini = new Date(Date.UTC(2026, 3 - q * 3, 1)).toISOString().slice(0, 10);
      serieDura.push(punto(fam, fin, 1e10 - q * 1e8, {
        period_start: fam === 'inventario' ? null : ini,
        yoy_pct: q < 8 ? 7.4 : null, revisado: q === 5, derived: q % 4 === 0,
        accession: `0000320193-26-00${q}001`, accession_aux: q % 4 === 0 ? `0000320193-26-00${q}002` : null,
        filed: fin, form: q % 4 === 0 ? '10-K' : '10-Q',
      }));
    }
  }

  const { cuerpo: cd } = await armarHistoria(lecturaFalsa(duras, serieDura), 'MSFT', {});
  const PD = armarEvidencia(cd);
  const bytes = Buffer.byteLength(canonico(PD), 'utf8');

  ok(bytes < TECHO_BYTES, `el emisor duro entra en el presupuesto (${(bytes / 1024).toFixed(1)} KB < ${TECHO_BYTES / 1024} KB)`);
  eq(PD.linea.episodios.length, 1, 'la pelea entra contada');
  eq(PD.linea.colapsados_en_episodios, 32, 'y ahorra 32 renglones');

  // El glosario va UNA vez. Si la glosa se repitiera por evento, la mitad del
  // paquete serían las mismas frases copiadas.
  const txt = canonico(PD);
  const glosa = PD.linea.glosario.items['5.02'];
  ok(glosa && glosa.length > 20, 'el glosario trae la glosa larga del 5.02');
  eq(txt.split(JSON.stringify(glosa)).length - 1, 1, 'y aparece UNA sola vez en todo el paquete');
  ok(PD.linea.eventos.every((e) => !('glosa' in e)), 'ningún evento carga su propia copia de la traducción');

  // Todos los códigos que se usan están en el glosario: un código sin
  // traducción es una fila que el modelo no puede leer.
  const usados = new Set(PD.linea.eventos.flatMap((e) => [...e.items, ...(e.items_adjuntos || [])]));
  const sinGlosa = [...usados].filter((c) => !PD.linea.glosario.items[c]);
  hondo(sinGlosa, [], 'todo código que aparece en un evento está en el glosario');

  const inv = inventarioDe(PD, cd);
  hondo(inv.huerfanos, [], 'y con 159 filings sigue sin haber huérfanos');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La puerta de inspección: ver el paquete sin gastar en el modelo');
{
  const r = respuestaEvidencia(cuerpo, { ticker: 'MELI' });

  eq(r.ticker, 'MELI', 'la respuesta dice de quién es');
  eq(r.narrable, true, 'y si se puede narrar');
  eq(r.hash, hashEvidencia(r.evidencia), 'con el hash con el que se guardaría la narración');
  eq(r.bytes, Buffer.byteLength(canonico(r.evidencia), 'utf8'), 'y el peso MEDIDO, no estimado');
  hondo(r.huerfanos, [], 'sin huérfanos');
  ok(r.inventario.length > 0, 'con el inventario de lo citable');

  // Un emisor sin ingerir: la puerta contesta, pero no finge un paquete.
  const sin = respuestaEvidencia({ ticker: 'LULU', estado: 'sin_ingesta' }, { ticker: 'LULU' });
  eq(sin.narrable, false, 'un emisor sin ingerir no es narrable');
  eq(sin.hash, null, 'y no lleva hash: no hay narración que guardar');
  hondo(sin.inventario, [], 'ni inventario de un paquete que no existe');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
