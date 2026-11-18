import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { ThreadMessage } from "#lib/messaging/thread.ts";
import MessageComposer from "./MessageComposer.svelte";
import MessageThread from "./MessageThread.svelte";
import NotificationBell from "./NotificationBell.svelte";
import NotificationList from "./NotificationList.svelte";
import SiteHeader from "./SiteHeader.svelte";

describe("NotificationBell", () => {
	it("links to the notifications page and announces the unread count", async () => {
		await render(NotificationBell, { unread: 3 });
		const bell = page.getByRole("link", { name: "Notifications, 3 unread" });
		await expect.element(bell).toHaveAttribute("href", "/me/notifications");
		await expect.element(page.getByTestId("unread-count")).toHaveTextContent("3");
	});

	it("shows no badge when everything is read, and caps big numbers", async () => {
		const { rerender } = await render(NotificationBell, { unread: 0 });
		await expect.element(page.getByRole("link", { name: "Notifications" })).toBeVisible();
		await expect.element(page.getByTestId("unread-count")).not.toBeInTheDocument();
		await rerender({ unread: 250 });
		await expect.element(page.getByTestId("unread-count")).toHaveTextContent("99+");
	});

	it("sits in the header with a Messages link when signed in", async () => {
		await render(SiteHeader, { user: { handle: "ash", displayName: "Ash" }, unread: 1 });
		await expect
			.element(page.getByRole("link", { name: "Messages" }))
			.toHaveAttribute("href", "/me/messages");
		await expect.element(page.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();
	});
});

describe("NotificationList", () => {
	it("lists notifications, marking unread ones, each opening through a form", async () => {
		await render(NotificationList, {
			notifications: [
				{
					id: "n1",
					title: "You won “Mew”",
					body: "Your claim won.",
					read: false,
					createdAt: 1_700_000_000_000,
				},
				{ id: "n2", title: "Invoice", body: "Ready.", read: true, createdAt: 1_600_000_000_000 },
			],
		});
		const items = page.getByRole("list", { name: "Notifications" }).getByRole("listitem");
		expect(items.elements()).toHaveLength(2);
		await expect.element(page.getByRole("button", { name: /Unread: You won “Mew”/ })).toBeVisible();
		await expect.element(page.getByRole("button", { name: /^Invoice/ })).toBeVisible();
		const form = page
			.getByRole("button", { name: /You won/ })
			.element()
			.closest("form")!;
		expect(form.getAttribute("action")).toBe("?/open");
		expect(form.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe("n1");
	});

	it("explains the empty state", async () => {
		await render(NotificationList, { notifications: [] });
		await expect.element(page.getByText(/Nothing yet/)).toBeVisible();
	});
});

const message = (over: Partial<ThreadMessage>): ThreadMessage => ({
	id: "m1",
	mine: false,
	senderName: "Brock",
	body: "Hello",
	paymentWarning: false,
	createdAt: 1_700_000_000_000,
	attachments: [],
	...over,
});

describe("MessageThread", () => {
	it("[MSG-payment-warning] shows the warning under a flagged message", async () => {
		await render(MessageThread, {
			messages: [
				message({ id: "a", body: "pay me F&F", paymentWarning: true }),
				message({ id: "b", body: "ok", mine: true }),
			],
		});
		await expect
			.element(page.getByRole("note"))
			.toHaveTextContent(
				'Careful: this message mentions paying outside the invoice. Pay only the way the seller\'s invoice lists, never "friends and family", and report anyone who asks you to.',
			);
		expect(page.getByTestId("message").elements()).toHaveLength(2);
	});

	it("[MSG-report] offers a report form on the other side's messages only", async () => {
		const { container } = await render(MessageThread, {
			messages: [message({ id: "a" }), message({ id: "b", mine: true, body: "mine" })],
		});
		const summaries = container.querySelectorAll("summary");
		expect(summaries).toHaveLength(1);
		summaries[0]!.click();
		await expect.element(page.getByRole("combobox", { name: "Reason" })).toBeVisible();
		const form = page.getByRole("button", { name: "Send report" }).element().closest("form")!;
		expect(form.getAttribute("action")).toBe("?/report");
		expect(form.querySelector<HTMLInputElement>('input[name="messageId"]')?.value).toBe("a");
	});

	it("shows message photos with alt text", async () => {
		await render(MessageThread, {
			messages: [
				message({ attachments: [{ id: "p", url: "/api/messages/attachments/p", width: 10, height: 10 }] }),
			],
		});
		await expect
			.element(page.getByRole("img", { name: "Photo 1 from Brock" }))
			.toHaveAttribute("src", "/api/messages/attachments/p");
	});
});

describe("MessageComposer", () => {
	it("[MSG-payment-warning] warns the writer as they type a payment handle", async () => {
		await render(MessageComposer, { action: "?/send" });
		const box = page.getByLabelText("Message");
		await expect.element(page.getByRole("note")).not.toBeInTheDocument();
		await userEvent.type(box, "send it on venmo");
		await expect.element(page.getByText(/^Payments belong on the invoice/)).toBeVisible();
	});

	it("posts a multipart form and shows a failed send's error with the text kept", async () => {
		await render(MessageComposer, {
			action: "?/send",
			error: "Write a message or add a photo",
			value: "draft",
		});
		await expect.element(page.getByRole("alert")).toHaveTextContent("Write a message or add a photo");
		await expect.element(page.getByLabelText("Message")).toHaveValue("draft");
		const form = page.getByRole("button", { name: "Send" }).element().closest("form")!;
		expect(form.getAttribute("enctype")).toBe("multipart/form-data");
		expect(form.getAttribute("action")).toBe("?/send");
	});
});
