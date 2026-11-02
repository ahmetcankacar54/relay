import test from "node:test";
import assert from "node:assert/strict";
import {
  linkedSwitchAccount,
  parseRelayLink,
  relayLinkArgument,
  relaySwitchLink,
} from "../shared/relay-link";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-00000000000b";
const ACCOUNTS = [
  { id: A, name: "Kişisel" },
  { id: B, name: "Vertex" },
];

test("the widget's switch link round-trips to a switch request for a known account", () => {
  const link = relaySwitchLink(A);
  assert.equal(link, `relay://switch?account=${A}`);
  assert.deepEqual(parseRelayLink(link, ACCOUNTS), {
    kind: "switch",
    accountId: A,
  });
  assert.deepEqual(parseRelayLink(`RELAY://switch?account=${B}`, ACCOUNTS), {
    kind: "switch",
    accountId: B,
  });
  assert.deepEqual(parseRelayLink("relay://open"), { kind: "open" });
  // Without accounts only the shape is checked.
  assert.deepEqual(parseRelayLink(link), { kind: "switch", accountId: A });
});

test("anything but a well-formed link to one of Relay's accounts is ignored", () => {
  const unknown = "00000000-0000-4000-8000-0000000000ff";
  for (const url of [
    `relay://switch?account=${unknown}`,
    "relay://switch?account=../../etc",
    "relay://switch?account=",
    "relay://switch",
    `relay://switch?account=${A}&account=${B}`,
    `relay://switch?account=${A}&confirm=1`,
    `relay://switch/now?account=${A}`,
    `relay://switch?account=${A}#go`,
    `relay://user:pw@switch?account=${A}`,
    `relay://switch:80?account=${A}`,
    `relay:switch?account=${A}`,
    `https://switch?account=${A}`,
    `relay://quit`,
    `relay://open?page=ayarlar`,
    "not a url",
    "",
    `relay://switch?account=${A}${"x".repeat(600)}`,
  ])
    assert.equal(parseRelayLink(url, ACCOUNTS), undefined, url);
  assert.equal(parseRelayLink(undefined, ACCOUNTS), undefined);
  assert.equal(parseRelayLink(42, ACCOUNTS), undefined);
});

test("a link among command-line arguments is found; none is undefined", () => {
  assert.equal(
    relayLinkArgument([
      "/Applications/Relay.app",
      "--flag",
      `relay://switch?account=${A}`,
    ]),
    `relay://switch?account=${A}`,
  );
  assert.equal(
    relayLinkArgument(["/Applications/Relay.app", "--flag"]),
    undefined,
  );
});

test("the review opens only for a known account that is not already open in Claude", () => {
  assert.equal(linkedSwitchAccount(B, ACCOUNTS, A)?.name, "Vertex");
  assert.equal(linkedSwitchAccount(A, ACCOUNTS, A), undefined);
  assert.equal(
    linkedSwitchAccount("00000000-0000-4000-8000-0000000000ff", ACCOUNTS, A),
    undefined,
  );
  assert.equal(linkedSwitchAccount(undefined, ACCOUNTS, A), undefined);
  assert.equal(linkedSwitchAccount(B, ACCOUNTS, undefined)?.id, B);
});
