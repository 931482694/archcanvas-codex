// Generated from archcanvas/hooks/nodetypes.ts; edit source, then rebuild.
// Module types: what a module is (code, a data folder, a notebook, a Claude
// Code skill, a document, tests, a service outside the project). The type
// decides how the canvas draws a module, what implementing a new one means
// for Claude, and, for data, that its contents stay unread and unshown unless
// the person says otherwise. Pure.

                                                          

export const NODE_TYPES                      = ['code', 'data', 'notebook', 'skill', 'doc', 'test', 'external']

export const TYPE_LABEL                           = {
  code: '代码',
  data: '数据',
  notebook: 'Notebook',
  skill: 'Skill',
  doc: '文档',
  test: '测试',
  external: '外部服务',
}

export const DATA_FILE = /\.(csv|tsv|xlsx?|sav|dta|sas7bdat|parquet|feather|rds|rdata|h5|hdf5|npy|npz|nii|nii\.gz|dcm|mat|sqlite|db)$/i
const DATA_DIR = /(^|\/)(data|datasets?|raw|processed|inputs?)\/?$/i
const NOTEBOOK = /\.(ipynb|rmd|qmd)$/i
const SKILL = /(^|\/)\.claude\/skills\/|(^|\/)SKILL\.md$/i
const DOC = /\.(md|rst|txt|docx?|pdf)$/i
const TEST = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go|r)$|\.(test|spec)\.[cm]?[jt]sx?$/i

export const isType = (v         )                => typeof v === 'string' && (NODE_TYPES                     ).includes(v)

// A type for a module whose graph does not give one, from its files.
export function inferType(node                                    )           {
  const files = node.files
  if (!files.length) return /外部|external|api|第三方|云服务|服务器/i.test(node.kind ?? '') ? 'external' : 'code'
  if (files.some(f => SKILL.test(f))) return 'skill'
  if (files.every(f => NOTEBOOK.test(f))) return 'notebook'
  if (files.every(f => DATA_FILE.test(f) || DATA_DIR.test(f))) return 'data'
  if (files.every(f => TEST.test(f))) return 'test'
  if (files.every(f => DOC.test(f))) return 'doc'
  return 'code'
}

export const typeOf = (node           )           => (isType(node.type) ? node.type : inferType(node))

// Data is sensitive unless the person said it is not.
export const isSensitive = (node           )          => typeOf(node) === 'data' && node.sensitive !== false

// A data folder's README and other notes describe the data, and stay readable.
// Only notes: a README in a text format, or Markdown (not readme_patients.csv).
export const NOTES = /(^|\/)(readme([._-][^/]*)?\.(md|markdown|txt|rst)|readme|[^/]+\.(md|markdown))$/i

// The sensitive module a project path falls in (the path itself, or under one
// of the module's folders), if any; its notes excepted.
export function sensitiveOwner(graph       , rel        )                        {
  const norm = (p        ) => p.replace(/\\/g, '/').split('/').filter(x => x && x !== '.').join('/').toLowerCase()
  const f = norm(rel)
  if (NOTES.test(f)) return undefined
  return graph.nodes.find(
    n =>
      isSensitive(n) &&
      n.files.some(x => {
        const g = norm(x)
        return !g || f === g || f.startsWith(g + '/')
      }),
  )
}

export const SENSITIVE_RULE = '不要读取或打印里面文件的内容（患者记录等），只看目录结构；需要字段名时请用户提供，或写个只输出列名的脚本来运行。'

// What implementing a new module of each type means, as list_tasks tells Claude.
export const BUILD_HINT                           = {
  code: '写出这个模块的代码；完成时在 files 里写明它的源文件。',
  data: '这是数据模块：建好它的文件夹，写一份 README 说明数据的格式和字段，需要的话加上读取它的代码；不要编造或生成假数据。完成时 files 写这个文件夹（以 / 结尾）。',
  notebook: '建一个 Notebook（.ipynb，R 项目用 .Rmd）骨架，写清分析目的和步骤；完成时 files 写这个文件。',
  skill: '按 Claude Code skill 的格式写 .claude/skills/<名字>/SKILL.md：frontmatter 里有 name 和 description，description 写清什么时候用；完成时 files 写这个 skill 的文件夹。',
  doc: '写这份 Markdown 文档；完成时 files 写文档路径。',
  test: '为它依赖的模块写测试，并自己跑一遍；完成时 files 写测试文件。',
  external: '这是项目外的服务：写调用它的客户端或配置，密钥从环境变量读，不要写进代码；没有本地文件的话 files 可以留空。',
}
