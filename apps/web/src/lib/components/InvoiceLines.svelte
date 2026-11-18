<script lang="ts">
	import { formatCents } from "@claimsale/core";

	/** An invoice's lines and totals, as the seller and the buyer both see them. */
	interface Props {
		invoice: {
			readonly lines: readonly {
				readonly entryId: string;
				readonly title: string;
				readonly amountCents: number;
				readonly refundOwed: boolean;
			}[];
			readonly subtotalCents: number;
			readonly shippingCents: number;
			readonly adjustmentCents: number;
			readonly totalCents: number;
			readonly shippingOptionLabel: string | null;
			readonly shippingOptionId: string | null;
		};
	}

	let { invoice }: Props = $props();
	const shippingChosen = $derived(invoice.shippingOptionId !== null);
</script>

<table class="mt-6 w-full text-left text-sm">
	<caption class="sr-only">Items and totals</caption>
	<thead class="border-b border-zinc-200 dark:border-zinc-800">
		<tr>
			<th scope="col" class="py-2 pr-4">Item</th>
			<th scope="col" class="py-2 text-right">Price</th>
		</tr>
	</thead>
	<tbody>
		{#each invoice.lines as line (line.entryId)}
			<tr class="border-b border-zinc-100 dark:border-zinc-900">
				<td class="py-2 pr-4">
					<span class={line.refundOwed ? "line-through" : ""}>{line.title}</span>
					{#if line.refundOwed}<span class="ml-2 text-amber-900 dark:text-amber-200">Refund owed</span>{/if}
				</td>
				<td class="py-2 text-right">{formatCents(line.amountCents)}</td>
			</tr>
		{/each}
	</tbody>
	<tfoot>
		<tr>
			<th scope="row" class="pt-3 pr-4 font-normal">Subtotal</th>
			<td class="pt-3 text-right">{formatCents(invoice.subtotalCents)}</td>
		</tr>
		<tr>
			<th scope="row" class="pr-4 font-normal"
				>Shipping{#if invoice.shippingOptionLabel}{" "}<span>({invoice.shippingOptionLabel})</span>{/if}</th
			>
			<td class="text-right">{shippingChosen ? formatCents(invoice.shippingCents) : "Chosen when paying"}</td>
		</tr>
		{#if invoice.adjustmentCents !== 0}
			<tr>
				<th scope="row" class="pr-4 font-normal">Adjustment</th>
				<td class="text-right"
					>{invoice.adjustmentCents < 0 ? "−" : ""}{formatCents(Math.abs(invoice.adjustmentCents))}</td
				>
			</tr>
		{/if}
		<tr>
			<th scope="row" class="pr-4">Total</th>
			<td class="text-right font-semibold" data-testid="invoice-total">{formatCents(invoice.totalCents)}</td>
		</tr>
	</tfoot>
</table>
