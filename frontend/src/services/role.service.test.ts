import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleRepository } from '../repositories/role.repository';

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('../repositories/role.repository', () => ({
  roleRepository: { create: mocks.create, update: mocks.update } satisfies Partial<RoleRepository>,
}));

import { emptyRoleDraft, isRoleFormValid, roleService, roleToDraft, validateRole } from './role.service';
import { buildRole } from '../test/builders';

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('role drafts', () => {
  it('starts empty', () => {
    expect(emptyRoleDraft()).toEqual({ name: '', description: '' });
  });

  it('maps a null description to an empty string', () => {
    expect(roleToDraft(buildRole({ name: 'trainer', description: null }))).toEqual({ name: 'trainer', description: '' });
    expect(roleToDraft(buildRole({ name: 'trainer', description: 'Floor staff' })).description).toBe('Floor staff');
  });
});

describe('validateRole', () => {
  it('requires a name, treating whitespace as empty', () => {
    expect(validateRole({ name: ' ', description: '' })).toEqual({ name: 'Name is required' });
    expect(isRoleFormValid(validateRole({ name: 'trainer', description: '' }))).toBe(true);
  });

  it('applies the database’s limits: name 80, description 500 characters', () => {
    expect(validateRole({ name: 'x'.repeat(81), description: 'y'.repeat(501) })).toEqual({
      name: 'Name must be at most 80 characters',
      description: 'Description must be at most 500 characters',
    });
    expect(validateRole({ name: 'x'.repeat(80), description: 'y'.repeat(500) })).toEqual({});
  });

  it('maps chk_roles_* to its field', () => {
    expect(roleService.roleFieldForConstraint('chk_roles_description_text')).toBe('description');
    expect(roleService.roleFieldForConstraint('chk_plans_name_text')).toBeUndefined();
  });
});

describe('roleService', () => {
  it('trims the name and stores a blank description as null', async () => {
    mocks.create.mockResolvedValue(buildRole());
    await roleService.create({ name: ' trainer ', description: '   ' });
    expect(mocks.create).toHaveBeenCalledWith({ name: 'trainer', description: null });
  });

  it('strips unsafe characters, keeping line feeds in the description', async () => {
    mocks.create.mockResolvedValue(buildRole());
    await roleService.create({ name: 'trainer\u0007', description: 'Floor\r\nstaff\u2066' });
    expect(mocks.create).toHaveBeenCalledWith({ name: 'trainer', description: 'Floor\nstaff' });
  });

  it('keeps a real description (trimmed) on update', async () => {
    mocks.update.mockResolvedValue(undefined);
    await roleService.update(2, { name: 'trainer', description: ' Floor staff ' });
    expect(mocks.update).toHaveBeenCalledWith(2, { name: 'trainer', description: 'Floor staff' });
  });
});
