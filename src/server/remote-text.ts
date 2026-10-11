import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { shellQuote, validateRemotePath } from "./commands.js";

export type TextWriteMode = "create" | "replace";

export interface RemoteTextDocument {
  content: string;
  sha256: string;
  size: number;
  mode: string;
  uid: number;
  gid: number;
  modifiedEpochSeconds: number;
  encoding: "utf-8" | "utf-8-bom";
  lineEnding: "lf" | "crlf" | "mixed" | "none";
  totalLines: number;
}

export interface PatchSummary {
  content: string;
  hunksApplied: number;
  linesAdded: number;
  linesDeleted: number;
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

export function analyzeText(content: string): Pick<RemoteTextDocument, "encoding" | "lineEnding" | "totalLines"> {
  const encoding = content.startsWith("\ufeff") ? "utf-8-bom" : "utf-8";
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/gu) ?? []).length;
  const lineEnding = crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
  const totalLines = content.length === 0 ? 0 : (content.match(/\n/gu) ?? []).length + (content.endsWith("\n") ? 0 : 1);
  return { encoding, lineEnding, totalLines };
}

export function paginateText(content: string, startLine: number, maxLines: number, maxBytes: number) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const startIndex = Math.min(startLine - 1, lines.length);
  const selected: string[] = [];
  let bytes = 0;
  for (let index = startIndex; index < lines.length && selected.length < maxLines; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index], "utf8");
    if (bytes + lineBytes > maxBytes) {
      if (selected.length === 0) throw new Error(`A single text line exceeds maxBytes (${maxBytes}).`);
      break;
    }
    selected.push(lines[index]);
    bytes += lineBytes;
  }
  const endLine = selected.length ? startLine + selected.length - 1 : startLine - 1;
  return {
    content: selected.join(""),
    startLine,
    endLine,
    returnedLines: selected.length,
    returnedBytes: bytes,
    hasMore: startIndex + selected.length < lines.length,
    nextLine: startIndex + selected.length < lines.length ? startLine + selected.length : null,
  };
}

export function remoteReadTextCommand(path: string, maxFileBytes: number): string {
  validateRemotePath(path);
  return [
    `target=${shellQuote(path)}`,
    `if [ -L "$target" ]; then printf 'STATE|symlink-refused\\n'; exit 41; fi`,
    `if [ ! -f "$target" ]; then printf 'STATE|not-regular\\n'; exit 42; fi`,
    `size=$(LC_ALL=C stat -c '%s' -- "$target") || exit 43`,
    `if [ "$size" -gt ${maxFileBytes} ]; then printf 'STATE|too-large|%s\\n' "$size"; exit 44; fi`,
    `before=$(sha256sum -- "$target" | awk '{print $1}') || exit 45`,
    `meta=$(LC_ALL=C stat -c '%a|%u|%g|%Y' -- "$target") || exit 46`,
    `printf 'META|%s|%s|%s\\n' "$before" "$size" "$meta"`,
    `printf 'DATA|'`,
    `base64 -w 0 -- "$target" || exit 47`,
    `printf '\\n'`,
    `after=$(sha256sum -- "$target" | awk '{print $1}') || exit 48`,
    `printf 'END|%s\\n' "$after"`,
  ].join("; ");
}

export function parseRemoteText(output: string): RemoteTextDocument {
  const firstBreak = output.indexOf("\n");
  const lastBreak = output.lastIndexOf("\n", output.length - 2);
  if (firstBreak < 0 || lastBreak <= firstBreak) throw new Error("Invalid remote text envelope.");
  const meta = output.slice(0, firstBreak).split("|");
  const data = output.slice(firstBreak + 1, lastBreak);
  const end = output.slice(lastBreak + 1).trimEnd().split("|");
  if (meta.length !== 7 || meta[0] !== "META" || !data.startsWith("DATA|") || end.length !== 2 || end[0] !== "END") {
    throw new Error("Invalid remote text envelope fields.");
  }
  const [, before, sizeText, mode, uidText, gidText, modifiedText] = meta;
  if (before !== end[1]) throw new Error(`Remote file changed while it was being read: before=${before}, after=${end[1]}.`);
  const bytes = Buffer.from(data.slice(5), "base64");
  const size = Number(sizeText);
  if (bytes.length !== size) throw new Error(`Remote text size mismatch: expected=${size}, actual=${bytes.length}.`);
  if (createHash("sha256").update(bytes).digest("hex") !== before) throw new Error("Remote text hash mismatch after transfer.");
  if (bytes.includes(0)) throw new Error("Remote file contains NUL bytes and is not supported as text.");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    content,
    sha256: before,
    size,
    mode,
    uid: Number(uidText),
    gid: Number(gidText),
    modifiedEpochSeconds: Number(modifiedText),
    ...analyzeText(content),
  };
}

export function remoteAtomicWriteCommand(options: {
  path: string;
  mode: TextWriteMode;
  expectedSha256?: string;
  afterSha256: string;
  operationId: string;
  preserveMetadata: boolean;
}): string {
  const path = validateRemotePath(options.path);
  const parent = posix.dirname(path);
  const temporary = posix.join(parent, `.${posix.basename(path)}.ssh-operator-${options.operationId}.tmp`);
  const expected = options.expectedSha256 ?? "";
  return [
    `target=${shellQuote(path)}`,
    `parent=${shellQuote(parent)}`,
    `temporary=${shellQuote(temporary)}`,
    `expected=${shellQuote(expected)}`,
    `desired=${shellQuote(options.afterSha256)}`,
    `operation=${shellQuote(options.operationId)}`,
    `cleanup() { rm -f -- "$temporary"; }`,
    `trap cleanup EXIT HUP INT TERM`,
    `if ! command -v flock >/dev/null 2>&1; then printf 'STATE|flock-missing\\n'; exit 60; fi`,
    `exec 9< "$parent" || { printf 'STATE|parent-unreadable\\n'; exit 61; }`,
    `if ! flock -n 9; then printf 'STATE|locked\\n'; exit 62; fi`,
    `if [ -L "$target" ]; then printf 'STATE|symlink-refused\\n'; exit 63; fi`,
    `exists=false; current=missing`,
    `if [ -e "$target" ]; then if [ ! -f "$target" ]; then printf 'STATE|not-regular\\n'; exit 64; fi; exists=true; current=$(sha256sum -- "$target" | awk '{print $1}') || exit 65; fi`,
    `if [ "$current" = "$desired" ]; then printf 'RESULT|already-applied|%s|%s|%s\\n' "$operation" "$current" "$current"; exit 0; fi`,
    ...(options.mode === "create"
      ? [`if [ "$exists" = true ]; then printf 'STATE|already-exists|%s\\n' "$current"; exit 66; fi`]
      : [
          `if [ "$exists" != true ]; then printf 'STATE|missing\\n'; exit 67; fi`,
          `if [ -z "$expected" ] || [ "$current" != "$expected" ]; then printf 'STATE|conflict|%s\\n' "$current"; exit 68; fi`,
        ]),
    ...(options.preserveMetadata
      ? [`if [ "$exists" = true ]; then cp -p -- "$target" "$temporary" || exit 69; else umask 022; : > "$temporary" || exit 69; fi`]
      : [`umask 022; : > "$temporary" || exit 69`]),
    `cat > "$temporary" || exit 70`,
    `staged=$(sha256sum -- "$temporary" | awk '{print $1}') || exit 71`,
    `if [ "$staged" != "$desired" ]; then printf 'STATE|staged-hash-mismatch|%s\\n' "$staged"; exit 72; fi`,
    `sync -f "$temporary" 2>/dev/null || true`,
    `latest=missing; if [ -e "$target" ]; then latest=$(sha256sum -- "$target" | awk '{print $1}') || exit 73; fi`,
    `if [ "$latest" != "$current" ]; then printf 'STATE|conflict|%s\\n' "$latest"; exit 74; fi`,
    ...(options.mode === "create"
      ? [`if ! ln -- "$temporary" "$target"; then printf 'STATE|concurrent-create\\n'; exit 75; fi`, `rm -f -- "$temporary" || exit 76`]
      : [`mv -f -- "$temporary" "$target" || exit 76`]),
    `observed=$(sha256sum -- "$target" | awk '{print $1}') || exit 77`,
    `if [ "$observed" != "$desired" ]; then printf 'STATE|verify-failed|%s\\n' "$observed"; exit 78; fi`,
    `printf 'RESULT|committed|%s|%s|%s\\n' "$operation" "$current" "$observed"`,
  ].join("; ");
}

export function applyUnifiedPatch(source: string, patch: string): PatchSummary {
  if (!patch.includes("@@")) throw new Error("Patch must contain at least one unified-diff hunk.");
  const bom = source.startsWith("\ufeff") ? "\ufeff" : "";
  const body = bom ? source.slice(1) : source;
  const lineEnding = body.includes("\r\n") && !body.match(/(?<!\r)\n/u) ? "\r\n" : "\n";
  const normalized = body.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const hadFinalNewline = normalized.endsWith("\n");
  const sourceLines = normalized.length === 0 ? [] : normalized.slice(0, hadFinalNewline ? -1 : undefined).split("\n");
  const patchLines = patch.replace(/\r\n/gu, "\n").split("\n");
  const output: string[] = [];
  let sourceCursor = 0;
  let index = 0;
  let hunksApplied = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  while (index < patchLines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(patchLines[index]);
    if (!header) { index += 1; continue; }
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const targetIndex = oldStart === 0 ? 0 : oldStart - 1;
    if (targetIndex < sourceCursor || targetIndex > sourceLines.length) throw new Error(`Patch hunk ${hunksApplied + 1} has an invalid or overlapping source range.`);
    output.push(...sourceLines.slice(sourceCursor, targetIndex));
    sourceCursor = targetIndex;
    index += 1;
    let consumed = 0;
    let produced = 0;
    while (index < patchLines.length && !patchLines[index].startsWith("@@")) {
      const line = patchLines[index];
      if (line.startsWith("--- ") || line.startsWith("+++ ")) break;
      if (line === "\\ No newline at end of file" || (line === "" && index === patchLines.length - 1)) { index += 1; continue; }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (sourceLines[sourceCursor] !== text) throw new Error(`Patch context mismatch at source line ${sourceCursor + 1}.`);
        output.push(text); sourceCursor += 1; consumed += 1; produced += 1;
      } else if (marker === "-") {
        if (sourceLines[sourceCursor] !== text) throw new Error(`Patch deletion mismatch at source line ${sourceCursor + 1}.`);
        sourceCursor += 1; consumed += 1; linesDeleted += 1;
      } else if (marker === "+") {
        output.push(text); produced += 1; linesAdded += 1;
      } else {
        throw new Error(`Unsupported patch line in hunk ${hunksApplied + 1}: ${JSON.stringify(line)}.`);
      }
      index += 1;
    }
    if (consumed !== oldCount || produced !== newCount) throw new Error(`Patch hunk ${hunksApplied + 1} count mismatch.`);
    hunksApplied += 1;
  }
  output.push(...sourceLines.slice(sourceCursor));
  const finalNewline = hadFinalNewline ? lineEnding : "";
  return { content: bom + output.join(lineEnding) + finalNewline, hunksApplied, linesAdded, linesDeleted };
}

export function normalizeOperationId(operationId?: string): string {
  return operationId ?? randomUUID();
}
