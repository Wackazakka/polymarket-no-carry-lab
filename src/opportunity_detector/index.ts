/**
 * Opportunity detector module — thin facade over strategy filters + EV.
 */
export {
  evaluateMarketCandidate,
  evaluateMarketCandidateWithDetails,
  type FailedCheck,
} from "../strategy/filters";
export { computeEV } from "../strategy/ev";
