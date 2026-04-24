import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import type { RetroEvaluator, RetroFinding, RetroRunInput } from './types.js'

type PackageJsonShape = {
  name?: string
  main?: string
  types?: string
  exports?: unknown
  scripts?: Record<string, string>
  files?: string[]
  prepack?: string
  prepare?: string
  prepublishOnly?: string
}

type ProjectSnapshot = {
  cwd: string
  targetName: string
  packageJson?: PackageJsonShape
  packageJsonError?: string
  hasReadme: boolean
  readmeText: string
  declaredEntrypoints: string[]
  missingEntrypoints: string[]
  hasBuildScript: boolean
  hasTestScript: boolean
  hasPublishBuildHook: boolean
  hasDistFilesWhitelist: boolean
  hasInstallDocs: boolean
  hasImportDocs: boolean
  hasTestFiles: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function normalizePath(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

function collectEntrypoints(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') {
    paths.add(normalizePath(value))
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  for (const nestedValue of Object.values(value)) {
    collectEntrypoints(nestedValue, paths)
  }
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function detectTestFiles(cwd: string): Promise<boolean> {
  for (const directory of ['tests', 'test', '__tests__']) {
    const dirPath = join(cwd, directory)
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      if (
        entries.some(
          (entry) =>
            entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
        )
      ) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}

async function loadProjectSnapshot(input: RetroRunInput): Promise<ProjectSnapshot> {
  const cwd = input.target.cwd ?? process.cwd()
  const targetName = input.target.name
  const packageJsonPath = join(cwd, 'package.json')
  const readmePath = join(cwd, 'README.md')
  const readmeText = await readOptionalFile(readmePath)
  const hasReadme = readmeText.length > 0
  const packageJsonText = await readOptionalFile(packageJsonPath)
  const hasTestFiles = await detectTestFiles(cwd)

  if (!packageJsonText) {
    return {
      cwd,
      targetName,
      hasReadme,
      readmeText,
      declaredEntrypoints: [],
      missingEntrypoints: [],
      hasBuildScript: false,
      hasTestScript: false,
      hasPublishBuildHook: false,
      hasDistFilesWhitelist: false,
      hasInstallDocs: /\bnpm\s+(install|i)\b/.test(readmeText),
      hasImportDocs: false,
      hasTestFiles,
    }
  }

  try {
    const packageJson = JSON.parse(packageJsonText) as PackageJsonShape
    const declaredEntrypoints = new Set<string>()
    collectEntrypoints(packageJson.main, declaredEntrypoints)
    collectEntrypoints(packageJson.types, declaredEntrypoints)
    collectEntrypoints(packageJson.exports, declaredEntrypoints)

    const missingEntrypoints: string[] = []
    for (const entrypoint of declaredEntrypoints) {
      if (!(await pathExists(join(cwd, entrypoint)))) {
        missingEntrypoints.push(entrypoint)
      }
    }

    const packageName = packageJson.name ?? targetName

    return {
      cwd,
      targetName,
      packageJson,
      hasReadme,
      readmeText,
      declaredEntrypoints: [...declaredEntrypoints],
      missingEntrypoints,
      hasBuildScript: typeof packageJson.scripts?.build === 'string',
      hasTestScript: typeof packageJson.scripts?.test === 'string',
      hasPublishBuildHook:
        typeof packageJson.scripts?.prepack === 'string' ||
        typeof packageJson.scripts?.prepare === 'string' ||
        typeof packageJson.scripts?.prepublishOnly === 'string',
      hasDistFilesWhitelist:
        Array.isArray(packageJson.files) && packageJson.files.some((entry) => entry === 'dist'),
      hasInstallDocs: /\bnpm\s+(install|i)\b/.test(readmeText),
      hasImportDocs:
        readmeText.includes(`from "${packageName}"`) ||
        readmeText.includes(`from '${packageName}'`) ||
        readmeText.includes(`require("${packageName}")`) ||
        readmeText.includes(`require('${packageName}')`),
      hasTestFiles,
    }
  } catch (error) {
    return {
      cwd,
      targetName,
      packageJsonError: error instanceof Error ? error.message : String(error),
      hasReadme,
      readmeText,
      declaredEntrypoints: [],
      missingEntrypoints: [],
      hasBuildScript: false,
      hasTestScript: false,
      hasPublishBuildHook: false,
      hasDistFilesWhitelist: false,
      hasInstallDocs: /\bnpm\s+(install|i)\b/.test(readmeText),
      hasImportDocs: false,
      hasTestFiles,
    }
  }
}

function createCompatibilityEvaluator(getSnapshot: (input: RetroRunInput) => Promise<ProjectSnapshot>): RetroEvaluator {
  return async (input) => {
    const snapshot = await getSnapshot(input)
    const findings: RetroFinding[] = []

    if (!snapshot.packageJson) {
      findings.push({
        dimension: 'compatibility',
        title: 'Package metadata is missing',
        rationale: 'package.json is required to publish and import the SDK consistently.',
        severity: 'critical',
        confidence: 'high',
        disposition: 'fix',
        evidence: [
          {
            kind: 'file',
            location: join(snapshot.cwd, 'package.json'),
            detail: 'No package.json was found for the retro target.',
          },
        ],
      })
      return { findings }
    }

    if (snapshot.packageJsonError) {
      findings.push({
        dimension: 'compatibility',
        title: 'Package metadata is invalid',
        rationale: 'Invalid package.json prevents consistent import and packaging behavior.',
        severity: 'critical',
        confidence: 'high',
        disposition: 'fix',
        evidence: [
          {
            kind: 'file',
            location: join(snapshot.cwd, 'package.json'),
            detail: snapshot.packageJsonError,
          },
        ],
      })
      return { findings }
    }

    if (snapshot.declaredEntrypoints.length === 0) {
      findings.push({
        dimension: 'compatibility',
        title: 'Import entrypoints are not declared',
        rationale: 'package.json should declare exports, main, or types so consumers can resolve the SDK reliably.',
        severity: 'high',
        confidence: 'high',
        disposition: 'fix',
        evidence: [
          {
            kind: 'file',
            location: join(snapshot.cwd, 'package.json'),
            detail: 'No exports/main/types entrypoints were declared.',
          },
        ],
      })
    } else if (snapshot.missingEntrypoints.length > 0) {
      findings.push({
        dimension: 'compatibility',
        title: 'Declared entrypoints are missing on disk',
        rationale: 'Consumers cannot import the SDK reliably when published entrypoints are absent from the package tree.',
        severity: 'high',
        confidence: 'high',
        disposition: 'fix',
        evidence: snapshot.missingEntrypoints.map((entrypoint) => ({
          kind: 'file' as const,
          location: join(snapshot.cwd, entrypoint),
          detail: 'Declared in package.json but not found on disk.',
        })),
      })
    }

    return { findings }
  }
}

function createStabilityEvaluator(getSnapshot: (input: RetroRunInput) => Promise<ProjectSnapshot>): RetroEvaluator {
  return async (input) => {
    const snapshot = await getSnapshot(input)
    const missingScripts: string[] = []
    if (!snapshot.hasBuildScript) missingScripts.push('build')
    if (!snapshot.hasTestScript) missingScripts.push('test')

    if (missingScripts.length === 0) {
      return { findings: [] }
    }

    return {
      findings: [
        {
          dimension: 'stability',
          title: 'Core verification scripts are incomplete',
          rationale: `The retro target is missing required scripts: ${missingScripts.join(', ')}.`,
          severity: 'high',
          confidence: 'high',
          disposition: 'fix',
          evidence: [
            {
              kind: 'file',
              location: join(snapshot.cwd, 'package.json'),
              detail: `Missing npm scripts: ${missingScripts.join(', ')}.`,
            },
          ],
        },
      ],
    }
  }
}

function createInteractionLogicEvaluator(getSnapshot: (input: RetroRunInput) => Promise<ProjectSnapshot>): RetroEvaluator {
  return async (input) => {
    const snapshot = await getSnapshot(input)

    if (!snapshot.hasReadme) {
      return {
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'README onboarding is missing',
            rationale: 'Users need a checked-in README to install and activate the SDK quickly.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'fix',
            evidence: [
              {
                kind: 'file',
                location: join(snapshot.cwd, 'README.md'),
                detail: 'README.md was not found.',
              },
            ],
          },
        ],
      }
    }

    const missingDocs: string[] = []
    if (!snapshot.hasInstallDocs) missingDocs.push('install')
    if (!snapshot.hasImportDocs) missingDocs.push('import')

    if (missingDocs.length === 0) {
      return { findings: [] }
    }

    return {
      findings: [
        {
          dimension: 'interaction_logic',
          title: 'README onboarding is incomplete',
          rationale: `The README is missing core onboarding guidance for: ${missingDocs.join(', ')}.`,
          severity: 'medium',
          confidence: 'high',
          disposition: 'fix',
          evidence: [
            {
              kind: 'doc',
              location: join(snapshot.cwd, 'README.md'),
              detail: `Missing README guidance: ${missingDocs.join(', ')}.`,
            },
          ],
        },
      ],
    }
  }
}

function createReliabilityEvaluator(getSnapshot: (input: RetroRunInput) => Promise<ProjectSnapshot>): RetroEvaluator {
  return async (input) => {
    const snapshot = await getSnapshot(input)
    const missingSafeguards: string[] = []

    if (!snapshot.hasPublishBuildHook) missingSafeguards.push('publish-time build hook')
    if (!snapshot.hasTestFiles) missingSafeguards.push('checked-in test files')
    if (!snapshot.hasDistFilesWhitelist) missingSafeguards.push('dist package whitelist')

    if (missingSafeguards.length === 0) {
      return { findings: [] }
    }

    return {
      findings: [
        {
          dimension: 'reliability',
          title: 'Release safeguards are incomplete',
          rationale: `The retro target is missing release safeguards: ${missingSafeguards.join(', ')}.`,
          severity: 'medium',
          confidence: 'medium',
          disposition: 'fix',
          evidence: [
            {
              kind: 'file',
              location: join(snapshot.cwd, 'package.json'),
              detail: `Missing safeguards: ${missingSafeguards.join(', ')}.`,
            },
          ],
        },
      ],
    }
  }
}

export function createDefaultRetroEvaluators(): RetroEvaluator[] {
  let snapshotPromise: Promise<ProjectSnapshot> | undefined
  const getSnapshot = (input: RetroRunInput) => {
    snapshotPromise ??= loadProjectSnapshot(input)
    return snapshotPromise
  }

  return [
    createCompatibilityEvaluator(getSnapshot),
    createStabilityEvaluator(getSnapshot),
    createInteractionLogicEvaluator(getSnapshot),
    createReliabilityEvaluator(getSnapshot),
  ]
}
