import { z } from "zod";

export const commonFields = {
  host: z.string().describe("REQUIRED. Explicit concrete Host alias from the local OpenSSH config; never omit it or infer it from prior conversation context."),
  cwd: z.string().optional().describe("Absolute working directory on the remote host"),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxOutputBytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional(),
};

export const executionContextFields = {
  shellMode: z.enum(["default", "login", "interactive"]).default("default")
    .describe("Remote shell startup mode. interactive may run startup-file side effects and emit startup output; it does not allocate a PTY."),
  environment: z.record(z.string(), z.string().nullable()).default({})
    .describe("Environment variables to set, or null values to unset. Values are never included in execution metadata."),
};
