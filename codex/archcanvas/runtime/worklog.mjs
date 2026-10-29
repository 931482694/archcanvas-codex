import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { begin, newEntry, openEntry, addRun, addEdit, addResult, trimLog, changedBetween, sortOutputs, outsideEntry, sealKeys, outputPlaces, OUTPUT_DIRS, versionOf } from '../lib/worklog.mjs'
import { cleanMask, maskText } from '../lib/mask.mjs'
import { load, readJson, writeJson, transaction, withProjectLock } from './store.mjs'
import { projectPath } from './paths.mjs'
import { sensitiveOwner } from '../lib/nodetypes.mjs'

// Shared project context is an observation, never the caller's identity.
export const sessionOf = (root, given) => given || process.env.CODEX_THREAD_ID || `mcp-${process.pid}`
export function codeVersion(root) {
  try {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return versionOf(git(['status', '--porcelain=v2', '--branch', '-z', '--', '.']), git(['rev-parse', '--show-prefix']).trim())
  } catch { return undefined }
}
const clean = (root, text) => maskText(String(text), cleanMask(readJson(root, '.archcanvas/mask.json'))).text
export function saveLog(root, log) {
  const trimmed = trimLog(log)
  const writes = { 'worklog.json': trimmed.log }
  for (const [month, entries] of Object.entries(trimmed.moved)) {
    const previous = readJson(root, `.archcanvas/worklog/${month}.json`) ?? []
    writes[`worklog/${month}.json`] = [...previous, ...entries.filter(e => !previous.some(p => p.id === e.id))]
  }
  transaction(root, writes)
}
export function ensureEntry(root, session, request = '本轮操作', turn = '') {
  const { worklog } = load(root)
  const old = openEntry(worklog, session)
  if (old) return old.id
  const id = turn || `w-${crypto.randomUUID()}`
  saveLog(root, begin(worklog, newEntry(id, session, Date.now(), clean(root, request), 'chat')))
  return id
}
// Only file size/time metadata; no result contents are read. Limits are
// recorded so a partial scan cannot turn unvisited files into deletions.
export function lookNow(root, graph) {
  const scan = readJson(root, '.archcanvas/scan.json') ?? { refs: [] }
  const present = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && OUTPUT_DIRS.includes(e.name.toLowerCase())).map(e => e.name)
  const places = outputPlaces(graph, scan, present)
  const snap = {}; let dirs = 0; let count = 0; let partial = false
  const visit = (rel, depth) => {
    rel = rel.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
    if (dirs++ >= 150 || count >= 2000 || depth > 12) { partial = true; return }
    let file
    try { file = projectPath(root, rel) } catch { partial = true; return }
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (!st) return
    if (st.isFile()) { snap[rel] = { size: st.size, mtimeMs: st.mtimeMs }; count++; return }
    for (const e of fs.readdirSync(file, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      visit(`${rel}/${e.name}`.replace(/^\//, ''), depth + 1)
    }
  }
  for (const p of places) { try { visit(p, 0) } catch { partial = true } }
  return { at: Date.now(), places, snap: sealKeys(snap, graph, places), ...(partial ? { partial: true } : {}) }
}
export function beginPrompt(root, input) {
  const session = input.session_id || 'unknown'
  const old = load(root).worklog
  const id = input.turn_id || `w-${crypto.randomUUID()}`
  if (old.some(e => e.id === id)) return id
  const graph = load(root).graph
  const now = lookNow(root, graph)
  const before = readJson(root, '.archcanvas/look.json')
  let log = old
  if (before && !before.partial && !now.partial) {
    const samePlaces = JSON.stringify(before.places) === JSON.stringify(now.places)
    const changes = changedBetween(before.snap, now.snap)
    if (samePlaces && changes.length) log = [...log, outsideEntry(`outside-${crypto.randomUUID()}`, session, before.at, now.at, sortOutputs(changes, graph))]
  }
  saveLog(root, begin(log, newEntry(id, session, Date.now(), clean(root, input.prompt || ''), 'chat')))
  writeJson(root, '.archcanvas/look.json', now)
  writeJson(root, '.archcanvas/context.json', { sessionId: session, turnId: id })
  return id
}
export function recordEdits(root, input, changes) {
  const session = sessionOf(root, input.session_id)
  const id = ensureEntry(root, session)
  let log = load(root).worklog
  const { graph } = load(root)
  for (const c of changes) {
    const rel = path.relative(root, path.resolve(root, c.file)).replace(/\\/g, '/')
    if (rel.startsWith('../') || rel.startsWith('.archcanvas/')) continue
    const ids = graph.nodes.filter(n => n.files.some(f => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/'))).map(n => n.id)
    log = addEdit(log, id, { file: rel, added: c.added, removed: c.removed, nodeIds: ids })
  }
  saveLog(root, log)
}
export function recordRun(root, input, run) {
  const session = sessionOf(root, input.session_id)
  const existing = load(root).worklog.find(e => e.session === session && e.runs.some(r => r.id === run.id))
  const id = existing?.id ?? ensureEntry(root, session)
  const { graph, worklog } = load(root)
  const oldRun = existing?.runs.find(r => r.id === run.id)
  if (oldRun?.finishedAt) return
  if (oldRun) run = { ...oldRun, ...run }
  const before = readJson(root, '.archcanvas/look.json')
  const now = lookNow(root, graph)
  const changes = before && !before.partial && !now.partial ? changedBetween(before.snap, now.snap) : []
  const withoutOld = oldRun ? worklog.map(e => e.id === id ? { ...e, runs: e.runs.filter(r => r.id !== run.id) } : e) : worklog
  saveLog(root, addRun(withoutOld, id, run, sortOutputs(changes, graph, run.id)))
  writeJson(root, '.archcanvas/look.json', now)
}
export function recordResult(root, args) {
  return withProjectLock(root, () => {
    if (!String(args.summary ?? '').trim()) throw new Error('summary 必须写明结果')
    const { graph } = load(root)
    const session = sessionOf(root, args.session_id)
    const id = ensureEntry(root, session)
    const files = (args.files ?? []).filter(f => { projectPath(root, f); return !graph || !sensitiveOwner(graph, f) })
    saveLog(root, addResult(load(root).worklog, id, clean(root, args.summary), files, Date.now()))
    return '已把结论记入工作记录（仅汇总结果）。'
  })
}
