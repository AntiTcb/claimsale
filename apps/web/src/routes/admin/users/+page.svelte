<script lang="ts">
	import { enhance } from "$app/forms";
	import { describeRecord } from "#lib/control-room.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
	const input = "rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
	const button = "rounded-md border border-zinc-400 px-3 py-1";
	const PLANS = [
		{ id: "seller_pro", label: "Seller Pro" },
		{ id: "buyer_pro", label: "Buyer Pro" },
		{ id: "bundle", label: "Seller and buyer Pro" },
	];
	const who = (u: { handle: string | null; displayName: string }) =>
		u.handle ? `@${u.handle}` : u.displayName;
</script>

<svelte:head>
	<title>Users · Admin · ClaimSale</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Users</h1>
	{#if form?.message}
		<p role="status" class="mt-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">{form.message}</p>
	{/if}

	{#if data.windowRequests.length > 0}
		<section class="mt-4" aria-labelledby="window-requests">
			<h2 id="window-requests" class="font-semibold">Decision window requests</h2>
			<ul class="mt-2 flex flex-col gap-2 text-sm">
				{#each data.windowRequests as request (request.userId)}
					<li class="flex flex-wrap items-center gap-2">
						<a href="/admin/users?id={request.userId}" class="underline">{who(request)}</a>
						asks for {request.hours} hours (now {request.capHours}) on {fmt(request.requestedAt)}: {request.reason}
						<form method="POST" action="?/approveWindow" use:enhance>
							<input type="hidden" name="userId" value={request.userId} />
							<button type="submit" class={button}>Approve <span class="sr-only">{who(request)}</span></button
							>
						</form>
						<form method="POST" action="?/declineWindow" use:enhance>
							<input type="hidden" name="userId" value={request.userId} />
							<button type="submit" class={button}>Decline <span class="sr-only">{who(request)}</span></button
							>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<form method="GET" class="mt-4 flex items-end gap-2">
		<label class="flex flex-col text-sm"
			>Handle or exact email <input name="q" value={data.q} class="w-64 {input}" /></label
		>
		<button type="submit" class={button}>Search</button>
	</form>
	{#if data.q && data.results.length === 0}
		<p class="mt-3">No accounts match.</p>
	{:else if data.results.length > 0}
		<ul class="mt-3 flex flex-col gap-1 text-sm">
			{#each data.results as user (user.id)}
				<li>
					<a href="/admin/users?id={user.id}" class="underline">{who(user)}</a>
					<span class="text-zinc-600 dark:text-zinc-400">
						· {user.displayName} · joined {fmt(user.createdAt)}</span
					>{#if user.bannedAt}<span class="text-red-700 dark:text-red-400"> · banned</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.detail}
		{@const d = data.detail}
		<article
			class="mt-8 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
			data-testid="user-detail"
		>
			<h2 class="text-lg font-semibold">{who(d.user)}</h2>
			<p class="text-sm">
				{d.user.displayName} · {d.user.email} · joined {fmt(d.user.createdAt)}{d.user.role === "admin"
					? " · admin"
					: ""}
			</p>
			{#if d.record}<p class="mt-1 text-sm">As a buyer: {describeRecord(d.record.record)}</p>{/if}
			<p class="text-sm">
				As a seller: {d.sellerCancels} seller-fault cancel{d.sellerCancels === 1 ? "" : "s"}
			</p>

			<h3 class="mt-4 font-semibold">Ban</h3>
			{#if d.user.bannedAt}
				<p class="text-sm text-red-700 dark:text-red-400">
					Banned since {fmt(d.user.bannedAt)}: {d.user.bannedReason}
				</p>
				<form method="POST" action="?/unban" use:enhance class="mt-2">
					<input type="hidden" name="userId" value={d.user.id} />
					<button type="submit" class={button}>Unban</button>
				</form>
			{:else if d.user.role !== "admin"}
				<form method="POST" action="?/ban" use:enhance class="mt-2 flex flex-wrap items-end gap-2">
					<input type="hidden" name="userId" value={d.user.id} />
					<label class="flex flex-col text-sm"
						>Reason (kept for admins) <input
							name="reason"
							required
							minlength="3"
							maxlength="500"
							class="w-80 {input}"
						/></label
					>
					<button type="submit" class="rounded-md bg-red-700 px-3 py-1 text-white">Ban account</button>
				</form>
			{/if}

			<h3 class="mt-4 font-semibold">Pro</h3>
			{#if d.grants.length === 0}
				<p class="text-sm">No subscriptions.</p>
			{:else}
				<ul class="text-sm">
					{#each d.grants as grant (grant.planId)}
						<li class="flex flex-wrap items-center gap-2">
							{grant.planName} · {grant.status}{grant.currentPeriodEnd
								? ` until ${fmt(grant.currentPeriodEnd)}`
								: ""}
							{#if grant.status === "granted"}
								<form method="POST" action="?/revoke" use:enhance>
									<input type="hidden" name="userId" value={d.user.id} />
									<input type="hidden" name="planId" value={grant.planId} />
									<button type="submit" class={button}
										>Revoke <span class="sr-only">{grant.planName}</span></button
									>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			<form method="POST" action="?/grant" use:enhance class="mt-2 flex flex-wrap items-end gap-2">
				<input type="hidden" name="userId" value={d.user.id} />
				<label class="flex flex-col text-sm"
					>Plan
					<select name="planId" class={input}>
						{#each PLANS as plan (plan.id)}<option value={plan.id}>{plan.label}</option>{/each}
					</select>
				</label>
				<label class="flex flex-col text-sm"
					>Days (empty: no end) <input name="days" inputmode="numeric" class="w-28 {input}" /></label
				>
				<button type="submit" class={button}>Grant Pro</button>
			</form>

			{#if data.window}
				<h3 class="mt-4 font-semibold">Decision window</h3>
				<p class="text-sm">
					Cap: {data.window.capHours} hours{data.window.approvedHours === null
						? " (default)"
						: " (approved)"}{data.window.request
						? ` · asked for ${data.window.request.hours} hours: ${data.window.request.reason}`
						: ""}
				</p>
				{#if data.window.approvedHours !== null}
					<form method="POST" action="?/resetWindow" use:enhance class="mt-2">
						<input type="hidden" name="userId" value={d.user.id} />
						<button type="submit" class={button}>Reset to 7 days</button>
					</form>
				{/if}
			{/if}
		</article>
	{/if}
</section>
