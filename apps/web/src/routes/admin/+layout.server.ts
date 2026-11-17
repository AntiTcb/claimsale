import { requireAdmin } from "#lib/server/admin.ts";
import type { LayoutServerLoad } from "./$types";

/** Every /admin page: admins only (others get a 404). Actions call requireAdmin too. */
export const load: LayoutServerLoad = (event) => {
	requireAdmin(event);
	return {};
};
