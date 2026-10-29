// Generated from archcanvas/hooks/history.ts; edit source, then rebuild.
// Change history: each file edit Claude makes, reduced to a small diff and
// tied to the modules whose files it touched. Pure.

                                             

export const HISTORY_PATH = '.archcanvas/history.json'
export const HISTORY_LIMIT = 1000

const DIFF_LINES = 80
const DIFF_CHARS = 6000

// One unified-diff hunk: the lines between the common head and the common
// tail. `firstLine` is where `before` starts in its file (1 for a whole file).
export function diffLines(before        , after        , firstLine = 1)                                                   {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n')
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const gone = a.slice(head, a.length - tail)
  const came = b.slice(head, b.length - tail)
  if (!gone.length && !came.length) return { added: 0, removed: 0, diff: '' }
  const at = firstLine + head
  const lines = [...gone.map(l => `-${l}`), ...came.map(l => `+${l}`)]
  let body = lines.slice(0, DIFF_LINES).join('\n')
  if (lines.length > DIFF_LINES) body += `\n …（还有 ${lines.length - DIFF_LINES} 行）`
  if (body.length > DIFF_CHARS) body = body.slice(0, DIFF_CHARS) + '\n …'
  const header = `@@ -${gone.length ? at : at - 1},${gone.length} +${came.length ? at : at - 1},${came.length} @@`
  return { added: came.length, removed: gone.length, diff: `${header}\n${body}` }
}

// The line an Edit's old text starts on, from the file as it was before.
export function lineOf(text        , snippet        )         {
  const i = snippet ? text.replace(/\r\n/g, '\n').indexOf(snippet.replace(/\r\n/g, '\n')) : -1
  return i < 0 ? 1 : text.replace(/\r\n/g, '\n').slice(0, i).split('\n').length
}

// The path relative to the project root, with forward slashes; undefined for
// a file outside it. Windows paths compare without case.
export function relativeTo(root        , file        )                     {
  const norm = (p        ) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(file)
  const fold = /^[A-Za-z]:/.test(r)
  const rc = fold ? r.toLowerCase() : r
  const fc = fold ? f.toLowerCase() : f
  if (!/^([A-Za-z]:)?\//.test(f)) return f.replace(/^\.\//, '')
  if (fc === rc || !fc.startsWith(rc + '/')) return undefined
  return f.slice(r.length + 1)
}

// The modules a project file belongs to: listed exactly, or under a listed folder.
export function nodesForFile(graph       , rel        )           {
  const f = rel.toLowerCase()
  return graph.nodes
    .filter(n => n.files.some(x => {
      const g = x.toLowerCase().replace(/\/+$/, '')
      return f === g || f.startsWith(g + '/')
    }))
    .map(n => n.id)
}

export function forNode(history                   , nodeId        )           {
  return history.filter(c => c.nodeIds.includes(nodeId)).sort((x, y) => y.at - x.at)
}

export function when(ms        )         {
  const d = new Date(ms)
  const two = (n        ) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function trimHistory(history                   )           {
  return history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : [...history]
}
