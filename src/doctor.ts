import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorOptions,
  DoctorReport,
  ToolDefinition,
} from './types.js'
import { applyRuntimeProfile } from './runtime-profiles.js'
import { getAllBaseTools, filterTools, getToolsetTools, isToolsetName } from './tools/index.js'
import { initBundledSkills, getUserInvocableSkills } from './skills/index.js'
import { getMemoryStoreInfo } from './memory.js'
import { listSessions } from './session.js'
import { listAgentJobs } from './agent-jobs.js'
import { isSdkServerConfig } from './sdk-mcp-server.js'
import type { ApiType } from './providers/index.js'
import { getModelCapabilities } from './providers/index.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const resolvedOptions = applyRuntimeProfile(options)
  const cwd = resolvedOptions.cwd || process.cwd()
  if (resolvedOptions.initializeBundledSkills !== false) initBundledSkills()

  const checks: DoctorCheck[] = []
  checks.push(checkProvider(resolvedOptions))
  checks.push(checkTools(resolvedOptions))
  checks.push(checkSkills())
  checks.push(...checkMcp(resolvedOptions))
  checks.push(await checkSessionStorage(resolvedOptions))
  checks.push(await checkMemoryStorage(resolvedOptions))
  checks.push(await checkAgentJobStorage(resolvedOptions))
  checks.push(...await checkPackageEntrypoints(resolvedOptions))

  const summary = summarizeChecks(checks)
  return {
    status: summary.error > 0 ? 'error' : summary.warn > 0 ? 'warn' : 'ok',
    checked_at: new Date().toISOString(),
    cwd,
    summary,
    checks,
  }
}

function checkProvider(options: DoctorOptions): DoctorCheck {
  const env = options.env ?? process.env
  const model = options.model ?? env.CLAVUE_AGENT_MODEL ?? 'claude-sonnet-4-6'
  const apiType = resolveApiType(options.apiType, model, env.CLAVUE_AGENT_API_TYPE)
  const capabilities = apiType ? getModelCapabilities(model, { apiType }) : undefined
  const apiKey = options.apiKey ?? env.CLAVUE_AGENT_API_KEY ?? env.CLAVUE_AGENT_AUTH_TOKEN
  const baseURL = options.baseURL ?? env.CLAVUE_AGENT_BASE_URL

  if (!apiType) {
    return {
      name: 'provider.config',
      category: 'provider',
      status: 'error',
      message: 'Unsupported CLAVUE_AGENT_API_TYPE. Use anthropic-messages or openai-completions.',
      details: { configuredApiType: options.apiType ?? env.CLAVUE_AGENT_API_TYPE },
    }
  }

  if (!apiKey) {
    return {
      name: 'provider.credentials',
      category: 'provider',
      status: 'warn',
      message: 'No API key configured. Set CLAVUE_AGENT_API_KEY or pass apiKey before making provider calls.',
      details: { apiType, model, capabilities, baseURLConfigured: Boolean(baseURL) },
    }
  }

  return {
    name: 'provider.credentials',
    category: 'provider',
    status: 'ok',
    message: 'Provider configuration is present.',
    details: { apiType, model, capabilities, baseURLConfigured: Boolean(baseURL) },
  }
}

function resolveApiType(
  explicit: ApiType | undefined,
  model: string,
  envType: string | undefined,
): ApiType | null {
  if (explicit) return explicit
  if (envType === 'openai-completions' || envType === 'anthropic-messages') return envType
  if (envType) return null

  return getModelCapabilities(model).apiType
}

function checkTools(options: DoctorOptions): DoctorCheck {
  const tools = resolveTools(options)
  const toolNames = tools.map((tool) => tool.name)
  const duplicateNames = findDuplicates(toolNames)
  const unknownToolsets = (options.toolsets || []).filter((toolset) => !isToolsetName(toolset))
  const available = new Set(getAllBaseTools().map((tool) => tool.name))
  const unknownRequestedTools = Array.isArray(options.tools) && options.tools.length > 0 && typeof options.tools[0] === 'string'
    ? (options.tools as string[]).filter((name) => !available.has(name))
    : []
  const unknownAllowedTools = (options.allowedTools || []).filter((name) => !available.has(name))
  const unknownDisallowedTools = (options.disallowedTools || []).filter((name) => !available.has(name))

  if (unknownToolsets.length > 0) {
    return {
      name: 'tools.registry',
      category: 'tools',
      status: 'error',
      message: 'One or more configured toolsets are not recognized.',
      details: { unknownToolsets, toolCount: tools.length },
    }
  }

  if (duplicateNames.length > 0) {
    return {
      name: 'tools.registry',
      category: 'tools',
      status: 'error',
      message: 'Tool names must be unique.',
      details: { duplicateNames, toolCount: tools.length },
    }
  }

  if (unknownRequestedTools.length > 0 || unknownAllowedTools.length > 0 || unknownDisallowedTools.length > 0) {
    return {
      name: 'tools.registry',
      category: 'tools',
      status: 'warn',
      message: 'Some configured tool names do not match built-in tools.',
      details: { unknownRequestedTools, unknownAllowedTools, unknownDisallowedTools, toolCount: tools.length },
    }
  }

  return {
    name: 'tools.registry',
    category: 'tools',
    status: 'ok',
    message: `Resolved ${tools.length} tool(s).`,
    details: { toolCount: tools.length, tools: toolNames },
  }
}

function resolveTools(options: DoctorOptions): ToolDefinition[] {
  const raw = options.tools
  let tools: ToolDefinition[]

  if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw)) {
    tools = getAllBaseTools()
  } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    tools = filterTools(getAllBaseTools(), raw as string[])
  } else {
    tools = raw as ToolDefinition[]
  }

  const toolsetTools = getToolsetTools(options.toolsets)
  const allowedTools = toolsetTools.length > 0
    ? [...new Set([...toolsetTools, ...(options.allowedTools ?? [])])]
    : options.allowedTools

  return filterTools(tools, allowedTools, options.disallowedTools)
}

function checkSkills(): DoctorCheck {
  const skills = getUserInvocableSkills()
  return {
    name: 'skills.registry',
    category: 'skills',
    status: skills.length > 0 ? 'ok' : 'warn',
    message: skills.length > 0
      ? `Registered ${skills.length} user-invocable skill(s).`
      : 'No user-invocable skills are registered.',
    details: { skillCount: skills.length, skills: skills.map((skill) => skill.name) },
  }
}

function checkMcp(options: DoctorOptions): DoctorCheck[] {
  const entries = Object.entries(options.mcpServers || {})
  if (entries.length === 0) {
    return [{
      name: 'mcp.config',
      category: 'mcp',
      status: 'skipped',
      message: 'No MCP servers configured.',
    }]
  }

  return entries.map(([name, config]) => {
    if (isSdkServerConfig(config)) {
      return {
        name: `mcp.${name}`,
        category: 'mcp',
        status: 'ok',
        message: 'In-process SDK MCP server is configured.',
        details: { type: 'sdk', toolCount: config.tools.length },
      }
    }

    if (!config || typeof config !== 'object') {
      return {
        name: `mcp.${name}`,
        category: 'mcp',
        status: 'error',
        message: 'MCP server config must be an object.',
      }
    }

    if (!config.type || config.type === 'stdio') {
      return {
        name: `mcp.${name}`,
        category: 'mcp',
        status: config.command ? 'ok' : 'error',
        message: config.command
          ? 'MCP stdio server command is configured.'
          : 'MCP stdio server requires a command.',
        details: { type: 'stdio' },
      }
    }

    if (config.type === 'sse' || config.type === 'http') {
      return {
        name: `mcp.${name}`,
        category: 'mcp',
        status: config.url ? 'ok' : 'error',
        message: config.url
          ? `MCP ${config.type} server URL is configured.`
          : `MCP ${config.type} server requires a URL.`,
        details: { type: config.type },
      }
    }

    return {
      name: `mcp.${name}`,
      category: 'mcp',
      status: 'error',
      message: `Unsupported MCP transport type: ${config.type}`,
      details: { type: config.type },
    }
  })
}

async function checkSessionStorage(options: DoctorOptions): Promise<DoctorCheck> {
  try {
    const sessions = await listSessions(options.session)
    return {
      name: 'storage.sessions',
      category: 'storage',
      status: 'ok',
      message: 'Session storage is readable.',
      details: { count: sessions.length, dir: options.session?.dir ?? 'default' },
    }
  } catch (err: any) {
    return storageError('storage.sessions', 'Session storage is not readable.', err)
  }
}

async function checkMemoryStorage(options: DoctorOptions): Promise<DoctorCheck> {
  if (options.memory?.enabled === false) {
    return {
      name: 'storage.memory',
      category: 'storage',
      status: 'skipped',
      message: 'Memory is disabled.',
    }
  }

  try {
    const info = await getMemoryStoreInfo({ dir: options.memory?.dir })
    return {
      name: 'storage.memory',
      category: 'storage',
      status: 'ok',
      message: 'Memory storage is readable and writable.',
      details: info,
    }
  } catch (err: any) {
    return storageError('storage.memory', 'Memory storage is not writable.', err)
  }
}

async function checkAgentJobStorage(options: DoctorOptions): Promise<DoctorCheck> {
  try {
    if (options.agentJobs?.dir) await mkdir(options.agentJobs.dir, { recursive: true })
    const jobs = await listAgentJobs({
      dir: options.agentJobs?.dir,
      runtimeNamespace: options.agentJobs?.runtimeNamespace ?? options.runtimeNamespace,
      staleAfterMs: options.agentJobs?.staleAfterMs,
    })
    const staleJobs = jobs.filter((job) => job.status === 'stale')
    const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running')
    return {
      name: 'storage.agentJobs',
      category: 'storage',
      status: staleJobs.length > 0 ? 'warn' : 'ok',
      message: staleJobs.length > 0
        ? 'Agent job storage is readable, but stale jobs require inspection or replay.'
        : 'Agent job storage is readable.',
      details: {
        count: jobs.length,
        dir: options.agentJobs?.dir ?? 'default',
        stale_count: staleJobs.length,
        active_count: activeJobs.length,
        stale_jobs: staleJobs.map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          updated_at: job.updatedAt,
          heartbeat_at: job.heartbeatAt,
          runner_id: job.runnerId,
          error: job.error,
        })),
      },
    }
  } catch (err: any) {
    return storageError('storage.agentJobs', 'Agent job storage is not readable.', err)
  }
}

function storageError(name: string, message: string, err: any): DoctorCheck {
  return {
    name,
    category: 'storage',
    status: 'error',
    message,
    details: { error: err?.message || String(err) },
  }
}

async function checkPackageEntrypoints(options: DoctorOptions): Promise<DoctorCheck[]> {
  if (options.checkPackageEntrypoints === false) {
    return [{
      name: 'package.entrypoints',
      category: 'package',
      status: 'skipped',
      message: 'Package entrypoint checks are disabled.',
    }]
  }

  const root = options.packageRoot || packageRoot
  const files = ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js']
  const missing: string[] = []
  for (const file of files) {
    try {
      await access(join(root, file))
    } catch {
      missing.push(file)
    }
  }

  return [{
    name: 'package.entrypoints',
    category: 'package',
    status: missing.length > 0 ? 'warn' : 'ok',
    message: missing.length > 0
      ? 'Some compiled package entrypoints are missing. Run npm run build before packing or publishing.'
      : 'Compiled package entrypoints are present.',
    details: { packageRoot: root, missing },
  }]
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorCheckStatus, number> {
  const summary: Record<DoctorCheckStatus, number> = {
    ok: 0,
    warn: 0,
    error: 0,
    skipped: 0,
  }
  for (const check of checks) summary[check.status]++
  return summary
}
