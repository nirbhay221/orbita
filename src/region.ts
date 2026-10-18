/**
 * What changes at a border, for a field.
 *
 * The sky does not change at a border, and nothing in the verdict does either: exposure comes from geomagnetic
 * latitude, so a field in Bavaria, Punjab or Mato Grosso is judged where it sits. Two things that are said do
 * change, in the twelve countries Alexa+ is in (October 2026: the US, Canada, Mexico, Brazil, the UK, Germany,
 * Austria, France, Italy, Spain, Australia and India).
 *
 * Units. Drift was said in inches everywhere, which is right in Iowa and wrong in Saskatchewan, Lyon or Punjab,
 * where machines are set up in centimetres. Outside the United States inches become centimetres, and miles become
 * kilometres outside the US and the UK, where road distances are still in miles.
 *
 * The free satellite correction. "Is it RTK, WAAS, or are you not sure?" named the North American system. Each
 * region has its own, and a farmer knows it by that name:
 *   WAAS      the United States, Canada and Mexico (FAA).
 *   EGNOS     the European Union and its neighbours. The UK left the programme on 25 June 2021, which ended the
 *             safety-of-life service there for aviation; the open signal farmers use still reaches British fields.
 *   GAGAN     India (ISRO and the Airports Authority of India).
 *   SouthPAN  Australia and New Zealand: open services since September 2022, safety-of-life for aviation in 2028.
 *   none      Brazil has no SBAS of its own. Farms there run RTK or a satellite-delivered PPP service (PointPerfect,
 *             StarFire and others), so the question offers PPP instead.
 *
 * Sources:
 *   https://community.amazondeveloper.com/t/sept-21-2026-alexa-in-india-aws-builder-app/29198
 *   https://www.criticalcomms.com.au/content/radio-systems/news/southpan-milestone-means-improved-service-availability-1184064463
 *   https://flyer.co.uk/shapps-confirms-no-lpv-approaches-after-june/
 *   https://www.oxera.com/insights/reports/the-value-for-money-for-a-temporary-reinstatement-of-egnos/
 *   https://nordian.com/newsroom/nordian-extends-pointperfect-gnss-correction-coverage-across-brazils-agricultural-heartland-through-l-band-satellite-delivery
 *   https://repositorio.usp.br/directbitstream/bb7eacb9-1cd6-44c2-8b8e-0fef15dcc961/3005598-A%20statistical%20app...
 */

const code = (country: string | null | undefined): string => (country ?? '').toUpperCase();

const EGNOS = new Set([
  'GB', 'IE', 'FR', 'DE', 'AT', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU', 'CH', 'DK', 'NO', 'SE', 'FI', 'PL', 'CZ', 'SK',
  'HU', 'SI', 'HR', 'GR', 'CY', 'MT', 'RO', 'BG', 'EE', 'LV', 'LT', 'IS',
]);

/** The region's own free satellite correction, by the name farmers use; null where there is none. */
export function sbasName(country: string | null | undefined): string | null {
  const c = code(country);
  if (!c || ['US', 'CA', 'MX', 'PR'].includes(c)) return 'WAAS';
  if (EGNOS.has(c)) return 'EGNOS';
  if (c === 'IN') return 'GAGAN';
  if (c === 'AU' || c === 'NZ') return 'SouthPAN';
  if (c === 'JP') return 'MSAS';
  if (c === 'KR') return 'KASS';
  return null;
}

/** The middle choice in "Is it RTK, ..., or are you not sure?": the local SBAS, or PPP where there is none. */
export const secondChoice = (country: string | null | undefined): string => sbasName(country) ?? 'PPP';

/** Inches and miles are said only where people use them. An unknown country keeps the US units it always had. */
export const metric = (country: string | null | undefined): boolean => !!code(country) && !['US', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(code(country));

const cm = (inches: number): string => {
  const v = inches * 2.54;
  return v < 10 ? `${v.toFixed(1)} centimetres` : `${Math.round(v)} centimetres`;
};
const km = (miles: number): number => Math.max(1, Math.round(miles * 1.609));

/** Every distance said in a field's own units. Numbers that are not distances are left alone. */
export function localiseUnits(text: string, country: string | null | undefined): string {
  if (!metric(country)) return text;
  let out = text
    .replace(/\b(\d+(?:\.\d+)?) inches\b/g, (_m, n: string) => cm(Number(n)))
    .replace(/\b(\d+(?:\.\d+)?) feet\b/g, (_m, n: string) => `${(Number(n) * 0.3048).toFixed(1)} metres`);
  if (code(country) !== 'GB') {
    out = out
      .replace(/\bunder a mile\b/g, 'under 2 km')
      .replace(/\b(\d+(?:\.\d+)?) miles?\b/g, (_m, n: string) => `${km(Number(n))} km`);
  }
  return out;
}

/** The one country a farm's fields are in, when they are all in one; otherwise none. */
export function farmCountry(fields: { countryCode?: string }[]): string | null {
  const codes = [...new Set(fields.map((f) => code(f.countryCode)).filter(Boolean))];
  return codes.length === 1 ? codes[0] : null;
}
