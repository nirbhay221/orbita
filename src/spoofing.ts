/**
 * Where GPS is jammed and spoofed as a matter of course.
 *
 * Space weather blurs a position, and a receiver usually knows: its error estimate grows, RTK drops to float.
 * Spoofing is worse. A transmitter imitates the satellites, the receiver locks on, and it reports a confident,
 * wrong position with no warning at all. Nothing published says, hour by hour, where that is happening on the
 * ground. What is published is where it happens routinely, by the two aviation regulators whose job is to warn
 * pilots about it:
 *
 *   The FAA's GPS/GNSS Interference Resource Guide, version 1.1 (March 2026), names the areas most affected by
 *   spoofing: the eastern Mediterranean, the Black Sea, Russia and the Baltic region, the India and Pakistan
 *   border, Iraq and Iran, North and South Korea, and the area around Beijing.
 *   EASA's Safety Information Bulletin 2022-02R4 (July 2026) names the areas around conflict zones: the south and
 *   eastern Mediterranean, the Black Sea, the Middle East, the Baltic Sea and the Arctic.
 *
 * The boxes below are drawn around those named regions. They are not the regulators' own borders, which are
 * given by flight information region and change, and they say "regularly reported", never "happening now". A
 * position inside one is told to verify before acting, with the check that catches spoofing: compare against
 * something that does not use GPS, and treat a position or a clock that jumps as a sign of it.
 *
 * Sources:
 *   https://nbaa.org/aircraft-operations/communications-navigation-surveillance-cns/global-positioning-system-gps/gps-interference/faa-publishes-updated-gps-gnss-interferences-jamming-and-spoofing-resource/
 *   https://www.easa.europa.eu/en/newsroom-and-events/news/easa-updates-safety-information-bulletin-gnss-interference
 *   https://ad.easa.europa.eu/blob/EASA_SIB_2022_02R4.pdf/SIB_2022-02R4_1
 */

export type Zone = { name: string; source: 'FAA' | 'EASA' | 'FAA and EASA' };
type Box = { lat: [number, number]; lon: [number, number] };

const ZONES: (Zone & { boxes: Box[] })[] = [
  { name: 'the eastern Mediterranean', source: 'FAA and EASA', boxes: [{ lat: [31.0, 37.5], lon: [29.0, 36.6] }] },
  { name: 'the Black Sea', source: 'FAA and EASA', boxes: [{ lat: [40.8, 47.2], lon: [27.4, 42.0] }] },
  { name: 'the Baltic region', source: 'FAA and EASA', boxes: [{ lat: [53.5, 61.0], lon: [17.5, 30.5] }] },
  { name: 'the Arctic north of Norway and Finland', source: 'EASA', boxes: [{ lat: [68.0, 71.5], lon: [20.0, 36.0] }] },
  { name: 'Iraq and Iran', source: 'FAA and EASA', boxes: [{ lat: [29.0, 38.5], lon: [38.5, 56.0] }] },
  { name: 'the Persian Gulf', source: 'EASA', boxes: [{ lat: [24.0, 30.5], lon: [47.5, 57.0] }] },
  { name: 'the Caucasus', source: 'EASA', boxes: [{ lat: [38.4, 43.6], lon: [40.0, 50.5] }] },
  { name: 'northern Libya', source: 'EASA', boxes: [{ lat: [30.5, 33.5], lon: [11.0, 25.0] }] },
  { name: 'the India and Pakistan border', source: 'FAA', boxes: [{ lat: [24.0, 34.5], lon: [69.5, 76.0] }] },
  { name: 'the Korean peninsula', source: 'FAA', boxes: [{ lat: [37.0, 39.0], lon: [124.5, 129.0] }] },
  { name: 'the area around Beijing', source: 'FAA', boxes: [{ lat: [39.0, 41.0], lon: [115.5, 117.6] }] },
];

/** The region a point is in, or null. */
export function zoneAt(lat: number, lon: number): Zone | null {
  const z = ZONES.find((x) => x.boxes.some((b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]));
  return z ? { name: z.name, source: z.source } : null;
}

/** "The FAA and EASA" or "EASA", as it is said. */
export const whoSays = (z: Zone): string => (z.source === 'FAA and EASA' ? 'The FAA and EASA list' : `${z.source === 'FAA' ? 'The FAA lists' : 'EASA lists'}`);

/** The reason, for an agent's verdict. */
export const reason = (z: Zone): string =>
  `${whoSays(z).replace(/^The /, 'the ')} ${z.name} as an area where GPS is regularly jammed and spoofed, and spoofing gives a confident wrong position with no warning`;

/** What a person hears ahead of a job. */
export const sayAhead = (z: Zone): string =>
  `One thing that is not the sun: ${whoSays(z).replace(/^The /, 'the ')} ${z.name} for regular GPS jamming and spoofing, so check your line against a marker you know before you trust it. ` +
  'Spoofing gives a confident wrong position with no warning, so if the position or the clock jumps, stop.';

export const SOURCES = [
  'https://nbaa.org/aircraft-operations/communications-navigation-surveillance-cns/global-positioning-system-gps/gps-interference/faa-publishes-updated-gps-gnss-interferences-jamming-and-spoofing-resource/',
  'https://ad.easa.europa.eu/blob/EASA_SIB_2022_02R4.pdf/SIB_2022-02R4_1',
];
