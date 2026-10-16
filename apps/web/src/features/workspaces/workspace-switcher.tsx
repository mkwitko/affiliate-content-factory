export type WorkspaceOption = Readonly<{
  id: string;
  name: string;
  role: "owner" | "operator" | "reviewer";
}>;

type WorkspaceSwitcherProps = Readonly<{
  workspaces: readonly WorkspaceOption[];
  selectedWorkspaceId: string | undefined;
  onChange: (workspaceId: string) => void;
}>;

const roleLabels: Readonly<Record<WorkspaceOption["role"], string>> = {
  owner: "dono",
  operator: "operador",
  reviewer: "revisor",
};

export const WorkspaceSwitcher = ({
  workspaces,
  selectedWorkspaceId,
  onChange,
}: WorkspaceSwitcherProps) => (
  <label className="workspace-switcher">
    <span>Espaço de trabalho</span>
    <select
      aria-label="Espaço de trabalho"
      value={selectedWorkspaceId ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name} — {roleLabels[workspace.role]}
        </option>
      ))}
    </select>
  </label>
);
