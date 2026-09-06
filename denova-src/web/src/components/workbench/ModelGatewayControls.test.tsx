import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchModelStatus, testModel } from '@/lib/api-client/model-gateway'
import { ModelGatewayControls } from './ModelGatewayControls'

vi.mock('@/lib/api-client/model-gateway', () => ({
  fetchModelStatus: vi.fn(),
  testModel: vi.fn(),
}))

describe('ModelGatewayControls', () => {
  beforeEach(() => {
    vi.mocked(fetchModelStatus).mockReset()
    vi.mocked(testModel).mockReset()
  })

  it('refreshes and tests the effective model for the active module', async () => {
    vi.mocked(fetchModelStatus).mockResolvedValue({
      module: 'module4', agent_kind: 'interactive_story', profile_id: 'shared', model: 'demo', base_url: 'https://example.com',
      configured: true, credential_configured: true, endpoint_configured: true, model_configured: true,
    })
    vi.mocked(testModel).mockResolvedValue({
      ok: true, module: 'module4', agent_kind: 'interactive_story', profile_id: 'shared', model: 'demo', base_url: 'https://example.com', message: '共享模型连接正常。', latency_ms: 12,
    })

    render(<ModelGatewayControls module="module4" />)
    fireEvent.click(screen.getByRole('button', { name: '刷新模型状态' }))
    await waitFor(() => expect(fetchModelStatus).toHaveBeenCalledWith('module4'))
    await waitFor(() => expect(screen.getByRole('button', { name: '测试 API' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '测试 API' }))
    await waitFor(() => expect(testModel).toHaveBeenCalledWith('module4'))
    expect(screen.getByText('测试 API')).toBeInTheDocument()
  })

  it('does not show a configured but unauthorized provider as healthy', async () => {
    vi.mocked(fetchModelStatus).mockResolvedValue({
      module: 'module4', agent_kind: 'interactive_story', profile_id: 'shared', model: 'demo', base_url: 'https://example.com',
      configured: true, credential_configured: true, endpoint_configured: true, model_configured: true,
    })
    vi.mocked(testModel).mockResolvedValue({
      ok: false, module: 'module4', agent_kind: 'interactive_story', profile_id: 'shared', model: 'demo', base_url: 'https://example.com',
      code: 'unauthorized', upstream_status: 401, message: '共享模型鉴权失败，请检查 Denova Settings 中的 API Key。', latency_ms: 8,
    })

    render(<ModelGatewayControls module="module4" />)
    fireEvent.click(screen.getByRole('button', { name: '刷新模型状态' }))
    await waitFor(() => expect(screen.getAllByText('共享模型已配置').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: '测试 API' }))
    await waitFor(() => expect(screen.getAllByText('共享模型鉴权失败，请检查 Denova Settings 中的 API Key。').length).toBeGreaterThan(0))
    expect(screen.getByTitle('开放沙盒 · 共享模型鉴权失败，请检查 Denova Settings 中的 API Key。')).toBeInTheDocument()
  })
})
