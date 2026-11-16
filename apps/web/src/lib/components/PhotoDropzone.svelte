<script lang="ts">
	import {
		deletePhoto,
		preparePhoto,
		uploadPhoto,
		PhotoError,
		type PreparedPhoto,
		type UploadedPhoto,
	} from "#lib/images/resize.ts";

	interface Photo {
		id: string;
		url: string;
		status?: string;
	}

	interface Props {
		saleId: string;
		itemId: string;
		/** Used in labels, e.g. "Photos for Charizard". */
		itemTitle: string;
		photos: Photo[];
		/** The seller's per-item cap (D33); the server enforces it too. */
		max: number;
		disabled?: boolean;
		/** Called after a photo is added or removed, e.g. to reload page data. */
		onchange?: () => void;
		// Injectable for tests; default to the real resize + upload.
		prepare?: (file: File) => Promise<PreparedPhoto>;
		upload?: (saleId: string, itemId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>;
		remove?: (imageId: string) => Promise<void>;
	}

	let {
		saleId,
		itemId,
		itemTitle,
		photos,
		max,
		disabled = false,
		onchange,
		prepare = preparePhoto,
		upload = uploadPhoto,
		remove = deletePhoto,
	}: Props = $props();

	let busy = $state(false);
	let dragging = $state(false);
	let error = $state("");
	let status = $state("");
	let input: HTMLInputElement | undefined = $state();

	const inputId = $derived(`photos-${itemId}`);
	const remaining = $derived(Math.max(0, max - photos.length));
	const full = $derived(remaining === 0);

	async function addFiles(files: FileList | File[]) {
		error = "";
		const list = Array.from(files);
		if (list.length === 0) return;
		if (list.length > remaining) {
			error = full
				? `This item already has ${max} photos.`
				: `You can add ${remaining} more photo${remaining === 1 ? "" : "s"} to this item.`;
			return;
		}
		busy = true;
		let added = 0;
		try {
			for (const file of list) {
				status = `Uploading photo ${added + 1} of ${list.length}…`;
				// Sequential on purpose: one upload at a time on phone connections.
				// oxlint-disable-next-line no-await-in-loop
				await upload(saleId, itemId, await prepare(file));
				added += 1;
			}
			status = `Added ${added} photo${added === 1 ? "" : "s"}.`;
		} catch (e) {
			error = e instanceof PhotoError ? e.message : "The upload failed. Try again.";
			status = "";
		} finally {
			busy = false;
			if (input) input.value = "";
			if (added > 0) onchange?.();
		}
	}

	async function removePhoto(photo: Photo, index: number) {
		error = "";
		busy = true;
		try {
			await remove(photo.id);
			status = `Removed photo ${index + 1}.`;
			onchange?.();
		} catch (e) {
			error = e instanceof PhotoError ? e.message : "The photo couldn't be removed.";
		} finally {
			busy = false;
		}
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (disabled || busy) return;
		const files = event.dataTransfer?.files;
		if (files) void addFiles(files);
	}
</script>

<div
	class="relative flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 {dragging
		? 'border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800'
		: 'border-zinc-300 dark:border-zinc-700'}"
	role="group"
	aria-label="Photos for {itemTitle}"
	aria-busy={busy}
	ondragover={(e) => {
		e.preventDefault();
		if (!disabled) dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
	data-testid="dropzone-{itemId}"
>
	{#each photos as photo, index (photo.id)}
		<div class="relative">
			<img
				src={photo.url}
				alt="Photo {index + 1} of {itemTitle}"
				class="h-14 w-14 rounded object-cover"
				loading="lazy"
			/>
			{#if photo.status === "review" || photo.status === "rejected"}
				<span class="absolute bottom-0 left-0 rounded bg-amber-200 px-1 text-xs text-amber-950">
					{photo.status === "review" ? "In review" : "Rejected"}
				</span>
			{/if}
			{#if !disabled}
				<button
					type="button"
					class="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-zinc-900 text-xs text-white dark:bg-zinc-100 dark:text-zinc-900"
					aria-label="Remove photo {index + 1} of {itemTitle}"
					disabled={busy}
					onclick={() => removePhoto(photo, index)}>×</button
				>
			{/if}
		</div>
	{/each}

	{#if !disabled && !full}
		<label
			for={inputId}
			class="flex h-14 cursor-pointer items-center rounded px-2 text-sm underline focus-within:outline-2"
		>
			{photos.length === 0 ? "Add photos" : "Add more"}
			<span class="sr-only">for {itemTitle}</span>
		</label>
		<input
			bind:this={input}
			id={inputId}
			type="file"
			accept="image/*"
			multiple
			class="sr-only"
			disabled={busy}
			onchange={(e) => {
				const files = e.currentTarget.files;
				if (files) void addFiles(files);
			}}
		/>
	{/if}
	<span class="text-xs text-zinc-600 dark:text-zinc-400">{photos.length}/{max}</span>
	<p class="sr-only" role="status" aria-live="polite">{status}</p>
	{#if error}
		<p class="w-full text-sm text-red-700 dark:text-red-400" role="alert">{error}</p>
	{/if}
</div>
