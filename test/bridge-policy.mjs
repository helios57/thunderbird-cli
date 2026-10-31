#!/usr/bin/env node
/**
 * Bridge access-policy, config-file, body-limit and disconnect tests.
 *
 * Unit-tests bridge/policy.js, then spawns the real bridge/bridge.js with a mock extension on
 * the WebSocket side to check that the policy is enforced before anything reaches Thunderbird.
 */

import { spawn } from "child_process";
import { request } from "http";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WebSocket } from "ws";
import { checkPolicy, parsePolicy, requiredLevel } from "../bridge/policy.js";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "bridge.js");
const PORT = 19740;
const WS_PORT = 19741;
const NO_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "__no_config__.json");

let passed = 0, failed = 0;
function test(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} — expected ${expected}, got ${actual}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── policy.js ──────────────────────────────────────────────────────

console.log("\n\x1b[1m=== bridge policy tests ===\x1b[0m");
console.log("\n\x1b[1mClassification\x1b[0m");
test("GET routes are read", requiredLevel("GET", "/messages/12/full"), "read");
test("search is read", requiredLevel("POST", "/messages/search", {}), "read");
test("attachment download is read", requiredLevel("POST", "/messages/12/attachment", {}), "read");
test("compose as draft is draft", requiredLevel("POST", "/compose", { draft: true }), "draft");
test("reply opened for a human is draft", requiredLevel("POST", "/reply", { open: true }), "draft");
test("compose with send is full", requiredLevel("POST", "/compose", { send: true }), "full");
test("forward with send is full", requiredLevel("POST", "/forward", { send: true }), "full");
test("mark read is organize", requiredLevel("POST", "/messages/update", {}), "organize");
test("move is organize", requiredLevel("POST", "/messages/move", {}), "organize");
test("delete is full", requiredLevel("POST", "/messages/delete", {}), "full");
test("folder delete is full", requiredLevel("POST", "/folders/delete", {}), "full");
test("bulk delete is full", requiredLevel("POST", "/bulk/delete", {}), "full");
test("unknown POST route is locked to full", requiredLevel("POST", "/something/new", {}), "full");
test("query string does not dodge classification", requiredLevel("POST", "/messages/delete?x=1", {}), "full");
test("PUT/DELETE methods are full", requiredLevel("DELETE", "/messages/search", {}), "full");

console.log("\n\x1b[1mLevels\x1b[0m");
test("read blocks drafts", checkPolicy("read", "POST", "/compose", {}) !== null, true);
test("draft allows drafts", checkPolicy("draft", "POST", "/compose", {}), null);
test("draft blocks sending", checkPolicy("draft", "POST", "/compose", { send: true }) !== null, true);
test("draft blocks mark read", checkPolicy("draft", "POST", "/messages/update", {}) !== null, true);
test("organize allows move", checkPolicy("organize", "POST", "/messages/move", {}), null);
test("organize blocks delete", checkPolicy("organize", "POST", "/messages/delete", {}) !== null, true);
test("full allows send", checkPolicy("full", "POST", "/compose", { send: true }), null);
test("send denial explains the draft alternative", /draft/.test(checkPolicy("organize", "POST", "/reply", { send: true })), true);
test("policy names are case-insensitive", parsePolicy(" Organize "), "organize");
let threw = false;
try { parsePolicy("everything"); } catch { threw = true; }
test("unknown policy name is rejected", threw, true);

// ─── Spawned bridge ─────────────────────────────────────────────────

function startBridge(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BRIDGE, "--port", String(PORT), "--ws-port", String(WS_PORT)], {
      env: { ...process.env, TB_AUTH_TOKEN: undefined, TB_BRIDGE_POLICY: undefined, TB_CONFIG_PATH: NO_CONFIG, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (chunk) => {
      out += chunk.toString();
      if (out.includes("Waiting for Thunderbird extension")) resolve({ proc, out: () => out });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(Object.assign(new Error(`bridge exited (code ${code}): ${out}`), { code, out })));
    setTimeout(() => reject(new Error(`bridge did not start: ${out}`)), 5000);
  });
}

function stopBridge(proc) {
  return new Promise((resolve) => {
    proc.removeAllListeners("exit");
    proc.on("exit", resolve);
    proc.kill();
  });
}

/** Mock extension: echoes each request; `hold` = never answer (to test disconnects). */
function connectExtension({ hold = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.received = [];
    ws.on("message", (d) => {
      const r = JSON.parse(d.toString());
      ws.received.push(r);
      if (!hold) ws.send(JSON.stringify({ id: r.id, result: { echoed: r.path, body: r.body } }));
    });
    ws.on("open", () => resolve(ws));
  });
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

console.log("\n\x1b[1mDefault policy (draft)\x1b[0m");
{
  const { proc, out } = await startBridge();
  const ext = await connectExtension();
  await sleep(50);
  test("startup log names the policy", /Policy: draft/.test(out()), true);
  test("status reports the policy", (await call("GET", "/bridge/status")).json?.policy, "draft");
  test("search passes", (await call("POST", "/messages/search", { query: "x" })).json?.echoed, "/messages/search");
  test("draft compose passes", (await call("POST", "/compose", { to: "a@b.c", body: "x", draft: true })).json?.echoed, "/compose");
  const send = await call("POST", "/compose", { to: "a@b.c", body: "x", send: true });
  test("send is refused with 403", send.status, 403);
  test("refusal carries POLICY_DENIED", send.json?.code, "POLICY_DENIED");
  test("delete is refused", (await call("POST", "/messages/delete", { messageIds: [1] })).status, 403);
  test("mark read is refused at draft", (await call("POST", "/messages/update", { messageId: 1, read: true })).status, 403);
  test("refused requests never reach Thunderbird", ext.received.some((r) => ["/messages/delete", "/messages/update"].includes(r.path) || r.body?.send), false);
  ext.close();
  await stopBridge(proc);
}

console.log("\n\x1b[1mEnvironment overrides\x1b[0m");
{
  const { proc } = await startBridge({ TB_BRIDGE_POLICY: "full" });
  await connectExtension();
  await sleep(50);
  test("full policy forwards send", (await call("POST", "/compose", { send: true })).json?.echoed, "/compose");
  await stopBridge(proc);
}
{
  let err = null;
  try { await startBridge({ TB_BRIDGE_POLICY: "yolo" }); } catch (e) { err = e; }
  test("unknown policy aborts startup", err?.code, 1);
}

console.log("\n\x1b[1mConfig file\x1b[0m");
const dir = mkdtempSync(join(tmpdir(), "tb-bridge-cfg-"));
const cfg = join(dir, "config.json");
writeFileSync(cfg, "\uFEFF" + JSON.stringify({ bridge: { authToken: "s3cret-token", policy: "organize" } }));
{
  const { proc, out } = await startBridge({ TB_CONFIG_PATH: cfg });
  await connectExtension();
  await sleep(50);
  test("token from config file enforces auth", (await call("POST", "/messages/search", {})).status, 401);
  const auth = { Authorization: "Bearer s3cret-token" };
  test("token from config file is accepted (BOM tolerated)", (await call("POST", "/messages/search", {}, auth)).status, 200);
  test("policy from config file applies (organize allows move)", (await call("POST", "/messages/move", { messageIds: [1] }, auth)).status, 200);
  test("policy from config file applies (organize blocks delete)", (await call("POST", "/messages/delete", { messageIds: [1] }, auth)).status, 403);
  test("startup log names the config file", out().includes(cfg), true);
  await stopBridge(proc);
}
{
  const { proc } = await startBridge({ TB_CONFIG_PATH: cfg, TB_BRIDGE_POLICY: "read" });
  await connectExtension();
  await sleep(50);
  test("environment policy beats config policy", (await call("POST", "/messages/move", {}, { Authorization: "Bearer s3cret-token" })).status, 403);
  await stopBridge(proc);
}
writeFileSync(cfg, "{ not json");
{
  let err = null;
  try { await startBridge({ TB_CONFIG_PATH: cfg }); } catch (e) { err = e; }
  test("unreadable config aborts startup instead of dropping auth", err?.code, 1);
}
writeFileSync(cfg, JSON.stringify({ bridge: { authToken: "" } }));
{
  let err = null;
  try { await startBridge({ TB_CONFIG_PATH: cfg }); } catch (e) { err = e; }
  test("empty token in config aborts startup", err?.code, 1);
}
rmSync(dir, { recursive: true, force: true });

console.log("\n\x1b[1mBody limit and disconnects\x1b[0m");
{
  const { proc } = await startBridge({ TB_BRIDGE_MAX_BODY_BYTES: "1000" });
  const ext = await connectExtension({ hold: true });
  await sleep(50);
  const big = await call("POST", "/messages/search", JSON.stringify({ query: "x".repeat(5000) }));
  test("oversized body gets 413", big.status, 413);
  const t0 = Date.now();
  const inflight = call("POST", "/messages/search", { query: "slow" }, { "X-TB-Timeout": "20000" });
  await sleep(150);
  ext.close();
  const res = await inflight;
  test("in-flight request fails when the extension drops", res.status, 503);
  test("…immediately, not after its timeout", Date.now() - t0 < 5000, true);
  test("…with EXTENSION_DISCONNECTED", res.json?.code, "EXTENSION_DISCONNECTED");
  await stopBridge(proc);
}

console.log("\n\x1b[1mTime budget and cancellation\x1b[0m");
{
  const { proc } = await startBridge();
  const ext = await connectExtension({ hold: true });
  await sleep(50);
  const res = await call("POST", "/messages/search", { query: "slow" }, { "X-TB-Timeout": "300" });
  await sleep(100);
  const req = ext.received.find((r) => r.path === "/messages/search");
  test("the extension is told the time budget", req?.timeoutMs, 300);
  test("a timed-out request still answers 504", res.status, 504);
  test("…and the extension is told to cancel it", ext.received.some((r) => r.cancel === true && r.id === req?.id), true);

  ext.received.length = 0;
  const ac = new AbortController();
  const gone = fetch(`http://127.0.0.1:${PORT}/messages/search`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-TB-Timeout": "20000" },
    body: JSON.stringify({ query: "slow" }), signal: ac.signal,
  }).catch(() => null);
  await sleep(150);
  ac.abort();
  await gone;
  await sleep(150);
  const req2 = ext.received.find((r) => r.path === "/messages/search");
  test("a client that hangs up cancels the work in Thunderbird", ext.received.some((r) => r.cancel === true && r.id === req2?.id), true);
  ext.close();
  await stopBridge(proc);
}

console.log("\n\x1b[1mConnection handling\x1b[0m");
{
  const { proc } = await startBridge();
  const ext = await connectExtension();
  await sleep(50);
  // A client asking to close must still get keep-alive: the bridge leaves closing to the client
  // (on Windows, Node closing first intermittently resets large responses before they are read).
  const headers = await new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port: PORT, path: "/messages/search", method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers));
    });
    r.end("{}");
  });
  test("responses keep the connection open even if the client asks to close", headers.connection, "keep-alive");
  ext.close();
  await stopBridge(proc);
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
