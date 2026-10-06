import { renameSync } from "node:fs";

export interface StorageDiagnostic extends Record<string, unknown> {
  area: "state" | "log";
  action: "migrated" | "quarantined";
  path: string;
  timestamp: string;
  reason?: string;
  quarantinedPath?: string;
  fromVersion?: number;
  toVersion?: number;
}

export function migrationDiagnostic(area: StorageDiagnostic["area"], path: string, fromVersion: number, toVersion: number): StorageDiagnostic {
  return { area, action: "migrated", path, timestamp: new Date().toISOString(), fromVersion, toVersion };
}

export function quarantineFile(area: StorageDiagnostic["area"], path: string, reason: string): StorageDiagnostic {
  const quarantinedPath = `${path}.corrupt.${Date.now()}.${process.pid}`;
  renameSync(path, quarantinedPath);
  return { area, action: "quarantined", path, quarantinedPath, reason, timestamp: new Date().toISOString() };
}
