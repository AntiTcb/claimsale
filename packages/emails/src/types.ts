/** Props of the Svelte email templates (src/templates). Plain strings: the templates escape them. */

export interface LayoutProps {
	readonly preheader: string;
	/** Where the recipient changes which emails they get; omitted for invites (not a user yet). */
	readonly preferencesUrl: string | null;
	readonly children: import("svelte").Snippet;
}

export interface NotificationEmailProps {
	readonly title: string;
	readonly body: string;
	readonly actionLabel: string;
	readonly url: string;
	readonly preferencesUrl: string;
}

export interface DigestEmailProps {
	readonly heading: string;
	readonly lines: readonly string[];
	readonly actionLabel: string;
	readonly url: string;
	readonly preferencesUrl: string;
}

export interface InviteEmailProps {
	readonly saleTitle: string;
	readonly sellerName: string;
	readonly when: string | null;
	readonly url: string;
}
