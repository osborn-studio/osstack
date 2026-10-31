import { describe, expect, it } from "vitest";
import { MISSION_SECRET_REDACTION, redactSecrets, scanForSecrets } from "./secret-scan.js";

// Fixtures are assembled at runtime so this file never contains a literal credential.
const alnum = (length: number) => "Ab3".repeat(Math.ceil(length / 3)).slice(0, length);
const FAKE = {
  github: "gh" + "p_" + alnum(36),
  githubPat: "github" + "_pat_" + alnum(22) + "_" + alnum(59),
  gho: "gh" + "o_" + alnum(36),
  aws: "AK" + "IA" + "Z7QW3ERT5YUI9OPA",
  sk: "s" + "k-" + "proj-" + alnum(48),
  slack: "xo" + "xb-" + "1234567890-" + alnum(24),
  slackWebhook: "https://hooks.slack" + ".com/services/T0001/B0002/" + alnum(24),
};

describe("scanForSecrets", () => {
  it.each([
    ["github", "secret.github-token"],
    ["githubPat", "secret.github-token"],
    ["gho", "secret.github-token"],
    ["aws", "secret.aws-access-key-id"],
    ["sk", "secret.sk-api-key"],
    ["slack", "secret.slack-token"],
    ["slackWebhook", "secret.slack-webhook"],
  ] as const)("detects %s without returning the value", (name, rule) => {
    const text = `line one\nconst token = "${FAKE[name]}";\n`;
    const matches = scanForSecrets(text, { channel: "stdout" });
    expect(matches).toEqual([{ channel: "stdout", line: 2, rule }]);
    expect(JSON.stringify(matches)).not.toContain(FAKE[name]);
  });

  it("detects keys right after a diff marker", () => {
    const text = `-${FAKE.sk}\n+${FAKE.sk}\n ${FAKE.sk}\n`;
    expect(scanForSecrets(text, { channel: "patch" }).map((match) => match.line)).toEqual([1, 2, 3]);
    expect(redactSecrets(text)).not.toContain(FAKE.sk);
  });

  it("ignores short or unrealistic look-alikes", () => {
    const text = [
      "task-sk-" + "a1".repeat(20),
      "sk-" + "a".repeat(40),
      "gh" + "p_short",
      "AKIA-not-a-key",
      "-----BEGIN PUBLIC KEY-----",
    ].join("\n");
    expect(scanForSecrets(text, { channel: "stderr" })).toEqual([]);
  });

  it("redacts every match and keeps surrounding text", () => {
    const text = `a ${FAKE.github} b ${FAKE.aws} c`;
    expect(redactSecrets(text)).toBe(`a ${MISSION_SECRET_REDACTION} b ${MISSION_SECRET_REDACTION} c`);
    expect(redactSecrets("nothing here")).toBe("nothing here");
  });

  it("redacts an unterminated private key to the end of the text", () => {
    const text = "key:\n-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEbody\nmore";
    expect(scanForSecrets(text, { channel: "final_message" })).toEqual([
      { channel: "final_message", line: 2, rule: "secret.private-key" },
    ]);
    expect(redactSecrets(text)).toBe(`key:\n${MISSION_SECRET_REDACTION}`);
  });
});
