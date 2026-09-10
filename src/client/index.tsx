/**
 * dsh-model-toggles — 浏览器半边。
 *
 * 不在设置页注册任何 section —— 只观察 DOM，往官方「模型」页编辑器里每个
 * 展开的模型条目注入「图片输入」+ 思考强度（最低/低/中/高/超高/最高）勾选。
 * 事实源在 host 影子段；本层维护目录映射与能力缓存，监听
 * settings/document-updated 后重新扫描（调和器把字段补回后勾选状态随之复位）。
 *
 * 写盘时机（为什么是「暂存 → 卡片关闭后提交」）：
 * 官方编辑卡片在**打开那一刻**把 settings namespace 的 revision 冻结进
 * React state（`dsh-client-ui-settings-models` 的 `expectedRevision` /
 * CustomProviderCard 的 `openedAt`），此后任何转发事件都不会重新取值，
 * 草稿也只存在于卡片内部。因此卡片打开期间对 `llm-pi-ai` 的任何外部写入
 * 都会让它的「保存」必然以 `settings/conflict` 失败，用户看到
 * 「这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开…」。
 *
 * 于是本层把勾选**暂存**在浏览器侧：
 *  - 官方卡片打开期间勾选只进暂存表（控件立即回显 + 「待写入」提示），不写盘；
 *  - 卡片从 DOM 消失（保存成功、取消、关闭、离开设置页）后提交暂存
 *    （capsSet）；此时官方卡片已不会再写，两者不再抢 revision；
 *  - 提交因「模型/路由尚未落盘」（新增模型 / 新增提供方的草稿）被拒时保留
 *    意图，等官方保存触发的 document-updated 再试（有 TTL，避免永久悬挂）；
 *  - 没有官方卡片打开时（理论上控件不存在，保留该路径）勾选立即写盘。
 *
 * Host 调用走官方 Connection：`ctx.connection.rpc.call(channel, endpoint, payload)`。
 */

import { type EffectiveCapability, type ThinkingLevel } from '../capabilities'
import { editorCardOpen, removeInjectedControls, scanForEditorControls, type ToggleHooks } from './inject'
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

/** 一次暂存的勾选（字段缺省 = 不动该维度；与 host 的 CapsPatch 同形）。 */
interface StagedPatch {
	image?: boolean
	efforts?: ThinkingLevel[]
}

interface StagedEntry {
	patch: StagedPatch
	/** 暂存时间：超过 TTL 且仍写不进去（模型/路由最终没落盘）就丢弃。 */
	at: number
	/** 可重试失败后的重试时刻（退避，避免 DOM 变更风暴反复打 RPC）。 */
	retryAfter?: number
	/** 已重试次数（退避按次数递增，上限 4×）。 */
	attempts: number
}

const SCAN_DEBOUNCE_MS = 50
/** 暂存意图的最长保留时间：官方保存后仍未落盘的草稿，超时丢弃。 */
const STAGED_TTL_MS = 5 * 60_000
/** 可重试失败后的基础退避（document-updated = 官方状态已变，会立即清掉）。 */
const RETRY_BACKOFF_MS = 1500
/** 可重试的失败码 —— 官方编辑器草稿尚未落盘（保存后再试即可）。 */
const RETRYABLE_CODES = new Set(['model-toggles/model-unsaved', 'model-toggles/route-unknown'])

export const name = 'dsh-model-toggles'
/** `connection` = Host RPC 传输；`remote` = 官方事件流（settings/document-updated）。 */
export const inject = ['connection', 'remote']

// 注入辅助层的再导出（smoke 直测用）。
export { CONTROLS_MARKER, editorCardOpen, removeInjectedControls, scanForEditorControls } from './inject'

export function apply(ctx: ClientContext): void {
	ctx.effect(() => injectStyles(), 'dsh-model-toggles: styles')

	const directory = { direct: new Set<string>(), byName: new Map<string, string>() }
	const capsCache = new Map<string, Map<string, EffectiveCapability>>()
	/** 每条路由最多一个当前请求；旧 token 的慢响应不得覆盖新状态。 */
	const capsInFlight = new Map<string, CapsRequest>()
	const capsTokens = new Map<string, number>()
	/** 尚未提交给 host 的勾选：key = `route\0model`。 */
	const staged = new Map<string, StagedEntry>()

	let scanTimer: ReturnType<typeof setTimeout> | undefined
	let flushPromise: Promise<void> | undefined
	let disposed = false

	const stagedKeyOf = (route: string, model: string): string => `${route}\u0000${model}`
	const splitKey = (key: string): { route: string, model: string } => {
		const cut = key.indexOf('\u0000')
		return { route: key.slice(0, cut), model: key.slice(cut + 1) }
	}

	/** 丢弃超时仍未落盘的暂存意图（用户放弃了官方草稿）。 */
	const dropExpiredStaged = (now: number): void => {
		for (const [key, entry] of staged) {
			if (now - entry.at > STAGED_TTL_MS) {
				staged.delete(key)
				console.warn(`dsh-model-toggles: 暂存勾选超过 ${String(STAGED_TTL_MS / 60000)} 分钟仍未落盘，已丢弃 ${key.split('\u0000').join('/')}`)
			}
		}
	}

	const scheduleScan = (): void => {
		if (disposed) return
		// 节流（而非去抖）：会话流式输出时 DOM 变更极密集，去抖会让「卡片关闭
		// 后提交暂存」的检测被无限推迟。已有待执行扫描就不再顺延。
		if (scanTimer !== undefined) return
		scanTimer = setTimeout(() => {
			scanTimer = undefined
			try {
				scanForEditorControls(document, hooks)
			} catch (error) {
				console.warn('dsh-model-toggles: 扫描失败', error)
			}
			// 没有官方卡片打开时才提交暂存（tryFlush 内部还会再判一次）；
			// 写失败的可重试键有退避，扫描再密集也不会打成 RPC 风暴。
			void tryFlush()
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

	/**
	 * 服务端快照 + 暂存意图的合成视图（读侧）。控件显示的是「用户刚点的选择」，
	 * 不会因为服务端还没有该字段而在重扫时被复位 —— 这正是「勾上后自动消失」
	 * 的修复点。
	 */
	const overlayStaged = (route: string): Map<string, EffectiveCapability> | undefined => {
		const base = capsCache.get(route)
		if (staged.size === 0) return base
		let overlaid: Map<string, EffectiveCapability> | undefined
		for (const [key, entry] of staged) {
			const { route: keyRoute, model } = splitKey(key)
			if (keyRoute !== route) continue
			overlaid ??= new Map(base ?? [])
			const current = overlaid.get(model) ?? { image: false, efforts: [] }
			overlaid.set(model, {
				image: typeof entry.patch.image === 'boolean' ? entry.patch.image : current.image,
				efforts: Array.isArray(entry.patch.efforts) ? [...entry.patch.efforts] : current.efforts,
			})
		}
		return overlaid ?? base
	}

	/**
	 * 把暂存勾选提交给 host（写影子段 + 立即调和）。
	 *
	 * **官方编辑卡片打开期间绝不写盘**：它冻结了打开时的 revision，我们的写入
	 * 会让它下一次「保存」必然 settings/conflict。只暂存、不写；卡片关闭后由
	 * 扫描回调再次调用本函数。
	 *
	 * 一次只提交一个键并串行执行：host 的写入是「读影子 → 合并 → 写」，并发会
	 * 互相覆盖。失败分两类：草稿未落盘（可重试，保留意图）与其他错误（丢弃并
	 * 回读服务端真相，让控件复位到实际状态）。
	 */
	const tryFlush = (): Promise<void> => {
		if (disposed || flushPromise !== undefined || staged.size === 0) return Promise.resolve()
		if (editorCardOpen(document)) return Promise.resolve()
		const body = async (): Promise<void> => {
			while (!disposed && staged.size > 0) {
				const now = Date.now()
				dropExpiredStaged(now)
				if (staged.size === 0) return
				if (editorCardOpen(document)) return // 卡片又打开了（例如保存失败留在原地）：立刻停手
				let key: string | undefined
				for (const [candidate, entry] of staged) {
					if (entry.retryAfter === undefined || entry.retryAfter <= now) {
						key = candidate
						break
					}
				}
				if (key === undefined) return // 全部在退避窗口内：等官方保存事件或下一次触发
				const entry = staged.get(key)
				if (entry === undefined) continue
				const { route, model } = splitKey(key)
				const result = await rpc<{ effective?: EffectiveCapability }>(ctx.connection, 'capsSet', { route, model, patch: entry.patch })
				if (result.ok) {
					staged.delete(key)
					// caps.set 只回当前模型，绝不能拿它拼一份 route map：那会让同一路由
					// 的其余模型在缓存中消失。写成功后强制拉完整路由快照。
					await requestCaps(route, true)
					continue
				}
				const code = result.error.code
				console.warn(`dsh-model-toggles: ${route}/${model} 写入失败（${code}）：${result.error.message}`)
				if (RETRYABLE_CODES.has(code)) {
					// 官方编辑器里的草稿（新增模型/新增提供方）还没保存：保留意图并退避，
					// 等官方保存触发的 document-updated（会清掉退避）再试。
					const current = staged.get(key)
					if (current !== undefined) {
						current.attempts += 1
						current.retryAfter = Date.now() + RETRY_BACKOFF_MS * Math.min(current.attempts, 4)
					}
					return
				}
				staged.delete(key)
				// 真实失败：回读服务端真相并重扫，让控件复位到实际落盘状态。
				await requestCaps(route, true)
			}
		}
		// 先挂上 flushPromise 再让函数体执行：RPC 期间可能同步派发
		// settings/document-updated（其监听器会再次调用 tryFlush），若此时
		// flushPromise 还是 undefined，就会重入成同步无限递归。
		const run = Promise.resolve()
			.then(body)
			.catch((error: unknown) => { console.warn('dsh-model-toggles: 提交暂存勾选失败', error) })
			.finally(() => { flushPromise = undefined })
		flushPromise = run
		return run
	}

	const hooks: ToggleHooks = {
		getDirectory: () => directory,
		getCaps: overlayStaged,
		isStaged: (route, model) => staged.has(stagedKeyOf(route, model)),
		requestCaps,
		onToggle: (route, model, patch: { image?: boolean, efforts?: ThinkingLevel[] }) => {
			// 合并同一模型的连续勾选（先勾图片再勾档位 → 一次提交两个维度）。
			const key = stagedKeyOf(route, model)
			const existing = staged.get(key)?.patch ?? {}
			const merged: StagedPatch = { ...existing }
			if ('image' in patch) merged.image = patch.image
			if ('efforts' in patch) merged.efforts = patch.efforts ?? []
			staged.set(key, { patch: merged, at: Date.now(), attempts: 0 })
			scheduleScan() // 立刻回显（overlay），并等待官方卡片关闭
			void tryFlush() // 没有官方卡片打开时立即写盘
		},
	}

	// 事件：settings 任何段变更都可能是「官方保存覆盖了我们的字段 → 调和补回」，
	// 失效完整快照（含已完成 promise）后重扫，避免单模型响应截断 route map。
	// 同时重试暂存（官方保存把新增模型/路由落盘后，之前被拒的勾选这次能成功）。
	const offDocumentUpdated = ((): (() => void) | undefined => {
		try {
			if (typeof ctx.remote?.$on !== 'function') return undefined
			return ctx.remote.$on('settings/document-updated', () => {
				invalidateCaps()
				dropExpiredStaged(Date.now())
				// 官方状态已变（典型：刚把新增模型/路由保存落盘）→ 清掉退避立刻重试。
				for (const entry of staged.values()) delete entry.retryAfter
				void refreshMeta().then(scheduleScan)
				void tryFlush()
			})
		} catch {
			return undefined
		}
	})()

	// 观察器：官方编辑器是 React 渲染，展开/折叠/重绘/关闭卡片都会触发 childList 变更。
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
		staged.clear()
		try {
			removeInjectedControls(document)
		} catch {
			// ignore
		}
	}, 'dsh-model-toggles: teardown')
}
