#!/usr/bin/env node
// Runs the prebuilt relay binary for this platform from its optional dependency.
// Plain syntax on purpose: any Node that installs this package must reach the error message.
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var target = process.platform + "-" + process.arch;
var binary;
try {
  var manifest = require.resolve(
    "@ahmetcankacar/relay-" + target + "/package.json",
  );
  binary = path.join(
    path.dirname(manifest),
    "bin",
    process.platform === "win32" ? "relay.exe" : "relay",
  );
} catch (_error) {
  binary = undefined;
}
if (!binary || !fs.existsSync(binary)) {
  process.stderr.write("relay: no prebuilt binary for " + target + ".\n");
  process.exit(5);
}

var child = childProcess.spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
});
var forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
function forward(signal) {
  child.kill(signal);
}
forwarded.forEach(function (signal) {
  process.on(signal, forward);
});

child.on("error", function (error) {
  process.stderr.write("relay: " + error.message + "\n");
  process.exit(5);
});
child.on("exit", function (code, signal) {
  forwarded.forEach(function (name) {
    process.removeListener(name, forward);
  });
  if (signal) {
    // Die of the same signal, so the shell sees what the binary saw; 128+n if it cannot be raised.
    var fallback = 128 + (os.constants.signals[signal] || 0);
    try {
      process.kill(process.pid, signal);
      setTimeout(function () {
        process.exit(fallback);
      }, 1000);
    } catch (_error) {
      process.exit(fallback);
    }
    return;
  }
  process.exit(code === null ? 1 : code);
});
