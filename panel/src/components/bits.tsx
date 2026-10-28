import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

export function Pick({ value, onChange, options, className, size }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; size?: 'sm' | 'default' }) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));

  return (
    <Select value={value} onValueChange={(v) => onChange(String(v ?? ''))} items={items}>
      <SelectTrigger className={className ?? 'w-full'} size={size}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Code({ children }: { children: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(children);
      setDone(true);
      toast.success(t('Copied', 'کپی شد'));
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error(t('Copy failed', 'کپی نشد'));
    }
  };

  return (
    <div className="relative">
      <pre dir="ltr" className="overflow-x-auto rounded-lg border bg-muted/50 p-3 pe-12 text-start font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{children}</pre>
      <Button variant="ghost" size="icon-sm" className="absolute end-1.5 top-1.5" onClick={copy} aria-label="copy">
        {done ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  read: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  draft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  live: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  admin: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

export const LevelBadge = ({ level }: { level: string }) => <Badge className={LEVEL_STYLE[level] ?? ''} variant="secondary">{level}</Badge>;

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const ok = status === 'ok';
  const map: Record<string, [string, string]> = { ok: ['Connected', 'متصل'], error: ['Problem', 'مشکل'], new: ['New', 'جدید'], denied: ['Denied', 'رد شد'], pending: ['Needs OK', 'منتظر تأیید'], dry_run: ['Preview', 'پیش‌نمایش'] };
  const [en, fa] = map[status] ?? [status, status];

  return (
    <Badge variant="secondary" className={ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : status === 'error' || status === 'denied' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : ''}>
      {t(en, fa)}
    </Badge>
  );
}

export function PageTitle({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
