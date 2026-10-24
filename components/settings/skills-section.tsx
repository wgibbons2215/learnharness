"use client";
/**
 * Settings → Skills: where skills live, and which stages each one is on
 * for. The skill list comes from GET /api/skills (a scan of the folder);
 * the choices are the `skills` settings section.
 */

import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_SKILLS_FOLDER,
	SKILL_STAGES,
	SKILL_STAGE_LABELS,
	skillOnFor,
	type SkillStage,
	type SkillsScanResult,
	type SkillsSettings,
} from "@/src/core";
import { CommitInput, SettingsGroup, Toggle } from "./controls.tsx";

const LINK_BUTTON = "text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40";

export function SkillsSection({
	skills,
	onSectionChange,
	initialScan,
}: {
	skills: SkillsSettings | undefined;
	onSectionChange: (next: SkillsSettings) => void;
	/** Tests pass a scan so the list renders without a fetch. */
	initialScan?: SkillsScanResult;
}) {
	const folder = skills?.folder ?? "";
	const stages = skills?.stages ?? {};
	const [scan, setScan] = useState<SkillsScanResult | null>(initialScan ?? null);
	const [scanError, setScanError] = useState<string | null>(null);
	const [openError, setOpenError] = useState<string | null>(null);
	const [desktop, setDesktop] = useState(false);
	useEffect(() => setDesktop(Boolean(window.lh?.skills)), []);

	const refresh = useCallback(() => {
		setScanError(null);
		fetch("/api/skills")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: SkillsScanResult) => setScan(body))
			.catch(() => setScanError("Could not read the skills folder — try Refresh."));
	}, []);
	// Re-scan whenever the folder setting changes (and on first open).
	useEffect(() => {
		if (!initialScan) refresh();
	}, [folder, refresh, initialScan]);

	const setFolder = (next: string) => {
		const { folder: _old, ...rest } = skills ?? {};
		onSectionChange(next ? { ...rest, folder: next } : rest);
	};

	const setStage = (name: string, stage: SkillStage, on: boolean) => {
		const forSkill = { ...(stages[name] ?? {}) };
		// Absent = on, so "on" just removes the switch.
		if (on) delete forSkill[stage];
		else forSkill[stage] = false;
		const nextStages = { ...stages };
		if (Object.keys(forSkill).length) nextStages[name] = forSkill;
		else delete nextStages[name];
		onSectionChange({ ...(skills ?? {}), stages: nextStages });
	};

	const browse = async () => {
		const picked = await window.lh?.skills?.pickFolder(scan?.resolved);
		if (picked) setFolder(picked);
	};
	const openFolder = async () => {
		if (!scan) return;
		setOpenError(null);
		const err = await window.lh?.skills?.openFolder(scan.resolved);
		if (err) setOpenError(err);
		refresh();
	};

	return (
		<>
			<SettingsGroup label="Folder" testid="group-skills-folder">
				<p className="text-xs text-muted-foreground/70">
					Each skill is a folder inside this one, holding a SKILL.md file. The file starts with a header naming the skill and saying when it applies.
				</p>
				<div className="flex items-center gap-3">
					<CommitInput
						value={folder}
						placeholder={DEFAULT_SKILLS_FOLDER}
						onCommit={setFolder}
						ariaLabel="Skills folder"
						testid="skills-folder-input"
						className="w-full min-w-0 flex-1"
					/>
					{desktop && (
						<button type="button" className={LINK_BUTTON} data-testid="skills-browse" onClick={() => void browse()}>
							Browse…
						</button>
					)}
					{desktop && (
						<button type="button" className={LINK_BUTTON} data-testid="skills-open" disabled={!scan} onClick={() => void openFolder()}>
							Open folder
						</button>
					)}
					<button type="button" className={LINK_BUTTON} data-testid="skills-refresh" onClick={refresh}>
						Refresh
					</button>
				</div>
				<p className="text-xs text-muted-foreground/70" data-testid="skills-folder-status">
					{scanError
						? scanError
						: !scan
							? "Looking for skills…"
							: !scan.exists
								? `${scan.resolved} doesn't exist yet.${desktop ? " Open folder creates it." : " Create it to add skills."}`
								: `${scan.skills.length} skill${scan.skills.length === 1 ? "" : "s"} in ${scan.resolved}`}
				</p>
				{openError && <p className="text-xs text-red-500">{openError}</p>}
			</SettingsGroup>

			<SettingsGroup label="Skills" testid="group-skills-list">
				{scan && scan.skills.length === 0 && (
					<p className="text-xs text-muted-foreground/70">No skills found yet.</p>
				)}
				{scan?.skills.map((skill) => (
					<div key={skill.name} data-testid={`skill-${skill.name}`} className="flex flex-col gap-1.5 border-b border-border/40 py-2 last:border-b-0">
						<span className="font-ui text-sm text-foreground">{skill.name}</span>
						<span className="text-xs text-muted-foreground/70">{skill.description}</span>
						<div className="mt-1 flex flex-wrap gap-x-5 gap-y-1.5">
							{SKILL_STAGES.map((stage) => (
								<span key={stage} className="flex items-center gap-2 text-xs text-muted-foreground">
									<Toggle
										checked={skillOnFor(stages, skill.name, stage)}
										label={`${skill.name} ${SKILL_STAGE_LABELS[stage]}`}
										onChange={(on) => setStage(skill.name, stage, on)}
									/>
									{SKILL_STAGE_LABELS[stage]}
								</span>
							))}
						</div>
					</div>
				))}
				{scan?.problems.map((p) => (
					<div key={p.dir} data-testid="skill-problem" className="flex flex-col gap-0.5 py-1">
						<span className="font-ui text-xs text-foreground">{p.dir.split(/[\\/]/).pop()}</span>
						<span className="text-xs text-red-500">Not used: {p.error}</span>
					</div>
				))}
			</SettingsGroup>
		</>
	);
}
