/**
 * dsh-model-toggles — 浏览器半边。
 *
 * 不在设置页注册任何 section —— 只观察 DOM，往官方「模型」页编辑器里每个
 * 展开的模型条目注入「图片输入」+ 思考强度（最低/低/中/高/超高/最高）勾选。
 * 事实源在 host 影子段；本层维护目录映射与能力缓存，监听
 * settings/document-updated 后重新扫描（调和器把字段补回后勾选状态随之复位）。
 *
 * Host 调用走官方 Connection：`ctx.connection.rpc.call(channel, endpoint, payload)`。
 */

import { type EffectiveCapability, type ThinkingLevel } from '../capabilities'
import { removeInjectedControls, scanForEditorControls, type ToggleHooks } from './inject'
import { rpc, type ClientConnectionLike } from './rpc'
import { injectStyles } from './styles'

interface RemoteLike {
	$on?(event: string, listener: (...args: unknown[]) => void): () => void
}

interface ClientContext {
	connection: ClientConnectionLike
	effect(callback: () => (() => void) | void, label?: string): () => void
	remote?: RemoteLike
}

interface CapsRequest {
	token: number
	promise: Promise<Map<string, EffectiveCapability> | undefined>
}

const SCAN_DEBOUNCE_MS = 50

export const name = 'dsh-model-toggles'
/** `connection` = Host RPC 传输；`remote` = 官方事件流（settings/document-updated）。 */
export const inject = ['connection', 'remote']

// 注入辅助层的再导出（smoke 直测用）。
export { CONTROLS_MARKER, removeInjectedControls, scanForEditorControls } from './inject'

export function apply(ctx: ClientContext): void {
	ctx.effect(() => injectStyles(), 'dsh-model-toggles: styles')

	const directory = { direct: new Set<string>(), byName: new Map<string, string>() }
	const capsCache = new Map<string, Map<string, EffectiveCapability>>()
	/** 每条路由最多一个当前请求；旧 token 的慢响应不得覆盖新状态。 */
	const capsInFlight = new Map<string, CapsRequest>()
	const capsTokens = new Map<string, number>()
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
		const result = await rpc<{ routes?: Array<{ provider: string, displayName: string }> }>(ctx.connection, 'metaRoutes')
		if (!result.ok || !Array.isArray(result.value.routes)) return
		const direct = new Set<string>()
		const byName = new Map<string, string>()
		for (const row of result.value.routes) {
			direct.add(row.provider)
			const existing = byName.get(row.displayName)
			if (existing === undefined) byName.set(row.displayName, row.provider)
			else if (existing !== row.provider) byName.delete(row.displayName) // 同名歧义：宁可不注入，也不写错路由
		}
		directory.direct = direct
		directory.byName = byName
	}

	/**
	 * 让一条路由的能力快照失效。必须同时移除 cache 与 inflight：之前只清
	 * cache 会复用一个已经完成的 promise，结果永远不再回填完整 map；随后
	 * 单模型 caps.set 的响应把 route map 截断成一个模型，正是「勾一个另一个
	 * 失效」的根因。
	 */
	const invalidateCaps = (route?: string): void => {
		const routes = route === undefined
			? new Set([...capsCache.keys(), ...capsInFlight.keys(), ...capsTokens.keys()])
			: new Set([route])
		for (const key of routes) {
			capsCache.delete(key)
			capsInFlight.delete(key)
			capsTokens.set(key, (capsTokens.get(key) ?? 0) + 1)
		}
	}

	/**
	 * 读取一条路由的完整能力 map。force 会废弃当前 map 并发起新请求；token
	 * 防止较早的慢响应回写过期数据。返回完整 map，绝不以 caps.set 的单模型
	 * response 充当 route 缓存。
	 */
	const requestCaps = (route: string, force = false): Promise<Map<string, EffectiveCapability> | undefined> => {
		if (!force) {
			const cached = capsCache.get(route)
			if (cached !== undefined) return Promise.resolve(cached)
			const active = capsInFlight.get(route)
			if (active !== undefined) return active.promise
		} else {
			// 保留 token 递增语义，同时不让旧缓存把其他模型短暂刷成错误状态。
			capsCache.delete(route)
		}

		const token = (capsTokens.get(route) ?? 0) + 1
		capsTokens.set(route, token)
		const promise = rpc<{ models?: Record<string, EffectiveCapability> }>(ctx.connection, 'capsGet', { route }).then(result => {
			if (!result.ok) return undefined
			const map = new Map<string, EffectiveCapability>()
			for (const [modelId, caps] of Object.entries(result.value.models ?? {})) {
				map.set(modelId, caps)
			}
			if (capsTokens.get(route) === token) capsCache.set(route, map)
			return map
		}).catch(error => {
			console.warn(`dsh-model-toggles: ${route} 能力状态读取失败`, error)
			return undefined
		}).finally(() => {
			const active = capsInFlight.get(route)
			if (active?.token === token) capsInFlight.delete(route)
		})
		capsInFlight.set(route, { token, promise })
		void promise.then(() => scheduleScan())
		return promise
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
				const result = await rpc<{ effective?: EffectiveCapability }>(ctx.connection, 'capsSet', { route, model, patch })
				if (!result.ok) {
					console.warn(`dsh-model-toggles: ${route}/${model} 写入失败：${result.error.message}`)
					// 写入失败：勾选框停在用户点击后的假状态 —— 强制回读服务端真相
					// 并重扫，让控件复位到实际落盘状态。
					await requestCaps(route, true)
					return
				}
				// caps.set 只回当前模型，绝不能拿它拼一份 route map：那会让同一路由
				// 的其余模型在缓存中消失。写成功后强制拉完整路由快照。
				await requestCaps(route, true)
			})
			toggleQueues.set(key, run.catch(() => {}))
			void run.then(scheduleScan)
		},
	}

	// 事件：settings 任何段变更都可能是「官方保存覆盖了我们的字段 → 调和补回」，
	// 失效完整快照（含已完成 promise）后重扫，避免单模型响应截断 route map。
	const offDocumentUpdated = ((): (() => void) | undefined => {
		try {
			if (typeof ctx.remote?.$on !== 'function') return undefined
			return ctx.remote.$on('settings/document-updated', () => {
				invalidateCaps()
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
