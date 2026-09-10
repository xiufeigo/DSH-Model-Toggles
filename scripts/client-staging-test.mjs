/**
 * 暂存（staging）回归测试 —— 直击两个真实报障：
 *
 *  1. 「模型界面改完上下文，再改思考强度/图片输入 → 保存报：这张卡片打开期间，
 *     这些设置已被其他地方改动…」
 *     根因：官方编辑卡片把打开时的 settings revision 冻结在 React state 里
 *     （dsh-client-ui-settings-models 的 expectedRevision），插件在卡片打开期间
 *     写入 llm-pi-ai 会让它的下一次「保存」必然 settings/conflict。
 *     本测试断言：**卡片打开期间 caps.set 调用次数为 0**，且每个 caps.set 都
 *     发生在 DOM 里没有官方编辑卡片的时候。
 *
 *  2. 「新增模型界面勾上图片输入/思考强度后自动消失」
 *     根因：新增（未保存）模型不在官方已保存的 models 列表里，host 拒绝
 *     （model-toggles/model-unsaved），旧实现立刻回读服务端真相 → 控件被复位。
 *     本测试断言：暂存后控件保持勾选（staged 标记 + 提示可见），等官方保存把
 *     模型落盘后自动补写成功。
 *
 * 另外覆盖：真实写盘失败（非草稿原因）→ 丢弃意图并回读服务端真相，控件回到
 * 实际状态（不长期显示假勾选）。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
const fail = (label, error) => {
  failures++
  console.error(`✘ ${label}:`, error?.message ?? error)
}
const ok = label => console.log(`✔ ${label}`)

const CARD_HTML = `
<li class="zGbnIq_rowCard">
  <div class="zGbnIq_rowHead"><span class="zGbnIq_rowName">Qwen Coding Plan</span></div>
  <div class="zGbnIq_editor">
    <div class="zGbnIq_editorHeader">
      <span class="zGbnIq_editorTitle">Qwen Coding Plan</span>
      <span class="zGbnIq_editorRoute">qwen-coding-plan</span>
    </div>
    <section class="zGbnIq_modelCatalog" aria-label="模型">
      <div class="zGbnIq_modelEntry">
        <div class="zGbnIq_modelRow"><input type="text" value="qwen3.6-plus" /><input type="text" value="qwen3.6-plus" /></div>
        <div class="zGbnIq_modelAdvanced"></div>
      </div>
      <div class="zGbnIq_modelEntry">
        <div class="zGbnIq_modelRow"><input type="text" value="brand/new-model" /><input type="text" value="" /></div>
        <div class="zGbnIq_modelAdvanced"></div>
      </div>
    </section>
  </div>
</li>
`

try {
  const dom = new JSDOM(`<div id="host">${CARD_HTML}</div>`, { url: 'http://127.0.0.1/' })
  const doc = dom.window.document
  globalThis.window = dom.window
  globalThis.document = doc
  globalThis.MutationObserver = dom.window.MutationObserver

  /** 服务端真相：已落盘的模型能力 + 新增模型是否已随官方保存落盘。 */
  const server = {
    caps: { 'qwen3.6-plus': { image: false, efforts: [] } },
    drafted: false,
    failFor: new Set(),
  }

  let remoteListener
  const calls = []
  /** 与插件同款判定：此刻 DOM 里是否有官方编辑卡片（它冻结着 settings revision）。 */
  const cardOpenNow = () => [...doc.querySelectorAll('div[class*="modelEntry"]')]
    .some(entry => entry.closest('div[class*="editor"]') !== null)

  const connection = {
    rpc: {
      async call(channel, endpoint, payload) {
        if (channel !== '/api') throw new Error(`unexpected RPC channel ${channel}`)
        if (endpoint === 'modelToggles/metaRoutes') {
          return { ok: true, value: { routes: [{ provider: 'qwen-coding-plan', displayName: 'Qwen Coding Plan' }] } }
        }
        if (endpoint === 'modelToggles/capsGet') {
          return { ok: true, value: { models: structuredClone(server.caps) } }
        }
        if (endpoint === 'modelToggles/capsSet') {
          const { model, patch } = payload.args
          calls.push({ model, patch: structuredClone(patch), cardOpen: cardOpenNow() })
          if (model === 'brand/new-model' && !server.drafted) {
            return { ok: false, error: { code: 'model-toggles/model-unsaved', message: '模型未保存', details: {} } }
          }
          if (server.failFor.has(model)) {
            return { ok: false, error: { code: 'model-toggles/write-failed', message: '写盘被拒', details: {} } }
          }
          const current = server.caps[model] ?? { image: false, efforts: [] }
          if ('image' in patch) current.image = patch.image
          if ('efforts' in patch) current.efforts = patch.efforts
          server.caps[model] = current
          remoteListener?.() // 服务端落盘后广播 settings/document-updated
          return { ok: true, value: { effective: structuredClone(current) } }
        }
        throw new Error(`unexpected RPC endpoint ${endpoint}`)
      },
    },
  }

  let captured = null
  dom.window.__ModuleLoader__ = { load(entry) { captured = entry } }
  require(join(root, 'lib', 'client.js'))
  const plugin = captured.factory(specifier => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    throw new Error(`unexpected external require: ${specifier}`)
  })
  const disposers = []
  plugin.apply({
    connection,
    remote: { $on(event, listener) { if (event !== 'settings/document-updated') throw new Error(`unexpected event ${event}`); remoteListener = listener; return () => {} } },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
  })

  const entries = [...doc.querySelectorAll('div[class*="modelEntry"]')]
  const controlsOf = entry => entry.querySelector('[data-dshmt-controls]')
  const imageOf = entry => controlsOf(entry)?.querySelector('input[data-dshmt-image]')
  const hintOf = entry => controlsOf(entry)?.querySelector('[data-dshmt-pending]')
  const levelOf = (entry, level) => controlsOf(entry)?.querySelector(`input[data-dshmt-level="${level}"]`)
  const card = doc.querySelector('li[class*="rowCard"]')
  const host = doc.querySelector('#host')
  const openCard = async () => { host.append(card); await sleep(300) }
  const closeCard = async () => { card.remove(); await sleep(400) }

  // 0. 注入：已保存模型 + 未保存草稿行都要有控件。
  await sleep(300)
  if (controlsOf(entries[0]) === null || controlsOf(entries[1]) === null) throw new Error('controls missing on model entries')
  if (hintOf(entries[0])?.hidden !== true) throw new Error('staged hint should start hidden')
  ok('staging: 已保存模型与未保存草稿行都注入控件（提示默认隐藏）')

  // 1. 报障一：卡片打开期间勾选 → 零写盘（官方卡片的 revision 不受影响）。
  const aImage = imageOf(entries[0])
  aImage.checked = true
  aImage.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  const aHigh = levelOf(entries[0], 'high')
  aHigh.checked = true
  aHigh.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await sleep(300)
  if (calls.length !== 0) throw new Error(`card open must not write at all: ${JSON.stringify(calls)}`)
  if (aImage.checked !== true || cardOpenNow() !== true) throw new Error('checkbox reverted while the card stayed open')
  if (controlsOf(entries[0]).dataset.dshmtStaged !== '1') throw new Error('staged marker missing')
  if (hintOf(entries[0]).hidden !== false) throw new Error('staged hint should be visible')
  ok('staging: 官方卡片打开期间勾选零 caps.set（不再抢 revision），控件保持勾选并提示待写入')

  // 2. 报障二：未保存草稿行勾选 → 同样只暂存、不回弹。
  const bImage = imageOf(entries[1])
  bImage.checked = true
  bImage.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await sleep(250)
  if (calls.length !== 0) throw new Error(`draft row must stage, not write: ${JSON.stringify(calls)}`)
  if (bImage.checked !== true) throw new Error('draft-row checkbox reverted before the card closed')
  ok('staging: 新增（未保存）模型行勾选后保持勾选，不再「勾上后自动消失」')

  // 3. 关闭卡片（保存/取消/离开都会这样）→ 提交暂存；草稿行被拒但意图保留。
  await closeCard()
  if (calls.length !== 2) throw new Error(`expected 2 flushes, got ${JSON.stringify(calls)}`)
  if (calls.some(call => call.cardOpen)) throw new Error(`every caps.set must happen with no editor card open: ${JSON.stringify(calls)}`)
  const aCall = calls.find(call => call.model === 'qwen3.6-plus')
  const bCall = calls.find(call => call.model === 'brand/new-model')
  if (JSON.stringify(aCall?.patch) !== JSON.stringify({ image: true, efforts: ['high'] })) {
    throw new Error(`merged patch wrong: ${JSON.stringify(aCall)}`)
  }
  if (!server.caps['qwen3.6-plus'].image || JSON.stringify(server.caps['qwen3.6-plus'].efforts) !== JSON.stringify(['high'])) {
    throw new Error(`server did not receive the saved model patch: ${JSON.stringify(server.caps)}`)
  }
  if (bCall === undefined || server.caps['brand/new-model'] !== undefined) throw new Error('draft-row write should have been refused host-side')
  ok('staging: 卡片关闭后提交暂存；已保存模型落盘（合并载荷），草稿行被拒但意图保留')

  // 4. 重新打开卡片：草稿行仍是勾选态（意图未丢），已保存模型按服务端真相回显。
  await openCard()
  if (imageOf(entries[0])?.checked !== true || levelOf(entries[0], 'high')?.checked !== true) {
    throw new Error('saved model should render the persisted state')
  }
  if (imageOf(entries[1])?.checked !== true) throw new Error('staged draft-row intent lost on re-open')
  if (calls.length !== 2) throw new Error('card open must stay zero-write after re-open')
  ok('staging: 重开卡片后草稿行仍是勾选态，已保存模型按服务端真相回显')

  // 5. 官方保存把新增模型落盘 → document-updated；关卡片后暂存自动补写成功。
  server.drafted = true
  server.caps['brand/new-model'] = { image: false, efforts: [] }
  remoteListener?.()
  await sleep(120)
  if (calls.length !== 2) throw new Error('card open must not flush on document-updated')
  await closeCard()
  if (calls.length !== 3) throw new Error(`draft-row intent should flush once materialized: ${JSON.stringify(calls)}`)
  if (server.caps['brand/new-model']?.image !== true) throw new Error(`materialized model did not receive the staged patch: ${JSON.stringify(server.caps)}`)
  await openCard()
  if (imageOf(entries[1])?.checked !== true) throw new Error('materialized model should render the persisted state')
  if (controlsOf(entries[1])?.dataset.dshmtStaged !== '0') throw new Error('staged marker should clear after a successful flush')
  ok('staging: 官方保存把新增模型落盘后，暂存意图自动补写成功（无需重勾）')

  // 6. 真实写盘失败（非草稿原因）→ 丢弃意图并回读服务端真相，不显示假勾选。
  if (imageOf(entries[0])?.checked !== true) throw new Error('precondition: image should be checked')
  server.failFor.add('qwen3.6-plus')
  const aImage2 = imageOf(entries[0])
  aImage2.checked = false
  aImage2.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await sleep(150)
  if (calls.length !== 3) throw new Error('still zero-write while the card is open')
  await closeCard()
  if (calls.length !== 4) throw new Error(`expected one failed flush, got ${JSON.stringify(calls)}`)
  await openCard()
  if (imageOf(entries[0])?.checked !== true) throw new Error('real failure must revert the control to server truth')
  if (controlsOf(entries[0])?.dataset.dshmtStaged !== '0') throw new Error('staged marker should clear after a real failure')
  ok('staging: 真实写盘失败后丢弃意图并回显服务端真相（不留假勾选）')

  for (const dispose of disposers.reverse()) dispose()
} catch (error) {
  fail('staging 回归', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll staging regression checks passed.')
