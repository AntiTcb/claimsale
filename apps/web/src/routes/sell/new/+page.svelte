<script lang="ts">
	import SaleDetailsFields from "#lib/components/SaleDetailsFields.svelte";
	import WizardSteps from "#lib/components/WizardSteps.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const values = $derived(
		form?.values ?? { title: "", description: "", visibility: "unlisted", allowlist: "" },
	);
</script>

<svelte:head>
	<title>New sale · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<WizardSteps current={1} />
	<h1 class="mt-4 text-2xl font-bold tracking-tight">New sale</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		It stays a draft, visible only to you, until you schedule it.
	</p>
	<form method="POST" class="mt-6 flex flex-col gap-5" novalidate>
		<SaleDetailsFields {values} errors={form?.errors ?? {}} canUsePrivate={data.canUsePrivate} />
		<button
			type="submit"
			class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Continue to terms</button
		>
	</form>
</section>
