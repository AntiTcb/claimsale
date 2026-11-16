<script lang="ts" module>
	/** The slice of Cloudflare's Turnstile API this component uses (explicit rendering). */
	export interface TurnstileApi {
		render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
		remove(widgetId: string): void;
	}

	declare global {
		interface Window {
			turnstile?: TurnstileApi;
		}
	}

	const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
	let loading: Promise<TurnstileApi> | undefined;

	/** Loads Cloudflare's script once per page, or uses one that is already there. */
	function loadTurnstile(): Promise<TurnstileApi> {
		if (window.turnstile) return Promise.resolve(window.turnstile);
		loading ??= new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = SCRIPT;
			script.async = true;
			script.addEventListener("load", () =>
				window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")),
			);
			script.addEventListener("error", () => {
				loading = undefined;
				reject(new Error("turnstile failed to load"));
			});
			document.head.appendChild(script);
		});
		return loading;
	}
</script>

<script lang="ts">
	interface Props {
		siteKey: string;
		/** Shown in Turnstile analytics, e.g. "signup". */
		action?: string;
	}

	let { siteKey, action }: Props = $props();
	let container: HTMLDivElement;
	let failed = $state(false);

	// The widget adds a hidden `cf-turnstile-response` input inside the container, so the
	// surrounding form posts the token with no extra code.
	$effect(() => {
		let widgetId: string | undefined;
		let api: TurnstileApi | undefined;
		let cancelled = false;
		failed = false;
		const mount = async () => {
			try {
				const loaded = await loadTurnstile();
				if (cancelled) return;
				api = loaded;
				widgetId = loaded.render(container, {
					sitekey: siteKey,
					action,
					theme: "auto",
					"response-field-name": "cf-turnstile-response",
				});
			} catch {
				if (!cancelled) failed = true;
			}
		};
		void mount();
		return () => {
			cancelled = true;
			if (api && widgetId !== undefined) api.remove(widgetId);
		};
	});
</script>

<div class="flex flex-col gap-1">
	<div bind:this={container} data-testid="turnstile"></div>
	{#if failed}
		<p role="alert" class="text-sm text-red-700 dark:text-red-400">
			The check that you're a person didn't load. Turn off blockers for challenges.cloudflare.com and reload.
		</p>
	{/if}
	<noscript>
		<p class="text-sm text-amber-900 dark:text-amber-200">
			Creating an account needs JavaScript for a quick check that you're a person.
		</p>
	</noscript>
</div>
