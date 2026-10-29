/**
 * `pnpm dev`: both Workers in one wrangler process (TECH_STACK S34), rebuilt and
 * restarted when web, engine or package sources change. Cross-platform: no shell
 * operators, and wrangler is stopped before each build (see dev-loop.ts).
 *
 * Usage: node scripts/dev.ts   (from apps/web)
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createDevLoop } from "./dev-loop.ts";

const web = resolve(import.meta.dirname, "..");
const repo = resolve(web, "../..");
const engine = join(repo, "apps/engine");
const persist = join(repo, ".wrangler/dev");
const require = createRequire(join(web, "package.json"));

/** Path to a package's bin script, so it runs on this Node without a shell shim. */
function bin(pkg: string, name: string): string {
	const manifest = require.resolve(`${pkg}/package.json`);
	const bins = (JSON.parse(readFileSync(manifest, "utf8")) as { bin: Record<string, string> }).bin;
	return join(dirname(manifest), bins[name] ?? "");
}

const vite = bin("vite", "vite");
const wrangler = bin("wrangler", "wrangler");

function run(args: readonly string[], cwd: string): Promise<boolean> {
	return new Promise((done) => {
		spawn(process.execPath, args, { cwd, stdio: ["ignore", "inherit", "inherit"] })
			.once("error", () => done(false))
			.once("exit", (code) => done(code === 0));
	});
}

let server: ChildProcess | undefined;

function stop(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	if (process.platform === "win32") {
		// Killing wrangler alone would orphan workerd, which keeps the port.
		spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
	} else {
		child.kill("SIGINT");
	}
	return exited;
}

const loop = createDevLoop({
	build: () => run([vite, "build"], web),
	start() {
		server = spawn(
			process.execPath,
			[
				wrangler,
				"dev",
				"-c",
				"wrangler.jsonc",
				"-c",
				"../engine/wrangler.jsonc",
				"--port",
				"8787",
				"--persist-to",
				persist,
			],
			{ cwd: web, stdio: ["ignore", "inherit", "inherit"] },
		);
	},
	stop: () => stop(server),
});

const migrated = await run(
	[wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
	engine,
);
if (!migrated) {
	console.error("Applying local D1 migrations failed.");
	process.exit(1);
}

await loop.start();

const packages = join(repo, "packages");
const sources = [join(web, "src"), join(engine, "src")].concat(
	readdirSync(packages).map((name) => join(packages, name, "src")),
);
for (const dir of sources.filter((d) => existsSync(d))) {
	watch(dir, { recursive: true }, () => loop.changed());
}

let closing = false;
function shutdown(): void {
	if (closing) return;
	closing = true;
	void loop.close().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
