/**
 * Telling other people.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assess, nextWindow, thresholdKp, TOLERANCE_M, degradedOptions, deadlinePressure, geomagneticLatitude,
  auroralBoundaryDeg,
  type Correction, type Operation,
} from '../domain.js';
import { activeImpacts, speakImpacts } from '../impacts.js';
import * as swpc from '../swpc.js';
import * as solarwind from '../solarwind.js';
import * as geomag from '../geomag.js';
import * as glotec from '../glotec.js';
import * as swpcplus from '../swpcplus.js';
import * as aurora from '../aurora.js';
import { chooseOne, canAsk } from '../elicit.js';
import * as season from '../season.js';
import { perCaller } from '../budget.js';
import * as store from '../store.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { randomBytes } from 'node:crypto';
import { sendEmail, emailConfigured, canEmailFor, toDemoPhone, DEMO_PHONE } from '../notify.js';
import { consentRequired, newInvite, invitation, alwaysAsk, newEntry } from '../consent.js';
import * as crewday from '../crewday.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  CARD,
  count,
  clean,
  sameName,
  say,
} from './shared.js';

/** Guessing codes is the only way in without one, so tries are counted per account. */
const joins = perCaller(5, 5 / 60);

export function register(server: McpServer, farmOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * The crew. Staged, confirmed, and only then emailed.
   * ---------------------------------------------------------------- */
  const describeCrew = (reasons: store.NotifyReason[]) =>
    [
      reasons.includes('window_clear') ? 'when a watched job clears' : '',
      reasons.includes('storm') ? 'the day before a storm puts your jobs outside tolerance' : '',
    ]
      .filter(Boolean)
      .join(', and ');

  /*
   * One door for the crew list, not three.
   *
   * Published benchmarks put tool selection above 90 percent up to about twenty
   * tools and falling away after that, and three tools that all mean "the crew
   * list" spend that budget on a distinction the customer never makes. The
   * action is a word they already say: add, confirm, remove.
   */
  server.registerTool(
    'crew_contact',
    {
      title: 'Who to email about a job',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage who gets emailed when a watched job clears or a storm is coming. action add stages someone, and ' +
        'nothing is ever sent until action confirm, which the customer has to say yes to first. action remove stops ' +
        'emailing them. Call this when someone says to tell, notify, add, confirm or stop telling a crew member, ' +
        'operator or manager. To link a crew member\'s working day from their heat safety add-on, pass action add with their ' +
        'name and the dayCode they read out.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone new, confirm after the customer says yes to adding them, remove to stop emailing them',
        ),
        name: z.string().describe('Who, as spoken'),
        email: z.string().email().optional().describe('Their address when adding, if it was said. Leave it out when it was not: a page is put up to type it on'),
        role: z.string().optional().describe('e.g. "planter operator", "crew lead", "survey party chief"'),
        when: z.enum(['window_clear', 'storm', 'both']).optional().describe('both by default, only used when adding'),
        dayCode: z.string().optional().describe('The eight digit code this person read out from their Sudor heat safety add-on, when they are sharing their working day with the crew'),
      },
    },
    async ({ action, name, email, role, when, dayCode }) => {
      const id = farmOf();
      name = clean(name, 60);

      // Somebody already on the crew sharing their working day. The code is exchanged for a link, once, with
      // the server that knows them, and nothing about their health ever comes back. See crewday.ts.
      if (action === 'add' && dayCode && !email) {
        const known = store.get(id).crew.find((c) => sameName(c.name, name));
        if (!known) return say(`${name} isn't on your crew list yet. Add them with an email address first, then link their day.`, { linked: false, reason: 'unknown' });
        if (!crewday.configured()) return say('This server is not connected to the heat safety add-on, so I cannot link their day.', { linked: false, reason: 'not_configured' });
        const joined = await crewday.join(dayCode);
        if (!joined.ok) {
          return say(
            joined.why === 'unreachable'
              ? 'I could not reach the heat safety add-on just now. Try again in a few minutes.'
              : 'That code did not work. Codes are eight digits, work once and last a day, so ask them for a new one.',
            { linked: false, reason: joined.why },
          );
        }
        store.update(id, (x) => {
          const c = x.crew.find((y) => sameName(y.name, name));
          if (c) c.dayLink = joined.link;
        });
        void crewday.refresh(joined.link, true);
        return say(`Done. When I answer about a job I will say how the day looks for ${known.name}, and nothing about their health.`, { linked: true, name: known.name });
      }

      if (action === 'add') {
        role = role ? clean(role, 60) : undefined;
        const notifyOn: store.NotifyReason[] =
          when === 'window_clear' ? ['window_clear'] : when === 'storm' ? ['storm'] : ['window_clear', 'storm'];
        if (!email) {
          // An address is the thing a microphone gets wrong most, so it is typed. See the typed entry in consent.ts.
          const url = newEntry(id, name, role ?? null, notifyOn);
          const inner = (server as unknown as { server?: { getClientCapabilities?: () => { elicitation?: { url?: unknown } } | undefined; elicitInput?: (p: unknown) => Promise<unknown> } }).server;
          const canSendPage = /^https:/.test(url) && inner?.getClientCapabilities?.()?.elicitation?.url != null && typeof inner.elicitInput === 'function';
          if (canSendPage) {
            // Not awaited: the answer does not wait on somebody typing.
            void inner!.elicitInput!({ mode: 'url', message: `Type the email address for ${name}.`, url, elicitationId: `entry-${randomBytes(6).toString('hex')}` }).catch(() => {});
            return say(`I've put up a page to type the email address for ${name}. Tell me when it's done.`, { staged: false, needs: 'email', enterAt: url, sentPage: true, nextAction: { tool: 'crew_contact', arguments: { action: 'confirm', name } } });
          }
          return say(`I need an email address for ${name}. Say it, or type it on a screen if you have one.`, { staged: false, needs: 'email', enterAt: url });
        }
        // Replacing somebody already on the list is not an addition.
        const held = store.get(id);
        const replacing = held.crew.some((c) => sameName(c.name, name) || c.email.toLowerCase() === email.toLowerCase());
        if (!replacing && held.crew.length >= store.limitsFor(id).crew) {
          return say('That is as many people as I can keep on the crew list. Take somebody off first if you need to add another.', {
            staged: false,
            reason: 'limit',
          });
        }
        store.update(id, (x) => {
          x.crew = x.crew.filter((c) => !sameName(c.name, name) && c.email.toLowerCase() !== email.toLowerCase());
          x.crew.push({ name, email, role: role ?? null, notifyOn, addedAt: new Date().toISOString(), confirmedAt: null });
        });
        return say(
          `I'll email ${name}${role ? `, your ${role},` : ''} at ${email} ${describeCrew(notifyOn)}. ` +
            `Nothing is sent until you confirm. Should I add ${name}?`,
          {
            staged: true,
            name,
            notifyOn,
            // A commit screen: everything that saying yes will do, in full, before it is done.
            card: {
              kind: 'card',
              title: `Add ${name}?`,
              status: { label: 'not confirmed', tone: 'neutral' },
              lines: [email, role ?? '', `Emailed ${describeCrew(notifyOn)}.`].filter(Boolean),
              confirm: `Say yes to add ${name}. Nothing is sent until you do.`,
            },
          },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).crew.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added.`, { confirmed: false });
        store.update(id, (x) => {
          const c = x.crew.find((y) => sameName(y.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
        // The customer has said yes. Now the person who owns the address is asked, once, and nothing else
        // goes to them until they agree. See consent.ts.
        if ((consentRequired() || alwaysAsk(id)) && !contact.acceptedAt) {
          if (!canEmailFor(id)) {
            // The public demo sends no email. The invitation goes to the phone on the demo page, with the real
            // link behind its buttons, so agreeing there is the same act as agreeing from an inbox.
            const invite = newInvite();
            store.update(id, (x) => {
              const c = x.crew.find((y) => sameName(y.name, name));
              if (c) {
                c.acceptHash = invite.hash;
                c.stopId = invite.stopId;
                c.invitedAt = new Date().toISOString();
              }
            });
            const text = invitation(contact.name, describeCrew(contact.notifyOn), invite.token).text.split('\n\n')[0];
            toDemoPhone(id, { to: contact.name, reason: 'invite', subject: 'Do you agree to get field alerts?', text, accept: invite.token });
            return say(`I've asked ${contact.name} to agree. ${DEMO_PHONE} Nothing more is sent until they say yes.`, { confirmed: true, accepted: false, demo: true });
          }
          if (!emailConfigured()) {
            return say(`Noted. Email isn't switched on for this server yet, so I can't ask ${contact.name} to agree, and nothing will be sent until it is.`, { confirmed: true, accepted: false, emailConfigured: false });
          }
          const askedRecently = !!contact.invitedAt && Date.now() - new Date(contact.invitedAt).getTime() < 60 * 60 * 1000;
          if (!askedRecently) {
            const invite = newInvite();
            store.update(id, (x) => {
              const c = x.crew.find((y) => sameName(y.name, name));
              if (c) {
                c.acceptHash = invite.hash;
                c.stopId = invite.stopId;
                c.invitedAt = new Date().toISOString();
              }
            });
            void sendEmail({ to: contact.email, sender: id, reason: 'invite', ...invitation(contact.name, describeCrew(contact.notifyOn), invite.token) });
          }
          return say(
            `${askedRecently ? `I have already emailed ${contact.name} to ask if they agree.` : `Done. I've emailed ${contact.name} to ask if they agree.`} ` +
              `They will get an email ${describeCrew(contact.notifyOn)} once they say yes, and not before.`,
            { confirmed: true, accepted: false, invited: true, emailConfigured: true },
          );
        }
        return say(
          `Done. ${contact.name} will get an email ${describeCrew(contact.notifyOn)}.` +
            (emailConfigured() ? '' : " Email isn't switched on for this server yet, so nothing can actually be sent until it is."),
          { confirmed: true, emailConfigured: emailConfigured() },
        );
      }

      if (!store.get(id).crew.some((c) => sameName(c.name, name))) {
        return say(`${name} isn't on your crew list.`, { removed: false });
      }
      store.update(id, (x) => void (x.crew = x.crew.filter((c) => !sameName(c.name, name))));
      return say(`Removed ${name}. They won't be emailed.`, { removed: true });
    },
  );

  /* ---------------------------------------------------------------- *
   * A second person who can ask for themselves. See store.ts.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'share_access',
    {
      title: 'Let somebody else ask about the farm',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        'Let another person ask about this farm from their own account, without being able to change anything. ' +
        'action invite gives the owner a one-time code to read to them. action join is said by the other person, ' +
        'with the code, from their own account. action leave is the other person stopping. action stop is the owner ' +
        'ending it for everybody. Call this when someone says let my operator check for himself, give Dale access, ' +
        'I have a code, or stop sharing. It is not for adding somebody to be emailed; that is crew_contact.',
      inputSchema: {
        action: z.enum(['invite', 'join', 'leave', 'stop']).describe('invite for the owner, join with a code, leave to stop looking, stop to end all sharing'),
        code: z.string().optional().describe('The eight digit code, as spoken, only when joining'),
      },
      _meta: { ui: { resourceUri: CARD } },
    },
    async ({ action, code }) => {
      const id = farmOf();
      if (action === 'invite') {
        const farm = store.get(id);
        if (!farm.fields.length) return say('There is nothing to share yet. Add a field first.', { shared: false });
        const made = store.createInvite(id);
        const read = `${made.slice(0, 4).split('').join(' ')}, ${made.slice(4).split('').join(' ')}`;
        return say(
          `The code is ${read}. It works once and lasts a day. They link their own account, then say join with that code. ` +
            'They will be able to ask about your fields and change nothing.',
          {
            shared: false,
            code: made,
            card: {
              kind: 'card',
              title: 'Share this farm',
              status: { label: 'code ready', tone: 'neutral' },
              lines: [`${made.slice(0, 4)} ${made.slice(4)}`, 'Works once. Lasts a day. They can ask, and change nothing.'],
            },
          },
        );
      }
      if (action === 'join') {
        if (!joins.allow(id)) return say('Too many codes tried. Wait a while and try again.', { joined: false, reason: 'limit' });
        const r = store.joinWithCode(id, code ?? '');
        if (!r.ok) {
          return say(
            r.why === 'own'
              ? 'That is your own code. Read it to the person you want to share with.'
              : r.why === 'full'
                ? 'That farm is already shared with as many people as it can be.'
                : 'That code did not work. Codes are eight digits, work once and last a day, so ask for a new one.',
            { joined: false, reason: r.why },
          );
        }
        const farm = store.get(r.farmId);
        return say(
          `You can now ask about ${count(farm.fields.length, 'field')}: ${farm.fields.slice(0, 5).map((f) => f.name).join(', ')}. Ask me whether a job can run.`,
          { joined: true, fields: farm.fields.map((f) => f.name) },
        );
      }
      if (action === 'leave') {
        return say(store.leave(id) ? 'Done. You are back to your own fields.' : 'You were not looking at anybody else\'s farm.', { left: true });
      }
      const n = store.stopSharing(id);
      return say(n ? `Done. ${count(n, 'person', 'people')} can no longer ask about your farm.` : 'Nobody else had access.', { stopped: n });
    },
  );

}
