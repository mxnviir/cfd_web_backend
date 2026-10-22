// clientIp: the address limits are keyed on must be one the caller cannot write.
//
// Regression for a limit that was one header away from not existing: keyed on
// the first X-Forwarded-For entry, a spoofed 203.0.113.x got a fresh bucket on
// every request against the deployed exchangeFusionToken.
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { clientIp } = await import(pathToFileURL(resolve(root, "functions/lib/lib/ratelimit.js")).href);

const req = (xff, ip) => ({ get: (n) => (n.toLowerCase() === "x-forwarded-for" ? xff : undefined), ip });

// What Google's front end hands us when the caller forged the header.
assert.equal(clientIp(req("203.0.113.110, 81.2.69.160")), "81.2.69.160");
// Several forged hops still lose to the one Google appended.
assert.equal(clientIp(req("1.1.1.1, 2.2.2.2, 81.2.69.160")), "81.2.69.160");
// No forgery.
assert.equal(clientIp(req("81.2.69.160")), "81.2.69.160");
// Whitespace and empty entries.
assert.equal(clientIp(req(" 203.0.113.9 ,, 81.2.69.160 ")), "81.2.69.160");
// No header at all (the emulator): fall back to the socket address.
assert.equal(clientIp(req(undefined, "127.0.0.1")), "127.0.0.1");
assert.equal(clientIp(req("", "127.0.0.1")), "127.0.0.1");
// Nothing to go on.
assert.equal(clientIp(req(undefined, undefined)), "");

console.log("client ip: 7 checks, a forged X-Forwarded-For cannot choose the bucket");
