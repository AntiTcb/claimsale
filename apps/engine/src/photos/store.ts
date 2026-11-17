/**
 * D1 access for photo authenticity: the band lookup (multi-index hashing) and the
 * writes of a verdict. Raw D1 like the catalog: one statement per query, verdict
 * writes in one atomic `db.batch()`.
 */
import {
	COMPLETED_SALE_STATUSES,
	isRepeatOffender,
	type PhotoStatus,
	type PublishPhotoState,
} from "@claimsale/core";
import {
	type BandKey,
	hashFromHex,
	hashToHex,
	type ImageHashes,
	matchDistance,
	type PhotoVerdict,
	type StoredMatch,
	toBands,
} from "@claimsale/imagehash";
import { Data, Effect } from "effect";
import { uuidv7 } from "uuidv7";

export class PhotoDbError extends Data.TaggedError("PhotoDbError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {
	override get message() {
		return `photo D1 ${this.operation} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
	}
}

export const d1 = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new PhotoDbError({ operation, cause }) });

/** The band columns of image_hashes, in `BandKey` order (dHash then pHash, band 0 first). */
export const BAND_COLUMNS = ["d0", "d1", "d2", "d3", "p0", "p1", "p2", "p3"] as const;
type BandColumn = (typeof BAND_COLUMNS)[number];

const columnOf = (key: BandKey): BandColumn => `${key.kind === "dhash" ? "d" : "p"}${key.band}`;

/**
 * Every candidate key as ONE JSON parameter, grouped by column:
 * `{"d0": [..], …, "p3": [..]}`. D1 allows 100 bound parameters per statement, and
 * radius 1 makes up to 680 keys.
 */
export function bandKeysJson(keys: readonly BandKey[]): string {
	const groups: Record<BandColumn, number[]> = {
		d0: [],
		d1: [],
		d2: [],
		d3: [],
		p0: [],
		p1: [],
		p2: [],
		p3: [],
	};
	for (const key of keys) groups[columnOf(key)].push(key.value);
	return JSON.stringify(groups);
}

/**
 * Approved images sharing at least one band value with the upload (?1: the keys JSON,
 * ?2: the upload's own ID). Each `IN` term can use its own band index, and SQLite
 * unions them (multi-index OR). `in_use`: the photo still exists and isn't rejected.
 */
export const LOOKUP_SQL = `SELECT h.image_id, h.seller_id, h.sale_id, h.item_id, h.dhash, h.phash,
	EXISTS (SELECT 1 FROM item_images i WHERE i.id = h.image_id AND i.status != 'rejected') AS in_use
FROM image_hashes h
WHERE h.decision = 'approved' AND h.image_id != ?2 AND (
	${BAND_COLUMNS.map((c) => `h.${c} IN (SELECT value FROM json_each(?1, '$.${c}'))`).join("\n\tOR ")}
)`;

interface CandidateRow {
	readonly image_id: string;
	readonly seller_id: string;
	readonly sale_id: string;
	readonly item_id: string | null;
	readonly dhash: string;
	readonly phash: string;
	readonly in_use: number;
}

/** Stored approved images near the upload, each with its closest distance over the variants. */
export const findMatches = (db: D1Database, imageId: string, hashes: ImageHashes, keys: readonly BandKey[]) =>
	d1("band lookup", () => db.prepare(LOOKUP_SQL).bind(bandKeysJson(keys), imageId).all<CandidateRow>()).pipe(
		Effect.map(({ results }) =>
			results.map((row): StoredMatch => ({
				imageId: row.image_id,
				sellerId: row.seller_id,
				saleId: row.sale_id,
				itemId: row.item_id,
				inUse: row.in_use === 1,
				distance: matchDistance(hashes, { dhash: hashFromHex(row.dhash), phash: hashFromHex(row.phash) }),
			})),
		),
	);

export interface PendingPhoto {
	readonly id: string;
	readonly seller_id: string;
	readonly sale_id: string;
	readonly item_id: string | null;
	readonly r2_key: string;
	readonly status: string;
}

export const loadPhoto = (db: D1Database, imageId: string) =>
	d1("load photo", () =>
		db
			.prepare("SELECT id, seller_id, sale_id, item_id, r2_key, status FROM item_images WHERE id = ?")
			.bind(imageId)
			.first<PendingPhoto>(),
	);

const auditStatement = (
	db: D1Database,
	photo: Pick<PendingPhoto, "id" | "sale_id" | "item_id">,
	actorId: string,
	action: string,
	data: Record<string, unknown>,
	now: number,
) =>
	db
		.prepare(
			"INSERT INTO audit_log (id, sale_id, item_id, actor_id, action, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			uuidv7(),
			photo.sale_id,
			photo.item_id,
			actorId,
			action,
			JSON.stringify({ imageId: photo.id, ...data }),
			now,
		);

/**
 * Records the verdict: the hashes (every hashed photo, so a held photo can be approved
 * later and a rejected one still counts toward repeat offenders), the photo's status
 * (only while still `pending`) and an audit row, in one batch.
 */
export const saveVerdict = (
	db: D1Database,
	photo: PendingPhoto,
	hashes: ImageHashes,
	verdict: PhotoVerdict,
	now: number,
) => {
	const { dhash, phash } = hashes.orig;
	const bands = [...toBands(dhash), ...toBands(phash)];
	return d1("save verdict", () =>
		db.batch([
			db
				.prepare(
					`INSERT INTO image_hashes (image_id, seller_id, sale_id, item_id, dhash, phash,
						d0, d1, d2, d3, p0, p1, p2, p3, decision, reason, created_at, decided_at, decided_by)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')
					ON CONFLICT (image_id) DO NOTHING`,
				)
				.bind(
					photo.id,
					photo.seller_id,
					photo.sale_id,
					photo.item_id,
					hashToHex(dhash),
					hashToHex(phash),
					...bands,
					verdict.decision,
					verdict.reason,
					now,
					now,
				),
			db
				.prepare(
					"UPDATE item_images SET status = ?, match_image_id = ?, match_distance = ?, verified_at = ? WHERE id = ? AND status = 'pending'",
				)
				.bind(
					verdict.decision,
					verdict.match?.imageId ?? null,
					verdict.match?.distance ?? null,
					now,
					photo.id,
				),
			auditStatement(
				db,
				photo,
				"system",
				"photo_verified",
				{ decision: verdict.decision, reason: verdict.reason },
				now,
			),
		]),
	);
};

/** A photo that couldn't be decoded: rejected, with nothing to hash. */
export const rejectUnreadable = (db: D1Database, photo: PendingPhoto, now: number) =>
	d1("reject unreadable", () =>
		db.batch([
			db
				.prepare(
					"UPDATE item_images SET status = 'rejected', verified_at = ? WHERE id = ? AND status = 'pending'",
				)
				.bind(now, photo.id),
			auditStatement(
				db,
				photo,
				"system",
				"photo_verified",
				{ decision: "rejected", reason: "unreadable" },
				now,
			),
		]),
	);

export const FLAG_REASON = "repeat_photo_rejections";

/**
 * Flags the seller for admin review once enough of their photos were rejected as other
 * sellers' images since the last flag an admin resolved. One open flag at most (the
 * `account_flags_open` unique index), so a repeat is a no-op.
 *
 * @spec IMG-repeat-offender
 */
export const flagIfRepeatOffender = (db: D1Database, sellerId: string, now: number) =>
	Effect.gen(function* () {
		const row = yield* d1("count rejections", () =>
			db
				.prepare(
					`SELECT count(*) AS n FROM image_hashes
					WHERE seller_id = ?1 AND decision = 'rejected' AND reason IN ('duplicate', 'possible_duplicate')
						AND decided_at > coalesce(
							(SELECT max(resolved_at) FROM account_flags WHERE user_id = ?1 AND reason = '${FLAG_REASON}'), 0)`,
				)
				.bind(sellerId)
				.first<{ n: number }>(),
		);
		const count = row?.n ?? 0;
		if (!isRepeatOffender(count)) return false;
		yield* d1("flag account", () =>
			db
				.prepare(
					`INSERT OR IGNORE INTO account_flags (id, user_id, reason, count, created_at) VALUES (?, ?, '${FLAG_REASON}', ?, ?)`,
				)
				.bind(uuidv7(), sellerId, count, now)
				.run(),
		);
		return true;
	});

export interface ReviewResolution {
	readonly imageId: string;
	readonly decision: "approved" | "rejected";
}

/**
 * An admin approves or rejects a held photo (IMG-dup-review). Approving adds its hashes
 * to the index; rejecting counts toward IMG-repeat-offender. Only a photo still in
 * `review` changes; returns whether it did.
 */
export const resolveReview = (db: D1Database, resolution: ReviewResolution, adminId: string, now: number) =>
	Effect.gen(function* () {
		const photo = yield* loadPhoto(db, resolution.imageId);
		if (!photo || photo.status !== "review") return false;
		const [updated] = yield* d1("resolve review", () =>
			db.batch([
				db
					.prepare(
						"UPDATE item_images SET status = ?, verified_at = ? WHERE id = ? AND status = 'review' RETURNING id",
					)
					.bind(resolution.decision, now, photo.id),
				db
					.prepare(
						"UPDATE image_hashes SET decision = ?, decided_at = ?, decided_by = ? WHERE image_id = ? AND decision = 'review'",
					)
					.bind(resolution.decision, now, adminId, photo.id),
				auditStatement(db, photo, adminId, "photo_reviewed", { decision: resolution.decision }, now),
			]),
		);
		const changed = (updated?.results.length ?? 0) > 0;
		if (changed && resolution.decision === "rejected") yield* flagIfRepeatOffender(db, photo.seller_id, now);
		return changed;
	});

const COMPLETED_IN = COMPLETED_SALE_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * Everything `checkPublishPhotos` needs about one sale: each item's photo statuses, the
 * sale's timestamp photo, and the seller's completed sales. Read by the SaleEngine's
 * publish command under the sale lock.
 *
 * @spec IMG-required
 * @spec IMG-timestamp-required — completed sales are closed and archived ones.
 */
export async function readPublishPhotoState(
	db: D1Database,
	saleId: string,
	sellerId: string,
): Promise<PublishPhotoState> {
	const [photos, timestamp, completed] = await Promise.all([
		db
			.prepare(
				"SELECT i.id AS item_id, p.status FROM items i LEFT JOIN item_images p ON p.item_id = i.id WHERE i.sale_id = ?1",
			)
			.bind(saleId)
			.all<{ item_id: string; status: PhotoStatus | null }>(),
		db
			.prepare(
				"SELECT p.status FROM sales s JOIN item_images p ON p.id = s.timestamp_image_id WHERE s.id = ?1",
			)
			.bind(saleId)
			.first<{ status: PhotoStatus }>(),
		db
			.prepare(`SELECT count(*) AS n FROM sales WHERE seller_id = ?1 AND status IN (${COMPLETED_IN})`)
			.bind(sellerId)
			.first<{ n: number }>(),
	]);
	const byItem = new Map<string, PhotoStatus[]>();
	for (const row of photos.results) {
		const list = byItem.get(row.item_id) ?? [];
		if (row.status) list.push(row.status);
		byItem.set(row.item_id, list);
	}
	return {
		items: [...byItem.values()].map((statuses) => ({ photos: statuses })),
		timestamp: timestamp?.status ?? null,
		completedSales: completed?.n ?? 0,
	};
}

/** Pending photos the queue may have lost (a failed send, retries exhausted), newest first. */
export const stalePendingPhotos = (db: D1Database, olderThan: number, newerThan: number, limit: number) =>
	d1("stale pending photos", () =>
		db
			.prepare(
				"SELECT id FROM item_images WHERE status = 'pending' AND created_at < ? AND created_at > ? ORDER BY created_at DESC LIMIT ?",
			)
			.bind(olderThan, newerThan, limit)
			.all<{ id: string }>(),
	).pipe(Effect.map(({ results }) => results.map((r) => r.id)));
