/**
 * Output shaping for MCP tool results: keep what an agent needs, drop what only costs tokens.
 */

import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── HTML → text ────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", shy: "",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", aacute: "á", acirc: "â", ccedil: "ç",
  Eacute: "É", Egrave: "È", Agrave: "À", ocirc: "ô", ucirc: "û", icirc: "î", iuml: "ï", euml: "ë",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€", copy: "©", reg: "®", trade: "™",
  deg: "°", times: "×", zwnj: "", zwj: "",
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Readable plain text from an HTML mail body. Not a renderer — just enough structure (line
 * breaks, list bullets, link targets) for an agent to read invoices, letters and newsletters
 * at a fraction of the HTML's size.
 */
export function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  // Links: keep the target when it adds information (http(s) only, bounded length).
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, q, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    if (!/^https?:\/\//i.test(url) || url.length > 300) return text;
    if (!text || text === url) return ` ${url} `;
    return `${text} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|tr|li|ul|ol|table|h[1-6]|blockquote|section|article|header|footer)\s*>/gi, "\n");
  s = s.replace(/<(p|div|tr|table|h[1-6]|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, "\t");
  s = s.replace(/<hr\b[^>]*>/gi, "\n---\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t\u00a0]+/g, (ws) => (ws.includes("\t") ? "\t" : " "));
  s = s.split("\n").map((l) => l.trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ─── Message objects ────────────────────────────────────────────────

/** Drop null/undefined, empty strings and empty arrays — common in header objects. */
export function compactMessage(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const out = {};
  for (const [k, v] of Object.entries(msg)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Keep only `fields` (top-level names, e.g. ["id","date","author","subject"]). */
export function pickFields(msg, fields) {
  if (!fields?.length || !msg || typeof msg !== "object") return compactMessage(msg);
  const out = {};
  for (const f of fields) if (msg[f] !== undefined) out[f] = msg[f];
  return out;
}

/** Shape `result.messages` (search/list/recent) or a bare array. */
export function shapeMessages(result, fields) {
  if (Array.isArray(result)) return result.map((m) => pickFields(m, fields));
  if (result && Array.isArray(result.messages)) {
    return { ...result, messages: result.messages.map((m) => pickFields(m, fields)) };
  }
  return result;
}

// ─── Attachments ────────────────────────────────────────────────────

export function downloadDir() {
  return process.env.TB_MCP_DOWNLOAD_DIR || join(tmpdir(), "thunderbird-cli", "attachments");
}

/** File name safe on Windows, macOS and Linux. */
export function safeFileName(name) {
  const cleaned = String(name || "attachment")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 150);
  return cleaned || "attachment";
}

/**
 * Write a downloaded attachment ({ name, contentType, data: base64 }) to the download
 * directory and return its path instead of the bytes. Base64 in a tool result costs ~1.37
 * tokens-worth of characters per byte; a path costs nothing and the agent can open the file.
 */
export function saveAttachment(messageId, partName, file) {
  const dir = downloadDir();
  mkdirSync(dir, { recursive: true });
  const fileName = `${messageId}-${String(partName).replace(/[^0-9a-z.]/gi, "_")}-${safeFileName(file.name)}`;
  const path = join(dir, fileName);
  const bytes = Buffer.from(file.data || "", "base64");
  writeFileSync(path, bytes);
  return { saved: true, path, name: file.name, contentType: file.contentType, size: bytes.length };
}
