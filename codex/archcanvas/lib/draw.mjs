// Generated from archcanvas/hooks/draw.ts; edit source, then rebuild.
// The overview drawing: layers as bands, modules as boxes, dependencies as
// curves, with the open tasks drawn over them. Pure.
//
// The drawing is laid out for the width it will be shown at, so the pane
// never has to shrink it: a narrow pane wraps a layer's modules onto more
// lines and puts the layer's name above them. Lines are ordered by where
// their neighbours sit, so edges cross less; an edge that skips lines runs
// down a free gutter instead of through the boxes between. Colours follow the
// light or dark scheme.

                                                                 

const PAD = 12
const BAND_GAP = 8
const LEGEND_H = 30
const PORT_INSET = 20
const NODE_H = 42

                
               
              
                                                            
               
                 
                    
 

const WIDE          = { nodeW: 150, gapX: 24, labelW: 92, lineH: 78, bandTop: 6, bandBottom: 6 }
const NARROW          = { nodeW: 124, gapX: 10, labelW: 0, lineH: 64, bandTop: 24, bandBottom: 4 }

// Dark first; the light scheme overrides the same names.
const STYLE = `
.band{fill:#232933}.band-t{fill:#a3adbd}
.node{fill:#2d3542;stroke:#4f5b70}.node-t{fill:#e8ecf2}.kind{fill:#98a2b3}
.edge{stroke:#66748c}.edge-h{fill:#66748c}
.focus{stroke:#6fb6e0}.focus-h{fill:#6fb6e0}
.near{stroke:#8fc59a}
.add{stroke:#6cc48a}.add-h,.add-t{fill:#6cc48a}
.rm{stroke:#e8787a}.rm-h{fill:#e8787a}
.note{fill:#e6b552}.note-t{fill:#1d2129}
.legend-t{fill:#a3adbd}
@media (prefers-color-scheme: light){
.band{fill:#f0f2f6}.band-t{fill:#58627a}
.node{fill:#ffffff;stroke:#c3ccd9}.node-t{fill:#1c2330}.kind{fill:#667185}
.edge{stroke:#93a0b4}.edge-h{fill:#93a0b4}
.focus{stroke:#2f7fb5}.focus-h{fill:#2f7fb5}
.near{stroke:#4f9a5f}
.add{stroke:#2f9a55}.add-h,.add-t{fill:#2f9a55}
.rm{stroke:#c94a4a}.rm-h{fill:#c94a4a}
.note{fill:#d9961a}.note-t{fill:#ffffff}
.legend-t{fill:#58627a}
}`

// Roughly how wide a label draws at 13px: CJK glyphs are about twice as wide.
function textWidth(s        , px = 13)         {
  let w = 0
  for (const ch of s) w += /[⺀-￿]/.test(ch) ? px : px * 0.56
  return w
}

function fit(s        , max        , px = 13)         {
  if (textWidth(s, px) <= max) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', px) > max) break
    out += ch
  }
  return out + '…'
}

const esc = (s        ) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

                                                                                              
                                                         

// Orders each layer by the mean position of its neighbours in the others,
// keeping the given order between equals.
function orderRows(rows               , edges                      )                {
  const out = rows.map(r => [...r])
  const pos = () => {
    const m = new Map                ()
    out.forEach(r => r.forEach((n, i) => m.set(n.id, i - (r.length - 1) / 2)))
    return m
  }
  const neighbours = (id        ) => edges.flatMap(e => (e.from === id ? [e.to] : e.to === id ? [e.from] : []))
  for (const pass of [0, 1, 2]) {
    const range = pass === 1 ? [...out.keys()].reverse() : [...out.keys()]
    for (const r of range) {
      const p = pos()
      const rowIds = new Set(out[r].map(n => n.id))
      const score = (n           , i        ) => {
        const ns = neighbours(n.id).filter(id => !rowIds.has(id) && p.has(id))
        return ns.length ? ns.reduce((s, id) => s + p.get(id) , 0) / ns.length : i - (out[r].length - 1) / 2
      }
      out[r] = out[r]
        .map((n, i) => ({ n, s: score(n, i), i }))
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .map(x => x.n)
    }
  }
  return out
}

                                                                                                              

// Lays the graph out to fit `maxWidth` pixels: as many modules per line as
// fit, a layer wrapping onto more lines when it has more.
export function layout(
  graph       ,
  ghosts                       = [],
  extraEdges                       = [],
  maxWidth = 760,
)         {
  const rows = graph.layers.map(layer => [
    ...graph.nodes.filter(n => n.layer === layer.id),
    ...ghosts.filter(n => n.layer === layer.id),
  ])
  const ordered = orderRows(rows, [...graph.edges, ...extraEdges])
  const widestRow = Math.max(1, ...ordered.map(r => r.length))
  const fits = (m         ) => Math.max(1, Math.floor((maxWidth - PAD * 2 - m.labelW + m.gapX) / (m.nodeW + m.gapX)))
  // The wide form while it holds at least two modules a line, else the narrow.
  const base = fits(WIDE) >= Math.min(2, widestRow) ? WIDE : NARROW
  const cols = Math.min(widestRow, fits(base))
  // Boxes widen to use the room there is, up to a comfortable width.
  const room = Math.floor((maxWidth - PAD * 2 - base.labelW - base.gapX * (cols - 1)) / cols)
  const m          = { ...base, nodeW: Math.max(base.nodeW, Math.min(room, base.labelW ? 190 : 176)) }
  const inner = cols * (m.nodeW + m.gapX) - m.gapX
  const width = PAD * 2 + m.labelW + inner

  const ghostIds = new Set(ghosts.map(g => g.id))
  const placed = new Map                ()
  const bands         = []
  let top = PAD
  let line = 0
  ordered.forEach((row, r) => {
    const lines = Math.max(1, Math.ceil(row.length / cols))
    const height = m.bandTop + lines * m.lineH + m.bandBottom
    bands.push({ name: graph.layers[r].name, top, height })
    for (let l = 0; l < lines; l++) {
      const chunk = row.slice(l * cols, (l + 1) * cols)
      const offset = (inner - (chunk.length * (m.nodeW + m.gapX) - m.gapX)) / 2
      chunk.forEach((node, col) => {
        placed.set(node.id, {
          node,
          line: line + l,
          isGhost: ghostIds.has(node.id),
          x: PAD + m.labelW + offset + col * (m.nodeW + m.gapX),
          y: top + m.bandTop + l * m.lineH + (m.lineH - NODE_H) / 2,
        })
      })
    }
    line += lines
    top += height + BAND_GAP
  })
  return { placed, bands, width, height: top - BAND_GAP + PAD, m }
}

                                    

// Spreads where lines leave and arrive along each box's edges, ordered by
// where the other end is, so they fan out instead of bundling.
function ports(edges                      , L        )                                       {
  const slots = new Map                                           ()
  const add = (k        , e           , other        ) => slots.set(k, [...(slots.get(k) ?? []), { e, other }])
  for (const e of edges) {
    const a = L.placed.get(e.from)
    const b = L.placed.get(e.to)
    if (!a || !b) continue
    if (a.line === b.line) {
      add(`${e.from}:top`, e, b.x)
      add(`${e.to}:top`, e, a.x)
    } else if (b.line > a.line) {
      add(`${e.from}:bottom`, e, b.x)
      add(`${e.to}:top`, e, a.x)
    } else {
      add(`${e.from}:top`, e, b.x)
      add(`${e.to}:bottom`, e, a.x)
    }
  }
  const at = new Map              ()
  for (const [k, list] of slots) {
    const [id, side] = k.split(':')
    const p = L.placed.get(id) 
    list.sort((u, v) => u.other - v.other)
    list.forEach(({ e }, i) => {
      const span = L.m.nodeW - PORT_INSET * 2
      const x = list.length === 1 ? p.x + L.m.nodeW / 2 : p.x + PORT_INSET + (span * i) / (list.length - 1)
      at.set(`${e.from}>${e.to}@${id}`, { x, y: side === 'top' ? p.y : p.y + NODE_H })
    })
  }
  const out = new Map                                 ()
  for (const e of edges) {
    const a = at.get(`${e.from}>${e.to}@${e.from}`)
    const b = at.get(`${e.from}>${e.to}@${e.to}`)
    if (a && b) out.set(e, { a, b })
  }
  return out
}

// An x that no box on lines (lo, hi) covers, nearest to `want`.
function gutter(L        , lo        , hi        , want        )                     {
  const blocked                     = []
  for (const p of L.placed.values()) if (p.line > lo && p.line < hi) blocked.push([p.x - 7, p.x + L.m.nodeW + 7])
  const left = PAD + L.m.labelW - L.m.gapX / 2
  const right = L.width - PAD - 3
  const free = (x        ) => x >= left && x <= right && blocked.every(([a, b]) => x < a || x > b)
  if (free(want)) return want
  const candidates = blocked.flatMap(([a, b]) => [a - 1, b + 1]).filter(free)
  candidates.sort((u, v) => Math.abs(u - want) - Math.abs(v - want))
  return candidates[0]
}

function route(from        , to        , a      , b      , L        )         {
  if (from.line === to.line) {
    const lift = (L.m.lineH - NODE_H) / 2 + 4
    return `M${a.x},${a.y} C${a.x},${a.y - lift} ${b.x},${b.y - lift} ${b.x},${b.y}`
  }
  const down = to.line > from.line
  const lo = Math.min(from.line, to.line)
  const hi = Math.max(from.line, to.line)
  if (hi - lo > 1) {
    const gx = gutter(L, lo, hi, (a.x + b.x) / 2)
    if (gx !== undefined) {
      const dir = down ? 1 : -1
      const y1 = a.y + dir * 18
      const y2 = b.y - dir * 18
      return `M${a.x},${a.y} C${a.x},${y1} ${gx},${a.y} ${gx},${y1} L${gx},${y2} C${gx},${b.y} ${b.x},${y2} ${b.x},${b.y}`
    }
  }
  const mid = (a.y + b.y) / 2
  return `M${a.x},${a.y} C${a.x},${mid} ${b.x},${mid} ${b.x},${b.y}`
}

const marker = (id        , cls        ) =>
  `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="${cls}"/></marker>`

export function toSvg(graph       , selected               , tasks                  = [], maxWidth = 760)         {
  const open = tasks.filter(t => t.status === 'draft' || t.status === 'queued' || t.status === 'working')
  const ghosts = open.flatMap(t => (t.kind === 'add-node' && t.node ? [t.node] : []))
  const removing = new Set(open.flatMap(t => (t.kind === 'remove-node' ? t.nodeIds : [])))
  const edgeKey = (e           ) => `${e.from}>${e.to}`
  const cutting = new Set(open.flatMap(t => (t.kind === 'remove-edge' && t.edge ? [edgeKey(t.edge)] : [])))
  const adding              = [
    ...open.flatMap(t => (t.kind === 'add-edge' && t.edge ? [t.edge] : [])),
    ...open.flatMap(t => (t.kind === 'add-node' && t.node ? t.nodeIds.map(to => ({ from: t.node .id, to })) : [])),
    ...open.flatMap(t => (t.kind === 'add-node' && t.node ? (t.usedBy ?? []).map(from => ({ from, to: t.node .id })) : [])),
  ]
  const notes = new Map                ()
  for (const t of open) if (t.kind === 'comment') for (const id of t.nodeIds) notes.set(id, (notes.get(id) ?? 0) + 1)

  const L = layout(graph, ghosts, adding, maxWidth)
  const { placed, width, m } = L
  const hasLegend = open.some(t => t.kind !== 'comment') || notes.size > 0
  const height = L.height + (hasLegend ? LEGEND_H : 0)
  const near = new Set        ()
  if (selected) {
    for (const e of graph.edges) {
      if (e.from === selected) near.add(e.to)
      if (e.to === selected) near.add(e.from)
    }
  }
  const at = ports([...graph.edges, ...adding], L)

  const parts           = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, 'Microsoft YaHei UI', 'PingFang SC', sans-serif" font-size="13">`,
    `<style>${STYLE}</style>`,
    `<defs>${marker('a', 'edge-h')}${marker('af', 'focus-h')}${marker('ag', 'add-h')}${marker('ar', 'rm-h')}</defs>`,
  ]

  for (const band of L.bands) {
    parts.push(`<rect class="band" x="${PAD}" y="${band.top}" width="${width - PAD * 2}" height="${band.height}" rx="10"/>`)
    parts.push(
      m.labelW
        ? `<text class="band-t" x="${PAD + 12}" y="${band.top + band.height / 2 + 4}" font-size="12" font-weight="600">${esc(fit(band.name, m.labelW - 18, 12))}</text>`
        : `<text class="band-t" x="${PAD + 10}" y="${band.top + 16}" font-size="11.5" font-weight="600">${esc(fit(band.name, width - PAD * 2 - 20, 11.5))}</text>`,
    )
  }

  const draw = (e           , cls        , head        , w        , extra = '') => {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    const p = at.get(e)
    if (!a || !b || !p) return
    parts.push(`<path d="${route(a, b, p.a, p.b, L)}" fill="none" class="${cls}" stroke-width="${w}" stroke-linecap="round" marker-end="url(#${head})"${extra}/>`)
  }
  // Quiet lines first, then the ones to look at, so the latter sit on top.
  const hot = (e           ) => selected !== null && (e.from === selected || e.to === selected)
  // With nothing selected the lines are a quiet texture; a selection brings its own forward.
  for (const e of graph.edges) if (!cutting.has(edgeKey(e)) && !hot(e)) draw(e, 'edge', 'a', 1.2, selected ? ' opacity="0.25"' : ' opacity="0.5"')
  for (const e of graph.edges) if (!cutting.has(edgeKey(e)) && hot(e)) draw(e, 'focus', 'af', 2.2)
  for (const e of graph.edges) if (cutting.has(edgeKey(e))) draw(e, 'rm', 'ar', 1.7, ' stroke-dasharray="5 4"')
  for (const e of adding) draw(e, 'add', 'ag', 1.7, ' stroke-dasharray="5 4"')

  for (const { node, x, y, isGhost } of placed.values()) {
    const isSel = node.id === selected
    const isNear = near.has(node.id)
    const isRemoving = removing.has(node.id)
    const ring = isGhost ? ' add' : isRemoving ? ' rm' : isSel ? ' focus' : isNear ? ' near' : ''
    const dim = selected !== null && !isSel && !isNear && !isGhost
    const dash = isGhost || isRemoving ? ' stroke-dasharray="5 4"' : ''
    const label = (isGhost ? '+ ' : '') + node.name
    const cx = x + m.nodeW / 2
    parts.push(
      `<g opacity="${dim ? 0.55 : 1}"><title>${esc(node.name)}${node.summary ? '：' + esc(node.summary) : ''}</title>`,
      `<rect class="node${ring}" x="${x}" y="${y}" width="${m.nodeW}" height="${NODE_H}" rx="9" stroke-width="${isSel ? 2.5 : 1.3}"${dash}/>`,
      `<text class="${isGhost ? 'add-t' : 'node-t'}" x="${cx}" y="${y + (node.kind ? 18 : 26)}" text-anchor="middle" font-weight="600"${isRemoving ? ' text-decoration="line-through"' : ''}>${esc(fit(label, m.nodeW - 16))}</text>`,
      node.kind ? `<text class="kind" x="${cx}" y="${y + 33}" text-anchor="middle" font-size="11">${esc(fit(node.kind, m.nodeW - 16, 11))}</text>` : '',
    )
    const count = notes.get(node.id)
    if (count) {
      parts.push(
        `<circle class="note" cx="${x + m.nodeW - 4}" cy="${y + 4}" r="8"/>`,
        `<text class="note-t" x="${x + m.nodeW - 4}" y="${y + 8}" text-anchor="middle" font-size="10" font-weight="700">${count}</text>`,
      )
    }
    parts.push('</g>')
  }

  if (hasLegend) {
    const y = L.height + 4
    let x = PAD + 2
    let row = 0
    const item = (shape                                  , text        ) => {
      const w = 20 + textWidth(text, 11.5) + 16
      if (x + w > width - PAD && x > PAD + 2) {
        row++
        x = PAD + 2
      }
      const yy = y + row * 20
      parts.push(shape(x, yy), `<text class="legend-t" x="${x + 20}" y="${yy + 12}" font-size="11.5">${text}</text>`)
      x += w
    }
    item((x, y) => `<rect class="node add" x="${x}" y="${y + 3}" width="14" height="11" rx="3" stroke-width="1.4" stroke-dasharray="3 2"/>`, '待新增')
    item((x, y) => `<rect class="node rm" x="${x}" y="${y + 3}" width="14" height="11" rx="3" stroke-width="1.4" stroke-dasharray="3 2"/>`, '待删除')
    item((x, y) => `<line class="add" x1="${x}" y1="${y + 9}" x2="${x + 14}" y2="${y + 9}" stroke-width="1.7" stroke-dasharray="4 3"/>`, '待新增连线')
    item((x, y) => `<line class="rm" x1="${x}" y1="${y + 9}" x2="${x + 14}" y2="${y + 9}" stroke-width="1.7" stroke-dasharray="4 3"/>`, '待去掉连线')
    item((x, y) => `<circle class="note" cx="${x + 7}" cy="${y + 9}" r="6"/>`, '有意见')
    if (row) {
      const grow = row * 20
      parts[0] = parts[0].replace(`height="${height}" viewBox="0 0 ${width} ${height}"`, `height="${height + grow}" viewBox="0 0 ${width} ${height + grow}"`)
    }
  }

  parts.push('</svg>')
  return parts.join('')
}

// The drawing with the size it was laid out at: the pane's Svg needs both,
// or its frame falls back to a small default box and shrinks the drawing.
export function overview(
  graph       ,
  selected               ,
  tasks                  = [],
  maxWidth = 760,
)                                                    {
  const source = toSvg(graph, selected, tasks, maxWidth)
  const m = /^<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(source)
  return { source, width: m ? Math.ceil(Number(m[1])) : maxWidth, height: m ? Math.ceil(Number(m[2])) : 400 }
}
