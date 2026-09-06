import { jsonHeaders, requestJSON } from './client'

export type ModelModule = 'writing' | 'game' | 'narraverse' | 'module4'

export interface ModelGatewayStatus {
  module: ModelModule
  agent_kind: string
  profile_id: string
  model: string
  base_url: string
  configured: boolean
  credential_configured: boolean
  endpoint_configured: boolean
  model_configured: boolean
}

export interface ModelGatewayTestResult {
  ok: boolean
  module: ModelModule
  agent_kind: string
  profile_id: string
  model: string
  base_url: string
  upstream_status?: number
  code?: string
  message: string
  latency_ms: number
}

export async function fetchModelStatus(module: ModelModule): Promise<ModelGatewayStatus> {
  return requestJSON(`/api/model/status?module=${encodeURIComponent(module)}`)
}

export async function testModel(module: ModelModule): Promise<ModelGatewayTestResult> {
  return requestJSON(`/api/model/test?module=${encodeURIComponent(module)}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ module }),
  })
}
