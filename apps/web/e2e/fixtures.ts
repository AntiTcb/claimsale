import AxeBuilder from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";

/** `expectAccessible()` runs axe on the current page (TESTING §4). */
export const test = base.extend<{ expectAccessible: () => Promise<void> }>({
	expectAccessible: async ({ page }, use) => {
		await use(async () => {
			const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
			expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
		});
	},
});

export { expect };
