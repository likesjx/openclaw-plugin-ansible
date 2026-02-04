/**
 * OpenClaw Plugin SDK Type Stubs
 *
 * These mirror the OpenClaw plugin API. When used with OpenClaw,
 * the real types from openclaw/plugin-sdk take precedence.
 */

export interface PluginTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface PluginService {
  id: string;
  start: (ctx: ServiceContext) => Promise<void>;
  stop?: (ctx: ServiceContext) => Promise<void>;
}

export interface ServiceContext {
  config: unknown;
  workspaceDir: string;
  stateDir: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug: (msg: string) => void;
  };
}

export interface PluginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
}

export interface CliRegistrarContext {
  program: CliProgram;
}

export interface CliRegistrarOptions {
  commands?: string[];
}

export interface OpenClawPluginApi {
  pluginConfig: unknown;
  logger?: PluginLogger;
  registerService: (service: PluginService) => void;
  registerTool: (tool: PluginTool) => void;
  registerCli?: (registrar: (ctx: CliRegistrarContext) => void, options?: CliRegistrarOptions) => void;
  on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => void;
}

export interface CliProgram {
  command: (name: string) => CliCommand;
}

export interface CliCommand {
  description: (desc: string) => CliCommand;
  option: (flags: string, description: string, defaultValue?: string) => CliCommand;
  action: (handler: (...args: unknown[]) => Promise<void>) => CliCommand;
  command: (name: string) => CliCommand;
}
