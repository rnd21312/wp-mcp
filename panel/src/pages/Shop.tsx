import { PackageIcon, PencilIcon, PlusIcon, SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, PageTitle, Pick } from '@/components/bits';
import { Field, Loading, Pager } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

export function Shop() {
  const { t } = useI18n();
  const { overview, run } = useSite();
  const woo = !!overview?.woocommerce;
  const status = useAction<any>('shop', 'status', {}, woo);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [s, setS] = useState('');
  const list = useAction<any>('shop', 'products_list', { page, per_page: 20, search: q, status: 'any' }, woo);
  const [edit, setEdit] = useState<any>(null);
  const [f, setF] = useState<any>({});
  const [quick, setQuick] = useState<Record<number, { stock?: string; price?: string }>>({});

  useEffect(() => setPage(1), [q]);
  if (!overview) return <Loading />;
  if (!woo) return (
    <>
      <PageTitle title={t('Shop', 'فروشگاه')} />
      <Empty><PackageIcon className="mx-auto mb-2 size-7 opacity-50" />{t('WooCommerce is not active on this site. Install it from Plugins to sell products.', 'ووکامرس روی این سایت فعال نیست. برای فروش محصول از بخش افزونه‌ها نصبش کنید.')}</Empty>
    </>
  );

  const open = async (p: any): Promise<void> => {
    setEdit(p);
    if (!p.id) { setF({ name: '', regular_price: '', sale_price: '', description: '', status: 'draft' }); return; }
    const r = await run<any>('shop', 'product_get', { id: p.id }, { quiet: true });
    if (r.ok) setF({ name: r.data.name, regular_price: r.data.regular_price, sale_price: r.data.sale_price, description: r.data.description, status: r.data.status });
  };
  const items: any[] = list.data?.products ?? [];

  return (
    <>
      <PageTitle title={t('Shop', 'فروشگاه')} hint={status.data ? `${status.data.products?.published ?? 0} ${t('published products', 'محصول منتشرشده')} · ${status.data.currency}` : ''}>
        <Button onClick={() => open({})}><PlusIcon /> {t('New product', 'محصول جدید')}</Button>
      </PageTitle>
      <form className="mb-4" onSubmit={(e) => { e.preventDefault(); setQ(s); }}><Input value={s} onChange={(e) => setS(e.target.value)} placeholder={t('Search products…', 'جستجوی محصول…')} className="max-w-xs" /></form>
      {list.loading && !list.data ? <Loading /> : items.length === 0 ? <Empty>{t('No products.', 'محصولی نیست.')}</Empty> : (
        <Card><CardContent className="divide-y p-0">
          {items.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {p.image ? <img src={p.image} alt="" className="size-12 rounded-lg border object-cover" /> : <div className="grid size-12 place-items-center rounded-lg border bg-muted"><PackageIcon className="size-5 opacity-40" /></div>}
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.sku || '—'} · <Badge variant="outline">{p.status}</Badge></div></div>
              <Input type="number" className="h-8 w-28" placeholder={t('Price', 'قیمت')} defaultValue={p.regular_price} onChange={(e) => setQuick({ ...quick, [p.id]: { ...quick[p.id], price: e.target.value } })} />
              <Input type="number" className="h-8 w-20" placeholder={t('Stock', 'موجودی')} defaultValue={p.stock_quantity ?? ''} onChange={(e) => setQuick({ ...quick, [p.id]: { ...quick[p.id], stock: e.target.value } })} />
              <Button variant="outline" size="sm" disabled={!quick[p.id]} onClick={async () => { const x = quick[p.id]; if ((await run('shop', 'stock_update', { items: [{ id: p.id, ...(x.price !== undefined ? { regular_price: x.price } : {}), ...(x.stock ? { stock_quantity: Number(x.stock) } : {}) }] })).ok) { setQuick({ ...quick, [p.id]: undefined as never }); list.reload(); } }}>{t('Update', 'ثبت')}</Button>
              <Button variant="ghost" size="icon-sm" onClick={() => open(p)}><PencilIcon /></Button>
            </div>
          ))}
        </CardContent></Card>
      )}
      <Pager page={page} pages={Math.max(1, Math.ceil((status.data?.products?.published ?? 0) / 20))} onPage={setPage} />

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{edit?.id ? edit.name : t('New product', 'محصول جدید')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label={t('Name', 'نام')}><Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('Regular price', 'قیمت')}><Input type="number" value={f.regular_price ?? ''} onChange={(e) => setF({ ...f, regular_price: e.target.value })} /></Field>
              <Field label={t('Sale price', 'قیمت با تخفیف')}><Input type="number" value={f.sale_price ?? ''} onChange={(e) => setF({ ...f, sale_price: e.target.value })} /></Field>
            </div>
            <Field label={t('Status', 'وضعیت')}><Pick value={f.status ?? 'draft'} onChange={(v) => setF({ ...f, status: v })} options={['draft', 'publish', 'private'].map((x) => ({ value: x, label: x }))} /></Field>
            <Field label={t('Description', 'توضیحات')}><Textarea rows={6} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEdit(null)}>{t('Cancel', 'انصراف')}</Button><Button disabled={!f.name} onClick={async () => { if ((await run('shop', 'product_save', { ...(edit?.id ? { id: edit.id } : {}), ...f })).ok) { setEdit(null); list.reload(); } }}><SaveIcon /> {t('Save', 'ذخیره')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
