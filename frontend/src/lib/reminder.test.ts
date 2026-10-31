import { describe, expect, it } from 'vitest';
import { buildReminderMessage, buildWhatsAppUrl } from './reminder';
import { REMINDER_TEMPLATES } from './reminder-templates';

const member = {
  name: 'Priya Sharma',
  phone: '9876543210',
  current_membership_plan_name: 'Quarterly',
  current_membership_end_date: '2026-07-10',
};

describe('buildReminderMessage', () => {
  it('uses the expiring template while the membership is running: greeting, name, plan, date, quote', () => {
    const message = buildReminderMessage(member, '2026-07-05');
    expect(message.startsWith('Hello *Priya Sharma*,')).toBe(true);
    expect(message).toContain('*Quarterly*');
    expect(message).toContain('*Fit & Fine*');
    expect(message).toContain('ends on *');
    expect(message).toContain(REMINDER_TEMPLATES.expiring.quote);
    expect(message).not.toContain('ended on');
  });

  it('treats the expiry day itself as still expiring', () => {
    expect(buildReminderMessage(member, '2026-07-10')).toContain('ends on');
  });

  it('uses the expired template once it has ended', () => {
    const message = buildReminderMessage(member, '2026-08-01');
    expect(message.startsWith('Hello *Priya Sharma*,')).toBe(true);
    expect(message).toContain('ended on *');
    expect(message).toContain('have you back');
    expect(message).toContain(REMINDER_TEMPLATES.expired.quote);
    expect(message).not.toContain('ends on');
  });

  it('puts the formatted expiry date in the message', () => {
    expect(buildReminderMessage(member, '2026-07-05')).toMatch(/10/);
    expect(buildReminderMessage(member, '2026-07-05')).toContain('2026');
  });

  it('falls back to "membership" when there is no plan name', () => {
    expect(buildReminderMessage({ ...member, current_membership_plan_name: null }, '2026-07-05')).toContain('*membership*');
  });

  it('leaves no placeholder unfilled in either template', () => {
    expect(buildReminderMessage(member, '2026-07-05')).not.toMatch(/\{\{/);
    expect(buildReminderMessage(member, '2026-08-01')).not.toMatch(/\{\{/);
  });

  it('never expands a placeholder that appears inside a member name', () => {
    const message = buildReminderMessage({ ...member, name: '{{plan}}' }, '2026-07-05');
    expect(message.startsWith('Hello *{{plan}}*,')).toBe(true);
  });
});

describe('REMINDER_TEMPLATES', () => {
  it.each(['expiring', 'expired'] as const)('the %s template has a greeting, the member, the plan, the date and a quote', (kind) => {
    const { body } = REMINDER_TEMPLATES[kind];
    expect(body.startsWith('Hello *{{name}}*')).toBe(true);
    for (const placeholder of ['{{plan}}', '{{date}}', '{{gym}}', '{{quote}}']) expect(body).toContain(placeholder);
  });

  it('only uses placeholders that buildReminderMessage fills', () => {
    const known = new Set(['name', 'plan', 'date', 'gym', 'quote']);
    for (const { body } of Object.values(REMINDER_TEMPLATES)) {
      for (const [, key] of body.matchAll(/\{\{(\w+)\}\}/g)) expect(known.has(key)).toBe(true);
    }
  });
});

describe('buildWhatsAppUrl', () => {
  it('prefixes the country code and URL-encodes the message, keeping its line breaks', () => {
    const url = buildWhatsAppUrl('9876543210', 'Hi *Priya* & co\nline two')!;
    expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    expect(url).toContain(encodeURIComponent('Hi *Priya* & co\nline two'));
    expect(url).toContain('%0A');
    expect(url).not.toContain(' ');
  });

  it('returns null unless the phone is exactly 10 digits', () => {
    expect(buildWhatsAppUrl('98765', 'x')).toBeNull();
    expect(buildWhatsAppUrl('98765432100', 'x')).toBeNull();
    expect(buildWhatsAppUrl('98765abcde', 'x')).toBeNull();
    expect(buildWhatsAppUrl('', 'x')).toBeNull();
  });
});
