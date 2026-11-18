import { ImageResponse } from "@ethercorps/sveltekit-og";
import type { ShareCard } from "@claimsale/core";
import bold from "@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?inline";
import boldExt from "@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff?inline";
import regular from "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?inline";
import regularExt from "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?inline";
import ShareCardImage from "#lib/og/ShareCardImage.svelte";

/**
 * Renders share cards to PNG with satori + resvg-wasm (TECH_STACK S13). The fonts are
 * bundled (Noto Sans, Latin and Latin Extended), so rendering fetches nothing but emoji
 * from the renderer's emoji CDN; glyphs outside those ranges are left out of the image.
 */

function bytes(dataUrl: string): ArrayBuffer {
	const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out.buffer;
}

let fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] | undefined;

function loadFonts() {
	const files: [string, 400 | 700][] = [
		[regular, 400],
		[regularExt, 400],
		[bold, 700],
		[boldExt, 700],
	];
	fonts ??= files.map(([url, weight]) => ({ name: "Noto Sans", data: bytes(url), weight, style: "normal" }));
	return fonts;
}

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export async function renderShareCard(card: ShareCard): Promise<ArrayBuffer> {
	const response = new ImageResponse(
		ShareCardImage,
		{ ...SHARE_IMAGE_SIZE, fonts: loadFonts(), format: "png" },
		{ card },
	);
	if (!response.ok) throw new Error(`Share card render failed with ${response.status}`);
	return response.arrayBuffer();
}

/** Pictographs, flag letters, and the variation selector and joiner that build emoji sequences. */
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}/gu;

function plain(text: string): string {
	return text.replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

/** The card without emoji, for when the renderer can't fetch them. */
export function plainShareCard(card: ShareCard): ShareCard {
	return {
		...card,
		title: plain(card.title),
		seller: plain(card.seller),
		items: card.items.map((i) => ({ ...i, title: plain(i.title) })),
	};
}
