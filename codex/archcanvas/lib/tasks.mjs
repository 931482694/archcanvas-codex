// Generated from archcanvas/hooks/tasks.ts; edit source, then rebuild.
// Tasks: what the person asks for in the pane (a comment on a module, or a
// change to the structure), and how a finished one changes the graph. Pure.

                                                                                                         
import { check, sourceText } from './graph.mjs'
import { KIND_WORD, drawnKind, edgeWords, endOf, wire } from './edges.mjs'
import { BUILD_HINT, SENSITIVE_RULE, TYPE_LABEL, isSensitive, isType, typeOf } from './nodetypes.mjs'

export const TASKS_PATH = '.archcanvas/tasks.json'

const OPEN = new Set(['draft', 'queued', 'working'])

export const isOpen = (t      ) => OPEN.has(t.status)

export function taskId(now        , taken                 )         {
  let n = 0
  let id = `t-${now.toString(36)}`
  while (taken.some(t => t.id === id)) id = `t-${now.toString(36)}-${++n}`
  return id
}

function base(kind          , now        , tasks                 ) {
  return { id: taskId(now, tasks), kind, status: 'draft'         , createdAt: now, updatedAt: now }
}

export function commentTask(nodeId        , text        , now        , tasks                 )                           {
  const body = text.trim()
  if (!body) return { error: '意见是空的。' }
  return { ...base('comment', now, tasks), nodeIds: [nodeId], text: body }
}

// A comment on a main line, or on one step of it (`step` from 0): the map's
// line is what is to change. Pinned to the step's module, so its card shows it.
export function flowCommentTask(flowId        , step                    , text        , graph       , now        , tasks                 )                           {
  const body = text.trim()
  if (!body) return { error: '意见是空的。' }
  const flow = graph.flows?.find(f => f.id === flowId)
  if (!flow) return { error: '这条主线已经不在了。' }
  if (step !== undefined && !(Number.isInteger(step) && step >= 0 && step < flow.steps.length)) return { error: '这一步已经不在了。' }
  const at = step === undefined ? undefined : flow.steps[step]
  const where = at ? `主线「${flow.name}」第 ${step  + 1} 步（${nameOf(graph, at.node)}）` : `主线「${flow.name}」`
  return {
    ...base('comment', now, tasks),
    nodeIds: at ? [at.node] : [],
    text: `${where}：${body}`,
    flow: { id: flow.id, name: flow.name, ...(at ? { step } : {}) },
  }
}

// A stable id for a new module: its ascii words if it has any, else a short
// counter. Claude may give a better one when it completes the task.
export function newNodeId(name        , graph       , tasks                 )         {
  const taken = new Set([...graph.nodes.map(n => n.id), ...tasks.flatMap(t => (t.node ? [t.node.id] : []))])
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const stem = ascii && /^[a-z0-9]/.test(ascii) ? ascii : 'module'
  let id = stem === 'module' ? 'module-1' : stem
  for (let n = 1; taken.has(id); n++) id = `${stem}-${n + 1}`
  return id
}

export function addNodeTask(form         , graph       , now        , tasks                 )                           {
  const name = form.name.trim()
  if (!name) return { error: '新模块要有名字。' }
  if (!graph.layers.some(l => l.id === form.layer)) return { error: '请选择新模块所在的分组。' }
  if (graph.nodes.some(n => n.name === name)) return { error: `已经有叫「${name}」的模块了。` }
  const type           = isType(form.type) ? form.type : 'code'
  // A data module may name its folder now; Claude names the files of the rest.
  const path = type === 'data' ? (form.path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '') : ''
  if (path && (/^([A-Za-z]:)?\//.test(path) || path.split('/').includes('..'))) return { error: '数据的路径要写项目里的相对路径，例如 data/raw/' }
  const sensitive = type === 'data' && form.sensitive !== false
  const node            = {
    id: newNodeId(name, graph, tasks),
    name,
    layer: form.layer,
    type,
    summary: form.summary.trim(),
    files: path ? [path] : [],
    ...(type === 'data' && !sensitive ? { sensitive: false } : {}),
  }
  const known = (id         ) => (id && graph.nodes.some(n => n.id === id) ? [id] : [])
  const deps = known(form.dependsOn)
  const users = known(form.usedBy)
  const place = placeIn(graph, form.flowStep)
  return {
    ...base('add-node', now, tasks),
    nodeIds: deps,
    text: addNodeText(node, deps, users, graph, place),
    node,
    ...(users.length ? { usedBy: users } : {}),
    ...(place ? { flowStep: place } : {}),
  }
}

// A place in a main line the map has, else none. When the line changed since
// and the step it follows (`node`) moved, the place follows that step.
function placeIn(graph       , p                              )                        {
  const flow = p && graph.flows?.find(f => f.id === p.flow)
  if (!flow || !Number.isInteger(p .after)) return undefined
  let after = p .after
  if (p .node && flow.steps[after]?.node !== p .node) {
    const moved = flow.steps.findIndex(s => s.node === p .node)
    if (moved >= 0) after = moved
  }
  if (after < -1 || after >= flow.steps.length) return undefined
  const node = flow.steps[after]?.node
  return { flow: flow.id, after, ...(node ? { node } : {}) }
}

// Where in a main line, in words.
function placeWords(graph       , p           )         {
  const flow = graph.flows?.find(f => f.id === p.flow)
  if (!flow) return ''
  const at = flow.steps[p.after]
  return at ? `主线「${flow.name}」第 ${p.after + 1} 步「${nameOf(graph, at.node)}」之后的一步` : `主线「${flow.name}」的第一步`
}

// How a proposed module is wired, in words: lines drawn out of it (`deps`)
// and into it (`users`), each said by what flows along it.
const WIRING                                        = [
  ['out:call', x => `调用${x}`],
  ['out:read', x => `供${x}读取`],
  ['out:write', x => `生成${x}`],
  ['out:link', x => `关联${x}`],
  ['in:call', x => `供${x}调用`],
  ['in:read', x => `读取${x}`],
  ['in:write', x => `由${x}生成`],
  ['in:link', x => `关联${x}`],
]

function addNodeText(node           , deps                   , users                   , graph       , place            )         {
  const type = typeOf(node)
  const what = type === 'code' ? '' : `（${TYPE_LABEL[type]}${isSensitive(node) ? '，敏感' : ''}）`
  const groups = new Map                  ()
  const put = (key        , id        ) => groups.set(key, [...(groups.get(key) ?? []), `「${nameOf(graph, id)}」`])
  for (const d of deps) put(`out:${drawnKind(type, endOf(graph, d).type)}`, d)
  for (const u of users) put(`in:${drawnKind(endOf(graph, u).type, type)}`, u)
  const wiring = WIRING.filter(([key]) => groups.has(key)).map(([key, say]) => `，${say(groups.get(key) .join('、'))}`)
  const step = place ? placeWords(graph, place) : ''
  return `新增模块「${node.name}」${what}${node.summary ? `：${node.summary}` : ''}${wiring.join('')}${step ? `，作为${step}` : ''}`
}

/** What the canvas may change on a proposed module before it is handed over. */
                           
               
                
                  
                 
               
                     
                                                       
                      
                                                             
                   
                                                                   
                             
 

// A proposed module changed on the canvas: the same task (id, time) with the
// new name, type, layer, description, folder or wiring.
export function editAddNodeTask(task      , change             , graph       , tasks                 )                           {
  if (task.kind !== 'add-node' || !task.node) return { error: '这不是新增模块的提议。' }
  if (task.status !== 'draft') return { error: '已经交出去的提议不能再改，可以先撤回再重新提。' }
  const node = task.node
  const remade = addNodeTask(
    {
      name: change.name ?? node.name,
      layer: change.layer ?? node.layer,
      summary: change.summary ?? node.summary,
      dependsOn: '',
      type: change.type ?? typeOf(node),
      path: change.path ?? node.files[0] ?? '',
      sensitive: change.sensitive ?? node.sensitive !== false,
    },
    graph,
    task.createdAt,
    tasks.filter(t => t.id !== task.id),
  )
  if ('error' in remade) return remade
  const known = (ids                   ) => [...new Set(ids)].filter(id => graph.nodes.some(n => n.id === id))
  const deps = known(change.dependsOn ?? task.nodeIds)
  const users = known(change.usedBy ?? task.usedBy ?? [])
  const place = placeIn(graph, change.flowStep === undefined ? task.flowStep : change.flowStep)
  const next            = { ...remade.node , id: node.id }
  const { usedBy: _, flowStep: __, ...rest } = task
  return {
    ...rest,
    nodeIds: deps,
    text: addNodeText(next, deps, users, graph, place),
    node: next,
    ...(users.length ? { usedBy: users } : {}),
    ...(place ? { flowStep: place } : {}),
  }
}

export function removeNodeTask(nodeId        , graph       , now        , tasks                 )                           {
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) return { error: '找不到这个模块。' }
  if (tasks.some(t => isOpen(t) && t.kind === 'remove-node' && t.nodeIds[0] === nodeId)) return { error: '已经提议删除这个模块了。' }
  return { ...base('remove-node', now, tasks), nodeIds: [nodeId], text: removeNodeText(node, graph) }
}

function removeNodeText(node           , graph       )         {
  const users = graph.edges.filter(e => e.to === node.id).map(e => nameOf(graph, e.from))
  return `删除模块「${node.name}」及其实现${users.length ? `（${users.join('、')} 用到它，需要一并调整）` : ''}`
}

// A line drawn on the canvas from one module to another, the way data flows.
export function addEdgeTask(from        , to        , graph       , now        , tasks                 )                           {
  if (from === to) return { error: '模块不能连到自己。' }
  if (!graph.nodes.some(n => n.id === from) || !graph.nodes.some(n => n.id === to)) return { error: '找不到这个模块。' }
  const edge = wire(endOf(graph, from), endOf(graph, to))
  const same = (e                              ) => (e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from)
  if (graph.edges.some(same)) return { error: '这两个模块之间已经有连线了；要改成别的意思，右键那条线。' }
  if (tasks.some(t => isOpen(t) && t.kind === 'add-edge' && t.edge && same(t.edge))) return { error: '已经提议过这条连线了。' }
  const said = edgeWords(graph, edge)
  return {
    ...base('add-edge', now, tasks),
    nodeIds: [edge.from, edge.to],
    text: `让${said.text}`,
    edge,
  }
}

export function removeEdgeTask(from        , to        , graph       , now        , tasks                 )                           {
  const edge = graph.edges.find(e => e.from === from && e.to === to)
  if (!edge) return { error: '这条连线不存在。' }
  if (tasks.some(t => isOpen(t) && t.kind === 'remove-edge' && t.edge?.from === from && t.edge.to === to)) return { error: '已经提议去掉这条连线了。' }
  const said = edgeWords(graph, edge)
  return {
    ...base('remove-edge', now, tasks),
    nodeIds: [from, to],
    text: `不再让${said.text}`,
    edge,
  }
}

// A structural task in today's words, from the map as it is now: tasks
// written before kept older words. The person's own comments stay as written.
export function freshText(task      , graph       )         {
  const known = (id        ) => graph.nodes.some(n => n.id === id)
  switch (task.kind) {
    case 'add-node':
      return task.node ? addNodeText(task.node, task.nodeIds.filter(known), (task.usedBy ?? []).filter(known), graph, placeIn(graph, task.flowStep)) : task.text
    case 'remove-node': {
      const node = graph.nodes.find(n => n.id === task.nodeIds[0])
      return node ? removeNodeText(node, graph) : task.text
    }
    case 'add-edge':
    case 'remove-edge': {
      if (!task.edge || !known(task.edge.from) || !known(task.edge.to)) return task.text
      return `${task.kind === 'add-edge' ? '让' : '不再让'}${edgeWords(graph, task.edge).text}`
    }
    default:
      return task.text
  }
}

export function nameOf(graph       , id        )         {
  return graph.nodes.find(n => n.id === id)?.name ?? id
}

                                                                                                                    

// The graph after a finished task: structure tasks change it, comments do not.
export function applyTask(graph       , task      , done            )                                       {
  let next        = graph
  switch (task.kind) {
    case 'comment':
      return { graph }
    case 'add-node': {
      if (!task.node) return { error: '这条提议里没有新模块的信息。' }
      const id = done.nodeId?.trim() || task.node.id
      // The map may have changed since: a group gone means the first one, wires to modules gone are dropped.
      const layer = graph.layers.some(l => l.id === task.node .layer) ? task.node.layer : (graph.layers[0]?.id ?? task.node.layer)
      const node            = {
        ...task.node,
        id,
        layer,
        summary: task.node.summary || done.summary || '',
        // Claude's list wins; a data module keeps the folder named when it was proposed.
        files: (done.files?.length ? done.files : task.node.files).map(f => f.replace(/\\/g, '/')),
        ...(done.sources?.length ? { sources: done.sources } : {}),
        ...(done.at ? { seenAt: done.at } : {}),
        // The person said whether the data is sensitive when they proposed it.
        ...(typeOf(task.node) === 'data' ? { pins: [...new Set([...(task.node.pins ?? []), 'sensitive'         ])] } : {}),
      }
      next = {
        ...graph,
        nodes: [...graph.nodes, node],
        edges: [
          ...graph.edges,
          ...task.nodeIds.filter(d => d !== id && graph.nodes.some(n => n.id === d)).map(d => wire({ id, type: typeOf(node) }, endOf(graph, d))),
          ...(task.usedBy ?? []).filter(u => u !== id && graph.nodes.some(n => n.id === u)).map(u => wire(endOf(graph, u), { id, type: typeOf(node) })),
        ],
      }
      // Proposed as a step of a main line: it goes in there, once it exists.
      const place = placeIn(graph, task.flowStep)
      if (place) {
        const label = (node.summary || '').split(/[。\n]/)[0].trim()
        const step = { node: id, ...(label ? { label } : {}) }
        next = {
          ...next,
          flows: (next.flows ?? []).map(f => (f.id === place.flow ? { ...f, steps: [...f.steps.slice(0, place.after + 1), step, ...f.steps.slice(place.after + 1)] } : f)),
        }
      }
      break
    }
    case 'remove-node': {
      const id = task.nodeIds[0]
      next = { ...graph, nodes: graph.nodes.filter(n => n.id !== id), edges: graph.edges.filter(e => e.from !== id && e.to !== id) }
      break
    }
    case 'add-edge':
      if (!task.edge) return { error: '这条提议里没有连线的信息。' }
      if (graph.edges.some(e => e.from === task.edge .from && e.to === task.edge .to)) return { graph }
      // An end removed since: nothing left to draw.
      if (![task.edge.from, task.edge.to].every(id => graph.nodes.some(n => n.id === id))) return { graph }
      next = { ...graph, edges: [...graph.edges, done.sources?.length ? { ...task.edge, sources: done.sources } : task.edge] }
      break
    case 'remove-edge':
      if (!task.edge) return { error: '这条提议里没有连线的信息。' }
      next = { ...graph, edges: graph.edges.filter(e => !(e.from === task.edge .from && e.to === task.edge .to)) }
      break
  }
  // The modules a line was drawn or taken between were just looked at in the code.
  if (done.at && task.edge && (task.kind === 'add-edge' || task.kind === 'remove-edge')) {
    const ends = new Set([task.edge.from, task.edge.to])
    next = { ...next, nodes: next.nodes.map(n => (ends.has(n.id) ? { ...n, seenAt: done.at } : n)) }
  }
  const checked = check(next)
  return 'error' in checked ? { error: checked.error } : { graph: checked.graph }
}

export const KIND_LABEL                           = {
  comment: '意见',
  'add-node': '新增模块',
  'remove-node': '删除模块',
  'add-edge': '新增连线',
  'remove-edge': '去掉连线',
}

export const STATUS_LABEL                                 = {
  draft: '草稿',
  queued: '已交给 Claude',
  working: 'Claude 正在做',
  done: '已完成',
  cancelled: '已取消',
}

// What a line asks of the code, and what taking it away asks.
const EDGE_DO = {
  call: '在代码里让前者真正调用后者',
  read: '在代码里让这个模块读取这份资料：只读，不改动资料本身',
  write: '让这个模块把结果写到这份资料里：写之前确认位置和格式，不要覆盖原始数据',
  link: '在说明里写清这两份资料的关系',
}         
const EDGE_UNDO = {
  call: '在代码里解除这处调用或导入，必要时改成别的实现',
  read: '在代码里去掉对这份资料的读取，必要时改成读别的',
  write: '让这个模块不再写这份资料，已经写出的内容先别删，问过我再说',
  link: '在说明里去掉两者的关联',
}         

// How a task reads to Claude in list_tasks.
export function brief(task      , graph       )         {
  const lines = [`[${task.id}] ${KIND_LABEL[task.kind]}（${STATUS_LABEL[task.status]}）：${task.text}`]
  for (const id of task.nodeIds) {
    const n = graph.nodes.find(x => x.id === id)
    if (!n) continue
    lines.push(`  - 模块 ${n.id}「${n.name}」（${TYPE_LABEL[typeOf(n)]}），文件：${n.files.join('、') || '（无）'}`)
    if (isSensitive(n)) lines.push(`  - 「${n.name}」是敏感数据：${SENSITIVE_RULE}`)
  }
  if (task.kind === 'add-node' && task.node) {
    const t = typeOf(task.node)
    const where = task.node.files.length ? `，位置：${task.node.files.join('、')}` : ''
    lines.push(`  - 新模块 id 建议：${task.node.id}，类型：${TYPE_LABEL[t]}，所在分组：${task.node.layer}${where}${task.node.summary ? `，说明：${task.node.summary}` : ''}`)
    lines.push(`  - ${BUILD_HINT[t]}`)
    for (const u of task.usedBy ?? []) {
      const k = drawnKind(endOf(graph, u).type, t)
      const who = `「${nameOf(graph, u)}」`
      lines.push(
        k === 'write'
          ? `  - 它由${who}生成：实现后让${who}真正把结果写到这里`
          : k === 'read'
            ? `  - 它要读取${who}：只读，不改动${who}`
            : k === 'link'
              ? `  - 它和${who}是一组资料：在说明里写清两者的关系`
              : `  - ${who}要调用它：实现后让${who}真正用上它`,
      )
    }
    if (isSensitive(task.node)) lines.push(`  - 它是敏感数据：${SENSITIVE_RULE}`)
  }
  if (task.flow) {
    const flow = graph.flows?.find(f => f.id === task.flow .id)
    if (flow) {
      const mark = (i        ) => (i === task.flow .step ? '（← 说的是这一步）' : '')
      lines.push(`  - 主线「${flow.name}」（id ${flow.id}）现在是：`)
      flow.steps.forEach((st, i) => lines.push(`    ${i + 1}. ${nameOf(graph, st.node)}（${st.node}）${st.label ? `：${st.label}` : ''}${mark(i)}`))
    } else {
      lines.push(`  - 主线「${task.flow.name}」已经不在图上了，看看意见是否还用得上`)
    }
    lines.push('  - 这条只改架构图的主线：读相关代码核对，用 read_graph 读出整张图，改好 flows 里这条主线后用 save_graph 保存（模块、分组、连线不动，不改代码），再 complete_task')
  }
  if (task.kind === 'remove-node') lines.push('  - 删除前先找出所有调用方并一并调整；确实删掉代码后再 complete_task')
  if (task.kind === 'remove-edge') {
    lines.push(`  - ${EDGE_UNDO[task.edge ? edgeWords(graph, task.edge).kind : 'call']}`)
    const saved = task.edge && graph.edges.find(e => e.from === task.edge .from && e.to === task.edge .to)
    if (saved?.sources?.length) lines.push(`  - 代码依据：${saved.sources.map(sourceText).join('；')}`)
  }
  if (task.kind === 'add-edge') {
    lines.push(`  - ${EDGE_DO[task.edge ? edgeWords(graph, task.edge).kind : 'call']}`)
    lines.push('  - 完成时在 complete_task 的 sources 里写上这处调用、读取或写入在代码里的位置（文件和行号）')
  }
  if (task.kind === 'add-node') lines.push('  - 完成时在 complete_task 的 sources 里写上它主要的实现位置（文件和行号）')
  const place = task.kind === 'add-node' ? placeIn(graph, task.flowStep) : undefined
  if (place) lines.push(`  - 它是${placeWords(graph, place)}：实现时让它在流程里真的处在这个位置；complete_task 后会自动把它插进主线，不用自己改 flows`)
  return lines.join('\n')
}
