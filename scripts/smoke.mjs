/**
 * 冒烟检查 —— 按两个运行时加载器的真实消费方式执行产物：
 *
 *  1. 纯逻辑层（lib/capabilities.js）：努力字段形状 / 有效状态读取 / 合并
 *     （接管、受管关闭、幂等、无目录拒绝接管）。
 *  2. Host 半边：真实实例化 TypertRemoteService（真 cordis Context），断言
 *     `@Remote` 标记与 service 注册；再直测三个端点的业务实现（RemoteError
 *     失败码）与调和/收敛/复活防护。
 *  3. 浏览器半边：模拟 __ModuleLoader__，断言导出与 inject(connection, remote)。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

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
  {
    // 影子段自动清理（纯逻辑）：路由已删 → 整段；模型不在显式列表 → 单键；
    // 无 models 列表（目录 passthrough）→ 保留；空覆盖 → 清；清空的段 → 连路由键。
    const plan = caps.pruneShadowProviders({
      shadow: {
        gone: { m1: { image: true } },
        demo: { m1: { image: true }, ghost: { image: true }, empty: {} },
        cat: { m1: { image: true } },
      },
      providers: {
        demo: { models: [{ id: 'm1' }] },
        cat: {},
      },
    })
    if (JSON.stringify(plan.unsetRoutes) !== JSON.stringify(['gone'])) throw new Error(`unsetRoutes wrong: ${JSON.stringify(plan.unsetRoutes)}`)
    const demoUnset = plan.unsetModels.filter(row => row.route === 'demo').map(row => row.model).sort()
    if (JSON.stringify(demoUnset) !== JSON.stringify(['empty', 'ghost'])) throw new Error(`demo unset wrong: ${JSON.stringify(plan.unsetModels)}`)
    if (plan.unsetModels.some(row => row.route === 'cat')) throw new Error(`catalog route keys must stay: ${JSON.stringify(plan.unsetModels)}`)
    if (plan.next.demo?.m1 === undefined || plan.next.cat?.m1 === undefined) throw new Error(`next tree wrong: ${JSON.stringify(plan.next)}`)
    if (plan.next.gone !== undefined || plan.unsetModels.some(row => row.route === 'gone')) throw new Error('gone route must be fully dropped')
    ok('capabilities.pruneShadowProviders：删路由清整段、删模型清单键、目录路由保留')
  }
  {
    // 目录条目字段保留 + 畸形状防御（接管底表不再只剩裸 id）。
    const entries = caps.catalogEntriesOf([
      { id: 'a', name: 'A', contextWindow: 1000, maxTokens: 2000, input: ['text', 'image', 42], reasoningEfforts: { off: null, high: 'high', bad: 1 }, compat: { x: 1 } },
      { noId: true },
      'junk',
      { id: '' },
      null,
    ])
    if (entries.length !== 1) throw new Error(`only one valid entry expected: ${JSON.stringify(entries)}`)
    const a = entries[0]
    if (a.name !== 'A' || a.contextWindow !== 1000 || a.maxTokens !== 2000) throw new Error(`capacity fields lost: ${JSON.stringify(a)}`)
    if (JSON.stringify(a.input) !== JSON.stringify(['text', 'image'])) throw new Error(`input filter wrong: ${JSON.stringify(a.input)}`)
    if (JSON.stringify(a.reasoningEfforts) !== JSON.stringify({ off: null, high: 'high' })) throw new Error(`efforts filter wrong: ${JSON.stringify(a.reasoningEfforts)}`)
    if (JSON.stringify(a.compat) !== '{"x":1}') throw new Error(`compat wrong: ${JSON.stringify(a.compat)}`)
    ok('capabilities.catalogEntriesOf：目录字段保留、畸形状防御')
  }
} catch (error) {
  fail('纯逻辑层', error)
}

// ── 2. Host 半边 ─────────────────────────────────────────────────────────────
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
  const entry = await import('dsh-model-toggles')
  const capsModule = require(join(root, 'lib', 'capabilities.js'))

  // 2a. Typert 接线：真 cordis Context 上实例化，断言 Service 注册 + @Remote 标记。
  {
    if (typeof entry.default !== 'function') throw new Error('default export must be the Service class')
    if (entry.SERVICE_KEY !== 'modelToggles') throw new Error(`unexpected SERVICE_KEY ${entry.SERVICE_KEY}`)
    const ctx = new Context()
    const service = new entry.default(ctx)
    if (service.name !== entry.SERVICE_KEY) throw new Error(`service registered as ${service.name}`)
    if (service.typertRemote?.namespace !== entry.SERVICE_KEY) {
      throw new Error(`typertRemote binding wrong: ${JSON.stringify(service.typertRemote)}`)
    }
    const markers = remoteMethods(service).map(marker => marker.method).sort()
    if (JSON.stringify(markers) !== JSON.stringify(['capsGet', 'capsSet', 'metaRoutes'])) {
      throw new Error(`@Remote markers wrong (装饰器降级接线？): ${JSON.stringify(markers)}`)
    }
    if (!Object.keys(ctx.reflect.props).includes(entry.SERVICE_KEY)) {
      throw new Error('service not registered on the cordis context (gateway cannot claim its endpoints)')
    }
    ok(`host half: TypertRemoteService 注册为 "${entry.SERVICE_KEY}"，@Remote 标记 [${markers.join(', ')}]`)
  }

  const mutateCalls = []

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
        // 逐条顺序应用：每条 op 都基于前一条的结果（真实 settings 服务语义）。
        for (const op of ops) {
          const section = ns === 'llm-pi-ai' ? state.llm : state.shadow
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

  /** 测试注入的内置目录视图（reconcileRoutes / capsGet 的 getInstalled 缝）。 */
  const fakeInstalled = route => route === 'catalog-route'
    ? [
        { id: 'cat-a', name: 'Cat A', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] },
        { id: 'cat-b', name: 'Cat B' },
      ]
    : []

  /** 按给定服务装配端点实现（等价于 Service 上三个 @Remote 方法体）。 */
  const handlersFor = (settings, options = {}) => entry.createHandlers(() => ({
    settings,
    getInstalled: fakeInstalled,
    reconciler: {
      reconcile: options.reconcile ?? ((routes, opts) => entry.reconcileRoutes({
        routes,
        shadow: entry.readShadowProviders(settings),
        providers: entry.readUserProviders(settings),
        settings,
        getInstalled: fakeInstalled,
        ...(opts === undefined ? {} : {
          allowCreate: opts.allowCreate === true,
          ...(opts.createIds === undefined ? {} : { createIds: opts.createIds }),
        }),
      })),
    },
  }))

  /** 断言一次业务失败：抛 RemoteError 且 code 匹配（Gateway 会转成 wire error 分支）。 */
  const expectRemoteError = async (code, run) => {
    try {
      await run()
    } catch (error) {
      if (error?.code !== code) throw new Error(`expected RemoteError ${code}, got ${error?.code ?? error}`)
      if (error.isDSHRemoteError !== true) throw new Error('failure is not a RemoteError instance')
      return error
    }
    throw new Error(`expected RemoteError ${code}, but the call resolved`)
  }

  // 目录装载兜底：调和前必 await ensureCatalog（缓存 promise），先等真实装载完成。
  await entry.ensureCatalog()

  {
    // 端点契约：成功返回业务值本身（不是 {ok:true} 包装 —— 包装由 Gateway 负责）。
    const res = await handlersFor(fakeSettings).capsGet('demo')
    if (res.models.m1.image !== false) throw new Error(`capsGet unexpected: ${JSON.stringify(res)}`)
    ok('endpoint: capsGet 返回业务值（有效能力 map）')
  }
  {
    const handlers = handlersFor(fakeSettings)
    const error = await expectRemoteError('model-toggles/bad-request', () => handlers.capsGet(''))
    if (typeof error.details !== 'object') throw new Error('RemoteError details missing')
    ok('endpoint: 缺 route → RemoteError model-toggles/bad-request（含 details）')
  }
  {
    // capsSet：影子段 op + llm 调和 op，两条路径各一次；重复同样勾选不再写 llm。
    mutateCalls.length = 0
    const res = await handlersFor(fakeSettings).capsSet('demo', 'm1', { image: true, efforts: ['high', 'max'] })
    if (res.effective.image !== true) throw new Error(`effective wrong: ${JSON.stringify(res)}`)
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
    ok('endpoint: capsSet 写影子段 + 调和写 models（input / reasoningEfforts 形状正确）')
  }
  {
    // 收敛：重复同样的 capsSet，llm 段不再写（影子重复写允许）。
    mutateCalls.length = 0
    const res = await handlersFor(fakeSettings).capsSet('demo', 'm1', { image: true, efforts: ['high', 'max'] })
    if (res.effective.image !== true) throw new Error('second capsSet effective wrong')
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 0) throw new Error(`repeat set should not write llm again (converged), got ${llmCalls.length}`)
    ok('endpoint: 重复相同勾选收敛（不再写 llm 段）')
  }
  {
    // 未保存模型勾选拒绝：路由有显式 models 列表、目标 id 不在其中（官方编辑器
    // 里的草稿/新增行）→ 拒绝并提示先保存，零写盘。
    mutateCalls.length = 0
    await expectRemoteError('model-toggles/model-unsaved', () => handlersFor(fakeSettings).capsSet('demo', 'fresh', { image: true }))
    if (mutateCalls.length !== 0) throw new Error(`refused capsSet must write nothing, got ${JSON.stringify(mutateCalls)}`)
    ok('endpoint: 未保存模型勾选被拒（model-toggles/model-unsaved）、零写盘')
  }
  {
    // 未知路由：报 route-unknown（而不是静默建路由）。
    mutateCalls.length = 0
    await expectRemoteError('model-toggles/route-unknown', () => handlersFor(fakeSettings).capsSet('nope', 'm1', { image: true }))
    if (mutateCalls.length !== 0) throw new Error('unknown route must write nothing')
    ok('endpoint: 未知路由 → model-toggles/route-unknown、零写盘')
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
    // 复活防护 C（复活 bug 回归·引擎缺省）：真实事件链路调 reconcile 时不传
    // allowCreate —— 旧实现把 undefined 当 true，官方编辑器保存删掉的模型被
    // 影子段立刻复活。引擎缺省必须等价 allowCreate=false。
    mutateCalls.length = 0
    const outcome = await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: { demo: { ghost: { image: true } } },
      providers: { demo: { models: [{ id: 'm1' }] } },
      settings: fakeSettings,
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 0) throw new Error(`default reconcile must not resurrect: ${JSON.stringify(outcome)}`)
    if (mutateCalls.some(call => call.ns === 'llm-pi-ai')) throw new Error('deleted entry resurrected via default allowCreate')
    ok('reconcile: 缺省（不传 allowCreate）调和不得复活被删条目')
  }
  {
    // 复活防护 D（复活 bug 回归·capsSet 创建范围）：影子段还记着已删除的
    // ghost 时，显式勾选只允许创建目标条目，ghost 绝不被顺手重建。
    mutateCalls.length = 0
    const scoped = makeStatefulSettings(
      { providers: { demo: { models: [{ id: 'm1' }] } } },
      { providers: { demo: { fresh: { image: true }, ghost: { image: true } } } },
    )
    const outcome = await entry.reconcileRoutes({
      routes: ['demo'],
      shadow: entry.readShadowProviders(scoped),
      providers: entry.readUserProviders(scoped),
      settings: scoped,
      allowCreate: true,
      createIds: ['fresh'],
    })
    if (outcome.ok !== true || outcome.changedRoutes.length !== 1) throw new Error(`scoped create should write once: ${JSON.stringify(outcome)}`)
    const written = mutateCalls.filter(call => call.ns === 'llm-pi-ai')[0]?.ops[0]?.value
    if (!Array.isArray(written)) throw new Error('no models array written')
    if (written.some(row => row.id === 'ghost')) throw new Error(`ghost resurrected via scoped create: ${JSON.stringify(written)}`)
    const fresh = written.find(row => row.id === 'fresh')
    if (fresh === undefined || JSON.stringify(fresh.input) !== JSON.stringify(['text', 'image'])) {
      throw new Error(`target entry not created: ${JSON.stringify(written)}`)
    }
    ok('reconcile: createIds 限定创建范围（目标创建、ghost 不复活）')
  }
  {
    // 目录接管（capsSet 全链路 + 注入目录）：路由无 models 列表时首次勾选 →
    // 以内置目录为底表接管，目录字段（name / 容量）保留；影子段里的 ghost
    // 不得混入（createIds 限定）；接管后顺手清理掉 ghost 影子键。
    mutateCalls.length = 0
    const scoped = makeStatefulSettings(
      { providers: { 'catalog-route': { displayName: 'Catalog Route' } } },
      { providers: { 'catalog-route': { ghost: { image: true } } } },
    )
    // 镜像生产 reconcileNow：调和成功后顺手清理影子段（capsSet 真实路径含此步）。
    const reconcile = async (routes, options) => {
      const outcome = await entry.reconcileRoutes({
        routes,
        shadow: entry.readShadowProviders(scoped),
        providers: entry.readUserProviders(scoped),
        settings: scoped,
        getInstalled: fakeInstalled,
        ...(options === undefined ? {} : {
          allowCreate: options.allowCreate === true,
          ...(options.createIds === undefined ? {} : { createIds: options.createIds }),
        }),
      })
      if (outcome.ok && options?.prune !== false) {
        const plan = capsModule.pruneShadowProviders({
          shadow: entry.readShadowProviders(scoped),
          providers: entry.readUserProviders(scoped),
        })
        const ops = [
          ...plan.unsetModels
            .filter(row => !plan.unsetRoutes.includes(row.route))
            .map(row => ({ op: 'unset', path: ['providers', row.route, row.model] })),
          ...plan.unsetRoutes.map(r => ({ op: 'unset', path: ['providers', r] })),
        ]
        if (ops.length > 0) await scoped.mutate('model-toggles', ops)
      }
      return outcome
    }
    const res = await handlersFor(scoped, { reconcile }).capsSet('catalog-route', 'cat-b', { image: true })
    if (res.effective.image !== true) throw new Error(`takeover effective wrong: ${JSON.stringify(res)}`)
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 1) throw new Error(`expected exactly 1 llm write, got ${llmCalls.length}`)
    const written = llmCalls[0].ops[0].value
    if (written.some(row => row.id === 'ghost')) throw new Error(`ghost resurrected by takeover: ${JSON.stringify(written)}`)
    const catB = written.find(row => row.id === 'cat-b')
    if (JSON.stringify(catB?.input) !== JSON.stringify(['text', 'image'])) throw new Error(`target input wrong: ${JSON.stringify(catB)}`)
    const catA = written.find(row => row.id === 'cat-a')
    if (catA?.name !== 'Cat A' || catA?.contextWindow !== 128000 || catA?.maxTokens !== 8192) {
      throw new Error(`catalog fields lost on takeover: ${JSON.stringify(catA)}`)
    }
    if (scoped.state.shadow.providers['catalog-route']?.ghost !== undefined) {
      throw new Error(`ghost shadow key not pruned after takeover: ${JSON.stringify(scoped.state.shadow)}`)
    }
    ok('endpoint: 目录路由首次勾选 → 接管（目录字段保留、ghost 不复活且影子键清理）')
  }
  {
    // capsGet 目录回退：passthrough 路由（无显式 models 列表）也能读到目录条目状态。
    const scoped = makeStatefulSettings(
      { providers: { 'catalog-route': { displayName: 'Catalog Route' } } },
      { providers: {} },
    )
    const res = await handlersFor(scoped).capsGet('catalog-route')
    if (res.models['cat-a']?.image !== true) throw new Error(`cat-a caps wrong: ${JSON.stringify(res)}`)
    if (res.models['cat-b']?.image !== false) throw new Error(`cat-b caps wrong: ${JSON.stringify(res)}`)
    ok('endpoint: capsGet 目录 passthrough 路由回退内置目录')
  }
  {
    // 复活防护 E（复活 bug 回归·capsSet 全链路）：影子段还记着已删除的 ghost 时，
    // 同路由显式勾选经生产 createIds 接线，只更新目标，ghost 不得被重建。
    mutateCalls.length = 0
    const scoped = makeStatefulSettings(
      { providers: { demo: { models: [{ id: 'm1', input: ['text'] }] } } },
      { providers: { demo: { ghost: { image: true } } } },
    )
    const res = await handlersFor(scoped).capsSet('demo', 'm1', { image: true })
    if (res.effective.image !== true) throw new Error('capsSet with ghost shadow failed')
    const written = mutateCalls.filter(call => call.ns === 'llm-pi-ai')[0]?.ops[0]?.value
    if (!Array.isArray(written)) throw new Error('expected exactly one llm write')
    if (written.some(row => row.id === 'ghost')) throw new Error(`ghost resurrected by capsSet reconcile: ${JSON.stringify(written)}`)
    const m1 = written.find(row => row.id === 'm1')
    if (JSON.stringify(m1?.input) !== JSON.stringify(['text', 'image'])) throw new Error(`target not updated: ${JSON.stringify(m1)}`)
    ok('endpoint: capsSet 调和只创建目标条目，影子段里的已删模型不复活')
  }
  {
    // 事件接线（settings/updated）：只认两段；LLM_NS 带清理、OWN_NS 不带清理；
    // 去抖合并连续事件。
    const seen = []
    const watcher = entry.createSettingsWatcher({
      reconcile: async (_routes, options) => { seen.push(options); return { ok: true, changedRoutes: [] } },
      onError: () => {},
      debounceMs: 5,
    })
    watcher('ui-theme')            // 无关段：忽略
    watcher('llm-pi-ai')
    watcher('model-toggles')       // 去抖窗口内的后一次覆盖前一次
    await new Promise(resolve => setTimeout(resolve, 60))
    if (seen.length !== 1) throw new Error(`debounce should collapse to one call, got ${seen.length}`)
    if (seen[0]?.prune !== false) throw new Error(`OWN_NS event must not prune: ${JSON.stringify(seen[0])}`)
    seen.length = 0
    watcher('llm-pi-ai')
    await new Promise(resolve => setTimeout(resolve, 60))
    if (seen.length !== 1 || seen[0]?.prune !== true) throw new Error(`LLM_NS event must prune: ${JSON.stringify(seen)}`)
    ok('watcher: 只认两段、LLM_NS 才清理、连续事件去抖合并')
  }
  {
    // 事件回路：settings/updated(llm-pi-ai) 触发调和（防抖后无差异不再写）。
    mutateCalls.length = 0
    const listener = entry.createSettingsWatcher({
      reconcile: (routes, options) => entry.reconcileRoutes({
        routes: routes ?? Object.keys(entry.readShadowProviders(fakeSettings)),
        shadow: entry.readShadowProviders(fakeSettings),
        providers: entry.readUserProviders(fakeSettings),
        settings: fakeSettings,
        ...(options === undefined ? {} : { allowCreate: options.allowCreate === true, ...(options.createIds === undefined ? {} : { createIds: options.createIds }) }),
      }),
      onError: () => {},
    })
    listener('llm-pi-ai')
    await new Promise(resolve => setTimeout(resolve, 90))
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 0) throw new Error(`reconcile on event should converge to no-op, got ${llmCalls.length}`)
    ok('watcher: settings/updated 事件触发调和且无差异收敛')
  }
  {
    // 复活防护 F（复活 bug 回归·事件全链路）：官方编辑器保存删除模型后，
    // 事件触发的兜底调和走缺省 allowCreate —— 影子段里还记着的已删模型
    // 绝不会被写回 models 数组；仍在列表里的 m1 也不得有任何修复写。
    mutateCalls.length = 0
    fakeSettings.state.llm.providers.demo.models = [
      { id: 'm1', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high', max: 'max' } },
    ]
    fakeSettings.state.shadow.providers.demo.fresh = { image: true }
    fakeSettings.state.shadow.providers.demo.ghost = { image: true }
    const outcome = await entry.reconcileRoutes({
      routes: Object.keys(entry.readShadowProviders(fakeSettings)),
      shadow: entry.readShadowProviders(fakeSettings),
      providers: entry.readUserProviders(fakeSettings),
      settings: fakeSettings,
    })
    if (!outcome.ok || outcome.changedRoutes.length !== 0) throw new Error(`event reconcile must converge: ${JSON.stringify(outcome)}`)
    const llmCalls = mutateCalls.filter(call => call.ns === 'llm-pi-ai')
    if (llmCalls.length !== 0) throw new Error(`event reconcile resurrected ghost: ${JSON.stringify(llmCalls)}`)
    const models = fakeSettings.state.llm.providers.demo.models
    if (models.some(row => row.id === 'ghost' || row.id === 'fresh')) {
      throw new Error(`deleted model present in state after event reconcile: ${JSON.stringify(models)}`)
    }
    const plan = capsModule.pruneShadowProviders({
      shadow: entry.readShadowProviders(fakeSettings),
      providers: entry.readUserProviders(fakeSettings),
    })
    const ops = [
      ...plan.unsetModels.filter(row => !plan.unsetRoutes.includes(row.route)).map(row => ({ op: 'unset', path: ['providers', row.route, row.model] })),
      ...plan.unsetRoutes.map(route => ({ op: 'unset', path: ['providers', route] })),
    ]
    if (ops.length > 0) await fakeSettings.mutate('model-toggles', ops)
    const demoShadow = fakeSettings.state.shadow.providers.demo ?? {}
    if (demoShadow.ghost !== undefined || demoShadow.fresh !== undefined) {
      throw new Error(`deleted-model shadow keys not auto-pruned: ${JSON.stringify(fakeSettings.state.shadow)}`)
    }
    if (demoShadow.m1 === undefined) throw new Error('live model shadow key must stay')
    ok('reconcile: 官方保存后兜底调和不复活被删模型，影子键自动清理（复活 bug 回归）')
  }
  {
    // 影子自动清理（目录 passthrough）：路由无显式 models 列表时无法判定删除，
    // 影子键保留，且调和 + 清理全程不得写盘（不接管、不误清）。
    mutateCalls.length = 0
    fakeSettings.state.llm.providers.catalog = {}
    fakeSettings.state.shadow.providers.catalog = { m1: { image: true } }
    const outcome = await entry.reconcileRoutes({
      routes: ['catalog'],
      shadow: entry.readShadowProviders(fakeSettings),
      providers: entry.readUserProviders(fakeSettings),
      settings: fakeSettings,
      // 缺省 allowCreate=false：目录 passthrough 路由不做接管（这正是被断言的行为）。
    })
    const plan = capsModule.pruneShadowProviders({
      shadow: entry.readShadowProviders(fakeSettings),
      providers: entry.readUserProviders(fakeSettings),
    })
    if (!outcome.ok) throw new Error('catalog passthrough reconcile failed')
    if (mutateCalls.length !== 0) throw new Error(`catalog passthrough must not write: ${JSON.stringify(mutateCalls)}`)
    if (plan.next.catalog?.m1 === undefined) {
      throw new Error(`catalog shadow key wrongly pruned: ${JSON.stringify(plan)}`)
    }
    ok('reconcile: 无 models 列表的路由影子键保留（不误清、零写盘）')
  }
  {
    // 回归（上下文窗口丢失）：currentUserEntriesOf 必须保留非受管字段。
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
    // 回归（上下文窗口丢失·修复路径）：官方编辑器用过期数组覆盖受管字段后，
    // 事件调和的修复写必须补回受管字段且不丢容量字段。
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
  if (!Array.isArray(pluginModule.inject) || !pluginModule.inject.includes('connection')) {
    throw new Error('client module inject must include connection')
  }
  if (!pluginModule.inject.includes('remote')) {
    throw new Error('client module inject must include remote (settings/document-updated)')
  }
  ok('browser half: 工厂求值成功，导出 apply + inject(connection, remote)')
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
