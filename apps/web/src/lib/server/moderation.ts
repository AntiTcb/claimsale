import {
	fromStored,
	ok,
	reject,
	type Millis,
	type Rejection,
	type RescindPhase,
	type RescindReasonCode,
	type Result,
} from "@claimsale/core";
import { and, asc, eq, inList, isNull, or, sql, type Db } from "@claimsale/db";
import { messages } from "@claimsale/db/messaging";
import { accountFlags } from "@claimsale/db/photos";
import {
	auditLog,
	entries,
	items,
	plans,
	REPORT_REASONS,
	REPORT_TARGETS,
	reports,
	rescinds,
	sales,
	sessions,
	subscriptions,
	users,
} from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import type { ReportReason, ReportTarget } from "#lib/report-reasons.ts";
import { buyerSummaries } from "./control-room.ts";
import { consume, type Limit } from "./rate-limit.ts";

/**
 * Admin moderation (PLAN §9, D22: reputation, reports and bans): bans, Pro grants,
 * the report queue and the rescind dispute queue. Every admin action writes an
 * `audit_log` row (no sale) with IDs only, never emails or message bodies.
 */

type Rejected = Result<never, Rejection>;

export async function audit(
	db: Db,
	adminId: string,
	action: string,
	data: Record<string, unknown>,
	now: Millis,
) {
	await db.insert(auditLog).values({
		id: uuidv7(),
		saleId: null,
		itemId: null,
		actorId: adminId,
		action,
		data,
		createdAt: now,
	});
}

const notFound = (): Rejected => reject("not_found", "No such account");

// ---------------------------------------------------------------------------
// Users: search, bans and Pro grants

export interface AdminUser {
	readonly id: string;
	readonly handle: string | null;
	readonly displayName: string;
	readonly email: string;
	readonly role: string;
	readonly bannedAt: Millis | null;
	readonly bannedReason: string | null;
	readonly createdAt: Millis;
}

const userColumns = {
	id: users.id,
	handle: users.handle,
	displayName: users.displayName,
	email: users.email,
	role: users.role,
	bannedAt: users.bannedAt,
	bannedReason: users.bannedReason,
	createdAt: users.createdAt,
};

const toAdminUser = (row: {
	id: string;
	handle: string | null;
	displayName: string;
	email: string;
	role: string;
	bannedAt: Date | null;
	bannedReason: string | null;
	createdAt: Date;
}): AdminUser => ({
	...row,
	bannedAt: row.bannedAt?.getTime() ?? null,
	createdAt: row.createdAt.getTime(),
});

/** Accounts whose handle starts with `query` (a leading @ is ignored) or whose email is `query`. */
export async function findUsers(db: Db, query: string, limit = 20): Promise<AdminUser[]> {
	const q = query.trim().replace(/^@/, "").toLowerCase();
	if (q.length < 2) return [];
	const escaped = q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	const rows = await db
		.select(userColumns)
		.from(users)
		.where(or(sql`${users.handle} LIKE ${`${escaped}%`} ESCAPE '\\'`, eq(users.email, q)))
		.orderBy(asc(users.handle))
		.limit(limit)
		.all();
	return rows.map(toAdminUser);
}

export interface Grant {
	readonly planId: string;
	readonly planName: string;
	readonly status: string;
	readonly currentPeriodEnd: Millis | null;
}

export interface AdminUserDetail {
	readonly user: AdminUser;
	readonly grants: readonly Grant[];
	readonly record: Awaited<ReturnType<typeof buyerSummaries>>[string] | undefined;
	/** Final seller-fault rescinds (`seller_cancel`). */
	readonly sellerCancels: number;
}

export async function userDetail(db: Db, userId: string): Promise<AdminUserDetail | null> {
	const row = await db.select(userColumns).from(users).where(eq(users.id, userId)).get();
	if (!row) return null;
	const [grants, summaries, sellerRescinds] = await Promise.all([
		db
			.select({
				planId: subscriptions.planId,
				planName: plans.name,
				status: subscriptions.status,
				currentPeriodEnd: subscriptions.currentPeriodEnd,
			})
			.from(subscriptions)
			.innerJoin(plans, eq(plans.id, subscriptions.planId))
			.where(eq(subscriptions.userId, userId))
			.all(),
		buyerSummaries(db, [userId]),
		db.select().from(rescinds).where(eq(rescinds.sellerId, userId)).all(),
	]);
	const sellerCancels = sellerRescinds.filter((r) => {
		const rescind = fromStored(r);
		if (!rescind || rescind.phase !== "final") return false;
		return (rescind.resolvedFault ?? rescind.fault) === "seller";
	}).length;
	return { user: toAdminUser(row), grants, record: summaries[userId], sellerCancels };
}

export const BAN_REASON_MAX = 500;

/**
 * Bans an account: it can't sign in again (auth.ts), its sessions end now, and the
 * engine rejects its claims and offers. Admins can't be banned here.
 *
 * @spec ADMIN-ban
 */
export async function banUser(
	db: Db,
	input: { userId: string; adminId: string; reason: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const reason = input.reason.trim();
	if (reason.length < 3 || reason.length > BAN_REASON_MAX) {
		return reject("invalid_reason", `Give a reason of 3 to ${BAN_REASON_MAX} characters`);
	}
	const target = await db.select({ role: users.role }).from(users).where(eq(users.id, input.userId)).get();
	if (!target) return notFound();
	if (target.role === "admin") return reject("not_allowed", "Admins can't be banned here");
	const updated = await db
		.update(users)
		.set({ bannedAt: new Date(now), bannedReason: reason, bannedBy: input.adminId, updatedAt: new Date(now) })
		.where(and(eq(users.id, input.userId), isNull(users.bannedAt)))
		.returning({ id: users.id })
		.all();
	if (updated.length === 0) return reject("already_banned", "This account is already banned");
	await db.delete(sessions).where(eq(sessions.userId, input.userId));
	await audit(db, input.adminId, "admin_ban", { userId: input.userId }, now);
	return ok(true);
}

/** @spec ADMIN-ban — unbanning restores sign-in. */
export async function unbanUser(
	db: Db,
	input: { userId: string; adminId: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const updated = await db
		.update(users)
		.set({ bannedAt: null, bannedReason: null, bannedBy: null, updatedAt: new Date(now) })
		.where(and(eq(users.id, input.userId), sql`${users.bannedAt} IS NOT NULL`))
		.returning({ id: users.id })
		.all();
	if (updated.length === 0) return reject("not_banned", "This account isn't banned");
	await audit(db, input.adminId, "admin_unban", { userId: input.userId }, now);
	return ok(true);
}

export const GRANTABLE_PLANS = ["seller_pro", "buyer_pro", "bundle"] as const;
export type GrantablePlan = (typeof GRANTABLE_PLANS)[number];

export const isGrantablePlan = (value: string): value is GrantablePlan =>
	(GRANTABLE_PLANS as readonly string[]).includes(value);

/**
 * Grants Pro before billing exists: a `granted` subscription, open-ended or until a date.
 * Granting again replaces the end date.
 *
 * @spec ADMIN-pro-grant
 */
export async function grantPro(
	db: Db,
	input: { userId: string; adminId: string; planId: string; until: Millis | null },
	now: Millis,
): Promise<Result<true, Rejection>> {
	if (!isGrantablePlan(input.planId)) return reject("invalid_plan", "Pick seller Pro, buyer Pro or both");
	if (input.until !== null && input.until <= now)
		return reject("invalid_until", "The end date must be in the future");
	const target = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get();
	if (!target) return notFound();
	await db
		.insert(subscriptions)
		.values({
			userId: input.userId,
			planId: input.planId,
			status: "granted",
			currentPeriodEnd: input.until,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [subscriptions.userId, subscriptions.planId],
			set: { status: "granted", currentPeriodEnd: input.until, updatedAt: now },
		});
	await audit(
		db,
		input.adminId,
		"admin_pro_grant",
		{ userId: input.userId, planId: input.planId, until: input.until },
		now,
	);
	return ok(true);
}

/** @spec ADMIN-pro-grant — revoking ends a grant now; paid subscriptions aren't touched. */
export async function revokePro(
	db: Db,
	input: { userId: string; adminId: string; planId: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const updated = await db
		.update(subscriptions)
		.set({ status: "canceled", currentPeriodEnd: now, updatedAt: now })
		.where(
			and(
				eq(subscriptions.userId, input.userId),
				eq(subscriptions.planId, input.planId),
				eq(subscriptions.status, "granted"),
			),
		)
		.returning({ planId: subscriptions.planId })
		.all();
	if (updated.length === 0) return reject("not_granted", "There's no grant to revoke");
	await audit(db, input.adminId, "admin_pro_revoke", { userId: input.userId, planId: input.planId }, now);
	return ok(true);
}

// ---------------------------------------------------------------------------
// Reports

export const REPORT_DETAILS_MAX = 2000;
/** Reports per account per hour, so one account can't flood the queue. */
export const REPORT_LIMIT: Limit = { windowMs: 3_600_000, max: 20 };

const isTarget = (v: unknown): v is ReportTarget =>
	typeof v === "string" && (REPORT_TARGETS as readonly string[]).includes(v);
const isReason = (v: unknown): v is ReportReason =>
	typeof v === "string" && (REPORT_REASONS as readonly string[]).includes(v);

/** Whether the reported user, sale, item or message exists. */
async function targetExists(db: Db, kind: ReportTarget, id: string): Promise<boolean> {
	switch (kind) {
		case "user":
			return (await db.select({ id: users.id }).from(users).where(eq(users.id, id)).get()) !== undefined;
		case "sale":
			return (
				(await db
					.select({ id: sales.id })
					.from(sales)
					.where(and(eq(sales.id, id), sql`${sales.status} NOT IN ('draft', 'deleted')`))
					.get()) !== undefined
			);
		case "item":
			return (
				(await db
					.select({ id: items.id })
					.from(items)
					.innerJoin(sales, eq(sales.id, items.saleId))
					.where(and(eq(items.id, id), sql`${sales.status} NOT IN ('draft', 'deleted')`))
					.get()) !== undefined
			);
		case "message":
			return (
				(await db.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).get()) !== undefined
			);
		default:
			return false;
	}
}

/**
 * A signed-in user reports a user, sale, item or message.
 *
 * @spec ADMIN-report-queue — one open report per reporter and target.
 */
export async function fileReport(
	db: Db,
	reporterId: string,
	body: unknown,
	now: Millis,
): Promise<Result<{ id: string }, Rejection>> {
	const b: Record<string, unknown> = body !== null && typeof body === "object" ? { ...body } : {};
	const { targetKind, targetId, reason } = b;
	const details = typeof b["details"] === "string" ? b["details"].trim() : "";
	if (!isTarget(targetKind) || typeof targetId !== "string" || targetId === "") {
		return reject("invalid_input", "Say what you're reporting");
	}
	if (!isReason(reason)) return reject("invalid_input", "Pick a reason");
	if (details.length > REPORT_DETAILS_MAX)
		return reject("invalid_input", `Use at most ${REPORT_DETAILS_MAX} characters`);
	if (targetKind === "user" && targetId === reporterId)
		return reject("invalid_input", "You can't report yourself");
	if (!(await consume(db, `report:${reporterId}`, REPORT_LIMIT, now))) {
		return reject("rate_limited", "You've sent a lot of reports. Try again later.");
	}
	if (!(await targetExists(db, targetKind, targetId)))
		return reject("not_found", "There's nothing to report there");
	const id = uuidv7();
	const inserted = await db
		.insert(reports)
		.values({ id, reporterId, targetKind, targetId, reason, details: details || null, createdAt: now })
		.onConflictDoNothing()
		.returning({ id: reports.id })
		.all();
	if (inserted.length === 0)
		return reject("already_reported", "You've already reported this; an admin will look at it");
	return ok({ id });
}

export interface OpenReport {
	readonly id: string;
	readonly targetKind: ReportTarget;
	readonly targetId: string;
	readonly reason: ReportReason;
	readonly details: string | null;
	readonly reporterHandle: string | null;
	readonly createdAt: Millis;
	/** Open reports about the same target, from anyone. */
	readonly sameTarget: number;
	/** A reported message's text and sender, for the admin only (MSG-report). */
	readonly messageBody: string | null;
	readonly messageSenderId: string | null;
}

/** Open reports, oldest first. */
export async function openReports(db: Db, limit = 100): Promise<OpenReport[]> {
	return db
		.select({
			id: reports.id,
			targetKind: reports.targetKind,
			targetId: reports.targetId,
			reason: reports.reason,
			details: reports.details,
			reporterHandle: users.handle,
			createdAt: reports.createdAt,
			sameTarget: sql<number>`(SELECT count(*) FROM reports o WHERE o.target_kind = ${reports.targetKind} AND o.target_id = ${reports.targetId} AND o.status = 'open')`,
			messageBody: messages.body,
			messageSenderId: messages.senderId,
		})
		.from(reports)
		.innerJoin(users, eq(users.id, reports.reporterId))
		.leftJoin(messages, and(eq(reports.targetKind, "message"), eq(messages.id, reports.targetId)))
		.where(eq(reports.status, "open"))
		.orderBy(asc(reports.createdAt), asc(reports.id))
		.limit(limit)
		.all();
}

/** @spec ADMIN-report-queue — the admin resolves or dismisses a report with a note. */
export async function closeReport(
	db: Db,
	input: { reportId: string; adminId: string; status: "resolved" | "dismissed"; note: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const updated = await db
		.update(reports)
		.set({
			status: input.status,
			resolvedAt: now,
			resolvedBy: input.adminId,
			resolutionNote: input.note.trim().slice(0, 2000) || null,
		})
		.where(and(eq(reports.id, input.reportId), eq(reports.status, "open")))
		.returning({ id: reports.id })
		.all();
	if (updated.length === 0) return reject("not_found", "That report was already closed");
	await audit(db, input.adminId, `admin_report_${input.status}`, { reportId: input.reportId }, now);
	return ok(true);
}

// ---------------------------------------------------------------------------
// Rescind disputes and fraud review

export interface DisputedRescind {
	readonly id: string;
	readonly saleId: string;
	readonly saleTitle: string;
	readonly itemTitle: string;
	readonly sellerHandle: string | null;
	readonly buyerHandle: string | null;
	readonly reasonCode: RescindReasonCode;
	readonly phase: RescindPhase;
	readonly explanation: string;
	readonly contestText: string | null;
	readonly createdAt: Millis;
	readonly contestedAt: Millis | null;
}

/**
 * Rescinds waiting for the admin: contested ones (including disputed mutual
 * agreements) and suspected fraud held for review, oldest first.
 *
 * @spec SM-4.3.1-contest
 * @spec SM-4.3.1-fraud-review
 */
export async function rescindQueue(db: Db, limit = 100): Promise<DisputedRescind[]> {
	const rows = await db
		.select({
			rescind: rescinds,
			saleId: sales.id,
			saleTitle: sales.title,
			itemTitle: items.title,
		})
		.from(rescinds)
		.innerJoin(entries, eq(entries.id, rescinds.entryId))
		.innerJoin(items, eq(items.id, entries.itemId))
		.innerJoin(sales, eq(sales.id, items.saleId))
		.where(
			or(
				sql`${rescinds.phase} IN ('contested', 'admin_review')`,
				and(
					isNull(rescinds.phase),
					isNull(rescinds.resolvedAt),
					or(sql`${rescinds.contestedAt} IS NOT NULL`, eq(rescinds.reasonCode, "suspected_fraud")),
				),
			),
		)
		.orderBy(asc(rescinds.createdAt), asc(rescinds.id))
		.limit(limit)
		.all();
	const people = new Set(rows.flatMap((row) => [row.rescind.sellerId, row.rescind.buyerId]));
	const handles = new Map(
		people.size === 0
			? []
			: (
					await db
						.select({ id: users.id, handle: users.handle })
						.from(users)
						.where(inList(users.id, [...people]))
						.all()
				).map((u) => [u.id, u.handle]),
	);
	return rows.flatMap((row) => {
		const r = row.rescind;
		const rescind = fromStored(r);
		if (!rescind) return [];
		return [
			{
				id: r.id,
				saleId: row.saleId,
				saleTitle: row.saleTitle,
				itemTitle: row.itemTitle,
				sellerHandle: handles.get(r.sellerId) ?? null,
				buyerHandle: handles.get(r.buyerId) ?? null,
				reasonCode: rescind.reasonCode,
				phase: rescind.phase,
				explanation: r.explanation,
				contestText: r.contestText,
				createdAt: r.createdAt,
				contestedAt: r.contestedAt,
			},
		];
	});
}

export interface FlaggedSeller {
	readonly flagId: string;
	readonly userId: string;
	readonly handle: string | null;
	readonly count: number;
	readonly createdAt: Millis;
}

/** Sellers flagged by the abuse guard (SM-4.3.1-abuse-guard), oldest first. */
export async function overturnedFlags(db: Db): Promise<FlaggedSeller[]> {
	return db
		.select({
			flagId: accountFlags.id,
			userId: accountFlags.userId,
			handle: users.handle,
			count: accountFlags.count,
			createdAt: accountFlags.createdAt,
		})
		.from(accountFlags)
		.innerJoin(users, eq(users.id, accountFlags.userId))
		.where(and(eq(accountFlags.reason, "overturned_rescinds"), isNull(accountFlags.resolvedAt)))
		.orderBy(asc(accountFlags.createdAt))
		.all();
}
