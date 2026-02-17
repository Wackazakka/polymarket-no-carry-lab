/**
 * Execution module — thin facade over strategy/paper_executor.
 */
export {
  simulateFill,
  openPaperPosition,
  getExpectedPnl,
  type TradeProposal,
  type FillResult,
  type SimulationConfig,
} from "../strategy/paper_executor";
