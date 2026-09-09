import { describe, expect, it } from 'vitest'
import {
  applyRefreshedBinding,
  classifyBindingHealth,
  classifyTargetValidity,
} from '../binding-health'
import type { World, WorldAssetBinding } from '../types'

function binding(partial: Partial<WorldAssetBinding> = {}): WorldAssetBinding {
  return {
    bindingId: 'b1',
    masterItemId: 'master/1',
    recordKind: 'character_template',
    semanticType: 'character',
    nameSnapshot: '旧名',
    tagsSnapshot: ['旧标签'],
    boundAt: '',
    ...partial,
  }
}

function fixtureWorld(): World {
  return {
    id: 'abcdef0123456789',
    schemaVersion: 1,
    name: 'W',
    status: 'active',
    bindings: [binding()],
    characters: [{ id: 'c1', bindingId: 'b1', displayName: '角色世界内名', worldNote: '世界内备注' }],
    locations: [{ id: 'l1', name: '地点' }],
    factions: [{ id: 'f1', name: '势力' }],
    timeline: [{ id: 't1', order: 1, title: '开端' }],
    createdAt: '',
    updatedAt: '',
  }
}

describe('classifyBindingHealth 优先级', () => {
  it('idle 且无基线版本 → unchecked', () => {
    expect(classifyBindingHealth(binding(), { phase: 'idle' })).toBe('unchecked')
  })
  it('loading 优先 → checking', () => {
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'loading' })).toBe('checking')
  })
  it('error 404 → missing', () => {
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'error', status: 404 })).toBe('missing')
  })
  it('error 其它状态码/无状态码 → unavailable', () => {
    expect(classifyBindingHealth(binding(), { phase: 'error', status: 500 })).toBe('unavailable')
    expect(classifyBindingHealth(binding(), { phase: 'error' })).toBe('unavailable')
  })
  it('审查硬要求：旧绑定 masterRevision 为空但原件 404 → 必须 missing（error 优先于 unchecked）', () => {
    expect(classifyBindingHealth(binding({ masterRevision: '' }), { phase: 'error', status: 404 })).toBe('missing')
  })
  it('ok 但当前 revision 缺失 → unavailable（不误报 stale）', () => {
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'ok', currentRevision: '' })).toBe('unavailable')
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'ok' })).toBe('unavailable')
  })
  it('ok 且存储版本为空 → unchecked（旧绑定首次成功检查，不臆断最新）', () => {
    expect(classifyBindingHealth(binding({ masterRevision: '' }), { phase: 'ok', currentRevision: 'sha256:new' })).toBe('unchecked')
  })
  it('ok 版本相等 → latest / 不等 → stale', () => {
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'ok', currentRevision: 'sha256:a' })).toBe('latest')
    expect(classifyBindingHealth(binding({ masterRevision: 'sha256:a' }), { phase: 'ok', currentRevision: 'sha256:b' })).toBe('stale')
  })
})

describe('applyRefreshedBinding 只改绑定三字段', () => {
  it('仅更新目标绑定的 name/tags/masterRevision，其余集合引用不变', () => {
    const w = fixtureWorld()
    const before = { characters: w.characters, locations: w.locations, factions: w.factions, timeline: w.timeline }
    const next = applyRefreshedBinding(w, 'b1', { name: '新名', tags: ['新标签'], masterRevision: 'sha256:new' })
    expect(next.bindings[0]).toMatchObject({ nameSnapshot: '新名', tagsSnapshot: ['新标签'], masterRevision: 'sha256:new' })
    // 世界内角色数据不被刷新覆盖
    expect(next.characters[0].displayName).toBe('角色世界内名')
    expect(next.characters[0].worldNote).toBe('世界内备注')
    // 其它集合保持同一引用
    expect(next.characters).toBe(before.characters)
    expect(next.locations).toBe(before.locations)
    expect(next.factions).toBe(before.factions)
    expect(next.timeline).toBe(before.timeline)
    // 未被命中的其它绑定也保持引用
    const two = fixtureWorld()
    two.bindings.push(binding({ bindingId: 'b2', masterItemId: 'master/2', nameSnapshot: '第二' }))
    const refreshed = applyRefreshedBinding(two, 'b1', { name: 'X', tags: [], masterRevision: 'sha256:x' })
    expect(refreshed.bindings[1]).toBe(two.bindings[1])
  })
  it('未知 bindingId 原样返回同一 world', () => {
    const w = fixtureWorld()
    expect(applyRefreshedBinding(w, 'nope', { name: 'X', tags: [], masterRevision: 'sha256:x' })).toBe(w)
  })
})

describe('classifyTargetValidity', () => {
  it('未选择 → none', () => {
    expect(classifyTargetValidity('', true, 'ok')).toBe('none')
    expect(classifyTargetValidity(undefined, true, 'ok')).toBe('none')
  })
  it('loading → checking', () => {
    expect(classifyTargetValidity('/book', false, 'loading')).toBe('checking')
  })
  it('加载失败 → unavailable（不误判失效）', () => {
    expect(classifyTargetValidity('/book', false, 'failed')).toBe('unavailable')
  })
  it('ok 命中 → enterable / 缺失 → invalid', () => {
    expect(classifyTargetValidity('/book', true, 'ok')).toBe('enterable')
    expect(classifyTargetValidity('/lost', false, 'ok')).toBe('invalid')
  })
})
