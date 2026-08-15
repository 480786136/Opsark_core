export interface ToolDefinition {
  id: string;
  implementation: string;
  name: string;
  description: string;
  usageInstructions: string;
  inputSchema: Record<string, unknown>;
  outputDescription: string;
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
