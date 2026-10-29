// Generated from archcanvas/hooks/relocate.ts; edit source, then rebuild.
// Where a cited spot is now. A spot on the map says file and lines as they
// were when it was cited; code written above it since moves it down or up.
// The lines it cited are kept (a few, trimmed) as its anchor, and found again
// in the file as it is now: the nearest place they stand, whole. Pure.

                                                                      

export const ANCHORS_PATH = '.archcanvas/anchors.json'

/** The lines each cited spot cited, by spot key. */
                                              

/** A spot cited in one place and now in another. */
                                                                                                                   

// At most this many lines of a spot are kept; a line kept to this length.
const KEEP_LINES = 3
const KEEP_CHARS = 160
// A single line too short or too common to find a spot by alone.
const WEAK = /^[\s{}()[\];,]*$|^(return|else|end|pass|break|continue|try|finally|\}\s*else\s*\{)[\s;:{]*$/

export const spotKey = (s           ) => `${s.path}\n${s.line ?? 0}\n${s.end_line ?? ''}`

const linesOf = (text        ) => text.split(/\r?\n/)
const norm = (l        ) => l.trim().slice(0, KEEP_CHARS)

/** What a spot cites in `text`: its first few lines, trimmed; none past the end. */
export function anchorAt(text        , s           )                       {
  if (!s.line) return undefined
  const lines = linesOf(text)
  if (s.line > lines.length) return undefined
  const last = Math.min(s.end_line ?? s.line, s.line + KEEP_LINES - 1, lines.length)
  const kept = lines.slice(s.line - 1, last).map(norm)
  return kept.some(l => l) ? kept : undefined
}

/**
 * Where the anchored lines stand in `text` now, nearest the line they were
 * cited at: the line they start on. Found whole first; else by one of them
 * that says enough on its own (the rest edited since); null when none is
 * found (the cited code itself changed). A spot whose lines are all too
 * common to tell apart (a lone `return`) is taken as it was.
 */
export function findAnchor(text        , anchor          , was        )                {
  const lines = linesOf(text).map(norm)
  if (!anchor.some(l => l)) return was
  if (anchor.every(l => !l || WEAK.test(l))) return was <= lines.length ? was : null
  const nearest = (fits                        , from        , to        ) => {
    let best                = null
    for (let i = from; i < to; i++) if (fits(i) && (best === null || Math.abs(i + 1 - was) < Math.abs(best - was))) best = i + 1
    return best
  }
  const whole = nearest(i => anchor.every((l, k) => lines[i + k] === l), 0, lines.length - anchor.length + 1)
  if (whole !== null) return whole
  // One telling line found; the spot starts as far above it as it did.
  let best                = null
  anchor.forEach((l, k) => {
    if (!l || WEAK.test(l) || l.length < 8) return
    const at = nearest(i => lines[i] === l, 0, lines.length)
    if (at !== null && (best === null || Math.abs(at - k - was) < Math.abs(best - was))) best = Math.max(1, at - k)
  })
  return best
}

                                      

/**
 * The map with its cited spots where they are now, by the anchors and the
 * files as they read now (`texts`; a file not read is left as cited).
 * `moved`: the spots that moved; `changed`: those whose lines are found
 * nowhere whole, left where they were cited.
 */
export function relocate(graph       , anchors         , texts                     )                                                             {
  const moved              = []
  const changed              = []
  const seen = new Set        ()
  const place = (s           )            => {
    const anchor = anchors[spotKey(s)]
    const text = texts.get(s.path)
    if (!anchor || text === undefined || !s.line) return s
    const at = findAnchor(text, anchor, s.line)
    const key = spotKey(s)
    if (at === null) {
      if (!seen.has(key)) changed.push(s)
      seen.add(key)
      return s
    }
    if (at === s.line) return s
    const now = { line: at, ...(s.end_line ? { end_line: s.end_line + at - s.line } : {}) }
    if (!seen.has(key)) moved.push({ ...s, now })
    seen.add(key)
    return { ...s, ...now }
  }
  const sourcesAt =                  (x   )    => (x.sources?.length ? { ...x, sources: x.sources.map(place) } : x)
  const edgeAt = (e           )            => {
    const out = sourcesAt(e)
    return e.vouched?.where ? { ...out, vouched: { ...e.vouched, where: place(e.vouched.where) } } : out
  }
  return { graph: { ...graph, nodes: graph.nodes.map(n => sourcesAt           (n)), edges: graph.edges.map(edgeAt) }, moved, changed }
}

/** Every spot the map cites with lines: modules', lines', and where a vouch was shown. */
export function citedSpots(graph       )              {
  const out              = []
  for (const n of graph.nodes) out.push(...(n.sources ?? []))
  for (const e of graph.edges) {
    out.push(...(e.sources ?? []))
    if (e.vouched?.where) out.push(e.vouched.where)
  }
  return out.filter(s => s.line)
}

/** The spots of a map by who cites them: `n:id` for a module, `e:from>to` for a line. */
export function spotsByOwner(graph       )                           {
  const out = new Map                     ()
  const add = (owner        , s           ) => (out.get(owner) ?? out.set(owner, new Set()).get(owner) ).add(spotKey(s))
  for (const n of graph.nodes) for (const s of n.sources ?? []) add(`n:${n.id}`, s)
  for (const e of graph.edges) {
    for (const s of e.sources ?? []) add(`e:${e.from}>${e.to}`, s)
    if (e.vouched?.where) add(`e:${e.from}>${e.to}`, e.vouched.where)
  }
  return out
}

/**
 * The spots of `next` cited just now: those no one cited in `prev` (by owner),
 * and every spot of the owners in `fresh` (what Claude cited again).
 */
export function freshSpots(prev              , next       , fresh                      = new Set())              {
  const before = prev ? spotsByOwner(prev) : new Map                     ()
  const out              = []
  const take = (owner        , s           ) => {
    if (fresh === 'all' || fresh.has(owner) || !before.get(owner)?.has(spotKey(s))) out.push(s)
  }
  for (const n of next.nodes) for (const s of n.sources ?? []) take(`n:${n.id}`, s)
  for (const e of next.edges) {
    for (const s of e.sources ?? []) take(`e:${e.from}>${e.to}`, s)
    if (e.vouched?.where) take(`e:${e.from}>${e.to}`, e.vouched.where)
  }
  return out.filter(s => s.line)
}

/** The anchors kept: at most a few lines each; with a map, only its spots'. */
export function cleanAnchors(raw         , graph              )          {
  const o = raw && typeof raw === 'object' ? ((raw                       ).spots ?? raw) : {}
  const keys = graph ? new Set(citedSpots(graph).map(spotKey)) : null
  const out          = {}
  for (const [k, v] of Object.entries((o ?? {})                           )) {
    if ((keys && !keys.has(k)) || !Array.isArray(v)) continue
    const lines = v.filter((l)              => typeof l === 'string').slice(0, KEEP_LINES).map(l => l.slice(0, KEEP_CHARS))
    if (lines.length) out[k] = lines
  }
  return out
}

/** The map with the spots a check found moved put where they are now. */
export function movedTo(graph       , moved             )        {
  const at = new Map(moved.map(m => [spotKey(m), m.now]))
  const place = (s           )            => {
    const now = at.get(spotKey(s))
    if (!now) return s
    const { end_line: _, ...rest } = s
    return { ...rest, ...now }
  }
  const sourcesAt =                  (x   )    => (x.sources?.length ? { ...x, sources: x.sources.map(place) } : x)
  return {
    ...graph,
    nodes: graph.nodes.map(n => sourcesAt           (n)),
    edges: graph.edges.map(e => {
      const out = sourcesAt(e)
      return e.vouched?.where ? { ...out, vouched: { ...e.vouched, where: place(e.vouched.where) } } : out
    }),
  }
}
