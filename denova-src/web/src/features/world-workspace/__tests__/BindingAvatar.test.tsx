import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BindingAvatar } from '../components/BindingAvatar'

describe('BindingAvatar 头像单一契约', () => {
  it('仅有 masterItemId、无 avatar_url 时不发起请求，直接回退图标', () => {
    const { container } = render(<BindingAvatar masterItemId="m1" className="size-10" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('无任何条目信息时直接回退', () => {
    const { container } = render(<BindingAvatar />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('有 avatar_url 时渲染该 URL，onError 后回退图标', () => {
    const { container } = render(<BindingAvatar avatarUrl="/api/library/assets/m1/avatar" masterItemId="m1" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', '/api/library/assets/m1/avatar')
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
