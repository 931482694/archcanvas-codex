// Generated from archcanvas/hooks/mask.ts; edit source, then rebuild.
// Identifiers in what a command printed, masked before Claude reads it:
// resident ID card numbers, mobile phone numbers, and record numbers in the
// formats the person gave for the project (by example: ZY20240001 stands
// for ZY and eight digits). The output itself is never kept. Pure.

export const MASK_PATH = '.archcanvas/mask.json'

/** A record-number format: what it is called, and an example of it (or `re:` and a pattern). */
                                                           

                                                                      

export const DEFAULT_MASK               = { enabled: true, formats: [] }

// Not part of a longer run of letters or digits.
const L = '(?<![0-9A-Za-z])'
const R = '(?![0-9A-Za-z])'
const DATE = '(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])'
const BUILT_IN                                  = [
  // 18 digits (the last may be X) with a birth date in the middle; the old 15-digit form.
  { label: '身份证号', re: new RegExp(`${L}[1-9]\\d{5}${DATE}\\d{3}[\\dXx]${R}`, 'g') },
  { label: '身份证号', re: new RegExp(`${L}[1-9]\\d{7}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}${R}`, 'g') },
  // Mainland mobile numbers, with or without +86 and spaces or dashes in the usual places.
  { label: '手机号', re: new RegExp(`(?<![0-9])(?:\\+?86[- ]?)?1[3-9]\\d[- ]?\\d{4}[- ]?\\d{4}(?![0-9])`, 'g') },
]

const escape = (s        ) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The pattern a format stands for: letters as they are (either case), each
 * run of digits as that many digits, the rest as written; or, after `re:`,
 * the pattern itself. Refused when it is short enough to hit ordinary
 * numbers.
 */
export function formatPattern(example        )                                     {
  const e = example.trim()
  if (e.startsWith('re:')) {
    try {
      const re = new RegExp(e.slice(3), 'g')
      if (re.test('') || re.test('2024')) return { error: '这个规则太宽，连普通数字都会打码。' }
      return { re: new RegExp(e.slice(3), 'g') }
    } catch {
      return { error: '规则写得不对。' }
    }
  }
  if (e.length < 5) return { error: '例子太短：至少写 5 个字符，免得把普通数字也打码。' }
  const digits = (e.match(/\d/g) ?? []).length
  if (!digits) return { error: '例子里要有数字。' }
  if (/^\d+$/.test(e) && e.length < 7) return { error: '纯数字的号码至少 7 位，再短会把普通数字也打码。' }
  const body = (e.match(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g) ?? []).map(run => (/^\d+$/.test(run) ? `\\d{${run.length}}` : /^[A-Za-z]+$/.test(run) ? run : escape(run))).join('')
  return { re: new RegExp(`${L}${body}${R}`, 'gi') }
}

/** The text with identifiers replaced by what they are (`[手机号]`), and how many of each. */
export function maskText(text        , settings              )                                                   {
  const counts                         = {}
  if (!settings.enabled || !text) return { text, counts }
  const all = [
    ...BUILT_IN,
    ...settings.formats.flatMap(f => {
      const p = formatPattern(f.example)
      return 're' in p ? [{ label: f.label || '病历号', re: p.re }] : []
    }),
  ]
  let out = text
  for (const { label, re } of all) {
    re.lastIndex = 0
    out = out.replace(re, () => {
      counts[label] = (counts[label] ?? 0) + 1
      return `[${label}]`
    })
  }
  return { text: out, counts }
}

export const total = (counts                        ) => Object.values(counts).reduce((a, b) => a + b, 0)

/** What was masked, for Claude and for the log: 「身份证号 2 处、手机号 1 处」. */
export const countWords = (counts                        ) =>
  Object.entries(counts)
    .map(([k, n]) => `${k} ${n} 处`)
    .join('、')

/** A command's record (stdout, stderr) with both masked. */
export function maskShellRecord(record                         , settings              )                                                                      {
  const counts                         = {}
  const next = { ...record }
  for (const key of ['stdout', 'stderr']         ) {
    if (typeof record[key] !== 'string') continue
    const m = maskText(record[key]          , settings)
    next[key] = m.text
    for (const [k, n] of Object.entries(m.counts)) counts[k] = (counts[k] ?? 0) + n
  }
  return { record: next, counts }
}

/** The person's settings as kept on disk, cleaned: unknown fields dropped, formats checked. */
export function cleanMask(raw         )               {
  const r = (raw && typeof raw === 'object' ? raw : {})                                            
  const formats = (Array.isArray(r.formats) ? r.formats : [])
    .map(f => (f && typeof f === 'object' ? (f                           ) : {}))
    .map(f => ({ label: typeof f.label === 'string' && f.label.trim() ? f.label.trim().slice(0, 20) : '病历号', example: typeof f.example === 'string' ? f.example.trim().slice(0, 200) : '' }))
    .filter(f => f.example && 're' in formatPattern(f.example))
    .slice(0, 20)
  return { enabled: r.enabled !== false, formats }
}
