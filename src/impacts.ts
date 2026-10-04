/**
 * What else a storm is doing, besides moving your tractor.
 *
 * The server already fetches `noaa-scales.json`, which carries all three NOAA
 * scales, and until now used only G. That threw away the two that answer the
 * question people actually ask next: my guidance is out, what else is out?
 *
 *   G  geomagnetic storm   ground currents, grid, long conductors, GNSS accuracy
 *   S  solar radiation     polar radiation, aviation routing, satellite hardware
 *   R  radio blackout      HF absorption on the daylit side, 1 to 30 MHz
 *
 * Every entry here is a documented effect with a level attached, not a guess.
 * Nothing in this file claims a storm damages a phone, a car or a laptop,
 * because it does not. The damage lands on systems that depend on ionospheric
 * refraction, centimetre positioning or nanosecond timing, and saying otherwise
 * would be the fastest way to lose a reader who knows the field.
 */

export type Scale = 'G' | 'S' | 'R';

export type Impact = {
  scale: Scale;
  /** Minimum level on that scale before this is worth mentioning, 1 to 5. */
  from: number;
  system: string;
  /** One sentence, speakable. No jargon, because this gets read aloud. */
  effect: string;
  /** Who this actually lands on, used to decide whether to mention it at all. */
  audience: 'field' | 'infrastructure' | 'aviation' | 'comms' | 'space';
};

export const IMPACTS: Impact[] = [
  // ---- G, geomagnetic. Ground currents and everything standing on them. ----
  {
    scale: 'G',
    from: 1,
    system: 'satellite guidance',
    effect: 'Position error grows, worst at high magnetic latitude and on long baselines.',
    audience: 'field',
  },
  {
    scale: 'G',
    from: 1,
    system: 'the power grid',
    effect:
      'Changing magnetic fields push currents into transmission lines, reaching a hundred amps in a strong storm. ' +
      'At G1 that is weak voltage fluctuation; by G2 operators are seeing voltage alarms and transformer damage becomes possible in a long storm.',
    audience: 'infrastructure',
  },
  {
    scale: 'G',
    from: 2,
    system: 'pipelines and railway signalling',
    effect:
      'The same induced currents run in any long conductor, so buried pipe and signalling track see them too, not just power lines.',
    audience: 'infrastructure',
  },
  {
    scale: 'G',
    from: 2,
    system: 'satellite timing, which is not the same as satellite position',
    effect:
      'Satellite navigation is a clock as much as a map. Mobile networks hold sync to a few hundred nanoseconds, ' +
      'trading timestamps are regulated to a hundred microseconds, and grid phasor units and data centre fabrics both run on it. ' +
      'Timing fails quietly and in places nobody is watching.',
    audience: 'infrastructure',
  },
  {
    scale: 'G',
    from: 2,
    system: 'satellite orbit predictions',
    effect:
      'NOAA says ground control may need to correct satellite orientation, and changing drag throws off orbit predictions.',
    audience: 'space',
  },
  {
    scale: 'G',
    from: 2,
    system: 'directional drilling surveys',
    effect:
      'Magnetic surveys downhole read the same field the storm is shaking. In an Alaska storm it swung to twice the quality limits drillers work to.',
    audience: 'infrastructure',
  },
  {
    scale: 'G',
    from: 3,
    system: 'satellites in low orbit',
    effect:
      'A heated upper atmosphere swells and drags on anything low. A minor to moderate storm in February 2022 brought down ' +
      'thirty eight of forty nine Starlink satellites from a single launch, and twelve more Starlinks re-entered around the May 2024 storm.',
    audience: 'space',
  },

  // ---- R, radio blackout. Absorption on the daylit side. ----
  {
    scale: 'R',
    from: 1,
    system: 'shortwave radio',
    effect:
      'High frequency radio between one and thirty megahertz fades or drops on the sunlit half of the planet. ' +
      'That is what long distance aircraft, ships, emergency services and amateur operators are using.',
    audience: 'comms',
  },
  {
    scale: 'R',
    from: 1,
    system: 'low frequency navigation',
    effect: 'Low frequency navigation signals degrade for short intervals.',
    audience: 'comms',
  },
  {
    scale: 'R',
    from: 3,
    system: 'aviation communication',
    effect:
      'A severe blackout takes high frequency contact with it, which matters most on routes that have no other link.',
    audience: 'aviation',
  },

  // ---- S, solar radiation. Particles, worst over the poles. ----
  {
    scale: 'S',
    from: 1,
    system: 'polar flight routes',
    effect:
      'Radiation rises over the poles, so airlines move flights off polar routes and drop altitude to cut crew and passenger dose.',
    audience: 'aviation',
  },
  {
    scale: 'S',
    from: 2,
    system: 'satellite hardware',
    effect: 'Particle flux causes single event upsets in spacecraft electronics and degrades solar panels over time.',
    audience: 'space',
  },
];

const WORD_LEVEL: Record<string, number> = { none: 0, minor: 1, moderate: 2, strong: 3, severe: 4, extreme: 5 };

/**
 * A NOAA scale level from whatever form it arrives in: 2, "2", "G2", or the word
 * NOAA puts in the feed's Text field, "moderate". The first version only read
 * "G2" while the live feed sends the word, so every real storm scored 0 here and
 * this whole file went silent exactly when it mattered. Anything unrecognised
 * is treated as quiet.
 */
export function levelOf(code: string | number | null | undefined): number {
  if (code == null) return 0;
  if (typeof code === 'number') return Number.isFinite(code) ? Math.max(0, Math.min(5, Math.round(code))) : 0;
  const s = code.trim().toLowerCase();
  if (s in WORD_LEVEL) return WORD_LEVEL[s];
  const m = /^[gsr]?([0-5])$/.exec(s);
  return m ? Number(m[1]) : 0;
}

type ScaleReading = { g?: string | number | null; s?: string | number | null; r?: string | number | null };

/**
 * What is worth saying right now, given the three current scale readings.
 * Ordered so the loudest thing comes first, because this gets spoken and a
 * listener remembers the front of a sentence.
 */
export function activeImpacts(scales: ScaleReading): Impact[] {
  const level: Record<Scale, number> = {
    G: levelOf(scales.g),
    S: levelOf(scales.s),
    R: levelOf(scales.r),
  };
  return IMPACTS.filter((i) => level[i.scale] >= i.from).sort(
    (a, b) => level[b.scale] - b.from - (level[a.scale] - a.from),
  );
}

/**
 * A spoken answer to "what else is affected". Capped, because certification
 * asks for at most five options read aloud and because nobody listens to ten.
 */
export function speakImpacts(
  scales: ScaleReading,
  limit = 4,
): string {
  const active = activeImpacts(scales).filter((i) => i.audience !== 'field');
  if (!active.length) {
    return (
      'Nothing beyond your own guidance right now. The grid, shortwave radio and polar flights all sit below the level ' +
      'where operators start acting, and a storm this size does not touch phones, cars or anything in the house.'
    );
  }
  const parts = active.slice(0, limit).map((i) => `${i.system}: ${i.effect}`);
  // The tool takes no argument to ask for the rest, so it does not offer a rest. It names what was left out,
  // which the customer can ask about directly.
  const rest = active.slice(limit).map((i) => i.system.split(',')[0]);
  const more = rest.length ? ` It also reaches ${rest.slice(0, 3).join(', ')}.` : '';
  return `${parts.join(' ')}${more}`;
}
