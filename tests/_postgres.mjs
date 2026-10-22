// ═══════════════════════════════════════════════════════════════════════
// tests/_postgres.mjs — UN POSTGRES DE VERDAD, EN UN SOLO SITIO
//
// Esto vivía copiado dentro de `mercado-sql.test.mjs`. Se saca acá porque
// `arena-watch-diagnostico.test.mjs` necesita exactamente lo mismo, y este
// repo ya pagó dos días por tener DOS copias idénticas de `xval` y arreglar
// una sola. Un arranque de Postgres copiado es el mismo cuento esperando.
//
// SI NO HAY POSTGRES, el que llama falla EN VOZ ALTA: una prueba de SQL que
// se auto-desactiva deja la suite en verde afirmando algo que no midió. Para
// saltarla a propósito hay que decirlo: SIN_POSTGRES=1.
// ═══════════════════════════════════════════════════════════════════════
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIN_POSTGRES = process.env.SIN_POSTGRES === '1';

/** El directorio de binarios del Postgres instalado, o null. */
export function binDePostgres() {
  const raices = ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt'];
  for (const raiz of raices) {
    if (!existsSync(raiz)) continue;
    for (const v of readdirSync(raiz).sort().reverse()) {
      const bin = join(raiz, v, 'bin');
      if (existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'pg_ctl'))) return bin;
    }
  }
  for (const bin of ['/usr/bin', '/usr/local/bin']) {
    if (existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'pg_ctl'))) return bin;
  }
  return null;
}

export const FALTA_POSTGRES =
  'no se encontró un Postgres instalado (initdb/pg_ctl). Esta prueba NO se salta sola: '
  + 'el SQL sin verificar fue exactamente cómo el mapa llegó roto a producción. '
  + 'Instalá postgresql (apt install postgresql, o brew install postgresql) — '
  + 'o, si sabés lo que estás haciendo, corré con SIN_POSTGRES=1.';

/**
 * Levanta un Postgres efímero y devuelve `psql(sql) -> texto`.
 *
 * `t` es el contexto de `node:test`: el servidor se apaga y el directorio se
 * borra en su `after`, pase lo que pase.
 *
 * `puerto` distinto por archivo: dos suites en paralelo sobre el mismo puerto
 * se pisan, y el síntoma —"no se pudo conectar"— no se parece en nada a la
 * causa.
 */
export function levantaPostgres(t, { bin, puerto }) {
  const dir = mkdtempSync(join(tmpdir(), 'qd-pg-'));
  const datos = join(dir, 'datos');
  // initdb se niega a correr como root, así que si lo somos delegamos en un
  // usuario sin privilegios. Es la misma configuración en los dos casos.
  const comoRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const USUARIO = 'pgtest';
  const corre = (cmd) => {
    if (!comoRoot) return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return execSync(`su ${USUARIO} -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: 'pipe' });
  };
  if (comoRoot) {
    try { execSync(`id -u ${USUARIO}`, { stdio: 'ignore' }); }
    catch { execSync(`useradd -m ${USUARIO}`, { stdio: 'ignore' }); }
    execSync(`chown -R ${USUARIO} ${dir} && chmod 700 ${dir}`);
  }

  t.after(() => {
    try { corre(`${join(bin, 'pg_ctl')} -D ${datos} -m immediate -w stop`); } catch { /* ya estaba caído */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* da igual */ }
  });

  corre(`${join(bin, 'initdb')} -D ${datos} -A trust -U postgres`);
  corre(
    `${join(bin, 'pg_ctl')} -D ${datos} `
      + `-o "-k ${dir} -p ${puerto} -c listen_addresses=''" -l ${join(dir, 'log')} -w start`,
  );

  // `-q` es necesario, no cosmético: sin él psql mezcla las etiquetas de
  // comando ("INSERT 0 1150", "SELECT 24") con las filas, y una prueba
  // contaría ruido como si fueran datos.
  return (sql) =>
    execFileSync(join(bin, 'psql'), ['-h', dir, '-p', String(puerto), '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
}
