#!/usr/bin/env node
// cockpit-capture.mjs — drive the osstack cockpit in headless Chrome over CDP.
// Verification scaffolding: needs Node >=22 (global WebSocket) and Chrome/Chromium.
// Usage: node cockpit-capture.mjs <url> <out-prefix> [--wait-text TEXT] [--timeout-ms N]
// Writes <out-prefix>.png, <out-prefix>.dom.html, <out-prefix>.text.txt; exits 1 if the cockpit
// (#board present, #generated no longer 'loading...') or TEXT never renders before the timeout.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) { console.error("usage: cockpit-capture.mjs <url> <out-prefix> [--wait-text TEXT] [--timeout-ms N]"); process.exit(2); }
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const waitText = flag("--wait-text");
const timeoutMs = Number(flag("--timeout-ms") ?? 20000);
const chromeBin = process.env.CHROME_BIN ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!chromeBin) { console.error("no Chrome/Chromium found; set CHROME_BIN"); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), "osstack-verify-chrome-"));
const chrome = spawn(chromeBin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1280,1800", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + timeoutMs;
let code = 1;
try {
  let port;
  while (!port && Date.now() < deadline) {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await sleep(100); }
  }
  if (!port) throw new Error("Chrome did not expose a DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  await send("Page.navigate", { url });
  let found = false;
  while (Date.now() < deadline) {
    const ready = await evaluate("document.readyState === 'complete' && !!document.querySelector('#board') && document.querySelector('#generated')?.textContent !== 'loading...'");
    if (ready && (waitText === undefined || (await evaluate(`document.body.innerText.includes(${JSON.stringify(waitText)})`)))) { found = true; break; }
    await sleep(250);
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${out}.png`, Buffer.from(shot.result.data, "base64"));
  writeFileSync(`${out}.dom.html`, await evaluate("document.documentElement.outerHTML"));
  writeFileSync(`${out}.text.txt`, await evaluate("document.body.innerText"));
  console.log(`${found ? "rendered" : "TIMEOUT"}${waitText ? ` wait-text=${JSON.stringify(waitText)}` : ""} url=${url}`);
  console.log(`evidence: ${out}.png ${out}.dom.html ${out}.text.txt`);
  code = found ? 0 : 1;
  ws.close();
} catch (e) {
  console.error(`cockpit-capture: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  chrome.kill("SIGTERM");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
