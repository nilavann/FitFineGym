// No Edge Function calls PostgREST's string filters:
// a value reaches the database only as an RPC parameter or through .eq / .in. This reads every
// .ts file under supabase/functions/ and fails on any such call, so a future
// function can't bring one back. It also checks that nothing builds a query from a template.
import { assert, assertEquals } from './harness.ts';

const FORBIDDEN = ['or', 'filter', 'not', 'like', 'ilike', 'textSearch'];
const root = new URL('..', import.meta.url);

function* sources(dir: URL): Generator<URL> {
  for (const entry of Deno.readDirSync(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) yield* sources(child);
    else if (entry.name.endsWith('.ts')) yield child;
  }
}

/** Source with comments and string/template literals blanked out, so prose can't trip or hide a match. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

const files = [...sources(root)].filter((u) => !u.pathname.includes('/_tests/'));

Deno.test('the scan sees the shared module, the entities and all twelve functions', () => {
  const names = files.map((u) => u.pathname.split('/functions/')[1]);
  assertEquals(names.filter((n) => n.startsWith('_shared/')).sort(), [
    '_shared/auth.ts', '_shared/clients.ts', '_shared/define-function.ts', '_shared/errors.ts', '_shared/http.ts', '_shared/validate.ts',
  ]);
  assert(names.some((n) => n.startsWith('_entities/member/')), 'the member entity is scanned');
  assertEquals(names.filter((n) => n.endsWith('/index.ts') && !n.startsWith('_')).length, 12);
});

Deno.test('no .or( .filter( .not( .like( .ilike( or .textSearch( call under supabase/functions/', () => {
  const re = new RegExp(`\\.\\s*(${FORBIDDEN.join('|')})\\s*\\(`);
  const hits: string[] = [];
  for (const file of files) {
    code(Deno.readTextFileSync(file)).split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${file.pathname.split('/functions/')[1]}:${i + 1}: ${line.trim()}`);
    });
  }
  assertEquals(hits, []);
});

Deno.test('the scan itself catches each forbidden call', () => {
  const re = new RegExp(`\\.\\s*(${FORBIDDEN.join('|')})\\s*\\(`);
  for (const name of FORBIDDEN) {
    assert(re.test(code(`q.${name}(\`a.eq.\${x}\`)`)), name);
    assert(re.test(code(`q\n  .${name} (x)`.split('\n').join(''))), `${name} with spaces`);
  }
  assert(!re.test(code('q.eq("a", 1).in("b", [1])')));
  assert(!re.test(code('// q.or(x)\n/* q.like(y) */')));
});

Deno.test('no function builds a query or filter from a template literal', () => {
  const hits: string[] = [];
  for (const file of files) {
    code(Deno.readTextFileSync(file)).split('\n').forEach((line, i) => {
      if (/\.(from|rpc|select|eq|in|is)\(\s*`[^`]*\$\{/.test(line)) hits.push(`${file.pathname.split('/functions/')[1]}:${i + 1}`);
    });
  }
  assertEquals(hits, []);
});

Deno.test('no function executes dynamic code', () => {
  const hits: string[] = [];
  for (const file of files) {
    if (/\b(eval|new Function)\s*\(/.test(code(Deno.readTextFileSync(file)))) hits.push(file.pathname);
  }
  assertEquals(hits, []);
});
