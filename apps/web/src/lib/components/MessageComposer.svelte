<script lang="ts">
	import { hasPaymentHandle, MESSAGE_MAX_ATTACHMENTS, MESSAGE_MAX_LENGTH } from "@claimsale/core";
	import { PhotoError, preparePhoto } from "#lib/images/resize.ts";

	interface Props {
		/** The form action, e.g. `?/send`. */
		action: string;
		error?: string | undefined;
		/** Kept after a failed send. */
		value?: string;
		disabled?: boolean;
		label?: string;
	}

	let { action, error, value = "", disabled = false, label = "Message" }: Props = $props();
	let text = $state("");
	$effect.pre(() => {
		text = value;
	});
	// MSG-payment-warning: warn the writer too, before they send.
	const warn = $derived(hasPaymentHandle(text));
	let preparing = $state(false);
	let photoError = $state<string | null>(null);

	/**
	 * With JavaScript, photos are resized and re-encoded in the browser first (which strips
	 * EXIF/GPS, PLAN §5 "Images"); without it they are posted as picked and checked by the server.
	 */
	async function prepare(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		const files = [...(input.files ?? [])];
		photoError =
			files.length > MESSAGE_MAX_ATTACHMENTS ? `Attach at most ${MESSAGE_MAX_ATTACHMENTS} photos` : null;
		if (files.length === 0 || typeof DataTransfer === "undefined") return;
		preparing = true;
		try {
			const out = new DataTransfer();
			for (const file of files.slice(0, MESSAGE_MAX_ATTACHMENTS)) {
				const photo = await preparePhoto(file);
				const ext = photo.blob.type === "image/webp" ? "webp" : "jpg";
				out.items.add(new File([photo.blob], `photo.${ext}`, { type: photo.blob.type }));
			}
			input.files = out.files;
		} catch (cause) {
			photoError = cause instanceof PhotoError ? cause.message : "This photo couldn't be read.";
			input.value = "";
		} finally {
			preparing = false;
		}
	}
</script>

<form method="POST" {action} enctype="multipart/form-data" class="flex flex-col gap-2">
	<label for="message-body" class="font-medium">{label}</label>
	<textarea
		id="message-body"
		name="body"
		rows="3"
		maxlength={MESSAGE_MAX_LENGTH}
		bind:value={text}
		{disabled}
		aria-describedby={error ? "message-error" : warn ? "message-warning" : undefined}
		aria-invalid={error ? "true" : undefined}
		class="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"></textarea>
	{#if warn}
		<p id="message-warning" role="note" class="text-sm text-amber-800 dark:text-amber-300">
			Payments belong on the invoice. Messages about paying another way are flagged to protect buyers.
		</p>
	{/if}
	<label class="text-sm">
		<span class="block">Photos (optional, up to {MESSAGE_MAX_ATTACHMENTS})</span>
		<input type="file" name="photos" accept="image/*" multiple {disabled} onchange={prepare} class="mt-1" />
	</label>
	{#if photoError}<p role="alert" class="text-sm text-red-700 dark:text-red-400">{photoError}</p>{/if}
	{#if error}<p id="message-error" role="alert" class="text-sm text-red-700 dark:text-red-400">
			{error}
		</p>{/if}
	<button
		type="submit"
		disabled={disabled || preparing}
		class="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
		>{preparing ? "Preparing photos…" : "Send"}</button
	>
</form>
