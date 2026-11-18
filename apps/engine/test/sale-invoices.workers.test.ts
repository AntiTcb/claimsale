import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAddress,
	addressOf,
	addUser,
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
	uid,
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

async function closedSaleWithWinner(
	options: { priceCents?: number; terms?: Record<string, unknown>; backup?: boolean } = {},
) {
	const sale = await makeSale({
		items: [{ priceCents: options.priceCents ?? 1500 }],
		shipping: SHIPPING,
		terms: options.terms ?? {},
		closesAt: Date.now() + 10 * DAY,
	});
	const buyer = await addUser();
	await addAddress(buyer);
	const winner = entryOf(await claim(sale, buyer));
	const backup = options.backup ? await addUser() : undefined;
	const backupEntry = backup ? entryOf(await claim(sale, backup)) : undefined;
	value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
	const [invoice] = await invoicesOf(sale.saleId);
	return { sale, buyer, winner, backup, backupEntry, invoiceId: invoice!["id"] as string };
}

const ids = (sale: SaleSetup, invoiceId: string) => ({ saleId: sale.saleId, invoiceId });

describe("invoices", () => {
	it("are sent only after the sale closes [SM-6-send-after-close]", async () => {
		const sale = await makeSale({ shipping: SHIPPING });
		await claim(sale, await addUser());
		const [invoice] = await invoicesOf(sale.saleId);
		const input = { saleId: sale.saleId, invoiceId: invoice!["id"] as string, sellerId: sale.sellerId };
		expect(rejection(await engine.sendInvoice(input))).toBe("sale_not_closed");
		value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
		expect(value(await engine.sendInvoice(input)).status).toBe("sent");
	});

	it("auto-send at close sends every draft [SM-6-send-after-close]", async () => {
		const { sale } = await closedSaleWithWinner({ terms: { autoSendAtClose: true } });
		const [invoice] = await invoicesOf(sale.saleId);
		expect(invoice).toMatchObject({ status: "sent", due_at: expect.any(Number) });
	});

	it("a win after the invoice was sent goes on a new draft [SM-6-late-wins-new-invoice]", async () => {
		const sale = await makeSale({ items: [{}, {}], shipping: SHIPPING, terms: { reviewEveryClaim: true } });
		const buyer = await addUser();
		const first = entryOf(await claim(sale, buyer));
		const late = entryOf(await claim(sale, buyer, sale.itemIds[1]));
		value(
			await engine.awardEntry({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: first.id,
				sellerId: sale.sellerId,
			}),
		);
		value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
		expect(value(await engine.sendAllInvoices({ saleId: sale.saleId, sellerId: sale.sellerId }))).toEqual({
			sent: 1,
		});
		value(
			await engine.awardEntry({
				saleId: sale.saleId,
				itemId: sale.itemIds[1]!,
				entryId: late.id,
				sellerId: sale.sellerId,
			}),
		);
		const invoices = await invoicesOf(sale.saleId);
		expect(invoices.map((i) => [i["status"], i.lines.map((l) => l["entry_id"])])).toEqual([
			["sent", [first.id]],
			["draft", [late.id]],
		]);
	});

	it("go buyer_paid → paid (GMV) → shipped (tracking above the threshold) → completed, fulfilling the win [SM-6-paid-flow] [SM-6-gmv]", async () => {
		const { sale, buyer, winner, invoiceId } = await closedSaleWithWinner({ priceCents: 2500 });
		const seller = { ...ids(sale, invoiceId), sellerId: sale.sellerId };
		value(await engine.sendInvoice(seller));
		// $25 is over the free seller's $20 threshold: the envelope isn't offered.
		expect(
			rejection(
				await engine.markInvoicePaid({
					...ids(sale, invoiceId),
					buyerId: buyer,
					addressId: addressOf(buyer),
					shippingOptionId: "pwe",
					paymentRef: null,
				}),
			),
		).toBe("unknown_shipping_option");
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "ground",
				paymentRef: "PP-123",
			}),
		);
		expect(value(await engine.confirmInvoicePaid(seller))).toMatchObject({ status: "paid", gmvCents: 3050 });
		expect(rejection(await engine.shipInvoice({ ...seller, tracking: null }))).toBe("tracking_required");
		value(
			await engine.shipInvoice({
				...seller,
				tracking: { carrier: "USPS", number: "9400100000000000000000" },
			}),
		);
		value(await engine.completeInvoice({ ...ids(sale, invoiceId), buyerId: buyer }));
		const [invoice] = await invoicesOf(sale.saleId);
		expect(invoice).toMatchObject({
			status: "completed",
			gmv_cents: 3050,
			total_cents: 3050,
			shipping_cents: 550,
			payment_ref: "PP-123",
			carrier: "USPS",
			paid_at: expect.any(Number),
			buyer_paid_at: expect.any(Number),
		});
		expect((await entriesOf(sale.itemIds[0]!))[0]).toMatchObject({ id: winner.id, status: "fulfilled" });
	});

	it("the seller says the payment didn't arrive: back to sent", async () => {
		const { sale, buyer, invoiceId } = await closedSaleWithWinner();
		const seller = { ...ids(sale, invoiceId), sellerId: sale.sellerId };
		value(await engine.sendInvoice(seller));
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "pwe",
				paymentRef: null,
			}),
		);
		expect(value(await engine.invoiceNotReceived(seller)).status).toBe("sent");
		// Only the buyer marks paid, only the seller confirms.
		expect(rejection(await engine.confirmInvoicePaid({ ...ids(sale, invoiceId), sellerId: buyer }))).toBe(
			"not_allowed",
		);
	});

	it("auto-completes 14 days after shipping through the alarm [SM-6-autocomplete]", async () => {
		const { sale, buyer, invoiceId } = await closedSaleWithWinner();
		const seller = { ...ids(sale, invoiceId), sellerId: sale.sellerId };
		value(await engine.sendInvoice(seller));
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "pwe",
				paymentRef: null,
			}),
		);
		value(await engine.confirmInvoicePaid(seller));
		const shippedAt = Date.now();
		await setClock(sale.saleId, shippedAt);
		value(await engine.shipInvoice({ ...seller, tracking: null }));
		await setClock(sale.saleId, shippedAt + 14 * DAY);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({
			status: "completed",
			completed_at: shippedAt + 14 * DAY,
		});
	});

	it("the payment deadline makes it overdue and auto-rescind passes the item on [SM-6-payment-deadline] [SM-6-rescind-line]", async () => {
		const { sale, buyer, winner, backup, backupEntry, invoiceId } = await closedSaleWithWinner({
			terms: { autoRescindOverdue: true },
			backup: true,
		});
		const sentAt = Date.now();
		await setClock(sale.saleId, sentAt);
		const sent = value(await engine.sendInvoice({ ...ids(sale, invoiceId), sellerId: sale.sellerId }));
		expect(sent.dueAt).toBe(sentAt + 48 * HOUR);
		await setClock(sale.saleId, sentAt + 48 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));

		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.find((r) => r["id"] === winner.id)).toMatchObject({ status: "rescinded" });
		expect(rows.find((r) => r["id"] === backupEntry!.id)).toMatchObject({ status: "won" });
		const rescind = await db
			.prepare("SELECT reason_code, fault, buyer_id FROM rescinds WHERE entry_id = ?1")
			.bind(winner.id)
			.first();
		expect(rescind).toEqual({ reason_code: "buyer_nonpayment", fault: "buyer", buyer_id: buyer });
		// The overdue invoice lost its only line; the promoted backup has a new draft.
		const invoices = await invoicesOf(sale.saleId);
		expect(invoices.map((i) => [i["buyer_id"], i["status"], i.lines.length])).toEqual([
			[buyer, "cancelled", 0],
			[backup, "draft", 1],
		]);
	});

	it("without auto-rescind, overdue only flags the invoice [SM-6-payment-deadline]", async () => {
		const { sale, winner, invoiceId } = await closedSaleWithWinner({ backup: true });
		const sentAt = Date.now();
		await setClock(sale.saleId, sentAt);
		value(await engine.sendInvoice({ ...ids(sale, invoiceId), sellerId: sale.sellerId }));
		await setClock(sale.saleId, sentAt + 48 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect((await invoicesOf(sale.saleId))[0]).toMatchObject({ status: "overdue" });
		expect((await entriesOf(sale.itemIds[0]!)).find((r) => r["id"] === winner.id)).toMatchObject({
			status: "won",
		});
	});

	it("a rescind after the buyer paid needs confirmation and keeps the line as refund owed [SM-4.3.1-refund-owed] [SM-6-rescind-line]", async () => {
		const { sale, buyer, winner, invoiceId } = await closedSaleWithWinner();
		value(await engine.sendInvoice({ ...ids(sale, invoiceId), sellerId: sale.sellerId }));
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "pwe",
				paymentRef: null,
			}),
		);
		const base = {
			saleId: sale.saleId,
			itemId: sale.itemIds[0]!,
			entryId: winner.id,
			sellerId: sale.sellerId,
			reasonCode: "seller_item_unavailable" as const,
			explanation: "The card was damaged while packing it",
			passToNext: false,
		};
		expect(rejection(await engine.sellerRescind({ ...base, confirmed: false }))).toBe(
			"confirmation_required",
		);
		value(await engine.sellerRescind({ ...base, confirmed: true }));
		const [invoice] = await invoicesOf(sale.saleId);
		expect(invoice).toMatchObject({ status: "buyer_paid" });
		expect(invoice!.lines).toEqual([expect.objectContaining({ entry_id: winner.id, refund_owed: 1 })]);
		expect(
			await db.prepare("SELECT refund_owed, fault FROM rescinds WHERE entry_id = ?1").bind(winner.id).first(),
		).toEqual({
			refund_owed: 1,
			fault: "seller",
		});
	});

	it("backups are lost once every unit is paid [SM-4.5-backups-lost]", async () => {
		const { sale, buyer, backupEntry, invoiceId } = await closedSaleWithWinner({ backup: true });
		const seller = { ...ids(sale, invoiceId), sellerId: sale.sellerId };
		value(await engine.sendInvoice(seller));
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "pwe",
				paymentRef: null,
			}),
		);
		expect((await entriesOf(sale.itemIds[0]!)).find((r) => r["id"] === backupEntry!.id)).toMatchObject({
			status: "open",
		});
		value(await engine.confirmInvoicePaid(seller));
		expect((await entriesOf(sale.itemIds[0]!)).find((r) => r["id"] === backupEntry!.id)).toMatchObject({
			status: "lost",
			ended_reason: "units_paid",
		});
	});

	it("a take-back can't be requested once the invoice is marked paid [SM-5-takeback-request]", async () => {
		const { sale, buyer, winner, invoiceId } = await closedSaleWithWinner();
		value(await engine.sendInvoice({ ...ids(sale, invoiceId), sellerId: sale.sellerId }));
		value(
			await engine.markInvoicePaid({
				...ids(sale, invoiceId),
				buyerId: buyer,
				addressId: addressOf(buyer),
				shippingOptionId: "pwe",
				paymentRef: null,
			}),
		);
		expect(
			rejection(
				await engine.requestTakeback({
					saleId: sale.saleId,
					itemId: sale.itemIds[0]!,
					entryId: winner.id,
					buyerId: buyer,
				}),
			),
		).toBe("invoice_paid");
	});

	it("an unknown invoice is not found", async () => {
		const sale = await makeSale();
		expect(
			rejection(
				await engine.sendInvoice({ saleId: sale.saleId, invoiceId: uid("inv"), sellerId: sale.sellerId }),
			),
		).toBe("not_found");
	});
});
