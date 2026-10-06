import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBundledSkill } from '../src/skill.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('bundle patch exposes the stable ssh_operator namespace', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: dsh-ssh-operator/)
  assert.match(patch, /serverName: ssh_operator/)
})

test('package exports the host entry and bundle patch', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
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
