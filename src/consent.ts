/**
 * The person who gets the emails is the one who agrees to them.
 *
 * A contact used to be "confirmed" by the account holder saying yes. That is the account holder agreeing to
 * send, which is not the same as somebody agreeing to receive: anyone could add any address, say yes to
 * themselves, and mail a stranger from this server's name. The limits in notify.ts bound how much. This
 * closes it: the account holder's yes sends one short invitation, and nothing else is ever sent to that
 * address until the person who owns it opens the link and says yes themselves. Every email after that
 * carries a link that stops them.
 *
 * Two details that matter:
 *   - The link opens a page with a button. It does not accept on being opened, because mail scanners open
 *     every link in every email, and a scanner is not a person agreeing.
 *   - Only a hash of the invitation is stored, so reading the data file does not let anyone accept on
 *     somebody's behalf.
 *
 * It needs a public address to build the link from. Where ORBITA_PUBLIC_URL is not set, which is a developer
 * machine, there is no link to send and the holder's confirmation stands alone as it did before.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';
import * as store from './store.js';
import { perCaller } from './budget.js';

export const publicUrl = (): string => (process.env.ORBITA_PUBLIC_URL ?? '').trim().replace(/\/$/, '');

/** Whether a recipient has to agree before anything is sent. Off only where there is no address to agree at, or when switched off. */
export const consentRequired = (): boolean =>
  (process.env.ORBITA_RECIPIENT_CONSENT ?? 'on').toLowerCase() !== 'off' && publicUrl() !== '';

type Consenting = { confirmedAt: string | null; acceptedAt?: string | null };

/** Whether this contact may be emailed an alert: the holder said yes, and so did they. */
export const reachable = (c: Consenting): boolean => !!c.confirmedAt && (!consentRequired() || !!c.acceptedAt);

/** Confirmed by the holder and still waiting on the recipient. */
export const awaiting = (c: Consenting): boolean => !!c.confirmedAt && consentRequired() && !c.acceptedAt;

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newInvite(): { token: string; hash: string; stopId: string } {
  const token = randomBytes(24).toString('hex');
  return { token, hash: hashOf(token), stopId: randomBytes(16).toString('hex') };
}

export const acceptLink = (token: string): string => `${publicUrl()}/contact/accept?t=${token}`;
export const stopLink = (stopId: string | null | undefined): string => (stopId && publicUrl() ? `${publicUrl()}/contact/stop?s=${stopId}` : '');

/** The line every alert ends with. Empty where there is no link to give. */
export const stopFooter = (c: { stopId?: string | null }): string => {
  const link = stopLink(c.stopId);
  return link ? `\n\nTo stop these emails, open ${link}` : '';
};

/** What the invitation says. */
export function invitation(name: string, when: string, token: string): { subject: string; text: string } {
  return {
    subject: 'Do you agree to get field alerts from a farm you work with?',
    text:
      `Hello ${name}. Somebody who uses Orbita, which watches space weather for GPS-guided field work, asked for you to be emailed ${when}.\n\n` +
      `Nothing more will be sent unless you agree. To agree, or to say no, open:\n${acceptLink(token)}\n\n` +
      'If you were not expecting this, do nothing. You will not hear from us again.',
  };
}

const PAGE = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem;color:#16202e;background:#f6f7f9;line-height:1.5}
 h1{font-size:1.4rem;margin:0 0 .75rem}
 button{font:inherit;padding:.7rem 1.2rem;border-radius:.5rem;border:1px solid #16202e;background:#16202e;color:#fff;cursor:pointer;margin:.75rem .5rem 0 0}
 button.no{background:#fff;color:#16202e}
 @media (prefers-color-scheme:dark){body{background:#10151d;color:#e8ecf2}button{background:#e8ecf2;color:#10151d;border-color:#e8ecf2}button.no{background:#10151d;color:#e8ecf2}}
</style></head><body><main>${body}</main></body></html>`;

const send = (res: Response, status: number, title: string, body: string): void => {
  res.status(status);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(PAGE(title, body));
};

const TOKEN = /^[0-9a-f]{48}$/;
const STOP = /^[0-9a-f]{32}$/;

function findByHash(hash: string): { id: string; name: string } | null {
  for (const [id, p] of store.allEntries()) {
    const c = p.crew.find((x) => x.acceptHash === hash);
    if (c) return { id, name: c.name };
  }
  return null;
}

function findByStop(stopId: string): { id: string; name: string } | null {
  for (const [id, p] of store.allEntries()) {
    const c = p.crew.find((x) => x.stopId === stopId);
    if (c) return { id, name: c.name };
  }
  return null;
}

/** Guessing is the only way in without the email, so tries are counted per address. */
const tries = perCaller(20, 20 / 60);
const GONE = '<h1>This link is no longer valid</h1><p>It may have been used already, or the person who added you may have removed you. Nothing will be sent to you.</p>';

export function mountConsent(app: Express): void {
  const form = express.urlencoded({ extended: false });
  const limited = (req: Request, res: Response): boolean => {
    if (tries.allow(req.ip ?? 'unknown')) return false;
    send(res, 429, 'Too many tries', '<h1>Too many tries</h1><p>Wait a few minutes and open the link again.</p>');
    return true;
  };

  app.get('/contact/accept', (req, res) => {
    if (limited(req, res)) return;
    const t = String(req.query.t ?? '');
    if (!TOKEN.test(t) || !findByHash(hashOf(t))) return send(res, 404, 'Link not valid', GONE);
    send(
      res,
      200,
      'Agree to alerts',
      '<h1>Do you agree to get these emails?</h1>' +
        '<p>Somebody who uses Orbita asked for you to be told when a watched job clears, or when a storm is coming that puts their field work outside tolerance.</p>' +
        `<form method="post" action="/contact/accept"><input type="hidden" name="t" value="${t}">` +
        '<button name="answer" value="yes">Yes, send them to me</button><button class="no" name="answer" value="no">No</button></form>',
    );
  });

  app.post('/contact/accept', form, (req, res) => {
    if (limited(req, res)) return;
    const t = String((req.body as { t?: unknown })?.t ?? '');
    const answer = String((req.body as { answer?: unknown })?.answer ?? '');
    const hit = TOKEN.test(t) ? findByHash(hashOf(t)) : null;
    if (!hit) return send(res, 404, 'Link not valid', GONE);
    const hash = hashOf(t);
    if (answer === 'yes') {
      store.update(hit.id, (p) => {
        const c = p.crew.find((x) => x.acceptHash === hash);
        if (c) {
          c.acceptedAt = new Date().toISOString();
          // Used once. The stop link is what works from here on.
          c.acceptHash = null;
        }
      });
      return send(res, 200, 'Agreed', '<h1>Thank you</h1><p>You will be emailed when it matters, and every email has a link that stops them.</p>');
    }
    store.update(hit.id, (p) => void (p.crew = p.crew.filter((x) => x.acceptHash !== hash)));
    return send(res, 200, 'Declined', '<h1>Understood</h1><p>You have been removed. Nothing will be sent to you.</p>');
  });

  app.get('/contact/stop', (req, res) => {
    if (limited(req, res)) return;
    const s = String(req.query.s ?? '');
    if (!STOP.test(s) || !findByStop(s)) return send(res, 404, 'Link not valid', GONE);
    send(
      res,
      200,
      'Stop these emails',
      '<h1>Stop these emails?</h1><p>You will not be told about jobs or storms from this farm again.</p>' +
        `<form method="post" action="/contact/stop"><input type="hidden" name="s" value="${s}"><button name="answer" value="stop">Stop them</button></form>`,
    );
  });

  app.post('/contact/stop', form, (req, res) => {
    if (limited(req, res)) return;
    const s = String((req.body as { s?: unknown })?.s ?? '');
    const hit = STOP.test(s) ? findByStop(s) : null;
    if (!hit) return send(res, 404, 'Link not valid', GONE);
    store.update(hit.id, (p) => void (p.crew = p.crew.filter((x) => x.stopId !== s)));
    return send(res, 200, 'Stopped', '<h1>Stopped</h1><p>You have been removed. Nothing more will be sent to you.</p>');
  });
}
