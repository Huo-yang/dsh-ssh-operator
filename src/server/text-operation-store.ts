import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { quarantineFile, type StorageDiagnostic } from "./storage-diagnostics.js";

export interface TextOperationRecord {
  operationId: string;
  host: string;
  remotePath: string;
  requestDigest: string;
  afterSha256: string;
  completedAt: string;
  result: Record<string, unknown>;
}

interface StoreDocument {
  version: 1;
  updatedAt: string;
  records: TextOperationRecord[];
}

class UnsupportedTextOperationVersionError extends Error {}

export function defaultTextOperationPath(): string {
  if (process.env.SSH_OPERATOR_TEXT_OPERATION_FILE) return process.env.SSH_OPERATOR_TEXT_OPERATION_FILE;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "ssh-operator-mcp", "text-operations.json");
  return join(homedir(), ".ssh-operator-mcp", "text-operations.json");
}

export class TextOperationStore {
  private readonly lockPath: string;
  private readonly storageDiagnostics: StorageDiagnostic[] = [];

  constructor(readonly path = defaultTextOperationPath(), private readonly maxRecords = 1_000) {
    this.lockPath = `${path}.lock`;
  }

  get(host: string, operationId: string): TextOperationRecord | undefined {
    return this.withLock(() => this.read().find((record) => record.host === host && record.operationId === operationId));
  }

  upsert(record: TextOperationRecord): void {
    const validated = this.validate(record);
    this.withLock(() => {
      const records = this.read().filter((candidate) => !(candidate.host === record.host && candidate.operationId === record.operationId));
      records.push(validated);
      this.write(records.slice(-this.maxRecords));
    });
  }

  count(): number {
    return this.withLock(() => this.read().length);
  }

  diagnostics(): StorageDiagnostic[] {
    return this.storageDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  private read(): TextOperationRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreDocument>;
      if (parsed.version !== 1) throw new UnsupportedTextOperationVersionError(`unsupported text-operation state version: ${String(parsed.version)}`);
      if (!Array.isArray(parsed.records)) throw new Error("missing text-operation records array");
      return parsed.records.map((record) => this.validate(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof UnsupportedTextOperationVersionError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.storageDiagnostics.push(quarantineFile("text-operation", this.path, reason));
      return [];
    }
  }

  private validate(value: unknown): TextOperationRecord {
    if (!value || typeof value !== "object") throw new Error("invalid text-operation record");
    const record = value as Partial<TextOperationRecord>;
    if (
      typeof record.operationId !== "string" || typeof record.host !== "string" || typeof record.remotePath !== "string" ||
      typeof record.requestDigest !== "string" || typeof record.afterSha256 !== "string" || typeof record.completedAt !== "string" ||
      !record.result || typeof record.result !== "object"
    ) throw new Error("invalid text-operation record");
    return { ...record, result: { ...record.result } } as TextOperationRecord;
  }

  private write(records: TextOperationRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const document: StoreDocument = { version: 1, updatedAt: new Date().toISOString(), records };
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + 5_000;
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(this.lockPath, "wx", 0o600);
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for text-operation state lock: ${this.lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try { return operation(); }
    finally {
      closeSync(descriptor);
      try { unlinkSync(this.lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private removeStaleLock(): void {
    try {
      if (Date.now() - statSync(this.lockPath).mtimeMs < 30_000) return;
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: number };
      if (lock.pid) {
        try { process.kill(lock.pid, 0); return; } catch {}
      }
      unlinkSync(this.lockPath);
    } catch {}
  }
}
