import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export type ClientRequest = {
  socket: Pick<IncomingMessage["socket"], "remoteAddress">;
  headers: IncomingMessage["headers"];
};
const privatePeers = new BlockList();
for (const [address, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16]] as const) {
  privatePeers.addSubnet(address, prefix, "ipv4");
}
privatePeers.addAddress("::1", "ipv6");
privatePeers.addSubnet("fc00::", 7, "ipv6");
privatePeers.addSubnet("fe80::", 10, "ipv6");

function normalize(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const canonical = new URL(`http://[${address.split("%")[0]}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Only a private TCP peer may supply the original address (the public Caddy proxy). */
export function clientIp(request: ClientRequest): string {
  const peer = normalize(request.socket.remoteAddress ?? "") ?? "unknown";
  const family = isIP(peer);
  if (!family || !privatePeers.check(peer, family === 4 ? "ipv4" : "ipv6")) return peer;
  const header = request.headers["x-forwarded-for"];
  const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
  return first ? normalize(first) ?? peer : peer;
}
