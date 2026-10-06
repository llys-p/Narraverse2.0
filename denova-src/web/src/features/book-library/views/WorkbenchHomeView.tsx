import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LoreItem } from '@/lib/api'
import { workspaceAssetURL } from '@/lib/api'
import { BOOK_LIBRARY_CATEGORIES, pinnedEntries, sortByRecentlyEdited, type BookLibraryView } from '../book-library-view-model'

interface WorkbenchHomeViewProps {
  bookName: string
  items: LoreItem[]
  onOpen: (id: string) => void
  onGoto: (view: BookLibraryView) => void
}

/**
 * 工作台首页只用真实可得的数据：条目总数、最近更新、置顶集合与分类计数。
 * 缺字段检查、AI 新建议与事件时间线本期没有可靠来源，因此整块不提供。
 */
export function WorkbenchHomeView({ bookName, items, onOpen, onGoto }: WorkbenchHomeViewProps) {
  const { t } = useTranslation()

  const recent = useMemo(() => sortByRecentlyEdited(items).slice(0, 4), [items])
  const pins = useMemo(() => pinnedEntries(items).slice(0, 6), [items])
  const categoryCounts = useMemo(() => BOOK_LIBRARY_CATEGORIES.map((category) => ({
    id: category.id,
    labelKey: category.labelKey,
    count: items.filter((item) => category.types.includes(item.type)).length,
  })), [items])

  const coverOf = (item: LoreItem) => item.image?.image_path || item.images?.[0]?.image_path || ''

  return (
    <>
      <section className="bl-card bl-home-banner">
        <div className="book-library-eyebrow">{t('bookLibrary.home.eyebrow')}</div>
        <h2>{bookName}</h2>
        <p>{t('bookLibrary.home.subtitle')}</p>
        <div className="bl-entry-count">{t('bookLibrary.home.entryCount', { count: items.length })}</div>
      </section>

      <div className="bl-home-grid">
        <div>
          <section className="bl-home-section">
            <header>
              <h2>{t('bookLibrary.home.continue')}</h2>
              <button type="button" className="bl-chip" style={{ minHeight: 22, padding: '0 7px' }} onClick={() => onGoto('all')}>
                {t('bookLibrary.home.viewAll')}
              </button>
            </header>
            {recent.length ? (
              <div className="bl-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {recent.map((item) => (
                  <button key={item.id} type="button" className="bl-card bl-entry-card" onClick={() => onOpen(item.id)}>
                    {coverOf(item) ? <img className="bl-entry-thumb" src={workspaceAssetURL(coverOf(item))} alt="" loading="lazy" /> : null}
                    <span className="bl-entry-type">{t(`lore.type.${item.type}`)}</span>
                    <h3>{item.name || t('bookLibrary.entry.unnamed')}</h3>
                    <p>{item.brief_description || t('bookLibrary.field.notFilled')}</p>
                  </button>
                ))}
              </div>
            ) : <div className="bl-empty">{t('bookLibrary.empty.description')}</div>}
          </section>

          <section className="bl-home-section">
            <header><h2>{t('bookLibrary.home.pinned')}</h2></header>
            {pins.length ? (
              <div className="bl-rows">
                {pins.map((item) => (
                  <div key={item.id} className="bl-card bl-row">
                    <div className="bl-row-copy">
                      <b>{item.name || t('bookLibrary.entry.unnamed')}</b>
                      <small>{t(`lore.type.${item.type}`)}</small>
                      <p>{item.brief_description || t('bookLibrary.field.notFilled')}</p>
                    </div>
                    <button type="button" className="bl-chip" style={{ minHeight: 26 }} onClick={() => onOpen(item.id)}>
                      {t('bookLibrary.people.open')}
                    </button>
                  </div>
                ))}
              </div>
            ) : <div className="bl-empty">{t('bookLibrary.home.noPinned')}</div>}
          </section>
        </div>

        <aside>
          <section className="bl-card bl-info bl-home-section">
            <h3>{t('bookLibrary.home.categories')}</h3>
            <div className="bl-relation-row" style={{ borderTop: '1px solid var(--nova-border)', borderBottom: 'none' }}>
              <span>{t('bookLibrary.category.all')}</span>
              <button type="button" className="bl-chip" style={{ minHeight: 24 }} onClick={() => onGoto('all')}>{items.length}</button>
            </div>
            {categoryCounts.map((category) => (
              <div className="bl-relation-row" key={category.id} style={{ borderBottom: 'none' }}>
                <span>{t(category.labelKey)}</span>
                <button type="button" className="bl-chip" style={{ minHeight: 24 }} onClick={() => onGoto(category.id)}>
                  {category.count}
                </button>
              </div>
            ))}
          </section>

          <section className="bl-card bl-info bl-home-section">
            <h3>{t('bookLibrary.home.explore')}</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" className="bl-chip" style={{ justifyContent: 'space-between' }} onClick={() => onGoto('graph')}>
                {t('bookLibrary.nav.graph')} <span>{t('bookLibrary.home.openGraph')}</span>
              </button>
              <button type="button" className="bl-chip" style={{ justifyContent: 'space-between' }} onClick={() => onGoto('overview')}>
                {t('bookLibrary.nav.overview')} <span>{t('bookLibrary.home.openOverview')}</span>
              </button>
            </div>
          </section>
        </aside>
      </div>
    </>
  )
}
