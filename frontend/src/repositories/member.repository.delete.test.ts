import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeFunctionError } from '../lib/edge-function-error';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase-client', () => ({ supabase: { functions: { invoke } } }));

import { memberRepository } from './member.repository';
import { subscriptionRepository } from './subscription.repository';

beforeEach(() => invoke.mockReset());

const refusal = (status: number, body: Record<string, unknown>) => ({
  data: null,
  error: Object.assign(new Error('non-2xx'), { context: new Response(JSON.stringify(body), { status }) }),
});

describe('memberRepository.delete', () => {
  it('invokes delete-member with the member id (there is no separate permanent delete any more)', async () => {
    invoke.mockResolvedValue({ data: { success: true, photos_removed: true }, error: null });
    await expect(memberRepository.delete(12)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('delete-member', { body: { member_id: 12 } });
    expect('purge' in memberRepository).toBe(false);
  });

  it('throws an EdgeFunctionError carrying the stable code when the member is in use', async () => {
    invoke.mockResolvedValue(refusal(409, { error: 'Cannot delete — used by 2 subscription/add-on record(s)', code: 'MEMBER_IN_USE' }));
    const error = await memberRepository.delete(12).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdgeFunctionError);
    expect(error).toMatchObject({ code: 'MEMBER_IN_USE', status: 409, message: 'Cannot delete — used by 2 subscription/add-on record(s)' });
  });
});

describe('subscriptionRepository.delete', () => {
  it('invokes delete-subscription with the checkout id', async () => {
    invoke.mockResolvedValue({ data: { success: true }, error: null });
    await expect(subscriptionRepository.delete(7)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('delete-subscription', { body: { subscription_id: 7 } });
  });

  it('throws a 404 as an EdgeFunctionError so the page can treat it as already done', async () => {
    invoke.mockResolvedValue(refusal(404, { error: 'Subscription not found' }));
    const error = await subscriptionRepository.delete(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdgeFunctionError);
    expect(error).toMatchObject({ status: 404 });
  });
});

describe('profileRepository: users are never deleted', () => {
  it('exposes no delete or restore, and asks list-users for everyone with an empty body', async () => {
    const { profileRepository } = await import('./profile.repository');
    expect('delete' in profileRepository).toBe(false);
    expect('restore' in profileRepository).toBe(false);
    invoke.mockResolvedValue({ data: { users: [] }, error: null });
    await profileRepository.getAllUsers();
    expect(invoke).toHaveBeenCalledWith('list-users', { body: {} });
  });
});
