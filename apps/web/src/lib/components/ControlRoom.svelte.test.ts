import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, type Locator } from "vitest/browser";
import type { BuyerSummary, ControlItem, QueueEntry } from "#lib/control-room.ts";
import ControlRoomItem from "./ControlRoomItem.svelte";
import Countdown from "./Countdown.svelte";

const NOW = Date.UTC(2026, 10, 20, 12);
/** An element's text with whitespace collapsed, as a reader sees it. */
const text = (locator: Locator) => (locator.element().textContent ?? "").replace(/\s+/g, " ").trim();
/** The control room's countdowns run on the real clock: their server time is "now". */
const LIVE = Date.now();

afterEach(() => {
	vi.useRealTimers();
});

describe("Countdown", () => {
	it("counts down from the server's clock, whatever the device clock says", async () => {
		// The device clock is an hour fast; the server's is the truth.
		vi.useFakeTimers({ now: NOW + 3_600_000, toFake: ["Date", "setInterval", "clearInterval"] });
		await render(Countdown, {
			deadline: NOW + 90_000,
			serverNow: NOW,
			label: "Decide within",
			endedLabel: "Window ended",
		});
		await expect.element(page.getByTestId("countdown")).toHaveTextContent("Decide within 1m");
		await expect
			.element(page.getByRole("time"))
			.toHaveAttribute("datetime", new Date(NOW + 90_000).toISOString());
		vi.advanceTimersByTime(45_000);
		await expect.element(page.getByTestId("countdown")).toHaveTextContent("Decide within 45s");
		vi.advanceTimersByTime(46_000);
		await expect.element(page.getByTestId("countdown")).toHaveTextContent("Window ended");
	});
});

const record = {
	completedPurchases: 3,
	nonPay: 1,
	paymentReversed: 0,
	takebacks: 0,
	violations: 0,
	proRescinds: 0,
	memberSince: Date.UTC(2025, 0, 5),
};
const buyers: Record<string, BuyerSummary> = {
	ash: { id: "ash", handle: "ash", displayName: "Ash", record },
	misty: { id: "misty", handle: "misty", displayName: "Misty", record: { ...record, nonPay: 0 } },
	brock: { id: "brock", handle: null, displayName: "Brock S", record },
};
const entry = (over: Partial<QueueEntry>): QueueEntry => ({
	id: "e",
	buyerId: "ash",
	kind: "claim",
	amountCents: 4000,
	status: "open",
	createdAt: NOW,
	counterCents: null,
	counterExpiresAt: null,
	wonAt: null,
	invoiceStatus: null,
	...over,
});
const item = (over: Partial<ControlItem> = {}): ControlItem => ({
	id: "i1",
	title: "Charizard",
	priceCents: 4000,
	quantity: 1,
	state: "deciding",
	decisionDeadline: LIVE + 2 * 3_600_000,
	offersLapseAt: null,
	winners: [],
	queue: [
		entry({ id: "e-misty", buyerId: "misty", kind: "offer", amountCents: 4500 }),
		entry({ id: "e-ash", buyerId: "ash" }),
	],
	countered: [],
	...over,
});

describe("ControlRoomItem", () => {
	it("[SM-4.2-award] shows the deciding countdown and the ranked queue with award, decline, counter and reorder", async () => {
		const enhance = vi.fn<(form: HTMLFormElement) => void>();
		await render(ControlRoomItem, { item: item(), buyers, serverNow: LIVE, enhance });
		await expect.element(page.getByRole("heading", { name: "Charizard" })).toBeVisible();
		// The time left ticks on the real clock; its deadline is exact.
		await expect.element(page.getByTestId("countdown")).toHaveTextContent("Decide within 1h 59m");
		await expect
			.element(page.getByRole("time"))
			.toHaveAttribute("datetime", new Date(LIVE + 2 * 3_600_000).toISOString());
		const queue = page.getByTestId("queue-entry").all();
		expect(queue.map(text)).toEqual([
			expect.stringContaining("#1 @misty · Offer $45.00 3 completed · member since Jan 2025"),
			expect.stringContaining("#2 @ash · Claim $40.00 3 completed · 1 non-pay"),
		]);
		await expect.element(page.getByRole("button", { name: "Award @misty" })).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Award @ash" })).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Decline @misty's offer" })).toBeVisible();
		// Claims can't be declined or countered.
		await expect.element(page.getByRole("button", { name: "Decline @ash's offer" })).not.toBeInTheDocument();
		await expect.element(page.getByRole("button", { name: "Move @misty up" })).toBeDisabled();
		await expect.element(page.getByRole("button", { name: "Move @ash down" })).toBeDisabled();
		await expect.element(page.getByRole("button", { name: "Move @ash up" })).toBeEnabled();
		// Every form goes through the page's enhance action.
		expect(enhance.mock.calls.map(([form]) => form.getAttribute("action"))).toEqual(
			expect.arrayContaining(["?/award", "?/decline", "?/counter", "?/moveBackup", "?/withdrawItem"]),
		);
	});

	it("[SM-4.3-seller-rescind] a winner gets the rescind form; a paid invoice asks for the extra confirmation", async () => {
		const winner = entry({
			id: "e-ash",
			buyerId: "ash",
			status: "won",
			wonAt: NOW,
			invoiceStatus: "buyer_paid",
		});
		await render(ControlRoomItem, {
			item: item({
				state: "sold_out",
				decisionDeadline: null,
				winners: [winner],
				queue: [entry({ id: "e-b", buyerId: "brock" })],
			}),
			buyers,
			serverNow: LIVE,
		});
		await expect.element(page.getByTestId("winner")).toBeVisible();
		expect(text(page.getByTestId("winner"))).toContain("@ash · Claim at $40.00 · invoice buyer paid");
		// Sold out: backups can't be awarded until a unit is free.
		await expect.element(page.getByRole("button", { name: /^Award/ })).not.toBeInTheDocument();
		expect(text(page.getByTestId("queue-entry"))).toContain("#1 Brock S · Claim $40.00");
		await page.getByText("Rescind @ash's win").click();
		const reason = page.getByRole("combobox", { name: "Reason" });
		await expect.element(reason).toBeVisible();
		await expect
			.element(page.getByRole("option", { name: /Listing mistake.*counts on your record/ }))
			.toBeInTheDocument();
		await expect.element(page.getByLabelText("Pass it to the next in line")).toBeChecked();
		await expect.element(page.getByLabelText(/marked this invoice paid/)).not.toBeChecked();
		await expect
			.element(page.getByRole("textbox", { name: "What happened (the buyer sees this)" }))
			.toHaveAttribute("minlength", "20");
	});

	it("[SM-4.4-counter] shows countered offers with their expiry, and offers the withdraw form", async () => {
		await render(ControlRoomItem, {
			item: item({
				queue: [],
				decisionDeadline: null,
				state: "available",
				countered: [
					entry({
						id: "e-c",
						buyerId: "misty",
						kind: "offer",
						amountCents: 3000,
						status: "countered",
						counterCents: 3500,
						counterExpiresAt: LIVE + 86_400_000,
					}),
				],
			}),
			buyers,
			serverNow: LIVE,
		});
		await expect
			.element(page.getByTestId("countered-entry"))
			.toHaveTextContent("@misty offered $30.00; you countered $35.00. Expires in 23h 59m");
		await expect.element(page.getByText("No open claims or offers.")).toBeVisible();
		await expect.element(page.getByText("Withdraw Charizard")).toBeVisible();
	});
});
