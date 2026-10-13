/**
 * A field by the name of the nearest town.
 *
 * Registering a field used to need its latitude and longitude, said aloud. Nobody standing in a yard knows
 * those numbers, and a voice assistant that asks for them has lost the customer at the first step. What a
 * farmer does know is the nearest town, and for space weather that is plenty: the storm's effect changes over
 * hundreds of kilometres, not over the distance from the town to the field.
 *
 * Open-Meteo's geocoder, which needs no key. One lookup, when a field is added and never while answering a
 * question about one, with a short timeout: if it does not answer, the customer is asked again rather than
 * left waiting.
 */

export type Place = { name: string; region: string | null; country: string | null; countryCode?: string | null; lat: number; lon: number; timeZone?: string | null };

type Row = { name: string; admin1?: string; country?: string; country_code?: string; latitude: number; longitude: number; timezone?: string };
type Lookup = (query: string) => Promise<Place | null>;

/** "Grand Island, Nebraska" or "Grand Island Nebraska": the town, and whatever narrows it down. */
export function split(query: string): { town: string; rest: string } {
  const q = query.trim().replace(/\s+/g, ' ').replace(/^(near|by|outside|around|close to)\s+/i, '');
  const comma = q.indexOf(',');
  if (comma > 0) return { town: q.slice(0, comma).trim(), rest: q.slice(comma + 1).trim() };
  return { town: q, rest: '' };
}

export function pick(query: string, rows: Row[]): Place | null {
  if (!rows.length) return null;
  const { rest } = split(query);
  const want = rest.toLowerCase();
  const hit = want
    ? rows.find((r) => [r.admin1, r.country, r.country_code].some((v) => (v ?? '').toLowerCase() === want)) ??
      rows.find((r) => [r.admin1, r.country].some((v) => (v ?? '').toLowerCase().includes(want)))
    : rows[0];
  // A region that was named and matches nothing is not answered with a town of the same name somewhere else.
  if (!hit) return null;
  return { name: hit.name, region: hit.admin1 ?? null, country: hit.country ?? null, countryCode: hit.country_code ?? null, lat: hit.latitude, lon: hit.longitude, timeZone: hit.timezone ?? null };
}

async function fetchPlace(query: string, timeoutMs = 2500): Promise<Place | null> {
  const { town, rest } = split(query);
  if (!town) return null;
  const tryName = async (name: string): Promise<Row[]> => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return [];
      const body = (await res.json()) as { results?: Row[] };
      return body.results ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
  const rows = await tryName(town);
  const found = pick(query, rows);
  if (found || rest) return found;
  // No comma was said: "Grand Island Nebraska". Try the last word, then the last two, as the region.
  const words = town.split(' ');
  for (const n of [1, 2]) {
    if (words.length <= n) continue;
    const again = `${words.slice(0, -n).join(' ')}, ${words.slice(-n).join(' ')}`;
    const hit = pick(again, await tryName(words.slice(0, -n).join(' ')));
    if (hit) return hit;
  }
  return null;
}

let lookup: Lookup = (query) => fetchPlace(query);
export const geocode: Lookup = (query) => lookup(query);

/** Test seam, so tests never reach the network. */
export function configureForTest(fn: Lookup | null): void {
  lookup = fn ?? ((query) => fetchPlace(query));
}

export const spoken = (p: Place): string => [p.name, p.region ?? p.country].filter(Boolean).join(', ');
