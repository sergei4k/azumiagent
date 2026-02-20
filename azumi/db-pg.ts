/**
 * Postgres integration - DISABLED.
 * All functions are no-ops. Re-enable by restoring the real implementation.
 */

// Normalize phone for consistent storage and lookup (digits and + only)
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

export async function initDb(): Promise<void> {
  // no-op
}

export async function saveCandidate(_data: { name: string; phone: string }): Promise<number> {
  console.warn('Postgres disabled: saveCandidate is a no-op');
  return 0;
}

export async function findCandidate(_params: {
  phone?: string;
  name?: string;
}): Promise<{ id: number; name: string; phone: string; created_at: Date } | null> {
  return null;
}

export async function logTelegramMessage(_params: {
  chatId: number;
  userId: number;
  sender: 'user' | 'bot';
  text: string;
}): Promise<void> {
  // no-op
}

export async function getRecentChats(): Promise<
  { chat_id: number; last_message_at: Date; last_text: string | null }[]
> {
  return [];
}

export async function getChatMessages(_chatId: number): Promise<
  { sender: 'user' | 'bot'; text: string | null; created_at: Date }[]
> {
  return [];
}
