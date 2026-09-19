/**
 * Saying times where the field is.
 *
 * NOAA publishes in UTC and a cloud server runs in UTC, so a bare "Thursday
 * 7 pm" means seven in the evening in Greenwich, and a farmer in Iowa hears two
 * in the afternoon. The first version formatted times in whatever zone the
 * server happened to be in, with no label, which was right only by accident on
 * a laptop in the same state as the field.
 *
 * Each field's IANA timezone is looked up once when it is added, from
 * Open-Meteo, which answers with the zone for any latitude and longitude. That
 * call takes about as long as Alexa+ allows for a whole turn, so it runs in the
 * background, and until it lands times are said in UTC and labelled UTC rather
 * than guessed.
 */

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

type Lookup = (lat: number, lon: number) => Promise<string | null>;
let lookup: Lookup = (lat, lon) => fetchTimeZone(lat, lon);

export const lookupTimeZone: Lookup = (lat, lon) => lookup(lat, lon);

/** Tests swap the lookup so nothing touches the network. */
export function configureForTest(fn: Lookup): void {
  lookup = fn;
}

async function fetchTimeZone(lat: number, lon: number, timeoutMs = 8000): Promise<string | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m&forecast_days=1&timezone=auto';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { timezone?: string };
    return body.timezone && validZone(body.timezone) ? body.timezone : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "Wed 7 PM CDT" where the field is, or "Thu 12 AM UTC" while its zone is not known yet. */
export function spokenTime(iso: string, timeZone?: string | null): string {
  const zone = timeZone && validZone(timeZone) ? timeZone : 'UTC';
  return new Date(iso)
    .toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' })
    .replace(/,/g, '')
    .replace(/:00(?= )/, '');
}
