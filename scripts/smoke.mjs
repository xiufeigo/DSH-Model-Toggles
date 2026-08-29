/**
 * 冒烟检查 —— 按两个运行时加载器的真实消费方式执行产物：
 *
 *  1. 纯逻辑层（lib/capabilities.js）：努力字段形状 / 有效状态读取 / 合并
 *     （接管、受管关闭、幂等、无目录拒绝接管）。
 *  2. Host 半边：require 包入口，mock ctx 跑 apply，直测 RPC 闸门与
 *     caps.set → 影子段 + llm-pi-ai 调和两条写入路径及收敛性。
 *  3. 浏览器半边：模拟 __ModuleLoader__，断言导出与 inject(remote)，
 *     及注入层对锚点 DOM 的最小行为（构造好的文档，jsdom-free 手写桩太脆，
 *     只测 resolveTarget 的目录映射逻辑经 scan 不抛 + 幂等）。
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
const fail = (label, error) => {
  failures++
  console.error(`✘ ${label}:`, error?.message ?? error)
}
const ok = label => console.log(`✔ ${label}`)

// ── 1. 纯逻辑层 ──────────────────────────────────────────────────────────────
try {
  const caps = require(join(root, 'lib', 'capabilities.js'))

  {
    const field = caps.effortsField(['low', 'xhigh'])
    if (JSON.stringify(field) !== JSON.stringify({ off: null, low: 'low', xhigh: 'xhigh' })) {
      throw new Error(`effortsField unexpected: ${JSON.stringify(field)}`)
    }
    ok('capabilities.effortsField：off 恒 null + 勾选档位')
  }
  {
    const effective = caps.effectiveOf({
      id: 'm',
      input: ['text', 'image'],
      reasoningEfforts: { off: null, high: 'high', max: 'max', broken: '' },
    })
    if (effective.image !== true) throw new Error('image should be true')
    if (effective.efforts.join(',') !== 'high,max') throw new Error(`efforts should skip off/empty: ${effective.efforts}`)
    const empty = caps.effectiveOf(undefined)
    if (empty.image !== false || empty.efforts.length !== 0) throw new Error('absent entry should read false/[]')
    ok('capabilities.effectiveOf：图片与档位读取、跳过 off/空值')
  }
  {
    // 有用户列表：原位合并 + 幂等。
    const overrides = { m1: { image: true, efforts: ['high'] } }
    const first = caps.mergeCapabilityEntries({
      currentEntries: [{ id: 'm1', input: ['text'] }],
      takeoverBase: [],
      overrides,
    })
    if (!first.changed) throw new Error('first merge should change')
    const m1 = first.entries.find(row => row.id === 'm1')
    if (JSON.stringify(m1.input) !== JSON.stringify(['text', 'image'])) throw new Error(`input wrong: ${JSON.stringify(m1)}`)
    if (JSON.stringify(m1.reasoningEfforts) !== JSON.stringify({ off: null, high: 'high' })) throw new Error(`efforts wrong: ${JSON.stringify(m1)}`)
    const second = caps.mergeCapabilityEntries({
      currentEntries: first.entries,
      takeoverBase: [],
      overrides,
    })
    if (second.changed) throw new Error('second merge should be a no-op (convergence)')
    ok('capabilities.mergeCapabilityEntries：图片+思考合并、收敛无变化')
  }
  {
    // 受管关闭：image:false / efforts:[] 删除字段。
    const merged = caps.mergeCapabilityEntries({
      currentEntries: [{ id: 'm1', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } }],
      takeoverBase: [],
      overrides: { m1: { image: false, efforts: [] } },
    })
    const m1 = merged.entries.find(row => row.id === 'm1')
    if ('input' in m1) throw new Error(`managed-off should delete input: ${JSON.stringify(m1)}`)
    if ('reasoningEfforts' in m1) throw new Error(`managed-off should delete efforts: ${JSON.stringify(m1)}`)
    ok('capabilities.mergeCapabilityEntries：受管关闭删除字段')
  }
  {
    // 接管：无用户列表 → 目录底表 + 新条目；无目录知识 → 拒绝。
    const merged = caps.mergeCapabilityEntries({
      currentEntries: undefined,
      takeoverBase: [{ id: 'inst-a' }, { id: 'inst-b' }],
      overrides: { 'inst-b': { image: true }, fresh: { efforts: ['max'] } },
    })
    if (!merged.createdTakeover || merged.entries.length !== 3) throw new Error(`takeover shape wrong: ${JSON.stringify(merged.entries)}`)
    const instB = merged.entries.find(row => row.id === 'inst-b')
    if (JSON.stringify(instB.input) !== JSON.stringify(['text', 'image'])) throw new Error('takeover passthrough override lost')
    try {
      caps.mergeCapabilityEntries({
        currentEntries: undefined,
        takeoverBase: [],
        overrides: { fresh: { image: true } },
      })
      throw new Error('should refuse takeover without catalog knowledge')
    } catch (error) {
      if (!/接管/.test(error.message)) throw error
    }
    ok('capabilities.mergeCapabilityEntries：接管底表合并 + 无目录拒绝')
  }
  {
    // allowCreate=false：无 models 列表的路由整体跳过；缺失条目不创建。
    const skipped = caps.mergeCapabilityEntries({
      currentEntries: undefined,
      takeoverBase: [{ id: 'a' }],
      overrides: { a: { image: true } },
      allowCreate: false,
    })
    if (skipped.skipped !== true || skipped.changed !== false) throw new Error(`event reconcile must not take over: ${JSON.stringify(skipped)}`)
    const noCreate = caps.mergeCapabilityEntries({
      currentEntries: [{ id: 'a' }],
      takeoverBase: [],
      overrides: { ghost: { image: true } },
      allowCreate: false,
    })
    if (noCreate.changed !== false || noCreate.entries.length !== 1) throw new Error(`event reconcile must not create entries: ${JSON.stringify(noCreate)}`)
    ok('capabilities.mergeCapabilityEntries：allowCreate=false 不接管、不复活')
  }
} catch (error) {
  fail('纯逻辑层', error)
}

// ── 2. Host 半边 ─────────────────────────────────────────────────────────────
try {
  const entry = require('dsh-model-toggles')
  const plugin = entry.default
  if (typeof plugin.apply !== 'function') throw new Error('host default export must carry apply')
  if (plugin.name !== 'dsh-model-toggles') throw new Error(`unexpected plugin name ${plugin.name}`)
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) throw new Error('inject must include webServer')
  ok(`host half: 默认导出 { inject:[${plugin.inject.join(', ')}], apply }`)

  const registeredRoutes = []
  const mutateCalls = []
  let settingsUpdatedListener = null

  /** 有状态的假 settings：真实应用 path ops（set/unset），供收敛断言。 */
  function makeStatefulSettings(initialLlm, initialShadow) {
    const state = { llm: structuredClone(initialLlm), shadow: structuredClone(initialShadow) }
    const applyOp = (section, op) => {
      const [head, ...rest] = op.path
      if (head === undefined) return op.value
      if (rest.length === 0) {
        if (op.op === 'unset') {
          const { [head]: _removed, ...kept } = section
          return kept
        }
        return { ...section, [head]: op.value }
      }
      const child = section[head]
      const nextChild = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : {}
      return { ...section, [head]: applyOp(nextChild, { ...op, path: rest }) }
    }
    return {
      state,
      describe() {
        return [
          { ns: 'llm-pi-ai', user: state.llm },
          { ns: 'model-toggles', user: state.shadow },
        ]
      },
      register() {
        return { update: async () => {} }
      },
      async mutate(ns, ops) {
        mutateCalls.push({ ns, ops })
        const section = ns === 'llm-pi-ai' ? state.llm : state.shadow
        for (const op of ops) {
          const next = applyOp(section, op)
          if (ns === 'llm-pi-ai') state.llm = next
          else state.shadow = next
        }
      },
    }
  }
  const fakeSettings = makeStatefulSettings(
    { providers: { demo: { models: [{ id: 'm1', input: ['text'] }] } } },
    { providers: {} },
  )
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return { register(route) { registeredRoutes.push(route); return () => {} } }
      }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        callback({ settings: fakeSettings, on(event, listener) { settingsUpdatedListener = { event, listener } } })
      }
      return () => {}
    },
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
  }
  plugin.apply(ctx)
  const route = registeredRoutes.find(row => row.path === '/dsh-model-toggles/rpc')
  if (route === undefined) throw new Error('rpc route not registered')
  if (settingsUpdatedListener === null || settingsUpdatedListener.event !== 'settings/updated') {
    throw new Error('settings/updated listener not wired')
  }
  ok('host half: RPC 路由 + settings/updated 调和监听已挂载')

  const handleRpc = entry.handleRpc
  const makeReq = (method, headers, body) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = headers
    const payload = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body)
    req[Symbol.asyncIterator] = async function* () { yield payload }
    return req
  }
  const makeRes = () => {
    const res = { statusCode: 0, headers: {}, body: '' }
    res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers ?? {}) }
    res.end = text => { res.body = String(text ?? '') }
    return res
  }
  const makeSv = () => ({
    settings: fakeSettings,
    reconciler: {
      reconcile: (routes, options) => entry.reconcileRoutes({
        routes,
        shadow: entry.readShadowProviders(fakeSettings),
        providers: entry.readUserProviders(fakeSettings),
        settings: fakeSettings,
        ...(options?.allowCreate === undefined ? {} : { allowCreate: options.allowCreate }),
      }),
    },
  })

  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'http://127.0.0.1:64044', host: '127.0.0.1:64044' }, null), res, makeSv())
    if (res.statusCode !== 204) throw new Error(`same-origin OPTIONS expected 204, got ${res.statusCode}`)
    ok('rpc gate: 同源 OPTIONS 预检 → 204')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'https://evil.example', host: '127.0.0.1:64044' }, null), res, makeSv())
    if (res.statusCode !== 403) throw new Error('cross-origin OPTIONS should 403')
    ok('rpc gate: 跨源 OPTIONS → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json' }, '{"method":"caps.get"}'), res, makeSv())
    if (res.statusCode !== 403) throw new Error('header-less POST should 403')
    ok('rpc gate: 无自定义头的 POST → 403')
  }
  {
    // caps.get 读有效状态。
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' }, '{"method":"caps.get","route":"demo"}'), res, makeSv())
    const parsed = JSON.parse(res.body)
    if (parsed.ok !== true || parsed.models.m1.image !== false) throw new Error(`caps.get unexpected: ${res.body}`)
    ok('rpc: caps.get 返回有效状态')
  }
  {
    // caps.set：影子段 op + llm 调和 op，两条路径各一次；重复同样勾选不再写 llm。
    mutateCalls.length = 0
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
      '{"method":"caps.set","route":"demo","model":"m1","patch":{"image":true,"efforts":["high","max"]}}'), res, makeSv())
    const parsed = JSON.parse(res.body)
    if (parsed.ok !== true) throw new Error(`caps.set failed: ${res.body}`)
    const ownCall = mutateCalls.find(call => call.ns === 'model-toggles')
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (ownCall === undefined) throw new Error('shadow ns write missing')
    const shadowOp = ownCall.ops[0]
    if (shadowOp.path.join('.') !== 'providers.demo.m1') throw new Error(`shadow op path wrong: ${shadowOp.path}`)
    if (shadowOp.value.image !== true || shadowOp.value.efforts.join(',') !== 'high,max') throw new Error(`shadow value wrong: ${JSON.stringify(shadowOp.value)}`)
    if (llmCalls.length !== 1) throw new Error(`expected exactly 1 llm write, got ${llmCalls.length}`)
    const llmOp = llmCalls[0].ops[0]
    if (llmOp.path.join('.') !== 'providers.demo.models') throw new Error(`llm op path wrong: ${llmOp.path}`)
    const m1 = llmOp.value.find(row => row.id === 'm1')
    if (JSON.stringify(m1.input) !== JSON.stringify(['text', 'image'])) throw new Error(`m1 input wrong: ${JSON.stringify(m1)}`)
    if (JSON.stringify(m1.reasoningEfforts) !== JSON.stringify({ off: null, high: 'high', max: 'max' })) throw new Error(`m1 efforts wrong: ${JSON.stringify(m1)}`)
    ok('rpc: caps.set 写影子段 + 调和写 models（input / reasoningEfforts 形状正确）')
  }
  {
    // 收敛：重复同样的 caps.set，llm 段不再写（影子重复写允许）。
    mutateCalls.length = 0
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
      '{"method":"caps.set","route":"demo","model":"m1","patch":{"image":true,"efforts":["high","max"]}}'), res, makeSv())
    const parsed = JSON.parse(res.body)
    if (parsed.ok !== true) throw new Error(`second caps.set failed: ${res.body}`)
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 0) throw new Error(`repeat set should not write llm again (converged), got ${llmCalls.length}`)
    ok('rpc: 重复相同勾选收敛（不再写 llm 段）')
  }
  {
    // 复活防护 A：用户已删除的路由，调和绝不重建。
    mutateCalls.length = 0
    const outcome = await entry.reconcileRoutes({
      routes: ['gone'],
      shadow: { gone: { m1: { image: true } } },
      providers: { demo: { models: [{ id: 'm1' }] } },
      settings: fakeSettings,
      allowCreate: true,
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 0) throw new Error(`deleted provider should be skipped: ${JSON.stringify(outcome)}`)
    if (mutateCalls.some(call => call.ns === 'llm-pi-ai')) throw new Error('deleted provider resurrected')
    ok('reconcile: 已删除路由绝不复活')
  }
  {
    // 复活防护 B：条目被官方编辑器删除后，事件调和（allowCreate=false）不重建。
    mutateCalls.length = 0
    const outcome = await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: { demo: { ghost: { image: true } } },
      providers: { demo: { models: [{ id: 'm1' }] } },
      settings: fakeSettings,
      allowCreate: false,
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 0) throw new Error(`missing entry should stay missing: ${JSON.stringify(outcome)}`)
    if (mutateCalls.some(call => call.ns === 'llm-pi-ai')) throw new Error('deleted entry resurrected')
    ok('reconcile: 被删条目在事件调和下不复活')
  }
  {
    // 用户显式勾选新 id（caps.set 立即调和 allowCreate=true）→ 创建条目。
    mutateCalls.length = 0
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
      '{"method":"caps.set","route":"demo","model":"fresh","patch":{"image":true}}'), res, makeSv())
    const parsed = JSON.parse(res.body)
    if (parsed.ok !== true) throw new Error(`caps.set fresh failed: ${res.body}`)
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 1) throw new Error(`expected exactly 1 llm write, got ${llmCalls.length}`)
    const freshEntry = llmCalls[0].ops[0].value.find(row => row.id === 'fresh')
    if (freshEntry === undefined || JSON.stringify(freshEntry.input) !== JSON.stringify(['text', 'image'])) {
      throw new Error(`fresh entry wrong: ${JSON.stringify(llmCalls[0].ops[0].value)}`)
    }
    ok('rpc: 显式勾选新模型 id → 创建条目并写入 input')
  }
  {
    // 事件回路：settings/updated(llm-pi-ai) 触发调和（防抖后无差异不再写）。
    mutateCalls.length = 0
    settingsUpdatedListener.listener('llm-pi-ai')
    // 防抖 30ms → 等 80ms 后检查。
    await new Promise(resolve => setTimeout(resolve, 90))
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 0) throw new Error(`reconcile on event should converge to no-op, got ${llmCalls.length}`)
    ok('rpc: settings/updated 事件触发调和且无差异收敛')
  }
  {
    // 回归（上下文窗口丢失）：currentUserEntriesOf 必须保留非受管字段。
    // 旧实现只回填 id/input/reasoningEfforts/name，调和器以「剥字段读」整写
    // models 数组，把用户在官方编辑器里保存的 contextWindow / maxTokens /
    // compat 一并抹掉。
    const entries = entry.currentUserEntriesOf(
      { demo: { models: [{ id: 'm1', name: 'M1', contextWindow: 983000, maxTokens: 131000, compat: { a: 1 }, custom: { b: [1, 2] } }] } },
      'demo',
    )
    const row = entries[0]
    if (row === undefined) throw new Error('entry missing')
    if (row.contextWindow !== 983000 || row.maxTokens !== 131000) throw new Error(`capacity fields lost: ${JSON.stringify(row)}`)
    if (JSON.stringify(row.compat) !== '{"a":1}' || JSON.stringify(row.custom) !== '{"b":[1,2]}') throw new Error(`opaque fields lost: ${JSON.stringify(row)}`)
    ok('host: currentUserEntriesOf 保留非受管字段（contextWindow / maxTokens / compat / 自定义）')
  }
  {
    // 回归（上下文窗口丢失·勾选路径）：同路由勾选触发的立即调和，整写 models
    // 数组时其他模型（及同模型）的 contextWindow / maxTokens 必须原样保留。
    mutateCalls.length = 0
    const scoped = makeStatefulSettings(
      { providers: { demo: { models: [
        { id: 'm1', name: 'M1', contextWindow: 983000, maxTokens: 131000, compat: { a: 1 }, input: ['text'] },
        { id: 'm2', contextWindow: 1000000, maxTokens: 64000 },
      ] } } },
      { providers: { demo: { m1: { image: true, efforts: ['high'] } } } },
    )
    const outcome = await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: entry.readShadowProviders(scoped),
      providers: entry.readUserProviders(scoped),
      settings: scoped,
      allowCreate: true,
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 1) throw new Error(`toggle reconcile should write once: ${JSON.stringify(outcome)}`)
    const written = mutateCalls.filter(call => call.ns === 'llm-pi-ai')[0]?.ops[0]?.value
    if (!Array.isArray(written)) throw new Error('no models array written')
    const w1 = written.find(row => row.id === 'm1')
    const w2 = written.find(row => row.id === 'm2')
    if (w1?.contextWindow !== 983000 || w1?.maxTokens !== 131000 || w1?.name !== 'M1' || JSON.stringify(w1?.compat) !== '{"a":1}') {
      throw new Error(`m1 non-managed fields lost on toggle write: ${JSON.stringify(w1)}`)
    }
    if (JSON.stringify(w1.input) !== JSON.stringify(['text', 'image']) || JSON.stringify(w1.reasoningEfforts) !== JSON.stringify({ off: null, high: 'high' })) {
      throw new Error(`m1 managed fields wrong: ${JSON.stringify(w1)}`)
    }
    if (w2?.contextWindow !== 1000000 || w2?.maxTokens !== 64000) {
      throw new Error(`m2 capacity fields lost on toggle write: ${JSON.stringify(w2)}`)
    }
    // 收敛：紧接的第二次调和（事件驱动兜底）不得再写。
    mutateCalls.length = 0
    await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: entry.readShadowProviders(scoped),
      providers: entry.readUserProviders(scoped),
      settings: scoped,
      allowCreate: false,
    })
    if (mutateCalls.some(call => call.ns === 'llm-pi-ai')) throw new Error('follow-up event reconcile should converge to no-op')
    ok('reconcile: 勾选调和写回保留 contextWindow / maxTokens / compat（上下文窗口丢失回归）')
  }
  {
    // 回归（上下文窗口丢失·修复路径）：官方编辑器用过期数组覆盖受管字段后
    // （input / reasoningEfforts 消失、contextWindow 仍在），事件调和的修复写
    // 必须补回受管字段且不丢容量字段。
    mutateCalls.length = 0
    const scoped = makeStatefulSettings(
      { providers: { demo: { models: [{ id: 'm1', name: 'M1', contextWindow: 983000, maxTokens: 131000 }] } } },
      { providers: { demo: { m1: { image: true, efforts: ['high'] } } } },
    )
    const outcome = await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: entry.readShadowProviders(scoped),
      providers: entry.readUserProviders(scoped),
      settings: scoped,
      allowCreate: false,
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 1) throw new Error(`repair reconcile should write once: ${JSON.stringify(outcome)}`)
    const written = mutateCalls.filter(call => call.ns === 'llm-pi-ai')[0]?.ops[0]?.value
    const w1 = written?.find(row => row.id === 'm1')
    if (JSON.stringify(w1?.input) !== JSON.stringify(['text', 'image']) || JSON.stringify(w1?.reasoningEfforts) !== JSON.stringify({ off: null, high: 'high' })) {
      throw new Error(`repair should restore managed fields: ${JSON.stringify(w1)}`)
    }
    if (w1?.contextWindow !== 983000 || w1?.maxTokens !== 131000 || w1?.name !== 'M1') {
      throw new Error(`repair write lost non-managed fields: ${JSON.stringify(w1)}`)
    }
    ok('reconcile: 官方过期数组覆盖后的修复写保留非受管字段（上下文窗口丢失回归）')
  }
} catch (error) {
  fail('Host 半边', error)
}

// ── 3. 浏览器半边 ────────────────────────────────────────────────────────────
try {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(entry_) { captured = entry_ } } }
  new Function(code)()
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
  if (typeof pluginModule.apply !== 'function') throw new Error('client module exposes no apply')
  if (!Array.isArray(pluginModule.inject) || !pluginModule.inject.includes('remote')) {
    throw new Error('client module inject must include remote')
  }
  ok('browser half: 工厂求值成功，导出 apply + inject(remote)')
  // 注入层纯函数存在性（DOM 集成行为在真实页面验证，本环境无浏览器）。
  const { scanForEditorControls, removeInjectedControls, CONTROLS_MARKER } = pluginModule
  if (typeof scanForEditorControls !== 'function' || typeof removeInjectedControls !== 'function') {
    throw new Error('injection helpers not exported')
  }
  if (typeof CONTROLS_MARKER !== 'string' || CONTROLS_MARKER.length === 0) throw new Error('CONTROLS_MARKER missing')
  ok('browser half: 注入辅助函数导出（scan/remove/marker）')
} catch (error) {
  fail('浏览器半边', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
