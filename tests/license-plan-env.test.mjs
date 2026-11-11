import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "license-plan-env-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { getLicenseStatus, getLicenseEntitlements } from "./src/lib/licenses/service.ts";
			export { getAccountForwardingDestination } from "./src/lib/email/account-forwarding.ts";
			export * as accounts from "./src/app/api/accounts/route.ts";
			export * as branding from "./src/app/api/branding/route.ts";
			export * as forwarding from "./src/app/api/settings/forwarding/route.ts";
			export * as mailboxes from "./src/app/api/mailboxes/route.ts";
		`,
		resolveDir: root,
		sourcefile: "license-plan-env-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, getLicenseStatus, getLicenseEntitlements,
	getAccountForwardingDestination, accounts, branding, forwarding, mailboxes } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, override, plan = "community", state = "inactive") {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	sql.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1, 1),
			('member', 'member@example.test', 'hash', 'Member', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at)
			VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 'none', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at)
			VALUES ('mailbox', 'member', 'domain', 'member', 1);
	`);
	sql.prepare("INSERT INTO license_settings (id, instance_id, plan, state, seat_limit, updated_at) VALUES ('default', 'self-hosted-test', ?, ?, 1, 1)").run(plan, state);
	const objects = new Map();
	const env = { DB: database, MAILFLARE_RUNTIME: "node", MAILFLARE_LICENSE_PLAN: override, BUCKET: {
		async put(key, data) { objects.set(key, new Uint8Array(data)); },
	} };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Tests must not contact external services"); });
	const sessions = new Map();
	for (const id of ["owner", "member"]) sessions.set(id, await createSession(env, id));
	const request = (actor, path, method = "GET", body) => new Request(`https://mail.test${path}`, {
		method,
		headers: { Authorization: `Bearer ${sessions.get(actor)}`, Origin: "https://mail.test", ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
		...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
	});
	return { sql, env, objects, request };
}

test("Pro and Team overrides allow account creation without a paid license or seat limit", async t => {
	for (const override of ["pro", "team"]) {
		const f = await fixture(t, override);
		const response = await accounts.POST(f.request("owner", "/api/accounts", "POST", {
			username: "new-member", domainId: "domain", password: "test-only-password", role: "user",
		}));
		assert.equal(response.status, 201, JSON.stringify(await response.json()));
		assert.equal(f.sql.prepare("SELECT count(*) AS total FROM users").get().total, 3);
		const list = await accounts.GET(f.request("owner", "/api/accounts"));
		assert.equal(list.status, 200);
		assert.deepEqual((await list.json()).seats, { limit: null, used: 3 });
		assert.equal((await accounts.GET(f.request("member", "/api/accounts"))).status, 403);
	}
});

test("Pro override enables branding while preserving primary-admin authorization", async t => {
	const f = await fixture(t, "pro");
	const form = () => {
		const body = new FormData();
		body.set("appName", "My Mail");
		body.set("icon", new File([new Uint8Array([1, 2, 3])], "icon.png", { type: "image/png" }));
		return body;
	};
	assert.equal((await branding.PUT(f.request("member", "/api/branding", "PUT", form()))).status, 403);
	const saved = await branding.PUT(f.request("owner", "/api/branding", "PUT", form()));
	assert.equal(saved.status, 200);
	assert.deepEqual(await saved.json(), { appName: "My Mail", hasCustomIcon: true, canCustomizeBranding: true });
	assert.deepEqual([...f.objects.get("branding/app-icon")], [1, 2, 3]);
});

test("runtime plan changes gate forwarding without deleting its saved destination", async t => {
	const f = await fixture(t, "pro");
	const destination = "archive@external.test";
	const response = await forwarding.PATCH(f.request("member", "/api/settings/forwarding", "PATCH", { forwardingEmail: destination }));
	assert.equal(response.status, 200);
	assert.equal(await getAccountForwardingDestination(f.env, "member@example.test"), destination);
	assert.equal(f.sql.prepare("SELECT forwarding_email FROM users WHERE id='owner'").get().forwarding_email, null);
	f.env.MAILFLARE_LICENSE_PLAN = "community";
	assert.equal(await getAccountForwardingDestination(f.env, "member@example.test"), null);
	assert.equal((await forwarding.PATCH(f.request("member", "/api/settings/forwarding", "PATCH", { forwardingEmail: "changed@external.test" }))).status, 403);
	f.env.MAILFLARE_LICENSE_PLAN = "team";
	assert.equal(await getAccountForwardingDestination(f.env, "member@example.test"), destination);
});

test("unset override preserves upstream license status, entitlements and Pro seat limits", async t => {
	for (const [plan, state] of [["community", "inactive"], ["pro", "active"], ["team", "active"], ["team", "expired"]]) {
		const f = await fixture(t, undefined, plan, state);
		const active = state === "active";
		const status = await getLicenseStatus(f.env);
		assert.equal(status.active, active);
		assert.equal(status.plan, active ? plan : "community");
		const entitlements = await getLicenseEntitlements(f.env);
		assert.equal(entitlements.canCustomizeBranding, active);
		assert.equal(entitlements.canManageAccounts, active);
		assert.equal(entitlements.canForwardEmail, active);
		assert.equal(entitlements.canShareMailboxes, active && plan === "team");
		assert.equal(entitlements.accountSeatLimit, active && plan === "pro" ? 1 : null);
		if (plan !== "team" || !active) {
			const response = await mailboxes.POST(f.request("owner", "/api/mailboxes", "POST", {
				domainId: "domain", localPart: "support", type: "shared",
			}));
			assert.equal(response.status, 403);
		}
	}
});

test("explicit overrides take precedence over an active Team license without changing its stored state", async t => {
	const f = await fixture(t, "community", "team", "active");
	for (const override of ["community", "pro", "team"]) {
		f.env.MAILFLARE_LICENSE_PLAN = override;
		const response = await accounts.GET(f.request("owner", "/api/accounts"));
		assert.equal(response.status, override === "community" ? 403 : 200);
		const shared = await mailboxes.POST(f.request("owner", "/api/mailboxes", "POST", {
			domainId: "domain", localPart: "support", type: "shared",
		}));
		assert.equal(shared.status, override === "team" ? 200 : 403);
		const status = await getLicenseStatus(f.env);
		assert.equal(status.plan, "team");
		assert.equal(status.active, true);
	}
	assert.equal(f.sql.prepare("SELECT count(*) AS total FROM users").get().total, 2);
	f.env.MAILFLARE_LICENSE_PLAN = "community";
	assert.equal((await getLicenseEntitlements(f.env)).accountSeatLimit, 1);
	assert.equal((await getLicenseEntitlements(f.env)).canCustomizeBranding, false);
});

test("plan parsing tolerates case and whitespace and ignores empty or unknown overrides", async t => {
	const f = await fixture(t, "  TeAm  ", "pro", "active");
	assert.equal((await getLicenseEntitlements(f.env)).canShareMailboxes, true);
	for (const override of ["", "  ", "unknown", "t eam"]) {
		f.env.MAILFLARE_LICENSE_PLAN = override;
		const entitlements = await getLicenseEntitlements(f.env);
		assert.equal(entitlements.plan, "pro");
		assert.equal(entitlements.accountSeatLimit, 1);
		assert.equal(entitlements.canShareMailboxes, false);
	}
});

test("valid overrides work when license storage is unavailable", async t => {
	const f = await fixture(t, "pro");
	f.sql.exec("DROP TABLE license_settings");
	const response = await accounts.GET(f.request("owner", "/api/accounts"));
	assert.equal(response.status, 200);
	assert.equal((await response.json()).seats.limit, null);
	const form = new FormData();
	form.set("appName", "My Mail");
	assert.equal((await branding.PUT(f.request("owner", "/api/branding", "PUT", form))).status, 200);
	assert.equal((await getLicenseEntitlements(f.env)).canShareMailboxes, false);
	f.env.MAILFLARE_LICENSE_PLAN = "team";
	assert.equal((await getLicenseEntitlements(f.env)).canShareMailboxes, true);
	delete f.env.MAILFLARE_LICENSE_PLAN;
	assert.equal((await accounts.GET(f.request("owner", "/api/accounts"))).status, 403);
});
