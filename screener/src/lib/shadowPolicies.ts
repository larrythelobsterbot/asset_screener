import type { VolRegime } from "./indicators";
import type { ConvictionResult, Signal, SignalFamily } from "./signals";

export const STAGE2_SHADOW_POLICY_VERSION = "stage2-shadow-v1";

const EXTREME_POSITIVE_FUNDING = 0.0001;
const EXTREME_NEGATIVE_FUNDING = -0.00005;

type AlertDirection = "long" | "short";
type DirectionalSignal = Pick<Signal, "direction" | "family" | "timeframe">;

type ShadowGate<TObserved> = {
  pass: boolean;
  observed: TObserved;
};

export interface Stage2ShadowPolicyInput {
  direction: AlertDirection;
  convictionScore: number;
  primaryVolRegime: VolRegime;
  byTimeframe: ConvictionResult["byTimeframe"];
  fundingHourly?: number | null;
  signals: readonly DirectionalSignal[];
}

export interface Stage2ShadowPolicyResult {
  policyVersion: typeof STAGE2_SHADOW_POLICY_VERSION;
  baselineContext: {
    primaryVolRegime: VolRegime;
    regimePass: boolean;
  };
  gates: {
    opposingSignalVeto: ShadowGate<{ opposingSignalCount: number }>;
    minimumIndependentFamilies: ShadowGate<{ alignedFamilies: SignalFamily[]; required: number }>;
    fourHourDirectionalConfirmation: ShadowGate<{ score: number; count: number }>;
    fundingHeadwind: ShadowGate<{ fundingHourly: number | null; headwind: boolean }>;
    scoreAtLeast4: ShadowGate<{ absoluteScore: number; threshold: number }>;
    scoreAtLeast4_5: ShadowGate<{ absoluteScore: number; threshold: number }>;
  };
  combinedConservativePass: boolean;
}

export function evaluateStage2ShadowPolicy(input: Stage2ShadowPolicyInput): Stage2ShadowPolicyResult {
  const alignedDirection = input.direction === "long" ? "bullish" : "bearish";
  const opposingDirection = input.direction === "long" ? "bearish" : "bullish";
  const opposingSignalCount = input.signals.filter((signal) => signal.direction === opposingDirection).length;
  const alignedFamilies = [...new Set(
    input.signals
      .filter((signal) => signal.direction === alignedDirection)
      .map((signal) => signal.family),
  )].sort() as SignalFamily[];
  const fourHour = input.byTimeframe["4h"] ?? { score: 0, count: 0 };
  const fourHourDirection = Math.sign(fourHour.score);
  const expectedDirection = input.direction === "long" ? 1 : -1;
  const funding = typeof input.fundingHourly === "number" && Number.isFinite(input.fundingHourly)
    ? input.fundingHourly
    : null;
  const fundingIsHeadwind = funding != null && (
    (input.direction === "long" && funding > EXTREME_POSITIVE_FUNDING)
    || (input.direction === "short" && funding < EXTREME_NEGATIVE_FUNDING)
  );
  const absoluteScore = Math.abs(input.convictionScore);
  const regimePass = input.primaryVolRegime === "normal" || input.primaryVolRegime === "wild";

  const opposingSignalVeto = {
    pass: opposingSignalCount === 0,
    observed: { opposingSignalCount },
  };
  const minimumIndependentFamilies = {
    pass: alignedFamilies.length >= 2,
    observed: { alignedFamilies, required: 2 },
  };
  const fourHourDirectionalConfirmation = {
    pass: fourHour.count > 0 && fourHourDirection === expectedDirection,
    observed: { score: fourHour.score, count: fourHour.count },
  };
  const fundingHeadwind = {
    pass: funding != null && !fundingIsHeadwind,
    observed: { fundingHourly: funding, headwind: fundingIsHeadwind },
  };
  const scoreAtLeast4 = {
    pass: absoluteScore >= 4,
    observed: { absoluteScore, threshold: 4 },
  };
  const scoreAtLeast4_5 = {
    pass: absoluteScore >= 4.5,
    observed: { absoluteScore, threshold: 4.5 },
  };

  return {
    policyVersion: STAGE2_SHADOW_POLICY_VERSION,
    baselineContext: {
      primaryVolRegime: input.primaryVolRegime,
      regimePass,
    },
    gates: {
      opposingSignalVeto,
      minimumIndependentFamilies,
      fourHourDirectionalConfirmation,
      fundingHeadwind,
      scoreAtLeast4,
      scoreAtLeast4_5,
    },
    combinedConservativePass:
      regimePass
      && opposingSignalVeto.pass
      && minimumIndependentFamilies.pass
      && fourHourDirectionalConfirmation.pass
      && fundingHeadwind.pass
      && scoreAtLeast4.pass,
  };
}
