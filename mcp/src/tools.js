/**
 * MCP tool definitions for thunderbird-cli.
 *
 * Each tool has:
 *   - name: tool identifier exposed to MCP clients
 *   - description: what the tool does (read by the LLM)
 *   - inputSchema: JSON Schema for arguments
 *   - handler: async (args, api) => result — calls bridge HTTP API
 *
 * `api` is injected by the server: api(method, path, body?) → response
 */

import { parseRelativeDate } from "./client.js";
import { htmlToText, readAttachmentFiles, saveAttachment, shapeMessages, pickFields } from "./format.js";

// Default cap on body text returned by email_read (characters). Keeps one long newsletter from
// eating the agent's context; pass maxBody: 0 for no limit.
const DEFAULT_MAX_BODY = 20000;
// Newest-first search over a big mailbox can take a while (Thunderbird has no search index for
// messages.query, so text queries parse bodies). Give it time before declaring a timeout.
const SEARCH_TIMEOUT_MS = 120000;

const FIELDS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Only return these message fields, e.g. [\"id\",\"date\",\"author\",\"subject\"] — cheapest for scanning many results. Default: all non-empty fields.",
};

// Saving a draft with attachments (or editing one) can take a while on IMAP.
const COMPOSE_TIMEOUT_MS = 120000;

const ATTACHMENTS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Local files to attach, as absolute paths (e.g. C:\\Users\\me\\Documents\\Rechnung.pdf). Each file is read where it is; at most 20 MB in total.",
};

function truncate(text, max) {
  if (!max || !text || text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "\n...[truncated]", truncated: true };
}

/** Draft / open / send flags shared by compose, reply and forward. */
function applyMode(payload, mode = "draft") {
  if (mode === "send") payload.send = true;
  else if (mode === "open") payload.open = true;
  else payload.draft = true;
  return payload;
}

// First add-on with attachments on compose/reply/forward, /drafts/update and /messages/trash.
const MIN_ADDON = "2.1.1.7";
const OLD_ADDON = `The Thunderbird add-on is older than ${MIN_ADDON} and cannot do this yet; install the current XPI (see docs).`;

function versionAtLeast(version, min) {
  const have = String(version || "").split(".").map((n) => parseInt(n, 10) || 0);
  const want = min.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < want.length; i++) {
    if ((have[i] || 0) !== want[i]) return (have[i] || 0) > want[i];
  }
  return true;
}

/** An extension that does not know a route answers { error: "Not found: ..." }. */
function checkRouteKnown(result) {
  if (typeof result?.error === "string" && result.error.startsWith("Not found:")) {
    throw Object.assign(new Error(OLD_ADDON), { code: "THUNDERBIRD_ERROR" });
  }
  return result;
}

/** Compose-type call with the right timeout, and a readable error when files are too big. */
async function composeCall(api, path, payload) {
  // An older add-on ignores `attachments` and would save, or send, the mail without them:
  // ask for its version before anything is created.
  if (payload.attachments?.length) {
    const health = await api("GET", "/health");
    if (!versionAtLeast(health?.version, MIN_ADDON)) {
      throw Object.assign(new Error(`${OLD_ADDON} Nothing was saved or sent.`), { code: "THUNDERBIRD_ERROR" });
    }
  }
  const slow = payload.attachments?.length || payload.draftId != null;
  let result;
  try {
    result = checkRouteKnown(await api("POST", path, payload, slow ? COMPOSE_TIMEOUT_MS : undefined));
  } catch (err) {
    if (err.code === "PAYLOAD_TOO_LARGE") {
      err.message = "Attachments are larger than the bridge accepts (TB_BRIDGE_MAX_BODY_BYTES, default 32 MiB; files grow by a third in transit).";
    }
    throw err;
  }
  return result;
}

/**
 * Move messages to the trash, drafts first: the bridge allows deleting drafts at policy "draft",
 * other mail needs "organize". So a draft-only batch works at "draft", and a mixed batch tells
 * exactly which ids were refused.
 */
async function deleteToTrash(api, messageIds) {
  const drafts = checkRouteKnown(await api("POST", "/messages/trash", { messageIds, draftsOnly: true }));
  const rest = drafts?.notDrafts || [];
  if (drafts?.error || rest.length === 0) return drafts;
  let others;
  try {
    others = await api("POST", "/messages/trash", { messageIds: rest });
  } catch (err) {
    if (drafts.deleted) {
      err.message = `Moved ${drafts.deleted} draft(s) to the trash; messages ${rest.join(", ")} are not drafts and were not deleted: ${err.message}`;
    }
    throw err;
  }
  if (others?.error) return others;
  const result = { success: true, deleted: (drafts.deleted || 0) + (others.deleted || 0), movedTo: "trash" };
  const inTrash = [...(drafts.alreadyInTrash || []), ...(others.alreadyInTrash || [])];
  if (inTrash.length) {
    result.alreadyInTrash = inTrash;
    result.note = others.note || drafts.note;
  }
  return result;
}

export const tools = [
  // ─── 1. Stats ──────────────────────────────────────────────────
  {
    name: "email_stats",
    description:
      "Get an overview of all email accounts: total accounts, unread counts, message totals. Optionally filter to a single account or include per-folder breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "Optional: limit stats to a specific account ID",
        },
        includeFolders: {
          type: "boolean",
          description: "Include per-folder breakdown",
          default: false,
        },
      },
    },
    handler: async (args, api) => {
      if (args.accountId || args.includeFolders) {
        return await api("POST", "/stats", {
          accountId: args.accountId,
          folders: args.includeFolders,
        });
      }
      return await api("GET", "/stats");
    },
  },

  // ─── 2. Search ─────────────────────────────────────────────────
  {
    name: "email_search",
    description:
      "Search emails across all accounts, newest first. Filters: sender, recipient, subject, date range, attachments, tags, size. Excludes junk by default. " +
      "Text matching (query, subject, from) is a CASE-SENSITIVE substring match — 'rechnung' does not find 'Rechnung'; try the spelling used in the mail, or search twice. " +
      "On large mailboxes a text query is slowest without a date range: add since/until, accountId or folderId when you can. Use fields to cut tokens. " +
      "Copies of one mail in several folders of an account (Gmail labels, All Mail) are returned once, with the other folders in alsoIn. " +
      "If time runs out the result has partial: true and searchedBackTo: everything newer was checked; continue with until=searchedBackTo or narrow the search.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to find. Optional when at least one filter is given",
        },
        searchMode: {
          type: "string",
          enum: ["fulltext", "body"],
          description:
            "fulltext (default): matches subject or author, otherwise the body. body: body only. Neither uses an index — both parse message bodies, so narrow by date/account/folder on big mailboxes.",
        },
        order: {
          type: "string",
          enum: ["newest", "any"],
          description:
            "newest (default): the most recent matches first, exact even across many accounts. any: first matches found in storage order — faster, but usually the oldest.",
        },
        offset: { type: "number", description: "Skip the first N results (pagination, newest order)" },
        fields: FIELDS_SCHEMA,
        dedupe: { type: "boolean", description: "false = return every folder copy separately (default true)" },
        accountId: { type: "string", description: "Limit to specific account" },
        folderId: { type: "string", description: "Limit to specific folder" },
        from: { type: "string", description: "Filter by sender address" },
        to: { type: "string", description: "Filter by recipient address" },
        subject: { type: "string", description: "Filter by subject substring" },
        unread: { type: "boolean", description: "Unread only" },
        flagged: { type: "boolean", description: "Flagged/starred only" },
        tag: { type: "string", description: "Filter by tag key (e.g. $label1)" },
        since: {
          type: "string",
          description:
            "Start date (ISO 8601 or relative: '7d', '2w', '3m', '1y', 'today', 'yesterday')",
        },
        until: { type: "string", description: "End date (ISO or relative)" },
        hasAttachment: { type: "boolean", description: "Only with attachments" },
        sizeMin: { type: "number", description: "Minimum message size in bytes" },
        sizeMax: { type: "number", description: "Maximum message size in bytes" },
        includeJunk: {
          type: "boolean",
          description: "Include junk messages (default: false)",
        },
        limit: { type: "number", description: "Max results", default: 25 },
      },
    },
    handler: async (args, api) => {
      const query = args.query?.trim();
      const hasFilter = [
        "accountId", "folderId", "from", "to", "subject", "unread", "flagged",
        "tag", "since", "until", "hasAttachment", "sizeMin", "sizeMax",
      ].some((key) => args[key]);
      if (!query && !hasFilter) {
        throw Object.assign(
          new Error("email_search requires a query or at least one filter"),
          { code: "INVALID_ARGS" }
        );
      }
      const body = { limit: args.limit || 25 };
      if (query) body.query = query;
      if (args.searchMode) body.searchMode = args.searchMode;
      if (args.offset) body.offset = args.offset;
      if (args.order === "any") body.sort = "none";
      if (args.dedupe === false) body.dedupe = false;
      if (args.accountId) body.accountId = args.accountId;
      if (args.folderId) body.folderId = args.folderId;
      if (args.from) body.fromAddress = args.from;
      if (args.to) body.toAddress = args.to;
      if (args.subject) body.subject = args.subject;
      if (args.unread) body.unreadOnly = true;
      if (args.flagged) body.flagged = true;
      if (args.tag) body.tag = args.tag;
      if (args.since) body.fromDate = parseRelativeDate(args.since);
      if (args.until) body.toDate = parseRelativeDate(args.until);
      if (args.hasAttachment) body.hasAttachment = true;
      if (args.sizeMin) body.sizeMin = args.sizeMin;
      if (args.sizeMax) body.sizeMax = args.sizeMax;
      if (args.includeJunk) body.includeJunk = true;
      try {
        return shapeMessages(await api("POST", "/messages/search", body, SEARCH_TIMEOUT_MS), args.fields);
      } catch (err) {
        if (err.code === "TIMEOUT") {
          err.message =
            "Search timed out before finishing — results are UNKNOWN, not empty. Narrow it with since/until, accountId or folderId.";
        }
        throw err;
      }
    },
  },

  // ─── 2b. Recent ────────────────────────────────────────────────
  {
    name: "email_recent",
    description:
      "Newest messages across all accounts (or one account) from the last N hours, newest first. Cheapest way to answer 'what came in today?'.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Look back this many hours (default 24)" },
        accountId: { type: "string", description: "Limit to one account" },
        unread: { type: "boolean", description: "Unread only" },
        includeJunk: { type: "boolean", description: "Include junk (default false)" },
        dedupe: { type: "boolean", description: "false = every folder copy separately (default true)" },
        limit: { type: "number", description: "Max results (default 50)" },
        fields: FIELDS_SCHEMA,
      },
    },
    handler: async (args, api) => {
      const body = { hours: args.hours || 24, limit: args.limit || 50 };
      if (args.accountId) body.accountId = args.accountId;
      if (args.unread) body.unreadOnly = true;
      if (args.includeJunk) body.includeJunk = true;
      if (args.dedupe === false) body.dedupe = false;
      return shapeMessages(await api("POST", "/recent", body, SEARCH_TIMEOUT_MS), args.fields);
    },
  },

  // ─── 2c. Identities ────────────────────────────────────────────
  {
    name: "email_identities",
    description:
      "List sender identities (id, email, name, accountId). Use an id as `from` in email_compose to choose the sending address.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    handler: async (args, api) => await api("GET", "/identities"),
  },

  // ─── 3. List ───────────────────────────────────────────────────
  {
    name: "email_list",
    description:
      "List messages in one folder, newest first by default. Use email_folders first to get folder IDs. Supports pagination and sorting.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: {
          type: "string",
          description: "Folder ID (e.g. 'account1://INBOX')",
        },
        unread: { type: "boolean", description: "Unread only" },
        flagged: { type: "boolean", description: "Flagged only" },
        offset: { type: "number", description: "Skip first N (pagination)" },
        sort: {
          type: "string",
          enum: ["date", "from", "subject", "size", "none"],
          description: "Sort field (default date). none = storage order, fastest",
        },
        sortOrder: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction (default desc = newest/largest first)",
        },
        limit: { type: "number", description: "Max results", default: 25 },
        fields: FIELDS_SCHEMA,
      },
      required: ["folderId"],
    },
    handler: async (args, api) => {
      const body = { folderId: args.folderId, limit: args.limit || 25 };
      if (args.unread) body.unreadOnly = true;
      if (args.flagged) body.flagged = true;
      if (args.offset) body.offset = args.offset;
      if (args.sort) body.sort = args.sort;
      if (args.sortOrder) body.sortOrder = args.sortOrder;
      return shapeMessages(await api("POST", "/messages/list", body, SEARCH_TIMEOUT_MS), args.fields);
    },
  },

  // ─── 4. Read ───────────────────────────────────────────────────
  {
    name: "email_read",
    description:
      "Read one email. Modes: 'default' (headers + plain-text body; HTML-only mails are converted to text), 'headers' (cheapest), 'full' (also the raw HTML), 'raw' (RFC822 source). " +
      `Body text is capped at ${DEFAULT_MAX_BODY} characters unless maxBody says otherwise (0 = no cap). Attachments are listed with partName for email_attachments.`,
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "number",
          description: "Thunderbird internal message ID",
        },
        mode: {
          type: "string",
          enum: ["default", "headers", "full", "raw", "check-download"],
          description: "Read mode",
          default: "default",
        },
        maxBody: {
          type: "number",
          description: `Truncate body text (and HTML in full mode) to N characters. Default ${DEFAULT_MAX_BODY}; 0 = unlimited`,
        },
        includeHtml: {
          type: "boolean",
          description: "default mode: also return the HTML part (normally dropped to save tokens)",
        },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      const id = args.messageId;
      const mode = args.mode || "default";
      const maxBody = args.maxBody ?? DEFAULT_MAX_BODY;
      let result;
      if (mode === "raw") result = await api("GET", `/messages/${id}/raw`);
      else if (mode === "headers") result = await api("GET", `/messages/${id}/headers`);
      else if (mode === "full") result = await api("GET", `/messages/${id}/full`);
      else if (mode === "check-download")
        result = await api("GET", `/messages/${id}/check-download`);
      else result = await api("GET", `/messages/${id}`);

      if (result && typeof result === "object" && !Array.isArray(result) && mode !== "raw") {
        result = pickFields(result); // drop empty header fields
      }
      const parts = result?.parts;
      if (parts) {
        if (mode === "default") {
          // HTML roughly triples the size of the same text; agents read the text.
          if (!parts.text && parts.html) {
            parts.text = htmlToText(parts.html);
            parts.textFromHtml = true;
          }
          if (!args.includeHtml) delete parts.html;
        }
        const t = truncate(parts.text, maxBody);
        parts.text = t.text;
        if (t.truncated) parts.textTruncated = true;
        if (parts.html) {
          const h = truncate(parts.html, maxBody);
          parts.html = h.text;
          if (h.truncated) parts.htmlTruncated = true;
        }
        if (Array.isArray(parts.attachments) && parts.attachments.length === 0) delete parts.attachments;
      }
      if (mode === "raw" && typeof result?.raw === "string") {
        const r = truncate(result.raw, maxBody);
        result.raw = r.text;
        if (r.truncated) result.rawTruncated = true;
      }
      return result;
    },
  },

  // ─── 5. Thread ─────────────────────────────────────────────────
  {
    name: "email_thread",
    description:
      "Get the full conversation thread for a message — all related messages sorted chronologically, resolved across accounts via References/In-Reply-To headers.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID" },
        fields: FIELDS_SCHEMA,
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      const result = await api("GET", `/messages/${args.messageId}/thread`, null, SEARCH_TIMEOUT_MS);
      if (result && Array.isArray(result.thread)) {
        return { ...result, thread: shapeMessages(result.thread, args.fields) };
      }
      return result;
    },
  },

  // ─── 6. Compose ────────────────────────────────────────────────
  {
    name: "email_compose",
    description:
      "Compose a new email, or edit a saved draft (draftId). Default mode is 'draft' (saved to Drafts folder, not sent; the result has its draftId). Use mode='send' to send immediately, mode='open' to open in Thunderbird's compose window for human review. ALWAYS prefer draft mode unless the human explicitly asked to send. " +
      "attachments: local file paths to attach. " +
      "Editing a draft (draftId): only the fields you pass change (to/cc/bcc/subject replace, body replaces the whole text), attachments are added, removeAttachments removes by file name; the edited draft is saved under a new draftId and the old one goes to the trash.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: {
          type: "number",
          description: "Edit this saved draft (message id of a mail in a Drafts folder) instead of composing a new one",
        },
        to: {
          type: "string",
          description: "Recipient(s), comma-separated for multiple. Required for a new message",
        },
        cc: { type: "string", description: "CC recipients" },
        bcc: { type: "string", description: "BCC recipients" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body (plain text)" },
        html: {
          type: "boolean",
          description: "Treat body as HTML",
          default: false,
        },
        from: {
          type: "string",
          description:
            "Identity ID to send from — get it from email_identities",
        },
        priority: {
          type: "string",
          enum: ["highest", "high", "normal", "low", "lowest"],
        },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          description: "draft (default, saves silently), open (compose window), send (immediate)",
          default: "draft",
        },
        attachments: ATTACHMENTS_SCHEMA,
        removeAttachments: {
          type: "array",
          items: { type: "string" },
          description: "With draftId: names of the draft's attachments to remove (as listed by email_attachments)",
        },
      },
    },
    handler: async (args, api) => {
      if (args.draftId != null) {
        // null counts as "not given": some clients send it for every field they leave out.
        const payload = { draftId: args.draftId };
        for (const key of ["to", "cc", "bcc", "subject", "body"]) {
          if (args[key] != null) payload[key] = args[key];
        }
        if (args.body != null) payload.isHTML = args.html || false;
        if (args.from) payload.identityId = args.from;
        const attachments = readAttachmentFiles(args.attachments);
        if (attachments?.length) payload.attachments = attachments;
        if (args.removeAttachments?.length) payload.removeAttachments = args.removeAttachments;
        return await composeCall(api, "/drafts/update", applyMode(payload, args.mode));
      }
      if (!args.to) {
        throw Object.assign(new Error("email_compose needs `to` for a new message (or draftId to edit a draft)"), {
          code: "INVALID_ARGS",
        });
      }
      if (args.removeAttachments?.length) {
        throw Object.assign(new Error("removeAttachments only applies when editing a draft (draftId)"), {
          code: "INVALID_ARGS",
        });
      }
      const attachments = readAttachmentFiles(args.attachments);
      const payload = {
        to: args.to,
        subject: args.subject || "",
        body: args.body || "",
        isHTML: args.html || false,
      };
      if (args.cc) payload.cc = args.cc;
      if (args.bcc) payload.bcc = args.bcc;
      if (args.from) payload.identityId = args.from;
      if (args.priority) payload.priority = args.priority;
      if (attachments?.length) payload.attachments = attachments;
      return await composeCall(api, "/compose", applyMode(payload, args.mode));
    },
  },

  // ─── 7. Reply ──────────────────────────────────────────────────
  {
    name: "email_reply",
    description:
      "Reply to a message. Default mode is 'draft' (result has its draftId). Use mode='send' for immediate send. Set replyAll=true to reply to all recipients. attachments: local file paths to attach.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID to reply to" },
        body: { type: "string", description: "Reply body" },
        replyAll: { type: "boolean", description: "Reply to all recipients" },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          default: "draft",
        },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ["messageId", "body"],
    },
    handler: async (args, api) => {
      const payload = {
        messageId: args.messageId,
        body: args.body,
        replyAll: args.replyAll || false,
      };
      const attachments = readAttachmentFiles(args.attachments);
      if (attachments?.length) payload.attachments = attachments;
      return await composeCall(api, "/reply", applyMode(payload, args.mode));
    },
  },

  // ─── 8. Forward ────────────────────────────────────────────────
  {
    name: "email_forward",
    description:
      "Forward a message to a new recipient. Default mode is 'draft' for human review (result has its draftId). attachments: extra local files to attach.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID to forward" },
        to: { type: "string", description: "Recipient address" },
        body: { type: "string", description: "Optional additional text" },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          default: "draft",
        },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ["messageId", "to"],
    },
    handler: async (args, api) => {
      const payload = {
        messageId: args.messageId,
        to: args.to,
        body: args.body || "",
      };
      const attachments = readAttachmentFiles(args.attachments);
      if (attachments?.length) payload.attachments = attachments;
      return await composeCall(api, "/forward", applyMode(payload, args.mode));
    },
  },

  // ─── 9. Mark ───────────────────────────────────────────────────
  {
    name: "email_mark",
    description:
      "Update message flags and tags: read/unread, flagged/unflagged, junk/not-junk, and IMAP tag keywords (e.g. $label1). Accepts an array of IDs for batch operations. Use addTags/removeTags to change tags without touching the others; `tags` replaces the whole set.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "number" },
          description: "Message IDs",
        },
        read: { type: "boolean", description: "Mark as read (true) or unread (false)" },
        flagged: { type: "boolean", description: "Flag (true) or unflag (false)" },
        junk: { type: "boolean", description: "Mark junk (true) or not-junk (false)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace all tags with exactly these tag keys (use [] to clear). Cannot be combined with addTags/removeTags",
        },
        addTags: {
          type: "array",
          items: { type: "string" },
          description: "Tag keys to add, keeping existing tags (see the tags list from email_stats / tb tags)",
        },
        removeTags: {
          type: "array",
          items: { type: "string" },
          description: "Tag keys to remove, keeping the others",
        },
      },
      required: ["messageIds"],
    },
    handler: async (args, api) => {
      const editsTags = args.addTags?.length || args.removeTags?.length;
      if (args.tags && editsTags) {
        throw Object.assign(new Error("Use either tags (replace) or addTags/removeTags, not both"), {
          code: "INVALID_ARGS",
        });
      }
      const props = {};
      if (args.read !== undefined) props.read = args.read;
      if (args.flagged !== undefined) props.flagged = args.flagged;
      if (args.junk !== undefined) props.junk = args.junk;
      if (args.tags) props.tags = [...new Set(args.tags)];
      const results = [];
      for (const id of args.messageIds) {
        const update = { messageId: id, ...props };
        if (editsTags) {
          const current = (await api("GET", `/messages/${id}/headers`)).tags || [];
          const removed = new Set(args.removeTags || []);
          update.tags = [...new Set([...current, ...(args.addTags || [])])].filter((t) => !removed.has(t));
        }
        results.push(await api("POST", "/messages/update", update));
      }
      return { success: true, updated: results.length };
    },
  },

  // ─── 10. Archive / Move / Delete ───────────────────────────────
  {
    name: "email_archive",
    description:
      "Archive, move, or delete messages. Operations: 'archive' (move to archive folder), 'move' (to specific folder), 'delete' (move to the account's Trash, recoverable; works for drafts too). " +
      "Deleting drafts is allowed at bridge policy 'draft', other mail needs 'organize'. Messages already in Trash stay there (alreadyInTrash). Permanent delete (permanent=true) requires confirm=true and policy 'full'.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "number" },
          description: "Message IDs",
        },
        operation: {
          type: "string",
          enum: ["archive", "move", "delete"],
          description: "Operation type",
        },
        destinationFolderId: {
          type: "string",
          description: "Required for 'move' operation",
        },
        permanent: {
          type: "boolean",
          description: "For delete: skip trash (requires confirm)",
        },
        confirm: {
          type: "boolean",
          description: "Required for permanent delete",
        },
      },
      required: ["messageIds", "operation"],
    },
    handler: async (args, api) => {
      if (args.operation === "archive") {
        return await api("POST", "/messages/archive", { messageIds: args.messageIds });
      }
      if (args.operation === "move") {
        if (!args.destinationFolderId) {
          return { error: "destinationFolderId required for move" };
        }
        return await api("POST", "/messages/move", {
          messageIds: args.messageIds,
          destinationFolderId: args.destinationFolderId,
        });
      }
      if (args.operation === "delete") {
        if (args.permanent && !args.confirm) {
          return { error: "Permanent delete requires confirm=true" };
        }
        if (args.permanent) {
          return await api("POST", "/messages/delete", { messageIds: args.messageIds, permanent: true });
        }
        return await deleteToTrash(api, args.messageIds);
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },

  // ─── 11. Attachments ───────────────────────────────────────────
  {
    name: "email_attachments",
    description:
      "List or download attachments from a message (drafts included). 'list' returns metadata (name, contentType, size, partName). " +
      "'download' saves the file to a local download folder and returns its path — open it from there (e.g. read a PDF or image); without partName it saves every attachment. Set inline=true only if you need the bytes as base64 in the response. " +
      "To attach local files to a mail, use the attachments parameter of email_compose / email_reply / email_forward.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID" },
        operation: {
          type: "string",
          enum: ["list", "download"],
          description: "list metadata or download a specific attachment",
        },
        partName: {
          type: "string",
          description: "download: which attachment (from list). Omit to download all of them",
        },
        inline: {
          type: "boolean",
          description: "download: return base64 data instead of saving to disk (large!)",
        },
      },
      required: ["messageId", "operation"],
    },
    handler: async (args, api) => {
      if (args.operation === "list") {
        return await api("GET", `/messages/${args.messageId}/attachments`);
      }
      if (args.operation === "download") {
        const fetchPart = (partName) =>
          api("POST", `/messages/${args.messageId}/attachment`, { partName }, SEARCH_TIMEOUT_MS);
        if (args.partName) {
          const file = await fetchPart(args.partName);
          if (args.inline || typeof file?.data !== "string") return file;
          return saveAttachment(args.messageId, args.partName, file);
        }
        if (args.inline) return { error: "inline needs a partName (one attachment at a time)" };
        const list = await api("GET", `/messages/${args.messageId}/attachments`);
        if (!Array.isArray(list)) return list;
        const files = [];
        for (const att of list) {
          try {
            const file = await fetchPart(att.partName);
            files.push(typeof file?.data === "string"
              ? { partName: att.partName, ...saveAttachment(args.messageId, att.partName, file) }
              : { partName: att.partName, name: att.name, error: file?.error || "no data" });
          } catch (err) {
            files.push({ partName: att.partName, name: att.name, error: err.message });
          }
        }
        return { saved: files.filter((f) => f.saved).length, files };
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },

  // ─── 12. Folders ───────────────────────────────────────────────
  {
    name: "email_folders",
    description:
      "List folders for an account, get folder info with message counts, or trigger sync. Operations: 'list' (folders for account), 'all' (across all accounts), 'info' (one folder), 'sync' (refresh from IMAP).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "all", "info", "sync"],
          description: "Operation type",
        },
        accountId: {
          type: "string",
          description: "Required for 'list' operation",
        },
        folderId: {
          type: "string",
          description: "Required for 'info' and 'sync' operations",
        },
      },
      required: ["operation"],
    },
    handler: async (args, api) => {
      if (args.operation === "list") {
        if (!args.accountId) return { error: "accountId required for list" };
        return await api("GET", `/accounts/${args.accountId}/folders`);
      }
      if (args.operation === "all") {
        const accounts = await api("GET", "/accounts");
        // Accounts in parallel; the extension bounds the per-folder work itself.
        const perAccount = await Promise.all(
          accounts.map((acct) => api("GET", `/accounts/${acct.id}/folders`, null, SEARCH_TIMEOUT_MS))
        );
        return perAccount.flatMap((folders, i) =>
          folders.map((f) => ({ ...f, accountId: accounts[i].id }))
        );
      }
      if (args.operation === "info") {
        if (!args.folderId) return { error: "folderId required for info" };
        return await api("POST", "/folders/info", { folderId: args.folderId });
      }
      if (args.operation === "sync") {
        if (args.folderId) return await api("POST", "/sync", { folderId: args.folderId });
        return await api("POST", "/sync", { all: true });
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },
];
