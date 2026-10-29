// Generated from archcanvas/hooks/graph.ts; edit source, then rebuild.
// The architecture graph: its shape and the checks a saved graph must pass.
// Pure, so the tests can drive it directly. The drawing is in ./draw.

                                                                                                                             
import { isEdgeKind, isResource } from './edges.mjs'
import { inferType, isType } from './nodetypes.mjs'

export const GRAPH_PATH = '.archcanvas/graph.json'

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

                                                                              

// Accepts what the model or the file hands over, and returns a graph whose ids
// are unique and whose references all land, or the first thing wrong with it.
export function check(raw         )          {
  if (!raw || typeof raw !== 'object') return { error: '架构图必须是一个对象。' }
  const r = raw                           
  const warnings           = []

  if (!Array.isArray(r.layers) || !r.layers.length) return { error: 'layers 至少要有一层。' }
  if (!Array.isArray(r.nodes) || !r.nodes.length) return { error: 'nodes 至少要有一个模块。' }
  const edgesIn = r.edges === undefined ? [] : r.edges
  if (!Array.isArray(edgesIn)) return { error: 'edges 必须是数组。' }

  const layers                  = []
  const layerIds = new Set        ()
  for (const [i, l] of r.layers.entries()) {
    const o = (l ?? {})                           
    if (typeof o.id !== 'string' || !ID.test(o.id)) return { error: `layers[${i}].id 要用小写字母、数字和连字符。` }
    if (layerIds.has(o.id)) return { error: `层 id 重复：${o.id}` }
    if (typeof o.name !== 'string' || !o.name.trim()) return { error: `层 ${o.id} 缺少 name。` }
    layerIds.add(o.id)
    const pins = pinsOf          (o.pins, ['name', 'keep'])
    layers.push({ id: o.id, name: o.name.trim(), description: str(o.description), ...(pins ? { pins } : {}) })
  }

  const nodes              = []
  const nodeIds = new Set        ()
  for (const [i, n] of r.nodes.entries()) {
    const o = (n ?? {})                           
    if (typeof o.id !== 'string' || !ID.test(o.id)) return { error: `nodes[${i}].id 要用小写字母、数字和连字符。` }
    if (nodeIds.has(o.id)) return { error: `模块 id 重复：${o.id}` }
    if (typeof o.name !== 'string' || !o.name.trim()) return { error: `模块 ${o.id} 缺少 name。` }
    if (typeof o.layer !== 'string' || !layerIds.has(o.layer)) return { error: `模块 ${o.id} 的 layer「${String(o.layer)}」不在 layers 里。` }
    const files = Array.isArray(o.files) ? o.files.filter((f)              => typeof f === 'string' && !!f.trim()) : []
    for (const f of files) {
      if (/^([A-Za-z]:)?[\\/]/.test(f) || f.split(/[\\/]/).includes('..')) {
        return { error: `模块 ${o.id} 的文件路径要相对于项目根目录：${f}` }
      }
    }
    nodeIds.add(o.id)
    const clean = files.map(f => f.replace(/\\/g, '/'))
    if (o.type !== undefined && !isType(o.type)) warnings.push(`模块 ${o.id} 的 type「${String(o.type)}」不认识，已按文件推断。`)
    const type = isType(o.type) ? o.type : inferType({ files: clean, kind: str(o.kind) })
    const sources = sourcesOf(o.sources, `模块 ${o.id}`, warnings)
    nodes.push({
      id: o.id,
      name: o.name.trim(),
      layer: o.layer,
      type,
      kind: str(o.kind),
      summary: str(o.summary) ?? '',
      details: str(o.details),
      files: clean,
      // Data stays sensitive unless said otherwise; nothing else carries the flag.
      ...(type === 'data' && o.sensitive === false ? { sensitive: false } : {}),
      ...(sources ? { sources } : {}),
      ...(stamp(o.seenAt) ? { seenAt: stamp(o.seenAt) } : {}),
      ...(pinsOf         (o.pins, ['layer', 'files', 'sensitive']) ? { pins: pinsOf         (o.pins, ['layer', 'files', 'sensitive']) } : {}),
    })
    if (!str(o.summary)) warnings.push(`模块 ${o.id} 没有 summary（职责说明）。`)
  }

  const edges              = []
  const seen = new Set        ()
  for (const [i, ed] of edgesIn.entries()) {
    const o = (ed ?? {})                           
    if (typeof o.from !== 'string' || !nodeIds.has(o.from)) return { error: `edges[${i}].from「${String(o.from)}」不是已有模块。` }
    if (typeof o.to !== 'string' || !nodeIds.has(o.to)) return { error: `edges[${i}].to「${String(o.to)}」不是已有模块。` }
    if (o.from === o.to) return { error: `edges[${i}] 不能指向自己。` }
    const key = `${o.from}>${o.to}`
    if (seen.has(key)) {
      warnings.push(`重复的连线 ${o.from} → ${o.to} 已合并。`)
      continue
    }
    seen.add(key)
    let kind = isEdgeKind(o.kind) ? o.kind : undefined
    if (o.kind !== undefined && !kind) warnings.push(`edges[${i}] 的 kind「${String(o.kind)}」不认识，已按两端推断。`)
    // Reading and making are between a step and a resource.
    const ends = [o.from, o.to].map(id => isResource(nodes.find(n => n.id === id) .type ))
    if ((kind === 'read' || kind === 'write') && ends[0] === ends[1]) {
      warnings.push(`edges[${i}] 的 kind ${kind} 要连在模块和资料（数据、文档、外部服务）之间，已按两端推断。`)
      kind = undefined
    }
    const sources = sourcesOf(o.sources, `连线 ${o.from} → ${o.to}`, warnings)
    const pins = pinsOf         (o.pins, ['kind'])
    const vouched = vouchOf(o.vouched)
    edges.push({ from: o.from, to: o.to, label: str(o.label), ...(kind ? { kind } : {}), ...(sources ? { sources } : {}), ...(vouched ? { vouched } : {}), ...(pins ? { pins } : {}) })
  }

  for (const layer of layers) {
    if (!nodes.some(n => n.layer === layer.id)) warnings.push(`分组「${layer.name}」里没有模块。`)
  }

  const drawnAt = stamp(r.drawnAt)
  const revision = typeof r.revision === 'string' && /^[0-9a-f]{40}$/.test(r.revision) ? r.revision : undefined
  const dirty = revision && Array.isArray(r.dirty) ? r.dirty.filter((p)              => typeof p === 'string' && !!p && !p.split('/').includes('..')) : []
  const flows = flowsOf(r.flows, nodeIds, warnings)
  return {
    graph: {
      version: 1,
      title: str(r.title) ?? '项目架构',
      ...(drawnAt ? { drawnAt } : {}),
      ...(revision ? { revision } : {}),
      ...(dirty.length ? { dirty } : {}),
      layers,
      nodes,
      edges,
      ...(flows ? { flows } : {}),
    },
    warnings,
  }
}

/**
 * The map's table of contents, for Claude to name modules by: groups, each
 * module's id, name, type and files, and the main lines' steps by id. No
 * summaries, lines or evidence.
 */
export function mapIndex(graph       )         {
  const out = [`架构图「${graph.title}」：${describe(graph)}`]
  for (const l of graph.layers) {
    out.push(`分组 ${l.id}「${l.name}」`)
    for (const n of graph.nodes.filter(x => x.layer === l.id)) out.push(`  ${n.id}「${n.name}」${n.type ?? ''}：${n.files.join('、') || '（无文件）'}`)
  }
  for (const f of graph.flows ?? []) out.push(`主线 ${f.id}「${f.name}」：${f.steps.map(s => s.node).join(' → ')}`)
  return out.join('\n')
}

/** At most this many main lines, each of at most this many steps. */
export const MAX_FLOWS = 5
export const MAX_STEPS = 40
/** A line longer than this no longer reads at a glance: Claude is asked to shorten it. */
export const LONG_FLOW = 15

// The main lines: each named, its steps on modules the map has. A step on a
// module that is not there is dropped and said; a line left with fewer than
// two steps is no line. Steps one after another on the same module are one
// step; a line still long is kept, and said.
function flowsOf(raw         , nodeIds             , warnings          )                     {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    warnings.push('flows 要是数组，已忽略。')
    return undefined
  }
  const out         = []
  const ids = new Set        ()
  for (const [i, f] of raw.entries()) {
    const o = (f ?? {})                           
    const name = str(o.name)
    if (!name) {
      warnings.push(`flows[${i}] 缺少 name，已去掉。`)
      continue
    }
    const steps             = []
    const merged = new Set        ()
    for (const s of Array.isArray(o.steps) ? o.steps : []) {
      const step = (typeof s === 'string' ? { node: s } : (s ?? {}))                           
      if (typeof step.node !== 'string' || !nodeIds.has(step.node)) {
        warnings.push(`主线「${name}」里的「${String(step.node)}」不是已有模块，这一步已去掉。`)
        continue
      }
      const label = str(step.label)
      const last = steps[steps.length - 1]
      if (last?.node === step.node) {
        const both = [last.label, label].filter(Boolean).join('；')
        steps[steps.length - 1] = { node: last.node, ...(both ? { label: both } : {}) }
        merged.add(step.node)
        continue
      }
      steps.push({ node: step.node, ...(label ? { label } : {}) })
    }
    if (steps.length < 2) {
      warnings.push(`主线「${name}」少于两步，已去掉。`)
      continue
    }
    if (merged.size) warnings.push(`主线「${name}」里连着落在 ${[...merged].map(id => `「${id}」`).join('、')} 上的几步已合成一步。`)
    if (steps.length > LONG_FLOW) {
      warnings.push(
        `主线「${name}」有 ${Math.min(steps.length, MAX_STEPS)} 步，一眼看不完：请精简到 ${LONG_FLOW} 步以内再保存（调度模块只在开头列一次，公共模块不列，只留主要环节）。`,
      )
    }
    let id = typeof o.id === 'string' && ID.test(o.id) && !ids.has(o.id) ? o.id : `flow-${out.length + 1}`
    while (ids.has(id)) id = `${id}-x`
    ids.add(id)
    out.push({ id, name, steps: steps.slice(0, MAX_STEPS) })
    if (out.length === MAX_FLOWS) break
  }
  return out.length ? out : undefined
}

// Where in the code a module or a line is seen: up to five spots, each a
// project-relative file with optional lines. Malformed ones are dropped and said.
function sourcesOf(raw         , where        , warnings          )                          {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    warnings.push(`${where} 的 sources 要是数组，已忽略。`)
    return undefined
  }
  const out              = []
  for (const s of raw) {
    const o = (s ?? {})                           
    const p = typeof o.path === 'string' ? o.path.trim().replace(/\\/g, '/').replace(/^\.\//, '') : ''
    if (!p || /^([A-Za-z]:)?\//.test(p) || p.split('/').includes('..')) {
      warnings.push(`${where} 的依据路径要相对于项目根目录，已去掉：${String(o.path)}`)
      continue
    }
    const line = Number.isInteger(o.line) && (o.line          ) >= 1 ? (o.line          ) : undefined
    const end = line && Number.isInteger(o.end_line) && (o.end_line          ) > line ? (o.end_line          ) : undefined
    out.push({ path: p, ...(line ? { line } : {}), ...(end ? { end_line: end } : {}) })
    if (out.length === 5) break
  }
  return out.length ? out : undefined
}

/** Whether a map says where anything is in the code at all (older maps do not). */
export const hasEvidence = (graph       )          => graph.edges.some(e => e.sources?.length) || graph.nodes.some(n => n.sources?.length)

/** Where a spot in the code is, in words: pipeline/clean.py 第 12–30 行. */
export const sourceText = (s           )         => (s.line ? `${s.path} 第 ${s.line}${s.end_line ? `–${s.end_line}` : ''} 行` : s.path)

// What the person pinned on the canvas: known fields only, each once.
function pinsOf                  (raw         , allowed              )                  {
  if (!Array.isArray(raw)) return undefined
  const out = [...new Set(raw.filter((p)         => (allowed                      ).includes(p)))]
  return out.length ? out : undefined
}

/** Who said a line is there though the code does not show it, and why; a few words kept. */
export function vouchOf(raw         )                        {
  const o = raw && typeof raw === 'object' ? (raw                           ) : null
  const why = str(o?.why)
  if (!o || !why || (o.by !== 'person' && o.by !== 'claude')) return undefined
  const where = o.where === undefined ? undefined : sourcesOf([o.where], '已核实的依据', [])?.[0]
  return { why: why.slice(0, 80), by: o.by, at: stamp(o.at) ?? 0, ...(where ? { where } : {}) }
}

// A moment, as milliseconds since 1970: a positive finite number.
const stamp = (v         )                     => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined)

function str(v         )                     {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function dependsOn(graph       , id        )              {
  return graph.edges.filter(e => e.from === id)
}

export function usedBy(graph       , id        )              {
  return graph.edges.filter(e => e.to === id)
}

export function nodeById(graph       , id               )                        {
  return id === null ? undefined : graph.nodes.find(n => n.id === id)
}

export function describe(graph       )         {
  const flows = graph.flows?.length ? `、${graph.flows.length} 条主线` : ''
  return `${graph.layers.length} 个分组、${graph.nodes.length} 个模块、${graph.edges.length} 条连线${flows}`
}

export { layout, toSvg } from './draw.mjs'
