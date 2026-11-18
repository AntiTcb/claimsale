import type { LiveItem, LiveMessage, LiveSnapshot, MyEntry } from "@claimsale/core";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import EntryDialog from "./EntryDialog.svelte";
import LiveItemCard from "./LiveItemCard.svelte";
import LiveSaleGrid from "./LiveSaleGrid.svelte";

/** A stand-in for the browser's WebSocket: the test plays the engine. */
class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 0;
	readonly sent: string[] = [];

	constructor(readonly url: string) {
		super();
		FakeSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		});
	}

	send(text: string) {
		this.sent.push(text);
	}

	close(code = 1000) {
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent("close", { code }));
	}

	emit(message: LiveMessage) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
	}
}

const live = (overrides: Partial<LiveItem> = {}): LiveItem => ({
	id: "i1",
	version: 1,
	state: "available",
	quantity: 1,
	freeUnits: 1,
	unitsWon: 0,
	claimCount: 0,
	offerCount: 0,
	decisionDeadline: null,
	offers: [],
	mine: [],
	...overrides,
});

const mine = (overrides: Partial<MyEntry> = {}): MyEntry => ({
	id: "e1",
	kind: "claim",
	status: "won",
	amountCents: 4000,
	counterCents: null,
	counterExpiresAt: null,
	endedReason: null,
	position: { kind: "won", rank: 1 },
	...overrides,
});

const card = {
	href: "/s/sale/i/i1",
	title: "Charizard",
	priceCents: 4000,
	quantity: 1,
	gameId: "pokemon",
	kind: "single",
	condition: null,
	photoUrl: null,
	state: "available" as const,
	offersEnabled: true,
};

describe("LiveItemCard", () => {
	it("[SM-3-counts-public] [SM-3-offer-visibility] shows counts, the offers the sale shows, and the buyer's position", async () => {
		await render(LiveItemCard, {
			...card,
			mode: "enter",
			live: live({
				state: "sold_out",
				freeUnits: 0,
				claimCount: 2,
				offerCount: 1,
				offers: [{ label: "Buyer C", amountCents: 3500 }],
				mine: [mine({ status: "open", position: { kind: "backup", rank: 2 } })],
			}),
		});
		await expect.element(page.getByTestId("item-state")).toHaveTextContent("Sold out");
		await expect.element(page.getByTestId("item-counts")).toHaveTextContent("2 claims waiting · 1 offer");
		await expect
			.element(page.getByRole("list", { name: "Offers on Charizard" }))
			.toHaveTextContent("Buyer C: $35.00");
		await expect.element(page.getByTestId("my-position")).toHaveTextContent("Backup #2");
		// One pending entry per item (SM-4.1-one-open-entry): the buttons wait.
		await expect.element(page.getByRole("button", { name: "Claim as backup Charizard" })).toBeDisabled();
	});

	it("offers claim and offer buttons while live, a countdown before, and a sign-in link to visitors", async () => {
		const onclaim = vi.fn<() => void>();
		const onoffer = vi.fn<() => void>();
		const screen = await render(LiveItemCard, { ...card, mode: "enter", live: live(), onclaim, onoffer });
		await page.getByRole("button", { name: "Claim Charizard" }).click();
		await page.getByRole("button", { name: "Make an offer on Charizard" }).click();
		expect(onclaim).toHaveBeenCalledOnce();
		expect(onoffer).toHaveBeenCalledOnce();

		await screen.rerender({ ...card, mode: "enter", live: live(), busy: true });
		await expect.element(page.getByRole("button", { name: "Claiming… Charizard" })).toBeDisabled();
		await screen.rerender({ ...card, mode: "soon", live: live() });
		await expect.element(page.getByRole("button", { name: "Claims open soon for Charizard" })).toBeDisabled();
		await screen.rerender({ ...card, mode: "sign_in", signInHref: "/login?next=/s/sale" });
		await expect
			.element(page.getByRole("link", { name: "Sign in to claim" }))
			.toHaveAttribute("href", "/login?next=/s/sale");
		await screen.rerender({ ...card, mode: "none", offersEnabled: false });
		await expect.element(page.getByRole("button")).not.toBeInTheDocument();
	});
});

describe("EntryDialog", () => {
	it("[LIVE-claim-confirm] asks before a binding claim", async () => {
		const onconfirm = vi.fn<(amountCents?: number) => void>();
		const oncancel = vi.fn<() => void>();
		await render(EntryDialog, {
			request: { kind: "claim", title: "Charizard", priceCents: 4000 },
			onconfirm,
			oncancel,
		});
		await expect.element(page.getByRole("dialog", { name: "Claim Charizard?" })).toBeVisible();
		await expect.element(page.getByText("Claims are binding. Claim for $40.00?")).toBeVisible();
		await page.getByRole("button", { name: "Claim for $40.00" }).click();
		expect(onconfirm).toHaveBeenCalledWith();
		await page.getByRole("button", { name: "Cancel" }).click();
		expect(oncancel).toHaveBeenCalledOnce();
	});

	it("takes an offer in dollars and sends cents", async () => {
		const onconfirm = vi.fn<(amountCents?: number) => void>();
		await render(EntryDialog, {
			request: { kind: "offer", title: "Charizard", priceCents: 4000 },
			onconfirm,
			oncancel: () => {},
		});
		const amount = page.getByLabelText("Your offer ($)");
		await amount.fill("abc");
		await page.getByRole("button", { name: "Send offer" }).click();
		await expect.element(page.getByText("Enter an amount in dollars, like 35 or 35.50")).toBeVisible();
		await expect.element(amount).toHaveAttribute("aria-invalid", "true");
		expect(onconfirm).not.toHaveBeenCalled();
		await amount.fill("35.50");
		await page.getByRole("button", { name: "Send offer" }).click();
		expect(onconfirm).toHaveBeenCalledWith(3550);
	});
});

const snapshot = (overrides: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
	serverNow: Date.now(),
	sale: { status: "live", liveAt: Date.now() - 1000, closesAt: Date.now() + 86_400_000, at: 1 },
	items: [live({ id: "i1" }), live({ id: "i2" })],
	...overrides,
});

/** The grid's socket, once it's open. */
async function socket(): Promise<FakeSocket> {
	await expect.poll(() => FakeSocket.instances.length).toBe(1);
	const s = FakeSocket.instances[0]!;
	await expect.element(page.getByTestId("connection")).toHaveTextContent("Live");
	return s;
}

describe("LiveSaleGrid", () => {
	const items = [
		{ ...card, id: "i1", title: "Charizard" },
		{ ...card, id: "i2", title: "Mewtwo", priceCents: 1250, gameId: "mtg" },
	];
	const props = (overrides: Record<string, unknown> = {}) => ({
		saleId: "sale1",
		slug: "sale",
		status: "live" as const,
		items,
		live: snapshot(),
		confirmClaims: true,
		signedIn: true,
		isSeller: false,
		refresh: vi.fn<() => Promise<void>>(async () => {}),
		...overrides,
	});
	let fetchMock: Mock<typeof fetch>;

	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		fetchMock = vi.fn<typeof fetch>(
			async () => new Response(JSON.stringify({ entry: { status: "won" } }), { status: 201 }),
		);
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("[LIVE-claim-confirm] [LIVE-position] confirms a claim, posts it, and reads out the result the socket brings", async () => {
		await render(LiveSaleGrid, props());
		const s = await socket();
		expect(s.url).toMatch(/\/api\/sales\/sale1\/live$/);

		await page.getByRole("button", { name: "Claim Charizard" }).click();
		await page.getByRole("button", { name: "Claim for $40.00" }).click();
		await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("/api/sales/sale1/entries");
		expect(typeof init?.body === "string" && JSON.parse(init.body)).toEqual({ itemId: "i1", kind: "claim" });

		s.emit({
			type: "items",
			items: [live({ id: "i1", version: 2, state: "sold_out", freeUnits: 0, unitsWon: 1, mine: [mine()] })],
		});
		await expect
			.element(page.getByTestId("live-announcement"))
			.toHaveTextContent("You're #1 — Charizard is yours.");
		await expect.element(page.getByRole("status").filter({ hasText: "You're #1" })).toBeInTheDocument();
		await expect.element(page.getByTestId("my-position")).toHaveTextContent("You're #1");
		// D53: the running total.
		await expect
			.element(page.getByTestId("running-total"))
			.toHaveTextContent("Your total: $40.00 · 1 item won");

		// An older frame (a late snapshot) never wins.
		s.emit({ type: "snapshot", ...snapshot() });
		await expect.element(page.getByTestId("my-position")).toHaveTextContent("You're #1");
	});

	it("[LIVE-claim-confirm] claims at once when the seller turned confirmation off", async () => {
		await render(LiveSaleGrid, props({ confirmClaims: false }));
		await socket();
		await page.getByRole("button", { name: "Claim Mewtwo" }).click();
		await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
		await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
	});

	it("says what went wrong when the engine says no", async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(JSON.stringify({ code: "already_entered", message: "You already claimed this" }), {
					status: 409,
				}),
		);
		await render(LiveSaleGrid, props({ confirmClaims: false }));
		await socket();
		await page.getByRole("button", { name: "Claim Mewtwo" }).click();
		await expect.element(page.getByTestId("live-announcement")).toHaveTextContent("You already claimed this");
	});

	it("flips the buttons at go-live, and refetches when the socket is gone", async () => {
		const refresh = vi.fn<() => Promise<void>>(async () => {});
		await render(
			LiveSaleGrid,
			props({
				status: "scheduled",
				refresh,
				live: snapshot({ sale: { status: "scheduled", liveAt: Date.now() + 60_000, closesAt: null, at: 1 } }),
			}),
		);
		const s = await socket();
		await expect.element(page.getByRole("button", { name: "Claims open soon for Charizard" })).toBeDisabled();
		await expect.element(page.getByRole("timer")).toBeVisible();
		s.emit({ type: "sale", sale: { status: "live", liveAt: Date.now(), closesAt: null, at: 2 } });
		await expect.element(page.getByRole("button", { name: "Claim Charizard" })).toBeEnabled();
		await expect
			.element(page.getByTestId("live-announcement"))
			.toHaveTextContent("The sale is live. Claims are open.");

		// The sale went back to draft: no reconnecting, the page reloads its data instead.
		s.close(4403);
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("reconnects after a dropped connection and catches up from the new snapshot [LIVE-broadcast]", async () => {
		await render(LiveSaleGrid, props());
		const first = await socket();
		first.close(1006);
		await expect.element(page.getByTestId("connection")).toHaveTextContent("Reconnecting…");
		await expect.poll(() => FakeSocket.instances.length, { timeout: 3000 }).toBe(2);
		const second = FakeSocket.instances[1]!;
		second.emit({
			type: "snapshot",
			...snapshot({ items: [live({ id: "i1", version: 5, claimCount: 3 }), live({ id: "i2" })] }),
		});
		await expect.element(page.getByTestId("item-counts")).toHaveTextContent("3 claims waiting · 0 offers");
	});

	it("filters by status, game and price", async () => {
		await render(
			LiveSaleGrid,
			props({
				live: snapshot({ items: [live({ id: "i1", state: "sold_out", freeUnits: 0 }), live({ id: "i2" })] }),
			}),
		);
		await expect.element(page.getByTestId("live-item")).toHaveLength(2);
		const show = page.getByRole("group", { name: "Show" });
		await show.getByText("Sold out", { exact: true }).click();
		await expect.element(page.getByTestId("live-item")).toHaveLength(1);
		await expect
			.element(page.getByTestId("live-item").getByRole("link", { name: "Charizard" }))
			.toBeVisible();
		await show.getByText("All", { exact: true }).click();
		await page.getByLabelText("Game").selectOptions("mtg");
		await expect.element(page.getByTestId("live-item").getByRole("link", { name: "Mewtwo" })).toBeVisible();
		await page.getByLabelText("Game").selectOptions("");
		await userEvent.fill(page.getByLabelText("Max $").element(), "20");
		await userEvent.tab();
		await expect.element(page.getByTestId("live-item")).toHaveLength(1);
		await expect.element(page.getByTestId("live-item").getByRole("link", { name: "Mewtwo" })).toBeVisible();
		await show.getByText("My items", { exact: true }).click();
		await expect.element(page.getByText("No items match these filters.")).toBeVisible();
	});

	it("shows visitors a sign-in link and the seller no buttons", async () => {
		const screen = await render(LiveSaleGrid, props({ signedIn: false }));
		await expect
			.element(page.getByRole("link", { name: "Sign in to claim" }).first())
			.toHaveAttribute("href", "/login?next=/s/sale");
		await expect.element(page.getByText("My items")).not.toBeInTheDocument();
		await screen.unmount();
		await render(LiveSaleGrid, props({ isSeller: true }));
		await expect.element(page.getByRole("button", { name: /Claim/ })).not.toBeInTheDocument();
	});
});
