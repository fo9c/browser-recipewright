/** Candidate locators → one element. The first candidate matching exactly one element wins. */
import type { Page, Locator, FrameLocator } from 'patchright';
import { RpaError, sleep } from './util.js';

export interface LocatorTry {
  candidate: number;
  matches: number;
}
export interface LocatorInfo {
  tried: LocatorTry[];
  hit: number | null;
}

type Root = Page | Locator | FrameLocator;

export function buildLocator(root: Root, c: any): Locator {
  let r: Root = root;
  if (c.frame) r = (root as Page).frameLocator(c.frame);
  let loc: Locator;
  const exact = c.exact;
  if (c.testid !== undefined) loc = r.getByTestId(c.testid);
  else if (c.role !== undefined) loc = r.getByRole(c.role, c.name !== undefined ? { name: c.name, exact } : {});
  else if (c.label !== undefined) loc = r.getByLabel(c.label, { exact });
  else if (c.placeholder !== undefined) loc = r.getByPlaceholder(c.placeholder, { exact });
  else if (c.text !== undefined) loc = r.getByText(c.text, { exact });
  else if (c.alt !== undefined) loc = r.getByAltText(c.alt, { exact });
  else if (c.title !== undefined) loc = r.getByTitle(c.title, { exact });
  else if (c.css !== undefined) loc = r.locator(c.css);
  else if (c.xpath !== undefined) loc = r.locator('xpath=' + c.xpath);
  else throw new RpaError('TEMPLATE_INVALID', 'locator candidate has no locator key');
  if (c.visible !== false) loc = loc.filter({ visible: true });
  if (c.nth !== undefined) loc = c.nth === -1 ? loc.last() : loc.nth(c.nth);
  return loc;
}

async function withinRoot(page: Page, c: any): Promise<Root | null> {
  if (!c.within) return page;
  for (const wc of c.within) {
    const l = buildLocator(page, wc);
    const n = await l.count().catch(() => 0);
    if (n >= 1) return l.first();
  }
  return null;
}

/** One pass over the candidates, no waiting. */
export async function tryTarget(page: Page, target: any[]): Promise<{ locator: Locator | null; info: LocatorInfo }> {
  const tried: LocatorTry[] = [];
  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    const root = await withinRoot(page, c);
    if (!root) {
      tried.push({ candidate: i, matches: 0 });
      continue;
    }
    const loc = buildLocator(root, c);
    const n = await loc.count().catch(() => 0);
    tried.push({ candidate: i, matches: n });
    if (n === 1) return { locator: loc, info: { tried, hit: i } };
  }
  return { locator: null, info: { tried, hit: null } };
}

/** Wait until some candidate matches exactly one element. */
export async function resolveTarget(page: Page, target: any[], timeoutMs: number): Promise<{ locator: Locator; info: LocatorInfo }> {
  const deadline = Date.now() + timeoutMs;
  let last: LocatorInfo = { tried: [], hit: null };
  for (;;) {
    const r = await tryTarget(page, target);
    last = r.info;
    if (r.locator) return { locator: r.locator, info: r.info };
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  const ambiguous = last.tried.some((t) => t.matches > 1);
  throw new RpaError(
    ambiguous ? 'LOCATOR_AMBIGUOUS' : 'LOCATOR_NOT_FOUND',
    ambiguous
      ? `no candidate matched exactly one element (${last.tried.map((t) => `#${t.candidate}:${t.matches}`).join(', ')}); add nth or within`
      : `no candidate matched any element after ${timeoutMs}ms`,
    { locator: last },
  );
}

/** Count matches of the first candidate that matches anything. */
export async function countTarget(page: Page, target: any[]): Promise<number> {
  for (const c of target) {
    const root = await withinRoot(page, c);
    if (!root) continue;
    const n = await buildLocator(root, c).count().catch(() => 0);
    if (n > 0) return n;
  }
  return 0;
}

export async function textOfTarget(page: Page, target: any[]): Promise<string | null> {
  for (const c of target) {
    const root = await withinRoot(page, c);
    if (!root) continue;
    const l = buildLocator(root, c);
    if ((await l.count().catch(() => 0)) > 0) return (await l.first().innerText().catch(() => null)) ?? null;
  }
  return null;
}
