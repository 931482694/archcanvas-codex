import fs from 'node:fs'
import path from 'node:path'
import { brief } from '../lib/tasks.mjs'
import { sensitiveBrief, sealedAt, shellShows, grepShows, refusalOf, namedPaths, absolute, showsContent } from '../lib/privacy.mjs'
import { sensitiveOwner, isSensitive } from '../lib/nodetypes.mjs'
import { scanCode } from '../lib/audit.mjs'
import { cleanMask, maskText } from '../lib/mask.mjs'
import { classify, makeRun } from '../lib/worklog.mjs'
import { load, record, saveTasks, readJson, writeJson, withProjectLock } from './store.mjs'
import { findPatch, parsePatch } from './patch.mjs'
import { checkpoint, changesSince } from './snapshot.mjs'
import { beginPrompt, recordEdits, recordRun, sessionOf, codeVersion } from './worklog.mjs'
import { projectPath } from './paths.mjs'

function notebookOwner(root, graph, rel) {
  if (!/\.ipynb$/i.test(rel)) return undefined
  const sensitive = graph.nodes.find(isSensitive)
  if (!sensitive) return undefined
  try {
    const file = projectPath(root, rel)
    if (fs.statSync(file).size > 4 * 1024 * 1024) return sensitive
    const text = fs.readFileSync(file, 'utf8')
    const raw = JSON.parse(text)
    if (!raw.cells?.some(c => Array.isArray(c.outputs) && c.outputs.length)) return undefined
    const previous = readJson(root, '.archcanvas/scan.json')
    const all = [...(previous?.files ?? []), rel, ...graph.nodes.flatMap(n => n.files)]
    const fresh = scanCode([{ path: rel, text }], all, Date.now())
    return [...fresh.refs, ...(previous?.refs ?? []).filter(r => r.from === rel)].map(r => sensitiveOwner(graph, r.to)).find(Boolean)
  } catch { return sensitive } // Cannot safely inspect this output-bearing source.
}
function notebookGuards(root, graph) {
  const scan = readJson(root, '.archcanvas/scan.json')
  const guarded = new Map()
  for (const rel of new Set([...(scan?.files ?? []), ...(scan?.refs ?? []).map(r => r.from)].filter(p => /\.ipynb$/i.test(p)))) {
    const owner = notebookOwner(root, graph, rel)
    if (owner) guarded.set(rel, owner)
  }
  return guarded
}

export function projectOf(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.archcanvas/graph.json'))) return fs.realpathSync(dir)
    if (path.dirname(dir) === dir) return null
  }
}
export function onEdit(input) {
  const cwd = input.cwd || process.cwd(); const root = projectOf(cwd)
  if (!root) return 0
  return withProjectLock(root, () => {
    const response = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '')
    if (/verification failed|"success"\s*:\s*false|"exit_code"\s*:\s*[1-9]|^\s*"?error/i.test(response)) return 0
    const patch = findPatch(input.tool_input)
    if (!patch) return 0
    const changes = parsePatch(patch).map(c => ({ ...c, file: path.resolve(cwd, c.file) }))
    const session = sessionOf(root, input.session_id)
    const task = load(root).tasks.find(t => t.status === 'working' && (!t.sessionId || t.sessionId === session))
    // Record the entire interval once. A patch can follow a script edit to
    // the same file, so advancing to the post-patch file without this diff
    // would erase the script's contribution from history.
    const observed = task ? changesSince(root, task.id) : null
    const kept = observed ?? changes
    const n = record(root, kept, { tool: observed ? 'Codex（补丁与文件对比）' : 'apply_patch', toolUseId: input.tool_use_id || '', sessionId: session, transcript: input.transcript_path || '' })
    if (n) recordEdits(root, input, kept)
    if (task) checkpoint(root, task.id, kept)
    return n
  })
}
export function onPrompt(input) {
  const root = projectOf(input.cwd || process.cwd())
  if (!root) return ''
  return withProjectLock(root, () => {
    const { graph, tasks } = load(root)
    beginPrompt(root, input)
    const fresh = tasks.filter(t => t.status === 'queued' && !t.announced)
    const requests = readJson(root, '.archcanvas/requests.json') ?? []
    if (fresh.length) saveTasks(root, tasks.map(t => fresh.includes(t) ? { ...t, announced: true } : t))
    if (requests.length) writeJson(root, '.archcanvas/requests.json', [])
    return [
      'archcanvas：这个项目有架构画布。代码结构改变时，用 update_graph 局部更新（查 id 用 read_graph 的 brief）；得出关键结果时用 record_result 记录汇总结论。',
      input.session_id ? `本会话 archcanvas session_id=${input.session_id}。调用 archcanvas 工具时原样传入 session_id；不要从项目共享 context 推断会话身份。` : '',
      sensitiveBrief(graph, [...notebookGuards(root, graph).keys()])?.replace(/Claude/g, 'Codex') || '',
      'Codex 版的读取拦截依赖已信任的钩子和可识别的命令，不构成文件系统隔离；命令原始输出无法由此钩子替换。不要打印个体数据。',
      graph.nodes.some(isSensitive) ? '本机宿主可能不向钩子传递命令实际工作目录；读取非敏感源码时请用文件绝对路径，敏感文件仍禁止读取。' : '',
      fresh.length && !/list_tasks/.test(String(input.prompt || '')) ? [`画布中 ${fresh.length} 项待办已交付（项目：${root}）：`, ...fresh.map(t => brief(t, graph).replace(/Claude/g, 'Codex').replace(/\.claude\/skills/g, '.agents/skills')), '按用户当前授权处理；开始前 start_task，做完 complete_task，做不了用 release_task。'].join('\n') : '',
      ...requests.map(r => `用户从画布发出的请求（先回应当前用户消息）：${r.text}`),
    ].filter(Boolean).join('\n')
  })
}
export function onPre(input) {
  const args = input.tool_input || {}
  const base = input.cwd || process.cwd()
  const cwd = args.workdir ? path.resolve(base, args.workdir) : base
  const root = projectOf(cwd) || projectOf(base)
  if (!root) return null
  const { graph } = load(root)
  let sealed = []
  const name = input.tool_name || ''
  const command = String(args.command || args.cmd || '')
  if (/Bash|exec_command|shell|terminal/i.test(name)) sealed = shellShows(graph, root, cwd, String(args.command || args.cmd || ''))
  else if (/grep|search/i.test(name)) sealed = grepShows(graph, root, cwd, args)
  else if (/read|file|view/i.test(name)) {
    const at = sealedAt(graph, root, cwd, String(args.path || args.file_path || args.filename || ''))
    if (at) sealed = [at]
  }
  const notebookPaths = [...command.matchAll(/["']([^"'\n]+\.ipynb)["']|([^\s"'`;()|]+\.ipynb)\b/gi)].map(m => m[1] ?? m[2])
  const candidates = /Bash|exec_command|shell/i.test(name)
    ? (showsContent(command) ? [...namedPaths(command), ...notebookPaths] : [])
    : [String(args.path || args.file_path || args.filename || '')]
  for (const given of candidates.filter(Boolean)) {
    try {
      const real = fs.realpathSync(absolute(cwd, given))
      const relative = path.relative(root, real).replace(/\\/g, '/')
      if (relative.startsWith('../') || path.isAbsolute(relative)) continue
      const owner = sensitiveOwner(graph, relative) || notebookOwner(root, graph, relative)
      if (owner) sealed.push({ owner, path: relative })
    } catch { /* Unresolved paths remain subject to the lexical guard. */ }
  }
  if (!sealed.length) {
    // Some Codex hosts normalize exec_command to Bash and omit workdir while
    // leaving cwd at the turn root. Relative reads cannot be resolved safely.
    if (name === 'Bash' && !args.workdir && graph.nodes.some(isSensitive) && showsContent(command)) {
      const paths = namedPaths(command)
      if (!paths.length || paths.some(p => !path.isAbsolute(p))) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'archcanvas：宿主没有提供命令实际工作目录，已拒绝无法确定目标的相对路径读取。请使用目标文件的绝对路径；敏感文件仍禁止读取。' } }
    }
    if (/Bash|exec_command|shell/i.test(name) && input.tool_use_id && classify(command)) {
      withProjectLock(root, () => {
        const starts = readJson(root, '.archcanvas/run-starts.json') ?? {}
        starts[input.tool_use_id] = { at: Date.now(), version: codeVersion(root) }
        writeJson(root, '.archcanvas/run-starts.json', Object.fromEntries(Object.entries(starts).slice(-100)))
      })
    }
    return null
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusalOf(sealed, '显示内容') } }
}
export function onPost(input) {
  if (/apply_patch|^Edit$|^Write$/.test(input.tool_name || '')) return onEdit(input)
  const root = projectOf(input.cwd || process.cwd())
  const polling = /write_stdin$/.test(input.tool_name || '')
  if (!root || (!polling && !/Bash|exec_command|shell/i.test(input.tool_name || ''))) return 0
  return withProjectLock(root, () => {
    const session = sessionOf(root, input.session_id)
    const pending = readJson(root, '.archcanvas/run-pending.json') ?? {}
    const key = JSON.stringify([session, String(input.tool_input?.session_id ?? '')])
    const previous = polling ? pending[key] : undefined
    if (polling && !previous) return 0
    const command = previous?.command ?? String(input.tool_input?.command || input.tool_input?.cmd || '')
    const seen = classify(command); if (!seen) return 0
    const response = input.tool_response
    const out = typeof response === 'string' ? response : String(response?.output ?? response?.stdout ?? response?.content?.filter?.(c => c.type === 'text').map(c => c.text).join('\n') ?? '')
    const rawExit = response?.exit_code ?? response?.exitCode
    const exit = Number.isInteger(rawExit) ? rawExit : undefined
    const processId = response?.session_id ?? response?.process_id
    const running = exit === undefined && processId !== undefined && !response?.isError
    const failed = response?.isError || (exit !== undefined && exit !== 0)
    const settings = cleanMask(readJson(root, '.archcanvas/mask.json'))
    const starts = readJson(root, '.archcanvas/run-starts.json') ?? {}
    const started = previous?.started ?? starts[input.tool_use_id]
    const runId = previous?.runId ?? input.tool_use_id ?? `run-${Date.now()}`
    const run = makeRun(runId, started?.at ?? Date.now(), maskText(command, settings).text, seen, { status: running ? 'background' : exit === undefined && !response?.isError ? 'unknown' : failed ? 'failed' : 'ok', ...(exit !== undefined ? { exitCode: exit } : {}), out: maskText(out, settings).text }, load(root).graph, started ? { ms: Date.now() - started.at, version: started.version } : {})
    if (!running) run.finishedAt = Date.now()
    recordRun(root, input, run)
    if (polling) delete pending[key]
    if (running) pending[JSON.stringify([session, String(processId)])] = { runId, command: maskText(command, settings).text, started: started ?? { at: run.at } }
    writeJson(root, '.archcanvas/run-pending.json', pending)
    if (starts[input.tool_use_id]) { delete starts[input.tool_use_id]; writeJson(root, '.archcanvas/run-starts.json', starts) }
    return 1
  })
}
export function runHook(fn) {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => { text += d })
  process.stdin.on('end', () => {
    try {
      const out = fn(JSON.parse(text || '{}'))
      if (typeof out === 'string' && out) process.stdout.write(out + '\n')
      else if (out && typeof out === 'object') process.stdout.write(JSON.stringify(out) + '\n')
    } catch (err) {
      // Never fail closed on an unexpected infrastructure error, and never
      // claim an edit or protection was applied when it was not.
      process.stderr.write(`archcanvas：${err.message}\n`)
      if (fn === onPre) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'archcanvas 无法读取项目保护状态；请修复记录文件后重试。' } }) + '\n')
    }
  })
}
