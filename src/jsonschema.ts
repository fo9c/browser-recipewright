/** Tiny JSON Schema subset validator for template outputs (type, required, properties, items, minItems, maxItems, enum). */
export function checkSchema(value: any, schema: any, p = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const errs: string[] = [];
  const typeOf = (v: any) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((x: string) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) return [`${p}: expected ${types.join('|')}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${p}: not one of ${JSON.stringify(schema.enum)}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${p}: needs at least ${schema.minItems} items, got ${value.length}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${p}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...checkSchema(v, schema.items, `${p}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const k of schema.required || []) if (value[k] === undefined || value[k] === null) errs.push(`${p}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) errs.push(...checkSchema(value[k], s, `${p}.${k}`));
  } else if (schema.required && value == null) errs.push(`${p}: required object missing`);
  return errs.slice(0, 50);
}
