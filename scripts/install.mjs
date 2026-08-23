#!/usr/bin/env node
/**
 * dsh-model-toggles 安装器（幂等）。
 * 流程：构建产物检查 → 冒烟自检 → 包解析 junction（农场 + profile）→
 *      patch 行 → 尽力而为 HTTP 验证。
 * 用法：node scripts/install.mjs [--rebuild] [--profile <n>] [--dry-run]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-model-toggles'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const DRY = flag('--dry-run')
const PROFILE = opt('--profile') ?? 'web'
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const JUNCTION_BASES = [join(DSH_HOME, 'profiles', 'node_modules'), join(PROFILE_DIR, 'node_modules')]

const log = (...parts) => console.log(...parts)
const step = title => console.log(`\n▶ ${title}`)

function run(cmd, args, cwd) {
  return spawnSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true }).status
}
function exec(description, fn) {
  if (DRY) {
    log(`  [dry-run] ${description}`)
    return 0
  }
  return fn()
}

// ── 1. 构建 + 自检 ──────────────────────────────────────────────────────────
step('构建产物检查')
if (!existsSync(join(PROJECT_ROOT, 'node_modules')) || flag('--rebuild')) {
  const installCode = exec('pnpm install', () => run('pnpm', ['install'], PROJECT_ROOT))
  // pnpm 对 ignored build scripts（依赖树里的 @google/genai、protobufjs）以 1 退出；
  // 只要依赖落位就继续。
  if (installCode !== 0 && !existsSync(join(PROJECT_ROOT, 'node_modules', 'tsdown'))) process.exit(1)
} else {
  log('  node_modules 已存在')
}
if (!existsSync(join(PROJECT_ROOT, 'lib', 'index.js')) || !existsSync(join(PROJECT_ROOT, 'lib', 'client.js')) || flag('--rebuild')) {
  if (exec('pnpm run build', () => run('pnpm', ['run', 'build'], PROJECT_ROOT)) !== 0) process.exit(1)
} else {
  log('  lib/index.js + lib/client.js 已存在（--rebuild 可强制重建）')
}

step('冒烟自检（真实执行两个 bundle + 纯逻辑单测）')
if (exec('pnpm run verify', () => run('node', ['scripts/smoke.mjs'], PROJECT_ROOT)) !== 0) {
  console.error('✘ 自检未通过，终止安装')
  process.exit(1)
}

// ── 2. 包解析 junction ──────────────────────────────────────────────────────
step('创建包解析 junction')
function linkPointsTo(link, target) {
  const existing = readlinkSync(link)
  return resolve(dirname(link), existing) === resolve(target)
}
function ensureJunction(link, target) {
  let info
  try { info = lstatSync(link) } catch { info = undefined }
  if (info !== undefined) {
    let pointsHere = false
    try { pointsHere = linkPointsTo(link, target) } catch { /* 普通目录或坏链 */ }
    if (pointsHere) {
      log(`  ✓ 已存在且指向正确：${link}`)
      return true
    }
    console.error(`  ✘ ${link} 已存在但指向别处（或不是链接）；请手动处理后再装`)
    return false
  }
  if (DRY) {
    log(`  [dry-run] 创建 junction：${link} -> ${target}`)
    return true
  }
  try {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
    log(`  ✓ 已创建：${link}`)
    return true
  } catch (error) {
    console.error(`  ✘ 创建失败：${error.message}`)
    return false
  }
}
let okLinks = true
for (const base of JUNCTION_BASES) {
  okLinks = ensureJunction(join(base, ROW_ID), PROJECT_ROOT) && okLinks
}
if (!okLinks) process.exit(1)

// ── 3. profile patch 行 ─────────────────────────────────────────────────────
step(`写入插件行：${PATCH_PATH}`)
if (!existsSync(PATCH_PATH)) {
  console.error(`✘ 找不到 ${PATCH_PATH}（profile "${PROFILE}" 不存在？用 --profile 指定）`)
  process.exit(1)
}
const patchText = readFileSync(PATCH_PATH, 'utf8')
if (/^\s*-\s*id:\s*dsh-model-toggles\s*$/m.test(patchText)) {
  log('  ✓ 插件行已存在')
} else {
  const block = [
    '- insert:',
    '    # 模型能力勾选（图片输入 / 思考强度）—— dsh-model-toggles（scripts/install.mjs 写入）',
    `    - id: ${ROW_ID}`,
    '      name: dsh-model-toggles',
  ]
  exec(`追加 ${ROW_ID} insert 块`, () => {
    const body = patchText.trimEnd()
    const usable = body.length > 0 && body.trim() !== '[]'
    writeFileSync(PATCH_PATH, `${usable ? `${body}\n\n` : ''}${block.join('\n')}\n`)
  })
  if (!DRY) log('  ✓ 已写入（watchUserPatches 会热重载组合；若未生效重启 dsh web）')
}

// ── 4. 线上验证（尽力而为） ─────────────────────────────────────────────────
step('线上验证（尽力而为，不阻塞安装）')
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:59300'
try {
  const status = await fetch(`${base}/dsh-model-toggles/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
    body: JSON.stringify({ method: 'meta.routes' }),
    signal: AbortSignal.timeout(3500),
  })
  if (status.status === 200) log(`  ✓ Host RPC 路由已挂载（${base}/dsh-model-toggles/rpc）`)
  else log(`  △ RPC 路由返回 ${status.status}：若为首次安装，请重启 dsh web`)
} catch {
  log(`  △ 无法访问 ${base}：请重启 dsh web 后验证`)
}
try {
  const bundle = await fetch(`${base}/plugins/${ROW_ID}/client.js`, { signal: AbortSignal.timeout(3500) })
  const head = (await bundle.text()).slice(0, 60)
  if (bundle.status === 200 && head.includes('__ModuleLoader__')) {
    log('  ✓ 浏览器 bundle 已在服务 —— 刷新页面后到「设置 → 模型」编辑提供方即可看到勾选')
  } else {
    log('  △ 浏览器 bundle 未就绪：重启 dsh web 后刷新页面')
  }
} catch {
  log('  △ 无法访问 bundle 路由（见上）')
}

console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  安装完成')
console.log('  接下来：刷新页面 → 设置 → 模型 → 编辑某提供方 → 展开模型条目')
console.log('  卸载：pnpm plugin:uninstall')
console.log('════════════════════════════════════════')
