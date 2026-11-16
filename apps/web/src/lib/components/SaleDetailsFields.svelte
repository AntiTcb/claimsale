<script lang="ts">
	import TextField from "./TextField.svelte";

	/** The sale details fields shared by /sell/new and the sale overview (D5, D31). */
	interface Props {
		values: { title: string; description: string; visibility: string; allowlist: string };
		errors?: Partial<Record<string, string>>;
		/** Private sales are Pro only (D31); free sellers see why it's unavailable. */
		canUsePrivate: boolean;
		/** The sale already has a password; leaving the field blank keeps it. */
		hasPassword?: boolean;
	}

	let { values, errors = {}, canUsePrivate, hasPassword = false }: Props = $props();

	// svelte-ignore state_referenced_locally
	let visibility = $state(values.visibility || "unlisted");

	const OPTIONS = [
		{
			value: "unlisted",
			label: "Unlisted",
			hint: "Anyone with the link can view it. Not in search. Most sellers pick this.",
		},
		{ value: "public", label: "Public", hint: "Listed in browse and search, and indexed." },
		{ value: "private", label: "Private", hint: "Only people with the password or on your invite list." },
	] as const;
</script>

<TextField label="Title" name="title" required maxlength={120} value={values.title} error={errors["title"]} />

<div class="flex flex-col gap-1">
	<label for="field-description" class="text-sm font-medium">Description (optional)</label>
	<textarea
		id="field-description"
		name="description"
		rows="4"
		maxlength="5000"
		aria-invalid={errors["description"] ? "true" : undefined}
		aria-describedby={errors["description"] ? "field-description-error" : undefined}
		class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
		>{values.description}</textarea
	>
	{#if errors["description"]}
		<p id="field-description-error" class="text-sm text-red-700 dark:text-red-400">{errors["description"]}</p>
	{/if}
</div>

<fieldset
	class="flex flex-col gap-2"
	aria-describedby={errors["visibility"] ? "visibility-error" : undefined}
>
	<legend class="text-sm font-medium">Who can see it</legend>
	{#each OPTIONS as option (option.value)}
		{@const locked = option.value === "private" && !canUsePrivate}
		<label class="flex items-start gap-2">
			<input
				type="radio"
				name="visibility"
				value={option.value}
				bind:group={visibility}
				disabled={locked}
				class="mt-1"
			/>
			<span>
				<span class="font-medium">{option.label}</span>{#if locked}<span class="text-sm"> · Pro</span>{/if}
				<span class="block text-sm text-zinc-600 dark:text-zinc-400">{option.hint}</span>
			</span>
		</label>
	{/each}
	{#if errors["visibility"]}
		<p id="visibility-error" class="text-sm text-red-700 dark:text-red-400">{errors["visibility"]}</p>
	{/if}
</fieldset>

{#if visibility === "private"}
	<div class="flex flex-col gap-4 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
		<TextField
			label="Sale password"
			name="password"
			type="password"
			autocomplete="new-password"
			maxlength={100}
			error={errors["password"]}
			hint={hasPassword
				? "Leave blank to keep the current password. Changing it locks everyone out again."
				: "Share it with your buyers. Optional if you use the invite list."}
		/>
		<div class="flex flex-col gap-1">
			<label for="field-allowlist" class="text-sm font-medium">Invite list (optional)</label>
			<textarea
				id="field-allowlist"
				name="allowlist"
				rows="3"
				aria-describedby="field-allowlist-hint{errors['allowlist'] ? ' field-allowlist-error' : ''}"
				aria-invalid={errors["allowlist"] ? "true" : undefined}
				class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
				>{values.allowlist}</textarea
			>
			<p id="field-allowlist-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
				One email per line. Invitees sign in with that verified email to view the sale.
			</p>
			{#if errors["allowlist"]}
				<p id="field-allowlist-error" class="text-sm text-red-700 dark:text-red-400">{errors["allowlist"]}</p>
			{/if}
		</div>
	</div>
{/if}
