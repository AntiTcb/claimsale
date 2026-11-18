<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import LiveSaleGrid from "#lib/components/LiveSaleGrid.svelte";
	import ReportButton from "#lib/components/ReportButton.svelte";
	import SaleStatusBadge from "#lib/components/SaleStatusBadge.svelte";
	import TextField from "#lib/components/TextField.svelte";
	import { PAYMENT_METHODS } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const header = $derived(data.header);
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
	const methodName = (id: string) => PAYMENT_METHODS.find((m) => m.id === id)?.name ?? id;
</script>

<svelte:head>
	<title>{header.title} · ClaimSale</title>
	{#if !header.indexable}<meta name="robots" content="noindex, nofollow" />{/if}
	{#if data.share}
		<!-- WS-L2: the preview a link shows in Facebook and elsewhere (SHARE-private-title-only). -->
		<meta property="og:type" content="website" />
		<meta property="og:site_name" content="ClaimSale" />
		<meta property="og:title" content={data.share.title} />
		<meta property="og:description" content={data.share.description} />
		<meta property="og:url" content={data.share.url} />
		<meta property="og:image" content={data.share.image} />
		<meta property="og:image:width" content="1200" />
		<meta property="og:image:height" content="630" />
		<meta property="og:image:alt" content={`${data.share.title}: ${data.share.description}`} />
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="description" content={data.share.description} />
	{/if}
</svelte:head>

<section class="mx-auto max-w-6xl px-4 py-8">
	<header class="flex flex-col gap-2">
		<div class="flex flex-wrap items-center gap-3">
			<h1 class="text-2xl font-bold tracking-tight">{header.title}</h1>
			<SaleStatusBadge status={header.status} liveAt={data.body?.liveAt ?? null} />
			{#if data.timestampUrl}
				<span
					class="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900 dark:bg-violet-950 dark:text-violet-100"
					title="The seller photographed these cards with their handle and the date">Timestamped</span
				>
			{/if}
		</div>
		{#if data.timestampUrl}
			<a href={data.timestampUrl} class="self-start" target="_blank" rel="noopener">
				<img
					src={data.timestampUrl}
					alt="Timestamp: the seller's cards beside a note with their handle and the date"
					class="h-24 w-auto rounded-md object-cover"
				/>
			</a>
		{/if}
		<p class="text-zinc-600 dark:text-zinc-300">
			by {#if header.sellerHandle}<a href="/u/{header.sellerHandle}" class="underline"
					>{header.sellerDisplayName} (@{header.sellerHandle})</a
				>{:else}{header.sellerDisplayName}{/if}
			{#if !data.isSeller && !data.locked}· <a href="/s/{header.slug}/message" class="underline"
					>Message the seller</a
				>{/if}
		</p>
		{#if !data.isSeller}
			<div class="flex flex-wrap items-center gap-4">
				{#if data.signedIn}
					<form method="POST" action={data.following ? "?/unfollow" : "?/follow"} use:enhance>
						<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1 text-sm"
							>{data.following ? "Unfollow" : "Follow"}<span class="sr-only"
								>{` ${header.sellerDisplayName}`}</span
							></button
						>
					</form>
				{/if}
				{#if form && "following" in form}
					<p role="status" class="text-sm text-green-800 dark:text-green-300">
						{form.following
							? "Following. We'll tell you when they schedule or open a public sale."
							: "You unfollowed them."}
					</p>
				{:else if form && "followError" in form}
					<p role="alert" class="text-sm text-red-700 dark:text-red-400">{form.followError}</p>
				{/if}
				{#if !data.locked}
					<ReportButton
						kind="sale"
						what="this sale"
						signedIn={data.signedIn}
						next="/s/{header.slug}"
						result={form && ("reported" in form || "reportError" in form) ? form : null}
					/>
				{/if}
			</div>
		{/if}
		{#if data.isSeller && header.status === "draft"}
			<p role="note" class="rounded-md bg-amber-50 p-3 text-amber-950 dark:bg-amber-950 dark:text-amber-100">
				This is a draft. Only you can see it.
			</p>
		{/if}
	</header>

	{#if data.locked}
		<div class="mt-8 max-w-md">
			<h2 class="text-lg font-semibold">This sale is private</h2>
			{#if data.locked.hasPassword}
				<p class="mt-2">Enter the password the seller shared.</p>
				{#if form && "message" in form}<p role="alert" class="mt-3 text-red-700 dark:text-red-400">
						{form.message}
					</p>{/if}
				<form method="POST" action="?/unlock" class="mt-4 flex flex-col gap-3">
					<TextField label="Sale password" name="password" type="password" autocomplete="off" required />
					<button
						type="submit"
						class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
						>Unlock</button
					>
				</form>
			{/if}
			{#if data.locked.allowlistEnabled}
				<p class="mt-4">
					{#if data.locked.signedIn}
						Invited? The invite goes to a verified email; check <a href="/me/settings" class="underline"
							>your settings</a
						>.
					{:else}
						Invited? <a href="/login?next=/s/{header.slug}" class="underline">Sign in</a> with the email you were
						invited with.
					{/if}
				</p>
			{/if}
		</div>
	{:else if data.body}
		{#if header.status === "scheduled" && data.body.liveAt}
			<p class="mt-6 rounded-md bg-sky-50 p-3 text-sky-950 dark:bg-sky-950 dark:text-sky-100" role="status">
				Preview. Claims open {fmt(data.body.liveAt)}.
			</p>
		{:else if header.status === "live" && data.body.closesAt}
			<p class="mt-6" role="status">Live now. Closes {fmt(data.body.closesAt)}.</p>
		{:else if header.status === "closed"}
			<p class="mt-6" role="status">This sale has closed.</p>
		{/if}

		{#if data.body.descriptionMd}
			<p class="mt-4 whitespace-pre-line">{data.body.descriptionMd}</p>
		{/if}

		<details class="mt-4 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
			<summary class="cursor-pointer font-medium">Terms</summary>
			<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt class="font-medium">Payment</dt>
				<dd>{data.body.terms.paymentMethods.map(methodName).join(", ")}</dd>
				<dt class="font-medium">Pay within</dt>
				<dd>{data.body.terms.paymentDeadlineHours} hours of the invoice</dd>
				<dt class="font-medium">Ships to</dt>
				<dd>{data.body.terms.shipsTo || "Ask the seller"}</dd>
			</dl>
			{#if data.body.terms.rulesMd}<p class="mt-2 text-sm whitespace-pre-line">
					{data.body.terms.rulesMd}
				</p>{/if}
		</details>

		{#if data.saleId}
			{#key data.saleId}
				<LiveSaleGrid
					saleId={data.saleId}
					slug={header.slug}
					status={header.status}
					items={data.items}
					live={data.live}
					confirmClaims={data.body.terms.confirmClaims}
					signedIn={data.signedIn}
					isSeller={data.isSeller}
					refresh={invalidateAll}
				/>
			{/key}
		{/if}
	{/if}
</section>
