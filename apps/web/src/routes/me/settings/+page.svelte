<script lang="ts">
	import { page } from "$app/state";
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const values = $derived(form?.action === "profile" && "values" in form ? form.values : data.profile);
	const errors = $derived<Record<string, string>>(
		form?.action === "profile" && "errors" in form ? form.errors : {},
	);
</script>

<svelte:head>
	<title>Settings · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Settings</h1>

	<h2 class="mt-8 text-lg font-semibold">Email</h2>
	<p class="mt-2">{data.profile.email}</p>
	{#if page.url.searchParams.get("verified") === "1" || data.profile.emailVerified}
		<p class="mt-1 text-sm text-green-800 dark:text-green-300">Verified.</p>
	{:else}
		<p class="mt-1 text-sm text-amber-900 dark:text-amber-200">
			Not verified yet: you need a verified email to claim items.
		</p>
		{#if form?.action === "verify" && "sent" in form}
			<p role="status" class="mt-2 text-sm">We sent a new link to {data.profile.email}.</p>
		{:else}
			{#if form?.action === "verify" && "message" in form}
				<p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-400">{form.message}</p>
			{/if}
			<form method="POST" action="?/verify" class="mt-2">
				<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1.5 text-sm"
					>Send a new verification link</button
				>
			</form>
		{/if}
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Profile</h2>
	{#if form?.action === "profile" && "saved" in form}
		<p
			role="status"
			class="mt-2 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			Saved.
		</p>
	{/if}
	<form method="POST" action="?/profile" class="mt-4 flex flex-col gap-4" novalidate>
		<TextField
			label="Display name"
			name="displayName"
			autocomplete="name"
			maxlength={50}
			required
			value={values.displayName}
			error={errors.displayName}
		/>
		<TextField
			label="Handle"
			name="handle"
			autocomplete="username"
			maxlength={20}
			required
			value={values.handle}
			error={errors.handle}
		/>
		<TextField
			label="Facebook profile (optional)"
			name="fbProfileUrl"
			type="url"
			value={values.fbProfileUrl}
			error={errors.fbProfileUrl}
			hint="Shown on your profile so sellers can check who you are. We can't verify it for them."
		/>
		<button
			type="submit"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Save profile</button
		>
	</form>
</section>
