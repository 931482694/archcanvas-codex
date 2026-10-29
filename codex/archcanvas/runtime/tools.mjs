import fs from 'node:fs'
import { mapIndex } from '../lib/graph.mjs'
import { movedTo } from '../lib/relocate.mjs'
import { brief } from '../lib/tasks.mjs'
import { makeCheck, briefCheck } from '../lib/checks.mjs'
import { auditSummary, auditLines } from '../lib/audit.mjs'
import { load, readJson, writeJson, withProjectLock } from './store.mjs'
import { saveProjectGraph, updateProjectGraph } from './project.mjs'
import { startTask, completeTask, releaseTask } from './tasks.mjs'
import { sessionOf, recordResult, ensureEntry, saveLog } from './worklog.mjs'
import { addLink, addMap } from '../lib/worklog.mjs'
import { projectPath } from './paths.mjs'

const said = s => s.replace(/Claude/g, 'Codex').replace(/\.claude\/skills/g, '.agents/skills')
export function callProjectTool(root, name, args) {
  return withProjectLock(root, () => {
    const { graph, tasks, checks } = load(root)
    const session = sessionOf(root, args.session_id)
    if (name === 'save_graph' || name === 'update_graph') {
      const text = name === 'save_graph' ? saveProjectGraph(root, args) : updateProjectGraph(root, args)
      const id = ensureEntry(root, session)
      saveLog(root, addMap(load(root).worklog, id, [name === 'save_graph' ? '保存或提议重画架构图' : '局部更新架构图']))
      return text
    }
    if (name === 'read_graph') {
      if (!graph) return '这个项目还没有架构图。'
      const found = readJson(root, '.archcanvas/audit.json')
      const pending = readJson(root, '.archcanvas/pending.json')
      const now = found?.moved?.length ? movedTo(graph, found.moved) : graph
      return [args.brief ? mapIndex(now) : JSON.stringify(now), `（读自 ${projectPath(root, '.archcanvas/graph.json')}）`, pending?.graph ? '另有新图等待用户确认。' : '', found ? [auditSummary(found), ...auditLines(found, graph, 8)].join('\n') : ''].filter(Boolean).join('\n')
    }
    if (name === 'list_tasks') {
      const handed = tasks.filter(t => ['queued', 'working'].includes(t.status))
      return handed.length ? ['已交给 Codex 的待办：', ...handed.map(t => said(brief(t, graph))), '按用户已有授权处理；草稿不要处理。'].join('\n') : `没有交给你的待办${tasks.some(t => t.status === 'draft') ? '（另有尚未交付的草稿）' : ''}。`
    }
    if (name === 'start_task') return startTask(root, args.id, session)
    if (name === 'complete_task') return completeTask(root, args.id, args, session)
    if (name === 'release_task') return releaseTask(root, args.id, args.reason, session)
    if (name === 'request_check') {
      if (!graph) throw new Error('这个项目还没有架构图')
      for (const p of args.paths ?? []) projectPath(root, p)
      const task = tasks.find(t => t.status === 'working' && t.sessionId === session)
      const out = makeCheck(args, graph, Date.now(), checks, task?.id)
      if ('error' in out) throw new Error(out.error)
      writeJson(root, '.archcanvas/checks.json', [...checks, out])
      const id = ensureEntry(root, session)
      saveLog(root, addLink(load(root).worklog, id, { checkId: out.id }))
      return `已请用户测试：[${out.id}] ${out.title}`
    }
    if (name === 'list_checks') return checks.length ? checks.map(c => said(briefCheck(c, graph))).join('\n') : '没有人工测试事项。'
    if (name === 'record_result') return recordResult(root, args)
    throw new Error(`没有这个工具：${name}`)
  })
}
