/**
 * Context pack and pipeline types.
 */

export type ContextPackSectionKind = 'date' | 'git' | 'project' | 'custom'

export interface ContextPackSection {
  kind: ContextPackSectionKind
  title: string
  content: string
  source?: string
}

export interface ContextPack {
  cwd: string
  created_at: string
  sections: ContextPackSection[]
}

export interface ContextPackOptions {
  includeDate?: boolean
  includeGit?: boolean
  includeProject?: boolean
  includeUser?: boolean
  now?: Date
}

export type ContextPipelineTransform = (pack: ContextPack) => ContextPack | Promise<ContextPack>

export interface ContextPipeline {
  use(transform: ContextPipelineTransform): ContextPipeline
  run(cwd: string, options?: ContextPackOptions): Promise<ContextPack>
}
