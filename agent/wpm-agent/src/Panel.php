<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Hosted panel: setup wizard, login, sites, deploys, connections, security. Server-rendered, no JavaScript needed. */
final class Panel
{
    /** English → Persian. Anything missing is shown in English. */
    private const FA = [
        'Setup' => 'نصب', 'Welcome' => 'خوش آمدید', 'Sign in' => 'ورود', 'Sign out' => 'خروج', 'Username' => 'نام کاربری', 'Password' => 'گذرواژه',
        'Repeat password' => 'تکرار گذرواژه', 'Setup code' => 'کد نصب', 'Create account' => 'ساخت حساب', 'Sites' => 'سایت‌ها', 'Create site' => 'ساخت سایت',
        'Name' => 'نام', 'Type' => 'نوع', 'Folder' => 'پوشه', 'Create' => 'بساز', 'Delete' => 'حذف', 'Deploy' => 'انتشار', 'Rollback' => 'بازگشت', 'Releases' => 'نسخه‌های منتشرشده',
        'Live' => 'فعال', 'Files' => 'فایل', 'Note' => 'یادداشت', 'Upload a zip of the built site' => 'زیپ سایت ساخته‌شده را بارگذاری کنید', 'Connect the Studio' => 'اتصال Studio',
        'Make a pairing code' => 'ساخت کد اتصال', 'Security' => 'امنیت', 'Host' => 'هاست', 'Audit log' => 'گزارش رویدادها', 'Change password' => 'تغییر گذرواژه',
        'Current password' => 'گذرواژه فعلی', 'New password' => 'گذرواژه جدید', 'Two-factor authentication' => 'تأیید دو مرحله‌ای', 'Enable' => 'فعال‌سازی', 'Disable' => 'غیرفعال‌سازی',
        'Code' => 'کد', 'Confirm' => 'تأیید', 'Back' => 'بازگشت', 'Revoke' => 'لغو', 'Connections' => 'اتصال‌ها', 'Never' => 'هرگز', 'Level' => 'سطح',
        'Static site (HTML/CSS/JS)' => 'سایت ایستا (HTML/CSS/JS)', 'Single-page app (React, Vue, Svelte, ...)' => 'اپ تک‌صفحه‌ای (React، Vue، Svelte و …)',
        'Requirements' => 'پیش‌نیازها', 'Ready' => 'آماده', 'Problem' => 'مشکل', 'Warning' => 'هشدار', 'Language' => 'زبان',
        'I understand this connection is not encrypted and I accept the risk' => 'می‌دانم این اتصال رمزنگاری نشده و ریسک آن را می‌پذیرم',
        'Wrong username or password.' => 'نام کاربری یا گذرواژه اشتباه است.', 'Too many attempts. Try again in %d minutes.' => 'تلاش‌های زیاد. %d دقیقه دیگر دوباره امتحان کنید.',
        'The setup code is wrong.' => 'کد نصب درست نیست.', 'Passwords do not match.' => 'گذرواژه‌ها یکسان نیستند.', 'Use at least 10 characters and avoid common passwords.' => 'حداقل ۱۰ نویسه و نه گذرواژه‌ی رایج.',
        'Username: 3-32 letters, digits, dot, dash or underscore.' => 'نام کاربری: ۳ تا ۳۲ حرف انگلیسی، رقم، نقطه، خط تیره یا زیرخط.',
        'This page is not secure (HTTP). Open it over HTTPS, or tick the box below if you accept the risk.' => 'این صفحه ایمن نیست (HTTP). با HTTPS باز کنید یا اگر ریسک را می‌پذیرید کادر زیر را تیک بزنید.',
        'Where is the setup code?' => 'کد نصب کجاست؟', 'If you downloaded the agent from the Studio, the code is shown there. Otherwise open this file in your host file manager:' => 'اگر ایجنت را از Studio گرفته‌اید کد همان‌جا نمایش داده می‌شود؛ وگرنه این فایل را در فایل‌منیجر هاست باز کنید:',
        'Saved.' => 'ذخیره شد.', 'Site created.' => 'سایت ساخته شد.', 'Deployed.' => 'منتشر شد.', 'Rolled back.' => 'به نسخه قبل برگشت.', 'Pairing code (valid 10 minutes). Enter it in the Studio together with this address:' => 'کد اتصال (۱۰ دقیقه معتبر). آن را همراه با این نشانی در Studio وارد کنید:',
        'Scan or type this key in your authenticator app, then enter the 6-digit code:' => 'این کلید را در برنامه‌ی احراز هویت وارد کنید، سپس کد ۶ رقمی را بزنید:', 'Two-factor code' => 'کد دو مرحله‌ای',
        'Wrong code.' => 'کد اشتباه است.', 'Choose a zip file.' => 'یک فایل زیپ انتخاب کنید.', 'Created' => 'ساخته شد', 'Last used' => 'آخرین استفاده', 'Time' => 'زمان', 'Who' => 'چه کسی', 'What' => 'چه چیزی',
        'Site type' => 'نوع سایت', 'Mode' => 'روش', 'Public URL (optional)' => 'نشانی عمومی (اختیاری)', 'Empty = web root' => 'خالی = ریشه وب', 'Also delete the files from the host' => 'فایل‌ها را هم از هاست پاک کن',
        'No releases yet.' => 'هنوز نسخه‌ای منتشر نشده.', 'No sites yet. Create the first one.' => 'هنوز سایتی نیست. اولین را بسازید.', 'Open site' => 'باز کردن سایت', 'Studio connected sites can also be created from the Studio.' => 'سایت را از خود Studio هم می‌توان ساخت.',
        'Setup finished. Enable two-factor authentication on the Security page.' => 'نصب تمام شد. تأیید دو مرحله‌ای را در صفحه‌ی امنیت فعال کنید.', 'Session expired. Sign in again.' => 'نشست منقضی شد. دوباره وارد شوید.',
        'Read only' => 'فقط خواندن', 'Read and deploy' => 'خواندن و انتشار', 'Full control (create sites)' => 'کنترل کامل (ساخت سایت)',
    ];

    private string $lang = 'en';

    public function __construct(private Agent $agent, private Auth $auth, private Sites $sites)
    {
    }

    private function t(string $en, string ...$args): string
    {
        $s = $this->lang === 'fa' ? (self::FA[$en] ?? $en) : $en;

        return $args ? vsprintf($s, $args) : $s;
    }

    private function e(string $s): string
    {
        return Util::h($s);
    }

    public function handle(Request $req): Response
    {
        $this->lang = $this->pickLang($req);
        $route = $req->route;
        $res = null;
        try {
            if (!$this->agent->installed()) {
                $res = $route === '/setup' ? $this->setup($req) : Response::redirect($this->url($req, '/setup'));
            } else {
                $res = $this->routed($req, $route);
            }
        } catch (ApiError $e) {
            $res = Response::html($this->layout($req, 'Error', '<div class="msg bad">' . $this->e($e->getMessage()) . '</div>', null), $e->status);
        }
        if (isset($req->query['lang']) && in_array($req->query['lang'], ['fa', 'en'], true)) {
            $res->cookies[] = $this->auth->cookieHeader($req, 'wpm_lang', $req->query['lang'], 31536000);
        }

        return $res;
    }

    private function pickLang(Request $req): string
    {
        $q = $req->query['lang'] ?? ($req->cookies['wpm_lang'] ?? '');
        if ($q === 'fa' || $q === 'en') {
            return $q;
        }

        return stripos($req->header('accept-language'), 'fa') === 0 ? 'fa' : 'en';
    }

    private function routed(Request $req, string $route): Response
    {
        $isPost = $req->method === 'POST';
        if ($route === '/login') {
            return $this->login($req);
        }
        $session = $this->auth->session($req);
        if (!$session) {
            return Response::redirect($this->url($req, '/login'));
        }
        if ($isPost && !$this->auth->csrfOk($req, $session)) {
            return Response::html($this->layout($req, 'Error', '<div class="msg bad">' . $this->e($this->t('Session expired. Sign in again.')) . '</div>', null), 403);
        }

        return match ($route) {
            '/' => $this->dashboard($req, $session, ''),
            '/logout' => $this->logout($req),
            '/sites/create' => $this->createSite($req, $session),
            '/site' => $this->site($req, $session, ''),
            '/site/deploy' => $this->deploy($req, $session),
            '/site/rollback' => $this->rollback($req, $session),
            '/site/delete' => $this->deleteSite($req, $session),
            '/connect' => $this->connect($req, $session),
            '/security' => $this->security($req, $session, ''),
            '/security/password' => $this->password($req, $session),
            '/security/2fa-start' => $this->totpStart($req, $session),
            '/security/2fa-confirm' => $this->totpConfirm($req, $session),
            '/security/2fa-off' => $this->totpOff($req, $session),
            '/security/revoke' => $this->revoke($req, $session),
            '/host' => $this->host($req, $session),
            default => Response::redirect($this->url($req, '/')),
        };
    }

    private function url(Request $req, string $route, array $q = []): string
    {
        $script = $req->server['SCRIPT_NAME'] ?? '/index.php';

        return $script . '?r=' . rawurlencode($route) . ($q ? '&' . http_build_query($q) : '');
    }

    // ---- layout -------------------------------------------------------------------------------------------------

    private function layout(Request $req, string $title, string $body, ?array $session): string
    {
        $rtl = $this->lang === 'fa';
        $nav = '';
        if ($session) {
            $nav = '<nav><a href="' . $this->url($req, '/') . '">' . $this->e($this->t('Sites')) . '</a><a href="' . $this->url($req, '/host') . '">' . $this->e($this->t('Host')) . '</a><a href="' . $this->url($req, '/security') . '">' . $this->e($this->t('Security')) . '</a>'
                . '<form method="post" action="' . $this->url($req, '/logout') . '"><input type="hidden" name="csrf" value="' . $this->e($session['csrf']) . '"><button class="link">' . $this->e($this->t('Sign out')) . '</button></form></nav>';
        }
        $other = $rtl ? 'en' : 'fa';
        $css = 'body{font:15px/1.6 system-ui,Segoe UI,Tahoma,sans-serif;margin:0;background:#f6f7f9;color:#1b1f24}main{max-width:880px;margin:0 auto;padding:20px}header{background:#111827;color:#fff}header div{max-width:880px;margin:0 auto;padding:12px 20px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}header a{color:#cbd5e1;text-decoration:none;margin-inline-end:14px}nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:16px;margin:14px 0}h1{font-size:20px}h2{font-size:16px;margin:0 0 10px}label{display:block;margin:10px 0 4px;font-weight:600}input,select{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9ced6;border-radius:8px;font:inherit}input[type=checkbox]{width:auto}button{padding:9px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:inherit;cursor:pointer;margin-top:12px}button.danger{background:#dc2626}button.link{background:none;color:#cbd5e1;padding:0;margin:0}table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid #eceef1;text-align:start;vertical-align:top}.msg{padding:10px 12px;border-radius:8px;margin:10px 0}.ok{background:#e8f6ec;color:#14532d}.bad{background:#fdecec;color:#7f1d1d}.warn{background:#fff6e0;color:#7a4b00}code{background:#eef0f3;padding:2px 6px;border-radius:5px;direction:ltr;unicode-bidi:embed;word-break:break-all}.big{font-size:20px;letter-spacing:1px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}';

        return '<!doctype html><html lang="' . $this->lang . '" dir="' . ($rtl ? 'rtl' : 'ltr') . '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' . $this->e($title) . ' · WPM Host Agent</title><style>' . $css . '</style></head><body><header><div><strong>WPM Host Agent</strong>' . $nav . '<a href="' . $this->url($req, $req->route, ['lang' => $other] + array_diff_key($req->query, ['r' => 1, 'lang' => 1])) . '">' . ($rtl ? 'English' : 'فارسی') . '</a></div></header><main>' . $body . '</main></body></html>';
    }

    private function field(string $label, string $name, string $type = 'text', string $value = '', string $extra = ''): string
    {
        return '<label>' . $this->e($this->t($label)) . '</label><input type="' . $type . '" name="' . $name . '" value="' . $this->e($value) . '" ' . $extra . '>';
    }

    private function form(Request $req, array $session, string $route, string $inner, string $button, bool $danger = false, string $enctype = ''): string
    {
        return '<form method="post" action="' . $this->url($req, $route) . '"' . ($enctype ? ' enctype="' . $enctype . '"' : '') . '><input type="hidden" name="csrf" value="' . $this->e($session['csrf']) . '">' . $inner . '<button' . ($danger ? ' class="danger"' : '') . '>' . $this->e($this->t($button)) . '</button></form>';
    }

    private function msg(string $text, string $kind = 'ok'): string
    {
        return $text === '' ? '' : '<div class="msg ' . $kind . '">' . $text . '</div>';
    }

    private function when(int $ts): string
    {
        return $ts > 0 ? gmdate('Y-m-d H:i', $ts) . ' UTC' : $this->t('Never');
    }

    // ---- setup & login ------------------------------------------------------------------------------------------

    private function setup(Request $req): Response
    {
        $error = '';
        if ($req->method === 'POST') {
            $err = $this->auth->install($req, $req->post('username'), $req->post('password'), $req->post('confirm'), $req->post('setup_code'), $req->post('allow_http') === '1');
            if ($err === null) {
                $login = $this->auth->login($req, $req->post('username'), $req->post('password'));
                $res = Response::redirect($this->url($req, '/', ['welcome' => '1']));
                if ($login['cookie']) {
                    $res->cookies[] = $login['cookie'];
                }
                return $res;
            }
            $error = match ($err) {
                'bad_setup_code' => $this->t('The setup code is wrong.'),
                'password_mismatch' => $this->t('Passwords do not match.'),
                'weak_password' => $this->t('Use at least 10 characters and avoid common passwords.'),
                'bad_username' => $this->t('Username: 3-32 letters, digits, dot, dash or underscore.'),
                'https_required' => $this->t('This page is not secure (HTTP). Open it over HTTPS, or tick the box below if you accept the risk.'),
                'locked' => $this->t('Too many attempts. Try again in %d minutes.', 15),
                default => $err,
            };
        }
        $caps = $this->agent->caps();
        $reqs = '';
        $blocked = false;
        foreach (Caps::requirements($caps, $req->isSecure(), $req->isLoopback()) as $r) {
            $blocked = $blocked || (!$r['ok'] && $r['blocker']);
            $reqs .= '<tr><td>' . ($r['ok'] ? '✓' : ($r['blocker'] ? '✗' : '!')) . '</td><td>' . $this->e($r['msg']) . '</td></tr>';
        }
        $insecure = !$req->isSecure() && !$req->isLoopback();
        $body = '<h1>' . $this->e($this->t('Welcome')) . ' · ' . $this->e($this->t('Setup')) . '</h1>'
            . '<div class="card"><h2>' . $this->e($this->t('Requirements')) . '</h2><table>' . $reqs . '</table></div>'
            . ($blocked ? $this->msg($this->e($this->t('Problem')) . ': PHP', 'bad') : '')
            . $this->msg($this->e($error), 'bad')
            . '<div class="card"><form method="post" action="' . $this->url($req, '/setup') . '">'
            . $this->field('Setup code', 'setup_code', 'text', '', 'autocomplete="off" required style="direction:ltr"')
            . '<p class="warn msg"><b>' . $this->e($this->t('Where is the setup code?')) . '</b><br>' . $this->e($this->t('If you downloaded the agent from the Studio, the code is shown there. Otherwise open this file in your host file manager:')) . '<br><code>' . $this->e($this->auth->setupTokenPath()) . '</code></p>'
            . $this->field('Username', 'username', 'text', '', 'autocomplete="username" required style="direction:ltr"')
            . $this->field('Password', 'password', 'password', '', 'autocomplete="new-password" required minlength="10"')
            . $this->field('Repeat password', 'confirm', 'password', '', 'autocomplete="new-password" required minlength="10"')
            . ($insecure ? '<label><input type="checkbox" name="allow_http" value="1"> ' . $this->e($this->t('I understand this connection is not encrypted and I accept the risk')) . '</label>' : '')
            . '<button' . ($blocked ? ' disabled' : '') . '>' . $this->e($this->t('Create account')) . '</button></form></div>';

        return Response::html($this->layout($req, 'Setup', $body, null));
    }

    private function login(Request $req): Response
    {
        $error = '';
        $stage = null;
        if ($req->method === 'POST') {
            if ($req->post('code') !== '' && $req->post('username') === '') {
                $err = $this->auth->verifyTotp($req, $req->post('code'));
                if ($err === null) {
                    return Response::redirect($this->url($req, '/'));
                }
                $stage = 'totp';
                $error = $err === 'locked' ? $this->t('Too many attempts. Try again in %d minutes.', 15) : $this->t('Wrong code.');
            } else {
                $r = $this->auth->login($req, $req->post('username'), $req->post('password'));
                if ($r['error'] === null) {
                    $res = $r['stage'] === 'ok' ? Response::redirect($this->url($req, '/')) : Response::redirect($this->url($req, '/login'));
                    $res->cookies[] = $r['cookie'];
                    return $res;
                }
                $error = $r['error'] === 'locked' ? $this->t('Too many attempts. Try again in %d minutes.', (int) ceil($r['wait'] / 60)) : $this->t('Wrong username or password.');
            }
        }
        $partial = $this->auth->session($req, true);
        if ($stage === null && $partial && $partial['stage'] === 'totp') {
            $stage = 'totp';
        }
        if ($stage === null && $this->auth->session($req)) {
            return Response::redirect($this->url($req, '/'));
        }
        $inner = $stage === 'totp'
            ? $this->field('Two-factor code', 'code', 'text', '', 'inputmode="numeric" autocomplete="one-time-code" required autofocus style="direction:ltr"')
            : $this->field('Username', 'username', 'text', '', 'autocomplete="username" required autofocus style="direction:ltr"') . $this->field('Password', 'password', 'password', '', 'autocomplete="current-password" required');
        $body = '<h1>' . $this->e($this->t('Sign in')) . '</h1>' . $this->msg($this->e($error), 'bad') . '<div class="card"><form method="post" action="' . $this->url($req, '/login') . '">' . $inner . '<button>' . $this->e($this->t('Sign in')) . '</button></form></div>';

        return Response::html($this->layout($req, 'Sign in', $body, null));
    }

    private function logout(Request $req): Response
    {
        $res = Response::redirect($this->url($req, '/login'));
        $res->cookies[] = $this->auth->logout($req);

        return $res;
    }

    // ---- dashboard & sites --------------------------------------------------------------------------------------

    private function dashboard(Request $req, array $session, string $flash, string $flashKind = 'ok'): Response
    {
        $sites = $this->sites->all();
        $rows = '';
        foreach ($sites as $s) {
            $v = $this->sites->view($s);
            $rows .= '<tr><td><a href="' . $this->url($req, '/site', ['id' => $s['id']]) . '">' . $this->e($s['name']) . '</a></td><td>' . $this->e($this->t(Sites::KINDS[$s['kind']] ?? $s['kind'])) . '</td><td><code>' . $this->e($s['folder'] === '' ? '/' : $s['folder']) . '</code></td><td>' . $this->e((string) ($v['current'] ?? '—')) . '</td></tr>';
        }
        $roots = $this->agent->roots();
        $kinds = '';
        foreach (Sites::KINDS as $k => $label) {
            $kinds .= '<option value="' . $k . '">' . $this->e($this->t($label)) . '</option>';
        }
        $welcome = isset($req->query['welcome']) ? $this->msg($this->e($this->t('Setup finished. Enable two-factor authentication on the Security page.'))) : '';
        $body = $welcome . $this->msg($flash, $flashKind) . '<h1>' . $this->e($this->t('Sites')) . '</h1>'
            . '<div class="card">' . ($rows ? '<table><tr><th>' . $this->e($this->t('Name')) . '</th><th>' . $this->e($this->t('Type')) . '</th><th>' . $this->e($this->t('Folder')) . '</th><th>' . $this->e($this->t('Live')) . '</th></tr>' . $rows . '</table>' : '<p>' . $this->e($this->t('No sites yet. Create the first one.')) . '</p>') . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Create site')) . '</h2>' . $this->form($req, $session, '/sites/create',
                '<div class="row"><div>' . $this->field('Name', 'name', 'text', '', 'required') . '</div><div><label>' . $this->e($this->t('Site type')) . '</label><select name="kind">' . $kinds . '</select></div></div>'
                . '<div class="row"><div>' . $this->field('Folder', 'folder', 'text', '', 'placeholder="' . $this->e($this->t('Empty = web root')) . '" style="direction:ltr"') . '</div><div>' . $this->field('Public URL (optional)', 'url', 'text', '', 'style="direction:ltr"') . '</div></div>'
                . '<small>' . $this->e(implode(' · ', $roots)) . '</small>', 'Create') . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Connect the Studio')) . '</h2>' . $this->form($req, $session, '/connect',
                '<label>' . $this->e($this->t('Level')) . '</label><select name="level"><option value="admin">' . $this->e($this->t('Full control (create sites)')) . '</option><option value="deploy">' . $this->e($this->t('Read and deploy')) . '</option><option value="read">' . $this->e($this->t('Read only')) . '</option></select>', 'Make a pairing code') . '</div>';

        return Response::html($this->layout($req, 'Sites', $body, $session));
    }

    private function createSite(Request $req, array $session): Response
    {
        try {
            $site = $this->sites->create(['name' => $req->post('name'), 'kind' => $req->post('kind'), 'folder' => $req->post('folder'), 'url' => $req->post('url')], (string) $session['user']);
        } catch (ApiError $e) {
            return $this->dashboard($req, $session, $this->e($e->getMessage()), 'bad');
        }

        return Response::redirect($this->url($req, '/site', ['id' => $site['id'], 'created' => '1']));
    }

    private function site(Request $req, array $session, string $flash, string $kind = 'ok'): Response
    {
        $id = $req->query['id'] ?? $req->post('id');
        $site = $this->sites->get($id);
        $info = $this->sites->releases($id);
        $rows = '';
        foreach ($info['releases'] as $r) {
            $live = $r['id'] === $info['current'];
            $rows .= '<tr><td><code>' . $this->e($r['id']) . '</code>' . ($live ? ' ✓' : '') . '</td><td>' . $this->e($this->when((int) $r['created'])) . '</td><td>' . (int) $r['files'] . '</td><td>' . $this->e($r['note']) . '</td><td>'
                . ($live ? '' : $this->form($req, $session, '/site/rollback', '<input type="hidden" name="id" value="' . $this->e($id) . '"><input type="hidden" name="release" value="' . $this->e($r['id']) . '">', 'Rollback')) . '</td></tr>';
        }
        $created = isset($req->query['created']) ? $this->msg($this->e($this->t('Site created.'))) : '';
        $body = $created . $this->msg($flash, $kind) . '<p><a href="' . $this->url($req, '/') . '">← ' . $this->e($this->t('Back')) . '</a></p><h1>' . $this->e($site['name']) . '</h1>'
            . '<p><code>' . $this->e($site['target']) . '</code> · ' . $this->e($site['mode']) . ' · ' . $this->e($this->t(Sites::KINDS[$site['kind']] ?? $site['kind'])) . ($site['url'] !== '' ? ' · <a href="' . $this->e($site['url']) . '" rel="noopener noreferrer">' . $this->e($this->t('Open site')) . '</a>' : '') . '</p>'
            . '<div class="card"><h2>' . $this->e($this->t('Deploy')) . '</h2>' . $this->form($req, $session, '/site/deploy',
                '<input type="hidden" name="id" value="' . $this->e($id) . '"><label>' . $this->e($this->t('Upload a zip of the built site')) . '</label><input type="file" name="zip" accept=".zip" required>' . $this->field('Note', 'note'), 'Deploy', false, 'multipart/form-data') . '<small>max ' . (int) (Util::bytes((string) ini_get('upload_max_filesize')) / 1048576) . ' MB · ' . $this->e($this->t('Studio connected sites can also be created from the Studio.')) . '</small></div>'
            . '<div class="card"><h2>' . $this->e($this->t('Releases')) . '</h2>' . ($rows ? '<table><tr><th>ID</th><th>' . $this->e($this->t('Time')) . '</th><th>' . $this->e($this->t('Files')) . '</th><th>' . $this->e($this->t('Note')) . '</th><th></th></tr>' . $rows . '</table>' : '<p>' . $this->e($this->t('No releases yet.')) . '</p>') . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Delete')) . '</h2>' . $this->form($req, $session, '/site/delete', '<input type="hidden" name="id" value="' . $this->e($id) . '"><label><input type="checkbox" name="purge" value="1"> ' . $this->e($this->t('Also delete the files from the host')) . '</label>', 'Delete', true) . '</div>';

        return Response::html($this->layout($req, $site['name'], $body, $session));
    }

    private function deploy(Request $req, array $session): Response
    {
        $id = $req->post('id');
        $file = $req->files['zip'] ?? null;
        try {
            if (!$file || ($file['error'] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $file['tmp_name'])) {
                throw new ApiError('no_file', $this->t('Choose a zip file.'));
            }
            $uid = $this->sites->uploadFromFile((string) $file['tmp_name'], 'panel');
            $this->sites->deploy($id, $uid, $req->post('note'), (string) $session['user'], 'panel');
        } catch (ApiError $e) {
            return $this->site($req->withQuery(['id' => $id]), $session, $this->e($e->getMessage()), 'bad');
        }

        return $this->site($req->withQuery(['id' => $id]), $session, $this->e($this->t('Deployed.')));
    }

    private function rollback(Request $req, array $session): Response
    {
        $id = $req->post('id');
        try {
            $this->sites->rollback($id, $req->post('release') ?: null, (string) $session['user']);
        } catch (ApiError $e) {
            return $this->site($req->withQuery(['id' => $id]), $session, $this->e($e->getMessage()), 'bad');
        }

        return $this->site($req->withQuery(['id' => $id]), $session, $this->e($this->t('Rolled back.')));
    }

    private function deleteSite(Request $req, array $session): Response
    {
        try {
            $this->sites->delete($req->post('id'), $req->post('purge') === '1', (string) $session['user']);
        } catch (ApiError $e) {
            return $this->dashboard($req, $session, $this->e($e->getMessage()), 'bad');
        }

        return Response::redirect($this->url($req, '/'));
    }

    private function connect(Request $req, array $session): Response
    {
        $p = $this->auth->createPairing($req->post('level', 'admin'), (string) $session['user']);
        $scheme = $req->isSecure() ? 'https' : 'http';
        $base = $scheme . '://' . $req->host() . rtrim(str_replace('\\', '/', dirname($req->server['SCRIPT_NAME'] ?? '/index.php')), '/') . '/';
        $html = $this->e($this->t('Pairing code (valid 10 minutes). Enter it in the Studio together with this address:')) . '<br><br><code class="big">' . $this->e($p['code']) . '</code><br><br><code>' . $this->e($base) . '</code>';

        return $this->dashboard($req, $session, $html);
    }

    // ---- host & security ----------------------------------------------------------------------------------------

    private function host(Request $req, array $session): Response
    {
        $caps = $this->agent->caps();
        $flat = static function (array $a, string $p = '') use (&$flat): array {
            $out = [];
            foreach ($a as $k => $v) {
                is_array($v) ? $out += $flat($v, $p . $k . '.') : $out[$p . $k] = is_bool($v) ? ($v ? 'yes' : 'no') : (string) $v;
            }
            return $out;
        };
        $rows = '';
        foreach ($flat($caps) as $k => $v) {
            $rows .= '<tr><td><code>' . $this->e($k) . '</code></td><td>' . $this->e($v) . '</td></tr>';
        }
        $body = '<h1>' . $this->e($this->t('Host')) . '</h1><div class="card"><table>' . $rows . '</table></div>';

        return Response::html($this->layout($req, 'Host', $body, $session));
    }

    private function security(Request $req, array $session, string $flash, string $kind = 'ok', string $extra = ''): Response
    {
        $admin = $this->agent->config()['admin'];
        $conns = '';
        foreach ($this->auth->connections() as $c) {
            $conns .= '<tr><td>' . $this->e($c['name']) . ' <code>' . $this->e($c['key_id']) . '</code></td><td>' . $this->e($c['level']) . '</td><td>' . $this->e($this->when((int) $c['last_used'])) . '</td><td>'
                . ($c['revoked'] ? '—' : $this->form($req, $session, '/security/revoke', '<input type="hidden" name="key" value="' . $this->e($c['key_id']) . '">', 'Revoke', true)) . '</td></tr>';
        }
        $log = '';
        foreach ($this->agent->store->tail('audit', 40) as $a) {
            $log .= '<tr><td>' . $this->e($this->when((int) $a['ts'])) . '</td><td>' . $this->e((string) $a['actor']) . '</td><td>' . $this->e((string) $a['action']) . '</td><td>' . $this->e((string) $a['detail']) . '</td></tr>';
        }
        $totp = !empty($admin['totp'])
            ? $this->form($req, $session, '/security/2fa-off', '', 'Disable', true)
            : $this->form($req, $session, '/security/2fa-start', '', 'Enable');
        $body = $this->msg($flash, $kind) . '<h1>' . $this->e($this->t('Security')) . '</h1>' . $extra
            . '<div class="card"><h2>' . $this->e($this->t('Two-factor authentication')) . '</h2>' . $totp . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Change password')) . '</h2>' . $this->form($req, $session, '/security/password', $this->field('Current password', 'current', 'password', '', 'autocomplete="current-password" required') . $this->field('New password', 'password', 'password', '', 'autocomplete="new-password" required minlength="10"') . $this->field('Repeat password', 'confirm', 'password', '', 'autocomplete="new-password" required minlength="10"'), 'Change password') . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Connections')) . '</h2>' . ($conns ? '<table><tr><th>' . $this->e($this->t('Name')) . '</th><th>' . $this->e($this->t('Level')) . '</th><th>' . $this->e($this->t('Last used')) . '</th><th></th></tr>' . $conns . '</table>' : '<p>—</p>') . '</div>'
            . '<div class="card"><h2>' . $this->e($this->t('Audit log')) . '</h2><table><tr><th>' . $this->e($this->t('Time')) . '</th><th>' . $this->e($this->t('Who')) . '</th><th>' . $this->e($this->t('What')) . '</th><th></th></tr>' . $log . '</table></div>';

        return Response::html($this->layout($req, 'Security', $body, $session));
    }

    private function password(Request $req, array $session): Response
    {
        $err = $this->auth->changePassword((string) $session['user'], $req->post('current'), $req->post('password'), $req->post('confirm'));
        if ($err === null) {
            return Response::redirect($this->url($req, '/login'));
        }
        $m = match ($err) {
            'bad_login' => $this->t('Wrong username or password.'),
            'password_mismatch' => $this->t('Passwords do not match.'),
            default => $this->t('Use at least 10 characters and avoid common passwords.'),
        };

        return $this->security($req, $session, $this->e($m), 'bad');
    }

    private function totpStart(Request $req, array $session): Response
    {
        $secret = $this->auth->totpBegin();
        $uri = Security::totpUri($secret, (string) $session['user']);
        $extra = '<div class="card"><h2>' . $this->e($this->t('Two-factor authentication')) . '</h2><p>' . $this->e($this->t('Scan or type this key in your authenticator app, then enter the 6-digit code:')) . '</p><p><code class="big">' . $this->e(trim(chunk_split($secret, 4, ' '))) . '</code></p><p><small><code>' . $this->e($uri) . '</code></small></p>'
            . $this->form($req, $session, '/security/2fa-confirm', $this->field('Code', 'code', 'text', '', 'inputmode="numeric" autocomplete="one-time-code" required style="direction:ltr"'), 'Confirm') . '</div>';

        return $this->security($req, $session, '', 'ok', $extra);
    }

    private function totpConfirm(Request $req, array $session): Response
    {
        return $this->auth->totpConfirm((string) $session['user'], $req->post('code'))
            ? $this->security($req, $session, $this->e($this->t('Saved.')))
            : $this->security($req, $session, $this->e($this->t('Wrong code.')), 'bad');
    }

    private function totpOff(Request $req, array $session): Response
    {
        $this->auth->totpDisable((string) $session['user']);

        return $this->security($req, $session, $this->e($this->t('Saved.')));
    }

    private function revoke(Request $req, array $session): Response
    {
        $this->auth->revoke($req->post('key'), (string) $session['user']);

        return $this->security($req, $session, $this->e($this->t('Saved.')));
    }
}
