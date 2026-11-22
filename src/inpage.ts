/**
 * Code that runs inside the page. patchright evaluates it in an isolated world, so the page's own
 * scripts cannot see or tamper with it. Kept as plain JS source (no bundler helpers) on purpose.
 */
export const INPAGE_LIB = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const IMPLICIT = {
    A: (el) => (el.hasAttribute('href') ? 'link' : null), BUTTON: () => 'button', SELECT: () => 'combobox',
    TEXTAREA: () => 'textbox', IMG: (el) => (el.getAttribute('alt') === '' ? 'presentation' : 'img'),
    H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    NAV: () => 'navigation', MAIN: () => 'main', HEADER: () => 'banner', FOOTER: () => 'contentinfo', ASIDE: () => 'complementary',
    FORM: () => 'form', DIALOG: () => 'dialog', ARTICLE: () => 'article', UL: () => 'list', OL: () => 'list', LI: () => 'listitem',
    TABLE: () => 'table', SECTION: (el) => (el.hasAttribute('aria-label') ? 'region' : null),
    INPUT: (el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'range') return 'slider';
      if (t === 'hidden') return null;
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    },
  };
  const role = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r.split(' ')[0];
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    const f = IMPLICIT[el.tagName];
    return f ? f(el) : null;
  };
  const accName = (el) => {
    const al = el.getAttribute('aria-label');
    if (al) return norm(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.innerText || e.textContent).join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt'));
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      if (el.id) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) return norm(l.innerText);
      }
      const pl = el.closest('label');
      if (pl) return norm(pl.innerText);
      if (el.type === 'submit' || el.type === 'button') return norm(el.value);
      return norm(el.getAttribute('title') || el.getAttribute('placeholder'));
    }
    const t = norm(el.innerText || el.textContent);
    if (t) return t.slice(0, 120);
    return norm(el.getAttribute('title'));
  };
  const textMatch = (actual, want, exact) => {
    const a = norm(actual), w = norm(want);
    return exact ? a === w : a.toLowerCase().includes(w.toLowerCase());
  };
  const all = (root, sel) => Array.from(root.querySelectorAll(sel));
  const findAllRaw = (root, c) => {
    if (c.testid !== undefined) return all(root, '[data-testid="' + CSS.escape(c.testid) + '"]');
    if (c.css !== undefined) return all(root, c.css);
    if (c.xpath !== undefined) {
      const res = document.evaluate(c.xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
      return out;
    }
    if (c.placeholder !== undefined) return all(root, '[placeholder]').filter((e) => textMatch(e.getAttribute('placeholder'), c.placeholder, c.exact));
    if (c.alt !== undefined) return all(root, '[alt]').filter((e) => textMatch(e.getAttribute('alt'), c.alt, c.exact));
    if (c.title !== undefined) return all(root, '[title]').filter((e) => textMatch(e.getAttribute('title'), c.title, c.exact));
    if (c.label !== undefined) return all(root, 'input,textarea,select,[aria-label],[aria-labelledby]').filter((e) => textMatch(accName(e), c.label, c.exact));
    if (c.role !== undefined) {
      return all(root, '*').filter((e) => role(e) === c.role && (c.name === undefined || textMatch(accName(e), c.name, c.exact)));
    }
    if (c.text !== undefined) {
      const hits = all(root, '*').filter((e) => !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(e.tagName) && textMatch(e.innerText || e.textContent, c.text, c.exact));
      return hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    }
    return [];
  };
  const findAll = (root, c) => {
    let roots = [root];
    if (c.within) {
      const w = resolveFirst(root, c.within);
      roots = w ? [w] : [];
    }
    let els = [];
    for (const r of roots) els = els.concat(findAllRaw(r, c));
    if (c.visible !== false) els = els.filter(isVisible);
    if (c.nth !== undefined) {
      const i = c.nth < 0 ? els.length + c.nth : c.nth;
      els = els[i] ? [els[i]] : [];
    }
    return els;
  };
  const resolveFirst = (root, target) => {
    for (const c of target) {
      const els = findAll(root, c);
      if (els.length) return els[0];
    }
    return null;
  };
  const rawField = (el, f) => {
    let els = [el];
    if (f.target) {
      els = [];
      for (const c of f.target) {
        const found = findAll(el, c);
        if (found.length) { els = found; break; }
      }
    }
    if (!els.length) return { found: false, raw: null };
    const one = (e) => {
      if (f.attr) {
        if (f.as === 'url' && (f.attr === 'href' || f.attr === 'src')) return e[f.attr] || e.getAttribute(f.attr);
        return e.getAttribute(f.attr);
      }
      if (f.html) return e.innerHTML;
      return norm(e.innerText || e.textContent);
    };
    return { found: true, raw: f.all ? els.map(one) : one(els[0]) };
  };
  const extractFrom = (el, fields) => {
    const out = {};
    for (const k of Object.keys(fields)) out[k] = rawField(el, fields[k]);
    return out;
  };
  const scrollInfo = () => {
    const se = document.scrollingElement || document.documentElement;
    return { y: se.scrollTop, h: se.scrollHeight, vh: window.innerHeight, atBottom: se.scrollTop + window.innerHeight >= se.scrollHeight - 80 };
  };
  const extractItems = (arg) => {
    let used = -1, els = [];
    for (let i = 0; i < arg.item.length; i++) {
      const found = findAll(document, arg.item[i]);
      if (found.length) { used = i; els = found; break; }
    }
    if (arg.max) els = els.slice(0, arg.max);
    const items = arg.fields ? els.map((e) => extractFrom(e, arg.fields)) : els.map((e) => ({ text: { found: true, raw: norm(e.innerText) } }));
    return { candidate: used, total: els.length, items, scroll: scrollInfo() };
  };
  const countTarget = (target) => target.map((c) => findAll(document, c).length);
  const detectChallenge = () => {
    const u = location.href;
    if (/\/account\/access|\/challenge|captcha|\/sorry\/|cdn-cgi\/challenge/i.test(u)) return 'url:' + u;
    const sel = ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="arkoselabs"]', 'iframe[src*="challenges.cloudflare.com"]', '#challenge-form', '[id^="cf-chl"]', 'iframe[src*="captcha"]'];
    for (const s of sel) { const e = document.querySelector(s); if (e && isVisible(e)) return 'element:' + s; }
    return null;
  };

  // ---------- snapshot for AI exploration ----------
  const INTERACTIVE_ROLES = new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','tab','menuitem','option','switch','slider']);
  const STRUCT_ROLES = new Set(['heading','navigation','main','dialog','article','form','region','banner','complementary']);
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 5) {
      if (e.id && /^[a-zA-Z][\w-]{1,40}$/.test(e.id) && !/\d{3,}/.test(e.id)) { parts.unshift('#' + CSS.escape(e.id)); break; }
      const tid = e.getAttribute('data-testid');
      if (tid) { parts.unshift('[data-testid="' + tid + '"]'); if (parts.length > 1) break; e = e.parentElement; continue; }
      let s = e.tagName.toLowerCase();
      const sib = e.parentElement ? Array.from(e.parentElement.children).filter((x) => x.tagName === e.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(s);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const candidatesFor = (el) => {
    const cands = [];
    const push = (c) => {
      const els = findAll(document, c);
      if (!els.length) return;
      if (els.length === 1) cands.push(c);
      else { const i = els.indexOf(el); if (i >= 0) cands.push(Object.assign({}, c, { nth: i })); }
    };
    const tid = el.getAttribute('data-testid');
    if (tid) push({ testid: tid });
    const r = role(el), n = accName(el);
    if (r && n && n.length <= 80) push({ role: r, name: n, exact: true });
    const ph = el.getAttribute('placeholder');
    if (ph) push({ placeholder: ph });
    if ((r === 'link' || r === 'button' || r === 'tab') && n && n.length <= 40 && !el.getAttribute('aria-label')) push({ text: n, exact: true });
    push({ css: cssPath(el) });
    return cands.slice(0, 4);
  };
  const snapshot = (opts) => {
    const max = opts.max || 300;
    const lines = [], refs = {};
    let n = 0, truncated = false;
    const walk = (el, depth) => {
      if (n >= max) { truncated = true; return; }
      if (!el || el.nodeType !== 1 || ['SCRIPT','STYLE','NOSCRIPT','SVG','svg','TEMPLATE'].includes(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const r = role(el);
      const tid = el.getAttribute('data-testid');
      const interesting = (r && (INTERACTIVE_ROLES.has(r) || STRUCT_ROLES.has(r))) || !!tid || el.isContentEditable && el.getAttribute('contenteditable') !== null;
      let d = depth;
      if (interesting && isVisible(el)) {
        n++;
        const ref = 'r' + n;
        const LABEL_ONLY = ['main','navigation','region','form','banner','complementary','dialog','list','table'];
        const name = r && LABEL_ONLY.includes(r) ? norm(el.getAttribute('aria-label')) : accName(el);
        let line = '  '.repeat(depth) + '- ' + (r || el.tagName.toLowerCase());
        if (name) line += ' "' + name.slice(0, 80).replace(/"/g, "'") + '"';
        if (tid) line += ' [testid=' + tid + ']';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') line += ' [value="' + String(el.value || '').slice(0, 40) + '"]';
        if (r === 'checkbox' || r === 'switch') line += el.checked || el.getAttribute('aria-checked') === 'true' ? ' [checked]' : '';
        if (r === 'link' && el.getAttribute('href')) line += ' [href=' + el.getAttribute('href').slice(0, 80) + ']';
        line += ' [ref=' + ref + ']';
        lines.push(line);
        refs[ref] = candidatesFor(el);
        d = depth + 1;
      }
      if (opts.text && !interesting && isVisible(el)) {
        let own = '';
        for (const nd of el.childNodes) if (nd.nodeType === 3) own += nd.textContent;
        own = norm(own);
        if (own.length > 1 && n < max) { n++; lines.push('  '.repeat(depth) + '- text "' + own.slice(0, 100).replace(/"/g, "'") + '"'); }
      }
      for (const ch of el.children) walk(ch, d);
      if (el.shadowRoot) for (const ch of el.shadowRoot.children) walk(ch, d);
    };
    walk(document.body, 0);
    return { url: location.href, title: document.title, text: lines.join('\n'), refs, truncated, scroll: scrollInfo() };
  };

  return { norm, isVisible, role, accName, findAll, extractFrom, extractItems, countTarget, detectChallenge, snapshot, scrollInfo };
})()`;

/** Build an expression that calls lib.<fn>(arg). */
export function inpageCall(fn: string, arg?: unknown): string {
  return `${INPAGE_LIB}.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`;
}

/**
 * A real function for locator.evaluate(el => ...). Built with new Function so Playwright serializes it
 * via toString() and calls it with the element (a plain string would be treated as an expression).
 */
export function inpageElementFn(fn: string): (el: any, arg: any) => any {
  return new Function('el', 'arg', `return ${INPAGE_LIB}.${fn}(el, arg);`) as any;
}
