<script lang="ts">
	import TextField from "./TextField.svelte";

	interface Props {
		/** The verified number, masked; null when none. */
		verified: string | null;
		/** The number a code was just sent to, masked; null when none. */
		pending: string | null;
		/** False when this environment can't send codes (e.g. Twilio isn't configured). */
		available: boolean;
		/** Where the forms post; the settings page's named actions by default. */
		actions?: { start: string; check: string; cancel: string };
		phoneValue?: string;
		errors?: { phone?: string; code?: string; form?: string };
		/** A status line after an action, e.g. "Verified." */
		status?: string | undefined;
	}

	let {
		verified,
		pending,
		available,
		actions = { start: "?/phoneStart", check: "?/phoneCheck", cancel: "?/phoneCancel" },
		phoneValue = "",
		errors = {},
		status,
	}: Props = $props();

	const button = "rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900";
</script>

<div class="flex flex-col gap-3">
	{#if verified}
		<p>Verified: <span class="font-mono">{verified}</span></p>
	{:else}
		<p class="text-sm text-amber-900 dark:text-amber-200">
			No verified number yet: sellers need a verified mobile number. It's never shown to anyone.
		</p>
	{/if}

	{#if status}
		<p role="status" class="rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200">
			{status}
		</p>
	{/if}
	{#if errors.form}
		<p role="alert" class="rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
			{errors.form}
		</p>
	{/if}

	{#if !available}
		<p class="text-sm">Phone verification isn't available right now. Try again later.</p>
	{:else if pending}
		<form method="POST" action={actions.check} class="flex flex-col gap-3" novalidate>
			<p>We texted a 6-digit code to <span class="font-mono">{pending}</span>.</p>
			<TextField
				label="Code"
				name="code"
				autocomplete="one-time-code"
				maxlength={7}
				required
				error={errors.code}
			/>
			<button type="submit" class={button}>Verify</button>
		</form>
		<form method="POST" action={actions.cancel}>
			<button type="submit" class="text-sm underline">Use a different number</button>
		</form>
	{:else}
		<form method="POST" action={actions.start} class="flex flex-col gap-3" novalidate>
			<TextField
				label={verified ? "New mobile number" : "Mobile number"}
				name="phone"
				type="tel"
				autocomplete="tel"
				maxlength={24}
				required
				value={phoneValue}
				error={errors.phone}
				hint="With your country code if you're outside the US or Canada, like +44 7700 900123."
			/>
			<button type="submit" class={button}>Text me a code</button>
		</form>
	{/if}
</div>
