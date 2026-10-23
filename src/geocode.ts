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
  // How people place a field against a town: "near Ames", "just outside Ames", "north of Fargo", "20 miles from Fargo".
  // A storm does not change over those distances, so the town is the answer. Only "near" and four others were known.
  const q = query.trim().replace(/\s+/g, ' ')
    .replace(/^(just |right |a bit |a little )?(near|by|outside( of)?|around|close to|next to|beside|(about |some )?\d+(\.\d+)? ?(miles?|mi|km|kilometres?|kilometers?) (from|outside( of)?|out of|(north|south|east|west|northeast|northwest|southeast|southwest) of)|(north|south|east|west|northeast|northwest|southeast|southwest) of)\s+/i, '');
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

/**
 * Somebody who names only a state or a province: "our control room in Minnesota". The geocoder has no entry for a
 * state as a whole, only for places, so it answered with the hamlet of Minnesota, Georgia, 1,500 km south and a
 * different storm exposure. A storm changes over hundreds of kilometres, so the middle of the state is a fair answer,
 * and it is said as that. A city of the same name that people mean by it, New York, is kept.
 */
const REGION_CENTRES: Record<string, [number, number]> = {
  Alabama: [32.8, -86.8], Alaska: [64.0, -150.0], Arizona: [34.3, -111.7], Arkansas: [34.9, -92.4], California: [37.2, -119.5],
  Colorado: [39.0, -105.5], Connecticut: [41.6, -72.7], Delaware: [39.0, -75.5], Florida: [28.6, -82.4], Georgia: [32.7, -83.4],
  Hawaii: [20.8, -156.3], Idaho: [44.4, -114.6], Illinois: [40.0, -89.2], Indiana: [39.9, -86.3], Iowa: [42.1, -93.5],
  Kansas: [38.5, -98.4], Kentucky: [37.5, -85.3], Louisiana: [31.1, -92.0], Maine: [45.4, -69.2], Maryland: [39.0, -76.8],
  Massachusetts: [42.3, -71.8], Michigan: [44.3, -85.4], Minnesota: [46.3, -94.3], Mississippi: [32.7, -89.7], Missouri: [38.4, -92.5],
  Montana: [47.0, -109.6], Nebraska: [41.5, -99.8], Nevada: [39.3, -116.6], 'New Hampshire': [43.7, -71.6], 'New Jersey': [40.2, -74.7],
  'New Mexico': [34.4, -106.1], 'New York': [42.9, -75.5], 'North Carolina': [35.6, -79.4], 'North Dakota': [47.5, -100.5], Ohio: [40.3, -82.8],
  Oklahoma: [35.6, -97.5], Oregon: [43.9, -120.6], Pennsylvania: [40.9, -77.8], 'Rhode Island': [41.7, -71.5], 'South Carolina': [33.9, -80.9],
  'South Dakota': [44.4, -100.2], Tennessee: [35.9, -86.4], Texas: [31.5, -99.3], Utah: [39.3, -111.7], Vermont: [44.1, -72.7],
  Virginia: [37.5, -78.9], Washington: [47.4, -120.5], 'West Virginia': [38.6, -80.6], Wisconsin: [44.6, -89.9], Wyoming: [43.0, -107.6],
  'District of Columbia': [38.9, -77.0],
  Alberta: [53.9, -116.6], 'British Columbia': [53.7, -127.6], Manitoba: [53.8, -98.8], 'New Brunswick': [46.6, -66.5],
  'Newfoundland and Labrador': [53.1, -57.7], 'Nova Scotia': [45.0, -63.0], 'Northwest Territories': [64.8, -124.8], Nunavut: [70.3, -83.1],
  Ontario: [50.0, -85.3], 'Prince Edward Island': [46.5, -63.4], Quebec: [52.9, -73.5], Saskatchewan: [52.9, -106.5], Yukon: [64.3, -135.0],
};

/*
 * The same, for the farming regions of the other countries Alexa+ is in. "Bavaria" found a village of that name in
 * Veneto, Italy, and "Mato Grosso" a town in Paraíba, 2,000 km from the soybean state. Names that are as often a city
 * ("Victoria") are left out, so they are looked up as places.
 */
const ABROAD: Record<string, { name: string; country: string; at: [number, number] }> = Object.fromEntries(([
  ['New South Wales', 'AU', -32.2, 147.0], ['Queensland', 'AU', -22.6, 144.1], ['South Australia', 'AU', -30.0, 135.8],
  ['Western Australia', 'AU', -25.3, 122.3], ['Tasmania', 'AU', -42.0, 146.6], ['Northern Territory', 'AU', -19.4, 133.4],
  ['Bavaria', 'DE', 48.9, 11.4, 'Bayern'], ['Lower Saxony', 'DE', 52.6, 9.8, 'Niedersachsen'], ['Baden-Württemberg', 'DE', 48.5, 9.0, 'Baden-Wurttemberg'],
  ['Brandenburg', 'DE', 52.4, 13.4], ['Mecklenburg-Vorpommern', 'DE', 53.6, 12.4], ['Saxony', 'DE', 51.0, 13.3, 'Sachsen'],
  ['Saxony-Anhalt', 'DE', 52.0, 11.7, 'Sachsen-Anhalt'], ['Schleswig-Holstein', 'DE', 54.2, 9.8], ['North Rhine-Westphalia', 'DE', 51.5, 7.6, 'Nordrhein-Westfalen'],
  ['Hesse', 'DE', 50.6, 9.0, 'Hessen'], ['Thuringia', 'DE', 50.9, 11.0, 'Thüringen'], ['Rhineland-Palatinate', 'DE', 49.9, 7.4, 'Rheinland-Pfalz'],
  ['Mato Grosso', 'BR', -12.6, -55.4], ['Mato Grosso do Sul', 'BR', -20.5, -54.8], ['Goiás', 'BR', -15.9, -49.6, 'Goias'],
  ['Paraná', 'BR', -24.6, -51.6, 'Parana'], ['Rio Grande do Sul', 'BR', -29.7, -53.2], ['Minas Gerais', 'BR', -18.5, -44.6],
  ['Bahia', 'BR', -12.5, -41.7], ['Tocantins', 'BR', -10.2, -48.3], ['Maranhão', 'BR', -5.4, -45.4, 'Maranhao'],
  ['Piauí', 'BR', -7.7, -42.7, 'Piaui'], ['Santa Catarina', 'BR', -27.2, -50.5], ['São Paulo', 'BR', -22.3, -48.7, 'Sao Paulo'],
  ['Punjab', 'IN', 30.9, 75.4], ['Haryana', 'IN', 29.1, 76.1], ['Uttar Pradesh', 'IN', 26.8, 80.9], ['Madhya Pradesh', 'IN', 23.5, 78.4],
  ['Maharashtra', 'IN', 19.4, 75.7], ['Gujarat', 'IN', 22.7, 71.6], ['Rajasthan', 'IN', 26.6, 73.8], ['Karnataka', 'IN', 15.0, 75.7],
  ['Andhra Pradesh', 'IN', 15.9, 79.7], ['Telangana', 'IN', 17.9, 79.0], ['Tamil Nadu', 'IN', 11.1, 78.4], ['Bihar', 'IN', 25.9, 85.6],
  ['West Bengal', 'IN', 23.0, 87.9], ['Sinaloa', 'MX', 25.0, -107.5], ['Sonora', 'MX', 29.6, -110.9], ['Jalisco', 'MX', 20.6, -103.6],
  ['Tamaulipas', 'MX', 24.3, -98.8], ['England', 'GB', 52.6, -1.5], ['Scotland', 'GB', 56.5, -4.2], ['Wales', 'GB', 52.3, -3.8],
  ['Northern Ireland', 'GB', 54.6, -6.7], ['Lombardy', 'IT', 45.6, 9.8, 'Lombardia'], ['Emilia-Romagna', 'IT', 44.5, 11.0],
  ['Andalusia', 'ES', 37.5, -4.7, 'Andalucía'], ['Brittany', 'FR', 48.2, -2.9, 'Bretagne'], ['Normandy', 'FR', 49.1, 0.2, 'Normandie'],
] as [string, string, number, number, string?][]).flatMap(([name, country, lat, lon, alias]) => {
  const v = { name, country, at: [lat, lon] as [number, number] };
  return [[name.toLowerCase(), v], ...(alias ? [[alias.toLowerCase(), v]] : [])];
}));

/** State abbreviations beside the US and Canadian ones: "Wagga Wagga NSW", "Rondonópolis MT". Tried when the first reading finds nothing. */
const ABROAD_SHORT: Record<string, string> = {
  NSW: 'New South Wales, Australia', QLD: 'Queensland, Australia', VIC: 'Victoria, Australia', SA: 'South Australia, Australia',
  WA: 'Western Australia, Australia', TAS: 'Tasmania, Australia', NT: 'Northern Territory, Australia',
  MT: 'Mato Grosso, Brazil', MS: 'Mato Grosso do Sul, Brazil', GO: 'Goiás, Brazil', PR: 'Paraná, Brazil', RS: 'Rio Grande do Sul, Brazil',
  MG: 'Minas Gerais, Brazil', BA: 'Bahia, Brazil', TO: 'Tocantins, Brazil', MA: 'Maranhão, Brazil', PI: 'Piauí, Brazil',
  SC: 'Santa Catarina, Brazil', SP: 'São Paulo, Brazil',
};
export function abroadReading(query: string): string | null {
  const m = /^(.+?)[,\s]+([A-Za-z]{2,3})\.?$/.exec(query.trim());
  const full = m ? ABROAD_SHORT[m[2].toUpperCase()] : undefined;
  return m && full ? `${m[1].replace(/,\s*$/, '')}, ${full}` : null;
}

/** A query that is only a country: too big to judge from its middle, so the customer is asked for a town instead. */
export function countryOnly(query: string): boolean {
  const { town, rest } = split(query);
  if (rest) return false;
  const n = narrowing(town);
  return !n.region && !!n.country && !ABROAD[town.trim().toLowerCase()];
}

/** A query that is only a state, a province or a farming region, as the middle of it; null for anything else. */
export function regionOnly(query: string, rows: Row[]): Place | null {
  const { town, rest } = split(query);
  if (rest || /^[a-z]{2}\.?$/i.test(town)) return null;
  const abroad = ABROAD[town.trim().toLowerCase()];
  if (abroad) {
    const big = rows.find((r) => r.name.toLowerCase() === abroad.name.toLowerCase() && (r.admin1 ?? '').toLowerCase() === abroad.name.toLowerCase() && (r.population ?? 0) >= 100_000);
    if (big) return { name: big.name, region: big.admin1 ?? null, country: big.country ?? countryName(big.country_code), countryCode: big.country_code ?? null, lat: big.latitude, lon: big.longitude, timeZone: big.timezone ?? null };
    return { name: `central ${abroad.name}`, region: null, country: countryName(abroad.country), countryCode: abroad.country, lat: abroad.at[0], lon: abroad.at[1], timeZone: null };
  }
  const { region, country } = narrowing(town);
  const centre = region ? REGION_CENTRES[region] : undefined;
  if (!region || !centre) return null;
  const city = rows.find((r) => r.name.toLowerCase() === region.toLowerCase() && (r.admin1 ?? '').toLowerCase() === region.toLowerCase() && (r.population ?? 0) >= 100_000);
  if (city) return { name: city.name, region: city.admin1 ?? null, country: city.country ?? countryName(city.country_code), countryCode: city.country_code ?? null, lat: city.latitude, lon: city.longitude, timeZone: city.timezone ?? null };
  return { name: `central ${region}`, region: null, country: countryName(country), countryCode: country, lat: centre[0], lon: centre[1], timeZone: null };
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
  const rows = await tryName(town);
  return regionOnly(query, rows) ?? pick(query, rows);
}

/**
 * A whole address, said the way it is written on an envelope: "3130 W Stolley Park Rd, Grand Island, Nebraska 68801,
 * USA". Everything before the first comma was taken as the town, so the geocoder was asked for a town called "3130 W
 * Stolley Park Rd", and "Nebraska 68801" was not a state it knew; both came back "I couldn't find". A storm does not
 * change between a street and its town, so the street is dropped and the postal code taken out, and when the town
 * still cannot be found the postal code is looked up on its own, which the geocoder accepts.
 */
const POSTAL = /\b\d{5}(?:-\d{3,4})?\b|\b\d{6}\b|\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/i;
// A street word ends an English address part ("Stolley Park Rd") and starts most others ("Avenida Blumenau"). At the
// start in English it is a town: "St. Paul".
const STREET_END = /\b(rd|road|st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|sq|square|strasse|straße)\.?$/i;
const STREET_START = /^(avenida|av\.|rua|calle|carrer|via|rue|chemin)\s/i;
const streetLike = (part: string): boolean => /\d/.test(part) || STREET_END.test(part) || STREET_START.test(part);
export function simplify(query: string): { query: string; postal: string | null } {
  const postal = POSTAL.exec(query)?.[0] ?? null;
  let parts = query.split(',').map((p) => p.replace(POSTAL, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A leading part with a house number or a street word is the street, when something after it can be the town.
  while (parts.length > 1 && streetLike(parts[0])) parts = parts.slice(1);
  return { query: parts.join(', '), postal };
}

async function fetchAddress(query: string): Promise<Place | null> {
  const { query: cleaned, postal } = simplify(query);
  // Nothing left but a state or a country, "68801, USA": the postal code is the place.
  const first = narrowing(cleaned.split(',')[0] ?? '');
  if (postal && (!cleaned || first.region || first.country)) {
    const byPostal = await fetchPlace(postal);
    if (byPostal) return byPostal;
  }
  // "Brazil" or "USA" alone: the middle of a country is not where anybody's field is, and "USA" found Uşak in Turkey.
  if (!postal && countryOnly(cleaned)) return null;
  const found = cleaned ? await fetchPlace(cleaned) : null;
  if (found) return found;
  // A state abbreviation abroad, "Rondonópolis MT", which the first reading took for Montana.
  const abroad = abroadReading(cleaned);
  if (abroad) {
    const hit = await fetchPlace(abroad);
    if (hit) return hit;
  }
  // A region said with no comma, "Ludhiana Punjab": the last one or two words as the region.
  if (!cleaned.includes(',')) {
    const words = cleaned.split(' ');
    for (const n of [1, 2]) {
      if (words.length <= n) continue;
      const hit = await fetchPlace(`${words.slice(0, -n).join(' ')}, ${words.slice(-n).join(' ')}`);
      if (hit) return hit;
    }
  }
  return postal ? fetchPlace(postal) : null;
}

let lookup: Lookup = (query) => fetchAddress(query);
export const geocode: Lookup = (query) => lookup(query);

/** Test seam, so tests never reach the network. */
export function configureForTest(fn: Lookup | null): void {
  lookup = fn ?? ((query) => fetchAddress(query));
}

export const spoken = (p: Place): string => [p.name, p.region ?? p.country].filter(Boolean).join(', ');
