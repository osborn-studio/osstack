/**
 * Truncate by UTF-16 code units without emitting an unpaired surrogate.
 *
 * JSON.stringify escapes lone surrogates, but strict JSON readers such as jq
 * reject those escapes. Replacing malformed input and keeping complete code
 * points makes persisted loop state and proof artifacts interoperable.
 */
export function truncateUnicodeSafe(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0 || value === "") return "";

  let result = "";
  for (const codePoint of value) {
    const normalized = isLoneSurrogate(codePoint) ? "\uFFFD" : codePoint;
    if (result.length + normalized.length > maxCodeUnits) break;
    result += normalized;
  }
  return result;
}

function isLoneSurrogate(value: string): boolean {
  if (value.length !== 1) return false;
  const codeUnit = value.charCodeAt(0);
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}
