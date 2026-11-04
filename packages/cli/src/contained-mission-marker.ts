/**
 * Machine marker on a Mission PR body (bridge design, first phase A.4). It only locates the Mission:
 * a PR body is editable, so the marker proves nothing about origin and authorizes nothing.
 */
export interface MissionMarker { id: string; spec_digest: string; head: string; start: string }
export interface ParsedMissionMarkers { marker?: MissionMarker; candidates: number; malformed: number }

const PREFIX = '<!-- osstack:mission ';
const LINE = /^<!-- osstack:mission ((?:[a-z_]+=[^\s=]+ )+)-->$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// CommonMark: a closing fence has nothing after the delimiter but whitespace.
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FIELDS: Record<keyof MissionMarker, RegExp> = {
  // Object ids are SHA-1 or SHA-256, as for start_commit (parseContainedMissionSpec).
  id: /^cm_[0-9a-f-]{36}$/, spec_digest: /^[0-9a-f]{64}$/, head: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, start: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/,
};
const KEYS = new Set(['v', ...Object.keys(FIELDS)]);

export function formatMissionMarker(marker: MissionMarker): string {
  for (const [key, pattern] of Object.entries(FIELDS)) if (!pattern.test(marker[key as keyof MissionMarker])) throw Error('CONTAINED_MARKER_INVALID');
  return `${PREFIX}v=1 id=${marker.id} spec_digest=${marker.spec_digest} head=${marker.head} start=${marker.start} -->`;
}

/** Exactly one candidate line outside fenced code, well formed and v=1, yields a marker; anything else yields none. */
export function parseMissionMarkers(body: string): ParsedMissionMarkers {
  let fence: string | undefined; const candidates: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) { const close = CLOSE.exec(line)?.[1]; if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined; continue; }
    const open = FENCE.exec(line)?.[1];
    if (open) { fence = open; continue; }
    if (line.startsWith(PREFIX)) candidates.push(line);
  }
  const parsed = candidates.map(parseLine);
  const malformed = parsed.filter(p => p === 'malformed').length;
  const only = candidates.length === 1 ? parsed[0] : undefined;
  return { ...(only && only !== 'malformed' && only !== 'unknown_version' ? { marker: only } : {}), candidates: candidates.length, malformed };
}

function parseLine(line: string): MissionMarker | 'malformed' | 'unknown_version' {
  const match = LINE.exec(line);
  if (!match) return 'malformed';
  const values = new Map<string, string>();
  for (const pair of match[1]!.trim().split(' ')) {
    const [key, value] = pair.split('=') as [string, string];
    if (!KEYS.has(key) || values.has(key)) return 'malformed';
    values.set(key, value);
  }
  if (!values.has('v') || Object.keys(FIELDS).some(key => !values.has(key))) return 'malformed';
  if (values.get('v') !== '1') return 'unknown_version';
  const marker = Object.fromEntries(Object.keys(FIELDS).map(key => [key, values.get(key)!])) as unknown as MissionMarker;
  return Object.entries(FIELDS).every(([key, pattern]) => pattern.test(marker[key as keyof MissionMarker])) ? marker : 'malformed';
}

/** Truncate first, then collapse to one line, so caller text (goal, verify argv) can neither open a fence nor start a marker line. */
export function renderBodyLine(goal: string, max: number): string {
  return goal.slice(0, max).replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/<!--/g, '<\\!--');
}
