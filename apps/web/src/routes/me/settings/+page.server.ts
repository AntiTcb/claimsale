import { maskPhoneForOwner, validateDisplayName, validateFacebookUrl, validateHandle } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { defaultMarketPercent, setDefaultMarketPercent } from "#lib/server/catalog.ts";
import { dropSessionCache } from "#lib/server/auth.ts";
import { auth, db, phoneVerifier } from "#lib/server/context.ts";
import { type FormErrors, authErrorMessage, field, fieldError } from "#lib/server/forms.ts";
import {
	cancelPhoneVerification,
	checkPhoneVerification,
	pendingPhone,
	startPhoneVerification,
} from "#lib/server/phone.ts";
import { isHandleAvailable, isUniqueViolation, updateProfile, verifiedPhone } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	const user = locals.user;
	const pending = await pendingPhone(db(), user.id, Date.now());
	const verified = await verifiedPhone(db(), user.id);
	return {
		// Only ever masked, even for its owner (D55: never shown publicly).
		phone: {
			verified: verified ? maskPhoneForOwner(verified) : null,
			pending: pending ? maskPhoneForOwner(pending) : null,
			available: phoneVerifier().available,
		},
		/** The highlighted % of market button (D64). */
		defaultMarketPercent: await defaultMarketPercent(db(), user.id),
		profile: {
			email: user.email,
			emailVerified: user.emailVerified,
			displayName: user.name,
			handle: user.handle ?? "",
			fbProfileUrl: user.fbProfileUrl ?? "",
			ageAttested: user.ageAttested ?? null,
		},
	};
};

export const actions: Actions = {
	profile: async ({ request, locals, cookies, url }) => {
		if (!locals.user) redirect(303, "/login");
		const data = await request.formData();
		const values = {
			displayName: field(data, "displayName"),
			handle: field(data, "handle"),
			fbProfileUrl: field(data, "fbProfileUrl"),
		};
		const errors: FormErrors = {};
		const displayName = validateDisplayName(values.displayName);
		if (!displayName.ok) errors.displayName = displayName.message;
		const handle = validateHandle(values.handle);
		if (!handle.ok) errors.handle = handle.message;
		const fb = validateFacebookUrl(values.fbProfileUrl);
		if (!fb.ok) errors.fbProfileUrl = fb.message;
		if (handle.ok && !(await isHandleAvailable(db(), handle.value, locals.user.id)))
			errors.handle = "That handle is taken";
		if (!displayName.ok || !handle.ok || !fb.ok || Object.keys(errors).length > 0) {
			return fail(400, { action: "profile" as const, values, errors });
		}
		try {
			await updateProfile(
				db(),
				locals.user.id,
				{ displayName: displayName.value, handle: handle.value, fbProfileUrl: fb.value },
				new Date(),
			);
		} catch (error) {
			if (isUniqueViolation(error))
				return fail(409, {
					action: "profile" as const,
					values,
					errors: fieldError("handle", "That handle is taken"),
				});
			throw error;
		}
		dropSessionCache(url.origin, cookies);
		return { action: "profile" as const, saved: true };
	},

	marketPct: async ({ request, locals }) => {
		if (!locals.user) redirect(303, "/login");
		const raw = field(await request.formData(), "percent");
		const saved = await setDefaultMarketPercent(
			db(),
			locals.user.id,
			raw === "" ? null : Number(raw),
			Date.now(),
		);
		if (!saved) return fail(400, { action: "marketPct" as const, message: "Choose one of the % buttons" });
		return { action: "marketPct" as const, saved: true };
	},

	verify: async ({ request, locals, url }) => {
		if (!locals.user) redirect(303, "/login");
		try {
			await auth(url.origin).api.sendVerificationEmail({
				body: { email: locals.user.email, callbackURL: "/me/settings?verified=1" },
				headers: request.headers,
			});
		} catch (error) {
			return fail(400, { action: "verify" as const, message: authErrorMessage(error) });
		}
		return { action: "verify" as const, sent: true };
	},

	phoneStart: async ({ request, locals }) => {
		if (!locals.user) redirect(303, "/login");
		const data = await request.formData();
		const phone = field(data, "phone");
		const result = await startPhoneVerification({
			db: db(),
			verifier: phoneVerifier(),
			userId: locals.user.id,
			rawPhone: phone,
			now: Date.now(),
		});
		if (!result.ok) {
			return fail(400, { action: "phone" as const, phone, errors: { [result.field]: result.message } });
		}
		return { action: "phone" as const, sentTo: result.masked };
	},

	phoneCheck: async ({ request, locals, cookies, url }) => {
		if (!locals.user) redirect(303, "/login");
		const data = await request.formData();
		const result = await checkPhoneVerification({
			db: db(),
			verifier: phoneVerifier(),
			userId: locals.user.id,
			rawCode: field(data, "code"),
			now: Date.now(),
		});
		if (!result.ok) {
			return fail(400, { action: "phone" as const, phone: "", errors: { [result.field]: result.message } });
		}
		dropSessionCache(url.origin, cookies);
		return { action: "phone" as const, verified: result.masked };
	},

	phoneCancel: async ({ locals }) => {
		if (!locals.user) redirect(303, "/login");
		await cancelPhoneVerification(db(), locals.user.id);
		return { action: "phone" as const, cancelled: true };
	},
};
