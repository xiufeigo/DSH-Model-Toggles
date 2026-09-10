/**
 * 能力勾选的纯逻辑层：思考强度字段形状、条目有效状态读取、
 * 「勾选覆盖 → models 数组」的合并。不碰网络、不碰 settings、不碰 DOM。
 *
 * 写盘语义（对应 dsh-llm-pi-ai 的 catalog 解析）：
 *  - `input` 字段：勾选图片输入 → 精确写 ["text","image"]；取消勾选 → 删除字段
 *    （继承内置目录/默认，absent 与 [] 同义）；
 *  - `reasoningEfforts`：键 = 档位，值 = wire 拼写；未声明的档位被解析为不支持，
 *    因此只写勾选的档位；`off: null` 恒存在 —— null 语义是「支持 off、不发参数」，
 *    否则一旦声明任何档位，模型将无法关闭思考。
 */

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	minimal: '最低',
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '超高',
	max: '最高',
}

/** 一个模型能力条目（settings.yaml models 数组元素的超集视图）。 */
export interface ModelEntry {
	id: string
	name?: string
	input?: string[]
	reasoningEfforts?: Record<string, string | null>
	contextWindow?: number
	maxTokens?: number
	compat?: Record<string, unknown>
	[key: string]: unknown
}

/** 一条能力勾选（字段缺省 = 不动该维度）。 */
export interface CapabilityOverride {
	image?: boolean
	efforts?: ThinkingLevel[]
}

/** 勾选集合的有效状态（读侧）。 */
export interface EffectiveCapability {
	image: boolean
	efforts: ThinkingLevel[]
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

/** 由勾选档位生成 reasoningEfforts 字段；off 恒为 null（支持、不发参数）。 */
export function effortsField(checked: ThinkingLevel[]): Record<string, string | null> {
	const field: Record<string, string | null> = { off: null }
	for (const level of checked) field[level] = level
	return field
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

/** 从一条 models 条目读有效能力；字段缺省按「未开启」处理。 */
export function effectiveOf(entry: ModelEntry | undefined): EffectiveCapability {
	const image = Array.isArray(entry?.input) && entry.input.includes('image')
	const efforts: ThinkingLevel[] = []
	const raw = entry?.reasoningEfforts
	if (raw !== null && typeof raw === 'object') {
		for (const level of THINKING_LEVELS) {
			const wire = (raw as Record<string, unknown>)[level]
			if (typeof wire === 'string' && wire.length > 0) efforts.push(level)
		}
	}
	return { image, efforts }
}

/** 覆盖是否携带任一维度（空覆盖在影子层里应被剪除）。 */
export function isEmptyOverride(override: CapabilityOverride | undefined): boolean {
	if (override === undefined || override === null) return true
	const hasImage = typeof override.image === 'boolean'
	const hasEfforts = Array.isArray(override.efforts)
	return !hasImage && !hasEfforts
}

/**
 * 把能力覆盖合并进一条路由的 models 数组。
 * @param input.currentEntries 用户 settings 里现有 models 数组；undefined 表示该路由
 *   直接使用内置目录 —— 此时以 takeoverBase（目录全量 passthrough）为底表接管。
 * @param input.allowCreate 是否允许创建缺失的条目（含接管）。
 *   用户显式勾选（caps.set 的立即调和）= true；事件驱动的兜底调和 = false：
 *   后者绝不复活被官方编辑器删除的条目/路由，只修改仍在列表里的条目。
 * @param input.createIds 仅当 allowCreate=true 时生效：只允许创建这些 id 的缺失
 *   条目（caps.set 传本次勾选的目标，防止影子段里其他已删除模型被顺手复活）；
 *   缺省 = 创建全部缺失条目（保留接管语义）。
 * @returns 合并后的完整数组、是否有变化、是否发生接管；skipped 表示因
 *   allowCreate=false 而整体跳过（无需写盘）。
 */
export function mergeCapabilityEntries(input: {
	currentEntries: ModelEntry[] | undefined
	takeoverBase: ModelEntry[]
	overrides: Record<string, CapabilityOverride>
	allowCreate?: boolean
	createIds?: readonly string[]
}): { entries: ModelEntry[]; changed: boolean; createdTakeover: boolean; skipped: boolean } {
	const { overrides } = input
	const allowCreate = input.allowCreate !== false
	// 剪掉空覆盖：它们不该触发接管或写入。
	const effectiveOverrides: Record<string, CapabilityOverride> = {}
	for (const [modelId, override] of Object.entries(overrides)) {
		if (!isEmptyOverride(override)) effectiveOverrides[modelId] = override
	}
	if (Object.keys(effectiveOverrides).length === 0) {
		return { entries: input.currentEntries ?? [], changed: false, createdTakeover: false, skipped: false }
	}

	if (input.currentEntries === undefined && !allowCreate) {
		// 路由当前无 models 列表（直接用内置目录），且这不是用户显式勾选：
		// 不做接管（接管会改变「跟随内置目录」的语义，也会复活被删的列表）。
		return { entries: [], changed: false, createdTakeover: false, skipped: true }
	}

	let entries: ModelEntry[]
	let createdTakeover = false
	if (input.currentEntries === undefined) {
		const base = input.takeoverBase.map(entry => ({ ...entry, id: entry.id }))
		if (input.takeoverBase.length === 0) {
			throw new Error('路由没有用户 models 列表且内置目录不可用，无法安全接管；先在模型页添加一个模型')
		}
		entries = base
		createdTakeover = true
	} else {
		entries = structuredClone(input.currentEntries)
	}

	let changed = createdTakeover
	const byId = new Map(entries.map(entry => [entry.id, entry]))
	for (const [modelId, override] of Object.entries(effectiveOverrides)) {
		let entry = byId.get(modelId)
		if (entry === undefined) {
			if (!allowCreate) continue // 条目已被用户删除：事件调和不得复活。
			if (input.createIds !== undefined && !input.createIds.includes(modelId)) continue
			entry = { id: modelId }
			entries.push(entry)
			byId.set(modelId, entry)
			changed = true
		}
		if (typeof override.image === 'boolean') {
			const want = override.image ? ['text', 'image'] : undefined
			const next = want === undefined ? undefined : [...want]
			if (!sameJson(entry.input, next)) {
				if (next === undefined) delete entry.input
				else entry.input = next
				changed = true
			}
		}
		if (Array.isArray(override.efforts)) {
			const unique = [...new Set(override.efforts.filter(isThinkingLevel))]
			const want = unique.length === 0 ? undefined : effortsField(unique)
			if (!sameJson(entry.reasoningEfforts, want)) {
				if (want === undefined) delete entry.reasoningEfforts
				else entry.reasoningEfforts = want
				changed = true
			}
		}
	}
	return { entries, changed, createdTakeover, skipped: false }
}

/** 写盘前的最后校验。 */
export function assertValidEntries(entries: ModelEntry[]): void {
	const seen = new Set<string>()
	for (const entry of entries) {
		if (typeof entry.id !== 'string' || entry.id.length === 0) {
			throw new Error(`模型条目缺少非空 id：${JSON.stringify(entry)}`)
		}
		if (seen.has(entry.id)) throw new Error(`模型 id 重复：${entry.id}`)
		seen.add(entry.id)
	}
}

/**
 * 内置目录条目 → ModelEntry 的防御式转换（保留 name / input / reasoningEfforts /
 * contextWindow / maxTokens / compat，未知形状按缺省处理）。接管底表用它保持
 * 目录字段，避免接管写出只剩裸 id 的条目。
 */
export function catalogEntriesOf(models: unknown[]): ModelEntry[] {
	const out: ModelEntry[] = []
	for (const raw of models) {
		const record = asRecord(raw)
		if (record === undefined || typeof record.id !== 'string' || record.id.length === 0) continue
		const entry: ModelEntry = { id: record.id }
		if (typeof record.name === 'string' && record.name.length > 0) entry.name = record.name
		if (Array.isArray(record.input)) entry.input = record.input.filter((row): row is string => typeof row === 'string')
		const efforts = asRecord(record.reasoningEfforts)
		if (efforts !== undefined) {
			const map: Record<string, string | null> = {}
			for (const [key, value] of Object.entries(efforts)) {
				if (value === null) map[key] = null
				else if (typeof value === 'string') map[key] = value
			}
			entry.reasoningEfforts = map
		}
		if (typeof record.contextWindow === 'number') entry.contextWindow = record.contextWindow
		if (typeof record.maxTokens === 'number') entry.maxTokens = record.maxTokens
		const compat = asRecord(record.compat)
		if (compat !== undefined) entry.compat = { ...compat }
		out.push(entry)
	}
	return out
}

/** 影子段清理计划：需要 unset 的路由段与模型键，以及清理后的完整影子树。 */
export interface ShadowPrunePlan {
	next: Record<string, Record<string, CapabilityOverride>>
	unsetRoutes: string[]
	unsetModels: Array<{ route: string, model: string }>
}

/**
 * 影子段自动清理（纯逻辑）：删掉「事实已不存在」的影子键，让影子段与
 * llm-pi-ai 用户配置保持一致 —— 用户在官方编辑器里删除模型/路由后无需人工
 * 清理影子段。
 *  - 路由不在 providers 里（已删除）→ 整段清理；
 *  - 路由有显式 models 列表 → 清掉不在列表里的模型键（含空覆盖）；
 *  - 路由无 models 列表（跟随内置目录）→ 无法凭列表判定删除，保留非空键；
 *  - 清理后变空的路段连路由键一起移除，不留 `route: {}` 尾巴。
 */
export function pruneShadowProviders(input: {
	shadow: Record<string, Record<string, CapabilityOverride>>
	providers: Record<string, unknown>
}): ShadowPrunePlan {
	const next: Record<string, Record<string, CapabilityOverride>> = {}
	const unsetRoutes: string[] = []
	const unsetModels: Array<{ route: string, model: string }> = []
	for (const [route, overrides] of Object.entries(input.shadow)) {
		const profile = asRecord(input.providers[route])
		if (profile === undefined) {
			unsetRoutes.push(route) // 路由已被用户删除：整段清理。
			continue
		}
		const models = Array.isArray(profile.models) ? profile.models : undefined
		const kept: Record<string, CapabilityOverride> = {}
		if (models === undefined) {
			// 跟随内置目录：没有显式列表可对照，保留非空覆盖，仅清空覆盖。
			for (const [model, override] of Object.entries(overrides)) {
				if (isEmptyOverride(override)) unsetModels.push({ route, model })
				else kept[model] = override
			}
		} else {
			const liveIds = new Set<string>()
			for (const raw of models) {
				const record = asRecord(raw)
				if (typeof record?.id === 'string' && record.id.length > 0) liveIds.add(record.id)
			}
			for (const [model, override] of Object.entries(overrides)) {
				if (!liveIds.has(model) || isEmptyOverride(override)) unsetModels.push({ route, model })
				else kept[model] = override
			}
		}
		if (Object.keys(kept).length > 0) next[route] = kept
		else unsetRoutes.push(route) // 段空了（或本来就是空段）：连路由键一起移除。
	}
	return { next, unsetRoutes, unsetModels }
}
