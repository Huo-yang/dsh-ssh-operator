import { readFile } from "node:fs/promises";

export async function listConcreteHosts(configPath: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const hosts = new Set<string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^Host\s+(.+)$/iu.exec(line);
    if (!match) continue;
    for (const host of match[1].trim().split(/\s+/u)) {
      if (!host.startsWith("!") && !host.includes("*") && !host.includes("?")) {
        hosts.add(host);
      }
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}
