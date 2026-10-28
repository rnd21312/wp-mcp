import { toast } from 'sonner';
import { useState } from 'react';
import { Pick } from '@/components/bits';
import { Field } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const empty = { name: '', folder: '', title: '', admin_email: '', admin_user: '', method: 'cpanel', url: '', user: '', secret: '', root_pass: '', db_host: 'localhost', db_name: '', db_user: '', db_pass: '' };

export function WordPressDialog({ host, onClose, onDone }: { host: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; admin_user: string; admin_password: string } | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const db = (): Record<string, unknown> => {
    if (f.method === 'cpanel') return { method: 'cpanel', url: f.url, user: f.user, token: f.secret };
    if (f.method === 'directadmin') return { method: 'directadmin', url: f.url, user: f.user, key: f.secret };
    if (f.method === 'mysql_root') return { method: 'mysql_root', host: f.db_host, root_pass: f.root_pass };
    return { method: 'manual', host: f.db_host, name: f.db_name, user: f.db_user, pass: f.db_pass };
  };

  const go = async (): Promise<void> => {
    setBusy(true);
    const r = await api.post<any>('hosts/wordpress/create', { host, name: f.name, folder: f.folder === '' ? undefined : f.folder, title: f.title || f.name, admin_email: f.admin_email, admin_user: f.admin_user, db: db() });
    setBusy(false);
    if (r.ok) {
      setResult(r);
      await onDone();
    } else toast.error(r.error?.message ?? 'error');
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('New WordPress site', 'سایت وردپرس جدید')}</DialogTitle>
          <DialogDescription>{t('Downloads the official WordPress, creates the database, installs it and connects it here. Takes about a minute.', 'وردپرس رسمی را دانلود می‌کند، دیتابیس می‌سازد، نصب و همین‌جا وصل می‌کند. حدود یک دقیقه.')}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 text-sm">
            <p>{t('Done. Save these now; the password is not stored anywhere.', 'تمام شد. همین حالا ذخیره کنید؛ گذرواژه جایی ذخیره نمی‌شود.')}</p>
            <div dir="ltr" className="space-y-1 rounded-lg bg-muted p-3 font-mono text-xs select-all">
              <div>{result.url}wp-admin/</div>
              <div>user: {result.admin_user}</div>
              <div>password: {result.admin_password}</div>
            </div>
            <Button onClick={onClose}>{t('Close', 'بستن')}</Button>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('Site name', 'نام سایت')} hint="a-z 0-9 -"><Input dir="ltr" value={f.name} onChange={set('name')} /></Field>
              <Field label={t('Folder (default: site name)', 'پوشه (پیش‌فرض: نام سایت)')}><Input dir="ltr" placeholder={f.name} value={f.folder} onChange={set('folder')} /></Field>
              <Field label={t('Site title', 'عنوان سایت')}><Input value={f.title} onChange={set('title')} /></Field>
              <Field label={t('Admin email', 'ایمیل مدیر')}><Input dir="ltr" value={f.admin_email} onChange={set('admin_email')} /></Field>
              <Field label={t('Admin username (optional)', 'نام کاربری مدیر (اختیاری)')}><Input dir="ltr" value={f.admin_user} onChange={set('admin_user')} /></Field>
              <Field label={t('Database', 'دیتابیس')}>
                <Pick value={f.method} onChange={(method) => setF({ ...f, method })} options={[{ value: 'cpanel', label: 'cPanel (API token)' }, { value: 'directadmin', label: 'DirectAdmin (Login Key)' }, { value: 'mysql_root', label: t('MySQL admin (VPS)', 'مدیر MySQL (VPS)') }, { value: 'manual', label: t('I have the details', 'مشخصات را دارم') }]} />
              </Field>
            </div>
            {(f.method === 'cpanel' || f.method === 'directadmin') && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('Panel address', 'نشانی پنل')}><Input dir="ltr" placeholder={f.method === 'cpanel' ? 'https://host:2083' : 'https://host:2222'} value={f.url} onChange={set('url')} /></Field>
                <Field label={t('Panel username', 'نام کاربری پنل')}><Input dir="ltr" value={f.user} onChange={set('user')} /></Field>
                <Field label={f.method === 'cpanel' ? 'API token' : 'Login Key'}><Input dir="ltr" type="password" value={f.secret} onChange={set('secret')} /></Field>
              </div>
            )}
            {f.method === 'mysql_root' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="MySQL host"><Input dir="ltr" value={f.db_host} onChange={set('db_host')} /></Field>
                <Field label={t('root password', 'گذرواژه‌ی root')}><Input dir="ltr" type="password" value={f.root_pass} onChange={set('root_pass')} /></Field>
              </div>
            )}
            {f.method === 'manual' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Host"><Input dir="ltr" value={f.db_host} onChange={set('db_host')} /></Field>
                <Field label={t('Database name', 'نام دیتابیس')}><Input dir="ltr" value={f.db_name} onChange={set('db_name')} /></Field>
                <Field label={t('Database user', 'کاربر دیتابیس')}><Input dir="ltr" value={f.db_user} onChange={set('db_user')} /></Field>
                <Field label={t('Database password', 'گذرواژه‌ی دیتابیس')}><Input dir="ltr" type="password" value={f.db_pass} onChange={set('db_pass')} /></Field>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('Panel and database secrets are used once, over the signed channel, and are not stored by the Studio.', 'اطلاعات پنل و دیتابیس یک بار از کانال امضاشده استفاده می‌شود و Studio ذخیره‌شان نمی‌کند.')}</p>
            <DialogFooter>
              <Button disabled={busy || !f.name || !f.admin_email} onClick={go}>{busy ? t('Installing…', 'در حال نصب…') : t('Create WordPress', 'ساخت وردپرس')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
