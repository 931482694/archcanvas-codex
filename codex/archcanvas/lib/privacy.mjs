// Generated from archcanvas/hooks/privacy.ts; edit source, then rebuild.
// What of a project's data Claude does not get to see.
//
// The person marks data modules sensitive: when they make one on the canvas,
// and when Claude has drawn the map. What would show Claude what is in those
// files is refused, without asking: reading them, searching them for lines,
// shell commands that print them. Nothing else is stopped: running a script on
// the data goes ahead, and data outside a sensitive module is not watched.
// Claude is given the rules each turn instead (sensitiveBrief), and the person
// is told on the canvas what still reaches the conversation. Pure.

                                                
import { relativeTo } from './history.mjs'
import { DATA_FILE, NOTES, SENSITIVE_RULE, isSensitive, sensitiveOwner } from './nodetypes.mjs'

/** A sensitive module a path Claude names falls in, and the path. */
                                                       

const slash = (p        ) => p.replace(/\\/g, '/')
const folder = (p        ) => p.toLowerCase().replace(/\/+$/, '')
const GLOB = /[*?[]/

// `.` and `..` taken out, so `src/../data/raw` is `data/raw`.
function tidy(p        )         {
  const head = /^([A-Za-z]:)?\//.exec(p)?.[0] ?? ''
  const out           = []
  for (const part of p.slice(head.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return head + out.join('/')
}

/** A path as Claude wrote it, made absolute: Git Bash's /c/ is C:/, a relative one is under `cwd`. */
export function absolute(cwd        , given        )         {
  let p = slash(given.trim())
  const msys = /^\/([A-Za-z])(\/|$)/.exec(p)
  if (msys && /^[A-Za-z]:/.test(cwd)) p = `${msys[1].toUpperCase()}:/${p.slice(3)}`
  if (!/^([A-Za-z]:)?\//.test(p)) p = `${slash(cwd).replace(/\/+$/, '')}/${p}`
  return tidy(p)
}

// Where a path is in the project: '' for the root itself, undefined outside it.
function inProject(root        , abs        )                     {
  return folder(abs) === folder(slash(root)) ? '' : relativeTo(root, abs)
}

// Sealed modules with a folder at or under `rel` ('' is the whole project).
function sealedUnder(graph       , rel        )              {
  const base = folder(rel)
  return graph.nodes.filter(n => isSensitive(n) && n.files.some(x => !base || folder(x) === base || folder(x).startsWith(base + '/')))
}

/** The sensitive module a path Claude names falls in, if any (its notes excepted). */
export function sealedAt(graph              , root        , cwd        , given        )                     {
  if (!graph || !given.trim()) return undefined
  const rel = inProject(root, absolute(cwd, given))
  const owner = rel ? sensitiveOwner(graph, rel) : undefined
  return owner && rel ? { owner, path: rel } : undefined
}

// ---- shell commands ----

// Words in a command that look like paths: with a slash, or a data file's
// extension. Quotes and brackets split words, so a path inside inline code
// (python -c "pd.read_csv('a.csv')") counts too; a quoted path with spaces
// counts whole.
export function namedPaths(command        )           {
  const out = new Set        ()
  const words = [...command.matchAll(/[^\s'"`;|&<>(){},=]+/g)].map(m => m[0])
  const quoted = [...command.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map(m => m[1] ?? m[2]).filter(q => /\s/.test(q))
  for (const word of [...words, ...quoted]) {
    const w = word.replace(/[:;,]+$/, '')
    if (!w || w.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue
    if (/[\\/]/.test(w) || DATA_FILE.test(w)) out.add(w)
  }
  return [...out]
}

// Commands that only list, count or make folders: names, not what is in the files.
const LOOK_ONLY = new Set([
  'ls', 'dir', 'tree', 'du', 'stat', 'file', 'wc', 'mkdir', 'md', 'cd', 'pushd', 'popd', 'pwd', 'echo', 'test', 'realpath', 'basename', 'dirname',
  'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'resolve-path', 'new-item', 'ni', 'measure-object', 'measure', 'select-object', 'sort-object',
  'format-table', 'ft', 'format-list', 'fl', 'where-object', 'write-output', 'write-host',
])

function looksOnly(command        )          {
  return command.split(/\|\||&&|[|;&\n]/).every(seg => {
    const words = seg.trim().split(/\s+/).filter(w => w && !/^\w+=/.test(w))
    const verb = (words[0] ?? '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
    if (!verb) return true
    if (verb === 'find') return !/\s-(exec|execdir|ok|okdir|delete|fprint)\b/.test(seg)
    return LOOK_ONLY.has(verb)
  })
}

// A search through every file under a folder.
const SEARCHES = [
  /(^|[\s|;&(])[ef]?grep\s(?:[^|;&]*\s)?-[A-Za-z]*[rR]/,
  /(^|[\s|;&(])(rg|ag|ack)(\s|$)/,
  /(^|[\s|;&(])git\s+grep(\s|$)/,
  /(^|[\s|;&(])findstr\s[^|;&]*\/s/i,
]
const searches = (c        ) =>
  SEARCHES.some(re => re.test(c)) || (/select-string|(^|[\s|;&(])sls\s/i.test(c) && /-recurse\b|\s-r(\s|$)|\s-s(\s|$)/i.test(c))

// The file filters a search names (--include=*.py, -g '*.py', -t py).
function filters(c        )                                     {
  const glob = [...c.matchAll(/(?:--include[= ]|--glob[= ]|--iglob[= ]|(?:^|\s)-g\s+|(?:^|\s)-Include\s+|(?:^|\s)-Filter\s+)['"]?([^\s'"]+)/gi)].map(m => m[1])
  const type = [...c.matchAll(/(?:--type[= ]|(?:^|\s)-t\s+)['"]?([^\s'"]+)/gi)].map(m => m[1])
  return { glob, type }
}

const DATA_WORD = /(^|[^a-z0-9])(csv|tsv|xlsx?|sav|dta|sas7bdat|parquet|feather|rds|rdata|h5|hdf5|npy|npz|nii|dcm|mat|sqlite|db)([^a-z0-9]|$)/i
const namesData = (glob        ) => DATA_WORD.test(glob)
/** Whether a file filter can match data files: one names a data extension, or names none (`*`, `data/**`). */
export const globReachesData = (glob        ) => namesData(glob) || !/\.[^/\\]*$/.test(glob)
const typeIsData = (type        ) => /^(csv|tsv)$/i.test(type)

// A command that prints what it reads.
const SHOWS = /(^|[\s|;&(])(cat|head|tail|less|more|type|gc|get-content|import-csv|sed|awk|cut|sort|uniq|xxd|od|strings|bat|column|csvlook|findstr|grep|rg|select-string|sls)(\s|$)|\.(head|tail|sample)\(|\bprint\(|\bdisplay\(/i
export const showsContent = (command        ) => SHOWS.test(command)

// Output is written, not read: `> out.csv` shows nothing.
const withoutOutput = (command        ) => command.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g, ' ')

/** The sensitive modules a shell command would print the files of: one that
 *  prints what it reads (cat, head, Get-Content, print(...), grep), naming a
 *  sensitive path, a wildcard over one, or searching a folder that holds one. */
export function shellShows(graph              , root        , cwd        , command        )           {
  const c = withoutOutput(command)
  if (!graph || looksOnly(c) || !showsContent(c)) return []
  const found = new Map                ()
  const add = (s                    ) => {
    if (s && !found.has(s.owner.id)) found.set(s.owner.id, s)
  }
  const sealedFrom = (given        ) => {
    const rel = inProject(root, absolute(cwd, given))
    if (rel !== undefined) for (const owner of sealedUnder(graph, rel)) add({ owner, path: rel })
  }
  const named = namedPaths(c)
  for (const p of named) {
    add(sealedAt(graph, root, cwd, p))
    // A wildcard reaches every sealed folder under where it starts.
    if (GLOB.test(p)) {
      const parts = slash(p).split('/')
      sealedFrom(parts.slice(0, parts.findIndex(x => GLOB.test(x))).join('/') || '.')
    }
  }
  if (searches(c)) {
    const f = filters(c)
    if (!f.glob.length && !f.type.length) {
      // What it searches: the folders it names, else where it runs.
      const dirs = named.filter(p => !GLOB.test(p) && !DATA_FILE.test(p))
      for (const d of dirs.length ? dirs : ['.']) sealedFrom(d)
    } else if (f.glob.some(globReachesData) || f.type.some(typeIsData)) {
      for (const d of named.filter(p => !GLOB.test(p)).concat('.')) sealedFrom(d)
    }
  }
  return [...found.values()]
}

// ---- Grep ----

// Each letter either case: ripgrep's globs are case-sensitive.
const anyCase = (s        ) => s.replace(/[a-z]/g, ch => `[${ch}${ch.toUpperCase()}]`)
const DATA_GLOBS = ['csv', 'tsv', 'xls', 'xlsx', 'sav', 'dta', 'sas7bdat', 'parquet', 'feather', 'rds', 'rdata', 'h5', 'hdf5', 'npy', 'npz', 'nii', 'nii.gz', 'dcm', 'mat', 'sqlite', 'db'].map(e => `**/*.${anyCase(e)}`)

/** The glob that keeps a search over the project out of sealed folders and data files. */
export function grepExclusion(graph              )         {
  const sealed = graph ? graph.nodes.filter(isSensitive).flatMap(n => n.files.map(f => f.replace(/\/+$/, ''))) : []
  return `!{${[...sealed.flatMap(p => [`**/${p}`, `**/${p}/**`]), ...DATA_GLOBS].join(',')}}`
}

/** The sensitive modules a Grep with its own file filter would show lines of. */
export function grepShows(graph              , root        , cwd        , e                                                                       )           {
  if (!graph || e.output_mode !== 'content') return []
  if (e.type ? !typeIsData(e.type) : !globReachesData(e.glob ?? '')) return []
  const rel = inProject(root, absolute(cwd, e.path || '.'))
  return rel === undefined ? [] : sealedUnder(graph, rel).map(owner => ({ owner, path: rel }))
}

// ---- what Claude is told ----

/** What Claude is told each turn about the data the person marked sensitive;
 *  null when none is. `notebooks`: those that keep outputs made from it. */
export function sensitiveBrief(graph              , notebooks           = [])                {
  const sealed = graph ? graph.nodes.filter(isSensitive) : []
  if (!sealed.length) return null
  return [
    '架构画布：用户把这些数据标为敏感（可能含患者信息）：',
    ...sealed.map(n => `- 「${n.name}」：${n.files.join('、') || '（没有列出文件）'}`),
    `${SENSITIVE_RULE}直接显示这些文件内容的读取和命令（Read、cat、head、Get-Content、Import-Csv、print(df) 这类）会被拒绝，不要换写法绕开。`,
    '要处理这些数据，就写脚本运行，脚本只输出汇总结果，不要打印具体记录（调试输出、报错信息里也别带出整行）：脚本打印的内容会进到对话里。里面的 README 等说明文件可以读。',
    ...(notebooks.length
      ? [`这些 Notebook 保存着用到敏感数据的运行结果，读它们会把结果一起带进对话：${notebooks.join('、')}。要读或改它们，先请用户在架构画布的「敏感数据」里清掉输出。`]
      : []),
    '没标为敏感的数据文件（csv、xlsx、sav 等）也先别打印内容，必要时先问用户。',
  ].join('\n')
}

/** A notebook with its outputs gone: what each code cell printed or showed,
 *  and its run count. The code, its notes and its settings stay as they were,
 *  written back the way Jupyter writes them (same indent, line ends, a newline last). */
export function clearOutputs(text        )                                                        {
  let nb                                                                                      
  try {
    nb = JSON.parse(text)
  } catch {
    return { error: '不是有效的 Notebook 文件' }
  }
  if (!nb || !Array.isArray(nb.cells)) return { error: '不是有效的 Notebook 文件' }
  let cleared = 0
  for (const c of nb.cells) {
    if (!c || c.cell_type !== 'code') continue
    if (Array.isArray(c.outputs) && c.outputs.length) cleared++
    c.outputs = []
    c.execution_count = null
  }
  const indent = /^\{\r?\n( +)"/.exec(text)?.[1].length ?? 1
  const out = JSON.stringify(nb, null, indent) + '\n'
  return { text: text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out, cleared }
}

/** Who refuses, and why: the words a refused read, search or command gives Claude. */
export function refusalOf(sealed          , what        )         {
  const names = [...new Set(sealed.map(s => `「${s.owner.name}」`))].join('、')
  return `archcanvas：${what}会显示敏感数据${names}里的内容，已拒绝。${SENSITIVE_RULE}要处理这些数据，请写脚本运行，只输出汇总结果。如果用户明确要你看内容，请用户先在架构画布上把它标为不敏感。`
}

// ---- the map itself ----

/** Folders and files the old map kept sealed that the new one would open. */
export function reopened(prev              , next       )           {
  if (!prev) return []
  return [...new Set(prev.nodes.filter(isSensitive).flatMap(n => n.files))].filter(f => !NOTES.test(f) && !sensitiveOwner(next, f.replace(/\/+$/, '')))
}
