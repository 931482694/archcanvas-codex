// Codex edits files with apply_patch, whose input is a patch in its own
// format:
//
//   *** Begin Patch
//   *** Update File: path/to/file.py
//   *** Move to: path/to/new.py          (optional)
//   @@ def clean(rows):                  (a hunk; the text after @@ is context)
//    unchanged line
//   -removed line
//   +added line
//   *** Add File: path/new.py            (every line starts with +)
//   *** Delete File: path/old.py
//   *** End Patch
//
// Each file it touches becomes { file, added, removed, diff }, the diff in the
// unified form the canvas draws (hunk headers, then -/+ and context lines).

const DIFF_LINES = 80

export function findPatch(input) {
  if (typeof input === 'string') return input.includes('*** Begin Patch') ? input : null
  if (Array.isArray(input)) {
    for (const v of input) {
      const p = findPatch(v)
      if (p) return p
    }
    return null
  }
  if (input && typeof input === 'object') {
    for (const v of Object.values(input)) {
      const p = findPatch(v)
      if (p) return p
    }
  }
  return null
}

export function parsePatch(text) {
  const files = []
  let cur = null
  const start = (file, op) => {
    cur = { file, op, added: 0, removed: 0, lines: [] }
    files.push(cur)
  }
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    let m
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(raw))) start(m[2].trim(), m[1].toLowerCase())
    else if ((m = /^\*\*\* Move to: (.+)$/.exec(raw)) && cur) { cur.oldFile = cur.file; cur.file = m[1].trim() }
    else if (/^\*\*\* (Begin|End) Patch/.test(raw) || raw === '*** End of File') continue
    else if (!cur) continue
    else if (raw.startsWith('@@')) cur.lines.push(raw)
    else if (raw.startsWith('+')) {
      cur.added++
      cur.lines.push(raw)
    } else if (raw.startsWith('-')) {
      cur.removed++
      cur.lines.push(raw)
    } else if (raw.startsWith(' ')) cur.lines.push(raw)
  }
  return files.flatMap(f => {
    let lines = f.lines
    if (f.op === 'add') lines = [`@@ -0,0 +1,${f.added} @@`, ...lines]
    if (f.op === 'delete') lines = ['（删除了这个文件）']
    let diff = lines.slice(0, DIFF_LINES).join('\n')
    if (lines.length > DIFF_LINES) diff += `\n …（还有 ${lines.length - DIFF_LINES} 行）`
    const change = { file: f.file, added: f.added, removed: f.removed, diff }
    return f.oldFile ? [{ file: f.oldFile, added: 0, removed: 0, diff: `（文件移到 ${f.file}）` }, change] : [change]
  })
}
