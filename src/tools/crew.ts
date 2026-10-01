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
import * as store from '../store.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  clean,
  sameName,
  say,
} from './shared.js';

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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage who gets emailed when a watched job clears or a storm is coming. action add stages someone, and ' +
        'nothing is ever sent until action confirm, which the customer has to say yes to first. action remove stops ' +
        'emailing them. Call this when someone says to tell, notify, add, confirm or stop telling a crew member, ' +
        'operator or manager.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone new, confirm after the customer says yes to adding them, remove to stop emailing them',
        ),
        name: z.string().describe('Who, as spoken'),
        email: z.string().email().optional().describe('Required when adding'),
        role: z.string().optional().describe('e.g. "planter operator", "crew lead", "survey party chief"'),
        when: z.enum(['window_clear', 'storm', 'both']).optional().describe('both by default, only used when adding'),
      },
    },
    async ({ action, name, email, role, when }) => {
      const id = farmOf();
      name = clean(name, 60);

      if (action === 'add') {
        if (!email) {
          return say(`I need an email address for ${name} before I can add them.`, { staged: false, needs: 'email' });
        }
        role = role ? clean(role, 60) : undefined;
        const notifyOn: store.NotifyReason[] =
          when === 'window_clear' ? ['window_clear'] : when === 'storm' ? ['storm'] : ['window_clear', 'storm'];
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
          { staged: true, name, notifyOn },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).crew.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added.`, { confirmed: false });
        store.update(id, (x) => {
          const c = x.crew.find((y) => sameName(y.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
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

}
