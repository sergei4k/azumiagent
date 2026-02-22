/**
 * Inactivity Reminder Scheduler
 * Periodically checks for candidates who started a conversation but haven't
 * completed their application, and sends them a friendly follow-up via Telegram.
 */

import { sendTelegramMessage } from './telegram-client';
import {
  getInactiveCandidates,
  recordReminderSent,
  InactiveCandidate,
} from '../../../db-pg';

const REMINDER_CHECK_INTERVAL_MS = parseInt(
  process.env.REMINDER_CHECK_INTERVAL_MINUTES || '60',
  10,
) * 60 * 1000;

const INACTIVITY_THRESHOLD_MS = parseInt(
  process.env.REMINDER_INACTIVITY_HOURS || '24',
  10,
) * 60 * 60 * 1000;

const MAX_REMINDERS = parseInt(process.env.REMINDER_MAX_COUNT || '2', 10);

const REMINDER_MESSAGES: ((name: string | null) => string)[] = [
  (name) =>
    `Hi${name ? ` ${name}` : ''}! We noticed you started your application with Azumi Staff but haven't completed it yet. ` +
    `We'd love to help you finish — just send a message whenever you're ready, and we'll pick up right where you left off.`,
  (name) =>
    `Hello${name ? ` ${name}` : ''}, just a gentle reminder that your application with Azumi Staff is still incomplete. ` +
    `Our team is looking forward to reviewing your profile. If you have any questions or need help, feel free to reach out anytime.`,
];

function getReminderMessage(candidate: InactiveCandidate): string {
  const idx = Math.min(candidate.reminders_sent, REMINDER_MESSAGES.length - 1);
  return REMINDER_MESSAGES[idx](candidate.first_name);
}

async function sendReminders(): Promise<void> {
  const candidates = await getInactiveCandidates({
    inactiveForMs: INACTIVITY_THRESHOLD_MS,
    maxReminders: MAX_REMINDERS,
  });

  if (candidates.length === 0) return;

  console.log(`⏰ Found ${candidates.length} inactive candidate(s) to remind`);

  for (const candidate of candidates) {
    try {
      const message = getReminderMessage(candidate);
      await sendTelegramMessage(candidate.chat_id, message);
      await recordReminderSent(candidate.chat_id);
      console.log(
        `📨 Sent reminder #${candidate.reminders_sent + 1} to chat ${candidate.chat_id} (${candidate.first_name || 'unknown'})`,
      );
    } catch (err) {
      console.error(
        `Failed to send reminder to chat ${candidate.chat_id}:`,
        err,
      );
    }
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startReminderScheduler(): void {
  if (intervalId) return;

  console.log(
    `⏰ Reminder scheduler started (check every ${REMINDER_CHECK_INTERVAL_MS / 60000}min, ` +
    `inactive threshold ${INACTIVITY_THRESHOLD_MS / 3600000}h, max ${MAX_REMINDERS} reminders)`,
  );

  sendReminders().catch((err) =>
    console.error('Initial reminder check failed:', err),
  );

  intervalId = setInterval(() => {
    sendReminders().catch((err) =>
      console.error('Reminder check failed:', err),
    );
  }, REMINDER_CHECK_INTERVAL_MS);
}

export function stopReminderScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('⏰ Reminder scheduler stopped');
  }
}
