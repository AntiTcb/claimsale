<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";

	interface Props {
		label: string;
		name: string;
		/** Defaults to `field-<name>`; set it when one page has two fields with the same name. */
		id?: string | undefined;
		type?: "text" | "email" | "password" | "url";
		value?: string | null | undefined;
		error?: string | undefined;
		hint?: string | undefined;
		required?: boolean;
		autocomplete?: HTMLInputAttributes["autocomplete"];
		minlength?: number;
		maxlength?: number;
	}

	let {
		label,
		name,
		id: idProp,
		type = "text",
		value = "",
		error,
		hint,
		required = false,
		autocomplete,
		minlength,
		maxlength,
	}: Props = $props();

	// `defaultValue`, not `value`: hydration must not wipe text typed before the page's
	// JavaScript loaded (regression: e2e/hydration.spec.ts).
	const id = $derived(idProp ?? `field-${name}`);
	const describedBy = $derived(
		[error ? `${id}-error` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" "),
	);
</script>

<div class="flex flex-col gap-1">
	<label for={id} class="text-sm font-medium">{label}</label>
	<input
		{id}
		{name}
		{type}
		{required}
		{autocomplete}
		{minlength}
		{maxlength}
		defaultValue={value ?? ""}
		aria-invalid={error ? "true" : undefined}
		aria-describedby={describedBy || undefined}
		class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900 aria-[invalid=true]:border-red-600"
	/>
	{#if hint}
		<p id="{id}-hint" class="text-sm text-zinc-600 dark:text-zinc-400">{hint}</p>
	{/if}
	{#if error}
		<p id="{id}-error" class="text-sm text-red-700 dark:text-red-400">{error}</p>
	{/if}
</div>
