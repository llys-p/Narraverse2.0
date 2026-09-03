import { useRef, useState } from 'react'
import { FileUp, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { enqueueMasterTranslationTargets, importMaterialToMaster, previewMaterial, type MaterialPreview } from '@/lib/api'

export function MasterImportDialog({ open, workspace, onOpenChange, onImported }: { open: boolean; workspace: string; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<MaterialPreview | null>(null)
  const [userName, setUserName] = useState('')
  const [acceptIncomplete, setAcceptIncomplete] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const reset = () => {
    setFile(null); setPreview(null); setUserName(''); setAcceptIncomplete(false); setLoading(false); setMessage(''); setError('')
  }

  const selectFile = async (next: File | undefined) => {
    if (!next) return
    setFile(next); setPreview(null); setMessage(''); setError(''); setLoading(true)
    try {
      const result = await previewMaterial(next)
      setPreview(result)
      if (result.character_card?.user_placeholder_found) setUserName(t('importCard.defaultUserCharacterName'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const importToMaster = async () => {
    if (!file || !preview || (preview.truncated && !acceptIncomplete) || loading) return
    setLoading(true); setError(''); setMessage('')
    try {
      const result = await importMaterialToMaster(file, { userCharacterName: userName, acceptIncomplete })
      await enqueueMasterTranslationTargets(workspace, result.translation_targets)
      setMessage(t('library.importSuccess', { name: result.name, count: result.master_item_ids.length }))
      onImported()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!next && !loading) { reset(); onOpenChange(false) } }}>
    <DialogContent className="max-w-[min(520px,calc(100vw-2rem))] border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
      <DialogHeader><DialogTitle>{t('library.importTitle')}</DialogTitle><DialogDescription>{t('library.importDescription')}</DialogDescription></DialogHeader>
      <div className="space-y-3 text-xs">
        <input ref={inputRef} type="file" accept=".json,.png,application/json,image/png" className="hidden" onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = '' }} />
        <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={loading}><FileUp />{t('library.chooseFile')}</Button><span className="min-w-0 truncate text-muted-foreground">{file?.name || t('library.noFile')}</span></div>
        {preview && <div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"><div className="font-medium">{preview.name}</div><div className="mt-1 text-[11px] text-muted-foreground">{t(`settingPanel.materialImport.kind.${preview.kind}`)} · {preview.entry_count} · {preview.truncated ? t('library.truncated') : t('library.complete')}</div>{preview.warnings.map((warning) => <div key={warning} className="mt-1 text-[11px] text-amber-600">{warning}</div>)}</div>}
        {preview?.character_card?.user_placeholder_found && <Input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder={t('importCard.userCharacterName')} disabled={loading} />}
        {preview?.truncated && <label className="flex items-center gap-2 text-[11px] text-amber-600"><input type="checkbox" checked={acceptIncomplete} onChange={(event) => setAcceptIncomplete(event.target.checked)} />{t('settingPanel.materialImport.acceptIncomplete')}</label>}
        {message && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-emerald-600">{message}</div>}
        {error && <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-red-600">{error}</div>}
      </div>
      <DialogFooter><Button type="button" variant="outline" onClick={() => { if (!loading) { reset(); onOpenChange(false) } }} disabled={loading}>{t('common.close')}</Button><Button type="button" onClick={() => void importToMaster()} disabled={!file || !preview || loading || Boolean(preview?.truncated && !acceptIncomplete)}>{loading ? <Loader2 className="animate-spin" /> : <FileUp />}{t('library.importToMaster')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
