import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { OutputChunk } from "./process-manager.js";
import { migrationDiagnostic, quarantineFile, type StorageDiagnostic } from "./storage-diagnostics.js";

export interface ProcessLogMetadata extends Record<string, unknown> {
  version: 2;
  updatedAt: string;
  processId: string;
  host: string;
  command: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  running: boolean;
  bytesWritten: number;
  chunkCount: number;
  maxBytes: number;
  truncated: boolean;
  recoveryOutcome?: string;
}

export interface ProcessLogPage extends Record<string, unknown> {
  metadata: ProcessLogMetadata;
  chunks: OutputChunk[];
  nextCursor: number;
  hasMore: boolean;
}

export interface StartProcessLog {
  processId: string;
  host: string;
  command: string;
  cwd?: string;
  startedAt: string;
  maxBytes: number;
}

export function defaultLogDirectory(): string {
  if (process.env.SSH_OPERATOR_LOG_DIR) return process.env.SSH_OPERATOR_LOG_DIR;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "ssh-operator-mcp", "logs");
  return join(homedir(), ".ssh-operator-mcp", "logs");
}

export class ProcessLogStore {
  private readonly storageDiagnostics: StorageDiagnostic[] = [];

  constructor(readonly directory = defaultLogDirectory()) {
    this.scanMetadata();
  }

  diagnostics(): StorageDiagnostic[] {
    return this.storageDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  start(metadata: StartProcessLog): string {
    this.validateId(metadata.processId);
    mkdirSync(this.directory, { recursive: true });
    const complete: ProcessLogMetadata = {
      ...metadata,
      version: 2,
      updatedAt: new Date().toISOString(),
      running: true,
      bytesWritten: 0,
      chunkCount: 0,
      truncated: false,
    };
    writeFileSync(this.logPath(metadata.processId), "", { encoding: "utf8", mode: 0o600 });
    this.writeMetadata(complete);
    return this.logPath(metadata.processId);
  }

  append(processId: string, chunk: OutputChunk): void {
    const metadata = this.get(processId);
    if (!metadata || metadata.truncated) return;
    const line = `${JSON.stringify(chunk)}\n`;
    const bytes = Buffer.byteLength(line);
    if (metadata.bytesWritten + bytes > metadata.maxBytes) {
      metadata.truncated = true;
      this.writeMetadata(metadata);
      return;
    }
    appendFileSync(this.logPath(processId), line, "utf8");
    metadata.bytesWritten += bytes;
    metadata.chunkCount += 1;
    this.writeMetadata(metadata);
  }

  finish(processId: string, recoveryOutcome?: string): void {
    const metadata = this.get(processId);
    if (!metadata) return;
    metadata.running = false;
    metadata.endedAt = new Date().toISOString();
    metadata.recoveryOutcome = recoveryOutcome;
    this.writeMetadata(metadata);
  }

  list(): ProcessLogMetadata[] {
    if (!existsSync(this.directory)) return [];
    const records: ProcessLogMetadata[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(this.readMetadata(join(this.directory, name)));
      } catch {
        // Startup scanning already quarantines invalid metadata. Ignore a record changed concurrently.
      }
    }
    return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  get(processId: string): ProcessLogMetadata | undefined {
    this.validateId(processId);
    const path = this.metadataPath(processId);
    if (!existsSync(path)) return undefined;
    try {
      return this.readMetadata(path);
    } catch (error) {
      this.quarantine(path, error instanceof Error ? error.message : String(error));
      throw new Error(`Corrupt process log metadata was quarantined: ${path}`);
    }
  }

  async read(processId: string, cursor = 0, limit = 100): Promise<ProcessLogPage> {
    const metadata = this.get(processId);
    if (!metadata) throw new Error(`Unknown persisted process log: ${processId}`);
    const chunks: OutputChunk[] = [];
    let hasMore = false;
    const input = createReadStream(this.logPath(processId), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const chunk = this.validateChunk(JSON.parse(line));
        if (chunk.seq <= cursor) continue;
        if (chunks.length < limit) chunks.push(chunk);
        else {
          hasMore = true;
          break;
        }
      }
    } catch (error) {
      lines.close();
      input.destroy();
      const reason = error instanceof Error ? error.message : String(error);
      this.quarantine(this.logPath(processId), reason);
      this.quarantine(this.metadataPath(processId), reason);
      throw new Error(`Corrupt process log data was quarantined: ${processId}`);
    }
    lines.close();
    input.destroy();
    return {
      metadata,
      chunks,
      nextCursor: chunks.at(-1)?.seq ?? cursor,
      hasMore,
    };
  }

  delete(processId: string): void {
    this.validateId(processId);
    if (!this.get(processId)) throw new Error(`Unknown persisted process log: ${processId}`);
    rmSync(this.metadataPath(processId));
    rmSync(this.logPath(processId), { force: true });
  }

  private metadataPath(processId: string): string {
    return join(this.directory, `${processId}.json`);
  }

  private logPath(processId: string): string {
    return join(this.directory, `${processId}.ndjson`);
  }

  private validateId(processId: string): void {
    if (!/^[A-Za-z0-9-]+$/u.test(processId)) throw new Error("Invalid process log identifier.");
  }

  private readMetadata(path: string): ProcessLogMetadata {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<ProcessLogMetadata, "version">> & { version?: number };
    if (
      typeof parsed.processId !== "string" ||
      typeof parsed.host !== "string" ||
      typeof parsed.command !== "string" ||
      typeof parsed.startedAt !== "string" ||
      !Number.isSafeInteger(parsed.bytesWritten) ||
      !Number.isSafeInteger(parsed.chunkCount) ||
      !Number.isSafeInteger(parsed.maxBytes) ||
      typeof parsed.running !== "boolean" ||
      typeof parsed.truncated !== "boolean"
    ) {
      throw new Error(`Invalid process log metadata: ${path}`);
    }
    if (basename(path) !== `${parsed.processId}.json`) throw new Error(`Process log metadata identifier does not match its filename: ${path}`);
    if (parsed.version === 1) {
      const migrated = { ...parsed, version: 2, updatedAt: new Date().toISOString() } as ProcessLogMetadata;
      this.writeMetadata(migrated);
      this.storageDiagnostics.push(migrationDiagnostic("log", path, 1, 2));
      return migrated;
    }
    if (parsed.version !== 2 || typeof parsed.updatedAt !== "string") throw new Error(`Unsupported process log metadata version: ${String(parsed.version)}`);
    return parsed as ProcessLogMetadata;
  }

  private writeMetadata(metadata: ProcessLogMetadata): void {
    metadata.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.metadataPath(metadata.processId)), { recursive: true });
    const path = this.metadataPath(metadata.processId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  private validateChunk(value: unknown): OutputChunk {
    if (!value || typeof value !== "object") throw new Error("Invalid process log chunk");
    const chunk = value as Partial<OutputChunk>;
    if (!Number.isSafeInteger(chunk.seq) || (chunk.seq ?? 0) <= 0 || !["stdout", "stderr"].includes(chunk.stream ?? "") || typeof chunk.text !== "string" || typeof chunk.timestamp !== "string") {
      throw new Error("Invalid process log chunk");
    }
    return chunk as OutputChunk;
  }

  private quarantine(path: string, reason: string): void {
    try {
      this.storageDiagnostics.push(quarantineFile("log", path, reason));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private scanMetadata(): void {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      try {
        this.readMetadata(path);
      } catch (error) {
        this.quarantine(path, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
