import { roleRepository, type NewRole } from '../repositories/role.repository';
import type { Role } from '../types/role';
import { charLength, cleanText, TEXT_LIMITS } from '../lib/text-rules';
import { constraintField } from '../lib/db-error';

/** The Role form's working state — see spec/frontend/master-data-management.md. */
export interface RoleDraft {
  name: string;
  description: string;
}

export function emptyRoleDraft(): RoleDraft {
  return { name: '', description: '' };
}

export function roleToDraft(role: Role): RoleDraft {
  return { name: role.name, description: role.description ?? '' };
}

export type RoleFormErrors = Partial<Record<keyof RoleDraft, string>>;

export function validateRole(form: RoleDraft): RoleFormErrors {
  const errors: RoleFormErrors = {};
  const name = cleanText(form.name);
  if (!name) errors.name = 'Name is required';
  else if (charLength(name) > TEXT_LIMITS.name) errors.name = 'Name must be at most 80 characters';
  if (charLength(cleanText(form.description, true)) > TEXT_LIMITS.description) {
    errors.description = 'Description must be at most 500 characters';
  }
  return errors;
}

/** The field a `chk_roles_*` constraint guards, for a 23514 that still arrives. */
export function roleFieldForConstraint(constraint: string | undefined): keyof RoleDraft | undefined {
  return constraintField(constraint, 'roles', ['name', 'description'] as const);
}

export function isRoleFormValid(errors: RoleFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

function draftToNewRole(form: RoleDraft): NewRole {
  return { name: cleanText(form.name), description: cleanText(form.description, true) || null };
}

export const roleService = {
  emptyRoleDraft,
  roleToDraft,
  validateRole,
  isRoleFormValid,
  roleFieldForConstraint,

  async create(form: RoleDraft): Promise<Role> {
    return roleRepository.create(draftToNewRole(form));
  },

  async update(id: number, form: RoleDraft): Promise<void> {
    return roleRepository.update(id, draftToNewRole(form));
  },
};

export type RoleService = typeof roleService;
