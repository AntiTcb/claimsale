/**
 * Invoices after close (WS-J): the address snapshot at payment, tracked shipping for
 * graded and sealed items, the one-click overdue rescind, tracking corrections and the
 * tracking re-import.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAddress,
	addressOf,
	addUser,
	auditOf,
	claim,
	DAY,
	db,
	engine,
	entriesOf,
	entryOf,
	HOUR,
	invoicesOf,
	makeSale,
	rejection,
	setClock,
	stubFor,
	value,
	type SaleSetup,
} from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

const SHIPPING = [
	{ id: "pwe", label: "Stamped envelope", priceCents: 100, tracked: false },
	{ id: "ground", label: "Ground Advantage", priceCents: 550, tracked: true },
];

async function setKind(itemId: string, kind: "single" | "graded" | "sealed") {
	await db.prepare("UPDATE items SET kind = ?1 WHERE id = ?2").bind(kind, itemId).run();
}

async function sentInvoice(
	options: {
		priceCents?: number;
		kind?: "single" | "graded" | "sealed";
		backup?: boolean;
		terms?: Record<string, unknown>;
	} = {},
) {
	const sale = await makeSale({
		items: [{ priceCents: options.priceCents ?? 1500 }],
		shipping: SHIPPING,
		terms: options.terms ?? {},
		closesAt: Date.now() + 10 * DAY,
	});
	if (options.kind) await setKind(sale.itemIds[0]!, options.kind);
	const buyer = await addUser();
	await addAddress(buyer);
	const winner = entryOf(await claim(sale, buyer));
	const backup = options.backup ? await addUser() : undefined;
	const backupEntry = backup ? entryOf(await claim(sale, backup)) : undefined;
	value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
	const invoiceId = (await invoicesOf(sale.saleId))[0]!["id"] as string;
	const sentAt = Date.now();
	await setClock(sale.saleId, sentAt);
	value(await engine.sendInvoice({ saleId: sale.saleId, invoiceId, sellerId: sale.sellerId }));
	return { sale, buyer, winner, backup, backupEntry, invoiceId, sentAt };
}

const pay = (sale: SaleSetup, invoiceId: string, buyer: string, shippingOptionId = "ground") =>
	engine.markInvoicePaid({
		saleId: sale.saleId,
		invoiceId,
		buyerId: buyer,
		addressId: addressOf(buyer),
		shippingOptionId,
		paymentRef: null,
	});

async function paidInvoice(options: Parameters<typeof sentInvoice>[0] = {}) {
	const setup = await sentInvoice(options);
	value(await pay(setup.sale, setup.invoiceId, setup.buyer));
	value(
		await engine.confirmInvoicePaid({
			saleId: setup.sale.saleId,
			invoiceId: setup.invoiceId,
			sellerId: setup.sale.sellerId,
		}),
	);
	return setup;
}

describe("paying an invoice", () => {
	it("snapshots the chosen address and shipping label; later address edits don't change it [SM-6-address-snapshot]", async () => {
		const { sale, buyer, invoiceId } = await sentInvoice();
		value(await pay(sale, invoiceId, buyer));
		await db.prepare("UPDATE addresses SET line1 = '2 Route 2' WHERE id = ?1").bind(addressOf(buyer)).run();
		const [invoice] = await invoicesOf(sale.saleId);
		expect(JSON.parse(invoice!["shipping_address"] as string)).toEqual({
			name: "Ash Ketchum",
			line1: "1 Route 1",
			line2: null,
			city: "Pallet",
			region: "CA",
			postalCode: "94107",
			country: "US",
		});
		expect(invoice!["shipping_option_label"]).toBe("Ground Advantage");
		// The address never reaches the audit log.
		const audit = await auditOf(sale.saleId);
		expect(JSON.stringify(audit)).not.toContain("Route 1");
	});

	it("rejects another user's address or a deleted one [SM-6-address-snapshot]", async () => {
		const { sale, buyer, invoiceId } = await sentInvoice();
		const stranger = await addUser();
		await addAddress(stranger);
		const input = {
			saleId: sale.saleId,
			invoiceId,
			buyerId: buyer,
			shippingOptionId: "ground",
			paymentRef: null,
		};
		expect(rejection(await engine.markInvoicePaid({ ...input, addressId: addressOf(stranger) }))).toBe(
			"address_not_found",
		);
		await db.prepare("UPDATE addresses SET deleted_at = 1 WHERE id = ?1").bind(addressOf(buyer)).run();
		expect(rejection(await engine.markInvoicePaid({ ...input, addressId: addressOf(buyer) }))).toBe(
			"address_not_found",
		);
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({ status: "sent", shipping_address: null });
	});
});

describe("tracked shipping for graded and sealed items", () => {
	it("a graded item only offers tracked shipping, under the threshold too [TCG-tracked-graded-sealed]", async () => {
		const { sale, buyer, invoiceId } = await sentInvoice({ priceCents: 500, kind: "graded" });
		expect(rejection(await pay(sale, invoiceId, buyer, "pwe"))).toBe("unknown_shipping_option");
		expect(value(await pay(sale, invoiceId, buyer, "ground")).status).toBe("buyer_paid");
	});

	it("a sealed item can't ship without tracking, under the threshold too [TCG-tracked-graded-sealed]", async () => {
		const { sale, invoiceId } = await paidInvoice({ priceCents: 500, kind: "sealed" });
		const seller = { saleId: sale.saleId, invoiceId, sellerId: sale.sellerId };
		expect(rejection(await engine.shipInvoice({ ...seller, tracking: null }))).toBe("tracking_required");
		expect(
			value(
				await engine.shipInvoice({
					...seller,
					tracking: { carrier: "USPS", number: "9400100000000000000001" },
				}),
			).status,
		).toBe("shipped");
	});

	it("a cheap raw single may still ship untracked [TCG-tracked-graded-sealed]", async () => {
		const { sale, invoiceId } = await paidInvoice({ priceCents: 500, kind: "single" });
		expect(
			value(
				await engine.shipInvoice({ saleId: sale.saleId, invoiceId, sellerId: sale.sellerId, tracking: null }),
			).status,
		).toBe("shipped");
	});
});

describe("rescinding an overdue invoice in one click", () => {
	it("rescinds every line for non-payment and passes the item to the backup [SM-6-overdue-rescind]", async () => {
		const { sale, buyer, winner, backup, backupEntry, invoiceId, sentAt } = await sentInvoice({
			backup: true,
		});
		const input = { saleId: sale.saleId, invoiceId, sellerId: sale.sellerId };
		expect(rejection(await engine.rescindOverdueInvoice(input))).toBe("invalid_status");
		await setClock(sale.saleId, sentAt + 48 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({ status: "overdue" });
		expect(rejection(await engine.rescindOverdueInvoice({ ...input, sellerId: buyer }))).toBe("not_allowed");

		expect(value(await engine.rescindOverdueInvoice(input)).status).toBe("cancelled");
		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.find((r) => r["id"] === winner.id)).toMatchObject({ status: "rescinded" });
		expect(rows.find((r) => r["id"] === backupEntry!.id)).toMatchObject({ status: "won" });
		expect(
			await db.prepare("SELECT reason_code, fault FROM rescinds WHERE entry_id = ?1").bind(winner.id).first(),
		).toEqual({ reason_code: "buyer_nonpayment", fault: "buyer" });
		const invoices = await invoicesOf(sale.saleId);
		expect(invoices.map((i) => [i["buyer_id"], i["status"]])).toEqual([
			[buyer, "cancelled"],
			[backup, "draft"],
		]);
		const actions = (await auditOf(sale.saleId))
			.filter((a) => a.actor_id === sale.sellerId)
			.map((a) => a.action);
		expect(actions).toContain("rescinded_and_passed");
	});
});

describe("tracking", () => {
	it("a confirmed replacement on a shipped invoice is logged with the old number [IO-tracking-replace]", async () => {
		const { sale, invoiceId } = await paidInvoice({ priceCents: 2500 });
		const seller = { saleId: sale.saleId, invoiceId, sellerId: sale.sellerId };
		expect(
			rejection(
				await engine.replaceInvoiceTracking({ ...seller, tracking: { carrier: "UPS", number: "1Z1" } }),
			),
		).toBe("invalid_status");
		value(await engine.shipInvoice({ ...seller, tracking: { carrier: "USPS", number: "9400111" } }));
		const replaced = value(
			await engine.replaceInvoiceTracking({
				...seller,
				tracking: { carrier: "UPS", number: "1Z999AA10123456784" },
			}),
		);
		expect(replaced.tracking).toEqual({ carrier: "UPS", number: "1Z999AA10123456784" });
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({
			carrier: "UPS",
			tracking_number: "1Z999AA10123456784",
		});
		const log = (await auditOf(sale.saleId)).find((a) => a.action === "tracking_replaced");
		expect(log).toMatchObject({ actor_id: sale.sellerId, data: { events: [{ previous: "9400111" }] } });
	});

	it("the re-import ships only paid invoices and rejects the rest with the reason [IO-tracking-transition]", async () => {
		const paid = await paidInvoice();
		const sale = paid.sale;
		const result = value(
			await engine.applyTracking({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				rows: [
					{
						row: 2,
						invoiceId: paid.invoiceId,
						carrier: "USPS",
						number: "9400100000000000000002",
						replace: false,
					},
					{
						row: 3,
						invoiceId: "inv_missing",
						carrier: "USPS",
						number: "9400100000000000000003",
						replace: false,
					},
				],
			}),
		);
		expect(result.rows).toEqual([
			{ row: 2, invoiceId: paid.invoiceId, outcome: "shipped" },
			expect.objectContaining({ row: 3, outcome: "error", code: "not_found" }),
		]);
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({
			status: "shipped",
			tracking_number: "9400100000000000000002",
		});

		const unpaid = await sentInvoice();
		const rejected = value(
			await engine.applyTracking({
				saleId: unpaid.sale.saleId,
				sellerId: unpaid.sale.sellerId,
				rows: [
					{
						row: 2,
						invoiceId: unpaid.invoiceId,
						carrier: "USPS",
						number: "9400100000000000000004",
						replace: true,
					},
				],
			}),
		);
		expect(rejected.rows).toEqual([
			expect.objectContaining({ outcome: "error", code: "not_paid", message: "The buyer hasn't paid yet" }),
		]);
		expect((await invoicesOf(unpaid.sale.saleId))[0]).toMatchObject({
			status: "sent",
			tracking_number: null,
		});
		// Another seller can't apply tracking to this sale.
		expect(
			rejection(await engine.applyTracking({ saleId: unpaid.sale.saleId, sellerId: unpaid.buyer, rows: [] })),
		).toBe("not_found");
	});

	it("the re-import replaces a shipped number only when confirmed; the same number is unchanged [IO-tracking-replace]", async () => {
		const { sale, invoiceId } = await paidInvoice();
		const apply = async (number: string, replace: boolean) =>
			value(
				await engine.applyTracking({
					saleId: sale.saleId,
					sellerId: sale.sellerId,
					rows: [{ row: 2, invoiceId, carrier: "USPS", number, replace }],
				}),
			).rows[0];
		expect(await apply("9400100000000000000005", false)).toMatchObject({ outcome: "shipped" });
		expect(await apply("9400 1000 0000 0000 0000 05", false)).toMatchObject({ outcome: "unchanged" });
		expect(await apply("9400100000000000000006", false)).toMatchObject({
			outcome: "error",
			code: "replace_unconfirmed",
		});
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({ tracking_number: "9400100000000000000005" });
		expect(await apply("9400100000000000000006", true)).toMatchObject({ outcome: "replaced" });
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({ tracking_number: "9400100000000000000006" });
		const replaced = (await auditOf(sale.saleId)).filter((a) => a.action === "tracking_replaced");
		expect(replaced).toHaveLength(1);
		expect(replaced[0]!.data).toMatchObject({ events: [{ previous: "9400100000000000000005" }] });
	});

	it("a row can't ship the same invoice twice in one batch [IO-tracking-match]", async () => {
		const { sale, invoiceId } = await paidInvoice();
		const result = value(
			await engine.applyTracking({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				rows: [
					{ row: 2, invoiceId, carrier: "USPS", number: "9400100000000000000007", replace: false },
					{ row: 3, invoiceId, carrier: "USPS", number: "9400100000000000000008", replace: true },
				],
			}),
		);
		expect(result.rows.map((r) => r.outcome)).toEqual(["shipped", "error"]);
	});
});
