<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Site records, uploads, deploys, atomic switch and rollback. */
final class Sites
{
    public const KINDS = ['static' => 'Static site (HTML/CSS/JS)', 'spa' => 'Single-page app (React, Vue, Svelte, ...)', 'node' => 'Node.js app', 'wordpress' => 'WordPress'];
    /** Kinds published as releases (WordPress is a live install instead). */
    public const DEPLOYABLE = ['static', 'spa', 'node'];
    private const BLOCKED_EXT = '/\.(php\d?|phtml|pht|phps|phar|cgi|pl|py|sh|bash|asp|aspx|jsp|exe|dll)$/i';
    private const BLOCKED_NAME = '/^(\.htaccess|\.htpasswd|\.user\.ini|web\.config|\.env.*|php\.ini)$/i';

    public function __construct(private Agent $agent)
    {
    }

    /** @return array<string,array<string,mixed>> */
    public function all(): array
    {
        return $this->agent->store->read('sites');
    }

    public function get(string $id): array
    {
        $site = $this->all()[$id] ?? null;
        if (!$site) {
            throw new ApiError('no_site', 'Unknown site.', 404);
        }
        return $site;
    }

    /** Public view: no secrets live in site records, but internal folders are summarised. */
    public function view(array $site): array
    {
        $rel = $this->agent->store->read('rel-' . $site['id']);

        return [
            'id' => $site['id'], 'name' => $site['name'], 'kind' => $site['kind'], 'mode' => $site['mode'], 'folder' => $site['folder'], 'url' => $site['url'] ?? '',
            'current' => $rel['current'] ?? null, 'releases' => count($rel['releases'] ?? []), 'created' => $site['created'],
        ] + (isset($site['node']) ? ['node' => $site['node'] + ['env_keys' => array_keys($this->agent->store->read('env-' . $site['id']))], 'warnings' => $site['warnings'] ?? []] : []);
    }

    /** @param array<string,mixed> $in name, kind, root (optional index or path), folder, mode, url */
    public function create(array $in, string $actor): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $id = Util::slug((string) ($in['id'] ?? $name));
        if ($id === '' || $name === '') {
            throw new ApiError('bad_name', 'Give the site a name.');
        }
        $kind = (string) ($in['kind'] ?? 'static');
        if (!isset(self::KINDS[$kind])) {
            throw new ApiError('bad_kind', 'Unsupported site type "' . $kind . '". Supported now: ' . implode(', ', array_keys(self::KINDS)) . '.');
        }
        $roots = $this->agent->roots();
        $root = (string) ($in['root'] ?? $roots[0]);
        $root = ctype_digit($root) && isset($roots[(int) $root]) ? $roots[(int) $root] : Fs::norm($root);
        if (!in_array($root, $roots, true)) {
            throw new ApiError('bad_root', 'That folder is not an allowed site location.');
        }
        $folderIn = rtrim(trim((string) ($in['folder'] ?? '')), '/');
        $folder = $folderIn === '' ? '' : Fs::cleanRel($folderIn);
        if ($folder === null) {
            throw new ApiError('bad_folder', 'The folder name is not valid.');
        }
        $target = $folder === '' ? $root : $root . '/' . $folder;
        if (!Fs::within($root, $target)) {
            throw new ApiError('bad_folder', 'The folder leaves the allowed location.');
        }
        foreach ([$this->agent->agentDir, $this->agent->dataDir] as $protected) {
            if (Fs::within($protected, $target)) {
                throw new ApiError('bad_folder', 'A site cannot live inside the agent folders.');
            }
        }

        $mode = $kind === 'wordpress' ? 'sync' : $this->chooseMode((string) ($in['mode'] ?? 'auto'), $target, $root);
        $extra = $kind === 'node' ? $this->nodeSettings($in, $root, $target) : [];
        $site = ['id' => $id, 'name' => $name, 'kind' => $kind, 'root' => $root, 'folder' => $folder, 'target' => $target, 'mode' => $mode, 'url' => substr((string) ($in['url'] ?? ''), 0, 200), 'created' => Util::now()] + $extra;

        $this->agent->store->update('sites', function (array $all, &$out) use ($site, $id) {
            if (isset($all[$id])) {
                throw new ApiError('exists', 'A site with this id already exists.', 409);
            }
            foreach ($all as $other) {
                if ($this->overlaps($site, $other)) {
                    throw new ApiError('overlap', 'This location overlaps the site "' . $other['name'] . '".', 409);
                }
            }
            $all[$id] = $site;
            $out = $site;
            return $all;
        });
        $this->agent->audit($actor, 'site.create', $id . ' (' . $kind . ', ' . $mode . ') -> ' . $target);

        return $site;
    }

    /** @return array<string,mixed> */
    private function nodeSettings(array $in, string $root, string $target): array
    {
        $startup = Fs::cleanRel((string) ($in['startup'] ?? 'server.js'));
        if ($startup === null || !preg_match('#^[A-Za-z0-9._/-]+\.(c|m)?js$#', $startup)) {
            throw new ApiError('bad_startup', 'The startup file must be a .js, .mjs or .cjs path such as server.js.');
        }
        $port = (int) ($in['port'] ?? random_int(20000, 29999));
        if ($port < 1024 || $port > 65535) {
            throw new ApiError('bad_port', 'The port must be between 1024 and 65535.');
        }
        $docroot = null;
        if (!empty($in['docroot'])) {
            $rel = Fs::cleanRel((string) $in['docroot']);
            $docroot = $rel === null ? null : Fs::norm($this->agent->docRoot) . '/' . $rel;
            if ($docroot === null || !Fs::within($this->agent->docRoot, $docroot) || Fs::within($this->agent->agentDir, $docroot) || Fs::within($this->agent->dataDir, $docroot)) {
                throw new ApiError('bad_docroot', 'The public folder is not valid.');
            }
        }
        $warnings = [];
        if (Fs::within($this->agent->docRoot, $target)) {
            $warnings[] = 'The app folder is inside the web root, so its source files can be downloaded if the Node app is not running. Prefer a folder outside public_html.';
        }

        return ['node' => ['startup' => $startup, 'port' => $port, 'docroot' => $docroot], 'warnings' => $warnings];
    }

    private function chooseMode(string $want, string $target, string $root): string
    {
        $canLink = Caps::detect($this->agent->dataDir, $this->agent->agentDir, $this->agent->docRoot)['symlink_works'];
        $linkable = $canLink && Fs::norm($target) !== Fs::norm($root) && (!file_exists($target) || is_link($target) || Fs::isEmptyDir($target));
        if ($want === 'symlink') {
            if (!$linkable) {
                throw new ApiError('mode_unavailable', 'Symlink mode needs symlink support and an empty or missing folder that is not the web root. Use sync mode.');
            }
            return 'symlink';
        }
        if ($want === 'sync') {
            return 'sync';
        }
        return $linkable ? 'symlink' : 'sync';
    }

    private function overlaps(array $a, array $b): bool
    {
        $x = rtrim(str_replace('\\', '/', $a['target']), '/');
        $y = rtrim(str_replace('\\', '/', $b['target']), '/');
        if ($x === $y) {
            return true;
        }
        // Folders inside one another are fine in sync mode (each site only touches files it owns); never with symlinks.
        $nested = str_starts_with($x . '/', $y . '/') || str_starts_with($y . '/', $x . '/');

        return $nested && ($a['mode'] === 'symlink' || $b['mode'] === 'symlink');
    }

    public function delete(string $id, bool $purge, string $actor): void
    {
        $site = $this->get($id);
        $this->withLock($id, function () use ($site, $purge) {
            $rel = $this->agent->store->read('rel-' . $site['id']);
            $cur = $rel['current'] ?? null;
            $dir = $this->releaseDir($site['id'], (string) $cur);
            if ($cur && is_dir($dir)) {
                if ($site['mode'] === 'symlink' && is_link($site['target'])) {
                    @unlink($site['target']);
                    if (!$purge) {
                        Fs::copyTree($dir, $site['target']);
                    }
                } elseif ($purge) {
                    $man = $this->manifest($site['id'], (string) $cur);
                    foreach (array_keys($man) as $path) {
                        @unlink($site['target'] . '/' . $path);
                        Fs::pruneEmpty(dirname($site['target'] . '/' . $path), $site['target']);
                    }
                }
            }
            Fs::rrmdir($this->siteDir($site['id']));
            foreach (glob($this->agent->dataDir . '/*' . $site['id'] . '*.json.php') ?: [] as $f) {
                if (preg_match('/^(rel|man|env)-' . preg_quote($site['id'], '/') . '(-|\.)/', basename($f))) {
                    @unlink($f);
                }
            }
        });
        $this->agent->store->update('sites', static function (array $all) use ($id) {
            unset($all[$id]);
            return $all;
        });
        $this->agent->audit($actor, 'site.delete', $id . ($purge ? ' (purged)' : ''));
    }

    // ---- paths --------------------------------------------------------------------------------------------------

    public function siteDir(string $id): string
    {
        return $this->agent->dataDir . '/sites/' . $id;
    }

    public function releaseDir(string $id, string $rid): string
    {
        return $this->siteDir($id) . '/releases/' . $rid;
    }

    private function manifest(string $id, string $rid): array
    {
        return $this->agent->store->read('man-' . $id . '-' . $rid);
    }

    private function withLock(string $id, callable $fn): mixed
    {
        Fs::mkdir($this->agent->dataDir . '/locks', 0700);
        $lock = fopen($this->agent->dataDir . '/locks/' . $id . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new ApiError('busy', 'Another deploy or rollback is running for this site. Try again in a moment.', 409);
        }
        try {
            return $fn();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    // ---- uploads ------------------------------------------------------------------------------------------------

    /** @return array{upload_id:string,chunk_bytes:int} */
    public function uploadBegin(int $size, string $sha256, string $keyId): array
    {
        if ($size <= 0 || $size > $this->agent->maxUploadBytes()) {
            throw new ApiError('upload_size', 'The upload is empty or larger than the allowed ' . intdiv($this->agent->maxUploadBytes(), 1048576) . ' MB.', 413);
        }
        if (!preg_match('/^[a-f0-9]{64}$/', $sha256)) {
            throw new ApiError('bad_hash', 'Send the sha256 of the archive.');
        }
        $free = (int) (@disk_free_space($this->agent->dataDir) ?: PHP_INT_MAX);
        if ($free < $size * 4) {
            throw new ApiError('disk_full', 'Not enough free disk space for this upload.', 507);
        }
        $this->pruneUploads();
        $id = Util::random(12);
        $dir = $this->agent->dataDir . '/uploads/' . $id;
        Fs::mkdir($dir, 0700);
        file_put_contents($dir . '/meta.json', json_encode(['size' => $size, 'sha256' => $sha256, 'key' => $keyId, 'created' => Util::now()]));
        $post = Util::bytes((string) ini_get('post_max_size'));

        return ['upload_id' => $id, 'chunk_bytes' => Caps::chunkBytes($post)];
    }

    private function uploadDir(string $id, string $keyId): string
    {
        if (!preg_match('/^[a-f0-9]{24}$/', $id)) {
            throw new ApiError('no_upload', 'Unknown upload.', 404);
        }
        $dir = $this->agent->dataDir . '/uploads/' . $id;
        $meta = json_decode((string) @file_get_contents($dir . '/meta.json'), true);
        if (!is_array($meta) || ($meta['key'] ?? '') !== $keyId) {
            throw new ApiError('no_upload', 'Unknown upload.', 404);
        }
        return $dir;
    }

    public function uploadChunk(string $id, int $index, string $body, string $keyId): int
    {
        $dir = $this->uploadDir($id, $keyId);
        $meta = json_decode((string) file_get_contents($dir . '/meta.json'), true);
        if ($index < 0 || $index > 100000 || $body === '') {
            throw new ApiError('bad_chunk', 'Bad chunk.');
        }
        $have = 0;
        foreach (glob($dir . '/*.part') ?: [] as $f) {
            $have += filesize($f);
        }
        if ($have + strlen($body) > $meta['size'] + 1048576) {
            throw new ApiError('upload_size', 'More data than the declared size.', 413);
        }
        file_put_contents($dir . '/' . $index . '.part', $body);

        return strlen($body);
    }

    /** @return array{upload_id:string,size:int,sha256:string} */
    public function uploadFinish(string $id, int $chunks, string $keyId): array
    {
        $dir = $this->uploadDir($id, $keyId);
        $meta = json_decode((string) file_get_contents($dir . '/meta.json'), true);
        $out = fopen($dir . '/blob.zip', 'wb');
        $ctx = hash_init('sha256');
        $size = 0;
        for ($i = 0; $i < $chunks; $i++) {
            $part = $dir . '/' . $i . '.part';
            if (!is_file($part)) {
                fclose($out);
                throw new ApiError('missing_chunk', 'Chunk ' . $i . ' is missing.', 409);
            }
            $fp = fopen($part, 'rb');
            while (!feof($fp)) {
                $buf = (string) fread($fp, 1048576);
                hash_update($ctx, $buf);
                $size += strlen($buf);
                fwrite($out, $buf);
            }
            fclose($fp);
            @unlink($part);
        }
        fclose($out);
        $sha = hash_final($ctx);
        if ($size !== $meta['size'] || !hash_equals($meta['sha256'], $sha)) {
            Fs::rrmdir($dir);
            throw new ApiError('upload_corrupt', 'The upload does not match its declared size or checksum. Nothing was deployed.', 422);
        }
        return ['upload_id' => $id, 'size' => $size, 'sha256' => $sha];
    }

    /** Path of a finished upload's zip. */
    public function uploadBlob(string $id, string $keyId): string
    {
        $blob = $this->uploadDir($id, $keyId) . '/blob.zip';
        if (!is_file($blob)) {
            throw new ApiError('upload_unfinished', 'Finish the upload first.', 409);
        }
        return $blob;
    }

    public function uploadFromFile(string $path, string $keyId): string
    {
        $begin = $this->uploadBegin((int) filesize($path), hash_file('sha256', $path), $keyId);
        $dir = $this->agent->dataDir . '/uploads/' . $begin['upload_id'];
        copy($path, $dir . '/blob.zip');

        return $begin['upload_id'];
    }

    private function pruneUploads(): void
    {
        $root = $this->agent->dataDir . '/uploads';
        foreach (glob($root . '/*', GLOB_ONLYDIR) ?: [] as $d) {
            if (filemtime($d) < Util::now() - 86400) {
                Fs::rrmdir($d);
            }
        }
    }

    // ---- deploy -------------------------------------------------------------------------------------------------

    /** Why a file may not be part of a site of this kind, or null. */
    private function policy(array $site): callable
    {
        $node = $site['kind'] === 'node';

        return static function (string $rel) use ($node): ?string {
            $segments = explode('/', $rel);
            $base = end($segments);
            if (in_array('.git', $segments, true)) {
                return 'The archive contains a .git folder. Remove it before deploying.';
            }
            // Node packages legitimately ship scripts (.sh, .py); what stays out is PHP, server configuration and secrets.
            $blockedName = $node ? '/^(\.htaccess|\.htpasswd|\.user\.ini|web\.config|php\.ini|\.env|\.env\.(local|production|development))$/i' : self::BLOCKED_NAME;
            $blockedExt = $node ? '/\.(php\d?|phtml|pht|phps|phar)$/i' : self::BLOCKED_EXT;
            if (preg_match($blockedName, $base) || preg_match($blockedExt, $base)) {
                return 'Files like "' . $base . '" are not allowed in a static site (executable or server configuration file).';
            }
            return null;
        };
    }

    // ---- node ---------------------------------------------------------------------------------------------------

    /** Env file, Passenger config in the public folder, and a restart signal. Runs after every switch. */
    private function afterNodeSwitch(array $site): void
    {
        if ($site['kind'] !== 'node') {
            return;
        }
        $env = $this->agent->store->read('env-' . $site['id']);
        $dir = $this->siteDir($site['id']);
        Fs::mkdir($dir, 0700);
        file_put_contents($dir . '/env', NodeApp::envFile($env));
        @chmod($dir . '/env', 0600);
        $docroot = $site['node']['docroot'] ?? null;
        if ($docroot) {
            Fs::mkdir($docroot);
            $file = $docroot . '/.htaccess';
            $old = is_file($file) ? (string) file_get_contents($file) : '';
            if ($old !== '' && !str_contains($old, '# Managed by the WPM Host Agent')) {
                Fs::mkdir($dir . '/backups', 0700);
                copy($file, $dir . '/backups/htaccess-' . Util::now());
            }
            file_put_contents($file, NodeApp::htaccess($site, $env));
        }
        NodeApp::restart($site, $dir);
    }

    /** @param array<string,mixed> $env */
    public function setEnv(string $siteId, array $env, string $actor): array
    {
        $site = $this->get($siteId);
        if ($site['kind'] !== 'node') {
            throw new ApiError('not_node', 'Environment variables apply to Node.js sites.');
        }
        $clean = NodeApp::cleanEnv($env);
        $this->agent->store->write('env-' . $siteId, $clean);
        $this->afterNodeSwitch($site);
        $this->agent->audit($actor, 'site.env', $siteId . ': ' . implode(',', array_keys($clean)));

        return ['keys' => array_keys($clean)];
    }

    public function nodeScript(string $siteId, string $domain, string $runUser, bool $installDb): string
    {
        $site = $this->get($siteId);
        if ($site['kind'] !== 'node') {
            throw new ApiError('not_node', 'This is not a Node.js site.');
        }
        if ($runUser === '') {
            $info = function_exists('posix_geteuid') && function_exists('posix_getpwuid') ? posix_getpwuid(posix_geteuid()) : false;
            $runUser = is_array($info) ? (string) $info['name'] : 'www-data';
        }

        return NodeApp::vpsScript($site, $domain, $runUser, $this->siteDir($siteId), $installDb);
    }

    /** @return array<string,mixed> the new release */
    public function deploy(string $siteId, string $uploadId, string $note, string $actor, string $keyId): array
    {
        $site = $this->get($siteId);
        if (!in_array($site['kind'], self::DEPLOYABLE, true)) {
            throw new ApiError('not_deployable', 'This site type is a live install and is not published as releases.', 409);
        }
        $dir = $this->uploadDir($uploadId, $keyId);
        $blob = $dir . '/blob.zip';
        if (!is_file($blob)) {
            throw new ApiError('upload_unfinished', 'Finish the upload before deploying.', 409);
        }
        $result = $this->withLock($siteId, function () use ($site, $blob, $note, $actor, $uploadId) {
            return $this->deployLocked($site, $blob, $note, $actor);
        });
        Fs::rrmdir($this->agent->dataDir . '/uploads/' . $uploadId);

        return $result;
    }

    /** @return array<string,mixed> */
    private function deployLocked(array $site, string $blob, string $note, string $actor): array
    {
        $id = $site['id'];
        $rid = gmdate('YmdHis', Util::now()) . '-' . Util::random(2);
        $rdir = $this->releaseDir($id, $rid);
        Fs::mkdir($rdir, 0700);
        try {
            $info = Zip::extract($blob, $rdir, $this->agent->maxUploadBytes() * 4, $this->policy($site), $site['kind'] === 'node' ? 150000 : 60000);
            if ($info['files'] === 0) {
                throw new ApiError('empty_release', 'The archive has no files.');
            }
            if ($site['kind'] === 'node') {
                if (!isset($info['manifest'][$site['node']['startup']])) {
                    throw new ApiError('no_startup', 'The archive has no ' . $site['node']['startup'] . ' at its top level. That is the file the host starts.');
                }
                @mkdir($rdir . '/tmp', 0755, true);
                file_put_contents($rdir . '/tmp/restart.txt', (string) Util::now());
            }
            if ($site['kind'] === 'spa') {
                if (!isset($info['manifest']['index.html'])) {
                    throw new ApiError('no_index', 'A single-page app needs an index.html at the top of the archive.');
                }
                $ht = "<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . index.html [L]\n</IfModule>\n";
                file_put_contents($rdir . '/.htaccess', $ht);
                $info['manifest']['.htaccess'] = ['sha256' => hash('sha256', $ht), 'size' => strlen($ht)];
                ksort($info['manifest']);
            }
        } catch (\Throwable $e) {
            Fs::rrmdir($rdir);
            throw $e;
        }
        $this->agent->store->write('man-' . $id . '-' . $rid, $info['manifest']);

        $rel = $this->agent->store->read('rel-' . $id, ['releases' => [], 'current' => null]);
        $prev = $rel['current'] ?? null;
        $oldMan = $prev ? $this->manifest($id, $prev) : [];

        try {
            $this->switchTo($site, $rid, $info['manifest'], $oldMan, $prev !== null);
            $this->afterNodeSwitch($site);
        } catch (\Throwable $e) {
            Fs::rrmdir($rdir);
            @unlink($this->agent->store->path('man-' . $id . '-' . $rid));
            throw $e;
        }

        $entry = ['id' => $rid, 'created' => Util::now(), 'files' => $info['files'], 'bytes' => $info['bytes'], 'sha256' => hash_file('sha256', $blob), 'note' => substr($note, 0, 200), 'by' => $actor];
        $rel['releases'][] = $entry;
        $rel['current'] = $rid;
        $rel['previous'] = $prev;
        $rel = $this->prune($site, $rel);
        $this->agent->store->write('rel-' . $id, $rel);
        $this->agent->audit($actor, 'deploy', $id . ' -> ' . $rid . ' (' . $info['files'] . ' files)');

        return $entry + ['previous' => $prev, 'mode' => $site['mode'], 'site' => $id];
    }

    public function rollback(string $siteId, ?string $to, string $actor): array
    {
        $site = $this->get($siteId);

        return $this->withLock($siteId, function () use ($site, $to, $actor) {
            $id = $site['id'];
            $rel = $this->agent->store->read('rel-' . $id, ['releases' => [], 'current' => null]);
            $current = $rel['current'] ?? null;
            $ids = array_column($rel['releases'], 'id');
            if ($to === null) {
                $pos = array_search($current, $ids, true);
                $to = $pos !== false && $pos > 0 ? $ids[$pos - 1] : null;
                if ($to === null) {
                    throw new ApiError('no_previous', 'There is no earlier release to go back to.', 409);
                }
            }
            if (!in_array($to, $ids, true) || !is_dir($this->releaseDir($id, $to))) {
                throw new ApiError('no_release', 'That release no longer exists.', 404);
            }
            if ($to === $current) {
                throw new ApiError('already_current', 'That release is already live.', 409);
            }
            $this->switchTo($site, $to, $this->manifest($id, $to), $current ? $this->manifest($id, $current) : [], $current !== null);
            $this->afterNodeSwitch($site);
            $rel['previous'] = $current;
            $rel['current'] = $to;
            $this->agent->store->write('rel-' . $id, $rel);
            $this->agent->audit($actor, 'rollback', $id . ': ' . $current . ' -> ' . $to);

            return ['site' => $id, 'current' => $to, 'previous' => $current, 'mode' => $site['mode']];
        });
    }

    /** @return array{current:?string,releases:list<array<string,mixed>>} */
    public function releases(string $siteId): array
    {
        $this->get($siteId);
        $rel = $this->agent->store->read('rel-' . $siteId, ['releases' => [], 'current' => null]);

        return ['current' => $rel['current'] ?? null, 'releases' => array_reverse($rel['releases'] ?? [])];
    }

    private function prune(array $site, array $rel): array
    {
        $keep = max(2, (int) ($this->agent->config()['keep_releases'] ?? 5));
        $list = $rel['releases'];
        while (count($list) > $keep) {
            $old = $list[0];
            if ($old['id'] === $rel['current'] || $old['id'] === ($rel['previous'] ?? null)) {
                break;
            }
            array_shift($list);
            Fs::rrmdir($this->releaseDir($site['id'], $old['id']));
            Fs::rrmdir($this->siteDir($site['id']) . '/backups/' . $old['id']);
            @unlink($this->agent->store->path('man-' . $site['id'] . '-' . $old['id']));
        }
        $rel['releases'] = $list;

        return $rel;
    }

    // ---- switching ----------------------------------------------------------------------------------------------

    private function switchTo(array $site, string $rid, array $newMan, array $oldMan, bool $hadRelease): void
    {
        $rdir = $this->releaseDir($site['id'], $rid);
        if ($site['mode'] === 'symlink') {
            $this->switchSymlink($site['target'], $rdir);
            return;
        }
        $this->switchSync($site, $rdir, $rid, $newMan, $oldMan);
    }

    private function switchSymlink(string $target, string $rdir): void
    {
        if (is_link($target)) {
            // fine: replaced atomically below
        } elseif (!file_exists($target)) {
            Fs::mkdir(dirname($target));
        } elseif (Fs::isEmptyDir($target)) {
            @rmdir($target);
        } else {
            throw new ApiError('target_not_empty', 'The site folder already holds files. Use sync mode, or empty it first.', 409);
        }
        $tmp = $target . '.wpm-' . Util::random(3);
        if (!@symlink($rdir, $tmp)) {
            throw new ApiError('symlink_failed', 'This host does not allow symlinks. Re-create the site in sync mode.', 500);
        }
        if (!@rename($tmp, $target)) {
            @unlink($tmp);
            throw new ApiError('switch_failed', 'Could not switch the live folder.', 500);
        }
    }

    /**
     * Shared-hosting strategy: the live folder is a real directory. Files of the new release are written next to
     * their final names and renamed into place (each file switches atomically), HTML last so pages never point at
     * assets that are not there yet; files that only the old release had are then removed. Files that were not
     * put there by a release are never deleted, and any that get overwritten are copied to backups/ first.
     */
    private function switchSync(array $site, string $rdir, string $rid, array $newMan, array $oldMan): void
    {
        $target = $site['target'];
        Fs::mkdir($target);
        $backup = $this->siteDir($site['id']) . '/backups/' . $rid;
        $paths = array_keys($newMan);
        usort($paths, static fn ($a, $b) => (int) preg_match('/\.html?$/i', $a) <=> (int) preg_match('/\.html?$/i', $b));

        foreach ($paths as $p) {
            $full = $target . '/' . $p;
            if (!Fs::within($target, $full) || Fs::within($this->agent->agentDir, $full) || Fs::within($this->agent->dataDir, $full)) {
                throw new ApiError('unsafe_target', 'A file would land outside the site folder: ' . $p, 422);
            }
            if (is_dir($full) && !is_link($full)) {
                throw new ApiError('target_conflict', 'A folder named "' . $p . '" already exists where a file should go.', 409);
            }
        }
        foreach ($paths as $p) {
            $full = $target . '/' . $p;
            if (is_file($full) && !is_link($full)) {
                $have = hash_file('sha256', $full);
                if ($have === $newMan[$p]['sha256']) {
                    continue;
                }
                if (!isset($oldMan[$p]) || $oldMan[$p]['sha256'] !== $have) {
                    Fs::mkdir(dirname($backup . '/' . $p));
                    copy($full, $backup . '/' . $p);
                }
            }
            Fs::mkdir(dirname($full));
            $tmp = $full . '.wpm-tmp';
            if (!copy($rdir . '/' . $p, $tmp) || !@rename($tmp, $full)) {
                @unlink($tmp);
                throw new ApiError('write_failed', 'Could not write ' . $p . ' (permissions or disk space).', 500);
            }
        }
        foreach (array_diff_key($oldMan, $newMan) as $p => $_) {
            $full = $target . '/' . $p;
            if (is_file($full) && !is_link($full)) {
                @unlink($full);
                Fs::pruneEmpty(dirname($full), $target);
            }
        }
    }
}
