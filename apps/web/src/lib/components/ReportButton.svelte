<script lang="ts">
	import { enhance } from "$app/forms";
	import { REPORT_REASON_LABELS, type ReportReason } from "#lib/report-reasons.ts";

	/**
	 * "Report" for a sale or a user (ADMIN-report-queue). It posts to the page's `?/report`
	 * action, which works out the target on the server (user IDs never reach the page) and
	 * files it with WS-I's `fileReport`. Signed-out visitors get a sign-in link instead.
	 */
	interface Props {
		kind: "sale" | "user";
		/** What the screen reader hears after "Report", e.g. "this sale". */
		what: string;
		signedIn: boolean;
		/** Where sign-in returns to. */
		next: string;
		/** The page's form result for the report action, if any. */
		result?: { reported?: boolean; reportError?: string } | null;
	}

	let { kind, what, signedIn, next, result = null }: Props = $props();

	const REASONS: Record<Props["kind"], ReportReason[]> = {
		sale: ["counterfeit", "stolen_photo", "prohibited_item", "scam", "other"],
		user: ["scam", "harassment", "spam", "off_platform_payment", "counterfeit", "other"],
	};
	const field = "rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
</script>

{#if !signedIn}
	<a href="/login?next={encodeURIComponent(next)}" class="text-sm underline"
		>Report<span class="sr-only">{` ${what}`}</span></a
	>
{:else}
	<!-- Stays open once there's a result, so the thanks or the error is seen. -->
	<details class="text-sm" open={result !== null}>
		<summary class="cursor-pointer underline">Report<span class="sr-only">{` ${what}`}</span></summary>
		{#if result?.reported}
			<p role="status" class="mt-2 text-green-800 dark:text-green-300">Thanks. An admin will look at it.</p>
		{:else}
			<form method="POST" action="?/report" use:enhance class="mt-2 flex max-w-sm flex-col gap-2">
				<label class="flex flex-col gap-1"
					>Reason
					<select name="reason" required class={field}>
						<option value="" disabled selected>Pick one</option>
						{#each REASONS[kind] as r (r)}<option value={r}>{REPORT_REASON_LABELS[r]}</option>{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1"
					>Details (optional)
					<textarea name="details" maxlength="2000" rows="3" class={field}></textarea>
				</label>
				{#if result?.reportError}<p role="alert" class="text-red-700 dark:text-red-400">
						{result.reportError}
					</p>{/if}
				<button
					type="submit"
					class="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900"
					>Send report</button
				>
			</form>
		{/if}
	</details>
{/if}
