import { planRepository, type NewPlan } from '../repositories/plan.repository';
import type { Plan, PlanCategory } from '../types/plan';
import { charLength, cleanText, TEXT_LIMITS } from '../lib/text-rules';
import { constraintField } from '../lib/db-error';

/**
 * The Plan form's working state — see spec/frontend/master-data-management.md §2.
 * `neverExpires` only applies to add-ons (a UX affordance over `duration_days IS NULL`);
 * membership plans have no such toggle — duration is always required for them.
 * `price` stays a raw string while editing for the same reason member.service.ts's
 * weight_kg/height_cm do — a controlled `type="number"` input eats a trailing decimal
 * point on every keystroke, so masking + string state is required, not optional polish.
 */
export interface PlanDraft {
  name: string;
  category: PlanCategory | '';
  duration_days: number | '';
  /** Only meaningful when category = 'addon'. Ignored (and cleared server-side regardless) for membership. */
  neverExpires: boolean;
  price: string;
  /** Only meaningful when category = 'membership' — forced to 1 for add-ons regardless of this value. */
  max_members: 1 | 2;
}

export function emptyPlanDraft(): PlanDraft {
  return { name: '', category: '', duration_days: '', neverExpires: false, price: '', max_members: 1 };
}

export function planToDraft(plan: Plan): PlanDraft {
  return {
    name: plan.name,
    category: plan.category,
    duration_days: plan.duration_days ?? '',
    neverExpires: plan.category === 'addon' && plan.duration_days === null,
    price: String(plan.price),
    max_members: plan.max_members === 2 ? 2 : 1,
  };
}

export type PlanFormErrors = Partial<Record<keyof PlanDraft, string>>;

/** Client-side validation mirroring the CHECK constraints (master-data-management.md §4). */
export function validatePlan(form: PlanDraft): PlanFormErrors {
  const errors: PlanFormErrors = {};
  const name = cleanText(form.name);
  if (!name) errors.name = 'Name is required';
  else if (charLength(name) > TEXT_LIMITS.name) errors.name = 'Name must be at most 80 characters';
  if (form.category === '') errors.category = 'Select a category';

  const durationRequired = form.category === 'membership' || (form.category === 'addon' && !form.neverExpires);
  if (durationRequired) {
    if (form.duration_days === '' || !Number.isInteger(form.duration_days) || form.duration_days < 1) {
      errors.duration_days = 'Enter a whole number of days, at least 1';
    }
  }

  const price = Number(form.price);
  if (form.price.trim() === '' || Number.isNaN(price) || price < 0) {
    errors.price = 'Enter a valid price';
  }

  return errors;
}

/** The field a `chk_plans_*` constraint guards, for a 23514 that still arrives. */
export function planFieldForConstraint(constraint: string | undefined): keyof PlanDraft | undefined {
  return constraintField(constraint, 'plans', ['name'] as const);
}

export function isPlanFormValid(errors: PlanFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

function draftToNewPlan(form: PlanDraft): NewPlan {
  const category = form.category as PlanCategory;
  const isIndefiniteAddon = category === 'addon' && form.neverExpires;
  return {
    name: cleanText(form.name),
    category,
    duration_days: isIndefiniteAddon ? null : (form.duration_days as number),
    price: Number(form.price),
    max_members: category === 'membership' ? form.max_members : 1,
  };
}

export const planService = {
  emptyPlanDraft,
  planToDraft,
  validatePlan,
  isPlanFormValid,
  planFieldForConstraint,

  async create(form: PlanDraft): Promise<Plan> {
    return planRepository.create(draftToNewPlan(form));
  },

  async update(id: number, form: PlanDraft): Promise<void> {
    return planRepository.update(id, draftToNewPlan(form));
  },
};

export type PlanService = typeof planService;
