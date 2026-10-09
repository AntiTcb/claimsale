<script lang="ts">
	interface Props {
		year?: number;
	}

	let { year = new Date().getFullYear() }: Props = $props();
</script>

<footer
	class="border-t border-zinc-200 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
>
	<p>{`© ${year} ClaimSale`}</p>
	<p>
		ClaimSale is not affiliated with, endorsed by, or sponsored by Konami, The Pokémon Company, Wizards of the
		Coast, Riot Games, or any other trading card game publisher.
	</p>
</footer>
