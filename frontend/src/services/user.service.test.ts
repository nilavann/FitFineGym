import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { profileRepository } from '../repositories/profile.repository';

const mocks = vi.hoisted(() => ({
  getAllUsers: vi.fn(),
  invite: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../repositories/profile.repository', () => ({
  profileRepository: mocks satisfies Partial<typeof profileRepository>,
}));

import { isFormValid, userService, validateEditUser, validateInvite } from './user.service';
import { buildProfile } from '../test/builders';

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('validateInvite', () => {
  const valid = { email: 'new@fitandfine.in', full_name: 'Ravi Kumar', roles: ['staff'] };

  it('accepts a complete invite', () => {
    expect(validateInvite(valid)).toEqual({});
  });

  it.each([
    ['missing email', { email: ' ' }, { email: 'Email is required' }],
    ['malformed email', { email: 'nope' }, { email: 'Enter a valid email address' }],
    ['missing name', { full_name: '' }, { full_name: 'Name is required' }],
    ['1-char name', { full_name: 'R' }, { full_name: 'Name must be 2-80 characters' }],
    ['81-char name', { full_name: 'x'.repeat(81) }, { full_name: 'Name must be 2-80 characters' }],
    ['no roles', { roles: [] }, { roles: 'Select at least one role' }],
  ])('rejects %s', (_label, patch, expected) => {
    expect(validateInvite({ ...valid, ...patch })).toEqual(expected);
  });
});

describe('validateEditUser', () => {
  const valid = { full_name: 'Ravi Kumar', roles: ['admin'], is_active: true };

  it('accepts a complete edit', () => {
    expect(validateEditUser(valid)).toEqual({});
  });

  it('applies the same 2-80 name rule and at-least-one-role rule as invite', () => {
    expect(validateEditUser({ ...valid, full_name: 'R' })).toEqual({ full_name: 'Name must be 2-80 characters' });
    expect(validateEditUser({ ...valid, roles: [] })).toEqual({ roles: 'Select at least one role' });
  });
});

describe('isFormValid', () => {
  it('is true only when there are no error keys', () => {
    expect(isFormValid({})).toBe(true);
    expect(isFormValid({ email: 'bad' })).toBe(false);
  });
});

describe('userService', () => {
  it('lists every user, deactivated ones included, with no include-deleted option', async () => {
    mocks.getAllUsers.mockResolvedValue([]);
    await userService.getAll();
    expect(mocks.getAllUsers).toHaveBeenCalledWith();
  });

  it('trims the email and name when inviting', async () => {
    mocks.invite.mockResolvedValue(undefined);
    await userService.invite({ email: ' a@b.co ', full_name: ' Ravi Kumar ', roles: ['staff'] });
    expect(mocks.invite).toHaveBeenCalledWith({ email: 'a@b.co', full_name: 'Ravi Kumar', roles: ['staff'] });
  });

  it('sends only the fields it is given on update, and returns the updated profile', async () => {
    const updated = buildProfile({ full_name: 'New Name' });
    mocks.update.mockResolvedValue(updated);
    await expect(userService.update('u1', { full_name: 'New Name' })).resolves.toBe(updated);
    expect(mocks.update).toHaveBeenCalledWith('u1', { full_name: 'New Name' });
  });

  it('strips unsafe characters from a name before it is sent', async () => {
    mocks.invite.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(buildProfile());
    await userService.invite({ email: 'a@b.co', full_name: 'Ravi\u202e Kumar', roles: ['staff'] });
    await userService.update('u1', { full_name: '\u200bRavi', roles: ['staff'] });
    expect(mocks.invite).toHaveBeenCalledWith({ email: 'a@b.co', full_name: 'Ravi Kumar', roles: ['staff'] });
    expect(mocks.update).toHaveBeenCalledWith('u1', { full_name: 'Ravi', roles: ['staff'] });
  });
});
