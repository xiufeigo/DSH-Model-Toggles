/**
 * 浏览器半边 → Host RPC。与官方 Models 页同一协议风格：POST + 自定义头跨站闸门。
 */

export interface RpcEnvelope {
	ok?: boolean
	error?: string
}

export async function rpc<T extends RpcEnvelope = RpcEnvelope>(method: string, args: Record<string, unknown> = {}): Promise<T> {
	try {
		const response = await fetch('/dsh-model-toggles/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
			body: JSON.stringify({ method, ...args }),
		})
		if (!response.ok) return { ok: false, error: `RPC 请求失败 (HTTP ${response.status})` } as T
		return (await response.json()) as T
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) } as T
	}
}
