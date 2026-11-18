import { createDb, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, grantSellerPro } from "../../../test/fixtures.ts";
import {
	buyerInvoice,
	importableInvoices,
	invoiceCommands,
	listBuyerInvoices,
	saleBuyers,
	sellerInvoice,
	type InvoiceBinding,
} from "./invoices.ts";

let d1: D1Database;
let db: Db;
const NOW = Date.UTC(2026, 10, 20);

const MENU = [
	{ id: "pwe", label: "Envelope", priceCents: 150, tracked: false },
	{ id: "ground", label: "Ground Advantage", priceCents: 550, tracked: true },
];

const run = (sql: string, ...params: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...params)
		.run();

async function sale(id: string, sellerId = "seller") {
	await run(
		`INSERT INTO sales (id, seller_id, slug, title, status, terms, shipping, created_at, updated_at)
		VALUES (?1, ?2, ?1, 'Weekend singles', 'closed', ?3, ?4, 1, 1)`,
		id,
		sellerId,
		JSON.stringify({ paymentMethods: ["paypal_gs", "venmo"] }),
		JSON.stringify(MENU),
	);
}

let seq = 0;
/** An invoice with one line per item (price, kind). */
async function invoice(
	saleId: string,
	buyerId: string,
	options: {
		status?: string;
		lines?: Array<{ cents: number; kind?: string; refundOwed?: boolean }>;
		address?: Record<string, unknown> | null;
		tracking?: [string, string];
		number?: number;
	} = {},
) {
	const id = `inv${++seq}`;
	const lines = options.lines ?? [{ cents: 1000 }];
	const subtotal = lines.filter((l) => !l.refundOwed).reduce((n, l) => n + l.cents, 0);
	await run(
		`INSERT INTO invoices (id, sale_id, buyer_id, seller_id, invoice_number, status, subtotal_cents, total_cents,
			shipping_address, carrier, tracking_number, due_at, created_at, updated_at)
		VALUES (?1, ?2, ?3, 'seller', ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
		id,
		saleId,
		buyerId,
		options.number ?? seq,
		options.status ?? "sent",
		subtotal,
		options.address === undefined || options.address === null ? null : JSON.stringify(options.address),
		options.tracking?.[0] ?? null,
		options.tracking?.[1] ?? null,
		NOW + 1000,
		seq,
	);
	for (const [i, line] of lines.entries()) {
		const itemId = `${id}_item${i}`;
		const entryId = `${id}_entry${i}`;
		await run(
			`INSERT INTO items (id, sale_id, sort_order, game_id, kind, title, price_cents, created_at, updated_at)
			VALUES (?1, ?2, ?3, 'pokemon', ?4, ?5, ?6, 1, 1)`,
			itemId,
			saleId,
			i,
			line.kind ?? "single",
			`Card ${i}`,
			line.cents,
		);
		await run(
			`INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, created_at)
			VALUES (?1, ?2, ?3, 'claim', ?4, 'won', 1)`,
			entryId,
			itemId,
			buyerId,
			line.cents,
		);
		await run(
			`INSERT INTO invoice_lines (id, invoice_id, entry_id, description, amount_cents, refund_owed, created_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			`${id}_line${i}`,
			id,
			entryId,
			`Card ${i}`,
			line.cents,
			line.refundOwed ? 1 : 0,
			i,
		);
	}
	return id;
}

beforeEach(async () => {
	d1 = testD1();
	db = createDb(d1);
	await addUser(db, "seller", { handle: "sella" });
	await addUser(db, "buyer", { handle: "ashk" });
	await addUser(db, "other", { handle: "misty" });
	await sale("s1");
});

describe("invoice reads", () => {
	it("a seller sees only their own invoice, with the buyer's address snapshot [SM-6-address-snapshot]", async () => {
		const address = {
			name: "Ash K",
			line1: "1 Route 1",
			line2: null,
			city: "Pallet",
			region: "CA",
			postalCode: "94107",
			country: "US",
		};
		const id = await invoice("s1", "buyer", { status: "buyer_paid", address });
		const seen = await sellerInvoice(db, "seller", "s1", id, NOW);
		expect(seen).toMatchObject({
			status: "buyer_paid",
			number: expect.stringMatching(/^CS-\d+$/),
			buyer: { handle: "ashk" },
			address,
			lines: [{ title: "Card 0", amountCents: 1000, kind: "single" }],
		});
		expect(await sellerInvoice(db, "other", "s1", id, NOW)).toBeUndefined();
		expect(await sellerInvoice(db, "seller", "elsewhere", id, NOW)).toBeUndefined();
	});

	it("the buyer is offered only the options their subtotal allows [SM-6-shipping-threshold]", async () => {
		const cheap = await buyerInvoice(
			db,
			"buyer",
			await invoice("s1", "buyer", { lines: [{ cents: 1500 }] }),
			NOW,
		);
		expect(cheap!.shippingOptions.map((o) => o.id)).toEqual(["pwe", "ground"]);
		const big = await buyerInvoice(
			db,
			"buyer",
			await invoice("s1", "buyer", { lines: [{ cents: 2500 }] }),
			NOW,
		);
		expect(big!.shippingOptions.map((o) => o.id)).toEqual(["ground"]);
		// Pro sellers' threshold is $40.
		await grantSellerPro(db, "seller");
		const pro = await buyerInvoice(
			db,
			"buyer",
			await invoice("s1", "buyer", { lines: [{ cents: 2500 }] }),
			NOW,
		);
		expect(pro!.shippingOptions.map((o) => o.id)).toEqual(["pwe", "ground"]);
	});

	it("graded or sealed lines only offer tracked shipping and need tracking [TCG-tracked-graded-sealed]", async () => {
		const id = await invoice("s1", "buyer", { lines: [{ cents: 500 }, { cents: 500, kind: "graded" }] });
		const seen = await buyerInvoice(db, "buyer", id, NOW);
		expect(seen!.shippingOptions.map((o) => o.id)).toEqual(["ground"]);
		expect(seen!.trackingRequired).toBe(true);
		const raw = await buyerInvoice(
			db,
			"buyer",
			await invoice("s1", "buyer", { lines: [{ cents: 500 }] }),
			NOW,
		);
		expect(raw!.trackingRequired).toBe(false);
	});

	it("the buyer sees the seller's handles and the sale's payment methods, and nobody else's invoice", async () => {
		await run(
			"INSERT INTO seller_profiles (user_id, payment_handles, created_at, updated_at) VALUES ('seller', ?1, 1, 1)",
			JSON.stringify([{ kind: "paypal_gs", value: "@sella" }, { kind: "venmo", value: " " }, "junk"]),
		);
		const id = await invoice("s1", "buyer");
		const seen = await buyerInvoice(db, "buyer", id, NOW);
		expect(seen).toMatchObject({
			sale: { title: "Weekend singles", slug: "s1" },
			seller: { handle: "sella", paymentHandles: [{ kind: "paypal_gs", value: "@sella" }] },
			paymentMethods: ["paypal_gs", "venmo"],
		});
		expect(await buyerInvoice(db, "other", id, NOW)).toBeUndefined();
	});

	it("rolls invoices up per buyer, and lists a buyer's invoices without cancelled ones", async () => {
		await invoice("s1", "buyer", { status: "sent" });
		await invoice("s1", "buyer", { status: "draft" });
		await invoice("s1", "other", { status: "cancelled" });
		const rollup = await saleBuyers(db, "s1");
		expect(rollup.map((b) => [b.buyer.handle, b.invoices.map((i) => i.status)])).toEqual([
			["ashk", ["sent", "draft"]],
			["misty", ["cancelled"]],
		]);
		expect((await listBuyerInvoices(db, "other")).length).toBe(0);
		expect((await listBuyerInvoices(db, "buyer")).map((i) => i.status).toSorted()).toEqual(["draft", "sent"]);
	});

	it("the tracking import sees the sale's sent invoices with their tracking [IO-tracking-match]", async () => {
		await invoice("s1", "buyer", { status: "draft" });
		const shipped = await invoice("s1", "buyer", {
			status: "shipped",
			tracking: ["USPS", "9400"],
			number: 7,
		});
		expect(await importableInvoices(db, "s1")).toEqual([
			{
				id: shipped,
				number: "CS-7",
				status: "shipped",
				tracking: { carrier: "USPS", number: "9400" },
				buyerHandle: "ashk",
			},
		]);
	});
});

const ok = <A>(value: A) => Promise.resolve({ ok: true as const, value: { ok: true as const, value } });

describe("invoice commands", () => {
	const calls: Array<[string, unknown]> = [];
	const binding = new Proxy(
		{},
		{
			get: (_target, name: string) => (input: unknown) => {
				calls.push([name, input]);
				if (name === "confirmInvoicePaid")
					return Promise.resolve({ ok: false, error: { name: "Error", message: "boom" } });
				if (name === "shipInvoice")
					return Promise.resolve({
						ok: true,
						value: { ok: false, error: { code: "tracking_required", message: "Needs tracking" } },
					});
				if (name === "applyTracking") return ok({ rows: [{ row: 2, invoiceId: "i", outcome: "shipped" }] });
				return ok({ sent: 2 });
			},
		},
	) as unknown as InvoiceBinding;

	it("pass the user to the engine and settle its answers", async () => {
		const commands = invoiceCommands(binding);
		expect(await commands.sendAll("s1", "seller")).toEqual({ ok: true, value: { sent: 2 } });
		expect(await commands.ship("s1", "i1", "seller", null)).toEqual({
			ok: false,
			error: { code: "tracking_required", message: "Needs tracking" },
		});
		expect(await commands.confirmPaid("s1", "i1", "seller")).toMatchObject({
			ok: false,
			error: { code: "engine_unavailable" },
		});
		expect(
			await commands.markPaid({
				saleId: "s1",
				invoiceId: "i1",
				buyerId: "buyer",
				shippingOptionId: "ground",
				addressId: "a1",
				paymentRef: null,
			}),
		).toEqual({ ok: true, value: true });
		expect(calls).toContainEqual([
			"markInvoicePaid",
			{
				saleId: "s1",
				invoiceId: "i1",
				buyerId: "buyer",
				shippingOptionId: "ground",
				addressId: "a1",
				paymentRef: null,
			},
		]);
		expect(await commands.rescindOverdue("s1", "i1", "seller")).toEqual({ ok: true, value: true });
		expect(calls).toContainEqual([
			"rescindOverdueInvoice",
			{ saleId: "s1", invoiceId: "i1", sellerId: "seller" },
		]);
	});
});
