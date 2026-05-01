import { createHash } from "node:crypto";

/**
 * Stable short fingerprint for an artifact (prompt YAML, judge YAML, dataset
 * JSON) so each eval run can record the precise versions it consumed.
 *
 * SHA-256 of the file contents, truncated to 12 hex chars. 48 bits of
 * collision resistance is overkill for our scale and short enough to
 * eyeball.
 */
export function shortHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
