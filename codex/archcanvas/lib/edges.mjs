// Generated from archcanvas/hooks/edges.ts; edit source, then rebuild.
// What a line between two modules means, from what the two ends are.
// Resources (data, documents, outside services) are read and made; steps
// (code, notebooks, skills, tests) do the reading, making and calling.
//
// A saved edge runs from the step to the resource for both reading and
// making, with `kind` saying which; between steps it runs from caller to
// callee. A line drawn on the canvas runs the way the data flows, and is
// saved in that form.

                                                                    
import { typeOf } from './nodetypes.mjs'

export const EDGE_KINDS                      = ['call', 'read', 'write', 'link']
export const isEdgeKind = (v         )                => typeof v === 'string' && (EDGE_KINDS                     ).includes(v)
export const isResource = (t          ) => t === 'data' || t === 'doc' || t === 'external'

export const KIND_WORD                           = { call: '调用', read: '读取', write: '生成', link: '关联' }

// A line drawn from one to the other: the data flows the way it is drawn.
export function drawnKind(from          , to          )           {
  const a = isResource(from)
  const b = isResource(to)
  return a && b ? 'link' : a ? 'read' : b ? 'write' : 'call'
}

// A saved edge's kind: its own, else what its ends suggest (a step depends on
// what it reads; a resource depends on the step that makes it).
export function kindOf(e           , from          , to          )           {
  if (e.kind) return e.kind
  const a = isResource(from)
  const b = isResource(to)
  return a && b ? 'link' : b ? 'read' : a ? 'write' : 'call'
}

// Which kinds make sense between two ends.
export function kindsBetween(a          , b          )             {
  const ra = isResource(a)
  const rb = isResource(b)
  return ra !== rb ? ['read', 'write'] : ra ? ['link'] : ['call']
}

                                         

// A line drawn from one to the other, as it is saved: reading and making run
// from the step to the resource.
export function wire(from     , to     )            {
  const kind = drawnKind(from.type, to.type)
  if (kind === 'read') return { from: to.id, to: from.id, kind }
  return kind === 'call' ? { from: from.id, to: to.id } : { from: from.id, to: to.id, kind }
}

export function endOf(graph       , id        )      {
  const n = graph.nodes.find(x => x.id === id)
  return { id, type: n ? typeOf(n) : 'code' }
}

// The edge said in words, the step first: 「清洗」读取「原始数据」.
export function edgeWords(graph       , e           )                                   {
  const a = endOf(graph, e.from)
  const b = endOf(graph, e.to)
  const kind = kindOf(e, a.type, b.type)
  const name = (id        ) => `「${graph.nodes.find(n => n.id === id)?.name ?? id}」`
  if (kind === 'read' || kind === 'write') {
    const [step, res] = isResource(a.type) ? [b.id, a.id] : [a.id, b.id]
    return { kind, text: `${name(step)}${KIND_WORD[kind]}${name(res)}` }
  }
  return { kind, text: kind === 'link' ? `${name(a.id)}和${name(b.id)}关联` : `${name(a.id)}调用${name(b.id)}` }
}
