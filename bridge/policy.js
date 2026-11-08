/**
 * Access policy for the bridge.
 *
 * The extension executes whatever the bridge forwards, and agent-side safeguards ("draft by
 * default", permission prompts) can be bypassed or switched off. The bridge is the one place
 * every request passes through, so this is where an agent's reach is capped.
 *
 * Levels (each includes the ones before it):
 *   read      search, list, read, threads, attachments, stats, contacts, sync — no changes
 *   draft     + compose / reply / forward (with attachments) saved as a draft or opened for a
 *               human (never sent); edit drafts; move drafts to the trash
 *   organize  + mark read/flagged/junk, tags, move, copy, archive, move any mail to the trash,
 *               create/rename folders
 *   full      + send immediately, delete permanently, delete folders, bulk delete
 *
 * "Trash" deletes (/messages/trash) are a move to the account's Trash folder, so they stay
 * recoverable; the extension enforces that, and that drafts-only deletes and draft edits touch
 * nothing outside a Drafts folder. These live on their own routes rather than as flags on
 * /messages/delete: an older extension answers "Not found" to an unknown route, whereas it would
 * ignore an unknown flag and delete whatever it was given.
 */

export const POLICY_LEVELS = ["read", "draft", "organize", "full"];

// Every GET route of the extension is read-only.
const READ_POST = new Set([
  "/folders/info",
  "/messages/search",
  "/messages/list",
  "/messages/read-batch",
  "/messages/fetch",
  "/stats",
  "/recent",
  "/contacts/search",
  "/sync",
  "/sync/status",
  "/bulk/fetch",
]);
const READ_POST_PATTERNS = [/^\/messages\/\d+\/attachment$/];

// Compose routes, including editing a saved draft, need "full" only to send.
const COMPOSE_POST = new Set(["/compose", "/reply", "/forward", "/drafts/update"]);
// Move to the account's Trash: drafts only at "draft", any mail at "organize".
const TRASH_POST = "/messages/trash";

const ORGANIZE_POST = new Set([
  "/messages/archive",
  "/messages/move",
  "/messages/copy",
  "/messages/update",
  "/tags/create",
  "/folders/create",
  "/folders/rename",
  "/bulk/tag",
]);

/** Normalize a configured level; throws on an unknown value rather than guessing. */
export function parsePolicy(value) {
  const level = String(value ?? "").trim().toLowerCase();
  if (!POLICY_LEVELS.includes(level)) {
    throw new Error(`Unknown policy "${value}". Use one of: ${POLICY_LEVELS.join(", ")}.`);
  }
  return level;
}

/** The minimum level a request needs. */
export function requiredLevel(method, path, body) {
  const route = String(path || "").split("?")[0];
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (m !== "POST") return "full";
  if (READ_POST.has(route) || READ_POST_PATTERNS.some((re) => re.test(route))) return "read";
  if (COMPOSE_POST.has(route)) return body?.send ? "full" : "draft";
  if (route === TRASH_POST) return body?.draftsOnly ? "draft" : "organize";
  if (ORGANIZE_POST.has(route)) return "organize";
  // /messages/delete, folder/bulk deletes and anything not listed above (new routes stay locked
  // until classified).
  return "full";
}

/** null if allowed, otherwise a human-readable reason. */
export function checkPolicy(policy, method, path, body) {
  const needed = requiredLevel(method, path, body);
  if (POLICY_LEVELS.indexOf(policy) >= POLICY_LEVELS.indexOf(needed)) return null;
  const route = String(path).split("?")[0];
  const raise = "ask the human to raise TB_BRIDGE_POLICY if this is intended.";
  if (needed === "full" && COMPOSE_POST.has(route)) {
    return `Sending immediately needs bridge policy "full", but it is "${policy}". ` +
      `Save it as a draft instead (omit send), or ${raise}`;
  }
  if (route === TRASH_POST && !body?.draftsOnly) {
    return `Moving mail other than drafts to the trash needs bridge policy "organize", but it is "${policy}". ` +
      `Drafts can be deleted at "draft"; for other mail ${raise}`;
  }
  if (route === "/messages/delete") {
    return `Deleting permanently needs bridge policy "full", but it is "${policy}". ` +
      `Move the messages to the trash instead (/messages/trash), or ${raise}`;
  }
  return `${method} ${path} needs bridge policy "${needed}", but it is "${policy}". ` +
    raise.charAt(0).toUpperCase() + raise.slice(1);
}
