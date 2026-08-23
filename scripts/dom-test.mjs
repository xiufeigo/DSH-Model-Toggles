/**
 * DOM 集成测试（jsdom）：按官方「模型」页编辑器的真实 DOM 形状（CSS-module
 * 类名 zGbnIq_*）构建夹具，直测注入层：
 *  - 展开条目注入「图片输入 + 五档思考强度」并正确回显能力状态；
 *  - 勾选变化正确上报 host（image / efforts 载荷）；
 *  - 折叠条目不注入、展开后补注入；空 id 跳过；创建卡（无 editor 祖先）跳过；
 *  - 路由解析：editorRoute 直接命中 + rowName/显示名兜底；
 *  - 幂等：重复扫描不产生重复控件；缓存变化后状态同步。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const fail = (label, error) => {
  failures++
  console.error(`✘ ${label}:`, error?.message ?? error)
}
const ok = label => console.log(`✔ ${label}`)

const EDITOR_HTML = `
<li class="zGbnIq_rowCard">
  <div class="zGbnIq_rowHead">
    <span class="zGbnIq_rowIdentity">
      <span class="zGbnIq_rowName">OpenRouter</span>
      <span class="zGbnIq_credentialDot zGbnIq_credentialDotConfigured"></span>
    </span>
    <span class="zGbnIq_rowActions">
      <button type="button" class="zGbnIq_secondaryButton">编辑</button>
    </span>
  </div>
  <div class="zGbnIq_editor">
    <div class="zGbnIq_editorHeader">
      <span class="zGbnIq_editorTitle">OpenRouter</span>
      <span class="zGbnIq_editorRoute">openrouter</span>
    </div>
    <section class="zGbnIq_modelCatalog" aria-label="模型">
      <div class="zGbnIq_modelEntry">
        <div class="zGbnIq_modelRow">
          <input type="text" aria-label="模型 ID 1" value="stealth/ox-alpha" />
          <input type="text" aria-label="显示名称 1" value="OX-Alpha" />
          <button type="button" class="zGbnIq_iconButton" aria-expanded="true"></button>
          <button type="button" class="zGbnIq_iconButton zGbnIq_iconButtonDanger"></button>
        </div>
        <div class="zGbnIq_modelAdvanced">
          <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">上下文窗口</span><input type="text" inputmode="numeric" value="1048576" /></label>
          <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">最大输出 token</span><input type="text" inputmode="numeric" value="131072" /></label>
        </div>
      </div>
      <div class="zGbnIq_modelEntry">
        <div class="zGbnIq_modelRow">
          <input type="text" aria-label="模型 ID 2" value="vendor/x" />
          <input type="text" aria-label="显示名称 2" value="" />
          <button type="button" class="zGbnIq_iconButton" aria-expanded="false"></button>
          <button type="button" class="zGbnIq_iconButton zGbnIq_iconButtonDanger"></button>
        </div>
      </div>
      <div class="zGbnIq_modelEntry">
        <div class="zGbnIq_modelRow">
          <input type="text" aria-label="模型 ID 3" value="" />
          <input type="text" aria-label="显示名称 3" value="" />
        </div>
        <div class="zGbnIq_modelAdvanced"></div>
      </div>
    </section>
  </div>
</li>
<div class="zGbnIq_addCard">
  <div class="zGbnIq_modelEntry">
    <div class="zGbnIq_modelRow">
      <input type="text" value="create-card-model" />
      <input type="text" value="" />
    </div>
    <div class="zGbnIq_modelAdvanced"></div>
  </div>
</div>
`

try {
  // 像外壳一样装载浏览器 bundle：顶层调用 window.__ModuleLoader__.load。
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(entry_) { captured = entry_ } } }
  require(join(root, 'lib', 'client.js'))
  if (captured === null || captured.id !== 'dsh-model-toggles' || typeof captured.factory !== 'function') {
    throw new Error('bundle did not call __ModuleLoader__.load with the right id/factory')
  }
  const injectedRequire = specifier => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    throw new Error(`unexpected external require: ${specifier}`)
  }
  const pluginModule = captured.factory(injectedRequire)
  const { scanForEditorControls, removeInjectedControls } = pluginModule
  if (typeof scanForEditorControls !== 'function' || typeof removeInjectedControls !== 'function') {
    throw new Error('injection helpers missing from client bundle')
  }
  const dom = new JSDOM(EDITOR_HTML)
  const doc = dom.window.document

  const capsByRoute = new Map([
    ['openrouter', new Map([['stealth/ox-alpha', { image: true, efforts: ['high', 'max'] }]])],
  ])
  const toggles = []
  const requested = []
  const hooks = {
    getDirectory: () => ({ direct: new Set(['openrouter']), byName: new Map([['OpenRouter', 'openrouter']]) }),
    getCaps: route => capsByRoute.get(route),
    requestCaps: route => requested.push(route),
    onToggle: (route, model, patch) => toggles.push({ route, model, patch }),
  }

  const containerOf = entry => entry.querySelector('[data-dshmt-controls]')
  const entries = () => [...doc.querySelectorAll('div[class*="modelEntry"]')]

  // 1. 首次扫描：注入 + 状态回显。
  const count = scanForEditorControls(doc, hooks)
  if (count < 2) throw new Error(`expected at least 2 augmented entries, got ${count}`)
  const expanded = entries()[0]
  const container = containerOf(expanded)
  if (container === null) throw new Error('expanded entry got no controls')
  const imageBox = container.querySelector('input[data-dshmt-image]')
  if (imageBox === null || imageBox.checked !== true) throw new Error('image checkbox should be checked (caps.image=true)')
  const levelBoxes = [...container.querySelectorAll('input[data-dshmt-level]')]
  if (levelBoxes.length !== 5) throw new Error(`expected 5 level boxes, got ${levelBoxes.length}`)
  const levelStates = Object.fromEntries(levelBoxes.map(box => [box.dataset.dshmtLevel, box.checked]))
  if (levelStates.low !== false || levelStates.medium !== false || levelStates.high !== true || levelStates.xhigh !== false || levelStates.max !== true) {
    throw new Error(`level states wrong: ${JSON.stringify(levelStates)}`)
  }
  ok('DOM: 展开条目注入控件并正确回显（图片=✓，high/max=✓，其余空）')

  // 2. 勾选上报：图片取消 → {image:false}；勾低 → efforts 含 low。
  // （合成 change 事件不翻转 checked —— 先手动设置状态再派发，模拟真实点击效果。）
  imageBox.checked = false
  imageBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  if (toggles.length !== 1 || toggles[0].patch.image !== false || toggles[0].route !== 'openrouter' || toggles[0].model !== 'stealth/ox-alpha') {
    throw new Error(`image toggle payload wrong: ${JSON.stringify(toggles)}`)
  }
  const lowBox = levelBoxes.find(box => box.dataset.dshmtLevel === 'low')
  lowBox.checked = true
  lowBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  const effortsToggle = toggles[toggles.length - 1]
  if (JSON.stringify(effortsToggle.patch.efforts) !== JSON.stringify(['low', 'high', 'max'])) {
    throw new Error(`efforts toggle payload wrong: ${JSON.stringify(effortsToggle)}`)
  }
  ok('DOM: 勾选变化上报正确（image:false / efforts 全量档位）')

  // 3. 折叠条目不注入；展开后补注入。
  const collapsed = entries()[1]
  if (containerOf(collapsed) !== null) throw new Error('collapsed entry must not get controls')
  const advanced = doc.createElement('div')
  advanced.className = 'zGbnIq_modelAdvanced'
  collapsed.append(advanced)
  scanForEditorControls(doc, hooks)
  const collapsedContainer = containerOf(collapsed)
  if (collapsedContainer === null) throw new Error('expanded-later entry should get controls')
  const collapsedImage = collapsedContainer.querySelector('input[data-dshmt-image]')
  if (collapsedImage === null || collapsedImage.checked !== false) throw new Error('no-caps entry should default unchecked')
  ok('DOM: 折叠不注入、展开后补注入且无能力默认未勾选')

  // 4. 空 id 跳过、创建卡（无 editor 祖先）跳过。
  const emptyId = entries()[2]
  const createCard = entries()[3]
  if (containerOf(emptyId) !== null) throw new Error('empty-id entry must be skipped')
  if (containerOf(createCard) !== null) throw new Error('create-card entry must be skipped')
  ok('DOM: 空 id 与创建卡条目跳过')

  // 5. 幂等：重复扫描不产生重复控件。
  const before = doc.querySelectorAll('[data-dshmt-controls]').length
  scanForEditorControls(doc, hooks)
  scanForEditorControls(doc, hooks)
  if (doc.querySelectorAll('[data-dshmt-controls]').length !== before) throw new Error('re-scan duplicated controls')
  ok('DOM: 重复扫描幂等（无重复控件）')

  // 6. 缓存变化 → 状态同步。
  capsByRoute.get('openrouter').set('stealth/ox-alpha', { image: false, efforts: [] })
  scanForEditorControls(doc, hooks)
  const updatedImage = containerOf(expanded).querySelector('input[data-dshmt-image]')
  const updatedLevels = [...containerOf(expanded).querySelectorAll('input[data-dshmt-level]')]
  if (updatedImage.checked !== false || updatedLevels.some(box => box.checked)) {
    throw new Error('state did not sync after caps change')
  }
  ok('DOM: 能力缓存变化后勾选状态同步')

  // 7. 卸载清理。
  removeInjectedControls(doc)
  if (doc.querySelectorAll('[data-dshmt-controls]').length !== 0) throw new Error('removeInjectedControls left nodes')
  ok('DOM: 卸载清理全部注入节点')
} catch (error) {
  fail('DOM 集成', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll DOM integration checks passed.')
