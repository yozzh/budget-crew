import { expect, it } from "vitest";
import { clientIp, type ClientRequest } from "./client-ip.js";

const ip = (peer: string, forwarded?: string) => clientIp({
  socket: { remoteAddress: peer }, headers: { "x-forwarded-for": forwarded },
} as ClientRequest);

it("trusts the first forwarded IP only behind private or loopback peers", () => {
  for (const peer of ["127.0.0.1", "10.0.0.2", "172.18.0.5", "192.168.1.2", "::1", "fd00::1", "::ffff:172.18.0.5", "::ffff:ac12:5"]) {
    expect(ip(peer, "198.51.100.2, 10.0.0.1")).toBe("198.51.100.2");
  }
  for (const peer of ["203.0.113.4", "172.32.0.1", "2001:db8::1", "::ffff:203.0.113.4"]) {
    expect(ip(peer, "198.51.100.2")).toBe(peer === "::ffff:203.0.113.4" ? "203.0.113.4" : peer);
  }
});

it("canonicalizes equivalent addresses so quota keys cannot be rotated by formatting", () => {
  expect(ip("127.0.0.1", "::ffff:c633:6402")).toBe("198.51.100.2");
  expect(ip("127.0.0.1", "2001:0db8:0000::0001")).toBe("2001:db8::1");
  expect(ip("10.0.0.2", "not-an-ip, 198.51.100.2")).toBe("10.0.0.2");
  expect(ip("::ffff:127.0.0.1")).toBe("127.0.0.1");
});
