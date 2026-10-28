<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Shared state of one agent installation: where the data lives, the config, the audit log. */
final class Agent
{
    public const VERSION = '2.0.0-m1';

    public Store $store;
    /** @var array<string,mixed> */
    private array $config = [];

    public function __construct(public readonly string $agentDir, public readonly string $dataDir, public readonly string $docRoot)
    {
        Fs::mkdir($dataDir, 0700);
        $this->store = new Store($dataDir);
        $this->config = $this->store->read('config');
    }

    /**
     * Finds (or, before installation, chooses) the data folder. A folder outside the web root is preferred;
     * when the host does not allow that, the folder inside the agent is used and protected with deny rules.
     */
    public static function boot(string $agentDir, ?string $override = null): self
    {
        $docRoot = (string) (realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? '')) ?: dirname($agentDir));
        $pointer = $agentDir . '/data-location.php';
        $dataDir = null;
        if (is_file($pointer)) {
            $v = include $pointer;
            $dataDir = is_string($v) ? $v : null;
        }
        if ($dataDir === null) {
            $dataDir = $override ?? self::chooseDataDir($agentDir, $docRoot);
            @file_put_contents($pointer, "<?php defined('WPM_AGENT') || exit; return " . var_export($dataDir, true) . ";\n");
        }
        $agent = new self($agentDir, $dataDir, $docRoot);
        $agent->protectDataDir();

        return $agent;
    }

    private static function chooseDataDir(string $agentDir, string $docRoot): string
    {
        $candidates = [dirname($docRoot) . '/wpm-agent-data', dirname($agentDir, 2) . '/wpm-agent-data'];
        foreach (array_unique($candidates) as $dir) {
            $parent = dirname($dir);
            if (!Fs::within($docRoot, $dir) && @is_dir($parent) && @is_writable($parent) && (@mkdir($dir, 0700, true) || is_dir($dir))) {
                return $dir;
            }
        }
        return $agentDir . '/data';
    }

    private function protectDataDir(): void
    {
        $deny = $this->dataDir . '/.htaccess';
        if (!is_file($deny)) {
            @file_put_contents($deny, "Require all denied\nDeny from all\n");
        }
        if (!is_file($this->dataDir . '/index.html')) {
            @file_put_contents($this->dataDir . '/index.html', '');
        }
    }

    public function insideWebRoot(): bool
    {
        return Fs::within($this->docRoot, $this->dataDir);
    }

    // ---- config -------------------------------------------------------------------------------------------------

    public function installed(): bool
    {
        return !empty($this->config['admin']['user']);
    }

    /** @return array<string,mixed> */
    public function config(): array
    {
        return $this->config;
    }

    public function setConfig(array $config): void
    {
        $this->config = $config;
        $this->store->write('config', $config);
    }

    public function updateConfig(callable $fn): void
    {
        $this->config = $this->store->update('config', function (array $c, &$out) use ($fn) {
            $new = $fn($c);
            $out = $new;
            return $new;
        }) ?? $this->config;
    }

    /** Folders sites may live in. The web root is always one. */
    public function roots(): array
    {
        $roots = [Fs::norm($this->docRoot)];
        foreach ((array) ($this->config['roots'] ?? []) as $r) {
            if (is_string($r) && is_dir($r)) {
                $roots[] = Fs::norm($r);
            }
        }
        return array_values(array_unique($roots));
    }

    /** Adds a folder sites may live in. Only inside the account's home (the folder above the web root). */
    public function addRoot(string $path, string $actor): string
    {
        $real = realpath($path);
        $home = Fs::norm(dirname($this->docRoot));
        if ($real === false || !is_dir($real) || !is_writable($real)) {
            throw new ApiError('bad_root', 'That folder does not exist or is not writable.');
        }
        $norm = Fs::norm($real);
        if ($norm === $home || !str_starts_with($norm . '/', $home . '/') || Fs::within($this->agentDir, $norm) || Fs::within($this->dataDir, $norm) || Fs::within($norm, $this->agentDir) && $norm !== Fs::norm($this->docRoot)) {
            throw new ApiError('bad_root', 'Allowed locations must be folders inside this hosting account (' . $home . '), outside the agent folders.');
        }
        $this->updateConfig(static function (array $c) use ($norm) {
            $c['roots'] = array_values(array_unique(array_merge((array) ($c['roots'] ?? []), [$norm])));
            return $c;
        });
        $this->audit($actor, 'root.add', $norm);

        return $norm;
    }

    public function maxUploadBytes(): int
    {
        return (int) (($this->config['max_upload_mb'] ?? 256) * 1048576);
    }

    // ---- audit --------------------------------------------------------------------------------------------------

    public function audit(string $actor, string $action, string $detail = '', string $ip = ''): void
    {
        $this->store->log('audit', ['ts' => Util::now(), 'actor' => $actor, 'action' => $action, 'detail' => substr($detail, 0, 300), 'ip' => $ip]);
    }

    public function caps(): array
    {
        return Caps::detect($this->dataDir, $this->agentDir, $this->docRoot);
    }
}
