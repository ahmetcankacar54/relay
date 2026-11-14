import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageRing, type RingState } from "../src/components/UsageRing";
import { StatusDot } from "../src/components/StatusDot";

const ring = (state?: RingState, outer = 20, inner: number | null = 40) =>
  renderToStaticMarkup(createElement(UsageRing, { outer, inner, label: "A", state }));
/** The tracks (no stroke-linecap) and the arcs (round caps), as drawn. */
const circles = (html: string) => html.match(/<circle[^>]*>/g) ?? [];
const tracks = (html: string) => circles(html).filter((c) => !c.includes("stroke-linecap"));
const arcs = (html: string) => circles(html).filter((c) => c.includes("stroke-linecap"));

test("a fresh ring draws solid tracks and calm meter-tone arcs below 75 %", () => {
  for (const html of [ring(), ring("fresh")]) {
    assert.doesNotMatch(html, /data-state/);
    assert.equal(tracks(html).length, 2);
    for (const track of tracks(html)) assert.doesNotMatch(track, /stroke-dasharray/);
    assert.equal(arcs(html).length, 2);
    for (const arc of arcs(html)) {
      assert.match(arc, /stroke-meter/);
      assert.doesNotMatch(arc, /opacity-/);
    }
  }
});

test("a stale ring fades its arcs on a dashed track", () => {
  const html = ring("stale");
  assert.match(html, /data-state="stale"/);
  for (const track of tracks(html)) assert.match(track, /stroke-dasharray="3 2.5"/);
  assert.equal(arcs(html).length, 2);
  for (const arc of arcs(html)) assert.match(arc, /opacity-45/);
});

test("an unknown ring is the dashed track alone, whatever values it is given", () => {
  const html = ring("unknown");
  assert.match(html, /data-state="unknown"/);
  assert.equal(tracks(html).length, 2);
  for (const track of tracks(html)) assert.match(track, /stroke-dasharray="3 2.5"/);
  assert.equal(arcs(html).length, 0);
});

test("a full ring draws its arcs critical, whatever their length", () => {
  const html = ring("full", 100, 20);
  assert.match(html, /data-state="full"/);
  for (const track of tracks(html)) assert.doesNotMatch(track, /stroke-dasharray/);
  assert.equal(arcs(html).length, 2);
  for (const arc of arcs(html)) {
    assert.match(arc, /stroke-crit/);
    assert.doesNotMatch(arc, /opacity-/);
  }
});

test("a hollow status dot is a ring in its tone, a plain one is filled", () => {
  const filled = renderToStaticMarkup(createElement(StatusDot, { tone: "off" }));
  assert.match(filled, /bg-muted-foreground\/40/);
  assert.doesNotMatch(filled, /border/);
  const hollow = renderToStaticMarkup(createElement(StatusDot, { tone: "off", hollow: true }));
  assert.match(hollow, /border-\[1\.5px\] border-muted-foreground\/60/);
  assert.doesNotMatch(hollow, /bg-/);
  assert.match(renderToStaticMarkup(createElement(StatusDot, { tone: "ok", hollow: true })), /border-ok/);
});
