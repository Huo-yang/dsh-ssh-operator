import { validateRemotePath } from "./commands.js";

export interface TreeEntry extends Record<string, unknown> {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: string;
  modifiedEpochSeconds: number;
}

export interface SearchMatch extends Record<string, unknown> {
  path: string;
  line: number;
  column: number;
  columnByte: number;
  text: string;
  submatches: Array<{ text: string; startByte: number; endByte: number }>;
}

const SIMPLE_NAME = /^[^/\0\r\n]+$/u;

export function validateExcludeNames(names: string[]): string[] {
  if (names.length > 32) throw new Error("At most 32 excluded directory names are allowed.");
  for (const name of names) {
    if (!SIMPLE_NAME.test(name) || name === "." || name === "..") {
      throw new Error(`Excluded directory names must be single path components: ${JSON.stringify(name)}.`);
    }
  }
  return names;
}

export function validateGlobs(globs: string[]): string[] {
  if (globs.length > 32) throw new Error("At most 32 search globs are allowed.");
  for (const glob of globs) {
    if (!glob || glob.includes("\0") || /[\r\n]/u.test(glob)) throw new Error("Search globs must not be empty or contain NUL or line breaks.");
  }
  return globs;
}

export const TREE_SCRIPT = String.raw`set -u
root=$1
depth=$2
skip=$3
need=$4
shift 4
if [ ! -d "$root" ]; then printf 'Workspace root is not a directory: %s\n' "$root" >&2; exit 20; fi
prune=()
for name in "$@"; do
  if [ "${"$"}{#prune[@]}" -gt 0 ]; then prune+=(-o); fi
  prune+=(-name "$name")
done
if [ "${"$"}{#prune[@]}" -gt 0 ]; then
  find -P "$root" -mindepth 0 -maxdepth "$depth" \( -type d \( "${"$"}{prune[@]}" \) -prune \) -o -printf '%P\0%y\0%s\0%m\0%T@\0'
else
  find -P "$root" -mindepth 0 -maxdepth "$depth" -printf '%P\0%y\0%s\0%m\0%T@\0'
fi | while IFS= read -r -d '' path && IFS= read -r -d '' type && IFS= read -r -d '' size && IFS= read -r -d '' mode && IFS= read -r -d '' modified; do
  encoded=$(printf '%s' "$path" | base64 -w 0)
  printf 'TREE|%s|%s|%s|%s|%s\n' "$encoded" "$type" "$size" "$mode" "$modified"
done | LC_ALL=C sort | {
  index=0
  emitted=0
  while IFS= read -r record; do
    if [ "$index" -ge "$skip" ]; then
      printf '%s\n' "$record"
      emitted=$((emitted + 1))
      if [ "$emitted" -ge "$need" ]; then break; fi
    fi
    index=$((index + 1))
  done
}`;

export function treeScriptArgs(root: string, maxDepth: number, cursor: number, limit: number, excludeNames: string[]): string[] {
  validateRemotePath(root);
  validateExcludeNames(excludeNames);
  return [root, String(maxDepth), String(cursor), String(limit + 1), ...excludeNames];
}

export function parseTreeOutput(output: string): TreeEntry[] {
  if (!output) return [];
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const fields = line.split("|");
    if (fields.length !== 6 || fields[0] !== "TREE") throw new Error(`Unexpected remote tree record: ${JSON.stringify(line)}`);
    const [, encodedPath, rawType, sizeText, mode, modifiedText] = fields;
    const path = Buffer.from(encodedPath, "base64").toString("utf8") || ".";
    const size = Number(sizeText);
    const modifiedEpochSeconds = Math.trunc(Number(modifiedText));
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(modifiedEpochSeconds) || !/^\d{3,4}$/u.test(mode)) {
      throw new Error(`Invalid remote tree record: ${JSON.stringify(line)}`);
    }
    const type = rawType === "f" ? "file" : rawType === "d" ? "directory" : rawType === "l" ? "symlink" : "other";
    return { path, type, size, mode, modifiedEpochSeconds };
  });
}

export const SEARCH_SCRIPT = String.raw`set -u
root=$1
skip=$2
need=$3
max_file_size=$4
max_columns=$5
fixed=$6
hidden=$7
glob_count=$8
shift 8
if [ ! -d "$root" ]; then printf 'Workspace root is not a directory: %s\n' "$root" >&2; exit 20; fi
if ! command -v rg >/dev/null 2>&1; then printf 'Required remote capability is unavailable: rg\n' >&2; exit 21; fi
rg_args=(--json --line-number --column --no-heading --color never --sort path --max-filesize "$max_file_size" --max-columns "$max_columns" --max-columns-preview)
if [ "$fixed" = true ]; then rg_args+=(-F); fi
if [ "$hidden" = true ]; then rg_args+=(--hidden); fi
i=0
while [ "$i" -lt "$glob_count" ]; do rg_args+=(--glob "$1"); shift; i=$((i + 1)); done
pattern=$1
rg_args+=(-- "$pattern" "$root")
set +e
LC_ALL=C rg "${"$"}{rg_args[@]}" | awk -v skip="$skip" -v need="$need" '
  index($0, "\"type\":\"match\"") {
    if (skip > 0) { skip--; next }
    print
    emitted++
    if (emitted >= need) exit
  }
'
statuses=("${"$"}{PIPESTATUS[@]}")
rg_status=${"$"}{statuses[0]}
case "$rg_status" in 0|1|141) exit 0 ;; *) exit "$rg_status" ;; esac`;

export function searchScriptArgs(options: {
  root: string;
  query: string;
  cursor: number;
  limit: number;
  maxFileSize: string;
  maxColumns: number;
  fixedStrings: boolean;
  includeHidden: boolean;
  globs: string[];
}): string[] {
  validateRemotePath(options.root);
  validateGlobs(options.globs);
  if (!options.query || options.query.includes("\0")) throw new Error("Search query must not be empty or contain NUL bytes.");
  return [
    options.root,
    String(options.cursor),
    String(options.limit + 1),
    options.maxFileSize,
    String(options.maxColumns),
    String(options.fixedStrings),
    String(options.includeHidden),
    String(options.globs.length),
    ...options.globs,
    options.query,
  ];
}

function rgText(value: { text?: string; bytes?: string } | undefined): string {
  if (!value) return "";
  if (value.text !== undefined) return value.text;
  return value.bytes ? Buffer.from(value.bytes, "base64").toString("utf8") : "";
}

export function parseSearchOutput(output: string): SearchMatch[] {
  if (!output) return [];
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string; bytes?: string };
        lines?: { text?: string; bytes?: string };
        line_number?: number;
        absolute_offset?: number;
        submatches?: Array<{ match?: { text?: string; bytes?: string }; start?: number; end?: number }>;
      };
    };
    if (event.type !== "match" || !event.data || !Number.isSafeInteger(event.data.line_number)) {
      throw new Error(`Unexpected ripgrep match record: ${JSON.stringify(line)}`);
    }
    const text = rgText(event.data.lines).replace(/\r?\n$/u, "");
    const submatches = (event.data.submatches ?? []).map((match) => ({
      text: rgText(match.match),
      startByte: match.start ?? 0,
      endByte: match.end ?? 0,
    }));
    const columnByte = (submatches[0]?.startByte ?? 0) + 1;
    const column = [...Buffer.from(text, "utf8").subarray(0, columnByte - 1).toString("utf8")].length + 1;
    return {
      path: rgText(event.data.path),
      line: event.data.line_number!,
      column,
      columnByte,
      text,
      submatches,
    };
  });
}
