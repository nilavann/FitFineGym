import { describe, expect, it } from 'vitest';
import { expectScanned, readSourceFiles } from '../test/source-files';

/**
 * PostgREST's string filters (`.or()`, `.filter()`, `.not()`, `.like()`, `.ilike()`, `.textSearch()`) take
 * a filter *expression*: a value spliced into one with a template literal or `+` can add its own
 * conditions (`a,id.gt.0`). Values reach a query only through `.eq` / `.in` or as an RPC parameter
 * (spec/frontend/backend-api.md §8; the Edge Functions have the same guard in
 * supabase/functions/_tests/source-scan.test.ts). `Array.prototype.filter` takes a function, so a
 * `.filter(` call is flagged only when its first argument is a string.
 */
const STRING_FILTER = /\.\s*(or|not|like|ilike|textSearch)\s*\(([^)]*)\)|\.\s*filter\s*\(\s*(['"`][^)]*)\)/g;

/** Comments blanked out, so prose can't trip or hide a match. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

/** Each string-filter call whose arguments are built from a template literal or concatenation. */
function builtFilterCalls(code: string): string[] {
  const hits: string[] = [];
  for (const match of stripComments(code).matchAll(STRING_FILTER)) {
    const args = match[2] ?? match[3] ?? '';
    if (args.includes('`') || /['"`]\s*\+|\+\s*['"`]/.test(args)) hits.push(match[0].replace(/\s+/g, ' '));
  }
  return hits;
}

describe('no PostgREST string filter is built from a template or concatenation', () => {
  it('under frontend/src', () => {
    const files = Object.fromEntries(Object.entries(readSourceFiles()).filter(([path]) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)));
    expectScanned(files);
    const hits = Object.entries(files).flatMap(([path, code]) => builtFilterCalls(code).map((call) => `${path}: ${call}`));
    expect(hits).toEqual([]);
  });

  it('the scan itself catches each forbidden shape, across lines too', () => {
    for (const name of ['or', 'not', 'like', 'ilike', 'textSearch']) {
      expect(builtFilterCalls(`q.${name}(\`name.ilike.\${term}\`)`)).toHaveLength(1);
      expect(builtFilterCalls(`q\n  .${name}('name.eq.' + term)`)).toHaveLength(1);
    }
    expect(builtFilterCalls('q.filter(`name`, "eq", x)')).toHaveLength(1);
    expect(builtFilterCalls("q.filter('name', 'eq', '' + x)")).toHaveLength(1);
  });

  it('leaves safe calls alone: .eq/.in, a literal filter, Array.filter, and comments', () => {
    expect(builtFilterCalls("q.eq('name', term).in('id', ids)")).toEqual([]);
    expect(builtFilterCalls("q.not('deleted_at', 'is', null)")).toEqual([]);
    expect(builtFilterCalls('rows.filter((r) => `${r.a}` === x)')).toEqual([]);
    expect(builtFilterCalls('// q.or(`a.eq.${x}`)\n/* q.like("a" + x) */')).toEqual([]);
  });
});
