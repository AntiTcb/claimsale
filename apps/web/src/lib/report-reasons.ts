import type { REPORT_REASONS, REPORT_TARGETS } from "@claimsale/db/schema";

/** Report reasons and targets (ADMIN-report-queue), shared by the report endpoint and /admin. */

export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
	counterfeit: "Counterfeit, proxy or replica",
	stolen_photo: "Photo isn't theirs",
	prohibited_item: "Prohibited item",
	scam: "Scam or fraud",
	harassment: "Harassment",
	spam: "Spam",
	off_platform_payment: "Asks to pay outside the invoice",
	other: "Something else",
};
