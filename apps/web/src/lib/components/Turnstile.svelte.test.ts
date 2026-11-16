import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import Turnstile, { type TurnstileApi } from "./Turnstile.svelte";

afterEach(() => {
	delete window.turnstile;
});

describe("Turnstile", () => {
	it("[AUTH-signup-captcha] renders the widget with the site key, and its token posts with the form", async () => {
		// A stand-in for Cloudflare's script: render() adds the hidden response field, as the real one does.
		const render_ = vi.fn<TurnstileApi["render"]>((container, options) => {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = String(options["response-field-name"]);
			input.value = "XXXX.DUMMY.TOKEN.XXXX";
			container.appendChild(input);
			return "widget-1";
		});
		const remove = vi.fn<TurnstileApi["remove"]>();
		window.turnstile = { render: render_, remove };

		const form = document.createElement("form");
		document.body.appendChild(form);
		const { unmount } = await render(Turnstile, {
			target: form,
			props: { siteKey: "1x00000000000000000000AA", action: "signup" },
		});

		await expect.element(page.getByTestId("turnstile")).toBeInTheDocument();
		await vi.waitFor(() => expect(render_).toHaveBeenCalledTimes(1));
		expect(render_.mock.calls[0]?.[1]).toMatchObject({
			sitekey: "1x00000000000000000000AA",
			action: "signup",
		});
		expect(new FormData(form).get("cf-turnstile-response")).toBe("XXXX.DUMMY.TOKEN.XXXX");

		await unmount();
		expect(remove).toHaveBeenCalledWith("widget-1");
		form.remove();
	});
});
