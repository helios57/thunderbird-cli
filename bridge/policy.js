/**
 * Access policy for the bridge.
 *
 * The extension executes whatever the bridge forwards, and agent-side safeguards ("draft by
 * default", permission prompts) can be bypassed or switched off. The bridge is the one place
 * every request passes through, so this is where an agent's reach is capped.
 *
 * Levels (each includes the ones before it):
 *   read      search, list, read, threads, attachments, stats, contacts, sync — no changes
 *   draft     + compose / reply / forward saved as a draft or opened for a human (never sent)
 *   organize  + mark read/flagged/junk, tags, move, copy, archive, create/rename folders
 *   full      + send immediately, delete messages and folders, bulk delete
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

const COMPOSE_POST = new Set(["/compose", "/reply", "/forward"]);

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
  if (ORGANIZE_POST.has(route)) return "organize";
  // Delete routes and anything not listed above (new routes stay locked until classified).
  return "full";
}

/** null if allowed, otherwise a human-readable reason. */
export function checkPolicy(policy, method, path, body) {
  const needed = requiredLevel(method, path, body);
  if (POLICY_LEVELS.indexOf(policy) >= POLICY_LEVELS.indexOf(needed)) return null;
  const what = needed === "full" && COMPOSE_POST.has(String(path).split("?")[0])
    ? "Sending immediately"
    : `${method} ${path}`;
  return `${what} needs bridge policy "${needed}", but it is "${policy}". ` +
    (needed === "full" && COMPOSE_POST.has(String(path).split("?")[0])
      ? "Save it as a draft instead (omit send), or ask the human to raise TB_BRIDGE_POLICY."
      : "Ask the human to raise TB_BRIDGE_POLICY if this is intended.");
}
