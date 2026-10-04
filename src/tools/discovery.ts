/**
 * What this add-on can do, and who else it affects.
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
  NOAA_DOWN,
  UI,
  say,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Certification asks that an add-on can answer what it does, and that
   * every example phrase it offers actually works. Both matter more on a
   * screenless Echo, where there is nothing to read and no menu to browse.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_can_you_do',
    {
      title: 'What can this do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Explain what this add-on is for and how to ask for it. Call this when the customer asks what you can do, ' +
        'what this is, how to use it, or opens with something too vague to route. It changes nothing and needs no ' +
        'setup. Do not use it when the customer has asked a specific question, even a short one; use the tool for that.',
      inputSchema: {},
    },
    async () => {
      const farm = store.get(farmOf());
      const setup =
        !farm.fields.length || !farm.equipment.length
          ? ' To start, tell me a field and the nearest town.'
          : '';
      // Three sentences. It used to be 168 words, which nobody asking "what can you do" is waiting for.
      return say(
        'I tell you whether GPS guidance will hold the accuracy a field job needs, from the space weather forecast ' +
          'and where your field is. Ask me can I plant the north forty today, or when does it clear. I can also ' +
          'watch a blocked job and tell your crew when it clears.' + setup,
        {
          fullAnswer: true,
          examplePhrases: [
            'Can I plant the north forty today?',
            'When does it clear for the survey crew?',
            'What is the sun doing?',
          ],
          fieldsRegistered: farm.fields.length,
          equipmentRegistered: farm.equipment.length,
        },
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * "My guidance is out, what else is out?" The scales file already in
   * memory answers this; until now only G was read and the other two
   * were fetched and dropped.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_else_is_affected',
    {
      title: 'What else does this storm hit',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'What a space weather event affects besides satellite guidance: the power grid, shortwave radio, polar flights, ' +
        'satellite timing, pipelines and rail. Call this when someone asks what else is going on, whether it is safe, ' +
        'whether it will affect the power or the radio or their phone, or how bad it is generally. If they say what they ' +
        'operate or look after, such as HF radio, a grid, drones or flights, use what_should_i_do instead.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI } },
    },
    async () => {
      const snap = swpc.current();
      if (!snap) return say(NOAA_DOWN, { unavailable: true });
      const active = activeImpacts(snap.scales);
      return say(speakImpacts(snap.scales), {
        scales: snap.scales,
        impacts: active,
        // Worth stating plainly, because it is the thing people most often get wrong.
        householdElectronics: 'unaffected',
      });
    },
  );
}
