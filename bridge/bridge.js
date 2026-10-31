#!/usr/bin/env node

/**
 * Thunderbird AI Bridge Server
 *
 * HTTP server (port 7700) for CLI requests.
 * WebSocket server (port 7701) for Thunderbird extension.
 * Forwards: CLI HTTP → WebSocket → Extension → response.
 *
 * Usage: node bridge.js [--port 7700] [--ws-port 7701]
 *
 * Environment variables:
 *   TB_BRIDGE_TIMEOUT  default per-request timeout in ms (default: 120000)
 *   TB_AUTH_TOKEN      if set, HTTP requests must present it as `Authorization: Bearer <token>`.
 *                      Unset it to run without authentication. Setting it to an empty value is
 *                      rejected at startup rather than silently disabling authentication.
 *   TB_BRIDGE_CORS_ORIGINS    comma-separated browser origins allowed to call the HTTP API
 *                             (default: the bridge's own http://127.0.0.1 / http://localhost origin)
 *   TB_BRIDGE_ALLOWED_HOSTS   extra comma-separated Host header names to accept, in addition to
 *                             IP literals, localhost, *.localhost and *.internal
 *   TB_BRIDGE_WS_HEARTBEAT_MS WebSocket ping interval used to drop dead extension sockets (default: 30000)
 *   TB_BRIDGE_WS_TAKEOVER_MS  how long a connected extension has to answer a ping before a new
 *                             connection may replace it (default: 2000)
 *   TB_BRIDGE_POLICY          what callers may do: read | draft | organize | full (default: draft,
 *                             i.e. read everything and save drafts, but never send or delete).
 *                             See policy.js.
 *   TB_BRIDGE_MAX_BODY_BYTES  largest accepted request body (default: 10485760 = 10 MiB)
 *   TB_CONFIG_PATH            config file to read instead of ~/.config/thunderbird-cli/config.json
 *
 * The config file shared with tb / tb-mcp may hold `bridge.authToken` and `bridge.policy`, so
 * a background service needs no environment variables. Environment variables take precedence.
 *
 * Per-request override: HTTP clients can pass `X-TB-Timeout: <ms>` header.
 */

import { createServer } from "http";
import { isIP } from "net";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";
import { randomUUID, timingSafeEqual } from "crypto";
import { checkPolicy, parsePolicy } from "./policy.js";

const HTTP_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "7700");
const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--ws-port") || "7701");
const DEFAULT_TIMEOUT = parseInt(process.env.TB_BRIDGE_TIMEOUT || "120000");
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.TB_BRIDGE_WS_HEARTBEAT_MS || "30000");
const TAKEOVER_PROBE_MS = parseInt(process.env.TB_BRIDGE_WS_TAKEOVER_MS || "2000");
const MAX_BODY_BYTES = parseInt(process.env.TB_BRIDGE_MAX_BODY_BYTES || String(10 * 1024 * 1024));

function loadFileConfig() {
  const paths = process.env.TB_CONFIG_PATH
    ? [process.env.TB_CONFIG_PATH]
    : [
        join(homedir(), ".config", "thunderbird-cli", "config.json"),
        join(homedir(), ".config", "thunderbird-ai", "config.json"),
      ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      return { path: p, config: JSON.parse(readFileSync(p, "utf-8").replace(/^\uFEFF/, "")) };
    } catch (e) {
      // A config that exists but can't be read must not silently drop auth or policy.
      console.error(`[bridge] Cannot parse config ${p}: ${e.message}`);
      process.exit(1);
    }
  }
  return { path: null, config: {} };
}
const FILE_CONFIG = loadFileConfig();
const fileBridge = FILE_CONFIG.config.bridge || {};

let POLICY;
try {
  POLICY = parsePolicy(process.env.TB_BRIDGE_POLICY ?? fileBridge.policy ?? "draft");
} catch (e) {
  console.error(`[bridge] ${e.message}`);
  process.exit(1);
}
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.TB_BRIDGE_CORS_ORIGINS || `http://127.0.0.1:${HTTP_PORT},http://localhost:${HTTP_PORT}`)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const EXTRA_ALLOWED_HOSTS = new Set(
  (process.env.TB_BRIDGE_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
// An empty TB_AUTH_TOKEN is a misconfiguration, not a way to disable auth. Failing open here
// would leave the bridge reachable by any local process with nothing in the log to say so.
const RAW_AUTH_TOKEN = process.env.TB_AUTH_TOKEN ?? fileBridge.authToken ?? undefined;
if (RAW_AUTH_TOKEN !== undefined && (typeof RAW_AUTH_TOKEN !== "string" || RAW_AUTH_TOKEN.trim() === "")) {
  console.error(
    "[bridge] TB_AUTH_TOKEN is set but empty (or bridge.authToken in the config file). Refusing " +
      "to start rather than silently disabling authentication — remove it to run without auth."
  );
  process.exit(1);
}
const AUTH_TOKEN = RAW_AUTH_TOKEN ?? null;

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  // RFC 7235: the auth scheme is case-insensitive. Require exactly "<scheme> <token>".
  const parts = (req.headers["authorization"] || "").split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return false;
  const expected = Buffer.from(AUTH_TOKEN);
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ─── Browser-origin defenses ────────────────────────────────────────
// Binding to 127.0.0.1 does not stop a web page in the user's browser from reaching the
// bridge. CORS alone only hides responses: a page can still fire "simple" cross-origin
// POSTs (e.g. compose+send, delete) blindly, and DNS rebinding makes a hostile domain
// same-origin with the bridge. CLI/MCP clients send no Origin header, so rejecting
// unknown origins and non-local Host names costs them nothing.

function getAllowedCorsOrigin(originHeader) {
  if (!originHeader) return null;
  let origin;
  try {
    origin = new URL(originHeader).origin;
  } catch {
    return null;
  }
  return CORS_ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  // DNS rebinding needs a domain name; IP literals can't be rebound. `.internal` is reserved
  // for private use (host.docker.internal, host.containers.internal, ...).
  return (
    isIP(bare) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal") ||
    EXTRA_ALLOWED_HOSTS.has(hostname)
  );
}

// The extension connects from a moz-extension:// origin; non-browser clients send none.
// Web content can only present http(s)/file origins or the opaque "null" origin.
function isWebPageOrigin(originHeader) {
  if (!originHeader) return false;
  return originHeader === "null" || /^(https?|file):/i.test(originHeader);
}

let extensionSocket = null;
const pending = new Map(); // id → { resolve, reject, timer }

// ─── WebSocket Server (for extension) ───────────────────────────────

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: WS_PORT,
  verifyClient: ({ req }) => {
    if (isWebPageOrigin(req.headers.origin)) {
      console.error(`[bridge] Rejected WebSocket connection from web origin ${req.headers.origin}`);
      return false;
    }
    return true;
  },
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const current = extensionSocket;
  if (!current || current.readyState !== 1) {
    attachExtension(ws);
    return;
  }

  // The slot is taken. Hand it over only if the connected extension stops answering a ping
  // (e.g. a half-open socket after sleep); otherwise any local process could silently take the
  // slot and read or forge every request.
  let answered = false;
  const onPong = () => {
    answered = true;
  };
  current.once("pong", onPong);
  current.ping();
  setTimeout(() => {
    current.off("pong", onPong);
    if (ws.readyState !== 1) return;
    if (answered && current.readyState === 1) {
      console.error("[bridge] Rejected another extension connection: the connected extension is still responding");
      ws.close(1008, "An extension is already connected");
      return;
    }
    console.log("[bridge] Connected extension is unresponsive; replacing it");
    current.terminate();
    attachExtension(ws);
  }, TAKEOVER_PROBE_MS);
});

function attachExtension(ws) {
  console.log("[bridge] Extension connected");
  extensionSocket = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(msg.error);
        } else {
          p.resolve(msg.result);
        }
      }
    } catch (e) {
      console.error("[bridge] Bad message from extension:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("[bridge] Extension disconnected");
    if (extensionSocket === ws) extensionSocket = null;
    // Requests already handed to this socket will never be answered: fail them now instead of
    // letting each one wait out its full timeout (up to minutes for big searches).
    for (const [id, p] of pending) {
      if (p.socket !== ws) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject({ message: "Thunderbird extension disconnected before answering", code: "EXTENSION_DISCONNECTED" });
    }
  });
}

// Terminate sockets that stop answering pings (e.g. after the host slept), so requests fail
// fast with EXTENSION_DISCONNECTED instead of hanging until the per-request timeout.
const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    if (client.readyState === 1) client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

// ─── Forward request to extension ───────────────────────────────────

/** Tell the extension to stop working on a request nobody waits for any more. */
function cancelOnExtension(socket, id) {
  try {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ id, cancel: true }));
  } catch {}
}

/**
 * Forward a request. The extension gets `timeoutMs` so long searches can stop in time and
 * return what they found (partial) instead of being cut off with nothing; if the bridge still
 * gives up (timeout) or the HTTP client goes away (`signal`), the extension is told to cancel,
 * so Thunderbird stops searching instead of grinding on in the background.
 */
function forwardToExtension(method, path, body, timeoutMs = DEFAULT_TIMEOUT, signal = null) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject({ message: "Thunderbird extension not connected. Is Thunderbird running?", code: "EXTENSION_DISCONNECTED" });
      return;
    }
    const id = randomUUID();
    const socket = extensionSocket;
    const timer = setTimeout(() => {
      pending.delete(id);
      cancelOnExtension(socket, id);
      reject({ message: `Request timed out (${Math.round(timeoutMs / 1000)}s)`, code: "TIMEOUT" });
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, socket });
    signal?.addEventListener("abort", () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      cancelOnExtension(socket, id);
      reject({ message: "Client disconnected", code: "CLIENT_GONE" });
    }, { once: true });
    socket.send(JSON.stringify({ id, method, path, body, timeoutMs }));
  });
}

// ─── HTTP Server (for CLI) ──────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  // Leave closing the connection to the client. If the client sends "Connection: close"
  // (Python urllib, many scripts), Node otherwise closes right after a large response, and on
  // Windows that intermittently arrives as a TCP reset before the client has read everything
  // (seen with ~460 KB attachment downloads: ~1 in 5 failed). Idle sockets still close after
  // the server keep-alive timeout.
  res.setHeader("Connection", "keep-alive");

  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(403);
    res.end(
      JSON.stringify({
        error: `Host "${req.headers.host}" not allowed. Add it to TB_BRIDGE_ALLOWED_HOSTS if this is intended.`,
        code: "FORBIDDEN",
      })
    );
    return;
  }

  const allowedOrigin = getAllowedCorsOrigin(req.headers.origin);
  if (req.headers.origin && !allowedOrigin) {
    res.writeHead(403);
    res.end(
      JSON.stringify({
        error: "CORS origin not allowed. Add it to TB_BRIDGE_CORS_ORIGINS if this is intended.",
        code: "FORBIDDEN",
      })
    );
    return;
  }
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-TB-Timeout");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401);
    res.end(
      JSON.stringify({
        error: "Missing or invalid Authorization token. Set TB_AUTH_TOKEN for this client.",
        code: "AUTH_REQUIRED",
      })
    );
    return;
  }

  // Bridge status endpoint (doesn't need extension)
  if (req.url === "/bridge/status") {
    const status = {
      bridge: "running",
      extension: extensionSocket ? "connected" : "disconnected",
      httpPort: HTTP_PORT,
      wsPort: WS_PORT,
      defaultTimeoutMs: DEFAULT_TIMEOUT,
      policy: POLICY,
    };
    res.writeHead(200);
    res.end(JSON.stringify(status));
    return;
  }

  // Read body (bounded: the bridge buffers it whole before forwarding)
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: `Request body larger than ${MAX_BODY_BYTES} bytes`, code: "PAYLOAD_TOO_LARGE" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  let parsedBody = null;
  if (body.trim()) {
    try {
      parsedBody = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
  }

  const denied = checkPolicy(POLICY, req.method, req.url, parsedBody);
  if (denied) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: denied, code: "POLICY_DENIED", policy: POLICY }));
    return;
  }

  // Per-request timeout override via X-TB-Timeout header
  let timeoutMs = DEFAULT_TIMEOUT;
  const headerTimeout = req.headers["x-tb-timeout"];
  if (headerTimeout) {
    const parsed = parseInt(headerTimeout);
    if (parsed > 0) timeoutMs = parsed;
  }

  // Forward to extension; if the client hangs up first, cancel the work in Thunderbird.
  const clientGone = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) clientGone.abort();
  });
  try {
    const result = await forwardToExtension(req.method, req.url, parsedBody, timeoutMs, clientGone.signal);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err.code === "CLIENT_GONE") return;
    // Always name the failure: a timeout must never look like an empty result to a client.
    const code = err.code || "THUNDERBIRD_ERROR";
    const status = code === "EXTENSION_DISCONNECTED" ? 503 : code === "TIMEOUT" ? 504 : 500;
    res.writeHead(status);
    res.end(JSON.stringify({ error: err.message || "Unknown error", code }));
  }
});

// A taken port is the most common startup failure (often an editor's port forwarding); explain it
// instead of crashing with an unhandled 'error' event.
function onServerError(label, port) {
  return (err) => {
    if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
      console.error(`[bridge] ${label} server error:`, err.message);
      return;
    }
    console.error(`[bridge] Cannot listen on 127.0.0.1:${port} (${label}): ${err.code === "EADDRINUSE" ? "port already in use" : "permission denied"}.`);
    console.error(
      process.platform === "win32"
        ? `[bridge] See what holds it:  Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess  (or: netstat -ano | findstr :${port})`
        : `[bridge] See what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN`
    );
    console.error(
      label === "WebSocket"
        ? `[bridge] The Thunderbird extension always connects to ws://127.0.0.1:${port}, so free this port (e.g. stop editor port forwarding) rather than changing it.`
        : `[bridge] Or pick another HTTP port: --port <n>, and set TB_BRIDGE_PORT=<n> for tb / tb-mcp.`
    );
    process.exit(1);
  };
}
wss.on("error", onServerError("WebSocket", WS_PORT));
httpServer.on("error", onServerError("HTTP", HTTP_PORT));

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`[bridge] HTTP server on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[bridge] WebSocket server on ws://127.0.0.1:${WS_PORT}`);
  console.log(`[bridge] Default timeout: ${DEFAULT_TIMEOUT}ms (override via TB_BRIDGE_TIMEOUT env or X-TB-Timeout header)`);
  console.log(
    AUTH_TOKEN
      ? "[bridge] Auth: enabled (Authorization: Bearer required on all HTTP requests)"
      : "[bridge] Auth: disabled — any local process can call this bridge (set TB_AUTH_TOKEN to require a token)"
  );
  console.log(
    `[bridge] Policy: ${POLICY}` +
      (POLICY === "full" ? " — callers may send mail and delete messages" : " (raise with TB_BRIDGE_POLICY / bridge.policy)")
  );
  if (FILE_CONFIG.path) console.log(`[bridge] Config: ${FILE_CONFIG.path}`);
  console.log(`[bridge] Waiting for Thunderbird extension to connect...`);
});
