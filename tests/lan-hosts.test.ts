import assert from "node:assert/strict";
import test from "node:test";
import { paidProvidersAllowed, trustedLanHosts } from "../lib/mvp/auth.ts";

const lan = "http://192.168.1.157:3000";

test("a LAN base url is blocked when RR_TRUSTED_LAN_HOSTS is unset", () => {
  assert.equal(paidProvidersAllowed("demo", lan, {}), false);
  assert.deepEqual(trustedLanHosts({}), []);
});

test("a listed LAN host is allowed over plain http in dev", () => {
  const env = { RR_TRUSTED_LAN_HOSTS: " 10.0.0.2 , 192.168.1.157 " };
  assert.equal(paidProvidersAllowed("demo", lan, env), true);
  assert.equal(paidProvidersAllowed("demo", "http://192.168.1.158:3000", env), false);
});

test("listed hosts are ignored in production and never widen https or other schemes", () => {
  assert.equal(paidProvidersAllowed("demo", lan, { NODE_ENV: "production", RR_TRUSTED_LAN_HOSTS: "192.168.1.157" }), false);
  assert.equal(paidProvidersAllowed("demo", "https://192.168.1.157", { RR_TRUSTED_LAN_HOSTS: "192.168.1.157" }), false);
});

test("loopback stays allowed with no list", () => {
  assert.equal(paidProvidersAllowed("demo", "http://127.0.0.1:3000", {}), true);
  assert.equal(paidProvidersAllowed("demo", "http://localhost:3000", {}), true);
});
