import { formatDate, todayDate } from './datetime';
import { REMINDER_TEMPLATES } from './reminder-templates';

// Members' phones are stored as exactly 10 digits with no country code (chk_members_phone_format),
// so every number is Indian and WhatsApp needs the country code in front.
const WHATSAPP_COUNTRY_CODE = '91';
const GYM_NAME = 'Fit & Fine';
const TEN_DIGITS = /^[0-9]{10}$/;

export interface ReminderSubject {
  name: string;
  phone: string;
  current_membership_plan_name: string | null;
  /** `YYYY-MM-DD`. Every Action Center row has one - it is what puts the member in the queue. */
  current_membership_end_date: string;
}

/** Fills `{{placeholder}}`s in one pass, so a value that itself contains `{{...}}` is never expanded. */
function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * The renewal reminder staff send by hand (Action Center): the "expiring" template while the membership is
 * still running (including its last day), the "expired" one after it has ended. Wording lives in
 * lib/reminder-templates.ts. `today` is injectable for tests; callers pass nothing.
 */
export function buildReminderMessage(member: ReminderSubject, today: string = todayDate()): string {
  const template = member.current_membership_end_date < today ? REMINDER_TEMPLATES.expired : REMINDER_TEMPLATES.expiring;
  return fillTemplate(template.body, {
    name: member.name,
    plan: member.current_membership_plan_name ?? 'membership',
    date: formatDate(member.current_membership_end_date),
    gym: GYM_NAME,
    quote: template.quote,
  });
}

/**
 * Click-to-chat link: opens WhatsApp (app or web) on the staff member's own account with the message
 * pre-filled; they press send. Returns null for a number that isn't 10 digits, so no broken link is shown.
 */
export function buildWhatsAppUrl(phone: string, message: string): string | null {
  const digits = phone.trim();
  if (!TEN_DIGITS.test(digits)) return null;
  return `https://wa.me/${WHATSAPP_COUNTRY_CODE}${digits}?text=${encodeURIComponent(message)}`;
}
