import type { LicenseEntitlements } from "./types";

/** Runtime-only override; unset or unrecognized values retain the upstream license behavior. */
export function getEnvironmentLicenseEntitlements(
	env: CloudflareEnv & { MAILFLARE_LICENSE_PLAN?: string },
): LicenseEntitlements | null {
	const plan = env.MAILFLARE_LICENSE_PLAN?.trim().toLowerCase();
	if (plan !== "community" && plan !== "pro" && plan !== "team") return null;
	const pro = plan !== "community";
	return {
		plan,
		canCustomizeBranding: pro,
		canManageAccounts: pro,
		canForwardEmail: pro,
		canShareMailboxes: plan === "team",
		accountSeatLimit: pro ? null : 1,
	};
}
