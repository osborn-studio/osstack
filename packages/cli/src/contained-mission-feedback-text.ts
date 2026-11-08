/** Keep a UTF-16 budget without leaving half of a supplementary Unicode code point at its cutoff. */
export function feedbackTextPrefix(text: string, end: number): string {
  const prefix = text.slice(0, end);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}
