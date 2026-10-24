import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseSkillFile, type SkillsScanResult } from "../core/skills.ts";
import { serverExecute } from "./tool-execute.ts";

/**
 * Skills — the file side: find skills in the configured folder and the
 * `load_skill` tool that reads them. Pure parsing lives in core/skills.ts.
 */

/** 50KB — the same output ceiling the file tools use. */
const MAX_OUTPUT_BYTES = 50 * 1024;
/** Cap on the file list shown with a skill (deep folders stay readable). */
const MAX_LISTED_FILES = 200;

/** `~` and relative paths resolve against the user's home directory. */
export function resolveSkillsFolder(folder: string): string {
	if (folder === "~") return os.homedir();
	if (folder.startsWith("~/") || folder.startsWith("~\\")) return path.join(os.homedir(), folder.slice(2));
	return path.isAbsolute(folder) ? folder : path.join(os.homedir(), folder);
}

/** A usable skill found on disk. */
export interface SkillInfo {
	name: string;
	description: string;
	/** Absolute path of the skill's folder. */
	dir: string;
}

function skillFileIn(dir: string): string | null {
	try {
		const match = fs.readdirSync(dir).find((f) => f.toLowerCase() === "skill.md");
		return match ? path.join(dir, match) : null;
	} catch {
		return null;
	}
}

/** Scan the folder: every subfolder holding a SKILL.md is a skill. A
 *  subfolder whose SKILL.md is malformed, or reuses a name, is reported as
 *  a problem and left out. Never throws. */
export function scanSkills(folder: string): SkillsScanResult {
	const resolved = resolveSkillsFolder(folder);
	const result: SkillsScanResult = { folder, resolved, exists: false, skills: [], problems: [] };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(resolved, { withFileTypes: true });
		result.exists = true;
	} catch {
		return result;
	}
	const seen = new Set<string>();
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const dir = path.join(resolved, entry.name);
		const file = skillFileIn(dir);
		if (!file) continue;
		let parsed;
		try {
			parsed = parseSkillFile(fs.readFileSync(file, "utf-8"));
		} catch (err) {
			result.problems.push({ dir, error: `could not read SKILL.md (${(err as Error).message})` });
			continue;
		}
		if (!parsed.ok) {
			result.problems.push({ dir, error: parsed.error });
			continue;
		}
		if (seen.has(parsed.name)) {
			result.problems.push({ dir, error: `another skill is already named "${parsed.name}"` });
			continue;
		}
		seen.add(parsed.name);
		result.skills.push({ name: parsed.name, description: parsed.description, dir });
	}
	return result;
}

/** Files inside a skill folder (relative, POSIX slashes), SKILL.md excluded. */
function listSkillFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string, depth: number) => {
		if (out.length >= MAX_LISTED_FILES || depth > 4) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.name.startsWith(".")) continue;
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(child, depth + 1);
			else if (e.isFile() && !(rel === "" && e.name.toLowerCase() === "skill.md")) out.push(child);
			if (out.length >= MAX_LISTED_FILES) return;
		}
	};
	walk("", 0);
	return out;
}

function capText(text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES) return text;
	let cut = text.slice(0, MAX_OUTPUT_BYTES);
	while (Buffer.byteLength(cut, "utf-8") > MAX_OUTPUT_BYTES) cut = cut.slice(0, -1024);
	return `${cut}\n\n[Truncated at 50KB.]`;
}

/** Resolve `file` inside the skill folder, refusing anything that escapes
 *  it (`..`, absolute paths, or links pointing outside). */
export function resolveInsideSkill(dir: string, file: string): string {
	if (path.isAbsolute(file)) throw new Error("file must be a path inside the skill's folder");
	const realDir = fs.realpathSync(dir);
	const real = fs.realpathSync(path.join(realDir, file)); // ENOENT → error result
	if (real !== realDir && !real.startsWith(realDir + path.sep)) {
		throw new Error("file must be a path inside the skill's folder");
	}
	return real;
}

const loadSkillInput = Type.Object({
	name: Type.String({ minLength: 1, description: "The skill's name, exactly as listed under Skills" }),
	file: Type.Optional(Type.String({ minLength: 1, description: "Optional: a file inside the skill's folder to read instead of its SKILL.md, as a relative path (e.g. references/notes.md)" })),
});

/** The `load_skill` tool for one turn: it can read only the skills that are
 *  on for the current stage. Files are re-read on each call, so edits take
 *  effect immediately. */
export function createLoadSkillTool(skills: readonly SkillInfo[]): AgentTool<typeof loadSkillInput> {
	const byName = new Map(skills.map((s) => [s.name, s]));
	return {
		name: "load_skill",
		label: "load_skill",
		description: "Load one of the learner's installed skills (listed under Skills in your instructions). Without `file`, returns the skill's instructions and a list of its other files; with `file`, returns that file from the skill's folder.",
		parameters: loadSkillInput,
		execute: serverExecute("load_skill", loadSkillInput, async ({ name, file }) => {
			const skill = byName.get(name);
			if (!skill) {
				throw new Error(`No skill named "${name}" is available here. Available: ${[...byName.keys()].join(", ") || "none"}`);
			}
			if (file) {
				const text = fs.readFileSync(resolveInsideSkill(skill.dir, file), "utf-8");
				return capText(text);
			}
			const skillFile = skillFileIn(skill.dir);
			if (!skillFile) throw new Error(`Skill "${name}" has no SKILL.md any more`);
			const parsed = parseSkillFile(fs.readFileSync(skillFile, "utf-8"));
			if (!parsed.ok) throw new Error(`Skill "${name}" could not be read: ${parsed.error}`);
			const files = listSkillFiles(skill.dir);
			const listing = files.length ? `\n\n---\nOther files in this skill (load with \`file\`):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
			return capText(`# Skill: ${parsed.name}\n\n${parsed.body}${listing}`);
		}),
	};
}
