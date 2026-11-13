<script lang="ts">
	let { data } = $props();

	let running = $state(false);
	let status = $state<number | undefined>();
	let result = $state<string | undefined>();

	async function run(fail: boolean) {
		running = true;
		try {
			const res = await fetch("/api/debug/trace-probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ fail }),
			});
			status = res.status;
			result = JSON.stringify(await res.json(), null, 2);
		} catch (err) {
			status = undefined;
			result = String(err);
		} finally {
			running = false;
		}
	}
</script>

<svelte:head>
	<title>Trace probe · ClaimSale</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="mx-auto max-w-2xl px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Trace probe</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		Sends one request through web → engine → Durable Object → D1 → queue → consumer → email, then shows the
		trace ID to look up in Sentry. Environment: <strong>{data.appEnv}</strong>, version
		<code>{data.version}</code>.
	</p>
	<div class="mt-6 flex flex-wrap gap-3">
		<button
			type="button"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
			disabled={running}
			onclick={() => run(false)}
		>
			Run probe
		</button>
		<button
			type="button"
			class="rounded-md border border-zinc-400 px-4 py-2 disabled:opacity-60"
			disabled={running}
			onclick={() => run(true)}
		>
			Run probe with a deliberate error
		</button>
	</div>
	{#if result !== undefined}
		<h2 class="mt-8 text-lg font-semibold">
			Result{status === undefined ? "" : ` (HTTP ${status})`}
		</h2>
		<pre
			class="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-4 text-sm dark:bg-zinc-900"
			data-testid="probe-result">{result}</pre>
	{/if}
</section>
