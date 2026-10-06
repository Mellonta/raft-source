import { Badge, Button, InlineCode } from "raft-ui";
import { useState, useEffect, useRef } from "react";
import { Globe, FolderOpen, RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import apiClient from "../../api/client";
import type { SkillInfo } from "@botiverse/raft-shared";
import SurfaceListItem from "../ui/SurfaceListItem";
import SectionHeader from "../ui/SectionHeader";

interface SkillsData {
  global: SkillInfo[];
  workspace: SkillInfo[];
}

function SkillCard({ skill }: { skill: SkillInfo }) {
  return (
    <SurfaceListItem>
      <div className="flex items-center gap-2">
        <span className="font-bold text-sm text-foreground-strong theme-brutal:text-black">{skill.displayName}</span>
        {skill.userInvocable && (
          <Badge appearance="soft" variant="success" uppercase className="text-[10px]">
            /{skill.name}
          </Badge>
        )}
      </div>
      {skill.description && (
        <p className="text-xs text-foreground-muted theme-brutal:text-black/60 mt-1 line-clamp-2">{skill.description}</p>
      )}
    </SurfaceListItem>
  );
}

function groupByPath(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const groups = new Map<string, SkillInfo[]>();
  for (const skill of skills) {
    const key = skill.sourcePath || "unknown";
    const list = groups.get(key) || [];
    list.push(skill);
    groups.set(key, list);
  }
  return groups;
}

function PathGroup({ path, skills }: { path: string; skills: SkillInfo[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <InlineCode className="text-[11px] text-foreground-placeholder theme-brutal:text-black/40">{path}</InlineCode>
        <span className="text-[11px] text-foreground-placeholder theme-brutal:text-black/30 font-mono">({skills.length})</span>
      </div>
      <div className="space-y-2">
        {skills.map((skill) => (
          <SkillCard key={skill.name} skill={skill} />
        ))}
      </div>
    </div>
  );
}

function SkillSubSection({ label, icon: Icon, skills, emptyText }: {
  label: string;
  icon: typeof Globe;
  skills: SkillInfo[];
  emptyText: string;
}) {
  const groups = groupByPath(skills);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={12} className="text-foreground-placeholder theme-brutal:text-black/40" />
        <span className="text-xs text-foreground-muted theme-brutal:text-black/50 font-medium">
          {label}
        </span>
        <span className="text-xs text-foreground-placeholder theme-brutal:text-black/30 font-mono">({skills.length})</span>
      </div>
      {skills.length > 0 ? (
        <div className="space-y-4">
          {[...groups.entries()].map(([path, pathSkills]) => (
            <PathGroup key={path} path={path} skills={pathSkills} />
          ))}
        </div>
      ) : (
        <p className="text-xs italic text-foreground-placeholder theme-brutal:text-black/40">{emptyText}</p>
      )}
    </div>
  );
}

export default function AgentSkills({ agentId, embedded }: { agentId: string; embedded?: boolean }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [data, setData] = useState<SkillsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSkills = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<SkillsData>(`/agents/${agentId}/skills`);
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessageRef.current({ id: "agent.skills.loadFailed" }));
    } finally {
      setLoading(false);
    }
  };

  // oxlint-disable react-hooks/exhaustive-deps -- fetch skills only when the agent id changes; `fetchSkills` is recreated each render and closes over the current `agentId`, so depending on it would refetch every render.
  // Async-loader pattern: `loading` is a transient async-fetch indicator, not
  // prop-derived state. Same FP family as AgentDetailPanel L228.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state
    fetchSkills();
  }, [agentId]);
  // oxlint-enable react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className={embedded ? "px-5 py-4" : "flex flex-1 items-center justify-center bg-layer-panel theme-brutal:bg-white"}>
        <span className="text-sm text-foreground-placeholder theme-brutal:text-black/40 font-mono">{formatMessage({ id: "agent.skills.loading" })}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={embedded ? "px-5 py-4 flex flex-col items-center gap-3" : "flex flex-1 flex-col items-center justify-center gap-3 bg-layer-panel theme-brutal:bg-white"}>
        <span className="text-sm text-foreground-muted theme-brutal:text-black/60 font-mono">{error}</span>
        <Button variant="outline" size="sm" onClick={fetchSkills} className="flex items-center gap-1">
          <RefreshCw size={12} />
          {formatMessage({ id: "agent.skills.retry" })}
        </Button>
      </div>
    );
  }

  const totalSkills = (data?.global?.length || 0) + (data?.workspace?.length || 0);

  return (
    <div className={embedded ? "" : "flex-1 overflow-y-auto bg-layer-panel theme-brutal:bg-white"}>
      <div className="px-5 py-4">
        {/* Same header + count format as the other profile sections; when there
            are no skills at all, the header's 0 is the whole section. */}
        <SectionHeader
          className={totalSkills > 0 ? "mb-3" : undefined}
          label={formatMessage({ id: "agent.skills.heading" })}
          count={totalSkills}
        />
        {totalSkills > 0 && (
        <div className="space-y-4">
          <SkillSubSection
            label={formatMessage({ id: "agent.skills.global" })}
            icon={Globe}
            skills={data?.global || []}
            emptyText={formatMessage({ id: "agent.skills.globalEmpty" })}
          />
          <SkillSubSection
            label={formatMessage({ id: "agent.skills.workspace" })}
            icon={FolderOpen}
            skills={data?.workspace || []}
            emptyText={formatMessage({ id: "agent.skills.workspaceEmpty" })}
          />
        </div>
        )}
      </div>
    </div>
  );
}
