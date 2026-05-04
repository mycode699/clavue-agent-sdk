#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { readFile } from 'node:fs/promises'

import { query, run } from './agent.js'
import {
  createIssueWorkflowRun,
  listIssueWorkflowRuns,
  loadIssueWorkflowRun,
  normalizeIssueInput,
  runIssueWorkflow,
  stopIssueWorkflowRun,
} from './issue-workflow.js'
import type { AgentOptions, ToolsetName } from './types.js'
import { formatImageBlockForText } from './utils/messages.js'
import { isToolsetName } from './tools/index.js'
import { parseCommaSeparatedList } from './utils/parsing.js'

function printHelp(): void {
  console.log(`Clavue Agent SDK CLI

Usage:
  npx clavue-agent-sdk "Read package.json and summarize it"
  npx clavue-agent-sdk --prompt "Review src for obvious bugs" --allow Read,Glob,Grep
  npx clavue-agent-sdk --autonomy autonomous --permission-mode acceptEdits --toolset repo-edit "Update docs"
  npx clavue-agent-sdk issue execute .clavue/issues/p0.md --max-iterations 3 --json

Options:
  -p, --prompt <text>       Prompt to send to the agent
  -m, --model <id>          Model ID (defaults to CLAVUE_AGENT_MODEL or claude-sonnet-4-6)
  --api-type <type>         anthropic-messages or openai-completions (defaults to model inference)
  --api-key <key>           API key (defaults to CLAVUE_AGENT_API_KEY or CLAVUE_AGENT_AUTH_TOKEN)
  --base-url <url>          API base URL (defaults to CLAVUE_AGENT_BASE_URL)
  --cwd <path>              Working directory (defaults to current directory)
  --max-turns <number>      Maximum agentic turns (default: 10)
  --autonomy <mode>         supervised, proactive, or autonomous
  --permission-mode <mode>  trustedAutomation, auto, default, acceptEdits, dontAsk, bypassPermissions, or plan
  --allow <tools>           Comma-separated allow-list, e.g. Read,Glob,Grep
  --toolset <names>         Comma-separated toolsets, e.g. repo-readonly,research
  --deny <tools>            Comma-separated deny-list, e.g. Bash,Write,Edit
  --self-improvement        Save bounded improvement memories after the run
  --json                    Print the final run artifact as JSON
  -h, --help                Show this help

Issue workflow:
  issue run <text-or-path>      Create builder/reviewer/verifier jobs for an issue
  issue execute <text-or-path>  Execute a bounded local issue workflow loop
  issue list                    List local issue workflow runs
  issue get <run-id>            Show one issue workflow run
  issue stop <run-id>           Stop a workflow run and its jobs

Environment:
  CLAVUE_AGENT_API_KEY      API key
  CLAVUE_AGENT_AUTH_TOKEN   API key fallback
  CLAVUE_AGENT_API_TYPE     anthropic-messages or openai-completions
  CLAVUE_AGENT_MODEL        Default model
  CLAVUE_AGENT_BASE_URL     Custom API endpoint
  CLAVUE_AGENT_AUTONOMY     supervised, proactive, or autonomous
  CLAVUE_AGENT_PERMISSION_MODE  trustedAutomation, auto, default, acceptEdits, dontAsk, bypassPermissions, or plan
  CLAVUE_AGENT_SELF_IMPROVEMENT  Set to 1/true/yes to enable run learning
`)
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function readApiType(value: string): AgentOptions['apiType'] {
  if (value === 'anthropic-messages' || value === 'openai-completions') {
    return value
  }
  throw new Error('--api-type must be anthropic-messages or openai-completions')
}

function readAutonomyMode(value: string): AgentOptions['autonomyMode'] {
  if (value === 'supervised' || value === 'proactive' || value === 'autonomous') {
    return value
  }
  throw new Error('--autonomy must be supervised, proactive, or autonomous')
}

function readPermissionMode(value: string): AgentOptions['permissionMode'] {
  if (
    value === 'trustedAutomation' ||
    value === 'auto' ||
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'dontAsk' ||
    value === 'bypassPermissions' ||
    value === 'plan'
  ) {
    return value
  }
  throw new Error('--permission-mode must be trustedAutomation, auto, default, acceptEdits, dontAsk, bypassPermissions, or plan')
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function readToolsets(value: string): ToolsetName[] {
  const toolsets: ToolsetName[] = []
  for (const toolset of parseCommaSeparatedList(value)) {
    if (!isToolsetName(toolset)) {
      throw new Error(`Unknown toolset: ${toolset}`)
    }
    toolsets.push(toolset)
  }
  return toolsets
}

function applySelfImprovementDefaults(options: AgentOptions): void {
  if (!options.selfImprovement) return

  options.memory = {
    ...options.memory,
    enabled: true,
    autoInject: options.memory?.autoInject ?? true,
    repoPath: options.memory?.repoPath || options.cwd || process.cwd(),
  }
}

export interface ParsedIssueCommand {
  action: string
  input: string
  maxIterations?: number
  passingScore?: number
  requiredGates?: string[]
}

export interface ParsedCliArgs {
  prompt: string
  options: AgentOptions
  json: boolean
  help: boolean
  command?: 'issue'
  issue?: ParsedIssueCommand
}

export interface IssueCommandOptions {
  dir?: string
  runtimeNamespace?: string
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedCliArgs {
  const options: AgentOptions = {
    selfImprovement: envFlagEnabled(env.CLAVUE_AGENT_SELF_IMPROVEMENT) || undefined,
    autonomyMode: env.CLAVUE_AGENT_AUTONOMY ? readAutonomyMode(env.CLAVUE_AGENT_AUTONOMY) : undefined,
    permissionMode: env.CLAVUE_AGENT_PERMISSION_MODE ? readPermissionMode(env.CLAVUE_AGENT_PERMISSION_MODE) : undefined,
  }
  const promptParts: string[] = []
  let json = false
  let help = false
  let issue: ParsedIssueCommand | undefined

  if (argv[0] === 'issue') {
    const action = argv[1]
    if (!action) throw new Error('Missing issue subcommand')
    issue = { action, input: '' }
    argv = argv.slice(2)
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '-p':
      case '--prompt':
        promptParts.push(readValue(argv, i, arg))
        i++
        break
      case '-m':
      case '--model':
        options.model = readValue(argv, i, arg)
        i++
        break
      case '--api-type':
        options.apiType = readApiType(readValue(argv, i, arg))
        i++
        break
      case '--api-key':
        options.apiKey = readValue(argv, i, arg)
        i++
        break
      case '--base-url':
        options.baseURL = readValue(argv, i, arg)
        i++
        break
      case '--cwd':
        options.cwd = readValue(argv, i, arg)
        i++
        break
      case '--max-turns': {
        options.maxTurns = readPositiveInteger(readValue(argv, i, arg), arg)
        i++
        break
      }
      case '--autonomy':
        options.autonomyMode = readAutonomyMode(readValue(argv, i, arg))
        i++
        break
      case '--permission-mode':
        options.permissionMode = readPermissionMode(readValue(argv, i, arg))
        i++
        break
      case '--allow':
        options.allowedTools = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
        break
      case '--toolset':
        options.toolsets = readToolsets(readValue(argv, i, arg))
        i++
        break
      case '--deny':
        options.disallowedTools = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
        break
      case '--max-iterations':
        if (!issue) throw new Error('Unknown option: --max-iterations')
        issue.maxIterations = readPositiveInteger(readValue(argv, i, arg), arg)
        i++
        break
      case '--passing-score':
        if (!issue) throw new Error('Unknown option: --passing-score')
        issue.passingScore = readPositiveInteger(readValue(argv, i, arg), arg)
        i++
        break
      case '--require-gate':
        if (!issue) throw new Error('Unknown option: --require-gate')
        issue.requiredGates = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
        break
      case '--self-improvement':
        options.selfImprovement = true
        break
      case '--json':
        json = true
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        promptParts.push(arg)
        break
    }
  }

  applySelfImprovementDefaults(options)

  const prompt = promptParts.join(' ').trim()
  if (issue) issue.input = prompt

  return {
    prompt: issue ? '' : prompt,
    options,
    json,
    help,
    command: issue ? 'issue' : undefined,
    issue,
  }
}

async function readIssueInput(input: string): Promise<{ content: string; path?: string }> {
  try {
    return { content: await readFile(input, 'utf-8'), path: input }
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENAMETOOLONG') return { content: input }
    throw error
  }
}

function requireIssueInput(parsed: ParsedCliArgs): string {
  const input = parsed.issue?.input.trim()
  if (!input) throw new Error(`issue ${parsed.issue?.action || ''} requires an input`)
  return input
}

export async function handleIssueCommand(
  parsed: ParsedCliArgs,
  options?: IssueCommandOptions,
): Promise<any> {
  if (!parsed.issue) throw new Error('Missing issue command')

  switch (parsed.issue.action) {
    case 'run': {
      const input = await readIssueInput(requireIssueInput(parsed))
      const issue = normalizeIssueInput(input.content, input.path ? { type: 'local-file', path: input.path } : { type: 'inline' })
      return createIssueWorkflowRun({
        issue,
        cwd: parsed.options.cwd || process.cwd(),
        requiredGates: parsed.issue.requiredGates,
        passingScore: parsed.issue.passingScore,
      }, options)
    }
    case 'execute': {
      const input = await readIssueInput(requireIssueInput(parsed))
      const issue = normalizeIssueInput(input.content, input.path ? { type: 'local-file', path: input.path } : { type: 'inline' })
      const result = await runIssueWorkflow({
        issue,
        cwd: parsed.options.cwd || process.cwd(),
        requiredGates: parsed.issue.requiredGates,
        passingScore: parsed.issue.passingScore,
        maxIterations: parsed.issue.maxIterations,
      }, options)
      return {
        ...result,
        workspace: result.run.workspace,
        errors: result.run.errors,
      }
    }
    case 'list':
      return listIssueWorkflowRuns(options)
    case 'get': {
      const run = await loadIssueWorkflowRun(requireIssueInput(parsed), options)
      if (!run) throw new Error(`Issue workflow run not found: ${parsed.issue.input}`)
      return run
    }
    case 'replay':
      throw new Error('issue replay requires an external runner and is not available from the local CLI yet')
    case 'stop': {
      const run = await stopIssueWorkflowRun(requireIssueInput(parsed), 'cli stop', options)
      if (!run) throw new Error(`Issue workflow run not found: ${parsed.issue.input}`)
      return run
    }
    default:
      throw new Error(`Unknown issue subcommand: ${parsed.issue.action}`)
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.command === 'issue') {
    const result = await handleIssueCommand(parsed)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (parsed.help || !parsed.prompt) {
    printHelp()
    process.exitCode = parsed.help ? 0 : 1
    return
  }

  if (parsed.json || parsed.options.selfImprovement) {
    const result = await run({ prompt: parsed.prompt, options: parsed.options })
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.text) console.log(result.text)
      const savedCount = result.self_improvement?.savedMemories.length ?? 0
      console.error(`[self-improvement] saved ${savedCount} improvement memor${savedCount === 1 ? 'y' : 'ies'}`)
      if (result.self_improvement?.errors?.length) {
        console.error(`[self-improvement] ${result.self_improvement.errors.join('; ')}`)
      }
    }
    process.exitCode = result.status === 'completed' ? 0 : 1
    return
  }

  for await (const event of query({ prompt: parsed.prompt, options: parsed.options })) {
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          console.error(`[tool] ${block.name}`)
        } else if (block.type === 'text') {
          process.stdout.write(block.text)
          if (!block.text.endsWith('\n')) process.stdout.write('\n')
        } else if (block.type === 'image') {
          process.stdout.write(formatImageBlockForText(block))
          process.stdout.write('\n')
        }
      }
    } else if (event.type === 'result' && event.is_error) {
      console.error(`Run ended with ${event.subtype}`)
      process.exitCode = 1
    }
  }
}

function isDirectCliExecution(): boolean {
  if (!process.argv[1]) return false

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isDirectCliExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
