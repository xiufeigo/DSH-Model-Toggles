#!/usr/bin/env node
/** 卸载：移除 profile patch 行 + 两处 junction。项目目录本身不动。 */

import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROW_ID = 'dsh-model-toggles'
const argv = process.argv.slice(2)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const PROFILE = opt('--profile') ?? 'web'
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PATCH_PATH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const BASES = [join(DSH_HOME, 'profiles', 'node_modules'), join(DSH_HOME, 'profiles', PROFILE, 'node_modules')]

if (existsSync(PATCH_PATH)) {
  const lines = readFileSync(PATCH_PATH, 'utf8').split(/\r?\n/)
  const rowIndex = lines.findIndex(line => /^\s*-\s*id:\s*dsh-model-toggles\s*$/.test(line))
  if (rowIndex >= 0) {
    let blockStart = rowIndex
    if (lines[rowIndex - 1]?.trim() === '- insert:') {
      blockStart = rowIndex - 1
      if (blockStart > 0 && lines[blockStart - 1].trimStart().startsWith('#')) blockStart -= 1
    }
    const rowIndent = (lines[rowIndex].match(/^\s*/)?.[0] ?? '').length
    let end = rowIndex + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') { end++; continue }
      const indent = (line.match(/^\s*/)?.[0] ?? '').length
      if (indent > rowIndent) { end++; continue }
      break
    }
    lines.splice(blockStart, end - blockStart)
    writeFileSync(PATCH_PATH, `${lines.join('\n').trimEnd()}\n`)
    console.log(`✓ 已移除 patch 行：${PATCH_PATH}`)
  } else {
    console.log('△ patch 行不存在，跳过')
  }
}

for (const base of BASES) {
  const link = join(base, ROW_ID)
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) {
      console.error(`✘ ${link} 不是链接，拒绝删除`)
      continue
    }
    unlinkSync(link)
    console.log(`✓ 已移除 junction：${link}`)
  } catch {
    // 不存在，跳过。
  }
}

console.log('\n卸载完成。若 dsh web 正在运行，重启后生效。')
