#!/usr/bin/env node
/**
 * dsh-model-toggles 卸载器 —— 与安装对称，走官方 CLI。
 *
 * 官方流程：`dsh plugin --profile <name> remove <pkg>` 在 profile 目录跑 pnpm，
 * 然后按「已安装依赖是否声明 dsh.bundle」重建 `dsh.profile.bundles`，本包自动
 * 退出层序。项目目录本身不动。
 *
 * 同时幂等清理旧方案（junction + profile 手写 patch 行）残留。
 *
 * 用法：node scripts/uninstall.mjs [--profile <n>] [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs'
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
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')

const log = (...parts) => console.log(...parts)

function run(cmd, args, cwd) {
	return spawnSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true }).status ?? 1
}

const installed = (() => {
	if (!existsSync(PROFILE_MANIFEST)) return false
	try {
		const manifest = JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8'))
		return Object.hasOwn(manifest.dependencies ?? {}, ROW_ID)
	} catch {
		return false
	}
})()

if (installed) {
	log(`\n▶ 官方卸载：dsh plugin --profile ${PROFILE} remove ${ROW_ID}`)
	if (DRY) log(`  [dry-run] dsh plugin --profile ${PROFILE} remove ${ROW_ID}`)
	else {
		const code = run('dsh', ['plugin', '--profile', PROFILE, 'remove', ROW_ID], PROJECT_ROOT)
		if (code === 127) log('  △ 找不到 dsh 命令 —— 请手工执行：dsh plugin --profile ' + PROFILE + ' remove ' + ROW_ID)
		else if (code !== 0) log('  △ dsh plugin remove 非零退出（见上方输出）')
	}
} else {
	log(`\n△ profile "${PROFILE}" 的依赖里没有 ${ROW_ID}，跳过官方卸载`)
}

log('\n▶ 旧方案残留清理')
{
	const handled = removeLegacyJunctions(legacyJunctionBases(DSH_HOME, PROFILE), PROJECT_ROOT, { dryRun: DRY })
	for (const row of handled) {
		if (row.action === 'removed') log(`  ${DRY ? '[dry-run] ' : ''}✓ 移除旧 junction：${row.link}`)
		else log(`  △ 跳过（${row.action}，不动）：${row.link}`)
	}
	if (handled.length === 0) log('  ✓ 无旧 junction')
}
if (removeLegacyPatchRow(PATCH_PATH, { dryRun: DRY })) log(`  ${DRY ? '[dry-run] ' : ''}✓ 移除旧手写插件行：${PATCH_PATH}`)
else log('  ✓ 无旧手写插件行')

log('\n卸载完成（已生效的配置不动：settings.yaml 里的 model-toggles: 段与')
log('由插件写入模型条目的 input / reasoningEfforts 字段需要时请手工删除）。')
log('若 dsh web 正在运行，重启后生效。')
