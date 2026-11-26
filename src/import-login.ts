/**
 * Optional: copy ONE site's login (its cookies) from the user's own Chrome into an isolated profile, once.
 * Afterwards runs use the isolated profile as usual; the user's Chrome is never attached to or changed.
 *
 * How: copy the cookie database (and Local State, which holds the key on Windows) of the chosen Chrome
 * profile into a throw-away folder, start the system Chrome on that copy (Chrome decrypts its own cookies,
 * so there is no crypto code here), read the cookies of the site's domains over CDP, then write them into
 * the isolated profile. The throw-away copy is deleted at the end.
 *
 * Not the default: logging in by hand in the isolated profile (`login`) stays the recommended way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, closeSession, getSession, profileDir, siteKey } from './browser.js';
import { hostMatches } from './scripts.js';
import { dirs, readJson, RecipeError, log, timestampId } from './util.js';

/** Where Chrome keeps its profiles on this computer (override with --chrome-dir). */
export function userChromeDir(): string {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(h, '.config', 'google-chrome');
}

/** Chrome profiles in a Chrome data folder: folder name ("Default", "Profile 1") and the name shown in Chrome. */
export function listChromeProfiles(chromeDir: string): { dir: string; name: string }[] {
  const ls = path.join(chromeDir, 'Local State');
  const out: { dir: string; name: string }[] = [];
  try {
    const cache = readJson(ls)?.profile?.info_cache || {};
    for (const [dir, info] of Object.entries<any>(cache)) out.push({ dir, name: info?.name || dir });
  } catch {}
  if (!out.length && fs.existsSync(path.join(chromeDir, 'Default'))) out.push({ dir: 'Default', name: 'Default' });
  return out;
}

/** Pick the Chrome profile folder: exact folder name, or the name shown in Chrome (case-insensitive). */
export function findChromeProfile(chromeDir: string, want?: string): string {
  const all = listChromeProfiles(chromeDir);
  const w = (want || 'Default').toLowerCase();
  const hit = all.find((p) => p.dir.toLowerCase() === w) || all.find((p) => p.name.toLowerCase() === w);
  if (hit) return hit.dir;
  if (!want && fs.existsSync(path.join(chromeDir, 'Default'))) return 'Default';
  throw new RecipeError(
    'IMPORT_FAILED',
    `Chrome profile "${want || 'Default'}" not found in ${chromeDir}.` + (all.length ? ` Available: ${all.map((p) => `"${p.name}" (${p.dir})`).join(', ')}; pass --from "<name>".` : ' Is Chrome installed and used on this computer? Use --chrome-dir to point to its data folder.'),
  );
}

/** Copy the files Chrome needs to read its cookies into a fresh user-data-dir. */
function copyCookieStore(chromeDir: string, chromeProfile: string, dest: string) {
  const src = path.join(chromeDir, chromeProfile);
  // Chrome 96+ keeps cookies in <profile>/Network/Cookies, older versions in <profile>/Cookies
  const rels = ['Network/Cookies', 'Network/Cookies-journal', 'Cookies', 'Cookies-journal'];
  let copied = 0;
  for (const rel of rels) {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, 'Default', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.copyFileSync(from, to);
      if (!rel.endsWith('journal')) copied++;
    } catch (e: any) {
      if (/EBUSY|EPERM|EACCES/.test(e.code || '')) {
        throw new RecipeError('IMPORT_FAILED', `cannot read Chrome's cookie file (${e.code}): Chrome is probably open and locks it. Quit Chrome completely and run this again, or log in by hand instead: browser-recipewright login <site> -p <site>/<account>`);
      }
      throw e;
    }
  }
  if (!copied) throw new RecipeError('IMPORT_FAILED', `no cookie database in ${src}; is this the right Chrome profile? (--from "<name>")`);
  // Local State carries the cookie key on Windows (DPAPI / app-bound); harmless elsewhere
  const ls = path.join(chromeDir, 'Local State');
  if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(dest, 'Local State'));
}

export interface ImportResult {
  profile: string;
  from: { chromeDir: string; profile: string };
  domains: string[];
  imported: number;
  cookieDomains: string[];
}

export async function importLogin(o: { site: string; profile: string; domains?: string[]; chromeDir?: string; from?: string }): Promise<ImportResult> {
  const site = siteKey(o.site);
  if (!site) throw new RecipeError('INPUT_INVALID', `"${o.site}" is not a site; give a domain like example.com`);
  const domains = [...new Set([site, ...(o.domains || []).map((d) => siteKey(d)).filter((d): d is string => !!d)])];
  const chromeDir = path.resolve(o.chromeDir || userChromeDir());
  if (!fs.existsSync(chromeDir)) throw new RecipeError('IMPORT_FAILED', `Chrome data folder not found: ${chromeDir}. Use --chrome-dir, or log in by hand: browser-recipewright login ${site} -p ${o.profile}`);
  if (path.resolve(profileDir(o.profile)) === chromeDir) throw new RecipeError('INPUT_INVALID', 'source and target are the same folder');
  if (await getSession(o.profile)) throw new RecipeError('IMPORT_FAILED', `profile ${o.profile} is open right now; close it first: browser-recipewright close -p ${o.profile}`);
  const chromeProfile = findChromeProfile(chromeDir, o.from);

  const tmpName = `_import/${timestampId()}-${process.pid}`;
  const tmpDir = profileDir(tmpName);
  let cookies: any[] = [];
  try {
    copyCookieStore(chromeDir, chromeProfile, tmpDir);
    log.info(`reading ${domains.join(', ')} cookies from Chrome profile "${chromeProfile}" (a temporary copy; your Chrome is not touched)`);
    if (process.platform === 'darwin') log.info('macOS may ask for your login password to let Chrome read "Chrome Safe Storage": choose Allow.');
    const src = await connect(tmpName, { headless: true, reuse: false });
    try {
      const all = await src.context.cookies();
      cookies = all.filter((c) => domains.some((d) => hostMatches(c.domain.replace(/^\./, ''), d)));
    } finally {
      await closeSession(tmpName, src.browser).catch(() => {});
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(path.join(dirs.profiles(), '_import'), { recursive: true, force: true });
  }
  if (!cookies.length) {
    const why = [
      `not logged in to ${site} in Chrome profile "${chromeProfile}" (try --from "<other profile>")`,
      process.platform === 'darwin' ? 'macOS keychain access was denied (run again and choose Allow)' : null,
      process.platform === 'win32' ? 'Chrome on Windows encrypts cookies for its own folder only (app-bound encryption), so they cannot be moved' : null,
      'the Chrome found is not the one you log in with (e.g. Chromium); set BROWSER_RECIPEWRIGHT_CHROME',
    ].filter(Boolean);
    throw new RecipeError('IMPORT_EMPTY', `no ${domains.join('/')} cookies could be read. Possible reasons: ${why.join('; ')}. The reliable way: log in by hand once: browser-recipewright login ${site} -p ${o.profile}`);
  }

  const dst = await connect(o.profile, { headless: true, reuse: false });
  try {
    await dst.context.addCookies(cookies);
  } finally {
    // closing lets Chrome write the cookies into the profile folder
    await closeSession(o.profile, dst.browser).catch(() => {});
  }
  return { profile: o.profile, from: { chromeDir, profile: chromeProfile }, domains, imported: cookies.length, cookieDomains: [...new Set(cookies.map((c) => c.domain))].sort() };
}
