/**
 * Client 状态回归测试：复现「同一路由第一个模型勾选后，第二个模型失效」的
 * 真实时序，并验证修复后的完整路由能力快照不会截断其他模型。
 *
 * 时序：
 *   1. caps.get 返回 qwen3.6-plus / qwen3.7-plus 两条完整状态；
 *   2. settings/document-updated 使缓存失效，服务端修改第一条能力；
 *   3. 用户勾第一条图片输入（此时官方编辑卡片还开着 → 只暂存、零写盘）；
 *   4. 关闭官方卡片 → 客户端提交暂存（caps.set），期间再次广播 document-updated；
 *   5. 重新打开卡片后必须两条都按服务端完整 map 回显。
 *
 * 旧实现会在第 3 步立刻写盘（让官方卡片的下一次保存必然 settings/conflict），
 * 并在第 4 步用 caps.set 的单模型 response 重建 route map，第二条随即显示
 * 未勾选；本测试同时覆盖这两条回归。
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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

const html = `
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
        <div class="zGbnIq_modelRow"><input type="text" value="qwen3.7-plus" /><input type="text" value="qwen3.7-plus" /></div>
        <div class="zGbnIq_modelAdvanced"></div>
      </div>
    </section>
  </div>
</li>
`

try {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' })
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.MutationObserver = dom.window.MutationObserver

  let remoteListener
  let capabilities = {
    'qwen3.6-plus': { image: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
    'qwen3.7-plus': { image: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
  }
  let capsGetCalls = 0
  const rpcCalls = []
  /** 假 Connection：官方 Api Gateway 通道 `/api`，端点 `<namespace>/<method>`，载荷 `{args}`。 */
  const connection = {
    rpc: {
      async call(channel, endpoint, payload) {
        if (channel !== '/api') throw new Error(`unexpected RPC channel ${channel}`)
        rpcCalls.push({ endpoint, args: payload?.args })
        if (endpoint === 'modelToggles/metaRoutes') {
          return { ok: true, value: { routes: [{ provider: 'qwen-coding-plan', displayName: 'Qwen Coding Plan' }] } }
        }
        if (endpoint === 'modelToggles/capsGet') {
          capsGetCalls++
          // 返回 detached data，模拟实际 JSON 边界。
          return { ok: true, value: { models: structuredClone(capabilities) } }
        }
        if (endpoint === 'modelToggles/capsSet') {
          const { model, patch } = payload.args
          capabilities = structuredClone(capabilities)
          if ('image' in patch) capabilities[model].image = patch.image
          if ('efforts' in patch) capabilities[model].efforts = patch.efforts
          // 服务端一次写入同时会广播 settings/document-updated。
          remoteListener?.()
          return { ok: true, value: { effective: structuredClone(capabilities[model]) } }
        }
        throw new Error(`unexpected RPC endpoint ${endpoint}`)
      },
    },
  }

  let captured = null
  dom.window.__ModuleLoader__ = { load(entry) { captured = entry } }
  require(join(root, 'lib', 'client.js'))
  if (captured === null) throw new Error('client bundle did not call ModuleLoader.load')
  const injectedRequire = specifier => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    throw new Error(`unexpected external require: ${specifier}`)
  }
  const plugin = captured.factory(injectedRequire)
  const disposers = []
  plugin.apply({
    connection,
    remote: {
      $on(event, listener) {
        if (event !== 'settings/document-updated') throw new Error(`unexpected remote event ${event}`)
        remoteListener = listener
        return () => { remoteListener = undefined }
      },
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get() { return undefined },
  })

  const entries = [...dom.window.document.querySelectorAll('div[class*="modelEntry"]')]
  const controlsOf = entry => entry.querySelector('[data-dshmt-controls]')
  const imageOf = entry => controlsOf(entry)?.querySelector('input[data-dshmt-image]')
  const levelsOf = entry => [...controlsOf(entry).querySelectorAll('input[data-dshmt-level]')]
  const stateOf = entry => ({
    image: imageOf(entry)?.checked,
    efforts: Object.fromEntries(levelsOf(entry).map(box => [box.dataset.dshmtLevel, box.checked])),
  })

  // 初次完整加载：两个模型都正确回显。
  await sleep(220)
  let first = stateOf(entries[0])
  let second = stateOf(entries[1])
  if (!first.image || !second.image || !first.efforts.high || !second.efforts.xhigh) {
    throw new Error(`initial full-map render wrong: ${JSON.stringify({ first, second })}`)
  }
  ok('client state: 初次 caps.get 完整回显两条模型能力')

  // 事件导致第一条状态变化，但第二条保持 true；必须重新拉完整 map。
  capabilities = structuredClone(capabilities)
  capabilities['qwen3.6-plus'].image = false
  remoteListener?.()
  await sleep(220)
  first = stateOf(entries[0])
  second = stateOf(entries[1])
  if (first.image !== false || second.image !== true) {
    throw new Error(`event invalidation failed: ${JSON.stringify({ first, second })}`)
  }
  ok('client state: document-updated 失效后完整回读，不复用陈旧 in-flight promise')

  // 用户重新勾第一条图片输入：官方编辑卡片仍开着 → 只暂存、零写盘（写盘会让
  // 官方卡片的「保存」因冻结的 revision 必然 settings/conflict）。
  const firstImage = imageOf(entries[0])
  firstImage.checked = true
  firstImage.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await sleep(280)
  const writesWhileCardOpen = rpcCalls.filter(call => call.endpoint === 'modelToggles/capsSet')
  if (writesWhileCardOpen.length !== 0) {
    throw new Error(`card open must stage instead of write: ${JSON.stringify(writesWhileCardOpen)}`)
  }
  if (imageOf(entries[0])?.checked !== true) throw new Error('staged checkbox reverted before the card closed')
  if (controlsOf(entries[0])?.dataset.dshmtStaged !== '1') throw new Error('staged marker missing on controls')
  ok('client state: 官方卡片打开期间勾选只暂存（零 caps.set），控件不回退')

  // 关闭官方卡片（保存/取消/离开页面都会让它从 DOM 消失）→ 提交暂存。
  const card = dom.window.document.querySelector('li[class*="rowCard"]')
  const parent = card.parentElement
  const anchor = card.nextSibling
  card.remove()
  await sleep(320)
  const written = rpcCalls.filter(call => call.endpoint === 'modelToggles/capsSet')
  if (written.length !== 1 || written[0].args.model !== 'qwen3.6-plus' || written[0].args.patch.image !== true) {
    throw new Error(`closing the card must flush the staged toggle: ${JSON.stringify(written)}`)
  }
  ok('client state: 卡片关闭后提交暂存（caps.set 一次、载荷正确）')

  // 重新打开卡片：caps.set 之后必须回读完整 route map —— 第二条绝不能失效。
  parent.insertBefore(card, anchor)
  await sleep(320)
  first = stateOf(entries[0])
  second = stateOf(entries[1])
  if (first.image !== true || second.image !== true || !second.efforts.high || !second.efforts.xhigh) {
    throw new Error(`single-model caps.set truncated route map: ${JSON.stringify({ first, second })}`)
  }
  if (capsGetCalls < 3) throw new Error(`expected full caps.get reloads, got ${capsGetCalls}`)
  ok('client state: caps.set 后回读完整路由快照，另一模型状态不失效')

  for (const dispose of disposers.reverse()) dispose()
  globalThis.window = original.window
  globalThis.document = original.document
  globalThis.MutationObserver = original.MutationObserver
} catch (error) {
  fail('client 状态回归', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll client state regression checks passed.')
