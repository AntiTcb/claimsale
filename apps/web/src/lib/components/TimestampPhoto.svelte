<script lang="ts">
	import {
		preparePhoto,
		uploadTimestampPhoto,
		PhotoError,
		type PreparedPhoto,
		type UploadedPhoto,
	} from "#lib/images/resize.ts";

	/**
	 * The sale's timestamp photo (D66): the cards beside a handwritten note with the
	 * seller's handle and the date. Required for newer sellers; any sale with an approved
	 * one gets the "Timestamped" badge.
	 */
	interface Props {
		saleId: string;
		handle: string;
		required: boolean;
		photo: { id: string; status: string; rejection?: string } | null;
		disabled?: boolean;
		/** Called after a photo is uploaded, e.g. to reload page data. */
		onchange?: () => void;
		// Injectable for tests; default to the real resize + upload.
		prepare?: (file: File) => Promise<PreparedPhoto>;
		upload?: (saleId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>;
	}

	let {
		saleId,
		handle,
		required,
		photo,
		disabled = false,
		onchange,
		prepare = preparePhoto,
		upload = uploadTimestampPhoto,
	}: Props = $props();

	let busy = $state(false);
	let error = $state("");
	let status = $state("");

	const STATUS: Record<string, string> = {
		pending: "Being checked. This takes a few seconds; reload to see the result.",
		approved: "Approved. The sale shows a “Timestamped” badge.",
		review: "Held for review by ClaimSale. Replace it or wait for a decision.",
		rejected: "Rejected.",
	};

	async function onFile(file: File | undefined) {
		if (!file) return;
		error = "";
		busy = true;
		try {
			status = "Uploading the timestamp photo…";
			await upload(saleId, await prepare(file));
			status = "Timestamp photo uploaded.";
			onchange?.();
		} catch (e) {
			error = e instanceof PhotoError ? e.message : "The upload failed. Try again.";
			status = "";
		} finally {
			busy = false;
		}
	}
</script>

<section
	aria-labelledby="timestamp-heading"
	class="mt-6 rounded-md border border-zinc-300 p-3 dark:border-zinc-700"
>
	<h2 id="timestamp-heading" class="font-medium">
		Timestamp photo {#if required}<span class="text-sm font-normal">(required)</span>{:else}<span
				class="text-sm font-normal">(optional)</span
			>{/if}
	</h2>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
		Photograph this sale's cards beside a handwritten note with <strong>@{handle}</strong> and today's date.
		It must be new for this sale.
		{#if required}Sellers with fewer than 5 completed sales need one to publish.{/if}
	</p>
	{#if photo}
		<div class="mt-3 flex items-center gap-3">
			<img
				src="/api/images/{photo.id}"
				alt="Your timestamp: the cards beside your note"
				class="h-16 w-16 rounded object-cover"
			/>
			<p class="text-sm" data-testid="timestamp-status">
				{STATUS[photo.status] ?? photo.status}
				{#if photo.rejection}{photo.rejection}{/if}
			</p>
		</div>
	{/if}
	{#if !disabled}
		<label class="mt-3 inline-block cursor-pointer text-sm underline focus-within:outline-2">
			{photo ? "Replace the timestamp photo" : "Add a timestamp photo"}
			<input
				type="file"
				accept="image/*"
				class="sr-only"
				disabled={busy}
				onchange={(e) => void onFile(e.currentTarget.files?.[0])}
			/>
		</label>
	{/if}
	<p class="sr-only" role="status" aria-live="polite">{status}</p>
	{#if error}<p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">{error}</p>{/if}
</section>
