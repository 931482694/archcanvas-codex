// The archcanvas canvas: a page on 127.0.0.1 that draws one project's graph full
// size, for this machine only. It reads .archcanvas/*.json itself and pushes a
// "change" to the page whenever one of them changes; every change the page
// asks for goes to the archcanvas mod as an "@@ACTION <json>" line on stdout, so
// the tasks are still written by the mod alone. Only layout.json (where the
// person dragged nodes, which layers are folded) is written here, and, in the
// person's home folder, how they like the canvas to look.
//
//   node canvas-server.mjs <project root> [session id]
//
// Prints "@@READY {port, token}" once listening. The page is reached through
// /open?k=<token>, which sets a same-site cookie; the mod posts notices with
// the token in a header.

import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const root = process.argv[2]
const sessionId = process.argv[3] || ''
if (!root) {
  process.stderr.write('usage: node canvas-server.mjs <project root> [session id]\n')
  process.exit(2)
}

const DATA = path.join(root, '.archcanvas')
const FILES = { graph: 'graph.json', tasks: 'tasks.json', history: 'history.json', layout: 'layout.json', checks: 'checks.json', pending: 'pending.json', audit: 'audit.json', worklog: 'worklog.json', mask: 'mask.json' }
const STATIC = {
  '/': ['canvas.html', 'text/html; charset=utf-8'],
  '/canvas.js': ['canvas.js', 'text/javascript; charset=utf-8'],
  '/canvas.css': ['canvas.css', 'text/css; charset=utf-8'],
}
const ACTIONS = new Set(['comment', 'add-node', 'remove-node', 'add-edge', 'remove-edge', 'cancel', 'handover', 'generate', 'assign-file', 'unassign-file', 'check-pass', 'check-fail', 'check-dismiss', 'check-reopen', 'set-sensitive', 'edit-add-node', 'add-layer', 'rename-layer', 'remove-layer', 'move-node', 'set-edge-kind', 'vouch-edge', 'evidence', 'recheck', 'mark-seen', 'accept-next', 'reject-next', 'audit', 'audit-fix', 'add-found-edge', 'confirm-sensitive', 'clear-outputs', 'flows', 'flow-comment', 'work-note', 'work-mark', 'mask-set'])
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

// Which agent started this server and how the page speaks of it. The Claude
// Code mod sets none of these; another agent's adapter sets them: its name,
// how to reopen the canvas there, the instructions the page copies for a
// handover (where the agent takes no message from a plugin), and whether
// files changed on disk light up (where no hook reports each read and write).
const AGENT = process.env.ARCHCANVAS_AGENT || 'Claude'
const REOPEN = process.env.ARCHCANVAS_REOPEN || `回到 ${AGENT}，输入 /archcanvas 重新打开（每次启动链接都会变）。`
let HANDOFF = null
try {
  HANDOFF = process.env.ARCHCANVAS_HANDOFF ? JSON.parse(process.env.ARCHCANVAS_HANDOFF) : null
} catch {
  HANDOFF = null
}
const WATCH_ACTIVITY = process.env.ARCHCANVAS_WATCH_ACTIVITY === '1'
const MAX_BODY = 64 * 1024

// How the person likes the canvas to look (wallpaper, colours), the same for
// every project: kept in their home folder, never in the project.
const LOOK = process.env.ARCHCANVAS_HOME || path.join(os.homedir(), '.archcanvas')
const LOOK_FILE = path.join(LOOK, 'style.json')
const MAX_IMAGE = 6 * 1024 * 1024
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const WALLS = new Set(['dots', 'grid', 'plain', 'dusk', 'forest', 'ember', 'paper', 'sky', 'image'])
const HEX = /^#[0-9a-f]{6}$/i
const token = crypto.randomBytes(24).toString('hex')
let port = 0
let cookie = ''

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

function same(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function cookies(header) {
  const out = {}
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

// Another site in the person's browser must not reach this: the Host header
// must be ours (no DNS rebinding), and the cookie or the mod's header must match.
const hostOk = req => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`
const originOk = req => !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}` || req.headers.origin === `http://localhost:${port}`
const authed = req => same(cookies(req.headers.cookie)[cookie], token) || same(req.headers['x-archcanvas-token'], token)

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  })
  res.end(body)
}

const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))

function refuse(res, status, why) {
  send(
    res,
    status,
    'text/html; charset=utf-8',
    `<!doctype html><meta charset="utf-8"><title>架构画布</title><body style="font:15px system-ui;padding:40px;background:#1f1e1d;color:#e8e6e1"><h2>打不开架构画布</h2><p>${why}</p><p>${REOPEN}</p>`,
    { 'Content-Security-Policy': CSP },
  )
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > max) {
        reject(new Error('发来的内容太大了。'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('发来的内容格式不对，刷新画布后再试。'))
      }
    })
    req.on('error', reject)
  })
}

// Why a file could not be read or written, in words.
function fsWhy(err) {
  const code = err && err.code
  if (code === 'ENOENT') return '文件不存在（可能刚被删掉或改名）'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限访问这个文件'
  if (code === 'EBUSY') return '文件正被别的程序占用'
  if (code === 'ENOSPC') return '磁盘空间不够了'
  if (err instanceof SyntaxError) return '内容不是有效的 JSON，可能被改坏了'
  return code ? `出了意外（${code}）` : '出了意外'
}

function readData(name) {
  try {
    return { value: JSON.parse(fs.readFileSync(path.join(DATA, FILES[name]), 'utf8')) }
  } catch (err) {
    return err.code === 'ENOENT' ? { value: undefined } : { error: `.archcanvas/${FILES[name]} 读不了：${fsWhy(err)}。` }
  }
}

function state() {
  const out = { project: path.basename(root), sessionId, agent: AGENT, reopen: REOPEN, handoff: HANDOFF, capabilities: { outputMasking: AGENT !== 'Codex', readGuard: AGENT === 'Codex' ? 'trusted-hooks' : 'native' }, errors: [] }
  for (const name of Object.keys(FILES)) {
    const r = readData(name)
    if (r.error) out.errors.push(r.error)
    out[name] = r.value ?? null
  }
  return out
}

// Where the person put things: positions by node id, folded layers, opened cards.
// Version 2: frames (where each layer sits) and module positions inside
// their frame. Version 1 had only positions, on the whole canvas.
function cleanLayout(raw) {
  const out = { v: 2, frames: {}, positions: {}, colors: {}, collapsed: [], expanded: [] }
  if (!raw || typeof raw !== 'object') return out
  const id = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)
  for (const key of ['frames', 'positions']) {
    for (const [k, v] of Object.entries(raw[key] || {})) {
      // A spot the canvas pinned itself says which group it was in.
      if (id(k) && v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[key][k] = { x: Math.round(v.x), y: Math.round(v.y), ...(key === 'positions' && id(v.layer) ? { layer: v.layer } : {}) }
    }
  }
  // Where the person last looked: pan and zoom.
  const w = raw.view
  if (w && Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.k) && w.k >= 0.05 && w.k <= 8) out.view = { x: Math.round(w.x), y: Math.round(w.y), k: Math.round(w.k * 1000) / 1000 }
  // How far a selected module's reach is lit: all the way, when the person picked that.
  if (raw.reach === 'all') out.reach = 'all'
  for (const key of ['collapsed', 'expanded']) {
    if (Array.isArray(raw[key])) out[key] = raw[key].filter(id).slice(0, 200)
  }
  for (const [k, v] of Object.entries(raw.colors || {})) if (id(k) && typeof v === 'string' && HEX.test(v)) out.colors[k] = v.toLowerCase()
  return out
}

function writeLayout(layout) {
  fs.mkdirSync(DATA, { recursive: true })
  const file = path.join(DATA, FILES.layout)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(layout, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// ---- how the canvas looks ----

function cleanStyle(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  if (WALLS.has(raw.wall)) out.wall = raw.wall
  for (const k of ['wallColor', 'frameColor', 'cardColor', 'textColor']) if (typeof raw[k] === 'string' && HEX.test(raw[k])) out[k] = raw[k].toLowerCase()
  for (const k of ['wallDim', 'frameAlpha', 'cardAlpha', 'textAlpha', 'edgeAlpha']) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = Math.round(Math.min(1, Math.max(0, raw[k])) * 100) / 100
  }
  // Which side bars and the legend the person folded.
  for (const k of ['filesClosed', 'panelClosed', 'legendMini']) if (typeof raw[k] === 'boolean') out[k] = raw[k]
  return out
}

function wallpaperFile() {
  for (const ext of Object.keys(IMAGE_TYPES)) {
    const file = path.join(LOOK, `wallpaper.${ext}`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// The settings, and when the wallpaper image last changed (0: there is none).
function readStyle() {
  let style = {}
  try {
    style = cleanStyle(JSON.parse(fs.readFileSync(LOOK_FILE, 'utf8')))
  } catch {}
  const image = wallpaperFile()
  return { ...style, wallpaper: image ? Math.round(fs.statSync(image).mtimeMs) : 0 }
}

function writeLook(name, data) {
  fs.mkdirSync(LOOK, { recursive: true })
  const file = path.join(LOOK, name)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// An image the person picked, as a data URL the page made smaller first.
function saveWallpaper(body) {
  for (const ext of Object.keys(IMAGE_TYPES)) fs.rmSync(path.join(LOOK, `wallpaper.${ext}`), { force: true })
  if (body.remove) return
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.data === 'string' ? body.data : '')
  if (!m) throw new Error('只能用 PNG、JPG 或 WebP 图片。')
  const bytes = Buffer.from(m[2], 'base64')
  if (bytes.length > MAX_IMAGE) throw new Error('图片太大了（最多 6 MB）。')
  writeLook(`wallpaper.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, bytes)
}

// ---- the conversation behind a change ----
// The desktop app lets no mod scroll its transcript, so the page shows the
// exchange itself, read from the session's transcript file on this machine:
// what the person asked, what Claude said just before the edit, how it went.

const TAGS = /<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

function transcriptOf(session) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) return null
  const projects = path.join(CONFIG, 'projects')
  const guess = path.join(projects, root.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)
  if (fs.existsSync(guess)) return guess
  try {
    for (const dir of fs.readdirSync(projects)) {
      const file = path.join(projects, dir, `${session}.jsonl`)
      if (fs.existsSync(file)) return file
    }
  } catch {
    // No projects folder: nothing to find.
  }
  return null
}

// Codex keeps each session as ~/.codex/sessions/.../rollout-*.jsonl, in order:
// the person's messages, Codex's messages, its tool calls and their outputs.
// A change recorded by the Codex hook carries that file's path; only files
// under Codex's own folder are read.
const CODEX_WRAPPERS = /^\s*<(environment_context|user_instructions|permissions|turn_aborted|user_shell_command)/

function codexConversation(change) {
  let file
  let base
  try {
    file = fs.realpathSync(String(change.transcript))
    base = fs.realpathSync(CODEX_HOME)
  } catch {
    return { error: '找不到这次修改所在会话的记录（会话可能已经被清理）。' }
  }
  if (!file.toLowerCase().startsWith(base.toLowerCase() + path.sep) || !file.endsWith('.jsonl')) return { error: '这次修改的会话记录不在 Codex 的目录里，不读取。' }

  const when = Number(change.at) || 0
  let prompt = null
  let said = []
  let found = null
  let lastBefore = null
  let result = null
  const textIn = content => (Array.isArray(content) ? content.map(c => c.text || '').join('\n') : String(content || ''))
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const p = e.payload || {}
    if (found) {
      // The call's output, once the call is known.
      if (/_output$/.test(p.type || '') && p.call_id === found.callId && !result) {
        const out =
          typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? p.output.map(o => o.text || '').join('\n') : JSON.stringify(p.output ?? '')
        result = { isError: /^(error|failed|apply_patch verification failed)/i.test(out.trim()), text: clip(out.trim(), 300) }
      }
      continue
    }
    if (e.type === 'response_item' && p.type === 'message') {
      const t = textIn(p.content).trim()
      if (!t) continue
      if (p.role === 'user' && !CODEX_WRAPPERS.test(t)) {
        prompt = { text: clip(t, 1500), at: e.timestamp, viaCanvas: false }
        said = []
      } else if (p.role === 'assistant') {
        said.push({ text: clip(t, 800), at: e.timestamp })
        if (said.length > 3) said.shift()
      }
    } else if (e.type === 'response_item' && /tool_call$|function_call$/.test(p.type || '')) {
      const snapshot = { callId: p.call_id, at: e.timestamp, prompt, said: [...said] }
      if (p.call_id && p.call_id === change.toolUseId) found = snapshot
      // A patch applied from inside another call has no line of its own: the
      // last call made before the change was recorded stands in for it.
      else if (Date.parse(e.timestamp) <= when + 2000) lastBefore = snapshot
    }
  }
  const hit = found || lastBefore
  if (!hit) return { error: '会话记录里找不到这次修改。' }
  return { prompt: hit.prompt, said: hit.said, result, at: hit.at, otherSession: change.sessionId !== sessionId }
}

function conversation(changeId) {
  const history = readData('history').value
  const change = Array.isArray(history) ? history.find(c => c && c.id === changeId) : undefined
  if (change && change.transcript) return codexConversation(change)
  if (!change || typeof change.toolUseId !== 'string' || !change.toolUseId) return { error: '找不到这次修改。' }
  const file = transcriptOf(String(change.sessionId || ''))
  if (!file) return { error: '找不到这次修改所在会话的记录（会话可能已经被清理）。' }

  const byUuid = new Map()
  let hit = null
  let result = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e.uuid || e.isSidechain || !['user', 'assistant', 'attachment', 'system'].includes(e.type)) continue
    byUuid.set(e.uuid, e)
    const blocks = Array.isArray(e.message?.content) ? e.message.content : []
    if (!hit && e.type === 'assistant' && blocks.some(b => b.type === 'tool_use' && b.id === change.toolUseId)) hit = e
    const done = e.type === 'user' ? blocks.find(b => b.type === 'tool_result' && b.tool_use_id === change.toolUseId) : undefined
    if (done) result = { isError: Boolean(done.is_error), text: clip(textOf(done.content).trim(), 300) }
  }
  if (!hit) return { error: '会话记录里找不到这次修改。' }

  // Back along the conversation to the person's message that started the turn.
  const said = []
  let prompt = null
  for (let e = byUuid.get(hit.parentUuid), steps = 0; e && steps < 20000; e = byUuid.get(e.parentUuid), steps++) {
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content).trim()
      if (t && said.length < 3) said.unshift({ text: clip(t, 800), at: e.timestamp })
    } else if (e.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) continue
      const t = textOf(c).replace(TAGS, '').trim()
      if (!t) continue
      prompt = { text: clip(t, 1500), at: e.timestamp, viaCanvas: e.origin?.kind === 'plugin' }
      break
    }
  }
  return { prompt, said, result, at: hit.timestamp, otherSession: change.sessionId !== sessionId }
}

// ---- the conversation behind a work-log entry ----
// What the person asked, what the agent said and which tools it used, from
// the entry's start to its end. What the tools gave back is never shown: a
// command's output may hold records. Long digit runs are masked, as in the log.

const maskDigits = s => s.replace(/\d{6,}/g, m => '#'.repeat(Math.min(m.length, 8)))

function toolLine(b) {
  const i = b.input || {}
  const name = String(b.name || '')
  // Inside the project relative to it; elsewhere in full.
  const at = p => {
    if (typeof p !== 'string' || !p) return ''
    const r = path.relative(root, p)
    return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p).replace(/\\/g, '/')
  }
  if (/^(Bash|PowerShell)$/.test(name)) return `运行：${clip(String(i.command || ''), 240)}`
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return `改文件：${at(i.file_path || i.notebook_path)}`
  if (name === 'Read') return `读文件：${at(i.file_path)}`
  if (name === 'Grep' || name === 'Glob') return `搜索：${clip(String(i.pattern || ''), 80)}`
  if (name.startsWith('mcp__archcanvas__')) return `架构画布：${name.slice('mcp__archcanvas__'.length)}`
  return `工具：${name}`
}

function turnTalk(entryId) {
  const log = readData('worklog').value
  const entry = Array.isArray(log) ? log.find(e => e && e.id === entryId) : undefined
  if (!entry) return { error: '找不到这条工作记录。' }
  if (entry.source === 'outside') return { error: `这些改动发生在 ${AGENT} 没在工作的时候，没有对应的对话。` }
  const file = transcriptOf(String(entry.session || ''))
  if (!file) return { error: '找不到这一轮所在会话的记录（会话可能已经被清理）。' }
  const from = Number(entry.startedAt) - 5000
  const to = (Number(entry.endedAt) || Date.now()) + 5000
  const items = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(e.timestamp || '')
    if (!t || t < from || t > to || e.isSidechain) continue
    if (e.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) continue
      const text = textOf(c).replace(TAGS, '').trim()
      if (text) items.push({ who: 'you', text: maskDigits(clip(text, 1500)), at: e.timestamp, viaCanvas: e.origin?.kind === 'plugin' })
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) items.push({ who: 'agent', text: maskDigits(clip(b.text.trim(), 1200)), at: e.timestamp })
        else if (b.type === 'tool_use') {
          // Tools used one after another are one block.
          const last = items[items.length - 1]
          const line = maskDigits(toolLine(b))
          if (last && last.who === 'tool') last.lines.push(line)
          else items.push({ who: 'tool', lines: [line], at: e.timestamp })
        }
      }
    }
  }
  return { items: items.slice(-60), cut: items.length > 60, otherSession: entry.session !== sessionId }
}

// ---- the project's files, for the tree beside the graph ----
// In a git repository the list is git's (tracked and untracked, .gitignore
// respected); elsewhere a walk that skips the usual tool folders.

const SKIP_DIRS = new Set(['.git', '.archcanvas', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.ipynb_checkpoints', '.cache'])
const SKIP_FILES = /(\.pyc|\.pyo)$|^\.DS_Store$|^Thumbs\.db$/
const MAX_FILES = 5000
const PREVIEW_BYTES = 256 * 1024
const PREVIEW_LINES = 400

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 })
}

function walk() {
  const out = []
  const visit = (dir, rel, depth) => {
    if (out.length >= MAX_FILES || depth > 16) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(path.join(dir, e.name), r, depth + 1)
      } else if (e.isFile() && !SKIP_FILES.test(e.name)) out.push(r)
    }
  }
  visit(root, '', 0)
  return out
}

// Git's status for each file: a letter (M A D R ? U) and lines changed.
function gitState() {
  let prefix
  try {
    prefix = git(['rev-parse', '--show-prefix']).trim()
  } catch {
    return null
  }
  const own = p => (p.startsWith(prefix) ? p.slice(prefix.length) : null)
  const status = {}
  const parts = git(['status', '--porcelain=v1', '-z', '-uall', '--', '.']).split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 4) continue
    const xy = rec.slice(0, 2)
    if (xy[0] === 'R' || xy[0] === 'C') i++
    const p = own(rec.slice(3))
    if (!p) continue
    const letter = xy === '??' ? '?' : /U/.test(xy) ? 'U' : ['D', 'A', 'R', 'M', 'C', 'T'].find(c => xy.includes(c)) || ''
    if (letter) status[p] = { letter }
  }
  try {
    // With -z a path comes as it is (a Chinese name is not quoted and escaped);
    // a rename leaves its path empty and gives the old and new as two more fields.
    const recs = git(['diff', 'HEAD', '--numstat', '-z', '--', '.']).split('\0')
    for (let i = 0; i < recs.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(recs[i])
      if (!m) continue
      let file = m[3]
      if (!file) file = recs[(i += 2)]
      const p = file && own(file)
      if (p && status[p]) status[p] = { ...status[p], added: Number(m[1]) || 0, removed: Number(m[2]) || 0 }
    }
  } catch {
    // No commit yet: letters only.
  }
  let branch = ''
  try {
    branch = git(['branch', '--show-current']).trim()
  } catch {
    // Detached or unborn.
  }
  return { branch, status }
}

// ---- sensitive data ----
// A module of type data is sensitive unless the graph says sensitive: false
// (a graph from before types: data when all its files look like data). The
// files under it are neither listed by name nor previewed; only how many
// there are. Its notes (README, .md) describe the data and stay visible.

const DATA_FILE = /\.(csv|tsv|xlsx?|sav|dta|sas7bdat|parquet|feather|rds|rdata|h5|hdf5|npy|npz|nii|nii\.gz|dcm|mat|sqlite|db)$/i
const DATA_DIR = /(^|\/)(data|datasets?|raw|processed|inputs?)\/?$/i
const NOTES = /(^|\/)(readme([._-][^/]*)?\.(md|markdown|txt|rst)|readme|[^/]+\.(md|markdown))$/i

function sealedPaths() {
  const graph = readData('graph').value
  const out = []
  for (const n of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!n || !Array.isArray(n.files)) continue
    const files = n.files.map(f => String(f).replace(/\\/g, '/'))
    const type = n.type || (files.length && files.every(f => DATA_FILE.test(f) || DATA_DIR.test(f)) ? 'data' : 'code')
    if (type === 'data' && n.sensitive !== false) for (const f of files) out.push({ path: f.replace(/\/+$/, ''), node: n.id })
  }
  return out
}

function sealedBy(rel, sealed) {
  const norm = p => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase()
  const f = norm(rel)
  if (NOTES.test(f)) return null
  return sealed.find(s => norm(s.path) === '.' || f === norm(s.path) || f.startsWith(norm(s.path) + '/')) || null
}

function listFiles() {
  let files = null
  const state = gitState()
  if (state) {
    try {
      files = git(['ls-files', '-co', '--exclude-standard', '-z', '--', '.'])
        .split('\0')
        .filter(Boolean)
        .filter(p => !p.split('/').some(part => SKIP_DIRS.has(part)))
        .slice(0, MAX_FILES)
    } catch {
      files = null
    }
  }
  if (!files) files = walk()
  const sealed = sealedPaths()
  const hidden = new Map(sealed.map(s => [s.path, 0]))
  files = files.filter(f => {
    const s = sealedBy(f, sealed)
    if (s) hidden.set(s.path, hidden.get(s.path) + 1)
    return !s
  })
  if (state) for (const p of Object.keys(state.status)) if (sealedBy(p, sealed)) delete state.status[p]
  files.sort((a, b) => a.localeCompare(b))
  return { files, truncated: files.length >= MAX_FILES, git: state, sealed: sealed.map(s => ({ ...s, count: hidden.get(s.path) })), changed: changedSince(files) }
}

// Files changed after the map last looked at them: path → when (ms). Only
// those newer than the oldest look, so the list stays short.
function changedSince(files) {
  const graph = readData('graph').value
  const drawn = graph && typeof graph.drawnAt === 'number' ? graph.drawnAt : 0
  if (!drawn) return null
  const looks = [drawn, ...(Array.isArray(graph.nodes) ? graph.nodes.map(n => n && n.seenAt).filter(v => typeof v === 'number') : [])]
  const since = Math.min(...looks)
  const out = {}
  for (const f of files) {
    try {
      const t = fs.statSync(path.join(root, f)).mtimeMs
      if (t > since) out[f] = Math.round(t)
    } catch {
      // Gone meanwhile.
    }
  }
  return out
}

// How much a module's folders and files hold: counts, size, the latest change.
// No names, so it serves sensitive data too.
function stats(nodeId) {
  const graph = readData('graph').value
  const node = Array.isArray(graph?.nodes) ? graph.nodes.find(n => n && n.id === nodeId) : null
  if (!node) return { error: '找不到这个模块。' }
  let files = 0
  let bytes = 0
  let latest = 0
  const missing = []
  const visit = (abs, depth) => {
    if (files >= 200000 || depth > 24) return
    let st
    try {
      st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) return
    } catch {
      return
    }
    if (st.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(abs)
      } catch {
        return
      }
      for (const name of names) if (!SKIP_DIRS.has(name)) visit(path.join(abs, name), depth + 1)
    } else if (st.isFile()) {
      files++
      bytes += st.size
      latest = Math.max(latest, st.mtimeMs)
    }
  }
  for (const f of node.files || []) {
    const abs = path.resolve(root, String(f))
    if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) continue
    if (!fs.existsSync(abs)) missing.push(String(f))
    else visit(abs, 0)
  }
  return { files, bytes, latest, missing }
}

// A file's text for the preview: inside the project only, text only, capped.
// A file's text for the page, `at` (a line) somewhere in the window shown.
function localFile(rel) {
  const base = fs.realpathSync(root)
  const target = path.resolve(base, rel)
  const relative = path.relative(base, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('路径在项目外')
  let current = base
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不跟随链接预览文件')
  }
  return target
}

function preview(rel, at) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return { error: '没有给出文件。' }
  if (sealedBy(rel, sealedPaths())) return { error: '这是敏感数据模块里的文件，不预览。确实不含隐私的话，可以在模块详情里把它标为不敏感。' }
  let base
  let real
  try {
    base = fs.realpathSync(root)
    real = localFile(rel)
  } catch {
    return { error: '文件不存在（可能刚被删掉或改名）。' }
  }
  if (!real.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return { error: '这个文件不在项目里。' }
  const st = fs.statSync(real)
  if (!st.isFile()) return { error: '这不是文件。' }
  const fd = fs.openSync(real, 'r')
  const buf = Buffer.alloc(Math.min(st.size, PREVIEW_BYTES))
  fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  return { ...shown(rel, buf, st.size, at), mtime: st.mtimeMs }
}

// A file as it was at a commit: a cited spot as the code read when the map was drawn.
function previewAt(rel, rev, at) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return { error: '没有给出文件。' }
  if (typeof rev !== 'string' || !/^[0-9a-f]{40}$/.test(rev)) return { error: '提交号不对。' }
  if (sealedBy(rel, sealedPaths())) return { error: '这是敏感数据模块里的文件，不预览。' }
  let buf
  try {
    buf = execFileSync('git', ['-C', root, 'show', `${rev}:./${rel.replace(/\\/g, '/')}`], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return { error: '画图时的提交里没有这个文件（可能是后来才加的），或者那个提交已经不在了。' }
  }
  return { ...shown(rel, buf.subarray(0, PREVIEW_BYTES), buf.length, at), rev }
}

// What the page shows of a file's start: up to PREVIEW_LINES lines, around `at` when it is far down.
function shown(rel, buf, size, at) {
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, size, binary: true }
  const lines = buf.toString('utf8').split(/\r?\n/)
  const start = at > PREVIEW_LINES - 60 ? Math.max(0, Math.min(at - 61, lines.length - PREVIEW_LINES)) : 0
  return {
    path: rel,
    size,
    start,
    lines: lines.slice(start, start + PREVIEW_LINES),
    more: Math.max(0, lines.length - start - PREVIEW_LINES),
    cut: size > PREVIEW_BYTES,
  }
}

// Shows a project file or folder in the system's file manager, for the
// person to start testing there: a file is selected in its folder. Nothing
// is run or opened with an app.
function reveal(rel) {
  let base
  let real
  try {
    base = fs.realpathSync(root)
    real = fs.realpathSync(path.resolve(root, typeof rel === 'string' ? rel : ''))
  } catch {
    return { error: '这个文件或文件夹不存在（可能刚被删掉或改名）。' }
  }
  if (real.toLowerCase() !== base.toLowerCase() && !real.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return { error: '这个位置不在项目里。' }
  const isFile = fs.statSync(real).isFile()
  const [cmd, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [isFile ? `/select,${real}` : real]]
      : process.platform === 'darwin'
        ? ['open', isFile ? ['-R', real] : [real]]
        : ['xdg-open', [isFile ? path.dirname(real) : real]]
  execFile(cmd, args, { windowsHide: false }, () => undefined)
  return { ok: true }
}

// ---- the page's live line ----

const clients = new Set()

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(frame)
}

const stamps = {}
function stamp(name) {
  try {
    const s = fs.statSync(path.join(DATA, FILES[name]))
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'none'
  }
}
for (const name of Object.keys(FILES)) stamps[name] = stamp(name)

setInterval(() => {
  const changed = []
  for (const name of Object.keys(FILES)) {
    const now = stamp(name)
    if (now !== stamps[name]) {
      stamps[name] = now
      changed.push(name)
    }
  }
  if (changed.length) broadcast('change', { files: changed })
}, 400)

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 15000)

// Files added, removed or saved anywhere in the project: the tree reloads.
let filesTimer = null
const pulsed = new Map()
try {
  fs.watch(root, { recursive: true }, (event, name) => {
    const rel = String(name || '').replace(/\\/g, '/')
    if (!rel || rel.split('/').some(part => SKIP_DIRS.has(part))) return
    clearTimeout(filesTimer)
    filesTimer = setTimeout(() => broadcast('files', {}), 400)
    // Where no hook reports each write, a file saved on disk lights up.
    if (WATCH_ACTIVITY && !SKIP_FILES.test(rel) && Date.now() - (pulsed.get(rel) || 0) > 1500) {
      pulsed.set(rel, Date.now())
      setTimeout(() => {
        try {
          if (fs.statSync(path.join(root, rel)).isFile()) broadcast('activity', { path: rel, kind: 'write' })
        } catch {
          // Deleted or renamed meanwhile.
        }
      }, 150)
    }
  })
} catch {
  // No recursive watching here: the tree reloads with the history instead.
}

// Ends with the session that started it, even if that one could not say so.
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    process.exit(0)
  }
}, 5000)

// ---- routes ----

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) return refuse(res, 403, '这个地址打不开画布，请用 /archcanvas 给出的链接。')
  const url = new URL(req.url, `http://127.0.0.1:${port}`)

  if (req.method === 'GET' && url.pathname === '/open') {
    if (!same(url.searchParams.get('k'), token)) return refuse(res, 403, '这个链接已经失效。')
    return send(res, 302, 'text/plain', '', {
      'Set-Cookie': `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      Location: '/',
    })
  }

  if (!authed(req)) return refuse(res, 403, `还没有通过 ${AGENT} 打开。`)

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname]
    try {
      return send(res, 200, type, fs.readFileSync(path.join(HERE, file)), { 'Content-Security-Policy': CSP })
    } catch {
      return send(res, 500, 'text/plain; charset=utf-8', `画布缺少文件 ${file}，请重新安装 archcanvas。`)
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state())
  if (req.method === 'GET' && url.pathname === '/api/style') return json(res, 200, readStyle())
  if (req.method === 'GET' && url.pathname === '/wallpaper') {
    const file = wallpaperFile()
    if (!file) return send(res, 404, 'text/plain', 'none')
    return send(res, 200, IMAGE_TYPES[path.extname(file).slice(1)], fs.readFileSync(file), { 'Cache-Control': 'no-cache' })
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    try {
      return json(res, 200, listFiles())
    } catch (err) {
      return json(res, 200, { files: [], git: null, error: `列不出文件：${fsWhy(err)}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') return json(res, 200, stats(url.searchParams.get('node') || ''))

  if (req.method === 'GET' && url.pathname === '/api/file') {
    try {
      const rel = url.searchParams.get('path') || ''
      const line = Number(url.searchParams.get('line')) || 0
      const rev = url.searchParams.get('rev')
      return json(res, 200, rev ? previewAt(rel, rev, line) : preview(rel, line))
    } catch (err) {
      return json(res, 200, { error: `读不了这个文件：${fsWhy(err)}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/conversation') {
    try {
      return json(res, 200, conversation(url.searchParams.get('change') || ''))
    } catch (err) {
      return json(res, 200, { error: `对话记录读不出来：${fsWhy(err)}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/turn') {
    try {
      return json(res, 200, turnTalk(url.searchParams.get('entry') || ''))
    } catch (err) {
      return json(res, 200, { error: `对话记录读不出来：${fsWhy(err)}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write('retry: 2000\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: '只接受画布页面自己发来的操作。' })
    let body
    try {
      body = await readBody(req, url.pathname === '/api/wallpaper' ? MAX_IMAGE * 1.4 : MAX_BODY)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    if (url.pathname === '/api/action') {
      if (!body || !ACTIONS.has(body.type)) return json(res, 400, { error: '这个操作没能识别，刷新画布后再试。' })
      process.stdout.write(`@@ACTION ${JSON.stringify(body)}\n`)
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/layout') {
      try {
        writeLayout(cleanLayout(body))
      } catch (err) {
        return json(res, 500, { error: `写不进 .archcanvas/layout.json：${fsWhy(err)}` })
      }
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/reveal') return json(res, 200, reveal(body.path))
    if (url.pathname === '/api/style' || url.pathname === '/api/wallpaper') {
      try {
        if (url.pathname === '/api/style') writeLook('style.json', JSON.stringify(cleanStyle(body), null, 2) + '\n')
        else saveWallpaper(body)
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      const style = readStyle()
      broadcast('style', style)
      return json(res, 200, style)
    }
    if (url.pathname === '/api/activity') {
      // Claude read or wrote a project file just now (from the mod).
      const file = typeof body.path === 'string' ? body.path.slice(0, 1000) : ''
      if (file) broadcast('activity', { path: file, kind: body.kind === 'write' ? 'write' : 'read' })
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/notice') {
      const text = typeof body.text === 'string' ? body.text.slice(0, 500) : ''
      if (text) broadcast('notice', { text, level: body.level === 'error' ? 'error' : 'info' })
      return json(res, 200, { ok: true })
    }
  }

  json(res, 404, { error: '画布服务没有这项功能，刷新画布后再试。' })
})

server.listen(Number(process.env.ARCHCANVAS_PORT) || 0, '127.0.0.1', () => {
  port = server.address().port
  cookie = `archcanvas_${port}`
  process.stdout.write(`@@READY ${JSON.stringify({ port, token })}\n`)
})
server.on('error', err => {
  process.stderr.write(`canvas server: ${err.message}\n`)
  process.exit(1)
})
