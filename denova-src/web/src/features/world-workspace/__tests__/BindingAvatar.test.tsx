import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BindingAvatar } from '../components/BindingAvatar'

describe('BindingAvatar 头像回退', () => {
  it('有 masterItemId 时先渲染头像 img，onError 后回退图标占位', () => {
    const { container } = render(<BindingAvatar masterItemId="m1" className="size-10" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', '/api/library/assets/m1/avatar')
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    // 回退为 lucide 图标（svg）
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('无 masterItemId 直接回退图标，不渲染 img', () => {
    const { container } = render(<BindingAvatar masterItemId={undefined} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
