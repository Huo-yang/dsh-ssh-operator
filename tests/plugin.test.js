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
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
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
