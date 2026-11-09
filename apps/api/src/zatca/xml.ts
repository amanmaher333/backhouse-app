/*
 * A small XML element tree with canonical serialisation.
 *
 * Invoices are built as trees and written out already in canonical form (C14N:
 * no self-closing tags, sorted attributes, canonical escaping, no insignificant
 * whitespace). Hashes are then taken over exactly the bytes a C14N
 * implementation would produce for the same tree:
 * - the invoice hash: inclusive C14N 1.1 of the document without the signature
 *   parts (the transforms in the signature say so);
 * - the signed properties digest: exclusive C14N of that element, which declares
 *   each namespace on the first element that uses it.
 */

export interface El {
  name: string;
  attrs?: Record<string, string | number | undefined | null>;
  children?: (El | string | null | undefined | false)[];
}

type Child = El | string | null | undefined | false;

/** Build an element; null/undefined children and attributes are dropped, arrays are flattened. */
export function el(name: string, attrs?: El['attrs'] | Child[], ...children: (Child | Child[])[]): El {
  const flat = children.flat() as Child[];
  if (Array.isArray(attrs)) return { name, children: [...attrs, ...flat] };
  return { name, attrs, children: flat };
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

const prefixOf = (qname: string) => (qname.includes(':') ? qname.split(':')[0]! : '');

function splitAttrs(e: El) {
  const ns: [string, string][] = []; // [prefix ('' = default), uri]
  const plain: [string, string][] = [];
  for (const [k, v] of Object.entries(e.attrs ?? {})) {
    if (v === undefined || v === null) continue;
    if (k === 'xmlns') ns.push(['', String(v)]);
    else if (k.startsWith('xmlns:')) ns.push([k.slice(6), String(v)]);
    else plain.push([k, String(v)]);
  }
  return { ns, plain };
}

function renderAttrs(nsOut: [string, string][], plain: [string, string][], scope: Map<string, string>) {
  // Namespace declarations first (default first, then by prefix), then attributes by namespace URI then local name.
  nsOut.sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const keyed = plain.map(([k, v]) => {
    const p = prefixOf(k);
    return { k, v, uri: p ? (scope.get(p) ?? '') : '', local: p ? k.slice(p.length + 1) : k };
  });
  keyed.sort((a, b) => (a.uri !== b.uri ? (a.uri < b.uri ? -1 : 1) : a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
  return [...nsOut.map(([p, u]) => ` ${p ? `xmlns:${p}` : 'xmlns'}="${escAttr(u)}"`), ...keyed.map((a) => ` ${a.k}="${escAttr(a.v)}"`)].join('');
}

/** Inclusive canonical form (as C14N 1.0/1.1 renders a whole document or a subtree with no ancestors). */
export function c14n(e: El, rendered: Map<string, string> = new Map()): string {
  const { ns, plain } = splitAttrs(e);
  const scope = new Map(rendered);
  const out: [string, string][] = [];
  for (const [p, u] of ns) {
    if (rendered.get(p) !== u) out.push([p, u]);
    scope.set(p, u);
  }
  const inner = (e.children ?? []).filter((c): c is El | string => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'string' ? escText(c) : c14n(c, scope))).join('');
  return `<${e.name}${renderAttrs(out, plain, scope)}>${inner}</${e.name}>`;
}

/**
 * Exclusive canonical form of a subtree. `context` holds the namespaces in scope at
 * the subtree from its ancestors. Each prefix is declared where it is first used.
 */
export function excC14n(e: El, context: Map<string, string>, rendered: Map<string, string> = new Map()): string {
  const { ns, plain } = splitAttrs(e);
  const scope = new Map(context);
  for (const [p, u] of ns) scope.set(p, u);
  const used = new Set<string>([prefixOf(e.name), ...plain.map(([k]) => prefixOf(k)).filter((p) => p !== '')]);
  const out: [string, string][] = [];
  const nextRendered = new Map(rendered);
  for (const p of used) {
    const uri = scope.get(p);
    if (uri === undefined) {
      if (p === '') continue;
      throw new Error(`Namespace prefix ${p} is not declared`);
    }
    if (rendered.get(p) !== uri) {
      out.push([p, uri]);
      nextRendered.set(p, uri);
    }
  }
  const inner = (e.children ?? []).filter((c): c is El | string => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'string' ? escText(c) : excC14n(c, scope, nextRendered))).join('');
  return `<${e.name}${renderAttrs(out, plain, scope)}>${inner}</${e.name}>`;
}

/** Remove elements matching `drop` anywhere in the tree (returns a copy). */
export function without(e: El, drop: (x: El) => boolean): El {
  return {
    ...e,
    children: (e.children ?? []).filter((c) => !(c && typeof c !== 'string' && drop(c))).map((c) => (c && typeof c !== 'string' ? without(c, drop) : c)),
  };
}

export const xmlDocument = (root: El) => `<?xml version="1.0" encoding="UTF-8"?>\n${c14n(root)}`;
