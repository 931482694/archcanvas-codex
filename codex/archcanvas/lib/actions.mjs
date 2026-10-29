// Generated from archcanvas/hooks/actions.ts; edit source, then rebuild.
// What the canvas page asks for, and what the mod should do about it. Pure:
// the mod writes the tasks or the graph and submits the prompt.

import { pin } from './merge.mjs'
                                                      
import { check } from './graph.mjs'
import { nodesForFile } from './history.mjs'
import { endOf, isEdgeKind, kindsBetween, KIND_WORD } from './edges.mjs'
import { addLayer, moveNode, removeLayer, renameLayer } from './layers.mjs'
import { isType, typeOf } from './nodetypes.mjs'
import {                   addEdgeTask, addNodeTask, commentTask, editAddNodeTask, flowCommentTask, isOpen, nameOf, removeEdgeTask, removeNodeTask } from './tasks.mjs'

                             
                                                
                
                                                                        
                                                             
               
                                        
                
                         
                                               
                   
                                                              
                 
                                                                             
                 
                                                                                            
              
                                                                                               
                    
 

const str = (v         ) => (typeof v === 'string' ? v : '')

// A place in a main line as the page sends it; checked against the map when used.
function placeOf(v         )                        {
  const o = (v && typeof v === 'object' ? v : null)                                                              
  return o && typeof o.flow === 'string' && typeof o.after === 'number' ? { flow: o.flow, after: o.after, ...(typeof o.node === 'string' ? { node: o.node } : {}) } : undefined
}

// `agent` names who the tasks go to in what the page is told.
export function applyAction(raw         , graph              , tasks        , now        , agent = 'Claude')                {
  const a = (raw && typeof raw === 'object' ? raw : {})                           
  const fail = (notice        )                => ({ notice, level: 'error' })
  if (a.type === 'generate') return { generate: true, notice: `已让 ${agent} 读代码、生成架构图，进度在 ${agent} 的对话里。`, level: 'info' }
  if (!graph) return fail('这个项目还没有架构图。')
  if (a.type === 'evidence') return { evidence: true, notice: `已让 ${agent} 找出每条连线在代码里的位置，进度在 ${agent} 的对话里。`, level: 'info' }
  if (a.type === 'flows') return { flows: true, notice: `已让 ${agent} 按执行顺序画出主线，进度在 ${agent} 的对话里。`, level: 'info' }
  if (a.type === 'recheck') {
    const ids = Array.isArray(a.nodeIds) ? a.nodeIds.filter((x)              => typeof x === 'string' && graph.nodes.some(n => n.id === x)) : []
    if (!ids.length) return fail('没有要核对的模块。')
    return { recheck: ids, notice: `已让 ${agent} 核对 ${ids.length} 个模块，进度在 ${agent} 的对话里。`, level: 'info' }
  }

  const added = (made                          )                =>
    'error' in made ? fail(made.error) : { tasks: [...tasks, made], notice: `已加入提议：${made.text}`, level: 'info' }

  switch (a.type) {
    case 'comment':
      return added(commentTask(str(a.nodeId), str(a.text), now, tasks))
    case 'flow-comment':
      return added(flowCommentTask(str(a.flowId), typeof a.step === 'number' ? a.step : undefined, str(a.text), graph, now, tasks))
    case 'add-node':
      return added(
        addNodeTask(
          {
            name: str(a.name),
            layer: str(a.layer),
            summary: str(a.summary),
            dependsOn: str(a.dependsOn),
            usedBy: str(a.usedBy),
            type: isType(a.nodeType) ? a.nodeType : 'code',
            path: str(a.path),
            sensitive: a.sensitive !== false,
            ...(placeOf(a.flowStep) ? { flowStep: placeOf(a.flowStep) } : {}),
          },
          graph,
          now,
          tasks,
        ),
      )
    case 'add-layer': {
      const made = addLayer(graph, str(a.name))
      if ('error' in made) return fail(made.error)
      return { graph: made.graph, notice: `已新建分组「${str(a.name).trim()}」。`, level: 'info' }
    }
    case 'rename-layer': {
      const made = renameLayer(graph, str(a.layerId), str(a.name))
      return 'error' in made ? fail(made.error) : { graph: made.graph, notice: '', level: 'info' }
    }
    case 'remove-layer': {
      const name = graph.layers.find(l => l.id === a.layerId)?.name
      const made = removeLayer(graph, str(a.layerId), tasks)
      return 'error' in made ? fail(made.error) : { graph: made.graph, notice: `已删除空的分组「${name}」。`, level: 'info' }
    }
    case 'move-node': {
      const node = graph.nodes.find(n => n.id === a.nodeId)
      const made = moveNode(graph, str(a.nodeId), str(a.layer))
      if ('error' in made) return fail(made.error)
      const to = graph.layers.find(l => l.id === a.layer)?.name
      return { graph: made.graph, notice: `已把「${node?.name}」移到「${to}」（只改架构图，不动代码）。`, level: 'info' }
    }
    case 'edit-add-node': {
      // A proposed module edited on its card before it is handed over.
      const t = tasks.find(x => x.id === a.taskId)
      if (!t) return fail('这条提议已经不在了。')
      const ids = (v         ) => (Array.isArray(v) ? v.filter((x)              => typeof x === 'string') : undefined)
      const change              = {
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
        ...(typeof a.layer === 'string' ? { layer: a.layer } : {}),
        ...(typeof a.summary === 'string' ? { summary: a.summary } : {}),
        ...(isType(a.nodeType) ? { type: a.nodeType } : {}),
        ...(typeof a.path === 'string' ? { path: a.path } : {}),
        ...(typeof a.sensitive === 'boolean' ? { sensitive: a.sensitive } : {}),
        ...(ids(a.dependsOn) ? { dependsOn: ids(a.dependsOn) } : {}),
        ...(ids(a.usedBy) ? { usedBy: ids(a.usedBy) } : {}),
        ...(a.flowStep === null ? { flowStep: null } : placeOf(a.flowStep) ? { flowStep: placeOf(a.flowStep) } : {}),
      }
      const made = editAddNodeTask(t, change, graph, tasks)
      if ('error' in made) return fail(made.error)
      // The card shows the change; no word needed.
      return { tasks: tasks.map(x => (x.id === t.id ? { ...made, updatedAt: now } : x)), notice: '', level: 'info' }
    }
    case 'mark-seen': {
      // The person looked: this module still matches its code.
      const node = graph.nodes.find(n => n.id === a.nodeId)
      if (!node) return fail('找不到这个模块。')
      return { graph: { ...graph, nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, seenAt: now } : n)) }, notice: `「${node.name}」已标为核对过。`, level: 'info' }
    }
    case 'set-sensitive': {
      // Whether a data module's contents may be shown and read: the person's call, made at once.
      const node = graph.nodes.find(n => n.id === a.nodeId)
      if (!node || typeOf(node) !== 'data') return fail('只有数据模块能设置是否敏感。')
      const sensitive = a.sensitive !== false
      const checked = check({
        ...graph,
        nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, type: 'data', sensitive, pins: pin(n.pins, 'sensitive') } : n)),
      })
      if ('error' in checked) return fail(checked.error)
      return {
        graph: checked.graph,
        notice: sensitive
          ? `「${node.name}」已标为敏感：画布不显示里面的文件，${agent} 直接查看里面内容会被拒绝。`
          : `「${node.name}」已标为不敏感：画布会显示里面的文件，${agent} 可以读取内容。`,
        level: 'info',
      }
    }
    case 'confirm-sensitive': {
      // The person looked over the data Claude found and left each as it is.
      const ids = new Set(Array.isArray(a.nodeIds) ? a.nodeIds.filter((x)              => typeof x === 'string') : [])
      const nodes = graph.nodes.filter(n => ids.has(n.id) && typeOf(n) === 'data')
      if (!nodes.length) return fail('没有要确认的数据模块。')
      return {
        graph: { ...graph, nodes: graph.nodes.map(n => (nodes.includes(n) ? { ...n, pins: pin(n.pins, 'sensitive') } : n)) },
        notice: `已确认 ${nodes.length} 处数据：${nodes.filter(n => n.sensitive !== false).length} 处敏感。`,
        level: 'info',
      }
    }
    case 'remove-node':
      return added(removeNodeTask(str(a.nodeId), graph, now, tasks))
    case 'add-edge':
      return added(addEdgeTask(str(a.from), str(a.to), graph, now, tasks))
    case 'remove-edge':
      return added(removeEdgeTask(str(a.from), str(a.to), graph, now, tasks))
    case 'set-edge-kind': {
      // What a line means (reading or making) is the map's own reading of the
      // code: corrected at once, no code changes.
      const edge = graph.edges.find(e => e.from === a.from && e.to === a.to)
      if (!edge) return fail('这条连线不存在。')
      if (!isEdgeKind(a.kind) || !kindsBetween(endOf(graph, edge.from).type, endOf(graph, edge.to).type).includes(a.kind)) return fail('这两个模块之间不能这样连。')
      const kind = a.kind
      const checked = check({ ...graph, edges: graph.edges.map(e => (e === edge ? { ...e, kind, pins: pin(e.pins, 'kind') } : e)) })
      if ('error' in checked) return fail(checked.error)
      return { graph: checked.graph, notice: `这条线改成了「${KIND_WORD[kind]}」（只改架构图，不动代码）。`, level: 'info' }
    }
    case 'vouch-edge': {
      // The person's word that a line is there though the code check cannot
      // see it (an object passed in, a call over the network), or taking it
      // back: the check leaves the line alone while it stands.
      const edge = graph.edges.find(e => e.from === a.from && e.to === a.to)
      if (!edge) return fail('这条连线不存在。')
      const why = str(a.why).trim().slice(0, 80)
      if (!why && !edge.vouched) return fail('这条线没有标过「已核实」。')
      const { vouched: _, ...rest } = edge
      // `where`: the file that hands the one to the other, when that is how it was found.
      const vouched = { why, by: 'person'         , at: now, ...(a.where && typeof a.where === 'object' ? { where: a.where } : {}) }
      const checked = check({ ...graph, edges: graph.edges.map(e => (e === edge ? (why ? { ...rest, vouched } : rest) : e)) })
      if ('error' in checked) return fail(checked.error)
      const again = why && edge.vouched?.why === why
      return {
        graph: checked.graph,
        notice: !why ? '已取消「已核实」，代码核对会重新检查这条线。' : again ? '已重新确认：这条线还在。' : `已确认这条线存在（${why}），代码核对不再报它。`,
        level: 'info',
      }
    }
    case 'cancel': {
      const t = tasks.find(x => x.id === a.taskId)
      if (!t || !isOpen(t)) return fail('这条提议已经不在了。')
      // One being worked on can be stopped too (the page asks first): what is done stays done.
      return {
        tasks: tasks.map(x => (x.id === t.id ? { ...x, status: 'cancelled'         , updatedAt: now } : x)),
        notice: t.status === 'working' ? `已取消：${t.text}（${agent} 已经做的改动不会撤回）` : `已取消：${t.text}`,
        level: 'info',
      }
    }
    case 'handover': {
      if (!tasks.some(t => t.status === 'draft')) return fail(`没有要交给 ${agent} 的提议。`)
      // A draft Claude gave back loses its reason once handed over again.
      const next = tasks.map(t => {
        if (t.status !== 'draft') return t
        const { summary: _, ...rest } = t
        return { ...rest, status: 'queued'         , updatedAt: now }
      })
      const n = next.filter(t => t.status === 'queued').length
      const lines = next.filter(t => t.status === 'queued' && t.flow).length
      const then = lines >= n ? '它会读代码核对后直接改好主线，不动代码。' : '它会先在对话里给出实施计划，你确认后才改代码。'
      return { tasks: next, handover: n, notice: `已把 ${n} 条提议交给 ${agent}。${then}`, level: 'info' }
    }
    case 'assign-file':
    case 'unassign-file': {
      const file = str(a.path).replace(/\\/g, '/').replace(/^\.\//, '')
      const node = graph.nodes.find(n => n.id === a.nodeId)
      if (!file || !node) return fail('找不到这个文件或模块。')
      const listed = node.files.some(f => f.toLowerCase() === file.toLowerCase())
      let files          
      if (a.type === 'assign-file') {
        if (nodesForFile(graph, file).includes(node.id)) return fail(`${file} 已经属于「${node.name}」。`)
        files = [...node.files, file]
      } else {
        if (!listed) return fail(`${file} 是因为所在文件夹归在「${node.name}」下的，要移出请改那个文件夹。`)
        files = node.files.filter(f => f.toLowerCase() !== file.toLowerCase())
      }
      const checked = check({ ...graph, nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, files, pins: pin(n.pins, 'files') } : n)) })
      if ('error' in checked) return fail(checked.error)
      return {
        graph: checked.graph,
        notice: a.type === 'assign-file' ? `已把 ${file} 归到「${nameOf(graph, node.id)}」。` : `已把 ${file} 从「${nameOf(graph, node.id)}」移出。`,
        level: 'info',
      }
    }
  }
  return fail('这个操作没能识别，刷新画布后再试。')
}
