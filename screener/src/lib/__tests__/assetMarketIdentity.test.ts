import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssetMarketIdentity } from "../assetMarketIdentity";

test("HIP-3 asset identity resolves SKHX to its qualified xyz market", () => {
  assert.deepEqual(resolveAssetMarketIdentity("SKHX"), {
    kind: "builder-perp",
    symbol: "SKHX",
    wireCoin: "xyz:SKHX",
    cacheSymbol: "SKHX",
    builderDex: "xyz",
  });
});

test("native perps retain bare wire identity", () => {
  assert.deepEqual(resolveAssetMarketIdentity("BTC"), {
    kind: "native-perp",
    symbol: "BTC",
    wireCoin: "BTC",
    cacheSymbol: "BTC",
    builderDex: null,
  });
});

test("spot stock identity keeps precedence over a same-ticker builder perp", () => {
  const identity = resolveAssetMarketIdentity("META");
  assert.equal(identity?.kind, "spot");
  assert.equal(identity?.symbol, "META");
  assert.match(identity?.wireCoin ?? "", /^@\d+$/);
  assert.equal(identity?.cacheSymbol, identity?.wireCoin);
  assert.equal(identity?.builderDex, null);
});

test("unknown and already-qualified route symbols fail closed", () => {
  assert.equal(resolveAssetMarketIdentity("NOT_A_REAL_MARKET"), null);
  assert.equal(resolveAssetMarketIdentity("xyz:SKHX"), null);
});

test("explicit selected venue can resolve a dynamic builder ticker", () => {
  assert.deepEqual(resolveAssetMarketIdentity("DYNAMIC", "xyz:DYNAMIC"), {
    kind: "builder-perp",
    symbol: "DYNAMIC",
    wireCoin: "xyz:DYNAMIC",
    cacheSymbol: "DYNAMIC",
    builderDex: "xyz",
  });
});

test("explicit native selection resolves before dynamic live-universe validation", () => {
  assert.equal(resolveAssetMarketIdentity("DYNAMIC", "DYNAMIC")?.kind, "native-perp");
  assert.equal(resolveAssetMarketIdentity("META", "META")?.kind, "native-perp");
});

test("explicit overlapping venue does not fall back to legacy first-DEX precedence", () => {
  assert.equal(resolveAssetMarketIdentity("BABA")?.wireCoin, "xyz:BABA");
  assert.equal(resolveAssetMarketIdentity("BABA", "km:BABA")?.wireCoin, "km:BABA");
});

test("malformed, disallowed, and incoherent selected wire identities fail closed", () => {
  assert.equal(resolveAssetMarketIdentity("SKHX", "xyz"), null);
  assert.equal(resolveAssetMarketIdentity("SKHX", "unknown:SKHX"), null);
  assert.equal(resolveAssetMarketIdentity("SKHX", "xyz:OTHER"), null);
  assert.equal(resolveAssetMarketIdentity("SKHX", "xyz:SKHX:extra"), null);

});
