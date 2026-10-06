import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expected = [
  'ssh_close_process', 'ssh_delete_process_log', 'ssh_doctor', 'ssh_download',
  'ssh_exec', 'ssh_hash', 'ssh_list_hosts', 'ssh_list_process_logs',
  'ssh_list_processes', 'ssh_list_recovery_records', 'ssh_probe',
  'ssh_read_process_log', 'ssh_read_process_output', 'ssh_reconcile_processes',
  'ssh_run_script', 'ssh_start_process', 'ssh_stat', 'ssh_stop_process',
  'ssh_sudo_exec', 'ssh_sudo_probe', 'ssh_sudo_run_script',
  'ssh_upload', 'ssh_upload_atomic',
].sort()

const child = spawn(process.execPath, [join(root, 'lib/server.js')], {
  cwd: root,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PROGRAMDATA: process.env.PROGRAMDATA || 'C:\\ProgramData' },
})
let stdout = ''
let stderr = ''
let settled = false

const finish = (error) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  child.stdin.end()
  child.kill()
  if (error) {
    console.error(`${error.message}\nstderr: ${stderr}`)
    process.exitCode = 1
  }
}
const timer = setTimeout(() => finish(new Error('MCP smoke test timed out')), 5000)

child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
child.stdout.setEncoding('utf8').on('data', chunk => {
  stdout += chunk
  const lines = stdout.split(/\r?\n/u)
  stdout = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id !== 2) continue
    const actual = message.result.tools.map(tool => tool.name).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return finish(new Error(`Unexpected MCP tools: ${JSON.stringify(actual)}`))
    console.log(`[smoke] MCP handshake succeeded with ${actual.length} tools`)
    finish()
  }
})
child.once('error', finish)

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-ssh-operator-smoke', version: '0.1.0' } } })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
