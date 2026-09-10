/**
 * DOM 注入层：在官方「模型」页编辑器的每个模型条目里挂能力勾选
 * （图片输入 + 思考强度：最低/低/中/高/超高/最高）。
 *
 * 锚点全部走语义化钩子，尽量抗上游小改动：
 *  - 条目容器 div[class*="modelEntry"]（CSS-module 名为 <hash>_modelEntry）；
 *  - 编辑器根 div[class*="editor"]（排除自定义提供方创建卡，其根是 addCard）；
 *  - 路由解析：li[class*="rowCard"/"setupCard"] 内 editorRoute 文本（直接是路由键）
 *    → rowName 文本 → editorTitle 文本 → 目录映射（显示名 → 路由键）；
 *  - 模型 id：modelRow 里第一个文本输入框（官方 aria-label「模型 ID N」）。
 *
 * 官方编辑器保存用「打开时基线」做最小 path ops，可能用过期数组覆盖我们的
 * 字段；因此勾选状态的事实源在 host 影子段，host 在 llm-pi-ai 变更后自动
 * 调和补回 —— 本层只负责渲染与上报，不信任官方草稿。
 *
 * 写盘时机由上层（src/client/index.tsx）决定：官方编辑卡片打开期间只暂存
 * （卡片冻结了打开时的 settings revision，外部写入会让它的保存必然冲突），
 * 因此这里额外渲染一个「待写入」提示（`editorCardOpen()` 判定卡片是否还在）。
 */

import {
	THINKING_LEVEL_LABELS,
	type EffectiveCapability,
	type ThinkingLevel,
} from '../capabilities'

export const CONTROLS_MARKER = 'dshmt-controls'
/** 暂存态提示（官方卡片打开期间勾选只暂存，关闭卡片后才写盘）。 */
const STAGED_HINT = '待写入：保存或关闭本卡片后生效'

export interface ToggleHooks {
	/** 目录映射：直接路由键集合 + 显示名→路由键。 */
	getDirectory(): { direct: Set<string>, byName: Map<string, string> }
	/** 某路由的有效能力缓存（含暂存覆盖；undefined = 尚未拉取）。 */
	getCaps(route: string): Map<string, EffectiveCapability> | undefined
	/** 该 (route, model) 是否有尚未提交 host 的暂存勾选。 */
	isStaged?(route: string, model: string): boolean
	/** 需要为某路由拉取能力（异步完成后调用方应再扫一遍）。 */
	requestCaps(route: string): void
	/** 勾选变化上报 host。 */
	onToggle(route: string, model: string, patch: { image?: boolean, efforts?: ThinkingLevel[] }): void
}

/**
 * 是否有官方的 llm-pi-ai 编辑卡片正打开着。
 *
 * 判定 = DOM 里存在位于某个 `div[class*="editor"]` 内的 `div[class*="modelEntry"]`。
 * 官方两类卡片（既有提供方的 `ProviderEditor` 与「添加自定义提供方」的
 * `CustomProviderCard`，后者根节点同样是 `zGbnIq_editor`）都渲染模型条目，
 * 且都把打开那一刻的 settings revision 冻结在自己的 React state 里 —— 卡片
 * 打开期间对 `llm-pi-ai` 的任何外部写入都会让它的下一次保存变成
 * `settings/conflict`。没有模型条目的卡片不可能有本插件控件，故无需单独判定。
 */
export function editorCardOpen(doc: Document): boolean {
	if (typeof doc === 'undefined' || doc.body === null) return false
	for (const entry of doc.body.querySelectorAll('div[class*="modelEntry"]')) {
		if (entry.closest('div[class*="editor"]') !== null) return true
	}
	return false
}

function firstTextInput(parent: ParentNode, selector: string): HTMLInputElement | undefined {
	const candidates = parent.querySelectorAll(selector)
	for (const candidate of candidates) {
		const input = candidate as HTMLInputElement
		if (input.tagName === 'INPUT' && input.type === 'text') return input
	}
	return undefined
}

/** 从条目向上解析 (route, modelId)；解析失败返回 undefined（不注入）。 */
function resolveTarget(entry: Element, hooks: ToggleHooks): { route: string, modelId: string } | undefined {
	// 只认官方编辑卡片里的条目。注意「添加自定义提供方」卡片（CustomProviderCard）
	// 根节点同样是 zGbnIq_editor，真正把它排除在外的是路由解析：它既没有
	// editorRoute 文本，editorTitle 也是本地化的标题（不在「显示名 → 路由键」
	// 目录里），因此解析不到 route。
	if (entry.closest('div[class*="editor"]') === null) return undefined
	const row = entry.querySelector(':scope > div[class*="modelRow"]') ?? entry.querySelector('div[class*="modelRow"]')
	const idInput = row === null ? undefined : firstTextInput(row, 'input[type="text"]')
	const modelId = idInput?.value.trim() ?? ''
	if (modelId.length === 0) return undefined

	const li = entry.closest('li[class*="rowCard"], li[class*="setupCard"]')
	const card = li ?? entry.parentElement
	if (card === null) return undefined
	const directory = hooks.getDirectory()
	const routeText = card.querySelector('[class*="editorRoute"]')?.textContent?.trim()
	if (routeText !== undefined && routeText.length > 0 && directory.direct.has(routeText)) {
		return { route: routeText, modelId }
	}
	for (const selector of ['[class*="rowName"]', '[class*="editorTitle"]']) {
		const text = card.querySelector(selector)?.textContent?.trim()
		if (text !== undefined && text.length > 0) {
			const mapped = directory.byName.get(text)
			if (mapped !== undefined) return { route: mapped, modelId }
		}
	}
	return undefined
}

function levelBoxes(container: HTMLElement): HTMLInputElement[] {
	const boxes: HTMLInputElement[] = []
	for (const input of container.querySelectorAll('input[type="checkbox"][data-dshmt-level]')) {
		boxes.push(input as HTMLInputElement)
	}
	return boxes
}

/** 用有效能力更新既有控件的勾选状态（不发事件），并同步暂存提示。 */
function updateStates(container: HTMLElement, caps: EffectiveCapability | undefined, staged: boolean): void {
	const image = container.querySelector<HTMLInputElement>('input[data-dshmt-image]')
	if (image !== null) image.checked = caps?.image === true
	const checkedLevels = new Set(caps?.efforts ?? [])
	for (const box of levelBoxes(container)) {
		box.checked = checkedLevels.has(box.dataset.dshmtLevel as ThinkingLevel)
	}
	container.dataset.dshmtStaged = staged ? '1' : '0'
	const hint = container.querySelector<HTMLElement>('[data-dshmt-pending]')
	if (hint !== null) hint.hidden = !staged
}

function checkedLevels(container: HTMLElement): ThinkingLevel[] {
	const levels: ThinkingLevel[] = []
	for (const box of levelBoxes(container)) {
		if (box.checked) levels.push(box.dataset.dshmtLevel as ThinkingLevel)
	}
	return levels
}

/** 在一条展开的模型条目里构建（或更新）能力勾选控件。 */
function augmentEntry(entry: Element, route: string, modelId: string, hooks: ToggleHooks): void {
	const advanced = entry.querySelector(':scope > div[class*="modelAdvanced"]') ?? entry.querySelector('div[class*="modelAdvanced"]')
	if (advanced === null) return // 未展开：折叠后 React 会移除高级区，展开时观察器会再次扫描

	let container = advanced.querySelector<HTMLElement>(`:scope > div[data-${CONTROLS_MARKER}]`) as HTMLElement | null
	// 陈旧检测：model 或 route 变了都要重建 —— 监听闭包捕获的是当时的 (route,
	// modelId)，路由映射变化后旧监听会把勾选写去错误路由。
	const staleModel = container?.dataset.dshmtModel ?? null
	const staleRoute = container?.dataset.dshmtRoute ?? null
	if (container !== null && ((staleModel !== null && staleModel !== modelId) || (staleRoute !== null && staleRoute !== route))) {
		container.remove()
		container = null
	}
	const caps = hooks.getCaps(route)?.get(modelId)
	const staged = hooks.isStaged?.(route, modelId) === true
	if (container !== null) {
		updateStates(container, caps, staged)
		return
	}

	container = entry.ownerDocument.createElement('div')
	// dataset 属性名必须驼峰（DOMStringMap 校验）：生成 data-dshmt-controls="1"。
	container.dataset.dshmtControls = '1'
	container.dataset.dshmtModel = modelId
	container.dataset.dshmtRoute = route
	container.className = CONTROLS_MARKER

	// 图片输入
	const imageLabel = entry.ownerDocument.createElement('label')
	imageLabel.className = 'dshmt-check'
	const imageBox = entry.ownerDocument.createElement('input')
	imageBox.type = 'checkbox'
	imageBox.dataset.dshmtImage = '1'
	imageBox.addEventListener('change', () => {
		hooks.onToggle(route, modelId, { image: imageBox.checked })
	})
	imageLabel.append(imageBox, entry.ownerDocument.createTextNode('图片输入'))

	// 思考强度
	const group = entry.ownerDocument.createElement('span')
	group.className = 'dshmt-group'
	const groupLabel = entry.ownerDocument.createElement('span')
	groupLabel.className = 'dshmt-group-label'
	groupLabel.textContent = '思考强度:'
	group.append(groupLabel)
	for (const level of Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]) {
		const label = entry.ownerDocument.createElement('label')
		label.className = 'dshmt-check'
		const box = entry.ownerDocument.createElement('input')
		box.type = 'checkbox'
		box.dataset.dshmtLevel = level
		box.addEventListener('change', () => {
			hooks.onToggle(route, modelId, { efforts: checkedLevels(container as HTMLElement) })
		})
		label.append(box, entry.ownerDocument.createTextNode(THINKING_LEVEL_LABELS[level]))
		group.append(label)
	}

	container.append(imageLabel, group)

	// 暂存提示：官方卡片打开期间勾选不写盘（写了会让官方「保存」必然冲突）。
	const hint = entry.ownerDocument.createElement('span')
	hint.className = 'dshmt-hint'
	hint.dataset.dshmtPending = '1'
	hint.textContent = STAGED_HINT
	hint.hidden = true
	container.append(hint)

	updateStates(container, caps, staged)
	advanced.append(container)
}

/**
 * 扫描文档并注入/更新能力勾选。返回处理过的条目数。
 * 纯 DOM 操作 + hooks，无模块表依赖，可反复调用（幂等）。
 */
export function scanForEditorControls(doc: Document, hooks: ToggleHooks): number {
	if (typeof doc === 'undefined' || doc.body === null) return 0
	let count = 0
	for (const entry of doc.body.querySelectorAll('div[class*="modelEntry"]')) {
		const target = resolveTarget(entry, hooks)
		if (target === undefined) continue
		if (hooks.getCaps(target.route) === undefined) {
			hooks.requestCaps(target.route)
			continue
		}
		augmentEntry(entry, target.route, target.modelId, hooks)
		count += 1
	}
	return count
}

/** 卸载时清掉所有注入的控件（外壳也会按 style[data-plugin] 清样式）。 */
export function removeInjectedControls(doc: Document): void {
	if (typeof doc === 'undefined' || doc.body === null) return
	for (const node of doc.body.querySelectorAll(`[data-${CONTROLS_MARKER}]`)) {
		node.remove()
	}
}
