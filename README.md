# ClaimSale

Claim sales for trading card games (Yu-Gi-Oh, Pokémon, Magic: The Gathering, Riftbound
and more) without the comment-thread chaos. Built with SvelteKit 3 and Effect 4 on
Cloudflare Workers, D1, Durable Objects and Queues.

- Product plan: [docs/PLAN.md](docs/PLAN.md)
- Behavior spec: [docs/STATE_MACHINES.md](docs/STATE_MACHINES.md)
- Tech stack: [docs/TECH_STACK.md](docs/TECH_STACK.md)
- Testing: [docs/TESTING.md](docs/TESTING.md)
- Contributor and agent guide: [CLAUDE.md](CLAUDE.md)

## Quick start

```sh
pnpm install      # Windows on ARM: pnpm install --cpu=x64 (see CLAUDE.md)
pnpm dev          # http://localhost:8787, health at /api/health
pnpm check && pnpm test && pnpm test:workers && pnpm test:e2e
```

## One-time setup

Run the guided wizard from the repository root on your own machine (it uses `gh` and the
Cloudflare CLI `cf` as you):

```sh
scripts/setup.sh
```

It sets the default branch and protections, GitHub environments, the Cloudflare API token
and Access service token (as GitHub secrets), queues, the `workers.dev` variables, Renovate,
and runs the first staging deploy. Details: [docs/TECH_STACK.md §11](docs/TECH_STACK.md#11-milestone-0-setup-checklist).
