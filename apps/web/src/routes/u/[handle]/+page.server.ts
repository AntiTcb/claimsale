import { error, fail } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { follow, followerCount, isFollowing, unfollow, userIdByHandle } from "#lib/server/follows.ts";
import { requireUser } from "#lib/server/sell.ts";
import { findPublicProfile } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
	const profile = await findPublicProfile(db(), params.handle);
	if (!profile) error(404, "No one has that handle");
	const userId = (await userIdByHandle(db(), params.handle))!;
	const viewer = locals.user?.id ?? null;
	return {
		profile: { ...profile, memberSince: profile.memberSince.getTime() },
		// D41: follow a seller to hear about their new sales.
		follow: {
			self: viewer === userId,
			signedIn: viewer !== null,
			following: viewer !== null && viewer !== userId && (await isFollowing(db(), viewer, userId)),
			followers: await followerCount(db(), userId),
		},
	};
};

/** Follow and unfollow (D41; the engine tells followers about new public sales). */
export const actions: Actions = {
	follow: async (event) => {
		const user = requireUser(event);
		const sellerId = await userIdByHandle(db(), event.params.handle);
		if (!sellerId) error(404, "No one has that handle");
		const result = await follow(db(), user.id, sellerId, Date.now());
		if (!result.ok) return fail(400, { message: result.error.message });
		return { following: true };
	},
	unfollow: async (event) => {
		const user = requireUser(event);
		const sellerId = await userIdByHandle(db(), event.params.handle);
		if (!sellerId) error(404, "No one has that handle");
		await unfollow(db(), user.id, sellerId);
		return { following: false };
	},
};
