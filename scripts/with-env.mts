/**
 * Run a command with .env loaded, without going through the shell.
 *
 * `set -a; . ./.env` truncates a Neon connection string at its `&`, which a POSIX shell reads
 * as a control operator. Parsing the file here and passing the result straight into the child
 * process avoids that, and keeps the credential off the command line.
 *
 * Usage: npx tsx scripts/with-env.mts <command> [args...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function loadEnv(path = '.env'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: run-with-env.mts <command> [args...]');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ...loadEnv() },
});

child.on('exit', (code) => process.exit(code ?? 1));
