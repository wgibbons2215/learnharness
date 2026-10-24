/**
 * Skills: SKILL.md parsing, folder scanning, the load_skill tool's folder
 * boundary, per-stage switches reaching the agent, and the settings shape.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import {
	DEFAULT_SKILLS_FOLDER,
	parseSkillFile,
	parseSkillsSettingsBody,
	sanitizeSkillsSettings,
	skillOnFor,
	skillsPromptSection,
} from "../src/core/skills.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { createLoadSkillTool, resolveSkillsFolder, scanSkills } from "../src/agent/skills.ts";
import { createPracticeAgent, createTeacherAgent, type PracticeAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-skills-test-"));

function skill(dir: string, header: string, body = "Do the thing.", root = tmp): string {
	const full = path.join(root, dir);
	fs.mkdirSync(full, { recursive: true });
	fs.writeFileSync(path.join(full, "SKILL.md"), `---\n${header}\n---\n\n${body}\n`);
	return full;
}

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const textOf = (r: { content: Array<{ type: string }> }) => (r.content[0] as unknown as { text: string }).text;

describe("parseSkillFile", () => {
	it("reads name, description and body", () => {
		const parsed = parseSkillFile("---\nname: chess-openings\ndescription: Use when teaching chess openings.\nlicense: MIT\n---\n\n# Body\nText");
		assert.deepEqual(parsed, { ok: true, name: "chess-openings", description: "Use when teaching chess openings.", body: "# Body\nText" });
	});

	it("accepts quoted values and folded/literal blocks", () => {
		const quoted = parseSkillFile('---\nname: "a-b"\ndescription: \'Quoted: yes\'\n---\nx');
		assert.ok(quoted.ok && quoted.name === "a-b" && quoted.description === "Quoted: yes");
		const folded = parseSkillFile("---\nname: folded\ndescription: >\n  Line one\n  line two.\n---\nx");
		assert.ok(folded.ok && folded.description === "Line one line two.");
	});

	it("rejects files without a usable header", () => {
		assert.match((parseSkillFile("# no header") as { error: string }).error, /must start/);
		assert.match((parseSkillFile("---\nname: x\n") as { error: string }).error, /closing/);
		assert.match((parseSkillFile("---\ndescription: d\n---\n") as { error: string }).error, /missing `name`/);
		assert.match((parseSkillFile("---\nname: Bad Name\ndescription: d\n---\n") as { error: string }).error, /lowercase/);
		assert.match((parseSkillFile("---\nname: ok\n---\n") as { error: string }).error, /missing `description`/);
	});
});

describe("scanSkills", () => {
	const root = path.join(tmp, "scan");
	skill("alpha", "name: alpha\ndescription: First.", "Alpha body", root);
	skill("beta", "name: beta\ndescription: Second.", "Beta body", root);
	skill("broken", "name: broken", "x", root);
	skill("dup", "name: alpha\ndescription: Same name.", "x", root);
	fs.mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
	fs.writeFileSync(path.join(root, "loose.md"), "ignored");

	it("finds skills, reports broken and duplicate ones, ignores the rest", () => {
		const result = scanSkills(root);
		assert.equal(result.exists, true);
		assert.deepEqual(result.skills.map((s) => s.name), ["alpha", "beta"]);
		assert.deepEqual(result.problems.map((p) => path.basename(p.dir)).sort(), ["broken", "dup"]);
	});

	it("reports a missing folder without throwing", () => {
		const result = scanSkills(path.join(tmp, "does-not-exist"));
		assert.equal(result.exists, false);
		assert.deepEqual(result.skills, []);
	});

	it("resolves ~ and relative paths against home", () => {
		assert.equal(resolveSkillsFolder("~"), os.homedir());
		assert.equal(resolveSkillsFolder("~/X Y"), path.join(os.homedir(), "X Y"));
		assert.equal(resolveSkillsFolder("rel"), path.join(os.homedir(), "rel"));
		assert.equal(resolveSkillsFolder(tmp), tmp);
	});
});

describe("load_skill", () => {
	const root = path.join(tmp, "load");
	const dir = skill("guide", "name: guide\ndescription: A guide.", "Follow these steps.", root);
	fs.mkdirSync(path.join(dir, "references"));
	fs.writeFileSync(path.join(dir, "references", "notes.md"), "Reference notes");
	fs.writeFileSync(path.join(root, "secret.txt"), "outside");
	fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "link.txt"));
	const tool = createLoadSkillTool(scanSkills(root).skills);

	it("returns the instructions and lists the skill's other files", async () => {
		const text = textOf(await tool.execute!("t", { name: "guide" }));
		assert.match(text, /^# Skill: guide/);
		assert.match(text, /Follow these steps\./);
		assert.match(text, /- references\/notes\.md/);
		assert.ok(!text.includes("name: guide"), "the header is not repeated");
	});

	it("reads a file inside the skill", async () => {
		assert.equal(textOf(await tool.execute!("t", { name: "guide", file: "references/notes.md" })), "Reference notes");
	});

	it("refuses paths that leave the skill folder", async () => {
		await assert.rejects(() => tool.execute!("t", { name: "guide", file: "../secret.txt" }), /inside the skill's folder/);
		await assert.rejects(() => tool.execute!("t", { name: "guide", file: "link.txt" }), /inside the skill's folder/);
		await assert.rejects(() => tool.execute!("t", { name: "guide", file: path.join(root, "secret.txt") }), /inside the skill's folder/);
	});

	it("refuses skills that are not available", async () => {
		await assert.rejects(() => tool.execute!("t", { name: "other" }), /No skill named "other".*Available: guide/);
	});
});

describe("stage switches reach the agent", () => {
	const root = path.join(tmp, "agents");
	skill("everywhere", "name: everywhere\ndescription: On for all stages.", "x", root);
	skill("teach-only", "name: teach-only\ndescription: Only while teaching.", "x", root);
	const found = scanSkills(root).skills;
	const stages = { "teach-only": { probe: false, practice: false } };

	it("the teacher sees both skills and gets load_skill", () => {
		const agent = createTeacherAgent(undefined, { engine: fauxEngine(), skills: { found, stages } });
		assert.match(agent.state.systemPrompt, /## Skills/);
		assert.match(agent.state.systemPrompt, /\*\*everywhere\*\*: On for all stages\./);
		assert.match(agent.state.systemPrompt, /\*\*teach-only\*\*/);
		assert.ok(agent.state.tools.some((t) => t.name === "load_skill"));
	});

	it("practice sees only the skills on for practice", () => {
		const agent: PracticeAgent = createPracticeAgent({} as never, { engine: fauxEngine(), tools: {}, skills: { found, stages } });
		assert.match(agent.state.systemPrompt, /\*\*everywhere\*\*/);
		assert.ok(!agent.state.systemPrompt.includes("teach-only"));
	});

	it("no skills on → no section and no tool", () => {
		const off = { everywhere: { teach: false }, "teach-only": { teach: false } };
		const agent = createTeacherAgent(undefined, { engine: fauxEngine(), skills: { found, stages: off } });
		assert.ok(!agent.state.systemPrompt.includes("## Skills"));
		assert.ok(!agent.state.tools.some((t) => t.name === "load_skill"));
	});

	it("skillOnFor: absent switch is on, only false turns a stage off", () => {
		assert.equal(skillOnFor({}, "x", "teach"), true);
		assert.equal(skillOnFor({ x: { teach: true } }, "x", "teach"), true);
		assert.equal(skillOnFor({ x: { teach: false } }, "x", "teach"), false);
		assert.equal(skillOnFor({ x: { teach: false } }, "x", "probe"), true);
	});

	it("the prompt section is empty when nothing applies", () => {
		assert.equal(skillsPromptSection([]), "");
	});
});

describe("skills settings", () => {
	it("resolves to the default folder and no switches", () => {
		assert.deepEqual(resolveSettings(null).skills, { folder: DEFAULT_SKILLS_FOLDER, stages: {} });
		assert.deepEqual(resolveSettings({ version: 1, skills: { folder: "/s", stages: { a: { teach: false } } } }).skills, { folder: "/s", stages: { a: { teach: false } } });
	});

	it("sanitizer keeps good parts and drops bad ones", () => {
		assert.deepEqual(
			sanitizeSkillsSettings({ folder: "  /s  ", stages: { good: { teach: false, bogus: true, probe: "no" }, "Bad Name": { teach: false }, empty: {} } }),
			{ folder: "/s", stages: { good: { teach: false } } },
		);
		assert.deepEqual(sanitizeUserSettings({ version: 1, skills: { folder: "/x" } })?.skills, { folder: "/x" });
	});

	it("write parser is strict", () => {
		assert.deepEqual(parseSkillsSettingsBody({ folder: "/s", stages: { a: { practice: false } } }), { ok: true, settings: { folder: "/s", stages: { a: { practice: false } } } });
		assert.equal(parseSkillsSettingsBody({ folder: 3 }).ok, false);
		assert.equal(parseSkillsSettingsBody({ stages: { a: { later: false } } }).ok, false);
		assert.equal(parseSkillsSettingsBody({ stages: { a: { teach: "off" } } }).ok, false);
		assert.equal(parseSkillsSettingsBody({ stages: { "A B": {} } }).ok, false);
		assert.equal(parseSkillsSettingsBody(null).ok, false);
	});
});
