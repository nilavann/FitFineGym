import { describe, expect, it } from 'vitest';
import { checkViolation, constraintField, DbError, isUniqueViolation, toDbError } from './db-error';
import { isNetworkError } from './network-error';

describe('toDbError', () => {
  it('keeps the SQLSTATE and the constraint a violation names', () => {
    const error = toDbError({ code: '23514', message: 'new row for relation "branches" violates check constraint "chk_branches_code_format"' });
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe('23514');
    expect(error.constraint).toBe('chk_branches_code_format');
    expect(checkViolation(error)).toBe('chk_branches_code_format');
    expect(isUniqueViolation(error)).toBe(false);
  });

  it('recognises a unique violation by its code, whatever the message says', () => {
    const error = toDbError({ code: '23505', message: 'duplicate key value violates unique constraint "idx_plans_name_active"' });
    expect(isUniqueViolation(error)).toBe(true);
    expect(checkViolation(error)).toBeUndefined();
  });

  it('keeps an offline write recognisable (supabase-js reports it with an empty code)', () => {
    const error = toDbError({ code: '', message: 'TypeError: Failed to fetch' });
    expect(error.code).toBeUndefined();
    expect(isNetworkError(error)).toBe(true);
  });

  it('a plain Error is neither kind', () => {
    expect(isUniqueViolation(new Error('duplicate key'))).toBe(false);
    expect(checkViolation(new Error('violates check constraint "chk_x"'))).toBeUndefined();
  });
});

describe('constraintField', () => {
  const fields = ['name', 'phone', 'aadhaar_number', 'emergency_contact_name'] as const;

  it.each([
    ['chk_members_name_text', 'name'],
    ['chk_members_phone_format', 'phone'],
    ['chk_members_aadhaar_number_format', 'aadhaar_number'],
    ['chk_members_emergency_contact_name_not_blank', 'emergency_contact_name'],
  ])('%s guards %s', (constraint, field) => {
    expect(constraintField(constraint, 'members', fields)).toBe(field);
  });

  it('is undefined for another table, an unknown field or no constraint', () => {
    expect(constraintField('chk_plans_name_text', 'members', fields)).toBeUndefined();
    expect(constraintField('chk_members_photo_url_path', 'members', fields)).toBeUndefined();
    expect(constraintField(undefined, 'members', fields)).toBeUndefined();
  });
});
