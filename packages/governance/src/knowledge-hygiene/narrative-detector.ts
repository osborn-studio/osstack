export const NARRATIVE_SIGNAL_RULE_IDS_V1 = [
  "rulebook.managed_context_block",
  "rulebook.narrative_block",
  "rulebook.narrative_density",
  "rulebook.invalid_waiver",
] as const;

export type NarrativeSignalRuleIdV1 =
  (typeof NARRATIVE_SIGNAL_RULE_IDS_V1)[number];

export interface NarrativeSignalV1 {
  rule_id: NarrativeSignalRuleIdV1;
  start_line: number;
  end_line: number;
  severity: "warning";
  confidence: "high" | "medium";
  observed: Record<string, string | number | boolean>;
}

export interface DetectNarrativeSignalsInputV1 {
  path: string;
  content: string;
}

interface ClassifiedLine {
  number: number;
  text: string;
  trimmed: string;
  eligible: boolean;
}

interface ParsedWaiver {
  line: number;
  ruleId: NarrativeSignalRuleIdV1;
}

interface Section {
  startIndex: number;
  endIndex: number;
}

const knownRuleIds = new Set<string>(NARRATIVE_SIGNAL_RULE_IDS_V1);
const waiverPrefix = "osstack-neat-disable-next-line";
const exactWaiver = new RegExp(
  `^<!-- ${waiverPrefix} ([a-z0-9][a-z0-9._-]*) reason="([^"\\r\\n]+)" -->$`,
);
const claudeContextStart = /^<claude-mem-context(?:\s[^>]*)?>$/;
const claudeContextEnd = /^<\/claude-mem-context>$/;
const observationRecord =
  /^\s*(?:[-*+]\s+)?\d{3,}\s+(?:\d{1,2}:\d{2}[ap]?|")\s+\S/;
const isoEvent =
  /^\s*(?:[-*+]\s+)?\d{4}-\d{2}-\d{2}(?:[T ][0-9:Z+.-]+)?\s+\S/;

const managedHtmlMarkers = new Map<string, readonly string[]>([
  ["<!-- ECC:SUMMARY -->", [
    "<!-- ECC:SUMMARY END -->",
    "<!-- /ECC:SUMMARY -->",
  ]],
  ["<!-- ECC:SUMMARY START -->", [
    "<!-- ECC:SUMMARY END -->",
    "<!-- /ECC:SUMMARY -->",
  ]],
  ["<!-- SessionStart hook -->", [
    "<!-- SessionStart hook END -->",
    "<!-- /SessionStart hook -->",
  ]],
  ["<!-- SessionStart hook START -->", [
    "<!-- SessionStart hook END -->",
    "<!-- /SessionStart hook -->",
  ]],
]);

function classifyLines(content: string): ClassifiedLine[] {
  const lines = content.split(/\r?\n/);
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  return lines.map((text, index) => {
    const trimmed = text.trim();
    if (fenceCharacter !== undefined) {
      const close = trimmed.match(/^(`+|~+)\s*$/)?.[1];
      const closesFence =
        close !== undefined &&
        close[0] === fenceCharacter &&
        close.length >= fenceLength;
      if (closesFence) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      return { number: index + 1, text, trimmed, eligible: false };
    }

    const open = trimmed.match(/^(`{3,}|~{3,})(?:\s*.*)?$/)?.[1];
    if (open !== undefined) {
      fenceCharacter = open[0] as "`" | "~";
      fenceLength = open.length;
      return { number: index + 1, text, trimmed, eligible: false };
    }
    return { number: index + 1, text, trimmed, eligible: true };
  });
}

function signal(
  ruleId: NarrativeSignalRuleIdV1,
  startLine: number,
  endLine: number,
  confidence: NarrativeSignalV1["confidence"],
  observed: NarrativeSignalV1["observed"],
): NarrativeSignalV1 {
  return {
    rule_id: ruleId,
    start_line: startLine,
    end_line: endLine,
    severity: "warning",
    confidence,
    observed,
  };
}

function findManagedBlocks(lines: readonly ClassifiedLine[]): NarrativeSignalV1[] {
  const signals: NarrativeSignalV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.eligible) continue;

    let closingTokens: readonly string[] | undefined;
    if (claudeContextStart.test(line.trimmed)) {
      closingTokens = ["</claude-mem-context>"];
    } else {
      closingTokens = managedHtmlMarkers.get(line.trimmed);
    }
    if (closingTokens === undefined) continue;

    let endIndex = index;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      if (lines[candidate]?.text.length) endIndex = candidate;
    }
    let closed = false;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const candidateLine = lines[candidate];
      if (
        candidateLine?.eligible &&
        (closingTokens.includes(candidateLine.trimmed) ||
          (closingTokens[0] === "</claude-mem-context>" &&
            claudeContextEnd.test(candidateLine.trimmed)))
      ) {
        endIndex = candidate;
        closed = true;
        break;
      }
    }
    const endLine = lines[endIndex]?.number ?? line.number;
    signals.push(signal(
      "rulebook.managed_context_block",
      line.number,
      endLine,
      "high",
      { marker: line.trimmed, closed },
    ));
    index = endIndex;
  }
  return signals;
}

function sections(lines: readonly ClassifiedLine[]): Section[] {
  const headings: Array<{ index: number; level: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.eligible) continue;
    const heading = line.text.match(/^\s*(#{1,6})\s+\S/);
    if (heading?.[1] !== undefined) {
      headings.push({ index, level: heading[1].length });
    }
  }
  const result: Section[] = [{ startIndex: 0, endIndex: lines.length }];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    const nextBoundary = headings.slice(index + 1).find(
      (candidate) => candidate.level <= heading.level,
    );
    result.push({
      startIndex: heading.index + 1,
      endIndex: nextBoundary?.index ?? lines.length,
    });
  }
  return result;
}

function consecutiveIsoRun(
  lines: readonly ClassifiedLine[],
  section: Section,
): ClassifiedLine[] {
  let best: ClassifiedLine[] = [];
  let current: ClassifiedLine[] = [];
  for (let index = section.startIndex; index < section.endIndex; index += 1) {
    const line = lines[index];
    if (line?.eligible && isoEvent.test(line.text)) {
      current.push(line);
      if (current.length > best.length) best = [...current];
    } else {
      current = [];
    }
  }
  return best;
}

function findNarrativeBlocks(lines: readonly ClassifiedLine[]): NarrativeSignalV1[] {
  const result = new Map<string, NarrativeSignalV1>();
  for (const section of sections(lines)) {
    const observations = lines
      .slice(section.startIndex, section.endIndex)
      .filter((line) => line.eligible && observationRecord.test(line.text));
    const isoRun = consecutiveIsoRun(lines, section);
    const matched = observations.length >= 5 ? observations : isoRun;
    if (matched.length < 5) continue;
    const first = matched[0];
    const last = matched.at(-1);
    if (first === undefined || last === undefined) continue;
    const kind = observations.length >= 5 ? "observation_records" : "iso_events";
    const key = `${kind}:${first.number}`;
    const candidate = signal(
      "rulebook.narrative_block",
      first.number,
      last.number,
      "medium",
      { kind, count: matched.length },
    );
    const existing = result.get(key);
    // The synthetic root section can rediscover a heading-scoped block.
    // Keep the narrowest candidate so one logical block has one review identity.
    if (existing === undefined || candidate.end_line < existing.end_line) {
      result.set(key, candidate);
    }
  }
  return [...result.values()];
}

function isSuspicious(line: ClassifiedLine): boolean {
  if (!line.eligible || line.trimmed.length === 0) return false;
  return observationRecord.test(line.text) ||
    isoEvent.test(line.text) ||
    /^(?:Session summary\b|会话摘要|Compaction occurred\b)/i.test(line.trimmed) ||
    /^(?:Legend|Stats|Fetch details):/.test(line.trimmed) ||
    /^Access\s+\d+(?:[kKmM])?\s+tokens\b/.test(line.trimmed);
}

function findNarrativeDensity(
  lines: readonly ClassifiedLine[],
): NarrativeSignalV1[] {
  const eligible = lines.filter(
    (line) => line.eligible && line.trimmed.length > 0,
  );
  const suspicious = eligible.filter(isSuspicious);
  if (suspicious.length < 8 || suspicious.length / eligible.length < 0.2) {
    return [];
  }
  const first = suspicious[0];
  const last = suspicious.at(-1);
  if (first === undefined || last === undefined) return [];
  return [signal(
    "rulebook.narrative_density",
    first.number,
    last.number,
    "medium",
    {
      suspicious_lines: suspicious.length,
      eligible_lines: eligible.length,
      ratio_basis_points: Math.round((suspicious.length / eligible.length) * 10_000),
    },
  )];
}

function parseWaivers(lines: readonly ClassifiedLine[]): {
  valid: ParsedWaiver[];
  invalid: NarrativeSignalV1[];
} {
  const valid: ParsedWaiver[] = [];
  const invalid: NarrativeSignalV1[] = [];
  for (const line of lines) {
    if (!line.eligible || !line.text.includes(waiverPrefix)) continue;
    const match = line.trimmed.match(exactWaiver);
    const ruleId = match?.[1];
    if (
      match === null ||
      ruleId === undefined ||
      match[2]?.trim().length === 0 ||
      !knownRuleIds.has(ruleId)
    ) {
      invalid.push(signal(
        "rulebook.invalid_waiver",
        line.number,
        line.number,
        "high",
        { reason: "malformed_or_unknown_rule" },
      ));
      continue;
    }
    valid.push({
      line: line.number,
      ruleId: ruleId as NarrativeSignalRuleIdV1,
    });
  }
  return { valid, invalid };
}

export function detectNarrativeSignals(
  input: DetectNarrativeSignalsInputV1,
): NarrativeSignalV1[] {
  const lines = classifyLines(input.content);
  const waivers = parseWaivers(lines);
  const raw = [
    ...findManagedBlocks(lines),
    ...findNarrativeBlocks(lines),
    ...findNarrativeDensity(lines),
  ];
  const consumedWaivers = new Set<number>();
  const active = raw.filter((candidate) => {
    const waiver = waivers.valid.find(
      (entry) =>
        entry.line + 1 === candidate.start_line &&
        entry.ruleId === candidate.rule_id,
    );
    if (waiver === undefined) return true;
    consumedWaivers.add(waiver.line);
    return false;
  });
  for (const waiver of waivers.valid) {
    if (consumedWaivers.has(waiver.line)) continue;
    waivers.invalid.push(signal(
      "rulebook.invalid_waiver",
      waiver.line,
      waiver.line,
      "high",
      { reason: "orphan_waiver", target_rule: waiver.ruleId },
    ));
  }

  return [...active, ...waivers.invalid].sort((left, right) =>
    left.start_line - right.start_line ||
    left.end_line - right.end_line ||
    left.rule_id.localeCompare(right.rule_id)
  );
}
