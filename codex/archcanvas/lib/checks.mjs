// Generated from archcanvas/hooks/checks.ts; edit source, then rebuild.
// Checks: what Claude asks the person to try by hand after a change (run a
// script and look at its output, compare a result with real data), pinned to
// modules. The person tries one at once, or leaves it and clears a batch
// later; a failed one can go back to Claude as a task. Pure.

                                                  
import { commentTask, nameOf } from './tasks.mjs'

export const CHECKS_PATH = '.archcanvas/checks.json'

export const CHECK_STATUS                                  = {
  open: '待测试',
  passed: '通过',
  failed: '没通过',
  dismissed: '不用测了',
}

const str = (v         ) => (typeof v === 'string' ? v : '')
const list = (v         ) => (Array.isArray(v) ? v.filter((x)              => typeof x === 'string') : [])

// A path inside the project, with forward slashes; '' for anything else.
function inside(p        )         {
  const f = p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!f || /^([A-Za-z]:)?\//.test(f) || f.split('/').includes('..')) return ''
  return f
}

export function checkId(now        , taken                  )         {
  let n = 0
  let id = `k-${now.toString(36)}`
  while (taken.some(c => c.id === id)) id = `k-${now.toString(36)}-${++n}`
  return id
}

                                                                                                                   

export function makeCheck(req              , graph       , now        , checks                  , taskId         )                            {
  const title = str(req.title).trim()
  if (!title) return { error: '请在 title 里写明要用户测试什么。' }
  const nodeIds = [...new Set(list(req.nodes))]
  if (!nodeIds.length) return { error: '请在 nodes 里写明是哪个模块的测试（模块 id）。' }
  const unknown = nodeIds.filter(id => !graph.nodes.some(n => n.id === id))
  if (unknown.length) return { error: `架构图里没有这些模块：${unknown.join('、')}。先 read_graph 看看模块 id。` }
  const paths = list(req.paths).map(inside)
  if (paths.some(p => !p)) return { error: 'paths 只能写项目里的相对路径。' }
  return {
    id: checkId(now, checks),
    nodeIds,
    title,
    steps: list(req.steps).map(s => s.trim()).filter(Boolean).slice(0, 20),
    expect: str(req.expect).trim(),
    paths: paths.slice(0, 10),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...(taskId ? { taskId } : {}),
  }
}

                                                                                                        

// What the person does with a check on the canvas.
export function applyCheckAction(raw         , checks         , graph              , tasks        , now        , agent = 'Claude')               {
  const a = (raw && typeof raw === 'object' ? raw : {})                           
  const fail = (notice        )               => ({ notice, level: 'error' })
  const c = checks.find(x => x.id === a.id)
  if (!c) return fail('这项测试已经不在了。')
  const note = str(a.note).trim()
  const set = (status                 , extra                 = {}) =>
    checks.map(x => (x.id === c.id ? { ...x, ...extra, status, updatedAt: now } : x))

  switch (a.type) {
    case 'check-pass':
      return { checks: set('passed', note ? { note } : {}), notice: `已记为通过：${c.title}`, level: 'info' }
    case 'check-dismiss':
      return { checks: set('dismissed'), notice: `不用测了：${c.title}`, level: 'info' }
    case 'check-reopen':
      return { checks: set('open', { note: undefined }), notice: `放回待测试：${c.title}`, level: 'info' }
    case 'check-fail': {
      const next = set('failed', note ? { note } : {})
      if (a.toAgent !== true || !graph) return { checks: next, notice: `已记为没通过：${c.title}`, level: 'info' }
      // The failure goes back as a draft on the same modules, handed over with the rest.
      const made = commentTask(c.nodeIds[0], `测试没通过：${c.title}${note ? `。问题：${note}` : ''}`, now, tasks)
      if ('error' in made) return { checks: next, notice: `已记为没通过：${c.title}`, level: 'info' }
      const task = { ...made, nodeIds: c.nodeIds.filter(id => graph.nodes.some(n => n.id === id)) }
      return {
        checks: next,
        tasks: [...tasks, task],
        notice: `已记为没通过，并加入提议（草稿），点「交给 ${agent} 实施」时一起处理：${task.text}`,
        level: 'info',
      }
    }
  }
  return fail('这个操作没能识别，刷新画布后再试。')
}

// How a check reads to Claude in list_checks.
export function briefCheck(c       , graph              )         {
  const mods = c.nodeIds.map(id => (graph ? nameOf(graph, id) : id)).join('、')
  const lines = [`[${c.id}] ${CHECK_STATUS[c.status]}：${c.title}（${mods}）`]
  if (c.note) lines.push(`  - 用户写的：${c.note}`)
  return lines.join('\n')
}
