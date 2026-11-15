#!/usr/bin/env node
// Claude Code hook for Jarvis -> Kontrol Merkezi lights.
//   node jarvis-kanca.mjs <istem|durdu|bildirim|basladi|bitti>
// Reads the hook's JSON from stdin, writes %LOCALAPPDATA%\KontrolMerkezi\jarvis.json atomically and exits 0
// silently, always: a hook must never slow down or break Jarvis. On "durdu" (Stop) it decides whether Jarvis's last
// message asks Özcan something (a "?" near its end), which turns the lights' "waiting for your answer" breath on.
// The service ignores events whose session is not the background session named jarvis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const event = process.argv[2] ?? "";
const dir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "KontrolMerkezi");

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

// Text of the last assistant message: from the hook input if present, else from the transcript's tail.
function lastAssistantText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  const file = input.transcript_path;
  if (!file) return "";
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type === "user" && row.message?.content && typeof row.message.content === "string") return "";
      if (row.type !== "assistant") continue;
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text.trim()) return text;
    }
  } catch {}
  return "";
}

try {
  const input = readStdin();
  const record = { olay: event, oturum: input.session_id ?? null, zaman: Date.now() };
  if (event === "durdu") {
    const tail = lastAssistantText(input).trim().slice(-300);
    record.soru = tail.includes("?");
  }
  if (event === "bitti") record.neden = input.reason ?? null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "jarvis.json");
  const tmp = `${target}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, target);
} catch {}
process.exit(0);
