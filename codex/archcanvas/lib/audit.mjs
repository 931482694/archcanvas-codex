// Generated from archcanvas/hooks/audit.ts; edit source, then rebuild.
// The map held against the code, read mechanically: which code files no
// module covers, which ties between modules the code shows (imports, source()
// calls, paths written in strings, calls to functions another file defines)
// that the map does not draw, which calls it draws that the code does not
// show, and which cited lines name nothing of the module they are cited for.
// Pure: the mod lists and reads the files; only paths, names and line numbers
// come out of here, never what the files hold.

                                                                                                         
import { KIND_WORD, isResource, kindOf } from './edges.mjs'
import { spotKey } from './relocate.mjs'
import { sourceText } from './graph.mjs'
import { DATA_FILE, sensitiveOwner, typeOf } from './nodetypes.mjs'

export const AUDIT_PATH = '.archcanvas/audit.json'
export const SCAN_PATH = '.archcanvas/scan.json'

/** At most this many files are listed, and this many code files read. */
export const MAX_LIST = 20000
export const MAX_SCAN = 1500
/** A file bigger than this is generated or vendored, and not looked into. */
export const MAX_CHARS = 512 * 1024

const CODE = /\.(py|r|rmd|qmd|ipynb|[cm]?[jt]sx?|sh|bash|ps1|bat|cmd|sql|jl|do|sas|go|rs|java|kt|scala|c|cc|cpp|h|hpp|cs|rb|php|swift|lua|pl)$/i
const BUILD = /(^|\/)(makefile|snakefile|[^/]+\.smk|justfile)$/i
// Files whose ties are read well enough to say one is not there.
const UNDERSTOOD = /\.(py|r|rmd|qmd|ipynb|[cm]?[jt]sx?|sh|bash|ps1|bat|cmd)$|(^|\/)(makefile|snakefile|[^/]+\.smk|justfile)$/i
// Where commands name files bare: python clean.py, Rscript fit.R.
const SHELLISH = /\.(sh|bash|ps1|bat|cmd)$|(^|\/)(makefile|snakefile|[^/]+\.smk|justfile)$/i
const PYISH = /\.(py|ipynb|rmd|qmd)$/i
const RISH = /\.(r|rmd|qmd)$/i
const JSISH = /\.[cm]?[jt]sx?$/i
// Folders of tools and environments, not the project's own code.
const SKIP_DIRS = new Set(['.git', '.archcanvas', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.ipynb_checkpoints', '.cache', 'renv', 'packrat', 'site-packages', 'dist', 'build', '.tox', '.nox', '.next', 'coverage', 'htmlcov'])
// Plumbing that needs no module of its own.
const PLUMBING = /(^|\/)(__init__\.py|setup\.py|conftest\.py|[^/]+\.config\.[cm]?[jt]s|[^/]+\.d\.ts)$/i

/** A folder the listing does not go into: a tool's, or a hidden one other than .claude. */
export const skipDir = (name        )          => SKIP_DIRS.has(name.toLowerCase()) || (name.startsWith('.') && name !== '.claude')

/** Whether a project file is code to read: not data, not in a tool's folder,
 *  and under .claude only in the project's own skills. */
export function isCodeFile(rel        )          {
  return inOwnFolders(rel) && !DATA_FILE.test(rel) && (CODE.test(rel) || BUILD.test(rel))
}

// Not in a tool's folder, nor a hidden one other than the project's own skills.
function inOwnFolders(rel        )          {
  const dirs = rel.split('/').slice(0, -1)
  return !dirs.some((d, i) => SKIP_DIRS.has(d.toLowerCase()) || (d.startsWith('.') && !(d === '.claude' && dirs[i + 1] === 'skills')))
}

const CONFIG = /\.(ya?ml|json|toml|ini|cfg|conf)$/i
const LOCKS = /(^|\/)(package-lock\.json|[^/]+\.lock|composer\.lock|npm-shrinkwrap\.json)$/i

/** Whether a project file is settings that may name where data is: config.yaml,
 *  settings.json, a .toml or .ini. Read for the paths they hold, nothing else. */
export const isConfigFile = (rel        )          => inOwnFolders(rel) && CONFIG.test(rel) && !LOCKS.test(rel)

// ---- paths ----

const dirOf = (p        ) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

// A path joined onto a folder, its . and .. worked out; undefined when it
// climbs out of the project.
function join(dir        , rel        )                     {
  const out = dir ? dir.split('/') : []
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part !== '..') out.push(part)
    else if (!out.length) return undefined
    else out.pop()
  }
  return out.join('/')
}

                                                                          

function indexOf(all          )        {
  const exact = new Map                ()
  const byName = new Map                  ()
  for (const f of all) {
    const k = f.toLowerCase()
    exact.set(k, f)
    const name = k.slice(k.lastIndexOf('/') + 1)
    const same = byName.get(name)
    if (same) same.push(f)
    else byName.set(name, [f])
  }
  return { exact, byName }
}

// The one listed file a path's tail can be: utils.py, R/fit.R.
function byTail(ix       , tail        )                     {
  const t = tail.toLowerCase()
  const hits = (ix.byName.get(t.slice(t.lastIndexOf('/') + 1)) ?? []).filter(f => {
    const k = f.toLowerCase()
    return k === t || k.endsWith('/' + t)
  })
  return hits.length === 1 ? hits[0] : undefined
}

const HAS_EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

// What a path written in the code points at, from the file it is written in:
// a listed file, else the path as written when it has a folder in it (a module
// may own a folder whose files git does not list, data most of all).
function pathRef(raw        , from        , ix       )                     {
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!p || p.length > 260 || /^[A-Za-z][\w+.-]*:|^[/~]|[*?<>|"{}$%\n\t]/.test(p)) return undefined
  const here = join(dirOf(from), p)
  const top = join('', p)
  for (const c of [here, top]) {
    const hit = c ? ix.exact.get(c.toLowerCase()) : undefined
    if (hit) return hit
  }
  if (HAS_EXT.test(p)) {
    const hit = byTail(ix, p.replace(/^(\.\.\/)+/, ''))
    if (hit) return hit
  }
  // Kept only when it reads as a path (a folder in it, or a folder itself:
  // results/): no spaces or sentence marks (a docstring with a slash in it),
  // and not a media type such as application/json.
  const folder = /[\\/]\s*$/.test(raw)
  if ((!p.includes('/') && !folder) || !/^[\w一-鿿.\-/]+$/.test(p) || /^(application|text|image|audio|video|multipart)\//i.test(p)) return undefined
  return top || here || undefined
}

// ---- reading one file ----

// Python: import a.b, from a.b import c, from . import d.
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm
// JavaScript and TypeScript: import … from './x', import './x', require('./x').
const JS_FROM = /\b(?:import|export)\s+(?:type\s+)?([\w$*{},\s]*?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g
const JS_BARE = /\bimport\s*(['"])([^'"\n]+)\1/g
const JS_CALL = /\b(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']
// What files define: Python and JavaScript functions and classes, R functions.
const PY_DEF = /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)/gm
const R_DEF = /^[ \t]*([A-Za-z.][\w.]*)[ \t]*(?:<<-|<-|=)[ \t]*function[ \t]*\(/gm
const JS_DEF = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function\*?|class)[ \t]+([A-Za-z_$][\w$]*)|^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm
// Paths in strings, joined when written in pieces: here("data", "raw"), Path("a") / "b".
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const JOINER = /^[\s,/()]*$/
const BARE = /(?:^|[\s=:(,])((?:\.{1,2}\/)?[\w一-鿿.\-/\\]*[\w一-鿿-]\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s;)&|>,])/g
const COMMENT = /^\s*(#|\/\/|--|%|\*|\/\*)/
// A line that writes where it names: to_csv(, saveRDS(, ggsave(, open(…, "w"), > out.csv.
const WRITES = /\b(to_[a-z]+|save[\w.]*|savefig|ggsave|dump|write[\w.]*|fwrite|sink)\s*\(|\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][wax]/i
const SHELL_WRITES = /(^|[^-=<>])>{1,2}\s*[\w./]/

const esc = (s        ) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 1-based line numbers for offsets into a text.
function lineAt(text        )                         {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return at => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

// Names in an import list, each with its alias: (a, b as c) → [a], [b, c].
const namesIn = (list        ) =>
  list
    .replace(/[()\\]/g, ' ')
    .split(',')
    .map(s => s.trim().split(/\s+as\s+/))
    .filter(x => x[0] && x[0] !== '*')

// The file a Python module is, looked for beside the importer, at the top,
// under src/, then anywhere it can only be one file.
function pyModule(dotted        , dots        , from        , ix       )                     {
  const tail = dotted.split('.').filter(Boolean).join('/')
  let bases          
  if (dots) {
    let b                     = dirOf(from)
    for (let i = 1; i < dots && b !== undefined; i++) b = b ? dirOf(b) : undefined
    if (b === undefined) return undefined
    bases = [b]
  } else bases = [dirOf(from), '', 'src']
  for (const b of bases) {
    const p = [b, tail].filter(Boolean).join('/')
    const cands = tail ? [`${p}.py`, `${p}/__init__.py`] : [p ? `${p}/__init__.py` : '__init__.py']
    for (const c of cands) {
      const hit = ix.exact.get(c.toLowerCase())
      if (hit) return hit
    }
  }
  if (dots || !tail) return undefined
  return byTail(ix, `${tail}.py`) ?? byTail(ix, `${tail}/__init__.py`)
}

function jsModule(spec        , from        , ix       )                     {
  if (!spec.startsWith('.')) return undefined
  const base = join(dirOf(from), spec)
  if (!base) return undefined
  const stem = base.replace(/\.[cm]?js$/, '')
  for (const c of [base, ...JS_EXTS.flatMap(x => [base + x, stem + x])]) {
    const hit = ix.exact.get(c.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

// A notebook's code cells, the language they are in, and whether any keeps
// output. What the outputs say is never looked at.
function notebookCode(text        )                                                   {
  try {
    const nb = JSON.parse(text)     
                                                                             
                                                                                          
     
    const lang = String(nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? 'python').toLowerCase()
    const cells = (Array.isArray(nb.cells) ? nb.cells : []).filter(c => c?.cell_type === 'code')
    const code = cells.map(c => (Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''))).join('\n')
    return { code, lang, outputs: cells.some(c => Array.isArray(c.outputs) && c.outputs.length > 0) }
  } catch {
    return { code: '', lang: '', outputs: false }
  }
}

                                                                                                                  

function sourceOf(path        , text        )         {
  if (/\.ipynb$/i.test(path)) {
    const nb = notebookCode(text)
    return { path, code: nb.code, lang: nb.lang === 'r' ? 'r' : nb.lang.startsWith('py') ? 'py' : 'other', lines: false, outputs: nb.outputs }
  }
  const lang = /\.py$/i.test(path) ? 'py' : RISH.test(path) ? 'r' : JSISH.test(path) ? 'js' : 'other'
  return { path, code: text, lang, lines: true }
}

function refsIn(src        , ix       , defs                          , routes                          )            {
  const out            = []
  const { path: from, code } = src
  const lineOf = lineAt(code)
  const add = (to                    , line        , names           , writes          ) => {
    if (!to || to === from) return
    const clean = names?.filter(Boolean)
    out.push({ from, to, line: src.lines ? line : 0, ...(clean?.length ? { names: clean } : {}), ...(writes ? { writes: true } : {}) })
  }

  if (src.lang === 'py' || PYISH.test(from)) {
    for (const m of code.matchAll(PY_FROM)) {
      const line = lineOf(m.index ?? 0)
      const dots = m[1].length
      const mod = m[2]
      const rest           = []
      for (const [name, alias] of namesIn(m[3])) {
        const sub = pyModule(mod ? `${mod}.${name}` : name, dots, from, ix)
        if (sub) add(sub, line, [name, alias])
        else rest.push(name, alias)
      }
      if (rest.length) add(pyModule(mod, dots, from, ix), line, rest)
    }
    for (const m of code.matchAll(PY_IMPORT)) {
      const line = lineOf(m.index ?? 0)
      for (const [dotted, alias] of namesIn(m[1])) add(pyModule(dotted, 0, from, ix), line, [dotted.split('.').pop() ?? '', alias])
    }
  }
  if (src.lang === 'js') {
    for (const m of code.matchAll(JS_FROM)) {
      const names = (m[1].match(/[A-Za-z_$][\w$]*/g) ?? []).filter(w => w !== 'as' && w !== 'type')
      add(jsModule(m[3], from, ix), lineOf(m.index ?? 0), names)
    }
    for (const re of [JS_BARE, JS_CALL]) for (const m of code.matchAll(re)) add(jsModule(m[2], from, ix), lineOf(m.index ?? 0))
  }

  // Paths written in strings, and bare in commands; comment lines skipped.
  const shell = SHELLISH.test(from)
  const comment = shell ? /^\s*(#|rem\b|::)/i : COMMENT
  code.split('\n').forEach((text, i) => {
    if (comment.test(text)) return
    const writes = WRITES.test(text) || (shell && SHELL_WRITES.test(text))
    let run           = []
    let end = -1
    const flush = () => {
      if (run.length > 1) add(pathRef(run.join('/'), from, ix), i + 1, undefined, writes)
      run = []
    }
    for (const m of text.matchAll(LITERAL)) {
      const at = m.index ?? 0
      if (end >= 0 && !JOINER.test(text.slice(end, at))) flush()
      add(pathRef(m[2], from, ix), i + 1, undefined, writes)
      run.push(m[2])
      end = at + m[0].length
    }
    flush()
    if (shell) for (const m of text.matchAll(BARE)) add(pathRef(m[1], from, ix), i + 1, undefined, writes)
  })

  const found = new Set        ()
  const defRe = src.lang === 'py' ? [PY_DEF] : src.lang === 'r' ? [R_DEF] : src.lang === 'js' ? [JS_DEF] : []
  for (const re of defRe) for (const m of code.matchAll(re)) if ((m[1] ?? m[2] ?? '').length >= 3) found.add(m[1] ?? m[2])
  if (found.size) defs[from] = [...found].slice(0, 300)
  const served = routesIn(code)
  if (served.length) routes[from] = served.slice(0, 300)
  return out
}

// ---- calls over HTTP ----
// A route a file serves: a decorator (@app.get("/run"), @bp.route('/run')), a
// server's method (app.post('/run', …), router.get, mux.HandleFunc), or a path
// it compares a request's with (url.pathname === '/run', case '/run':). A
// client's own calls (fetch, axios.get, this.http.get) are not among them.
const ROUTE_AT = [
  /@[\w.]+\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\(\s*[rbuf]?(["'])(\/[^"'\s]*)\1/gi,
  /\b(?:\w*(?:app|App|router|Router)|server|srv|fastify|bp|blueprint|\w+_bp)\s*\.\s*(?:get|post|put|patch|delete|all|route|options|head|add_get|add_post|add_put|add_delete|add_route|add_url_rule)\s*\(\s*(["'`])(\/[^"'`\s]*)\1/g,
  /\.(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\s*\(\s*(["`])(\/[^"`\s]*)\1/g,
  /\b[\w.]*(?:path|pathname|url|uri|route|endpoint)\s*[!=]==?\s*(["'`])(\/[^"'`\s]*)\1/gi,
  /(["'`])(\/[^"'`\s]*)\1\s*[!=]==?\s*[\w.]*(?:path|pathname|url|uri|route|endpoint)\b/gi,
  /\bcase\s+(["'`])(\/[^"'`\s]*)\1\s*:/g,
]
const PARAM = /^(:\w+\??|\{[^}]*\}|<[^>]*>|\*)$/

// A route as served, its last slash and query dropped; one with too little of
// its own to tell it from any other path (/, /:id, /x) is none.
function routeOf(raw        )                     {
  if (raw.includes('${')) return undefined
  const r = raw.split(/[?#]/)[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  const own = r.split('/').filter(s => s && !PARAM.test(s)).join('')
  return (own.match(/[A-Za-z0-9]/g) ?? []).length >= 3 ? r : undefined
}

function routesIn(code        )           {
  const out = new Set        ()
  // Comment lines are left out: an example in a comment serves nothing.
  const said = code
    .split('\n')
    .filter(l => !COMMENT.test(l))
    .join('\n')
  for (const re of ROUTE_AT) for (const m of said.matchAll(re)) {
    const r = routeOf(m[2])
    if (r) out.add(r)
  }
  return [...out]
}

// The longest fixed part of a route: what a string has to hold to be calling it.
const routeKey = (route        ) => route.split('/').filter(s => !PARAM.test(s)).sort((a, b) => b.length - a.length)[0]

// What a route goes by in the code that calls it: the part before its first
// parameter (/api/items for /api/items/:id).
export function routeName(route        )         {
  const parts = route.split('/')
  const at = parts.findIndex(s => PARAM.test(s))
  const head = (at < 0 ? parts : parts.slice(0, at)).join('/')
  return head.length >= 3 ? head : routeKey(route)
}

// A route written out in a string: /api/items/:id in `${base}/api/items/${id}?full=1`.
function routeMatcher(route        )         {
  const parts = route.split('/').map(s => (s === '*' ? '[^?#]*' : PARAM.test(s) ? '[^/?#]+' : esc(s)))
  return new RegExp(`${parts.join('/')}/?(?:[?#]|$)`)
}

// Values in a settings file that read as paths: quoted anywhere, or bare after
// a key (raw_dir: data/raw, out = results/) or a list's dash. One under a key
// that sounds like output (out, result, save, export, report) is written.
const CONFIG_KEY = /^\s*["']?([\w.-]+)["']?\s*[:=]/
const CONFIG_BARE = /^\s*(?:-\s+|["']?[\w.-]+["']?\s*[:=]\s*)([^\s#;'"[{][^\s#;]*)\s*(?:[#;].*)?$/
const OUT_KEY = /out|result|save|export|write|report|figure/i

function configPaths(path        , text        , ix       )                                    {
  const found = new Map                 ()
  const add = (raw        , key        ) => {
    const to = pathRef(raw, path, ix)
    if (to && to !== path) found.set(to, (found.get(to) ?? false) || OUT_KEY.test(key))
  }
  for (const line of text.slice(0, MAX_CHARS).split('\n')) {
    const key = CONFIG_KEY.exec(line)?.[1] ?? ''
    for (const m of line.matchAll(LITERAL)) add(m[2], key)
    const bare = CONFIG_BARE.exec(line)
    if (bare) add(bare[1], key)
  }
  return [...found].map(([to, writes]) => ({ to, writes }))
}

/** Reads what the code files say: what each names (imports, source() calls,
 *  paths in strings) and defines. `all` is every project file, for finding
 *  what a name points at. A settings file in `configs` that code names lends
 *  that code the paths it holds. Same `from` and `to` are kept once, at the first line. */
/**
 * What the code files say. `other`: what files not read now define and serve
 * (R functions, web routes), from a scan before, so that a few files read
 * again still find their calls into the rest.
 */
export function scanCode(
  files                                  ,
  all          ,
  at        ,
  truncated = false,
  configs                                   = [],
  other                                                                         = {},
)           {
  const ix = indexOf(all)
  const defs                           = {}
  const routes                           = {}
  const sources = files.map(f => sourceOf(f.path, f.text))
  const refs = sources.flatMap(s => refsIn(s, ix, defs, routes))

  // Paths a settings file holds count as named where the code names the file:
  // clean.py reading config.yaml reads the data config.yaml points at.
  const held = new Map(configs.map(c => [c.path, configPaths(c.path, c.text, ix)]))
  for (const r of [...refs]) {
    for (const h of held.get(r.to) ?? []) if (h.to !== r.from) refs.push({ from: r.from, to: h.to, line: r.line, ...(h.writes ? { writes: true          } : {}) })
  }

  // R: a function one other R file defines, called here. R projects often
  // source everything from one main script and call across files freely.
  const rFiles = sources.filter(s => s.lang === 'r')
  const definedBy = new Map                       ()
  const read = new Set(files.map(f => f.path))
  const rDefs                       = [
    ...rFiles.map(s => [s.path, defs[s.path] ?? []]                      ),
    ...Object.entries(other.defs ?? {}).filter(([p]) => !read.has(p) && /\.(r|rmd|qmd)$/i.test(p)),
  ]
  for (const [path, names] of rDefs) for (const d of names) definedBy.set(d, definedBy.has(d) && definedBy.get(d) !== path ? null : path)
  const callable = [...definedBy].filter((x)                        => x[1] !== null && x[0].length >= 4)
  for (const s of rFiles) {
    const lineOf = lineAt(s.code)
    for (const [name, owner] of callable) {
      if (owner === s.path) continue
      const m = new RegExp(`(?<![\\w.$])${esc(name)}\\s*\\(`).exec(s.code)
      if (m) refs.push({ from: s.path, to: owner, line: s.lines ? lineOf(m.index) : 0, names: [name] })
    }
  }

  // HTTP: a route one file serves, written out in another's string
  // (fetch('/api/run'), `${base}/items/${id}`): a call over the network. A
  // route more than one file serves is left alone.
  const servedBy = new Map                       ()
  const served                       = [...Object.entries(other.routes ?? {}).filter(([p]) => !read.has(p)), ...Object.entries(routes)]
  for (const [path, list] of served) for (const r of list) servedBy.set(r, servedBy.has(r) && servedBy.get(r) !== path ? null : path)
  const routed = [...servedBy]
    .filter((x)                        => x[1] !== null)
    .map(([route, owner]) => ({ route, owner, name: routeName(route), key: routeKey(route), re: routeMatcher(route) }))
  if (routed.length) {
    for (const s of sources) {
      const hit = new Set        ()
      s.code.split('\n').forEach((text, i) => {
        if (COMMENT.test(text) || !text.includes('/')) return
        for (const m of text.matchAll(LITERAL)) {
          for (const r of routed) {
            if (r.owner === s.path || hit.has(r.route) || !m[2].includes(r.key) || !r.re.test(m[2])) continue
            hit.add(r.route)
            refs.push({ from: s.path, to: r.owner, line: s.lines ? i + 1 : 0, names: [r.name] })
          }
        }
      })
    }
  }

  const kept = new Map                 ()
  for (const r of refs) {
    const key = `${r.from}\n${r.to}`
    const had = kept.get(key)
    if (!had) kept.set(key, { ...r })
    else {
      const names = [...new Set([...(had.names ?? []), ...(r.names ?? [])])]
      kept.set(key, { ...had, ...(names.length ? { names } : {}), ...(had.writes || r.writes ? { writes: true } : {}) })
    }
  }
  const outputs = sources.filter(s => s.outputs).map(s => s.path)
  return {
    at,
    files: files.map(f => f.path),
    refs: [...kept.values()],
    defs,
    ...(Object.keys(routes).length ? { routes } : {}),
    ...(outputs.length ? { outputs } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * A scan brought up to date for a few files read again (`files`) and some
 * gone (`gone`): what those say is replaced, the rest kept as last read. A
 * call from an unchanged file into a changed one is as last read too.
 */
export function rescan(prev          , files                                  , gone          , all          , at        , configs                                   = [])           {
  const fresh = scanCode(files, all, at, false, configs, prev)
  const changed = new Set([...files.map(f => f.path), ...gone])
  const defs = Object.fromEntries(Object.entries(prev.defs).filter(([p]) => !changed.has(p)))
  Object.assign(defs, fresh.defs)
  const routes = Object.fromEntries(Object.entries(prev.routes ?? {}).filter(([p]) => !changed.has(p)))
  Object.assign(routes, fresh.routes)
  const outputs = [...(prev.outputs ?? []).filter(p => !changed.has(p)), ...(fresh.outputs ?? [])]
  return {
    at,
    files: [...new Set([...prev.files.filter(f => !changed.has(f)), ...files.map(f => f.path)])],
    refs: [...prev.refs.filter(r => !changed.has(r.from)), ...fresh.refs],
    defs,
    ...(Object.keys(routes).length ? { routes } : {}),
    ...(outputs.length ? { outputs } : {}),
    ...(prev.truncated ? { truncated: true          } : {}),
  }
}

// ---- holding the map against it ----

const key = (p        ) => p.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** Which modules a project path falls in: those whose files or folders hold
 *  it most closely (a file over its folder). One file may be listed by two
 *  modules, when it does two jobs; then it is in both. */
export function ownersOf(graph       )                             {
  const entries = graph.nodes.flatMap(n => n.files.map(f => ({ id: n.id, k: key(f) }))).filter(e => e.k)
  return p => {
    const k = key(p)
    const hits = entries.filter(e => k === e.k || k.startsWith(e.k + '/'))
    const closest = Math.max(0, ...hits.map(e => e.k.length))
    return [...new Set(hits.filter(e => e.k.length === closest).map(e => e.id))]
  }
}

// A file's name without its extension; a package's own file goes by its folder.
function stem(p        )         {
  const parts = p.replace(/\/+$/, '').split('/')
  const s = (parts.pop() ?? '').replace(/\.[^.]+$/, '')
  return s === '__init__' || s === 'index' ? (parts.pop() ?? '') : s
}

const mentions = (text        , name        ) => new RegExp(`(^|[^A-Za-z0-9_])${esc(name)}($|[^A-Za-z0-9_])`, 'i').test(text)

const isCall = (e           , graph       ) => {
  const a = graph.nodes.find(n => n.id === e.from)
  const b = graph.nodes.find(n => n.id === e.to)
  return Boolean(a && b && kindOf(e, typeOf(a), typeOf(b)) === 'call')
}

/** The map against what the code says. `texts` holds the code files the
 *  map's call lines cite, for whether the cited lines name what is called.
 *  `rewritten`: spots (by spotKey) whose cited lines are found nowhere now:
 *  what stands at their line numbers is another code's, and they are doubted
 *  as rewritten whatever it says. */
export function audit(graph       , scan          , texts                     , at        , rewritten              = new Set())        {
  const owners = ownersOf(graph)
  const type = new Map(graph.nodes.map(n => [n.id, typeOf(n)]))
  const owned = new Map                  ()
  for (const f of scan.files) for (const id of owners(f)) owned.set(id, [...(owned.get(id) ?? []), f])

  const uncovered = scan.files.filter(f => !owners(f).length && !PLUMBING.test(f)).sort((a, b) => a.localeCompare(b))

  // Each spot ties the modules its file is in to the modules what it names is
  // in. It is drawn when any of those pairs has a line, either way round.
  const drawn = (a        , b        ) => graph.edges.some(e => (e.from === a && e.to === b) || (e.from === b && e.to === a))
  const acts = (id        ) => ['code', 'notebook', 'skill'].includes(type.get(id) ?? '')
  const shown = new Set        ()
  const ties = new Map                  ()
  for (const r of scan.refs) {
    const ends = owners(r.to)
    const pairs = owners(r.from)
      .filter(a => !isResource(type.get(a) ))
      .flatMap(a => ends.filter(b => b !== a).map(b => [a, b]         ))
    for (const [a, b] of pairs) shown.add(`${a}>${b}`)
    if (pairs.some(([a, b]) => drawn(a, b))) continue
    const where            = r.line ? { path: r.from, line: r.line } : { path: r.from }
    for (const [a, b] of pairs.filter(([a, b]) => acts(a) && type.get(b) !== 'test')) {
      const t = ties.get(`${a}>${b}`)
      if (!t) {
        const kind           = isResource(type.get(b) ) ? (r.writes ? 'write' : 'read') : 'call'
        ties.set(`${a}>${b}`, { from: a, to: b, kind, at: [where] })
        continue
      }
      if (r.writes && t.kind === 'read') t.kind = 'write'
      if (t.at.length < 3 && !t.at.some(s => s.path === where.path)) t.at.push(where)
    }
  }
  const missing = [...ties.values()]

  // What a module goes by in the code: its files' names, what they define,
  // and what the citing file imported from it.
  const namesOf = (id        , from        ) => {
    const out = new Set        ()
    for (const f of graph.nodes.find(n => n.id === id)?.files ?? []) out.add(stem(f))
    for (const f of owned.get(id) ?? []) {
      out.add(stem(f))
      for (const d of scan.defs[f] ?? []) out.add(d)
      for (const r of scan.routes?.[f] ?? []) out.add(routeName(r))
    }
    for (const r of scan.refs) if (r.from === from && owners(r.to).includes(id)) for (const n of r.names ?? []) out.add(n)
    return [...out].filter(n => n.length >= 2)
  }

  // What each file names, by module, at the first line: to find a file that
  // names both ends of a call the code does not show, and may hand one to the
  // other (an entry script passing the store it opened to the server). Tests
  // name everything they set up, and are no evidence of that.
  const names = new Map                             ()
  for (const r of scan.refs) {
    const by = names.get(r.from) ?? names.set(r.from, new Map()).get(r.from) 
    for (const id of owners(r.to)) if (!by.has(id)) by.set(id, r.line)
  }
  const handedBy = (a        , b        )                                                        => {
    for (const [path, by] of names) {
      const own = owners(path)
      if (!by.has(a) || !by.has(b) || own.includes(a) || own.includes(b) || own.some(id => type.get(id) === 'test')) continue
      return { path, line: by.get(b) , ...(own.length ? { node: own[0] } : {}) }
    }
    return undefined
  }

  const unfound                   = []
  const doubtful                    = []
  for (const e of graph.edges) {
    // Someone looked and said it is there, in a way this reading cannot see.
    if (!isCall(e, graph) || e.vouched) continue
    const mine = owned.get(e.from) ?? []
    const readable = mine.some(f => UNDERSTOOD.test(f))
    const reachable = (graph.nodes.find(n => n.id === e.to)?.files.length ?? 0) > 0
    // Two modules in one file call each other inside it, where no import shows.
    const together = mine.some(f => owners(f).includes(e.to))
    if (readable && reachable && !together && !shown.has(`${e.from}>${e.to}`)) {
      const via = shown.has(`${e.to}>${e.from}`) ? undefined : handedBy(e.from, e.to)
      unfound.push(shown.has(`${e.to}>${e.from}`) ? { from: e.from, to: e.to, reversed: true } : { from: e.from, to: e.to, ...(via ? { via } : {}) })
    }
    for (const s of e.sources ?? []) {
      if (!s.line || owners(s.path).includes(e.to)) continue
      if (rewritten.has(spotKey(s))) {
        doubtful.push({ from: e.from, to: e.to, source: s, changed: true })
        continue
      }
      const text = texts.get(s.path)
      if (text === undefined) continue
      // A module the code has no name for (a service outside, without files): nothing to hold the lines to.
      const names = namesOf(e.to, s.path)
      if (!names.length) continue
      const lines = text.split(/\r?\n/).slice(s.line - 1, s.end_line ?? s.line).join('\n')
      if (!names.some(n => mentions(lines, n))) doubtful.push({ from: e.from, to: e.to, source: s })
    }
  }

  // Notebooks that keep outputs and name data the person marked sensitive:
  // what they printed may hold its records, and goes wherever the notebook is read.
  const notebooks = (scan.outputs ?? [])
    .map(path => ({ path, uses: [...new Set(scan.refs.filter(r => r.from === path).map(r => sensitiveOwner(graph, r.to)?.id).filter((id)               => !!id))] }))
    .filter(n => n.uses.length)

  return {
    at,
    scanned: scan.files.length,
    ...(scan.truncated ? { truncated: true } : {}),
    uncovered: uncovered.slice(0, 300),
    missing: missing.slice(0, 100),
    unfound: unfound.slice(0, 100),
    doubtful: doubtful.slice(0, 100),
    notebooks,
  }
}

/** The code files a map's call lines cite: what `audit` wants to read. */
export function citedFiles(graph       , scan          )           {
  const read = new Set(scan.files)
  return [...new Set(graph.edges.filter(e => isCall(e, graph)).flatMap(e => (e.sources ?? []).map(s => s.path)))].filter(p => read.has(p))
}

export const isClean = (a       ) => !a.uncovered.length && !a.missing.length && !a.unfound.length && !a.doubtful.length

/** The audit in one line. */
export function auditSummary(a       )         {
  const parts = [
    a.uncovered.length ? `${a.uncovered.length} 个代码文件没归进模块` : '',
    a.missing.length ? `${a.missing.length} 处代码里有的关系图上没画` : '',
    a.unfound.length ? `${a.unfound.length} 条调用代码里没找到` : '',
    a.doubtful.length ? `${a.doubtful.length} 处依据没提到被调用的模块` : '',
  ].filter(Boolean)
  return parts.length ? `代码核对：${parts.join('，')}。` : `代码核对：读了 ${a.scanned} 个代码文件，图和代码对得上。`
}

/** The audit as lines for Claude: the first `max` of each kind. */
export function auditLines(a       , graph       , max = 12)           {
  const name = (id        ) => `「${graph.nodes.find(n => n.id === id)?.name ?? id}」`
  const lines           = []
  if (a.uncovered.length) {
    lines.push(`这些代码文件没归进任何模块（${a.uncovered.length} 个）：${a.uncovered.slice(0, max).join('、')}${a.uncovered.length > max ? ' 等' : ''}`)
  }
  if (a.missing.length) {
    lines.push(`代码里有、图上没画的关系（${a.missing.length} 处）：`)
    for (const t of a.missing.slice(0, max)) lines.push(`- ${name(t.from)}${KIND_WORD[t.kind]}${name(t.to)}：${t.at.map(sourceText).join('、')}`)
  }
  if (a.unfound.length) {
    lines.push(`图上画了、代码里没找到的调用（${a.unfound.length} 条）：`)
    for (const u of a.unfound.slice(0, max)) {
      const how = u.reversed
        ? '（代码里是后者引用前者，方向可能画反了）'
        : u.via
          ? `（${sourceText(u.via)}${u.via.node ? `（${name(u.via.node)}）` : ''}同时引用了两者，可能是它把后者作为参数交给前者）`
          : ''
      lines.push(`- ${name(u.from)} → ${name(u.to)}${how}`)
    }
  }
  if (a.doubtful.length) {
    lines.push(`依据那几行没提到被调用的模块（${a.doubtful.length} 处）：`)
    for (const d of a.doubtful.slice(0, max)) lines.push(`- ${name(d.from)} → ${name(d.to)}：${sourceText(d.source)}${d.changed ? '（这几行引用时的代码已经改写，文件里找不到了）' : ''}`)
  }
  return lines
}

/** What Claude is asked when the person hands the audit over. */
export function auditPrompt(a       , graph       )         {
  return [
    '架构画布把架构图和代码对了一遍，有下面这些出入。请逐条核对并修正架构图（用架构画布的 read_graph 读出，改完用 save_graph 保存）。',
    '',
    ...auditLines(a, graph, 30),
    '',
    '怎么处理：',
    ...(a.uncovered.length ? ['- 没归进模块的文件：归到合适的模块（写进它的 files），或新建模块；确实无关紧要的（临时脚本、示例）可以不管，在回复里说一声。'] : []),
    ...(a.missing.length ? ['- 代码里有、图上没画的关系：属实就补上连线，依据写上面列的位置。'] : []),
    ...(a.unfound.length
      ? [
          '- 代码里没找到的调用：可能是通过命令行、配置或别的方式调用的，找到就补上依据；确实没有就去掉这条线；方向反了就改过来。',
          '  调用确实存在、只是核对认不出来的（对象作为参数传进来、经网络接口调用、运行时才加载），不要去掉，用 update_graph 的 change_edges 写上 vouch（一句原因），以后核对就不再报它。标了「同时引用了两者」的，先看那个文件是不是真把一个交给了另一个。',
        ]
      : []),
    ...(a.doubtful.length
      ? [
          '- 依据没提到被调用模块的：换成真正调用它的那几行（用 update_graph 的 change_edges 写新的 sources）；确实就是这几行、只是没写出模块的名字时，同样用 change_edges 写上 vouch。',
          '  因为上面加了代码而整体挪了位的依据，核对已经按原来那几行的内容找到了新位置，不用改；列在这里的是找到后仍对不上、或原来那几行已经改写的。',
        ]
      : []),
    '',
    '这些是按 import、source()、代码里写的路径和函数名自动找的，会有误报，以你读到的代码为准。数据文件夹只看目录结构，不要打开里面的数据文件。',
  ].join('\n')
}

/** The map with a tie the code shows drawn in, its spots as the line's evidence. */
export function drawTie(graph       , a              , from        , to        )                                                     {
  const t = a?.missing.find(x => x.from === from && x.to === to)
  if (!t) return { error: '这条关系已经不在核对结果里了，刷新画布看看。' }
  const ends = [from, to].map(id => graph.nodes.find(n => n.id === id))
  if (!ends[0] || !ends[1]) return { error: '这条关系的模块已经不在图上了。' }
  if (graph.edges.some(e => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return { error: '图上已经有这条线了。' }
  const edge            = { from, to, ...(t.kind === 'call' ? {} : { kind: t.kind }), sources: t.at.slice(0, 5) }
  return { graph: { ...graph, edges: [...graph.edges, edge] }, text: `已画上：「${ends[0].name}」${KIND_WORD[t.kind]}「${ends[1].name}」，依据 ${t.at.map(sourceText).join('、')}。` }
}
