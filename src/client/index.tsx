/**
 * dsh-model-toggles — 浏览器半边。
 *
 * 不在设置页注册任何 section —— 只观察 DOM，往官方「模型」页编辑器里每个
 * 展开的模型条目注入「图片输入」+ 思考强度（低/中/高/超高/最高）勾选。
 * 事实源在 host 影子段；本层维护目录映射与能力缓存，监听
 * settings/document-updated 后重新扫描（调和器把字段补回后勾选状态随之复位）。
 */

import { type EffectiveCapability, type ThinkingLevel } from '../capabilities'
import { removeInjectedControls, scanForEditorControls, type ToggleHooks } from './inject'
import { rpc } from './rpc'
import { injectStyles } from './styles'

interface RemoteLike {
	$on?(event: string, listener: (...args: unknown[]) => void): () => void
}

interface ClientContext {
	get(name: string): unknown
	effect(callback: () => (() => void) | void, label?: string): () => void
	remote?: RemoteLike
}

interface MetaRoutesResponse extends RpcEnvelopeResponse {
	routes?: Array<{ provider: string, displayName: string }>
}
interface CapsGetResponse extends RpcEnvelopeResponse {
	models?: Record<string, EffectiveCapability>
}
interface CapsSetResponse extends RpcEnvelopeResponse {
	effective?: EffectiveCapability
}
interface RpcEnvelopeResponse {
	ok?: boolean
	error?: string
}

const SCAN_DEBOUNCE_MS = 50

export const name = 'dsh-model-toggles'
export const inject = ['remote']

// 注入辅助层的再导出（smoke 直测用）。
export { CONTROLS_MARKER, removeInjectedControls, scanForEditorControls } from './inject'

export function apply(ctx: ClientContext): void {
	ctx.effect(() => injectStyles(), 'dsh-model-toggles: styles')

	const directory = { direct: new Set<string>(), byName: new Map<string, string>() }
	const capsCache = new Map<string, Map<string, EffectiveCapability>>()
	const capsInFlight = new Map<string, Promise<Map<string, EffectiveCapability> | undefined>>()
	const toggleQueues = new Map<string, Promise<void>>()

	let scanTimer: ReturnType<typeof setTimeout> | undefined
	let disposed = false
	const scheduleScan = (): void => {
		if (disposed) return
		if (scanTimer !== undefined) clearTimeout(scanTimer)
		scanTimer = setTimeout(() => {
			scanTimer = undefined
			try {
				scanForEditorControls(document, hooks)
			} catch (error) {
				console.warn('dsh-model-toggles: 扫描失败', error)
			}
		}, SCAN_DEBOUNCE_MS)
	}

	const refreshMeta = async (): Promise<void> => {
		const response = await rpc<MetaRoutesResponse>('meta.routes')
		if (!response.ok || !Array.isArray(response.routes)) return
		const direct = new Set<string>()
		const byName = new Map<string, string>()
		for (const row of response.routes) {
			direct.add(row.provider)
			byName.set(row.displayName, row.provider)
		}
		directory.direct = direct
		directory.byName = byName
	}

	const requestCaps = (route: string): void => {
		let inflight = capsInFlight.get(route)
		if (inflight === undefined) {
			inflight = rpc<CapsGetResponse>('caps.get', { route }).then(response => {
				const map = new Map<string, EffectiveCapability>()
				for (const [modelId, caps] of Object.entries(response.models ?? {})) {
					map.set(modelId, caps)
				}
				if (response.ok) capsCache.set(route, map)
				return response.ok ? map : undefined
			})
			capsInFlight.set(route, inflight)
		}
		void inflight.then(() => scheduleScan())
	}

	const hooks: ToggleHooks = {
		getDirectory: () => directory,
		getCaps: route => capsCache.get(route),
		requestCaps,
		onToggle: (route, model, patch: { image?: boolean, efforts?: ThinkingLevel[] }) => {
			// 按 (route,model) 串行：快速连续勾选两个维度时，后一个请求等前一个
			// 落盘，host 端合并读到的就是含前一次结果的影子，避免互相覆盖。
			const key = `${route}\u0000${model}`
			const previous = toggleQueues.get(key) ?? Promise.resolve()
			const run = previous.then(async () => {
				const response = await rpc<CapsSetResponse>('caps.set', { route, model, patch })
				if (!response.ok) {
					console.warn(`dsh-model-toggles: ${route}/${model} 写入失败：${response.error ?? '未知错误'}`)
					return
				}
				if (response.effective !== undefined) {
					const map = capsCache.get(route) ?? new Map<string, EffectiveCapability>()
					map.set(model, response.effective)
					capsCache.set(route, map)
				}
			})
			toggleQueues.set(key, run.catch(() => {}))
			void run.then(scheduleScan)
		},
	}

	// 事件：settings 任何段变更都可能是「官方保存覆盖了我们的字段 → 调和补回」，
	// 清缓存重扫以复位勾选状态。
	const offDocumentUpdated = ((): (() => void) | undefined => {
		try {
			if (typeof ctx.remote?.$on !== 'function') return undefined
			return ctx.remote.$on('settings/document-updated', () => {
				capsCache.clear()
				void refreshMeta().then(scheduleScan)
			})
		} catch {
			return undefined
		}
	})()

	// 观察器：官方编辑器是 React 渲染，展开/折叠/重绘都会触发 childList 变更。
	const observer = new MutationObserver(() => scheduleScan())
	if (typeof document !== 'undefined' && document.body !== null) {
		observer.observe(document.body, { childList: true, subtree: true })
	}

	void refreshMeta().then(scheduleScan)

	ctx.effect(() => () => {
		disposed = true
		if (scanTimer !== undefined) clearTimeout(scanTimer)
		observer.disconnect()
		offDocumentUpdated?.()
		try {
			removeInjectedControls(document)
		} catch {
			// ignore
		}
	}, 'dsh-model-toggles: teardown')
}
