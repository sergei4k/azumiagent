import { AsyncLocalStorage } from 'node:async_hooks';

export type IntakeChannel = 'whatsapp' | 'telegram';

const intakeAls = new AsyncLocalStorage<{ channel: IntakeChannel }>();

/** Run agent/tool chain with channel so CRM tools can skip duplicate notes on WhatsApp. */
export function runWithIntakeChannelAsync<T>(channel: IntakeChannel, fn: () => Promise<T>): Promise<T> {
  return intakeAls.run({ channel }, fn);
}

export function getIntakeChannel(): IntakeChannel | undefined {
  return intakeAls.getStore()?.channel;
}
