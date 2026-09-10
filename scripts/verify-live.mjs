#!/usr/bin/env node
/**
 * 重启后的活实例一键验证（只读，不写 settings）：
 *  1. apply 诊断日志（apply-enter → connection-ok → channel-registered）；
 *  2. Connection RPC channel 的 meta.routes / caps.get 通路；
 *  3. 浏览器 bundle 服务状态。
 *
 * 用法：node scripts/verify-live.mjs [baseUrl]（默认 $DSH_WEB_URL / 127.0.0.1:52221）
 *
 * 与 DSH 官方接入规范对齐后的两点：
 *  - Host 侧 RPC 注册在 **Connection 的逻辑 channel** 上
 *    （`ctx.connection.rpc.handle('/dsh-model-toggles/rpc', …)`），路由由
 *    @deepseek-ai/dsh-client-connection 统一挂载在 webServer 上，并施加
 *    Host/Origin 信任闸门 + 浏览器会话鉴权。脚本没有会话 cookie 时
 *    **401 = 路由已挂载且鉴权生效**（这是期望结果，不是失败）；带 token 的
 *    URL 或 DSH_WEB_COOKIE 可做完整业务验证。
 *  - 插件 bundle 是 combo 形态
 *    `/plugins/??<id>/client.js&rev=<每次启动的随机 rev>`，rev 只能从首页
 *    boot graph 读取；首页被鉴权挡住时该项优雅跳过。
 *
 * baseUrl 两种传法：`http://127.0.0.1:PORT`（无鉴权，业务验证降级）或
 * 带 token 的完整 URL `http://127.0.0.1:PORT/?token=...`（完整验证）。
 * 也可用环境变量 DSH_WEB_COOKIE 直接传 `dsh-auth-*` 会话 cookie。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'

const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52221'
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
/** 与 Host 半边 `src/index.ts` 的 RPC_CHANNEL 一致。 */
const RPC_CHANNEL = '/dsh-model-toggles/rpc'
const failures = []
const ok = label => console.log(`✔ ${label}`)
const skip = label => console.log(`– ${label}（跳过）`)
const bad = (label, detail) => {
  failures.push(label)
  console.error(`✘ ${label}: ${detail}`)
}

/** 用 node:http 发请求（避免 undici 在 Windows 退出时的 libuv 断言噪音）。 */
function rawFetch(url, options) {
  const { headers = {}, body = '', timeoutMs = 15000 } = options
  const target = new URL(url)
  const payload = Buffer.from(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: {
        ...headers,
        'content-length': payload.byteLength,
        connection: 'close',
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end(payload)
  })
}

/**
 * 拿一份已鉴权的首页 + 会话 cookie：
 * DSH_WEB_COOKIE 直传 > 带 ?token= 的 URL（303 + Set-Cookie）> 匿名。
 */
async function acquireSession() {
  const envCookie = process.env.DSH_WEB_COOKIE
  if (envCookie) {
    const res = await rawFetch(base, { headers: { cookie: envCookie }, timeoutMs: 10000 })
    return { cookie: envCookie, index: res.status === 200 ? res : undefined }
  }
  let res = await rawFetch(base, { timeoutMs: 10000 })
  if ((res.status === 303 || res.status === 302) && res.headers['set-cookie']?.length) {
    const cookie = res.headers['set-cookie'].map(row => row.split(';')[0]).join('; ')
    res = await rawFetch(base, { headers: { cookie }, timeoutMs: 10000 })
    return { cookie, index: res.status === 200 ? res : undefined }
  }
  return { cookie: undefined, index: res.status === 200 ? res : undefined }
}

// 1. 诊断日志
const logPath = join(dshHome, 'dsh-model-toggles.apply.log')
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
  for (const line of lines.slice(-6)) console.log(`  [log] ${line}`)
  const text = lines.join(' ')
  if (text.includes('channel-registered')) ok('apply 诊断：Connection channel 已注册')
  else if (text.includes('no-connection')) bad('apply 诊断', 'ctx.connection 不可用（inject 未就绪）——需要看代码')
  else bad('apply 诊断', '未走到 channel-registered，见上方日志')
} else {
  bad('apply 诊断', `日志不存在（${logPath}）——DSH 可能还没重启过，或插件未装载`)
}

const session = await acquireSession().catch(() => ({ cookie: undefined, index: undefined }))

/**
 * 走官方 RPC 信封调一个端点：
 * `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result}`。
 */
async function rpc(endpoint, payload = {}) {
  const res = await rawFetch(`${base}${RPC_CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session.cookie === undefined ? {} : { cookie: session.cookie }),
    },
    body: JSON.stringify({ type: 'client-request', rpcId: `verify-${endpoint}`, method: endpoint, payload }),
  })
  let body = null
  try { body = JSON.parse(res.text) } catch { /* 非 JSON 响应（鉴权闸门等） */ }
  return { status: res.status, body }
}

// 2. Connection channel 通路
try {
  const meta = await rpc('meta.routes')
  if (meta.status === 401) {
    ok('Host RPC channel 已挂载且受连接鉴权保护（401 = 未带会话 cookie）')
    skip('meta.routes / caps.get 业务验证（需要会话：传带 ?token= 的 URL 或设 DSH_WEB_COOKIE）')
  } else if (meta.status === 403) {
    bad('Host RPC channel', '信任闸门拒绝（Host/Origin）——浏览器同源访问不受影响')
  } else if (meta.status === 404) {
    bad('Host RPC channel', `404 未挂载：${base}${RPC_CHANNEL} —— 重启 DSH 后重试`)
  } else if (meta.status !== 200 || meta.body?.result?.ok !== true) {
    bad('meta.routes', `status=${meta.status} body=${JSON.stringify(meta.body)}`)
  } else {
    const routes = meta.body.result.value?.routes ?? []
    if (meta.body.rpcId !== 'verify-meta.routes') bad('meta.routes', `rpcId 未回显：${JSON.stringify(meta.body)}`)
    else ok(`meta.routes：${routes.length} 条路由（${routes.map(r => r.provider).join(', ')}）`)
    const target = routes.find(r => r.provider === 'openrouter') ?? routes[0]
    if (target === undefined) {
      bad('caps.get', '没有任何路由')
    } else {
      const caps = await rpc('caps.get', { route: target.provider })
      if (caps.status !== 200 || caps.body?.result?.ok !== true) bad('caps.get', `status=${caps.status} body=${JSON.stringify(caps.body)}`)
      else ok(`caps.get(${target.provider})：${Object.keys(caps.body.result.value?.models ?? {}).length} 个模型条目可读`)
    }
  }
} catch (error) {
  bad('RPC 通路', error.message)
}

// 3. 浏览器 bundle：优先从首页 boot graph 解析 combo URL；无会话时优雅跳过。
try {
  if (session.index === undefined) {
    skip('浏览器 bundle：首页受 token 鉴权保护，脚本无法读取 boot graph')
    console.log('  请在浏览器确认：刷新页面 → 设置 → 模型 → 编辑提供方 → 展开模型条目，应看到「图片输入 + 思考强度」勾选。')
    console.log('  （带 token 的完整验证：把 `dsh web` / 桌面壳打开页面的原始 URL 作为 baseUrl 传入，或设置 DSH_WEB_COOKIE。）')
  } else {
    const html = session.index.text
    const graphMatch = html.match(/globalThis\[.__DSH_BOOT__.\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
    const bundleUrl = (() => {
      if (graphMatch === null) return null
      if (!graphMatch[1].includes('dsh-model-toggles')) return { missing: true }
      const row = graphMatch[1].match(/\{"id":"dsh-model-toggles"[^{}]*\}/)
      if (row === null) return null
      const url = row[0].match(/"url":"([^"]+)"/)
      return url === null ? null : url[1]
    })()
    if (bundleUrl !== null && typeof bundleUrl === 'object' && bundleUrl.missing === true) {
      bad('浏览器 bundle', 'boot graph 里没有 dsh-model-toggles —— client 半边不会被浏览器加载（检查 dsh.profile.bundles 层序）')
    } else if (typeof bundleUrl === 'string') {
      const bundle = await rawFetch(`${base}${bundleUrl}`, { timeoutMs: 10000 })
      if (bundle.status === 200 && bundle.text.includes('__ModuleLoader__')) ok(`浏览器 bundle 已在服务（combo 形态，${bundle.text.length} 字节）`)
      else bad('浏览器 bundle', `status=${bundle.status} url=${bundleUrl}`)
    } else {
      // 没有 boot graph（旧版本页面形状）或行内无 url：回退单文件探测。
      const bundle = await rawFetch(`${base}/plugins/dsh-model-toggles/client.js`, { timeoutMs: 10000 })
      if (bundle.status === 200 && bundle.text.slice(0, 60).includes('__ModuleLoader__')) ok('浏览器 bundle 已在服务（单文件形态）')
      else bad('浏览器 bundle', `status=${bundle.status}`)
    }
  }
} catch (error) {
  bad('浏览器 bundle', error.message)
}

console.log(failures.length === 0 ? '\n全部通过：刷新页面 → 设置 → 模型 → 编辑提供方 → 展开模型条目，应能看到「图片输入 + 思考强度」勾选。' : `\n${failures.length} 项未通过`)
process.exit(failures.length === 0 ? 0 : 1)
