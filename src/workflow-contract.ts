import { readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type WorkflowContractErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_render_error'
  | 'invalid_workflow_config'

export class WorkflowContractError extends Error {
  code: WorkflowContractErrorCode

  constructor(code: WorkflowContractErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowContractError'
    this.code = code
  }
}

export type WorkflowConfigScalar = string | number | boolean | null
export type WorkflowConfigValue = WorkflowConfigScalar | WorkflowConfigValue[] | { [key: string]: WorkflowConfigValue }
export type WorkflowConfigMap = Record<string, WorkflowConfigValue>

export interface WorkflowDefinition {
  config: WorkflowConfigMap
  prompt_template: string
  path?: string
  directory?: string
}

export interface ParseWorkflowDefinitionOptions {
  path?: string
  cwd?: string
}

export interface LoadWorkflowDefinitionOptions extends ParseWorkflowDefinitionOptions {
  workflowPath?: string
}

export interface WorkflowIssueInput {
  id?: string | null
  identifier?: string | null
  title?: string | null
  description?: string | null
  body?: string | null
  priority?: number | string | null
  state?: string | null
  branch_name?: string | null
  url?: string | null
  labels?: string[]
  blocked_by?: Array<Record<string, unknown>>
  created_at?: string | null
  updated_at?: string | null
}

export interface RenderWorkflowPromptInput {
  issue: WorkflowIssueInput
  attempt?: number | null
}

export interface RenderWorkflowPromptOptions {
  defaultPrompt?: string
}

export interface ResolvedWorkflowTrackerConfig {
  kind?: string
  endpoint?: string
  api_key?: string
  project_slug?: string
  active_states: string[]
  terminal_states: string[]
}

export interface ResolvedWorkflowHooksConfig {
  after_create?: string
  before_run?: string
  after_run?: string
  before_remove?: string
  timeout_ms: number
}

export interface ResolvedWorkflowAgentConfig {
  max_concurrent_agents: number
  max_turns: number
  max_retry_backoff_ms: number
  max_concurrent_agents_by_state: Record<string, number>
}

export interface ResolvedWorkflowCodexConfig {
  command: string
  approval_policy?: WorkflowConfigValue
  thread_sandbox?: WorkflowConfigValue
  turn_sandbox_policy?: WorkflowConfigValue
  turn_timeout_ms: number
  read_timeout_ms: number
  stall_timeout_ms: number
}

export interface ResolvedWorkflowServiceConfig {
  tracker: ResolvedWorkflowTrackerConfig
  polling: {
    interval_ms: number
  }
  workspace: {
    root: string
  }
  hooks: ResolvedWorkflowHooksConfig
  agent: ResolvedWorkflowAgentConfig
  codex: ResolvedWorkflowCodexConfig
}

export interface ResolveWorkflowServiceConfigOptions {
  env?: Record<string, string | undefined>
  cwd?: string
  homeDir?: string
  tmpDir?: string
}

export interface WorkflowValidationIssue {
  code: WorkflowContractErrorCode
  path: string
  message: string
}

export interface ValidateWorkflowDispatchOptions {
  requireTracker?: boolean
  supportedTrackers?: string[]
}

interface ParsedLine {
  indent: number
  content: string
  raw: string
}

const defaultActiveStates = ['Todo', 'In Progress']
const defaultTerminalStates = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']
const defaultLinearEndpoint = 'https://api.linear.app/graphql'

function contractError(code: WorkflowContractErrorCode, message: string): WorkflowContractError {
  return new WorkflowContractError(code, message)
}

function countIndent(line: string): number {
  let count = 0
  while (line[count] === ' ') count += 1
  return count
}

function stripInlineComment(value: string): string {
  let quote: string | undefined
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote || char
    }
    if (!quote && char === '#') return value.slice(0, index).trimEnd()
  }
  return value
}

function splitFrontMatter(content: string): { frontmatter?: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { body: normalized.trim() }

  const lines = normalized.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      return {
        frontmatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n').trim(),
      }
    }
  }

  throw contractError('workflow_parse_error', 'Workflow front matter starts with --- but has no closing --- marker.')
}

function parseScalar(value: string): WorkflowConfigValue {
  const trimmed = stripInlineComment(value.trim())
  if (trimmed === '') return ''
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineList(inner).map(parseScalar)
  }

  return trimmed
}

function splitInlineList(value: string): string[] {
  const parts: string[] = []
  let quote: string | undefined
  let start = 0

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote || char
    }
    if (!quote && char === ',') {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }

  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function toParsedLines(frontmatter: string): ParsedLine[] {
  return frontmatter
    .replace(/\t/g, '  ')
    .split('\n')
    .map((raw) => ({ raw, indent: countIndent(raw), content: raw.trim() }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith('#'))
}

function parseBlockScalar(lines: ParsedLine[], startIndex: number, parentIndent: number): { value: string; nextIndex: number } {
  const collected: ParsedLine[] = []
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent <= parentIndent) break
    collected.push(line)
    index += 1
  }

  const blockIndent = collected
    .filter((line) => line.content.length > 0)
    .reduce((min, line) => Math.min(min, line.indent), Number.POSITIVE_INFINITY)

  const trimIndent = Number.isFinite(blockIndent) ? blockIndent : parentIndent + 2
  const value = collected
    .map((line) => line.raw.slice(Math.min(trimIndent, line.raw.length)))
    .join('\n')
    .replace(/\n+$/, '')

  return { value, nextIndex: index }
}

function parseSequence(lines: ParsedLine[], startIndex: number, indent: number): { value: WorkflowConfigValue[]; nextIndex: number } {
  const values: WorkflowConfigValue[] = []
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw contractError('workflow_parse_error', `Unexpected nested sequence content: ${line.raw}`)
    }
    if (!line.content.startsWith('- ')) break

    const item = line.content.slice(2).trim()
    if (!item) {
      const nested = parseYamlBlock(lines, index + 1, indent + 2)
      values.push(nested.value)
      index = nested.nextIndex
      continue
    }

    values.push(parseScalar(item))
    index += 1
  }

  return { value: values, nextIndex: index }
}

function parseYamlBlock(lines: ParsedLine[], startIndex: number, indent: number): { value: WorkflowConfigValue; nextIndex: number } {
  if (startIndex >= lines.length) return { value: {}, nextIndex: startIndex }
  const first = lines[startIndex]!
  if (first.indent < indent) return { value: {}, nextIndex: startIndex }
  if (first.indent === indent && first.content.startsWith('- ')) return parseSequence(lines, startIndex, indent)

  const result: WorkflowConfigMap = {}
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw contractError('workflow_parse_error', `Unexpected indentation in workflow front matter: ${line.raw}`)
    }
    if (line.content.startsWith('- ')) break

    const separator = line.content.indexOf(':')
    if (separator <= 0) {
      throw contractError('workflow_parse_error', `Invalid workflow front matter line: ${line.raw}`)
    }

    const key = line.content.slice(0, separator).trim()
    const rawValue = line.content.slice(separator + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw contractError('workflow_parse_error', `Invalid workflow front matter key: ${key}`)
    }

    if (rawValue === '|' || rawValue === '|-' || rawValue === '|+') {
      const block = parseBlockScalar(lines, index + 1, indent)
      result[key] = block.value
      index = block.nextIndex
      continue
    }

    if (rawValue === '') {
      const nested = parseYamlBlock(lines, index + 1, indent + 2)
      result[key] = nested.value
      index = nested.nextIndex
      continue
    }

    result[key] = parseScalar(rawValue)
    index += 1
  }

  return { value: result, nextIndex: index }
}

function parseFrontMatter(frontmatter: string): WorkflowConfigMap {
  const lines = toParsedLines(frontmatter)
  if (lines.length === 0) return {}
  const parsed = parseYamlBlock(lines, 0, lines[0]!.indent).value
  if (!isRecord(parsed)) {
    throw contractError('workflow_front_matter_not_a_map', 'Workflow front matter must decode to a map/object.')
  }
  return parsed as WorkflowConfigMap
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: WorkflowConfigValue | undefined): Record<string, WorkflowConfigValue> {
  return isRecord(value) ? value as Record<string, WorkflowConfigValue> : {}
}

function stringValue(value: WorkflowConfigValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function intValue(value: WorkflowConfigValue | undefined, fallback: number, options: { min?: number } = {}): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : fallback
  if (!Number.isInteger(numeric)) return fallback
  if (options.min !== undefined && numeric < options.min) return fallback
  return numeric
}

function stringList(value: WorkflowConfigValue | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const items = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  return items.length > 0 ? items : [...fallback]
}

function stringMapPositiveInts(value: WorkflowConfigValue | undefined): Record<string, number> {
  const map = asRecord(value)
  const output: Record<string, number> = {}
  for (const [key, rawValue] of Object.entries(map)) {
    const value = intValue(rawValue, 0, { min: 1 })
    if (value > 0) output[key.toLowerCase()] = value
  }
  return output
}

function resolveEnvRef(value: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!value) return value
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)
  if (!match) return value
  const resolved = env[match[1]!]
  return resolved && resolved.length > 0 ? resolved : undefined
}

function resolvePathValue(
  value: string | undefined,
  fallback: string,
  options: {
    env: Record<string, string | undefined>
    baseDir: string
    homeDir: string
  },
): string {
  let candidate = resolveEnvRef(value, options.env) || fallback
  if (candidate === '~') {
    candidate = options.homeDir
  } else if (candidate.startsWith('~/')) {
    candidate = join(options.homeDir, candidate.slice(2))
  }
  return isAbsolute(candidate) ? resolve(candidate) : resolve(options.baseDir, candidate)
}

function defaultWorkflowPrompt(issue: WorkflowIssueInput): string {
  const identifier = issue.identifier || issue.id || 'the issue'
  const description = issue.description ?? issue.body ?? ''
  return [
    `You are working on ${identifier}.`,
    '',
    `Title: ${issue.title || 'Untitled issue'}`,
    description ? `Description: ${description}` : undefined,
  ].filter(Boolean).join('\n')
}

function formatTemplateValue(value: unknown): string {
  if (value === undefined) {
    throw contractError('template_render_error', 'Unknown workflow template value.')
  }
  if (value === null) return ''
  if (Array.isArray(value)) return value.map(formatTemplateValue).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function resolveTemplateValue(context: Record<string, unknown>, expression: string): unknown {
  const parts = expression.split('.')
  let current: unknown = context
  for (const part of parts) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      throw contractError('template_render_error', `Invalid workflow template expression: ${expression}`)
    }
    if (!isRecord(current) || !(part in current)) {
      throw contractError('template_render_error', `Unknown workflow template variable: ${expression}`)
    }
    current = current[part]
  }
  return current
}

function applyTemplateFilter(value: unknown, filter: string): unknown {
  const name = filter.trim()
  if (name === 'json') return JSON.stringify(value)
  throw contractError('template_render_error', `Unknown workflow template filter: ${name}`)
}

export function parseWorkflowDefinition(content: string, options: ParseWorkflowDefinitionOptions = {}): WorkflowDefinition {
  const { frontmatter, body } = splitFrontMatter(content)
  const path = options.path
  return {
    config: frontmatter === undefined ? {} : parseFrontMatter(frontmatter),
    prompt_template: body.trim(),
    path,
    directory: path ? dirname(resolve(path)) : options.cwd ? resolve(options.cwd) : undefined,
  }
}

export async function loadWorkflowDefinition(options: LoadWorkflowDefinitionOptions = {}): Promise<WorkflowDefinition> {
  const cwd = resolve(options.cwd || process.cwd())
  const workflowPath = resolve(options.workflowPath || options.path || join(cwd, 'WORKFLOW.md'))
  try {
    const content = await readFile(workflowPath, 'utf-8')
    return parseWorkflowDefinition(content, { ...options, path: workflowPath, cwd })
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw contractError('missing_workflow_file', `Workflow file not found: ${workflowPath}`)
    }
    if (error instanceof WorkflowContractError) throw error
    throw contractError('workflow_parse_error', error?.message || String(error))
  }
}

export function renderWorkflowPrompt(
  definition: WorkflowDefinition,
  input: RenderWorkflowPromptInput,
  options: RenderWorkflowPromptOptions = {},
): string {
  const template = definition.prompt_template.trim()
  if (!template) return options.defaultPrompt || defaultWorkflowPrompt(input.issue)

  const context = {
    issue: input.issue,
    attempt: input.attempt ?? null,
  }

  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, rawExpression: string) => {
    const [path, ...filters] = rawExpression.split('|').map((part) => part.trim()).filter(Boolean)
    if (!path) throw contractError('template_render_error', 'Empty workflow template expression.')
    let value = resolveTemplateValue(context, path)
    for (const filter of filters) value = applyTemplateFilter(value, filter)
    return formatTemplateValue(value)
  })
}

export function resolveWorkflowServiceConfig(
  definition: WorkflowDefinition,
  options: ResolveWorkflowServiceConfigOptions = {},
): ResolvedWorkflowServiceConfig {
  const env = options.env || process.env
  const baseDir = definition.directory || (definition.path ? dirname(resolve(definition.path)) : resolve(options.cwd || process.cwd()))
  const homeDir = options.homeDir || homedir()
  const tempRoot = options.tmpDir || tmpdir()
  const tracker = asRecord(definition.config.tracker)
  const polling = asRecord(definition.config.polling)
  const workspace = asRecord(definition.config.workspace)
  const hooks = asRecord(definition.config.hooks)
  const agent = asRecord(definition.config.agent)
  const codex = asRecord(definition.config.codex)
  const trackerKind = stringValue(tracker.kind)

  return {
    tracker: {
      kind: trackerKind,
      endpoint: stringValue(tracker.endpoint) || (trackerKind === 'linear' ? defaultLinearEndpoint : undefined),
      api_key: resolveEnvRef(stringValue(tracker.api_key), env) || (trackerKind === 'linear' ? env.LINEAR_API_KEY : undefined),
      project_slug: stringValue(tracker.project_slug),
      active_states: stringList(tracker.active_states, defaultActiveStates),
      terminal_states: stringList(tracker.terminal_states, defaultTerminalStates),
    },
    polling: {
      interval_ms: intValue(polling.interval_ms, 30_000, { min: 1 }),
    },
    workspace: {
      root: resolvePathValue(stringValue(workspace.root), join(tempRoot, 'clavue_agent_workspaces'), { env, baseDir, homeDir }),
    },
    hooks: {
      after_create: stringValue(hooks.after_create),
      before_run: stringValue(hooks.before_run),
      after_run: stringValue(hooks.after_run),
      before_remove: stringValue(hooks.before_remove),
      timeout_ms: intValue(hooks.timeout_ms, 60_000, { min: 1 }),
    },
    agent: {
      max_concurrent_agents: intValue(agent.max_concurrent_agents, 10, { min: 1 }),
      max_turns: intValue(agent.max_turns, 20, { min: 1 }),
      max_retry_backoff_ms: intValue(agent.max_retry_backoff_ms, 300_000, { min: 1 }),
      max_concurrent_agents_by_state: stringMapPositiveInts(agent.max_concurrent_agents_by_state),
    },
    codex: {
      command: stringValue(codex.command) || 'codex app-server',
      approval_policy: codex.approval_policy,
      thread_sandbox: codex.thread_sandbox,
      turn_sandbox_policy: codex.turn_sandbox_policy,
      turn_timeout_ms: intValue(codex.turn_timeout_ms, 3_600_000, { min: 1 }),
      read_timeout_ms: intValue(codex.read_timeout_ms, 5_000, { min: 1 }),
      stall_timeout_ms: intValue(codex.stall_timeout_ms, 300_000),
    },
  }
}

export function validateWorkflowDispatchConfig(
  config: ResolvedWorkflowServiceConfig,
  options: ValidateWorkflowDispatchOptions = {},
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  const supportedTrackers = options.supportedTrackers || ['linear']

  if (options.requireTracker || config.tracker.kind) {
    if (!config.tracker.kind) {
      issues.push({ code: 'invalid_workflow_config', path: 'tracker.kind', message: 'tracker.kind is required for dispatch.' })
    } else if (!supportedTrackers.includes(config.tracker.kind)) {
      issues.push({ code: 'invalid_workflow_config', path: 'tracker.kind', message: `Unsupported tracker kind: ${config.tracker.kind}` })
    }
  }

  if (config.tracker.kind === 'linear') {
    if (!config.tracker.api_key) {
      issues.push({ code: 'invalid_workflow_config', path: 'tracker.api_key', message: 'tracker.api_key or LINEAR_API_KEY is required for Linear dispatch.' })
    }
    if (!config.tracker.project_slug) {
      issues.push({ code: 'invalid_workflow_config', path: 'tracker.project_slug', message: 'tracker.project_slug is required for Linear dispatch.' })
    }
  }

  if (!config.codex.command.trim()) {
    issues.push({ code: 'invalid_workflow_config', path: 'codex.command', message: 'codex.command must not be empty.' })
  }

  return issues
}

export function normalizeWorkflowState(state: string): string {
  return state.trim().toLowerCase()
}

export function normalizeWorkspaceKey(identifier: string): string {
  const key = identifier.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_')
  return key || 'issue'
}

export function getWorkflowWorkspacePath(config: Pick<ResolvedWorkflowServiceConfig, 'workspace'>, issueIdentifier: string): string {
  return resolve(config.workspace.root, normalizeWorkspaceKey(issueIdentifier))
}
