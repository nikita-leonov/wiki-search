import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader. Loads KEY=value lines from `.env` in the given
 * directory into process.env. Does not override variables that are already
 * set (matches dotenv's default behavior). Quoted values are unquoted.
 * Lines starting with `#` and blank lines are ignored.
 */
export function loadEnv(cwd: string = process.cwd()): { loaded: boolean; path: string } {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return { loaded: false, path };

  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return { loaded: true, path };
}
