/**
 * Pushing the machine alert to a fleet's own software, for machines that cannot read an email.
 *
 * machinealerts.ts made the alert a feed to poll, on purpose: a server that calls whatever address its users give
 * it can be turned against other people's machines. A robot fleet should not have to poll, though, so this pushes,
 * built the way published SSRF advisories say to:
 *
 *   - https on port 443 only, no user name or password in the address;
 *   - the name is looked up when sending, every address it resolves to must be public (no loopback, private,
 *     link-local such as the cloud metadata address, carrier-grade NAT, multicast or reserved ranges, in IPv4 or
 *     IPv6, including IPv4 written inside IPv6), and the connection is made to the address that was checked, so a
 *     second lookup cannot swap in an internal one (DNS rebinding);
 *   - redirects are never followed; five seconds, a small body, and nothing read back but the status.
 *     https://www.getconvoy.io/docs/webhook-guides/tackling-ssrf
 *
 * Each message is signed as the Standard Webhooks specification lays out (webhook-id, webhook-timestamp,
 * webhook-signature: v1 and an HMAC-SHA256 over "id.timestamp.body", with a whsec_ secret), so the fleet can tell
 * it came from here and is not a replay. https://www.standardwebhooks.com/
 *
 * The demo page's sandboxes never call out at all, as they never send email: what would be sent is shown on the page.
 */

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

// Two lists: Node checks an IPv4 address against IPv6 rules as if it were IPv4 written inside IPv6, so one list
// with ::ffff:0:0/96 in it closed every IPv4 address.
const closed4 = new BlockList();
const closed6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) closed4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) closed6.addSubnet(net, bits, 'ipv6');

/** Whether an address is somewhere on the public internet. IPv4 written inside IPv6 is judged as the IPv4 it is. */
export function publicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return publicAddress(mapped[1]);
  const family = isIP(ip);
  if (!family) return false;
  return family === 4 ? !closed4.check(ip, 'ipv4') : !closed6.check(ip, 'ipv6');
}

export type Checked = { ok: true; url: URL; address: string; family: 4 | 6 } | { ok: false; why: string };

/** The address as given, judged before anything is sent to it. */
export async function checkUrl(raw: string, resolve: typeof lookup = lookup): Promise<Checked> {
  let url: URL;
  try { url = new URL(String(raw).trim()); } catch { return { ok: false, why: 'That is not a web address.' }; }
  if (String(raw).length > 300) return { ok: false, why: 'That address is too long.' };
  if (url.protocol !== 'https:') return { ok: false, why: 'The address has to start with https.' };
  if (url.username || url.password) return { ok: false, why: 'The address cannot carry a user name or password.' };
  if (url.port && url.port !== '443') return { ok: false, why: 'Only the standard https port, 443, is used.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return { ok: false, why: 'That address is not on the public internet.' };
  let found: { address: string; family: number }[];
  try {
    found = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, why: `${host} could not be looked up.` };
  }
  if (!found.length) return { ok: false, why: `${host} could not be looked up.` };
  if (found.some((a) => !publicAddress(a.address))) return { ok: false, why: 'That address is not on the public internet.' };
  return { ok: true, url, address: found[0].address, family: found[0].family === 6 ? 6 : 4 };
}

export const newSecret = (): string => `whsec_${randomBytes(24).toString('base64')}`;

/** Standard Webhooks: v1, then base64 of HMAC-SHA256 with the decoded secret over "id.timestamp.body". */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export type Pushed = { ok: boolean; status?: number; why?: string };

/** Sends one signed message. Never throws; says why when it did not arrive. */
export async function push(raw: string, secret: string, payload: unknown, resolve: typeof lookup = lookup): Promise<Pushed> {
  const checked = await checkUrl(raw, resolve);
  if (!checked.ok) return { ok: false, why: checked.why };
  const body = JSON.stringify(payload);
  if (body.length > 64_000) return { ok: false, why: 'The message was too large to send.' };
  const id = `msg_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  return new Promise<Pushed>((done) => {
    const req = request(
      {
        // The address that was checked, not the name, so a second lookup cannot point it somewhere else. The name
        // still goes in the Host header and to TLS, which checks the certificate against it.
        host: checked.address,
        family: checked.family,
        servername: isIP(checked.url.hostname) ? undefined : checked.url.hostname,
        port: 443,
        method: 'POST',
        path: `${checked.url.pathname}${checked.url.search}`,
        agent: false,
        timeout: 5000,
        headers: {
          host: checked.url.host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Orbita-Alerts/1',
          'webhook-id': id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': sign(secret, id, timestamp, body),
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        done(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, why: status >= 300 && status < 400 ? 'It answered with a redirect, which is not followed.' : `It answered ${status}.` });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ ok: false, why: err.message === 'timeout' ? 'It did not answer within five seconds.' : 'It could not be reached.' }));
    req.end(body);
  });
}
