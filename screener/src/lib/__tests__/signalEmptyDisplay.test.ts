import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SignalFeed from "@/components/SignalFeed";
import SignalTable from "@/components/SignalTable";
import SignalScanner from "@/components/SignalScanner";

// Node/tsx uses classic JSX with Next's preserve config; runtime Next uses SWC.
Object.assign(globalThis, { React });
const onSelectAsset = () => {};

test("both empty scanner views describe cached rows, never complete observed coverage", () => {
  for (const component of [SignalFeed, SignalTable]) {
    const html = renderToStaticMarkup(React.createElement(component, { signals: [], onSelectAsset }));
    assert.doesNotMatch(html, /No active signals/);
    assert.match(html, /No cached signal rows match this view/);
    assert.match(html, /does not establish complete scan coverage/);
  }
});

test("scanner never asserts live green telemetry or a visitor-triggered scan", () => {
  const props = { signals: [], allowedSymbols: null, onSelectAsset };
  const empty = renderToStaticMarkup(React.createElement(SignalScanner, { ...props, loading: false }));
  assert.doesNotMatch(empty, /animate-pulse|bg-positive/);
  const loading = renderToStaticMarkup(React.createElement(SignalScanner, { ...props, loading: true }));
  assert.match(loading, /Loading cached signals/);
  assert.doesNotMatch(loading, /Scanning for signals/);
});
