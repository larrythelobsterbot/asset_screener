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
