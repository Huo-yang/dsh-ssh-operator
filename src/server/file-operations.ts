import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { shellQuote } from "./commands.js";

export interface RemoteFileStat extends Record<string, unknown> {
  type: string;
  size: number;
  mode: string;
  uid: number;
  gid: number;
  modifiedEpochSeconds: number;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function remoteHashCommand(path: string): string {
  return `sha256sum -- ${shellQuote(path)} | awk '{print $1}'`;
}

export function remoteStatCommand(path: string, followSymlinks: boolean): string {
  return `LC_ALL=C stat ${followSymlinks ? "-L " : ""}-c '%F|%s|%a|%u|%g|%Y' -- ${shellQuote(path)}`;
}

export function parseRemoteStat(output: string): RemoteFileStat {
  const fields = output.trimEnd().split("|");
  if (fields.length !== 6) throw new Error(`Unexpected remote stat output: ${JSON.stringify(output)}`);
  const [type, sizeText, mode, uidText, gidText, modifiedText] = fields;
  const size = Number(sizeText);
  const uid = Number(uidText);
  const gid = Number(gidText);
  const modifiedEpochSeconds = Number(modifiedText);
  if (!type || !/^\d{3,4}$/u.test(mode) || ![size, uid, gid, modifiedEpochSeconds].every(Number.isSafeInteger)) {
    throw new Error(`Invalid remote stat fields: ${JSON.stringify(fields)}`);
  }
  return { type, size, mode, uid, gid, modifiedEpochSeconds };
}

export function parseSha256(output: string): string {
  const digest = output.trim();
  if (!/^[a-fA-F0-9]{64}$/u.test(digest)) throw new Error(`Unexpected SHA-256 output: ${JSON.stringify(output)}`);
  return digest.toLowerCase();
}
