import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTemplates, generatedDir } from "../scripts/compile.ts";
import { digestEmail, inviteEmail, notificationEmail } from "./index.ts";

describe("generated templates", () => {
	it("src/generated matches the Svelte templates (run `pnpm --filter @claimsale/emails generate`)", () => {
		const expected = compileTemplates();
		const actual = new Map(
			readdirSync(generatedDir).map((name) => [
				name,
				readFileSync(join(generatedDir, name), "utf8").replaceAll("\r\n", "\n"),
			]),
		);
		expect([...actual.keys()].toSorted()).toEqual([...expected.keys()].toSorted());
		for (const [name, code] of expected) expect({ name, code: actual.get(name) }).toEqual({ name, code });
	});
});

describe("notification email", () => {
	const mail = notificationEmail({
		title: "You won “Blue-Eyes”",
		body: "Your claim won at $40.00.",
		actionLabel: "View the item",
		url: "https://claimsale.net/s/x/i/1",
		preferencesUrl: "https://claimsale.net/me/notifications",
	});

	it("renders the title as the subject, a button and the preferences link", () => {
		expect(mail.subject).toBe("You won “Blue-Eyes”");
		expect(mail.html).toContain("<h1");
		expect(mail.html).toContain('href="https://claimsale.net/s/x/i/1"');
		expect(mail.html).toContain('href="https://claimsale.net/me/notifications"');
		expect(mail.html.startsWith("<!doctype html>")).toBe(true);
	});

	it("has a plain-text version with the link first-class", () => {
		expect(mail.text).toBe(
			"Your claim won at $40.00.\n\nView the item: https://claimsale.net/s/x/i/1\n\n— ClaimSale\n\nChoose which emails you get: https://claimsale.net/me/notifications",
		);
	});

	it("escapes user content (sale and item titles are seller-written)", () => {
		const evil = notificationEmail({
			title: '<script>alert(1)</script>"',
			body: "<img src=x onerror=alert(1)>",
			actionLabel: "Go",
			url: 'https://claimsale.net/"><script>',
			preferencesUrl: "https://claimsale.net/me/notifications",
		});
		expect(evil.html).not.toContain("<script>");
		expect(evil.html).not.toContain("<img");
		expect(evil.html).toContain("&lt;script>");
	});
});

describe("digest and invite emails", () => {
	it("lists every line of a digest", () => {
		const mail = digestEmail({
			subject: "12 new claims in the last few minutes",
			heading: "Activity on your sales",
			lines: ["“A”: 12 new claims", "“B”: 1 new offer"],
			actionLabel: "Open your sales",
			url: "https://claimsale.net/sell",
			preferencesUrl: "https://claimsale.net/me/notifications",
		});
		expect(mail.subject).toBe("12 new claims in the last few minutes");
		expect(mail.html.match(/<li>/g)).toHaveLength(2);
		expect(mail.text).toContain("- “A”: 12 new claims\n- “B”: 1 new offer");
	});

	it("invites without a preferences link (the invitee may have no account)", () => {
		const mail = inviteEmail({
			saleTitle: "Vintage Pokémon",
			sellerName: "Ash",
			when: null,
			url: "https://claimsale.net/s/vintage",
		});
		expect(mail.subject).toBe("You're invited to a private sale: Vintage Pokémon");
		expect(mail.html).toContain("invite list of a private claim sale");
		expect(mail.html).not.toContain("Choose which emails you get");
		expect(mail.text).toContain("Open the sale: https://claimsale.net/s/vintage");
		expect(inviteEmail({ saleTitle: "S", sellerName: "A", when: "Sat", url: "u" }).text).toContain(
			"which goes live Sat",
		);
	});
});
