/**
 * Browser layer: find the system Chrome, launch it with clean flags (no --enable-automation,
 * no automation extension), one user-data-dir per site/account, then attach with patchright over CDP.
 * A launched browser is registered as a "session" so later CLI calls (snapshot / act / run) can reuse it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { dirs, ensureDir, readJson, writeJson, safeName, sleep, RecipeError, log } from './util.js';

export interface SessionInfo {
  profile: string;
  port: number;
  pid: number;
  userDataDir: string;
  headless: boolean;
  startedAt: string;
  chrome: string;
}

export interface Connected {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  session: SessionInfo;
  launchedHere: boolean;
}

export function profileDir(profile: string): string {
  const parts = profile.split('/').filter(Boolean).map(safeName);
  return path.join(dirs.profiles(), ...parts);
}

function sessionFile(profile: string) {
  return path.join(dirs.sessions(), safeName(profile.replace(/\//g, '__')) + '.json');
}
export function refsFile(profile: string) {
  return path.join(dirs.sessions(), safeName(profile.replace(/\//g, '__')) + '.refs.json');
}

export function findChrome(): string | null {
  const env = process.env.BROWSER_RECIPEWRIGHT_CHROME || process.env.BROWSER_RPA_CHROME || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
      );
    }
  } else if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]) {
      if (base) candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
    }
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const p = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
        if (p) candidates.push(p);
      } catch {}
    }
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cdpReachable(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function getSession(profile: string): Promise<SessionInfo | null> {
  const f = sessionFile(profile);
  if (!fs.existsSync(f)) return null;
  const s = readJson<SessionInfo>(f);
  if (alive(s.pid) && (await cdpReachable(s.port))) return s;
  fs.rmSync(f, { force: true });
  return null;
}

export async function listSessions(): Promise<SessionInfo[]> {
  if (!fs.existsSync(dirs.sessions())) return [];
  const out: SessionInfo[] = [];
  for (const f of fs.readdirSync(dirs.sessions())) {
    if (!f.endsWith('.json') || f.endsWith('.refs.json')) continue;
    const s = readJson<SessionInfo>(path.join(dirs.sessions(), f));
    if (await getSession(s.profile)) out.push(s);
  }
  return out;
}

/**
 * Command-line flags for the Chrome we spawn. Exported so tests can check them.
 * The three "background" flags stop Chrome from slowing down a window that is minimized, covered by
 * another window, or in a background tab. Without them, timers and page repaints are throttled and
 * actionability checks ("is the element stable?") can stall until they time out.
 */
export function chromeArgs(userDataDir: string, opts: { headless?: boolean; firstRun?: boolean; url?: string } = {}): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Chrome turns navigator.webdriver on whenever remote debugging is enabled; this keeps it false
    '--disable-blink-features=AutomationControlled',
    // keep running at full speed when the user minimizes / covers the window or switches tabs
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  if (opts.firstRun || opts.headless) args.push('--window-size=1280,900');
  if (opts.headless) args.push('--headless=new');
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  args.push(opts.url || 'about:blank');
  return args;
}

/** Launch a fresh Chrome for this profile (detached, so it can outlive the CLI call). */
export async function launchChrome(profile: string, opts: { headless?: boolean; url?: string } = {}): Promise<SessionInfo> {
  const chrome = findChrome();
  if (!chrome) throw new RecipeError('BROWSER_ERROR', 'Google Chrome not found. Install Chrome, or set BROWSER_RECIPEWRIGHT_CHROME=/path/to/chrome');
  const userDataDir = ensureDir(profileDir(profile));
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const firstRun = !fs.existsSync(path.join(userDataDir, 'Default'));
  const args = chromeArgs(userDataDir, { headless: opts.headless, firstRun, url: opts.url });
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 30000;
  let port = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      port = parseInt(first, 10);
      if (port && (await cdpReachable(port))) break;
    }
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  if (!port || !(await cdpReachable(port))) {
    try { if (child.pid) process.kill(child.pid); } catch {}
    throw new RecipeError(
      'BROWSER_ERROR',
      `Chrome did not start for profile "${profile}". If a Chrome window is already open with this profile, close it (or run: browser-recipewright close --profile ${profile}) and retry.`,
    );
  }
  const info: SessionInfo = { profile, port, pid: child.pid!, userDataDir, headless: !!opts.headless, startedAt: new Date().toISOString(), chrome };
  writeJson(sessionFile(profile), info);
  return info;
}

export async function connect(profile: string, opts: { headless?: boolean; reuse?: boolean } = {}): Promise<Connected> {
  let session = opts.reuse === false ? null : await getSession(profile);
  let launchedHere = false;
  if (!session) {
    session = await launchChrome(profile, { headless: opts.headless });
    launchedHere = true;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages().filter((p) => !p.url().startsWith('chrome-extension://') && !p.url().startsWith('devtools://'));
  const page = pages[pages.length - 1] ?? (await context.newPage());
  return { browser, context, page, session, launchedHere };
}

/** Close Chrome gracefully (lets it flush cookies to the profile), then make sure the process is gone. */
export async function closeSession(profile: string, browser?: Browser): Promise<boolean> {
  const s = await getSession(profile);
  let b = browser;
  try {
    if (!b && s) b = await chromium.connectOverCDP(`http://127.0.0.1:${s.port}`);
    if (b) {
      const cdp = await b.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
    }
  } catch {}
  if (s) {
    for (let i = 0; i < 30 && alive(s.pid); i++) await sleep(100);
    if (alive(s.pid)) try { process.kill(s.pid); } catch {}
  }
  fs.rmSync(sessionFile(profile), { force: true });
  return !!s;
}

export async function disconnect(c: Connected) {
  // connectOverCDP: close() only disconnects this client; Chrome keeps running.
  await c.browser.close().catch(() => {});
}

/** "www.example.com" / "https://www.example.com/x" → "example.com"; "*.example.com" → "example.com"; "*" or junk → null. */
export function siteKey(s?: string | null): string | null {
  if (!s) return null;
  let host = s.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(host)) {
    if (!/^https?:/i.test(host)) return null;
    try { host = new URL(host).hostname; } catch { return null; }
  } else host = host.split('/')[0];
  host = host.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/:\d+$/, '');
  return host && host !== '*' ? host : null;
}

/**
 * The one rule every command uses to pick a profile when -p is not given:
 *   1. -p <site>/<account>                      → exactly that
 *   2. a recipe is involved (run, login, batch) → <recipe site>/default
 *   3. launch --url                             → <host of the url>/default
 *   4. exactly one browser is running           → that one (so snapshot/act/screenshot after a run or launch
 *                                                  just work, whatever its profile is)
 *   5. several are running                      → error: say which one with -p
 *   6. nothing running, a url is known          → <host>/default; otherwise default/default
 * Profiles live in ~/.browser-rpa/profiles/<site>/<account> (or ~/.browser-recipewright/...), one isolated
 * Chrome user-data-dir each.
 */
export async function resolveProfile(o: { explicit?: string; site?: string | null; url?: string; urlFirst?: boolean } = {}): Promise<{ profile: string; why: string }> {
  if (o.explicit) return { profile: o.explicit, why: '-p' };
  const fromSite = siteKey(o.site);
  if (o.site !== undefined) return { profile: `${fromSite || 'default'}/default`, why: 'recipe site' };
  const fromUrl = siteKey(o.url);
  if (o.urlFirst && fromUrl) return { profile: `${fromUrl}/default`, why: 'url' };
  const running = (await listSessions()).map((s) => s.profile).filter((p) => !p.startsWith('_'));
  if (running.length === 1) return { profile: running[0], why: 'the only running browser' };
  if (running.length > 1) {
    if (fromUrl) {
      const same = running.filter((p) => p.split('/')[0] === fromUrl);
      if (same.length === 1) return { profile: same[0], why: 'running browser for this site' };
    }
    throw new RecipeError('PROFILE_AMBIGUOUS', `${running.length} browsers are running (${running.join(', ')}); say which one with -p <site>/<account>`, { running });
  }
  return { profile: fromUrl ? `${fromUrl}/default` : 'default/default', why: fromUrl ? 'url' : 'default' };
}

export function profilesList(): string[] {
  const root = dirs.profiles();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const site of fs.readdirSync(root)) {
    const sd = path.join(root, site);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const acc of fs.readdirSync(sd)) if (fs.statSync(path.join(sd, acc)).isDirectory()) out.push(`${site}/${acc}`);
  }
  return out;
}

export { log };
