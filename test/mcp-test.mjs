#!/usr/bin/env node

/**
 * MCP server integration test
 *
 * Spawns a mock bridge + the MCP server, sends MCP JSON-RPC requests via stdio,
 * and verifies every tool returns correct results.
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, randomUUID as uuid } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dirname, "../mcp/src/server.js");
const PORT = 19800;
const WS_PORT = 19801;

const updates = [];
const deletes = [];
const DRAFT_IDS = new Set([501, 502]);
let passed = 0,
  failed = 0;
const failures = [];

// ─── Mock bridge handler ───────────────────────────────────────────

const attached = (body) => (body?.attachments?.length ? { attachments: body.attachments.map((a) => ({ name: a.name })) } : {});

function handle({ method, path, body }) {
  if (path === "/health") return { status: "ok", version: "2.0.0", thunderbird: true };
  if (path === "/accounts" && method === "GET")
    return [
      {
        id: "acct1",
        name: "Test",
        type: "imap",
        identities: [{ id: "id1", email: "t@t.com", name: "T" }],
        rootFolder: { id: "rf", name: "" },
      },
    ];
  if (path?.match(/^\/accounts\/[^/]+\/folders$/))
    return [
      {
        id: "f1",
        name: "Inbox",
        path: "/Inbox",
        type: "inbox",
        unreadMessageCount: 5,
        totalMessageCount: 50,
        depth: 0,
      },
    ];
  if (path === "/folders/info")
    return {
      id: body?.folderId,
      name: "Inbox",
      type: "inbox",
      unreadMessageCount: 5,
      totalMessageCount: 50,
    };
  if (path === "/messages/search")
    return {
      messages: [
        {
          id: 1,
          subject: "Test",
          author: "a@b.com",
          date: "2026-04-01",
          read: false,
          flagged: false,
          junk: false,
          size: 100,
          tags: [],
        },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
      _body: body,
    };
  if (path === "/messages/list")
    return {
      messages: [
        {
          id: 1,
          subject: "Test",
          author: "a@b.com",
          date: "2026-04-01",
          read: false,
          flagged: false,
          junk: false,
          size: 100,
          tags: [],
        },
      ],
      total: 1,
    };
  if (path === "/messages/77" && method === "GET")
    return {
      id: 77, subject: "Rechnung", author: "shop@example.ch", ccList: [], bccList: [], tags: [],
      parts: {
        text: "",
        html: "<html><head><style>p{color:red}</style></head><body><p>Rechnung &amp; Betrag:<br>CHF&nbsp;12.50 f&uuml;r M&auml;rz</p><a href=\"https://pay.example.ch/x\">Jetzt zahlen</a><script>track()</script></body></html>",
        attachments: [],
      },
    };
  if (path === "/messages/78" && method === "GET")
    return { id: 78, subject: "Long", parts: { text: "x".repeat(30000), html: "<p>" + "x".repeat(30000) + "</p>", attachments: [] } };
  if (path === "/identities") return [{ id: "id1", email: "t@t.com", name: "T", accountId: "acct1" }];
  if (path === "/recent") return { messages: [{ id: 5, subject: "Neu", tags: [], ccList: [] }], total: 1, _body: body };
  if (path?.match(/^\/messages\/\d+$/) && method === "GET")
    return {
      id: 1,
      subject: "Test",
      author: "a@b.com",
      date: "2026-04-01",
      parts: { text: "Hello world body text", html: "", attachments: [] },
    };
  if (path?.match(/\/raw$/)) return { raw: "From: a@b.com\nSubject: Test\n\nBody" };
  if (path?.match(/\/headers$/)) return { id: 1, subject: "Test", author: "a@b.com", tags: ["$label1", "$label2"] };
  if (path?.match(/\/full$/))
    return { id: 1, subject: "Test", parts: { text: "Hello", html: "<p>Hi</p>", attachments: [] } };
  if (path?.match(/\/check-download$/))
    return { id: 1, downloadState: "full", size: 100, hasBody: true };
  if (path?.match(/\/thread$/)) return { thread: [{ id: 1, subject: "Test" }], count: 1 };
  if (path?.match(/\/attachments$/))
    return [{ name: "f.pdf", contentType: "application/pdf", partName: "1.2", size: 5000 }];
  if (path?.match(/\/attachment$/) && method === "POST")
    return { name: "f.pdf", size: 5000, contentType: "application/pdf", data: "SGVsbG8=" };
  if (path === "/messages/move") return { success: true, moved: (body?.messageIds || []).length };
  if (path === "/messages/delete") {
    deletes.push({ ...body, route: "delete" });
    return { success: true, deleted: (body?.messageIds || []).length, ...(body?.permanent ? { permanent: true } : {}) };
  }
  if (path === "/messages/trash" && (body?.messageIds || []).includes(999)) {
    return { error: "Not found: POST /messages/trash" }; // an add-on without the route
  }
  if (path === "/messages/trash") {
    deletes.push(body);
    const ids = body?.messageIds || [];
    if (body?.draftsOnly) {
      const drafts = ids.filter((id) => DRAFT_IDS.has(id));
      const others = ids.filter((id) => !DRAFT_IDS.has(id));
      return { success: true, deleted: drafts.length, movedTo: "trash", ...(others.length ? { notDrafts: others } : {}) };
    }
    const inTrash = ids.filter((id) => id === 777);
    return { success: true, deleted: ids.length - inTrash.length, movedTo: "trash", ...(inTrash.length ? { alreadyInTrash: inTrash, note: "in trash" } : {}) };
  }
  if (path === "/messages/archive") return { success: true, archived: (body?.messageIds || []).length };
  if (path === "/messages/update") { updates.push(body); return { success: true }; }
  if (path === "/drafts/update")
    return { success: true, action: body?.send ? "sent" : "draft_saved", draftId: 901, replacedDraftId: body?.draftId,
      ...attached(body), _body: body };
  if (path === "/compose" && body?.subject === "__old_addon__")
    return { success: true, action: "draft_saved" }; // an add-on that ignores attachments
  if (path === "/compose")
    return { success: true, action: body?.send ? "sent" : body?.open ? "draft_opened" : "draft_saved", draftId: 900, ...attached(body), _body: body };
  if (path === "/reply") return { success: true, action: body?.send ? "sent" : "draft_saved", ...attached(body), _body: body };
  if (path === "/forward") return { success: true, action: body?.send ? "sent" : "draft_saved", ...attached(body), _body: body };
  if (path === "/stats")
    return { totalAccounts: 1, totalUnread: 5, totalMessages: 100, accounts: [] };
  if (path === "/sync") return { success: true, synced: body?.all ? "all" : body?.folderId };
  return { error: `Not found: ${method} ${path}` };
}

// ─── Bridge servers ────────────────────────────────────────────────

async function startBridge() {
  return new Promise((resolve) => {
    const pending = new Map();
    let extSock = null;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
    wss.on("connection", (ws) => {
      extSock = ws;
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          clearTimeout(p.timer);
          p.resolve(m.result);
        }
      });
    });
    const httpServer = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/bridge/status") {
        res.writeHead(200);
        res.end(JSON.stringify({ bridge: "running", extension: "connected" }));
        return;
      }
      let b = "";
      for await (const c of req) b += c;
      let pb = null;
      if (b.trim())
        try {
          pb = JSON.parse(b);
        } catch {}
      // Bridge policy "draft": deleting anything but drafts is refused (id 403 stands for such a mail).
      if (req.url === "/messages/trash" && !pb?.draftsOnly && pb?.messageIds?.includes(403)) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Moving mail other than drafts to the trash needs bridge policy "organize", but it is "draft".', code: "POLICY_DENIED" }));
        return;
      }
      if (req.url === "/messages/search" && pb?.query === "__timeout__") {
        res.writeHead(504);
        res.end(JSON.stringify({ error: "Request timed out (120s)", code: "TIMEOUT" }));
        return;
      }
      try {
        const result = await new Promise((resolve, reject) => {
          if (!extSock || extSock.readyState !== 1) {
            reject(new Error("no ext"));
            return;
          }
          const id = uuid();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("timeout"));
          }, 5000);
          pending.set(id, { resolve, reject, timer });
          extSock.send(JSON.stringify({ id, method: req.method, path: req.url, body: pb }));
        });
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    httpServer.listen(PORT, "127.0.0.1", () => {
      const mock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      mock.on("open", () => resolve({ httpServer, wss, mock }));
      mock.on("message", (d) => {
        const r = JSON.parse(d.toString());
        mock.send(JSON.stringify({ id: r.id, result: handle(r) }));
      });
    });
  });
}

// ─── MCP client (over stdio) ───────────────────────────────────────

class McpClient {
  constructor(serverPath, env) {
    this.proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            p.resolve(msg);
          }
        } catch {}
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  async initialize() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    this.notify("notifications/initialized");
  }

  async listTools() {
    const r = await this.send("tools/list", {});
    return r.result?.tools || [];
  }

  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.result?.content?.[0]?.text) {
      try {
        return JSON.parse(r.result.content[0].text);
      } catch {
        return r.result.content[0].text;
      }
    }
    return r.result;
  }

  close() {
    this.proc.kill();
  }
}

// ─── Test runner ───────────────────────────────────────────────────

function test(name, result, check) {
  if (check(result)) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push({ name, result });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${JSON.stringify(result).slice(0, 200)}`);
  }
}

const servers = await startBridge();
await new Promise((r) => setTimeout(r, 300));

const DOWNLOAD_DIR = mkdtempSync(join(tmpdir(), "tb-mcp-dl-"));
const client = new McpClient(MCP_SERVER, {
  TB_BRIDGE_HOST: "127.0.0.1",
  TB_BRIDGE_PORT: String(PORT),
  TB_MCP_DOWNLOAD_DIR: DOWNLOAD_DIR,
  TB_CONFIG_PATH: join(__dirname, "__no_config__.json"),
});

console.log("\n\x1b[1m=== thunderbird-cli MCP Server Tests ===\x1b[0m\n");

await client.initialize();

console.log("\x1b[1mProtocol\x1b[0m");
const toolList = await client.listTools();
test("tools/list returns 14 tools", toolList, (r) => Array.isArray(r) && r.length === 14);
test("each tool has name+description+inputSchema", toolList, (r) =>
  r.every((t) => t.name && t.description && t.inputSchema)
);
test("read tools are annotated read-only", toolList, (r) =>
  r.find((t) => t.name === "email_search")?.annotations?.readOnlyHint === true &&
  r.find((t) => t.name === "email_archive")?.annotations?.destructiveHint === true
);

console.log("\n\x1b[1mTools (14)\x1b[0m");

test("email_stats", await client.callTool("email_stats", {}), (r) => r.totalAccounts === 1);
test(
  "email_stats with accountId",
  await client.callTool("email_stats", { accountId: "acct1" }),
  (r) => r.totalAccounts !== undefined
);
test(
  "email_stats includeFolders",
  await client.callTool("email_stats", { includeFolders: true }),
  (r) => r.totalAccounts !== undefined
);

test(
  "email_search basic",
  await client.callTool("email_search", { query: "test" }),
  (r) => r.messages?.length >= 0
);
test(
  "email_search with filters",
  await client.callTool("email_search", {
    query: "test",
    unread: true,
    since: "7d",
    limit: 5,
  }),
  (r) => r.messages !== undefined
);
test(
  "email_search with filters and no query",
  await client.callTool("email_search", { subject: "invoice", unread: true, limit: 5 }),
  (r) => r.messages !== undefined && !("query" in r._body) && r._body.subject === "invoice"
);
test(
  "email_search passes searchMode through",
  await client.callTool("email_search", { query: "x", searchMode: "body" }),
  (r) => r._body?.searchMode === "body"
);
test(
  "email_search timeout is reported as TIMEOUT with 'results unknown', not as empty",
  await client.callTool("email_search", { query: "__timeout__" }),
  (r) => r.code === "TIMEOUT" && /UNKNOWN, not empty/.test(r.error) && r.messages === undefined
);
test(
  "email_search without query or filters returns INVALID_ARGS",
  await client.callTool("email_search", {}),
  (r) => r.code === "INVALID_ARGS"
);
test(
  "email_search with whitespace-only query and no filters returns INVALID_ARGS",
  await client.callTool("email_search", { query: "   ", includeJunk: true }),
  (r) => r.code === "INVALID_ARGS"
);

test(
  "email_list",
  await client.callTool("email_list", { folderId: "f1" }),
  (r) => r.messages !== undefined
);
test(
  "email_list with sort",
  await client.callTool("email_list", { folderId: "f1", sort: "date", sortOrder: "desc" }),
  (r) => r.messages !== undefined
);

test(
  "email_read default",
  await client.callTool("email_read", { messageId: 1 }),
  (r) => r.id === 1 && r.parts
);
test(
  "email_read headers",
  await client.callTool("email_read", { messageId: 1, mode: "headers" }),
  (r) => r.id === 1
);
test(
  "email_read full",
  await client.callTool("email_read", { messageId: 1, mode: "full" }),
  (r) => r.parts?.html !== undefined
);
test(
  "email_read raw",
  await client.callTool("email_read", { messageId: 1, mode: "raw" }),
  (r) => r.raw
);
test(
  "email_read with maxBody",
  await client.callTool("email_read", { messageId: 1, maxBody: 5 }),
  (r) => r.parts?.textTruncated === true
);

test(
  "email_thread",
  await client.callTool("email_thread", { messageId: 1 }),
  (r) => r.thread !== undefined
);

test(
  "email_compose draft (default)",
  await client.callTool("email_compose", { to: "a@b.com", body: "Hi" }),
  (r) => r.success && r.action === "draft_saved"
);
test(
  "email_compose send",
  await client.callTool("email_compose", { to: "a@b.com", body: "Hi", mode: "send" }),
  (r) => r.action === "sent"
);
test(
  "email_compose open",
  await client.callTool("email_compose", { to: "a@b.com", body: "Hi", mode: "open" }),
  (r) => r.action === "draft_opened"
);

test(
  "email_reply",
  await client.callTool("email_reply", { messageId: 1, body: "Thanks" }),
  (r) => r.success
);
test(
  "email_reply --send",
  await client.callTool("email_reply", { messageId: 1, body: "Thanks", mode: "send" }),
  (r) => r.action === "sent"
);

test(
  "email_forward",
  await client.callTool("email_forward", { messageId: 1, to: "c@d.com", body: "FYI" }),
  (r) => r.success
);

test(
  "email_mark read",
  await client.callTool("email_mark", { messageIds: [1], read: true }),
  (r) => r.success
);
updates.length = 0;
test(
  "email_mark addTags keeps existing tags",
  await client.callTool("email_mark", { messageIds: [1], addTags: ["$label3", "$label1"] }),
  (r) => r.success && JSON.stringify(updates.at(-1)?.tags) === JSON.stringify(["$label1", "$label2", "$label3"])
);
test(
  "email_mark removeTags removes only those",
  await client.callTool("email_mark", { messageIds: [1], removeTags: ["$label2"] }),
  (r) => r.success && JSON.stringify(updates.at(-1)?.tags) === JSON.stringify(["$label1"])
);
test(
  "email_mark add + remove together",
  await client.callTool("email_mark", { messageIds: [1], addTags: ["$label4"], removeTags: ["$label1"] }),
  (r) => r.success && JSON.stringify(updates.at(-1)?.tags) === JSON.stringify(["$label2", "$label4"])
);
test(
  "email_mark tags replaces the set (and [] clears)",
  await client.callTool("email_mark", { messageIds: [1, 2], tags: [] }),
  (r) => r.updated === 2 && updates.slice(-2).every((u) => Array.isArray(u.tags) && u.tags.length === 0)
);
test(
  "email_mark read-only change does not touch tags",
  await client.callTool("email_mark", { messageIds: [1], read: true }),
  (r) => r.success && !("tags" in updates.at(-1))
);
test(
  "email_mark tags with addTags is INVALID_ARGS",
  await client.callTool("email_mark", { messageIds: [1], tags: ["$label1"], addTags: ["$label2"] }),
  (r) => r.code === "INVALID_ARGS"
);
test(
  "email_mark batch flagged",
  await client.callTool("email_mark", { messageIds: [1, 2, 3], flagged: true }),
  (r) => r.updated === 3
);

test(
  "email_archive operation=archive",
  await client.callTool("email_archive", { messageIds: [1], operation: "archive" }),
  (r) => r.success
);
test(
  "email_archive operation=move",
  await client.callTool("email_archive", {
    messageIds: [1],
    operation: "move",
    destinationFolderId: "f2",
  }),
  (r) => r.success
);
test(
  "email_archive operation=delete",
  await client.callTool("email_archive", { messageIds: [1], operation: "delete" }),
  (r) => r.success
);
test(
  "email_archive permanent delete without confirm",
  await client.callTool("email_archive", {
    messageIds: [1],
    operation: "delete",
    permanent: true,
  }),
  (r) => r.error?.includes("confirm")
);

test(
  "email_attachments list",
  await client.callTool("email_attachments", { messageId: 1, operation: "list" }),
  (r) => Array.isArray(r) && r.length > 0
);
const saved = await client.callTool("email_attachments", {
  messageId: 1,
  operation: "download",
  partName: "1.2",
});
test("email_attachments download saves to disk and returns the path", saved, (r) =>
  r.saved === true && typeof r.path === "string" && r.path.startsWith(DOWNLOAD_DIR) && r.data === undefined
);
test("saved attachment holds the decoded bytes", saved, (r) =>
  existsSync(r.path) && readFileSync(r.path, "utf-8") === "Hello" && r.size === 5
);
test(
  "email_attachments download inline=true returns base64",
  await client.callTool("email_attachments", { messageId: 1, operation: "download", partName: "1.2", inline: true }),
  (r) => r.data === "SGVsbG8="
);

console.log("\n\x1b[1mDelete drafts and other mail\x1b[0m");
deletes.length = 0;
test(
  "deleting drafts needs one drafts-only call",
  await client.callTool("email_archive", { messageIds: [501, 502], operation: "delete" }),
  (r) => r.success && r.deleted === 2 && deletes.length === 1 && deletes[0].draftsOnly === true
);
deletes.length = 0;
test(
  "other mail is moved to the trash in a second call",
  await client.callTool("email_archive", { messageIds: [501, 1, 777], operation: "delete" }),
  (r) => r.deleted === 2 && JSON.stringify(r.alreadyInTrash) === "[777]" && deletes.length === 2 &&
    !deletes[1].draftsOnly && JSON.stringify(deletes[1].messageIds) === "[1,777]" && r.notDrafts === undefined
);
test(
  "a refused non-draft names what was deleted and what was not",
  await client.callTool("email_archive", { messageIds: [501, 403], operation: "delete" }),
  (r) => r.code === "POLICY_DENIED" && /Moved 1 draft/.test(r.error) && /403 are not drafts/.test(r.error)
);
deletes.length = 0;
test(
  "permanent delete with confirm goes straight through",
  await client.callTool("email_archive", { messageIds: [1], operation: "delete", permanent: true, confirm: true }),
  (r) => r.permanent === true && deletes.length === 1 && deletes[0].route === "delete" && deletes[0].permanent === true
);
test(
  "an add-on without the trash route gets a clear upgrade message",
  await client.callTool("email_archive", { messageIds: [999], operation: "delete" }),
  (r) => r.code === "THUNDERBIRD_ERROR" && /older than 2\.1\.1\.6/.test(r.error)
);

console.log("\n\x1b[1mUpload attachments\x1b[0m");
const UPLOAD_DIR = mkdtempSync(join(tmpdir(), "tb-mcp-up-"));
const pdfPath = join(UPLOAD_DIR, "Rechnung März.pdf");
writeFileSync(pdfPath, "%PDF-1.4 hallo");
const withFile = await client.callTool("email_compose", { to: "a@b.com", body: "Anbei", attachments: [pdfPath] });
test("email_compose reads the file where it lies and sends name + base64", withFile, (r) =>
  r.action === "draft_saved" && r.draftId === 900 && r._body.attachments?.length === 1 &&
  r._body.attachments[0].name === "Rechnung März.pdf" &&
  Buffer.from(r._body.attachments[0].data, "base64").toString() === "%PDF-1.4 hallo"
);
test(
  "a relative attachment path is INVALID_ARGS",
  await client.callTool("email_compose", { to: "a@b.com", body: "x", attachments: ["Rechnung.pdf"] }),
  (r) => r.code === "INVALID_ARGS" && /absolute/.test(r.error)
);
test(
  "a missing attachment is NOT_FOUND",
  await client.callTool("email_compose", { to: "a@b.com", body: "x", attachments: [join(UPLOAD_DIR, "nope.pdf")] }),
  (r) => r.code === "NOT_FOUND"
);
test(
  "a folder is not an attachment",
  await client.callTool("email_compose", { to: "a@b.com", body: "x", attachments: [UPLOAD_DIR] }),
  (r) => r.code === "INVALID_ARGS" && /not a file/.test(r.error)
);
const bigPath = join(UPLOAD_DIR, "big.bin");
writeFileSync(bigPath, "");
truncateSync(bigPath, 21 * 1024 * 1024);
test(
  "attachments over 20 MB are refused before reading",
  await client.callTool("email_compose", { to: "a@b.com", body: "x", attachments: [bigPath] }),
  (r) => r.code === "INVALID_ARGS" && /limit is 20 MB/.test(r.error)
);
const replyFile = await client.callTool("email_reply", { messageId: 1, body: "Danke", attachments: [pdfPath] });
test("email_reply attaches files", replyFile, (r) => r._body.attachments?.[0]?.name === "Rechnung März.pdf");
const fwdFile = await client.callTool("email_forward", { messageId: 1, to: "c@d.com", attachments: [pdfPath] });
test("email_forward attaches files", fwdFile, (r) => r._body.attachments?.length === 1);
test("compose without attachments sends none", await client.callTool("email_compose", { to: "a@b.com", body: "x" }), (r) =>
  r._body.attachments === undefined
);
test(
  "an add-on that ignores attachments is reported, not hidden",
  await client.callTool("email_compose", { to: "a@b.com", subject: "__old_addon__", attachments: [pdfPath] }),
  (r) => r.code === "THUNDERBIRD_ERROR" && /WITHOUT the attachments/.test(r.error)
);
test(
  "a new message without `to` is INVALID_ARGS",
  await client.callTool("email_compose", { body: "x" }),
  (r) => r.code === "INVALID_ARGS"
);

console.log("\n\x1b[1mEdit drafts\x1b[0m");
const editDraft = await client.callTool("email_compose", {
  draftId: 501, attachments: [pdfPath], removeAttachments: ["alt.pdf"], subject: "Neu",
});
test("draft edit sends only what changes", editDraft, (r) =>
  r.draftId === 901 && r.replacedDraftId === 501 && r._body.draftId === 501 && r._body.subject === "Neu" && !("to" in r._body) && !("body" in r._body) &&
  r._body.attachments?.length === 1 && JSON.stringify(r._body.removeAttachments) === '["alt.pdf"]' && r._body.draft === true
);
test("draft edit with a new body passes its format", await client.callTool("email_compose", { draftId: 501, body: "<p>x</p>", html: true }), (r) =>
  r._body.body === "<p>x</p>" && r._body.isHTML === true
);
test(
  "removeAttachments without draftId is INVALID_ARGS",
  await client.callTool("email_compose", { to: "a@b.com", body: "x", removeAttachments: ["a.pdf"] }),
  (r) => r.code === "INVALID_ARGS"
);

console.log("\n\x1b[1mDownload all attachments\x1b[0m");
const all = await client.callTool("email_attachments", { messageId: 1, operation: "download" });
test("download without partName saves every attachment", all, (r) =>
  r.saved === 1 && r.files?.[0]?.partName === "1.2" && existsSync(r.files[0].path) && readFileSync(r.files[0].path, "utf-8") === "Hello"
);
rmSync(UPLOAD_DIR, { recursive: true, force: true });

console.log("\n\x1b[1mToken-efficient output\x1b[0m");
const raw = await client.send("tools/call", { name: "email_search", arguments: { query: "x" } });
test("results are compact JSON (no indentation)", raw, (r) => !r.result.content[0].text.includes("\n  "));
test("empty header fields are dropped", await client.callTool("email_search", { query: "x" }), (r) =>
  r.messages[0].tags === undefined && r.messages[0].subject === "Test"
);
test("fields selects message fields", await client.callTool("email_search", { query: "x", fields: ["id", "subject"] }), (r) =>
  JSON.stringify(Object.keys(r.messages[0])) === JSON.stringify(["id", "subject"])
);
test("search defaults to newest order", await client.callTool("email_search", { query: "x" }), (r) => r._body.sort === undefined);
test("order=any requests storage order", await client.callTool("email_search", { query: "x", order: "any", offset: 25 }), (r) =>
  r._body.sort === "none" && r._body.offset === 25
);
const html = await client.callTool("email_read", { messageId: 77 });
test("HTML-only mail is returned as text", html, (r) =>
  r.parts.textFromHtml === true && r.parts.text.includes("Rechnung & Betrag:\nCHF 12.50 für März")
);
test("HTML conversion keeps link targets and drops script/style", html, (r) =>
  r.parts.text.includes("Jetzt zahlen (https://pay.example.ch/x)") && !r.parts.text.includes("track()") && !r.parts.text.includes("color:red")
);
test("default read drops the HTML part and empty fields", html, (r) =>
  r.parts.html === undefined && r.ccList === undefined && r.parts.attachments === undefined
);
test("includeHtml keeps the HTML", await client.callTool("email_read", { messageId: 77, includeHtml: true }), (r) =>
  typeof r.parts.html === "string" && r.parts.html.includes("<p>")
);
test("long bodies are capped by default", await client.callTool("email_read", { messageId: 78 }), (r) =>
  r.parts.textTruncated === true && r.parts.text.length < 20100
);
test("maxBody 0 disables the cap", await client.callTool("email_read", { messageId: 78, maxBody: 0 }), (r) =>
  r.parts.text.length === 30000 && !r.parts.textTruncated
);
test("full mode caps HTML too", await client.callTool("email_read", { messageId: 1, mode: "full", maxBody: 3 }), (r) =>
  r.parts.htmlTruncated === true
);
test("email_identities lists sender identities", await client.callTool("email_identities", {}), (r) =>
  Array.isArray(r) && r[0].id === "id1"
);
test("email_recent forwards hours/unread", await client.callTool("email_recent", { hours: 6, unread: true }), (r) =>
  r._body.hours === 6 && r._body.unreadOnly === true && r.messages[0].ccList === undefined
);

test(
  "email_folders list",
  await client.callTool("email_folders", { operation: "list", accountId: "acct1" }),
  (r) => Array.isArray(r)
);
test(
  "email_folders all",
  await client.callTool("email_folders", { operation: "all" }),
  (r) => Array.isArray(r)
);
test(
  "email_folders info",
  await client.callTool("email_folders", { operation: "info", folderId: "f1" }),
  (r) => r.name
);
test(
  "email_folders sync",
  await client.callTool("email_folders", { operation: "sync" }),
  (r) => r.success
);

console.log("\n\x1b[1mError handling\x1b[0m");
const unknownTool = await client.callTool("nonexistent_tool", {});
test("unknown tool returns error", unknownTool, (r) => r.error?.includes("Unknown tool"));

// Summary
console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(
  `\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`
);
if (failures.length > 0) {
  console.log("\x1b[31mFailures:\x1b[0m");
  for (const f of failures) {
    console.log(`  ${f.name}: ${JSON.stringify(f.result).slice(0, 200)}`);
  }
}

client.close();
rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
servers.mock.close();
servers.wss.close();
servers.httpServer.close();
process.exit(failed > 0 ? 1 : 0);
