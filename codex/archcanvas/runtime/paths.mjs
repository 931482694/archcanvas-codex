import fs from 'node:fs'
import path from 'node:path'

export function projectPath(root, relative = '.') {
  const base = fs.realpathSync(root)
  const target = path.resolve(base, relative)
  const inside = p => { const r = path.relative(base, p); return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }
  if (!inside(target)) throw new Error('路径必须在项目内')
  let existing = target
  while (!fs.existsSync(existing)) {
    if (fs.lstatSync(path.dirname(existing), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('不跟随目录链接')
    existing = path.dirname(existing)
  }
  // A lock/file can disappear between existsSync and realpathSync when a
  // different process releases it. Validate its nearest surviving ancestor.
  let real
  for (;;) {
    try { real = fs.realpathSync(existing); break } catch (err) {
      if (err.code !== 'ENOENT' || existing === base) throw err
      existing = path.dirname(existing)
    }
  }
  if (!inside(real)) throw new Error('链接目标在项目外')
  // Reject every symlink, including links pointing back inside the project:
  // privacy and module ownership use one canonical project-relative name.
  let at = base
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('不跟随文件或目录链接')
  }
  return target
}
export function relativePath(root, given) {
  const target = projectPath(root, given)
  return path.relative(fs.realpathSync(root), target).replace(/\\/g, '/')
}
