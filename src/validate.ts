/** Static validation: finds template problems without opening a browser. */
import { ACTION_SCHEMAS, TemplateSchema, Target, PRIMARY_LOCATOR_KEYS, TARGET_ACTIONS } from './schema.js';
import { findRefs, parseExpr, FILTERS } from './render.js';
import { CONDITION_KEYS, conditionTargets } from './conditions.js';
import { checkScript, hostMatches } from './scripts.js';

export interface Issue {
  level: 'error' | 'warning';
  stepId: string | null;
  path: string;
  message: string;
}
export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

const zodIssues = (err: any, base: string) =>
  (err.issues || []).map((i: any) => {
    const field = i.path.length ? String(i.path[i.path.length - 1]) : '';
    let message = /received undefined/.test(i.message) ? 'required field is missing' : i.message;
    if (i.code === 'unrecognized_keys') message = `unknown field(s): ${i.keys.join(', ')}`;
    return { path: [base, ...i.path].filter((x) => x !== '').join('.'), message: field && !/^\d+$/.test(field) ? `"${field}": ${message}` : message };
  });

export function validateTemplate(tpl: any): ValidationResult {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], stepId: string | null, path: string, message: string) => issues.push({ level, stepId, path, message });

  const top = TemplateSchema.safeParse(tpl);
  if (!top.success) for (const i of zodIssues(top.error, '')) if (!/^steps\.\d+\./.test(i.path)) add('error', null, i.path, i.message);
  if (!tpl || typeof tpl !== 'object' || !Array.isArray(tpl.steps)) return finish(issues);

  const site: string[] = Array.isArray(tpl.site) ? tpl.site : [];
  const inputs: Record<string, any> = tpl.inputs || {};
  const secretInputs = new Set(Object.entries(inputs).filter(([, d]: any) => d?.secret).map(([k]) => k));
  const seenIds = new Map<string, string>();
  const savedAt = new Map<string, string>();
  const declaredVars = new Set<string>();
  const hasGap = !!tpl.defaults?.stepGapMs;
  const screenshotsEvery = tpl.defaults?.screenshots === 'every';

  const checkRefs = (value: any, stepId: string | null, path: string, extraRoots: Set<string>) => {
    for (const expr of findRefs(value)) {
      let parsed;
      try {
        parsed = parseExpr(expr);
      } catch (e: any) {
        add('error', stepId, path, e.message);
        continue;
      }
      for (const f of parsed.filters) if (!FILTERS[f]) add('error', stepId, path, `unknown filter "${f}" in {{${expr}}}`);
      const [root, second] = parsed.path;
      if (root === 'inputs') {
        if (!(second in inputs)) add('error', stepId, path, `{{${expr}}}: input "${second}" is not declared in inputs`);
      } else if (root === 'vars') {
        if (!declaredVars.has(second)) add('error', stepId, path, `{{${expr}}}: variable "${second}" is not produced by any earlier step (saveAs)`);
      } else if (root === 'account' || root === 'env') {
        // runtime-bound
      } else if (!extraRoots.has(root)) {
        add('error', stepId, path, `{{${expr}}}: unknown reference root "${root}" (use inputs., vars., account., or a loop variable)`);
      }
    }
  };

  const checkTarget = (t: any, stepId: string, path: string) => {
    const r = Target.safeParse(t);
    if (!r.success) {
      for (const i of zodIssues(r.error, path)) add('error', stepId, i.path, i.message);
      return;
    }
    const prim = (c: any) => PRIMARY_LOCATOR_KEYS.find((k) => c[k] !== undefined)!;
    const kinds = t.map(prim);
    if (t.length === 1) add('warning', stepId, path, 'only one locator candidate; add a fallback (testid / role+name / text / css)');
    if (kinds.every((k: string) => k === 'css' || k === 'xpath')) add('warning', stepId, path, 'only css/xpath locators; prefer testid or role+name');
    if (kinds.includes('xpath')) add('warning', stepId, path, 'xpath is the least stable locator; use only as last resort');
  };

  const checkCond = (c: any, stepId: string | null, path: string, roots: Set<string>) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return add('error', stepId, path, 'condition must be an object like {"exists": [...]}');
    const keys = Object.keys(c);
    if (keys.length !== 1) return add('error', stepId, path, `condition must have exactly one key, got [${keys.join(', ')}]`);
    const k = keys[0];
    if (!(CONDITION_KEYS as readonly string[]).includes(k)) return add('error', stepId, path, `unknown condition "${k}" (allowed: ${CONDITION_KEYS.join(', ')})`);
    const v = c[k];
    if (k === 'and' || k === 'or') {
      if (!Array.isArray(v) || !v.length) return add('error', stepId, path, `${k} needs a non-empty array`);
      v.forEach((x: any, i: number) => checkCond(x, stepId, `${path}.${k}[${i}]`, roots));
    } else if (k === 'not') checkCond(v, stepId, `${path}.not`, roots);
    else if (['exists', 'notExists', 'visible', 'hidden'].includes(k)) {
      const r = Target.safeParse(v);
      if (!r.success) for (const i of zodIssues(r.error, `${path}.${k}`)) add('error', stepId, i.path, i.message);
    } else if (k === 'textContains') {
      if (!Array.isArray(v) || v.length !== 2) add('error', stepId, path, 'textContains needs [target, "text"]');
    } else if (!['urlContains', 'urlMatches', 'truthy', 'empty'].includes(k)) {
      if (!Array.isArray(v) || v.length !== 2) add('error', stepId, path, `${k} needs a two-item array [a, b]`);
    }
    if (k === 'matches' || k === 'urlMatches') {
      const pat = k === 'matches' ? v?.[1] : v;
      if (typeof pat === 'string' && !pat.includes('{{')) {
        try { new RegExp(pat); } catch { add('error', stepId, path, `invalid regex ${pat}`); }
      }
    }
    checkRefs(v, stepId, path, roots);
    void conditionTargets;
  };

  const loopMax = (s: any): number => {
    if (s.action === 'forEach') return typeof s.max === 'number' ? s.max : 20;
    if (s.action === 'while') return s.maxIterations || 0;
    if (s.action === 'collect') return s.maxScrolls || 0;
    return 0;
  };
  let bigLoop = false;

  const walk = (steps: any[], base: string, roots: Set<string>) => {
    if (!Array.isArray(steps)) return add('error', null, base, 'expected an array of steps');
    steps.forEach((s, idx) => {
      const p = `${base}[${idx}]`;
      if (!s || typeof s !== 'object') return add('error', null, p, 'step must be an object');
      const sid: string = s.id ?? null;
      if (sid) {
        if (seenIds.has(sid)) add('error', sid, p, `duplicate step id "${sid}" (also at ${seenIds.get(sid)})`);
        else seenIds.set(sid, p);
      }
      const sch = ACTION_SCHEMAS[s.action];
      if (!sch) return add('error', sid, `${p}.action`, `unknown action "${s.action}" (allowed: ${Object.keys(ACTION_SCHEMAS).join(', ')})`);
      const r = sch.safeParse(s);
      if (!r.success) for (const i of zodIssues(r.error, p)) add('error', sid, i.path, i.message);

      // targets
      if (s.target) checkTarget(s.target, sid, `${p}.target`);
      if (s.item) checkTarget(s.item, sid, `${p}.item`);
      if (s.trigger) checkTarget(s.trigger, sid, `${p}.trigger`);
      if (TARGET_ACTIONS.includes(s.action) && !s.target) add('error', sid, p, `action "${s.action}" needs a target`);

      // references in plain fields (not nested steps / conditions handled separately)
      const skip = new Set(['do', 'then', 'else', 'steps', 'expect', 'when', 'that', 'until', 'filter', 'collectFrom', 'fields', 'item']);
      const plain: any = {};
      for (const [k, v] of Object.entries(s)) if (!skip.has(k)) plain[k] = v;
      checkRefs(plain, sid, p, roots);
      if (s.fields) checkRefs(s.fields, sid, `${p}.fields`, roots);
      if (s.expect) checkCond(s.expect, sid, `${p}.expect`, roots);

      // per action
      switch (s.action) {
        case 'goto': {
          if (typeof s.url === 'string') {
            const staticUrl = s.url.replace(/\{\{[^}]*\}\}/g, '');
            if (/^\{\{/.test(s.url)) add('warning', sid, `${p}.url`, 'url host comes from a variable; domain is only checked at run time');
            else {
              try {
                const host = new URL(staticUrl).hostname;
                if (!site.some((d) => hostMatches(host, d))) add('error', sid, `${p}.url`, `host "${host}" is not in site [${site.join(', ')}]`);
              } catch {
                add('error', sid, `${p}.url`, `not an absolute URL: ${s.url}`);
              }
            }
          }
          if (!s.expect) add('warning', sid, p, 'goto without expect; add {"urlContains": ...} or {"exists": [...]}');
          break;
        }
        case 'click':
          if (!s.expect) add('warning', sid, p, 'click without expect; failures may only surface steps later');
          break;
        case 'runScript': {
          const err = typeof s.script === 'string' ? checkScript(s.script, site) : 'script name missing';
          if (err) add('error', sid, `${p}.script`, err);
          if (s.optional) add('error', sid, p, 'runScript cannot be optional');
          break;
        }
        case 'assert':
          checkCond(s.that, sid, `${p}.that`, roots);
          break;
        case 'handoff':
          if (s.until) checkCond(s.until, sid, `${p}.until`, roots);
          break;
        case 'waitFor':
          if (!s.target && !s.url && !s.text && !s.until) add('error', sid, p, 'waitFor needs one of target / url / text / until');
          if (s.until) checkCond(s.until, sid, `${p}.until`, roots);
          break;
        case 'collect': {
          const inner = new Set([...roots, 'item', 'self']);
          if (s.filter) checkCond(s.filter, sid, `${p}.filter`, inner);
          if (s.until) checkCond(s.until, sid, `${p}.until`, inner);
          if (s.dedupeBy && s.fields && !(s.dedupeBy in s.fields)) add('error', sid, `${p}.dedupeBy`, `dedupeBy "${s.dedupeBy}" is not one of the fields`);
          if (!s.dedupeBy) add('warning', sid, p, 'collect without dedupeBy: items seen twice while scrolling will be duplicated');
          break;
        }
        case 'if':
          checkCond(s.when, sid, `${p}.when`, roots);
          walk(s.then, `${p}.then`, roots);
          if (s.else) walk(s.else, `${p}.else`, roots);
          break;
        case 'while':
          checkCond(s.when, sid, `${p}.when`, roots);
          walk(s.do, `${p}.do`, roots);
          break;
        case 'group':
          walk(s.steps, `${p}.steps`, roots);
          break;
        case 'forEach': {
          if (typeof s.in === 'string') checkRefs(s.in, sid, `${p}.in`, roots);
          const inner = new Set([...roots, s.as]);
          walk(s.do, `${p}.do`, inner);
          if (s.collectFrom !== undefined) checkRefs(s.collectFrom, sid, `${p}.collectFrom`, inner);
          break;
        }
      }
      if (loopMax(s) > 20) bigLoop = true;

      // screenshots + secrets
      if ((s.screenshot || screenshotsEvery) && secretInputs.size) {
        const used = findRefs(s).some((e) => [...secretInputs].some((k) => e.includes(`inputs.${k}`)));
        if (used) add('warning', sid, p, 'step uses a secret input while screenshots are on');
      }

      if (s.saveAs) {
        if (savedAt.has(s.saveAs)) add('error', sid, `${p}.saveAs`, `variable "${s.saveAs}" is already saved by step at ${savedAt.get(s.saveAs)}`);
        else savedAt.set(s.saveAs, p);
        declaredVars.add(s.saveAs);
      }
    });
  };

  walk(tpl.steps, 'steps', new Set());
  if (tpl.account?.loginCheck) checkCond(tpl.account.loginCheck, null, 'account.loginCheck', new Set());
  if (tpl.outputs?.from) checkRefs(tpl.outputs.from, null, 'outputs.from', new Set());
  if (bigLoop && !hasGap) add('warning', null, 'defaults.stepGapMs', 'loops over 20 rounds with no step gap; add defaults.stepGapMs to avoid looking like a bot');
  return finish(issues);
}

function finish(all: Issue[]): ValidationResult {
  const seen = new Set<string>();
  const issues = all.filter((i) => {
    const k = `${i.level}|${i.stepId}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}
