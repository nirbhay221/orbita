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

type Row = { name: string; admin1?: string; country?: string; country_code?: string; latitude: number; longitude: number; timezone?: string; population?: number };
type Lookup = (query: string) => Promise<Place | null>;

/** "Grand Island, Nebraska" or "Grand Island Nebraska": the town, and whatever narrows it down. */
export function split(query: string): { town: string; rest: string } {
  const q = query.trim().replace(/\s+/g, ' ').replace(/^(near|by|outside|around|close to)\s+/i, '');
  const comma = q.indexOf(',');
  if (comma > 0) return { town: q.slice(0, comma).trim(), rest: q.slice(comma + 1).trim() };
  return { town: q, rest: '' };
}

/**
 * The places a farmer names after the town, in the forms they are said: "IA", "Sask", "UK".
 *
 * Only full names used to be matched, and a two letter state was matched as a fragment of any region name,
 * so "Ames, IA" found Ames in Galicia (Spain has no Iowa, but "Galicia" has an "ia" in it), "Fargo ND" found
 * Fargo, Indiana, and "Salina, KS" and "Lubbock, TX" found nothing at all.
 */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const CA_PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon', SASK: 'Saskatchewan', ALTA: 'Alberta', MAN: 'Manitoba', ONT: 'Ontario', QUE: 'Quebec',
};
/** Country names as people say them, to the two letter code the geocoder carries. */
const COUNTRY_SAID: Record<string, string> = {
  us: 'US', usa: 'US', america: 'US', 'united states': 'US', 'united states of america': 'US',
  uk: 'GB', britain: 'GB', 'great britain': 'GB', 'united kingdom': 'GB', uae: 'AE',
};
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code?: string | null): string | null => {
  if (!code) return null;
  try {
    return regionNames.of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
};

/** "France", "Puerto Rico", "India" to their codes, from the same names Intl gives the codes. */
let byName: Map<string, string> | null = null;
// Retired codes share a name with today's: DD reads "Germany" and comes before DE, so "Hannover, Germany" was
// searched in East Germany and found nothing. The same for Serbia, Vietnam, Yemen, Myanmar and a few more.
const RETIRED = new Set(['AN', 'BU', 'CS', 'DD', 'DY', 'FX', 'HV', 'NH', 'RH', 'SU', 'TP', 'UK', 'VD', 'YD', 'YU', 'ZR']);
const codeOfCountry = (name: string): string | null => {
  if (!byName) {
    byName = new Map();
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
      const n = countryName(a + b);
      if (n && n !== a + b && !RETIRED.has(a + b) && !/unknown/i.test(n) && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), a + b);
    }
  }
  return byName.get(name.toLowerCase()) ?? null;
};

/** What was said after the town, as a region, a country code, or both. */
export function narrowing(rest: string): { region: string | null; country: string | null; said: string } {
  // A region and a country: "Mato Grosso, Brazil", "Saskatchewan, Canada", "Texas, USA". A known state or
  // province settles it; otherwise the last part is the country and the first is the region to look for.
  if (rest.includes(',')) {
    const parts = rest.split(',').map((x) => x.trim()).filter(Boolean);
    const first = narrowing(parts[0]);
    if (first.region) return first;
    const last = narrowing(parts[parts.length - 1]);
    return { region: null, country: last.country ?? first.country, said: parts[0] };
  }
  const said = rest.trim().replace(/\.$/, '').replace(/^the /i, '');
  const up = said.toUpperCase().replace(/\./g, '');
  if (US_STATES[up]) return { region: US_STATES[up], country: 'US', said };
  if (CA_PROVINCES[up]) return { region: CA_PROVINCES[up], country: 'CA', said };
  const lower = said.toLowerCase();
  const bare = lower.replace(/\./g, '');
  const state = Object.values(US_STATES).find((n) => n.toLowerCase() === lower);
  if (state) return { region: state, country: 'US', said };
  const province = Object.values(CA_PROVINCES).find((n) => n.toLowerCase() === lower);
  if (province) return { region: province, country: 'CA', said };
  if (COUNTRY_SAID[bare]) return { region: null, country: COUNTRY_SAID[bare], said };
  const named = codeOfCountry(said);
  if (named) return { region: null, country: named, said };
  if (/^[a-z]{2}$/i.test(said) && countryName(said) && countryName(said) !== said.toUpperCase()) return { region: null, country: said.toUpperCase(), said };
  return { region: null, country: null, said };
}

const biggest = (rows: Row[]): Row | undefined => rows.reduce<Row | undefined>((a, r) => (!a || (r.population ?? 0) > (a.population ?? 0) ? r : a), undefined);

export function pick(query: string, rows: Row[]): Place | null {
  if (!rows.length) return null;
  const { rest } = split(query);
  let hit: Row | undefined;
  if (!rest) hit = rows[0];
  else {
    const { region, country, said } = narrowing(rest);
    const want = said.toLowerCase();
    const names = (r: Row) => [r.admin1, r.country, r.country_code, countryName(r.country_code)].map((v) => (v ?? '').toLowerCase());
    if (region) hit = rows.find((r) => (r.admin1 ?? '').toLowerCase() === region.toLowerCase() && (!country || !r.country_code || r.country_code === country));
    // Within a country, the biggest place of that name: the first "Wagga Wagga, Australia" the lookup gave was a
    // locality in Western Australia, not the city of 57,000 in New South Wales.
    else if (country) hit = rows.find((r) => r.country_code === country && (r.admin1 ?? '').toLowerCase() === want) ?? biggest(rows.filter((r) => r.country_code === country));
    // A region the tables above do not know, "Punjab" or "Bavaria", is matched by name, whole words only.
    else hit = rows.find((r) => names(r).includes(want)) ?? (want.length >= 3 ? rows.find((r) => names(r).some((v) => ` ${v} `.includes(` ${want} `))) : undefined);
  }
  // A region that was named and matches nothing is not answered with a town of the same name somewhere else.
  if (!hit) return null;
  return { name: hit.name, region: hit.admin1 ?? null, country: hit.country ?? countryName(hit.country_code), countryCode: hit.country_code ?? null, lat: hit.latitude, lon: hit.longitude, timeZone: hit.timezone ?? null };
}

/** The geocoder did not answer. Not the same as a town it does not know, which is null. */
export class GeocoderDown extends Error {}

/** Said when the lookup itself failed, so the farmer tries again instead of trying another town. */
export const lookupDown = (place: string): string =>
  `I can't reach the map service to look up ${place} right now. Ask me again in a minute.`;

async function fetchPlace(query: string, timeoutMs = 2500): Promise<Place | null> {
  const { town, rest } = split(query);
  if (!town) return null;
  const tryName = async (name: string, within?: string | null): Promise<Row[]> => {
    // Searched within the country that was named: ten worldwide answers for "Columbia" hold no Columbia, Missouri.
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json${within ? `&countryCode=${within}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new GeocoderDown(`HTTP ${res.status}`);
      const body = (await res.json()) as { results?: Row[] };
      return body.results ?? [];
    } catch (err) {
      // A lookup that timed out is not a town that does not exist, and must not be told as one.
      throw err instanceof GeocoderDown ? err : new GeocoderDown(String(err));
    } finally {
      clearTimeout(timer);
    }
  };
  if (rest) return pick(query, await tryName(town, narrowing(rest).country));
  // No comma was said: "Fargo ND", "Grand Island Nebraska". When the last words are a state, a province or a
  // country, that split is tried first: the whole string searched as one name can find Fargo, Indiana.
  const words = town.split(' ');
  for (const n of [2, 1]) {
    if (words.length <= n) continue;
    const { region, country } = narrowing(words.slice(-n).join(' '));
    // Only a last word that is a place: "Grand Island" is not the town "Grand" on the island.
    if (!region && !country) continue;
    const hit = pick(`${words.slice(0, -n).join(' ')}, ${words.slice(-n).join(' ')}`, await tryName(words.slice(0, -n).join(' '), country));
    if (hit) return hit;
  }
  return pick(query, await tryName(town));
}

let lookup: Lookup = (query) => fetchPlace(query);
export const geocode: Lookup = (query) => lookup(query);

/** Test seam, so tests never reach the network. */
export function configureForTest(fn: Lookup | null): void {
  lookup = fn ?? ((query) => fetchPlace(query));
}

export const spoken = (p: Place): string => [p.name, p.region ?? p.country].filter(Boolean).join(', ');
