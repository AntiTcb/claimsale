-- Hand-written. Expand-only: changes row values, no schema.
--
-- 1. Makes `games` match the core registry (packages/core/src/games.ts, D61), which
--    the sell form and the attribute schemas read. 0004 seeded the rows with TCGplayer
--    finish names and uppercase language codes; the registry's finish ids and BCP 47
--    language codes replace them (nothing read the old values). Adds Final Fantasy TCG,
--    disabled. The disabled `pokemon-japan` row stays: Japanese Pokémon is a language
--    of `pokemon`, and that row only marks TCGCSV category 85 for later ingestion.
--    apps/web/src/lib/server/games-seed.test.ts checks the table against the registry.
INSERT INTO `games` (`id`, `slug`, `name`, `condition_scale`, `finishes`, `languages`, `tcgplayer_category_id`, `enabled`, `sort_order`) VALUES
	('yugioh', 'yugioh', 'Yu-Gi-Oh!', '["NM","LP","MP","HP","DMG"]', '["normal"]', '["en","ja","ko","fr","de","it","es","pt"]', 2, 1, 10),
	('pokemon', 'pokemon', 'Pokémon', '["NM","LP","MP","HP","DMG"]', '["non-holo","holo","reverse-holo"]', '["en","ja","ko","zh-Hant","zh-Hans","fr","de","it","es","pt","id","th"]', 3, 1, 20),
	('mtg', 'mtg', 'Magic: The Gathering', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil","etched"]', '["en","ja","de","fr","it","es","pt","ru","ko","zh-Hans","zh-Hant"]', 1, 1, 30),
	('riftbound', 'riftbound', 'Riftbound', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","zh-Hans"]', 89, 1, 40),
	('one-piece', 'one-piece', 'One Piece Card Game', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 68, 1, 50),
	('lorcana', 'lorcana', 'Disney Lorcana', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","fr","de","it","ja"]', 71, 1, 60),
	('flesh-and-blood', 'flesh-and-blood', 'Flesh and Blood', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","fr","de","it","es","ja"]', 62, 1, 70),
	('star-wars-unlimited', 'star-wars-unlimited', 'Star Wars: Unlimited', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","fr","de","it","es"]', 79, 1, 80),
	('digimon', 'digimon', 'Digimon Card Game', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 63, 1, 90),
	('gundam', 'gundam', 'Gundam Card Game', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 86, 1, 100),
	('dragon-ball-fusion-world', 'dragon-ball-fusion-world', 'Dragon Ball Super: Fusion World', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 80, 0, 120),
	('union-arena', 'union-arena', 'Union Arena', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 81, 0, 130),
	('weiss-schwarz', 'weiss-schwarz', 'Weiss Schwarz', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 20, 0, 140),
	('cardfight-vanguard', 'cardfight-vanguard', 'Cardfight!! Vanguard', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 16, 0, 150),
	('sorcery', 'sorcery', 'Sorcery: Contested Realm', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en"]', 77, 0, 160),
	('grand-archive', 'grand-archive', 'Grand Archive', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja"]', 74, 0, 170),
	('final-fantasy', 'final-fantasy', 'Final Fantasy TCG', '["NM","LP","MP","HP","DMG"]', '["non-foil","foil"]', '["en","ja","fr","de","it","es"]', 24, 0, 180)
ON CONFLICT (`id`) DO UPDATE SET
	`name` = excluded.`name`,
	`condition_scale` = excluded.`condition_scale`,
	`finishes` = excluded.`finishes`,
	`languages` = excluded.`languages`,
	`tcgplayer_category_id` = excluded.`tcgplayer_category_id`,
	`enabled` = excluded.`enabled`,
	`sort_order` = excluded.`sort_order`;
--> statement-breakpoint
-- 2. The sell form (WS-A) stored Magic as "magic" before the registry existed; the
--    registry slug is "mtg".
UPDATE `items` SET `game_id` = 'mtg' WHERE `game_id` = 'magic';
