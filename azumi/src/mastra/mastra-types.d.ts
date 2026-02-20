declare module '@mastra/core/tools' {
  export function createTool(options: {
    id: string;
    description: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    execute: (input: any) => Promise<any> | any;
    suspendSchema?: unknown;
    resumeSchema?: unknown;
    requireApproval?: boolean;
    mcp?: Record<string, unknown>;
    requestContextSchema?: unknown;
    onInputStart?: (params: Record<string, unknown>) => void;
    onInputDelta?: (params: Record<string, unknown>) => void;
    onInputAvailable?: (params: Record<string, unknown>) => void;
    onOutput?: (params: Record<string, unknown>) => void;
  }): unknown;
}

declare module '@mastra/core/agent' {
  export class Agent {
    constructor(options: Record<string, unknown>);
  }
}

declare module '@mastra/memory' {
  export class Memory {
    constructor(options?: Record<string, unknown>);
  }
}

declare module 'mysql2/promise' {
  const mysql: any;
  export default mysql;
}
