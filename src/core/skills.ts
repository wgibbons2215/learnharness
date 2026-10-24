/**
 * Skills — the browser-safe half: settings shape, SKILL.md header parsing,
 * and the per-stage switch rule. File access lives in src/agent/skills.ts.
 *
 * A skill is a folder holding a SKILL.md (the same format Claude uses):
 * a `---` header with `name` and `description`, then the instructions. The
 * model sees only the name + description of each skill that is on for the
 * current stage, and loads the full text on demand with `load_skill`.
 */

/** The session stages a skill can be switched on for. */
export const SKILL_STAGES = ["probe", "teach", "practice"] as const;
export type SkillStage = (typeof SKILL_STAGES)[number];

/** Settings-page labels, in display order. */
export const SKILL_STAGE_LABELS: Readonly<Record<SkillStage, string>> = {
	probe: "Measuring",
	teach: "Planning & teaching",
	practice: "Practice",
};

/** Where skills live when the user has not picked a folder. `~` is the
 *  user's home directory; relative paths also resolve against home. */
export const DEFAULT_SKILLS_FOLDER = "~/LearnHarness Skills";

/** The `skills` settings section. Delta-shaped like every section: an
 *  absent folder is the default, an absent stage switch is ON. */
export interface SkillsSettings {
	folder?: string;
	/** Per-skill stage switches, keyed by skill name. */
	stages?: Record<string, Partial<Record<SkillStage, boolean>>>;
}

export interface EffectiveSkillsSettings {
	folder: string;
	stages: Record<string, Partial<Record<SkillStage, boolean>>>;
}

/** New skills start ON for every stage; only an explicit false turns one off. */
export function skillOnFor(stages: EffectiveSkillsSettings["stages"], name: string, stage: SkillStage): boolean {
	return stages[name]?.[stage] !== false;
}

/** Skill names: lowercase letters, digits and hyphens (Claude's rule). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_DESCRIPTION_MAX = 1024;

export type ParsedSkill =
	| { ok: true; name: string; description: string; body: string }
	| { ok: false; error: string };

/**
 * Parse a SKILL.md: the `---` header's `name` and `description` (plain,
 * quoted, or a `>`/`|` block), then the body. Other header keys are
 * ignored. Never throws.
 */
export function parseSkillFile(text: string): ParsedSkill {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { ok: false, error: "SKILL.md must start with a --- header" };
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end === -1) return { ok: false, error: "SKILL.md header has no closing ---" };

	const fields: Record<string, string> = {};
	for (let i = 1; i < end; i++) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
		if (!m) continue;
		const key = m[1]!;
		let value = m[2]!.trim();
		if (value === ">" || value === "|" || value === ">-" || value === "|-") {
			const block: string[] = [];
			while (i + 1 < end && (/^\s/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) block.push(lines[++i]!.trim());
			value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
		} else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	const name = fields.name?.trim() ?? "";
	const description = fields.description?.trim() ?? "";
	if (!name) return { ok: false, error: "header is missing `name`" };
	if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `name "${name}" must be lowercase letters, digits and hyphens (max 64)` };
	if (!description) return { ok: false, error: "header is missing `description`" };
	if (description.length > SKILL_DESCRIPTION_MAX) return { ok: false, error: `description is longer than ${SKILL_DESCRIPTION_MAX} characters` };
	return { ok: true, name, description, body: lines.slice(end + 1).join("\n").trim() };
}

/** The system-prompt appendix listing the skills on for this stage. */
export function skillsPromptSection(skills: ReadonlyArray<{ name: string; description: string }>): string {
	if (skills.length === 0) return "";
	return [
		"## Skills",
		"",
		"The learner has installed skills: extra instructions for particular kinds of work. Each is listed below with a description of when it applies. When one fits what you are about to do, call `load_skill` with its name, then follow it. The description is not the skill — load it before relying on it. A skill may refer to other files in its folder; load those with `load_skill` and its `file` field.",
		"",
		...skills.map((s) => `- **${s.name}**: ${s.description.replace(/\s+/g, " ")}`),
	].join("\n");
}

/** Lenient read-side sanitizer (bad parts drop; never throws). */
export function sanitizeSkillsSettings(raw: Record<string, unknown>): SkillsSettings {
	const out: SkillsSettings = {};
	if (typeof raw.folder === "string" && raw.folder.trim()) out.folder = raw.folder.trim();
	if (raw.stages !== null && typeof raw.stages === "object" && !Array.isArray(raw.stages)) {
		const stages: NonNullable<SkillsSettings["stages"]> = {};
		for (const [name, switches] of Object.entries(raw.stages as Record<string, unknown>)) {
			if (!SKILL_NAME_RE.test(name) || switches === null || typeof switches !== "object" || Array.isArray(switches)) continue;
			const clean: Partial<Record<SkillStage, boolean>> = {};
			for (const stage of SKILL_STAGES) {
				const v = (switches as Record<string, unknown>)[stage];
				if (typeof v === "boolean") clean[stage] = v;
			}
			if (Object.keys(clean).length) stages[name] = clean;
		}
		if (Object.keys(stages).length) out.stages = stages;
	}
	return out;
}

/** Strict write-side parser for PUT /api/settings/skills. */
export function parseSkillsSettingsBody(body: unknown): { ok: true; settings: SkillsSettings } | { ok: false; error: string } {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	if (raw.folder !== undefined && typeof raw.folder !== "string") return { ok: false, error: "folder must be a string" };
	if (raw.stages !== undefined) {
		if (raw.stages === null || typeof raw.stages !== "object" || Array.isArray(raw.stages)) return { ok: false, error: "stages must be an object" };
		for (const [name, switches] of Object.entries(raw.stages as Record<string, unknown>)) {
			if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `invalid skill name "${name}"` };
			if (switches === null || typeof switches !== "object" || Array.isArray(switches)) return { ok: false, error: `stages.${name} must be an object` };
			for (const [stage, v] of Object.entries(switches as Record<string, unknown>)) {
				if (!(SKILL_STAGES as readonly string[]).includes(stage)) return { ok: false, error: `unknown stage "${stage}"` };
				if (typeof v !== "boolean") return { ok: false, error: `stages.${name}.${stage} must be true or false` };
			}
		}
	}
	return { ok: true, settings: sanitizeSkillsSettings(raw) };
}

/** What GET /api/skills reports for the settings page. */
export interface SkillsScanResult {
	/** The folder as configured (may start with ~). */
	folder: string;
	/** The absolute folder actually scanned. */
	resolved: string;
	exists: boolean;
	skills: Array<{ name: string; description: string; dir: string }>;
	/** Folders that look like skills but could not be used, with why. */
	problems: Array<{ dir: string; error: string }>;
}
