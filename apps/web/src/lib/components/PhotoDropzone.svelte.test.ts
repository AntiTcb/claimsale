import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import { PhotoError, type PreparedPhoto, type UploadedPhoto } from "#lib/images/resize.ts";
import PhotoDropzone from "./PhotoDropzone.svelte";

const prepared: PreparedPhoto = { blob: new Blob(["x"], { type: "image/webp" }), width: 10, height: 10 };
type Prepare = (file: File) => Promise<PreparedPhoto>;
type Upload = (saleId: string, itemId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>;
const file = (name = "card.jpg") => new File(["fake"], name, { type: "image/jpeg" });

function setup(overrides: Record<string, unknown> = {}) {
	const prepare = vi.fn<Prepare>(async () => prepared);
	const upload = vi.fn<Upload>(async () => ({ id: "img-new", url: "/api/images/img-new" }));
	const remove = vi.fn<(imageId: string) => Promise<void>>(async () => {});
	const onchange = vi.fn<() => void>();
	const props = {
		saleId: "sale-1",
		itemId: "item-1",
		itemTitle: "Charizard",
		photos: [] as Array<{ id: string; url: string; status?: string }>,
		max: 4,
		onchange,
		prepare,
		upload,
		remove,
		...overrides,
	};
	return { props, prepare, upload, remove, onchange };
}

describe("PhotoDropzone", () => {
	it("labels the group and the file input for the item", async () => {
		const { props } = setup();
		await render(PhotoDropzone, props);
		await expect.element(page.getByRole("group", { name: "Photos for Charizard" })).toBeVisible();
		await expect
			.element(page.getByLabelText("Add photos for Charizard"))
			.toHaveAttribute("accept", "image/*");
		await expect.element(page.getByText("0/4")).toBeVisible();
	});

	it("resizes and uploads each picked photo in turn, then reports the change", async () => {
		const { props, prepare, upload, onchange } = setup();
		await render(PhotoDropzone, props);
		await userEvent.upload(page.getByLabelText("Add photos for Charizard"), [file("a.jpg"), file("b.jpg")]);
		await expect.element(page.getByRole("status")).toHaveTextContent("Added 2 photos.");
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(upload).toHaveBeenCalledWith("sale-1", "item-1", prepared);
		expect(onchange).toHaveBeenCalledOnce();
	});

	it("refuses more photos than the cap allows, before uploading anything", async () => {
		const photos = [1, 2, 3].map((n) => ({ id: `p${n}`, url: `/api/images/p${n}` }));
		const { props, upload } = setup({ photos });
		await render(PhotoDropzone, props);
		await userEvent.upload(page.getByLabelText("Add more for Charizard"), [file(), file()]);
		await expect.element(page.getByRole("alert")).toHaveTextContent("You can add 1 more photo to this item.");
		expect(upload).not.toHaveBeenCalled();
	});

	it("hides the picker when the item is full", async () => {
		const photos = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, url: `/api/images/p${n}` }));
		const { props } = setup({ photos });
		await render(PhotoDropzone, props);
		await expect.element(page.getByText("4/4")).toBeVisible();
		await expect.element(page.getByLabelText(/Add (photos|more)/)).not.toBeInTheDocument();
	});

	it("shows the server's message when an upload is refused", async () => {
		const upload = vi.fn<Upload>(async () => {
			throw new PhotoError("Upload a JPEG or WebP photo");
		});
		const { props, onchange } = setup({ upload });
		await render(PhotoDropzone, props);
		await userEvent.upload(page.getByLabelText("Add photos for Charizard"), [file()]);
		await expect.element(page.getByRole("alert")).toHaveTextContent("Upload a JPEG or WebP photo");
		expect(onchange).not.toHaveBeenCalled();
	});

	it("removes a photo from its labelled button, with the keyboard", async () => {
		const photos = [{ id: "p1", url: "/api/images/p1", status: "review" }];
		const { props, remove, onchange } = setup({ photos });
		await render(PhotoDropzone, props);
		await expect.element(page.getByRole("img", { name: "Photo 1 of Charizard" })).toBeInTheDocument();
		await expect.element(page.getByText("In review")).toBeVisible();
		const button = page.getByRole("button", { name: "Remove photo 1 of Charizard" });
		(button.element() as HTMLButtonElement).focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("status")).toHaveTextContent("Removed photo 1.");
		expect(remove).toHaveBeenCalledWith("p1");
		expect(onchange).toHaveBeenCalledOnce();
	});

	it("is read-only when disabled", async () => {
		const photos = [{ id: "p1", url: "/api/images/p1" }];
		const { props } = setup({ photos, disabled: true });
		await render(PhotoDropzone, props);
		await expect.element(page.getByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
		await expect.element(page.getByLabelText(/Add/)).not.toBeInTheDocument();
	});
});
