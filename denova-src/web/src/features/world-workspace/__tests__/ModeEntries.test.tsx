import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModeEntries } from '../components/ModeEntries'
import type { World } from '../types'

function worldFixture(): World {
  return {
    id: 'w1', schemaVersion: 1, name: 'W', status: 'active',
    bindings: [], characters: [], locations: [], factions: [], timeline: [],
    primaryBookPath: '/book.md', primaryInteractiveStoryId: 'story-1',
    createdAt: '', updatedAt: '',
  }
}

describe('ModeEntries 兼容层', () => {
  it('世界工作区不再重复渲染四个运行模式入口', () => {
    const { container } = render(
      <ModeEntries
        world={worldFixture()}
        confirmLeave={() => true}
        onSetMode={vi.fn()}
        onQuickSwitchBook={vi.fn(async () => true)}
        onLaunchGame={vi.fn(async () => {})}
        onOpenModule4={vi.fn()}
        onCloseModule4={vi.fn()}
      />,
    )

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: /写作模式/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /游戏模式/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /叙界/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开放沙盒/ })).not.toBeInTheDocument()
  })
})
