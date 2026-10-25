/** Minimal .env loader for scripts (tsx does not load .env automatically). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvFile(): void {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue; // real environment takes precedence
    process.env[key] = match[2]!.replace(/^["']|["']$/g, '');
  }
}
