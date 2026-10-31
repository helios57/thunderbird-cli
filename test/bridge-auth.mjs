#!/usr/bin/env node
/**
 * Bridge authentication tests.
 *
 * Spawns the real bridge/bridge.js as a subprocess (not a mock) and exercises the
 * TB_AUTH_TOKEN enforcement path against /bridge/status, which answers without the
 * Thunderbird extension being connected.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "bridge.js");
const PORT = 19710;
const WS_PORT = 19711;
const TOKEN = "test-token-abc123";

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

/** Build a child env, treating an `undefined` value as "remove this variable". */
function childEnv(overrides) {
  const env = { ...process.env, TB_CONFIG_PATH: join(dirname(fileURLToPath(import.meta.url)), "__no_config__.json"), ...overrides };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
  }
  return env;
}

/** Start the bridge with the given env; resolves once it is listening. */
function startBridge(overrides) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BRIDGE, "--port", String(PORT), "--ws-port", String(WS_PORT)], {
      env: childEnv(overrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (chunk) => {
      out += chunk.toString();
      if (out.includes("Waiting for Thunderbird extension")) resolve({ proc, out });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`bridge exited early (code ${code}): ${out}`)));
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

async function status(headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`, { headers });
  return res.status;
}

async function statusBody(headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/bridge/status`, { headers });
  return res.json();
}

/** Run the bridge with `env`, hand it to `fn`, then shut it down. */
async function withBridge(env, fn) {
  const { proc, out } = await startBridge(env);
  try {
    await fn(out);
  } finally {
    await stopBridge(proc);
  }
}

console.log("\n\x1b[1mAuth disabled (TB_AUTH_TOKEN unset)\x1b[0m");
await withBridge({ TB_AUTH_TOKEN: undefined }, async (out) => {
  test("request without a token succeeds", await status(), 200);
  test("startup log reports auth disabled", out.includes("Auth: disabled"), true);
});

console.log("\n\x1b[1mAuth enabled\x1b[0m");
await withBridge({ TB_AUTH_TOKEN: TOKEN }, async (out) => {
  test("startup log reports auth enabled", out.includes("Auth: enabled"), true);
  test("no Authorization header is rejected", await status(), 401);
  test("wrong token is rejected", await status({ Authorization: "Bearer wrong-token-abc12" }), 401);
  test("correct token is accepted", await status({ Authorization: `Bearer ${TOKEN}` }), 200);
  test("scheme is case-insensitive (RFC 7235)", await status({ Authorization: `bearer ${TOKEN}` }), 200);
  test("wrong scheme is rejected", await status({ Authorization: `Basic ${TOKEN}` }), 401);
  test("bare token without a scheme is rejected", await status({ Authorization: TOKEN }), 401);
  test("token with trailing content is rejected", await status({ Authorization: `Bearer ${TOKEN} extra` }), 401);
  test("empty Authorization header is rejected", await status({ Authorization: "" }), 401);
  test("token that is a prefix of the real one is rejected", await status({ Authorization: "Bearer test-token-abc12" }), 401);
  // Clients map an unrecognised 4xx to THUNDERBIRD_ERROR, which would misreport an auth
  // failure as a Thunderbird problem. The bridge names it so they surface it correctly.
  test("401 body carries the AUTH_REQUIRED code", (await statusBody()).code, "AUTH_REQUIRED");
});

console.log("\n\x1b[1mEmpty TB_AUTH_TOKEN fails closed\x1b[0m");
{
  const proc = spawn(process.execPath, [BRIDGE, "--port", String(PORT), "--ws-port", String(WS_PORT)], {
    env: childEnv({ TB_AUTH_TOKEN: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c.toString()));
  proc.stderr.on("data", (c) => (out += c.toString()));
  const code = await new Promise((resolve) => proc.on("exit", resolve));
  test("bridge refuses to start", code, 1);
  test("reason is logged", out.includes("TB_AUTH_TOKEN is set but empty"), true);
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
