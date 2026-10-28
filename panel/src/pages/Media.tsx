import { CopyIcon, ImageIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle } from '@/components/bits';
import { Field, Loading, Pager, fileToBase64 } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

const isImage = (m: string): boolean => m.startsWith('image/');

/** Media grid. In picker mode (onPick) clicking an item selects it instead of opening details. */
export function MediaLibrary({ onPick, embedded }: { onPick?: (item: any) => void; embedded?: boolean }) {
  const { t } = useI18n();
  const { run } = useSite();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAction<any>('media', 'list', { page, per_page: 24, search: q });
  const [open, setOpen] = useState<any>(null);
  const [alt, setAlt] = useState('');
  const [title, setTitle] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      if (f.size > 8 * 1024 * 1024) {
        toast.error(`${f.name}: ${t('larger than 8 MB', 'بزرگ‌تر از ۸ مگابایت')}`);
        continue;
      }
      await run('media', 'upload', { filename: f.name, data_base64: await fileToBase64(f), alt: f.name.replace(/\.[^.]+$/, '') });
    }
    setBusy(false);
    reload();
  };

  const items: any[] = data?.items ?? [];
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 24));

  return (
    <>
      {!embedded && <PageTitle title={t('Media', 'رسانه')} hint={t('Images and files of the site. Upload, describe for accessibility and SEO, delete.', 'تصاویر و فایل‌های سایت. آپلود، متن جایگزین برای دسترس‌پذیری و سئو، حذف.')} />}
      <div className="mb-4 flex flex-wrap gap-2">
        <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQ(search); }}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search media…', 'جستجوی رسانه…')} className="max-w-xs" />
        </form>
        <input ref={file} type="file" multiple accept="image/*,application/pdf,video/mp4" className="hidden" onChange={(e) => upload(e.target.files)} />
        <Button disabled={busy} onClick={() => file.current?.click()}><UploadIcon /> {busy ? t('Uploading…', 'در حال آپلود…') : t('Upload', 'آپلود')}</Button>
      </div>

      {loading && !data ? <Loading /> : items.length === 0 ? (
        <Empty><ImageIcon className="mx-auto mb-2 size-6 opacity-50" />{t('No media found.', 'رسانه‌ای نیست.')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {items.map((m) => (
            <button key={m.id} className="group overflow-hidden rounded-lg border bg-muted/30 text-start transition hover:ring-2 hover:ring-primary" onClick={() => { if (onPick) onPick(m); else { setOpen(m); setAlt(m.alt ?? ''); setTitle(m.title ?? ''); } }}>
              <div className="grid aspect-square place-items-center overflow-hidden">
                {isImage(m.mime) ? <img src={m.url} alt={m.alt} loading="lazy" className="size-full object-cover" /> : <ImageIcon className="size-8 opacity-40" />}
              </div>
              <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">{m.title}</div>
            </button>
          ))}
        </div>
      )}
      <Pager page={page} pages={pages} onPage={setPage} />

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{open?.title}</DialogTitle></DialogHeader>
          {open && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid place-items-center overflow-hidden rounded-lg border bg-muted/30">{isImage(open.mime) ? <img src={open.url} alt={open.alt} className="max-h-72 object-contain" /> : <ImageIcon className="size-12 opacity-40" />}</div>
              <div className="space-y-3">
                <Field label={t('Alt text (accessibility and SEO)', 'متن جایگزین (دسترس‌پذیری و سئو)')}><Input value={alt} onChange={(e) => setAlt(e.target.value)} /></Field>
                <Field label={t('Title', 'عنوان')}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
                <div dir="ltr" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{open.url}</span>
                  <Button variant="ghost" size="icon-xs" onClick={() => { void navigator.clipboard.writeText(open.url); toast.success(t('Copied', 'کپی شد')); }}><CopyIcon /></Button>
                </div>
                <p className="text-xs text-muted-foreground">{open.width ? `${open.width}×${open.height} · ` : ''}{open.mime}</p>
              </div>
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" className="text-destructive" onClick={async () => { const r = await run('media', 'delete', { id: open.id }); if (r.ok) { setOpen(null); reload(); } }}><Trash2Icon /> {t('Delete', 'حذف')}</Button>
            <Button onClick={async () => { const r = await run('media', 'update', { id: open.id, alt, title }); if (r.ok) { setOpen(null); reload(); } }}>{t('Save', 'ذخیره')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const MediaPage = () => <MediaLibrary />;
