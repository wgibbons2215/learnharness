/**
 * GET /api/skills — what the settings page shows: the configured skills
 * folder, whether it exists, the usable skills found in it, and any
 * skill folders that could not be used (with the reason). Read-only.
 */

import { effectiveSettings, scanSkills } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(scanSkills(effectiveSettings().skills.folder));
}
