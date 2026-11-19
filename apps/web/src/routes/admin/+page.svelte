<script lang="ts">
	import { enhance } from "$app/forms";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<svelte:head>
	<title>Admin · ClaimSale</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Admin</h1>
	<p class="mt-2 text-sm"><a href="/admin/reports" class="underline">Reports</a></p>
	{#if form?.message}
		<p role="status" class="mt-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">{form.message}</p>
	{/if}

	<h2 class="mt-8 text-lg font-semibold">Photos held for review ({data.photos.length})</h2>
	<p class="text-sm text-zinc-600 dark:text-zinc-400">
		Each photo is close to another seller's image. Approve it if they are different photos (for example two
		copies of the same graded card); reject it if it's a copy. The seller never sees the other image.
	</p>
	{#if data.photos.length === 0}
		<p class="mt-3">Nothing to review.</p>
	{:else}
		<ul class="mt-4 flex flex-col gap-4">
			{#each data.photos as photo (photo.imageId)}
				<li
					class="flex flex-wrap items-start gap-4 rounded-md border border-zinc-300 p-3 dark:border-zinc-700"
					data-testid="held-photo"
				>
					<figure>
						<img
							src="/api/images/{photo.imageId}"
							alt="Held upload for {photo.itemTitle ?? 'the timestamp'}"
							class="h-40 w-40 rounded object-cover"
						/>
						<figcaption class="text-xs">Uploaded</figcaption>
					</figure>
					{#if photo.matchImageId}
						<figure>
							<img
								src="/api/images/{photo.matchImageId}"
								alt="Closest match"
								class="h-40 w-40 rounded object-cover"
							/>
							<figcaption class="text-xs">Closest match · distance {photo.matchDistance}</figcaption>
						</figure>
					{/if}
					<div class="flex flex-col gap-2 text-sm">
						<p>
							<strong>{photo.itemTitle ?? "Timestamp photo"}</strong> in “{photo.saleTitle}” by
							{photo.sellerHandle ? `@${photo.sellerHandle}` : "a seller without a handle"}
						</p>
						<p class="text-zinc-600 dark:text-zinc-400">{fmt(photo.createdAt)}</p>
						<div class="flex gap-2">
							<form method="POST" action="?/approve" use:enhance>
								<input type="hidden" name="imageId" value={photo.imageId} />
								<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1"
									>Approve<span class="sr-only"> photo for {photo.itemTitle ?? "the timestamp"}</span></button
								>
							</form>
							<form method="POST" action="?/reject" use:enhance>
								<input type="hidden" name="imageId" value={photo.imageId} />
								<button type="submit" class="rounded-md bg-red-700 px-3 py-1 text-white"
									>Reject<span class="sr-only"> photo for {photo.itemTitle ?? "the timestamp"}</span></button
								>
							</form>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Flagged accounts ({data.flags.length})</h2>
	<p class="text-sm text-zinc-600 dark:text-zinc-400">
		Accounts with several photos rejected as other sellers' images.
	</p>
	{#if data.flags.length === 0}
		<p class="mt-3">No flagged accounts.</p>
	{:else}
		<ul class="mt-4 flex flex-col gap-2">
			{#each data.flags as flag (flag.flagId)}
				<li class="flex flex-wrap items-center gap-3" data-testid="flagged-account">
					<span>
						{flag.handle ? `@${flag.handle}` : flag.displayName}: {flag.rejectedTotal} rejected photo{flag.rejectedTotal ===
						1
							? ""
							: "s"}, flagged {fmt(flag.createdAt)}
					</span>
					<form method="POST" action="?/resolveFlag" use:enhance>
						<input type="hidden" name="flagId" value={flag.flagId} />
						<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1 text-sm"
							>Mark reviewed<span class="sr-only"> for {flag.handle ?? flag.displayName}</span></button
						>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="mt-10" aria-labelledby="restore-heading">
	<h2 id="restore-heading" class="text-lg font-semibold">After a database restore</h2>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
		Each open sale keeps its own copy of its claims. After restoring D1, reload those copies from the restored
		database. Pause live sales first.
	</p>
	<form method="POST" action="?/rehydrateSales" use:enhance class="mt-3">
		<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1 text-sm"
			>Reload open sales from D1</button
		>
	</form>
</section>
