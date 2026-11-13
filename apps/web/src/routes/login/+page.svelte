<script lang="ts">
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const failed = $derived(form && "message" in form ? form.message : undefined);
</script>

<svelte:head>
	<title>Sign in · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Sign in</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		New here? <a href="/signup" class="underline">Create an account</a>.
	</p>

	{#if failed}
		<p role="alert" class="mt-6 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
			{failed}
		</p>
	{/if}

	<form method="POST" action="?/password" class="mt-6 flex flex-col gap-4">
		<input type="hidden" name="next" value={data.next} />
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="email"
			required
			value={form?.action === "password" ? form.email : ""}
		/>
		<TextField label="Password" name="password" type="password" autocomplete="current-password" required />
		<button
			type="submit"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">Sign in</button
		>
		<a href="/forgot-password" class="text-sm underline">Forgot your password?</a>
	</form>

	<h2 class="mt-10 text-lg font-semibold">Or get a sign-in link by email</h2>
	{#if form?.action === "magic" && "sent" in form}
		<p
			role="status"
			class="mt-3 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			If {form.email} can sign in, a link is on its way. It works once, for 5 minutes.
		</p>
	{:else}
		<form method="POST" action="?/magic" class="mt-3 flex flex-col gap-4">
			<input type="hidden" name="next" value={data.next} />
			<TextField
				label="Email for the link"
				name="email"
				id="magic-email"
				type="email"
				autocomplete="email"
				required
			/>
			<button type="submit" class="rounded-md border border-zinc-400 px-4 py-2">Email me a link</button>
		</form>
	{/if}

	{#if data.discord}
		<form method="POST" action="?/discord" class="mt-10">
			<input type="hidden" name="next" value={data.next} />
			<button type="submit" class="w-full rounded-md bg-[#5865F2] px-4 py-2 text-white"
				>Continue with Discord</button
			>
		</form>
	{/if}
</section>
