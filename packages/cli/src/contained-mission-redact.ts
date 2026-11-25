// Dependency-free redaction for bridge log and error text. Lives apart from contained-mission-bridge.ts so the shadow
// merger can redact without importing any App-credential code (merger design §5.3).
import { redactSecrets } from '@osstack/governance';

/** redactSecrets plus every GitHub token shape (ghp_, ghs_, ghu_, gho_, ghr_). */
export const redactBridge = (text: string): string => redactSecrets(text).replace(/gh[pousr]_[A-Za-z0-9_]+/gu, '[REDACTED]');

export function isSafeExternalNoticeId(id: unknown): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 256
    && !/[\\/\p{C}]/u.test(id) && redactBridge(id) === id;
}
