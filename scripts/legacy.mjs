#!/usr/bin/env node
/**
 * 旧安装方案的残留清理（junction 农场 + profile patch 手写行）。
 *
 * DSH 官方接入规范已经是 **bundle 包**：包自己声明 `dsh.bundle.patch` 并随包
 * 携带 `cordis.patch.yml`，由 `dsh plugin --profile <name> add <pkg>` 安装并
 * 自动把包名并入 profile 的 `dsh.profile.bundles` 层序
 * （见 @deepseek-ai/dsh/plugin 的 reconcilePlugins）。
 *
 * 本插件早期版本自己造了「两处 junction + 往 profile 的 cordis.patch.yml
 * 追加 insert 行」的安装器——那套机制现在由官方 CLI 实现，已删除。这里只保留
 * 幂等的**迁移清理**：把旧方案留下的东西摘干净，避免同一个插件 id 出现两次。
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const ROW_ID = 'dsh-model-toggles'
/** 放宽到引号与行尾注释变体（手写 `id: "dsh-model-toggles"` 也算已在）。 */
const ROW_RE = /^\s*-\s*id:\s*["']?dsh-model-toggles["']?\s*(#.*)?$/

/** 旧方案写入 junction 的两个位置：profiles 农场 + profile 自身。 */
export function legacyJunctionBases(dshHome, profile) {
	return [join(dshHome, 'profiles', 'node_modules'), join(dshHome, 'profiles', profile, 'node_modules')]
}

/**
 * 删除旧方案创建的 junction —— 只删「确为本项目」的链接，普通目录一律不动。
 * @returns 处理的路径列表（供日志）。
 */
export function removeLegacyJunctions(bases, projectRoot, { dryRun = false } = {}) {
	const handled = []
	for (const base of bases) {
		const link = join(base, ROW_ID)
		let stat
		try { stat = lstatSync(link) } catch { continue } // 不存在：跳过
		if (!stat.isSymbolicLink()) {
			handled.push({ link, action: 'skipped-not-link' })
			continue
		}
		let target
		try { target = resolve(dirname(link), readlinkSync(link)) } catch { target = undefined }
		if (target !== resolve(projectRoot)) {
			handled.push({ link, action: 'skipped-other-target' })
			continue
		}
		if (!dryRun) unlinkSync(link)
		handled.push({ link, action: 'removed' })
	}
	return handled
}

/**
 * 删除旧方案写进 profile `cordis.patch.yml` 的插件行（含其 `- insert:` 头与
 * 紧邻注释）。bundle 层由包自带的 cordis.patch.yml 提供，手写行会造成同一
 * 插件 id 重复挂载。
 * @returns true 表示确实移除了内容。
 */
export function removeLegacyPatchRow(patchPath, { dryRun = false } = {}) {
	if (!existsSync(patchPath)) return false
	const text = readFileSync(patchPath, 'utf8')
	const eol = text.includes('\r\n') ? '\r\n' : '\n'
	const lines = text.split(/\r?\n/)
	const rowIndex = lines.findIndex(line => ROW_RE.test(line))
	if (rowIndex < 0) return false

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
	if (!dryRun) writeFileSync(patchPath, `${lines.join(eol).trimEnd()}${eol}`)
	return true
}
