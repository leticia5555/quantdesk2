// ═══════════════════════════════════════════════════════════════════
// Fixtures de eventos de Gamma para la cosecha de rangos de KPI.
// Forma copiada de /events?slug= (campos que usa la cosecha; el resto se
// omite). Strings con JSON adentro en outcomes/outcomePrices/clobTokenIds,
// como los manda Gamma.
// ═══════════════════════════════════════════════════════════════════

const cajon = (cond, label, yes, { closed = false, question = null, tok = null } = {}) => ({
  id: 'g-' + cond,
  conditionId: cond,
  question: question || `Mastercard (MA) cross-border volume growth Q3 2026: ${label}?`,
  groupItemTitle: label,
  outcomes: '["Yes", "No"]',
  outcomePrices: JSON.stringify([String(yes), String(Number((1 - yes).toFixed(4)))]),
  clobTokenIds: JSON.stringify([tok || 'tok-yes-' + cond, 'tok-no-' + cond]),
  endDate: '2026-10-30T20:00:00Z',
  createdAt: '2026-10-01T15:00:00Z',
  closed,
  active: !closed,
  volumeNum: 12000,
  liquidityNum: 3400,
});

export const EVENTO_MA = {
  slug: 'mastercard-ma-cross-border-volume-growth-q3-2026',
  title: 'Mastercard (MA) cross-border volume growth Q3 2026?',
  endDate: '2026-10-30T20:00:00Z',
  createdAt: '2026-10-01T15:00:00Z',
  markets: [
    cajon('0xma1', '<22%', 0.08),
    cajon('0xma2', '22% to 24%', 0.31),
    cajon('0xma3', '24% to 26%', 0.42),
    cajon('0xma4', '26% to 28%', 0.15),
    cajon('0xma5', '28%+', 0.04),
  ],
};

// Sin groupItemTitle: el rango sale de la pregunta. Nombre comercial con
// apóstrofo ("DICK'S") en vez de ticker. Ya resuelto: ganó "between 3% and 4%".
const dks = (cond, label, yes) => ({
  ...cajon(cond, label, yes, { closed: true, question: `Will DICK'S comparable sales be ${label} in Q2 2026?` }),
  groupItemTitle: undefined,
  endDate: '2026-08-28T20:00:00Z',
});
export const EVENTO_DKS = {
  slug: 'dicks-comparable-sales-q2-2026',
  title: "DICK'S comparable sales Q2 2026?",
  endDate: '2026-08-28T20:00:00Z',
  markets: [
    dks('0xdk1', 'below 1%', 0),
    dks('0xdk2', 'between 1% and 3%', 0),
    dks('0xdk3', 'between 3% and 4%', 1),
    dks('0xdk4', 'above 4%', 0),
  ],
};

// Trampas que la búsqueda por texto arrastra:
export const EVENTO_BEAT = {
  slug: 'will-costco-beat-quarterly-earnings',
  title: 'Will Costco (COST) beat quarterly earnings?',
  markets: [cajon('0xb1', 'Yes', 0.7, { question: 'Will Costco (COST) beat quarterly earnings?' })],
};
export const EVENTO_MENCION = {
  slug: 'what-will-microsoft-say-during-earnings-call',
  title: 'What will Microsoft say during earnings call?',
  markets: [cajon('0xm1', 'Azure 10+ times', 0.5, { question: 'Will Microsoft say "Azure" 10+ times?' })],
};
export const EVENTO_AZURE_SIN_RANGOS = {
  slug: 'azure-outage-by-december',
  title: 'Azure outage by December 31?',
  markets: [{ ...cajon('0xaz1', 'December 31', 0.2, { question: 'Azure outage by December 31?' }) }],
};

// Rangos, pero no de un periodo fiscal: la semilla "net adds" los trajo en la
// corrida en seco real.
export const EVENTO_MUSK = {
  slug: 'elon-musk-net-worth-on-october-31',
  title: 'Elon Musk Net Worth on October 31?',
  markets: [cajon('0xem1', '<$400B', 0.2), cajon('0xem2', '$400B to $500B', 0.5), cajon('0xem3', '$500B+', 0.3)],
};

// Escalera: cada hijo es "above X", con la etiqueta como número pelado.
export const EVENTO_ESCALERA = {
  slug: 'will-crowdstrike-q3-net-new-arr-be-above',
  title: 'Will CrowdStrike Q3 net new ARR be above __?',
  markets: [cajon('0xcr1', '$200M', 0.9), cajon('0xcr2', '$225M', 0.6), cajon('0xcr3', '$250M', 0.25)],
};

// Respuesta de /public-search: los eventos pueden venir con los mercados
// recortados; la cosecha re-hidrata por slug.
export function busqueda(eventos) {
  return { events: eventos.map((e) => ({ slug: e.slug, title: e.title, markets: [] })), tags: [], profiles: [] };
}
