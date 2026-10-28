import { BotIcon, CheckIcon, PlusIcon, SendIcon, SettingsIcon, Trash2Icon, UserIcon, WrenchIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageTitle, Pick } from '@/components/bits';
import { Field } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/site';

interface Preset { id: string; label: string; base: string; model: string; models: string[]; needsKey: boolean; keyUrl: string }
interface Prov { id: string; name: string; preset: string; model: string; has_key: boolean; base_url: string }
interface Msg { role: 'user' | 'assistant' | 'tool'; content?: string; toolCalls?: { id: string; name: string; args: any }[]; toolCallId?: string; name?: string; isError?: boolean }

const summarize = (c: { name: string; args: any }): string => `${c.name}.${c.args?.action ?? ''}${c.args?.site ? ` @${c.args.site}` : ''}`;

function ProviderDialog({ open, onClose, presets, onSaved }: { open: boolean; onClose: () => void; presets: Preset[]; onSaved: () => void }) {
  const { t } = useI18n();
  const [preset, setPreset] = useState('openai');
  const p = presets.find((x) => x.id === preset) ?? presets[0];
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (p) { setBase(p.base); setModel(p.model); setName(''); } }, [preset, p?.id]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('Add an AI provider', 'افزودن ارائه‌دهنده‌ی هوش مصنوعی')}</DialogTitle><DialogDescription>{t('The key is stored encrypted on this computer and is only ever sent to the provider.', 'کلید روی همین کامپیوتر رمزشده ذخیره می‌شود و فقط به خود ارائه‌دهنده فرستاده می‌شود.')}</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <Field label={t('Provider', 'ارائه‌دهنده')}><Pick value={preset} onChange={setPreset} options={presets.map((x) => ({ value: x.id, label: x.label }))} /></Field>
          {p?.id === 'custom' && <Field label={t('Base URL', 'آدرس پایه')} hint="https://…/v1"><Input dir="ltr" value={base} onChange={(e) => setBase(e.target.value)} /></Field>}
          <Field label={t('Model', 'مدل')} hint={p?.models.length ? <span dir="ltr">{p.models.join(' · ')}</span> : undefined}><Input dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} /></Field>
          {p?.needsKey !== false && <Field label={t('API key', 'کلید API')} hint={p?.keyUrl ? <a className="text-primary hover:underline" dir="ltr" href={p.keyUrl} target="_blank" rel="noreferrer">{p.keyUrl}</a> : undefined}><Input dir="ltr" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>}
          <Field label={t('Name (optional)', 'نام (اختیاری)')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('Cancel', 'انصراف')}</Button>
          <Button onClick={async () => { const r = await api.post<any>('ai/providers/add', { preset, name, base_url: p?.id === 'custom' ? base : '', model, key }); if (r.ok) { setKey(''); onSaved(); onClose(); } else setErr(r.error?.message ?? 'Failed'); }}>{t('Save', 'ذخیره')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AiPage() {
  const { t } = useI18n();
  const { site, level } = useSite();
  const [provs, setProvs] = useState<Prov[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [sel, setSel] = useState(() => { try { return localStorage.getItem('wpm_ai') ?? ''; } catch { return ''; } });
  const [adding, setAdding] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<any>(null);
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    const r = await fetch('/admin/api/ai/providers', { headers: { 'x-wpm-panel': '1' } }).then((x) => x.json());
    setProvs(r.providers);
    setPresets(r.presets);
    setSel((s) => (r.providers.some((p: Prov) => p.id === s) ? s : r.providers[0]?.id ?? ''));
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { try { localStorage.setItem('wpm_ai', sel); } catch { /* ignore */ } }, [sel]);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [msgs, pending, busy]);

  const send = async (messages: Msg[], approve?: { toolCallId: string; ok: boolean }): Promise<void> => {
    setBusy(true);
    setErr('');
    setPending(null);
    setMsgs(messages);
    const r = await api.post<any>('ai/chat', { provider: sel, site: site?.name, level, messages, approve });
    setBusy(false);
    setMsgs(r.messages ?? messages);
    if (r.pending) setPending(r.pending);
    if (!r.ok || r.error) setErr(r.error ?? 'Failed');
  };

  const ask = (q: string): void => { if (!q.trim() || busy || !sel) return; setText(''); void send([...msgs, { role: 'user', content: q.trim() }]); };
  const prov = provs.find((p) => p.id === sel);
  const suggestions = [t('Audit the SEO of the home page and list fixes', 'سئوی صفحه‌ی اصلی را بررسی کن و راه‌حل‌ها را بنویس'), t('Check the health of the site and what needs updating', 'سلامت سایت و آنچه نیاز به به‌روزرسانی دارد را بررسی کن'), t('Write a draft blog post about our services', 'یک پیش‌نویس نوشته درباره‌ی خدمات ما بنویس'), t('List all pages that have no meta description', 'همه‌ی برگه‌هایی که توضیحات متا ندارند را فهرست کن')];

  return (
    <>
      <PageTitle title={t('AI assistant', 'دستیار هوش مصنوعی')} hint={t('Chat with any AI. It uses the same tools, levels and confirmations as everything else, on the selected site.', 'با هر هوش مصنوعی گفتگو کنید. با همان ابزارها، سطح‌ها و تأییدها روی سایت انتخاب‌شده کار می‌کند.')}>
        <Button variant="outline" onClick={() => setAdding(true)}><PlusIcon /> {t('Provider', 'ارائه‌دهنده')}</Button>
        {prov && <Button variant="ghost" size="icon" title={t('Remove provider', 'حذف ارائه‌دهنده')} onClick={async () => { await api.post('ai/providers/remove', { id: prov.id }); await load(); }}><Trash2Icon /></Button>}
      </PageTitle>

      {provs.length === 0 ? (
        <Card className="border-dashed"><CardContent className="space-y-3 py-10 text-center"><SettingsIcon className="mx-auto size-8 opacity-40" /><p className="text-sm text-muted-foreground">{t('Add a provider and its API key to start: ChatGPT (OpenAI), Claude, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Grok, or a free local model with Ollama.', 'یک ارائه‌دهنده و کلید API آن را اضافه کنید: ChatGPT (OpenAI)، Claude، Gemini، OpenRouter، DeepSeek، Groq، Mistral، Grok یا مدل محلی رایگان با Ollama.')}</p><Button onClick={() => setAdding(true)}>{t('Add a provider', 'افزودن ارائه‌دهنده')}</Button></CardContent></Card>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-64"><Pick value={sel} onChange={setSel} options={provs.map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` }))} /></div>
            <Badge variant="outline">{site?.name ?? '—'}</Badge><Badge variant="secondary">{level}</Badge>
            {msgs.length > 0 && <Button variant="ghost" size="sm" onClick={() => { setMsgs([]); setPending(null); setErr(''); }}>{t('New chat', 'گفتگوی تازه')}</Button>}
          </div>

          <div className="min-h-[50vh] space-y-3 rounded-xl border p-3">
            {msgs.length === 0 && <div className="space-y-2 py-6 text-center"><BotIcon className="mx-auto size-8 opacity-40" /><div className="flex flex-wrap justify-center gap-2">{suggestions.map((s) => <button key={s} className="rounded-full border px-3 py-1.5 text-xs hover:bg-muted" onClick={() => ask(s)}>{s}</button>)}</div></div>}
            {msgs.map((m, i) => m.role === 'user' ? (
              <div key={i} className="flex gap-2"><UserIcon className="mt-1 size-4 shrink-0 text-muted-foreground" /><div dir="auto" className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{m.content}</div></div>
            ) : m.role === 'assistant' ? (
              <div key={i} className="space-y-1.5">
                {m.content && <div className="flex gap-2"><BotIcon className="mt-1 size-4 shrink-0 text-primary" /><div dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div></div>}
                {m.toolCalls?.map((c) => { const res = msgs.find((x) => x.role === 'tool' && x.toolCallId === c.id); const failed = res?.isError || (res?.content ?? '').includes('"ok":false');
                  return <details key={c.id} className="ms-6 rounded border text-xs"><summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1"><WrenchIcon className="size-3" /><span dir="ltr" className="font-mono">{summarize(c)}</span>{res ? failed ? <XIcon className="size-3 text-destructive" /> : <CheckIcon className="size-3 text-emerald-600" /> : <span className="text-muted-foreground">…</span>}</summary><pre dir="ltr" className="max-h-60 overflow-auto border-t p-2 text-start font-mono text-[11px] whitespace-pre-wrap break-words">{JSON.stringify(c.args)}{res?.content ? `\n\n→ ${res.content.slice(0, 3000)}` : ''}</pre></details>; })}
              </div>
            ) : null)}
            {busy && <p className="text-sm text-muted-foreground">{t('Thinking…', 'در حال فکر کردن…')}</p>}
            {pending && (
              <Alert>
                <AlertTitle>{t('The assistant wants to do this. Nothing has changed yet.', 'دستیار می‌خواهد این کار را بکند. هنوز چیزی تغییر نکرده.')} <span dir="ltr" className="font-mono text-xs">{pending.action}</span></AlertTitle>
                <AlertDescription className="space-y-3"><pre dir="ltr" className="max-h-52 overflow-auto rounded border bg-muted/40 p-2 text-start font-mono text-[11px] whitespace-pre-wrap break-words">{JSON.stringify(pending.preview, null, 2)}</pre>
                  <div className="flex gap-2"><Button variant="destructive" size="sm" disabled={busy} onClick={() => send(msgs, { toolCallId: pending.toolCallId, ok: true })}>{t('Approve', 'تأیید')}</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => send(msgs, { toolCallId: pending.toolCallId, ok: false })}>{t('Decline', 'رد')}</Button></div></AlertDescription>
              </Alert>
            )}
            {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
            <div ref={end} />
          </div>

          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
            <Textarea dir="auto" rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(text); } }} placeholder={t('Ask or tell the assistant what to do…', 'بپرسید یا بگویید چه کاری انجام شود…')} />
            <Button size="icon-lg" disabled={busy || !text.trim() || !!pending}><SendIcon className="rtl:-scale-x-100" /></Button>
          </form>
        </div>
      )}
      <ProviderDialog open={adding} onClose={() => setAdding(false)} presets={presets} onSaved={load} />
    </>
  );
}
