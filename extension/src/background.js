/**
 * Thunderbird AI Bridge — Background Script (v2)
 *
 * Pure WebExtension — no Experiment APIs.
 * Connects to local Node.js bridge via WebSocket.
 * Handles requests using messenger.* APIs.
 */

const WS_URL = "ws://127.0.0.1:7701";
// Reconnect backoff while the bridge is absent: 3s, 6s, 12s, then every 15s. Cuts idle wakeups
// without making a freshly started bridge wait long for the extension.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 15000;
// Max per-message operations (each one or two messenger.* calls) in flight across all requests.
const IPC_CONCURRENCY = 8;
const BASE64_CHUNK_SIZE = 0x8000;
// messages.query() page size (Thunderbird default: 100). Larger pages mean fewer IPC round
// trips when a date slice holds thousands of hits.
const QUERY_PAGE_SIZE = 500;
// Newest-first search walks back through these date slices (days before now), then the rest.
const NEWEST_SLICES_DAYS = [7, 60, 365];
const DAY_MS = 24 * 60 * 60 * 1000;
// Safety cap for one newest-first search: beyond this many hits the result is flagged as
// truncated instead of holding an unbounded number of headers in memory.
const MAX_NEWEST_SCAN = 20000;
// API sort names → messages.list() sortType (Thunderbird 128+).
const LIST_SORT_TYPES = { date: "date", from: "author", subject: "subject", size: "size" };
const unsupportedQueryProps = new Set(); // query extras this Thunderbird rejected
// Long searches stop at this share of the bridge's timeout and return what they found, so the
// answer (marked partial) still arrives before the bridge gives up.
const SOFT_DEADLINE_SHARE = 0.8;
const activeRequests = new Map(); // request id → context ({ cancelled, deadline })

function requestContext(timeoutMs) {
  const ms = Number(timeoutMs);
  return {
    cancelled: false,
    deadline: ms > 0 ? Date.now() + ms * SOFT_DEADLINE_SHARE : Infinity,
  };
}

const shouldStop = (ctx) => !!ctx && (ctx.cancelled || Date.now() > ctx.deadline);

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let ipcInFlight = 0;
const ipcQueue = [];

// ─── WebSocket Connection ───────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.log("[tb-ai] WebSocket create failed:", err.message);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    console.log("[tb-ai] Connected to bridge");
    reconnectDelay = RECONNECT_BASE_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onmessage = async (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    // The bridge gave up on a request (timeout, client gone): stop its search loop.
    if (request.cancel) {
      const running = activeRequests.get(request.id);
      if (running) {
        running.cancelled = true;
        running.onCancel?.(); // abort the Thunderbird list that is being read right now
      }
      return;
    }

    const ctx = requestContext(request.timeoutMs);
    activeRequests.set(request.id, ctx);
    try {
      const result = await handleRequest(request, ctx);
      socket.send(JSON.stringify({ id: request.id, result }));
    } catch (err) {
      socket.send(JSON.stringify({
        id: request.id,
        error: { message: err.message, stack: err.stack },
      }));
    } finally {
      activeRequests.delete(request.id);
    }
  };

  // Only clear `ws` if it is still this socket: a late event from a replaced socket must not
  // drop the current connection.
  socket.onclose = () => {
    console.log("[tb-ai] Disconnected from bridge");
    if (ws === socket) ws = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    console.log("[tb-ai] WebSocket error, will reconnect");
    if (ws === socket) ws = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Start connection
connect();

// Coming back from idle or sleep: retry right away instead of waiting out the backoff.
if (typeof messenger !== "undefined" && messenger.idle?.onStateChanged) {
  messenger.idle.onStateChanged.addListener((state) => {
    if (state !== "active") return;
    reconnectDelay = RECONNECT_BASE_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  });
}

// ─── Request Router ─────────────────────────────────────────────────

async function handleRequest({ method, path, body }, ctx = null) {
  // Health
  if (path === "/health") {
    return { status: "ok", version: messenger.runtime.getManifest().version, thunderbird: true };
  }

  // ─── Accounts ───────────────────────────────────────────────────

  if (path === "/accounts" && method === "GET") {
    const accounts = await messenger.accounts.list(true);
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      identities: a.identities?.map((id) => ({
        email: id.email, name: id.name, id: id.id,
      })),
      rootFolder: a.rootFolder
        ? { id: a.rootFolder.id, name: a.rootFolder.name }
        : null,
    }));
  }

  // Account by ID
  const acctMatch = path.match(/^\/accounts\/([^/]+)$/);
  if (acctMatch && method === "GET") {
    const account = await messenger.accounts.get(acctMatch[1], true);
    if (!account) return { error: "Account not found" };
    return account;
  }

  // Account folders
  const foldersMatch = path.match(/^\/accounts\/([^/]+)\/folders$/);
  if (foldersMatch && method === "GET") {
    const account = await messenger.accounts.get(foldersMatch[1], true);
    if (!account) return { error: "Account not found" };
    return await flattenFolders(account.rootFolder);
  }

  // ─── Identities ────────────────────────────────────────────────

  if (path === "/identities" && method === "GET") {
    const accounts = await messenger.accounts.list(true);
    const identities = [];
    for (const acct of accounts) {
      for (const id of (acct.identities || [])) {
        identities.push({ id: id.id, email: id.email, name: id.name, accountId: acct.id });
      }
    }
    return identities;
  }

  // ─── Folders ────────────────────────────────────────────────────

  if (path === "/folders/info" && method === "POST") {
    const { folderId } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    if (!folder) return { error: "Folder not found" };
    let info = {};
    try { info = await messenger.folders.getFolderInfo(folder); } catch {}
    return {
      id: folder.id, name: folder.name, path: folder.path, type: folder.type,
      unreadMessageCount: info.unreadMessageCount || 0,
      totalMessageCount: info.totalMessageCount || 0,
      newMessageCount: info.newMessageCount || 0,
      accountId: folder.accountId,
    };
  }

  if (path === "/folders/create" && method === "POST") {
    const { parentFolderId, name } = body || {};
    const parent = await messenger.folders.get(parentFolderId, false);
    const newFolder = await messenger.folders.create(parent, name);
    return { success: true, folder: { id: newFolder.id, name: newFolder.name, path: newFolder.path } };
  }

  if (path === "/folders/rename" && method === "POST") {
    const { folderId, newName } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    const renamed = await messenger.folders.rename(folder, newName);
    return { success: true, folder: { id: renamed.id, name: renamed.name, path: renamed.path } };
  }

  if (path === "/folders/delete" && method === "POST") {
    const { folderId } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    await messenger.folders.delete(folder);
    return { success: true };
  }

  // ─── Search ─────────────────────────────────────────────────────

  if (path === "/messages/search" && method === "POST") {
    const { query, accountId, fromAddress, toAddress, subject,
            unreadOnly, flagged, limit = 25, offset = 0, fromDate, toDate,
            folderId, tag, hasAttachment, sizeMin, sizeMax,
            includeJunk, headerMessageId, searchMode = "fulltext", sort = "date",
            dedupe = true } = body || {};
    const q = {};
    // Thunderbird has no index behind messages.query: fullText matches subject/author and
    // otherwise parses each candidate's MIME body, body always parses it. Both are
    // case-sensitive substring matches. Date limits are checked before the body, which is
    // why newest-first slicing (collectNewest) keeps text searches fast on big mailboxes.
    let mode = query ? (searchMode === "body" ? "body" : "fulltext") : null;
    if (mode === "fulltext") q.fullText = query;
    if (mode === "body") q.body = query;
    if (accountId) q.accountId = accountId;
    if (fromAddress) q.author = fromAddress;
    if (toAddress) q.recipients = toAddress;
    if (subject) q.subject = subject;
    if (headerMessageId) q.headerMessageId = stripAngleBrackets(headerMessageId);
    if (unreadOnly) q.unread = true;
    if (flagged !== undefined) q.flagged = flagged;
    if (fromDate) q.fromDate = new Date(fromDate);
    if (toDate) q.toDate = new Date(toDate);
    if (folderId) q.folderId = folderId;
    if (hasAttachment) q.attachment = true;
    if (!includeJunk) q.junk = false;
    // Tag and size are evaluated inside Thunderbird, so they no longer shrink a page that was
    // already cut to `limit` (which used to return fewer hits than existed).
    if (tag) q.tags = { mode: "all", tags: { [tag]: true } };
    if (sizeMin || sizeMax) {
      q.size = {};
      if (sizeMin) q.size.min = sizeMin;
      if (sizeMax) q.size.max = sizeMax;
    }
    // Kept as a client-side safety net in case a Thunderbird build ignores a criterion.
    const keep = (msg) => {
      if (tag && !(msg.tags || []).includes(tag)) return false;
      if (sizeMin && (msg.size || 0) < sizeMin) return false;
      if (sizeMax && (msg.size || 0) > sizeMax) return false;
      return true;
    };

    const run = () => {
      if (headerMessageId || sort === "none") {
        return collectMessages(() => runQuery(q), limit, { offset, keep });
      }
      return collectNewestPage(q, limit, offset, keep, { dedupe: dedupe !== false, ctx });
    };

    let result;
    try {
      result = await run();
    } catch (e) {
      if (mode !== "fulltext") throw e;
      // Thunderbird without fullText support: fall back to a body scan.
      delete q.fullText;
      q.body = query;
      mode = "body";
      result = await run();
    }
    if (mode) result.searchMode = mode;
    return result;
  }

  // ─── List messages in folder ────────────────────────────────────

  if (path === "/messages/list" && method === "POST") {
    const { folderId, limit = 25, unreadOnly = false,
            offset = 0, sort = "date", sortOrder = "desc", flagged } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    if (!folder) return { error: "Folder not found" };
    const filters = { unreadOnly, flaggedOnly: flagged || false };

    if (sort === "none") {
      return await collectMessages(
        () => messenger.messages.list(folder), limit, { ...filters, offset }
      );
    }

    // Thunderbird 128+ sorts inside the folder database (much cheaper than shipping every
    // header over IPC), so the first page already holds the newest messages.
    const sortType = LIST_SORT_TYPES[sort];
    if (sortType) {
      const native = { sortType, sortOrder: sortOrder === "asc" ? "ascending" : "descending" };
      let firstPage = null;
      try {
        firstPage = await messenger.messages.list(folder, native);
      } catch {
        firstPage = null; // older Thunderbird: no list options, sort below instead
      }
      if (firstPage) {
        return await collectMessages(async () => firstPage, limit, { ...filters, offset });
      }
    }

    // Fallback: sort the whole (filtered) folder before offset/limit are applied — otherwise
    // the "newest" page is just the first N messages in database order re-ordered.
    const all = await collectMessages(
      () => messenger.messages.list(folder), Infinity, { ...filters, offset: 0 }
    );
    const dir = sortOrder === "asc" ? 1 : -1;
    all.messages.sort((a, b) => {
      if (sort === "date") return dir * (new Date(a.date) - new Date(b.date));
      if (sort === "from") return dir * (a.author || "").localeCompare(b.author || "");
      if (sort === "subject") return dir * (a.subject || "").localeCompare(b.subject || "");
      if (sort === "size") return dir * ((a.size || 0) - (b.size || 0));
      return 0;
    });
    const messages = all.messages.slice(offset, offset + limit);
    return { messages, total: messages.length, offset, hasMore: offset + limit < all.messages.length };
  }

  // ─── Read batch ─────────────────────────────────────────────────

  if (path === "/messages/read-batch" && method === "POST") {
    const { messageIds } = body || {};
    return await mapWithIpcLimit(messageIds || [], async (id) => {
      try {
        const [msg, full] = await Promise.all([
          messenger.messages.get(id),
          messenger.messages.getFull(id),
        ]);
        return { ...formatMessage(msg), parts: extractParts(full) };
      } catch (e) {
        return { id, error: e.message };
      }
    });
  }

  // ─── Fetch (force download) ─────────────────────────────────────

  if (path === "/messages/fetch" && method === "POST") {
    body = body || {};
    if (body.messageId) {
      const raw = await messenger.messages.getRaw(body.messageId);
      return { downloaded: true, size: typeof raw === "string" ? raw.length : 0 };
    }
    if (body.folderId) {
      const folder = await messenger.folders.get(body.folderId, false);
      const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
      const fetched = await fetchRawAll(result.messages);
      return { fetched, total: result.messages.length };
    }
    return { error: "Provide messageId or folderId" };
  }

  // ─── Archive ────────────────────────────────────────────────────

  if (path === "/messages/archive" && method === "POST") {
    const { messageIds } = body || {};
    await messenger.messages.archive(messageIds);
    return { success: true, archived: messageIds.length };
  }

  // ─── Move ───────────────────────────────────────────────────────

  if (path === "/messages/move" && method === "POST") {
    const { messageIds, destinationFolderId } = body;
    const folder = await messenger.folders.get(destinationFolderId, false);
    await messenger.messages.move(messageIds, folder);
    return { success: true, moved: messageIds.length };
  }

  // ─── Copy ───────────────────────────────────────────────────────

  if (path === "/messages/copy" && method === "POST") {
    const { messageIds, destinationFolderId } = body;
    const folder = await messenger.folders.get(destinationFolderId, false);
    await messenger.messages.copy(messageIds, folder);
    return { success: true, copied: messageIds.length };
  }

  // ─── Delete ─────────────────────────────────────────────────────

  // Move to the account's Trash (recoverable); draftsOnly limits it to drafts.
  if (path === "/messages/trash" && method === "POST") {
    const { messageIds, draftsOnly = false } = body || {};
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return { error: "messageIds must be a non-empty array" };
    }
    return await deleteToTrash(messageIds, { draftsOnly });
  }

  if (path === "/messages/delete" && method === "POST") {
    const { messageIds, permanent = false } = body || {};
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return { error: "messageIds must be a non-empty array" };
    }
    if (permanent) {
      await messenger.messages.delete(messageIds, true);
      return { success: true, deleted: messageIds.length, permanent: true };
    }
    // Without permanent: to the trash, never by the account's deletion setting.
    return await deleteToTrash(messageIds);
  }

  // ─── Update (mark read/flagged/junk/tags) ───────────────────────

  if (path === "/messages/update" && method === "POST") {
    const { messageId, read, flagged, junk, tags } = body;
    const props = {};
    if (read !== undefined) props.read = read;
    if (flagged !== undefined) props.flagged = flagged;
    if (junk !== undefined) props.junk = junk;
    if (tags !== undefined) props.tags = tags;
    await messenger.messages.update(messageId, props);
    return { success: true };
  }

  // ─── Message sub-routes (order matters: specific before generic) ─

  // Raw message
  const rawMatch = path.match(/^\/messages\/(\d+)\/raw$/);
  if (rawMatch && method === "GET") {
    const raw = await messenger.messages.getRaw(parseInt(rawMatch[1]));
    return { raw };
  }

  // Headers only
  const headersMatch = path.match(/^\/messages\/(\d+)\/headers$/);
  if (headersMatch && method === "GET") {
    const msgId = parseInt(headersMatch[1]);
    const msg = await messenger.messages.get(msgId);
    return formatMessage(msg);
  }

  // Full read including HTML
  const fullMatch = path.match(/^\/messages\/(\d+)\/full$/);
  if (fullMatch && method === "GET") {
    const msgId = parseInt(fullMatch[1]);
    const msg = await messenger.messages.get(msgId);
    const full = await messenger.messages.getFull(msgId);
    const parts = extractParts(full);
    return { ...formatMessage(msg), parts };
  }

  // Check download state
  const checkDlMatch = path.match(/^\/messages\/(\d+)\/check-download$/);
  if (checkDlMatch && method === "GET") {
    const msgId = parseInt(checkDlMatch[1]);
    const msg = await messenger.messages.get(msgId);
    let downloadState = "unknown";
    try {
      const full = await messenger.messages.getFull(msgId);
      const parts = extractParts(full);
      downloadState = (parts.text || parts.html) ? "full" : "headers_only";
    } catch {
      downloadState = "headers_only";
    }
    return {
      id: msg.id, downloadState, size: msg.size,
      hasBody: downloadState === "full",
      hasAttachments: false,
    };
  }

  // Download status
  const dlStatusMatch = path.match(/^\/messages\/(\d+)\/download-status$/);
  if (dlStatusMatch && method === "GET") {
    const msgId = parseInt(dlStatusMatch[1]);
    const msg = await messenger.messages.get(msgId);
    let state = "headers_only";
    try {
      const full = await messenger.messages.getFull(msgId);
      const parts = extractParts(full);
      if (parts.text || parts.html) state = "full";
    } catch { /* headers_only */ }
    return { state, size: msg.size };
  }

  // Attachments list
  const attachmentsMatch = path.match(/^\/messages\/(\d+)\/attachments$/);
  if (attachmentsMatch && method === "GET") {
    const msgId = parseInt(attachmentsMatch[1]);
    const full = await messenger.messages.getFull(msgId);
    const parts = extractParts(full);
    return parts.attachments;
  }

  // Download specific attachment
  const attachmentMatch = path.match(/^\/messages\/(\d+)\/attachment$/);
  if (attachmentMatch && method === "POST") {
    const msgId = parseInt(attachmentMatch[1]);
    const { partName } = body || {};
    const file = await messenger.messages.getAttachmentFile(msgId, partName);
    const buffer = await file.arrayBuffer();
    const base64 = bytesToBase64(new Uint8Array(buffer));
    return { name: file.name, size: file.size, contentType: file.type, data: base64 };
  }

  // Thread
  const threadMatch = path.match(/^\/messages\/(\d+)\/thread$/);
  if (threadMatch && method === "GET") {
    const msgId = parseInt(threadMatch[1]);
    const msg = await messenger.messages.get(msgId);

    // getFull() does not reliably expose RFC 2822 headers; parse them from the raw source.
    let ids = new Set();
    try {
      const raw = await messenger.messages.getRaw(msgId);
      if (typeof raw === "string") ids = buildThreadIds(raw);
    } catch {}
    if (ids.size === 0) {
      try {
        const full = await messenger.messages.getFull(msgId);
        const header = (name) => full.headers?.[name]?.[0] || "";
        ids = new Set([
          ...parseReferences(header("references")),
          ...parseReferences(header("in-reply-to")),
          stripAngleBrackets(header("message-id")),
        ].filter(Boolean));
      } catch {}
    }
    // messages.query() matches headerMessageId without angle brackets
    if (msg?.headerMessageId) ids.add(stripAngleBrackets(msg.headerMessageId));

    // Copies of one mail (Gmail labels, All Mail) collapse into one thread entry; a match via
    // References outranks the subject heuristic.
    const dedupe = body?.dedupe !== false;
    const found = new Map();
    const how = new Map();
    const add = (m, threadMatch) => {
      const key = addCopy(found, m, dedupe);
      if (how.get(key) !== "references") how.set(key, threadMatch);
    };

    // Upstream: every message named in References / In-Reply-To
    const pages = await mapWithIpcLimit([...ids], async (hdrId) => {
      try {
        return (await messenger.messages.query({ headerMessageId: hdrId }))?.messages || [];
      } catch {
        return [];
      }
    });
    for (const messages of pages) messages.forEach((m) => add(m, "references"));

    // Downstream: replies that don't reference this message yet share its normalized subject.
    // Thunderbird's subject query is a substring match, so keep exact matches only; these are
    // heuristic, so they are labelled and junk is excluded.
    const norm = normalizeSubject(msg?.subject || "");
    if (norm) {
      try {
        const r = await messenger.messages.query({ subject: norm, junk: false });
        for (const m of r?.messages || []) {
          if (normalizeSubject(m.subject || "").toLowerCase() === norm.toLowerCase()) add(m, "subject");
        }
      } catch {}
    }

    const thread = [...found].map(([key, entry]) => ({ ...formatCopies(entry), threadMatch: how.get(key) }));
    thread.sort((a, b) => new Date(a.date) - new Date(b.date));
    return { thread, count: thread.length };
  }

  // Read message (default — must be AFTER all /messages/:id/* sub-routes)
  const msgMatch = path.match(/^\/messages\/(\d+)$/);
  if (msgMatch && method === "GET") {
    const msgId = parseInt(msgMatch[1]);
    const msg = await messenger.messages.get(msgId);
    if (!msg) return { error: "Message not found" };
    const full = await messenger.messages.getFull(msgId);
    return { ...formatMessage(msg), parts: extractParts(full) };
  }

  // ─── Tags ───────────────────────────────────────────────────────

  if (path === "/tags" && method === "GET") {
    return await messenger.messages.listTags();
  }

  if (path === "/tags/create" && method === "POST") {
    const { key, tag, color } = body || {};
    await messenger.messages.createTag(key, tag, color);
    return { success: true, key, tag, color };
  }

  // ─── Compose ────────────────────────────────────────────────────

  if (path === "/drafts/update" && method === "POST") {
    return await editDraft(body || {});
  }

  if (path === "/compose" && method === "POST") {
    const { to, cc, bcc, subject, body: msgBody = "", isHTML = false,
            identityId, send = false, open = false, priority } = body || {};
    const files = decodeAttachments(body?.attachments); // bad input fails before a window opens
    const details = {};
    if (to) details.to = recipientList(to);
    if (cc) details.cc = recipientList(cc);
    if (bcc) details.bcc = recipientList(bcc);
    if (subject) details.subject = subject;
    if (isHTML) { details.isPlainText = false; details.body = msgBody; }
    else { details.isPlainText = true; details.plainTextBody = msgBody; }
    if (identityId) details.identityId = identityId;
    if (priority) details.customHeaders = [{ name: "X-Priority", value: priorityToValue(priority) }];
    const tab = await messenger.compose.beginNew(null, details);
    return await finishCompose(tab, { send, open, files });
  }

  // ─── Reply ──────────────────────────────────────────────────────

  if (path === "/reply" && method === "POST") {
    const { messageId, body: replyBody = "", replyAll = false,
            send = false, open = false } = body || {};
    const files = decodeAttachments(body?.attachments);
    const type = replyAll ? "replyToAll" : "replyToSender";
    const tab = await messenger.compose.beginReply(messageId, type, {
      isPlainText: true, plainTextBody: replyBody,
    });
    return await finishCompose(tab, { send, open, files });
  }

  // ─── Forward ────────────────────────────────────────────────────

  if (path === "/forward" && method === "POST") {
    const { messageId, to, body: fwdBody,
            send = false, open = false } = body || {};
    const files = decodeAttachments(body?.attachments);
    const tab = await messenger.compose.beginForward(
      messageId, "forwardAsAttachment",
      { to: recipientList(to), isPlainText: true, plainTextBody: fwdBody || "" }
    );
    return await finishCompose(tab, { send, open, files });
  }

  // ─── Stats (GET — legacy) ──────────────────────────────────────

  if (path === "/stats" && (method === "GET" || method === "POST")) {
    const accounts = await messenger.accounts.list(true);
    const accts = method === "POST" && body?.accountId
      ? accounts.filter((a) => a.id === body.accountId)
      : accounts;
    const withFolders = method === "POST" && !!body?.folders;
    // One bounded-parallel pass over every folder of every account instead of one sequential
    // getFolderInfo() round trip per folder.
    const stats = await Promise.all(accts.map(async (account) => {
      const folders = account.rootFolder ? await flattenFolders(account.rootFolder) : [];
      const s = { id: account.id, name: account.name, type: account.type,
        email: account.identities?.[0]?.email || "unknown",
        folders: folders.length,
        unreadTotal: folders.reduce((n, f) => n + f.unreadMessageCount, 0),
        messageTotal: folders.reduce((n, f) => n + f.totalMessageCount, 0) };
      if (withFolders) s.folderDetails = folders;
      return s;
    }));
    return {
      totalAccounts: stats.length,
      totalUnread: stats.reduce((s, a) => s + a.unreadTotal, 0),
      totalMessages: stats.reduce((s, a) => s + a.messageTotal, 0),
      accounts: stats,
    };
  }

  // ─── Recent ─────────────────────────────────────────────────────

  if (path === "/recent" && method === "POST") {
    const { hours = 24, limit = 50, accountId, unreadOnly = false, includeJunk = false,
            dedupe = true } = body || {};
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    // Filters go into the query so Thunderbird skips non-matching headers itself; the page
    // is the true newest `limit` (previously: the first `limit` found, then sorted).
    const q = { fromDate: since };
    if (accountId) q.accountId = accountId;
    if (unreadOnly) q.unread = true;
    if (!includeJunk) q.junk = false;
    const keep = (msg) =>
      (!unreadOnly || !msg.read) && (!accountId || msg.folder?.accountId === accountId);
    const result = await collectNewestPage(q, limit, 0, keep, { dedupe: dedupe !== false, ctx });
    result.since = since.toISOString();
    return result;
  }

  // ─── Contacts search (must be before /contacts/:id) ─────────────

  if (path === "/contacts/search" && method === "POST") {
    const { query, book, limit: contactLimit } = body || {};
    const books = await messenger.addressBooks.list();
    const all = [];
    for (const b of books) {
      if (book && b.id !== book && b.name !== book) continue;
      const contacts = await messenger.contacts.list(b.id);
      for (const c of contacts) {
        const name = c.properties?.DisplayName || "";
        const email = c.properties?.PrimaryEmail || "";
        if (query) {
          const q = query.toLowerCase();
          if (!name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) continue;
        }
        all.push({ id: c.id, name, email, book: b.name });
        if (contactLimit && all.length >= contactLimit) break;
      }
      if (contactLimit && all.length >= contactLimit) break;
    }
    return all;
  }

  // ─── Contacts list ──────────────────────────────────────────────

  if (path === "/contacts" && method === "GET") {
    const books = await messenger.addressBooks.list();
    const all = [];
    for (const book of books) {
      const contacts = await messenger.contacts.list(book.id);
      for (const c of contacts) {
        all.push({
          id: c.id, name: c.properties?.DisplayName || "",
          email: c.properties?.PrimaryEmail || "", book: book.name,
        });
      }
    }
    return all;
  }

  // ─── Contact by ID ─────────────────────────────────────────────

  const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
  if (contactMatch && method === "GET") {
    const contactId = contactMatch[1];
    const contact = await messenger.contacts.get(contactId);
    return { id: contact.id, properties: contact.properties };
  }

  // ─── Sync ───────────────────────────────────────────────────────

  if (path === "/sync" && method === "POST") {
    if (body && body.all) {
      const accounts = await messenger.accounts.list(true);
      for (const acct of accounts) {
        if (acct.rootFolder) await messenger.folders.getSubFolders(acct.rootFolder, false);
      }
      return { success: true, synced: "all" };
    }
    if (body && body.folderId) {
      const folder = await messenger.folders.get(body.folderId, false);
      await messenger.folders.getSubFolders(folder, false);
      return { success: true, synced: body.folderId };
    }
    return { error: "Provide folderId or all: true" };
  }

  if (path === "/sync/status" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    return {
      folderId: folder.id, totalMessages: folder.totalMessageCount,
      unread: folder.unreadMessageCount, type: folder.type, name: folder.name,
    };
  }

  // ─── Bulk operations ───────────────────────────────────────────

  if (path === "/bulk/delete" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const filtered = filterBulkMessages(result.messages, body);
    if (filtered.length > 0) {
      await messenger.messages.delete(filtered.map((m) => m.id), false);
    }
    return { success: true, deleted: filtered.length };
  }

  if (path === "/bulk/tag" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const toTag = filterBulkMessages(result.messages, body)
      .filter((msg) => !(msg.tags || []).includes(body.tagKey));
    await mapWithIpcLimit(toTag, (msg) =>
      messenger.messages.update(msg.id, { tags: [...(msg.tags || []), body.tagKey] })
    );
    return { success: true, tagged: toTag.length };
  }

  if (path === "/bulk/fetch" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const fetched = await fetchRawAll(result.messages);
    return { success: true, fetched, total: result.messages.length };
  }

  // ─── Not found ─────────────────────────────────────────────────

  return { error: `Not found: ${method} ${path}` };
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatMessage(msg) {
  return {
    id: msg.id,
    date: msg.date?.toISOString(),
    author: msg.author,
    subject: msg.subject,
    read: msg.read,
    flagged: msg.flagged,
    junk: msg.junk,
    size: msg.size,
    tags: msg.tags || [],
    folder: msg.folder
      ? { accountId: msg.folder.accountId, path: msg.folder.path, name: msg.folder.name }
      : null,
    recipients: msg.recipients,
    ccList: msg.ccList,
    bccList: msg.bccList,
    headerMessageId: msg.headerMessageId,
  };
}

function extractParts(part, result = { text: "", html: "", attachments: [] }) {
  if (!part) return result;
  const ct = (part.contentType || "").toLowerCase();
  // A text/plain or text/html part that is a file (.txt, .csv, .ics, an attached .html) is an
  // attachment, not body text: concatenating it would bloat the body and hide the file.
  const disposition = String(part.headers?.["content-disposition"]?.[0] || "").toLowerCase();
  const isFile = !!part.name || disposition.startsWith("attachment");
  if (ct === "text/plain" && part.body && !isFile) result.text += part.body;
  else if (ct === "text/html" && part.body && !isFile) result.html += part.body;
  else if (part.partName && (isFile || (ct && !ct.startsWith("multipart/")))) {
    result.attachments.push({
      name: part.name || "unnamed", contentType: ct,
      partName: part.partName, size: part.size,
    });
  }
  if (part.parts) for (const sub of part.parts) extractParts(sub, result);
  return result;
}

/** Every folder below (and including) `root`, with message counts, depth-first order. */
async function flattenFolders(root) {
  const folders = [];
  const walk = (folder, depth) => {
    folders.push({ folder, depth });
    for (const sub of folder.subFolders || []) walk(sub, depth + 1);
  };
  walk(root, 0);
  // getFolderInfo() is one IPC round trip per folder; run them bounded-parallel.
  return await mapWithIpcLimit(folders, async ({ folder, depth }) => {
    let info = {};
    try { info = await messenger.folders.getFolderInfo(folder); } catch {}
    return {
      id: folder.id, name: folder.name, path: folder.path,
      type: folder.type,
      unreadMessageCount: info.unreadMessageCount || 0,
      totalMessageCount: info.totalMessageCount || 0,
      depth,
    };
  });
}

/**
 * messages.query() with optional extras Thunderbird may not know (older builds reject the whole
 * query for an unknown property): bigger pages by default, plus e.g. returnMessageListId.
 * An extra that is rejected once is dropped for the rest of the session.
 */
async function runQuery(q, extras = {}) {
  const wanted = { messagesPerPage: QUERY_PAGE_SIZE, ...extras };
  for (;;) {
    const opts = {};
    for (const [k, v] of Object.entries(wanted)) if (!unsupportedQueryProps.has(k)) opts[k] = v;
    try {
      return await messenger.messages.query({ ...opts, ...q });
    } catch (e) {
      const bad = Object.keys(opts).find((k) => (e?.message || "").includes(k));
      if (!bad) throw e;
      unsupportedQueryProps.add(bad);
    }
  }
}

/**
 * Read a message list to the end, or until stopped. `handle` is what messages.query() returned:
 * a list id (with returnMessageListId) or a first page (older Thunderbird).
 *
 * Thunderbird only hands out a page once it holds at least one hit, so a rare full-text term can
 * block continueList() for minutes. Holding the list id lets a timer (soft deadline) or the
 * bridge's cancel abort the list from outside: abortList() makes Thunderbird stop searching and
 * resolves the pending page with whatever it found.
 *
 * onMessage(msg) returns false to stop (cap reached). Resolves to null when the list was read
 * completely, otherwise "partial" (deadline/cancel) or "truncated" (cap).
 */
async function drainList(handle, ctx, onMessage) {
  let listId = typeof handle === "string" ? handle : null;
  let page = typeof handle === "string" ? null : handle;
  let stopped = null;
  const stop = (why) => {
    if (!stopped) stopped = why;
    if (listId) abandonList({ id: listId });
  };
  let timer = null;
  if (ctx && listId) {
    const left = ctx.deadline - Date.now();
    if (Number.isFinite(left)) timer = setTimeout(() => stop("partial"), Math.max(0, left));
    ctx.onCancel = () => stop("partial");
  }
  try {
    if (!page && listId) page = await messenger.messages.continueList(listId);
    while (page) {
      for (const msg of page.messages) {
        if (onMessage(msg) === false) { stop("truncated"); break; }
      }
      if (stopped || !page.id) break;
      listId = page.id;
      if (shouldStop(ctx)) { stop("partial"); break; }
      page = await messenger.messages.continueList(page.id);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (ctx) ctx.onCancel = null;
  }
  return stopped;
}

/** Stop a message list we no longer read, so Thunderbird stops searching in the background. */
function abandonList(page) {
  if (!page?.id) return;
  try {
    const r = messenger.messages.abortList?.(page.id);
    r?.catch?.(() => {});
  } catch {}
}

async function collectMessages(queryFn, limit,
  { unreadOnly = false, flaggedOnly = false, offset = 0, accountId = null, keep = null } = {}) {
  let page = await queryFn();
  const messages = [];
  let skipped = 0;
  while (page && messages.length < limit) {
    for (const msg of page.messages) {
      if (unreadOnly && msg.read) continue;
      if (flaggedOnly && !msg.flagged) continue;
      if (accountId && msg.folder?.accountId !== accountId) continue;
      if (keep && !keep(msg)) continue;
      if (skipped < offset) { skipped++; continue; }
      messages.push(formatMessage(msg));
      if (messages.length >= limit) break;
    }
    if (page.id && messages.length < limit) {
      page = await messenger.messages.continueList(page.id);
    } else break;
  }
  const hasMore = !!page?.id;
  if (hasMore) abandonList(page);
  return { messages, total: messages.length, offset, hasMore };
}

/**
 * Newest-first page of a query, without reading the whole mailbox.
 *
 * messages.query() returns hits in folder/database order, so "first N found" are typically the
 * oldest. Instead, query disjoint date slices walking back from now (7 days, 60 days, 1 year,
 * everything older). Every message in a later slice is older than every message in an earlier
 * one, so once `offset + limit` hits are collected the newest page is exact and older slices
 * are never touched. A broad query usually stops after the first slice; a narrow one costs at
 * most four passes, and because Thunderbird checks dates before parsing bodies, text searches
 * only parse messages inside the slices actually visited.
 *
 * With a request context (`ctx`), the walk stops when the bridge cancels or the soft deadline
 * passes, and returns what it has: `partial: true` plus `searchedBackTo`, the date down to which
 * every message was checked. Hits older than that may be missing.
 */
async function collectNewestPage(q, limit, offset = 0, keep = null, { dedupe = true, ctx = null } = {}) {
  const needed = offset + limit;
  const upper = q.toDate ? q.toDate.getTime() : Infinity;
  const lower = q.fromDate ? q.fromDate.getTime() : -Infinity;
  // Slices are measured back from the top of the searched range (now, or `until` when a search
  // is continued), so a continuation again starts with a small slice that can finish in time.
  // Thunderbird scans a slice folder by folder, not by date, so only finished slices give a
  // date up to which the search is complete.
  const anchor = Number.isFinite(upper) ? upper : Date.now();
  const cuts = NEWEST_SLICES_DAYS.map((d) => anchor - d * DAY_MS).filter((t) => t > lower && t < upper);
  cuts.push(lower);

  // Unique messages (copies collapsed, see addCopy), so `limit` counts distinct mails.
  const found = new Map();
  let end = upper; // everything newer than `end` (within the query) has been checked
  let truncated = false;
  let partial = false;
  let slices = 0;
  let exhausted = true;
  for (let i = 0; i < cuts.length && !partial; i++) {
    if (shouldStop(ctx)) { partial = true; break; }
    const cut = cuts[i];
    const sq = { ...q };
    if (end === Infinity) delete sq.toDate; else sq.toDate = new Date(end);
    if (cut === -Infinity) delete sq.fromDate; else sq.fromDate = new Date(cut);

    const handle = await runQuery(sq, { returnMessageListId: true });
    slices++;
    const stopped = await drainList(handle, ctx, (msg) => {
      if (!keep || keep(msg)) addCopy(found, msg, dedupe);
      return found.size < MAX_NEWEST_SCAN;
    });
    if (stopped === "truncated") truncated = true;
    if (stopped === "partial") partial = true;
    if (truncated || partial) break;
    end = cut;
    if (found.size >= needed) {
      exhausted = i === cuts.length - 1;
      break;
    }
  }

  const sorted = [...found.values()].sort((a, b) => b.best.date - a.best.date);
  const messages = sorted.slice(offset, needed).map(formatCopies);
  const result = {
    messages, total: messages.length, offset,
    hasMore: sorted.length > needed || !exhausted || partial,
    order: "newest",
    slicesScanned: slices,
  };
  if (truncated) {
    result.truncated = true;
    result.note = `More than ${MAX_NEWEST_SCAN} hits in one date range; narrow the search (date, account, folder) for exact newest-first order.`;
  }
  if (partial) {
    const back = end === Infinity ? null : new Date(end).toISOString();
    result.partial = true;
    result.searchedBackTo = back;
    if (ctx?.cancelled) {
      result.note = "Search was cancelled; results are incomplete.";
    } else if (end === upper) {
      // Not even the first slice finished: there is no date up to which the result is complete.
      result.note = "Time limit reached before any date range was searched completely. " +
        "Narrow the search: accountId, folderId, or a shorter since/until window.";
    } else {
      result.note = `Time limit reached: every message newer than ${back.slice(0, 10)} was checked, older ones were not (fully). ` +
        "Narrow the search (since, accountId, folderId) or continue with until set to that date.";
    }
  }
  return result;
}

/**
 * Which copy of a message represents it: lower is better. Gmail (and other label-based IMAP
 * servers) expose one mail in INBOX, "[Gmail]/All Mail", "[Gmail]/Important" and every label
 * folder; the inbox copy is the one an agent should read and act on (archiving it removes the
 * inbox label), then a real folder/label, then Gmail's virtual folders.
 */
function copyRank(msg) {
  const f = msg.folder || {};
  const use = [...(f.specialUse || []), ...(f.type ? [f.type] : [])];
  if (use.includes("inbox")) return 0;
  if (use.includes("sent") || use.includes("drafts")) return 1;
  if (use.includes("trash") || use.includes("junk")) return 5;
  if (use.includes("all") || use.includes("archives")) return 4;
  if (/^\/\[(gmail|google mail)\]\//i.test(f.path || "")) return 3;
  return 2;
}

/**
 * Add a header to a Map of unique messages, collapsing copies of the same mail within one
 * account (same Message-ID). Copies in different accounts stay separate: "sent from account A"
 * and "received in account B" are different facts. Same id twice (inclusive slice bounds) is ignored.
 * Returns the message's key in `found`.
 */
function addCopy(found, msg, dedupe = true) {
  const hdr = dedupe && msg.headerMessageId ? stripAngleBrackets(msg.headerMessageId) : null;
  const key = hdr ? `${msg.folder?.accountId || ""}|${hdr}` : `id:${msg.id}`;
  const entry = found.get(key);
  if (!entry) {
    found.set(key, { best: msg, copies: [msg] });
  } else if (!entry.copies.some((c) => c.id === msg.id)) {
    entry.copies.push(msg);
    if (copyRank(msg) < copyRank(entry.best)) entry.best = msg;
  }
  return key;
}

/** formatMessage() of the representative copy, plus the other folders it sits in. */
function formatCopies(entry) {
  const out = formatMessage(entry.best);
  const others = entry.copies.filter((c) => c !== entry.best).map((c) => c.folder?.path).filter(Boolean);
  if (others.length) out.alsoIn = [...new Set(others)];
  return out;
}

// ─── Delete ─────────────────────────────────────────────────────────

function hasSpecialUse(folder, use) {
  return !!folder && ((folder.specialUse || []).includes(use) || folder.type === use);
}

const isDraft = (msg) => hasSpecialUse(msg?.folder, "drafts");

/** The account's Trash folder (MailFolder), or null. */
async function findTrashFolder(accountId) {
  const account = accountId ? await messenger.accounts.get(accountId, true) : null;
  let found = null;
  const walk = (folder) => {
    if (found || !folder) return;
    if (hasSpecialUse(folder, "trash") && !folder.isVirtual) found = folder;
    else for (const sub of folder.subFolders || []) walk(sub);
  };
  walk(account?.rootFolder);
  return found;
}

/**
 * "Delete" as a move to the account's Trash folder, so it can always be undone. messages.delete()
 * without skipTrash follows the account's deletion setting instead: an IMAP account set to
 * "remove immediately" deletes for good, and deleting inside Trash is always permanent. Staying
 * recoverable is what lets the bridge allow this below policy "full".
 *
 * With draftsOnly, only messages in a Drafts folder are moved; the others come back in
 * notDrafts, untouched. Messages already in Trash stay there (alreadyInTrash): removing them is
 * a permanent delete. Every id is checked before anything moves.
 */
async function deleteToTrash(messageIds, { draftsOnly = false } = {}) {
  const headers = await mapWithIpcLimit(messageIds, (id) => messenger.messages.get(id));
  const notDrafts = [];
  const alreadyInTrash = [];
  const byAccount = new Map();
  headers.forEach((msg, i) => {
    const id = messageIds[i];
    if (!msg) throw new Error(`Message ${id} not found`);
    if (draftsOnly && !isDraft(msg)) { notDrafts.push(id); return; }
    if (hasSpecialUse(msg.folder, "trash")) { alreadyInTrash.push(id); return; }
    const accountId = msg.folder?.accountId;
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(id);
  });

  const trashes = new Map();
  for (const accountId of byAccount.keys()) {
    const trash = await findTrashFolder(accountId);
    if (!trash) {
      throw new Error(`Account ${accountId} has no Trash folder; nothing was deleted. ` +
        "Move the messages to a folder instead, or delete them permanently (permanent: true).");
    }
    trashes.set(accountId, trash);
  }

  let deleted = 0;
  for (const [accountId, ids] of byAccount) {
    await messenger.messages.move(ids, trashes.get(accountId));
    deleted += ids.length;
  }
  const result = { success: true, deleted, movedTo: "trash" };
  if (notDrafts.length) result.notDrafts = notDrafts;
  if (alreadyInTrash.length) {
    result.alreadyInTrash = alreadyInTrash;
    result.note = "Messages already in Trash were left there; removing them from Trash is a permanent delete (permanent: true).";
  }
  return result;
}

// ─── Compose ────────────────────────────────────────────────────────

// Thunderbird stores the content type the File carries; fill it in for common files when the
// caller sends none.
const ATTACHMENT_TYPES = {
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", html: "text/html", htm: "text/html",
  ics: "text/calendar", vcf: "text/vcard", xml: "application/xml", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", heic: "image/heic", zip: "application/zip", eml: "message/rfc822",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime",
};

const recipientList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Uploaded attachments ([{ name, data: base64, contentType? }]) as File objects. A pure
 * WebExtension cannot open local paths, so callers send the bytes.
 */
function decodeAttachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("attachments must be an array of { name, data }");
  return list.map((a, i) => {
    if (!a || typeof a.name !== "string" || !a.name.trim() || typeof a.data !== "string") {
      throw new Error(`attachments[${i}] needs a name and base64 data`);
    }
    let bytes;
    try {
      bytes = base64ToBytes(a.data);
    } catch {
      throw new Error(`attachments[${i}] (${a.name}): data is not valid base64`);
    }
    const ext = /\.([0-9a-z]+)$/i.exec(a.name)?.[1]?.toLowerCase();
    return new File([bytes], a.name, { type: a.contentType || ATTACHMENT_TYPES[ext] || "" });
  });
}

/** Close a compose window we could not finish, without Thunderbird asking to save it. */
async function discardCompose(tabId) {
  try { await messenger.compose.setComposeDetails(tabId, { isModified: false }); } catch {}
  try { await messenger.tabs.remove(tabId); } catch {}
}

/**
 * Attach files to an open compose window, then send it, leave it open for the human, or save it
 * as a draft and close it (default). If preparing or attaching fails, the window is closed
 * unsaved, so a half-built message is never sent or saved.
 */
async function finishCompose(tab, { send = false, open = false, files = [], prepare = null, listAll = false } = {}) {
  let attachments = [];
  try {
    if (prepare) await prepare(tab);
    for (const file of files) {
      const added = await messenger.compose.addAttachment(tab.id, { file, name: file.name });
      attachments.push({ name: added?.name ?? file.name, size: file.size });
    }
    // An edited draft reports every attachment it now has, not only the added ones.
    if (listAll) {
      attachments = (await messenger.compose.listAttachments(tab.id)).map(({ name, size }) => ({ name, size }));
    }
  } catch (e) {
    await discardCompose(tab.id);
    throw e;
  }
  const extra = attachments.length || listAll ? { attachments } : {};
  if (send) {
    await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
    return { success: true, action: "sent", ...extra };
  }
  if (open) return { success: true, action: "draft_opened", tabId: tab.id, ...extra };
  const saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
  await messenger.tabs.remove(tab.id);
  const draftId = saved?.messages?.[0]?.id;
  return { success: true, action: "draft_saved", ...(draftId != null ? { draftId } : {}), ...extra };
}

async function removeComposeAttachments(tabId, names, draftId) {
  const current = await messenger.compose.listAttachments(tabId);
  const missing = names.filter((n) => !current.some((a) => a.name === n));
  if (missing.length) {
    const has = current.map((a) => `"${a.name}"`).join(", ") || "none";
    throw new Error(`Draft ${draftId} has no attachment named ${missing.map((n) => `"${n}"`).join(", ")} ` +
      `(it has: ${has}); nothing was changed.`);
  }
  for (const a of current) {
    if (names.includes(a.name)) await messenger.compose.removeAttachment(tabId, a.id);
  }
}

function plainToHtml(text) {
  const escaped = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\r?\n/g, "<br>");
}

function htmlToPlain(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/**
 * Edit a saved draft: change recipients, subject or body, add or remove attachments.
 *
 * compose.beginNew(draftId) opens a copy of the draft (Thunderbird's "edit as new": recipients,
 * body, attachments and References are kept), so saving writes a new draft with a new id. The
 * original is then moved to the trash. Only messages in a Drafts folder can be edited, which is
 * what lets the bridge allow this at policy "draft".
 */
/** true if the draft has no HTML body, null if that cannot be read (default editor then). */
async function isPlainTextDraft(draftId) {
  try {
    return extractParts(await messenger.messages.getFull(draftId)).html === "";
  } catch {
    return null;
  }
}

async function editDraft(b) {
  const { draftId, send = false, open = false } = b;
  if (draftId == null) throw new Error("draftId is required");
  const draft = await messenger.messages.get(draftId);
  if (!draft) throw new Error(`Message ${draftId} not found`);
  if (!isDraft(draft)) throw new Error(`Message ${draftId} is not in a Drafts folder; only drafts can be edited.`);
  const files = decodeAttachments(b.attachments);
  if (b.removeAttachments != null &&
      (!Array.isArray(b.removeAttachments) || b.removeAttachments.some((n) => typeof n !== "string"))) {
    throw new Error("removeAttachments must be an array of attachment names");
  }
  const remove = [...new Set(b.removeAttachments || [])];

  const details = {};
  if (b.to !== undefined) details.to = recipientList(b.to);
  if (b.cc !== undefined) details.cc = recipientList(b.cc);
  if (b.bcc !== undefined) details.bcc = recipientList(b.bcc);
  if (b.subject !== undefined) details.subject = b.subject;
  if (b.identityId) details.identityId = b.identityId;
  // Thunderbird reopens a draft in the default editor, which turned plain-text drafts into
  // HTML. Keep the draft's format; only an explicit HTML body makes it HTML.
  const plain = b.isHTML ? false : await isPlainTextDraft(draftId);
  if (plain != null) details.isPlainText = plain;
  if (b.body !== undefined) {
    // Given in both formats: Thunderbird uses the one that matches the editor.
    if (b.isHTML) { details.body = b.body; details.plainTextBody = htmlToPlain(b.body); }
    else { details.plainTextBody = b.body; details.body = plainToHtml(b.body); }
  }

  const tab = await messenger.compose.beginNew(draftId, details);
  const prepare = remove.length ? (t) => removeComposeAttachments(t.id, remove, draftId) : null;
  const result = await finishCompose(tab, { send, open, files, prepare, listAll: true });
  result.replacedDraftId = draftId;
  if (open) {
    result.note = "The original draft stays until the edited copy is saved in Thunderbird; delete it afterwards.";
    return result;
  }
  try {
    await deleteToTrash([draftId], { draftsOnly: true });
    result.originalDraftDeleted = true;
  } catch (e) {
    result.originalDraftDeleted = false;
    result.warning = `The edited draft was saved, but the original could not be moved to the trash: ${e.message}`;
  }
  return result;
}

function filterBulkMessages(messages, filters) {
  let result = messages;
  if (filters.olderThan) {
    const cutoff = new Date(Date.now() - parseInt(filters.olderThan) * 86400000);
    result = result.filter((m) => new Date(m.date) < cutoff);
  }
  if (filters.from) {
    const from = filters.from.toLowerCase();
    result = result.filter((m) => (m.author || "").toLowerCase().includes(from));
  }
  if (filters.subject) {
    const subj = filters.subject.toLowerCase();
    result = result.filter((m) => (m.subject || "").toLowerCase().includes(subj));
  }
  return result;
}

function priorityToValue(priority) {
  const map = { highest: "1", high: "2", normal: "3", low: "4", lowest: "5" };
  return map[priority] || "3";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Force-download each message; resolves to how many succeeded. */
async function fetchRawAll(messages) {
  const results = await mapWithIpcLimit(messages, async (msg) => {
    try {
      await messenger.messages.getRaw(msg.id);
      return true;
    } catch {
      return false;
    }
  });
  return results.filter(Boolean).length;
}

/**
 * Map items through an async fn, preserving order, with at most IPC_CONCURRENCY calls in
 * flight across every concurrent request so bulk work can't flood Thunderbird.
 */
function mapWithIpcLimit(items, fn) {
  return Promise.all(items.map((item) => new Promise((resolve, reject) => {
    ipcQueue.push({ run: () => fn(item), resolve, reject });
    drainIpcQueue();
  })));
}

function drainIpcQueue() {
  while (ipcInFlight < IPC_CONCURRENCY && ipcQueue.length > 0) {
    const { run, resolve, reject } = ipcQueue.shift();
    ipcInFlight++;
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => {
        ipcInFlight--;
        drainIpcQueue();
      });
  }
}
