/**
 * 浏览器半边 → Host 的 RPC 调用。
 *
 * 走官方 Connection 接入方式：`ctx.connection.rpc.call(channel, endpoint, payload)`
 * —— 传输（HTTP 路由、rpcId 关联、信封校验、Host/Origin 闸门、浏览器会话鉴权）
 * 由 `@deepseek-ai/dsh-client-connection` 拥有；本层只做端点名与超时保护。
 */

/** channel 必须与 Host 半边 `RPC_CHANNEL` 一致。 */
const RPC_CHANNEL = '/dsh-model-toggles/rpc'
/** 超时保护：挂起的请求会永久卡住该 (route,model) 的串行勾选队列。 */
const RPC_TIMEOUT_MS = 15000

/** Connection 通用一元 RPC 结果（官方契约）。 */
export type RpcResult<T> =
	| { ok: true, value: T }
	| { ok: false, error: { code: string, message: string, details: object } }

/** 客户端 Connection 服务的最小面（官方 `ClientConnectionRpc`）。 */
export interface ClientConnectionLike {
	rpc: {
		call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
	}
}

export async function rpc<T>(connection: ClientConnectionLike, endpoint: string, payload: Record<string, unknown> = {}): Promise<RpcResult<T>> {
	try {
		const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload, AbortSignal.timeout(RPC_TIMEOUT_MS))
		return result as RpcResult<T>
	} catch (error) {
		// 传输层失败（HTTP 非 2xx、rpcId 不匹配、超时）：折成同一结果形状，
		// 调用方只需判 result.ok。
		return {
			ok: false,
			error: {
				code: 'dsh-model-toggles/transport',
				message: error instanceof Error ? error.message : String(error),
				details: {},
			},
		}
	}
}
