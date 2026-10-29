// Project-local source checkpoints. Unknown or unreadable files are never
// interpreted as deletions; privacy is checked again when producing a diff.
import fs from 'node:fs'
import path from 'node:path'
import { diffLines } from '../lib/history.mjs'
import { sensitiveOwner, DATA_FILE } from '../lib/nodetypes.mjs'
import { load } from './store.mjs'
import { projectPath } from './paths.mjs'

const SKIP = new Set(['.git', '.archcanvas', '.tmp', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.next'])
const SOURCE = /\.(py|pyi|r|js|mjs|cjs|ts|tsx|jsx|vue|svelte|go|rs|c|h|cpp|cs|java|rb|php|sql|sh|ps1|bat|cmd|html|css|md|rst|txt|toml|yaml|yml|ini|cfg|json|xml)$/i
const fileFor = (root, id) => projectPath(root, `.archcanvas/snapshots/${encodeURIComponent(id)}.json`)
const wasSkipped = (snapshot, rel) => (snapshot.skipped ?? []).some(p => p === '' || rel === p || rel.startsWith(`${p}/`))
export function sources(root) {
  const graph = load(root).graph
  const files = {}; const skipped = []
  function visit(rel, depth = 0) {
    if (depth > 16 || Object.keys(files).length >= 3000) { skipped.push(rel); return }
    let entries
    try { entries = fs.readdirSync(projectPath(root, rel), { withFileTypes: true }) } catch { skipped.push(rel); return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink() || (graph && sensitiveOwner(graph, r))) continue
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) visit(r, depth + 1) }
      else if (e.isFile() && SOURCE.test(r) && !DATA_FILE.test(r)) {
        if (Object.keys(files).length >= 3000) { skipped.push(r); continue }
        try {
          const file = projectPath(root, r)
          if (fs.statSync(file).size > 512 * 1024) { skipped.push(r); continue }
          const buf = fs.readFileSync(file)
          if (buf.subarray(0, 8000).includes(0)) { skipped.push(r); continue }
          files[r] = buf.toString('utf8')
        } catch { skipped.push(r) }
      }
    }
  }
  visit('')
  return { files, skipped }
}
export function takeSnapshot(root, id) {
  const file = fileFor(root, id)
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(sources(root)))
  return true
}
export function changesSince(root, id) {
  const file = fileFor(root, id)
  if (!fs.existsSync(file)) return null
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const now = sources(root)
  const before = saved.files
  const after = now.files
  const graph = load(root).graph
  const out = []
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (graph && sensitiveOwner(graph, rel)) continue
    let target
    try { target = projectPath(root, rel) } catch { continue }
    if (!(rel in after) && (wasSkipped(now, rel) || fs.existsSync(target))) continue
    // Missing content in a partial baseline is unknown, not an empty file.
    // A readable checkpoint can override a still-skipped parent directory.
    if (!(rel in before) && wasSkipped(saved, rel)) {
      out.push({ file: rel, added: 0, removed: 0, diff: '（旧快照未保存此文件内容，无法比较；新增和删除行数未统计）' })
      continue
    }
    const a = before[rel] ?? ''; const b = after[rel] ?? ''
    if (a !== b) out.push({ file: rel, ...diffLines(a, b), ...(!(rel in after) ? { diff: '（删除了这个文件）' } : {}) })
  }
  return out
}
export function checkpoint(root, id, changes) {
  const file = fileFor(root, id)
  if (!fs.existsSync(file)) return
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const now = sources(root)
  const skipped = new Set(saved.skipped ?? [])
  for (const c of changes) {
    const rel = path.relative(root, path.resolve(root, c.file)).replace(/\\/g, '/')
    projectPath(root, rel)
    if (rel in now.files) {
      saved.files[rel] = now.files[rel]
      skipped.delete(rel)
    } else {
      delete saved.files[rel]
      if (wasSkipped(now, rel)) skipped.add(rel)
      else skipped.delete(rel)
    }
  }
  saved.skipped = [...skipped]
  fs.writeFileSync(file, JSON.stringify(saved))
}
export function dropSnapshot(root, id) { fs.rmSync(fileFor(root, id), { force: true }) }
export function scrubSnapshots(root) {
  const dir = projectPath(root, '.archcanvas/snapshots')
  if (!fs.existsSync(dir)) return
  const graph = load(root).graph
  for (const f of fs.readdirSync(dir)) {
    const file = projectPath(root, `.archcanvas/snapshots/${f}`)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const rel of Object.keys(saved.files)) if (graph && sensitiveOwner(graph, rel)) delete saved.files[rel]
    fs.writeFileSync(file, JSON.stringify(saved))
  }
}
