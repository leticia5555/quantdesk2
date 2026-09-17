// ═══════════════════════════════════════════════════════════════
// tests/external-crons.test.mjs — qué cuenta como falla en el cron externo.
//
// EL BUG: el 2026-09-17 llegaba correo de Actions todos los días —
// "external-crons / screener-refresh — Failed in 3 seconds"— y el cron NO
// estaba roto: el endpoint contestaba perfecto que está APAGADO
// (`ARENA_SCREENER_ENABLED != 1`), y el workflow trataba `disabled: true` como
// fallo duro.
//
// Es el MISMO bug que ya se había arreglado una vez en este archivo, para
// `pead:earnings`, y volvió por el otro job. Por eso ahora hay un test: un
// comentario que explica la lección no impide repetirla.
//
// Y la lección es la que importa: un rojo permanente se silencia, y el día que
// un cron se caiga de verdad el aviso va a estar en la misma carpeta que todos
// los avisos que se aprendieron a ignorar. Un aviso rojo que se ignora es peor
// que no tener aviso, porque además da la sensación de que hay vigilancia.
//
// El test EJERCITA el shell del workflow —no lo grepea— porque lo que falla es
// la lógica, no el texto.
//
// Correr con `node tests/external-crons.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const yml = readFileSync(new URL('../.github/workflows/external-crons.yml', import.meta.url), 'utf8');

// ── El shell del workflow, tal cual, con el curl reemplazado por inyección ──
// Se extrae el bloque `run: |` y se corta desde la primera decisión: todo lo
// que sigue es la lógica que decide rojo/amarillo/verde.
function logicaDelWorkflow() {
  const run = yml.split('run: |\n')[1];
  const sinIndent = run.split('\n').map((l) => (l.startsWith(' '.repeat(10)) ? l.slice(10) : l)).join('\n');
  const desde = sinIndent.indexOf('if [ "$curl_exit" -ne 0 ]');
  if (desde < 0) return null;
  return '#!/usr/bin/env bash\nset -uo pipefail\ncurl_exit=0\n' + sinIndent.slice(desde);
}

const script = logicaDelWorkflow();
ok(!!script, 'el bloque `run` del workflow se puede extraer y ejercitar');

let puedeCorrer = true;
try { execFileSync('bash', ['-c', 'command -v jq >/dev/null']); } catch { puedeCorrer = false; }

if (!script || !puedeCorrer) {
  console.log('  SKIP  (falta bash o jq en esta máquina) — el resto del test necesita los dos');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'crons-'));
  const ruta = join(dir, 'logica.sh');
  writeFileSync(ruta, script);

  const correr = (http_code, body) => {
    try {
      const out = execFileSync('bash', [ruta], { env: { ...process.env, http_code: String(http_code), body }, encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };

  // ── LO QUE TIENE QUE QUEDAR VERDE ────────────────────────────────
  console.log('\n── una corrida normal pasa ──');
  {
    const r = correr(200, '{"job":"refresh","processed":[],"stats":{}}');
    ok(r.code === 0 && /OK — screener corrió/.test(r.out), 'un refresh normal sale verde', r.out.trim());
  }

  // ── APAGADO NO ES ROTO ───────────────────────────────────────────
  console.log('\n── apagado es un ESTADO, no una falla ──');
  {
    const r = correr(200, '{"disabled":true,"hint":"ARENA_SCREENER_ENABLED != 1"}');
    ok(r.code === 0, 'el endpoint que contesta "estoy apagado" NO pone el run en rojo: contestó bien', String(r.code));
    ok(/::warning::/.test(r.out) && /ARENA_SCREENER_ENABLED=1/.test(r.out),
      'pero avisa, y dice exactamente cómo encenderlo — amarillo se ve, rojo permanente se silencia');
    ok(!/::error::/.test(r.out), 'y no lo anuncia como error');
  }
  {
    const r = correr(200, '{"job":"refresh","done":true,"note":"ledger vacío — corré ?job=seed"}');
    ok(r.code === 0 && /::warning::/.test(r.out) && /job=seed/.test(r.out),
      'un ledger vacío también avisa con su remedio, sin teñir de rojo un cron que no está roto');
  }

  // ── LO QUE SÍ TIENE QUE PONERSE ROJO ─────────────────────────────
  // El punto de bajar el ruido NO es bajar la guardia: lo que de verdad se
  // rompe tiene que seguir doliendo.
  console.log('\n── lo que sí está roto sigue en rojo ──');
  {
    const r = correr(401, '{"error":"No autorizado."}');
    ok(r.code === 1 && /CRON_SECRET/.test(r.out),
      'un 401 es rojo, y el mensaje nombra el secret que hay que arreglar y dónde', r.out.trim().split('\n').pop());
  }
  {
    const r = correr(500, '{"error":"boom"}');
    ok(r.code === 1, 'un 5xx es rojo: el endpoint está caído');
  }
  {
    const r = correr(200, '{"job":"refresh","error":"FINNHUB_API_KEY not set"}');
    ok(r.code === 1, 'un HTTP 200 con `error` adentro es rojo: el handler falló y lo dice en el cuerpo');
  }
  {
    const r = correr(200, '<html>Vercel error</html>');
    ok(r.code === 1, 'y una página de error de Vercel en vez de JSON también');
  }
}

// ── EL SCHEDULE Y EL JOB TIENEN QUE COINCIDIR ────────────────────────
// El `if:` del job compara contra el string del cron. Si alguien cambia el
// schedule y no el `if`, el job deja de correr EN SILENCIO: no falla, no
// aparece, simplemente no existe — que es el peor modo de falla de todos.
console.log('\n── el schedule y el guard del job dicen lo mismo ──');
{
  const schedules = [...yml.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
  const guards = [...yml.matchAll(/github\.event\.schedule\s*==\s*'([^']+)'/g)].map((m) => m[1]);
  ok(schedules.length > 0 && guards.length > 0, 'hay al menos un schedule y un guard', `${schedules.length}/${guards.length}`);
  const huerfanos = guards.filter((g) => !schedules.includes(g));
  ok(huerfanos.length === 0,
    'cada guard apunta a un schedule que existe — si no, el job no corre y no falla: desaparece',
    huerfanos.join(', '));
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
