import { resolve, relative } from 'path'

export function resolveWorkspacePath(context: { cwd: string; workspaceRoot?: string }, inputPath: string): string | { data: string; is_error: true } {
  const workspaceRoot = resolve(context.workspaceRoot ?? context.cwd)
  const resolvedPath = resolve(context.cwd, inputPath)
  const relativePath = relative(workspaceRoot, resolvedPath)

  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes('..'))) {
    return resolvedPath
  }

  return {
    data: `Error: Path is outside the workspace root: ${resolvedPath}`,
    is_error: true,
  }
}
