'use strict'
// The archcanvas canvas page: draws .archcanvas/graph.json as one frame per layer,
// per layer, with the open tasks laid over it. Every change the person asks
// for is posted to /api/action and becomes a draft task in the archcanvas mod;
// nothing here edits code or the graph. Text is always set as text, never as
// markup.
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const $ = id => document.getElementById(id)
  const svg = $('canvas')
  const scene = $('scene')
  const stage = $('stage')
  const panel = $('panel')
  const panelBody = $('panel-body')

  // ---- tiny DOM helpers ----

  function s(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') el.textContent = v
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v))
    }
    if (parent) parent.appendChild(el)
    return el
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    for (const kid of kids.flat(3)) {
      if (kid === undefined || kid === null || kid === false || kid === '') continue
      el.append(kid instanceof Node ? kid : String(kid))
    }
    return el
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

  // ---- text measuring ----

  const ctx = document.createElement('canvas').getContext('2d')
  const FONT = getComputedStyle(document.body).fontFamily
  function textW(text, px, weight) {
    ctx.font = `${weight || 400} ${px}px ${FONT}`
    return ctx.measureText(text).width
  }
  function fit(text, maxW, px, weight) {
    if (textW(text, px, weight) <= maxW) return text
    const chars = Array.from(text)
    let lo = 0
    let hi = chars.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (textW(chars.slice(0, mid).join('') + '…', px, weight) <= maxW) lo = mid
      else hi = mid - 1
    }
    return chars.slice(0, lo).join('') + '…'
  }
  const WIDE = /[⺀-鿿豈-﫿＀-￯　-〿]/
  function wrap(text, maxW, px, maxLines) {
    const tokens = text.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) || []
    const lines = []
    let cur = ''
    const push = () => {
      lines.push(cur.trim())
      cur = ''
    }
    for (const tok of tokens) {
      if (textW(cur + tok, px) <= maxW) {
        cur += tok
        continue
      }
      if (cur.trim()) push()
      if (/^\s+$/.test(tok)) continue
      if (textW(tok, px) <= maxW || WIDE.test(tok)) cur = tok
      else {
        for (const ch of Array.from(tok)) {
          if (textW(cur + ch, px) > maxW) push()
          cur += ch
        }
      }
    }
    if (cur.trim()) push()
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines)
      kept[maxLines - 1] = fit(kept[maxLines - 1] + '…', maxW, px)
      return kept
    }
    return lines
  }

  // ---- state ----

  const OPEN = new Set(['draft', 'queued', 'working'])
  // Which agent the page works with (the server says: Claude, Codex, ...),
  // and how a handover reaches it: sent straight in, or copied for pasting.
  let AGENT = 'Claude'
  let HANDOFF = null
  let STATUS = {}
  function setAgent(name) {
    AGENT = name || 'Claude'
    STATUS = { draft: '草稿', queued: `已交给 ${AGENT}`, working: `${AGENT} 正在做`, done: '已完成', cancelled: '已取消' }
    $('link').title = `与 ${AGENT} 的连接`
    $('link').querySelector('b').textContent = $('link').classList.contains('on') ? `已连接 ${AGENT}` : '已断开'
    $('empty').querySelector('p').textContent = `让 ${AGENT} 读一遍代码，把模块分好组、连好线，画到这里。`
    $('generate').textContent = `让 ${AGENT} 生成架构图`
  }
  setAgent('Claude')
  const KIND = { comment: '意见', 'add-node': '新增模块', 'remove-node': '删除模块', 'add-edge': '新增连线', 'remove-edge': '去掉连线' }
  const LAYER_COLORS = ['#72a9ec', '#b58de0', '#5fb8a6', '#e6b84a', '#e0835f', '#8fbf5f', '#e07fa8']
  // What the group-colour menu offers.
  const GROUP_COLORS = [
    ['蓝', '#72a9ec'],
    ['紫', '#b58de0'],
    ['青', '#5fb8a6'],
    ['黄', '#e6b84a'],
    ['橙', '#e0835f'],
    ['绿', '#8fbf5f'],
    ['粉', '#e07fa8'],
    ['灰', '#a39e94'],
  ]
  const G = { nodeW: 216, nodeH: 66, gapY: 20, headH: 52 }
  // A frame (one per layer): the inset of its cards, where they start below
  // its title, the gap between frames laid out by default and how many go in
  // a row, the height of a folded one.
  const FRAME = { pad: 18, top: G.headH + 16, gap: 76, perRow: 4, minW: G.nodeW + 36, foldH: 40 }
  const snap = v => Math.round(v / 4) * 4

  let S = { graph: null, tasks: [], history: [], layout: null, sessionId: '', project: '', errors: [] }
  let L = { v: 2, frames: {}, positions: {}, colors: {}, collapsed: [], expanded: [] }
  // The work log in the panel: the entry lit on the canvas, those opened, how many shown.
  let workView = false
  let workPick = null
  const workOpen = new Set()
  let workShown = 60
  const view = { x: 0, y: 0, k: 1 }
  let M = null // what the graph and tasks come to
  let P = null // where everything sits
  let R = [] // the edges as drawn
  let labelBoxes = [] // the edge labels on show, each a box the pointer can take the edge by
  let selected = null
  let hover = null
  let hoverEdge = null
  let hoverFrame = null // the frame the pointer is over, its empty slot shown
  let vouchedOpen = null // the list of vouched lines unfolded (null: only while one needs a look)
  let flow = true
  let mainFlow = null // the id of the main line on show, if any
  let fitted = false
  // The view kept with the layout: when it is saved, and whether the page opened on it.
  let viewTimer = 0
  let viewRestored = false
  let drag = null
  let connectFrom = null
  let pointer = null
  let sketch = null // a new card, started where the person pointed
  let titleEdit = null // the frame whose title is being typed over
  let pendingFrame = null // where a layer asked for a moment ago is to sit
  let editor = null // the box open on a card: a draft's fields, or a comment
  let pendingPlace = null // where the module asked for a moment ago is to sit
  const unsavedPos = {} // positions set here that the server has not stored yet
  const unsavedFrames = {} // frame spots likewise
  const movedTo = new Map() // module → the frame it was dropped in, until the server says so
  let lastStatus = null // task id → status at the last refresh
  let panelFor = undefined
  const openDiffs = new Set()
  const openTalks = new Set()
  const talks = new Map() // change id → what /api/conversation answered
  const drafts = {}
  const seenErrors = new Set()

  // The file tree: the project's files, which one is open in the panel, and
  // what Claude touched a moment ago.
  let FT = { files: [], git: null, truncated: false }
  let fileSel = null
  let fileView = null
  let fSearch = ''
  let fileFocus = null // { path, line, end, scroll }: the lines a cited spot points at

  // Which side bars and the legend are folded goes with the look settings:
  // they outlast this page, which opens on a new port each time.
  const keepUi = change => setLook(change)
  function foldBar(el, btn, closed, shut, open) {
    el.classList.toggle('closed', closed)
    btn.textContent = closed ? shut : open
  }
  let onlyUnowned = false
  let treeSeeded = false
  let activityTimer = 0
  const openDirs = new Set()
  const activity = new Map() // path → { kind, until }
  const nodePulse = new Map() // node id → { kind, until }
  const GIT_TITLE = { M: '已修改', A: '新增', D: '已删除', R: '已改名', '?': '未跟踪', U: '有冲突', T: '类型变了', C: '已复制' }

  // ---- the model ----

  function build() {
    const g = S.graph
    const tasks = (S.tasks || []).filter(t => OPEN.has(t.status))
    const nodes = g.nodes.map(n => ({ ...n, layer: movedTo.get(n.id) || n.layer, ghost: false }))
    const ids = new Set(nodes.map(n => n.id))
    for (const t of tasks) {
      if (t.kind === 'add-node' && t.node && !ids.has(t.node.id) && g.layers.some(l => l.id === t.node.layer)) {
        nodes.push({ ...t.node, layer: movedTo.get(t.node.id) || t.node.layer, files: [], ghost: true, task: t })
        ids.add(t.node.id)
      }
    }
    const removing = new Map()
    for (const t of tasks) if (t.kind === 'remove-node') removing.set(t.nodeIds[0], t)
    const typeOfId = new Map(nodes.map(n => [n.id, nodeType(n)]))
    const edges = []
    // Saved lines (and proposed ones, saved the same way) say their kind or
    // have it from their ends; a draft's wires are as drawn.
    const line = (from, to, rest, kind) => {
      const a = typeOfId.get(from)
      const b = typeOfId.get(to)
      const k = kind || drawnKind(a, b)
      edges.push({ from, to, ...rest, kind: k, head: headOf(k, a, b) })
    }
    // A map that cites code marks the lines it found no code for; an older map cites none.
    const evidence = g.edges.some(e => e.sources && e.sources.length) || g.nodes.some(n => n.sources && n.sources.length)
    // What the check against the code found: calls the code does not show, cited lines that name nothing of the callee.
    const A = auditOf(S)
    const nocode = new Map(A.unfound.map(u => [`${u.from}>${u.to}`, u.reversed ? 'reversed' : 'missing']))
    // A third file that names both ends, and so may hand the one to the other.
    const viaOf = new Map(A.unfound.filter(u => u.via && u.via.path).map(u => [`${u.from}>${u.to}`, u.via]))
    const doubt = new Map()
    for (const d of A.doubtful) doubt.set(`${d.from}>${d.to}`, [...(doubt.get(`${d.from}>${d.to}`) || []), { ...d.source, ...(d.changed ? { changed: true } : {}) }])
    const place = placer(A)
    for (const e of g.edges) {
      const cut = tasks.find(t => t.kind === 'remove-edge' && t.edge && t.edge.from === e.from && t.edge.to === e.to)
      const sources = (e.sources || []).map(place)
      const k = `${e.from}>${e.to}`
      // A line someone vouched for is there, whatever the check reads.
      const vouched = e.vouched && e.vouched.why ? e.vouched : null
      line(
        e.from,
        e.to,
        {
          label: e.label || '',
          state: cut ? 'remove' : 'normal',
          task: cut,
          sources,
          vouched,
          unsure: evidence && !sources.length && !vouched,
          nocode: vouched ? null : nocode.get(k) || null,
          via: vouched ? null : viaOf.get(k) || null,
          doubt: vouched ? [] : doubt.get(k) || [],
        },
        savedKind(e, typeOfId.get(e.from), typeOfId.get(e.to)),
      )
    }
    // Modules many others call (helpers, checks, storage): the calls into them are drawn faint.
    const callers = new Map()
    for (const e of edges) if (e.state === 'normal' && e.kind === 'call') callers.set(e.to, (callers.get(e.to) || 0) + 1)
    const hubs = new Set([...callers].filter(([, n]) => n >= HUB_CALLERS).map(([id]) => id))
    for (const e of edges) if (e.kind === 'call' && hubs.has(e.to)) e.hub = true
    for (const t of tasks) {
      if (t.kind !== 'add-edge' || !t.edge || !ids.has(t.edge.from) || !ids.has(t.edge.to)) continue
      if (g.edges.some(e => e.from === t.edge.from && e.to === t.edge.to)) continue
      line(t.edge.from, t.edge.to, { label: '', state: 'add', task: t }, savedKind(t.edge, typeOfId.get(t.edge.from), typeOfId.get(t.edge.to)))
    }
    for (const n of nodes) {
      if (!n.ghost) continue
      for (const d of n.task.nodeIds) if (ids.has(d) && d !== n.id) line(n.id, d, { label: '', state: 'add', task: n.task })
      for (const u of n.task.usedBy || []) if (ids.has(u) && u !== n.id) line(u, n.id, { label: '', state: 'add', task: n.task })
    }
    // What the agent has in hand: being done now, left from an earlier session, or waiting its turn.
    const running = new Map()
    for (const t of tasks) {
      if (t.status !== 'working' && t.status !== 'queued') continue
      const st = isStale(t) ? 'stale' : t.status
      for (const id of t.kind === 'add-node' ? (t.node ? [t.node.id] : []) : t.nodeIds) if (running.get(id) !== 'working') running.set(id, st)
    }
    const todo = new Map()
    const bump = (id, t) => {
      if (!todo.has(id)) todo.set(id, [])
      todo.get(id).push(t)
    }
    for (const t of tasks) {
      if (t.kind === 'add-node') {
        if (t.node) bump(t.node.id, t)
      } else for (const id of t.nodeIds) bump(id, t)
    }
    const changes = new Map()
    for (const c of S.history || []) {
      for (const id of c.nodeIds || []) {
        if (!changes.has(id)) changes.set(id, [])
        changes.get(id).push(c)
      }
    }
    // What is waiting for the person to test, by module.
    const tests = new Map()
    for (const c of checksOf(S)) if (c.status === 'open') for (const id of c.nodeIds) tests.set(id, (tests.get(id) || 0) + 1)
    return { g, tasks, nodes, edges, removing, todo, changes, tests, running, hubs, byId: new Map(nodes.map(n => [n.id, n])) }
  }

  // A module called by this many others is shared plumbing, not the story.
  const HUB_CALLERS = 5

  // The main line on show: its steps on modules still drawn, the proposed
  // modules that are to be steps of it where they will go (`ghost`), and each
  // module's step numbers.
  function shownFlow() {
    const f = mainFlow && S.graph && (S.graph.flows || []).find(x => x.id === mainFlow)
    if (!f || !M) return null
    const coming = M.nodes.filter(n => n.ghost && n.task && n.task.flowStep && n.task.flowStep.flow === f.id)
    const steps = []
    const put = i => {
      for (const g of coming) if (placeAt(f, g.task.flowStep) === i) steps.push({ node: g.id, label: g.summary ? `待新增：${g.summary}` : '待新增', ghost: true })
    }
    put(-1)
    f.steps.forEach((st, i) => {
      if (M.byId.has(st.node) && !M.byId.get(st.node).ghost) steps.push(st)
      put(i)
    })
    const at = new Map()
    steps.forEach((st, i) => at.set(st.node, [...(at.get(st.node) || []), i + 1]))
    return { flow: f, steps, at }
  }
  // Which step a place in a line follows now, found by its module if the line changed (as the mod does).
  function placeAt(f, p) {
    if (p.node && (f.steps[p.after] || {}).node !== p.node) {
      const i = f.steps.findIndex(s => s.node === p.node)
      if (i >= 0) return i
    }
    return p.after
  }

  // The trunk view of a main line: its modules in a row from left to right,
  // one card each, in the order the line first reaches them. Every other
  // module hangs off the first trunk module it is tied to (one other module
  // between at most): data, documents and outside services above, code below.
  // Shared modules, and those further off, sit in rows underneath.
  const TRUNK = { gapX: 40, gapY: 16, perSide: 3, between: 64, perRow: 7, reach: 2, under: 70 }
  function trunkPlace(line) {
    const spine = []
    for (const st of line.steps) if (!spine.includes(st.node)) spine.push(st.node)
    const onSpine = new Set(spine)
    // Proposed modules too: one wired to the trunk hangs off it like the rest.
    const shown = M.nodes
    const nb = new Map(shown.map(n => [n.id, []]))
    for (const e of M.edges) {
      if (!nb.has(e.from) || !nb.has(e.to)) continue
      nb.get(e.from).push(e.to)
      nb.get(e.to).push(e.from)
    }
    const shared = new Set([...M.hubs].filter(id => !onSpine.has(id) && nb.has(id)))
    // Out from the whole trunk at once, in its order: the earliest step wins a
    // module. Branches go two modules out; what lies further is set below.
    const owner = new Map(spine.map(id => [id, id]))
    const depth = new Map(spine.map(id => [id, 0]))
    const queue = [...spine]
    while (queue.length) {
      const id = queue.shift()
      if (depth.get(id) >= TRUNK.reach) continue
      for (const m of nb.get(id)) {
        if (owner.has(m) || shared.has(m)) continue
        owner.set(m, owner.get(id))
        depth.set(m, depth.get(id) + 1)
        queue.push(m)
      }
    }
    const W = G.nodeW + TRUNK.gapX
    const boxes = new Map()
    const put = (n, x, y) => boxes.set(n.id, { x, y, w: G.nodeW, h: heightOf(n), key: n.id })
    let x = 0
    let bottom = G.nodeH
    for (const id of spine) {
      const n = M.byId.get(id)
      const kids = shown
        .filter(k => !onSpine.has(k.id) && owner.get(k.id) === id)
        .sort((a, b) => depth.get(a.id) - depth.get(b.id) || a.name.localeCompare(b.name, 'zh'))
      const above = kids.filter(k => isRes(nodeType(k)))
      const below = kids.filter(k => !isRes(nodeType(k)))
      const cols = Math.max(1, Math.ceil(above.length / TRUNK.perSide), Math.ceil(below.length / TRUNK.perSide))
      put(n, x, 0)
      // Stacked up from the trunk, and down from it, a few to a column.
      const up = []
      above.forEach((k, j) => {
        const c = Math.floor(j / TRUNK.perSide)
        const y = (up[c] ?? 0) - TRUNK.gapY - heightOf(k)
        put(k, x + c * W, y)
        up[c] = y
      })
      const down = []
      below.forEach((k, j) => {
        const c = Math.floor(j / TRUNK.perSide)
        const y = down[c] ?? heightOf(n) + TRUNK.gapY
        put(k, x + c * W, y)
        down[c] = y + heightOf(k) + TRUNK.gapY
        bottom = Math.max(bottom, y + heightOf(k))
      })
      bottom = Math.max(bottom, heightOf(n))
      x += cols * W - TRUNK.gapX + TRUNK.between
    }
    const areas = []
    let y = bottom + TRUNK.under
    const block = (label, list) => {
      if (!list.length) return
      areas.push({ label, x: 0, y: y - 14 })
      list.forEach((k, j) => put(k, (j % TRUNK.perRow) * W, y + Math.floor(j / TRUNK.perRow) * (G.nodeH + TRUNK.gapY)))
      y += Math.ceil(list.length / TRUNK.perRow) * (G.nodeH + TRUNK.gapY) + 34
    }
    block(`公共模块：被 ${HUB_CALLERS} 个以上模块调用`, shown.filter(k => shared.has(k.id)))
    block('新增的模块（还没连到主线附近）', shown.filter(k => k.ghost && !owner.has(k.id)))
    block('离主线较远的模块', shown.filter(k => !k.ghost && !owner.has(k.id) && !shared.has(k.id)))
    // A new card being named sits where the pointer was.
    if (sketch && sketch.at) boxes.set(SKETCH, { x: sketch.at.x, y: sketch.at.y, w: G.nodeW, h: G.nodeH, key: SKETCH })
    return { cols: [], boxes, spine, onSpine, areas }
  }

  // Into a main line's trunk view, the canvas fitted to it; out of it, back to where the canvas was.
  let viewBefore = null
  function setFlow(id) {
    // A new card belongs to the view it was opened in: named, it is made; else dropped.
    if (editor && editor.kind === 'new') closeEditor()
    if (id && !mainFlow) viewBefore = { ...view }
    mainFlow = id
    selected = null
    if (id && fileSel) closeFile()
    draw()
    renderPanel()
    renderBar()
    if (id) fitStart()
    else if (viewBefore) {
      Object.assign(view, viewBefore)
      viewBefore = null
      applyView()
    }
  }

  const nameOf = id => (M && M.byId.get(id) ? M.byId.get(id).name : id)
  // A group's colour: the one the person picked, else a default by its place.
  function colorOf(layerId) {
    if (L.colors && L.colors[layerId]) return L.colors[layerId]
    const i = S.graph ? S.graph.layers.findIndex(l => l.id === layerId) : 0
    return LAYER_COLORS[Math.max(0, i) % LAYER_COLORS.length]
  }
  const layerName = id => (S.graph && S.graph.layers.find(l => l.id === id) ? S.graph.layers.find(l => l.id === id).name : id)
  const isDraft = n => Boolean(n && n.ghost && n.task.status === 'draft')
  // What a line means, from its ends (as the mod's hooks/edges.ts has it):
  // resources (data, documents, outside services) are read and made by steps.
  const isRes = t => t === 'data' || t === 'doc' || t === 'external'
  const KIND_WORD = { call: '调用', read: '读取', write: '生成', link: '关联' }
  const savedKind = (e, a, b) => e.kind || (isRes(a) && isRes(b) ? 'link' : isRes(b) ? 'read' : isRes(a) ? 'write' : 'call')
  const drawnKind = (a, b) => (isRes(a) && isRes(b) ? 'link' : isRes(a) ? 'read' : isRes(b) ? 'write' : 'call')
  // The arrow shows the way the data goes: into the step that reads, into
  // the resource that is made; to the callee for a call.
  const headOf = (kind, a, b) => (kind === 'read' ? (isRes(a) && !isRes(b) ? 'to' : 'from') : kind === 'write' ? (isRes(a) && !isRes(b) ? 'from' : 'to') : 'to')
  // Wires run between modules, or between a module and a proposed one that
  // is still a draft (that only changes the draft's wiring).
  const canWireFrom = id => {
    const n = M && M.byId.get(id)
    return Boolean(n && !M.removing.has(id) && (!n.ghost || isDraft(n)))
  }
  const canWireTo = (from, to) => {
    const a = M && M.byId.get(from)
    const b = M && M.byId.get(to)
    if (!a || !b || from === to || M.removing.has(to) || (a.ghost && b.ghost)) return false
    return !b.ghost || isDraft(b)
  }

  // What an opened card shows below its title.
  function cardLines(n) {
    const summary = n.summary ? wrap(n.summary, G.nodeW - 30, 12.5, 4) : []
    const files = (n.files || []).slice(0, 4).map(f => fit(f, G.nodeW - 30, 11.5))
    if ((n.files || []).length > 4) files.push(`…还有 ${n.files.length - 4} 个`)
    return { summary, files }
  }
  function heightOf(n) {
    if (!L.expanded.includes(n.id)) return G.nodeH
    const { summary, files } = cardLines(n)
    if (!summary.length && !files.length) return G.nodeH
    return G.nodeH + 10 + summary.length * 18 + (files.length ? (summary.length ? 8 : 0) + files.length * 17 : 0) + 4
  }

  // ---- layout: one frame per layer, each where the person put it ----

  // A frame sits where it was dragged (layout.frames), else in the default
  // rows, left to right. Its modules sit where they were put inside it
  // (layout.positions, relative to the frame), else stacked down its left
  // edge in an order that cuts crossings, pending ones after the real ones so
  // proposing something never moves what is there. The frame grows around
  // what it holds, but holds still under a card being dragged.
  function place() {
    const g = M.g
    const cols = g.layers.map((layer, i) => ({ layer, i, folded: L.collapsed.includes(layer.id), nodes: M.nodes.filter(n => n.layer === layer.id && !n.ghost) }))
    const colOf = new Map()
    cols.forEach(c => c.nodes.forEach(n => colOf.set(n.id, c)))
    const nbrs = new Map(cols.flatMap(c => c.nodes).map(n => [n.id, []]))
    for (const e of g.edges) {
      if (nbrs.has(e.from) && nbrs.has(e.to)) {
        nbrs.get(e.from).push(e.to)
        nbrs.get(e.to).push(e.from)
      }
    }
    const pos = new Map()
    const index = () => cols.forEach(c => c.nodes.forEach((n, j) => pos.set(n.id, (j + 0.5) / c.nodes.length)))
    index()
    for (let pass = 0; pass < 6; pass++) {
      for (const c of pass % 2 ? [...cols].reverse() : cols) {
        const key = new Map()
        for (const n of c.nodes) {
          const others = nbrs.get(n.id).filter(m => colOf.get(m) !== c)
          key.set(n.id, others.length ? others.reduce((a, m) => a + pos.get(m), 0) / others.length : pos.get(n.id))
        }
        c.nodes.sort((a, b) => key.get(a.id) - key.get(b.id))
        c.nodes.forEach((n, j) => pos.set(n.id, (j + 0.5) / c.nodes.length))
      }
    }

    const moving = drag && drag.mode === 'node' && drag.moved ? drag.id : null
    for (const c of cols) {
      c.nodes.push(...M.nodes.filter(n => n.ghost && n.layer === c.layer.id))
      c.rel = new Map()
      const taken = []
      for (const n of c.nodes) {
        const p = L.positions[n.id]
        // A spot the canvas pinned in another group is stale: the module moved, and is placed afresh.
        if (!p || (p.layer && p.layer !== c.layer.id)) continue
        // Inside the frame's edge, except while being dragged out of it.
        const r = n.id === moving ? { x: p.x, y: p.y } : { x: Math.max(FRAME.pad, p.x), y: Math.max(FRAME.top, p.y) }
        c.rel.set(n.id, { ...r, w: G.nodeW, h: heightOf(n) })
        if (n.id !== moving) taken.push(c.rel.get(n.id))
      }
      let y = FRAME.top
      for (const n of c.nodes) {
        if (c.rel.has(n.id)) continue
        const r = { x: FRAME.pad, y, w: G.nodeW, h: heightOf(n) }
        for (let clash; (clash = taken.find(b => overlaps(r, b))); ) r.y = clash.y + clash.h + G.gapY
        c.rel.set(n.id, r)
        taken.push(r)
        y = r.y + r.h + G.gapY
      }
      const held = [...taken]
      if (sketch && sketch.rel && sketch.layer === c.layer.id) held.push({ ...sketch.rel, w: G.nodeW, h: G.nodeH })
      let w = FRAME.minW
      let bottom = FRAME.top - G.gapY
      for (const r of held) {
        w = Math.max(w, r.x + r.w + FRAME.pad)
        bottom = Math.max(bottom, r.y + r.h)
      }
      // Room for one more card below the last: a double-click there adds it.
      c.slot = bottom + G.gapY
      const h = c.slot + G.nodeH + FRAME.pad
      c.size = c.folded ? { w: clamp(textW(`${c.layer.name}  ${c.nodes.length}`, 13.5, 650) + 110, 160, 340), h: FRAME.foldH } : { w, h }
    }

    // The default spots: rows left to right, a few frames to a row.
    const perRow = cols.length <= FRAME.perRow ? cols.length : Math.ceil(cols.length / Math.ceil(cols.length / FRAME.perRow))
    let fx = 22
    let fy = 0
    let rowH = 0
    cols.forEach((c, i) => {
      if (i && i % perRow === 0) {
        fx = 22
        fy += rowH + FRAME.gap
        rowH = 0
      }
      c.auto = { x: fx, y: fy }
      fx += c.size.w + FRAME.gap
      rowH = Math.max(rowH, c.size.h)
    })

    for (const c of cols) {
      const o = L.frames[c.layer.id] || c.auto
      c.box = { x: o.x, y: o.y, w: c.size.w, h: c.size.h }
    }
    // Groups never sit on one another. One placed by default, or one another
    // grew into, steps out of the way on the canvas (its saved spot stays):
    // those starting to the right move right, the rest move down. Saved spots
    // go first, top to bottom; a group being dragged stays under the pointer.
    if (!(drag && drag.mode === 'frame' && drag.moved)) {
      const spot = c => L.frames[c.layer.id]
      const order = [...cols].sort((a, b) => (spot(a) ? 0 : 1) - (spot(b) ? 0 : 1) || (spot(a) && spot(b) ? spot(a).y - spot(b).y || spot(a).x - spot(b).x : 0))
      const placed = []
      for (const c of order) {
        for (let guard = 0; guard < 100; guard++) {
          const B = c.box
          const A = placed.find(p => p.x < B.x + B.w && p.x + p.w > B.x && p.y < B.y + B.h && p.y + p.h > B.y)
          if (!A) break
          c.box = B.x >= A.x + 40 ? { ...B, x: snap(A.x + A.w + 40) } : { ...B, y: snap(A.y + A.h + 40) }
        }
        placed.push(c.box)
      }
    }

    const boxes = new Map()
    for (const c of cols) {
      const o = c.box
      // The title, cut to leave room for the count and the arrange button.
      c.title = fit(c.layer.name, c.box.w - (c.folded ? 120 : 150), 13.5, 650)
      c.btn = c.folded ? null : { x: o.x + 42 + textW(c.title, 13.5, 650) + textW(String(c.nodes.length), 12), y: o.y + 17, w: 24, h: 22 }
      if (c.folded) {
        // A folded frame is its title bar; the edges attach to it.
        c.anchor = { ...c.box, key: 'fold:' + c.layer.id }
        for (const n of c.nodes) boxes.set(n.id, c.anchor)
      } else for (const [id, r] of c.rel) boxes.set(id, { x: o.x + r.x, y: o.y + r.y, w: r.w, h: r.h, key: id })
    }
    const home = sketch && sketch.rel && cols.find(x => x.layer.id === sketch.layer)
    if (home) boxes.set(SKETCH, { x: home.box.x + sketch.rel.x, y: home.box.y + sketch.rel.y, w: G.nodeW, h: G.nodeH, key: SKETCH })
    return { cols, boxes }
  }

  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h + 8 && a.y + a.h + 8 > b.y

  // Modules whose code changed after the map last looked at them: id → the
  // files. Data and outside services are left out: new data is not a new map.
  function staleMap() {
    const out = new Map()
    const changed = FT.changed
    if (!changed || !M || !S.graph || !S.graph.drawnAt) return out
    for (const [f, t] of Object.entries(changed)) {
      for (const id of ownersOf(f)) {
        const n = M.byId.get(id)
        if (!n || n.ghost || nodeType(n) === 'data' || nodeType(n) === 'external') continue
        if (t <= (n.seenAt || S.graph.drawnAt) + 1000) continue
        if (!out.has(id)) out.set(id, [])
        out.get(id).push(f)
      }
    }
    return out
  }
  const staleSig = () => JSON.stringify([...staleMap()])

  // What a module reaches along the arrows (downstream) and against them
  // (upstream), as the map draws them, up to `depth` steps: each with how many
  // steps away, and the lines that lead one step further out (a line between
  // two modules equally far is no way out). Proposed lines and 「关联」 lines
  // are not walked.
  function reachOf(id, depth = Infinity) {
    const out = new Map()
    const into = new Map()
    const add = (map, k, v) => (map.get(k) || map.set(k, []).get(k)).push(v)
    for (const e of M.edges) {
      if (e.state === 'add' || e.kind === 'link') continue
      const [a, b] = e.head === 'from' ? [e.to, e.from] : [e.from, e.to]
      add(out, a, [b, e])
      add(into, b, [a, e])
    }
    const walk = next => {
      const dist = new Map([[id, 0]])
      const edges = new Set()
      let ring = [id]
      for (let d = 1; ring.length && d <= depth; d++) {
        const step = []
        for (const x of ring) {
          for (const [y, e] of next.get(x) || []) {
            if (!dist.has(y)) {
              dist.set(y, d)
              step.push(y)
            }
            if (dist.get(y) === d) edges.add(e)
          }
        }
        ring = step
      }
      dist.delete(id)
      return { dist, edges }
    }
    const down = walk(out)
    const up = walk(into)
    return { up: up.dist, down: down.dist, edges: new Set([...up.edges, ...down.edges]) }
  }

  // How far a selected module's reach is lit and listed: the modules it
  // touches, or all the way when the person picks that (kept in the layout).
  const reachDepth = () => (L.reach === 'all' ? Infinity : 1)
  function setReach(all) {
    if (all === (L.reach === 'all')) return
    if (all) L.reach = 'all'
    else delete L.reach
    saveLayout(false)
    draw()
    renderPanel()
  }

  // The (unfolded) frame a point is in, the one drawn on top first.
  function frameAt(p) {
    for (const c of [...(P ? P.cols : [])].reverse()) {
      const b = c.box
      if (!c.folded && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return c
    }
    return null
  }

  // Frames placed by default shift when another changes size or a layer
  // comes or goes; once the person moves things about, each keeps its spot.
  function materializeFrames() {
    for (const c of P ? P.cols : []) if (!L.frames[c.layer.id]) setFrame(c.layer.id, { x: c.box.x, y: c.box.y })
  }

  // ---- edges: from the right side of the caller to the left side of the callee ----

  function bez(p0, p1, p2, p3, t) {
    const u = 1 - t
    return {
      x: u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      y: u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    }
  }

  function route() {
    const list = []
    const seen = new Set()
    for (const e of M.edges) {
      const a = P.boxes.get(e.from)
      const b = P.boxes.get(e.to)
      if (!a || !b || a === b) continue
      const k = `${a.key}>${b.key}>${e.state}`
      if (seen.has(k)) continue
      seen.add(k)
      let sa = 'r'
      let sb = 'l'
      if (b.x >= a.x + a.w + 16) {
        sa = 'r'
        sb = 'l'
      } else if (b.x + b.w <= a.x - 16) {
        sa = 'l'
        sb = 'r'
      } else {
        sa = 'r'
        sb = 'r'
      }
      list.push({ e, a, b, sa, sb, key: `${e.from}>${e.to}` })
    }
    const slots = new Map()
    const put = (box, side, it, end, otherY) => {
      const k = `${box.key}:${side}`
      if (!slots.has(k)) slots.set(k, [])
      slots.get(k).push({ box, it, end, otherY })
    }
    for (const it of list) {
      put(it.a, it.sa, it, 'ay', it.b.y + it.b.h / 2)
      put(it.b, it.sb, it, 'by', it.a.y + it.a.h / 2)
    }
    for (const arr of slots.values()) {
      arr.sort((p, q) => p.otherY - q.otherY)
      const n = arr.length
      const box = arr[0].box
      const span = Math.min(box.h - 18, (n - 1) * 11)
      arr.forEach((slot, i) => {
        slot.it[slot.end] = box.y + box.h / 2 + (n > 1 ? -span / 2 + (span * i) / (n - 1) : 0)
      })
    }
    for (const it of list) {
      const x1 = it.sa === 'r' ? it.a.x + it.a.w : it.a.x
      const x2 = it.sb === 'r' ? it.b.x + it.b.w : it.b.x
      const d1 = it.sa === 'r' ? 1 : -1
      const d2 = it.sb === 'r' ? 1 : -1
      const reach = it.sa === it.sb ? 46 + Math.abs(it.by - it.ay) * 0.12 : Math.max(36, Math.abs(x2 - x1) * 0.45)
      const p0 = [x1, it.ay]
      const p1 = [x1 + d1 * reach, it.ay]
      const p2 = [x2 + d2 * reach, it.by]
      const p3 = [x2, it.by]
      it.d = `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`
      it.pts = []
      for (let i = 0; i <= 24; i++) it.pts.push(bez(p0, p1, p2, p3, i / 24))
      it.mid = bez(p0, p1, p2, p3, 0.5)
    }
    return list
  }

  function distToPts(p, pts) {
    let best = Infinity
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = dx * dx + dy * dy || 1
      const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1)
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
    }
    return best
  }

  // ---- drawing ----

  function draw() {
    const has = Boolean(S.graph)
    $('empty').hidden = has
    $('legend').hidden = !has
    if (!has) {
      M = null
      P = null
      R = []
      scene.replaceChildren()
      renderBar()
      return
    }
    M = build()
    // A main line on show lays the map out as its trunk and branches.
    const line = shownFlow()
    P = line ? trunkPlace(line) : place()
    if (!line) pinNew()
    R = route()
    labelBoxes = []

    const frag = document.createDocumentFragment()
    const lanes = s('g', {}, frag)
    const edgesG = s('g', {}, frag)
    const flowG = s('g', {}, frag)
    const lineG = s('g', {}, frag)
    const labelsG = s('g', {}, frag)
    const nodesG = s('g', {}, frag)
    const top = s('g', {}, frag)

    for (const c of P.cols) {
      const b = c.box
      const moved = drag && drag.mode === 'frame' && drag.moved && drag.layer === c.layer.id
      const g = s('g', { class: 'lane' + (c.folded ? ' lane-folded' : '') + (moved ? ' moving' : '') }, lanes)
      const bg = s('rect', { class: c.folded ? 'card fold-pill' : 'lane-bg', x: b.x, y: b.y, width: b.w, height: b.h, rx: c.folded ? 10 : 14 }, g)
      // A colour the person gave the group tints its frame.
      const tint = L.colors[c.layer.id]
      if (tint) {
        bg.style.stroke = tint
        bg.style.strokeOpacity = '0.6'
        if (!c.folded) {
          bg.style.fill = tint
          bg.style.fillOpacity = '0.09'
        }
      }
      const head = s('g', { class: 'lane-head' }, g)
      const ty = c.folded ? b.y + 25 : b.y + 32
      s('rect', { x: b.x + 16, y: ty - 13, width: 4, height: 16, rx: 2, fill: colorOf(c.layer.id) }, head)
      if (!titleEdit || titleEdit.layer !== c.layer.id) s('text', { class: 'lane-title', x: b.x + 28, y: ty, text: c.title }, head)
      s('text', { class: 'lane-count', x: b.x + 34 + textW(c.title, 13.5, 650), y: ty, text: `${c.nodes.length}` }, head)
      if (c.btn) {
        const bt = s('g', { class: 'lane-btn', transform: `translate(${c.btn.x},${c.btn.y})` }, head)
        s('title', { text: '排列这个分组的模块：横排、竖排或平铺' }, bt)
        s('rect', { width: c.btn.w, height: c.btn.h, rx: 5 }, bt)
        s('path', { d: 'M6.5 6h4v4h-4z M13.5 6h4v4h-4z M6.5 12h4v4h-4z M13.5 12h4v4h-4z' }, bt)
      }
      s('text', { class: 'lane-fold', x: b.x + b.w - 16, y: ty, 'text-anchor': 'end', text: c.folded ? '展开 ›' : '‹ 收起' }, head)
      // The empty slot says what it is for: always in an empty frame, else under the pointer.
      if (!c.folded && !(sketch && sketch.layer === c.layer.id) && (!c.nodes.length || hoverFrame === c.layer.id)) {
        s('rect', { class: 'lane-slot', x: b.x + FRAME.pad, y: b.y + c.slot, width: G.nodeW, height: G.nodeH, rx: 10 }, g)
        s('text', { class: 'lane-empty', x: b.x + FRAME.pad + G.nodeW / 2, y: b.y + c.slot + G.nodeH / 2 + 4, 'text-anchor': 'middle', text: '双击这里新增模块' }, g)
      }
    }

    const dragging = drag && drag.mode === 'node' && drag.moved ? drag.id : null
    const focus = dragging || hover || selected
    // A file open in the panel lights up the modules it belongs to.
    const owning = fileSel && !selected ? new Set(ownersOf(fileSel)) : null
    // An entry picked in the work log lights up the modules it touched.
    const picked = workView && workPick && !selected && !fileSel ? workEntry(workPick) : null
    const working = picked && picked.nodeIds.length ? new Set(picked.nodeIds) : null
    const near = new Set()
    if (selected) {
      near.add(selected)
      for (const e of M.edges) {
        if (e.from === selected) near.add(e.to)
        if (e.to === selected) near.add(e.from)
      }
    }
    // The selected module's upstream and downstream, while nothing else is
    // pointed at: the modules it touches, or all the way when the person asked.
    const trace = selected && focus === selected ? reachOf(selected, reachDepth()) : null
    // A line pointed at while a module is selected stands out; the rest fade,
    // and only its words show.
    const lineFocus = selected && hoverEdge ? R.find(it => it.key === hoverEdge) : null
    const ends = lineFocus ? new Set([lineFocus.e.from, lineFocus.e.to, selected]) : null
    // Many lines lit at once: their words show one at a time, under the pointer.
    const litCount = focus ? R.filter(it => it.e.from === focus || it.e.to === focus || (trace && trace.edges.has(it.e))).length : 0
    const wordy = litCount <= 8
    const stale = staleMap()
    // In the trunk view the trunk itself says how its modules follow one
    // another: lines between two of them show only for the module pointed at.
    const spine = P.onSpine || null
    for (const area of P.areas || []) s('text', { class: 'area-label', x: area.x, y: area.y, text: area.label }, lanes)
    if (P.spine && P.spine.length > 1) {
      const pts = P.spine.map(id => P.boxes.get(id))
      const y = pts[0].y + G.nodeH / 2
      const last = pts[pts.length - 1]
      s('path', { class: 'trunk-bar', d: `M${pts[0].x},${y} L${last.x + last.w},${y}` }, lineG)
      for (let i = 1; i < pts.length; i++) s('path', { class: 'trunk-step', d: `M${pts[i - 1].x + pts[i - 1].w},${y} L${pts[i].x},${y}`, 'marker-end': 'url(#m-hot)' }, lineG)
    }

    for (const it of R) {
      const e = it.e
      const hot = Boolean(focus && (e.from === focus || e.to === focus))
      if (spine && spine.has(e.from) && spine.has(e.to) && !hot) continue
      const onPath = Boolean(trace && trace.edges.has(e))
      const over = hoverEdge === it.key
      let cls = 'edge'
      if (e.state === 'add') cls += ' add'
      else if (e.state === 'remove') cls += ' remove'
      else if (hot) cls += ' hot'
      else if (onPath) cls += ' path'
      else if (focus) cls += ' dim'
      else if (working && !(working.has(e.from) && working.has(e.to))) cls += ' dim'
      else if (e.hub) cls += ' hub'
      if (over) cls += ' hover'
      else if (lineFocus) cls += ' faded'
      if (e.unsure && e.state === 'normal') cls += ' unsure'
      if (e.nocode && e.state === 'normal') cls += ' nocode'
      cls += ` k-${e.kind}`
      const marker =
        e.state === 'add' ? 'm-add' : e.state === 'remove' ? 'm-remove' : e.kind === 'read' ? 'm-read' : e.kind === 'write' ? 'm-write' : hot || onPath ? 'm-hot' : 'm-edge'
      s('path', { class: cls, d: it.d, [e.head === 'from' ? 'marker-start' : 'marker-end']: `url(#${marker})` }, edgesG)
      const quiet = (e.hub && !hot && !onPath) || (lineFocus && !over)
      if (flow && e.state !== 'remove' && !quiet && (!focus || hot || onPath || e.state === 'add')) {
        s('path', { class: `flow k-${e.kind}` + (e.state === 'add' ? ' add' : hot ? ' hot' : '') + (e.head === 'from' ? ' rev' : ''), d: it.d }, flowG)
      }
      const said = [e.kind === 'call' ? e.label : `${KIND_WORD[e.kind]}${e.label ? ` · ${e.label}` : ''}`, ...edgeNotes(e)].filter(Boolean).join(' · ')
      if ((over || (hot && wordy && !lineFocus)) && said) {
        const text = fit(said, 170, 11.5)
        const w = textW(text, 11.5) + 14
        const g = s('g', { class: 'edge-label', transform: `translate(${it.mid.x - w / 2},${it.mid.y - 10})` }, labelsG)
        s('rect', { width: w, height: 20, rx: 6 }, g)
        s('text', { x: 7, y: 14, text }, g)
        labelBoxes.push({ x: it.mid.x - w / 2, y: it.mid.y - 10, w, h: 20, item: it })
      }
    }

    const order = [...M.nodes].sort((a, b) => (a.id === dragging) - (b.id === dragging))
    for (const n of order) {
      const b = P.boxes.get(n.id)
      if (!b || b.key !== n.id) continue
      const removing = M.removing.has(n.id)
      const target = (drag && drag.mode === 'wire' && drag.target === n.id) || (connectFrom && pointer && pointer.target === n.id)
      let cls = 'node'
      if (n.ghost) cls += ' ghost'
      if (removing) cls += ' removing'
      if (selected === n.id) cls += ' selected'
      if (hover === n.id) cls += ' hover'
      if (dragging === n.id) cls += ' dragging'
      if (target) cls += ' target'
      if (selected && !near.has(n.id)) cls += trace && (trace.up.has(n.id) || trace.down.has(n.id)) ? ' far' : ' dim'
      else if (ends && !ends.has(n.id)) cls += ' far'
      if (owning) cls += owning.has(n.id) ? ' owner' : ' dim'
      if (working) cls += working.has(n.id) ? ' owner' : ' dim'
      if (spine && spine.has(n.id)) cls += ' on-line'
      const pz = nodePulse.get(n.id)
      const done = pz && pz.until > Date.now() && pz.kind === 'done'
      if (pz && pz.until > Date.now()) cls += ` pulse-${pz.kind}`
      const run = M.running.get(n.id)
      if (run) cls += ` run-${run}`
      if (editor && editor.id === n.id) cls += ' editing'
      const type = nodeType(n)
      cls += ` t-${type}`
      const g = s('g', { class: cls, transform: `translate(${b.x},${b.y})` }, nodesG)
      s('rect', { class: 'card', width: b.w, height: b.h, rx: 10 }, g)
      if (!n.ghost && !removing) {
        s('rect', { class: 'stripe', x: 0.5, y: 12, width: 3, height: 22, rx: 1.5, fill: colorOf(n.layer) }, g)
      }
      typeIcon(type, g, 14, 15)
      const locked = isSensitiveNode(n)
      if (locked) lockIcon(g, b.w - 30, 16)
      s('text', { class: 'name', x: 36, y: 27, text: fit((n.ghost ? '+ ' : '') + n.name, b.w - 50 - (locked ? 16 : 0), 14, 650) }, g)

      const changes = M.changes.get(n.id) || []
      const files = new Set(changes.map(c => c.file)).size
      const right = files ? `${files} 个文件变更` : ''
      const rightW = right ? textW(right, 12) + 10 : 0
      let mx = 16
      if (n.ghost || removing) {
        const label = n.ghost ? '待新增' : '待删除'
        const tw = textW(label, 11, 600) + 12
        const tag = s('g', { class: 'tag ' + (n.ghost ? 'add' : 'remove'), transform: 'translate(16,35)' }, g)
        s('rect', { width: tw, height: 18 }, tag)
        s('text', { x: 6, y: 13, text: label }, tag)
        mx += tw + 8
      }
      const meta = [n.ghost || removing ? null : TYPE_LABEL[type], n.kind, n.ghost ? layerName(n.layer) : filesLabel(n)].filter(Boolean).join(' · ')
      s('text', { class: 'meta', x: mx, y: 48, text: fit(meta, b.w - mx - 14 - rightW, 12) }, g)
      if (right) s('text', { class: 'changes', x: b.w - 14, y: 48, 'text-anchor': 'end', text: right }, g)

      if (b.h > G.nodeH) {
        const { summary, files: list } = cardLines(n)
        s('line', { class: 'divider', x1: 14, x2: b.w - 14, y1: G.nodeH - 4, y2: G.nodeH - 4 }, g)
        let y = G.nodeH + 14
        for (const line of summary) {
          s('text', { class: 'summary', x: 16, y, text: line }, g)
          y += 18
        }
        if (summary.length && list.length) y += 8
        for (const f of list) {
          s('text', { class: 'file', x: 16, y: y - 1, text: f }, g)
          y += 17
        }
      }

      const badge = (M.todo.get(n.id) || []).filter(t => t.kind !== 'add-node' && t.kind !== 'remove-node').length
      if (badge) {
        const bg = s('g', { class: 'badge', transform: `translate(${b.w - 4},4)` }, g)
        s('title', { text: `给 ${AGENT} 的提议 ${badge} 条` }, bg)
        s('circle', { r: 10 }, bg)
        s('text', { x: 0, y: 4, 'text-anchor': 'middle', text: String(badge) }, bg)
      }
      const tests = M.tests.get(n.id) || 0
      if (tests) {
        const tg = s('g', { class: 'badge test', transform: 'translate(4,4)' }, g)
        s('title', { text: `${AGENT} 请你测试 ${tests} 项` }, tg)
        s('circle', { r: 10 }, tg)
        s('text', { x: 0, y: 4, 'text-anchor': 'middle', text: String(tests) }, tg)
      }
      // Above the card, on the left: its code changed after the map last looked.
      if (stale.has(n.id)) {
        const label = '可能过时'
        const sg = s('g', { class: 'stale-tag', transform: 'translate(18,-10)' }, g)
        s('title', { text: `画好架构图以后改过：${stale.get(n.id).slice(0, 5).join('、')}${stale.get(n.id).length > 5 ? ' 等' : ''}` }, sg)
        s('rect', { width: textW(label, 11, 600) + 14, height: 18, rx: 9 }, sg)
        s('text', { x: 7, y: 13, text: label }, sg)
      }
      // Above the card: the agent is on it, it waits its turn, or it just got done.
      const flag = run === 'working' ? `${AGENT} 实施中` : run === 'stale' ? `${AGENT} 上次没做完` : run === 'queued' ? '排队中' : done ? '✓ 已完成' : ''
      if (flag) {
        const tw = textW(flag, 11, 600) + (run ? 24 : 14)
        const fg = s('g', { class: `run-tag ${run || 'done'}`, transform: `translate(${b.w - tw - 18},-10)` }, g)
        s('rect', { width: tw, height: 18, rx: 9 }, fg)
        if (run) s('circle', { cx: 10.5, cy: 9, r: 3.2 }, fg)
        s('text', { x: run ? 18 : 7, y: 13, text: flag }, fg)
      }
      // On the bottom-left corner (the trunk enters by the left edge): where this module comes in the main line.
      const nos = line && line.at.get(n.id)
      if (nos) {
        const text = nos.length > 3 ? `${nos.slice(0, 3).join('·')}…` : nos.join('·')
        const tw = textW(text, 11.5, 700) + 14
        const sg = s('g', { class: 'step-badge', transform: `translate(-8,${b.h - 10})` }, g)
        s('title', { text: `主线「${line.flow.name}」第 ${nos.join('、')} 步` }, sg)
        s('rect', { width: tw, height: 20, rx: 10 }, sg)
        s('text', { x: tw / 2, y: 14, 'text-anchor': 'middle', text }, sg)
      }
      const wiring = (drag && drag.mode === 'wire' && drag.from === n.id) || connectFrom === n.id || (sketch && sketch.usedBy === n.id)
      if ((hover === n.id && canWireFrom(n.id) && !drag) || wiring) s('circle', { class: 'port', cx: b.w, cy: b.h / 2, r: 5.5 }, g)
    }

    // The new card, where it will land.
    if (sketch && P.boxes.has(SKETCH)) {
      const b = P.boxes.get(SKETCH)
      const g = s('g', { class: `node ghost sketch t-${sketch.type}${Date.now() - sketch.born < 300 ? ' fresh' : ''}`, transform: `translate(${b.x},${b.y})` }, nodesG)
      s('rect', { class: 'card', width: b.w, height: b.h, rx: 10 }, g)
      typeIcon(sketch.type, g, 14, 15)
      if (sketch.type === 'data') lockIcon(g, b.w - 30, 16)
      if (sketch.sent) s('text', { class: 'name', x: 36, y: 27, text: fit('+ ' + sketch.name, b.w - 66, 14, 650) }, g)
      const tw = textW('新建', 11, 600) + 12
      const tag = s('g', { class: 'tag add', transform: 'translate(16,35)' }, g)
      s('rect', { width: tw, height: 18 }, tag)
      s('text', { x: 6, y: 13, text: '新建' }, tag)
      s('text', { class: 'meta', x: 24 + tw, y: 48, text: fit(`${TYPE_LABEL[sketch.type]} · ${layerName(sketch.layer)}`, b.w - 40 - tw, 12) }, g)
    }

    // The dependency being drawn, from the port to the pointer or the target,
    // or into the new card the module is to call.
    const from = drag && drag.mode === 'wire' ? drag.from : connectFrom || (sketch && sketch.usedBy)
    const at = drag && drag.mode === 'wire' ? drag : connectFrom ? pointer : sketch && sketch.usedBy ? { target: SKETCH } : null
    if (from && at && (at.p || at.target)) {
      const a = P.boxes.get(from)
      const tb = at.target ? P.boxes.get(at.target) : null
      const x1 = a.x + a.w
      const y1 = a.y + a.h / 2
      const x2 = tb ? (tb.x >= x1 ? tb.x : tb.x + tb.w) : at.p.x
      const y2 = tb ? tb.y + tb.h / 2 : at.p.y
      const reach = Math.max(40, Math.abs(x2 - x1) * 0.45)
      const back = tb && tb.x < x1 ? 1 : -1
      s('path', { class: 'wire', d: `M${x1},${y1} C${x1 + reach},${y1} ${x2 + back * reach},${y2} ${x2},${y2}`, 'marker-end': 'url(#m-add)' }, top)
    }

    scene.replaceChildren(frag)
    applyView()
    renderBar()
    if (editor && editor.kind !== 'new' && !M.byId.has(editor.id)) closeEditor(false)
  }

  function applyView() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`)
    const step = 24 * view.k * (gridEl.className === 'lines' ? 2 : 1)
    gridEl.style.backgroundSize = `${step}px ${step}px`
    gridEl.style.backgroundPosition = `${view.x}px ${view.y}px`
    $('zoom-reset').textContent = `${Math.round(view.k * 100)}%`
    placeOverlays()
    keepView()
  }

  // Where the person was looking, kept with the project's layout a moment
  // after they stop moving; the trunk view is a look of its own, not kept.
  function keepView() {
    if (mainFlow || !fitted) return
    clearTimeout(viewTimer)
    viewTimer = setTimeout(() => {
      if (mainFlow) return
      L.view = { x: view.x, y: view.y, k: view.k }
      saveLayout(false)
    }, 800)
  }

  function renderBar() {
    const g = S.graph
    $('title').textContent = g ? g.title || S.project : S.project || '架构画布'
    document.title = `${g ? g.title || S.project : S.project} · 架构画布`
    $('stats').textContent = g ? `${g.layers.length} 个分组 · ${g.nodes.length} 个模块 · ${g.edges.length} 条连线` : ''
    const open = M ? M.tasks : []
    const draftsN = open.filter(t => t.status === 'draft').length
    const pending = $('pending')
    pending.hidden = !open.length
    pending.textContent = draftsN
      ? `给 ${AGENT} 的提议 ${open.length}`
      : open.some(t => t.status === 'working')
        ? `${AGENT} 正在做 ${open.length}`
        : `已交给 ${AGENT} ${open.length}`
    $('next-pill').hidden = !(S.pending && S.pending.graph)
    const hand = $('handover')
    hand.hidden = !draftsN
    hand.textContent = `交给 ${AGENT} 实施（${draftsN}）`
    const shown = mainFlow && g && (g.flows || []).find(f => f.id === mainFlow)
    const mb = $('mainline-btn')
    mb.hidden = !g
    mb.classList.toggle('on', Boolean(shown))
    mb.textContent = shown ? `主线：${shown.name}` : '主线'
    const wb = $('worklog-btn')
    wb.hidden = !g
    wb.classList.toggle('on', workView)
    const tests = checksOf(S).filter(c => c.status === 'open').length
    const pill = $('checks-pill')
    pill.hidden = !tests
    pill.textContent = `${AGENT} 请你测试 ${tests}`
    $('bar').classList.toggle('no-graph', !g)
  }

  function renderLegend() {
    const item = (cls, label) => h('span', {}, h('i', { class: cls }), label)
    const mini = Boolean(LOOK.legendMini)
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'lg-toggle',
        title: mini ? '展开图例' : '收起图例',
        onclick: () => keepUi({ legendMini: !mini }),
      },
      mini ? '图例' : '收起',
    )
    $('legend').classList.toggle('mini', mini)
    if (mini) return $('legend').replaceChildren(toggle)
    $('legend').replaceChildren(
      item('solid k-call', '调用'),
      item('solid k-read', '读取（箭头指向读它的模块）'),
      item('solid k-write', '生成（箭头指向生成的资料）'),
      item('k-flow', '数据流'),
      item('box k-add', '待新增'),
      item('box k-remove', '待删除'),
      item('box k-run', '实施中'),
      item('k-add', '待新增连线'),
      item('k-remove', '待去掉连线'),
      item('k-unsure', '未确认（没找到代码依据）'),
      item('k-nocode', '代码里没找到这条调用'),
      item('k-hub', `连向公共模块的线（被 ${HUB_CALLERS} 个以上模块调用，已淡化）`),
      item('k-mainline', '主线（树干，按执行先后从左往右）'),
      item('k-stale', '可能过时（画好图后代码改过）'),
      item('dotc k-todo', `给 ${AGENT} 的提议`),
      item('dotc k-test', `${AGENT} 请你测试`),
      toggle,
    )
  }

  // ---- view ----

  function world(ev) {
    const r = svg.getBoundingClientRect()
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k }
  }

  function bounds() {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const add = b => {
      x0 = Math.min(x0, b.x)
      y0 = Math.min(y0, b.y)
      x1 = Math.max(x1, b.x + b.w)
      y1 = Math.max(y1, b.y + b.h)
    }
    for (const c of P.cols) add(c.box)
    for (const b of P.boxes.values()) add(b)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  function fitView() {
    if (!P) return
    const b = bounds()
    const W = svg.clientWidth
    const H = svg.clientHeight
    if (!W || !H) return
    view.k = clamp(Math.min((W - 64) / b.w, (H - 110) / b.h), 0.25, 1.25)
    // Too wide even at the smallest: the start in view, the rest a pan away.
    view.x = b.w * view.k > W - 64 ? 32 - b.x * view.k : (W - b.w * view.k) / 2 - b.x * view.k
    view.y = (H - 50 - b.h * view.k) / 2 - b.y * view.k + 6
    applyView()
  }
  // Some modules brought into view together and flashed: left where they are
  // when all are on screen already; else centred, zoomed out just enough to
  // show them all (or in, up to 90%, from far out). Says whether any is on the map.
  function bringIntoView(ids) {
    const shown = [...new Set(ids)].filter(id => P && P.boxes.has(id))
    if (!shown.length) return false
    const boxes = shown.map(id => P.boxes.get(id))
    const W = svg.clientWidth
    const H = svg.clientHeight
    for (const id of shown) nodePulse.set(id, { kind: 'found', until: Date.now() + 1600 })
    if (!W || !H) return draw(), true
    const onScreen = b => {
      const l = view.x + b.x * view.k
      const t = view.y + b.y * view.k
      return l >= 8 && t >= 8 && l + b.w * view.k <= W - 8 && t + b.h * view.k <= H - 60
    }
    if (boxes.every(onScreen)) return draw(), true
    const x0 = Math.min(...boxes.map(b => b.x))
    const y0 = Math.min(...boxes.map(b => b.y))
    const x1 = Math.max(...boxes.map(b => b.x + b.w))
    const y1 = Math.max(...boxes.map(b => b.y + b.h))
    const fits = Math.min((W - 80) / (x1 - x0), (H - 130) / (y1 - y0))
    view.k = fits >= view.k ? (view.k < 0.5 ? Math.min(fits, 0.9) : view.k) : clamp(fits, 0.2, view.k)
    view.x = W / 2 - ((x0 + x1) / 2) * view.k
    view.y = (H - 50) / 2 - ((y0 + y1) / 2) * view.k
    applyView()
    draw()
    return true
  }

  // The trunk view opens on the start of the trunk, as large as its height allows.
  function fitStart() {
    if (!P) return
    const b = bounds()
    const W = svg.clientWidth
    const H = svg.clientHeight
    if (!W || !H) return
    view.k = clamp((H - 110) / b.h, 0.25, 0.9)
    view.x = b.w * view.k > W - 64 ? 40 - b.x * view.k : (W - b.w * view.k) / 2 - b.x * view.k
    view.y = (H - 50 - b.h * view.k) / 2 - b.y * view.k + 6
    applyView()
  }

  function zoomAt(cx, cy, factor) {
    const k = clamp(view.k * factor, 0.2, 2.5)
    view.x = cx - ((cx - view.x) * k) / view.k
    view.y = cy - ((cy - view.y) * k) / view.k
    view.k = k
    applyView()
  }
  const zoomCenter = factor => zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, factor)

  // ---- hit testing, in graph coordinates ----

  function hit(p) {
    if (!P) return null
    const sk = sketch && !sketch.sent && P.boxes.get(SKETCH)
    if (sk && p.x >= sk.x && p.x <= sk.x + sk.w && p.y >= sk.y && p.y <= sk.y + sk.h) return { type: 'sketch' }
    // A port answers whether or not its card was hovered first (touch, a quick press).
    const order = [...M.nodes].reverse()
    const reach = 9 / Math.min(1, view.k)
    for (const n of hover ? [M.byId.get(hover), ...order] : order) {
      const b = n && P.boxes.get(n.id)
      if (b && b.key === n.id && canWireFrom(n.id) && Math.hypot(p.x - (b.x + b.w), p.y - (b.y + b.h / 2)) <= reach) return { type: 'port', id: n.id }
    }
    // A label on show sits above the cards: pressing it takes its line.
    for (const l of labelBoxes) if (p.x >= l.x && p.x <= l.x + l.w && p.y >= l.y && p.y <= l.y + l.h) return { type: 'edge', item: l.item }
    for (const n of order) {
      const b = P.boxes.get(n.id)
      if (b && b.key === n.id && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { type: 'node', id: n.id }
    }
    // Frame titles, the top one first: the fold switch at the right end, the
    // rest a handle to drag the frame by.
    for (const c of [...P.cols].reverse()) {
      const b = c.box
      if (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + (c.folded ? b.h : G.headH - 6)) continue
      const k = c.btn
      if (k && p.x >= k.x && p.x <= k.x + k.w && p.y >= k.y && p.y <= k.y + k.h) return { type: 'arrange', layer: c.layer }
      return { type: p.x >= b.x + b.w - 74 ? 'fold' : 'head', layer: c.layer }
    }
    // A frame's empty slot takes a press before an edge crossing it.
    for (const c of [...P.cols].reverse()) {
      if (c.folded) continue
      const x = c.box.x + FRAME.pad
      const y = c.box.y + c.slot
      if (p.x >= x && p.x <= x + G.nodeW && p.y >= y && p.y <= y + G.nodeH) return { type: 'lane', layer: c.layer }
    }
    // Lines are thin: they take the pointer from a few pixels either side.
    let best = null
    let bd = 11 / view.k
    for (const it of R) {
      const d = distToPts(p, it.pts)
      if (d < bd) {
        bd = d
        best = it
      }
    }
    if (best) return { type: 'edge', item: best }
    const c = frameAt(p)
    return c ? { type: 'lane', layer: c.layer } : null
  }

  function updateHover(p) {
    const t = hit(p)
    const nh = t && (t.type === 'node' || t.type === 'port') ? t.id : null
    const eh = t && t.type === 'edge' ? t.item.key : null
    const fh = t && (t.type === 'lane' || t.type === 'node' || t.type === 'port') ? (t.type === 'lane' ? t.layer.id : M.byId.get(t.id).layer) : null
    svg.classList.toggle('over-node', Boolean(t && (t.type === 'node' || t.type === 'fold' || t.type === 'arrange')))
    svg.classList.toggle('over-head', Boolean(t && t.type === 'head'))
    svg.classList.toggle('over-port', Boolean(t && t.type === 'port'))
    if (connectFrom) {
      const target = t && t.type === 'node' && canWireTo(connectFrom, t.id) ? t.id : null
      pointer = { p, target }
      draw()
      return
    }
    if (nh !== hover || eh !== hoverEdge || fh !== hoverFrame) {
      hover = nh
      hoverEdge = eh
      hoverFrame = fh
      draw()
    }
  }

  // ---- pointer ----

  svg.addEventListener('pointerdown', ev => {
    closeMenu()
    if (titleEdit) endRename(true)
    const p = S.graph ? world(ev) : null
    let t = p ? hit(p) : null
    // A press on the new card goes back to its name.
    if (t && t.type === 'sketch') {
      ev.preventDefault()
      return sketchName.focus({ preventScroll: true })
    }
    if (editor) {
      closeEditor()
      t = p ? hit(p) : null
    }
    if (ev.button === 2 || !S.graph) return
    if (connectFrom) {
      const from = connectFrom
      endConnect()
      // A module to call, or empty space: a new module there for it to call.
      if (t && t.type === 'node') {
        if (canWireTo(from, t.id)) link(from, t.id)
      } else if ((!t || t.type === 'lane') && !M.byId.get(from).ghost) {
        ev.preventDefault()
        P.spine ? trunkNew(ev.clientX, ev.clientY, from) : openSketch(ev.clientX, ev.clientY, { usedBy: from })
      }
      return
    }
    svg.setPointerCapture(ev.pointerId)
    if (ev.button === 1 || !t || t.type === 'lane' || t.type === 'edge') {
      drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false, t }
    } else if (t.type === 'port') {
      drag = { mode: 'wire', from: t.id, p, target: null }
      svg.classList.add('connecting')
      draw()
    } else if (t.type === 'node') {
      const b = P.boxes.get(t.id)
      // The trunk view places every card itself: a press there only picks.
      drag = { mode: 'node', id: t.id, sx: p.x, sy: p.y, ox: b.x, oy: b.y, was: L.positions[t.id], moved: false, fixed: Boolean(P.spine) }
    } else if (t.type === 'head') {
      const b = P.cols.find(c => c.layer.id === t.layer.id).box
      drag = { mode: 'frame', layer: t.layer.id, sx: p.x, sy: p.y, ox: b.x, oy: b.y, moved: false }
    } else if (t.type === 'arrange') {
      // The menu opens when the press ends, so this press does not close it.
      drag = { mode: 'arrange', layer: t.layer.id }
    } else if (t.type === 'fold') {
      drag = null
      toggleFold(t.layer.id)
    }
  })

  svg.addEventListener('pointermove', ev => {
    if (!S.graph) return
    const p = world(ev)
    if (!drag) return updateHover(p)
    if (drag.mode === 'pan') {
      const dx = ev.clientX - drag.sx
      const dy = ev.clientY - drag.sy
      if (!drag.moved && Math.hypot(dx, dy) < 3) return
      drag.moved = true
      svg.classList.add('panning')
      view.x = drag.vx + dx
      view.y = drag.vy + dy
      applyView()
    } else if (drag.mode === 'node') {
      if (drag.fixed) return
      const dx = p.x - drag.sx
      const dy = p.y - drag.sy
      if (!drag.moved && Math.hypot(dx, dy) * view.k < 4) return
      drag.moved = true
      svg.classList.add('dragging')
      // Kept relative to its frame, which holds still meanwhile.
      const o = P.cols.find(c => c.layer.id === M.byId.get(drag.id).layer).box
      L.positions[drag.id] = { x: snap(drag.ox + dx - o.x), y: snap(drag.oy + dy - o.y) }
      draw()
    } else if (drag.mode === 'frame') {
      const dx = p.x - drag.sx
      const dy = p.y - drag.sy
      if (!drag.moved && Math.hypot(dx, dy) * view.k < 4) return
      if (!drag.moved) materializeFrames()
      drag.moved = true
      svg.classList.add('dragging')
      setFrame(drag.layer, { x: snap(drag.ox + dx), y: snap(drag.oy + dy) })
      draw()
    } else if (drag.mode === 'wire') {
      const t = hit(p)
      drag.p = p
      drag.target = t && t.type === 'node' && canWireTo(drag.from, t.id) ? t.id : null
      draw()
    }
  })

  // A click redraws the scene, so the browser's dblclick (which wants both
  // clicks on one element) never comes: count the second click here.
  let lastClick = { at: 0, what: null }
  function second(what) {
    const now = performance.now()
    const is = lastClick.what === what && now - lastClick.at < 400
    lastClick = is ? { at: 0, what: null } : { at: now, what }
    return is
  }

  function endDrag(ev, cancelled) {
    const d = drag
    drag = null
    svg.classList.remove('panning', 'dragging', 'connecting')
    if (!d) return
    if (d.mode === 'pan' && !d.moved && !cancelled) {
      if (d.t && d.t.type === 'edge') edgeMenu(d.t.item, ev.clientX, ev.clientY)
      else if (second('canvas')) P.spine ? trunkNew(ev.clientX, ev.clientY) : frameAt(world(ev)) ? openSketch(ev.clientX, ev.clientY) : newFrame(ev.clientX, ev.clientY)
      else select(null)
    } else if (d.mode === 'arrange') {
      if (!cancelled) arrangeMenu(d.layer, ev.clientX, ev.clientY)
    } else if (d.mode === 'frame') {
      if (d.moved) {
        pushFrames(d.layer)
        saveLayout()
      }
      else if (!cancelled && second('head:' + d.layer)) renameFrame(d.layer)
      draw()
    } else if (d.mode === 'node') {
      if (d.moved) {
        dropCard(d)
        saveLayout()
      } else if (!cancelled) {
        // A second click opens a card: a draft for editing, a module to read.
        if (second(d.id)) isDraft(M.byId.get(d.id)) ? openEditor(d.id) : toggleExpand(d.id)
        else select(d.id)
      }
      draw()
    } else if (d.mode === 'wire') {
      // Where the pointer came up decides, whatever the moves before said.
      const p = world(ev)
      const t = cancelled ? null : hit(p)
      const to = t && t.type === 'node' && canWireTo(d.from, t.id) ? t.id : null
      const b = P.boxes.get(d.from)
      const far = b && Math.hypot(p.x - (b.x + b.w), p.y - (b.y + b.h / 2)) * view.k > 28
      if (to) link(d.from, to)
      // Let go on empty space: a new module there, for this one to call.
      else if (!cancelled && far && (!t || t.type === 'lane') && !M.byId.get(d.from).ghost) {
        P.spine ? trunkNew(ev.clientX, ev.clientY, d.from) : openSketch(ev.clientX, ev.clientY, { usedBy: d.from })
      }
      draw()
    }
  }

  // Where a dragged card is let go. In another frame it changes layer: a
  // draft's proposal changes, a module moves at once (the map's own grouping;
  // no code moves). In its own frame, or just past its edge, it stays and the
  // frame grows. Out on the empty canvas it goes back.
  function dropCard(d) {
    const n = M.byId.get(d.id)
    const b = P.boxes.get(d.id)
    if (!n || !b) return
    const own = P.cols.find(c => c.layer.id === n.layer)
    const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const into = frameAt(mid)
    const back = () => {
      delete unsavedPos[d.id]
      if (d.was) L.positions[d.id] = d.was
      else delete L.positions[d.id]
    }
    if (into && into !== own) {
      if (n.ghost && !isDraft(n)) return back()
      return moveInto(n, into, freeSpot(into, { x: b.x - into.box.x, y: b.y - into.box.y }, d.id, b.h))
    }
    const ob = own.box
    if (into === own || (mid.x > ob.x - 40 && mid.x < ob.x + ob.w + G.nodeW / 2 && mid.y > ob.y - 40 && mid.y < ob.y + ob.h + G.nodeH)) {
      const rel = freeSpot(own, L.positions[d.id], d.id, b.h)
      // The frame may grow to hold it, but not over another frame.
      const card = { x: ob.x + rel.x - FRAME.pad, y: ob.y + rel.y - FRAME.pad, w: b.w + 2 * FRAME.pad, h: b.h + 2 * FRAME.pad }
      const hit = P.cols.find(c => c !== own && !c.folded && card.x < c.box.x + c.box.w && card.x + card.w > c.box.x && card.y < c.box.y + c.box.h && card.y + card.h > c.box.y)
      if (!hit) return setPos(d.id, rel)
      back()
      return toast(`放在这里会盖住分组「${hit.layer.name}」：先把分组拖开一点，或者干脆拖进「${hit.layer.name}」。`)
    }
    back()
    toast('分组外的空白处放不了模块：要换分组，就拖进别的分组；要挪远一点，拖动整个分组。')
  }

  // A module (or draft) into another group, at `rel` there: a draft's
  // proposal changes, a module moves at once (the map's own grouping).
  function moveInto(n, into, rel) {
    setPos(n.id, rel)
    const layer = into.layer.id
    movedTo.set(n.id, layer)
    if (n.ghost) editDraft(n.task.id, { layer })
    else propose({ type: 'move-node', nodeId: n.id, layer })
    // Refused (the server says why): back to the group the server has.
    setTimeout(() => {
      if (movedTo.get(n.id) !== layer) return
      movedTo.delete(n.id)
      draw()
    }, 8000)
  }

  // From the menu: into the group's empty slot, the group opened if folded.
  function moveToGroup(id, layerId) {
    const n = M.byId.get(id)
    if (!n) return
    if (L.collapsed.includes(layerId)) {
      L.collapsed = L.collapsed.filter(x => x !== layerId)
      saveLayout()
      draw()
    }
    const into = P.cols.find(c => c.layer.id === layerId)
    if (!into) return
    moveInto(n, into, freeSpot(into, { x: FRAME.pad, y: into.slot }, id, heightOf(n)))
    saveLayout()
    draw()
  }

  // A wire from one to the other: a new dependency between modules, or the
  // wiring of a draft.
  function link(from, to) {
    const a = M.byId.get(from)
    const b = M.byId.get(to)
    if (a.ghost) return editDraft(a.task.id, { dependsOn: [...a.task.nodeIds.filter(x => x !== to), to] })
    if (b.ghost) return editDraft(b.task.id, { usedBy: [...(b.task.usedBy || []).filter(x => x !== from), from] })
    propose({ type: 'add-edge', from, to })
  }
  const editDraft = (taskId, change) => propose({ type: 'edit-add-node', taskId, ...change })
  svg.addEventListener('pointerup', ev => endDrag(ev, false))
  svg.addEventListener('pointercancel', ev => endDrag(ev, true))
  svg.addEventListener('pointerleave', () => {
    if (!drag && (hover || hoverEdge || hoverFrame) && !connectFrom) {
      hover = null
      hoverEdge = null
      hoverFrame = null
      draw()
    }
  })

  svg.addEventListener(
    'wheel',
    ev => {
      ev.preventDefault()
      closeMenu()
      const r = svg.getBoundingClientRect()
      const unit = ev.deltaMode === 1 ? 18 : ev.deltaMode === 2 ? 300 : 1
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * unit * 0.0016))
    },
    { passive: false },
  )

  svg.addEventListener('contextmenu', ev => {
    ev.preventDefault()
    if (!S.graph) return
    endConnect()
    const t = hit(world(ev))
    if (t && t.type === 'sketch') return
    if (t && (t.type === 'node' || t.type === 'port')) nodeMenu(t.id, ev.clientX, ev.clientY)
    else if (t && t.type === 'edge') edgeMenu(t.item, ev.clientX, ev.clientY)
    else if (t && (t.type === 'lane' || t.type === 'fold' || t.type === 'head' || t.type === 'arrange')) laneMenu(t.layer, ev.clientX, ev.clientY)
    else canvasMenu(ev.clientX, ev.clientY)
  })

  // ---- what the person does ----

  function select(id) {
    selected = id
    if (id) {
      fileSel = null
      fileView = null
    }
    draw()
    renderPanel()
    renderFiles(id ? 'reveal' : undefined)
    if (id && panel.classList.contains('closed')) togglePanel()
  }

  // A module brought into view near full size, selected and flashed: from the search.
  function focusNode(id) {
    const n = M && M.byId.get(id)
    if (!n) return
    if (L.collapsed.includes(n.layer)) {
      L.collapsed = L.collapsed.filter(x => x !== n.layer)
      saveLayout()
    }
    nodePulse.set(id, { kind: 'found', until: Date.now() + 1600 })
    select(id)
    centreOn(id)
  }
  // The canvas moved to a module, without choosing it: a main line's step stays in the panel.
  function showStep(id) {
    if (!M || !M.byId.has(id)) return
    nodePulse.set(id, { kind: 'found', until: Date.now() + 1600 })
    draw()
    centreOn(id)
  }
  function centreOn(id) {
    const b = P.boxes.get(id)
    if (!b) return
    view.k = Math.max(view.k, 0.9)
    view.x = svg.clientWidth / 2 - (b.x + b.w / 2) * view.k
    view.y = svg.clientHeight / 2 - (b.y + b.h / 2) * view.k
    applyView()
  }
  const findModules = q => (q && M ? M.nodes.filter(n => [n.name, n.kind || ''].some(s => s.toLowerCase().includes(q))) : [])

  function selectFile(p, at = null) {
    fileSel = p
    fileFocus = at ? { path: p, ...at, scroll: true } : null
    fileView = null
    selected = null
    revealPath(p)
    draw()
    renderPanel()
    renderFiles('reveal')
    loadPreview(p)
    if (panel.classList.contains('closed')) togglePanel()
  }

  function closeFile() {
    fileSel = null
    fileView = null
    draw()
    renderPanel()
    renderFiles()
  }

  function toggleExpand(id) {
    L.expanded = L.expanded.includes(id) ? L.expanded.filter(x => x !== id) : [...L.expanded, id]
    saveLayout()
    draw()
  }

  function toggleFold(layerId) {
    L.collapsed = L.collapsed.includes(layerId) ? L.collapsed.filter(x => x !== layerId) : [...L.collapsed, layerId]
    saveLayout()
    draw()
  }

  function startConnect(id) {
    connectFrom = id
    pointer = null
    const hint = $('hint')
    hint.textContent = M.byId.get(id).ghost
      ? `点一下「${nameOf(id)}」要调用的模块 · Esc 取消`
      : P && P.spine
        ? `点一下要从「${nameOf(id)}」连到的模块，或点空白处新建一个（先选放进哪个分组） · Esc 取消`
        : `点一下要从「${nameOf(id)}」连到的模块，或点分组里的空白处新建一个 · Esc 取消`
    hint.hidden = false
    svg.classList.add('connecting')
    draw()
  }
  function endConnect() {
    if (!connectFrom) return
    connectFrom = null
    pointer = null
    $('hint').hidden = true
    svg.classList.remove('connecting')
    draw()
  }

  // A position set here holds until the server has it, so a refresh that
  // comes first does not move the card back.
  function setPos(id, p) {
    L.positions[id] = p
    unsavedPos[id] = p
  }

  // A card the canvas placed itself keeps that spot from the first time it
  // shows, so modules coming and going around it later do not move it. The
  // pin says its group: in another group it no longer holds.
  function pinNew() {
    if (drag || !P || !P.cols) return
    let pinned = false
    for (const c of P.cols) {
      if (c.folded) continue
      for (const [id, r] of c.rel) {
        const p = L.positions[id]
        if (id === SKETCH || (p && !(p.layer && p.layer !== c.layer.id))) continue
        setPos(id, { x: r.x, y: r.y, layer: c.layer.id })
        pinned = true
      }
    }
    if (pinned) saveLayout(false)
  }
  function setFrame(id, p) {
    L.frames[id] = p
    unsavedFrames[id] = p
  }

  // A request to the canvas server. A failure comes back in words: the
  // server's own reason, else what kind of failure it was.
  async function request(url, opts) {
    let r
    try {
      r = await fetch(url, { cache: 'no-store', ...opts })
    } catch {
      throw new Error(`连不上画布服务（${AGENT} 的会话可能已经结束）`)
    }
    let d = null
    try {
      d = await r.json()
    } catch {}
    if (r.ok && d) return d
    throw new Error((d && d.error) || (r.status === 403 ? `画布链接已失效。${(S && S.reopen) || ''}` : '画布服务没有正常回应'))
  }
  const postJson = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  // Until the server has a change made here, a refresh keeps the page's own
  // layout (folds, colours and the rest, not only positions). Each change the
  // person makes can be undone; ones the page makes itself (`remember` false)
  // are not steps of their own.
  let layoutTimer = 0
  let layoutEdits = 0
  let layoutSaved = 0
  let layoutBefore = null // the layout as of the last change, as JSON
  let layoutStepAt = 0
  const undoStack = []
  const layoutMine = () => layoutEdits > layoutSaved
  function saveLayout(remember = true) {
    const now = JSON.stringify(L)
    if (remember && layoutBefore !== null && layoutBefore !== now) {
      // One gesture may save twice in a row: it undoes as one.
      if (Date.now() - layoutStepAt > 400) undoStack.push(layoutBefore)
      if (undoStack.length > 50) undoStack.shift()
      layoutStepAt = Date.now()
    }
    layoutBefore = now
    layoutEdits++
    clearTimeout(layoutTimer)
    layoutTimer = setTimeout(async () => {
      const upTo = layoutEdits
      const sent = { ...unsavedPos }
      const sentFrames = { ...unsavedFrames }
      try {
        await postJson('/api/layout', L)
        layoutSaved = Math.max(layoutSaved, upTo)
        for (const id of Object.keys(sent)) if (unsavedPos[id] === sent[id]) delete unsavedPos[id]
        for (const id of Object.keys(sentFrames)) if (unsavedFrames[id] === sentFrames[id]) delete unsavedFrames[id]
      } catch (err) {
        toast(`布局没保存上：${err.message}`, 'error')
      }
    }, 250)
  }

  // Back to the layout before the last change made here.
  function undo() {
    const last = undoStack.pop()
    if (!last) return toast('没有可以撤销的布局改动。')
    L = JSON.parse(last)
    for (const id of Object.keys(unsavedPos)) delete unsavedPos[id]
    for (const id of Object.keys(unsavedFrames)) delete unsavedFrames[id]
    saveLayout(false)
    draw()
    renderFiles()
  }
  const undoable = text => toast(text, 'info', { label: '撤销', run: undo })

  // Whether it reached the agent; the page says so when it did not.
  async function propose(body) {
    try {
      await postJson('/api/action', body)
      return true
    } catch (err) {
      toast(`没能送到 ${AGENT}：${err.message}`, 'error')
      return false
    }
  }
  // A task the agent started in a session that has since ended.
  const isStale = t => t.status === 'working' && Boolean(S && S.sessionId) && t.session !== S.sessionId

  // One the agent is working on is stopped only after a word on what that means.
  function cancelTask(id) {
    const t = (S.tasks || []).find(x => x.id === id)
    if (!t || t.status !== 'working') return propose({ type: 'cancel', taskId: id })
    dialog({
      title: `取消「${t.text.length > 30 ? t.text.slice(0, 30) + '…' : t.text}」？`,
      sub: isStale(t)
        ? `这一项是 ${AGENT} 在之前的会话里开始、没做完的。取消后它就不再算待办；已经改了的代码不会撤回。`
        : `${AGENT} 正在做这一项。取消后它再来完成时会被告知已取消；已经改了的代码不会撤回。要让正在跑的这一轮马上停下，请在对话里按 Esc。`,
      fields: [],
      submit: '取消这一项',
      dismiss: '保留',
      onSubmit: () => {
        propose({ type: 'cancel', taskId: id })
      },
    })
  }

  // ---- menus ----

  const menu = $('menu')
  // An item runs on a click, or with `sub` opens a submenu beside it (on
  // hover or click). An item may show a colour dot (`swatch`) or a tick (`on`).
  const submenu = $('submenu')
  function menuItems(box, items) {
    box.replaceChildren()
    for (const it of items) {
      if (it === '-') {
        box.append(h('hr'))
        continue
      }
      const label = h('span', { class: 'm-label' })
      if (it.on !== undefined) label.append(h('span', { class: 'm-check', text: it.on ? '✓' : '' }))
      if (it.swatch) {
        const sw = h('span', { class: 'm-swatch' })
        sw.style.background = it.swatch
        label.append(sw)
      }
      if (it.icon) label.append(glyph(it.icon))
      label.append(it.label)
      const btn = h(
        'button',
        {
          type: 'button',
          class: it.danger ? 'danger' : '',
          role: 'menuitem',
          'aria-haspopup': it.sub ? 'menu' : null,
          onclick: () => {
            if (it.sub) return openSub(btn, it.sub)
            closeMenu()
            it.run()
          },
        },
        label,
        it.sub ? h('kbd', { text: '›' }) : it.kbd ? h('kbd', { text: it.kbd }) : null,
      )
      if (box === menu) btn.addEventListener('pointerenter', () => (it.sub ? openSub(btn, it.sub) : closeSub()))
      box.append(btn)
    }
  }
  function openMenu(x, y, title, items) {
    closeSub()
    menuItems(menu, items)
    if (title) menu.prepend(h('div', { class: 'm-title', text: title }))
    menu.hidden = false
    const r = menu.getBoundingClientRect()
    menu.style.left = `${clamp(x, 8, window.innerWidth - r.width - 8)}px`
    menu.style.top = `${clamp(y, 8, window.innerHeight - r.height - 8)}px`
    const first = menu.querySelector('button')
    if (first) first.focus({ preventScroll: true })
  }
  // Beside the menu, at the item's height; to the left when there is no room.
  function openSub(btn, items) {
    for (const b of menu.querySelectorAll('button.open')) b.classList.remove('open')
    btn.classList.add('open')
    menuItems(submenu, items)
    submenu.hidden = false
    const m = menu.getBoundingClientRect()
    const r = btn.getBoundingClientRect()
    const s = submenu.getBoundingClientRect()
    const left = m.right + s.width + 4 <= window.innerWidth - 8 ? m.right + 4 : m.left - s.width - 4
    submenu.style.left = `${Math.max(8, left)}px`
    submenu.style.top = `${clamp(r.top - 5, 8, window.innerHeight - s.height - 8)}px`
  }
  function closeSub() {
    submenu.hidden = true
    for (const b of menu.querySelectorAll('button.open')) b.classList.remove('open')
  }
  function closeMenu() {
    menu.hidden = true
    closeSub()
  }
  document.addEventListener('pointerdown', ev => {
    if (!menu.hidden && !menu.contains(ev.target) && !submenu.contains(ev.target)) closeMenu()
  })

  function nodeMenu(id, x, y) {
    const n = M.byId.get(id)
    if (!n) return
    if (n.ghost) {
      const draft = isDraft(n)
      return openMenu(x, y, `+ ${n.name}（${draft ? '待新增' : STATUS[n.task.status]}）`, [
        draft ? { label: '编辑…', kbd: '双击', run: () => openEditor(id) } : null,
        { label: '查看这项新增', run: () => select(id) },
        draft ? { label: '从它连线到…', kbd: '拖右侧圆点', run: () => startConnect(id) } : null,
        draft && M.g.layers.length > 1
          ? { label: '移到分组', sub: M.g.layers.filter(l => l.id !== n.layer).map(l => ({ label: l.name, swatch: colorOf(l.id), run: () => moveToGroup(id, l.id) })) }
          : null,
        '-',
        { label: '取消这项新增', danger: true, run: () => cancelTask(n.task.id) },
      ].filter(Boolean))
    }
    const removing = M.removing.get(id)
    const items = [
      { label: '查看详情', run: () => select(id) },
      { label: `给 ${AGENT} 提意见…`, run: () => openComment(id) },
    ]
    // On a main line shown: a word on the step it is at, written in the step list.
    const line = shownFlow()
    const at = line ? line.flow.steps.findIndex(st => st.node === id) : -1
    if (at >= 0) items.push({ label: `主线第 ${(line.at.get(id) || [at + 1]).join('、')} 步不对，提意见…`, run: () => askStep(line.flow.id, at) })
    if (!removing) items.push({ label: '从它连线到…', kbd: '拖右侧圆点', run: () => startConnect(id) })
    items.push({ label: L.expanded.includes(id) ? '收起卡片' : '展开卡片', kbd: '双击', run: () => toggleExpand(id) })
    if (L.positions[id]) {
      items.push({
        label: '放回自动位置',
        run: () => {
          delete L.positions[id]
          saveLayout()
          draw()
        },
      })
    }
    if (nodeType(n) === 'data') {
      const locked = isSensitiveNode(n)
      items.push({ label: locked ? '标为不敏感' : '标为敏感', run: () => propose({ type: 'set-sensitive', nodeId: n.id, sensitive: !locked }) })
    }
    items.push('-')
    const others = M.g.layers.filter(l => l.id !== n.layer)
    if (others.length) items.push({ label: '移到分组', sub: others.map(l => ({ label: l.name, swatch: colorOf(l.id), run: () => moveToGroup(id, l.id) })) })
    if (n.files && n.files.length) items.push({ label: '在文件夹中打开', run: () => reveal(n.files[0]) })
    items.push('-')
    items.push(removing ? { label: '取消删除提议', run: () => cancelTask(removing.id) } : { label: '提议删除此模块', danger: true, run: () => propose({ type: 'remove-node', nodeId: id }) })
    openMenu(x, y, n.name, items)
  }

  // ---- sensitive data ----
  // The person says which data is sensitive: on a new module's card, and in
  // the overview for what the agent found. The agent is refused whatever would
  // show it what is inside; running scripts on the data is not stopped.

  const SENSITIVE_MEANS = () =>
    S.capabilities?.readGuard === 'trusted-hooks'
      ? '画布不显示敏感数据内容。Codex 中已信任的钩子会拦截能识别的直接读取；这是命令规则检查，不能替代文件权限，也无法识别所有写法。脚本输出和 Notebook 输出仍可能进入对话，请只输出汇总结果。'
      : `标为敏感的数据，${AGENT} 直接查看内容（打开文件、cat、head、打印几行）会被拒绝，画布也不列出里面的文件。运行分析脚本不受限制：脚本打印出来的内容、保存了运行结果的 Notebook，仍会进到对话里。没标为敏感的数据不受保护。`

  const dataModules = () => (M ? M.nodes.filter(n => !n.ghost && nodeType(n) === 'data') : [])
  // Data whose sensitivity nobody has said yet: as the agent found it.
  const unconfirmed = () => dataModules().filter(n => !(n.pins || []).includes('sensitive'))

  // A switch: one click either way.
  function lockButton(n) {
    const locked = isSensitiveNode(n)
    return h(
      'button',
      {
        type: 'button',
        class: 'btn small lock-btn' + (locked ? ' on' : ''),
        title: locked ? '点一下改为不敏感' : '点一下标为敏感',
        onclick: ev => {
          ev.stopPropagation()
          propose({ type: 'set-sensitive', nodeId: n.id, sensitive: !locked })
        },
      },
      locked ? lockGlyph() : null,
      locked ? '敏感' : '不敏感',
    )
  }

  // One data module: its name (a click goes there), its files, its switch.
  function sensitiveRow(n) {
    return h(
      'div',
      { class: 'sens-row' },
      h('span', { class: 'link', text: n.name, title: '看这个模块', onclick: () => select(n.id) }),
      h('span', { class: 'muted mono', text: (n.files || []).join('、') || '（没有列出文件）' }),
      lockButton(n),
    )
  }

  // What the agent found and nobody has looked at yet: sensitive until the person says.
  function sensitiveBanner() {
    const list = unconfirmed()
    if (!list.length) return null
    return h(
      'div',
      { class: 'p-banner next sens' },
      h('b', { text: `确认哪些是敏感数据（${list.length}）` }),
      h('div', { class: 'row-sub', text: `${AGENT} 画图时找到这些数据，默认按敏感处理。含患者信息的保持「敏感」，确定不含隐私的改成「不敏感」，然后点「确认」。` }),
      list.map(sensitiveRow),
      h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => propose({ type: 'confirm-sensitive', nodeIds: list.map(n => n.id) }) }, '确认')),
    )
  }

  // Notebooks that keep outputs and use sensitive data: what they printed may
  // hold records, and goes along whenever the notebook is read.
  const keptOutputs = () => (S.audit && Array.isArray(S.audit.notebooks) ? S.audit.notebooks : [])
  const clearOutputs = paths => propose({ type: 'clear-outputs', paths })

  function notebookRow(nb) {
    return h(
      'div',
      { class: 'sens-row' },
      h('span', { class: 'link mono', text: nb.path, title: '在文件树里打开', onclick: () => selectFile(nb.path) }),
      h('span', { class: 'muted', text: `用到${nb.uses.map(id => `「${nameOf(id)}」`).join('、')}` }),
      h('button', { type: 'button', class: 'btn small', onclick: () => clearOutputs([nb.path]) }, '清掉输出'),
    )
  }

  function notebooksBanner() {
    const list = keptOutputs()
    if (!list.length) return null
    return h(
      'div',
      { class: 'p-banner evidence' },
      `${list.length} 个 Notebook 保存着用到敏感数据的运行结果，${AGENT} 读它们时，打印出的记录会一起进到对话里。`,
      h('button', { type: 'button', class: 'btn link', onclick: () => clearOutputs(list.map(nb => nb.path)) }, list.length > 1 ? '全部清掉输出' : '清掉输出'),
      h('button', { type: 'button', class: 'btn link', onclick: () => $('sensitive-sec') && $('sensitive-sec').scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '看详情'),
    )
  }

  // Every data module and whether it is sensitive, with what that means; the notebooks that keep its records.
  function sensitiveSection() {
    const all = dataModules()
    if (!all.length) return null
    const kept = keptOutputs()
    return withId(
      'sensitive-sec',
      section(
        `敏感数据（${all.filter(isSensitiveNode).length}/${all.length}）`,
        h('div', { class: 'row-sub', text: SENSITIVE_MEANS() }),
        all.map(sensitiveRow),
        kept.length
          ? [
              h('div', { class: 'reach-head', text: `保存着运行结果的 Notebook（${kept.length}）` }),
              h('div', { class: 'row-sub', text: '这些 Notebook 用到了敏感数据，里面保存的输出（打印的表格、前几行）可能有具体记录。清掉输出只去掉运行结果，代码和说明不动，重新运行就会再有。' }),
              kept.map(notebookRow),
              kept.length > 1 ? h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn small', onclick: () => clearOutputs(kept.map(nb => nb.path)) }, '全部清掉输出')) : null,
            ]
          : null,
        maskBlock(),
      ),
    )
  }

  // ---- identifiers masked in command output ----
  // What the mod does to a command's output before Claude reads it, and the
  // record-number formats of this project, given by example.
  const maskOf = () => {
    const m = S.mask && typeof S.mask === 'object' ? S.mask : {}
    return { enabled: m.enabled !== false, formats: Array.isArray(m.formats) ? m.formats : [] }
  }
  // An example in words: ZY20240001 → 「ZY + 8 位数字」.
  function formatWords(example) {
    if (example.startsWith('re:')) return `规则 ${example.slice(3)}`
    return (example.match(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g) || []).map(r => (/^\d+$/.test(r) ? `${r.length} 位数字` : r)).join(' + ')
  }
  function maskBlock() {
    const m = maskOf()
    const set = change => propose({ type: 'mask-set', enabled: m.enabled, formats: m.formats, ...change })
    const add = () => {
      const label = (drafts['mask-label'] || '').trim() || '病历号'
      const example = (drafts['mask-example'] || '').trim()
      if (!example) return toast('先写一个号码的例子。', 'error')
      drafts['mask-example'] = ''
      set({ formats: [...m.formats, { label, example }] })
    }
    return [
      h(
        'div',
        { class: 'reach-head mask-head' },
        S.capabilities?.outputMasking === false ? '记录里的号码过滤' : '命令输出打码',
        h('button', { type: 'button', class: 'btn small lock-btn' + (m.enabled ? ' on' : ''), onclick: () => set({ enabled: !m.enabled }) }, m.enabled ? '已开' : '已关'),
      ),
      h('div', {
        class: 'row-sub',
        text: S.capabilities?.outputMasking === false
          ? 'Codex 的命令原始输出不会在交给它之前自动打码。这里的设置仅用于过滤工作记录中的号码；运行脚本时请只输出汇总结果。读取拦截需要在 Codex 中信任插件钩子，不能替代文件访问权限。'
          : m.enabled
          ? `${AGENT} 运行命令、脚本后，输出交给它之前，先把身份证号、手机号${m.formats.length ? '和下面这些号码' : ''}换成 [身份证号] 这样的标记，工作记录里记下遮了几处。只管命令的输出，不改文件，也不管 ${AGENT} 直接打开的文件。`
          : `关着：命令输出原样交给 ${AGENT}。`,
      }),
      m.formats.map((f, i) =>
        h(
          'div',
          { class: 'sens-row' },
          h('span', { text: f.label }),
          h('span', { class: 'mono', text: f.example }),
          h('span', { class: 'muted', text: formatWords(f.example) }),
          h('button', { type: 'button', class: 'btn small', onclick: () => set({ formats: m.formats.filter((_, j) => j !== i) }) }, '去掉'),
        ),
      ),
      h(
        'div',
        { class: 'compose mask-add' },
        h('input', { type: 'text', 'data-key': 'mask-label', class: 'mask-label', placeholder: '名称，如 病历号', maxlength: 20, oninput: ev => (drafts['mask-label'] = ev.target.value) }),
        h('input', {
          type: 'text',
          'data-key': 'mask-example',
          class: 'mono',
          placeholder: '写一个号码的样子，如 ZY20240001',
          maxlength: 200,
          oninput: ev => (drafts['mask-example'] = ev.target.value),
          onkeydown: ev => {
            if (ev.key === 'Enter' && !ev.isComposing) add()
          },
        }),
        h('button', { type: 'button', class: 'btn small', onclick: add }, '添加'),
      ),
      h('div', {
        class: 'row-sub',
        text: '字母照写、每串数字按位数算：ZY20240001 会遮住所有「ZY + 8 位数字」的号码。纯数字的号码至少 7 位，也会遮住同样位数的其他数字（比如 8 位的日期）。',
      }),
    ]
  }

  // How much a data module holds, without naming a file.
  const dataStats = new Map()
  async function loadStats(id) {
    dataStats.set(id, { loading: true })
    try {
      dataStats.set(id, await request(`/api/stats?node=${encodeURIComponent(id)}`))
    } catch (err) {
      dataStats.set(id, { error: `统计不出来：${err.message}` })
    }
    if (selected === id) renderPanel()
  }

  function dataSection(n) {
    const st = dataStats.get(n.id)
    if (!st) loadStats(n.id)
    const locked = isSensitiveNode(n)
    const facts = !st || st.loading
      ? '统计中…'
      : st.error
        ? st.error
        : `${st.files} 个文件，共 ${size(st.bytes)}${st.latest ? `，最近修改 ${when(st.latest)}` : ''}${st.missing && st.missing.length ? `；找不到：${st.missing.join('、')}` : ''}`
    return section(
      '数据',
      h(
        'div',
        { class: `p-banner ${locked ? 'sealed' : 'open'}` },
        h(
          'div',
          {},
          locked
            ? `敏感：${AGENT} 直接查看里面的内容会被拒绝，画布不列出里面的文件（README 等说明文件除外）。运行分析脚本不受限制，脚本打印的内容仍会进到对话里。`
            : `不敏感：画布显示里面的文件，${AGENT} 可以读取。`,
        ),
        lockButton(n),
      ),
      h('div', { class: 'p-text muted', text: facts }),
    )
  }

  function edgeMenu(it, x, y) {
    const e = it.e
    const items = [
      { label: `查看「${nameOf(e.from)}」`, run: () => select(e.from) },
      { label: `查看「${nameOf(e.to)}」`, run: () => select(e.to) },
      '-',
    ]
    const ta = M.byId.get(e.from) ? nodeType(M.byId.get(e.from)) : 'code'
    const tb = M.byId.get(e.to) ? nodeType(M.byId.get(e.to)) : 'code'
    if (e.state === 'normal' && e.sources.length) {
      const doubtOf = src => e.doubt.find(d => d.path === src.path && d.line === src.line)
      for (const src of e.sources) {
        const d = doubtOf(src)
        const note = [
          d ? (d.changed ? '存疑：原来那几行已改写' : '存疑') : '',
          src.was ? `代码挪动过，原第 ${src.was} 行` : citedState(src.path).changed ? '画图后改过' : '',
        ]
          .filter(Boolean)
          .join('，')
        items.push({ label: `依据${note ? `（${note}）` : ''}：${sourceText(src)}`, run: () => openSource(src) })
      }
      items.push('-')
    } else if (e.state === 'normal' && e.unsure) {
      items.push({ label: `未确认 · 请 ${AGENT} 找出代码位置`, run: () => askForEvidence(e) })
      items.push('-')
    }
    if (e.state === 'normal' && e.nocode) {
      items.push({ label: `${e.nocode === 'reversed' ? '代码里方向相反' : '代码里没找到'} · 请 ${AGENT} 核对`, run: () => askToCheck(e) })
      if (e.via) items.push({ label: `看「${viaName(e.via)}」怎么交过去：${sourceText(e.via)}`, run: () => openSource(e.via) })
      items.push('-')
    }
    if (e.state === 'normal' && e.vouched) {
      const after = vouchChanged(e)
      if (after.length) {
        items.push({ label: `核实后改过：${filesText(after)} · 还是对的`, run: () => propose({ type: 'vouch-edge', from: e.from, to: e.to, why: e.vouched.why, ...(e.vouched.where ? { where: e.vouched.where } : {}) }) })
        items.push({ label: `核实后改过 · 请 ${AGENT} 再核对`, run: () => askToRevouch(e, after) })
      }
      items.push({ label: `取消「已核实」（${vouchText(e.vouched)}）`, run: () => propose({ type: 'vouch-edge', from: e.from, to: e.to, why: '' }) })
      items.push('-')
    } else if (e.state === 'normal' && (e.unsure || e.nocode || e.doubt.length)) {
      items.push({ label: '代码里看不出来，但确实存在', sub: vouchItems(e) })
      items.push('-')
    }
    if (e.state === 'normal' && isRes(ta) !== isRes(tb)) {
      items.push({
        label: '这条线是',
        sub: ['read', 'write'].map(k => ({ label: KIND_WORD[k], on: e.kind === k, run: () => e.kind !== k && propose({ type: 'set-edge-kind', from: e.from, to: e.to, kind: k }) })),
      })
      items.push('-')
    }
    if (e.state === 'normal') items.push({ label: '提议去掉这条连线', danger: true, run: () => propose({ type: 'remove-edge', from: e.from, to: e.to }) })
    else if (e.state === 'remove') items.push({ label: '取消解除提议', run: () => cancelTask(e.task.id) })
    else if (e.task.kind === 'add-node') {
      // A wire of a draft comes off the draft; the module stays proposed.
      const t = e.task
      if (t.status === 'draft') {
        const off = t.node.id === e.from ? { dependsOn: t.nodeIds.filter(x => x !== e.to) } : { usedBy: (t.usedBy || []).filter(x => x !== e.from) }
        items.push({ label: '去掉这条连线', run: () => editDraft(t.id, off) })
      }
      items.push({ label: '取消这项新增', danger: true, run: () => cancelTask(t.id) })
    } else items.push({ label: '取消新增连线', run: () => cancelTask(e.task.id) })
    openMenu(x, y, `${edgeText(e)}${e.label ? `（${e.label}）` : ''}`, items)
  }

  // Where in the code, in words: pipeline/clean.py 第 12–30 行.
  const sourceText = src => (src.line ? `${src.path} 第 ${src.line}${src.end_line ? `–${src.end_line}` : ''} 行` : src.path)

  // A cited spot opened in the file view, its lines marked.
  // A file changed after the map was drawn shows its lines as they were then,
  // from the commit the drawing was at, unless it had changes not committed.
  // A spot found where the code moved it opens there, in the file as it is now.
  function openSource(src) {
    if (!(FT.files || []).includes(src.path)) return toast(`${src.path} 不在文件列表里（可能是敏感数据，或已经删掉、改名）。`, 'error')
    const st = citedState(src.path)
    selectFile(src.path, src.line ? { line: src.line, end: src.end_line || src.line, ...(src.was ? { was: src.was } : st.changed && st.pinned ? { rev: S.graph.revision } : {}) } : null)
  }

  // Cited spots where the check found them now: moved ones carry the line they were cited at (`was`).
  function placer(A) {
    const at = new Map(A.moved.map(m => [`${m.path}\n${m.line}\n${m.end_line || ''}`, m.now]))
    return src => {
      const now = at.get(`${src.path}\n${src.line || 0}\n${src.end_line || ''}`)
      if (!now) return src
      const { end_line: _, ...rest } = src
      return { ...rest, ...now, was: src.line }
    }
  }

  // Whether a cited file changed after the map was drawn, and whether the drawing's commit holds it as cited.
  function citedState(p) {
    const g = S.graph
    const t = FT.changed && FT.changed[p]
    return { changed: Boolean(g && g.drawnAt && t && t > g.drawnAt + 1000), pinned: Boolean(g && g.revision && !(g.dirty || []).includes(p)) }
  }

  // The cited lines in the other version: as drawn (`rev`) or as they are now.
  function showVersion(p, rev) {
    if (!fileFocus || fileFocus.path !== p) return
    fileFocus = { ...fileFocus, rev: rev || undefined, scroll: true }
    fileView = null
    renderPanel()
    loadPreview(p)
  }

  // A line nobody found code for, as a proposal: the agent looks, and cites or says it is not there.
  function askForEvidence(e) {
    propose({
      type: 'comment',
      nodeId: e.from,
      text: `给这条连线找代码依据：${edgeText(e)}。找出它在代码里真正发生的位置（文件和行号），补进架构图；代码里找不到的话说明一下，要不要去掉这条线由我决定。`,
    })
  }

  // A call the check against the code did not find, as a proposal: the agent looks and says.
  function askToCheck(e) {
    const how =
      e.nocode === 'reversed'
        ? `代码里是「${nameOf(e.to)}」引用「${nameOf(e.from)}」，方向可能画反了`
        : `代码里没找到「${nameOf(e.from)}」引用「${nameOf(e.to)}」的地方（import、source() 或写明的路径）`
    propose({ type: 'comment', nodeId: e.from, text: `核对这条连线：${edgeText(e)}。${how}。看看它实际是怎么调用的，补上代码依据；确实没有的话说明一下，要不要去掉或改方向由我决定。` })
  }

  // A vouched line whose code changed since, as a proposal: the agent looks again and says.
  function askToRevouch(e, files) {
    propose({
      type: 'comment',
      nodeId: e.from,
      text: `再核对一下这条连线：${edgeText(e)}。它标了「已核实」（${e.vouched.why}），之后这些文件改过：${files.slice(0, 5).join('、')}。看看调用还在不在，在回复里告诉我；不在了的话，要不要去掉这条线由我决定。`,
    })
  }

  // Ways a call is made that the check cannot read; picking one says the line is there.
  // A file that names both ends comes first: most likely it hands the one to the other.
  const VOUCH_WHY = ['对象作为参数传进来', '经网络接口调用（HTTP）', '调用项目外的服务', '运行时才加载', '其他方式']
  function vouchItems(e) {
    const say = (why, where) => propose({ type: 'vouch-edge', from: e.from, to: e.to, why, ...(where ? { where } : {}) })
    const handed = e.via ? [{ label: `由「${viaName(e.via)}」作为参数传进来（${sourceText(e.via)}）`, run: () => say(`由「${viaName(e.via)}」作为参数传进来`, { path: e.via.path, line: e.via.line }) }, '-'] : []
    return [...handed, ...VOUCH_WHY.map(why => ({ label: why, run: () => say(why) }))]
  }
  const vouchText = v => `${v.by === 'person' ? '你确认的' : `${AGENT} 读代码确认的`}：${v.why}`
  const viaName = via => (via.node && M.byId.has(via.node) ? nameOf(via.node) : via.path)
  const filesText = fs => `${fs[0]}${fs.length > 1 ? ` 等 ${fs.length} 个文件` : ''}`

  // A vouched line's code that changed after the word was given, newest first:
  // the caller's files, the spots the line cites, the file that hands one to the other.
  function vouchChanged(e) {
    const v = e.vouched
    const changed = FT.changed
    if (!v || !changed) return []
    const cited = new Set([...(e.sources || []).map(s => s.path), ...(v.where ? [v.where.path] : [])])
    return Object.entries(changed)
      .filter(([f, t]) => t > (v.at || 0) + 1000 && (cited.has(f) || ownersOf(f).includes(e.from)))
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f)
  }

  // What is uncertain about a line, in a few words: for its label, chip and menu.
  function edgeNotes(e) {
    const normal = e.state === 'normal'
    return [
      e.unsure ? '未确认' : '',
      normal && e.nocode ? (e.nocode === 'reversed' ? '代码里方向相反' : e.via ? `可能经「${viaName(e.via)}」传入` : '代码里没找到') : '',
      normal && e.doubt && e.doubt.length ? '依据存疑' : '',
      normal && e.vouched && vouchChanged(e).length ? '核实后代码改过' : '',
    ].filter(Boolean)
  }

  // A line in words, the step first: 数据清洗 读取 原始数据.
  function edgeText(e) {
    const [a, b] = e.head === 'from' ? [e.to, e.from] : [e.from, e.to]
    if (e.kind === 'read') return `${nameOf(b)} 读取 ${nameOf(a)}`
    if (e.kind === 'write') return `${nameOf(a)} 生成 ${nameOf(b)}`
    if (e.kind === 'link') return `${nameOf(a)} 和 ${nameOf(b)} 关联`
    return `${nameOf(e.from)} 调用 ${nameOf(e.to)}`
  }

  // A frame's modules are laid out only when the person asks, one of three ways.
  function arrangeMenu(layerId, x, y) {
    const c = P.cols.find(k => k.layer.id === layerId)
    if (!c) return
    if (!c.nodes.length) return toast('这个分组还没有模块。')
    openMenu(x, y, `排列「${c.layer.name}」`, [
      { label: '横排', kbd: '排成一行', run: () => arrange(layerId, 'row') },
      { label: '竖排', kbd: '排成一列', run: () => arrange(layerId, 'column') },
      { label: '平铺', kbd: '排成方阵', run: () => arrange(layerId, 'grid') },
    ])
  }

  function arrange(layerId, how) {
    const c = P.cols.find(k => k.layer.id === layerId)
    if (!c) return
    materializeFrames()
    // In the order they read now: across for a row, down for a column, line by line for a grid.
    const cards = c.nodes.map(n => ({ id: n.id, ...c.rel.get(n.id) }))
    cards.sort((a, b) => (how === 'row' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x))
    const per = how === 'row' ? cards.length : how === 'column' ? 1 : Math.ceil(Math.sqrt(cards.length))
    let y = FRAME.top
    for (let i = 0; i < cards.length; i += per) {
      const line = cards.slice(i, i + per)
      line.forEach((r, j) => setPos(r.id, { x: FRAME.pad + j * (G.nodeW + 24), y }))
      y += Math.max(...line.map(r => r.h)) + G.gapY
    }
    draw()
    pushFrames(layerId)
    saveLayout()
    draw()
    undoable(`已排列「${c.layer.name}」。`)
  }

  // Frames the grown one now covers move out of its way: those starting to
  // its right move right, the rest move down; those they then cover move in turn.
  function pushFrames(fromId) {
    const gap = 40
    const queue = [fromId]
    for (let guard = 0; queue.length && guard < 200; guard++) {
      const id = queue.shift()
      const a = P.cols.find(c => c.layer.id === id)
      for (const b of P.cols) {
        const A = a.box
        const B = b.box
        if (b === a || !(A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y)) continue
        const to = B.x >= A.x + 40 ? { x: snap(A.x + A.w + gap), y: B.y } : { x: B.x, y: snap(A.y + A.h + gap) }
        setFrame(b.layer.id, to)
        b.box = { ...B, ...to }
        queue.push(b.layer.id)
      }
    }
  }

  function laneMenu(layer, x, y) {
    const c = P.cols.find(k => k.layer.id === layer.id)
    const folded = L.collapsed.includes(layer.id)
    openMenu(x, y, layer.name, [
      { label: '新增步骤', sub: STEP_TYPES.map(t => ({ label: TYPE_LABEL[t], icon: t, run: () => openSketch(x, y, { layer: layer.id, type: t }) })) },
      { label: '新增资料', sub: RESOURCE_TYPES.map(t => ({ label: TYPE_LABEL[t], icon: t, run: () => openSketch(x, y, { layer: layer.id, type: t }) })) },
      { label: '重命名…', kbd: '双击标题', run: () => renameFrame(layer.id) },
      { label: folded ? '展开这个分组' : '收起这个分组', run: () => toggleFold(layer.id) },
      c && c.nodes.length && !folded
        ? {
            label: '排列',
            sub: [
              { label: '横排：排成一行', run: () => arrange(layer.id, 'row') },
              { label: '竖排：排成一列', run: () => arrange(layer.id, 'column') },
              { label: '平铺：排成方阵', run: () => arrange(layer.id, 'grid') },
            ],
          }
        : null,
      {
        label: '分组颜色',
        sub: [
          ...GROUP_COLORS.map(([name, color]) => ({ label: name, swatch: color, on: L.colors[layer.id] === color, run: () => setGroupColor(layer.id, color) })),
          '-',
          { label: '默认', on: !L.colors[layer.id], run: () => setGroupColor(layer.id, null) },
        ],
      },
      c && !c.nodes.length ? { label: '删除这个分组', danger: true, run: () => propose({ type: 'remove-layer', layerId: layer.id }) } : null,
      '-',
      { label: '适应画布', kbd: 'F', run: fitView },
      { label: '整理布局', run: relayout },
    ].filter(Boolean))
  }

  function canvasMenu(x, y) {
    // The trunk view lays the cards out itself: the groups come back with the way out of it.
    if (P && P.spine) {
      return openMenu(x, y, '', [
        { label: '在这里新建模块…', kbd: '双击', run: () => trunkNew(x, y) },
        '-',
        { label: '退出主线，回到分组', kbd: 'Esc', run: () => setFlow(null) },
        { label: '导出图片（PNG）', run: exportPng },
        { label: '适应画布', kbd: 'F', run: fitView },
      ])
    }
    openMenu(x, y, '', [
      { label: '新建分组', kbd: '双击', run: () => newFrame(x, y) },
      { label: '导出图片（PNG）', run: exportPng },
      '-',
      undoStack.length ? { label: '撤销布局改动', kbd: 'Ctrl+Z', run: undo } : null,
      { label: '适应画布', kbd: 'F', run: fitView },
      { label: '整理布局', run: relayout },
    ].filter(Boolean))
  }

  function setGroupColor(layerId, color) {
    if (color) L.colors[layerId] = color
    else delete L.colors[layerId]
    saveLayout()
    draw()
    renderFiles()
  }

  // The whole map as a PNG for a report or slides: what is drawn, without
  // the pointer's traces, on the canvas's colour. The page's styles go in
  // with the colours resolved, theme and the person's settings both.
  async function exportPng() {
    if (!P) return
    try {
      const b = bounds()
      const box = { x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 }
      const scale = Math.min(2, 8000 / Math.max(box.w, box.h))
      const css = await (await fetch('/canvas.css', { cache: 'no-store' })).text()
      const look = getComputedStyle(stage)
      const vars = [...new Set(css.match(/--[a-z0-9-]+/g) || [])]
        .map(name => [name, look.getPropertyValue(name).trim()])
        .filter(([, v]) => v)
        .map(([name, v]) => `${name}: ${v}`)
        .join('; ')
      const scene2 = scene.cloneNode(true)
      scene2.removeAttribute('transform')
      for (const el of scene2.querySelectorAll('.flow, .port, .wire, .sketch, .run-tag.done')) el.remove()
      for (const el of scene2.querySelectorAll('.dim, .hover, .selected, .target, .editing, .owner')) el.classList.remove('dim', 'hover', 'selected', 'target', 'editing', 'owner')
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      const markup =
        `<svg xmlns="${NS}" width="${Math.round(box.w * scale)}" height="${Math.round(box.h * scale)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" style="${esc(`${vars}; font-family: ${getComputedStyle(svg).fontFamily}`)}">` +
        `<style>${esc(css)}</style>${svg.querySelector('defs').outerHTML}` +
        `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${look.backgroundColor}"/>` +
        new XMLSerializer().serializeToString(scene2) +
        '</svg>'
      const img = await new Promise((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('这张图没能画出来'))
        i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
      })
      const c = document.createElement('canvas')
      c.width = Math.round(box.w * scale)
      c.height = Math.round(box.h * scale)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'))
      const name = `${(S.graph.title || S.project || '架构图').replace(/[\\/:*?"<>|]+/g, '-')}-架构图.png`
      const a = h('a', { href: URL.createObjectURL(blob), download: name })
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 10000)
      toast(`已导出 ${name}（在浏览器的下载里）`)
    } catch (err) {
      toast(`没能导出图片：${err.message}`, 'error')
    }
  }

  // An empty layer, its frame where the menu was opened, named right away.
  function newFrame(clientX, clientY) {
    const at = world({ clientX, clientY })
    materializeFrames()
    saveLayout()
    const name = freeLayerName()
    pendingFrame = { name, x: snap(at.x), y: snap(at.y), rename: true, since: Date.now() }
    propose({ type: 'add-layer', name })
  }

  function freeLayerName(stem = '新分组') {
    const taken = new Set(S.graph.layers.map(l => l.name))
    let name = stem
    for (let i = 2; taken.has(name); i++) name = `${stem} ${i}`
    return name
  }

  // The layer the page asked for a moment ago, now in the graph: its frame
  // goes where the person pointed. Says which to name, if any.
  function placePendingFrame() {
    if (!pendingFrame) return null
    const pf = pendingFrame
    const l = S.graph && S.graph.layers.find(x => x.name === pf.name)
    if (!l) {
      if (Date.now() - pf.since > 8000) pendingFrame = null
      return null
    }
    pendingFrame = null
    setFrame(l.id, { x: pf.x, y: pf.y })
    saveLayout(false)
    return pf.rename ? l.id : null
  }

  // A frame's title, typed over where it is.
  const titleInput = $('title-edit')
  function renameFrame(layerId) {
    const c = P && P.cols.find(x => x.layer.id === layerId)
    if (!c) return
    closeEditor()
    titleEdit = { layer: layerId }
    titleInput.value = c.layer.name
    titleInput.hidden = false
    draw()
    titleInput.focus({ preventScroll: true })
    titleInput.select()
  }
  function endRename(keep) {
    if (!titleEdit) return
    const id = titleEdit.layer
    titleEdit = null
    titleInput.hidden = true
    const name = titleInput.value.trim()
    const layer = S.graph && S.graph.layers.find(l => l.id === id)
    if (keep && layer && name && name !== layer.name) {
      if (S.graph.layers.some(l => l.id !== id && l.name === name)) toast(`已经有叫「${name}」的分组了。`, 'error')
      else {
        layer.name = name // shown at once; the server's answer follows
        propose({ type: 'rename-layer', layerId: id, name })
      }
    }
    draw()
  }
  titleInput.addEventListener('keydown', ev => {
    if (ev.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Enter') endRename(true)
    else if (ev.key === 'Escape') endRename(false)
    else return
    ev.preventDefault()
    ev.stopPropagation()
  })
  titleInput.addEventListener('blur', () => endRename(true))

  function relayout() {
    L.positions = {}
    L.frames = {}
    for (const id of Object.keys(unsavedPos)) delete unsavedPos[id]
    for (const id of Object.keys(unsavedFrames)) delete unsavedFrames[id]
    saveLayout()
    draw()
    fitView()
    undoable('已整理布局：所有分组和模块回到自动排列的位置。')
  }

  // ---- dialogs ----

  const dialogWrap = $('dialog-wrap')
  const dialogBox = $('dialog')
  function dialog({ title, sub, fields, submit, onSubmit, dismiss = '取消' }) {
    const inputs = {}
    const error = h('div', { class: 'd-error' })
    const done = () => {
      const values = {}
      for (const [k, el] of Object.entries(inputs)) values[k] = el.value
      const why = onSubmit(values)
      if (why) error.textContent = why
      else closeDialog()
    }
    const body = fields.map(f => {
      let el
      if (f.type === 'select') {
        el = h('select', { id: `f-${f.key}` }, f.options.map(o => h('option', { value: o.value, text: o.label })))
        el.value = f.value || ''
      } else if (f.type === 'textarea') {
        el = h('textarea', { id: `f-${f.key}`, rows: 3, placeholder: f.placeholder || '' })
        el.value = f.value || ''
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) done()
        })
      } else {
        el = h('input', { id: `f-${f.key}`, type: 'text', placeholder: f.placeholder || '', maxlength: 80 })
        el.value = f.value || ''
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') done()
        })
      }
      inputs[f.key] = el
      return h('div', { class: 'd-field' }, h('label', { for: `f-${f.key}`, text: f.label }), el)
    })
    dialogBox.replaceChildren(
      h(
        'div',
        {},
        h('h2', { text: title }),
        sub ? h('p', { class: 'd-sub', text: sub }) : null,
        body,
        error,
        h(
          'div',
          { class: 'd-actions' },
          h('button', { type: 'button', class: 'btn', onclick: closeDialog }, dismiss),
          h('button', { type: 'button', class: 'btn primary', onclick: done }, submit),
        ),
      ),
    )
    dialogWrap.hidden = false
    const first = Object.values(inputs)[0]
    if (first) first.focus()
  }
  function closeDialog() {
    dialogWrap.hidden = true
    dialogBox.replaceChildren()
  }
  dialogWrap.addEventListener('pointerdown', ev => {
    if (ev.target === dialogWrap) closeDialog()
  })

  // ---- on the canvas: a new card where the person points, and a box under a card ----
  // A double-click on empty space (or a wire let go there) puts a blank card
  // right where the module will land, in that lane. The name is typed on the
  // card, the type picked from a row of icons under it (or by typing its
  // word); Enter makes it a draft, and the rest is filled in below the card.

  const editorEl = $('editor')
  const sketchName = $('sketch-name')
  const SKETCH = '__sketch'
  const TYPE_HINT = {
    code: '脚本、函数、类',
    data: '数据文件夹或文件，默认敏感',
    notebook: '.ipynb / .Rmd 分析',
    skill: 'Claude Code 的 skill',
    doc: '说明、手册、数据字典',
    test: '自动化测试',
    external: '项目外的 API、数据库',
  }
  // Typing one of these alone picks the type; a name ending in one suggests it.
  const TYPE_WORDS = {
    code: ['代码', 'code', '脚本', 'script', '函数', '程序'],
    data: ['数据', 'data', '表', 'csv', 'excel', 'xlsx', '数据集', 'dataset'],
    notebook: ['notebook', 'ipynb', 'rmd', 'jupyter', '笔记本'],
    skill: ['skill', '技能'],
    doc: ['文档', 'doc', '说明', 'readme', '手册'],
    test: ['测试', 'test', '校验'],
    external: ['外部服务', '外部', '服务', 'api', 'external'],
  }
  const DEFAULT_NAME = { code: '新模块', data: '新数据', notebook: '新 Notebook', skill: '新 Skill', doc: '新文档', test: '新测试', external: '新外部服务' }

  const typeWord = text => {
    const low = text.trim().toLowerCase()
    return low ? NODE_TYPES.find(t => TYPE_LABEL[t].toLowerCase() === low || TYPE_WORDS[t].includes(low)) || null : null
  }
  const typeEnding = text => {
    const low = text.trim().toLowerCase()
    return low ? NODE_TYPES.find(t => TYPE_WORDS[t].some(w => low.endsWith(w))) || null : null
  }

  function glyph(type) {
    const el = document.createElementNS(NS, 'svg')
    el.setAttribute('viewBox', '0 0 16 16')
    el.setAttribute('class', `ticon t-${type}`)
    s('path', { d: TYPE_ICON[type] }, el)
    return el
  }

  // The row of type icons under a card, the chosen one named at its end.
  // Pressing one leaves the focus where it was.
  function typeChips(current, pick) {
    const chip = type =>
      h(
        'button',
        {
          type: 'button',
          class: 'ed-type' + (type === current ? ' on' : ''),
          title: `${TYPE_LABEL[type]}：${TYPE_HINT[type]}`,
          role: 'radio',
          'aria-label': TYPE_LABEL[type],
          'aria-checked': String(type === current),
          onpointerdown: ev => ev.preventDefault(),
          onclick: () => pick(type),
        },
        glyph(type),
      )
    // Steps, then resources, each named.
    return h(
      'div',
      { class: 'ed-types', role: 'radiogroup', 'aria-label': '类型' },
      h('span', { class: 'ed-tgroup', text: '步骤' }),
      STEP_TYPES.map(chip),
      h('span', { class: 'ed-tsep' }),
      h('span', { class: 'ed-tgroup', text: '资料' }),
      RESOURCE_TYPES.map(chip),
      h('span', { class: 'ed-tlabel', text: TYPE_LABEL[current] }),
    )
  }

  const nameTaken = name =>
    S.graph.nodes.some(n => n.name === name) || (S.tasks || []).some(t => OPEN.has(t.status) && t.kind === 'add-node' && t.node && t.node.name === name)
  function freeName(stem) {
    let name = stem
    for (let i = 2; nameTaken(name); i++) name = `${stem} ${i}`
    return name
  }

  // Where a new card fits in a frame: as near the spot asked for as it can,
  // inside the frame's edge, above or below the cards in the way.
  function freeSpot(c, want, except, h = G.nodeH) {
    const x = snap(Math.max(FRAME.pad, want.x))
    const wantY = Math.max(FRAME.top, want.y)
    const at = y => ({ x, y, w: G.nodeW, h })
    const others = [...c.rel].filter(([id]) => id !== except).map(([, r]) => r)
    const tries = [wantY, ...others.flatMap(b => [b.y + b.h + G.gapY, b.y - G.nodeH - G.gapY]), Math.max(FRAME.top, ...others.map(b => b.y + b.h + G.gapY))].filter(
      y => y >= FRAME.top && !others.some(b => overlaps(at(y), b)),
    )
    const y = tries.reduce((best, t) => (Math.abs(t - wantY) < Math.abs(best - wantY) ? t : best), tries[0])
    return { x, y: snap(y) }
  }

  // From graph coordinates to the stage's.
  function toStage(x, y) {
    const sr = stage.getBoundingClientRect()
    const vr = svg.getBoundingClientRect()
    return { x: vr.left - sr.left + view.x + x * view.k, y: vr.top - sr.top + view.y + y * view.k }
  }

  // ---- the new card ----

  function openSketch(clientX, clientY, opts = {}) {
    if (!S.graph || !P) return
    closeMenu()
    closeEditor()
    const at = world({ clientX, clientY })
    let spot
    if (P.spine) {
      // The trunk view shows no groups: the group was chosen first, and the
      // card goes where the pointer was.
      if (!opts.layer || !S.graph.layers.some(l => l.id === opts.layer)) return
      spot = { layer: opts.layer, rel: null, at: { x: at.x - G.nodeW / 2, y: at.y - G.nodeH / 2 } }
    } else {
      const hit0 = opts.layer ? P.cols.find(x => x.layer.id === opts.layer) : frameAt(at)
      if (hit0 && hit0.folded) {
        L.collapsed = L.collapsed.filter(x => x !== hit0.layer.id)
        saveLayout()
        draw()
      }
      const c = hit0 && P.cols.find(x => x.layer.id === hit0.layer.id)
      // Modules go in groups; out on the empty canvas only groups are made.
      if (!c) {
        if (opts.usedBy) toast('把线拖到分组里的空白处，才能新建一个从它连出的模块。')
        return
      }
      spot = { layer: c.layer.id, rel: freeSpot(c, { x: at.x - c.box.x - G.nodeW / 2, y: at.y - c.box.y - G.nodeH / 2 }) }
    }
    // The name is typed on the card: zoomed far out, come in to read it,
    // keeping the spot pointed at where it is.
    if (view.k < 0.8) {
      const r = svg.getBoundingClientRect()
      zoomAt(clientX - r.left, clientY - r.top, 1 / view.k)
    }
    sketch = { ...spot, usedBy: opts.usedBy || null, type: opts.type || 'code', chosen: Boolean(opts.type), sent: false, name: '', error: '', born: Date.now() }
    editor = { id: SKETCH, kind: 'new' }
    editorEl.className = 'sketch'
    sketchName.value = ''
    sketchName.hidden = false
    renderSketch()
    editorEl.hidden = false
    draw()
    keepInView()
    sketchName.focus({ preventScroll: true })
  }

  // A new module from the trunk view, which shows no groups: which group it
  // goes in is asked first, the module it was dragged out of offering its own.
  function trunkNew(clientX, clientY, usedBy = null) {
    const layers = S.graph ? S.graph.layers : []
    if (!layers.length) return toast('还没有分组：先退出主线（Esc），在普通模式里新建一个分组。', 'error')
    if (layers.length === 1) return openSketch(clientX, clientY, { layer: layers[0].id, usedBy })
    const own = usedBy && M.byId.get(usedBy) ? M.byId.get(usedBy).layer : null
    const order = [...layers].sort((a, b) => (b.id === own) - (a.id === own))
    // After the press that asked for it, which would otherwise close it as a click outside.
    setTimeout(() =>
      openMenu(
        clientX,
        clientY,
        usedBy ? `从「${nameOf(usedBy)}」连出一个新模块，放进哪个分组？` : '新模块放进哪个分组？',
        order.map(l => ({ label: l.name + (l.id === own ? '（和它同组）' : ''), swatch: colorOf(l.id), run: () => openSketch(clientX, clientY, { layer: l.id, usedBy }) })),
      ),
    )
  }

  function renderSketch() {
    const typed = sketchName.value.trim()
    const as = typeWord(typed)
    const name = !typed || as ? freeName(DEFAULT_NAME[sketch.type]) : typed
    editorEl.replaceChildren(
      typeChips(sketch.type, type => {
        sketch.type = type
        sketch.chosen = true
        sketch.error = ''
        renderSketch()
        draw()
      }),
      h('div', {
        class: 'ed-note' + (sketch.error ? ' error' : ''),
        text: sketch.error || `回车新建${!typed || as ? `「${name}」` : ''}${sketch.type === 'data' ? '（先按敏感处理，卡片上可以改）' : ''} · Tab 换类型 · Esc 取消`,
      }),
    )
  }

  // What is typed may pick the type: a type's word alone, or a name ending in one.
  sketchName.addEventListener('input', () => {
    if (!sketch) return
    const typed = sketchName.value
    const before = sketch.type
    const as = typeWord(typed)
    if (as) sketch.type = as
    else if (!sketch.chosen) sketch.type = typeEnding(typed) || 'code'
    sketch.error = ''
    renderSketch()
    if (sketch.type !== before) draw()
  })
  sketchName.addEventListener('keydown', ev => {
    if (!sketch || ev.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Enter') submitSketch()
    else if (ev.key === 'Escape') closeEditor(false)
    else if (ev.key === 'Tab') {
      const i = TYPE_ORDER.indexOf(sketch.type)
      sketch.type = TYPE_ORDER[(i + (ev.shiftKey ? -1 : 1) + TYPE_ORDER.length) % TYPE_ORDER.length]
      sketch.chosen = true
      renderSketch()
      draw()
    } else return
    ev.preventDefault()
    ev.stopPropagation()
  })

  // The card stays where it is, as the draft it asks for, until the server
  // has it; `more` opens the rest of its fields then (Enter, not a click away).
  function submitSketch(more = true) {
    const typed = sketchName.value.trim()
    const as = typeWord(typed)
    const type = as || sketch.type
    const name = !typed || as ? freeName(DEFAULT_NAME[type]) : typed
    if (nameTaken(name)) {
      sketch.error = `已经有叫「${name}」的模块了，换个名字`
      renderSketch()
      return false
    }
    Object.assign(sketch, { sent: true, name, type })
    pendingPlace = { name, rel: sketch.rel, more, since: Date.now() }
    // Dragged out of a module on the main line on show: by default the step right after it (the editor can change it).
    const line = P && P.spine ? shownFlow() : null
    const after = line && sketch.usedBy ? line.flow.steps.findIndex(s => s.node === sketch.usedBy) : -2
    const flowStep = after >= 0 ? { flow: line.flow.id, after, node: sketch.usedBy } : undefined
    propose({ type: 'add-node', name, nodeType: type, layer: sketch.layer, summary: '', dependsOn: '', usedBy: sketch.usedBy || '', ...(flowStep ? { flowStep } : {}) })
    editor = null
    editorEl.hidden = true
    editorEl.replaceChildren()
    sketchName.hidden = true
    draw()
    // Refused (the server says why): the card goes after a while.
    setTimeout(() => {
      if (sketch && sketch.sent && pendingPlace && pendingPlace.name === name) {
        sketch = null
        pendingPlace = null
        draw()
      }
    }, 8000)
    return true
  }

  // The draft the new card asked for, now on the server: it takes the card's
  // place, and the rest of its fields open under it.
  function placePending() {
    if (!pendingPlace) return null
    const pp = pendingPlace
    const t = (S.tasks || [])
      .filter(x => x.kind === 'add-node' && x.status === 'draft' && x.node && x.node.name === pp.name)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!t) return null
    pendingPlace = null
    if (sketch && sketch.sent) sketch = null
    // Made in the trunk view: its group places it when the groups are back.
    if (pp.rel) {
      setPos(t.node.id, pp.rel)
      saveLayout(false)
    }
    return pp.more ? t.node.id : null
  }

  // ---- the box under a draft ----

  // `focus`: 'name' when opened to edit; 'rest' right after the card was made.
  function openEditor(id, focus = 'name') {
    const n = M && M.byId.get(id)
    if (!n || !n.ghost) return
    if (!isDraft(n)) return toast(`已经交给 ${AGENT} 了；要改，先撤回再重新提。`, 'error')
    closeEditor()
    const node = n.task.node
    editor = {
      id,
      kind: 'add',
      taskId: n.task.id,
      v: { name: node.name, nodeType: nodeType(node), summary: node.summary || '', path: (node.files || [])[0] || '', sensitive: node.sensitive !== false },
    }
    editorEl.className = ''
    renderEditor()
    editorEl.hidden = false
    draw()
    keepInView()
    const field = focus === 'rest' ? editorEl.querySelector('.ed-path') || editorEl.querySelector('.ed-summary') : editorEl.querySelector('.ed-name')
    field.focus({ preventScroll: true })
    if (focus !== 'rest') field.select()
  }

  // What the text fields hold that the server has not been told yet, sent as one change.
  function flushEditor() {
    if (!editor || editor.kind !== 'add') return
    const change = {}
    const name = editorEl.querySelector('.ed-name')
    const path = editorEl.querySelector('.ed-path')
    const summary = editorEl.querySelector('.ed-summary')
    if (name && name.value.trim() && name.value.trim() !== editor.v.name) change.name = editor.v.name = name.value.trim()
    if (path && path.value.trim() !== editor.v.path) change.path = editor.v.path = path.value.trim()
    if (summary && summary.value.trim() !== editor.v.summary) change.summary = editor.v.summary = summary.value.trim()
    if (Object.keys(change).length) editDraft(editor.taskId, change)
  }

  function renderEditor() {
    const v = editor.v
    const taskId = editor.taskId
    const t = (S.tasks || []).find(x => x.id === taskId)
    const onEnter = ev => {
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter' && (ev.target.tagName !== 'TEXTAREA' || ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault()
        closeEditor()
      }
    }
    const name = h('input', { class: 'ed-name', type: 'text', maxlength: 80, value: v.name, 'aria-label': '名字', onkeydown: onEnter, onblur: flushEditor })
    const types = typeChips(v.nodeType, type => {
      if (type === v.nodeType) return
      flushEditor()
      v.nodeType = type
      editDraft(taskId, { nodeType: type })
      renderEditor()
    })
    const data =
      v.nodeType === 'data'
        ? h(
            'div',
            { class: 'ed-data' },
            h(
            'div',
            { class: 'ed-row' },
            h('input', { class: 'ed-path', type: 'text', value: v.path, placeholder: '位置，例如 data/raw/（可以不写）', 'aria-label': '位置', onkeydown: onEnter, onblur: flushEditor }),
            h(
              'button',
              {
                type: 'button',
                class: 'ed-lock' + (v.sensitive ? ' on' : ''),
                title: v.sensitive ? `敏感：${AGENT} 直接查看内容会被拒绝，画布不列出里面的文件` : '不敏感：可以显示和读取',
                onclick: () => {
                  v.sensitive = !v.sensitive
                  editDraft(taskId, { sensitive: v.sensitive })
                  renderEditor()
                },
              },
              v.sensitive ? lockGlyph() : null,
              v.sensitive ? '敏感' : '不敏感',
            ),
            ),
            h('div', {
              class: 'ed-note',
              text: v.sensitive
                ? `含患者信息就保持敏感：${AGENT} 直接查看里面的内容会被拒绝，只能写脚本处理。`
                : `不敏感：${AGENT} 可以直接打开里面的文件，内容会进到对话里。`,
            }),
          )
        : null
    const [ask, example] = TYPE_ASK[v.nodeType]
    const summary = h('textarea', {
      class: 'ed-summary',
      rows: 2,
      placeholder: example.startsWith('例如') ? `${ask}，${example}` : example,
      'aria-label': ask,
      onkeydown: onEnter,
      onblur: flushEditor,
    })
    summary.value = v.summary
    const wiring = t
      ? [t.nodeIds.length ? `调用 ${t.nodeIds.map(nameOf).join('、')}` : '', (t.usedBy || []).length ? `供 ${t.usedBy.map(nameOf).join('、')} 调用` : ''].filter(Boolean)
      : []
    // In the trunk view, or once placed in a line: which step of the main line it is to be, if any.
    const lineId = (t && t.flowStep && t.flowStep.flow) || (P && P.spine ? mainFlow : null)
    const flow = lineId && S.graph && (S.graph.flows || []).find(f => f.id === lineId)
    const stepRow = flow
      ? h(
          'div',
          { class: 'ed-row ed-flow' },
          h('span', { class: 'ed-note', text: `主线「${flow.name}」` }),
          h(
            'select',
            {
              'aria-label': '放进主线',
              onchange: ev => {
                const v = ev.target.value
                editDraft(taskId, { flowStep: v === '' ? null : { flow: flow.id, after: Number(v), ...(flow.steps[Number(v)] ? { node: flow.steps[Number(v)].node } : {}) } })
              },
            },
            h('option', { value: '', text: '不放进主线' }),
            h('option', { value: '-1', text: '作为第一步' }),
            flow.steps.map((s, i) => h('option', { value: String(i), text: `第 ${i + 1} 步「${nameOf(s.node)}」之后` })),
          ),
        )
      : null
    if (stepRow) {
      const sel = stepRow.querySelector('select')
      sel.value = t && t.flowStep && t.flowStep.flow === flow.id ? String(placeAt(flow, t.flowStep)) : ''
    }
    editorEl.replaceChildren(
      ...[name, types, data, summary, stepRow].filter(Boolean),
      h(
        'div',
        { class: 'ed-foot' },
        h('span', {
          class: 'ed-note',
          text:
            [t ? `在「${layerName(t.node.layer)}」` : '', ...wiring].filter(Boolean).join(' · ') +
            (P && P.spine ? '。拖右侧圆点连到别的模块；要换分组，右键它选「移到分组」。' : '。拖右侧圆点连到别的模块，拖进别的分组就换过去。'),
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small danger',
            onclick: () => {
              closeEditor(false)
              cancelTask(taskId)
            },
          },
          '撤回',
        ),
        h('button', { type: 'button', class: 'btn small primary', onclick: () => closeEditor() }, '完成'),
      ),
    )
  }

  // A comment on a module, written under its card instead of in a dialog.
  function openComment(id) {
    closeEditor()
    const key = `comment-${id}`
    editor = { id, kind: 'comment' }
    editorEl.className = ''
    const area = h('textarea', { class: 'ed-summary', rows: 3, placeholder: '想怎么改？例如：缺失评分改成用中位数填补，不要直接丢掉', 'aria-label': '意见' })
    area.value = drafts[key] || ''
    const send = () => {
      const text = area.value.trim()
      if (!text) return toast('意见是空的。', 'error')
      propose({ type: 'comment', nodeId: id, text })
      drafts[key] = ''
      closeEditor()
    }
    area.addEventListener('input', () => (drafts[key] = area.value))
    area.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
        ev.preventDefault()
        send()
      }
    })
    editorEl.replaceChildren(
      h('div', { class: 'ed-title', text: `给 ${AGENT} 提意见：${nameOf(id)}` }),
      area,
      h(
        'div',
        { class: 'ed-foot' },
        h('span', { class: 'ed-note', text: `交给 ${AGENT} 时一起处理 · Ctrl+Enter 加入` }),
        h('button', { type: 'button', class: 'btn small', onclick: () => closeEditor() }, '取消'),
        h('button', { type: 'button', class: 'btn small primary', onclick: send }, '加入提议'),
      ),
    )
    editorEl.hidden = false
    draw()
    keepInView()
    area.focus({ preventScroll: true })
  }

  // `keep` false drops what the box holds: Esc on a new card, or a draft
  // that is gone or handed over. Leaving a new card that has a name makes it.
  function closeEditor(keep = true) {
    if (!editor) return
    if (editor.kind === 'new') {
      if (keep && sketch && !sketch.sent && sketchName.value.trim()) {
        submitSketch(false)
        return
      }
      sketch = null
      sketchName.hidden = true
    } else if (keep) flushEditor()
    editor = null
    editorEl.hidden = true
    editorEl.replaceChildren()
    if (M) draw()
  }

  // The box sits under its card (above it when there is no room), and a new
  // card's name field on the card itself, both following pans and zooms.
  function placeOverlays() {
    if (titleEdit && P) {
      const c = P.cols.find(x => x.layer.id === titleEdit.layer)
      if (c) {
        const at = toStage(c.box.x + 24, c.box.y + (c.folded ? 9 : 16))
        titleInput.style.left = `${at.x}px`
        titleInput.style.top = `${at.y}px`
        titleInput.style.width = `${Math.max(120, c.box.w - 110)}px`
        titleInput.style.transform = `scale(${view.k})`
      }
    }
    if (!editor || !P) return
    const b = P.boxes.get(editor.id)
    if (!b) return
    const W = stage.clientWidth
    const H = stage.clientHeight
    if (editor.kind === 'new') {
      const at = toStage(b.x + 32, b.y + 11)
      sketchName.style.left = `${at.x}px`
      sketchName.style.top = `${at.y}px`
      sketchName.style.transform = `scale(${view.k})`
    }
    const w = editorEl.offsetWidth
    const hh = editorEl.offsetHeight
    const tl = toStage(b.x, b.y)
    const br = toStage(b.x + b.w, b.y + b.h)
    let left = tl.x
    let top = br.y + 8
    if (top + hh > H) {
      if (tl.y - 8 - hh >= 8) top = tl.y - 8 - hh
      else {
        // No room above or below: beside the card, never over it.
        top = clamp(tl.y, 8, H - hh)
        left = br.x + 8 + w <= W - 8 ? br.x + 8 : tl.x - 8 - w
      }
    }
    editorEl.style.left = `${clamp(left, 8, W - w - 8)}px`
    editorEl.style.top = `${top}px`
  }

  // The box belongs under its card: when the stage has no room there, the
  // canvas moves up rather than the box jumping above the card.
  function keepInView() {
    const b = editor && P && P.boxes.get(editor.id)
    if (!b) return
    const shift = Math.min(toStage(b.x, b.y + b.h).y + editorEl.offsetHeight + 24 - stage.clientHeight, toStage(b.x, b.y).y - 8)
    if (shift <= 0) return
    view.y -= shift
    applyView()
  }

  // A press outside the box closes it. The path is taken as the press began:
  // a press on the canvas may have redrawn (and so removed) what it hit.
  document.addEventListener('pointerdown', ev => {
    const path = ev.composedPath()
    if (editor && !path.includes(editorEl) && !path.includes(sketchName) && !path.includes(svg)) closeEditor()
  })
  // In a new card's box the name keeps the focus, so Enter still makes it.
  editorEl.addEventListener('pointerdown', ev => {
    if (editor && editor.kind === 'new' && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) ev.preventDefault()
  })

  // ---- side panel ----

  function when(ms) {
    const d = new Date(ms)
    const p = n => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function inline(text) {
    const out = []
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
    let last = 0
    let m
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index))
      const tok = m[0]
      out.push(tok[0] === '`' ? h('code', { text: tok.slice(1, -1) }) : h('strong', { text: tok.slice(2, -2) }))
      last = m.index + tok.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }
  function md(text) {
    const box = h('div', { class: 'p-md' })
    let ul = null
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      if (!line.trim()) {
        ul = null
        continue
      }
      const item = /^\s*[-*]\s+(.*)$/.exec(line)
      if (item) {
        if (!ul) box.append((ul = h('ul')))
        ul.append(h('li', {}, inline(item[1])))
        continue
      }
      ul = null
      const head = /^#{1,6}\s+(.*)$/.exec(line)
      box.append(head ? h('h4', {}, inline(head[1])) : h('p', {}, inline(line)))
    }
    return box
  }

  function diffBlock(text) {
    const pre = h('pre', { class: 'diff' })
    for (const line of (text || '（没有文字改动）').split('\n')) {
      const cls = line.startsWith('@@') ? 'd-hunk' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : ''
      pre.append(h('span', { class: cls, text: line || ' ' }))
    }
    return pre
  }

  const section = (title, ...kids) => h('div', { class: 'p-sec' }, h('h3', {}, title), kids)
  const withId = (id, el) => ((el.id = id), el)
  const statusTag = t => h('span', { class: `status ${t.status}`, text: isStale(t) ? `${AGENT} 上次没做完` : STATUS[t.status] })

  function clock(iso) {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : when(d.getTime())
  }

  async function loadTalk(id) {
    talks.set(id, { loading: true })
    renderPanel()
    try {
      talks.set(id, await request(`/api/conversation?change=${encodeURIComponent(id)}`))
    } catch (err) {
      talks.set(id, { error: `对话记录读不出来：${err.message}` })
    }
    renderPanel()
  }

  // The exchange behind a change: the person's message, Claude's words just
  // before the edit, and how the edit went.
  function talkBlock(id) {
    const t = talks.get(id)
    if (!t || t.loading) return h('div', { class: 'talk' }, h('div', { class: 'p-empty', text: '读取对话记录…' }))
    if (t.error) return h('div', { class: 'talk' }, h('div', { class: 'p-empty', text: t.error }))
    const msg = (who, cls, text, at) =>
      h('div', { class: `msg ${cls}` }, h('div', { class: 'who' }, who, at ? h('span', { class: 'at', text: clock(at) }) : null), h('div', { class: 'said', text }))
    return h(
      'div',
      { class: 'talk' },
      t.otherSession ? h('div', { class: 'p-empty', text: '来自另一个会话' }) : null,
      t.prompt ? msg(t.prompt.viaCanvas ? `你（从画布交给 ${AGENT}）` : '你', 'you', t.prompt.text, t.prompt.at) : h('div', { class: 'p-empty', text: '（这一轮开头的消息找不到了，可能在压缩前）' }),
      t.said.map(s => msg(`${AGENT}`, 'claude', s.text, s.at)),
      h('div', { class: `msg edit ${t.result && t.result.isError ? 'failed' : ''}` }, h('div', { class: 'who' }, '改动', h('span', { class: 'at', text: clock(t.at) })), h('div', { class: 'said', text: t.result ? (t.result.isError ? `没有成功：${t.result.text}` : '已写入') : '（没有找到执行结果）' })),
    )
  }

  function changeRow(c, withModules) {
    const task = c.taskId ? (S.tasks || []).find(t => t.id === c.taskId) : null
    const isOpen = openDiffs.has(c.id)
    const isTalk = openTalks.has(c.id)
    const mods = withModules
      ? (c.nodeIds || []).map((id, i) => [i ? '、' : ' · ', h('button', { type: 'button', class: 'mod-link', onclick: () => select(id), text: nameOf(id) })])
      : []
    return h(
      'div',
      { class: 'row' },
      h(
        'div',
        { class: 'row-top' },
        h('div', { class: 'row-main' }, h('span', { class: 'mono', text: c.file }), h('span', { class: 'plus', text: `+${c.added}` }), h('span', { class: 'minus', text: `−${c.removed}` })),
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              onclick: () => {
                if (isOpen) openDiffs.delete(c.id)
                else openDiffs.add(c.id)
                renderPanel()
              },
            },
            isOpen ? '收起' : '看改动',
          ),
          c.toolUseId
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn small',
                  onclick: () => {
                    if (isTalk) openTalks.delete(c.id)
                    else {
                      openTalks.add(c.id)
                      if (!talks.has(c.id) || talks.get(c.id).error) return loadTalk(c.id)
                    }
                    renderPanel()
                  },
                },
                isTalk ? '收起对话' : '看对话',
              )
            : null,
        ),
      ),
      h('div', { class: 'row-sub' }, when(c.at), mods, task ? ` · ${task.text}` : '', S.sessionId && c.sessionId !== S.sessionId ? ' · 另一个会话' : ''),
      isOpen ? diffBlock(c.diff) : null,
      isTalk ? talkBlock(c.id) : null,
    )
  }

  function taskRow(t) {
    return h(
      'div',
      { class: 'row' },
      h(
        'div',
        { class: 'row-top' },
        h('div', { class: 'row-main' }, statusTag(t), h('span', { class: 'muted', text: KIND[t.kind] })),
        OPEN.has(t.status) ? h('button', { type: 'button', class: 'btn small', onclick: () => cancelTask(t.id) }, '取消') : null,
      ),
      h('div', { class: 'p-text', text: t.text }),
      t.summary ? h('div', { class: 'row-sub', text: `${AGENT}：${t.summary}` }) : null,
    )
  }

  // A map Claude drew again whose structure changed: what changed, and the person's yes or no.
  function pendingNote() {
    const p = S.pending
    if (!p || !p.graph) return null
    return withId(
      'next-sec',
      h(
        'div',
        { class: 'p-banner next' },
        h('b', { text: `${AGENT} 重新画了架构图，等你确认` }),
        h('ul', { class: 'diff' }, (p.lines || []).map(l => h('li', { text: l }))),
        h('div', { class: 'row-sub', text: '你在画布上改过的分组名、模块所在分组、连线类型、归属文件和敏感标记会保留。确认前画布上还是现在这张图。' }),
        h(
          'div',
          { class: 'line' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => propose({ type: 'accept-next' }) }, '采用新图'),
          h('button', { type: 'button', class: 'btn small', onclick: () => propose({ type: 'reject-next' }) }, '保留现在的图'),
        ),
      ),
    )
  }

  // A module whose code changed after the map last looked at it: what changed,
  // and either the agent checks it or the person says it still holds.
  function staleBanner(n) {
    const files = staleMap().get(n.id)
    if (!files) return null
    const some = `${files.slice(0, 4).join('、')}${files.length > 4 ? ` 等 ${files.length} 个文件` : ''}`
    return h(
      'div',
      { class: 'p-banner stale' },
      h('div', { text: `画好架构图以后，这个模块的代码改过（${some}），职责、连线和依据可能要更新。` }),
      h(
        'div',
        { class: 'line' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn link',
            onclick: () =>
              propose({ type: 'comment', nodeId: n.id, text: `核对「${n.name}」：画好架构图以后它的代码改过（${files.slice(0, 6).join('、')}），看看职责、连线和代码依据是否还对，需要的话更新架构图。` }),
          },
          `请 ${AGENT} 核对`,
        ),
        h('button', { type: 'button', class: 'btn link', onclick: () => propose({ type: 'mark-seen', nodeId: n.id }) }, '我看过了，还是对的'),
      ),
    )
  }

  // The overview: how many modules may have fallen behind their code.
  function staleNote() {
    const ids = [...staleMap().keys()]
    if (!ids.length) return null
    return h(
      'div',
      { class: 'p-banner stale' },
      `画好架构图以后，${ids.length} 个模块的代码改过，图上的说明可能过时：${ids.slice(0, 6).map(nameOf).join('、')}${ids.length > 6 ? ' 等' : ''}。`,
      h('button', { type: 'button', class: 'btn link', onclick: () => propose({ type: 'recheck', nodeIds: ids }) }, `让 ${AGENT} 核对这些模块`),
    )
  }

  // A module's upstream and downstream, nearest first: a click goes there.
  function reachSection(n) {
    if (n.ghost) return null
    const whole = reachOf(n.id)
    if (!whole.up.size && !whole.down.size) return null
    const all = L.reach === 'all'
    const tr = all ? whole : reachOf(n.id, 1)
    // Lit and listed: the modules it touches, or all the way. A module many
    // others use would light up most of the map all the way.
    const pick = h(
      'div',
      { class: 'chips reach-pick' },
      h('span', { class: 'chip' + (all ? '' : ' on'), title: '只亮直接相连的模块和连线', onclick: () => setReach(false) }, '直接相连'),
      h('span', { class: 'chip' + (all ? ' on' : ''), title: '顺着箭头一路往上、往下，全部亮起来', onclick: () => setReach(true) }, `全部上下游（上游 ${whole.up.size} · 下游 ${whole.down.size}）`),
    )
    const chips = map =>
      map.size
        ? h(
            'div',
            { class: 'chips' },
            [...map]
              .sort((a, b) => a[1] - b[1] || nameOf(a[0]).localeCompare(nameOf(b[0]), 'zh'))
              .map(([x, d]) =>
                h('span', { class: 'chip' + (d > 1 ? ' only' : ''), onclick: () => select(x), title: d > 1 ? `隔了 ${d - 1} 个模块` : '直接相连' }, dot(nodeColor(x), 'dot-chip'), nameOf(x)),
              ),
          )
        : h('div', { class: 'p-empty', text: '没有' })
    return section(
      '上下游',
      h('div', { class: 'row-sub', text: '逆着箭头往上是上游，顺着箭头往下是下游，图上亮起来的就是这些；鼠标移到其中一条线上，只看这一条。只按图上画的连线算（「关联」线不算），不等于改了它一定会影响到。' }),
      pick,
      h('div', { class: 'reach-head', text: `上游 ${tr.up.size}` }),
      chips(tr.up),
      h('div', { class: 'reach-head', text: `下游 ${tr.down.size}` }),
      chips(tr.down),
    )
  }

  // Whether the map's lines say where they are in the code; a button has the agent find out.
  function evidenceNote() {
    const edges = M.edges.filter(e => e.state === 'normal')
    const unsure = edges.filter(e => e.unsure).length
    const any = edges.some(e => e.sources && e.sources.length) || M.nodes.some(n => n.sources && n.sources.length)
    if (!edges.length || (any && !unsure)) return null
    return h(
      'div',
      { class: 'p-banner evidence' },
      any
        ? `${unsure} 条连线未确认：没找到它们在代码里的位置（图上画成点线）。`
        : `这张图还没有代码依据：连线是 ${AGENT} 读代码后概括的，没有标出具体在哪几行。`,
      h('button', { type: 'button', class: 'btn link', onclick: () => propose({ type: 'evidence' }) }, `让 ${AGENT} 补上依据`),
    )
  }

  // ---- the map held against the code ----
  // The mod reads the code (imports, source() calls, paths in strings, R
  // functions another file defines) and saves where map and code differ.

  // The check as the mod last saved it; empty lists when there is none.
  function auditOf(st) {
    const a = st && st.audit && typeof st.audit === 'object' ? st.audit : null
    const list = k => (a && Array.isArray(a[k]) ? a[k] : [])
    return {
      any: Boolean(a),
      at: (a && a.at) || 0,
      scanned: (a && a.scanned) || 0,
      truncated: Boolean(a && a.truncated),
      uncovered: list('uncovered'),
      missing: list('missing'),
      unfound: list('unfound'),
      doubtful: list('doubtful'),
      moved: list('moved'),
    }
  }

  // What still differs, the lines whose modules have gone left out.
  function auditFindings() {
    const a = auditOf(S)
    const both = x => M.byId.has(x.from) && M.byId.has(x.to)
    const out = { ...a, missing: a.missing.filter(both), unfound: a.unfound.filter(both), doubtful: a.doubtful.filter(both) }
    out.count = out.uncovered.length + out.missing.length + out.unfound.length + out.doubtful.length
    return out
  }

  // A tie the code shows: where, and one click to draw it with those lines as its evidence.
  function tieRow(t) {
    return h(
      'div',
      { class: 'audit-row' },
      h('span', { class: 'link', title: `打开代码：${t.at.map(sourceText).join('、')}`, onclick: () => openSource(t.at[0]), text: `${nameOf(t.from)} ${KIND_WORD[t.kind]} ${nameOf(t.to)}` }),
      h('span', { class: 'muted mono', text: sourceText(t.at[0]) }),
      h('button', { type: 'button', class: 'btn link', title: '把这条线画到图上，依据就是这几行', onclick: () => propose({ type: 'add-found-edge', from: t.from, to: t.to }) }, '画上'),
    )
  }

  // A module's ties the code shows that the map does not draw.
  function tiesSection(id) {
    const ties = auditFindings().missing.filter(t => t.from === id || t.to === id)
    if (!ties.length) return null
    return section(`代码里有、图上没画（${ties.length}）`, h('div', { class: 'row-sub', text: '按 import、source() 和代码里写的路径找到的。点名字看代码，「画上」把它连到图上。' }), ties.map(tieRow))
  }

  // The overview's word on it: how much differs, and the way to the list.
  function auditBanner() {
    const a = auditFindings()
    const stale = M.edges.filter(e => e.state === 'normal' && e.vouched && vouchChanged(e).length).length
    if (!a.count && !stale) return null
    const parts = [
      a.uncovered.length ? `${a.uncovered.length} 个代码文件没归进模块` : '',
      a.missing.length ? `${a.missing.length} 处关系图上没画` : '',
      a.unfound.length ? `${a.unfound.length} 条调用代码里没找到` : '',
      a.doubtful.length ? `${a.doubtful.length} 处依据存疑` : '',
    ].filter(Boolean)
    const after = stale ? `${stale} 条已核实的连线，核实后代码改过。` : ''
    return h(
      'div',
      { class: 'p-banner evidence' },
      parts.length ? `图和代码有出入：${parts.join('，')}。${after}` : after,
      h('button', { type: 'button', class: 'btn link', onclick: () => $('audit-sec') && $('audit-sec').scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '看详情'),
    )
  }

  // Every difference, each a click from its code or module; the agent can be handed them all.
  function auditSection() {
    const a = auditFindings()
    if (!a.any) return null
    const MAX = 20
    const rows = (list, row) => [...list.slice(0, MAX).map(row), list.length > MAX ? h('div', { class: 'p-empty', text: `另有 ${list.length - MAX} 处没列出。` }) : null]
    const group = (title, list, row) => [h('div', { class: 'reach-head', text: `${title}（${list.length}）` }), ...rows(list, row)]
    // Lines vouched for, those whose code changed since first.
    const vouched = M.edges
      .filter(e => e.state === 'normal' && e.vouched)
      .map(e => ({ e, after: vouchChanged(e) }))
      .sort((x, y) => y.after.length - x.after.length)
    // Folded unless the person opened it, or one of them needs a look.
    const changedN = vouched.filter(v => v.after.length).length
    const open = vouchedOpen === null ? changedN > 0 : vouchedOpen
    const vouchedHead = h(
      'div',
      {
        class: 'reach-head fold-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(open),
        onclick: () => {
          vouchedOpen = !open
          renderPanel()
        },
        onkeydown: ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), (vouchedOpen = !open), renderPanel()),
      },
      h('span', { class: 'fold-mark', text: open ? '▾' : '▸' }),
      `已核实、不再核对的连线（${vouched.length}${changedN ? `，${changedN} 条核实后改过` : ''}）`,
    )
    // A line the check cannot read but someone knows is there: how it is called, in one pick.
    const viaFor = x => x.via || (a.unfound.find(u => u.from === x.from && u.to === x.to) || {}).via
    const vouchButton = x =>
      h(
        'button',
        { type: 'button', class: 'btn link', title: '代码里看不出来，但这条线确实存在：选一下是怎么调用的，以后核对不再报它', onclick: ev => openMenu(ev.clientX, ev.clientY, '确实存在：怎么调用的？', vouchItems({ ...x, via: viaFor(x) })) },
        '确认存在',
      )
    return withId(
      'audit-sec',
      section(
        a.count ? `代码核对（${a.count}）` : '代码核对',
        h('div', { class: 'row-sub', text: `${when(a.at)} 按 import、source()、代码里写的路径、函数名和网络接口自动对照，读了 ${a.scanned} 个代码文件${a.truncated ? '（文件太多，只读了一部分）' : ''}。会有误报，以代码为准。` }),
        a.count ? null : h('div', { class: 'p-empty', text: '图和代码对得上：代码文件都归进了模块，代码里的依赖图上都画了。' }),
        a.uncovered.length
          ? group('没归进模块的代码文件', a.uncovered, p => h('div', { class: 'audit-row' }, h('span', { class: 'link mono', text: p, title: '在文件树里打开，可以归到某个模块', onclick: () => selectFile(p) })))
          : null,
        a.missing.length ? group('代码里有、图上没画', a.missing, tieRow) : null,
        a.unfound.length
          ? group('图上画了、代码里没找到', a.unfound, u =>
              h(
                'div',
                { class: 'audit-row' },
                h('span', { class: 'link', text: `${nameOf(u.from)} 调用 ${nameOf(u.to)}`, title: `看「${nameOf(u.from)}」`, onclick: () => select(u.from) }),
                u.reversed ? h('span', { class: 'muted', text: '代码里是反过来引用的' }) : null,
                u.via ? h('span', { class: 'link muted', text: `可能经「${viaName(u.via)}」传入`, title: `「${viaName(u.via)}」同时引用了两者，可能是它把后者作为参数交给前者。打开 ${sourceText(u.via)}`, onclick: () => openSource(u.via) }) : null,
                vouchButton(u),
              ),
            )
          : null,
        a.doubtful.length
          ? group('依据没提到被调用的模块', a.doubtful, d =>
              h(
                'div',
                { class: 'audit-row' },
                h('span', { class: 'link', text: `${nameOf(d.from)} → ${nameOf(d.to)}`, title: '打开这几行', onclick: () => openSource(d.source) }),
                h('span', { class: 'muted mono', text: sourceText(d.source) }),
                d.changed ? h('span', { class: 'muted', text: '原来那几行已改写' }) : null,
                vouchButton(d),
              ),
            )
          : null,
        vouched.length ? vouchedHead : null,
        vouched.length && open
          ? rows(vouched, ({ e, after }) =>
              h(
                'div',
                { class: 'audit-row' },
                h('span', { class: 'link', text: edgeText(e), title: `看「${nameOf(e.from)}」`, onclick: () => select(e.from) }),
                h('span', { class: 'muted', text: vouchText(e.vouched) }),
                after.length
                  ? h('span', { class: 'link stale-note', text: `核实后改过：${filesText(after)}`, title: `打开 ${after[0]}。改过之后调用可能已经不在了，看一眼再定`, onclick: () => selectFile(after[0]) })
                  : null,
                h(
                  'span',
                  { class: 'acts' },
                  after.length
                    ? h('button', { type: 'button', class: 'btn link', title: '看过了，调用还在', onclick: () => propose({ type: 'vouch-edge', from: e.from, to: e.to, why: e.vouched.why, ...(e.vouched.where ? { where: e.vouched.where } : {}) }) }, '还是对的')
                    : null,
                  after.length ? h('button', { type: 'button', class: 'btn link', title: `交给 ${AGENT} 再看一遍`, onclick: () => askToRevouch(e, after) }, `请 ${AGENT} 再核对`) : null,
                  h('button', { type: 'button', class: 'btn link', title: '代码核对会重新检查这条线', onclick: () => propose({ type: 'vouch-edge', from: e.from, to: e.to, why: '' }) }, '取消'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { class: 'line audit-actions' },
          a.count ? h('button', { type: 'button', class: 'btn small primary', onclick: () => propose({ type: 'audit-fix' }) }, `交给 ${AGENT} 核对修正`) : null,
          h('button', { type: 'button', class: 'btn small', onclick: () => propose({ type: 'audit' }) }, '重新核对'),
        ),
      ),
    )
  }

  function handoverBox(draftsN) {
    if (!draftsN) return null
    return h(
      'div',
      { class: 'cta' },
      h('p', { text: `这些改动交给 ${AGENT} 实施后才会写进代码和架构图；${AGENT} 会先在对话里给出计划，等你确认。` }),
      h('button', { type: 'button', class: 'btn primary', onclick: handover }, `交给 ${AGENT} 实施（${draftsN}）`),
    )
  }

  // ---- main lines ----
  // The order a whole run goes through the modules, as the agent read it from
  // the code: numbered on the cards, step to step on the canvas, listed here.

  // The overview's word: the main lines to look at, or the agent to draw them.
  function flowsNote() {
    const flows = (S.graph && S.graph.flows) || []
    if (!flows.length) {
      return h(
        'div',
        { class: 'p-banner evidence' },
        '这张图还没有主线：看不出一次完整流程按什么顺序经过哪些模块。',
        h('button', { type: 'button', class: 'btn link', onclick: () => propose({ type: 'flows' }) }, `让 ${AGENT} 画出主线`),
      )
    }
    return section(
      `主线（${flows.length}）`,
      flows.map(f =>
        h(
          'div',
          { class: 'sens-row' },
          h('span', { class: 'link', text: f.name, onclick: () => setFlow(f.id) }),
          h('span', { class: 'muted', text: `${f.steps.length} 步：${f.steps.slice(0, 4).map(st => nameOf(st.node)).join(' → ')}${f.steps.length > 4 ? ' → …' : ''}` }),
          h('button', { type: 'button', class: 'btn small', onclick: () => setFlow(f.id) }, '看主线'),
        ),
      ),
    )
  }

  // A word on a main line or one of its steps, written in the step list: the
  // step open for it (`step` from 0, -1 for the whole line), and its box.
  let stepAsk = null
  function askStep(flowId, step) {
    stepAsk = stepAsk && stepAsk.flow === flowId && stepAsk.step === step ? null : { flow: flowId, step }
    renderPanel()
    const el = stepAsk && panelBody.querySelector(`[data-key="${CSS.escape(stepKey(flowId, step))}"]`)
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }
  }
  const stepKey = (flowId, step) => `flowstep-${flowId}-${step}`
  function stepCompose(flowId, step) {
    const key = stepKey(flowId, step)
    // The words stay in the box until they have reached the agent.
    const send = async () => {
      const text = (drafts[key] || '').trim()
      if (!text) return toast('意见是空的。', 'error')
      if (!(await propose({ type: 'flow-comment', flowId, ...(step >= 0 ? { step } : {}), text }))) return
      drafts[key] = ''
      stepAsk = null
      renderPanel()
    }
    return h(
      'div',
      { class: 'compose step-compose', onclick: ev => ev.stopPropagation(), ondblclick: ev => ev.stopPropagation() },
      h('textarea', {
        'data-key': key,
        rows: 2,
        placeholder: step >= 0 ? '哪里不对？例如：这一步应该在校验之后；这里其实是读缓存，不调模型' : '整条主线哪里不对？例如：漏了写出报告这一步；顺序整体反了',
        oninput: ev => (drafts[key] = ev.target.value),
        onkeydown: ev => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) send()
          if (ev.key === 'Escape') {
            ev.stopPropagation()
            askStep(flowId, step)
          }
        },
      }),
      h(
        'div',
        { class: 'line' },
        h('button', { type: 'button', class: 'btn small primary', onclick: send }, '加入提议'),
        h('button', { type: 'button', class: 'btn small', onclick: () => askStep(flowId, step) }, '取消'),
      ),
    )
  }
  // What the person already said about a step, or the whole line, still open.
  function stepNotes(flowId, step) {
    const said = M.tasks.filter(t => t.flow && t.flow.id === flowId && (step >= 0 ? t.flow.step === step : t.flow.step === undefined))
    return said.map(t => h('div', { class: 'step-said', title: t.text }, `${t.status === 'draft' ? '已提' : '已交给 ' + AGENT}：${t.text.replace(/^主线「[^」]*」(第 \d+ 步（[^）]*）)?：/, '')}`))
  }

  // A main line step by step: each a click from its module.
  function flowPanel(line) {
    const flows = S.graph.flows || []
    const fid = line.flow.id
    if (stepAsk && stepAsk.flow !== fid) stepAsk = null
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'p-head' },
        h('div', {}, h('h2', { text: line.flow.name }), h('div', { class: 'p-sub', text: `主线 · ${line.steps.length} 步 · 按代码执行的先后` })),
        h('button', { type: 'button', class: 'btn small', onclick: () => setFlow(null), title: '回到概览（Esc）' }, '× 退出主线'),
      ),
      flows.length > 1
        ? h('div', { class: 'chips' }, flows.map(f => h('span', { class: 'chip' + (f.id === line.flow.id ? ' on' : ''), text: f.name, onclick: () => setFlow(f.id) })))
        : null,
      h(
        'ol',
        { class: 'steps' },
        line.steps.map((st, i) => {
          // A proposed module that is to be this step: not in the line until it is built.
          if (st.ghost) {
            const g = M.byId.get(st.node)
            return h(
              'li',
              {
                class: 'step coming',
                onclick: () => showStep(st.node),
                ondblclick: () => (isDraft(g) ? openEditor(st.node) : select(st.node)),
                title: `等 ${AGENT} 实现后插进主线；双击修改这个提议`,
              },
              h('span', { class: 'step-no', text: String(i + 1) }),
              h('div', { class: 'step-body' }, h('div', { class: 'step-name' }, `+ ${nameOf(st.node)}`), h('div', { class: 'row-sub', text: st.label })),
            )
          }
          const at = line.flow.steps.indexOf(st)
          const open = stepAsk && stepAsk.step === at
          return h(
            'li',
            {
              class: 'step' + (open ? ' asking' : ''),
              onclick: () => showStep(st.node),
              ondblclick: () => focusNode(st.node),
              oncontextmenu: ev => {
                ev.preventDefault()
                openMenu(ev.clientX, ev.clientY, `第 ${i + 1} 步：${nameOf(st.node)}`, [
                  { label: '这一步不对，提意见…', run: () => askStep(fid, at) },
                  { label: '看模块详情', run: () => focusNode(st.node) },
                ])
              },
              title: '点一下移到这个模块，双击看它的详情，右键提意见',
            },
            h('span', { class: 'step-no', text: String(i + 1) }),
            h(
              'div',
              { class: 'step-body' },
              h('div', { class: 'step-name' }, dot(nodeColor(st.node), 'dot-chip'), nameOf(st.node)),
              st.label ? h('div', { class: 'row-sub', text: st.label }) : null,
              stepNotes(fid, at),
              open ? stepCompose(fid, at) : null,
            ),
            open
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'step-ask',
                    title: '这一步不对？写一句交给 ' + AGENT,
                    'aria-label': `对第 ${i + 1} 步提意见`,
                    onclick: ev => {
                      ev.stopPropagation()
                      askStep(fid, at)
                    },
                    ondblclick: ev => ev.stopPropagation(),
                  },
                  '提意见',
                ),
          )
        }),
      ),
      stepNotes(fid, -1),
      stepAsk && stepAsk.step === -1 ? stepCompose(fid, -1) : null,
      h('div', {
        class: 'row-sub',
        text: `主线由 ${AGENT} 按代码的执行顺序写出。画布上，主线经过的模块从左往右排成树干，其他模块挂在它最先连到的那一步旁边（最多隔一个模块）：数据、文档在上，代码在下；公共模块和离主线较远的放在最下面。树干上两个模块之间的连线平时不画，指向其中一个时才显示。`,
      }),
      h(
        'div',
        { class: 'line' },
        stepAsk && stepAsk.step === -1 ? null : h('button', { type: 'button', class: 'btn small', onclick: () => askStep(fid, -1) }, '对整条主线提意见'),
        h('button', { type: 'button', class: 'btn small', onclick: () => propose({ type: 'flows' }) }, `让 ${AGENT} 重画主线`),
      ),
    )
  }

  // Where a module comes in the main lines.
  function nodeFlows(n) {
    const hits = ((S.graph && S.graph.flows) || [])
      .map(f => ({ f, at: f.steps.flatMap((st, i) => (st.node === n.id ? [i + 1] : [])) }))
      .filter(x => x.at.length)
    if (!hits.length) return null
    return section(
      '在主线上',
      h('div', { class: 'chips' }, hits.map(x => h('span', { class: 'chip', title: '看这条主线', onclick: () => setFlow(x.f.id) }, `${x.f.name} · 第 ${x.at.join('、')} 步`))),
    )
  }

  // ---- the work log: each request, what was run for it, what came out ----

  const RUN_KIND = { run: '运行', test: '测试', notebook: 'Notebook', env: '安装', git: '提交', other: '命令' }
  const RUN_MARK = { ok: '✓', failed: '✗', interrupted: '中断', background: '后台', unknown: '未确认' }
  const END_WORD = { answer: '完成', aborted: '被打断', refusal: '被拒绝', error: '出错', lost: '没有结束记录' }
  const CHANGE_WORD = { created: '新建', updated: '更新', deleted: '删除' }
  const worklogOf = () => (Array.isArray(S.worklog) ? S.worklog : [])
  const workEntry = id => worklogOf().find(e => e.id === id)
  const lasted = ms => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : ms < 3600000 ? `${Math.round(ms / 60000)} 分钟` : `${(ms / 3600000).toFixed(1)} 小时`)
  const hourOf = ms => when(ms).slice(6)
  const firstLine = e =>
    e.source === 'outside'
      ? `在 ${AGENT} 之外改动的文件（${dayOf(e.startedAt) === dayOf(e.endedAt) ? `${hourOf(e.startedAt)}–${hourOf(e.endedAt)}` : `${when(e.startedAt)} 到 ${when(e.endedAt)}`}）`
      : e.request
        ? e.request.split('\n')[0]
        : `（没有新的要求，${AGENT} 接着上一轮做）`

  // Which requests made or changed a file, latest first.
  function madeBy(p) {
    const out = []
    for (const e of [...worklogOf()].reverse()) for (const o of e.outputs) if (o.path === p) out.push({ e, o, run: e.runs.find(r => r.id === o.runId) })
    return out
  }

  // The person's word on an entry: kept by the mod in the log.
  const workTalks = new Map() // entry id → what /api/turn answered
  const workTalkOpen = new Set()
  async function loadWorkTalk(id) {
    workTalks.set(id, { loading: true })
    renderPanel()
    try {
      workTalks.set(id, await request(`/api/turn?entry=${encodeURIComponent(id)}`))
    } catch (err) {
      workTalks.set(id, { error: `对话记录读不出来：${err.message}` })
    }
    renderPanel()
  }
  function workTalkBlock(id) {
    const t = workTalks.get(id)
    if (!t || t.loading) return h('div', { class: 'talk' }, h('div', { class: 'p-empty', text: '读取对话记录…' }))
    if (t.error) return h('div', { class: 'talk' }, h('div', { class: 'p-empty', text: t.error }))
    const who = it => (it.who === 'you' ? (it.viaCanvas ? '你（从画布发出）' : '你') : AGENT)
    return h(
      'div',
      { class: 'talk' },
      t.otherSession ? h('div', { class: 'p-empty', text: '来自另一个会话' }) : null,
      t.cut ? h('div', { class: 'p-empty', text: '前面还有，只显示最后 60 段' }) : null,
      t.items.length ? null : h('div', { class: 'p-empty', text: '会话记录里找不到这一轮（可能在压缩前）。' }),
      t.items.map(it =>
        it.who === 'tool'
          ? h(
              'div',
              { class: 'msg tool', title: it.lines.join('\n') },
              it.lines.slice(0, 3).map(l => h('div', { class: 'said', text: l })),
              it.lines.length > 3 ? h('div', { class: 'said', text: `…还有 ${it.lines.length - 3} 次（鼠标停在这里看全部）` }) : null,
            )
          : h('div', { class: `msg ${it.who === 'you' ? 'you' : 'claude'}` }, h('div', { class: 'who' }, who(it), h('span', { class: 'at', text: clock(it.at) })), h('div', { class: 'said', text: it.text })),
      ),
      h('div', { class: 'p-empty', text: '工具运行的输出不显示。' }),
    )
  }

  // The work log in the panel; `pick` opens that entry and lights its modules.
  function setWork(on, pick = null) {
    workView = on
    workPick = on ? pick : null
    if (on) {
      if (pick) workOpen.add(pick)
      selected = null
      fileSel = null
      fileView = null
    }
    renderBar()
    draw()
    renderPanel()
    if (on && panel.classList.contains('closed')) togglePanel()
    const el = pick && panelBody.querySelector(`[data-entry="${CSS.escape(pick)}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
    // The modules it touched, where the person can see them.
    const e = pick && workEntry(pick)
    if (e) bringIntoView(e.nodeIds)
  }

  function toggleEntry(id) {
    if (workOpen.has(id) && workPick === id) {
      workOpen.delete(id)
      workPick = null
    } else {
      workOpen.add(id)
      workPick = id
    }
    draw()
    renderPanel()
    const e = workPick && workEntry(workPick)
    if (e) bringIntoView(e.nodeIds)
  }

  function dayOf(ms) {
    const d = new Date(ms)
    const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const days = Math.round((start(new Date()) - start(d)) / 86400000)
    const date = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`
    return days === 0 ? `今天 · ${date}` : days === 1 ? `昨天 · ${date}` : date
  }

  const testText = t => (t.failed ? `${t.failed} 个没通过，${t.passed} 个通过` : `${t.passed} 个全部通过`) + (t.skipped ? `，跳过 ${t.skipped}` : '')
  const versionText = v =>
    `代码 ${v.revision.slice(0, 7)}` + (v.dirty && v.dirty.length ? `（${v.dirty.length} 个代码文件有没提交的改动：${v.dirty.slice(0, 3).join('、')}${v.dirty.length > 3 ? '…' : ''}）` : '')

  // The entry at a glance: runs, tests, files out, edits, proposals.
  function workTally(e) {
    const bits = []
    const ran = e.runs.filter(r => ['run', 'test', 'notebook'].includes(r.kind))
    const failed = ran.filter(r => r.status === 'failed').length
    if (ran.length) bits.push({ text: `运行 ${ran.length}${failed ? `（${failed} 失败）` : ''}`, bad: failed > 0 })
    const tests = e.runs.filter(r => r.tests).map(r => r.tests)
    const t = tests[tests.length - 1]
    if (t) bits.push({ text: t.failed ? `测试 ${t.failed} 没通过` : `测试 ${t.passed} 通过`, bad: t.failed > 0 })
    const outs = e.outputs.length + (e.sealed || []).reduce((n, s) => n + s.created + s.updated + s.deleted, 0)
    if (outs) bits.push({ text: `产出 ${outs}` })
    if (e.edits.length) bits.push({ text: `改了 ${e.edits.length} 个文件` })
    const installs = e.runs.filter(r => r.kind === 'env').length
    if (installs) bits.push({ text: `安装 ${installs}` })
    const commits = e.runs.filter(r => r.kind === 'git').length
    if (commits) bits.push({ text: `提交 ${commits}` })
    if ((e.taskIds || []).length) bits.push({ text: `提议 ${e.taskIds.length}` })
    if ((e.checkIds || []).length) bits.push({ text: `请你测试 ${e.checkIds.length}` })
    if ((e.results || []).length) bits.push({ text: `结论 ${e.results.length}` })
    if ((e.map || []).length) bits.push({ text: '改了架构图' })
    return bits
  }

  // `ownVersion`: the runs of the entry used different code, so each says its own.
  function runRow(r, ownVersion) {
    const where = r.nodeIds.length ? r.nodeIds.map(nameOf).join('、') : ''
    const facts = [
      RUN_KIND[r.kind],
      where,
      r.ms ? lasted(r.ms) : '',
      r.tests ? testText(r.tests) : '',
      r.error ? `出错：${r.error}` : '',
      r.status === 'failed' && r.exitCode ? `退出码 ${r.exitCode}` : '',
      r.status === 'unknown' && r.finishedAt ? '结果已返回；宿主未提供退出码' : '',
      r.commit ? `提交 ${r.commit.slice(0, 7)}` : '',
      ownVersion && r.version ? versionText(r.version) : '',
      r.partial ? '有的文件夹太大没逐个比对，那里的产出只记 git 看到的变化' : '',
      r.masked ? `输出里 ${r.masked} 处号码给 ${AGENT} 看之前已打码` : '',
    ]
    return h(
      'div',
      { class: `run-row ${r.status}` },
      h('span', { class: 'run-mark', text: RUN_MARK[r.status] || '' }),
      h(
        'div',
        { class: 'run-body' },
        h('div', { class: 'run-cmd', text: r.command, title: r.command }),
        h('div', { class: 'row-sub', text: facts.filter(Boolean).join(' · ') }),
        r.tests && r.tests.failedNames ? h('div', { class: 'run-fails', text: `没通过：${r.tests.failedNames.join('、')}` }) : null,
      ),
    )
  }

  function outRow(o) {
    const name = o.change === 'deleted' ? h('span', { class: 'mono', text: o.path }) : h('span', { class: 'link mono', text: o.path, onclick: () => selectFile(o.path) })
    return h('div', { class: 'out-row' }, h('span', { class: `out-change ${o.change}`, text: CHANGE_WORD[o.change] }), name, h('span', { class: 'muted', text: [o.size ? size(o.size) : '', o.nodeIds.map(nameOf).join('、')].filter(Boolean).join(' · ') }))
  }

  function sealedRow(s) {
    const n = [s.created && `新建 ${s.created}`, s.updated && `更新 ${s.updated}`, s.deleted && `删除 ${s.deleted}`].filter(Boolean).join('、')
    return h(
      'div',
      { class: 'out-row' },
      h('span', { class: 'out-change sealed', text: '敏感' }),
      h('span', { class: 'out-text', text: `「${nameOf(s.nodeId)}」里${n} 个文件${s.size ? `（共 ${size(s.size)}）` : ''}，文件名不记` }),
    )
  }

  function workDetail(e) {
    const part = (title, ...kids) => h('div', { class: 'work-part' }, h('div', { class: 'work-part-title', text: title }), kids)
    const tasks = (e.taskIds || []).map(id => (S.tasks || []).find(t => t.id === id)).filter(Boolean)
    const checks = (e.checkIds || []).map(id => checksOf(S).find(c => c.id === id)).filter(Boolean)
    const version = [...e.runs].reverse().find(r => r.version)
    const versions = new Set(e.runs.filter(r => r.version).map(r => JSON.stringify(r.version)))
    const noteKey = `worknote-${e.id}`
    if (drafts[noteKey] === undefined && e.note) drafts[noteKey] = e.note
    const saveNote = () => propose({ type: 'work-note', entryId: e.id, text: drafts[noteKey] ?? e.note ?? '' })
    const talking = workTalkOpen.has(e.id)
    return h(
      'div',
      { class: 'work-detail' },
      e.request && (e.request.length > 60 || e.request.includes('\n')) ? h('div', { class: 'work-full', text: e.request }) : null,
      e.source === 'canvas' ? h('div', { class: 'row-sub', text: '从画布上的按钮发出' }) : null,
      e.source === 'outside'
        ? h('div', {
            class: 'row-sub',
            text: AGENT === 'Codex' ? '两次文件观察之间发生了变化，来源无法确定，也可能由后台命令生成。可以在下面备注来源。' : `这段时间 ${AGENT} 没在运行，这些文件是你手动、在 Jupyter 里或用别的程序改的。${e.background ? `也可能是 ${AGENT} 之前转到后台的命令生成的。` : ''}可以在下面备注一句是怎么来的。`,
          })
        : null,
      (e.results || []).length
        ? part(
            `${AGENT} 记下的结论`,
            e.results.map(r =>
              h(
                'div',
                { class: 'work-result' },
                h('div', { text: r.text }),
                (r.files || []).length ? h('div', { class: 'row-sub' }, r.files.map((f, i) => [i ? '、' : '', h('span', { class: 'link mono', text: f, onclick: () => selectFile(f) })])) : null,
              ),
            ),
          )
        : null,
      e.runs.length ? part('跑了什么', e.runs.map(r => runRow(r, versions.size > 1))) : null,
      e.outputs.length || (e.sealed || []).length ? part('产出', e.outputs.map(outRow), (e.sealed || []).map(sealedRow)) : null,
      e.edits.length
        ? part(
            '改了哪些文件',
            e.edits.map(x =>
              h('div', { class: 'out-row' }, h('span', { class: 'link mono', text: x.file, onclick: () => selectFile(x.file) }), h('span', { class: 'muted', text: `+${x.added} −${x.removed}` })),
            ),
          )
        : null,
      (e.map || []).length ? part('架构图的改动', e.map.map(l => h('div', { class: 'row-sub', text: l }))) : null,
      tasks.length ? part('画布上的提议', tasks.map(t => h('div', { class: 'row-sub', text: `${t.text}（${STATUS[t.status] || t.status}）` }))) : null,
      checks.length ? part('留给你测试', checks.map(c => h('div', { class: 'row-sub', text: c.title }))) : null,
      e.answer ? part(`${AGENT} 最后说`, h('div', { class: 'work-answer', text: e.answer })) : null,
      version && versions.size === 1 ? h('div', { class: 'row-sub', text: versionText(version.version) }) : null,
      e.nodeIds.length
        ? h('div', { class: 'chips' }, e.nodeIds.filter(id => M && M.byId.has(id)).map(id => h('span', { class: 'chip', title: '看这个模块', onclick: () => focusNode(id) }, dot(nodeColor(id), 'dot-chip'), nameOf(id))))
        : null,
      part(
        '备注',
        h(
          'div',
          { class: 'compose' },
          h('textarea', {
            'data-key': noteKey,
            rows: 2,
            placeholder: e.source === 'outside' ? '这些改动是怎么来的？例如：在 Jupyter 里重跑了探索分析' : '想留一句话？例如：这次的数据有错，以 10-26 那次为准',
            oninput: ev => (drafts[noteKey] = ev.target.value),
            onkeydown: ev => {
              if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) saveNote()
            },
          }),
          h(
            'div',
            { class: 'line' },
            h('button', { type: 'button', class: 'btn small', onclick: saveNote }, '保存备注'),
            h('button', { type: 'button', class: 'btn small' + (e.mark === 'important' ? ' on' : ''), onclick: () => propose({ type: 'work-mark', entryId: e.id, mark: e.mark === 'important' ? null : 'important' }) }, e.mark === 'important' ? '★ 取消重要' : '☆ 标为重要'),
            h(
              'button',
              { type: 'button', class: 'btn small' + (e.mark === 'void' ? ' on' : ''), title: '这一次的结果不再算数（例如用错了数据），记录留着', onclick: () => propose({ type: 'work-mark', entryId: e.id, mark: e.mark === 'void' ? null : 'void' }) },
              e.mark === 'void' ? '取消作废' : '作废',
            ),
            e.source === 'outside'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small',
                    onclick: () => {
                      if (talking) workTalkOpen.delete(e.id)
                      else {
                        workTalkOpen.add(e.id)
                        if (!workTalks.has(e.id) || workTalks.get(e.id).error) return loadWorkTalk(e.id)
                      }
                      renderPanel()
                    },
                  },
                  talking ? '收起对话' : '看对话',
                ),
          ),
        ),
      ),
      talking ? workTalkBlock(e.id) : null,
    )
  }

  function workItem(e) {
    const open = workOpen.has(e.id)
    const outside = e.source === 'outside'
    const end = outside ? '' : !e.endedAt ? (e.session === S.sessionId ? '进行中' : END_WORD.lost) : END_WORD[e.end] || ''
    const bad = !outside && (!e.endedAt ? e.session !== S.sessionId : e.end !== 'answer')
    const quiet = !e.runs.length && !e.edits.length && !e.outputs.length && !(e.sealed || []).length && !(e.results || []).length && !(e.map || []).length
    const bits = workTally(e)
    const cls = ['work', open && 'open', workPick === e.id && 'lit', quiet && 'quiet', outside && 'outside', e.mark].filter(Boolean).join(' ')
    return h(
      'div',
      { class: cls, 'data-entry': e.id },
      h(
        'div',
        { class: 'work-head', onclick: () => toggleEntry(e.id), title: open ? '收起' : '展开，并在画布上亮出它涉及的模块' },
        h('span', { class: 'work-time', text: hourOf(e.startedAt) }),
        h('div', { class: 'work-req' }, e.mark === 'important' ? h('span', { class: 'work-star', text: '★ ' }) : null, e.mark === 'void' ? h('span', { class: 'work-void', text: '已作废 ' }) : null, firstLine(e)),
        h('span', { class: 'work-end' + (bad ? ' bad' : !e.endedAt ? ' live' : ''), text: [end, e.ms ? lasted(e.ms) : ''].filter(Boolean).join(' · ') }),
      ),
      bits.length ? h('div', { class: 'work-bits', onclick: () => toggleEntry(e.id) }, bits.map(b => h('span', { class: 'work-bit' + (b.bad ? ' bad' : ''), text: b.text }))) : null,
      e.note && !open ? h('div', { class: 'work-said', text: `备注：${e.note}` }) : null,
      open ? workDetail(e) : null,
    )
  }

  function workPanel() {
    const log = [...worklogOf()].reverse()
    const head = h(
      'div',
      { class: 'p-head' },
      h('div', {}, h('h2', { text: '工作记录' }), h('div', { class: 'p-sub', text: log.length ? `${log.length} 次要求 · 点一条展开，画布上亮出它涉及的模块` : '还没有记录' })),
      h('button', { type: 'button', class: 'btn small', onclick: () => setWork(false), title: '回到概览（Esc）' }, '× 关闭'),
    )
    const note = h('div', {
      class: 'row-sub work-note',
      text: AGENT === 'Codex' ? '记录用户要求、钩子捕获的修改与运行摘要、文件变化及汇总结论。命令原始输出不保存；没有捕获到退出结果时显示“未确认”。不使用 Stop hook，因此不记录最后回复，下一条要求到来时封存上一条并标注“没有结束记录”。' : `你在对话里每提一次要求，这里记一条：${AGENT} 跑了哪些脚本、测试和 Notebook，成没成，生成或改了哪些文件，用的哪版代码，以及它最后怎么说。命令打印出的内容不记；敏感数据里的文件只记个数和大小；6 位以上的数字（病历号、证件号）记成 #。`,
    })
    if (!log.length) return h('div', {}, head, note)
    const groups = []
    for (const e of log.slice(0, workShown)) {
      const day = dayOf(e.startedAt)
      if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] })
      groups[groups.length - 1].items.push(e)
    }
    return h(
      'div',
      {},
      head,
      groups.map(g => h('div', { class: 'work-day' }, h('div', { class: 'work-day-title', text: g.day }), g.items.map(workItem))),
      log.length > workShown
        ? h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn small', onclick: () => ((workShown += 60), renderPanel()) }, `再显示更早的（还有 ${log.length - workShown} 条）`))
        : null,
      note,
    )
  }

  // What was done with a module, request by request: the latest first.
  function nodeWork(n) {
    const hits = worklogOf().filter(e => e.nodeIds.includes(n.id)).slice(-8).reverse()
    if (!hits.length) return null
    const here = e => {
      const bits = e.runs.filter(r => r.nodeIds.includes(n.id)).slice(0, 3).map(r => `${RUN_KIND[r.kind]} ${(r.script || r.command).split('/').pop()} ${RUN_MARK[r.status]}`)
      const outs = e.outputs.filter(o => o.nodeIds.includes(n.id)).length + (e.sealed || []).filter(s => s.nodeId === n.id).reduce((k, s) => k + s.created + s.updated + s.deleted, 0)
      if (outs) bits.push(`产出 ${outs} 个文件`)
      const edits = e.edits.filter(x => x.nodeIds.includes(n.id))
      if (edits.length) bits.push(`改了 ${edits.map(x => x.file.split('/').pop()).join('、')}`)
      return bits.join(' · ')
    }
    return section(
      '做过什么',
      hits.map(e =>
        h(
          'div',
          { class: 'work-mini', onclick: () => setWork(true, e.id), title: '在工作记录里看这一次' },
          h('span', { class: 'work-time', text: when(e.startedAt) }),
          h('div', {}, h('div', { class: 'work-req', text: firstLine(e) }), h('div', { class: 'row-sub', text: here(e) })),
        ),
      ),
    )
  }

  function overviewPanel() {
    const g = S.graph
    if (!g) {
      return h('div', {}, h('div', { class: 'p-head' }, h('div', {}, h('h2', { text: S.project || '架构画布' }), h('div', { class: 'p-sub', text: '还没有架构图' }))))
    }
    const open = M.tasks
    const draftsN = open.filter(t => t.status === 'draft').length
    const recent = [...(S.history || [])].reverse().slice(0, 12)
    return h(
      'div',
      {},
      h('div', { class: 'p-head' }, h('div', {}, h('h2', { text: g.title || S.project }), h('div', { class: 'p-sub', text: '点模块看详情；右键模块、连线或空白处有更多操作' }))),
      pendingNote(),
      sensitiveBanner(),
      notebooksBanner(),
      flowsNote(),
      staleNote(),
      evidenceNote(),
      auditBanner(),
      checksSection(checksOf(S)),
      withId(
        'proposals-sec',
        section(
          `给 ${AGENT} 的提议（${open.length}）`,
          h('div', { class: 'row-sub', text: `你在图上提的意见和改动，交给 ${AGENT} 实施后才会改代码。` }),
          open.length
            ? open.map(taskRow)
            : h('div', { class: 'p-empty', text: '还没有提议。双击分组里的空白处新增模块；从模块右侧的圆点拖到另一个模块是新增连线，拖到分组里的空白处是新建一个接上；右键模块可以提意见、提议删除。' }),
          handoverBox(draftsN),
        ),
      ),
      auditSection(),
      sensitiveSection(),
      section(
        `最近修改（${(S.history || []).length}）`,
        recent.length ? recent.map(c => changeRow(c, true)) : h('div', { class: 'p-empty', text: `${AGENT} 改过的文件会记在对应模块下，这里按时间列出。` }),
      ),
      section(
        '操作',
        h(
          'ul',
          { class: 'tips' },
          h('li', {}, h('b', { text: '滚轮' }), ' 缩放，', h('b', { text: '拖空白处' }), ' 平移，', h('b', { text: 'F' }), ' 适应画布，', h('b', { text: 'Ctrl+Z' }), ' 撤销布局改动'),
          h('li', {}, h('b', { text: '/' }), ' 搜索模块或文件，回车跳到第一个模块'),
          h('li', {}, h('b', { text: '双击分组里的空白处' }), ' 新增模块：输入名字、选类型，模块落在双击的位置；右键分组也可以'),
          h('li', {}, h('b', { text: '双击分组外的空白处' }), ' 新建分组，接着给它起名；右键空白处也可以'),
          h('li', {}, h('b', { text: '从右侧圆点拖出连线' }), '：按数据流的方向连。模块连到模块是调用，模块连到数据或文档是生成，数据或文档连到模块是读取；拖到分组里的空白处是新建一个接上'),
          h('li', {}, h('b', { text: '拖动模块' }), ' 在分组里随意摆放，拖进别的分组就换过去（只改架构图）；拖分组的标题可以移动整个分组，双击标题改名'),
          h('li', {}, h('b', { text: '分组标题旁的排列按钮' }), ' 横排、竖排或平铺；「整理布局」把所有分组放回自动排列'),
          h('li', {}, h('b', { text: '双击模块' }), ' 展开卡片看职责和文件；双击待新增的模块，在卡片上直接改'),
          h('li', {}, h('b', { text: '主线模式里' }), ' 卡片不能拖；双击空白处、右键空白处，或从模块拖线到空白处，先选放进哪个分组，再在那里新建模块'),
          h('li', {}, h('b', { text: '分组标题右边的「收起」' }), ' 把整个分组折叠成一条'),
          h('li', {}, h('b', { text: '左边文件树' }), `：点文件看它属于哪个模块；${AGENT} 读写文件时，文件和模块会亮起来（紫色是读，橙色是写）`),
        ),
      ),
    )
  }

  function nodePanel(id) {
    const n = M.byId.get(id)
    const removing = M.removing.get(id)
    const outs = M.edges.filter(e => e.from === id)
    const ins = M.edges.filter(e => e.to === id)
    const changes = [...(M.changes.get(id) || [])].reverse()
    const tasks = (S.tasks || []).filter(t => (t.kind === 'add-node' ? t.node && t.node.id === id : t.nodeIds.includes(id))).reverse().slice(0, 10)
    const draftsN = M.tasks.filter(t => t.status === 'draft').length

    const chip = (e, other, arrow) => {
      const cls = 'chip' + (e.state === 'add' ? ' add' : e.state === 'remove' ? ' remove' : '')
      const x =
        e.state === 'normal'
          ? h('button', { type: 'button', class: 'x', title: '提议去掉这条连线', onclick: ev => (ev.stopPropagation(), propose({ type: 'remove-edge', from: e.from, to: e.to })) }, '去掉')
          : h('button', { type: 'button', class: 'x', title: '撤回这条提议', onclick: ev => (ev.stopPropagation(), cancelTask(e.task.id)) }, '撤回')
      const notes = edgeNotes(e)
      const tip = [
        e.label,
        e.unsure ? '未确认：没找到代码依据' : '',
        e.state === 'normal' && e.nocode === 'reversed' ? '代码里方向相反：是对方引用这个模块' : '',
        e.state === 'normal' && e.nocode === 'missing' ? '代码里没找到这条调用（import、source() 或写明的路径）' : '',
        e.state === 'normal' && e.via ? `可能是「${viaName(e.via)}」把它作为参数交过去的：${sourceText(e.via)}` : '',
        e.vouched ? `已核实（${vouchText(e.vouched)}），代码核对不再报它` : '',
        e.vouched && vouchChanged(e).length ? `核实后这些文件改过：${filesText(vouchChanged(e))}` : '',
        ...(e.sources || []).map(src => `依据${e.doubt && e.doubt.some(d => d.path === src.path && d.line === src.line) ? '（存疑：没提到被调用的模块）' : ''}：${sourceText(src)}`),
      ]
        .filter(Boolean)
        .join('\n')
      const marks = notes.length ? notes : e.vouched ? ['已核实'] : []
      return h('span', { class: cls + (notes.length ? ' unsure' : ''), onclick: () => select(other), title: tip }, arrow, marks.length ? h('span', { class: 'muted', text: ` · ${marks.join(' · ')}` }) : null, n.ghost ? null : x)
    }
    // A line from this module's side: 读取「原始数据」, 被「统计分析」调用.
    const said = e => {
      const other = `「${nameOf(e.from === id ? e.to : e.from)}」`
      const res = isRes(nodeType(n))
      if (e.kind === 'read') return res ? `被${other}读取` : `读取${other}`
      if (e.kind === 'write') return res ? `由${other}生成` : `生成${other}`
      if (e.kind === 'link') return `关联${other}`
      return e.from === id ? `调用${other}` : `被${other}调用`
    }

    const candidates = S.graph.nodes.filter(m => m.id !== id && !outs.some(e => e.to === m.id))
    const linkKey = `link-${id}`
    const commentKey = `comment-${id}`
    const compose =
      n.ghost || removing
        ? null
        : section(
            '提议改动',
            h(
              'div',
              { class: 'compose' },
              h('textarea', {
                'data-key': commentKey,
                rows: 3,
                placeholder: `给 ${AGENT} 提意见：想怎么改这个模块？`,
                oninput: ev => (drafts[commentKey] = ev.target.value),
                onkeydown: ev => {
                  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) sendComment()
                },
              }),
              h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn', onclick: sendComment }, '加入提议')),
              candidates.length
                ? h(
                    'div',
                    { class: 'line' },
                    h(
                      'select',
                      { 'data-key': linkKey, onchange: ev => (drafts[linkKey] = ev.target.value) },
                      h('option', { value: '', text: '连到…（数据从它流向对方）' }),
                      candidates.map(m => h('option', { value: m.id, text: `${layerName(m.layer)} · ${m.name}` })),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn',
                        onclick: () => {
                          if (!drafts[linkKey]) return toast('先选要连到的模块。', 'error')
                          propose({ type: 'add-edge', from: id, to: drafts[linkKey] })
                          drafts[linkKey] = ''
                        },
                      },
                      '加入提议',
                    ),
                  )
                : null,
              h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn danger', onclick: () => propose({ type: 'remove-node', nodeId: id }) }, '提议删除此模块')),
            ),
          )
    function sendComment() {
      const text = (drafts[commentKey] || '').trim()
      if (!text) return toast('意见是空的。', 'error')
      propose({ type: 'comment', nodeId: id, text })
      drafts[commentKey] = ''
      const el = panelBody.querySelector(`[data-key="${CSS.escape(commentKey)}"]`)
      if (el) el.value = ''
    }

    const box = h(
      'div',
      {},
      h(
        'div',
        { class: 'p-head' },
        h(
          'div',
          {},
          h('h2', { text: (n.ghost ? '+ ' : '') + n.name }),
          h('div', { class: 'p-sub', text: [layerName(n.layer), TYPE_LABEL[nodeType(n)] + (isSensitiveNode(n) ? '（敏感）' : ''), n.kind].filter(Boolean).join(' · ') }),
        ),
        h('button', { type: 'button', class: 'btn small', onclick: () => select(null), title: '回到概览（Esc）' }, '× 关闭'),
      ),
      n.ghost
        ? h(
            'div',
            { class: 'p-banner add' },
            isDraft(n) ? `待新增：交给 ${AGENT} 实施后才会写出代码。` : `${STATUS[n.task.status]}：完成后会出现在图上。`,
            isDraft(n) ? h('button', { type: 'button', class: 'btn link', onclick: () => openEditor(id) }, '编辑') : null,
            h('button', { type: 'button', class: 'btn link', onclick: () => cancelTask(n.task.id) }, n.task.status === 'working' ? '取消' : '撤回'),
          )
        : null,
      removing ? h('div', { class: 'p-banner remove' }, `待删除：交给 ${AGENT} 实施后才会删掉代码。`, h('button', { type: 'button', class: 'btn link', onclick: () => cancelTask(removing.id) }, '撤回')) : null,
      n.ghost ? null : staleBanner(n),
      n.summary ? h('div', { class: 'p-text' }, nodeType(n) === 'code' ? null : h('span', { class: 'muted', text: `${TYPE_ASK[nodeType(n)][0]}：` }), n.summary) : null,
      n.details ? md(n.details) : null,
      nodeType(n) === 'data' && !n.ghost ? dataSection(n) : null,
      section(
        `源文件（${(n.files || []).length}）`,
        (n.files || []).length
          ? h(
              'ul',
              { class: 'files' },
              n.files.map(f =>
                h('li', {
                  class: 'link',
                  text: f,
                  title: FT.files.includes(f) ? '在文件树里打开' : '在文件树里展开',
                  onclick: () => (FT.files.includes(f) ? selectFile(f) : renderFiles('reveal')),
                }),
              ),
            )
          : h('div', { class: 'p-empty', text: n.ghost ? `实施后由 ${AGENT} 补上。` : '（没有列出）' }),
      ),
      n.sources && n.sources.length
        ? section(
            '代码依据',
            h(
              'ul',
              { class: 'files' },
              n.sources.map(placer(auditOf(S))).map(src =>
                h('li', { class: 'link', text: sourceText(src), title: src.was ? `打开这几行（代码挪动过，原第 ${src.was} 行）` : '打开这几行', onclick: () => openSource(src) }),
              ),
            ),
          )
        : null,
      reachSection(n),
      n.ghost ? null : nodeFlows(n),
      n.ghost ? null : nodeWork(n),
      section(
        `连线（${outs.length + ins.length}）`,
        outs.length + ins.length
          ? h('div', { class: 'chips' }, [...outs, ...ins].map(e => chip(e, e.from === id ? e.to : e.from, said(e))))
          : h('div', { class: 'p-empty', text: '还没有和别的模块连线' }),
      ),
      n.ghost ? null : tiesSection(id),
      section(`修改记录（${changes.length}）`, changes.length ? changes.slice(0, 15).map(c => changeRow(c, false)) : h('div', { class: 'p-empty', text: `${AGENT} 还没改过这个模块的文件。` })),
      checksSection(checksOf(S).filter(c => c.nodeIds.includes(id))),
      tasks.length ? section(`给 ${AGENT} 的提议（${tasks.length}）`, tasks.map(taskRow), handoverBox(draftsN)) : null,
      compose,
    )
    return box
  }

  // ---- module types ----
  // The graph says what each module is (the mod fills in a type for graphs
  // from before types); data is sensitive unless marked otherwise.

  const NODE_TYPES = ['code', 'data', 'notebook', 'skill', 'doc', 'test', 'external']
  const TYPE_LABEL = { code: '代码', data: '数据', notebook: 'Notebook', skill: 'Skill', doc: '文档', test: '测试', external: '外部服务' }
  // What a draft's card asks for in its description field, by type.
  const TYPE_ASK = {
    code: ['职责', '它负责什么（可以不写）'],
    data: ['里面是什么', '例如：问卷原始数据，每行一位受访者'],
    notebook: ['分析目的', '例如：比较两组评分的分布'],
    skill: ['什么时候用', '例如：用户要出周报时，按模板汇总本周的分析结果'],
    doc: ['写什么', '例如：数据字典，说明每个字段'],
    test: ['测什么', '例如：清洗后不再有缺失评分'],
    external: ['是什么服务、怎么连', '例如：医院的检验系统 API，用环境变量里的地址和密钥'],
  }
  // 16×16 line icons, drawn in the type's colour.
  const TYPE_ICON = {
    code: 'M5.5 4 L1.5 8 L5.5 12 M10.5 4 L14.5 8 L10.5 12',
    data: 'M1.5 4.5 H6 L7.5 6 H14.5 V13.5 H1.5 Z',
    notebook: 'M4 1.5 H13 V14.5 H4 Z M6.5 5 H10.5 M6.5 8 H10.5 M2 4 H5 M2 8 H5 M2 12 H5',
    skill: 'M8 1.5 L9.5 6.5 L14.5 8 L9.5 9.5 L8 14.5 L6.5 9.5 L1.5 8 L6.5 6.5 Z',
    doc: 'M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z M9.5 1.5 V4.5 H12.5 M5.5 8 H10.5 M5.5 11 H10.5',
    test: 'M8 1.5 A6.5 6.5 0 1 1 7.99 1.5 Z M5 8.2 L7.2 10.4 L11.2 6',
    external: 'M4.5 12.5 H11.5 A3 3 0 0 0 11.5 6.5 A4.2 4.2 0 0 0 3.6 5.4 A3.6 3.6 0 0 0 4.5 12.5 Z',
  }

  const nodeType = n => (n && NODE_TYPES.includes(n.type) ? n.type : 'code')
  // Steps do the work; resources are what they read and make.
  const STEP_TYPES = ['code', 'notebook', 'skill', 'test']
  const RESOURCE_TYPES = ['data', 'doc', 'external']
  const TYPE_ORDER = [...STEP_TYPES, ...RESOURCE_TYPES]
  const isSensitiveNode = n => nodeType(n) === 'data' && n.sensitive !== false

  function typeIcon(type, parent, x, y) {
    const g = s('g', { class: `ticon t-${type}`, transform: `translate(${x},${y})` }, parent)
    s('title', { text: TYPE_LABEL[type] }, g)
    s('path', { d: TYPE_ICON[type] }, g)
    return g
  }

  // The lock for HTML rows (the file tree).
  function lockGlyph() {
    const svgEl = document.createElementNS(NS, 'svg')
    svgEl.setAttribute('viewBox', '0 0 13 14')
    svgEl.setAttribute('class', 'f-lock')
    s('path', { d: 'M3.5 6.5 V4.5 A3 3 0 0 1 9.5 4.5 V6.5 M2 6.5 H11 V13 H2 Z' }, svgEl)
    return svgEl
  }

  function lockIcon(parent, x, y) {
    const g = s('g', { class: 'lock', transform: `translate(${x},${y})` }, parent)
    s('title', { text: `敏感数据：不显示内容，${AGENT} 也不读` }, g)
    s('path', { d: 'M3.5 6.5 V4.5 A3 3 0 0 1 9.5 4.5 V6.5 M2 6.5 H11 V13 H2 Z' }, g)
    return g
  }

  function filesLabel(n) {
    const files = n.files || []
    if (!files.length) return nodeType(n) === 'external' ? '项目外' : '未列文件'
    const dirs = files.filter(f => f.endsWith('/')).length
    if (dirs === files.length) return `${dirs} 个文件夹`
    return dirs ? `${files.length - dirs} 个文件、${dirs} 个文件夹` : `${files.length} 个文件`
  }

  // ---- what the agent asks the person to test ----
  // Each check sits on its modules until the person tries it: at once (the
  // folder opens and the steps unfold) or later, one by one in a run. A
  // failed one can go back to the agent as a draft task.

  const openRows = new Set() // checks unfolded in the panel
  let checkRun = null // { ids, i, passed, failed, skipped } while testing one by one
  let knownChecks = null // what was waiting at the last refresh
  let knownNext = null // when the map waiting for a yes was drawn, at the last refresh

  const checksOf = st => (st && Array.isArray(st.checks) ? st.checks : [])
  const checkById = id => checksOf(S).find(c => c.id === id)

  async function reveal(p) {
    try {
      const d = await postJson('/api/reveal', { path: p || '' })
      if (d.error) toast(d.error, 'error')
    } catch (err) {
      toast(`没能打开文件夹：${err.message}`, 'error')
    }
  }

  // Where testing starts: the first path the agent named, else the module's first file.
  function startPath(c) {
    if (c.paths && c.paths.length) return c.paths[0]
    const n = S.graph && S.graph.nodes.find(x => x.id === c.nodeIds[0])
    return n && n.files && n.files[0] ? n.files[0] : ''
  }

  function startCheck(c) {
    openRows.add(c.id)
    reveal(startPath(c))
    renderPanel()
  }

  function passCheck(c) {
    propose({ type: 'check-pass', id: c.id })
    if (checkRun) nextInRun('passed')
  }

  function failDialog(c) {
    dialog({
      title: `没通过：${c.title}`,
      sub: `写下看到的问题。交给 ${AGENT} 修的话，会变成一条提议，和其他提议一起交给 ${AGENT}。`,
      fields: [
        { key: 'note', label: '看到的问题', type: 'textarea', placeholder: '例如：输出里分组 B 的样本量是 0' },
        {
          key: 'to',
          label: '接下来',
          type: 'select',
          value: 'yes',
          options: [
            { value: 'yes', label: `交给 ${AGENT} 修（加入提议）` },
            { value: 'no', label: '只记下来' },
          ],
        },
      ],
      submit: '记为没通过',
      onSubmit: v => {
        propose({ type: 'check-fail', id: c.id, note: v.note.trim(), toAgent: v.to === 'yes' })
        if (checkRun) nextInRun('failed')
      },
    })
  }

  function checkCard(c, inRun) {
    const open = c.status === 'open'
    const unfolded = inRun || openRows.has(c.id)
    const task = c.taskId ? (S.tasks || []).find(t => t.id === c.taskId) : null
    const mods = (c.nodeIds || []).map((id, i) => [i ? '、' : '', h('button', { type: 'button', class: 'mod-link', onclick: () => select(id), text: nameOf(id) })])
    const paths = c.paths && c.paths.length ? c.paths : startPath(c) ? [startPath(c)] : []
    return h(
      'div',
      { class: `check ${c.status}` },
      h(
        'div',
        { class: 'row-top' },
        h('div', { class: 'row-main' }, open ? null : h('span', { class: `status ${c.status}`, text: { passed: '通过', failed: '没通过', dismissed: '不用测了' }[c.status] }), h('b', { text: c.title })),
        open && !unfolded ? h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startCheck(c) }, '开始测试')) : null,
      ),
      h('div', { class: 'row-sub' }, when(c.createdAt), ' · ', mods, task ? ` · 来自：${task.text}` : ''),
      unfolded
        ? [
            c.steps && c.steps.length ? h('ol', { class: 'steps' }, c.steps.map(step => h('li', {}, inline(step)))) : null,
            c.expect ? h('div', { class: 'expect' }, h('b', { text: '应该看到：' }), inline(c.expect)) : null,
            paths.length
              ? h('div', { class: 'chips' }, paths.map(p => h('button', { type: 'button', class: 'chip only', title: '在文件夹里打开', onclick: () => reveal(p) }, `↗ ${p}`)))
              : null,
          ]
        : null,
      c.note ? h('div', { class: 'row-sub', text: `你写的：${c.note}` }) : null,
      open && unfolded
        ? h(
            'div',
            { class: 'acts' },
            h('button', { type: 'button', class: 'btn small ok', onclick: () => passCheck(c) }, '✓ 通过'),
            h('button', { type: 'button', class: 'btn small danger', onclick: () => failDialog(c) }, '✗ 没通过…'),
            inRun
              ? h('button', { type: 'button', class: 'btn small', onclick: () => nextInRun('skipped') }, '跳过，留着')
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small',
                    onclick: () => {
                      openRows.delete(c.id)
                      renderPanel()
                    },
                  },
                  '稍后再测',
                ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn link',
                onclick: () => {
                  propose({ type: 'check-dismiss', id: c.id })
                  if (checkRun) nextInRun('skipped')
                },
              },
              '不用测了',
            ),
          )
        : null,
      !open ? h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn small', onclick: () => propose({ type: 'check-reopen', id: c.id }) }, '放回待测试')) : null,
    )
  }

  // The checks of the overview (all) or of one module: what waits, then the last few that failed.
  function checksSection(list) {
    const waiting = list.filter(c => c.status === 'open')
    const failed = list.filter(c => c.status === 'failed').slice(-3)
    if (!waiting.length && !failed.length) return null
    return h(
      'div',
      { class: 'p-sec', id: 'checks-sec' },
      h('h3', {}, `${AGENT} 请你测试（${waiting.length}）`, waiting.length > 1 ? h('button', { type: 'button', class: 'btn small', onclick: () => startRun(waiting) }, '逐个测试') : null),
      h('div', { class: 'row-sub', text: `${AGENT} 改完后，需要你亲手确认的事。` }),
      waiting.map(c => checkCard(c, false)),
      failed.length ? [h('div', { class: 'row-sub', text: '最近没通过的：' }), failed.map(c => checkCard(c, false))] : null,
    )
  }

  function startRun(list) {
    checkRun = { ids: list.map(c => c.id), i: 0, passed: 0, failed: 0, skipped: 0 }
    selected = null
    fileSel = null
    draw()
    renderPanel()
    if (panel.classList.contains('closed')) togglePanel()
  }

  function nextInRun(kind) {
    if (!checkRun) return
    checkRun[kind]++
    checkRun.i++
    renderPanel()
  }

  function runPanel() {
    const r = checkRun
    // One that was settled meanwhile (on another tab, by the agent) is passed over.
    while (r.i < r.ids.length && !(checkById(r.ids[r.i]) && checkById(r.ids[r.i]).status === 'open')) r.i++
    const done = r.i >= r.ids.length
    const bar = h('div', { class: 'run-bar' }, h('i', {}))
    bar.firstChild.style.width = `${Math.round((Math.min(r.i, r.ids.length) / r.ids.length) * 100)}%`
    const close = () => {
      checkRun = null
      renderPanel()
    }
    if (done) {
      return h(
        'div',
        {},
        h('div', { class: 'run-head' }, h('h2', { text: '这一轮测完了' })),
        bar,
        h('div', { class: 'p-text', text: `通过 ${r.passed} 项，没通过 ${r.failed} 项，留着没测 ${r.skipped} 项。` }),
        r.failed ? h('div', { class: 'row-sub', text: `没通过的如果选了交给 ${AGENT} 修，已经在提议里，点「交给 ${AGENT} 实施」就行。` }) : null,
        h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn primary', onclick: close }, '回到概览')),
      )
    }
    const c = checkById(r.ids[r.i])
    return h(
      'div',
      {},
      h('div', { class: 'run-head' }, h('h2', { text: '逐个测试' }), h('span', { class: 'muted', text: `第 ${r.i + 1} / ${r.ids.length} 项` }), h('button', { type: 'button', class: 'btn small', onclick: close, title: '没测的会留在待测试里' }, '退出')),
      bar,
      checkCard(c, true),
      h('div', { class: 'acts' }, startPath(c) ? h('button', { type: 'button', class: 'btn small primary', onclick: () => reveal(startPath(c)) }, '打开文件夹') : null),
    )
  }

  // ---- the file tree ----

  // The modules a file belongs to: listed exactly, or under a listed folder
  // (a folder itself, written with a trailing slash, gets only folder entries).
  function ownersOf(file) {
    if (!S.graph) return []
    const f = file.toLowerCase()
    return S.graph.nodes
      .filter(n =>
        (n.files || []).some(x => {
          const g = x.toLowerCase().replace(/\/+$/, '')
          return f === g || f.startsWith(g + '/')
        }),
      )
      .map(n => n.id)
  }
  function nodeColor(id) {
    const n = S.graph && S.graph.nodes.find(x => x.id === id)
    return colorOf(n ? n.layer : '')
  }
  function dot(color, cls) {
    const d = h('span', { class: cls || 'f-dot' })
    d.style.background = color
    return d
  }
  const dirsOf = f => {
    const parts = f.split('/')
    const out = []
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
    return out
  }
  function revealPath(p) {
    for (const d of dirsOf(p)) openDirs.add(d)
  }
  function size(n) {
    return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  async function loadFiles() {
    const before = staleSig()
    try {
      FT = { ...(await request('/api/files')), loaded: true }
      if (staleSig() !== before) {
        draw()
        renderPanel()
      }
      dataStats.clear()
    } catch (err) {
      FT = { files: [], git: null, error: `列不出文件：${err.message}`, loaded: true }
    }
    // A small project opens whole; a big one shows its top level.
    if (!treeSeeded && FT.files.length) {
      treeSeeded = true
      if (FT.files.length <= 300) for (const f of FT.files) revealPath(f)
    }
    renderFiles()
    if (fileSel) loadPreview(fileSel)
  }

  async function loadPreview(p) {
    let v
    const at = fileFocus && fileFocus.path === p ? `&line=${fileFocus.line}${fileFocus.rev ? `&rev=${fileFocus.rev}` : ''}` : ''
    try {
      v = await request(`/api/file?path=${encodeURIComponent(p)}${at}`)
    } catch (err) {
      v = { error: `读不了这个文件：${err.message}` }
    }
    if (fileSel !== p) return
    fileView = { ...v, path: p }
    renderPanel()
  }

  function onActivity(d) {
    const until = Date.now() + 2600
    activity.set(d.path, { kind: d.kind, until })
    for (const id of ownersOf(d.path)) nodePulse.set(id, { kind: d.kind, until })
    if (!fSearch) revealPath(d.path)
    renderFiles()
    draw()
    const row = [...$('f-tree').querySelectorAll('.f-row')].find(r => r.dataset.path === d.path)
    if (row) row.scrollIntoView({ block: 'nearest' })
    clearTimeout(activityTimer)
    activityTimer = setTimeout(() => {
      renderFiles()
      draw()
    }, 2700)
  }

  function renderFiles(reveal) {
    const tree = $('f-tree')
    const files = FT.files || []
    const owners = new Map(files.map(f => [f, ownersOf(f)]))
    const unowned = S.graph ? files.filter(f => !owners.get(f).length) : []
    const edits = new Map()
    for (const c of S.history || []) edits.set(c.file, (edits.get(c.file) || 0) + 1)
    // Files a run made or changed, by the latest request that did.
    const made = new Map()
    for (const e of worklogOf()) for (const o of e.outputs) if (o.change !== 'deleted') made.set(o.path, e)
    const modFiles = selected ? new Set(files.filter(f => owners.get(f).includes(selected))) : null
    if (reveal && modFiles) for (const f of modFiles) revealPath(f)
    if (onlyUnowned && !unowned.length) onlyUnowned = false

    $('f-count').textContent = files.length ? `${files.length}${FT.truncated ? '+' : ''} 个` : ''
    $('f-branch').textContent = FT.git && FT.git.branch ? `⎇ ${FT.git.branch}` : ''
    $('f-filter').replaceChildren(
      ...(unowned.length
        ? [
            h(
              'button',
              {
                type: 'button',
                class: 'f-chip' + (onlyUnowned ? ' on' : ''),
                title: '不属于任何模块的文件；右键可以归到模块',
                onclick: () => {
                  onlyUnowned = !onlyUnowned
                  renderFiles()
                },
              },
              `未归属 ${unowned.length}`,
            ),
          ]
        : []),
    )

    const now = Date.now()
    const indent = (row, depth) => {
      row.style.paddingLeft = `${8 + depth * 14}px`
      return row
    }
    const fileRow = (f, depth, flat) => {
      const ids = owners.get(f) || []
      const g = FT.git && FT.git.status ? FT.git.status[f] : null
      const n = edits.get(f) || 0
      const act = activity.get(f)
      let cls = 'f-row f-file'
      if (S.graph && !ids.length) cls += ' unowned'
      if (fileSel === f) cls += ' sel'
      else if (modFiles && modFiles.has(f)) cls += ' mod'
      if (act && act.until > now) cls += ` act-${act.kind}`
      const where = flat ? f.split('/').slice(0, -1).join('/') : ''
      const row = h(
        'div',
        {
          class: cls,
          role: 'treeitem',
          'data-path': f,
          title: S.graph ? `${f}\n${ids.length ? `属于：${ids.map(nameOf).join('、')}` : '不属于任何模块'}` : f,
          onclick: () => selectFile(f),
          oncontextmenu: ev => {
            ev.preventDefault()
            fileMenu(f, ev.clientX, ev.clientY)
          },
        },
        h('span', { class: 'f-caret' }),
        h('span', { class: 'f-name' }, f.split('/').pop(), where ? h('span', { class: 'f-where', text: where }) : null),
        h(
          'span',
          { class: 'f-meta' },
          made.has(f) ? h('span', { class: 'f-made', title: `最近一次由「${firstLine(made.get(f))}」生成（${when(made.get(f).startedAt)}）`, text: '◆' }) : null,
          n ? h('span', { class: 'f-edits', title: `${AGENT} 改过 ${n} 次`, text: `✎${n}` }) : null,
          g && g.added !== undefined ? h('span', { class: 'f-lines', text: `+${g.added} −${g.removed}` }) : null,
          g ? h('span', { class: `g-${g.letter}`, title: GIT_TITLE[g.letter] || '', text: g.letter }) : null,
          S.graph ? (ids.length ? ids.slice(0, 3).map(id => dot(nodeColor(id))) : h('span', { class: 'f-dot none' })) : null,
        ),
      )
      return indent(row, depth)
    }
    const dirRow = (d, depth) => {
      const open = openDirs.has(d)
      const ids = ownersOf(d + '/')
      const row = h(
        'div',
        {
          class: 'f-row f-dir',
          role: 'treeitem',
          'aria-expanded': open ? 'true' : 'false',
          title: ids.length ? `${d}/\n整个文件夹属于：${ids.map(nameOf).join('、')}` : `${d}/`,
          onclick: () => {
            if (open) openDirs.delete(d)
            else openDirs.add(d)
            renderFiles()
          },
          oncontextmenu: ev => {
            ev.preventDefault()
            if (S.graph) openMenu(ev.clientX, ev.clientY, `${d}/`, [{ label: '把整个文件夹归到模块…', run: () => assignDialog(`${d}/`) }])
          },
        },
        h('span', { class: 'f-caret', text: open ? '▾' : '▸' }),
        h('span', { class: 'f-name', text: d.split('/').pop() }),
        h('span', { class: 'f-meta' }, sealedAt.has(d) ? sealedNote(sealedAt.get(d)) : null, ids.map(id => dot(nodeColor(id)))),
      )
      return indent(row, depth)
    }
    // A sensitive data folder or file: a lock and how many files, no names.
    const sealedAt = new Map((FT.sealed || []).map(sl => [sl.path, sl]))
    const sealedNote = sl => [lockGlyph(), h('span', { class: 'f-sealed', text: `${sl.count} 个文件` })]
    const sealedRow = (sl, depth) =>
      indent(
        h(
          'div',
          {
            class: 'f-row f-dir sealed',
            role: 'treeitem',
            title: `${sl.path}\n敏感数据：不列文件名、不预览，${AGENT} 也不读。点一下看它所属的模块。`,
            onclick: () => select(sl.node),
          },
          h('span', { class: 'f-caret' }),
          h('span', { class: 'f-name', text: sl.path.split('/').pop() }),
          h('span', { class: 'f-meta' }, sealedNote(sl), dot(nodeColor(sl.node))),
        ),
        depth,
      )

    const rows = []
    if (!FT.loaded) rows.push(h('div', { class: 'f-empty', text: '读取文件列表…' }))
    else if (FT.error) rows.push(h('div', { class: 'f-empty', text: FT.error }))
    else if (!files.length) rows.push(h('div', { class: 'f-empty', text: '项目里没有文件。' }))
    else if (fSearch || onlyUnowned) {
      // Modules first: a name or label that matches takes you to its card.
      const mods = onlyUnowned ? [] : findModules(fSearch)
      if (mods.length) {
        rows.push(h('div', { class: 'f-group', text: `模块 ${mods.length}` }))
        for (const n of mods.slice(0, 30)) {
          rows.push(
            indent(
              h(
                'div',
                { class: 'f-row f-mod' + (selected === n.id ? ' sel' : ''), role: 'treeitem', title: `跳到「${n.name}」`, onclick: () => focusNode(n.id) },
                h('span', { class: 'f-caret' }),
                glyph(nodeType(n)),
                h('span', { class: 'f-name' }, (n.ghost ? '+ ' : '') + n.name, h('span', { class: 'f-where', text: layerName(n.layer) })),
              ),
              0,
            ),
          )
        }
        rows.push(h('div', { class: 'f-group', text: '文件' }))
      }
      const list = files.filter(f => (!onlyUnowned || !owners.get(f).length) && (!fSearch || f.toLowerCase().includes(fSearch)))
      for (const f of list.slice(0, 400)) rows.push(fileRow(f, 0, true))
      if (!list.length) rows.push(h('div', { class: 'f-empty', text: mods.length ? '没有匹配的文件。' : '没有匹配的模块或文件。' }))
      if (list.length > 400) rows.push(h('div', { class: 'f-empty', text: `只列出前 400 个，共 ${list.length} 个。` }))
    } else {
      const kids = new Map()
      const at = d => {
        if (!kids.has(d)) kids.set(d, { dirs: new Set(), files: [], sealed: [] })
        return kids.get(d)
      }
      const place = (p, leaf) => {
        const parts = p.split('/')
        for (let i = 0; i < parts.length - 1; i++) at(parts.slice(0, i).join('/')).dirs.add(parts.slice(0, i + 1).join('/'))
        leaf(at(parts.slice(0, -1).join('/')))
      }
      for (const f of files) place(f, k => k.files.push(f))
      for (const sl of FT.sealed || []) place(sl.path, k => k.sealed.push(sl))
      const emit = (d, depth) => {
        const k = kids.get(d)
        if (!k) return
        for (const sub of [...k.dirs].sort((a, b) => a.localeCompare(b))) {
          rows.push(dirRow(sub, depth))
          if (openDirs.has(sub)) emit(sub, depth + 1)
        }
        // A sealed folder with notes in it already has its row, lock and all.
        for (const sl of k.sealed) if (!k.dirs.has(sl.path)) rows.push(sealedRow(sl, depth))
        for (const f of k.files) rows.push(fileRow(f, depth, false))
      }
      emit('', 0)
    }
    const scroll = tree.scrollTop
    tree.replaceChildren(...rows)
    tree.scrollTop = scroll
    if (reveal) {
      const el = tree.querySelector('.f-row.sel') || tree.querySelector('.f-row.mod')
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }

  function exactOwners(p) {
    return S.graph ? S.graph.nodes.filter(n => (n.files || []).some(x => x.toLowerCase() === p.toLowerCase())) : []
  }

  function fileMenu(f, x, y) {
    const ids = ownersOf(f)
    const items = [{ label: '查看文件', run: () => selectFile(f) }]
    if (S.graph) {
      items.push('-', { label: '归到模块…', run: () => assignDialog(f) })
      for (const n of exactOwners(f)) items.push({ label: `从「${n.name}」移出`, run: () => propose({ type: 'unassign-file', path: f, nodeId: n.id }) })
      if (ids.length) {
        items.push({ label: '对这个文件提意见…', run: () => fileCommentDialog(f, ids) })
        items.push('-', ...ids.map(id => ({ label: `查看「${nameOf(id)}」`, run: () => select(id) })))
      }
    }
    openMenu(x, y, f, items)
  }

  function assignDialog(p) {
    if (!S.graph) return
    const ids = ownersOf(p)
    const choices = S.graph.nodes.filter(n => !ids.includes(n.id))
    dialog({
      title: '归到模块',
      sub: `${p} 属于哪个模块？只改架构图里的记录，不动代码。`,
      fields: [
        {
          key: 'node',
          label: '模块',
          type: 'select',
          value: '',
          options: [{ value: '', label: '请选择模块…' }, ...choices.map(n => ({ value: n.id, label: `${layerName(n.layer)} · ${n.name}` }))],
        },
      ],
      submit: '归入',
      onSubmit: v => {
        if (!v.node) return '请选择模块。'
        propose({ type: 'assign-file', path: p, nodeId: v.node })
      },
    })
  }

  function fileCommentDialog(p, ids) {
    dialog({
      title: `对 ${p.split('/').pop()} 提意见`,
      sub: `写成所属模块的提议，交给 ${AGENT} 时一起处理。Ctrl+Enter 加入。`,
      fields: [
        ...(ids.length > 1 ? [{ key: 'node', label: '记在哪个模块下', type: 'select', value: ids[0], options: ids.map(id => ({ value: id, label: nameOf(id) })) }] : []),
        { key: 'text', label: '想怎么改', type: 'textarea', placeholder: '例如：这里的阈值改成可配置' },
      ],
      submit: '加入提议',
      onSubmit: v => {
        if (!v.text.trim()) return '意见是空的。'
        propose({ type: 'comment', nodeId: v.node || ids[0], text: `关于 ${p}：${v.text.trim()}` })
      },
    })
  }

  function previewBlock(v) {
    if (!v) return h('div', { class: 'p-empty', text: '读取中…' })
    if (v.error) return h('div', { class: 'p-empty', text: v.error })
    if (v.binary) return h('div', { class: 'p-empty', text: '二进制文件，不预览。' })
    const pre = h('pre', { class: 'code' })
    const from = v.start || 0
    const mark = fileFocus && fileFocus.path === v.path ? fileFocus : null
    v.lines.forEach((line, i) => {
      const n = from + i + 1
      pre.append(h('span', { class: mark && n >= mark.line && n <= mark.end ? 'hl' : '' }, h('i', { text: String(n) }), line || ' '))
    })
    // A cited spot in a file changed since the drawing: which version this is, and the way to the other.
    const st = mark ? citedState(v.path) : null
    const version = v.rev
      ? h(
          'div',
          { class: 'p-banner stale' },
          h('div', { text: `这是画图时（提交 ${v.rev.slice(0, 7)}）的版本：画好图以后这个文件改过，标出的是当时的那几行。` }),
          h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn link', onclick: () => showVersion(v.path, null) }, '看现在的')),
        )
      : mark && mark.was
        ? h('div', { class: 'p-banner' }, `这处依据引用时在第 ${mark.was} 行，上面的代码改过，已按当时那几行的内容对到现在的位置。`)
        : st && st.changed
        ? h(
            'div',
            { class: 'p-banner stale' },
            h('div', { text: '画好图以后这个文件改过，标出的行可能已经错位。' }),
            st.pinned ? h('div', { class: 'line' }, h('button', { type: 'button', class: 'btn link', onclick: () => showVersion(v.path, S.graph.revision) }, '看画图时的版本')) : null,
          )
        : null
    return h(
      'div',
      {},
      version,
      from ? h('div', { class: 'p-empty', text: `从第 ${from + 1} 行开始显示。` }) : null,
      pre,
      v.more ? h('div', { class: 'p-empty', text: `后面还有 ${v.more} 行没显示。` }) : null,
      v.cut ? h('div', { class: 'p-empty', text: '文件较大，只读了前 256 KB。' }) : null,
    )
  }

  // Where a file came from: the runs and outside changes that made or changed it, from the work log.
  function madeSection(p) {
    const made = madeBy(p)
    if (!made.length) return null
    return section(
      '怎么来的',
      made.slice(0, 6).map(m =>
        h(
          'div',
          { class: 'work-mini', onclick: () => setWork(true, m.e.id), title: '在工作记录里看这一次' },
          h('span', { class: 'work-time', text: when(m.run ? m.run.at : m.e.startedAt) }),
          h(
            'div',
            {},
            h('div', { class: 'work-req', text: `${CHANGE_WORD[m.o.change]} · ${m.run ? m.run.command : m.e.source === 'outside' ? `在 ${AGENT} 之外` : '命令行'}` }),
            h('div', { class: 'row-sub', text: (m.e.mark === 'void' ? '（已作废）' : '') + firstLine(m.e) }),
          ),
        ),
      ),
      made.length > 6 ? h('div', { class: 'p-empty', text: `更早还有 ${made.length - 6} 次` }) : null,
    )
  }

  function filePanel(p) {
    const ids = ownersOf(p)
    const exact = new Set(exactOwners(p).map(n => n.id))
    const g = FT.git && FT.git.status ? FT.git.status[p] : null
    const changes = (S.history || []).filter(c => c.file === p).reverse()
    const v = fileView && fileView.path === p ? fileView : null
    const sub = [p.split('/').slice(0, -1).join('/') || '项目根目录', v && v.size !== undefined ? size(v.size) : '', g ? GIT_TITLE[g.letter] || g.letter : '']
      .filter(Boolean)
      .join(' · ')
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'p-head' },
        h('div', {}, h('h2', { text: p.split('/').pop() }), h('div', { class: 'p-sub', text: sub })),
        h('button', { type: 'button', class: 'btn small', onclick: closeFile, title: '回到概览（Esc）' }, '× 关闭'),
      ),
      S.graph
        ? section(
            '所属模块',
            ids.length
              ? h(
                  'div',
                  { class: 'chips' },
                  ids.map(id =>
                    h(
                      'span',
                      { class: 'chip' + (exact.has(id) ? '' : ' only'), onclick: () => select(id), title: exact.has(id) ? '' : '因为所在文件夹归在这个模块下' },
                      dot(nodeColor(id), 'dot-chip'),
                      nameOf(id),
                      exact.has(id)
                        ? h('button', { type: 'button', class: 'x', title: '从这个模块移出', onclick: ev => (ev.stopPropagation(), propose({ type: 'unassign-file', path: p, nodeId: id })) }, '移出')
                        : null,
                    ),
                  ),
                )
              : h('div', { class: 'p-empty', text: '不属于任何模块。' }),
            h(
              'div',
              { class: 'compose' },
              h(
                'div',
                { class: 'line' },
                h('button', { type: 'button', class: 'btn small', onclick: () => assignDialog(p) }, '归到模块…'),
                ids.length ? h('button', { type: 'button', class: 'btn small', onclick: () => fileCommentDialog(p, ids) }, '对这个文件提意见…') : null,
              ),
            ),
          )
        : null,
      madeSection(p),
      section(`${AGENT} 的修改（${changes.length}）`, changes.length ? changes.slice(0, 15).map(c => changeRow(c, true)) : h('div', { class: 'p-empty', text: `${AGENT} 还没改过这个文件。` })),
      section('预览', previewBlock(v)),
    )
  }

  function renderPanel() {
    const active = document.activeElement
    const key = active && panelBody.contains(active) && active.dataset ? active.dataset.key : null
    const range = key && 'selectionStart' in active && active.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null
    const target = S.graph && selected && M && M.byId.has(selected) ? selected : null
    const line = !target && !fileSel && !workView ? shownFlow() : null
    const showing = checkRun ? 'run' : fileSel && !target ? `file:${fileSel}` : target || (workView ? 'work' : line ? `flow:${line.flow.id}` : null)
    const scroll = panelFor === showing ? panelBody.scrollTop : 0
    panelFor = showing
    panelBody.replaceChildren(
      checkRun ? runPanel() : target ? nodePanel(target) : fileSel ? filePanel(fileSel) : workView ? workPanel() : line ? flowPanel(line) : overviewPanel(),
    )
    for (const el of panelBody.querySelectorAll('[data-key]')) if (drafts[el.dataset.key]) el.value = drafts[el.dataset.key]
    if (key) {
      const el = panelBody.querySelector(`[data-key="${CSS.escape(key)}"]`)
      if (el) {
        el.focus({ preventScroll: true })
        if (range) el.setSelectionRange(range[0], range[1])
      }
    }
    panelBody.scrollTop = scroll
    // A cited spot just opened: its lines in view, once.
    const hl = fileFocus && fileFocus.scroll && panelBody.querySelector('.code .hl')
    if (hl) {
      fileFocus.scroll = false
      hl.scrollIntoView({ block: 'center' })
    }
  }

  function togglePanel() {
    const closed = panel.classList.toggle('closed')
    $('panel-toggle').textContent = closed ? '‹' : '›'
    keepUi({ panelClosed: closed })
  }
  $('panel-toggle').addEventListener('click', togglePanel)

  // Where the agent takes no message from the page, the instructions go on
  // the clipboard for the person to paste (the press makes copying allowed).
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const area = h('textarea', {})
      area.value = text
      document.body.append(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }

  async function handover() {
    if (HANDOFF && HANDOFF.handover) {
      const n = (S.tasks || []).filter(t => t.status === 'draft' || t.status === 'queued').length
      const copied = await copyText(HANDOFF.handover.replace('{n}', String(n)))
      toast(copied ? `指令已复制。回到 ${AGENT} 粘贴发送，或者直接说「处理画布上的提议」。` : `没能复制；回到 ${AGENT} 说「处理画布上的提议」就行。`, copied ? 'info' : 'error')
    }
    propose({ type: 'handover' })
  }

  async function generate() {
    if (HANDOFF && HANDOFF.generate) {
      const copied = await copyText(HANDOFF.generate)
      toast(copied ? `分析指令已复制。回到 ${AGENT} 粘贴发送。` : `没能复制；回到 ${AGENT} 说「分析项目、生成架构图」就行。`, copied ? 'info' : 'error')
      return
    }
    propose({ type: 'generate' })
  }

  // ---- how the canvas looks: wallpaper and colours ----
  // The person's own, the same for every project (the server keeps them in
  // their home folder). A change shows at once and is saved a moment later.

  const wallEl = $('wall')
  const gridEl = $('grid')
  const popEl = $('pop')
  let LOOK = {}
  let lookLoaded = false
  let lookTimer = 0
  let lookBusyUntil = 0
  const WALLPAPERS = [
    { id: 'dots', label: '点阵' },
    { id: 'grid', label: '网格' },
    { id: 'plain', label: '纯色' },
    { id: 'dusk', label: '暮色', css: 'linear-gradient(135deg, #1c2233 0%, #2c2036 100%)' },
    { id: 'forest', label: '森林', css: 'linear-gradient(160deg, #13201b 0%, #26362c 100%)' },
    { id: 'ember', label: '余烬', css: 'radial-gradient(circle at 25% 15%, #3b2a1e 0%, #1b1a19 65%)' },
    { id: 'paper', label: '纸张', css: 'linear-gradient(180deg, #f5f1e8 0%, #e8e0d0 100%)' },
    { id: 'sky', label: '晴空', css: 'linear-gradient(180deg, #e6eef8 0%, #cfdcee 100%)' },
  ]
  // The parts whose colour and opacity can be changed, and the theme's own value for each.
  const PARTS = {
    frame: { label: '分组框', theme: '--lane', fill: '--frame-fill', alpha: '--frame-alpha' },
    card: { label: '卡片', theme: '--node', fill: '--card-fill', alpha: '--card-alpha' },
    text: { label: '文字', theme: '--text', fill: '--text-fill', alpha: '--text-alpha' },
  }
  const STYLE_KEYS = ['frameColor', 'frameAlpha', 'cardColor', 'cardAlpha', 'textColor', 'textAlpha', 'edgeAlpha']

  // A theme colour as the colour picker takes it, with its own opacity.
  function themeColor(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const rgb = /^rgba?\(([^)]+)\)$/.exec(v)
    if (rgb) {
      const [r, g, b, a = '1'] = rgb[1].split(',').map(x => x.trim())
      return { hex: '#' + [r, g, b].map(x => Number(x).toString(16).padStart(2, '0')).join(''), alpha: Number(a) }
    }
    if (/^#[0-9a-f]{6}$/i.test(v)) return { hex: v.toLowerCase(), alpha: 1 }
    if (/^#[0-9a-f]{3}$/i.test(v)) return { hex: '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase(), alpha: 1 }
    return { hex: '#888888', alpha: 1 }
  }

  function setVar(name, value) {
    if (value === undefined || value === null) stage.style.removeProperty(name)
    else stage.style.setProperty(name, String(value))
  }

  function applyStyle(look) {
    LOOK = look || {}
    // The side bars and legend as the person left them; on a narrow screen the file tree starts folded.
    const bars = () => `${$('files').classList.contains('closed')}${panel.classList.contains('closed')}`
    const was = bars()
    // The first time, the bars take their places at once, without sliding.
    const first = !lookLoaded
    if (first) document.body.classList.add('still')
    foldBar($('files'), $('files-toggle'), LOOK.filesClosed ?? window.innerWidth < 1200, '›', '‹')
    foldBar(panel, $('panel-toggle'), Boolean(LOOK.panelClosed), '‹', '›')
    renderLegend()
    // The map was fitted to the room before the settings came: fit it again to the room it has.
    if (first && fitted && !viewRestored && bars() !== was) fitView()
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('still')))
    lookLoaded = true
    const wall = LOOK.wall === 'image' && !LOOK.wallpaper ? 'dots' : LOOK.wall || 'dots'
    setVar('--wall-color', LOOK.wallColor)
    gridEl.className = wall === 'dots' ? 'dots' : wall === 'grid' ? 'lines' : ''
    const preset = WALLPAPERS.find(w => w.id === wall)
    const dim = LOOK.wallDim ?? 0.35
    wallEl.style.backgroundImage =
      wall === 'image' ? `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("/wallpaper?v=${LOOK.wallpaper}")` : preset && preset.css ? preset.css : ''
    // A part keeps the theme's colour until the person touches it; then its
    // colour is solid and the opacity is theirs.
    for (const [key, part] of Object.entries(PARTS)) {
      const color = LOOK[`${key}Color`]
      const alpha = LOOK[`${key}Alpha`]
      const touched = color !== undefined || alpha !== undefined
      const base = themeColor(part.theme)
      setVar(part.fill, touched ? color || base.hex : undefined)
      setVar(part.alpha, touched ? (alpha ?? base.alpha) : undefined)
    }
    setVar('--edge-alpha', LOOK.edgeAlpha)
    applyView()
  }

  async function loadStyle() {
    try {
      applyStyle(await (await fetch('/api/style', { cache: 'no-store' })).json())
    } catch {}
  }

  // `undefined` in a change takes the setting back to the default.
  function setLook(change) {
    const next = { ...LOOK, ...change }
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete next[k]
    applyStyle(next)
    lookBusyUntil = Date.now() + 1500
    clearTimeout(lookTimer)
    lookTimer = setTimeout(() => {
      const { wallpaper, ...settings } = LOOK
      postLook('/api/style', settings)
    }, 300)
  }

  async function postLook(url, body) {
    try {
      return await postJson(url, body)
    } catch (err) {
      toast(`外观没保存上：${err.message}`, 'error')
      return null
    }
  }

  // The picked image goes up smaller: no canvas needs more than a large screen's worth.
  async function uploadWallpaper(file) {
    try {
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result)
        r.onerror = () => reject(new Error('读不了这个文件'))
        r.readAsDataURL(file)
      })
      const img = await new Promise((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('这不是能用的图片'))
        i.src = url
      })
      const k = Math.min(1, 2560 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * k))
      c.height = Math.max(1, Math.round(img.naturalHeight * k))
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      const saved = await postLook('/api/wallpaper', { data: c.toDataURL('image/jpeg', 0.85) })
      if (!saved) return
      setLook({ wall: 'image', wallpaper: saved.wallpaper })
      if (popFor) renderPop()
    } catch (err) {
      toast(`没能用这张图片：${err.message}`, 'error')
    }
  }

  async function removeWallpaper() {
    if (!(await postLook('/api/wallpaper', { remove: true }))) return
    setLook({ wall: LOOK.wall === 'image' ? undefined : LOOK.wall, wallpaper: 0 })
    renderPop()
  }

  // ---- the popover under a toolbar button ----

  let popFor = null
  let popBuild = null
  function openPop(anchor, build) {
    if (popFor === anchor) return closePop()
    closeMenu()
    popFor = anchor
    popBuild = build
    renderPop()
    popEl.hidden = false
    const r = anchor.getBoundingClientRect()
    popEl.style.top = `${r.bottom + 8}px`
    popEl.style.left = `${clamp(r.left, 8, window.innerWidth - popEl.offsetWidth - 8)}px`
  }
  function renderPop() {
    if (popBuild) popEl.replaceChildren(...popBuild().filter(Boolean))
  }
  function closePop() {
    popFor = null
    popBuild = null
    popEl.hidden = true
    popEl.replaceChildren()
  }
  document.addEventListener('pointerdown', ev => {
    const path = ev.composedPath()
    if (popFor && !path.includes(popEl) && !path.includes(popFor)) closePop()
  })

  const popRow = (label, ...controls) => h('div', { class: 'pop-row' }, h('span', { class: 'pop-label', text: label }), ...controls)
  function colorInput(value, onInput) {
    const el = h('input', { type: 'color', value })
    el.addEventListener('input', () => onInput(el.value))
    return el
  }
  // An opacity, shown as a percentage beside the slider.
  function slider(value, max, onInput) {
    const pct = h('span', { class: 'pop-pct', text: `${Math.round(value * 100)}%` })
    const el = h('input', { type: 'range', min: 0, max, step: 0.01, value })
    el.addEventListener('input', () => {
      pct.textContent = `${Math.round(Number(el.value) * 100)}%`
      onInput(Number(el.value))
    })
    return [el, pct]
  }
  const popFoot = reset =>
    h(
      'div',
      { class: 'pop-foot' },
      h('span', { class: 'muted', text: '所有项目共用这套设置' }),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            setLook(Object.fromEntries(reset.map(k => [k, undefined])))
            renderPop()
          },
        },
        '恢复默认',
      ),
    )

  function wallpaperPop() {
    const current = LOOK.wall === 'image' && !LOOK.wallpaper ? 'dots' : LOOK.wall || 'dots'
    const swatch = (id, label) => {
      const thumb = h('span', { class: 'pop-thumb' + (id === 'dots' ? ' dots' : id === 'grid' ? ' lines' : '') })
      const preset = WALLPAPERS.find(w => w.id === id)
      if (preset && preset.css) thumb.style.backgroundImage = preset.css
      if (id === 'image') thumb.style.backgroundImage = `url("/wallpaper?v=${LOOK.wallpaper}")`
      if (LOOK.wallColor && (id === 'dots' || id === 'grid' || id === 'plain')) thumb.style.backgroundColor = LOOK.wallColor
      return h(
        'button',
        {
          type: 'button',
          class: 'pop-swatch' + (current === id ? ' on' : ''),
          onclick: () => {
            setLook({ wall: id })
            renderPop()
          },
        },
        thumb,
        h('span', { text: label }),
      )
    }
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true })
    file.addEventListener('change', () => file.files[0] && uploadWallpaper(file.files[0]))
    return [
      h('div', { class: 'pop-title', text: '更换壁纸' }),
      h('div', { class: 'pop-swatches' }, WALLPAPERS.map(w => swatch(w.id, w.label)), LOOK.wallpaper ? swatch('image', '我的图片') : null),
      h(
        'div',
        { class: 'pop-row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => file.click() }, LOOK.wallpaper ? '换一张图片…' : '用自己的图片…'),
        LOOK.wallpaper ? h('button', { type: 'button', class: 'btn small link', onclick: removeWallpaper }, '删除图片') : null,
        file,
      ),
      current === 'dots' || current === 'grid' || current === 'plain'
        ? popRow('底色', colorInput(LOOK.wallColor || themeColor('--bg').hex, v => setLook({ wallColor: v })))
        : null,
      current === 'image' ? popRow('图片变暗', ...slider(LOOK.wallDim ?? 0.35, 0.8, v => setLook({ wallDim: v }))) : null,
      popFoot(['wall', 'wallColor', 'wallDim']),
    ]
  }

  function stylePop() {
    const rows = Object.entries(PARTS).map(([key, part]) => {
      const base = themeColor(part.theme)
      return popRow(
        part.label,
        colorInput(LOOK[`${key}Color`] || base.hex, v => setLook({ [`${key}Color`]: v })),
        ...slider(LOOK[`${key}Alpha`] ?? base.alpha, 1, v => setLook({ [`${key}Alpha`]: v })),
      )
    })
    return [
      h('div', { class: 'pop-title', text: '调整风格' }),
      ...rows,
      popRow('连线', ...slider(LOOK.edgeAlpha ?? 1, 1, v => setLook({ edgeAlpha: v }))),
      popFoot(STYLE_KEYS),
    ]
  }

  // ---- toasts and the live line ----

  function toast(text, level, action) {
    const box = $('toasts')
    const el = h('div', { class: `toast ${level || 'info'}`, text })
    if (action) el.append(h('button', { type: 'button', class: 'btn link toast-act', onclick: () => (el.remove(), action.run()) }, action.label))
    box.append(el)
    while (box.children.length > 3) box.firstChild.remove()
    setTimeout(() => el.remove(), level === 'error' ? 7000 : 4500)
  }

  function setLink(on) {
    const link = $('link')
    link.classList.toggle('on', on)
    link.classList.toggle('off', !on)
    link.querySelector('b').textContent = on ? `已连接 ${AGENT}` : '已断开'
    $('offline').hidden = on
  }

  async function refresh() {
    let st
    try {
      const r = await fetch('/api/state', { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      st = await r.json()
    } catch (err) {
      setLink(false)
      return
    }
    S = st
    if ((st.agent || 'Claude') !== AGENT) setAgent(st.agent)
    HANDOFF = st.handoff || null
    if (st.reopen) $('offline').textContent = `与 ${AGENT} 的连接断开了。${st.reopen}`
    // New things to test get a word, once; the first load only takes stock.
    const waiting = checksOf(st).filter(c => c.status === 'open')
    if (knownChecks) {
      const fresh = waiting.filter(c => !knownChecks.has(c.id))
      if (fresh.length) toast(fresh.length === 1 ? `${AGENT} 留了 1 项给你测试：${fresh[0].title}` : `${AGENT} 留了 ${fresh.length} 项给你测试`)
    }
    knownChecks = new Set(waiting.map(c => c.id))
    const nextAt = st.pending && st.pending.graph ? st.pending.at : 0
    if (knownNext !== null && nextAt && nextAt !== knownNext) toast(`${AGENT} 重新画了架构图，结构有变化，等你确认。`)
    knownNext = nextAt
    // The server's layout, unless the page has changes it does not have yet.
    if (!layoutMine()) {
      const lay = st.layout || {}
      const v2 = lay.v === 2
      const positions = lay.positions && typeof lay.positions === 'object' ? lay.positions : {}
      // A card being dragged right now stays where the pointer has it.
      const held = drag && drag.mode === 'node' && drag.moved ? L.positions[drag.id] : null
      L = {
        v: 2,
        frames: v2 && lay.frames && typeof lay.frames === 'object' ? lay.frames : {},
        // Version 1 kept positions on the whole canvas, one column per layer.
        positions: v2 ? positions : Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: FRAME.pad, y: Math.max(FRAME.top, p.y) }])),
        colors: lay.colors && typeof lay.colors === 'object' ? lay.colors : {},
        collapsed: Array.isArray(lay.collapsed) ? lay.collapsed : [],
        expanded: Array.isArray(lay.expanded) ? lay.expanded : [],
        ...(lay.view && Number.isFinite(lay.view.k) ? { view: lay.view } : {}),
        ...(lay.reach === 'all' ? { reach: 'all' } : {}),
      }
      if (held) L.positions[drag.id] = held
      Object.assign(L.positions, unsavedPos)
      Object.assign(L.frames, unsavedFrames)
      if (!drag) layoutBefore = JSON.stringify(L)
    }
    const naming = placePendingFrame()
    for (const [id, layer] of movedTo) {
      const real = st.graph && st.graph.nodes.find(n => n.id === id)
      const t = (st.tasks || []).find(x => x.node && x.node.id === id && x.status === 'draft')
      if (real ? real.layer === layer : !t || t.node.layer === layer) movedTo.delete(id)
    }
    const placed = placePending()
    const finished = noteFinished(st)
    // A draft handed over or withdrawn closes its box, with nothing more to send.
    if (editor && editor.kind === 'add' && !(st.tasks || []).some(t => t.id === editor.taskId && t.status === 'draft')) closeEditor(false)
    for (const e of st.errors || []) {
      if (!seenErrors.has(e)) {
        seenErrors.add(e)
        toast(e, 'error')
      }
    }
    if (selected && !(S.graph && (S.graph.nodes.some(n => n.id === selected) || (S.tasks || []).some(t => OPEN.has(t.status) && t.node && t.node.id === selected)))) selected = null
    draw()
    renderPanel()
    renderFiles()
    if (!fitted && S.graph) {
      // Back where the person last looked in this project; the first time, the whole map.
      if (L.view) {
        Object.assign(view, { x: L.view.x, y: L.view.y, k: L.view.k })
        viewRestored = true
        fitted = true
        applyView()
      } else {
        fitted = true
        fitView()
      }
    }
    if (placed) openEditor(placed, 'rest')
    else if (naming) renameFrame(naming)
    if (finished) {
      clearTimeout(doneTimer)
      doneTimer = setTimeout(draw, 3100)
    }
  }

  // Tasks the agent finished since the last look: their modules flash and
  // say so. A new module keeps the spot its draft had, under its final id.
  let doneTimer = 0
  function noteFinished(st) {
    const before = lastStatus
    lastStatus = new Map((st.tasks || []).map(t => [t.id, t.status]))
    if (!before || !st.graph) return 0
    const until = Date.now() + 3000
    let n = 0
    for (const t of st.tasks || []) {
      const was = before.get(t.id)
      if (!was || was === 'done' || t.status !== 'done') continue
      n++
      let ids = t.nodeIds
      if (t.kind === 'add-node' && t.node) {
        const real = st.graph.nodes.find(x => x.id === t.node.id) || st.graph.nodes.find(x => x.name === t.node.name)
        ids = real ? [real.id] : []
        const spot = L.positions[t.node.id]
        if (real && real.id !== t.node.id && spot && !L.positions[real.id]) {
          setPos(real.id, spot)
          delete L.positions[t.node.id]
          saveLayout(false)
        }
      }
      for (const id of ids) if (st.graph.nodes.some(x => x.id === id)) nodePulse.set(id, { kind: 'done', until })
      toast(`${AGENT} 完成了：${t.text}`)
    }
    return n
  }

  function listen() {
    const es = new EventSource('/api/events')
    es.addEventListener('open', () => {
      setLink(true)
      refresh()
      loadFiles()
    })
    es.addEventListener('change', ev => {
      refresh()
      // Which files show depends on the graph too (sensitive data is not listed).
      try {
        if (JSON.parse(ev.data).files.includes('graph')) loadFiles()
      } catch {}
    })
    es.addEventListener('files', () => loadFiles())
    // Saved here a moment ago, or in another canvas open on this machine.
    es.addEventListener('style', ev => {
      if (Date.now() < lookBusyUntil) return
      try {
        applyStyle(JSON.parse(ev.data))
      } catch {}
    })
    es.addEventListener('activity', ev => {
      try {
        onActivity(JSON.parse(ev.data))
      } catch {}
    })
    es.addEventListener('notice', ev => {
      try {
        const d = JSON.parse(ev.data)
        toast(d.text, d.level)
      } catch {}
    })
    es.addEventListener('error', () => setLink(false))
  }

  // ---- toolbar and keys ----

  $('zoom-in').addEventListener('click', () => zoomCenter(1.2))
  $('zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2))
  $('zoom-reset').addEventListener('click', () => zoomCenter(1 / view.k))
  $('wallpaper-btn').addEventListener('click', ev => openPop(ev.currentTarget, wallpaperPop))
  $('style-btn').addEventListener('click', ev => openPop(ev.currentTarget, stylePop))
  $('handover').addEventListener('click', handover)
  $('next-pill').addEventListener('click', () => {
    selected = null
    fileSel = null
    fileView = null
    checkRun = null
    draw()
    renderPanel()
    renderFiles()
    if (panel.classList.contains('closed')) togglePanel()
    const sec = $('next-sec')
    if (sec) sec.scrollIntoView({ block: 'start' })
  })
  $('pending').addEventListener('click', () => {
    selected = null
    fileSel = null
    fileView = null
    checkRun = null
    draw()
    renderPanel()
    renderFiles()
    if (panel.classList.contains('closed')) togglePanel()
    const sec = $('proposals-sec')
    if (sec) sec.scrollIntoView({ block: 'start' })
  })
  $('checks-pill').addEventListener('click', () => {
    selected = null
    fileSel = null
    fileView = null
    draw()
    renderPanel()
    renderFiles()
    if (panel.classList.contains('closed')) togglePanel()
    const sec = $('checks-sec')
    if (sec) sec.scrollIntoView({ block: 'start' })
  })
  $('generate').addEventListener('click', generate)
  $('flow').addEventListener('change', ev => {
    flow = ev.target.checked
    draw()
  })
  // One main line and none on show: straight to it. Otherwise the list, and the agent to draw them.
  $('mainline-btn').addEventListener('click', () => {
    const flows = (S.graph && S.graph.flows) || []
    if (flows.length === 1 && !mainFlow) return setFlow(flows[0].id)
    const r = $('mainline-btn').getBoundingClientRect()
    const items = flows.map(f => ({ label: `${f.name}（${f.steps.length} 步）`, on: mainFlow === f.id, run: () => setFlow(mainFlow === f.id ? null : f.id) }))
    if (flows.length) items.push('-')
    items.push({ label: flows.length ? `让 ${AGENT} 重画主线` : `让 ${AGENT} 画出主线`, run: () => propose({ type: 'flows' }) })
    if (mainFlow) items.push({ label: '退出主线', run: () => setFlow(null) })
    openMenu(r.left, r.bottom + 6, flows.length ? '主线：按执行顺序看一次完整流程' : '这张图还没有主线', items)
  })
  $('worklog-btn').addEventListener('click', () => setWork(!workView))
  // Enter goes to the first module that matches, else opens the first file.
  $('f-search').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.isComposing || !fSearch) return
    ev.preventDefault()
    const n = findModules(fSearch)[0]
    if (n) return focusNode(n.id)
    const f = (FT.files || []).find(x => x.toLowerCase().includes(fSearch))
    if (f) selectFile(f)
  })
  $('f-search').addEventListener('input', ev => {
    fSearch = ev.target.value.trim().toLowerCase()
    renderFiles()
  })
  function toggleFiles() {
    const closed = $('files').classList.toggle('closed')
    $('files-toggle').textContent = closed ? '›' : '‹'
    keepUi({ filesClosed: closed })
  }
  $('files-toggle').addEventListener('click', toggleFiles)

  document.addEventListener('keydown', ev => {
    if (!dialogWrap.hidden) {
      if (ev.key === 'Escape') closeDialog()
      return
    }
    // A new card is open but its name lost the focus: Enter still makes it.
    if (ev.key === 'Enter' && !ev.isComposing && editor && editor.kind === 'new' && sketch && !sketch.sent && ev.target !== sketchName) {
      ev.preventDefault()
      return submitSketch()
    }
    if (ev.key === 'Escape') {
      if (!menu.hidden) return closeMenu()
      if (popFor) return closePop()
      if (editor) return closeEditor(editor.kind !== 'new')
      if (connectFrom) return endConnect()
      if (ev.target === $('f-search') && fSearch) {
        ev.target.value = ''
        fSearch = ''
        return renderFiles()
      }
      if (checkRun) {
        checkRun = null
        return renderPanel()
      }
      if (selected) return select(null)
      if (fileSel) return closeFile()
      if (workView) return setWork(false)
      if (mainFlow) return setFlow(null)
      return
    }
    const tag = ev.target && ev.target.tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)
    if (!typing && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault()
      return undo()
    }
    if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (ev.key === '/') {
      if ($('files').classList.contains('closed')) toggleFiles()
      $('f-search').focus()
      $('f-search').select()
    } else if (ev.key === 'f' || ev.key === 'F') fitView()
    else if (ev.key === '0') zoomCenter(1 / view.k)
    else if (ev.key === '+' || ev.key === '=') zoomCenter(1.2)
    else if (ev.key === '-') zoomCenter(1 / 1.2)
    else return
    ev.preventDefault()
  })

  window.addEventListener('resize', () => {
    closeMenu()
  })

  renderLegend()
  setLink(false)
  $('link').querySelector('b').textContent = '连接中'
  $('offline').hidden = true
  refresh()
  listen()
  loadStyle()
})()
