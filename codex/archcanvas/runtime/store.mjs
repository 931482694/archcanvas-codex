import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { check } from '../lib/graph.mjs'
import { nodesForFile, trimHistory } from '../lib/history.mjs'
import { sensitiveOwner } from '../lib/nodetypes.mjs'
import { projectPath, relativePath } from './paths.mjs'

export const DATA_DIR = '.archcanvas'
const held = new Set()
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const metaPath = (root, rel) => projectPath(root, `${DATA_DIR}/${rel}`)
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (err) { return err.code !== 'ESRCH' }
}
function reapAbandoned(dir) {
  // Only one contender may reap. Recheck after claiming the marker, since
  // the old directory could have been replaced while this process waited.
  const marker = path.join(dir, 'reaping')
  try { fs.mkdirSync(marker) } catch { return false }
  try {
    let owner
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) } catch { /* interrupted acquisition */ }
    if (owner && ownerAlive(owner.pid)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } finally { fs.rmSync(marker, { recursive: true, force: true }) }
}
export function readJson(root, rel) {
  const file = projectPath(root, rel)
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
  try { return JSON.parse(text) } catch { throw new Error(`${rel} 不是有效 JSON，保留原文件，未写入。`) }
}
function atomic(root, rel, value) {
  const file = projectPath(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  // Windows antivirus/indexers may briefly hold the target open. Keep the
  // old file intact while retrying the atomic replace; never unlink first.
  const started = Date.now()
  for (;;) {
    try { fs.renameSync(tmp, file); break } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || Date.now() - started >= 2000) throw err
      Atomics.wait(sleeper, 0, 0, 20)
    }
  }
}
function recover(root) {
  const journal = readJson(root, '.archcanvas/transaction.json')
  if (!journal) return
  if (typeof journal !== 'object' || Array.isArray(journal)) throw new Error('事务日志格式不合法，保留原文件')
  for (const name of Object.keys(journal)) {
    if (!/^(graph|tasks|history|checks|pending|worklog|look|mask|audit|scan|anchors|requests)\.json$|^worklog\/[0-9]{4}-[0-9]{2}\.json$|^snapshots\/[A-Za-z0-9%_.-]+\.json$/.test(name)) throw new Error('事务日志路径不合法，保留原文件')
    projectPath(root, `.archcanvas/${name}`)
  }
  for (const [name, value] of Object.entries(journal)) {
    atomic(root, `.archcanvas/${name}`, value)
  }
  fs.unlinkSync(metaPath(root, 'transaction.json'))
}
export function withProjectLock(root, fn) {
  root = fs.realpathSync(root)
  if (held.has(root)) return fn()
  const dir = metaPath(root, 'lock')
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const started = Date.now()
  for (;;) {
    try { fs.mkdirSync(dir); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
        if (!ownerAlive(owner.pid) && reapAbandoned(dir)) continue
      } catch {
        const stat = fs.statSync(dir, { throwIfNoEntry: false })
        if (!stat) continue
        if (Date.now() - stat.mtimeMs > 30000 && reapAbandoned(dir)) continue
      }
      if (Date.now() - started > 10000) throw new Error('项目记录正在被另一个进程更新，请稍后重试')
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }))
  held.add(root)
  try { recover(root); return fn() } finally { held.delete(root); fs.rmSync(dir, { recursive: true, force: true }) }
}
export function transaction(root, files) {
  return withProjectLock(root, () => {
    files = { ...files }
    if (files['graph.json']) {
      const graph = files['graph.json']
      const history = files['history.json'] ?? readJson(root, '.archcanvas/history.json')
      if (history !== undefined) {
        if (!Array.isArray(history)) throw new Error('history.json 格式不正确，保留原文件')
        files['history.json'] = history.map(c => sensitiveOwner(graph, c.file) ? { ...c, diff: '（敏感内容未记录）' } : c)
      }
      const dir = metaPath(root, 'snapshots')
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
        const snapshot = readJson(root, `.archcanvas/snapshots/${name}`)
        if (!snapshot?.files || typeof snapshot.files !== 'object') throw new Error('快照损坏，保留原文件')
        const kept = Object.fromEntries(Object.entries(snapshot.files).filter(([rel]) => !sensitiveOwner(graph, rel)))
        files[`snapshots/${name}`] = { ...snapshot, files: kept }
      }
    }
    atomic(root, '.archcanvas/transaction.json', files)
    recover(root)
  })
}
export function writeJson(root, rel, value) {
  return withProjectLock(root, () => atomic(root, rel, value))
}
const array = (root, file) => {
  const value = readJson(root, `.archcanvas/${file}`)
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${file} 格式不正确，保留原文件，未写入。`)
  return value
}
export function load(root) {
  return withProjectLock(root, () => {
    const raw = readJson(root, '.archcanvas/graph.json')
    const checked = raw === undefined ? null : check(raw)
    if (checked && 'error' in checked) throw new Error(`graph.json: ${checked.error}`)
    const graph = checked?.graph ?? null
    const history = array(root, 'history.json').map(c => graph && sensitiveOwner(graph, c.file) ? { ...c, diff: '（敏感内容未记录）' } : c)
    return { graph, tasks: array(root, 'tasks.json'), history, checks: array(root, 'checks.json'), worklog: array(root, 'worklog.json'), problem: null }
  })
}
export const saveGraph = (root, graph) => transaction(root, { 'graph.json': graph })
export const saveTasks = (root, tasks) => writeJson(root, '.archcanvas/tasks.json', tasks)
export const saveHistory = (root, history) => writeJson(root, '.archcanvas/history.json', trimHistory(history))
export function record(root, changes, meta = {}) {
  return withProjectLock(root, () => {
    const { graph, tasks, history } = load(root)
    if (!graph || !changes.length) return meta.preview ? { history, count: 0 } : 0
    const working = tasks.find(t => t.status === 'working' && (!t.sessionId || t.sessionId === meta.sessionId))
    const kept = []
    for (const c of changes) {
      let rel
      try { rel = relativePath(root, c.file) } catch { continue }
      if (!rel || rel.startsWith('.archcanvas/')) continue
      if (meta.toolUseId && history.some(h => h.toolUseId === meta.toolUseId && h.file === rel)) continue
      const ids = new Set(nodesForFile(graph, rel))
      if (working) for (const id of [...working.nodeIds, ...(working.node ? [working.node.id] : [])]) ids.add(id)
      if (!ids.size) continue
      const at = meta.at ?? Date.now()
      kept.push({ id: `c-${at.toString(36)}-${crypto.randomUUID().slice(0, 8)}`, at, file: rel, tool: meta.tool || 'Codex', toolUseId: meta.toolUseId || '', sessionId: meta.sessionId || '', nodeIds: [...ids], ...(working ? { taskId: working.id } : {}), added: c.added, removed: c.removed, diff: sensitiveOwner(graph, rel) ? '（敏感内容未记录）' : c.diff, ...(meta.transcript ? { transcript: meta.transcript } : {}) })
    }
    if (meta.preview) return { history: trimHistory([...history, ...kept]), count: kept.length }
    if (kept.length) saveHistory(root, [...history, ...kept])
    return kept.length
  })
}
