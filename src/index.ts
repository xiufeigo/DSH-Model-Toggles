/**
 * dsh-model-toggles — Host 半边。
 *
 * 接入方式完全走 DSH 官方 Typert Remote（**SRC / 源模式**落地）：
 *
 *  - 本插件是一个 `TypertRemoteService`（Cordis Service），Cordis service key
 *    即 wire namespace（`modelToggles`）；
 *  - 三个 `@Remote` 方法由 **Api Gateway 在共享 `/api` 通道上自动认领** ——
 *    gateway 的 `collectSrcClaims()` 扫描 `ctx.reflect.props` 里所有带
 *    `typertRemote` 绑定的 Service（非硬编码名册），因此第三方插件无需任何注册；
 *  - 浏览器半边用官方传输 `ctx.connection.rpc.call('/api', 'modelToggles/<method>',
 *    { args })` 调用；路由挂载、Host/Origin 信任闸门、浏览器会话鉴权、rpcId
 *    关联与信封校验全部由 @deepseek-ai/dsh-client-connection / dsh-api-gateway 拥有；
 *  - 业务失败抛 `RemoteError`（稳定 code + 结构化 details），由 Gateway 原样编码到
 *    wire 的 error 分支。
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

import { type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
	assertValidEntries,
	catalogEntriesOf,
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
/** Cordis service key —— 同时是 Typert wire namespace（网关按此认领 `/api` 端点）。 */
export const SERVICE_KEY = 'modelToggles'
const LLM_NS = 'llm-pi-ai'
const OWN_NS = 'model-toggles'
/** 官方保存/勾选风暴的调和去抖。 */
const RECONCILE_DEBOUNCE_MS = 30

/** `metaRoutes` 的一行：路由键 + 展示名。 */
export interface RouteMeta {
	readonly provider: string
	readonly displayName: string
}

/** 一个模型的有效能力（读侧）。 */
export interface ModelCaps {
	readonly image: boolean
	readonly efforts: readonly ThinkingLevel[]
}

/** `capsSet` 的勾选载荷：字段缺省 = 不动该维度。 */
export interface CapsPatch {
	readonly image?: boolean
	readonly efforts?: readonly ThinkingLevel[]
}

/** 本插件声明的 Remote 失败码（Gateway 原样透传，调用方按 code 判别）。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
	interface RemoteErrorDetailsMap {
		/** 端点载荷不合法（缺字段 / 空勾选）。 */
		'model-toggles/bad-request': { readonly endpoint: string }
		/** 目标路由不在 `llm-pi-ai.providers` 里。 */
		'model-toggles/route-unknown': { readonly route: string }
		/** 目标模型不在该路由**已保存**的 models 列表里。 */
		'model-toggles/model-unsaved': { readonly route: string, readonly model: string }
		/** settings 服务未挂载或写盘被拒。 */
		'model-toggles/write-failed': { readonly route: string }
	}
}

/** 本插件影子段：providers.<route>.<modelId> = { image?, efforts? }（字段缺省 = 不管理该维度）。 */
const OwnSchema = z.object({
	providers: z.dict(z.dict(z.object({
		image: z.boolean(),
		efforts: z.array(z.union([...THINKING_LEVELS])),
	}))),
})

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
		return catalogEntriesOf(getBuiltinModelsFn(route))
	} catch {
		return []
	}
}

// ── settings 读取 ──────────────────────────────────────────────────────────

export interface SettingsServiceLike {
	describe(options?: { redactSecrets?: boolean }): Array<{ ns: string, user?: unknown }>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	register(ns: string, schema: any, options?: { base?: unknown }): { update(patch: Record<string, unknown>): Promise<void> }
	mutate(ns: string, ops: Array<{ op: 'set' | 'unset', path: string[], value?: unknown }>, expectedRevision?: number): Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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
 *   安全默认：调用方漏传也绝不复活）；仅用户显式勾选（capsSet 的立即调和）显式
 *   传 true。事件驱动的兜底调和不得复活用户删除的路由/条目。
 * @param input.createIds allowCreate=true 时仅允许创建这些 id 的缺失条目
 *   （capsSet 传本次勾选的目标）；缺省 = 全部缺失条目（接管语义）。
 * @param input.getInstalled 内置目录视图（测试注入用）；缺省 installedEntriesOf。
 *   注意：接管只对「路由键 = pi-ai 内置 provider 名」的路由有底表，自定义路由键
 *   按空目录处理（安全拒绝接管）。
 */
export async function reconcileRoutes(input: {
	routes: string[]
	shadow: Record<string, Record<string, CapabilityOverride>>
	providers: Record<string, unknown>
	settings: SettingsServiceLike
	allowCreate?: boolean
	createIds?: readonly string[]
	getInstalled?: (route: string) => ModelEntry[]
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
				takeoverBase: (input.getInstalled ?? installedEntriesOf)(route),
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

// ── Remote 端点实现（纯逻辑，服务方法只做委托 ⇒ 可直测） ────────────────────

export interface Reconciler {
	reconcile(routes: string[], options?: { allowCreate?: boolean, createIds?: readonly string[], prune?: boolean }): Promise<ReconcileOutcome>
}

export interface RpcServices {
	settings: SettingsServiceLike | undefined
	reconciler: Reconciler
	/** 内置目录视图（测试注入用）；缺省 installedEntriesOf（真实 pi-ai 目录）。 */
	getInstalled?: (route: string) => ModelEntry[]
}

/**
 * `ctx.inject(['settings'], cb)` 回调里的作用域面。cordis 的 `Context` 类型只在
 * 装载了 dsh-settings 时才声明 settings 服务与 settings/updated 事件，本包不依赖
 * 它的类型（保持 @deepseek-ai/* 全部 external），故按结构声明。
 */
interface SettingsScope {
	settings?: SettingsServiceLike
	on(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * 三个 Remote 端点的实现。失败一律抛 `RemoteError`（Gateway 转成 wire 上
 * `{ok:false, error}` 分支）；成功返回值本身。
 * @param services - 取当前服务（settings 可能在 apply 之后才挂载，故用取值函数）。
 * @returns 与 Service 上 `@Remote` 方法一一对应的实现。
 */
export function createHandlers(services: () => RpcServices) {
	const bad = (endpoint: string, message: string): never => {
		throw new RemoteError('model-toggles/bad-request', message, { endpoint })
	}
	return {
		/** 列出 llm-pi-ai 已配置的路由（路由键 + 展示名）。 */
		async metaRoutes(): Promise<{ routes: RouteMeta[] }> {
			const sv = services()
			const providers = readUserProviders(sv.settings)
			const routes = Object.keys(providers).sort().map(route => {
				const profile = asRecord(providers[route])
				const displayName = profile?.displayName
				return {
					provider: route,
					displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : route,
				}
			})
			return { routes }
		},

		/** 读一条路由上每个模型的有效能力（目录 passthrough 路由回退内置目录）。 */
		async capsGet(route: string): Promise<{ models: Record<string, ModelCaps> }> {
			const sv = services()
			if (typeof route !== 'string' || route.length === 0) return bad('capsGet', '缺少 route')
			await ensureCatalog()
			const providers = readUserProviders(sv.settings)
			const entries = currentUserEntriesOf(providers, route) ?? (sv.getInstalled ?? installedEntriesOf)(route)
			const models: Record<string, ModelCaps> = {}
			for (const entry of entries) models[entry.id] = effectiveOf(entry)
			return { models }
		},

		/** 写入一次勾选：影子段 + 立即调和，返回该模型落盘后的有效能力。 */
		async capsSet(route: string, model: string, patch: CapsPatch): Promise<{ effective: ModelCaps }> {
			const sv = services()
			if (typeof route !== 'string' || route.length === 0 || typeof model !== 'string' || model.length === 0) {
				return bad('capsSet', '缺少 route 或 model')
			}
			if (sv.settings === undefined) {
				throw new RemoteError('model-toggles/write-failed', 'settings 服务未挂载，无法写入', { route })
			}
			const providers = readUserProviders(sv.settings)
			if (!(route in providers)) {
				throw new RemoteError('model-toggles/route-unknown', `路由 ${route} 不在 llm-pi-ai.providers 里；先在模型页添加并保存`, { route })
			}
			// 只接受已保存条目：官方编辑器里的草稿/新增行（未保存）不得直接建裸条目 ——
			// 否则与官方保存的插入 op 撞出重复 id，assertValidEntries 会让后续调和永久
			// 失败。目录路由（无显式 models 列表）例外：那正是「首次勾选 → 接管」路径。
			{
				const profile = asRecord(providers[route])
				if (Array.isArray(profile?.models)) {
					const savedIds = new Set<string>()
					for (const raw of profile.models) {
						const record = asRecord(raw)
						if (typeof record?.id === 'string' && record.id.length > 0) savedIds.add(record.id)
					}
					if (!savedIds.has(model)) {
						throw new RemoteError(
							'model-toggles/model-unsaved',
							`模型 ${model} 不在路由 ${route} 已保存的 models 列表；请先在官方编辑器保存该模型，再回来勾选`,
							{ route, model },
						)
					}
				}
			}
			const payload = asRecord(patch) ?? {}
			const override: CapabilityOverride = {}
			if (typeof payload.image === 'boolean') override.image = payload.image
			if (Array.isArray(payload.efforts)) {
				const efforts = payload.efforts.filter((row): row is ThinkingLevel => isThinkingLevel(row))
				override.efforts = [...new Set(efforts)]
			}
			if (isEmptyOverride(override)) return bad('capsSet', '勾选载荷为空（image / efforts 至少给一个）')
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
				throw new RemoteError('model-toggles/write-failed', `影子段写入失败：${errorMessage(error)}`, { route })
			}
			// 立即调和（不等事件去抖），让响应携带落盘后的有效状态。
			// 用户显式勾选：允许创建缺失条目/接管目录，但只限本次勾选的目标 id ——
			// 影子段里其他已被用户删除的模型不得被顺手复活。
			const outcome = await sv.reconciler.reconcile([route], { allowCreate: true, createIds: [model] })
			if (!outcome.ok) {
				throw new RemoteError('model-toggles/write-failed', `写入 models 失败：${outcome.error ?? '未知错误'}`, { route })
			}
			const entries = currentUserEntriesOf(readUserProviders(sv.settings), route) ?? []
			return { effective: effectiveOf(entries.find(entry => entry.id === model)) }
		},
	}
}

// ── 插件本体：TypertRemoteService（Service 类即插件） ────────────────────────

/**
 * settings 段变更 → 去抖兜底调和。**清理只在官方保存（LLM_NS）触发** —— 影子段
 * 自身变更（OWN_NS）只调和不清理，防止刚写入、尚未调和成功的键被当成「不在
 * models 列表」误删。导出以便冒烟直测这段接线（事件名过滤 / 清理开关 / 去抖）。
 * @param input.reconcile - 触发一次兜底调和（缺省 allowCreate=false）。
 * @param input.onError - 调和失败回调。
 * @param input.debounceMs - 去抖窗口。
 * @returns 供 `settings/updated` 直接使用的监听器。
 */
export function createSettingsWatcher(input: {
	reconcile: (routes?: string[], options?: { allowCreate?: boolean, createIds?: readonly string[], prune?: boolean }) => Promise<ReconcileOutcome>
	onError: (error: unknown) => void
	debounceMs?: number
}): (ns: unknown) => void {
	let timer: ReturnType<typeof setTimeout> | undefined
	return (ns: unknown): void => {
		if (ns !== LLM_NS && ns !== OWN_NS) return
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = undefined
			void input.reconcile(undefined, { prune: ns === LLM_NS }).catch(input.onError)
		}, input.debounceMs ?? RECONCILE_DEBOUNCE_MS)
	}
}

/** 落盘诊断：apply 的每个阶段写一行 marker（排查装载问题用，量极小）。 */
function diag(stage: string, detail?: string): void {
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

/**
 * 模型能力勾选的 Host 服务。Cordis service key = Typert wire namespace
 * （`modelToggles`），三个 `@Remote` 方法由 Api Gateway 在 `/api` 上自动认领。
 */
export class ModelTogglesService extends TypertRemoteService {
	private settings: SettingsServiceLike | undefined
	private readonly handlers = createHandlers(() => ({
		settings: this.settings,
		reconciler: { reconcile: (routes, options) => this.reconcileNow(routes, options) },
	}))
	private readonly watchSettings = createSettingsWatcher({
		reconcile: (routes, options) => this.reconcileNow(routes, options),
		onError: (error) => { this.ctx.logger.warn('%s: 调和失败：%s', NAME, errorMessage(error)) },
	})

	constructor(ctx: Context) {
		super(ctx, SERVICE_KEY)
		diag('apply-enter')
		// 目录预热：懒加载 pi-ai 内置 provider 目录（失败按空目录降级，接管/回退
		// 读侧仍可用，只是无底表）。
		void ensureCatalog()
		diag('service-registered', SERVICE_KEY)

		ctx.inject(['settings'], (injected) => {
			const scope = injected as unknown as SettingsScope
			this.settings = scope.settings
			if (this.settings === undefined) return
			try {
				this.settings.register(OWN_NS, OwnSchema, {})
			} catch (error) {
				ctx.logger.warn('%s: settings.register(%s) 失败：%s', NAME, OWN_NS, errorMessage(error))
			}
			// 监听两段变更：官方保存覆盖 llm-pi-ai → 补回勾选字段；影子变更 → 应用勾选。
			try {
				scope.on('settings/updated', this.watchSettings)
			} catch (error) {
				ctx.logger.warn('%s: settings 事件监听不可用（勾选仍可用，但官方保存覆盖后不会自动补回）：%s', NAME, errorMessage(error))
			}
			// 启动即调和 + 清理一次：修复历史覆盖，并自动清掉已删模型/路由的影子
			// 残留（含旧版本留下的无效键），无需人工清理。
			void this.reconcileNow().catch((error: unknown) => {
				ctx.logger.warn('%s: 启动调和失败：%s', NAME, errorMessage(error))
			})
		})
	}

	/** 调和 + 顺手清理影子段；失败不抛出（调用方按需取 outcome）。 */
	private async reconcileNow(routes?: string[], options?: { allowCreate?: boolean, createIds?: readonly string[], prune?: boolean }): Promise<ReconcileOutcome> {
		const settings = this.settings
		if (settings === undefined) return { ok: false, changedRoutes: [], error: 'settings 未挂载' }
		// 目录装载（懒加载、缓存）：接管底表与 capsGet 回退都依赖它。
		await ensureCatalog()
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
		// 清掉，无需人工维护。触发时机限定「官方保存（LLM_NS 事件）/ 启动 /
		// capsSet 立即调和」—— 影子段自身变更（OWN_NS 事件）只调和不清理。
		// 清理失败只记警告，不影响勾选结果；只清已删键，收敛不循环。
		if (outcome.ok && options?.prune !== false) {
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
				this.ctx.logger.warn('%s: 影子段清理失败：%s', NAME, errorMessage(error))
			}
		}
		return outcome
	}

	/** 列出 llm-pi-ai 已配置的路由。 */
	@Remote
	async metaRoutes(): Promise<{ routes: RouteMeta[] }> {
		return this.handlers.metaRoutes()
	}

	/** 读一条路由上每个模型的有效能力。 */
	@Remote
	async capsGet(route: string): Promise<{ models: Record<string, ModelCaps> }> {
		return this.handlers.capsGet(route)
	}

	/** 写入一次勾选并返回落盘后的有效能力。 */
	@Remote
	async capsSet(route: string, model: string, patch: CapsPatch): Promise<{ effective: ModelCaps }> {
		return this.handlers.capsSet(route, model, patch)
	}
}

export default ModelTogglesService
