// _shared/errors.ts: the typed errors, the SQLSTATE mapping with an entity's codes, and the
// handler putting `code` in the body only when there is one.
import { assert, assertEquals } from './harness.ts';
import { BadRequestError, ConflictError, ForbiddenError, GENERIC_ERROR, HttpError, NotFoundError, rpcError } from '../_shared/errors.ts';
import { handle } from '../_shared/http.ts';

const thrown = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('not thrown');
};

Deno.test('the typed errors are HttpErrors with their status and optional code', () => {
  const cases: [HttpError, number][] = [
    [new BadRequestError('b', 'B'), 400], [new ForbiddenError('f', 'F'), 403],
    [new NotFoundError('n', 'N'), 404], [new ConflictError('c', 'C'), 409],
  ];
  for (const [e, status] of cases) {
    assert(e instanceof HttpError && e instanceof Error);
    assertEquals([e.status, e.code], [status, e.message.toUpperCase()]);
  }
  assertEquals(new NotFoundError('n').code, undefined);
});

Deno.test('rpcError: a refusal becomes the typed error for its status, with the entity code for that status', () => {
  const codes = { 404: 'THING_NOT_FOUND', 409: 'THING_IN_USE' } as const;
  const notFound = thrown(() => rpcError({ code: 'PT404', message: 'gone' }, codes));
  if (!(notFound instanceof NotFoundError)) throw new Error(`not a NotFoundError: ${String(notFound)}`);
  assertEquals([notFound.status, notFound.message, notFound.code], [404, 'gone', 'THING_NOT_FOUND']);

  const conflict = thrown(() => rpcError({ code: 'PT409', message: 'in use' }, codes));
  if (!(conflict instanceof ConflictError)) throw new Error(`not a ConflictError: ${String(conflict)}`);
  assertEquals(conflict.code, 'THING_IN_USE');

  const forbidden = thrown(() => rpcError({ code: 'PT403', message: 'no' }, codes));
  if (!(forbidden instanceof ForbiddenError)) throw new Error(`not a ForbiddenError: ${String(forbidden)}`);
  assertEquals(forbidden.code, undefined, 'a status the entity gave no code has none');

  const bad = thrown(() => rpcError({ code: 'PT400', message: 'bad' }));
  if (!(bad instanceof BadRequestError)) throw new Error(`not a BadRequestError: ${String(bad)}`);
});

Deno.test('rpcError: an unexpected error is rethrown untouched, whatever codes were given', () => {
  const raw = { code: '23514', message: 'violates chk_x' };
  assert(thrown(() => rpcError(raw, { 409: 'X' })) === raw);
  rpcError(null, { 409: 'X' });
});

Deno.test('handle: the body carries `code` only when the error has one', async () => {
  const post = () => new Request('http://localhost/fn', { method: 'POST' });
  const withCode = await handle('t', () => Promise.reject(new ConflictError('in use', 'MEMBER_IN_USE')))(post());
  assertEquals([withCode.status, await withCode.json()], [409, { error: 'in use', code: 'MEMBER_IN_USE' }]);
  const without = await handle('t', () => Promise.reject(new ConflictError('in use')))(post());
  assertEquals(await without.json(), { error: 'in use' });
  const realError = console.error;
  console.error = () => {};
  try {
    const unexpected = await handle('t', () => Promise.reject(new Error('boom')))(post());
    assertEquals(await unexpected.json(), { error: GENERIC_ERROR }, 'an unexpected error has no code');
  } finally {
    console.error = realError;
  }
});
