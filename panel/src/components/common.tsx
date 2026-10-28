import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/site';

export const Spinner = () => <Loader2Icon className="size-4 animate-spin text-muted-foreground" />;

export const Loading = () => (
  <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
    <Spinner />
  </div>
);

export const ErrorBox = ({ message }: { message: string }) => (
  <Alert variant="destructive">
    <AlertDescription>{message}</AlertDescription>
  </Alert>
);

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const { lang } = useI18n();
  if (pages <= 1) return null;
  const Prev = lang === 'fa' ? ChevronRightIcon : ChevronLeftIcon;
  const Next = lang === 'fa' ? ChevronLeftIcon : ChevronRightIcon;

  return (
    <div className="flex items-center justify-center gap-3 pt-4 text-sm">
      <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><Prev /></Button>
      <span className="text-muted-foreground">{page} / {pages}</span>
      <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}><Next /></Button>
    </div>
  );
}

/** Wraps a page that needs a connected site (and optionally a minimum feature of the bridge). */
export function NeedSite({ children }: { children: ReactNode }) {
  const { site } = useSite();
  const { t } = useI18n();
  if (!site) return <ErrorBox message={t('Connect a site first (Sites page).', 'اول یک سایت وصل کنید (صفحه‌ی سایت‌ها).')} />;

  return <>{children}</>;
}

/** Count characters for SEO fields and colour the counter inside a good range. */
export function Counter({ value, min, max }: { value: string; min: number; max: number }) {
  const n = value.length;
  const ok = n >= min && n <= max;

  return <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : n === 0 ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}>{n}/{max}</span>;
}

/** Turns "&#8217;" style entities from WordPress text into real characters. */
export const plain = (s: string): string => new DOMParser().parseFromString(String(s ?? ''), 'text/html').documentElement.textContent ?? '';

export const pathOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
};

export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
