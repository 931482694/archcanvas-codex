// Generated from archcanvas/hooks/merge.ts; edit source, then rebuild.
// When Claude draws the map again: what the person changed on the canvas is
// carried over, and what changed between the two maps is said in words, so a
// change to the structure waits for the person's yes. Pure.

                                                                                  
import { kindsBetween } from './edges.mjs'
import { typeOf } from './nodetypes.mjs'

/** A field the person changed on the canvas, added to what is already pinned. */
export function pin                  (pins                          , field   )      {
  return [...new Set([...(pins ?? []), field])]
}

/** Claude's new map with the person's own changes on the canvas laid back over it. */
export function carryOver(prev       , next       )        {
  const layers = next.layers.map(l => {
    const old = prev.layers.find(x => x.id === l.id)
    if (!old?.pins?.length) return l
    return { ...l, ...(old.pins.includes('name') ? { name: old.name } : {}), pins: [...old.pins]               }
  })
  // A group the person made stays, even if Claude's map has no use for it.
  for (const old of prev.layers) if (old.pins?.includes('keep') && !layers.some(l => l.id === old.id)) layers.push({ ...old })
  const layerIds = new Set(layers.map(l => l.id))

  const nodes = next.nodes.map(n => {
    const old = prev.nodes.find(x => x.id === n.id)
    // A look the person took after Claude drew this map still counts.
    const seen = old?.seenAt && old.seenAt > (next.drawnAt ?? 0) ? { seenAt: old.seenAt } : {}
    if (!old?.pins?.length) return { ...n, ...seen }
    const out = { ...n, ...seen, pins: [...old.pins]              }
    if (old.pins.includes('layer') && layerIds.has(old.layer)) out.layer = old.layer
    if (old.pins.includes('files')) out.files = [...old.files]
    if (old.pins.includes('sensitive') && typeOf(old) === 'data' && typeOf(out) === 'data') {
      if (old.sensitive === false) out.sensitive = false
      else delete out.sensitive
    }
    return out
  })

  const edges = next.edges.map(e => {
    const old = prev.edges.find(x => x.from === e.from && x.to === e.to)
    // Someone's word that a line is there holds until it is taken back.
    const vouch = old?.vouched ? { vouched: old.vouched } : {}
    if (!old?.pins?.length) return { ...e, ...vouch }
    const out = { ...e, ...vouch, pins: [...old.pins]              }
    const a = nodes.find(n => n.id === e.from)
    const b = nodes.find(n => n.id === e.to)
    if (old.pins.includes('kind') && old.kind && a && b && kindsBetween(typeOf(a), typeOf(b)).includes(old.kind)) out.kind = old.kind
    return out
  })
  // A map drawn again without main lines keeps the old ones (steps on modules
  // gone fall away when the map is checked); new ones replace them.
  const flows = next.flows ?? prev.flows
  return { ...next, layers, nodes, edges, ...(flows ? { flows } : {}) }
}

/** A save that changed only words (what modules and lines say, their evidence,
 *  the main lines) while a map Claude drew earlier waits for the person: the
 *  same changes laid over the waiting map, so taking it later loses none of
 *  them. `flows`: the main lines this save brought, if any. */
export function carryWords(waiting       , prev       , next       , flows         )        {
  const lay =                   (onto   , was   , now   , fields                   )    => {
    const out = { ...onto }                           
    const a = was                           
    const b = now                           
    for (const f of fields) {
      if (same(a[f], b[f])) continue
      if (b[f] === undefined) delete out[f]
      else out[f] = b[f]
    }
    return out     
  }
  const nodes = waiting.nodes.map(n => {
    const was = prev.nodes.find(x => x.id === n.id)
    const now = next.nodes.find(x => x.id === n.id)
    return was && now ? lay(n, was, now, ['name', 'kind', 'summary', 'details', 'sources']) : n
  })
  const edges = waiting.edges.map(e => {
    const was = prev.edges.find(x => x.from === e.from && x.to === e.to)
    const now = next.edges.find(x => x.from === e.from && x.to === e.to)
    return was && now ? lay(e, was, now, ['label', 'sources', 'vouched']) : e
  })
  return { ...waiting, nodes, edges, ...(flows ? { flows } : {}) }
}

const same = (a         , b         ) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** What changed from one map to the next. */
export function diffGraphs(prev       , next       )            {
  const lid = (g       ) => new Map(g.layers.map(l => [l.id, l]))
  const nid = (g       ) => new Map(g.nodes.map(n => [n.id, n]))
  const eid = (g       ) => new Map(g.edges.map(e => [`${e.from}>${e.to}`, e]))
  const [pl, nl, pn, nn, pe, ne] = [lid(prev), lid(next), nid(prev), nid(next), eid(prev), eid(next)]
  const pair = (k        ) => k.split('>')                    
  return {
    layers: {
      added: [...nl.keys()].filter(k => !pl.has(k)),
      removed: [...pl.keys()].filter(k => !nl.has(k)),
      renamed: [...nl.keys()].filter(k => pl.has(k) && pl.get(k) .name !== nl.get(k) .name),
    },
    nodes: {
      added: [...nn.keys()].filter(k => !pn.has(k)),
      removed: [...pn.keys()].filter(k => !nn.has(k)),
      moved: [...nn.keys()].filter(k => pn.has(k) && pn.get(k) .layer !== nn.get(k) .layer),
      changed: [...nn.keys()].filter(k => {
        const a = pn.get(k)
        const b = nn.get(k)
        return a && b && ['name', 'type', 'kind', 'summary', 'details', 'files', 'sources', 'sensitive'].some(f => !same(a[f                  ], b[f                  ]))
      }),
    },
    edges: {
      added: [...ne.keys()].filter(k => !pe.has(k)).map(pair),
      removed: [...pe.keys()].filter(k => !ne.has(k)).map(pair),
      retyped: [...ne.keys()].filter(k => pe.has(k) && (pe.get(k) .kind ?? null) !== (ne.get(k) .kind ?? null)).map(pair),
      reworded: [...ne.keys()]
        .filter(k => pe.has(k) && ['label', 'sources', 'vouched'].some(f => !same(pe.get(k) [f           ], ne.get(k) [f           ])))
        .map(pair),
    },
  }
}

/** Whether the structure changed: groups, modules or lines came or went, moved or changed kind. */
export function isStructural(d           )          {
  return Boolean(
    d.layers.added.length || d.layers.removed.length || d.nodes.added.length || d.nodes.removed.length || d.nodes.moved.length || d.edges.added.length || d.edges.removed.length || d.edges.retyped.length,
  )
}

/** What changed, in a few lines for the person: names, not ids. */
export function changeLines(d           , prev       , next       )           {
  const name = (g       , id        ) => g.nodes.find(n => n.id === id)?.name ?? id
  const either = (id        ) => (next.nodes.some(n => n.id === id) ? name(next, id) : name(prev, id))
  const layer = (g       , id        ) => g.layers.find(l => l.id === id)?.name ?? id
  const list = (xs          ) => `${xs.slice(0, 5).join('、')}${xs.length > 5 ? ` 等 ${xs.length} 个` : ''}`
  const line = ([a, b]                  ) => `${either(a)} → ${either(b)}`
  const out           = []
  if (d.nodes.added.length) out.push(`新增模块：${list(d.nodes.added.map(id => name(next, id)))}`)
  if (d.nodes.removed.length) out.push(`去掉模块：${list(d.nodes.removed.map(id => name(prev, id)))}`)
  if (d.nodes.moved.length) out.push(`换了分组：${list(d.nodes.moved.map(id => `${name(next, id)}（${layer(prev, prev.nodes.find(n => n.id === id) .layer)} → ${layer(next, next.nodes.find(n => n.id === id) .layer)}）`))}`)
  if (d.edges.added.length) out.push(`新增连线：${list(d.edges.added.map(line))}`)
  if (d.edges.removed.length) out.push(`去掉连线：${list(d.edges.removed.map(line))}`)
  if (d.edges.retyped.length) out.push(`连线类型变了：${list(d.edges.retyped.map(line))}`)
  if (d.layers.added.length) out.push(`新增分组：${list(d.layers.added.map(id => layer(next, id)))}`)
  if (d.layers.removed.length) out.push(`去掉分组：${list(d.layers.removed.map(id => layer(prev, id)))}`)
  if (d.layers.renamed.length) out.push(`分组改名：${list(d.layers.renamed.map(id => `${layer(prev, id)} → ${layer(next, id)}`))}`)
  if (d.nodes.changed.length) out.push(`说明或文件改了：${list(d.nodes.changed.map(id => name(next, id)))}`)
  if (d.edges.reworded.length) out.push(`连线的说明或依据改了：${d.edges.reworded.length} 条`)
  return out
}
