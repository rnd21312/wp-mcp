import { RefreshCwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageTitle, StatusBadge } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ago, api, type Activity } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function ActivityPage() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Activity[]>([]);
  const load = useCallback(async () => setRows((await api.activity(150)).entries), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageTitle title={t('Activity', 'فعالیت‌ها')} hint={t('Every call the AI or this panel made through the gateway. The site keeps its own log with undo points.', 'هر فراخوانی که هوش مصنوعی یا این پنل از طریق gateway انجام داده. خود سایت هم لاگ و نقاط بازگشت دارد.')}>
        <Button variant="outline" onClick={load}><RefreshCwIcon /> {t('Refresh', 'تازه‌سازی')}</Button>
      </PageTitle>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('When', 'زمان')}</TableHead>
                <TableHead>{t('Who', 'چه کسی')}</TableHead>
                <TableHead>{t('Site', 'سایت')}</TableHead>
                <TableHead>{t('Action', 'عملیات')}</TableHead>
                <TableHead>{t('Result', 'نتیجه')}</TableHead>
                <TableHead>{t('Details', 'جزئیات')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{ago(r.ts, lang)}</TableCell>
                  <TableCell>{r.principal_name}</TableCell>
                  <TableCell>{r.site || '—'}</TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">{r.tool}.{r.action}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={r.summary}>{r.summary}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{t('Nothing yet.', 'هنوز چیزی نیست.')}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
