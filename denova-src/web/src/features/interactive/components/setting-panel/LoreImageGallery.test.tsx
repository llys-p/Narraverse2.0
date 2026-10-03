import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { LoreItemImage } from '@/lib/api'
import { LoreImageGallery } from './LoreImageGallery'

const aiImage: LoreItemImage = { schema: 'lore_item_image.v1', image_path: 'lore/ai.png', meta_path: 'lore/ai.json' }
const firstUpload: LoreItemImage = { schema: 'lore_item_image.v1', image_path: 'lore/manual-1.png', meta_path: 'lore/manual-1.json' }

function GalleryHarness() {
  const [uploaded, setUploaded] = useState([firstUpload])
  return <LoreImageGallery itemName="Mira" aiImage={aiImage} uploadedImages={uploaded} disabled={false} onRemove={(path) => setUploaded((current) => current.filter((image) => image.image_path !== path))} />
}

describe('LoreImageGallery', () => {
  it('shows one large image at a time and navigates the carousel', () => {
    render(<GalleryHarness />)

    expect(screen.getAllByRole('img', { name: 'Mira' })).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Mira' })).toHaveAttribute('src', '/api/workspace/asset?path=lore%2Fai.png')
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一张图片' }))

    expect(screen.getByRole('img', { name: 'Mira' })).toHaveAttribute('src', '/api/workspace/asset?path=lore%2Fmanual-1.png')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '上一张图片' }))
    expect(screen.getByRole('img', { name: 'Mira' })).toHaveAttribute('src', '/api/workspace/asset?path=lore%2Fai.png')
  })

  it('removes the active uploaded image and keeps the AI image available for preview', async () => {
    render(<GalleryHarness />)

    fireEvent.click(screen.getByRole('button', { name: '下一张图片' }))
    fireEvent.click(screen.getByRole('button', { name: '移除上传图片 1' }))

    await waitFor(() => expect(screen.queryByText('1 / 2')).not.toBeInTheDocument())
    expect(screen.getByRole('img', { name: 'Mira' })).toHaveAttribute('src', '/api/workspace/asset?path=lore%2Fai.png')
    expect(screen.queryByRole('button', { name: '下一张图片' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放大查看资料图片' }))
    expect(await screen.findByTestId('image-preview-viewport')).toBeInTheDocument()
  })
})
