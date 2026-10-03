import { Bookmark, CircleHelp, FileText, Globe, ScrollText, Sparkles, Swords } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoreItem } from '@/lib/api'
import { ThemedMarkdownRenderer } from '@/components/common/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { presetActionButtonClassName as actionButtonClassName } from '../preset-config/editor-styles'
import type { parseOverview } from './book-overview-reading'
import { loreLoadModeLabel, loreTypeLabel } from './editor-shared'

function sectionIcon(heading: string) {
  if (/概况|背景|时代|基调|world|setting/i.test(heading)) return Globe
  if (/矛盾|局势|conflict/i.test(heading)) return Swords
  return ScrollText
}

// Reading projection only: the parent owns saving, featured entries and AI drafts.
export function BookOverviewReadView({ content, draft, items, grouped, gaps, onEdit, onOpenItem }: {
  content: string
  draft: ReturnType<typeof parseOverview>
  items: LoreItem[]
  grouped: { type: LoreItem['type']; entries: LoreItem[] }[]
  gaps: string[]
  onEdit: () => void
  onOpenItem?: (id: string) => void
}) {
  const { t } = useTranslation()
  const pinnedCount = items.filter((item) => item.pinned).length
  const residentCount = items.filter((item) => item.enabled && item.load_mode === 'resident').length
  const entryCount = (count: number) => t('settingPanel.bookOverview.entriesCount', { count })
  return (
    <div className="bo-reading">
      <div className="bo-layout">
        <div className="bo-main">
          {draft.title ? <h2 className="bo-book-title">{draft.title}</h2> : null}
          <section>
            <h3 className="bo-section-heading">
              <Sparkles aria-hidden="true" />{t('settingPanel.bookOverview.sectionLede')}
              <span className="bo-section-hint">{t('settingPanel.bookOverview.ledeHint')}</span>
            </h3>
            <ThemedMarkdownRenderer className="bo-lede" content={draft.lede || t('settingPanel.bookOverview.emptySection')} />
          </section>
          {!content.trim() && !pinnedCount ? (
            <div className="bo-empty">
              {t('settingPanel.bookOverview.emptyOverview')}
              <div className="mt-3">
                <Button className={actionButtonClassName} variant="outline" size="sm" onClick={onEdit}>
                  {t('settingPanel.bookOverview.editMode')}
                </Button>
              </div>
            </div>
          ) : null}
          {draft.blocks.map((block, index) => {
            const Icon = sectionIcon(block.heading)
            return (
              <section key={`${index}:${block.heading}`}>
                <h3 className="bo-section-heading"><Icon aria-hidden="true" />{block.heading}</h3>
                <ThemedMarkdownRenderer className="bo-prose" content={block.body || t('settingPanel.bookOverview.emptySection')} />
              </section>
            )
          })}
          <section>
            <h3 className="bo-section-heading">
              <Bookmark aria-hidden="true" />{t('settingPanel.bookOverview.sectionKeyEntries')}
              <span className="bo-section-hint">{t('settingPanel.bookOverview.keyHint')}</span>
            </h3>
            {grouped.length === 0 ? <p className="bo-empty">{t('settingPanel.bookOverview.noPinnedYet')}</p> : grouped.map((group) => (
              <div className="bo-group" key={group.type}>
                <h4 className="bo-group-heading">{loreTypeLabel(group.type, t)}<span className="bo-badge">{group.entries.length}</span></h4>
                <div className="bo-key-grid">
                  {group.entries.map((entry) => (
                    <article className="bo-key-card" key={entry.id}>
                      <div className="bo-key-title">
                        <span className="bo-key-name">{entry.name}</span>
                        <span className="bo-badge bo-badge-key">{t('settingPanel.bookOverview.pinnedTag')}</span>
                        {entry.enabled && entry.load_mode === 'resident' ? <span className="bo-badge">{t('settingPanel.bookOverview.residentTag')}</span> : null}
                      </div>
                      <p className="bo-key-brief line-clamp-3">{entry.brief_description}</p>
                      {onOpenItem ? <Button className={`${actionButtonClassName} bo-key-action`} variant="outline" size="sm" onClick={() => onOpenItem(entry.id)}>{t('settingPanel.bookOverview.viewEntry')}</Button> : null}
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </section>
          {gaps.length > 0 ? (
            <section className="bo-gaps">
              <h3 className="bo-section-heading"><CircleHelp aria-hidden="true" />{t('settingPanel.bookOverview.gapsTitle')}</h3>
              <div className="bo-prose">
                <ul>{gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                <p className="bo-side-note">{t('settingPanel.bookOverview.gapsNoAutoFix')}</p>
              </div>
            </section>
          ) : null}
        </div>
        <div className="bo-side">
          <aside className="bo-side-card" aria-label={t('settingPanel.bookOverview.composition')}>
            <h3 className="bo-section-heading"><FileText aria-hidden="true" />{t('settingPanel.bookOverview.composition')}</h3>
            <dl>
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.overviewLabel')}</dt><dd>{t('settingPanel.bookOverview.overviewChars', { count: Array.from(content).length })}</dd></div>
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.sectionKeyEntries')}</dt><dd>{entryCount(pinnedCount)}</dd></div>
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.allEntries')}</dt><dd>{entryCount(items.length)}</dd></div>
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.gapsTitle')}</dt><dd>{gaps.length}</dd></div>
            </dl>
            <p className="bo-side-note">{t('settingPanel.bookOverview.compositionNote')}</p>
          </aside>
          <aside className="bo-side-card" aria-label={t('settingPanel.bookOverview.loadingDisplay')}>
            <h3>{t('settingPanel.bookOverview.loadingDisplay')}</h3>
            <dl>
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.residentEntries')}</dt><dd>{entryCount(residentCount)}</dd></div>
              {(['auto', 'manual'] as const).map((mode) => (
                <div className="bo-compose-row" key={mode}><dt>{loreLoadModeLabel(mode, t)}</dt><dd>{entryCount(items.filter((item) => item.enabled && item.load_mode === mode).length)}</dd></div>
              ))}
              <div className="bo-compose-row"><dt>{t('settingPanel.bookOverview.sectionKeyEntries')}</dt><dd>{entryCount(pinnedCount)}</dd></div>
            </dl>
            <p className="bo-side-note">{t('settingPanel.bookOverview.loadingNote')}</p>
          </aside>
        </div>
      </div>
    </div>
  )
}
