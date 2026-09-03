/**
 * dsh-model-toggles — Host 半边。
 *
 * 在共享 webServer 上注册一条 JSON RPC 路由（POST /dsh-model-toggles/rpc），
 * 浏览器半边把它挂在官方「模型」页的每个模型条目里（图片输入 + 思考强度勾选，
 * 档位对齐 pi-ai：最低/低/中/高/超高/最高）。
 *
 * 架构：勾选状态的事实源放在本插件自己的 settings 段（`model-toggles:`），
 * host 监听 `llm-pi-ai` 段变更并把勾选【调和（reconcile）】进
 * `llm-pi-ai.providers.<route>.models` 数组。这样即使用户在官方编辑器里
 * 用过期草稿点了保存（编辑器以打开时的基线做最小 path ops，可能用旧数组
 * 覆盖我们的字段），调和器也会立即把勾选字段补回 —— 收敛、不循环。
 *
 * 写盘语义（src/capabilities.ts）：
 *  - 图片输入勾选 → 条目 input = ["text","image"]；取消 → 删除字段（继承默认）；
 *  - 思考强度勾选 → reasoningEfforts = { off:null, <勾选档位>: <档位名> }；
 *    off 恒可用（null = 支持 off、不发参数）；全部取消 → 删除字段。
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
	assertValidEntries,
	effectiveOf,
	isEmptyOverride,
	isThinkingLevel,
	mergeCapabilityEntries,
	pruneShadowProviders,
	THINKING_LEVELS,
	type CapabilityOverride,
	type ModelEntry,
	type ThinkingLevel,
} from './capabilities'

const NAME = 'dsh-model-toggles'
const RPC_PATH = `/${NAME}/rpc`
const REQUEST_HEADER = 'x-dsh-model-toggles'
const MAX_BODY_BYTES = 512 * 1024
const LLM_NS = 'llm-pi-ai'
const OWN_NS = 'model-toggles'
/** 官方保存/勾选风暴的调和去抖。 */
const RECONCILE_DEBOUNCE_MS = 30

/** 本插件影子段：providers.<route>.<modelId> = { image?, efforts? }（字段缺省 = 不管理该维度）。 */
const OwnSchema = z.object({
	providers: z.dict(z.dict(z.object({
		image: z.boolean(),
		efforts: z.array(z.union([...THINKING_LEVELS])),
	}))),
})
type ShadowSection = { providers?: Record<string, Record<string, CapabilityOverride>> } | undefined

// ── 内置目录视图（软解析 pi-ai，失败按空目录处理） ──────────────────────────

type GetBuiltinModels = (provider: string) => unknown[]

let getBuiltinModelsFn: GetBuiltinModels | undefined
let catalogLoad: Promise<void> | undefined

export function ensureCatalog(): Promise<void> {
	catalogLoad ??= import('@earendil-works/pi-ai/providers/all').then(
		mod => { getBuiltinModelsFn = (mod as { getBuiltinModels: GetBuiltinModels }).getBuiltinModels },
		() => { /* pi-ai 不可用：目录视为空 */ },
	)
	return catalogLoad
}

/** pi-ai 内置目录里某条路由的模型 passthrough 底表；未知路由/异常按空处理。 */
export function installedEntriesOf(route: string): ModelEntry[] {
	if (getBuiltinModelsFn === undefined) return []
	try {
		const models = getBuiltinModelsFn(route) as Array<Record<string, unknown>>
		const out: ModelEntry[] = []
		for (const model of models) {
			if (typeof model.id !== 'string' || model.id.length === 0) continue
			out.push({ id: model.id })
		}
		return out
	} catch {
		return []
	}
}

// ── settings 读取 / RPC 基础设施 ────────────────────────────────────────────

interface SettingsServiceLike {
	describe(options?: { redactSecrets?: boolean }): Array<{ ns: string, user?: unknown }>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	register(ns: string, schema: any, options?: { base?: unknown }): { update(patch: Record<string, unknown>): Promise<void> }
	mutate(ns: string, ops: Array<{ op: 'set' | 'unset', path: string[], value?: unknown }>, expectedRevision?: number): Promise<void>
}

interface HostContext {
	get(name: string): unknown
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	inject(deps: string[], callback: (ctx: any) => void): unknown
	effect(callback: () => (() => void) | void, label?: string): () => void
	logger?: { warn(...args: unknown[]): void, error(...args: unknown[]): void }
}

interface WebServerService {
	register(route: { kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(body))
}

/** 跨站闸门：同源预检放行，POST 必须带插件自定义头。 */
export function gateRequest(req: IncomingMessage, res: ServerResponse, methods = 'POST, OPTIONS'): boolean {
	const origin = req.headers.origin
	const host = req.headers.host
	const sameHost = typeof origin === 'string' && origin.length > 0 && typeof host === 'string'
		&& ((): boolean => {
			try { return new URL(origin).host === host } catch { return false }
		})()

	if (req.method === 'OPTIONS') {
		if (sameHost) {
			res.writeHead(204, {
				'access-control-allow-origin': origin,
				'access-control-allow-methods': methods,
				'access-control-allow-headers': `content-type, ${REQUEST_HEADER}`,
				'access-control-max-age': '600',
			})
			res.end()
		} else {
			res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('forbidden origin')
		}
		return false
	}
	if (req.method !== 'POST' || req.headers[REQUEST_HEADER] !== '1') {
		res.writeHead(req.method === 'POST' ? 403 : 405, { 'content-type': 'text/plain; charset=utf-8' })
		res.end(req.method === 'POST' ? 'forbidden' : 'POST only')
		return false
	}
	return true
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let total = 0
	for await (const chunk of req) {
		const piece = chunk as Buffer
		total += piece.byteLength
		if (total > limit) throw new Error(`请求体超过 ${limit} 字节`)
		chunks.push(piece)
	}
	if (chunks.length === 0) return {}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('请求体必须是 JSON 对象')
	}
	return parsed as Record<string, unknown>
}

/** 读 llm-pi-ai 用户段（raw user layer）。 */
export function readUserProviders(settings: SettingsServiceLike | undefined): Record<string, unknown> {
	if (settings === undefined) return {}
	try {
		const descriptor = settings.describe({ redactSecrets: false }).find(row => row.ns === LLM_NS)
		const user = asRecord(descriptor?.user)
		return asRecord(user?.providers) ?? {}
	} catch {
		return {}
	}
}

/** 读本插件影子段。 */
export function readShadowProviders(settings: SettingsServiceLike | undefined): Record<string, Record<string, CapabilityOverride>> {
	if (settings === undefined) return {}
	try {
		const descriptor = settings.describe({ redactSecrets: false }).find(row => row.ns === OWN_NS)
		const user = asRecord(descriptor?.user)
		return asRecord(user?.providers) as Record<string, Record<string, CapabilityOverride>> ?? {}
	} catch {
		return {}
	}
}

/** 某路由当前的用户 models 数组（未写 = undefined，直接使用内置目录）。 */
export function currentUserEntriesOf(providers: Record<string, unknown>, route: string): ModelEntry[] | undefined {
	const profile = asRecord(providers[route])
	const models = profile?.models
	if (!Array.isArray(models)) return undefined
	const entries: ModelEntry[] = []
	for (const raw of models) {
		const record = asRecord(raw)
		if (record === undefined || typeof record.id !== 'string' || record.id.length === 0) continue
		const entry: ModelEntry = { id: record.id }
		// 保留除受管字段外的所有原样字段（上下文窗口、最大输出、compat 等），
		// 避免勾选调和时丢失用户在官方编辑器里设置的 contextWindow / maxTokens。
		for (const [key, value] of Object.entries(record)) {
			if (key === 'id' || key === 'input' || key === 'reasoningEfforts' || key === 'name') continue
			;(entry as Record<string, unknown>)[key] = value
		}
		if (Array.isArray(record.input)) entry.input = record.input.filter((row): row is string => typeof row === 'string')
		if (record.reasoningEfforts !== null && typeof record.reasoningEfforts === 'object' && !Array.isArray(record.reasoningEfforts)) {
			const efforts: Record<string, string | null> = {}
			for (const [key, value] of Object.entries(record.reasoningEfforts as Record<string, unknown>)) {
				if (value === null) efforts[key] = null
				else if (typeof value === 'string') efforts[key] = value
			}
			entry.reasoningEfforts = efforts
		}
		if (typeof record.name === 'string' && record.name.length > 0) entry.name = record.name
		entries.push(entry)
	}
	return entries
}

// ── 调和引擎 ────────────────────────────────────────────────────────────────

export interface ReconcileOutcome {
	ok: boolean
	changedRoutes: string[]
	error?: string
}

/**
 * 把影子勾选调和进 llm-pi-ai 的 models 数组。只处理影子里有条目的路由；
 * 无差异不写（收敛保证，防事件循环）。
 * @param input.allowCreate 是否允许创建缺失条目/接管目录。**缺省 false**（引擎级
 *   安全默认：调用方漏传也绝不复活）；仅用户显式勾选（caps.set 的立即调和）显式
 *   传 true。事件驱动的兜底调和不得复活用户删除的路由/条目。
 * @param input.createIds allowCreate=true 时仅允许创建这些 id 的缺失条目
 *   （caps.set 传本次勾选的目标）；缺省 = 全部缺失条目（接管语义）。
 */
export async function reconcileRoutes(input: {
	routes: string[]
	shadow: Record<string, Record<string, CapabilityOverride>>
	providers: Record<string, unknown>
	settings: SettingsServiceLike
	allowCreate?: boolean
	createIds?: readonly string[]
}): Promise<ReconcileOutcome> {
	const ops: Array<{ op: 'set', path: string[], value: ModelEntry[] }> = []
	const changedRoutes: string[] = []
	for (const route of input.routes) {
		if (!(route in input.providers)) continue // 用户已删除该路由：绝不复活（影子段由清理流程自动移除）。
		const overrides = input.shadow[route]
		if (overrides === undefined || Object.keys(overrides).length === 0) continue
		const currentEntries = currentUserEntriesOf(input.providers, route)
		let merged
		try {
			merged = mergeCapabilityEntries({
				currentEntries,
				takeoverBase: installedEntriesOf(route),
				overrides,
				// 安全默认：undefined 一律按 false 处理（事件调和漏传不得复活删除）。
				allowCreate: input.allowCreate === true,
				...(input.createIds === undefined ? {} : { createIds: input.createIds }),
			})
		} catch (error) {
			return { ok: false, changedRoutes, error: `${route}: ${errorMessage(error)}` }
		}
		if (merged.skipped || !merged.changed) continue
		assertValidEntries(merged.entries)
		ops.push({ op: 'set', path: ['providers', route, 'models'], value: merged.entries })
		changedRoutes.push(route)
	}
	if (ops.length === 0) return { ok: true, changedRoutes }
	try {
		await input.settings.mutate(LLM_NS, ops)
		return { ok: true, changedRoutes }
	} catch (error) {
		return { ok: false, changedRoutes, error: errorMessage(error) }
	}
}

// ── RPC 分发 ────────────────────────────────────────────────────────────────

export interface Reconciler {
	reconcile(routes: string[], options?: { allowCreate?: boolean, createIds?: readonly string[] }): Promise<ReconcileOutcome>
}

interface RpcServices {
	settings: SettingsServiceLike | undefined
	reconciler: Reconciler
}

/** RPC 入口（导出仅为 smoke 直测）。 */
export async function handleRpc(req: IncomingMessage, res: ServerResponse, sv: RpcServices): Promise<void> {
	if (!gateRequest(req, res)) return
	let body: Record<string, unknown>
	try {
		body = await readJsonBody(req)
	} catch (error) {
		sendJson(res, 400, { ok: false, error: `无效请求：${errorMessage(error)}` })
		return
	}
	const method = typeof body.method === 'string' ? body.method : ''
	try {
		if (method === 'meta.routes') {
			const providers = readUserProviders(sv.settings)
			const routes = Object.keys(providers).sort().map(route => {
				const profile = asRecord(providers[route])
				const displayName = profile?.displayName
				return {
					provider: route,
					displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : route,
				}
			})
			sendJson(res, 200, { ok: true, routes })
			return
		}
		if (method === 'caps.get') {
			const route = typeof body.route === 'string' ? body.route : ''
			if (route.length === 0) {
				sendJson(res, 200, { ok: false, error: '缺少 route' })
				return
			}
			const providers = readUserProviders(sv.settings)
			const entries = currentUserEntriesOf(providers, route) ?? []
			const models: Record<string, { image: boolean, efforts: ThinkingLevel[] }> = {}
			for (const entry of entries) models[entry.id] = effectiveOf(entry)
			sendJson(res, 200, { ok: true, models })
			return
		}
		if (method === 'caps.set') {
			const route = typeof body.route === 'string' ? body.route : ''
			const model = typeof body.model === 'string' ? body.model : ''
			if (route.length === 0 || model.length === 0) {
				sendJson(res, 200, { ok: false, error: '缺少 route 或 model' })
				return
			}
			if (sv.settings === undefined) {
				sendJson(res, 200, { ok: false, error: 'settings 服务未挂载，无法写入' })
				return
			}
			const providers = readUserProviders(sv.settings)
			if (!(route in providers)) {
				sendJson(res, 200, { ok: false, error: `路由 ${route} 不在 llm-pi-ai.providers 里；先在模型页添加并保存` })
				return
			}
			const patch = asRecord(body.patch) ?? {}
			const override: CapabilityOverride = {}
			if (typeof patch.image === 'boolean') override.image = patch.image
			if (Array.isArray(patch.efforts)) {
				const efforts = patch.efforts.filter((row): row is ThinkingLevel => isThinkingLevel(row))
				override.efforts = [...new Set(efforts)]
			}
			if (isEmptyOverride(override)) {
				sendJson(res, 200, { ok: false, error: '勾选载荷为空（image / efforts 至少给一个）' })
				return
			}
			// 影子层合并：勾选即「受管」。false / 空数组是受管关闭（调和时删除字段），
			// 不是解除管理 —— 这样官方保存覆盖后调和器才知道该字段应保持删除。
			const shadow = readShadowProviders(sv.settings)
			const existing = shadow[route]?.[model] ?? {}
			const mergedOverride: CapabilityOverride = { ...existing }
			if ('image' in override) mergedOverride.image = override.image
			if ('efforts' in override) mergedOverride.efforts = override.efforts ?? []
			const managedDimensions = ('image' in mergedOverride ? 1 : 0) + ('efforts' in mergedOverride ? 1 : 0)
			const ops: Array<{ op: 'set' | 'unset', path: string[], value?: unknown }> =
				managedDimensions === 0
					? [{ op: 'unset', path: ['providers', route, model] }]
					: [{ op: 'set', path: ['providers', route, model], value: mergedOverride }]
			try {
				await sv.settings.mutate(OWN_NS, ops)
			} catch (error) {
				sendJson(res, 200, { ok: false, error: `影子段写入失败：${errorMessage(error)}` })
				return
			}
			// 立即调和（不等事件去抖），让响应携带落盘后的有效状态。
			// 用户显式勾选：允许创建缺失条目/接管目录，但只限本次勾选的目标 id ——
			// 影子段里其他已被用户删除的模型不得被顺手复活。
			const outcome = await sv.reconciler.reconcile([route], { allowCreate: true, createIds: [model] })
			if (!outcome.ok) {
				sendJson(res, 200, { ok: false, error: `写入 models 失败：${outcome.error ?? '未知错误'}` })
				return
			}
			const entries = currentUserEntriesOf(readUserProviders(sv.settings), route) ?? []
			const effective = effectiveOf(entries.find(entry => entry.id === model))
			sendJson(res, 200, { ok: true, effective })
			return
		}
		sendJson(res, 200, { ok: false, error: `未知方法 ${method}` })
	} catch (error) {
		sendJson(res, 200, { ok: false, error: errorMessage(error) })
	}
}

// ── 插件对象 ────────────────────────────────────────────────────────────────

export function apply(ctx: HostContext): void {
	/** 落盘诊断：apply 的每个阶段写一行 marker（排查装载问题用，量极小）。 */
	const diag = (stage: string, detail?: string): void => {
		try {
			const env = process.env.DSH_HOME
			const home = env !== undefined && env.trim().length > 0 ? env.trim() : join(homedir(), '.dsh')
			const dir = join(resolve(home))
			mkdirSync(dir, { recursive: true })
			appendFileSync(join(dir, 'dsh-model-toggles.apply.log'), `${new Date().toISOString()} ${stage}${detail === undefined ? '' : ` ${detail}`}\n`, 'utf8')
		} catch {
			// 诊断失败静默。
		}
	}
	diag('apply-enter')
	const webServer = ctx.get('webServer') as WebServerService | undefined
	if (webServer === undefined) {
		diag('no-webServer')
		ctx.logger?.warn?.('%s: ctx.get("webServer") 返回 undefined（inject 未就绪？），RPC 路由未注册', NAME)
		return
	}
	diag('webServer-ok')

	let settings: SettingsServiceLike | undefined
	let debounce: ReturnType<typeof setTimeout> | undefined

	const reconcileNow = async (routes?: string[], options?: { allowCreate?: boolean, createIds?: readonly string[] }): Promise<ReconcileOutcome> => {
		if (settings === undefined) return { ok: false, changedRoutes: [], error: 'settings 未挂载' }
		const shadow = readShadowProviders(settings)
		const targets = routes ?? Object.keys(shadow)
		const outcome = await reconcileRoutes({
			routes: targets,
			shadow,
			providers: readUserProviders(settings),
			settings,
			// 不传 options（事件驱动的兜底调和）= allowCreate false：绝不复活/接管。
			allowCreate: options?.allowCreate === true,
			...(options?.createIds === undefined ? {} : { createIds: options.createIds }),
		})
		// 调和成功后顺手自动清理影子段：官方编辑器删除的模型/路由，影子键跟随
		// 清掉，无需人工维护。调和失败时保守跳过（等下一轮事件重试）；清理
		// 失败只记警告，不影响勾选结果。只清已删键，收敛不循环。
		if (outcome.ok) {
			try {
				const plan = pruneShadowProviders({
					shadow: readShadowProviders(settings),
					providers: readUserProviders(settings),
				})
				const ops: Array<{ op: 'unset', path: string[] }> = [
					...plan.unsetModels
						.filter(row => !plan.unsetRoutes.includes(row.route))
						.map(row => ({ op: 'unset' as const, path: ['providers', row.route, row.model] })),
					...plan.unsetRoutes.map(route => ({ op: 'unset' as const, path: ['providers', route] })),
				]
				if (ops.length > 0) await settings.mutate(OWN_NS, ops)
			} catch (error) {
				ctx.logger?.warn?.('%s: 影子段清理失败：%s', NAME, errorMessage(error))
			}
		}
		return outcome
	}

	ctx.inject(['settings'], (sctx: { settings?: SettingsServiceLike, on?: (event: string, listener: (...args: unknown[]) => void) => unknown }) => {
		settings = sctx.settings
		if (settings === undefined) return
		try {
			settings.register(OWN_NS, OwnSchema, {})
		} catch (error) {
			ctx.logger?.warn?.('%s: settings.register(%s) 失败：%s', NAME, OWN_NS, errorMessage(error))
		}
		// 监听两段变更：官方保存覆盖 llm-pi-ai → 补回勾选字段；影子变更 → 应用勾选。
		try {
			sctx.on?.('settings/updated', (ns: unknown) => {
				if (ns !== LLM_NS && ns !== OWN_NS) return
				if (debounce !== undefined) clearTimeout(debounce)
				debounce = setTimeout(() => {
					debounce = undefined
					void reconcileNow().catch(error => {
						ctx.logger?.warn?.('%s: 调和失败：%s', NAME, errorMessage(error))
					})
				}, RECONCILE_DEBOUNCE_MS)
			})
		} catch (error) {
			ctx.logger?.warn?.('%s: settings 事件监听不可用（勾选仍可用，但官方保存覆盖后不会自动补回）：%s', NAME, errorMessage(error))
		}
		// 启动即调和 + 清理一次：修复历史覆盖，并自动清掉已删模型/路由的影子
		// 残留（含旧版本留下的无效键），无需人工清理。
		void reconcileNow().catch((error: unknown) => {
			ctx.logger?.warn?.('%s: 启动调和失败：%s', NAME, errorMessage(error))
		})
	})

	ctx.effect(() => webServer.register({
		kind: 'exact',
		path: RPC_PATH,
		handler: (req, res) => void handleRpc(req, res, {
			settings,
			reconciler: { reconcile: (routes, options) => reconcileNow(routes, options) },
		}).catch(error => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, error: errorMessage(error) })
		}),
	}), `${NAME}: rpc route`)
	diag('route-registered', RPC_PATH)
}

/**
 * 插件对象带硬 inject：等 webServer 就绪后再 apply（裸 apply 冷启动会静默丢路由）。
 */
export default {
	name: NAME,
	inject: ['webServer'],
	apply,
}
