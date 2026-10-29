// Generated from archcanvas/hooks/worklog.ts; edit source, then rebuild.
// The work log: each request the person made, what Claude ran for it, the
// files that came out, what it edited, and how its last answer began. What a
// command printed is never kept: only how it ended, the tests' tally, an
// error's type and the files it left. Pure: register.tsx feeds it.

                                                                                                                                                                                  
import { isCodeFile } from './audit.mjs'
import { kindOf as lineKind } from './edges.mjs'
import { nodesForFile, relativeTo } from './history.mjs'
import { sensitiveOwner, typeOf } from './nodetypes.mjs'

export const WORKLOG_PATH = '.archcanvas/worklog.json'
/** Older entries move to `.archcanvas/worklog/<year-month>.json`. */
export const WORKLOG_DIR = '.archcanvas/worklog'
export const WORKLOG_LIMIT = 400

const REQUEST_CHARS = 1500
const ANSWER_CHARS = 800
const COMMAND_CHARS = 400
const NAME_CHARS = 120
const MAX_NAMES = 10
const MAX_OUTPUTS = 200

/** Runs of six or more digits (record and ID numbers) become #. */
export const mask = (text        )         => text.replace(/\d{6,}/g, m => '#'.repeat(Math.min(m.length, 8)))

const cut = (s        , n        ) => (s.length > n ? `${s.slice(0, n)}…` : s)

// ---- what a command is ----

const WRAPPERS             = [['uv', 'run'], ['poetry', 'run'], ['pipenv', 'run'], ['pixi', 'run'], ['rye', 'run'], ['pnpm', 'exec'], ['npx'], ['bunx'], ['sudo'], ['time'], ['nohup'], ['exec'], ['&'], ['call']]
const SCRIPT = /\.(py|r|js|mjs|cjs|ts|tsx|sh|bash|ps1|jl|do|m|ipynb|qmd|rmd)$/i
const NOTEBOOK = /\.(ipynb|qmd|rmd)$/i
const PYTHON = /^(python[\d.]*|py|pythonw|ipython)$/
const NODE = /^(node|tsx|ts-node|deno|bun)$/
const SHELL = /^(bash|sh|zsh|pwsh|powershell)$/

// Words of one command, quotes taken off.
function words(segment        )           {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^(["'])(.*)\1$/, '$2'))
}

const base = (w        ) => w.replace(/\\/g, '/').split('/').pop() .toLowerCase().replace(/\.(exe|cmd|bat)$/, '')

// The command proper: environment settings and wrappers (uv run, conda run -n x, …) taken off.
function proper(ws          )           {
  let rest = ws
  for (;;) {
    while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0])) rest = rest.slice(1)
    const head = rest.length ? base(rest[0]) : ''
    if (head === 'conda' || head === 'mamba' || head === 'micromamba') {
      if (rest[1] !== 'run') return rest
      let i = 2
      while (i < rest.length && rest[i].startsWith('-')) i += /^(-n|--name|-p|--prefix)$/.test(rest[i]) ? 2 : 1
      rest = rest.slice(i)
      continue
    }
    const w = WRAPPERS.find(w => w.every((x, i) => (i === 0 ? head === x : rest[i] === x)))
    if (!w) return rest
    rest = rest.slice(w.length)
  }
}

const firstScript = (ws          ) => ws.find(w => SCRIPT.test(w) && !w.startsWith('-'))

// One command's kind, and the script it runs.
function kindOf(ws          )                                                 {
  if (!ws.length) return undefined
  const head = base(ws[0])
  const [a, b] = [ws[1]?.toLowerCase() ?? '', ws[2]?.toLowerCase() ?? '']
  const all = ws.join(' ')
  // tests
  if (/^(pytest|py\.test|vitest|jest|mocha|tox|nox)$/.test(head)) return { kind: 'test' }
  if (PYTHON.test(head) && a === '-m' && /^(pytest|unittest|nose2)$/.test(b)) return { kind: 'test' }
  if (/^(npm|pnpm|yarn|bun)$/.test(head) && (a === 'test' || a === 't' || (a === 'run' && /^test(:|$)/.test(b)) || /^test:/.test(a))) return { kind: 'test' }
  if (/^(go|cargo|deno|dotnet|mvn|gradle)$/.test(head) && a === 'test') return { kind: 'test' }
  if (head === 'make' && /^(test|tests|check)$/.test(a)) return { kind: 'test' }
  if (head === 'claude' && a === 'plugin' && b === 'test') return { kind: 'test' }
  if (/^(rscript|r)$/.test(head) && /testthat|devtools::test|tinytest|test_dir|test_file/.test(all)) return { kind: 'test' }
  // installs
  if (/^pip\d*$/.test(head) && /^(install|uninstall)$/.test(a)) return { kind: 'env' }
  if (PYTHON.test(head) && a === '-m' && b === 'pip') return { kind: 'env' }
  if (head === 'uv' && (a === 'add' || a === 'remove' || a === 'sync' || (a === 'pip' && /^(install|uninstall)$/.test(b)))) return { kind: 'env' }
  if (/^(conda|mamba|micromamba)$/.test(head) && /^(install|create|update|remove|env)$/.test(a)) return { kind: 'env' }
  if (/^(npm|pnpm|yarn|bun)$/.test(head) && ((head === 'yarn' && a === '') || /^(install|i|ci|add|remove|uninstall)$/.test(a))) return { kind: 'env' }
  if (/^(poetry|pipenv)$/.test(head) && /^(add|install|remove|update)$/.test(a)) return { kind: 'env' }
  if (/^(rscript|r)$/.test(head) && /install\.packages|renv::(restore|install)|BiocManager::install|remotes::install|devtools::install/.test(all)) return { kind: 'env' }
  // commits
  if (head === 'git') return a === 'commit' ? { kind: 'git' } : undefined
  // notebooks
  if (head === 'jupyter' && ((a === 'nbconvert' && ws.includes('--execute')) || a === 'execute')) return { kind: 'notebook', script: firstScript(ws.slice(2)) }
  if (head === 'papermill') return { kind: 'notebook', script: firstScript(ws.slice(1)) }
  if (head === 'quarto' && /^(render|run)$/.test(a)) return { kind: 'notebook', script: firstScript(ws.slice(2)) }
  if (/^(rscript|r)$/.test(head) && /rmarkdown::render|quarto::quarto_render/.test(all)) {
    const m = all.match(/["']([^"']+\.(rmd|qmd))["']/i)
    return { kind: 'notebook', script: m?.[1] }
  }
  // scripts
  if (PYTHON.test(head)) {
    // A module run with -m is a file under its dots.
    if (a === '-m' && b && !/^(venv|http\.server|json\.tool|site|ensurepip)$/.test(b)) return { kind: 'run', script: `${ws[2].replace(/\./g, '/')}.py` }
    if (a === '-c') return { kind: 'run' }
    const s = firstScript(ws.slice(1))
    return s ? { kind: 'run', script: s } : undefined
  }
  if (head === 'rscript') {
    const s = firstScript(ws.slice(1))
    return s ? { kind: 'run', script: s } : ws.includes('-e') ? { kind: 'run' } : undefined
  }
  if (head === 'r' && (a === '-f' || (a === 'cmd' && b === 'batch'))) return { kind: 'run', script: firstScript(ws.slice(2)) }
  if (NODE.test(head)) {
    if ((head === 'deno' || head === 'bun') && a === 'run') return { kind: 'run', script: firstScript(ws.slice(2)) }
    const s = firstScript(ws.slice(1))
    return s ? { kind: 'run', script: s } : undefined
  }
  if (SHELL.test(head)) {
    const s = firstScript(ws.slice(1))
    return s ? { kind: NOTEBOOK.test(s) ? 'notebook' : 'run', script: s } : undefined
  }
  if (/^(npm|pnpm|yarn)$/.test(head) && a === 'run' && b) return { kind: 'run' }
  if (/^(cargo|go)$/.test(head) && a === 'run') return { kind: 'run' }
  if (/^(make|snakemake|nextflow|julia|stata|stata-mp|matlab|java)$/.test(head)) return { kind: 'run', script: firstScript(ws.slice(1)) }
  if (/^\.{0,2}\//.test(ws[0].replace(/\\/g, '/')) && SCRIPT.test(ws[0])) return { kind: NOTEBOOK.test(ws[0]) ? 'notebook' : 'run', script: ws[0] }
  return undefined
}

const RANK                          = { test: 5, notebook: 4, run: 3, env: 2, git: 1, other: 0 }

/**
 * What a shell command runs, if anything worth a line: tests, a notebook, a
 * script, an install or a commit, with the script it names. Looking (ls, cat,
 * grep, git status) is not.
 */
export function classify(command        )                                                 {
  let best                                                
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const ws = proper(words(segment.trim()))
    if (ws.length && /^(cd|pushd|popd|set-location|source|\.)$/i.test(ws[0])) continue
    const k = kindOf(ws)
    if (k && (!best || RANK[k.kind] > RANK[best.kind])) best = k
  }
  if (best?.script) best = { ...best, script: best.script.replace(/\\/g, '/').replace(/^\.\//, '') }
  return best
}

// ---- how a run ended ----

/** The tests' tally from their own summary lines; undefined when none is there. */
export function testCount(out        )                        {
  const text = out.replace(/\x1b\[[0-9;]*m/g, '')
  const lastOf = (re        ) => [...text.matchAll(re)].pop()
  const num = (s                    , word        ) => Number(s?.match(word)?.[1] ?? 0)
  let count                                            

  // pytest: "== 12 passed, 1 failed, 2 skipped in 0.31s ==" or the same without the bars
  const py = lastOf(/^[= ]*((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s\b.*$/gm)
  if (py) {
    const s = py[1]
    count = { passed: num(s, /(\d+) passed/) + num(s, /(\d+) xpassed/), failed: num(s, /(\d+) failed/) + num(s, /(\d+) errors?/), skipped: num(s, /(\d+) skipped/) + num(s, /(\d+) xfailed/) }
  }
  // unittest: "Ran 12 tests in 0.1s" then "OK" or "FAILED (failures=1, errors=1, skipped=2)"
  const ran = !count && lastOf(/^Ran (\d+) tests? in /gm)
  if (ran) {
    const st = lastOf(/^(OK|FAILED)(?: \(([^)]*)\))?\s*$/gm)
    const s = st?.[2] ?? ''
    const failed = num(s, /failures=(\d+)/) + num(s, /errors=(\d+)/)
    const skipped = num(s, /skipped=(\d+)/)
    count = { passed: Math.max(0, Number(ran[1]) - failed - skipped), failed, skipped }
  }
  // jest: "Tests:       1 failed, 2 skipped, 12 passed, 15 total"
  const jest = !count && lastOf(/^Tests:\s+(.*\d+ total)\s*$/gm)
  if (jest) count = { passed: num(jest[1], /(\d+) passed/), failed: num(jest[1], /(\d+) failed/), skipped: num(jest[1], /(\d+) (?:skipped|todo)/) }
  // vitest: "      Tests  1 failed | 12 passed (13)"
  const vi = !count && lastOf(/^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)\s*$/gm)
  if (vi) count = { passed: num(vi[1], /(\d+) passed/), failed: num(vi[1], /(\d+) failed/), skipped: num(vi[1], /(\d+) skipped/) }
  // bun and claude plugin test: " 12 pass" / " 1 fail"
  const bunPass = !count && lastOf(/^\s*(\d+) pass\s*$/gm)
  if (bunPass) count = { passed: Number(bunPass[1]), failed: Number(lastOf(/^\s*(\d+) fail\s*$/gm)?.[1] ?? 0), skipped: Number(lastOf(/^\s*(\d+) skip\s*$/gm)?.[1] ?? 0) }
  // testthat: "[ FAIL 1 | WARN 0 | SKIP 2 | PASS 12 ]"
  const tt = !count && lastOf(/\[ FAIL (\d+) \| WARN \d+ \| SKIP (\d+) \| PASS (\d+) \]/g)
  if (tt) count = { passed: Number(tt[3]), failed: Number(tt[1]), skipped: Number(tt[2]) }
  // cargo: "test result: FAILED. 12 passed; 1 failed; 0 ignored" (one per crate)
  const cargo = !count ? [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)] : []
  if (cargo.length) count = cargo.reduce((c, m) => ({ passed: c.passed + Number(m[1]), failed: c.failed + Number(m[2]), skipped: c.skipped + Number(m[3]) }), { passed: 0, failed: 0, skipped: 0 })
  // mocha: "12 passing", "1 failing", "2 pending"
  const mocha = !count && lastOf(/^\s*(\d+) passing\b/gm)
  if (mocha) count = { passed: Number(mocha[1]), failed: Number(lastOf(/^\s*(\d+) failing\b/gm)?.[1] ?? 0), skipped: Number(lastOf(/^\s*(\d+) pending\b/gm)?.[1] ?? 0) }
  if (!count) return undefined

  const names           = []
  const take = (re        , pick                                 ) => {
    for (const m of text.matchAll(re)) if (names.length < MAX_NAMES) names.push(cut(mask(pick(m).trim()), NAME_CHARS))
  }
  if (count.failed) {
    take(/^(?:FAILED|ERROR) (?!\()(\S+)/gm, m => m[1])
    take(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm, m => m[1])
    take(/^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/gm, m => `${m[2]}.${m[1]}`)
    take(/── (?:Failure|Error) \([^)]*\): (.+?) ─/g, m => m[1])
    take(/^\s*● (?!Test suite failed)(.+)$/gm, m => m[1])
    take(/^(?:--- FAIL: (\S+)|test (\S+) \.\.\. FAILED)/gm, m => m[1] ?? m[2])
  }
  const failedNames = [...new Set(names)]
  return failedNames.length ? { ...count, failedNames } : count
}

/** The type of the error a failed run ended on, and nothing of its message. */
export function errorType(out        )                     {
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).slice(-60).reverse()
  for (const l of lines) {
    const py = l.match(/^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt))(?::|\s*$)/)
    if (py) return py[1].split('.').pop()
    const js = l.match(/^\s*(?:Uncaught )?([A-Z]\w*Error)(?: \[\w+\])?:/)
    if (js) return js[1]
    if (/command not found|is not recognized as|No such file or directory: '?[\w.]+'?$|CommandNotFoundException/.test(l)) return '找不到命令'
  }
  if (lines.some(l => /^Error( in .*)?\s*:/.test(l) || l.trim() === 'Execution halted')) return 'Error（R）'
  return undefined
}

                                                                                                                                                                                      

/** How a shell call ended, from what the tool said back; `out` is its printed
 *  text, read for the tally and the error type, then dropped. */
export function outcomeOf(ran                                                        )                                                                         {
  const r = (ran.result && typeof ran.result === 'object' ? ran.result : {})               
  const str = (v         ) => (typeof v === 'string' ? v : '')
  const out = [str(r.stdout), str(r.stderr), typeof ran.result === 'string' ? ran.result : '', ran.text ?? ''].filter(Boolean).join('\n')
  const code = (ran.text ?? '').match(/(?:^|\n)Exit code:? (-?\d+)/)
  const exitCode = code ? Number(code[1]) : undefined
  const sha = str(r.gitOperation?.commit?.sha)
  const status            =
    r.interrupted === true ? 'interrupted' : r.backgroundTaskId || r.timedOutAfterMs ? 'background' : ran.isError || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'ok'
  return { status, ...(exitCode !== undefined ? { exitCode } : {}), out, ...(sha ? { commit: sha } : {}) }
}

/** One run, ready for the log; nothing it printed goes in. */
export function makeRun(
  id        ,
  at        ,
  command        ,
  seen                                    ,
  ended                                                                        ,
  graph              ,
  extra                                                                                    = {},
)          {
  const tests = seen.kind === 'test' ? testCount(ended.out) : undefined
  const failed = ended.status === 'ok' && tests?.failed ? 'failed' : ended.status
  const error = failed === 'failed' && seen.kind !== 'test' ? errorType(ended.out) : undefined
  const script = seen.script
  return {
    id,
    at,
    ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
    kind: seen.kind,
    command: cut(mask(command.trim()), COMMAND_CHARS),
    ...(script ? { script } : {}),
    nodeIds: graph && script ? nodesForFile(graph, script) : [],
    status: failed,
    ...(ended.exitCode !== undefined ? { exitCode: ended.exitCode } : {}),
    ...(error ? { error } : {}),
    ...(tests ? { tests } : {}),
    ...(extra.version ? { version: extra.version } : {}),
    ...(ended.commit ? { commit: ended.commit } : {}),
    ...(extra.partial ? { partial: true          } : {}),
    ...(extra.masked ? { masked: extra.masked } : {}),
  }
}

// ---- what a run left ----

/** A file's size and time, by project-relative path. */
                                                                        

/** Folders, by convention, where results land. */
export const OUTPUT_DIRS = ['results', 'result', 'output', 'outputs', 'out', 'figures', 'figs', 'plots', 'reports', 'tables']

/**
 * Where a run's results may land, to look at before and after it, likeliest
 * first: the places the code writes to, the usual result folders that exist
 * (`present`), data the map shows being written and documents, then data the
 * map ties to nothing. Data the map shows only being read (raw inputs, often
 * thousands of files) is not looked at. Folders end with a slash.
 */
export function outputPlaces(graph              , scan                               , present           = [])           {
  const places           = []
  const add = (p        ) => {
    const q = p.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!q || q === '/' || q.startsWith('.archcanvas') || q.startsWith('..') || /^([A-Za-z]:)?\//.test(q) || places.includes(q)) return
    places.push(q)
  }
  for (const r of scan?.refs ?? []) {
    if (!r.writes) continue
    const to = r.to.replace(/\\/g, '/')
    // A file named in code: watch its folder, since names are often built.
    add(to.endsWith('/') ? to : /\.[A-Za-z0-9]{1,6}$/.test(to) && to.includes('/') ? to.slice(0, to.lastIndexOf('/') + 1) : to)
  }
  for (const d of present) add(`${d}/`)
  const nodes = graph?.nodes ?? []
  const kinds = new Map                    ()
  for (const e of graph?.edges ?? []) {
    const a = nodes.find(n => n.id === e.from)
    const b = nodes.find(n => n.id === e.to)
    if (!a || !b) continue
    const k = lineKind(e, typeOf(a), typeOf(b))
    for (const id of [e.from, e.to]) kinds.set(id, [...(kinds.get(id) ?? []), k])
  }
  const tied = (id        ) => kinds.get(id) ?? []
  for (const n of nodes) if ((typeOf(n) === 'data' && tied(n.id).includes('write')) || typeOf(n) === 'doc') n.files.forEach(add)
  for (const n of nodes) if (typeOf(n) === 'data' && !tied(n.id).length) n.files.forEach(add)
  // A place inside another is looked at with it.
  return places.filter(p => !places.some(q => q !== p && q.endsWith('/') && p.startsWith(q)))
}

/** How much one look before or after a run may take: folders listed, files
 *  kept, how deep, and how many folders listed at once. */
export const LOOK = { dirs: 150, files: 2000, depth: 6, together: 8 }

                                                                                            

/** How a look reads the disk: a folder's entries, or one path's (null when missing). */
                                                                                                              

/**
 * The sizes and times of the files at the places, in their order, within
 * the budget. A place too big to look at whole is left out rather than seen
 * in part, since a part would show files as made or gone that were not;
 * `whole` names the places that were looked at whole, `big` those given up on.
 */
export async function lookAt(
  places          ,
  io        ,
  limits = LOOK,
  skip                            = () => false,
)                                                              {
  const snap           = {}
  const whole           = []
  const big           = []
  let dirs = 0
  let files = 0
  for (const place of places) {
    if (dirs >= limits.dirs || files >= limits.files) break
    const got           = {}
    let over = false
    let level           = []
    if (place.endsWith('/')) level = [place]
    else {
      dirs++
      const s = await io.stat(place).catch(() => null)
      if (s?.kind === 'file') {
        got[place] = { size: s.size, mtimeMs: s.mtimeMs }
        files++
      } else if (s?.kind === 'dir') level = [`${place}/`]
    }
    for (let depth = 0; level.length && !over; depth++) {
      const next           = []
      for (let i = 0; i < level.length && !over; i += limits.together) {
        const batch = level.slice(i, i + limits.together)
        dirs += batch.length
        if (dirs > limits.dirs) {
          over = true
          break
        }
        const lists = await Promise.all(batch.map(rel => io.list(rel).catch(() => []           )))
        lists.forEach((entries, j) => {
          for (const e of entries) {
            const p = `${batch[j]}${e.name}`
            if (e.kind === 'dir') {
              if (!skip(e.name)) {
                if (depth >= limits.depth) over = true
                else next.push(`${p}/`)
              }
            } else if (e.kind === 'file') {
              got[p] = { size: e.size, mtimeMs: e.mtimeMs }
              if (++files > limits.files) over = true
            }
          }
        })
      }
      level = next
    }
    if (over) {
      big.push(place)
      continue
    }
    Object.assign(snap, got)
    whole.push(place)
  }
  return { snap, whole, big }
}

/** The part of a look that falls under these places. */
export function within(snap          , places          )           {
  // A sealed file (sealKeys) says its place by hash.
  const hashes = new Set(places.map(fnv))
  const inside = (p        ) => {
    const sealed = p.match(SEALED_KEY)
    return sealed ? hashes.has(sealed[2]) : places.some(q => under(p, q))
  }
  return Object.fromEntries(Object.entries(snap).filter(([p]) => inside(p)))
}

/**
 * The code version from one `git status --porcelain=v2 --branch -z`: the
 * commit, and code files (under `prefix`, the project's place in the
 * repository) not as committed. Undefined before the first commit.
 */
export function versionOf(out        , prefix        )                          {
  const recs = out.split('\0')
  const head = recs.find(r => r.startsWith('# branch.oid '))?.slice(13).trim() ?? ''
  if (!/^[0-9a-f]{40}$/.test(head)) return undefined
  const dirty           = []
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    const f = r.split(' ')
    const p = r.startsWith('1 ') ? f.slice(8).join(' ') : r.startsWith('2 ') ? f.slice(9).join(' ') : r.startsWith('u ') ? f.slice(10).join(' ') : r.startsWith('? ') ? r.slice(2) : ''
    // A rename's old path comes as a record of its own.
    if (r.startsWith('2 ')) i++
    if (p && p.startsWith(prefix) && isCodeFile(p.slice(prefix.length))) dirty.push(p.slice(prefix.length))
  }
  return dirty.length ? { revision: head, dirty: dirty.slice(0, 10) } : { revision: head }
}

/** What changed from one snapshot to the next. */
export function changedBetween(before          , after          )                                                                  {
  const out                                                                  = []
  for (const [p, a] of Object.entries(after)) {
    const b = before[p]
    if (!b) out.push({ path: p, change: 'created', size: a.size })
    else if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) out.push({ path: p, change: 'updated', size: a.size })
  }
  for (const p of Object.keys(before)) if (!after[p]) out.push({ path: p, change: 'deleted' })
  return out
}

/**
 * Files a run left, split: those in sensitive data counted per module and
 * never named; the rest by name with their modules.
 */
export function sortOutputs(
  changes                                                                 ,
  graph              ,
  runId         ,
)                                                    {
  const outputs               = []
  const sealed = new Map                      ()
  for (const c of changes) {
    if (c.path.startsWith('.archcanvas/')) continue
    // A file in sensitive data a kept look named by its module only (sealKeys).
    const kept = c.path.match(SEALED_KEY)
    const owner = kept ? { id: kept[1] } : graph ? sensitiveOwner(graph, c.path) : undefined
    if (owner) {
      const s = sealed.get(owner.id) ?? { nodeId: owner.id, created: 0, updated: 0, deleted: 0, size: 0, ...(runId ? { runId } : {}) }
      s[c.change]++
      s.size += c.size ?? 0
      sealed.set(owner.id, s)
      continue
    }
    outputs.push({ path: c.path, change: c.change, ...(c.size !== undefined ? { size: c.size } : {}), nodeIds: graph ? nodesForFile(graph, c.path) : [], ...(runId ? { runId } : {}) })
  }
  return { outputs, sealed: [...sealed.values()] }
}

                                                                         

// ---- what changed while Claude was not working ----

/** The look kept at the end of each request, to hold the next one's start
 *  against: what changed in between was done outside Claude. */
export const LOOK_PATH = '.archcanvas/look.json'

                                                                       

// `#<module>#<place hash>:<path hash>`: a file in sensitive data as a kept look names it.
const SEALED_KEY = /^#([^#]+)#([0-9a-f]{8}):[0-9a-f]{8}$/

const under = (p        , q        ) => (q.endsWith('/') ? p.startsWith(q) : p === q || p.startsWith(`${q}/`))

// A short, steady stand-in for a path (32-bit FNV-1a).
function fnv(s        )         {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A look as it may be kept on disk: files in sensitive data go by their
 *  module, the place they were found at and a hash of the path, never by name. */
export function sealKeys(snap          , graph              , places          )           {
  const out           = {}
  for (const [p, v] of Object.entries(snap)) {
    const owner = graph ? sensitiveOwner(graph, p) : undefined
    const place = places.find(q => under(p, q)) ?? ''
    out[owner ? `#${owner.id}#${fnv(place)}:${fnv(p)}` : p] = v
  }
  return out
}

/** Where to look for changes made outside Claude: where results land, and
 *  the notebooks, which a person runs by hand. */
export function outsidePlaces(graph              , outputs          )           {
  const books = (graph?.nodes ?? []).filter(n => typeOf(n) === 'notebook').flatMap(n => n.files)
  const all = [...outputs]
  for (const b of books) if (!all.includes(b) && !all.some(q => q.endsWith('/') && b.startsWith(q))) all.push(b)
  return all
}

/** An entry for files that changed between two requests: who changed them
 *  and why is not known, only that Claude was not running anything then
 *  (`background`: unless a command it left in the background was). */
export function outsideEntry(id        , session        , from        , to        , left                                                   , background = false)            {
  const nodeIds = [...new Set([...left.outputs.flatMap(o => o.nodeIds), ...left.sealed.map(s => s.nodeId)])]
  return {
    id,
    session,
    source: 'outside',
    request: '',
    startedAt: from,
    endedAt: to,
    runs: [],
    outputs: left.outputs,
    ...(left.sealed.length ? { sealed: left.sealed } : {}),
    edits: [],
    ...(background ? { background: true          } : {}),
    nodeIds,
  }
}

                                                                                                                                                              

/** The files a shell call changed, as the engine saw them in the working
 *  tree: names only, the lines it diffed are not kept. */
export function editedBy(result         , root        )         {
  const d = result && typeof result === 'object' ? (result                               ).bashEditDiff : undefined
  if (!d || d.unavailable || d.skipped) return []
  const out = new Map              ()
  const put = (abs         , change                ) => {
    const rel = typeof abs === 'string' ? relativeTo(root, abs) : undefined
    if (rel && !out.has(rel)) out.set(rel, { path: rel, change })
  }
  for (const f of d.files ?? []) put(f.filePath, f.created ? 'created' : f.deleted ? 'deleted' : 'updated')
  for (const f of d.changedFiles ?? []) put(f, 'updated')
  return [...out.values()]
}

/** Two accounts of what a run changed as one list: the look at the folders
 *  knows sizes, the engine's diff knows files outside them. */
export function mergeChanges(a        , b        )         {
  const out = new Map(a.map(x => [x.path, x]))
  for (const x of b) out.set(x.path, { ...out.get(x.path), ...x })
  return [...out.values()]
}

// ---- the log ----

export function newEntry(id        , session        , at        , request        , source            )            {
  return { id, session, source, request: cut(mask(request.trim()), REQUEST_CHARS), startedAt: at, runs: [], outputs: [], edits: [], nodeIds: [] }
}

const union = (a                   , b                   ) => [...new Set([...a, ...b])]

function touch(entry           , change                             )            {
  const next = change(entry)
  const ids = [
    ...next.runs.flatMap(r => r.nodeIds),
    ...next.outputs.flatMap(o => o.nodeIds),
    ...(next.sealed ?? []).map(s => s.nodeId),
    ...next.edits.flatMap(e => e.nodeIds),
  ]
  return { ...next, nodeIds: union(entry.nodeIds, ids) }
}

const on = (log             , id        , change                             ) => log.map(e => (e.id === id ? touch(e, change) : e))

/** A request starts: any of the session's still open are closed as lost, since a turn ends before the next begins. */
export function begin(log             , entry           )              {
  const closed = log.map(e => (e.session === entry.session && !e.endedAt ? { ...e, endedAt: entry.startedAt, end: 'lost'          } : e))
  return [...closed.filter(e => e.id !== entry.id), entry]
}

/** The request still open in this session, which a run or an edit belongs to. */
export const openEntry = (log                      , session        )                        => [...log].reverse().find(e => e.session === session && !e.endedAt)

export function addRun(log             , id        , run         , left                                                    = { outputs: [], sealed: [] })              {
  return on(log, id, e => {
    // A file written twice in one request is listed once: created stays created.
    const outputs = [...e.outputs]
    for (const o of left.outputs) {
      const i = outputs.findIndex(x => x.path === o.path)
      if (i < 0) outputs.push(o)
      else if (outputs[i].change === 'created' && o.change === 'deleted') outputs.splice(i, 1)
      else outputs[i] = { ...o, change: outputs[i].change === 'created' && o.change !== 'deleted' ? 'created' : o.change }
    }
    const sealed = [...(e.sealed ?? [])]
    for (const s of left.sealed) {
      const i = sealed.findIndex(x => x.nodeId === s.nodeId)
      if (i < 0) sealed.push(s)
      else sealed[i] = { ...sealed[i], created: sealed[i].created + s.created, updated: sealed[i].updated + s.updated, deleted: sealed[i].deleted + s.deleted, size: sealed[i].size + s.size }
    }
    return { ...e, runs: [...e.runs, run], outputs: outputs.slice(-MAX_OUTPUTS), ...(sealed.length ? { sealed } : {}) }
  })
}

export function addEdit(log             , id        , edit          )              {
  return on(log, id, e => {
    const had = e.edits.find(x => x.file === edit.file)
    const edits = had
      ? e.edits.map(x => (x === had ? { ...x, added: x.added + edit.added, removed: x.removed + edit.removed, nodeIds: union(x.nodeIds, edit.nodeIds) } : x))
      : [...e.edits, edit]
    return { ...e, edits }
  })
}

export function addLink(log             , id        , link                                       )              {
  return on(log, id, e => ({
    ...e,
    ...(link.taskId ? { taskIds: union(e.taskIds ?? [], [link.taskId]) } : {}),
    ...(link.checkId ? { checkIds: union(e.checkIds ?? [], [link.checkId]) } : {}),
  }))
}

/** What changed on the architecture map during the request, a line each. */
export function addMap(log             , id        , lines          )              {
  return on(log, id, e => ({ ...e, map: [...(e.map ?? []), ...lines.map(l => cut(l, 200))].slice(-30) }))
}

const RESULT_CHARS = 600
const NOTE_CHARS = 1000
const MAX_RESULTS = 20

/** A result Claude wrote down: one sentence (numbers masked like the rest),
 *  and the project files it is in. */
export function addResult(log             , id        , text        , files          , at        )              {
  const said = cut(mask(text.trim()), RESULT_CHARS)
  const where = [...new Set(files.map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter(f => f && !/^([A-Za-z]:)?\//.test(f) && !f.split('/').includes('..')))].slice(0, 10)
  return on(log, id, e => ({ ...e, results: [...(e.results ?? []), { text: said, ...(where.length ? { files: where } : {}), at }].slice(-MAX_RESULTS) }))
}

/** The person's note on an entry; empty takes it away. */
export function setNote(log             , id        , text        )              {
  const note = cut(text.trim(), NOTE_CHARS)
  return log.map(e => {
    if (e.id !== id) return e
    const { note: _, ...rest } = e
    return note ? { ...rest, note } : rest
  })
}

/** Marked as mattering, or as no longer counting (a run on wrong data, say); null takes the mark away. */
export function setMark(log             , id        , mark                          )              {
  return log.map(e => {
    if (e.id !== id) return e
    const { mark: _, ...rest } = e
    return mark ? { ...rest, mark } : rest
  })
}

/** The request ends: when, how, and the start of Claude's last answer. */
export function finish(log             , id        , at        , how                                                )              {
  const answer = how.answer ? cut(mask(how.answer.trim()), ANSWER_CHARS) : ''
  return on(log, id, e => ({ ...e, endedAt: at, ...(how.ms !== undefined ? { ms: how.ms } : {}), end: how.end, ...(answer ? { answer } : {}) }))
}

/** The year and month an entry is filed under once it leaves the current log. */
export function monthOf(ms        )         {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The log kept to its limit; the oldest go to their month's file. */
export function trimLog(log             )                                                           {
  if (log.length <= WORKLOG_LIMIT) return { log, moved: {} }
  const gone = log.slice(0, log.length - WORKLOG_LIMIT)
  const moved                              = {}
  for (const e of gone) (moved[monthOf(e.startedAt)] ??= []).push(e)
  return { log: log.slice(log.length - WORKLOG_LIMIT), moved }
}
