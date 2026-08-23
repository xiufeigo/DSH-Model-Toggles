/**
 * 注入控件样式（data-plugin 标记，插件卸载时由外壳按 style[data-plugin] 清理）。
 * 类名前缀 dshmt-。
 */

const CSS = `
.dshmt-controls { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; padding:2px 0 0; font-size:12px; }
.dshmt-check { display:inline-flex; align-items:center; gap:5px; cursor:pointer; user-select:none; }
.dshmt-check input[type="checkbox"] { accent-color:#4b7bec; margin:0; }
.dshmt-group-label { opacity:.62; }
.dshmt-group { display:inline-flex; align-items:center; gap:2px 10px; flex-wrap:wrap; }
.dshmt-hint { opacity:.5; font-size:11px; }
`

export function injectStyles(): () => void {
	if (typeof document === 'undefined') return () => {}
	const tagId = 'dsh-model-toggles/controls'
	if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
		const tag = document.createElement('style')
		tag.dataset.plugin = 'dsh-model-toggles'
		tag.dataset.pluginCss = tagId
		tag.textContent = CSS
		document.head.appendChild(tag)
	}
	return () => {
		document.querySelector(`style[data-plugin-css="${tagId}"]`)?.remove()
	}
}
