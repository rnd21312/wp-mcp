import { FilePlusIcon, FolderPlusIcon, HammerIcon, RocketIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle, Pick } from '@/components/bits';
import { Field, Loading } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ago, api, type ProjectInfo } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useStudio } from '@/pages/Hosts';

interface FileInfo { path: string; bytes: number }

function Workspace({ project, hosts, onDeployed }: { project: ProjectInfo; hosts: string[]; onDeployed: () => Promise<void> }) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [current, setCurrent] = useState('');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [binary, setBinary] = useState(false);
  const [host, setHost] = useState(project.host || hosts[0] || '');
  const [folder, setFolder] = useState(project.name);
  const [note, setNote] = useState('');
  const [nodeForm, setNodeForm] = useState({ app_root: '', docroot: '', check_url: '', env: '' });
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ status: string; step: string; log: string; error: string; output: { dir: string; files: number } | null } | null>(null);

  useEffect(() => {
    // pick up a build that is already running (or just finished) when the project is opened
    void api.post<any>('projects/build-status', { project: project.name }).then((r) => r.ok && r.job && setJob(r.job));
  }, [project.name]);

  useEffect(() => {
    if (job?.status !== 'running') return;
    const id = setInterval(async () => {
      const r = await api.post<any>('projects/build-status', { project: project.name });
      if (r.ok && r.job) setJob(r.job);
    }, 1000);
    return () => clearInterval(id);
  }, [job?.status, project.name]);

  const build = async (): Promise<void> => {
    if (dirty) await save();
    const r = await api.post<any>('projects/build', { project: project.name });
    r.ok ? setJob(r.job) : toast.error(r.error?.message ?? 'error');
  };

  const load = useCallback(async () => {
    const r = await api.post<{ ok: boolean; files: FileInfo[] }>('projects/files', { project: project.name });
    if (r.ok) setFiles(r.files);
  }, [project.name]);
  useEffect(() => { void load(); }, [load]);

  const open = async (path: string): Promise<void> => {
    if (dirty && !confirm(t('Discard unsaved changes?', 'تغییرات ذخیره‌نشده دور ریخته شود؟'))) return;
    const r = await api.post<{ ok: boolean; content: string; binary: boolean; error?: { message: string } }>('projects/read', { project: project.name, path });
    if (!r.ok) return void toast.error(r.error?.message ?? 'error');
    setCurrent(path);
    setText(r.content);
    setBinary(r.binary);
    setDirty(false);
  };

  const save = async (): Promise<void> => {
    const r = await api.post('projects/write', { project: project.name, path: current, content: text });
    r.ok ? (setDirty(false), toast.success(t('Saved', 'ذخیره شد'))) : toast.error(r.error?.message ?? 'error');
  };

  const addFile = async (): Promise<void> => {
    const path = prompt(t('New file path (for example about.html or css/site.css)', 'مسیر فایل جدید (مثلاً about.html یا css/site.css)'));
    if (!path) return;
    const r = await api.post('projects/write', { project: project.name, path, content: '' });
    r.ok ? (await load(), await open(path)) : toast.error(r.error?.message ?? 'error');
  };

  const remove = async (): Promise<void> => {
    if (!current || !confirm(t(`Delete ${current}?`, `${current} حذف شود؟`))) return;
    await api.post('projects/delete-file', { project: project.name, path: current });
    setCurrent('');
    setText('');
    await load();
  };

  const deploy = async (): Promise<void> => {
    if (dirty) await save();
    setBusy(true);
    const env: Record<string, string> = {};
    for (const line of nodeForm.env.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim();
    }
    const node = project.kind === 'node' ? { app_root: nodeForm.app_root, docroot: nodeForm.docroot, check_url: nodeForm.check_url, env } : undefined;
    const r = await api.post<any>('projects/deploy', { project: project.name, host, folder, note, node, ...(project.host === host && project.site ? { site: project.site } : {}) });
    setBusy(false);
    if (r.ok) {
      toast.success(t(`Published: ${r.files} files, release ${r.release.id}`, `منتشر شد: ${r.files} فایل، نسخه ${r.release.id}`));
      if (r.check) r.check.status >= 200 && r.check.status < 400 ? toast.success(t(`The address answers (HTTP ${r.check.status}).`, `نشانی پاسخ می‌دهد (HTTP ${r.check.status}).`)) : toast.warning(t(`The address answered HTTP ${r.check.status || 'nothing'}. Node apps may need to be registered or restarted in the hosting panel.`, `نشانی پاسخ ${r.check.status || 'نداد'} داد. ممکن است برنامه‌ی Node باید در پنل هاست ثبت یا ری‌استارت شود.`));
      await onDeployed();
    } else toast.error(r.error?.message ?? 'error');
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <div className="space-y-2">
        <div className="max-h-96 overflow-y-auto rounded-lg border p-1 text-sm">
          {files.map((f) => (
            <button key={f.path} dir="ltr" onClick={() => open(f.path)} className={`block w-full truncate rounded px-2 py-1 text-start hover:bg-muted ${f.path === current ? 'bg-muted font-medium' : ''}`}>{f.path}</button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={addFile}><FilePlusIcon /> {t('New file', 'فایل جدید')}</Button>
      </div>
      <div className="space-y-3">
        {current ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span dir="ltr" className="font-mono text-sm">{current}{dirty ? ' •' : ''}</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={!dirty || binary} onClick={save}><SaveIcon /> {t('Save', 'ذخیره')}</Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={remove}><Trash2Icon /></Button>
              </div>
            </div>
            {binary ? <p className="text-sm text-muted-foreground">{t('Binary or very large file: not editable here.', 'فایل باینری یا خیلی بزرگ: اینجا قابل ویرایش نیست.')}</p> : (
              <Textarea dir="ltr" spellCheck={false} className="h-96 font-mono text-xs" value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} />
            )}
          </>
        ) : <Empty>{t('Choose a file to edit.', 'یک فایل برای ویرایش انتخاب کنید.')}</Empty>}

        {project.has_build && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><HammerIcon className="size-4" /> {t('Build', 'ساخت (Build)')}</CardTitle>
              <CardDescription>{t('Runs npm install and npm run build on this computer (needs Node.js). Scripts in the project itself run, so only build projects you trust.', 'روی همین کامپیوتر npm install و npm run build را اجرا می‌کند (نیازمند Node.js). اسکریپت‌های خود پروژه اجرا می‌شوند؛ فقط پروژه‌های مورد اعتماد را بسازید.')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" disabled={job?.status === 'running'} onClick={build}><HammerIcon /> {job?.status === 'running' ? (job.step === 'install' ? t('Installing packages…', 'نصب بسته‌ها…') : t('Building…', 'در حال ساخت…')) : t('Build now', 'همین حالا بساز')}</Button>
              {job && job.status === 'ok' && <p className="text-sm text-green-600">{t(`Built: ${job.output?.files} files in ${job.output?.dir}/. Publish below.`, `ساخته شد: ${job.output?.files} فایل در ${job.output?.dir}/. پایین منتشر کنید.`)}</p>}
              {job && job.status === 'failed' && <p className="text-sm text-destructive">{job.error}</p>}
              {job && job.log && <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{job.log}</pre>}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><RocketIcon className="size-4" /> {t('Publish', 'انتشار')}</CardTitle>
            <CardDescription>{project.last_deploy ? t(`Last published to ${project.host}/${project.site} as ${project.last_release}.`, `آخرین انتشار روی ${project.host}/${project.site} با نسخه‌ی ${project.last_release}.`) : t('Not published yet.', 'هنوز منتشر نشده.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {hosts.length === 0 ? <p className="text-sm text-muted-foreground">{t('Connect a host first (Hosts page).', 'اول یک هاست وصل کنید (صفحه‌ی هاست‌ها).')}</p> : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('Host', 'هاست')}><Pick value={host} onChange={setHost} options={hosts.map((h) => ({ value: h, label: h }))} /></Field>
                <Field label={t('Folder on the host', 'پوشه روی هاست')} hint={project.site && project.host === host ? t('Already created; updates the same site.', 'ساخته شده؛ همان سایت به‌روز می‌شود.') : t('Empty = web root', 'خالی = ریشه‌ی وب')}><Input dir="ltr" value={folder} disabled={!!project.site && project.host === host} onChange={(e) => setFolder(e.target.value)} /></Field>
                <Field label={t('Note', 'یادداشت')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </div>
            )}
            {project.kind === 'node' && !(project.site && project.host === host) && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">{t('Node.js app: it runs from a folder outside the public web folder. On shared hosting (Passenger) register the app in your hosting panel, or let the agent write the Passenger settings into the public folder below.', 'برنامه‌ی Node.js از پوشه‌ای بیرون از پوشه‌ی عمومی اجرا می‌شود. روی هاست اشتراکی (Passenger) برنامه را در پنل هاست ثبت کنید یا بگذارید ایجنت تنظیمات Passenger را در پوشه‌ی عمومی پایین بنویسد.')}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t('App folder on the host', 'پوشه‌ی برنامه روی هاست')} hint={t('Absolute path inside your account, e.g. /home/you/nodeapps', 'مسیر مطلق داخل حساب شما، مثل /home/you/nodeapps')}><Input dir="ltr" value={nodeForm.app_root} onChange={(e) => setNodeForm({ ...nodeForm, app_root: e.target.value })} /></Field>
                  <Field label={t('Public folder (Passenger)', 'پوشه‌ی عمومی (Passenger)')} hint={t('Under the web root; empty = none', 'زیر ریشه‌ی وب؛ خالی = ندارد')}><Input dir="ltr" value={nodeForm.docroot} onChange={(e) => setNodeForm({ ...nodeForm, docroot: e.target.value })} /></Field>
                  <Field label={t('Check address after publish', 'نشانی آزمون بعد از انتشار')}><Input dir="ltr" placeholder="https://" value={nodeForm.check_url} onChange={(e) => setNodeForm({ ...nodeForm, check_url: e.target.value })} /></Field>
                </div>
                <Field label={t('Environment variables (KEY=value per line)', 'متغیرهای محیطی (هر خط KEY=value)')} hint={t('Stored on the host in a private file; never shown again.', 'روی هاست در فایل خصوصی ذخیره می‌شود؛ دوباره نمایش داده نمی‌شود.')}><Textarea dir="ltr" className="h-20 font-mono text-xs" value={nodeForm.env} onChange={(e) => setNodeForm({ ...nodeForm, env: e.target.value })} /></Field>
              </div>
            )}
            <Button disabled={busy || !host} onClick={deploy}><RocketIcon /> {busy ? t('Uploading…', 'در حال ارسال…') : t('Publish now', 'همین حالا منتشر کن')}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function Projects() {
  const { t, lang } = useI18n();
  const { data, refresh } = useStudio();
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'static', template: 'landing', title: '', rtl: lang === 'fa' });

  if (!data) return <Loading />;
  const project = data.projects.find((p) => p.name === selected);
  const tpl = data.templates.find((x) => x.id === form.template);

  const create = async (): Promise<void> => {
    const r = await api.post('projects/create', form);
    if (r.ok) {
      setCreating(false);
      setSelected(form.name.toLowerCase());
      await refresh();
    } else toast.error(r.error?.message ?? 'error');
  };

  return (
    <>
      <PageTitle title={t('Projects', 'پروژه‌ها')} hint={t('Websites you build here, as plain folders on your computer. Publish them to any connected host.', 'سایت‌هایی که اینجا می‌سازید، به‌شکل پوشه‌های ساده روی کامپیوتر شما. روی هر هاست وصل‌شده منتشرشان کنید.')}>
        <Button onClick={() => setCreating(true)}><FolderPlusIcon /> {t('New project', 'پروژه‌ی جدید')}</Button>
      </PageTitle>

      {data.projects.length === 0 ? <Empty>{t('No projects yet. Create one from a template.', 'هنوز پروژه‌ای نیست. یکی از روی قالب بسازید.')}</Empty> : (
        <div className="mb-4 flex flex-wrap gap-2">
          {data.projects.map((p) => (
            <Button key={p.name} variant={p.name === selected ? 'default' : 'outline'} size="sm" onClick={() => setSelected(p.name)}>
              {p.name} <span className="opacity-60">· {p.kind}{p.last_deploy ? ` · ${ago(p.last_deploy, lang)}` : ''}</span>
            </Button>
          ))}
        </div>
      )}

      {project && (
        <>
          <Workspace key={project.name} project={project} hosts={data.hosts.filter((h) => h.status !== 'error' || h.last_ok).map((h) => h.name)} onDeployed={refresh} />
          <div className="mt-6"><Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { if (confirm(t('Remove this project from the Studio? Choose OK to also delete its files.', 'این پروژه از Studio حذف شود؟ OK یعنی فایل‌هایش هم پاک شود.'))) { await api.post('projects/remove', { name: project.name, delete_files: true }); setSelected(''); await refresh(); } }}><Trash2Icon /> {t('Remove project', 'حذف پروژه')}</Button></div>
        </>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('New project', 'پروژه‌ی جدید')}</DialogTitle>
            <DialogDescription>{t('Plain HTML, or a framework project that is built on this computer and published as static files.', 'HTML ساده، یا پروژه‌ی فریم‌ورک که روی همین کامپیوتر ساخته و به‌صورت فایل ایستا منتشر می‌شود.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label={t('Name', 'نام')} hint="a-z 0-9 -"><Input dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('Title shown on the page', 'عنوان صفحه')}><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('Template', 'قالب')}><Pick value={form.template} onChange={(template) => setForm({ ...form, template })} options={data.templates.map((x) => ({ value: x.id, label: x.label + (x.build ? ' ⚙' : '') }))} /></Field>
              <Field label={t('Type', 'نوع')}>{tpl?.build ? <p className="pt-2 text-xs text-muted-foreground">{tpl.note}</p> : <Pick value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={[{ value: 'static', label: t('Static site', 'سایت ایستا') }, { value: 'spa', label: 'SPA (React/Vue/…)' }]} />}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.rtl} onChange={(e) => setForm({ ...form, rtl: e.target.checked })} /> {t('Right-to-left (Persian, Arabic)', 'راست‌به‌چپ (فارسی، عربی)')}</label>
          </div>
          <DialogFooter><Button disabled={!form.name} onClick={create}>{t('Create', 'بساز')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
