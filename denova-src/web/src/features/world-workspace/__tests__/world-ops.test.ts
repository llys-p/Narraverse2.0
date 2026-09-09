import { describe, expect, it } from 'vitest'
import { findDraftIssue, pruneOrphanBindings, referencedBindingIds, removeWorldEntity } from '../world-ops'
import type { World, WorldAssetBinding, WorldSemanticType } from '../types'

function binding(bindingId: string, master = `m-${bindingId}`, semantic: WorldSemanticType = 'character'): WorldAssetBinding {
  return {
    bindingId, masterItemId: master,
    recordKind: semantic === 'character' ? 'character_template' : 'lorebook_template',
    semanticType: semantic, nameSnapshot: bindingId, tagsSnapshot: [], boundAt: '',
  }
}

function baseWorld(): World {
  return {
    id: 'w', schemaVersion: 1, name: 'W', status: 'active',
    bindings: [binding('b1'), binding('b2'), binding('bloc'), binding('bfrac')],
    characters: [
      { id: 'c1', bindingId: 'b1', displayName: '甲', factionId: 'f1', locationId: 'l1',
        relationships: [{ targetCharacterId: 'c2', label: '盟友' }] },
      { id: 'c2', bindingId: 'b2', displayName: '乙',
        relationships: [{ targetCharacterId: 'c1', label: '对手' }] },
    ],
    locations: [{ id: 'l1', name: '地点1', bindingId: 'bloc' }],
    factions: [{ id: 'f1', name: '势力1', bindingId: 'bfrac', headquartersLocationId: 'l1' }],
    timeline: [], createdAt: '', updatedAt: '',
  }
}

describe('referencedBindingIds', () => {
  it('汇总角色/地点/势力引用，去重', () => {
    const ids = referencedBindingIds(baseWorld())
    expect([...ids].sort()).toEqual(['b1', 'b2', 'bfrac', 'bloc'])
  })
})

describe('pruneOrphanBindings', () => {
  it('删除无人引用的绑定，保留仍被引用的', () => {
    const w = baseWorld()
    w.locations = [] // bloc 变 orphan
    const out = pruneOrphanBindings(w)
    expect(out.bindings.map((b) => b.bindingId).sort()).toEqual(['b1', 'b2', 'bfrac'])
  })

  it('同一绑定被多个对象引用时不会被误删', () => {
    const w = baseWorld()
    // 让角色 c2 也引用 bloc（地点删除后仍被角色引用）
    w.characters = w.characters.map((c) => (c.id === 'c2' ? { ...c, bindingId: 'bloc' } : c))
    w.locations = []
    const out = pruneOrphanBindings(w)
    expect(out.bindings.some((b) => b.bindingId === 'bloc')).toBe(true)
  })

  it('没有 orphan 时返回原引用（无多余重渲染）', () => {
    const w = baseWorld()
    expect(pruneOrphanBindings(w)).toBe(w)
  })
})

describe('removeWorldEntity', () => {
  it('删角色：移除角色、摘除他人指向它的关系，并清理其独占绑定', () => {
    const out = removeWorldEntity(baseWorld(), 'character', 'c1')
    expect(out.characters.map((c) => c.id)).toEqual(['c2'])
    // c2 原本指向 c1 的关系被解除
    expect(out.characters[0].relationships).toEqual([])
    // b1 仅 c1 引用 → 清理；b2 保留
    expect(out.bindings.some((b) => b.bindingId === 'b1')).toBe(false)
    expect(out.bindings.some((b) => b.bindingId === 'b2')).toBe(true)
  })

  it('删地点：移除地点、清空角色 locationId 与势力总部、清理地点独占绑定', () => {
    const out = removeWorldEntity(baseWorld(), 'location', 'l1')
    expect(out.locations).toEqual([])
    expect(out.characters.every((c) => c.locationId === undefined)).toBe(true)
    expect(out.factions[0].headquartersLocationId).toBeUndefined()
    expect(out.bindings.some((b) => b.bindingId === 'bloc')).toBe(false)
    // 角色/势力自身及其绑定保留
    expect(out.characters).toHaveLength(2)
    expect(out.bindings.some((b) => b.bindingId === 'bfrac')).toBe(true)
  })

  it('删势力：移除势力、清空角色 factionId、清理势力独占绑定', () => {
    const out = removeWorldEntity(baseWorld(), 'faction', 'f1')
    expect(out.factions).toEqual([])
    expect(out.characters.every((c) => c.factionId === undefined)).toBe(true)
    expect(out.bindings.some((b) => b.bindingId === 'bfrac')).toBe(false)
    expect(out.locations).toHaveLength(1)
  })

  it('共享绑定在删除一个引用方后仍被其它对象引用时保留', () => {
    const w = baseWorld()
    // 势力 f1 复用角色绑定 b1
    w.factions = [{ ...w.factions[0], bindingId: 'b1' }]
    const out = removeWorldEntity(w, 'character', 'c1')
    expect(out.bindings.some((b) => b.bindingId === 'b1')).toBe(true)
  })

  it('不修改入参（纯函数）', () => {
    const w = baseWorld()
    const snapshot = JSON.stringify(w)
    removeWorldEntity(w, 'character', 'c1')
    expect(JSON.stringify(w)).toBe(snapshot)
  })

  it('M2：世界级自由绑定（world/rule/item/other/lorebook）在删除任意实体后仍保留', () => {
    const w = baseWorld()
    w.bindings = [
      ...w.bindings,
      binding('bworld', 'mw', 'world'),
      binding('brule', 'mr', 'rule'),
      binding('bitem', 'mi', 'item'),
      binding('bother', 'mo', 'other'),
    ]
    // 删除角色 c1（其独占的实体作用域绑定 b1 被清），世界级绑定一个都不能少
    const out = removeWorldEntity(w, 'character', 'c1')
    for (const id of ['bworld', 'brule', 'bitem', 'bother']) {
      expect(out.bindings.some((b) => b.bindingId === id), `世界级绑定 ${id} 不应被清理`).toBe(true)
    }
    expect(out.bindings.some((b) => b.bindingId === 'b1')).toBe(false)
  })

  it('M2：实体作用域绑定（location/faction）失去全部引用时仍被清理', () => {
    const w = baseWorld()
    // 一个语义为 location 但没有任何地点引用的绑定 → 仍属 orphan，应清理
    w.bindings = [...w.bindings, binding('blocOrphan', 'mlo', 'location')]
    const out = pruneOrphanBindings(w)
    expect(out.bindings.some((b) => b.bindingId === 'blocOrphan')).toBe(false)
    // 被地点 l1 引用的 bloc 保留
    expect(out.bindings.some((b) => b.bindingId === 'bloc')).toBe(true)
  })
})

describe('findDraftIssue 保存前校验', () => {
  it('全部非空时返回 null', () => {
    expect(findDraftIssue(baseWorld())).toBeNull()
  })
  it('按 角色→地点→势力→时间线 顺序返回第一个空名/空标题实体', () => {
    const w = baseWorld()
    w.characters = [...w.characters, { id: 'cEmpty', displayName: '   ' }]
    expect(findDraftIssue(w)).toEqual({ kind: 'character', id: 'cEmpty' })

    const w2 = baseWorld()
    w2.locations = [...w2.locations, { id: 'lEmpty', name: '' }]
    expect(findDraftIssue(w2)).toEqual({ kind: 'location', id: 'lEmpty' })

    const w3 = baseWorld()
    w3.factions = [...w3.factions, { id: 'fEmpty', name: '' }]
    expect(findDraftIssue(w3)).toEqual({ kind: 'faction', id: 'fEmpty' })

    const w4 = baseWorld()
    w4.timeline = [{ id: 'tEmpty', order: 1, title: '' }]
    expect(findDraftIssue(w4)).toEqual({ kind: 'timeline', id: 'tEmpty' })
  })
})
