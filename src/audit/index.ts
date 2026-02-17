/**
 * Audit/reporting module — thin facade over report/daily_report.
 */
export {
  generateReport,
  writeReportToFile,
  type ReportInput,
  type ReportResult,
} from "../report/daily_report";
