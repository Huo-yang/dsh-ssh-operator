import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src/index.js')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-skill', '@deepseek-ai/schemastery'],
  logLevel: 'info',
})

await build({
  entryPoints: [join(root, 'src/server/index.ts')],
  outfile: join(outDir, 'server.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'info',
})

console.log('[build] dsh-ssh-operator: lib/index.js + lib/server.js')
