import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, request } from 'undici';
import { invalid } from '@/api/library/store.ts';

const privateAddresses = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) privateAddresses.addSubnet(address, prefix);

export async function destination(value: unknown) {
  let url: URL;
  try { url = new URL(value as string); } catch { invalid('callback_url must be a public HTTP(S) URL'); }
  if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('Invalid callback_url');
  // Pin a public IPv4 address for the connection so DNS rebinding cannot reach the private network.
  const host = url.hostname;
  if (host.startsWith("[")) invalid("callback_url requires public IPv4");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  const address = addresses.find(a => a.family === 4 && !privateAddresses.check(a.address));
  if (!address) invalid('callback_url must resolve to a public IPv4 address');
  return { url, address: address.address };
}

export async function deliver(url: string, body: unknown) {
  const target = await destination(url);
  const agent = new Agent({ connect: { timeout: 5000, lookup: (_host, options, callback: any) => {
    callback(null, options.all ? [{ address: target.address, family: 4 }] : target.address, 4);
  } } });
  try {
    const response = await request(target.url, {
      dispatcher: agent, method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), maxRedirections: 0,
    });
    await response.body.dump();
    if (response.statusCode < 200 || response.statusCode >= 300) throw Error('Callback rejected');
  } finally { await agent.destroy(); }
}
