/**
 * 浏览器半边 → Host 的 Remote 调用。
 *
 * 走官方 Api Gateway 通道：端点 `<namespace>/<method>` 挂在共享 `/api` 上，
 * 载荷必须是唯一的 `args` 普通对象字段（Gateway 的 `assertExactArguments`），
 * 业务失败由 Gateway 编码成 `{ ok:false, error }`（error 为 RemoteFailure）。
 * 传输（路由、rpcId 关联、信封校验、Host/Origin 闸门、浏览器会话鉴权）由
 * @deepseek-ai/dsh-client-connection / dsh-api-gateway 拥有。
 *
 * 说明：Host 半边目前以 **SRC（源模式）** 暴露端点 —— 本包的 client bundle 无法
 * 让上游 `dsh-api-remotes` 挂载自己生成的 `./remote` 描述符（它的挂载清单是构建期
 * 写死的 15 个内置包），因此这里直接用官方通用调用面而非 `ctx.remote.<ns>`。
 */

/** Api Gateway 认领的共享通道。 */
const API_CHANNEL = '/api'
/** Host 半边 Cordis service key / Typert wire namespace（见 src/index.ts 的 SERVICE_KEY）。 */
const NAMESPACE = 'modelToggles'
/** 超时保护：挂起的请求会永久卡住该 (route,model) 的串行勾选队列。 */
const RPC_TIMEOUT_MS = 15000

/** 一个 Remote 调用的结果（官方 `RemoteResult`）。 */
export type RpcResult<T> =
	| { ok: true, value: T }
	| { ok: false, error: { code: string, message: string, details: object } }

/** 客户端 Connection 服务的最小面（官方 `ClientConnectionRpc`）。 */
export interface ClientConnectionLike {
	rpc: {
		call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
	}
}

export async function rpc<T>(connection: ClientConnectionLike, method: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
	try {
		const result = await connection.rpc.call(API_CHANNEL, `${NAMESPACE}/${method}`, { args }, AbortSignal.timeout(RPC_TIMEOUT_MS))
		return result as RpcResult<T>
	} catch (error) {
		// 传输层/装配失败（HTTP 非 2xx、rpcId 不匹配、超时、未知端点、无活动 Connection）：
		// 折成同一结果形状，调用方只需判 result.ok。
		return {
			ok: false,
			error: {
				code: 'model-toggles/transport',
				message: error instanceof Error ? error.message : String(error),
				details: {},
			},
		}
	}
}
