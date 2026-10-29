import fs from 'node:fs'
import { applyTask, brief } from '../lib/tasks.mjs'
import { describe } from '../lib/graph.mjs'
import { reopened } from '../lib/privacy.mjs'
import { projectPath } from './paths.mjs'
import { load, saveTasks, record, transaction, withProjectLock, readJson } from './store.mjs'
import { takeSnapshot, changesSince, dropSnapshot } from './snapshot.mjs'

const said = s => s.replace(/Claude/g, 'Codex').replace(/\.claude\/skills/g, '.agents/skills')
function owned(task, session) {
  if (task.sessionId && task.sessionId !== session) throw new Error('这项待办属于另一个会话，请先在原会话完成或由用户取消')
}
export function startTask(root, id, session) {
  return withProjectLock(root, () => {
    const { graph, tasks } = load(root)
    const task = tasks.find(t => t.id === id)
    if (!task || !graph) throw new Error(`找不到待办 ${id}`)
    if (task.status === 'draft') throw new Error('草稿还没有交付，不能开始')
    if (task.status === 'working') { owned(task, session); return `已经在实施：${task.text}` }
    if (task.status !== 'queued') throw new Error('这项待办已结束，不能开始')
    if (tasks.some(t => t.status === 'working')) throw new Error('另有待办正在实施，请先完成或释放')
    takeSnapshot(root, id)
    saveTasks(root, tasks.map(t => t.id === id ? { ...t, status: 'working', sessionId: session, updatedAt: Date.now() } : t))
    return `已开始：${task.text}\n${said(brief({ ...task, status: 'working' }, graph))}`
  })
}
export function completeTask(root, id, args, session) {
  return withProjectLock(root, () => {
    const { graph, tasks, history } = load(root)
    const task = tasks.find(t => t.id === id)
    if (!task || !graph) throw new Error(`找不到待办 ${id}`)
    owned(task, session)
    if (task.status === 'done') { dropSnapshot(root, id); return `待办 ${id} 已经完成。` }
    if (task.status !== 'working') throw new Error('请先开始已交付的待办，再完成它')
    const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
    if (!summary) throw new Error('summary 必须写明做了什么')
    for (const f of args.files ?? []) projectPath(root, f)
    const applied = applyTask(graph, task, { files: args.files, nodeId: args.node_id, summary, sources: args.sources, at: Date.now() })
    if ('error' in applied) throw new Error(applied.error)
    if (reopened(graph, applied.graph).length) throw new Error('不能解除敏感数据保护')
    const diff = changesSince(root, id) ?? []
    const next = record(root, diff, { tool: 'Codex', sessionId: session, toolUseId: `snapshot-${id}`, preview: true })
    let kept = next.history
    if (task.kind === 'add-node' && args.node_id && task.node?.id !== args.node_id) kept = kept.map(c => ({ ...c, nodeIds: [...new Set(c.nodeIds.map(n => n === task.node.id ? args.node_id : n))] }))
    const files = { 'graph.json': applied.graph, 'history.json': kept, 'tasks.json': tasks.map(t => t.id === id ? { ...t, status: 'done', summary, updatedAt: Date.now() } : t) }
    const pending = readJson(root, '.archcanvas/pending.json')
    if (pending?.graph && applied.graph !== graph) {
      const waiting = applyTask(pending.graph, task, { files: args.files, nodeId: args.node_id, summary, sources: args.sources, at: Date.now() })
      if ('error' in waiting || reopened(applied.graph, waiting.graph).length) throw new Error('待确认的新图无法合并本项改动，请先在画布上采用或保留当前图，再重试完成')
      files['pending.json'] = { ...pending, graph: waiting.graph }
    }
    transaction(root, files)
    dropSnapshot(root, id)
    return [`已完成：${task.text}`, `架构图已更新：${describe(applied.graph)}。`, next.count ? `按开始前后的文件对比，补记了 ${next.count} 处修改。` : '修改记录已保留。'].join('\n')
  })
}
export function releaseTask(root, id, reason, session) {
  return withProjectLock(root, () => {
    const { tasks } = load(root)
    const task = tasks.find(t => t.id === id)
    if (!task) throw new Error('找不到待办')
    owned(task, session)
    if (!['working', 'queued'].includes(task.status)) throw new Error('只能释放正在实施或排队的待办')
    if (!String(reason ?? '').trim()) throw new Error('请说明退回原因')
    saveTasks(root, tasks.map(t => { if (t !== task) return t; const { sessionId, announced, ...rest } = t; return { ...rest, status: 'draft', summary: String(reason).trim(), updatedAt: Date.now() } }))
    dropSnapshot(root, id)
    return '已放回用户草稿，已有代码改动保留。'
  })
}
