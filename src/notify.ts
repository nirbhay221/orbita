/**
 * Telling the crew, not just answering the person who asked.
 *
 * An Alexa+ add-on cannot make an Echo speak first. A server can still send an
 * email, and that is how a crew hears that a job they were holding has cleared,
 * or that a storm will put tomorrow's work outside tolerance. Two rules hold
 * everywhere this is used: nobody is contacted until they have been confirmed,
 * and nothing spoken claims a message was delivered when it was only attempted.
 *
 * Email goes through Amazon SES once ORBITA_EMAIL_FROM is set to a verified
 * sender. Until then every message is still written to the outbox file and
 * marked not_configured, so a demo never pretends. While an SES account is in
 * the sandbox, each recipient address has to be verified as well.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export type Email = { to: string; subject: string; text: string; reason: string };
export type Delivery = {
  at: string;
  to: string;
  subject: string;
  reason: string;
  status: 'sent' | 'not_configured' | 'failed';
  detail?: string;
};
type Transport = (email: Email, from: string) => Promise<void>;

const OUTBOX = resolve(process.env.ORBITA_OUTBOX ?? './data/outbox.jsonl');
let from: string | undefined = process.env.ORBITA_EMAIL_FROM;
let client: SESv2Client | null = null;

let transport: Transport = async (email, sender) => {
  client ??= new SESv2Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [email.to] },
      Content: { Simple: { Subject: { Data: email.subject }, Body: { Text: { Data: email.text } } } },
    }),
  );
};

function record(d: Delivery): Delivery {
  mkdirSync(dirname(OUTBOX), { recursive: true });
  appendFileSync(OUTBOX, `${JSON.stringify(d)}\n`);
  return d;
}

/** Whether this server can actually send, so spoken answers never overclaim. */
export const emailConfigured = (): boolean => Boolean(from);

export async function sendEmail(email: Email): Promise<Delivery> {
  const base = { at: new Date().toISOString(), to: email.to, subject: email.subject, reason: email.reason };
  if (!from) return record({ ...base, status: 'not_configured' });
  try {
    await transport(email, from);
    return record({ ...base, status: 'sent' });
  } catch (err) {
    return record({ ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Test seam: a sender address and a fake transport, so tests never touch SES. */
export function configureForTest(opts: { from?: string; transport?: Transport }): void {
  from = opts.from;
  if (opts.transport) transport = opts.transport;
}
