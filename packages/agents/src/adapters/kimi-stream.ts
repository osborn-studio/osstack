import { Buffer } from "node:buffer";
import {
  parseKimiReviewResult,
  type KimiReviewResult,
} from "./kimi-contract.js";

const REVIEW_RESULT_PREFIX = "OSSTACK_REVIEW_RESULT=";
const KNOWN_EVENT_TYPES = new Set(["assistant", "session.resume_hint"]);

export interface KimiStreamMessage {
  type: string;
  text?: string;
  raw: Record<string, unknown>;
}

export class KimiStreamAccumulator {
  private readonly limitBytes: number;
  private bufferedLine = "";
  private receivedBytes = 0;
  private readonly displayText: string[] = [];
  private readonly resultPayloads: string[] = [];
  private readonly unknownEventTypes = new Set<string>();

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error("Kimi stream byte limit must be a positive safe integer");
    }
    this.limitBytes = limitBytes;
  }

  pushChunk(chunk: string): KimiStreamMessage[] {
    this.addBytes(Buffer.byteLength(chunk, "utf8"));
    const lines = `${this.bufferedLine}${chunk}`.split("\n");
    this.bufferedLine = lines.pop() ?? "";

    const messages: KimiStreamMessage[] = [];
    for (const line of lines) {
      const message = this.parseLine(line.replace(/\r$/, ""));
      if (message !== undefined) messages.push(message);
    }
    return messages;
  }

  pushLine(line: string): KimiStreamMessage | undefined {
    this.addBytes(Buffer.byteLength(line, "utf8"));
    return this.parseLine(line.replace(/\r$/, ""));
  }

  finish(): void {
    if (this.bufferedLine === "") return;
    const finalLine = this.bufferedLine;
    this.bufferedLine = "";
    this.parseLine(finalLine.replace(/\r$/, ""));
  }

  text(): string {
    return this.displayText.join("\n");
  }

  unknownTypes(): string[] {
    return [...this.unknownEventTypes];
  }

  reviewResult(subjectRunId: string): KimiReviewResult {
    if (this.resultPayloads.length === 0) {
      throw new Error(`missing ${REVIEW_RESULT_PREFIX.slice(0, -1)}`);
    }
    if (this.resultPayloads.length > 1) {
      throw new Error(`duplicate ${REVIEW_RESULT_PREFIX.slice(0, -1)}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(this.resultPayloads[0] ?? "");
    } catch (error) {
      throw new Error("invalid OSSTACK_REVIEW_RESULT JSON", { cause: error });
    }

    const result = parseKimiReviewResult(raw);
    if (result.subject_run_id !== subjectRunId) {
      throw new Error(
        `Kimi review subject_run_id ${result.subject_run_id} does not match ${subjectRunId}`,
      );
    }
    return result;
  }

  private addBytes(bytes: number): void {
    this.receivedBytes += bytes;
    if (this.receivedBytes > this.limitBytes) {
      throw new Error(
        `Kimi stream byte limit exceeded: ${this.receivedBytes} > ${this.limitBytes}`,
      );
    }
  }

  private parseLine(line: string): KimiStreamMessage | undefined {
    if (line.trim() === "") return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error("invalid Kimi stream JSON", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid Kimi stream JSON: event must be an object");
    }

    const raw = parsed as Record<string, unknown>;
    const type = eventType(raw);
    if (!KNOWN_EVENT_TYPES.has(type)) this.unknownEventTypes.add(type);

    const text = assistantText(raw);
    const display = text === undefined ? undefined : this.captureAssistantText(text);
    if (display !== undefined && display !== "") {
      this.displayText.push(display);
      return { type, text: display, raw };
    }
    return { type, raw };
  }

  private captureAssistantText(text: string): string {
    const displayLines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(REVIEW_RESULT_PREFIX)) {
        this.resultPayloads.push(
          trimmed.slice(REVIEW_RESULT_PREFIX.length).trim(),
        );
      } else {
        displayLines.push(line);
      }
    }
    return displayLines.join("\n").trim();
  }
}

function eventType(raw: Record<string, unknown>): string {
  if (typeof raw["type"] === "string" && raw["type"].trim() !== "") {
    return raw["type"];
  }
  if (typeof raw["role"] === "string" && raw["role"].trim() !== "") {
    return raw["role"];
  }
  return "unknown";
}

function assistantText(raw: Record<string, unknown>): string | undefined {
  if (raw["role"] !== "assistant") return undefined;
  return typeof raw["content"] === "string" ? raw["content"] : undefined;
}
