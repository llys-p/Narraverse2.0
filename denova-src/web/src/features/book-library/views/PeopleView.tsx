import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { LoreItem } from '@/lib/api'
import { workspaceAssetURL } from '@/lib/api'
import {
  PEOPLE_GROUPS,
  groupCharactersByTier,
  paginate,
  resolveCharacterTier,
  selectPeople,
  type PeopleGroup,
} from '../book-library-view-model'

const GROUP_LABEL_KEY: Record<PeopleGroup, string> = {
  major: 'settingPanel.characterTier.major',
  minor: 'settingPanel.characterTier.minor',
  unclassified: 'settingPanel.characterTier.unclassified',
  all: 'bookLibrary.people.all',
}

interface PeopleViewProps {
  items: LoreItem[]
  query: string
  /** 分组与搜索先作用于全量人物，翻页时不重复不漏项。 */
  onOpen: (id: string) => void
  /** 批量层级入口沿用既有对话框组件，由上层注入以免重复实现写入流程。 */
  batchAction?: ReactNode
}

export function PeopleView({ items, query, onOpen, batchAction }: PeopleViewProps) {
  const { t } = useTranslation()
  const [group, setGroup] = useState<PeopleGroup>('major')
  const [page, setPage] = useState(0)

  const counts = useMemo(() => groupCharactersByTier(items), [items])
  const matches = useMemo(() => selectPeople(items, group, query), [group, items, query])
  const slice = useMemo(() => paginate(matches, page), [matches, page])

  useEffect(() => {
    setPage(0)
  }, [group, query])

  // 筛选结果变少时（例如批改层级后当前页已不存在）自动回落到最后一页。
  useEffect(() => {
    if (page > slice.pageCount - 1) setPage(Math.max(0, slice.pageCount - 1))
  }, [page, slice.pageCount])

  const coverOf = (item: LoreItem) => item.image?.image_path || item.images?.[0]?.image_path || ''

  return (
    <>
      <div className="book-library-toolbar" role="group" aria-label={t('bookLibrary.people.groups')}>
        {PEOPLE_GROUPS.map((value) => {
          const count = value === 'all'
            ? counts.major.length + counts.minor.length + counts.unclassified.length
            : counts[value].length
          return (
            <button
              key={value}
              type="button"
              className={`bl-chip${group === value ? ' is-active' : ''}`}
              aria-pressed={group === value}
              onClick={() => setGroup(value)}
            >
              {t(GROUP_LABEL_KEY[value])} <span>{count}</span>
            </button>
          )
        })}
        <span className="spacer" />
        {batchAction}
        <span className="book-library-total">{t('bookLibrary.people.showing', { from: slice.from, to: slice.to, total: slice.total })}</span>
      </div>

      {!slice.rows.length ? (
        <div className="bl-empty">
          {group === 'unclassified' && !counts.unclassified.length
            ? t('bookLibrary.people.noneUnclassified')
            : t('bookLibrary.people.noMatch')}
        </div>
      ) : (
        <>
          {slice.rows.some((item) => resolveCharacterTier(item) === 'major') ? (
            <div className="bl-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {slice.rows.filter((item) => resolveCharacterTier(item) === 'major').map((item) => (
                <button key={item.id} type="button" className="bl-card bl-person-card" onClick={() => onOpen(item.id)}>
                  <span className="bl-person-cover">
                    {coverOf(item) ? <img src={workspaceAssetURL(coverOf(item))} alt={item.name} loading="lazy" /> : null}
                    <span className="bl-tier">{t('settingPanel.characterTier.major')}</span>
                  </span>
                  <span className="bl-person-body">
                    <b>{item.name || t('bookLibrary.entry.unnamed')}</b>
                    <span className="bl-person-meta">{(item.tags || []).join(' · ') || t('bookLibrary.field.notFilled')}</span>
                    <span className="bl-person-summary">{item.brief_description || t('bookLibrary.field.notFilled')}</span>
                    <span className="bl-person-foot">
                      <span>{t(`lore.loadMode.${item.load_mode || 'auto'}`)}</span>
                      <strong>{t('bookLibrary.people.open')}</strong>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {slice.rows.filter((item) => resolveCharacterTier(item) !== 'major').length ? (
            <div className="bl-rows" style={{ marginTop: slice.rows.some((item) => resolveCharacterTier(item) === 'major') ? 13 : 0 }}>
              {slice.rows.filter((item) => resolveCharacterTier(item) !== 'major').map((item) => (
                <div key={item.id} className="bl-card bl-row">
                  <div className="bl-row-copy">
                    <b>{item.name || t('bookLibrary.entry.unnamed')}</b>
                    <small>{t(GROUP_LABEL_KEY[resolveCharacterTier(item)])}</small>
                    <p>{item.brief_description || t('bookLibrary.field.notFilled')}</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpen(item.id)}>
                    {t('bookLibrary.people.open')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {slice.pageCount > 1 ? (
        <nav className="bl-pagination" aria-label={t('bookLibrary.people.pagination')}>
          <Button type="button" size="sm" variant="outline" disabled={slice.page === 0} onClick={() => setPage(slice.page - 1)}>
            {t('bookLibrary.people.prev')}
          </Button>
          <span>{t('bookLibrary.people.pagePosition', { page: slice.page + 1, pageCount: slice.pageCount })}</span>
          <Button type="button" size="sm" variant="outline" disabled={slice.page >= slice.pageCount - 1} onClick={() => setPage(slice.page + 1)}>
            {t('bookLibrary.people.next')}
          </Button>
        </nav>
      ) : null}
    </>
  )
}
