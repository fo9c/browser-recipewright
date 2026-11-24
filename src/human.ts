/** Humanized input on top of CDP trusted events: curved mouse paths, jittered timing, chunked wheel scrolling. */
import type { Page, Locator, JSHandle } from 'patchright';
import { sleep, randInt, log } from './util.js';

const mousePos = new WeakMap<Page, { x: number; y: number }>();

/**
 * Optional observer of the humanized input on a page (the executor turns these into pointer.* / key.type events
 * for viewer plugins). It only reports what already happened: it never changes timing or behaviour.
 * Coordinates are CSS pixels relative to the page viewport. Typed text is never reported, only its length.
 */
export interface InputObserver {
  move?(to: { x: number; y: number }, from: { x: number; y: number }, ms: number): void;
  click?(at: { x: number; y: number }, button: string, count: number): void;
  wheel?(dy: number, at: { x: number; y: number } | null): void;
  type?(chars: number): void;
}
const observers = new WeakMap<Page, InputObserver>();
export function observeInput(page: Page, obs: InputObserver | null) {
  if (obs) observers.set(page, obs);
  else observers.delete(page);
}
function notify(page: Page, fn: (o: InputObserver) => void) {
  const o = observers.get(page);
  if (!o) return;
  try {
    fn(o);
  } catch {}
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export async function moveMouse(page: Page, x: number, y: number) {
  const vp = page.viewportSize() ?? (await page.evaluate('({width: innerWidth, height: innerHeight})').catch(() => ({ width: 1200, height: 800 })) as any);
  const from = mousePos.get(page) ?? { x: randInt(vp.width * 0.3, vp.width * 0.7), y: randInt(vp.height * 0.3, vp.height * 0.7) };
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 14)));
  const t0 = Date.now();
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
  notify(page, (o) => o.move?.({ x, y }, from, Date.now() - t0));
}

async function pointIn(locator: Locator, timeout: number) {
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (!box) return null;
  const jx = box.width * 0.22, jy = box.height * 0.22;
  return { x: box.x + box.width / 2 + (Math.random() * 2 - 1) * jx, y: box.y + box.height / 2 + (Math.random() * 2 - 1) * jy };
}

/**
 * Runs inside the page: is the element (or something inside it) really the topmost thing at (x, y)?
 * x/y and bx/by come from boundingBox(), which is relative to the top-level page; the element may sit in
 * an iframe, so the point is first shifted into the element's own frame.
 */
const HIT_TEST = (el: any, a: { x: number; y: number; bx: number; by: number }) => {
  const r = el.getBoundingClientRect();
  const x = a.x - (a.bx - r.left), y = a.y - (a.by - r.top);
  const root = el.getRootNode();
  const hit = (root && root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(x, y);
  if (!hit) return false;
  for (let n = hit; n; n = n.parentNode || n.host) if (n === el) return true;
  // clicking a <label> activates its control, so a label covering the target is fine
  if (hit.control === el) return true;
  if (el.labels) for (const l of Array.from(el.labels) as any[]) if (l.contains(hit)) return true;
  return false;
};

/**
 * After the mouse has travelled to the point, check again that the point is still on the target.
 * The mouse move takes a few hundred ms; if the user scrolled, resized or zoomed the window meanwhile,
 * or the page shifted, the old point may now be on something else.
 */
async function stillOnTarget(locator: Locator, pt: { x: number; y: number }): Promise<boolean> {
  const box = await locator.boundingBox({ timeout: 2000 }).catch(() => null);
  if (!box) return false;
  if (pt.x < box.x + 1 || pt.x > box.x + box.width - 1 || pt.y < box.y + 1 || pt.y > box.y + box.height - 1) return false;
  // if the hit test itself cannot run (unusual frames), fall back to the box check above
  return (locator as any).evaluate(HIT_TEST, { x: pt.x, y: pt.y, bx: box.x, by: box.y }, undefined, true).catch(() => true);
}

export async function click(page: Page, locator: Locator, opts: { humanize: boolean; timeout: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }) {
  if (!opts.humanize) {
    await locator.click({ timeout: opts.timeout, button: opts.button, clickCount: opts.clickCount });
    return;
  }
  // trial: runs Playwright's actionability checks (visible, stable, enabled, not covered) without clicking
  await locator.click({ trial: true, timeout: opts.timeout });
  for (let aim = 1; aim <= 3; aim++) {
    const pt = await pointIn(locator, opts.timeout);
    if (!pt) break;
    await moveMouse(page, pt.x, pt.y);
    await sleep(randInt(60, 180));
    if (!(await stillOnTarget(locator, pt))) {
      log.info(`    ↺ target moved or got covered while the mouse was on its way; aiming again (${aim}/3)`);
      continue;
    }
    const n = opts.clickCount ?? 1;
    for (let i = 0; i < n; i++) {
      await page.mouse.down({ button: opts.button, clickCount: i + 1 });
      await sleep(randInt(40, 110));
      await page.mouse.up({ button: opts.button, clickCount: i + 1 });
      if (i < n - 1) await sleep(randInt(60, 120));
    }
    notify(page, (o) => o.click?.(pt, opts.button ?? 'left', n));
    return;
  }
  // the page keeps changing under the mouse: let Playwright check and click in one quick go,
  // rather than pressing the mouse on a point that may now be something else
  await locator.click({ timeout: opts.timeout, button: opts.button, clickCount: opts.clickCount });
}

// ---------- keyboard focus ----------

/**
 * Runs inside the page: the element that should receive the keystrokes, or null.
 * Accepts the focused element when it is the target or inside it; when the target itself is not
 * editable (e.g. a fake search box that opens a real input when clicked), accepts any focused editable.
 */
const TYPING_TARGET = (el: any) => {
  let a = el.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  const editable = (x: any) =>
    !!x && (x.isContentEditable || x.tagName === 'TEXTAREA' ||
      (x.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes((x.type || '').toLowerCase())));
  if (!a || a === el.ownerDocument.body) return null;
  for (let n = a; n; n = n.parentNode || n.host) if (n === el) return a;
  if (!editable(el) && editable(a)) return a;
  return null;
};

/** Runs inside the page: is `el` still focused? If not, focus it again and put the caret at the end. */
const KEEP_FOCUS = (el: any) => {
  let a = el.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (a === el) return true;
  el.focus();
  try {
    if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') el.setSelectionRange(el.value.length, el.value.length);
    else if (el.isContentEditable) {
      const sel = el.ownerDocument.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {}
  return false;
};

export interface FocusGuard {
  /** Call before each keystroke: puts the focus back if the user (or the page) moved it away. */
  check(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * After clicking an input, make sure the keyboard focus really is there before typing, and keep it
 * there while typing. If the user clicks somewhere else in the page meanwhile, keystrokes would
 * otherwise land in the wrong field.
 */
export async function focusForTyping(page: Page, locator: Locator, opts: { humanize: boolean; timeout: number }): Promise<FocusGuard> {
  const noop: FocusGuard = { check: async () => {}, dispose: async () => {} };
  const find = async () => {
    const h = (await (locator as any).evaluateHandle(TYPING_TARGET, undefined, undefined, true).catch(() => null)) as JSHandle | null;
    if (h && h.asElement()) return h;
    await h?.dispose().catch(() => {});
    return null;
  };
  let h = await find();
  if (!h) {
    log.info('    ↺ the input is not focused (did something take the focus?); clicking it again');
    await click(page, locator, opts).catch(() => {});
    h = await find();
  }
  if (!h) {
    await locator.focus({ timeout: opts.timeout }).catch(() => {});
    h = await find();
  }
  if (!h) return noop; // focus went somewhere we cannot see (e.g. an editor in another frame): type as before
  const handle = h;
  let warned = false;
  return {
    async check() {
      const ok = await (handle as any).evaluate(KEEP_FOCUS, undefined, undefined, true).catch(() => true);
      if (!ok && !warned) {
        warned = true;
        log.info('    ↺ the input lost focus while typing (a click elsewhere?); focus restored, typing continues');
      }
    },
    dispose: () => handle.dispose().catch(() => {}),
  };
}

export async function hover(page: Page, locator: Locator, opts: { humanize: boolean; timeout: number }) {
  if (!opts.humanize) return locator.hover({ timeout: opts.timeout });
  await locator.hover({ trial: true, timeout: opts.timeout });
  const pt = await pointIn(locator, opts.timeout);
  if (pt) await moveMouse(page, pt.x, pt.y);
}

export async function typeText(page: Page, text: string, delay: number | [number, number] | undefined, humanize: boolean, guard?: FocusGuard) {
  if (!humanize && delay === undefined) {
    await guard?.check();
    await page.keyboard.insertText(text);
    notify(page, (o) => o.type?.(text.length));
    return;
  }
  const [lo, hi] = Array.isArray(delay) ? delay : delay !== undefined ? [delay, delay] : [45, 140];
  for (const ch of text) {
    await guard?.check();
    await page.keyboard.type(ch);
    let d = randInt(lo, hi);
    if (humanize && Math.random() < 0.06) d += randInt(150, 450); // occasional thinking pause
    await sleep(d);
  }
  notify(page, (o) => o.type?.([...text].length));
}

export async function selectAllAndDelete(page: Page, guard?: FocusGuard) {
  await guard?.check();
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
  notify(page, (o) => o.wheel?.(dy, mousePos.get(page) ?? null));
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
