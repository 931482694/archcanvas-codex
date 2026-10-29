// Local stdio MCP transport. Project behavior is implemented in runtime/;
// the browser's stdout is never allowed to contaminate JSON-RPC stdout.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { TOOLS, validate } from './tools.mjs'
import { callProjectTool } from '../runtime/tools.mjs'
import { canvasAction, auditProject } from '../runtime/project.mjs'
import { load, readJson } from '../runtime/store.mjs'
import { describe } from '../lib/graph.mjs'
import { projectPath } from '../runtime/paths.mjs'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.codex-plugin/plugin.json'), 'utf8')).version
const canvases = new Map(); const pending = new Map()
const sessions = new Map()
let clientCaps = {}; let nextId = 0; let initialized = false
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
function request(method, params) {
  const id = `archcanvas-${++nextId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 5000)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
async function projectRoot(arg) {
  let given = arg
  if (!given && clientCaps.roots) {
    const result = await request('roots/list', {})
    const roots = (result?.roots ?? []).filter(r => String(r.uri).startsWith('file:'))
    if (roots.length > 1) throw new Error('当前有多个项目，请明确传 project 的绝对路径')
    if (roots.length === 1) given = fileURLToPath(roots[0].uri)
  }
  given ||= process.env.ARCHCANVAS_ROOT
  if (!given && !fs.existsSync(path.join(process.cwd(), '.codex-plugin'))) given = process.cwd()
  if (typeof given !== 'string' || !path.isAbsolute(given)) throw new Error('请传 project：当前项目根目录的绝对路径')
  const root = fs.realpathSync(given)
  if (!fs.statSync(root).isDirectory()) throw new Error('项目路径必须是文件夹')
  if (root === fs.realpathSync(PLUGIN)) throw new Error('不能将插件安装目录当作用户项目')
  projectPath(root, '.archcanvas')
  return root
}
function startCanvas(root) {
  if (canvases.has(root)) return canvases.get(root).ready
  const child = spawn(process.execPath, [path.join(PLUGIN, 'server/canvas-server.mjs'), root, ''], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARCHCANVAS_AGENT: 'Codex', ARCHCANVAS_REOPEN: '回到 Codex，说「打开架构画布」重新打开。', ARCHCANVAS_HANDOFF: JSON.stringify({ handover: '请用 archcanvas 的 list_tasks 查看我交付的 {n} 项待办，按当前授权处理，实施前 start_task，做完 complete_task。', generate: '请读项目代码，用 archcanvas 的 save_graph 生成架构图，附带模块类型、真实代码依据和执行主线；数据只看目录。' }), ARCHCANVAS_WATCH_ACTIVITY: '1' },
  })
  const entry = { child, info: null }; canvases.set(root, entry)
  entry.ready = new Promise((resolve, reject) => {
    let errors = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('画布服务启动超时')) }, 10000)
    child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { errors = (errors + d).slice(-1500) })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      try {
        if (line.startsWith('@@READY ')) { entry.info = JSON.parse(line.slice(8)); clearTimeout(timer); resolve(entry.info) }
        else if (line.startsWith('@@ACTION ')) {
          let result
          try { result = canvasAction(root, JSON.parse(line.slice(9))) } catch (err) { result = { notice: err.message, level: 'error' } }
          if (result.notice && entry.info) fetch(`http://127.0.0.1:${entry.info.port}/api/notice`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-archcanvas-token': entry.info.token }, body: JSON.stringify({ text: result.notice, level: result.level }), signal: AbortSignal.timeout(3000) }).catch(() => {})
        }
      } catch (err) { process.stderr.write(`archcanvas：${err.message}\n`) }
    })
    child.on('error', err => { clearTimeout(timer); canvases.delete(root); reject(err) })
    child.on('exit', () => { clearTimeout(timer); canvases.delete(root); lines.close(); if (!entry.info) reject(new Error(errors || '画布服务没有启动')) })
  })
  return entry.ready
}
function openBrowser(url) {
  if (process.env.ARCHCANVAS_NO_BROWSER === '1') return Promise.resolve(false)
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  return new Promise(resolve => execFile(cmd, args, { windowsHide: true, timeout: 10000 }, err => resolve(!err)))
}
async function call(name, args) {
  const def = TOOLS.find(t => t.name === name)
  if (!def) throw new Error(`没有这个工具：${name}`)
  validate(args, def.inputSchema)
  const root = await projectRoot(args.project)
  if (!sessions.has(root)) sessions.set(root, process.env.CODEX_THREAD_ID || `mcp-${process.pid}`)
  args = { ...args, session_id: args.session_id || sessions.get(root) }
  if (name !== 'open_canvas') {
    if (name === 'read_graph' && !load(root).graph) return `这个项目还没有架构图。（找的是 ${projectPath(root, '.archcanvas/graph.json')}）`
    return callProjectTool(root, name, args)
  }
  const { graph } = load(root)
  if (graph) auditProject(root, graph)
  const info = await startCanvas(root)
  const url = `http://127.0.0.1:${info.port}/open?k=${info.token}`
  const opened = await openBrowser(url)
  return [`架构画布已${opened ? '在浏览器打开' : '启动'}（${graph ? describe(graph) : '还没有架构图'}）。`, `链接：${url}`, '可以在 Codex 内置浏览器中打开。画布仅本机访问，MCP 进程结束后关闭。', '画布请求会在下一条消息附带给 Codex；命令原始输出不会被此插件自动替换或打码。'].join('\n')
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async line => {
  let msg
  try { msg = JSON.parse(line) } catch { error(null, -32700, 'Parse error'); return }
  if (!msg || Array.isArray(msg) || typeof msg !== 'object' || msg.jsonrpc !== '2.0') { error(null, -32600, 'Invalid Request'); return }
  if (!msg.method && msg.id !== undefined) {
    const waiter = pending.get(msg.id)
    if (waiter) { clearTimeout(waiter.timer); pending.delete(msg.id); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result) }
    return
  }
  if (typeof msg.method !== 'string') { error(msg.id ?? null, -32600, 'Invalid Request'); return }
  if (msg.id === undefined) return // Notifications never receive a response or execute tools.
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    clientCaps = msg.params?.capabilities || {}; initialized = true
    return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'archcanvas', version: VERSION }, instructions: 'archcanvas：打开画布用 open_canvas；结构变化用 update_graph 局部更新；完整重画用 save_graph（结构变化等用户确认）；关键结论用 record_result。只处理已交付待办，start_task → complete_task，无法继续用 release_task。project 明确传当前项目根目录。' })
  }
  if (msg.method === 'ping') return reply({})
  if (!initialized) { error(msg.id, -32000, 'Initialize first'); return }
  if (msg.method === 'tools/list') return reply({ tools: TOOLS })
  if (msg.method === 'tools/call') {
    if (!msg.params || typeof msg.params.name !== 'string') { error(msg.id, -32602, 'Invalid params'); return }
    try { reply({ content: [{ type: 'text', text: await call(msg.params.name, msg.params.arguments ?? {}) }] }) }
    catch (err) { reply({ isError: true, content: [{ type: 'text', text: `出错了：${err.message}` }] }) }
    return
  }
  error(msg.id, -32601, `Method not found: ${msg.method}`)
})
async function shutdown() {
  const exits = [...canvases.values()].map(({ child }) => { const done = once(child, 'exit'); child.kill(); return done })
  for (const p of pending.values()) clearTimeout(p.timer)
  await Promise.race([Promise.allSettled(exits), new Promise(resolve => setTimeout(resolve, 3000))])
  process.exit(0)
}
rl.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
