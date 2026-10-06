import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import { registerBundledSkill } from './skill.js'

export const name = 'dsh-ssh-operator'
export const inject = ['tools', 'skills']

const DEFAULT_CONFIG = Object.freeze({
  serverName: 'ssh_operator',
  toolCallTimeoutMs: 120_000,
  failOnStartupError: false,
})

/**
 * Load the bundled ssh-operator MCP server through DSH's first-party bridge.
 * The bridge owns discovery, tool registration, cancellation and reconnects;
 * this plugin only resolves its packaged server entry point and safe defaults.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULT_CONFIG>} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig }
  const serverEntry = fileURLToPath(new URL('./server.js', import.meta.url))
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData'

  await registerBundledSkill(ctx)
  await applyMcpClient(ctx, {
    transport: 'stdio',
    serverName: config.serverName,
    command: process.execPath,
    args: [serverEntry],
    env: { PROGRAMDATA: programData },
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  })
}

export const Config = z.object({
  serverName: z.string().default(DEFAULT_CONFIG.serverName),
  toolCallTimeoutMs: z.number().step(1000).min(1000).default(DEFAULT_CONFIG.toolCallTimeoutMs),
  failOnStartupError: z.boolean().default(DEFAULT_CONFIG.failOnStartupError),
})
export { DEFAULT_CONFIG }
