import type { Db } from "@claimsale/db";
import { emailOutbox } from "@claimsale/db/schema";
import { describe, expect, it, vi } from "vitest";
import { makeMailer, type EmailBinding, type Mail } from "./mailer.ts";

const mail: Mail = {
	to: "Jane@Example.test",
	subject: "Confirm",
	text: "secret link",
	html: "<p>secret link</p>",
};

/** A stand-in for Drizzle's `db.insert(table).values(row)`. */
function fakeDb() {
	const rows: Array<{ table: unknown; row: Record<string, unknown> }> = [];
	const db = {
		insert: (table: unknown) => ({
			values: async (row: Record<string, unknown>) => {
				rows.push({ table, row });
			},
		}),
	} as unknown as Db;
	return { db, rows };
}

describe("makeMailer", () => {
	it("captures to the outbox, lowercasing the address, and logs only the subject", async () => {
		const { db, rows } = fakeDb();
		const log = vi.fn<(line: string) => void>();
		const binding = { send: vi.fn<EmailBinding["send"]>() };
		const mailer = makeMailer({ mode: "capture", from: "no-reply@x", binding, db, now: () => 42, log });
		await mailer.send(mail);
		expect(mailer.mode).toBe("capture");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.table).toBe(emailOutbox);
		expect(rows[0]?.row).toMatchObject({
			to: "jane@example.test",
			subject: "Confirm",
			text: "secret link",
			createdAt: 42,
		});
		expect(binding.send).not.toHaveBeenCalled();
		expect(log.mock.calls[0]?.[0]).toBe(
			JSON.stringify({ level: "info", msg: "email captured", subject: "Confirm" }),
		);
		expect(String(log.mock.calls[0]?.[0])).not.toContain("jane");
	});

	it("sends through Email Service in cloudflare mode", async () => {
		const { db, rows } = fakeDb();
		const binding = { send: vi.fn<EmailBinding["send"]>(async () => ({ messageId: "m1" })) };
		const mailer = makeMailer({ mode: "cloudflare", from: "no-reply@notify.claimsale.net", binding, db });
		await mailer.send(mail);
		expect(binding.send).toHaveBeenCalledWith({
			from: "no-reply@notify.claimsale.net",
			to: "Jane@Example.test",
			subject: "Confirm",
			text: "secret link",
			html: "<p>secret link</p>",
		});
		expect(rows).toEqual([]);
	});

	it("fails closed to sending when the mode is misspelled", () => {
		const { db } = fakeDb();
		expect(
			makeMailer({ mode: "captur", from: "x", binding: { send: vi.fn<EmailBinding["send"]>() }, db }).mode,
		).toBe("cloudflare");
	});
});
