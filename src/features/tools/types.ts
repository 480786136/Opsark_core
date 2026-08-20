export interface ToolDefinition {
  id: string;
  implementation: string;
  name: string;
  description: string;
  usageInstructions: string;
  inputSchema: Record<string, unknown>;
  outputDescription: string;
  /** Controls whether this atomic tool must be the only step in a generated plan. */
  planMode?: "regular" | "standalone";
  /** Tells the generic orchestrator what to do after a successful tool call. */
  completionMode?: "continue" | "refine" | "complete";
  /** Limits automatic refinement to workflows that deliberately activated a Skill. */
  refinementScope?: "always" | "active-skill";
  /** Selects the execution adapter without branching on a concrete tool id. */
  executionMode?: "local" | "terminal" | "user-input";
  enabled: boolean;
  builtIn: boolean;
  version: number;
  updatedAt: string;
}

export interface ToolOverride {
  id: string;
  name?: string;
  description?: string;
  usageInstructions?: string;
  outputDescription?: string;
  enabled?: boolean;
  updatedAt?: string;
}

export interface ToolValidationIssue {
  field: "name" | "description" | "usageInstructions" | "outputDescription";
  message: string;
}

export interface ToolCall {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  callId: string;
  toolId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  truncated?: boolean;
}

export type UserInputFieldType = "text" | "password" | "number";

export interface UserInputField {
  key: string;
  label: string;
  description: string;
  type: UserInputFieldType;
  placeholder?: string;
  required: boolean;
}

export interface UserInputRequest {
  title: string;
  description?: string;
  fields: UserInputField[];
}

export interface UserInputResult {
  title: string;
  values: Record<string, string | number>;
}

export interface PendingUserInput extends UserInputRequest {
  taskId: string;
  stepId: string;
  callId: string;
  error?: string;
}

export interface ServerConnectRequest {
  host: string;
  port?: number;
  username?: string;
  passwordSecretKey?: string;
  credentialRef?: string;
  name?: string;
  group?: string;
}

export interface ServerConnectionLookupRequest {
  host: string;
  port?: number;
}

export interface ServerConnectionLookupResult {
  found: boolean;
  serverId?: string;
  host: string;
  port: number;
  username?: string;
  credentialAvailable: boolean;
  credentialRef?: string;
}

export interface ServerConnectResult {
  serverId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  info: Record<string, unknown>;
}

export interface FileStructureRequest {
  rootPath: string;
  excludeDirectories?: string[];
  maxDepth?: number;
  maxNodes?: number;
  includeHidden?: boolean;
}

export interface FileStructureNode {
  name: string;
  relativePath: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  children?: FileStructureNode[];
}

export interface FileStructureResult {
  rootPath: string;
  nodes: FileStructureNode[];
  excludedDirectories: string[];
  totalNodes: number;
  maxDepthReached: boolean;
  truncated: boolean;
  warnings: string[];
}

export interface ServerFileTransferRequest {
  sourcePath: string;
  targetServer: string;
  targetPath: string;
  overwrite?: boolean;
}

export interface ServerFileTransferResult {
  sourcePath: string;
  targetPath: string;
  transferredBytes: number;
  sha256: string;
  targetServerId: string;
}
