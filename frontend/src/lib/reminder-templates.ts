/**
 * The WhatsApp renewal reminders, in one place so the wording can be changed without touching any code that
 * uses it. One template per situation. WhatsApp formatting: *bold*, _italic_; blank lines are kept.
 *
 * Placeholders (filled by `buildReminderMessage` in lib/reminder.ts):
 *   {{name}}  the member's name        {{plan}}  their membership plan     {{date}}  the expiry date
 *   {{gym}}   the gym's name           {{quote}} the motivational line (set below)
 */
export const REMINDER_TEMPLATES = {
  /** The membership is still running and ends within the Action Center window. */
  expiring: {
    quote: 'The only bad workout is the one that did not happen.',
    body: `Hello *{{name}}*,

Your *{{plan}}* at *{{gym}}* ends on *{{date}}*.
Renew at the front desk to keep your access and your momentum going.

_"{{quote}}"_

See you at the gym!`,
  },

  /** The membership has already ended. */
  expired: {
    quote: 'It is never too late to start again. Every rep counts.',
    body: `Hello *{{name}}*,

Your *{{plan}}* at *{{gym}}* ended on *{{date}}*.
We would love to have you back. Renew at the front desk and pick up where you left off.

_"{{quote}}"_

See you at the gym!`,
  },
} as const;

export type ReminderTemplateKind = keyof typeof REMINDER_TEMPLATES;
