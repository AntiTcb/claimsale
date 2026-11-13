import { error } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { findPublicProfile } from "#lib/server/users.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
	const profile = await findPublicProfile(db(), params.handle);
	if (!profile) error(404, "No one has that handle");
	return { profile: { ...profile, memberSince: profile.memberSince.getTime() } };
};
