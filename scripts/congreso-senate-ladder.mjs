#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// ESCALERA DEL SENADO — aislar por que el probe recibe 503 y Chrome no.
//
// Contexto (corrida 4, jueves 15:28 ET): desde la MISMA IP y a la MISMA hora,
// Chrome carga efdsearch.senate.gov y la busqueda de PTRs devuelve resultados,
// mientras el probe recibe 503 "U.S. Senate: Site Under Maintenance". Un
// mantenimiento real habria roto tambien a Chrome. Entonces la diferencia esta
// en el request, y comparar dos requests campo por campo solo produce
// sospechas: hay que MEDIR cual campo es.
//
// Metodo: peldano 0 = el request exacto del navegador (control conocido-bueno).
// Cada peldano siguiente cambia UNA sola cosa respecto al control. El primero
// que rompa nombra la causa. Si el peldano 0 ya falla, la causa no esta en el
// request: es la ruta de red (IP, TLS, HTTP/2) o las cookies expiraron.
//
// Uso (en la Mac, con Chrome abierto en el sitio y la sesion viva):
//   1. DevTools → Network → el POST a report/data/ → Copy as cURL
//   2. Pegar SOLO el valor de -b (las cookies) aqui:
//        export SENATE_COOKIE='csrftoken=...; sessionid=...; 33a5...=...'
//      y el csrftoken (el mismo valor que va en el header X-CSRFToken):
//        export SENATE_CSRF='...'
//      (si no se pasa, se saca del propio SENATE_COOKIE)
//   3. node scripts/congreso-senate-ladder.mjs
//
// Fase 0: esto NO parsea nada. Solo dice que request pasa y cual no.
// ═══════════════════════════════════════════════════════════════════════
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_DIR = '.congreso-phase0';
const BASE = 'https://efdsearch.senate.gov';
const PACE_MS = Number(process.env.SENATE_PACE_MS || 2500);

const COOKIE = process.env.SENATE_COOKIE || '';
const CSRF = process.env.SENATE_CSRF
  || (COOKIE.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, body) => {
  try { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(`${OUT_DIR}/${name}`, body); }
  catch { /* da igual */ }
};

if (!COOKIE || !CSRF) {
  console.error('Falta SENATE_COOKIE (y/o SENATE_CSRF). Ver la cabecera de este archivo.');
  process.exit(2);
}

// ── El request del navegador, campo por campo ──────────────────────────
const UA_REAL = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
// El que mandaba el probe: ningun Chrome emite un UA de dos componentes.
const UA_PROBE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const headersNavegador = () => ({
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Cookie: COOKIE,
  Origin: BASE,
  Referer: `${BASE}/search/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': UA_REAL,
  'X-CSRFToken': CSRF,
  'X-Requested-With': 'XMLHttpRequest',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
});

const payloadNavegador = () => {
  const p = {
    draw: '1', start: '0', length: '25',
    'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '1', 'order[0][dir]': 'asc',
    'order[1][column]': '0', 'order[1][dir]': 'asc',
    report_types: '[11]', filer_types: '[]',
    submitted_start_date: '01/01/2012 00:00:00', submitted_end_date: '',
    candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: '',
  };
  for (let i = 0; i < 5; i++) {
    p[`columns[${i}][data]`] = String(i);
    p[`columns[${i}][name]`] = '';
    p[`columns[${i}][searchable]`] = 'true';
    p[`columns[${i}][orderable]`] = 'true';
    p[`columns[${i}][search][value]`] = '';
    p[`columns[${i}][search][regex]`] = 'false';
  }
  return p;
};

// El shape que mandaba el probe: 17 claves menos y fecha vacia.
const payloadViejo = () => ({
  start: '0', length: '25', report_types: '[11]', filer_types: '[]',
  submitted_start_date: '', submitted_end_date: '', candidate_state: '',
  senator_state: '', office_id: '', first_name: '', last_name: '',
  csrfmiddlewaretoken: CSRF,
});

const sinCookie = (nombre) => COOKIE.split(/;\s*/)
  .filter((c) => !c.startsWith(`${nombre}=`)).join('; ');

// La tercera cookie: nombre y valor hexadecimales de 32, no la pone Django.
const nombreOpaca = (COOKIE.match(/(?:^|;\s*)([0-9a-f]{32})=/) || [])[1];

// ── Los peldanos: cada uno cambia UNA cosa respecto al control ──────────
const peldanos = [
  ['0 · CONTROL — request exacto del navegador', {}],
  ['1 · UA del probe ("Chrome/126.0", que no existe)', { headers: { 'User-Agent': UA_PROBE } }],
  ['2 · sin sec-ch-ua / Sec-Fetch / Accept-Language', {
    quitarHeaders: ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
                    'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'Accept-Language'] }],
  ['3 · Referer /search/home/ en vez de /search/', { headers: { Referer: `${BASE}/search/home/` } }],
  ...(nombreOpaca ? [[`4 · sin la cookie opaca (${nombreOpaca.slice(0, 8)}…)`,
    { headers: { Cookie: sinCookie(nombreOpaca) } }]] : []),
  ['5 · sin sessionid (el agreement)', { headers: { Cookie: sinCookie('sessionid') } }],
  ['6 · payload viejo del probe (17 claves menos, fecha vacia)', { payload: payloadViejo() }],
  ['7 · solo submitted_start_date vacio', { payloadPatch: { submitted_start_date: '' } }],
  ['8 · TODO junto: el request que mandaba el probe', {
    headers: { 'User-Agent': UA_PROBE, Referer: `${BASE}/search/home/` },
    quitarHeaders: ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
                    'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'Accept-Language'],
    payload: payloadViejo() }],
];

function veredictoDe(status, body, res) {
  // Un 403 del proxy de egress no dice NADA sobre el Senado. Distinguirlo
  // antes de leerlo como respuesta del sitio.
  const deny = res && res.headers.get('x-deny-reason');
  if (deny || /Host not in allowlist/i.test(body)) {
    return { ok: false, proxy: true, nota: `BLOQUEADO POR EL PROXY DE EGRESS (${deny || 'host_not_allowed'}) — no es el Senado` };
  }
  const title = (body.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim();
  const ref = (body.match(/Reference\s*#\s*([\w.]+)/i) || [, ''])[1];
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j.data)) return { ok: true, nota: `JSON · ${j.data.length} filas · total ${j.recordsTotal ?? '?'}` };
    } catch { /* no era JSON */ }
    return { ok: false, nota: `200 pero no es JSON${title ? ` · title="${title}"` : ''}` };
  }
  return { ok: false, nota: `HTTP ${status}${title ? ` · title="${title}"` : ''}${ref ? ` · ref=${ref}` : ''}` };
}

async function correr(nombre, cfg) {
  const h = { ...headersNavegador(), ...(cfg.headers || {}) };
  for (const k of cfg.quitarHeaders || []) delete h[k];
  const p = cfg.payload || { ...payloadNavegador(), ...(cfg.payloadPatch || {}) };
  const t0 = Date.now();
  let status = 0; let body = ''; let resp = null;
  try {
    const res = await fetch(`${BASE}/search/report/data/`, {
      method: 'POST', headers: h, redirect: 'manual',
      body: new URLSearchParams(p).toString(),
    });
    status = res.status;
    body = await res.text();
    resp = res;
  } catch (e) {
    console.log(`  ${nombre}\n     EXCEPCION: ${e.message}`);
    return null;
  }
  const v = veredictoDe(status, body, resp);
  if (v.proxy) proxyBloqueo = true;
  save(`ladder-${nombre.split(' ')[0]}.txt`, body.slice(0, 20000));
  console.log(`  ${v.ok ? '✓' : '✗'} ${nombre}\n     ${v.nota} (${Date.now() - t0}ms)`);
  return v.ok;
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  ESCALERA DEL SENADO · ' + new Date().toISOString());
console.log('  Cookies: ' + COOKIE.split(/;\s*/).map((c) => c.split('=')[0]).join(', '));
console.log('═══════════════════════════════════════════════════════════\n');

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (proxy) console.log(`  ⚠ Hay proxy de egress (${proxy}): un 403 puede venir de EL.\n`);

let proxyBloqueo = false;
const resultados = [];
for (const [nombre, cfg] of peldanos) {
  const ok = await correr(nombre, cfg);
  resultados.push([nombre, ok]);
  await sleep(PACE_MS);
}

console.log('\n─── LECTURA ───────────────────────────────────────────────');
if (proxyBloqueo) {
  console.log('  El proxy de egress bloqueo el host: esta corrida no midio NADA del Senado.');
  console.log('  Correr la escalera desde la Mac (salida directa), no desde el contenedor.');
  process.exit(0);
}
const control = resultados[0][1];
if (control === false) {
  console.log('  El CONTROL fallo. El request del navegador, calcado, tampoco pasa desde');
  console.log('  Node. Entonces la diferencia NO esta en headers/cookies/payload:');
  console.log('    · o las cookies pegadas ya expiraron (rehacer el Copy as cURL), o');
  console.log('    · la puerta discrimina por la capa de transporte (huella TLS/JA3,');
  console.log('      HTTP/2 vs HTTP/1.1, orden de headers) — cosa que ningun header arregla.');
  console.log('  Siguiente paso en ese caso: repetir el mismo cURL DEL NAVEGADOR con `curl`.');
  console.log('  Si curl pasa y Node no, es huella de cliente. Si ninguno pasa, son las cookies.');
} else if (control === true) {
  const primerFallo = resultados.find(([, ok]) => ok === false);
  if (!primerFallo) {
    console.log('  Pasaron TODOS los peldanos, incluido el request viejo del probe.');
    console.log('  Entonces el 503 no venia del shape del request: quedan la sesion (el probe');
    console.log('  nunca llegaba a tener `sessionid`, ver el fix en congreso-phase0-probe.mjs)');
    console.log('  o algo dependiente del momento. Correr el probe arreglado y comparar.');
  } else {
    console.log(`  El control pasa y el primer peldano que rompe es:\n    → ${primerFallo[0]}`);
    console.log('  Esa es la variable que explica el 503. Es UN solo cambio respecto al');
    console.log('  control, asi que no hay que adivinar entre varias sospechas.');
  }
}
save('ladder-resumen.json', JSON.stringify({ ts: new Date().toISOString(), resultados }, null, 2));
console.log(`\n  Cuerpos guardados en ${OUT_DIR}/ladder-*.txt`);
