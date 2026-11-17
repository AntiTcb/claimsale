import type { CatalogLookup, CatalogProduct } from "@claimsale/core";
import { toFtsQuery } from "./search.ts";

/**
 * Core's injected catalog lookup (TCG-catalog-match) over D1, for item imports. Only
 * enabled games are searched. Each product carries its `catalog_products.id` as
 * `productId`, which the importer stores on the item.
 */

export type CatalogRow = CatalogProduct & { readonly productId: number };

interface ProductRow {
	readonly id: number;
	readonly tcgplayer_product_id: number;
	readonly game_id: string;
	readonly kind: "single" | "sealed";
	readonly name: string;
	readonly set_name: string;
	readonly set_code: string | null;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly product_type: string | null;
}

const SELECT = `SELECT p.id, p.tcgplayer_product_id, p.game_id, p.kind, p.name, s.name AS set_name,
	s.code AS set_code, p.number, p.rarity, p.product_type
	FROM catalog_products p JOIN catalog_sets s ON s.id = p.set_id JOIN games g ON g.id = p.game_id
	WHERE g.enabled = 1`;

const toProduct = (r: ProductRow): CatalogRow => ({
	productId: r.id,
	tcgplayerProductId: r.tcgplayer_product_id,
	game: r.game_id,
	kind: r.kind,
	name: r.name,
	setCode: r.set_code,
	setName: r.set_name,
	number: r.number,
	rarity: r.rarity,
	productType: r.product_type,
});

const all = async (statement: D1PreparedStatement) =>
	(await statement.all<ProductRow>()).results.map(toProduct);

export function d1CatalogLookup(db: D1Database): CatalogLookup & {
	/** Reads many TCGplayer IDs in one query; later `byProductId` calls use the result. */
	prefetch(tcgplayerProductIds: readonly number[]): Promise<void>;
} {
	const byId = new Map<number, CatalogRow | null>();
	const prefetch = async (ids: readonly number[]) => {
		const wanted = [...new Set(ids)].filter((id) => !byId.has(id));
		if (wanted.length === 0) return;
		const found = await all(
			db
				.prepare(`${SELECT} AND p.tcgplayer_product_id IN (SELECT value FROM json_each(?1))`)
				.bind(JSON.stringify(wanted)),
		);
		for (const id of wanted) byId.set(id, null);
		for (const product of found) byId.set(product.tcgplayerProductId, product);
	};
	return {
		prefetch,
		async byProductId(id) {
			await prefetch([id]);
			return byId.get(id) ?? null;
		},
		bySetAndNumber: (game, setCode, number) =>
			all(
				db
					.prepare(
						`${SELECT} AND p.game_id = ?1 AND lower(s.code) = lower(?2) AND (p.number = ?3 OR p.number LIKE ?3 || '/%') LIMIT 50`,
					)
					.bind(game, setCode, number),
			),
		async byName(game, name, setCode) {
			const match = toFtsQuery(name);
			if (match === null) return [];
			return all(
				db
					.prepare(
						`${SELECT} AND p.game_id = ?1
							AND p.id IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ?2)
							AND (?3 IS NULL OR lower(s.code) = lower(?3)) LIMIT 25`,
					)
					.bind(game, match, setCode),
			);
		},
	};
}
