import { describe, expect, it } from 'vitest';
import { EdgeFunctionError, extractFunctionErrorMessage, isNotFound, refusalMessage, toEdgeFunctionError } from './edge-function-error';

function httpError(message: string, body: unknown, jsonThrows = false) {
  const error = new Error(message) as Error & { context: { json: () => Promise<unknown> } };
  error.context = {
    json: () => (jsonThrows ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(body)),
  };
  return error;
}

describe('extractFunctionErrorMessage', () => {
  it("returns the Edge Function's `{ error }` body message instead of supabase-js's generic one", async () => {
    const error = httpError('Edge Function returned a non-2xx status code', { error: 'Plan is in use' });
    await expect(extractFunctionErrorMessage(error)).resolves.toBe('Plan is in use');
  });

  it('falls back to the error message when the body has no string `error`', async () => {
    const error = httpError('generic failure', { message: 'something else' });
    await expect(extractFunctionErrorMessage(error)).resolves.toBe('generic failure');
  });

  it('falls back to the error message when the body is not JSON', async () => {
    const error = httpError('generic failure', null, true);
    await expect(extractFunctionErrorMessage(error)).resolves.toBe('generic failure');
  });

  it('reports a request that never reached the server as the browser\'s "Failed to fetch", which every page treats as offline', async () => {
    // supabase-js: `new FunctionsFetchError(originalError)` — name set explicitly, message is the SDK's own wording.
    const error = Object.assign(new Error('Failed to send a request to the Edge Function'), {
      name: 'FunctionsFetchError',
      context: new TypeError('Failed to fetch'),
    });
    await expect(extractFunctionErrorMessage(error)).resolves.toBe('Failed to fetch');
  });

  it('uses the message of a plain Error with no response context', async () => {
    await expect(extractFunctionErrorMessage(new Error('Network down'))).resolves.toBe('Network down');
  });

  it('returns a generic message for a non-Error value', async () => {
    await expect(extractFunctionErrorMessage('weird')).resolves.toBe('Unexpected error');
  });
});

describe('toEdgeFunctionError', () => {
  it('carries the message and the stable code from the `{ error, code }` body', async () => {
    const error = httpError('non-2xx', { error: 'A member with this phone number already exists', code: 'MEMBER_PHONE_IN_USE' });
    const result = await toEdgeFunctionError(error);
    expect(result).toBeInstanceOf(EdgeFunctionError);
    expect(result.message).toBe('A member with this phone number already exists');
    expect(result.code).toBe('MEMBER_PHONE_IN_USE');
  });

  it('has no code when the function sent none, or the code is not a string', async () => {
    expect((await toEdgeFunctionError(httpError('x', { error: 'Plan is in use' }))).code).toBeUndefined();
    expect((await toEdgeFunctionError(httpError('x', { error: 'm', code: 409 }))).code).toBeUndefined();
  });

  it('keeps the offline normalisation: a request that never arrived is "Failed to fetch" with no code', async () => {
    const offline = Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' });
    const result = await toEdgeFunctionError(offline);
    expect([result.message, result.code]).toEqual(['Failed to fetch', undefined]);
  });
});

describe('status, isNotFound and refusalMessage', () => {
  function withStatus(status: number, body: unknown) {
    const error = new Error('non-2xx') as Error & { context: { status: number; json: () => Promise<unknown> } };
    error.context = { status, json: () => Promise.resolve(body) };
    return error;
  }

  it('carries the HTTP status, even when the body is not JSON (the platform’s own 413)', async () => {
    expect((await toEdgeFunctionError(withStatus(404, { error: 'Branch not found' }))).status).toBe(404);
    const tooLarge = new Error('non-2xx') as Error & { context: { status: number; json: () => Promise<unknown> } };
    tooLarge.context = { status: 413, json: () => Promise.reject(new SyntaxError('not json')) };
    expect((await toEdgeFunctionError(tooLarge)).status).toBe(413);
  });

  it('isNotFound is true only for a 404', async () => {
    expect(isNotFound(await toEdgeFunctionError(withStatus(404, { error: 'gone' })))).toBe(true);
    expect(isNotFound(await toEdgeFunctionError(withStatus(409, { error: 'in use' })))).toBe(false);
    expect(isNotFound(new Error('404'))).toBe(false);
  });

  it.each([400, 403, 409, 413])('refusalMessage passes a %s message through for the person', async (status) => {
    expect(refusalMessage(await toEdgeFunctionError(withStatus(status, { error: 'Reason' })))).toBe('Reason');
  });

  it('refusalMessage is undefined for a 500, an offline request and a plain Error', async () => {
    expect(refusalMessage(await toEdgeFunctionError(withStatus(500, { error: 'Something went wrong' })))).toBeUndefined();
    const offline = Object.assign(new Error('x'), { name: 'FunctionsFetchError' });
    expect(refusalMessage(await toEdgeFunctionError(offline))).toBeUndefined();
    expect(refusalMessage(new Error('Reason'))).toBeUndefined();
  });
});
