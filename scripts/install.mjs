#!/usr/bin/env node
/**
 * dsh-model-toggles 安装器（幂等）—— 走 DSH 官方插件接入规范。
 *
 * 官方规范（DSH ≥ 0.1.2，见 @deepseek-ai/dsh-package-manifest 与
 * @deepseek-ai/dsh/plugin）：
 *   - 插件包在 package.json 声明 `dsh.bundle.patch`，并随包携带该 patch 文件
 *     → 包成为 profile 的一个**层（bundle）**；
 *   - 浏览器半边在 `dsh.client` 声明（platform: 'web'）；
 *   - 安装 = `dsh plugin --profile <name> add <spec>`：CLI 在 profile 目录跑
 *     pnpm，然后按「已安装依赖是否声明 dsh.bundle」自动重建
 *     `dsh.profile.bundles` 层序。
 *
 * 因此本脚本只做三件事：构建自检 → 清理旧方案残留 → 交给官方 CLI。
 * 早期版本自造的「两处 junction + 往 profile cordis.patch.yml 手写 insert 行」
 * 已删除（官方 CLI 已实现该机制）。
 *
 * 用法：node scripts/install.mjs [--profile <n>] [--spec <pkg-spec>] [--rebuild] [--dry-run]
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyJunctionBases, removeLegacyJunctions, removeLegacyPatchRow, ROW_ID } from './legacy.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = name => {
	const i = argv.indexOf(name)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const DRY = flag('--dry-run')
const PROFILE = opt('--profile') ?? 'web'
/** 默认以 link: 安装本 checkout —— 源码改动即时生效，无需重装。 */
const SPEC = opt('--spec') ?? `link:${PROJECT_ROOT}`
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')

const log = (...parts) => console.log(...parts)
const step = title => console.log(`\n▶ ${title}`)

function run(cmd, args, cwd) {
	return spawnSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true }).status ?? 1
}

// ── 1. 构建 + 自检 ──────────────────────────────────────────────────────────
step('构建产物检查')
if (!existsSync(join(PROJECT_ROOT, 'node_modules')) || flag('--rebuild')) {
	const installCode = run('pnpm', ['install'], PROJECT_ROOT)
	// pnpm 对 ignored build scripts 以 1 退出；只要依赖落位就继续。
	if (installCode !== 0 && !existsSync(join(PROJECT_ROOT, 'node_modules', 'tsdown'))) process.exit(1)
} else {
	log('  node_modules 已存在')
}
if (!existsSync(join(PROJECT_ROOT, 'lib', 'index.js')) || !existsSync(join(PROJECT_ROOT, 'lib', 'client.js')) || flag('--rebuild')) {
	if (DRY) log('  [dry-run] pnpm run build')
	else if (run('pnpm', ['run', 'build'], PROJECT_ROOT) !== 0) process.exit(1)
} else {
	log('  lib/index.js + lib/client.js 已存在（--rebuild 可强制重建）')
}

step('冒烟自检（真实执行两个 bundle + 纯逻辑单测）')
if (DRY) log('  [dry-run] node scripts/smoke.mjs')
else if (run('node', ['scripts/smoke.mjs'], PROJECT_ROOT) !== 0) {
	console.error('✘ 自检未通过，终止安装')
	process.exit(1)
}

// bundle 层的前置条件：包必须声明 dsh.bundle.patch 且 patch 文件存在 ——
// 否则 `dsh plugin add` 只会当普通依赖装上，不会进入 profile 层序。
step('bundle 声明自检')
{
	const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
	const patchRel = manifest.dsh?.bundle?.patch
	const platform = manifest.dsh?.client?.platform
	if (typeof patchRel !== 'string' || patchRel.length === 0) {
		console.error('✘ package.json 缺少 dsh.bundle.patch —— 官方 CLI 不会把它并入 dsh.profile.bundles')
		process.exit(1)
	}
	if (!existsSync(join(PROJECT_ROOT, patchRel))) {
		console.error(`✘ dsh.bundle.patch 指向的文件不存在：${patchRel}`)
		process.exit(1)
	}
	if (platform !== 'web') {
		console.error(`✘ package.json 的 dsh.client.platform 应为 "web"（当前 ${JSON.stringify(platform)}）`)
		process.exit(1)
	}
	log(`  ✓ dsh.bundle.patch = ${patchRel}；dsh.client.platform = ${platform}`)
}

// ── 2. 旧方案残留清理（官方 CLI 已接管安装，旧机制删除） ─────────────────────
step('旧方案残留清理（junction / profile 手写 patch 行）')
{
	const handled = removeLegacyJunctions(legacyJunctionBases(DSH_HOME, PROFILE), PROJECT_ROOT, { dryRun: DRY })
	for (const row of handled) {
		if (row.action === 'removed') log(`  ${DRY ? '[dry-run] ' : ''}✓ 移除旧 junction：${row.link}`)
		else if (row.action === 'skipped-not-link') log(`  △ 跳过（非链接，不动）：${row.link}`)
		else log(`  △ 跳过（指向其他目标，不动）：${row.link}`)
	}
	if (handled.length === 0) log('  ✓ 无旧 junction')
	const removedRow = removeLegacyPatchRow(PATCH_PATH, { dryRun: DRY })
	if (removedRow) log(`  ${DRY ? '[dry-run] ' : ''}✓ 移除旧手写插件行：${PATCH_PATH}`)
	else log('  ✓ 无旧手写插件行')
}

// ── 3. 官方安装：dsh plugin add ─────────────────────────────────────────────
step(`官方安装：dsh plugin --profile ${PROFILE} add <spec>`)
/** 以 link: 安装（符号链接，源码改动即时生效）优先；pnpm 拒绝时回退裸绝对路径。 */
const SPEC_CANDIDATES = [SPEC]
if (SPEC === `link:${PROJECT_ROOT}`) SPEC_CANDIDATES.push(PROJECT_ROOT)
let usedSpec
if (DRY) {
	log(`  [dry-run] dsh plugin --profile ${PROFILE} add ${SPEC}`)
} else {
	for (const [index, spec] of SPEC_CANDIDATES.entries()) {
		log(`  → dsh plugin --profile ${PROFILE} add ${spec}`)
		const code = run('dsh', ['plugin', '--profile', PROFILE, 'add', spec], PROJECT_ROOT)
		if (code === 127) {
			console.error('✘ 找不到 dsh 命令 —— 请先安装 DSH CLI（npm i -g @deepseek-ai/dsh）')
			process.exit(1)
		}
		if (code === 0) { usedSpec = spec; break }
		if (index === SPEC_CANDIDATES.length - 1) {
			console.error('✘ dsh plugin add 失败（见上方 pnpm 输出）')
			process.exit(1)
		}
		console.error(`  △ ${spec} 安装失败，回退下一种 spec`)
	}
}

// ── 4. 层序核对：包必须已进入 dsh.profile.bundles ───────────────────────────
step('层序核对')
if (DRY) {
	log('  [dry-run] 跳过层序核对')
} else {
	if (!existsSync(PROFILE_MANIFEST)) {
		console.error(`✘ profile 清单不存在：${PROFILE_MANIFEST}`)
		process.exit(1)
	}
	const manifest = JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8'))
	const bundles = manifest.dsh?.profile?.bundles ?? []
	if (!bundles.includes(ROW_ID)) {
		console.error(`✘ ${ROW_ID} 不在 dsh.profile.bundles —— 插件不会装载`)
		console.error(`  当前层序：${JSON.stringify(bundles)}`)
		console.error('  排查：依赖是否真的装上（profile 的 dependencies），以及包的 dsh.bundle 声明是否存在')
		process.exit(1)
	}
	log(`  ✓ dsh.profile.bundles 已含 ${ROW_ID}（共 ${bundles.length} 层；spec=${usedSpec}）`)

	// 解析链接形态：符号链接 = 源码改动即时生效；普通目录 = 安装时快照。
	const linked = join(PROFILE_DIR, 'node_modules', ROW_ID)
	if (!existsSync(join(linked, 'package.json'))) {
		console.error(`✘ profile 无法解析本包：${linked}`)
		process.exit(1)
	}
	let isLink = false
	try {
		isLink = lstatSync(linked).isSymbolicLink()
		const target = isLink ? resolve(dirname(linked), readlinkSync(linked)) : undefined
		if (isLink && target !== PROJECT_ROOT) {
			log(`  △ ${linked} 指向 ${target}（不是本 checkout）`)
		}
	} catch {
		// 普通目录（快照安装）：下面统一提示。
	}
	log(isLink
		? `  ✓ 已链接到本 checkout（源码改动即时生效）：${linked}`
		: `  △ 为快照安装（非符号链接）：改源码后需重跑 pnpm plugin:install`)
}

// ── 5. 线上验证（尽力而为，不阻塞安装） ─────────────────────────────────────
step('线上验证（尽力而为，不阻塞安装）')
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:52221'
const probe = async (url, init) => {
	try {
		const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3500) })
		return { status: response.status, text: await response.text() }
	} catch {
		return undefined
	}
}
if (DRY) {
	log('  [dry-run] 跳过线上验证')
} else {
	// Remote 端点：Host 半边是 TypertRemoteService，`@Remote` 方法由 Api Gateway
	// 的 collectSrcClaims() 自动认领到共享 `/api` 上。脚本没有会话 cookie，因此
	// **401 = 端点已挂载且连接鉴权生效**（这正是期望），404 = Gateway 未认领。
	const rpcProbe = await probe(`${base}/api/modelToggles/metaRoutes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: 'install-check', method: 'modelToggles/metaRoutes', payload: { args: {} } }),
	})
	if (rpcProbe === undefined) log(`  △ 无法访问 ${base}：请重启 dsh web 后验证`)
	else if (rpcProbe.status === 401) log(`  ✓ Remote 端点已挂载且受连接鉴权保护（${base}/api/modelToggles/metaRoutes）`)
	else if (rpcProbe.status === 200) log('  ✓ Remote 端点已挂载（未鉴权响应：DSH 较旧）')
	else if (rpcProbe.status === 403) log('  △ 信任闸门拒绝脚本请求（Host/Origin）——浏览器同源访问不受影响')
	else log(`  △ Remote 端点返回 ${rpcProbe.status}：若为首次安装，请重启 dsh web`)

	const bundle = await probe(`${base}/plugins/${ROW_ID}/client.js`)
	if (bundle !== undefined && bundle.status === 200 && bundle.text.includes('__ModuleLoader__')) {
		log('  ✓ 浏览器 bundle 已在服务 —— 刷新页面后到「设置 → 模型」编辑提供方即可看到勾选')
	} else {
		log('  △ 浏览器 bundle 未就绪：重启 dsh web 后刷新页面（combo 形态 URL 只在 boot graph 里）')
	}
}

console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  安装完成')
console.log('  接下来：重启 DSH → 刷新页面 → 设置 → 模型 → 编辑某提供方 → 展开模型条目')
console.log('  卸载：pnpm plugin:uninstall')
console.log('════════════════════════════════════════')
