import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBundledSkill } from '../src/skill.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('carrier bundle mounts the host and the in-box MCP bridge', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: ssh-operator\s+name: "@huo-yang\/dsh-ssh-operator"/u)
  assert.match(patch, /id: ssh-operator-bridge\s+name: "@deepseek-ai\/dsh-mcp-client"/u)
  assert.match(patch, /name: "@huo-yang\/dsh-ssh-operator"/u)
  assert.match(patch, /serverName: ssh_operator/)
  assert.match(patch, /transport: stdio/u)
  assert.match(patch, /import\('@huo-yang\/dsh-ssh-operator\/server'\)/u)
  assert.match(patch, /ctx\.get\('profileContext'\)\?\.dir/u)
})

test('package exports the host entry and bundle patch', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@huo-yang/dsh-ssh-operator')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./server'], './lib/server.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.peerDependencies, undefined)
})

test('host source does not import DSH internal runtime packages', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-/u)
  assert.doesNotMatch(source, /@deepseek-ai\/schemastery/u)
})

test('package metadata is localized for Chinese and English DSH locales', async () => {
  const zh = JSON.parse(await readFile(join(root, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'))
  assert.equal(typeof zh.meta.title, 'string')
  assert.equal(typeof zh.meta.description, 'string')
  assert.equal(typeof en.meta.title, 'string')
  assert.equal(typeof en.meta.description, 'string')
  assert.notEqual(zh.meta.title, en.meta.title)
})

test('packaged ssh-operator skill is valid and model invocable', async () => {
  const file = join(root, 'skill', 'ssh-operator', 'SKILL.md')
  const skill = await loadBundledSkill(file)
  assert.equal(skill.name, 'ssh-operator')
  assert.match(skill.description, /ssh/i)
  assert.match(skill.content, /ssh_run_script/)
  assert.equal(skill.path, file)
  assert.equal(skill.source, 'bundled')
})
