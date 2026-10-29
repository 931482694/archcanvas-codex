import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { applyAction } from '../lib/actions.mjs'
import { check, describe } from '../lib/graph.mjs'
import { applyPatch } from '../lib/patch.mjs'
import { carryOver, carryWords, diffGraphs, isStructural, changeLines } from '../lib/merge.mjs'
import { reopened, clearOutputs } from '../lib/privacy.mjs'
import { sensitiveOwner, DATA_FILE, typeOf, isSensitive } from '../lib/nodetypes.mjs'
import { applyCheckAction } from '../lib/checks.mjs'
import { audit, scanCode, isCodeFile, isConfigFile, skipDir, MAX_LIST, MAX_SCAN, MAX_CHARS, drawTie, auditSummary, auditPrompt } from '../lib/audit.mjs'
import { anchorAt, citedSpots, cleanAnchors, relocate, spotKey } from '../lib/relocate.mjs'
import { cleanMask, formatPattern } from '../lib/mask.mjs'
import { setNote, setMark } from '../lib/worklog.mjs'
import { load, readJson, writeJson, saveGraph, saveTasks, saveHistory, withProjectLock, transaction } from './store.mjs'
import { projectPath } from './paths.mjs'
import { scrubSnapshots, dropSnapshot } from './snapshot.mjs'

const PENDING = '.archcanvas/pending.json'
function protectNewData(prev, next) {
  if (next.nodes.some(n => typeOf(n) === 'data' && n.sensitive === false && !prev?.nodes.some(p => p.id === n.id && typeOf(p) === 'data' && p.sensitive === false))) throw new Error('新增的数据模块须先按敏感处理；只能由用户在画布中确认不敏感')
}
function requireGraph(root) { const g = load(root).graph; if (!g) throw new Error('这个项目还没有架构图'); return g }
function textOf(root, graph, rel) {
  if (DATA_FILE.test(rel) || sensitiveOwner(graph, rel)) return null
  try {
    const p = projectPath(root, rel)
    if (fs.statSync(p).size > MAX_CHARS) return null
    const buf = fs.readFileSync(p)
    if (buf.subarray(0, 8000).includes(0)) return null
    return buf.toString('utf8')
  } catch { return null }
}
export function auditProject(root, graph = requireGraph(root), fresh = []) {
  return withProjectLock(root, () => {
    const all = []; let truncated = false
    const visit = (dir = '', depth = 0) => {
      if (depth > 16 || all.length >= MAX_LIST) { truncated = true; return }
      for (const e of fs.readdirSync(projectPath(root, dir), { withFileTypes: true })) {
        if (all.length >= MAX_LIST) { truncated = true; break }
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (e.isSymbolicLink() || sensitiveOwner(graph, rel)) continue
        if (e.isDirectory() && !skipDir(e.name)) { try { visit(rel, depth + 1) } catch { truncated = true } }
        else if (e.isFile()) all.push(rel)
      }
    }
    visit()
    const texts = new Map(); const code = []; const configs = []
    for (const rel of all) {
      if (!isCodeFile(rel) && !isConfigFile(rel)) continue
      if (code.length + configs.length >= MAX_SCAN) { truncated = true; break }
      const text = textOf(root, graph, rel)
      if (text === null) { truncated = true; continue }
      texts.set(rel, text)
      ;(isCodeFile(rel) ? code : configs).push({ path: rel, text })
    }
    // Evidence may cite a Markdown entrypoint; never use Notebook outputs as anchors.
    for (const s of citedSpots(graph)) if (!texts.has(s.path) && !/\.ipynb$/i.test(s.path)) {
      const text = textOf(root, graph, s.path); if (text !== null) texts.set(s.path, text)
    }
    const scan = scanCode(code, all, Date.now(), truncated, configs)
    const anchors = cleanAnchors(readJson(root, '.archcanvas/anchors.json'), graph)
    const freshKeys = new Set(fresh.map(spotKey))
    for (const s of citedSpots(graph)) {
      if (/\.ipynb$/i.test(s.path)) continue
      if (!anchors[spotKey(s)] || freshKeys.has(spotKey(s))) {
        const text = texts.get(s.path); const anchor = text === undefined ? null : anchorAt(text, s)
        if (anchor) anchors[spotKey(s)] = anchor
      }
    }
    const moved = relocate(graph, anchors, texts)
    const found = audit(moved.graph, scan, texts, Date.now(), new Set(moved.changed.map(spotKey)))
    if (moved.moved.length) found.moved = moved.moved
    transaction(root, { 'audit.json': found, 'scan.json': scan, 'anchors.json': { v: 1, spots: anchors } })
    return found
  })
}
function verified(root, graph) {
  const problems = []
  const keep = refs => refs?.filter(s => {
    try {
      const p = projectPath(root, s.path)
      if (!fs.existsSync(p)) throw new Error('不存在')
      const text = textOf(root, graph, s.path)
      if (text !== null && s.line && s.line > text.split(/\r?\n/).length) throw new Error('行号超出文件')
      return true
    } catch { problems.push(`${s.path} 的依据无效，已移除`); return false }
  })
  const clean = x => ({ ...x, sources: keep(x.sources) })
  return { graph: { ...graph, nodes: graph.nodes.map(clean), edges: graph.edges.map(clean) }, problems }
}
function version(root) {
  try {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { revision: git(['rev-parse', 'HEAD']), dirty: git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean) }
  } catch { return {} }
}
export function saveProjectGraph(root, raw) {
  return withProjectLock(root, () => {
    const { graph: prev } = load(root)
    const checked = check(raw)
    if ('error' in checked) throw new Error(checked.error)
    protectNewData(prev, checked.graph)
    if (reopened(prev, checked.graph).length) throw new Error('不能解除敏感数据保护、去掉敏感模块或移除其文件')
    const proposed = prev ? carryOver(prev, checked.graph) : checked.graph
    const ok = check(proposed); if ('error' in ok) throw new Error(ok.error)
    const v = verified(root, ok.graph)
    const next = { ...v.graph, drawnAt: Date.now(), ...version(root) }
    const missing = next.nodes.flatMap(n => n.files.filter(f => { try { return !fs.existsSync(projectPath(root, f)) } catch { return true } }).map(f => `${n.id}: ${f}`)).slice(0, 20)
    const notes = [...checked.warnings, ...v.problems, ...missing.map(f => `文件找不到：${f}`)]
    const pending = readJson(root, PENDING)
    if (prev && isStructural(diffGraphs(prev, next))) {
      writeJson(root, PENDING, { graph: next, at: Date.now(), lines: changeLines(diffGraphs(prev, next), prev, next) })
      return ['结构变化已交给用户在画布上确认，当前图保持原样。', ...notes].join('\n')
    }
    if (pending?.graph && prev) writeJson(root, PENDING, { ...pending, graph: carryWords(pending.graph, prev, next, checked.graph.flows) })
    saveGraph(root, next)
    const found = auditProject(root, next, citedSpots(next))
    return [`已保存架构图（${describe(next)}）到 .archcanvas/graph.json。`, ...notes, auditSummary(found)].join('\n')
  })
}
export function updateProjectGraph(root, patch) {
  return withProjectLock(root, () => {
    const graph = requireGraph(root)
    protectNewData(graph, { nodes: (patch.add_nodes ?? []).map(n => ({ ...n, files: n.files ?? [] })) })
    if ((patch.change_nodes ?? []).some(n => n.sensitive === false && graph.nodes.some(old => old.id === n.id && isSensitive(old)))) return '拒绝解除敏感数据保护；只能由用户在画布上修改。'
    const out = applyPatch(graph, patch, f => { try { return fs.existsSync(projectPath(root, f)) } catch { return true } }, Date.now())
    if ('error' in out) throw new Error(out.error)
    protectNewData(graph, out.graph)
    if (reopened(graph, out.graph).length) throw new Error('不能解除敏感数据保护')
    const v = verified(root, out.graph)
    const pending = readJson(root, PENDING)
    if (pending?.graph) {
      const waiting = applyPatch(pending.graph, patch, f => { try { return fs.existsSync(projectPath(root, f)) } catch { return true } }, Date.now())
      if ('error' in waiting || reopened(graph, waiting.graph).length) throw new Error('当前有待确认新图，局部更新无法同步，请先采用或保留当前图')
      writeJson(root, PENDING, { ...pending, graph: waiting.graph })
    }
    saveGraph(root, { ...v.graph, drawnAt: Date.now(), ...version(root) })
    auditProject(root, v.graph, citedSpots(v.graph))
    return [...out.said, ...out.refused, ...v.problems, '架构图局部更新已保存。'].join('\n')
  })
}
function queueRequest(root, text) {
  const list = readJson(root, '.archcanvas/requests.json') ?? []
  writeJson(root, '.archcanvas/requests.json', [...list, { text, at: Date.now() }].slice(-30))
  return { notice: '请求已记录。回到 Codex 发下一条消息时会附带此请求；也可以直接粘贴相关指令。', level: 'info' }
}
export function canvasAction(root, action) {
  return withProjectLock(root, () => {
    const { graph, tasks, checks, worklog } = load(root)
    const now = Date.now()
    if (action.type === 'accept-next' || action.type === 'reject-next') {
      const pending = readJson(root, PENDING)
      if (!pending?.graph) return { notice: '没有等待确认的新图。', level: 'info' }
      if (action.type === 'accept-next') {
        const next = graph ? carryOver(graph, pending.graph) : pending.graph
        if (reopened(graph, next).length) throw new Error('新图会解除敏感保护，请重新生成')
        const checked = check(next); if ('error' in checked) throw new Error(checked.error)
        transaction(root, { 'graph.json': checked.graph, 'pending.json': null })
        auditProject(root, checked.graph)
      } else writeJson(root, PENDING, null)
      return { notice: action.type === 'accept-next' ? '已采用新图。' : '已保留当前图。', level: 'info' }
    }
    if (action.type === 'audit') return { notice: auditSummary(auditProject(root)), level: 'info' }
    if (action.type === 'audit-fix') return queueRequest(root, auditPrompt(auditProject(root), graph).replace(/Claude/g, 'Codex'))
    if (action.type === 'work-note' || action.type === 'work-mark') {
      if (!worklog.some(e => e.id === action.entryId)) throw new Error('找不到工作记录')
      writeJson(root, '.archcanvas/worklog.json', action.type === 'work-note' ? setNote(worklog, action.entryId, String(action.text ?? '')) : setMark(worklog, action.entryId, ['important', 'void'].includes(action.mark) ? action.mark : null))
      return { notice: '工作记录已更新。', level: 'info' }
    }
    if (action.type === 'mask-set') {
      const was = cleanMask(readJson(root, '.archcanvas/mask.json'))
      const formats = Array.isArray(action.formats) ? action.formats : was.formats
      for (const f of formats) { const result = formatPattern(String(f.example ?? '')); if ('error' in result) throw new Error(result.error) }
      writeJson(root, '.archcanvas/mask.json', cleanMask({ ...was, ...action, formats }))
      return { notice: '打码设置已保存。Codex 钩子无法替换命令原始输出；仅记录内容使用过滤。', level: 'info' }
    }
    if (action.type === 'clear-outputs') {
      const paths = Array.isArray(action.paths) ? action.paths : []
      for (const rel of paths) {
        if (typeof rel !== 'string' || !rel.endsWith('.ipynb')) throw new Error('只允许清理项目内 Notebook 输出')
        const file = projectPath(root, rel)
        const result = clearOutputs(fs.readFileSync(file, 'utf8'))
        if ('error' in result) throw new Error(result.error)
        fs.writeFileSync(file, result.text)
      }
      return { notice: `已清理 ${paths.length} 个 Notebook 的输出。`, level: 'info' }
    }
    if (action.type === 'add-found-edge') {
      const result = drawTie(graph, readJson(root, '.archcanvas/audit.json'), String(action.from), String(action.to))
      if ('error' in result) throw new Error(result.error)
      saveGraph(root, result.graph); auditProject(root, result.graph)
      return { notice: result.text, level: 'info' }
    }
    const out = String(action.type).startsWith('check-') ? applyCheckAction(action, checks, graph, tasks, now, 'Codex') : applyAction(action, graph, tasks, now, 'Codex')
    const changes = {}
    if (out.tasks) changes['tasks.json'] = out.tasks
    if (out.checks) changes['checks.json'] = out.checks
    if (out.graph) changes['graph.json'] = out.graph
    if (Object.keys(changes).length) transaction(root, changes)
    if (out.graph) {
      saveHistory(root, load(root).history)
      scrubSnapshots(root)
      auditProject(root, out.graph)
    }
    if (action.type === 'cancel') dropSnapshot(root, String(action.taskId))
    if (out.generate) return queueRequest(root, '先读代码，用 save_graph 生成架构图，带模块类型、代码依据和执行主线。数据只看目录，不读内容。')
    if (out.flows) return queueRequest(root, '请读架构图和代码，用 update_graph 补齐或更新 flows，每条主线 5–15 步。')
    if (out.evidence) return queueRequest(root, '请核对源代码，用 update_graph 为模块和连线补齐真实文件与行号依据。')
    if (out.recheck) return queueRequest(root, `请核对并更新这些模块：${out.recheck.join('、')}。`)
    if (out.handover) return { ...out, notice: '待办已交付。回到 Codex 粘贴指令或发送下一条消息，Codex 才能开始处理。' }
    return out
  })
}
