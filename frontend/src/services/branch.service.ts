import { branchRepository, type NewBranch } from '../repositories/branch.repository';
import type { Branch } from '../types/branch';
import { charLength, cleanText, TEXT_LIMITS } from '../lib/text-rules';
import { constraintField } from '../lib/db-error';

export interface BranchDraft {
  name: string;
  code: string;
}

export type BranchFormErrors = Partial<Record<keyof BranchDraft, string>>;

/** Letters and digits only: no '-' or wildcard, so '<code>-' prefixes exactly one branch's member numbers. */
const CODE_REGEX = /^[A-Za-z0-9]{1,10}$/;

/**
 * Client-side validation for instant feedback — `chk_branches_*` and `idx_branches_code_active`'s unique
 * index are the authoritative copy (spec/frontend/backend-api-changes.md §5, master-data-management.md §4).
 */
export function validateBranch(form: BranchDraft): BranchFormErrors {
  const errors: BranchFormErrors = {};
  const name = cleanText(form.name);
  if (!name) errors.name = 'Name is required';
  else if (charLength(name) > TEXT_LIMITS.name) errors.name = 'Name must be at most 80 characters';
  const code = form.code.trim();
  if (!code) errors.code = 'Code is required';
  else if (!CODE_REGEX.test(code)) errors.code = 'Use 1-10 letters or digits — no spaces or symbols';
  return errors;
}

/** The field a `chk_branches_*` constraint guards, for a 23514 that still arrives. */
export function branchFieldForConstraint(constraint: string | undefined): keyof BranchDraft | undefined {
  return constraintField(constraint, 'branches', ['name', 'code'] as const);
}

export function isBranchFormValid(errors: BranchFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

function draftToNewBranch(form: BranchDraft): NewBranch {
  return { name: cleanText(form.name), code: form.code.trim() };
}

export const branchService = {
  validateBranch,
  isBranchFormValid,
  branchFieldForConstraint,

  async create(form: BranchDraft): Promise<Branch> {
    return branchRepository.create(draftToNewBranch(form));
  },

  async update(id: number, form: BranchDraft): Promise<void> {
    return branchRepository.update(id, draftToNewBranch(form));
  },
};

export type BranchService = typeof branchService;
