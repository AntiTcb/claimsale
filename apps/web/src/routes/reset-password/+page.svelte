<script lang="ts">
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Choose a new password · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Choose a new password</h1>
	{#if data.invalid}
		<p role="alert" class="mt-6">
			This link has expired or was already used. <a href="/forgot-password" class="underline"
				>Ask for a new one</a
			>.
		</p>
	{:else}
		{#if form?.message}
			<p role="alert" class="mt-6 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
				{form.message}
			</p>
		{/if}
		<form method="POST" class="mt-6 flex flex-col gap-4">
			<input type="hidden" name="token" value={data.token} />
			<TextField
				label="New password"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength={10}
				required
				hint="At least 10 characters. Signing in again is needed everywhere else."
			/>
			<button
				type="submit"
				class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
				>Save password</button
			>
		</form>
	{/if}
</section>
