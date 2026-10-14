import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui/button";

test("outline buttons draw a themed border, not the text colour", () => {
  // Legacy `button { border: 0 }` resets border-color to currentColor.
  const html = renderToStaticMarkup(
    createElement(Button, { variant: "outline" }, "Edit"),
  );
  const classes = html.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
  assert.ok(classes.includes("border"));
  assert.ok(classes.includes("border-input"));
});
