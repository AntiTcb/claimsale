<script lang="ts">
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { form }: PageProps = $props();
	let age = $state<string>("");
	$effect.pre(() => {
		if (form?.values.age) age = form.values.age;
	});
</script>

<svelte:head>
	<title>Create an account · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Create your account</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		Already have one? <a href="/login" class="underline">Sign in</a>.
	</p>

	{#if form?.errors.form}
		<p role="alert" class="mt-6 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
			{form.errors.form}
		</p>
	{/if}

	<form method="POST" class="mt-6 flex flex-col gap-4" novalidate>
		<TextField
			label="Display name"
			name="displayName"
			autocomplete="name"
			maxlength={50}
			required
			value={form?.values.displayName}
			error={form?.errors.displayName}
		/>
		<TextField
			label="Handle"
			name="handle"
			autocomplete="username"
			maxlength={20}
			required
			value={form?.values.handle}
			error={form?.errors.handle}
			hint="Your public name in sales, like @card_shark. Letters, numbers and underscores."
		/>
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="email"
			required
			value={form?.values.email}
			error={form?.errors.email}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="new-password"
			minlength={10}
			required
			error={form?.errors.password}
			hint="At least 10 characters."
		/>

		<fieldset class="flex flex-col gap-2" aria-describedby={form?.errors.age ? "age-error" : undefined}>
			<legend class="text-sm font-medium">How old are you?</legend>
			<label class="flex items-center gap-2"
				><input type="radio" name="age" value="18+" bind:group={age} /> 18 or older</label
			>
			<label class="flex items-center gap-2"
				><input type="radio" name="age" value="13-17" bind:group={age} /> 13 to 17</label
			>
			<label class="flex items-center gap-2"
				><input type="radio" name="age" value="under-13" bind:group={age} /> Under 13</label
			>
			{#if age === "13-17"}
				<label class="ml-6 flex items-start gap-2 text-sm">
					<input type="checkbox" name="parentalConsent" class="mt-1" />
					A parent or guardian knows I'm joining and said it's OK. (You can buy at 13+; selling needs 18+.)
				</label>
			{/if}
			{#if form?.errors.age}
				<p id="age-error" class="text-sm text-red-700 dark:text-red-400">{form.errors.age}</p>
			{/if}
		</fieldset>

		<button
			type="submit"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
		>
			Create account
		</button>
	</form>
</section>
