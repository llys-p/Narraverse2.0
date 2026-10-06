import { useMemo, useState } from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import type { LoreItem } from '@/lib/api'
import { workspaceAssetURL } from '@/lib/api'
import type { EntryLayout } from '../book-library-view-model'
import { BOOK_LIBRARY_CATEGORIES, filterEntries } from '../book-library-view-model'

interface EntriesViewProps {
  items: LoreItem[]
  query: string
  /** 为空表示「全部资料」，此时提供类型筛选。 */
  types: LoreItem['type'][]
  showTypeFilter: boolean
  onOpen: (id: string) => void
}

export function EntriesView({ items, query, types, showTypeFilter, onOpen }: EntriesViewProps) {
  const { t } = useTranslation()
  const [layout, setLayout] = useState<EntryLayout>('list')
  const [typeFilter, setTypeFilter] = useState<LoreItem['type'] | 'all'>('all')

  const rows = useMemo(() => {
    const scoped = filterEntries(items, query, types)
    return typeFilter === 'all' ? scoped : scoped.filter((item) => item.type === typeFilter)
  }, [items, query, typeFilter, types])

  const typeCounts = useMemo(() => {
    const base = filterEntries(items, query, types)
    return BOOK_LIBRARY_CATEGORIES.flatMap((category) => category.types).reduce<Record<string, number>>((acc, type) => {
      const key = type
      acc[key] = acc[key] || base.filter((item) => item.type === type).length
      return acc
    }, {})
  }, [items, query, types])

  if (!items.length) {
    return <EmptyState variant="page" title={t('bookLibrary.empty.title')} description={t('bookLibrary.empty.description')} />
  }

  return (
    <>
      <div className="book-library-toolbar">
        {showTypeFilter && (
          <>
            <button type="button" className={`bl-chip${typeFilter === 'all' ? ' is-active' : ''}`} aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>
              {t('bookLibrary.filter.all')} <span>{filterEntries(items, query, types).length}</span>
            </button>
            {BOOK_LIBRARY_CATEGORIES.flatMap((category) => category.types).map((type) => (
              <button
                key={type}
                type="button"
                className={`bl-chip${typeFilter === type ? ' is-active' : ''}`}
                aria-pressed={typeFilter === type}
                onClick={() => setTypeFilter((current) => (current === type ? 'all' : type))}
              >
                {t(`lore.type.${type}`)} <span>{typeCounts[type] || 0}</span>
              </button>
            ))}
          </>
        )}
        <span className="spacer" />
        <span className="book-library-total">{t('bookLibrary.entries.count', { count: rows.length })}</span>
        <div className="flex items-center gap-1" role="group" aria-label={t('bookLibrary.view.layout')}>
          <Button type="button" size="icon-xs" variant={layout === 'list' ? 'secondary' : 'ghost'} aria-pressed={layout === 'list'} onClick={() => setLayout('list')} title={t('bookLibrary.view.list')}>
            <List />
          </Button>
          <Button type="button" size="icon-xs" variant={layout === 'cards' ? 'secondary' : 'ghost'} aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')} title={t('bookLibrary.view.cards')}>
            <LayoutGrid />
          </Button>
        </div>
      </div>

      {!rows.length ? (
        <div className="bl-empty">{t('bookLibrary.entries.noMatch')}</div>
      ) : layout === 'list' ? (
        <section className="bl-card">
          <table className="bl-table">
            <thead>
              <tr>
                <th>{t('bookLibrary.entries.name')}</th>
                <th>{t('bookLibrary.entries.type')}</th>
                <th>{t('bookLibrary.entries.brief')}</th>
                <th>{t('bookLibrary.entries.loadMode')}</th>
                <th>{t('bookLibrary.entries.relations')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id} tabIndex={0} onClick={() => onOpen(item.id)} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(item.id) }}>
                  <td>
                    <span className="bl-name">
                      <span><b>{item.name || t('bookLibrary.entry.unnamed')}</b><small>{(item.tags || []).join(' · ')}</small></span>
                    </span>
                  </td>
                  <td>{t(`lore.type.${item.type}`)}</td>
                  <td className="max-w-[36rem]">{item.brief_description || t('bookLibrary.field.notFilled')}</td>
                  <td>{t(`lore.loadMode.${item.load_mode || 'auto'}`)}</td>
                  <td>{(item.relations || []).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="bl-grid">
          {rows.map((item) => (
            <button key={item.id} type="button" className="bl-card bl-entry-card" onClick={() => onOpen(item.id)}>
              {item.image?.image_path || item.images?.[0]?.image_path ? (
                <img className="bl-entry-thumb" src={workspaceAssetURL(item.image?.image_path || item.images?.[0]?.image_path || '')} alt="" loading="lazy" />
              ) : null}
              <span className="bl-entry-type">{t(`lore.type.${item.type}`)}</span>
              <h3>{item.name || t('bookLibrary.entry.unnamed')}</h3>
              <p>{item.brief_description || t('bookLibrary.field.notFilled')}</p>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
