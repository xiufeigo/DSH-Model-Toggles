/** 一次性校验：用 DSH 同款 yaml 包解析 settings.yaml，交叉核对影子段。 */
const yaml = await import('file:///C:/Users/xiufe/.dsh/profiles/node_modules/yaml/dist/index.js')
const { parseDocument } = yaml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const path = join(homedir(), '.dsh', 'settings.yaml')
const doc = parseDocument(readFileSync(path, 'utf8'))
const errs = doc.errors ?? []
const warns = doc.warnings ?? []
console.log(`YAML 解析错误: ${errs.length}，警告: ${warns.length}`)
if (errs.length > 0) {
  console.log(errs.map(e => e.message).join('\n'))
  process.exit(1)
}
if (warns.length > 0) console.log(warns.map(w => w.message).join('\n'))

const root = doc.toJS()
const liveRoot = root['llm-pi-ai']?.providers ?? {}
const live = {}
for (const [route, profile] of Object.entries(liveRoot)) {
  // null = 该路由无显式 models 列表（目录 passthrough）：无法凭列表判定删除，
  // 模型级核对跳过（插件清理同样保留这类键）。
  live[route] = Array.isArray(profile?.models) ? profile.models.map(m => m.id) : null
}
const shadow = root['model-toggles']?.providers ?? {}
let bad = 0
console.log('--- 影子段核对 ---')
for (const [route, models] of Object.entries(shadow)) {
  if (!(route in live)) {
    console.log(`✘ 无效路由: ${route}`)
    bad += 1
    continue
  }
  if (live[route] === null) {
    console.log(`✔ ${route} -> ${Object.keys(models).join(', ')}（目录 passthrough，跳过模型级核对）`)
    continue
  }
  for (const m of Object.keys(models)) {
    if (!live[route].includes(m)) {
      console.log(`✘ 无效模型: ${route} / ${m}`)
      bad += 1
    }
  }
  console.log(`✔ ${route} -> ${Object.keys(models).join(', ')}`)
}
console.log(bad === 0 ? '--- 全部有效 ---' : `--- 仍有 ${bad} 个无效键 ---`)
process.exit(bad === 0 ? 0 : 1)
