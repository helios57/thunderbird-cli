#!/usr/bin/env node
/**
 * Extension background-script tests.
 *
 * Loads the real extension/src/thread-utils.js + background.js (in manifest order) into a vm
 * with a mocked `messenger` API, WebSocket and timers, then drives handleRequest() and the
 * reconnect logic directly. Complements test/quick-test.mjs, which mocks the extension away.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import vm from "vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf-8"));

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── Mock environment ───────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  // test helpers
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  fail() { this.readyState = MockWebSocket.CLOSED; this.onerror?.(new Error("refused")); this.onclose?.(); }
}

const timers = [];
const idleListeners = [];
const date = (s) => new Date(s);
const folder = (accountId) => ({ accountId, path: "/INBOX", name: "Inbox" });

function header(id, extra = {}) {
  return {
    id, subject: `Message ${id}`, author: "a@example.org", date: date("2026-01-01T00:00:00Z"),
    read: false, flagged: false, junk: false, size: 10, tags: [], folder: folder("acct1"),
    headerMessageId: `m${id}@example.org`, ...extra,
  };
}

const calls = { query: [], getRaw: [], update: [], list: [], abortList: [] };
let legacyList = false;
let inFlight = 0, maxInFlight = 0;
const track = async (fn) => {
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setImmediate(r));
  try { return await fn(); } finally { inFlight--; }
};

const store = new Map();
const pages = new Map();
const PAGE_SIZE = 7;
function pageOf(all, start) {
  const messages = all.slice(start, start + PAGE_SIZE);
  if (start + PAGE_SIZE >= all.length) return { messages };
  const id = `page-${start + PAGE_SIZE}`;
  pages.set(id, async () => pageOf(all, start + PAGE_SIZE));
  return { id, messages };
}
const queryHandlers = [];

const messenger = {
  runtime: { getManifest: () => manifest },
  idle: { onStateChanged: { addListener: (fn) => idleListeners.push(fn) } },
  folders: { get: async (id) => ({ id, accountId: "acct1" }) },
  messages: {
    get: (id) => track(async () => {
      if (!store.has(id)) throw new Error(`Message ${id} not found`);
      return store.get(id).header;
    }),
    getFull: (id) => track(async () => {
      if (!store.has(id)) throw new Error(`Message ${id} not found`);
      return store.get(id).full || { contentType: "text/plain", body: `body ${id}`, headers: {} };
    }),
    getRaw: (id) => track(async () => {
      calls.getRaw.push(id);
      const raw = store.get(id)?.raw;
      if (raw === undefined) throw new Error("no raw");
      return raw;
    }),
    query: async (q) => {
      calls.query.push(q);
      for (const h of queryHandlers) {
        const r = h(q);
        if (r) return r;
      }
      return { messages: [] };
    },
    // Paginated like Thunderbird (small pages to exercise continueList). Thunderbird 128+
    // sorts when given { sortType, sortOrder } (default order: descending); `legacyList`
    // simulates an older build that rejects list options.
    list: async (folder, options) => {
      calls.list.push(options);
      const all = [...store.values()].map((s) => s.header);
      if (options) {
        if (legacyList) throw new Error("Incorrect argument types for messages.list.");
        const key = { date: (h) => h.date.getTime(), size: (h) => h.size, subject: (h) => h.subject, author: (h) => h.author }[options.sortType];
        const f = options.sortOrder === "ascending" ? 1 : -1;
        if (key) all.sort((a, b) => { const x = key(a), y = key(b); return f * (typeof x === "string" ? x.localeCompare(y) : x - y); });
      }
      return pageOf(all, 0);
    },
    continueList: async (id) => pages.get(id)?.() ?? null,
    abortList: async (id) => { calls.abortList.push(id); pages.delete(id); },
    update: (id, props) => track(async () => { calls.update.push({ id, props }); }),
    getAttachmentFile: async () => {
      const bytes = randomBytes(100_000);
      attachmentBytes = bytes;
      return { name: "big.bin", size: bytes.length, type: "application/octet-stream", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    },
  },
};
let attachmentBytes = null;

const ctx = vm.createContext({
  console: { log() {}, error() {} },
  WebSocket: MockWebSocket,
  messenger,
  btoa,
  setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
  clearTimeout: (t) => { if (t) t.cleared = true; },
});
for (const script of manifest.background.scripts) {
  const file = join(EXT, script);
  vm.runInContext(readFileSync(file, "utf-8"), ctx, { filename: file });
}
const handle = (method, path, body) => ctx.handleRequest({ method, path, body });
const pendingTimers = () => timers.filter((t) => !t.cleared && !t.fired);
const fireTimer = () => { const t = pendingTimers()[0]; t.fired = true; t.fn(); return t.ms; };
const lastSocket = () => MockWebSocket.instances.at(-1);

console.log("\n\x1b[1m=== extension background tests ===\x1b[0m");

// ─── Manifest ───────────────────────────────────────────────────────

console.log("\n\x1b[1mManifest\x1b[0m");
test("thread-utils.js loads before background.js",
  manifest.background.scripts.indexOf("src/thread-utils.js") < manifest.background.scripts.indexOf("src/background.js"));
test("idle permission declared for wake-up reconnect", manifest.permissions.includes("idle"));

// ─── Reconnect ──────────────────────────────────────────────────────

console.log("\n\x1b[1mReconnect\x1b[0m");
test("connects on load", MockWebSocket.instances.length === 1 && lastSocket().url === "ws://127.0.0.1:7701");
const delays = [];
for (let i = 0; i < 6; i++) {
  lastSocket().fail();
  test(`failure ${i + 1} schedules exactly one retry`, pendingTimers().length === 1, `pending=${pendingTimers().length}`);
  delays.push(fireTimer());
}
test("backoff is 3s → 6s → 12s → capped at 15s", JSON.stringify(delays) === JSON.stringify([3000, 6000, 12000, 15000, 15000, 15000]), JSON.stringify(delays));

lastSocket().open();
lastSocket().fail();
test("successful connection resets backoff to 3s", pendingTimers()[0]?.ms === 3000, `got ${pendingTimers()[0]?.ms}`);
fireTimer();
lastSocket().fail();
fireTimer();
lastSocket().fail();
const beforeIdle = MockWebSocket.instances.length;
idleListeners.forEach((fn) => fn("idle"));
test("idle state does not reconnect", MockWebSocket.instances.length === beforeIdle);
idleListeners.forEach((fn) => fn("active"));
test("returning to active reconnects immediately", MockWebSocket.instances.length === beforeIdle + 1);
test("pending backoff timer is cancelled on wake", pendingTimers().length === 0);

const current = lastSocket();
current.open();
const stale = new MockWebSocket("stale");
stale.onclose = null;
idleListeners.forEach((fn) => fn("active"));
test("active while connected does not open a second socket", lastSocket() === stale);
current.onmessage({ data: JSON.stringify({ id: "r1", method: "GET", path: "/health" }) });
await new Promise((r) => setImmediate(r));
test("requests are answered on the socket they arrived on", current.sent[0]?.id === "r1" && current.sent[0]?.result?.status === "ok");
test("health reports the manifest version", current.sent[0]?.result?.version === manifest.version);

// ─── Thread ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mThread\x1b[0m");
store.clear();
store.set(1, { header: header(1, { subject: "Budget", date: date("2026-01-01T00:00:00Z"), headerMessageId: "root@example.org" }) });
store.set(2, { header: header(2, { subject: "Re: Budget", date: date("2026-01-02T00:00:00Z"), headerMessageId: "mid@example.org" }) });
store.set(3, {
  header: header(3, { subject: "Re: [fin] Budget", date: date("2026-01-03T00:00:00Z"), headerMessageId: "leaf@example.org" }),
  raw: "Message-ID: <leaf@example.org>\r\nReferences: <root@example.org>\r\n <mid@example.org>\r\nIn-Reply-To: <mid@example.org>\r\nSubject: Re: [fin] Budget\r\n\r\nbody",
});
store.set(4, { header: header(4, { subject: "AW: Budget", date: date("2026-01-04T00:00:00Z"), headerMessageId: "late@example.org" }) });
store.set(5, { header: header(5, { subject: "Budget review Q3", date: date("2026-01-05T00:00:00Z"), headerMessageId: "other@example.org" }) });
const byHdrId = new Map([...store.values()].map((s) => [s.header.headerMessageId, s.header]));
queryHandlers.length = 0;
queryHandlers.push((q) => q.headerMessageId && { messages: byHdrId.has(q.headerMessageId) ? [byHdrId.get(q.headerMessageId)] : [] });
queryHandlers.push((q) => q.subject && { messages: [...store.values()].map((s) => s.header).filter((h) => h.subject.includes(q.subject)) });

calls.query.length = 0;
const t = await handle("GET", "/messages/3/thread");
const ids = t.thread.map((m) => m.id);
test("header ids are queried without angle brackets", calls.query.filter((q) => q.headerMessageId).every((q) => !/[<>]/.test(q.headerMessageId)));
test("upstream messages found via folded References", ids.includes(1) && ids.includes(2));
test("downstream reply found by exact normalized subject", ids.includes(4));
test("substring subject match is excluded", !ids.includes(5));
test("thread sorted by date", JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(ids));
test("count matches", t.count === 4);
test("matches labelled by source",
  t.thread.find((m) => m.id === 2)?.threadMatch === "references" && t.thread.find((m) => m.id === 4)?.threadMatch === "subject");
test("subject search excludes junk", calls.query.some((q) => q.subject === "Budget" && q.junk === false));

// getRaw unavailable → getFull headers, still bracket-stripped
store.set(6, {
  header: header(6, { subject: "Re: Budget", headerMessageId: "six@example.org" }),
  full: { headers: { references: ["<root@example.org> <mid@example.org>"], "in-reply-to": ["<mid@example.org>"], "message-id": ["<six@example.org>"] } },
});
const t6 = await handle("GET", "/messages/6/thread");
test("falls back to getFull headers when getRaw fails", t6.thread.some((m) => m.id === 1 && m.threadMatch === "references"));

let missingErr = null;
try { await handle("GET", "/messages/999/thread"); } catch (e) { missingErr = e; }
test("unknown message still reports an error", missingErr?.message.includes("not found"));

// ─── Recent ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mRecent\x1b[0m");
queryHandlers.length = 0;
queryHandlers.push((q) => q.fromDate && {
  messages: [
    header(10, { folder: folder("acct1"), read: false }),
    header(11, { folder: folder("acct2"), read: false }),
    header(12, { folder: folder("acct1"), read: true }),
  ],
});
const all = await handle("POST", "/recent", { hours: 24, limit: 50 });
test("no filters returns every account", all.messages.length === 3);
const acct = await handle("POST", "/recent", { hours: 24, limit: 50, accountId: "acct2" });
test("--account filters by account", acct.messages.length === 1 && acct.messages[0].id === 11);
const unread = await handle("POST", "/recent", { hours: 24, limit: 50, unreadOnly: true });
test("--unread filters read messages", unread.messages.length === 2 && unread.messages.every((m) => !m.read));

// ─── Search ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mSearch\x1b[0m");
calls.query.length = 0;
await handle("POST", "/messages/search", { headerMessageId: "<abc@host>" });
test("headerMessageId forwarded to query without brackets", calls.query[0]?.headerMessageId === "abc@host");
test("junk still excluded by default", calls.query[0]?.junk === false);

calls.query.length = 0;
const ft = await handle("POST", "/messages/search", { query: "invoice" });
test("text query uses the fullText index by default", calls.query[0]?.fullText === "invoice" && calls.query[0]?.body === undefined && ft.searchMode === "fulltext");
calls.query.length = 0;
const bodyScan = await handle("POST", "/messages/search", { query: "invoice", searchMode: "body" });
test("searchMode body scans bodies", calls.query[0]?.body === "invoice" && calls.query[0]?.fullText === undefined && bodyScan.searchMode === "body");
calls.query.length = 0;
queryHandlers.unshift((q) => { if (q.fullText) throw new Error("fullText unsupported"); });
const fallback = await handle("POST", "/messages/search", { query: "invoice" });
queryHandlers.shift();
test("falls back to a body scan when fullText is unsupported", calls.query.at(-1)?.body === "invoice" && fallback.searchMode === "body");
const filtersOnly = await handle("POST", "/messages/search", { subject: "x" });
test("filter-only search reports no searchMode", filtersOnly.searchMode === undefined);

// ─── Read batch / bulk ──────────────────────────────────────────────

console.log("\n\x1b[1mBatch and bulk\x1b[0m");
store.clear();
for (let i = 1; i <= 40; i++) store.set(i, { header: header(i, { tags: i % 2 ? ["$label1"] : [] }), raw: "x" });
const batchIds = [...Array(40).keys()].map((i) => i + 1).reverse();
maxInFlight = 0;
await handle("POST", "/messages/read-batch", { messageIds: batchIds });
// 8 operations × (get + getFull)
test(`in-flight messenger calls bounded (max ${maxInFlight} ≤ 16)`, maxInFlight > 2 && maxInFlight <= 16);

batchIds.splice(5, 0, 404);
const batch = await handle("POST", "/messages/read-batch", { messageIds: batchIds });
test("read-batch preserves request order", JSON.stringify(batch.map((m) => m.id)) === JSON.stringify(batchIds));
test("read-batch reports per-message errors", batch[5].error?.includes("not found") && batch[6].parts?.text === "body 35");
test("read-batch with no ids returns []", JSON.stringify(await handle("POST", "/messages/read-batch", {})) === "[]");

calls.update.length = 0;
const tagged = await handle("POST", "/bulk/tag", { folderId: "f1", tagKey: "$label1", limit: 100 });
test("bulk tag only touches untagged messages", tagged.tagged === 20 && calls.update.length === 20);
test("bulk tag appends to existing tags", calls.update.every((u) => u.props.tags.at(-1) === "$label1"));

calls.getRaw.length = 0;
store.get(7).raw = undefined;
const fetched = await handle("POST", "/bulk/fetch", { folderId: "f1", limit: 100 });
test("bulk fetch counts successes", fetched.fetched === 39 && fetched.total === 40);

// ─── List sorting (#24, #15) ────────────────────────────────────────

console.log("\n\x1b[1mList sorting\x1b[0m");
store.clear();
// Database order is oldest → newest, so the newest messages sit on the last page.
for (let i = 1; i <= 30; i++) {
  store.set(i, { header: header(i, { date: new Date(Date.UTC(2026, 0, i)), read: i % 3 === 0, subject: `S${String(i).padStart(2, "0")}` }) });
}
const newest = await handle("POST", "/messages/list", { folderId: "f1", limit: 3, sort: "date", sortOrder: "desc" });
test("sort=date desc returns the true newest messages across pages", JSON.stringify(newest.messages.map((m) => m.id)) === "[30,29,28]", JSON.stringify(newest.messages.map((m) => m.id)));
test("sorted page reports hasMore", newest.hasMore === true && newest.total === 3);
const next = await handle("POST", "/messages/list", { folderId: "f1", limit: 3, offset: 3, sort: "date", sortOrder: "desc" });
test("offset applies after sorting", JSON.stringify(next.messages.map((m) => m.id)) === "[27,26,25]", JSON.stringify(next.messages.map((m) => m.id)));
const oldest = await handle("POST", "/messages/list", { folderId: "f1", limit: 2, sort: "date", sortOrder: "asc" });
test("sort=date asc returns the oldest", JSON.stringify(oldest.messages.map((m) => m.id)) === "[1,2]");
const unreadNewest = await handle("POST", "/messages/list", { folderId: "f1", limit: 2, sort: "date", sortOrder: "desc", unreadOnly: true });
test("filters apply before sorting", JSON.stringify(unreadNewest.messages.map((m) => m.id)) === "[29,28]", JSON.stringify(unreadNewest.messages.map((m) => m.id)));
const lastPage = await handle("POST", "/messages/list", { folderId: "f1", limit: 5, offset: 28, sort: "subject", sortOrder: "asc" });
test("last sorted page has hasMore=false", lastPage.messages.length === 2 && lastPage.hasMore === false);
calls.list.length = 0;
const defaultList = await handle("POST", "/messages/list", { folderId: "f1", limit: 3 });
test("without sort, listing defaults to newest first", JSON.stringify(defaultList.messages.map((m) => m.id)) === "[30,29,28]", JSON.stringify(defaultList.messages.map((m) => m.id)));
test("date sort is delegated to Thunderbird (messages.list options)", calls.list[0]?.sortType === "date" && calls.list[0]?.sortOrder === "descending");
test("a page cut short aborts the list in Thunderbird", calls.abortList.length > 0);
const unsorted = await handle("POST", "/messages/list", { folderId: "f1", limit: 3, sort: "none" });
test("sort=none keeps database order and paging", JSON.stringify(unsorted.messages.map((m) => m.id)) === "[1,2,3]" && unsorted.hasMore === true);
const byFrom = await handle("POST", "/messages/list", { folderId: "f1", limit: 1, sort: "from" });
test("sort=from maps to Thunderbird's author sort", calls.list.at(-1)?.sortType === "author" && byFrom.messages.length === 1);

legacyList = true;
const legacy = await handle("POST", "/messages/list", { folderId: "f1", limit: 3, sort: "date", sortOrder: "desc" });
legacyList = false;
test("Thunderbird without list options falls back to sorting the whole folder", JSON.stringify(legacy.messages.map((m) => m.id)) === "[30,29,28]", JSON.stringify(legacy.messages.map((m) => m.id)));

// ─── Newest-first search ────────────────────────────────────────────

console.log("\n\x1b[1mNewest-first search\x1b[0m");
// Messages spread over three years, stored oldest first (like a real folder database).
store.clear();
const DAY = 86400000;
const ages = [1, 2, 3, 10, 20, 100, 200, 400, 800, 1000]; // days old
ages.forEach((age, i) => {
  const id = 100 + i;
  store.set(id, { header: header(id, { date: new Date(Date.now() - age * DAY), subject: age > 300 ? "Rechnung alt" : "Rechnung", read: age === 2 }) });
});
const dbOrder = [...store.values()].map((s) => s.header).reverse(); // oldest first
queryHandlers.length = 0;
queryHandlers.push((q) => {
  const hits = dbOrder.filter((h) =>
    (!q.fromDate || h.date >= q.fromDate) && (!q.toDate || h.date <= q.toDate) &&
    (!q.subject || h.subject.includes(q.subject)) && (q.unread === undefined || !h.read));
  return pageOf(hits, 0);
});

calls.query.length = 0;
const top3 = await handle("POST", "/messages/search", { subject: "Rechnung", limit: 3 });
test("search returns the newest hits, not database order", JSON.stringify(top3.messages.map((m) => m.id)) === "[100,101,102]", JSON.stringify(top3.messages.map((m) => m.id)));
test("a broad search stops after the first date slice", top3.slicesScanned === 1 && calls.query.length === 1, `slices=${top3.slicesScanned}`);
test("first slice is bounded by fromDate (dates are checked before bodies)", Object.prototype.toString.call(calls.query[0]?.fromDate) === "[object Date]");
test("hasMore is set when older slices were skipped", top3.hasMore === true);
test("queries ask for large pages", calls.query[0]?.messagesPerPage === 500);

const page2 = await handle("POST", "/messages/search", { subject: "Rechnung", limit: 3, offset: 3 });
test("offset pages continue newest-first", JSON.stringify(page2.messages.map((m) => m.id)) === "[103,104,105]", JSON.stringify(page2.messages.map((m) => m.id)));

const rare = await handle("POST", "/messages/search", { subject: "Rechnung alt", limit: 5 });
test("a narrow search walks back through all slices", rare.slicesScanned === 4 && JSON.stringify(rare.messages.map((m) => m.id)) === "[107,108,109]", JSON.stringify(rare.messages.map((m) => m.id)));
test("exhausted search reports hasMore=false", rare.hasMore === false);

const unreadOnly = await handle("POST", "/messages/search", { subject: "Rechnung", unreadOnly: true, limit: 2 });
test("filters are applied inside the slices", JSON.stringify(unreadOnly.messages.map((m) => m.id)) === "[100,102]", JSON.stringify(unreadOnly.messages.map((m) => m.id)));

const windowed = await handle("POST", "/messages/search", { subject: "Rechnung", fromDate: new Date(Date.now() - 30 * DAY).toISOString(), limit: 10 });
test("an explicit date range is respected", JSON.stringify(windowed.messages.map((m) => m.id)) === "[100,101,102,103,104]", JSON.stringify(windowed.messages.map((m) => m.id)));

calls.query.length = 0;
await handle("POST", "/messages/search", { subject: "Rechnung", tag: "$label1", sizeMin: 5, sizeMax: 50 });
test("tag and size filters go into the Thunderbird query", calls.query[0]?.tags?.tags?.$label1 === true && calls.query[0]?.size?.min === 5 && calls.query[0]?.size?.max === 50);

const fast = await handle("POST", "/messages/search", { subject: "Rechnung", limit: 2, sort: "none" });
test("sort=none keeps the fast first-found path", fast.order === undefined && fast.messages.length === 2);

// ─── Time budget and cancellation ───────────────────────────────────

console.log("\n\x1b[1mTime budget and cancellation\x1b[0m");
{
  const reqCtx = { cancelled: false, deadline: Infinity };
  // The bridge cancels while the first date slice is being searched.
  queryHandlers.unshift(() => { reqCtx.cancelled = true; });
  const cut = await ctx.handleRequest({ method: "POST", path: "/messages/search", body: { subject: "Rechnung", limit: 10 } }, reqCtx);
  queryHandlers.shift();
  test("a cancelled search returns what it found so far", cut.partial === true && JSON.stringify(cut.messages.map((m) => m.id)) === "[100,101,102]", JSON.stringify(cut.messages.map((m) => m.id)));
  test("…and stops walking back", cut.slicesScanned === 1 && cut.hasMore === true);
  test("…and says so", /cancel/i.test(cut.note || ""));

  const late = await ctx.handleRequest({ method: "POST", path: "/messages/search", body: { subject: "Rechnung", limit: 10 } }, { cancelled: false, deadline: Date.now() - 1 });
  test("a passed deadline returns a partial result instead of searching on", late.partial === true && late.slicesScanned === 0);

  const reqCtx2 = { cancelled: false, deadline: Infinity };
  let m = 0;
  queryHandlers.unshift(() => { if (++m === 2) reqCtx2.deadline = Date.now() - 1; });
  const budget = await ctx.handleRequest({ method: "POST", path: "/messages/search", body: { subject: "Rechnung alt", limit: 10 } }, reqCtx2);
  queryHandlers.shift();
  const days = (Date.now() - new Date(budget.searchedBackTo).getTime()) / DAY;
  test("a deadline reports how far back the search is complete (last fully searched slice)", budget.partial === true && Math.round(days) === 60, `searchedBackTo=${budget.searchedBackTo}`);
  test("…with a hint to continue", /until/.test(budget.note || ""));
}
{
  const sock = current; // the connected socket from the reconnect tests
  const before = sock.sent.length;
  sock.onmessage({ data: JSON.stringify({ id: "nope", cancel: true }) });
  await new Promise((r) => setImmediate(r));
  test("cancel for an unknown request is ignored silently", sock.sent.length === before);
  sock.onmessage({ data: JSON.stringify({ id: "t1", method: "GET", path: "/health", timeoutMs: 5000 }) });
  await new Promise((r) => setImmediate(r));
  test("requests carrying timeoutMs are answered", sock.sent.at(-1)?.id === "t1" && sock.sent.at(-1)?.result?.status === "ok");
}

// ─── Gmail copies ───────────────────────────────────────────────────

console.log("\n\x1b[1mGmail copies\x1b[0m");
// Gmail exposes one mail in INBOX, All Mail, Important and label folders (same Message-ID).
const gfolder = (path, extra = {}) => ({ accountId: "acct1", path, name: path.split("/").pop(), ...extra });
const copies = [];
let cid = 300;
const addMail = (hdr, ageDays, folders, accountId = "acct1") => {
  for (const f of folders) {
    copies.push(header(cid++, { headerMessageId: hdr, date: new Date(Date.now() - ageDays * DAY), subject: "eBill", folder: { ...f, accountId } }));
  }
};
addMail("a@x", 1, [gfolder("/[Gmail]/Alle Nachrichten", { specialUse: ["all"] }), gfolder("/INBOX", { specialUse: ["inbox"] }), gfolder("/[Gmail]/Wichtig")]);
addMail("b@x", 2, [gfolder("/[Gmail]/Alle Nachrichten", { specialUse: ["all"] }), gfolder("/Rechnungen")]);
addMail("c@x", 3, [gfolder("/INBOX", { specialUse: ["inbox"] })]);
addMail("a@x", 1, [gfolder("/INBOX", { specialUse: ["inbox"] })], "acct2"); // same mail, other mailbox
queryHandlers.length = 0;
queryHandlers.push((q) => pageOf(copies.filter((h) =>
  (!q.fromDate || h.date >= q.fromDate) && (!q.toDate || h.date <= q.toDate) && (!q.subject || h.subject.includes(q.subject))), 0));

const deduped = await handle("POST", "/messages/search", { subject: "eBill", limit: 3 });
const mailA = deduped.messages.find((m) => m.headerMessageId === "a@x" && m.folder.accountId === "acct1");
test("copies of one mail collapse to one result", deduped.messages.filter((m) => m.headerMessageId === "a@x" && m.folder.accountId === "acct1").length === 1);
test("the inbox copy represents the mail", mailA?.folder.path === "/INBOX");
test("other folders are listed in alsoIn", JSON.stringify(mailA?.alsoIn?.sort()) === JSON.stringify(["/[Gmail]/Alle Nachrichten", "/[Gmail]/Wichtig"]));
test("a real label folder beats All Mail", deduped.messages.find((m) => m.headerMessageId === "b@x")?.folder.path === "/Rechnungen");
test("limit counts distinct mails", deduped.messages.length === 3 && new Set(deduped.messages.map((m) => `${m.folder.accountId}|${m.headerMessageId}`)).size === 3);
test("the same mail in another account stays separate", deduped.messages.some((m) => m.folder.accountId === "acct2"));
const raw2 = await handle("POST", "/messages/search", { subject: "eBill", limit: 20, dedupe: false });
test("dedupe:false returns every copy", raw2.messages.length === copies.length);
const recentDedup = await handle("POST", "/recent", { hours: 24 * 30, limit: 50 });
test("recent collapses copies too", recentDedup.messages.length === 4, `got ${recentDedup.messages.length}`);

// Thread: references query returns every copy of each referenced mail.
store.clear();
for (const h of copies) store.set(h.id, { header: h });
store.set(399, { header: header(399, { subject: "Re: eBill", headerMessageId: "reply@x", folder: gfolder("/INBOX", { specialUse: ["inbox"] }) }),
  raw: "Message-ID: <reply@x>\r\nReferences: <a@x>\r\nSubject: Re: eBill\r\n\r\nbody" });
queryHandlers.length = 0;
queryHandlers.push((q) => q.headerMessageId && { messages: [...store.values()].map((s) => s.header).filter((h) => h.headerMessageId === q.headerMessageId && h.folder.accountId === "acct1") });
queryHandlers.push((q) => q.subject && { messages: [] });
const gThread = await handle("GET", "/messages/399/thread");
test("thread lists each mail once", gThread.count === 2 && gThread.thread.filter((m) => m.headerMessageId === "a@x").length === 1, JSON.stringify(gThread.thread.map((m) => m.id)));
test("thread keeps the references match label", gThread.thread.every((m) => m.threadMatch === "references"));

// ─── Body parts ─────────────────────────────────────────────────────

console.log("\n\x1b[1mBody parts\x1b[0m");
store.set(200, {
  header: header(200),
  full: { contentType: "multipart/mixed", parts: [
    { contentType: "text/plain", body: "Hallo", partName: "1.1", headers: {} },
    { contentType: "text/plain", body: "a;b;c", partName: "1.2", name: "liste.csv", size: 5, headers: { "content-disposition": ["attachment; filename=liste.csv"] } },
    { contentType: "application/pdf", partName: "1.3", name: "rechnung.pdf", size: 900, headers: {} },
  ] },
});
const withFiles = await handle("GET", "/messages/200");
test("an attached text file is not merged into the body", withFiles.parts.text === "Hallo", JSON.stringify(withFiles.parts.text));
test("an attached text file is listed as an attachment", withFiles.parts.attachments.some((a) => a.name === "liste.csv") && withFiles.parts.attachments.some((a) => a.name === "rechnung.pdf"));

// ─── Attachment ─────────────────────────────────────────────────────

console.log("\n\x1b[1mAttachment\x1b[0m");
const att = await handle("POST", "/messages/1/attachment", { partName: "1.2" });
test("chunked base64 matches Node's encoder (100 KB, multi-chunk)", att.data === attachmentBytes.toString("base64"));

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
