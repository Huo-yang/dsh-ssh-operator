import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Read the packaged skill and separate its small YAML frontmatter from the
 * instruction body. The bundle owns this file, so malformed metadata is a
 * packaging error and should fail plugin activation instead of hiding it.
 *
 * @param {string} file
 */
export async function loadBundledSkill(file) {
  const source = await readFile(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (match === null) throw new Error('ssh-operator skill is missing YAML frontmatter')

  const metadata = Object.fromEntries(match[1].split(/\r?\n/u).map(line => {
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`ssh-operator skill has invalid frontmatter: ${line}`)
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }))
  if (metadata.name !== 'ssh-operator' || !metadata.description) {
    throw new Error('ssh-operator skill must declare its stable name and description')
  }
  return {
    name: metadata.name,
    description: metadata.description,
    content: match[2].trim(),
    path: file,
    source: 'bundled',
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function registerBundledSkill(ctx) {
  const file = fileURLToPath(new URL('../skill/ssh-operator/SKILL.md', import.meta.url))
  const skill = await loadBundledSkill(file)
  ctx.skills.register({
    ...skill,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
