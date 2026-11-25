/**
 * Template format v0 — zod schemas (source of truth for structure).
 * Conditions and variable references are checked by validate.ts, which gives
 * friendlier, step-addressed messages than a big recursive union would.
 */
import { z } from 'zod';
import { ANSWER_TYPES } from './ask.js';

const ms = z.union([z.number().int().nonnegative(), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])]);
const tmplNum = z.union([z.number(), z.string()]); // number or "{{inputs.count}}"

export const PRIMARY_LOCATOR_KEYS = ['testid', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'css', 'xpath'] as const;

export const Candidate: z.ZodType<any> = z.lazy(() =>
  z
    .strictObject({
      testid: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      text: z.string().optional(),
      alt: z.string().optional(),
      title: z.string().optional(),
      css: z.string().optional(),
      xpath: z.string().optional(),
      exact: z.boolean().optional(),
      within: Target.optional(),
      nth: z.number().int().optional(),
      visible: z.boolean().optional(),
      frame: z.string().optional(),
    })
    .refine((c: any) => PRIMARY_LOCATOR_KEYS.filter((k) => c[k] !== undefined).length === 1, {
      message: `each locator candidate needs exactly one of: ${PRIMARY_LOCATOR_KEYS.join(', ')}`,
    }),
);
export const Target: z.ZodType<any> = z.lazy(() => z.array(Candidate).min(1));

export const FieldSpec = z.strictObject({
  target: Target.optional(),
  text: z.boolean().optional(),
  attr: z.string().optional(),
  html: z.boolean().optional(),
  pattern: z.string().optional(),
  as: z.enum(['string', 'number', 'count', 'url', 'boolean']).optional(),
  optional: z.boolean().optional(),
  all: z.boolean().optional(),
  default: z.any().optional(),
});
const Fields = z.record(z.string(), FieldSpec);
const Cond = z.record(z.string(), z.any()); // deep-checked in validate.ts
const Steps = z.array(z.record(z.string(), z.any())); // nested steps validated recursively

const common = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'step id: letters, digits, - and _, starting with a letter'),
  action: z.string(),
  note: z.string().optional(),
  expect: Cond.optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().min(0).max(5).optional(),
  optional: z.boolean().optional(),
  saveAs: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
  appendTo: z
    .union([
      z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
      z.strictObject({ var: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), dedupeBy: z.string().optional() }),
    ])
    .optional(),
  screenshot: z.boolean().optional(),
};

const s = (extra: Record<string, z.ZodTypeAny>) => z.strictObject({ ...common, ...extra });

export const ACTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  goto: s({ url: z.string(), waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional() }),
  back: s({}),
  click: s({ target: Target, button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  fill: s({ target: Target, value: z.string() }),
  type: s({ target: Target, text: z.string(), delayMs: ms.optional(), clear: z.boolean().optional() }),
  press: s({ key: z.string(), target: Target.optional() }),
  hover: s({ target: Target }),
  select: s({ target: Target, option: z.union([z.string(), z.array(z.string())]) }),
  check: s({ target: Target, checked: z.boolean().optional() }),
  upload: s({ target: Target, files: z.union([z.string(), z.array(z.string())]) }),
  waitFor: s({
    target: Target.optional(),
    url: z.string().optional(),
    text: z.string().optional(),
    until: Cond.optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
  }),
  wait: s({ ms }),
  scroll: s({
    target: Target.optional(),
    by: z.union([z.number(), z.literal('page')]).optional(),
    to: z.enum(['top', 'bottom']).optional(),
    times: z.number().int().min(1).max(50).optional(),
  }),
  read: s({ target: Target, fields: Fields.optional(), text: z.boolean().optional(), attr: z.string().optional(), pattern: z.string().optional(), as: FieldSpec.shape.as }),
  queryAll: s({ target: Target, fields: Fields.optional(), limit: tmplNum.optional() }),
  collect: s({
    item: Target,
    fields: Fields,
    dedupeBy: z.string().optional(),
    filter: Cond.optional(),
    until: Cond.optional(),
    limit: tmplNum.optional(),
    offset: z.number().int().min(0).optional(),
    maxScrolls: z.number().int().min(0).max(500),
    scrollBy: z.union([z.number(), z.literal('page')]).optional(),
    scrollWaitMs: ms.optional(),
    stopAfterNoNew: z.number().int().min(1).optional(),
  }),
  download: s({ trigger: Target, filename: z.string().optional() }),
  runScript: s({ script: z.string(), args: z.any().optional() }),
  assert: s({ that: Cond, code: z.string().optional(), message: z.string().optional() }),
  handoff: s({ reason: z.string(), until: Cond.optional() }),
  // breakpoint: pause, hand question + data to the calling agent, continue with its answer (see ask.ts)
  ask: s({
    question: z.string().min(1),
    data: z.any().optional(),
    answer: z
      .strictObject({
        type: z.enum(ANSWER_TYPES).optional(),
        options: z.array(z.any()).min(1).optional(),
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(1).optional(),
        schema: z.any().optional(),
        hint: z.string().optional(),
      })
      .optional(),
    default: z.any().optional(),
  }),
  if: s({ when: Cond, then: Steps, else: Steps.optional() }),
  forEach: s({
    in: z.union([z.string(), z.array(z.any())]),
    as: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    do: Steps,
    max: tmplNum,
    continueOnError: z.boolean().optional(),
    collectFrom: z.any().optional(),
    flatten: z.boolean().optional(),
  }),
  while: s({ when: Cond, do: Steps, maxIterations: z.number().int().min(1).max(10000) }),
  group: s({ steps: Steps }),
  // run another recipe (a fragment) on the same page, in the same run: flows are recipes made of these + ask steps
  recipe: s({ recipe: z.string().min(1), inputs: z.record(z.string(), z.any()).optional() }),
};

export const ATOMIC_ACTIONS = Object.keys(ACTION_SCHEMAS).filter((a) => !['if', 'forEach', 'while', 'group', 'recipe'].includes(a));
export const TARGET_ACTIONS = ['click', 'fill', 'type', 'hover', 'select', 'check', 'upload', 'read', 'queryAll'];

export const InputDef = z.strictObject({
  type: z.enum(['string', 'integer', 'number', 'boolean', 'array', 'object']),
  default: z.any().optional(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.any()).optional(),
});

export const TemplateSchema = z.strictObject({
  $schema: z.string().optional(),
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver like 0.1.0'),
  title: z.string().min(1),
  description: z.string().optional(),
  /** "recipe": one fixed fragment of work · "flow": strings recipes and breakpoints together (informational) */
  kind: z.enum(['recipe', 'flow']).optional(),
  tags: z.array(z.string()).optional(),
  site: z.array(z.string()).min(1),
  account: z
    .strictObject({
      platform: z.string().optional(),
      loginCheck: Cond.optional(),
      checkUrl: z.string().optional(),
      loginUrl: z.string().optional(),
    })
    .optional(),
  inputs: z.record(z.string(), InputDef).optional(),
  /**
   * Where this fragment starts. If the browser already satisfies `when`, the recipe starts right there (an agent
   * chaining fragments in one browser); otherwise it opens `goto` first, or fails with START_PAGE_MISMATCH.
   */
  startOn: z.strictObject({ when: Cond, goto: z.string().optional() }).optional(),
  defaults: z
    .strictObject({
      timeoutMs: z.number().int().positive().optional(),
      retries: z.number().int().min(0).max(5).optional(),
      stepGapMs: ms.optional(),
      humanize: z.boolean().optional(),
      screenshots: z.enum(['failure', 'every', 'none']).optional(),
    })
    .optional(),
  steps: Steps.min(1),
  outputs: z.strictObject({ from: z.string(), schema: z.any().optional() }).optional(),
  provenance: z.any().optional(),
});

export type Template = z.infer<typeof TemplateSchema>;
export type Step = Record<string, any> & { id: string; action: string };

/** Build a JSON Schema document for editors / other languages. */
export function buildJsonSchema(): any {
  const defs: Record<string, any> = {};
  const conv = (sch: z.ZodTypeAny) => z.toJSONSchema(sch, { unrepresentable: 'any', io: 'input' }) as any;
  for (const [name, sch] of Object.entries(ACTION_SCHEMAS)) {
    const j = conv(sch);
    delete j.$schema;
    j.properties.action = { const: name };
    defs['step_' + name] = j;
  }
  const root = conv(TemplateSchema);
  delete root.$schema;
  root.properties.steps = { type: 'array', minItems: 1, items: { $ref: '#/$defs/step' } };
  defs.step = { oneOf: Object.keys(ACTION_SCHEMAS).map((n) => ({ $ref: '#/$defs/step_' + n })) };
  // nested steps reference the step union
  for (const n of ['if', 'forEach', 'while', 'group']) {
    const p = defs['step_' + n].properties;
    for (const k of ['then', 'else', 'do', 'steps']) if (p[k]) p[k] = { type: 'array', items: { $ref: '#/$defs/step' } };
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/fo9c/browser-recipewright/main/schema/template.v0.json',
    title: 'browser-recipewright template v0',
    ...root,
    $defs: { ...(root.$defs || {}), ...defs },
  };
}

/** Names of all list variables filled by `appendTo` anywhere in the steps. */
export function appendTargets(steps: any[], acc = new Set<string>()): Set<string> {
  for (const s of steps || []) {
    if (s.appendTo) acc.add(typeof s.appendTo === 'string' ? s.appendTo : s.appendTo.var);
    for (const k of ['do', 'then', 'else', 'steps']) if (Array.isArray(s[k])) appendTargets(s[k], acc);
  }
  return acc;
}
