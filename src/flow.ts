/**
 * Fragments and flows.
 *
 * A recipe is a fixed fragment of work ("search and collect 30 posts"). The agent strings fragments together while
 * it works, deciding the next one from what the last one returned. When a way of working proves itself it can be
 * saved as a flow: a recipe whose steps are mostly `recipe` calls (the fixed parts) and `ask` steps (the judgment
 * points). Everything runs in the same browser, with the same human-like input and one run record.
 *
 * This module resolves the recipes a template calls and checks the calls statically (they exist, are valid,
 * get the inputs they need, and do not call each other in a circle).
 */
import path from 'node:path';
import fs from 'node:fs';
import { loadTemplate, type LoadedTemplate } from './library.js';
import { validateTemplate, type Issue } from './validate.js';
import { RecipeError } from './util.js';

/** Most nested recipe calls allowed (flow → recipe → recipe …). */
export const MAX_RECIPE_DEPTH = 4;

/** A recipe reference: a library id ("example.com/search"), or a file path; "./x.json" is relative to the caller's file. */
export function resolveRecipe(ref: string, fromPath?: string): LoadedTemplate {
  if ((ref.startsWith('./') || ref.startsWith('../')) && fromPath && fromPath !== '(act)') {
    const p = path.resolve(path.dirname(fromPath), ref);
    if (fs.existsSync(p)) return loadTemplate(p);
    throw new RecipeError('TEMPLATE_NOT_FOUND', `recipe "${ref}" not found next to ${fromPath} (looked for ${p})`);
  }
  return loadTemplate(ref);
}

function eachRecipeStep(steps: any[], base: string, fn: (s: any, p: string) => void) {
  (steps || []).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const p = `${base}[${i}]`;
    if (s.action === 'recipe') fn(s, p);
    for (const k of ['do', 'then', 'else', 'steps']) if (Array.isArray(s[k])) eachRecipeStep(s[k], `${p}.${k}`, fn);
  });
}

/** Static check of every `recipe` step (recursively). Errors here block a run, like validate errors. */
export function checkRecipeCalls(tpl: any, fromPath: string | undefined, chain: string[] = []): Issue[] {
  const issues: Issue[] = [];
  const me = tpl?.id ?? '?';
  eachRecipeStep(tpl?.steps, 'steps', (s, p) => {
    if (typeof s.recipe !== 'string') return;
    const add = (message: string, level: Issue['level'] = 'error') => issues.push({ level, stepId: s.id ?? null, path: `${p}.recipe`, message });
    let sub: LoadedTemplate;
    try {
      sub = resolveRecipe(s.recipe, fromPath);
    } catch (e: any) {
      return add(e.message);
    }
    const subId = sub.template?.id ?? s.recipe;
    if ([...chain, me].includes(subId)) return add(`recipes call each other in a circle: ${[...chain, me, subId].join(' → ')}`);
    if (chain.length + 1 >= MAX_RECIPE_DEPTH) return add(`recipe calls are nested more than ${MAX_RECIPE_DEPTH} deep`);
    const v = validateTemplate(sub.template);
    if (!v.ok) return add(`recipe "${subId}" is invalid (${v.errors.length} error(s)); run: browser-recipewright validate ${sub.path}`);
    const defs = sub.template.inputs || {};
    const given = s.inputs || {};
    for (const k of Object.keys(given)) if (!(k in defs)) add(`recipe "${subId}" has no input "${k}" (it accepts: ${Object.keys(defs).join(', ') || 'none'})`);
    for (const [k, d] of Object.entries<any>(defs)) {
      if (!(k in given) && d.default === undefined && d.required !== false) add(`recipe "${subId}" needs input "${k}"${d.description ? ` (${d.description})` : ''}`);
    }
    if (!sub.template.startOn) add(`recipe "${subId}" has no startOn: it will run from wherever the browser is; give it startOn so it can check (or open) its start page`, 'warning');
    for (const i of checkRecipeCalls(sub.template, sub.path, [...chain, me])) issues.push({ ...i, path: `${p} → ${subId}: ${i.path}` });
  });
  return issues;
}
