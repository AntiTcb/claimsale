/** A message as the thread page shows it (server: #lib/server/messaging.ts `MessageView`). */
export interface ThreadMessage {
	readonly id: string;
	readonly mine: boolean;
	readonly senderName: string;
	readonly body: string;
	readonly paymentWarning: boolean;
	readonly createdAt: number;
	readonly attachments: ReadonlyArray<{
		readonly id: string;
		readonly url: string;
		readonly width: number | null;
		readonly height: number | null;
	}>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const nullableNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Checks a message from the poll endpoint; null if it isn't one. */
export function parseThreadMessage(raw: unknown): ThreadMessage | null {
	if (!isRecord(raw)) return null;
	const { id, mine, senderName, body, paymentWarning, createdAt, attachments } = raw;
	if (
		typeof id !== "string" ||
		typeof mine !== "boolean" ||
		typeof senderName !== "string" ||
		typeof body !== "string" ||
		typeof paymentWarning !== "boolean" ||
		typeof createdAt !== "number" ||
		!Array.isArray(attachments)
	)
		return null;
	return {
		id,
		mine,
		senderName,
		body,
		paymentWarning,
		createdAt,
		attachments: attachments.filter(isRecord).flatMap((a) =>
			typeof a["id"] === "string" && typeof a["url"] === "string"
				? [
						{
							id: a["id"],
							url: a["url"],
							width: nullableNumber(a["width"]),
							height: nullableNumber(a["height"]),
						},
					]
				: [],
		),
	};
}
