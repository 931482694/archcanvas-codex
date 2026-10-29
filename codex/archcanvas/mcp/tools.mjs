// Tool metadata describes the shared graph format explicitly, so Codex can
// supply main lines, code evidence and resource directions without guessing.
const string = { type: 'string' }
const strings = { type: 'array', items: string }
const object = (properties, required = []) => ({ type: 'object', properties, required })
const array = items => ({ type: 'array', items })
const source = object({ path: string, line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path'])
const sources = array(source)
const layer = object({ id: string, name: string, description: string }, ['id', 'name'])
const node = object({ id: string, name: string, layer: string, type: { type: 'string', enum: ['code', 'data', 'notebook', 'skill', 'doc', 'test', 'external'] }, kind: string, summary: string, details: string, files: strings, sources, sensitive: { type: 'boolean' } }, ['id', 'name', 'layer', 'summary'])
const edge = object({ from: string, to: string, kind: { type: 'string', enum: ['call', 'read', 'write', 'link'] }, label: string, sources, vouch: string }, ['from', 'to'])
const flow = object({ id: string, name: string, steps: array(object({ node: string, label: string }, ['node', 'label'])) }, ['name', 'steps'])
const common = { project: { type: 'string', description: '当前项目根目录的绝对路径；多个项目时必须明确提供。' }, session_id: { type: 'string', description: '可选的当前 Codex 会话 id；用于待办归属和工作记录。' } }
const tool = (name, title, description, props = {}, required = [], readOnly = false) => ({ name, description, inputSchema: object({ ...common, ...props }, required), annotations: { title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } })
export const TOOLS = [
  tool('open_canvas', '打开架构画布', '在本机浏览器打开架构画布。返回的链接可在 Codex 内置浏览器打开。'),
  tool('save_graph', '保存架构图', '保存完整架构图。重画的结构变化等待用户在画布上确认；保留用户的分组、文件归属和敏感设置。先读代码：3–6 分组、5–40 模块；模块 type 明确标代码/数据等，新的数据保持敏感。sources 写真正调用或读写的文件与行号，不编造依据。read/write 连线 from 写做事模块、to 写资料。flows 写 1–3 条真实执行主线，每条 5–15 步，调度模块只在开头列一次。省略 flows 会保留原主线。', { title: string, layers: array(layer), nodes: array(node), edges: array(edge), flows: array(flow) }, ['layers', 'nodes']),
  tool('read_graph', '读取架构图', '读取当前图、代码核对与待确认提示。brief: true 只列模块与主线目录，便于 update_graph。', { brief: { type: 'boolean' } }, [], true),
  tool('update_graph', '局部更新架构图', '只写变化：增减节点/文件/连线，或更新主线。用户固定的归属和敏感状态受保护；存在文件的模块不能直接删除。change_nodes 的 files 整组替换，add_files/remove_files 增减。change_edges 的 vouch 为代码中确认但扫描无法识别的原因，空字符串撤回；不能改用户确认。', { add_layers: array(layer), add_nodes: array(node), change_nodes: array(object({ ...node.properties, add_files: strings, remove_files: strings }, ['id'])), remove_nodes: strings, add_edges: array(edge), change_edges: array(edge), remove_edges: array(object({ from: string, to: string }, ['from', 'to'])), flows: array(flow) }),
  tool('list_tasks', '列出已交付待办', '仅处理用户已在画布交付的待办；草稿不是授权。按当前用户已有授权执行；开始前 start_task，完成后 complete_task，做不了 release_task。', {}, [], true),
  tool('start_task', '开始待办', '开始一项已交付待办，建立项目内源文件快照。重复开始不覆盖快照；一个项目同时仅一项实施中。', { id: string }, ['id']),
  tool('complete_task', '完成待办', '完成属于当前会话的 working 待办。写 summary；新增模块必须给真实 files，可以用 node_id 指定最终 id。补记脚本修改，原子更新图/历史/任务状态；可安全重试。', { id: string, summary: string, files: strings, node_id: string, sources }, ['id', 'summary']),
  tool('release_task', '退回待办', '当前无法继续时，把已交付待办退回用户草稿并写明原因；代码改动保留。', { id: string, reason: string }, ['id', 'reason']),
  tool('request_check', '请用户测试', '仅为自己无法验证的项目行为留人工测试事项；写清操作步骤和期望结果。能自动验证的先自己验证。', { nodes: strings, title: string, steps: strings, expect: string, paths: strings }, ['nodes', 'title']),
  tool('list_checks', '读取人工测试结果', '列出用户测试结果及反馈。', {}, [], true),
  tool('record_result', '记录汇总结论', '得出关键结果时写一句汇总结论和结果 files；不要写姓名、病历号或个体数据。', { summary: string, files: strings }, ['summary']),
]
export function validate(value, schema, location = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} 必须是对象`)
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${location}.${key} 缺失`)
    for (const [key, v] of Object.entries(value)) if (schema.properties?.[key]) validate(v, schema.properties[key], `${location}.${key}`)
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${location} 必须是数组`)
    value.forEach((v, i) => validate(v, schema.items, `${location}[${i}]`))
  } else if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`${location} 类型不正确`)
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location} 值不合法`)
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${location} 超出范围`)
}
