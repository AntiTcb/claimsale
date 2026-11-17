import { RESCIND_REASONS, type RescindReasonCode } from "@claimsale/core";
import { Schema } from "effect";
import { MAX_IMPORT_BATCH } from "./import.ts";

/**
 * Input schemas of the engine's sale RPC methods. The web Worker authenticates the
 * user and passes their ID; the engine decides what that user may do (§8). Every
 * input names its sale, which picks the SaleEngine instance.
 */

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Cents = Schema.Int.check(Schema.isGreaterThan(0));
const Millis = Schema.Int.check(Schema.isGreaterThan(0));

const ReasonCode = Schema.Literals(Object.keys(RESCIND_REASONS) as RescindReasonCode[]);

export const PlaceEntryInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	buyerId: Id,
	kind: Schema.Literals(["claim", "offer"]),
	amountCents: Schema.optional(Cents),
});
export type PlaceEntryInput = typeof PlaceEntryInput.Type;

export const BuyerEntryInput = Schema.Struct({ saleId: Id, itemId: Id, entryId: Id, buyerId: Id });
export type BuyerEntryInput = typeof BuyerEntryInput.Type;

export const CounterResponseInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	entryId: Id,
	buyerId: Id,
	accept: Schema.Boolean,
});
export type CounterResponseInput = typeof CounterResponseInput.Type;

export const SellerEntryInput = Schema.Struct({ saleId: Id, itemId: Id, entryId: Id, sellerId: Id });
export type SellerEntryInput = typeof SellerEntryInput.Type;

export const CounterInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	entryId: Id,
	sellerId: Id,
	amountCents: Cents,
});
export type CounterInput = typeof CounterInput.Type;

export const ReorderInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	sellerId: Id,
	orderedEntryIds: Schema.Array(Id).check(Schema.isMaxLength(1000)),
});
export type ReorderInput = typeof ReorderInput.Type;

export const SellerItemInput = Schema.Struct({ saleId: Id, itemId: Id, sellerId: Id });
export type SellerItemInput = typeof SellerItemInput.Type;

export const SellerRescindInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	entryId: Id,
	sellerId: Id,
	reasonCode: ReasonCode,
	explanation: Schema.String.check(Schema.isMaxLength(2000)),
	passToNext: Schema.Boolean,
	/** The extra confirmation after the buyer marked the invoice paid. */
	confirmed: Schema.Boolean,
	attachmentKey: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
});
export type SellerRescindInput = typeof SellerRescindInput.Type;

export const TakebackRequestInput = Schema.Struct({
	saleId: Id,
	itemId: Id,
	entryId: Id,
	buyerId: Id,
	reason: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
});
export type TakebackRequestInput = typeof TakebackRequestInput.Type;

export const TakebackDecisionInput = Schema.Struct({
	saleId: Id,
	requestId: Id,
	sellerId: Id,
	approve: Schema.Boolean,
});
export type TakebackDecisionInput = typeof TakebackDecisionInput.Type;

export const TakebackCancelInput = Schema.Struct({ saleId: Id, requestId: Id, buyerId: Id });
export type TakebackCancelInput = typeof TakebackCancelInput.Type;

export const PublishInput = Schema.Struct({
	saleId: Id,
	sellerId: Id,
	/** Null publishes now. */
	liveAt: Schema.NullOr(Millis),
	closesAt: Millis,
});
export type PublishInput = typeof PublishInput.Type;

export const SellerSaleInput = Schema.Struct({ saleId: Id, sellerId: Id });
export type SellerSaleInput = typeof SellerSaleInput.Type;

export const SellerInvoiceInput = Schema.Struct({ saleId: Id, invoiceId: Id, sellerId: Id });
export type SellerInvoiceInput = typeof SellerInvoiceInput.Type;

export const BuyerInvoiceInput = Schema.Struct({ saleId: Id, invoiceId: Id, buyerId: Id });
export type BuyerInvoiceInput = typeof BuyerInvoiceInput.Type;

export const MarkPaidInput = Schema.Struct({
	saleId: Id,
	invoiceId: Id,
	buyerId: Id,
	shippingOptionId: Id,
	paymentRef: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
});
export type MarkPaidInput = typeof MarkPaidInput.Type;

export const ShipInput = Schema.Struct({
	saleId: Id,
	invoiceId: Id,
	sellerId: Id,
	tracking: Schema.NullOr(
		Schema.Struct({
			carrier: Schema.String.check(Schema.isMaxLength(40)),
			number: Schema.String.check(Schema.isMaxLength(64)),
		}),
	),
});
export type ShipInput = typeof ShipInput.Type;

export const ImportBatchInput = Schema.Struct({
	saleId: Id,
	sellerId: Id,
	importId: Id,
	rows: Schema.Array(
		Schema.Struct({
			row: Schema.Int.check(Schema.isGreaterThan(1)),
			cells: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(10_000))),
		}),
	).check(Schema.isMaxLength(MAX_IMPORT_BATCH)),
});
export type ImportBatchInput = typeof ImportBatchInput.Type;
