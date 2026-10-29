// Generated from archcanvas/hooks/layers.ts; edit source, then rebuild.
// Layers as the canvas changes them: made, renamed, emptied out and removed,
// and modules moved between them. Like which module a file belongs to, this
// is the map's own grouping, changed at once; no code moves. Pure.

import { pin } from './merge.mjs'
                                           
import { check } from './graph.mjs'
import { isOpen } from './tasks.mjs'

                                                   

const checked = (g       )          => {
  const r = check(g)
  return 'error' in r ? r : { graph: r.graph }
}

// A stable id for a new layer: its ascii words if it has any, else a counter.
export function newLayerId(name        , graph       )         {
  const taken = new Set(graph.layers.map(l => l.id))
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const stem = ascii && /^[a-z0-9]/.test(ascii) ? ascii : 'layer'
  let id = stem === 'layer' ? 'layer-1' : stem
  for (let n = 1; taken.has(id); n++) id = `${stem}-${n + 1}`
  return id
}

export function addLayer(graph       , raw        )                                                   {
  const name = raw.trim()
  if (!name) return { error: '新分组要有名字。' }
  if (graph.layers.some(l => l.name === name)) return { error: `已经有叫「${name}」的分组了。` }
  const id = newLayerId(name, graph)
  // Made by the person: it stays when Claude draws the map again.
  const out = checked({ ...graph, layers: [...graph.layers, { id, name, pins: ['name', 'keep'] }] })
  return 'error' in out ? out : { graph: out.graph, id }
}

export function renameLayer(graph       , id        , raw        )          {
  const name = raw.trim()
  const layer = graph.layers.find(l => l.id === id)
  if (!layer) return { error: '找不到这个分组。' }
  if (!name) return { error: '分组要有名字。' }
  if (graph.layers.some(l => l.id !== id && l.name === name)) return { error: `已经有叫「${name}」的分组了。` }
  return checked({ ...graph, layers: graph.layers.map(l => (l.id === id ? { ...l, name, pins: pin(l.pins, 'name') } : l)) })
}

// Only an empty layer goes: no modules, and none proposed for it.
export function removeLayer(graph       , id        , tasks                 )          {
  const layer = graph.layers.find(l => l.id === id)
  if (!layer) return { error: '找不到这个分组。' }
  if (graph.layers.length === 1) return { error: '架构图至少要留一个分组。' }
  const held = graph.nodes.filter(n => n.layer === id).length
  if (held) return { error: `「${layer.name}」里还有 ${held} 个模块，先把它们移到别的分组。` }
  if (tasks.some(t => isOpen(t) && t.kind === 'add-node' && t.node?.layer === id)) return { error: `「${layer.name}」里还有待新增的模块。` }
  return checked({ ...graph, layers: graph.layers.filter(l => l.id !== id) })
}

export function moveNode(graph       , nodeId        , layerId        )          {
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) return { error: '找不到这个模块。' }
  if (!graph.layers.some(l => l.id === layerId)) return { error: '找不到这个分组。' }
  if (node.layer === layerId) return { graph }
  return checked({ ...graph, nodes: graph.nodes.map(n => (n.id === nodeId ? { ...n, layer: layerId, pins: pin(n.pins, 'layer') } : n)) })
}
