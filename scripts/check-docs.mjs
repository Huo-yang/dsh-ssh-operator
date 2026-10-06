import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
for (const file of ['README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md', 'docs/TESTING.md', 'docs/RELEASING.md', 'skill/ssh-operator/SKILL.md']) {
  await access(join(root, file))
}
const zh = await readFile(join(root, 'README.md'), 'utf8')
const en = await readFile(join(root, 'README.en.md'), 'utf8')
assert.match(zh, /README\.en\.md/)
assert.match(en, /README\.md/)
assert.match(zh, /mcp__ssh_operator__/)
assert.match(en, /mcp__ssh_operator__/)
console.log('[docs] required bilingual documentation and links are present')
