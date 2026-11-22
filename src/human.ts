/** Humanized input on top of CDP trusted events: curved mouse paths, jittered timing, chunked wheel scrolling. */
import type { Page, Locator } from 'patchright';
import { sleep, randInt } from './util.js';

const mousePos = new WeakMap<Page, { x: number; y: number }>();

function bezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export async function moveMouse(page: Page, x: number, y: number) {
  const vp = page.viewportSize() ?? (await page.evaluate('({width: innerWidth, height: innerHeight})').catch(() => ({ width: 1200, height: 800 })) as any);
  const from = mousePos.get(page) ?? { x: randInt(vp.width * 0.3, vp.width * 0.7), y: randInt(vp.height * 0.3, vp.height * 0.7) };
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 14)));
  const spread = Math.min(120, dist * 0.3);
  const c1 = { x: from.x + (x - from.x) * 0.3 + randInt(-spread, spread), y: from.y + (y - from.y) * 0.3 + randInt(-spread, spread) };
  const c2 = { x: from.x + (x - from.x) * 0.7 + randInt(-spread, spread), y: from.y + (y - from.y) * 0.7 + randInt(-spread, spread) };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
    await page.mouse.move(bezier(from.x, c1.x, c2.x, x, e), bezier(from.y, c1.y, c2.y, y, e));
    await sleep(randInt(4, 14));
  }
  mousePos.set(page, { x, y });
}

async function pointIn(locator: Locator, timeout: number) {
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (!box) return null;
  const jx = box.width * 0.22, jy = box.height * 0.22;
  return { x: box.x + box.width / 2 + (Math.random() * 2 - 1) * jx, y: box.y + box.height / 2 + (Math.random() * 2 - 1) * jy };
}

export async function click(page: Page, locator: Locator, opts: { humanize: boolean; timeout: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }) {
  if (!opts.humanize) {
    await locator.click({ timeout: opts.timeout, button: opts.button, clickCount: opts.clickCount });
    return;
  }
  // trial: runs Playwright's actionability checks (visible, stable, enabled, not covered) without clicking
  await locator.click({ trial: true, timeout: opts.timeout });
  const pt = await pointIn(locator, opts.timeout);
  if (!pt) {
    await locator.click({ timeout: opts.timeout, button: opts.button });
    return;
  }
  await moveMouse(page, pt.x, pt.y);
  await sleep(randInt(60, 180));
  const n = opts.clickCount ?? 1;
  for (let i = 0; i < n; i++) {
    await page.mouse.down({ button: opts.button, clickCount: i + 1 });
    await sleep(randInt(40, 110));
    await page.mouse.up({ button: opts.button, clickCount: i + 1 });
    if (i < n - 1) await sleep(randInt(60, 120));
  }
}

export async function hover(page: Page, locator: Locator, opts: { humanize: boolean; timeout: number }) {
  if (!opts.humanize) return locator.hover({ timeout: opts.timeout });
  await locator.hover({ trial: true, timeout: opts.timeout });
  const pt = await pointIn(locator, opts.timeout);
  if (pt) await moveMouse(page, pt.x, pt.y);
}

export async function typeText(page: Page, text: string, delay: number | [number, number] | undefined, humanize: boolean) {
  if (!humanize && delay === undefined) {
    await page.keyboard.insertText(text);
    return;
  }
  const [lo, hi] = Array.isArray(delay) ? delay : delay !== undefined ? [delay, delay] : [45, 140];
  for (const ch of text) {
    await page.keyboard.type(ch);
    let d = randInt(lo, hi);
    if (humanize && Math.random() < 0.06) d += randInt(150, 450); // occasional thinking pause
    await sleep(d);
  }
}

export async function selectAllAndDelete(page: Page) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+A`);
  await sleep(randInt(30, 90));
  await page.keyboard.press('Backspace');
}

export async function wheel(page: Page, dy: number, humanize: boolean) {
  if (!mousePos.get(page)) {
    const vp = page.viewportSize() ?? ((await page.evaluate('({width: innerWidth, height: innerHeight})')) as any);
    const x = randInt(vp.width * 0.35, vp.width * 0.65), y = randInt(vp.height * 0.4, vp.height * 0.7);
    if (humanize) await moveMouse(page, x, y);
    else {
      await page.mouse.move(x, y);
      mousePos.set(page, { x, y });
    }
  }
  if (!humanize) {
    await page.mouse.wheel(0, dy);
    return;
  }
  let left = Math.abs(dy);
  const sign = Math.sign(dy) || 1;
  while (left > 0) {
    const chunk = Math.min(left, randInt(70, 140));
    await page.mouse.wheel(0, sign * chunk);
    left -= chunk;
    await sleep(randInt(12, 40));
  }
}
