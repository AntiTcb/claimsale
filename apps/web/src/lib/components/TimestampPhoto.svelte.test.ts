import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import { PhotoError, type PreparedPhoto, type UploadedPhoto } from "#lib/images/resize.ts";
import TimestampPhoto from "./TimestampPhoto.svelte";

const prepared: PreparedPhoto = { blob: new Blob(["x"], { type: "image/webp" }), width: 10, height: 10 };

function setup(overrides: Record<string, unknown> = {}) {
	const prepare = vi.fn<(file: File) => Promise<PreparedPhoto>>(async () => prepared);
	const upload = vi.fn<(saleId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>>(async () => ({
		id: "ts-1",
		url: "/api/images/ts-1",
	}));
	const onchange = vi.fn<() => void>();
	return {
		props: {
			saleId: "sale-1",
			handle: "ash",
			required: true,
			photo: null,
			onchange,
			prepare,
			upload,
			...overrides,
		},
		upload,
		onchange,
	};
}

describe("TimestampPhoto", () => {
	it("[IMG-timestamp-required] explains what to photograph and that it's required", async () => {
		const { props } = setup();
		await render(TimestampPhoto, props);
		await expect.element(page.getByRole("heading", { name: "Timestamp photo (required)" })).toBeVisible();
		await expect.element(page.getByText("@ash")).toBeVisible();
		await expect.element(page.getByLabelText("Add a timestamp photo")).toHaveAttribute("accept", "image/*");
	});

	it("[IMG-timestamp-required] uploads a photo and reports the change", async () => {
		const { props, upload, onchange } = setup({ required: false });
		await render(TimestampPhoto, props);
		await expect.element(page.getByRole("heading", { name: "Timestamp photo (optional)" })).toBeVisible();
		await userEvent.upload(page.getByLabelText("Add a timestamp photo"), [
			new File(["x"], "note.jpg", { type: "image/jpeg" }),
		]);
		await expect.element(page.getByRole("status")).toHaveTextContent("Timestamp photo uploaded.");
		expect(upload).toHaveBeenCalledWith("sale-1", prepared);
		expect(onchange).toHaveBeenCalledOnce();
	});

	it("[IMG-timestamp-required] shows the check's result, and why a photo was rejected", async () => {
		const { props } = setup({
			photo: { id: "ts-1", status: "rejected", rejection: "This timestamp photo was already used." },
		});
		await render(TimestampPhoto, props);
		await expect
			.element(page.getByTestId("timestamp-status"))
			.toHaveTextContent("Rejected. This timestamp photo was already used.");
		await expect.element(page.getByLabelText("Replace the timestamp photo")).toBeInTheDocument();
	});

	it("shows an upload error", async () => {
		const { props } = setup({
			upload: vi.fn<(saleId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>>(async () => {
				throw new PhotoError("That photo is too large.");
			}),
		});
		await render(TimestampPhoto, props);
		await userEvent.upload(page.getByLabelText("Add a timestamp photo"), [
			new File(["x"], "note.jpg", { type: "image/jpeg" }),
		]);
		await expect.element(page.getByRole("alert")).toHaveTextContent("That photo is too large.");
	});
});
