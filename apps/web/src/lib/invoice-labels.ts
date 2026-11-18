import type { InvoiceStatus, ShippingAddress } from "@claimsale/core";

/** What each invoice status is called on the seller's and the buyer's pages. */
export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
	draft: "Not sent yet",
	sent: "Awaiting payment",
	overdue: "Overdue",
	buyer_paid: "Marked paid",
	paid: "Paid",
	shipped: "Shipped",
	completed: "Completed",
	cancelled: "Cancelled",
};

/** The address as lines for display. */
export function addressLines(address: ShippingAddress): string[] {
	return [
		address.name,
		address.line1,
		...(address.line2 ? [address.line2] : []),
		`${address.city}, ${address.region} ${address.postalCode}`,
		...(address.country && address.country !== "US" ? [address.country] : []),
	];
}

export const CARRIER_CHOICES = ["USPS", "UPS", "FedEx", "DHL"] as const;
