<script lang="ts">
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Reset your password · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Reset your password</h1>
	{#if form && "sent" in form}
		<p
			role="status"
			class="mt-6 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			If {form.email} has an account, we've sent a link to choose a new password.
		</p>
	{:else}
		{#if form && "message" in form}
			<p role="alert" class="mt-6 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
				{form.message}
			</p>
		{/if}
		<form method="POST" class="mt-6 flex flex-col gap-4">
			<TextField label="Email" name="email" type="email" autocomplete="email" required value={form?.email} />
			<button
				type="submit"
				class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
				>Send the link</button
			>
		</form>
	{/if}
</section>
