-- Hand-written (drizzle-kit can't express FTS5 tables or triggers). Expand-only.
--
-- 1. catalog_search: the FTS5 index behind the seller's catalog type-ahead (PLAN 3,
--    D60). rowid = catalog_products.id. Triggers keep it in sync with
--    catalog_products and catalog_sets, so writers never touch it directly.
-- 2. Seed rows for the games ingested from TCGCSV (D61). The display data and attribute
--    schemas belong to packages/core's games registry; `id` is the slug both share.
CREATE VIRTUAL TABLE `catalog_search` USING fts5(
	`name`,
	`set_name`,
	`set_code`,
	`number`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
CREATE TRIGGER `catalog_products_search_insert` AFTER INSERT ON `catalog_products` BEGIN
	INSERT INTO `catalog_search` (`rowid`, `name`, `set_name`, `set_code`, `number`)
	SELECT new.`id`, new.`name`, s.`name`, s.`code`, new.`number` FROM `catalog_sets` s WHERE s.`id` = new.`set_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_products_search_update` AFTER UPDATE OF `name`, `number`, `set_id` ON `catalog_products` BEGIN
	DELETE FROM `catalog_search` WHERE `rowid` = old.`id`;
	INSERT INTO `catalog_search` (`rowid`, `name`, `set_name`, `set_code`, `number`)
	SELECT new.`id`, new.`name`, s.`name`, s.`code`, new.`number` FROM `catalog_sets` s WHERE s.`id` = new.`set_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_products_search_delete` AFTER DELETE ON `catalog_products` BEGIN
	DELETE FROM `catalog_search` WHERE `rowid` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_sets_search_update` AFTER UPDATE OF `name`, `code` ON `catalog_sets` BEGIN
	UPDATE `catalog_search` SET `set_name` = new.`name`, `set_code` = new.`code`
	WHERE `rowid` IN (SELECT `id` FROM `catalog_products` WHERE `set_id` = new.`id`);
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `games` (`id`, `slug`, `name`, `condition_scale`, `finishes`, `languages`, `tcgplayer_category_id`, `enabled`, `sort_order`) VALUES
	('yugioh', 'yugioh', 'Yu-Gi-Oh!', '["NM","LP","MP","HP","DMG"]', '["1st Edition","Unlimited","Limited"]', '["EN"]', 2, 1, 10),
	('pokemon', 'pokemon', 'Pokémon', '["NM","LP","MP","HP","DMG"]', '["Normal","Holofoil","Reverse Holofoil"]', '["EN"]', 3, 1, 20),
	('mtg', 'mtg', 'Magic: The Gathering', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 1, 1, 30),
	('riftbound', 'riftbound', 'Riftbound', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 89, 1, 40),
	('one-piece', 'one-piece', 'One Piece Card Game', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 68, 1, 50),
	('lorcana', 'lorcana', 'Disney Lorcana', '["NM","LP","MP","HP","DMG"]', '["Normal","Cold Foil"]', '["EN"]', 71, 1, 60),
	('flesh-and-blood', 'flesh-and-blood', 'Flesh and Blood', '["NM","LP","MP","HP","DMG"]', '["Normal","Rainbow Foil","Cold Foil"]', '["EN"]', 62, 1, 70),
	('star-wars-unlimited', 'star-wars-unlimited', 'Star Wars: Unlimited', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 79, 1, 80),
	('digimon', 'digimon', 'Digimon Card Game', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 63, 1, 90),
	('gundam', 'gundam', 'Gundam Card Game', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 86, 1, 100),
	('pokemon-japan', 'pokemon-japan', 'Pokémon (Japanese)', '["NM","LP","MP","HP","DMG"]', '["Normal","Holofoil","Reverse Holofoil"]', '["JA"]', 85, 0, 110),
	('dragon-ball-fusion-world', 'dragon-ball-fusion-world', 'Dragon Ball Super: Fusion World', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 80, 0, 120),
	('union-arena', 'union-arena', 'Union Arena', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 81, 0, 130),
	('weiss-schwarz', 'weiss-schwarz', 'Weiss Schwarz', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 20, 0, 140),
	('cardfight-vanguard', 'cardfight-vanguard', 'Cardfight!! Vanguard', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 16, 0, 150),
	('sorcery', 'sorcery', 'Sorcery: Contested Realm', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 77, 0, 160),
	('grand-archive', 'grand-archive', 'Grand Archive', '["NM","LP","MP","HP","DMG"]', '["Normal","Foil"]', '["EN"]', 74, 0, 170);
