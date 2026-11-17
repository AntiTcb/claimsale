import { error } from "@sveltejs/kit";
import { isAdmin } from "#lib/server/admin.ts";
import { db, imageStore } from "#lib/server/context.ts";
import { findAttachmentFor } from "#lib/server/messaging.ts";
import type { RequestHandler } from "./$types";

/**
 * A message photo, for the conversation's buyer and seller (and admins reviewing a report).
 *
 * @spec MSG-attachment-access — anyone else gets a 404; never publicly cacheable.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = locals.user ? { id: locals.user.id, admin: isAdmin(locals.user) } : null;
	const attachment = await findAttachmentFor(db(), params.attachmentId, viewer);
	if (!attachment) error(404, "Not found");
	const object = await imageStore().get(attachment.r2Key);
	if (!object) error(404, "Not found");
	return new Response(object.body, {
		headers: {
			"content-type": attachment.contentType,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
};
