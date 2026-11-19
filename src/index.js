import { registerBundledSkill } from './skill.js'

export const name = 'dsh-ssh-operator'
export const inject = ['skills']

/**
 * Register the bundled Skill. The MCP bridge is mounted independently by
 * cordis.patch.yml so this host never imports DSH's private runtime packages.
 *
 * @param {{ skills: { register(skill: object): unknown } }} ctx
 */
export async function apply(ctx) {
  await registerBundledSkill(ctx)
}
