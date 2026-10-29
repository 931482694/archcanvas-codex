// Generated from archcanvas/hooks/patch.ts; edit source, then rebuild.
// A small change to the map: modules added, changed or removed, lines added,
// changed or removed, a main line rewritten; the rest of the map stays as it is, so
// Claude says only what changed instead of writing the whole map again. What
// the person decided on the canvas holds: a module they placed in a group, the
// files they assigned, data they sealed, a line's kind they set or their word
// that a line is there. Pure.

                                                                                                  
import { check } from './graph.mjs'
import { isEdgeKind, KIND_WORD } from './edges.mjs'
import { isSensitive, isType, typeOf } from './nodetypes.mjs'

                          
                                             
                                  
                                                                                                                                        
                         
                                                                                                    
                                                                                                                      
                                                                                                                              
                                               
                
 

const list =    (v         )      => (Array.isArray(v) ? (v       ) : [])
const str = (v         ) => (typeof v === 'string' ? v.trim() : '')
const norm = (f        ) => f.replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * The map with the patch laid on it, checked whole; `said` lists what changed
 * in a few words each, `refused` what was left out and why. `stillThere`
 * says whether a project file exists: a module is removed only when the
 * files it lists are gone. `at`: now, for Claude's word on a line.
 */
export function applyPatch(graph       , raw         , stillThere                           , at = 0)                                                                                             {
  const p = (raw && typeof raw === 'object' ? raw : {})                           
  const said           = []
  const refused           = []
  const touched = new Set        ()
  let layers               = [...graph.layers]
  let nodes              = graph.nodes.map(n => ({ ...n }))
  let edges              = [...graph.edges]
  let flows         = [...(graph.flows ?? [])]
  const nameOf = (id        ) => nodes.find(n => n.id === id)?.name ?? id

  for (const l of list                                  (p.add_layers)) {
    const id = str(l.id)
    const name = str(l.name)
    if (!id || !name) refused.push('新分组要有 id 和 name。')
    else if (layers.some(x => x.id === id)) refused.push(`分组 ${id} 已经有了。`)
    else {
      layers = [...layers, { id, name }]
      said.push(`新增分组「${name}」`)
    }
  }

  for (const n of list                         (p.add_nodes)) {
    const id = str(n.id)
    const name = str(n.name)
    const layer = str(n.layer)
    if (!id || !name) {
      refused.push('新模块要有 id 和 name。')
      continue
    }
    if (nodes.some(x => x.id === id)) {
      refused.push(`模块 ${id} 已经有了，要改它请用 change_nodes。`)
      continue
    }
    if (!layers.some(l => l.id === layer)) {
      refused.push(`「${name}」的分组 ${layer || '（没写）'} 不存在。`)
      continue
    }
    const type = isType(n.type) ? n.type : undefined
    const node            = {
      id,
      name,
      layer,
      summary: str(n.summary),
      files: list        (n.files).filter(f => typeof f === 'string').map(norm),
      ...(type ? { type } : {}),
      ...(str(n.kind) ? { kind: str(n.kind) } : {}),
      ...(str(n.details) ? { details: str(n.details) } : {}),
      ...(Array.isArray(n.sources) ? { sources: n.sources                } : {}),
    }
    // New data is sensitive until the person says otherwise.
    if (n.sensitive === false && typeOf(node) === 'data') refused.push(`「${name}」先按敏感数据处理：只有用户能在画布上改成不敏感。`)
    nodes = [...nodes, node]
    touched.add(id)
    said.push(`新增模块「${name}」`)
  }

  for (const c of list                         (p.change_nodes)) {
    const id = str(c.id)
    const at = nodes.findIndex(x => x.id === id)
    if (at < 0) {
      refused.push(`找不到模块 ${id || '（没写 id）'}。`)
      continue
    }
    const was = nodes[at]
    const next            = { ...was }
    const bits           = []
    for (const key of ['name', 'summary', 'details', 'kind']         ) {
      if (typeof c[key] === 'string' && str(c[key]) !== (was[key] ?? '')) {
        ;(next                           )[key] = str(c[key])
        bits.push(key === 'name' ? `改名为「${str(c.name)}」` : key === 'summary' ? '改了职责' : key === 'details' ? '改了细节' : '改了标签')
      }
    }
    if (c.layer !== undefined && str(c.layer) !== was.layer) {
      if (was.pins?.includes('layer')) refused.push(`「${was.name}」所在的分组是用户在画布上定的，没有改。`)
      else if (!layers.some(l => l.id === str(c.layer))) refused.push(`分组 ${str(c.layer)} 不存在，「${was.name}」没有换组。`)
      else {
        next.layer = str(c.layer)
        bits.push(`换到「${layers.find(l => l.id === next.layer) .name}」`)
      }
    }
    if (c.type !== undefined && c.type !== typeOf(was)) {
      if (isSensitive(was)) refused.push(`「${was.name}」是敏感数据，类型不能改。`)
      else if (isType(c.type)) {
        next.type = c.type
        bits.push('改了类型')
      }
    }
    const files = list        (c.files).filter(f => typeof f === 'string').map(norm)
    const add = list        (c.add_files).filter(f => typeof f === 'string').map(norm)
    const drop = new Set(list        (c.remove_files).filter(f => typeof f === 'string').map(norm))
    const pinned = was.pins?.includes('files')
    if ((Array.isArray(c.files) || drop.size) && pinned) refused.push(`「${was.name}」的文件是用户在画布上归的，只能加，不能去掉或整组替换。`)
    else {
      if (Array.isArray(c.files)) next.files = files
      if (drop.size) next.files = next.files.filter(f => !drop.has(f))
    }
    if (add.length) next.files = [...new Set([...next.files, ...add])]
    if (next.files.join('\n') !== was.files.join('\n')) bits.push(`文件改为 ${next.files.length} 个`)
    if (Array.isArray(c.sources)) {
      next.sources = c.sources               
      bits.push('更新了代码依据')
    }
    if (!bits.length) continue
    nodes = nodes.map((x, i) => (i === at ? next : x))
    touched.add(id)
    said.push(`「${was.name}」${bits.join('，')}`)
  }

  for (const raw of list         (p.remove_nodes)) {
    const id = str(raw)
    const n = nodes.find(x => x.id === id)
    if (!n) {
      refused.push(`找不到要去掉的模块 ${id}。`)
      continue
    }
    if (isSensitive(n)) {
      refused.push(`「${n.name}」是敏感数据，只能由用户在画布上删除。`)
      continue
    }
    const left = n.files.filter(f => stillThere(f))
    if (left.length) {
      refused.push(`「${n.name}」的文件还在（${left.slice(0, 3).join('、')}），没有去掉；它确实不该再是一个模块的话，请用户在画布上删除。`)
      continue
    }
    nodes = nodes.filter(x => x.id !== id)
    edges = edges.filter(e => e.from !== id && e.to !== id)
    said.push(`去掉模块「${n.name}」（文件已删除）`)
  }

  for (const e of list                         (p.remove_edges)) {
    const from = str(e.from)
    const to = str(e.to)
    if (!edges.some(x => x.from === from && x.to === to)) {
      refused.push(`没有 ${from} → ${to} 这条线。`)
      continue
    }
    edges = edges.filter(x => !(x.from === from && x.to === to))
    touched.add(from)
    touched.add(to)
    said.push(`去掉连线「${nameOf(from)}」→「${nameOf(to)}」`)
  }

  for (const e of list                         (p.add_edges)) {
    const from = str(e.from)
    const to = str(e.to)
    if (!nodes.some(n => n.id === from) || !nodes.some(n => n.id === to) || from === to) {
      refused.push(`连线 ${from} → ${to} 的两端要是两个已有模块。`)
      continue
    }
    if (edges.some(x => (x.from === from && x.to === to) || (x.from === to && x.to === from))) {
      refused.push(`「${nameOf(from)}」和「${nameOf(to)}」之间已经有线了。`)
      continue
    }
    const edge            = {
      from,
      to,
      ...(isEdgeKind(e.kind) ? { kind: e.kind } : {}),
      ...(str(e.label) ? { label: str(e.label) } : {}),
      ...(Array.isArray(e.sources) ? { sources: e.sources                } : {}),
    }
    edges = [...edges, edge]
    touched.add(from)
    touched.add(to)
    said.push(`新增连线「${nameOf(from)}」→「${nameOf(to)}」`)
  }

  for (const c of list                         (p.change_edges)) {
    const from = str(c.from)
    const to = str(c.to)
    const i = edges.findIndex(x => x.from === from && x.to === to)
    if (i < 0) {
      refused.push(`没有 ${from} → ${to} 这条线${edges.some(x => x.from === to && x.to === from) ? '（图上是反方向的那条）' : ''}。`)
      continue
    }
    const was = edges[i]
    const next            = { ...was }
    const line = `「${nameOf(from)}」→「${nameOf(to)}」`
    const bits           = []
    if (typeof c.label === 'string' && str(c.label) !== (was.label ?? '')) {
      if (str(c.label)) next.label = str(c.label)
      else delete next.label
      bits.push('改了说明')
    }
    if (c.kind !== undefined && c.kind !== was.kind) {
      if (was.pins?.includes('kind')) refused.push(`${line}的类型是用户在画布上定的，没有改。`)
      else if (isEdgeKind(c.kind)) {
        next.kind = c.kind
        bits.push(`改成${KIND_WORD[c.kind]}`)
      }
    }
    if (Array.isArray(c.sources)) {
      next.sources = c.sources               
      bits.push('更新了代码依据')
    }
    if (c.vouch !== undefined) {
      const why = str(c.vouch)
      if (was.vouched?.by === 'person') refused.push(`${line}是用户在画布上确认存在的，没有改。`)
      else if (why) {
        // Said again after the code changed: the word is as of now.
        next.vouched = { why: why.slice(0, 80), by: 'claude', at }
        bits.push(why.slice(0, 80) === was.vouched?.why ? '重新确认了「已核实」' : `标为代码核对看不出、但确实存在（${why.slice(0, 80)}）`)
      } else if (was.vouched) {
        delete next.vouched
        bits.push('去掉了「已核实」')
      }
    }
    if (!bits.length) continue
    edges = edges.map((x, j) => (j === i ? next : x))
    touched.add(from)
    touched.add(to)
    said.push(`连线${line}${bits.join('，')}`)
  }

  for (const f of list                         (p.flows)) {
    const id = str(f.id)
    if (!id) {
      refused.push('主线要写 id（改已有的就用它的 id）。')
      continue
    }
    const had = flows.find(x => x.id === id)
    const steps = list         (f.steps)
    const flow = { id, name: str(f.name) || had?.name || id, steps }        
    flows = had ? flows.map(x => (x.id === id ? flow : x)) : [...flows, flow]
    said.push(`${had ? '改了' : '新增'}主线「${flow.name}」（${steps.length} 步）`)
  }

  const checked = check({ ...graph, layers, nodes, edges, flows })
  if ('error' in checked) return { error: checked.error }
  return { graph: checked.graph, said, refused: [...refused, ...checked.warnings], touched: [...touched].filter(id => checked.graph.nodes.some(n => n.id === id)) }
}

/** A patch says something at all. */
export const isEmptyPatch = (raw         )          =>
  !raw || typeof raw !== 'object' || !['add_layers', 'add_nodes', 'change_nodes', 'remove_nodes', 'add_edges', 'change_edges', 'remove_edges', 'flows'].some(k => list((raw                           )[k]).length)

/** Whose evidence a patch cites anew (`n:id` for a module, `e:from>to` for a line): their spots are as the code reads now. */
export function patchCites(raw         )              {
  const p = (raw && typeof raw === 'object' ? raw : {})                           
  const out = new Set        ()
  for (const n of [...list                         (p.add_nodes), ...list                         (p.change_nodes)]) if (Array.isArray(n.sources)) out.add(`n:${str(n.id)}`)
  for (const e of [...list                         (p.add_edges), ...list                         (p.change_edges)]) if (Array.isArray(e.sources)) out.add(`e:${str(e.from)}>${str(e.to)}`)
  return out
}
