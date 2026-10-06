import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { migrationDiagnostic, quarantineFile, type StorageDiagnostic } from "./storage-diagnostics.js";

export interface ActiveProcessRecord {
  processId: string;
  host: string;
  remotePid: number;
  token: string;
  startedAt: string;
  ownerPid: number;
  detached: boolean;
}

interface StoreDocumentV1 {
  version: 1;
  records: ActiveProcessRecord[];
}

interface StoreDocument {
  version: 2;
  updatedAt: string;
  records: ActiveProcessRecord[];
}

class UnsupportedStateVersionError extends Error {}

export function defaultStatePath(): string {
  if (process.env.SSH_OPERATOR_STATE_FILE) return process.env.SSH_OPERATOR_STATE_FILE;
  if (process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "ssh-operator-mcp", "active-processes.json");
  }
  return join(homedir(), ".ssh-operator-mcp", "active-processes.json");
}

export class ActiveProcessStore {
  private records: ActiveProcessRecord[];
  private readonly lockPath: string;
  private readonly storageDiagnostics: StorageDiagnostic[] = [];

  constructor(readonly path = defaultStatePath()) {
    this.lockPath = `${this.path}.lock`;
    this.records = this.withLock(() => this.read());
  }

  list(): ActiveProcessRecord[] {
    return this.withLock(() => {
      this.records = this.read();
      return this.records.map((record) => ({ ...record }));
    });
  }

  diagnostics(): StorageDiagnostic[] {
    return this.storageDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  upsert(record: ActiveProcessRecord): void {
    const validated = this.validate(record);
    this.withLock(() => {
      this.records = this.read().filter((candidate) => candidate.processId !== record.processId);
      this.records.push({ ...validated });
      this.write(this.records);
    });
  }

  remove(processId: string): void {
    this.withLock(() => {
      this.records = this.read();
      const remaining = this.records.filter((record) => record.processId !== processId);
      if (remaining.length === this.records.length) return;
      this.records = remaining;
      this.write(this.records);
    });
  }

  markDetached(processId: string): void {
    this.withLock(() => {
      this.records = this.read();
      const record = this.records.find((candidate) => candidate.processId === processId);
      if (!record) return;
      record.detached = true;
      this.write(this.records);
    });
  }

  private read(): ActiveProcessRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreDocument | StoreDocumentV1>;
      if (parsed.version !== 1 && parsed.version !== 2) {
        throw new UnsupportedStateVersionError(`unsupported state version: ${String(parsed.version)}`);
      }
      if (!Array.isArray(parsed.records)) throw new Error("missing records array");
      const records: ActiveProcessRecord[] = [];
      let invalidRecords = 0;
      for (const record of parsed.records) {
        try { records.push(this.validate(record)); } catch { invalidRecords += 1; }
      }
      if (invalidRecords > 0) {
        this.storageDiagnostics.push(quarantineFile("state", this.path, `${invalidRecords} invalid process record(s)`));
        this.write(records);
        return records;
      }
      if (parsed.version === 1) {
        this.write(records);
        this.storageDiagnostics.push(migrationDiagnostic("state", this.path, 1, 2));
        return records;
      }
      if (typeof (parsed as Partial<StoreDocument>).updatedAt !== "string") throw new Error("missing state updatedAt");
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof UnsupportedStateVersionError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      try {
        this.storageDiagnostics.push(quarantineFile("state", this.path, reason));
        return [];
      } catch (quarantineError) {
        throw new Error(`Could not quarantine invalid active-process state ${this.path}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`);
      }
    }
  }

  private validate(value: unknown): ActiveProcessRecord {
    if (!value || typeof value !== "object") throw new Error("invalid process record");
    const record = value as Partial<ActiveProcessRecord>;
    if (
      typeof record.processId !== "string" ||
      typeof record.host !== "string" ||
      !Number.isSafeInteger(record.remotePid) ||
      (record.remotePid ?? 0) <= 0 ||
      typeof record.token !== "string" ||
      typeof record.startedAt !== "string" ||
      !Number.isSafeInteger(record.ownerPid) ||
      (record.ownerPid ?? 0) <= 0 ||
      (record.detached !== undefined && typeof record.detached !== "boolean")
    ) {
      throw new Error("invalid process record");
    }
    return { ...record, detached: record.detached ?? false } as ActiveProcessRecord;
  }

  private write(records: ActiveProcessRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const document: StoreDocument = { version: 2, updatedAt: new Date().toISOString(), records };
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
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for active-process state lock: ${this.lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private removeStaleLock(): void {
    try {
      const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
      if (ageMs < 30_000) return;
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: number };
      if (lock.pid && this.isProcessAlive(lock.pid)) return;
      unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
