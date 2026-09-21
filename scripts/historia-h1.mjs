// ═══════════════════════════════════════════════════════════════
// scripts/historia-h1.mjs — la compuerta H1 de §11.8.
//
//   DATABASE_URL=... SEC_USER_AGENT="QuantDesk lety@…" node scripts/historia-h1.mjs
//   …--muestra=5      cuántos documentos se bajan enteros para el factor
//   …--formas=8-K,10-Q
//
// Mide **cuánto pesa lo que habría que leer** si HISTORIA extrajera cuerpos.
// Toda la aritmética del memo cuelga de esta cifra y no está medida.
//
// ── LAS CUATRO CONDICIONES, Y POR QUÉ CADA UNA ──────────────────────
//
// **1. SOLO EL DOCUMENTO PRINCIPAL.** `company_filings.size_bytes` es la
// submission ENTERA —exhibits y XBRL adentro—, y con eso un 8-K de dos
// párrafos pesa lo mismo que uno de cuarenta páginas. Se mide la URL del
// documento principal, con una HEAD por filing: una request, sin bajar nada.
//
// **2. BYTES DE HTML NO SON TOKENS.** En un filing de EDGAR el marcado se
// come la mitad o más. Armar la aritmética sobre bytes crudos la infla dos o
// tres veces. Así que de una MUESTRA chica se bajan los documentos enteros,
// se les quitan las etiquetas y se mide la razón texto/bytes. Ese factor va
// al informe **con el tamaño de su muestra al lado**: un factor medido sobre
// tres documentos es un factor medido sobre tres documentos, y decirlo es
// parte del número.
//
// **3. MEDIANA Y p95, NO PROMEDIO.** Un 10-K con anexos mueve un promedio y
// no representa nada. La mediana dice cómo es el documento típico; el p95,
// qué tan mal se puede poner.
//
// **4. SEPARADO POR FORMULARIO.** Un 8-K y un 10-K difieren en un orden de
// magnitud. Los que importan para la sección de dirección son los 8-K, que
// son los chicos: un número agregado haría descartar la extracción por el
// peso de documentos que ni se van a extraer.
//
// ── LO QUE ESTE SCRIPT NO HACE ──────────────────────────────────────
// No extrae nada, no llama a ningún modelo (salvo `count_tokens`, que no
// genera y no cuesta) y no escribe en la base. Mide.
// ═══════════════════════════════════════════════════════════════

import { pathToFileURL } from 'node:url';
import { sql } from '../api/_lib/db.js';
import { crearCliente, ErrorEdgar } from '../api/_lib/edgar.js';

const arg = (n, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};

const MUESTRA = Math.max(1, Number(arg('muestra', 3)));
const FORMAS = String(arg('formas', '8-K,10-Q,10-K,DEF 14A,DFAN14A'))
  .split(',').map((f) => f.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────
// Percentiles sobre la muestra observada. Interpolación lineal, que es la
// misma convención que `percentile_cont` de Postgres — así el número de acá
// y el de una consulta dan lo mismo.
// ─────────────────────────────────────────────────────────────────────────
export function percentil(valores, p) {
  const v = [...valores].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

// ─────────────────────────────────────────────────────────────────────────
// Quitar el marcado. No es un parser de HTML y no pretende serlo: para MEDIR
// alcanza con sacar script/style, las etiquetas y las entidades, y colapsar
// los espacios. Lo que queda es el texto que un extractor tendría que leer.
// ─────────────────────────────────────────────────────────────────────────
export function texto(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens exactos cuando hay llave: `count_tokens` no genera nada y no cuesta.
// Sin llave, la estimación de chars/4 — declarada como estimación.
async function contarTokens(texto_, apiKey) {
  if (!apiKey) return { tokens: Math.round(texto_.length / 4), exacto: false };
  const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': /* date-lint-ok: versión del protocolo de Anthropic, no una referencia a "hoy" */ '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.HISTORIA_CLAUDE_MODEL || 'claude-opus-5',
      messages: [{ role: 'user', content: texto_ }],
    }),
  });
  if (!r.ok) return { tokens: Math.round(texto_.length / 4), exacto: false, http: r.status };
  const j = await r.json();
  return { tokens: j.input_tokens, exacto: true };
}

const kb = (b) => (b == null ? '—' : (b / 1024).toFixed(1));

async function main() {
  const cli = crearCliente();
  const apiKey = process.env.ANTHROPIC_API_KEY || '';

  console.log('H1 — peso del DOCUMENTO PRINCIPAL por formulario');
  console.log(`UA: ${cli.ua} · ${cli.reqPorSegundo} req/s${cli.recortadoAlTecho ? ' (recortado al techo de la SEC)' : ''}`);
  console.log(`formas: ${FORMAS.join(', ')} · muestra para el factor texto/bytes: ${MUESTRA}\n`);

  const filas = await sql(
    `select e.ticker, f.form, f.accession, f.url
       from company_filings f
       join company_emisor e on e.cik = f.cik
      where f.form = any($1)
      order by f.form, f.filed desc`,
    [FORMAS],
  );
  if (!filas.length) {
    console.log('No hay filings de esas formas en la base. ¿Corriste el goteo?');
    return;
  }

  // ── El factor texto/bytes, sobre una muestra que se declara ────────────
  //
  // Se toma de los 8-K a propósito: son los documentos que la extracción
  // realmente va a leer (§11.8). Medir el factor sobre 10-K daría un número
  // correcto sobre los documentos equivocados.
  const paraMuestra = filas.filter((f) => f.form === '8-K').slice(0, MUESTRA);
  const razones = [];
  const tokensPorKbTexto = [];
  console.log('── Factor texto/bytes (documentos bajados enteros) ──');
  for (const f of paraMuestra) {
    try {
      const { cuerpo, bytes } = await cli.texto(f.url, { kind: 'h1-muestra' });
      const t = texto(cuerpo);
      const razon = t.length / bytes;
      razones.push(razon);
      const { tokens, exacto, http } = await contarTokens(t.slice(0, 200000), apiKey);
      tokensPorKbTexto.push(tokens / (t.length / 1024));
      console.log(`  ${f.ticker} ${f.accession}  ${kb(bytes)} KB → texto ${kb(t.length)} KB `
        + `(${(razon * 100).toFixed(0)}%) · ${tokens} tokens${exacto ? '' : ` (estimado${http ? `, count_tokens dio ${http}` : ''})`}`);
    } catch (e) {
      console.log(`  ${f.ticker} ${f.accession}  ERROR ${e instanceof ErrorEdgar ? e.clase : ''} ${e.message}`);
    }
  }
  const factor = razones.length ? razones.reduce((a, b) => a + b, 0) / razones.length : null;
  const tokPorKb = tokensPorKbTexto.length
    ? tokensPorKbTexto.reduce((a, b) => a + b, 0) / tokensPorKbTexto.length : null;

  if (factor == null) {
    console.log('\nNo se pudo medir el factor: sin él, los KB de abajo NO se pueden convertir a tokens.');
  } else {
    console.log(`\n  factor texto/bytes = ${(factor * 100).toFixed(0)}% `
      + `· ${tokPorKb ? tokPorKb.toFixed(0) : '—'} tokens por KB de texto`);
    console.log(`  ⚠️  MUESTRA DE ${razones.length} DOCUMENTO(S), todos 8-K. Es el tamaño de la muestra, no un detalle.`);
  }

  // ── El peso, por formulario, con una HEAD por filing ───────────────────
  console.log('\n── Peso del documento principal (HEAD, sin bajar el cuerpo) ──');
  const porForma = new Map();
  let sinLargo = 0;
  for (const f of filas) {
    if (!porForma.has(f.form)) porForma.set(f.form, []);
    try {
      const { bytes } = await cli.cabeza(f.url, { kind: 'h1-head' });
      if (bytes == null) { sinLargo++; continue; }
      porForma.get(f.form).push(bytes);
    } catch {
      sinLargo++;
    }
  }

  console.log('\nforma      n    mediana    p95     mediana→tokens   p95→tokens');
  for (const forma of FORMAS) {
    const v = porForma.get(forma) || [];
    if (!v.length) { console.log(`${forma.padEnd(10)} 0    —`); continue; }
    const med = percentil(v, 0.5);
    const p95 = percentil(v, 0.95);
    const aTok = (b) => (factor && tokPorKb ? Math.round((b * factor / 1024) * tokPorKb).toLocaleString('es-MX') : '—');
    console.log(`${forma.padEnd(10)} ${String(v.length).padEnd(4)} ${kb(med).padStart(7)} KB ${kb(p95).padStart(7)} KB`
      + `   ${aTok(med).padStart(12)}   ${aTok(p95).padStart(10)}`);
  }
  if (sinLargo) console.log(`\n(${sinLargo} filings sin content-length: quedaron fuera de la muestra, no se estimó su peso)`);

  const s = cli.stats();
  console.log(`\nllamadas a EDGAR: ${s.llamadas} · espera por el limitador: ${(s.esperaTotalMs / 1000).toFixed(1)} s`);
  console.log('\nCRITERIO (§11.8): si la mediana del 8-K pasa de ~6.000 tokens, la opción (a)');
  console.log('—cuerpos al prompt— queda descartada sin discusión. Los 8-K son los que importan.');
}

// Corre SOLO cuando se lo invoca directo. Sin esta guarda, importarlo para
// probar `texto()` o `percentil()` dispara una corrida contra EDGAR — y una
// función que no se puede importar es una función que no se puede probar.
const invocadoDirecto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invocadoDirecto) {
  main().catch((e) => { console.error('H1 falló:', e && e.message ? e.message : e); process.exit(1); });
}
