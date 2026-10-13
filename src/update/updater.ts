import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import { isNewer, normalizeVersion } from '../domain/version.js';
import type { Logger } from '../logging/logger.js';

const LATEST_KEY = 'update.latest';
const NOTES_MAX = 4000;

const latestSchema = z.object({
  /** Without the leading `v`. */
  version: z.string(),
  url: z.string(),
  publishedAt: z.number().int().nullable(),
  notes: z.string(),
  checkedAt: z.number().int(),
});

export type LatestRelease = z.infer<typeof latestSchema>;

/** What the setup script wrote about its last update run (`data/update-status.json`). */
const statusSchema = z.object({
  state: z.enum(['running', 'done', 'failed']),
  version: z.string(),
  at: z.number().int(),
  message: z.string().nullable().optional(),
});

export interface UpdateRun {
  state: 'running' | 'done' | 'failed';
  version: string;
  at: number;
  message: string;
}

export class UpdateError extends Error {
  constructor(
    readonly code: 'UPDATE_CHECK_FAILED' | 'UPDATE_NOT_AVAILABLE' | 'UPDATE_UNSUPPORTED',
  ) {
    super(code);
    this.name = 'UpdateError';
  }
}

/** Starts a command line outside of this process tree. Injectable for tests. */
export type Launcher = (commandLine: string, cwd: string) => Promise<void>;

/**
 * Starts the command through WMI, so that it becomes a child of the WMI host and not of this
 * process: the service manager kills the whole process tree of the service when the update
 * stops it, and the updater must survive that.
 */
export const launchDetached: Launcher = (commandLine, cwd) =>
  new Promise((resolve, reject) => {
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const script =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = ${quote(commandLine)}; CurrentDirectory = ${quote(cwd)} }; ` +
      `if ($r.ReturnValue -ne 0) { exit 1 }`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`launcher exited with code ${String(code)}`));
    });
  });

export interface UpdaterOptions {
  db: DbExecutor;
  logger: Logger;
  /** Version that is running, from package.json. */
  currentVersion: string;
  /** `owner/name` of the GitHub repository whose releases are offered. */
  repo: string;
  /** Root of the installation (contains `scripts/setup.ps1` and `.git`). */
  root: string;
  /** Name of the Windows service the setup script restarts. */
  serviceName: string;
  /** UTC seconds. */
  now: () => number;
  fetch?: typeof fetch;
  launch?: Launcher;
  platform?: NodeJS.Platform;
}

/**
 * Looks for new releases on GitHub and can hand the installation to the setup script. Only
 * published releases count – never drafts, pre-releases or the state of a branch – and only the
 * release found by the last check can be installed, so no version text from a request ever
 * reaches a command line.
 */
export class Updater {
  constructor(private readonly options: UpdaterOptions) {}

  get currentVersion(): string {
    return this.options.currentVersion;
  }

  /** The release found by the last check; undefined before the first one. */
  latest(): LatestRelease | undefined {
    try {
      return getSetting(this.options.db, LATEST_KEY, latestSchema);
    } catch {
      return undefined;
    }
  }

  updateAvailable(): boolean {
    const latest = this.latest();
    return latest !== undefined && isNewer(latest.version, this.options.currentVersion);
  }

  /** Why an update cannot be started from the web interface; undefined when it can. */
  installBlocker(): 'platform' | 'no_git' | 'no_script' | undefined {
    if ((this.options.platform ?? process.platform) !== 'win32') return 'platform';
    if (!existsSync(join(this.options.root, '.git'))) return 'no_git';
    if (!existsSync(this.scriptPath)) return 'no_script';
    return undefined;
  }

  /** The last run of the setup script, if it left a readable status file. */
  lastRun(): UpdateRun | undefined {
    try {
      const text = readFileSync(this.statusPath, 'utf8');
      // Windows PowerShell likes to put a byte order mark in front.
      const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const status = statusSchema.parse(JSON.parse(raw));
      return { ...status, message: status.message ?? '' };
    } catch {
      return undefined;
    }
  }

  /** Asks GitHub for the latest published release and remembers it. */
  async check(): Promise<LatestRelease> {
    const request = this.options.fetch ?? fetch;
    let body: unknown;
    try {
      const response = await request(
        `https://api.github.com/repos/${this.options.repo}/releases/latest`,
        {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'ts3-analytics' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      body = await response.json();
    } catch (error) {
      this.options.logger.warn({ err: error }, 'Update check failed');
      throw new UpdateError('UPDATE_CHECK_FAILED');
    }
    const release = z
      .object({
        tag_name: z.string(),
        html_url: z.string(),
        published_at: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        draft: z.boolean().optional(),
        prerelease: z.boolean().optional(),
      })
      .safeParse(body);
    const version = release.success ? normalizeVersion(release.data.tag_name) : undefined;
    if (
      !release.success ||
      version === undefined ||
      release.data.draft ||
      release.data.prerelease
    ) {
      this.options.logger.warn('Update check returned no usable release');
      throw new UpdateError('UPDATE_CHECK_FAILED');
    }
    const published = Date.parse(release.data.published_at ?? '');
    const latest: LatestRelease = {
      version,
      url: release.data.html_url,
      publishedAt: Number.isFinite(published) ? Math.floor(published / 1000) : null,
      notes: (release.data.body ?? '').slice(0, NOTES_MAX),
      checkedAt: this.options.now(),
    };
    setSetting(this.options.db, LATEST_KEY, latest, latest.checkedAt);
    return latest;
  }

  /**
   * Starts the setup script for the release of the last check. Returns as soon as the script
   * was launched; the service is stopped by it shortly after.
   */
  async install(): Promise<string> {
    const latest = this.latest();
    if (!latest || !isNewer(latest.version, this.options.currentVersion)) {
      throw new UpdateError('UPDATE_NOT_AVAILABLE');
    }
    if (this.installBlocker() !== undefined || !/^[\w-]{1,64}$/.test(this.options.serviceName)) {
      throw new UpdateError('UPDATE_UNSUPPORTED');
    }
    const tag = `v${latest.version}`;
    const log = join(this.options.root, 'data', 'logs', 'update.log');
    // Every part is either fixed, validated above or a path of this installation.
    const commandLine =
      `cmd.exe /d /c powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
      `-File "${this.scriptPath}" update -Version ${tag} -ServiceName ${this.options.serviceName} ` +
      `-Repo ${this.options.repo} -Yes > "${log}" 2>&1`;
    this.options.logger.info({ version: tag }, 'Starting update');
    await (this.options.launch ?? launchDetached)(commandLine, this.options.root);
    return tag;
  }

  private get scriptPath(): string {
    return join(this.options.root, 'scripts', 'setup.ps1');
  }

  private get statusPath(): string {
    return join(this.options.root, 'data', 'update-status.json');
  }
}
