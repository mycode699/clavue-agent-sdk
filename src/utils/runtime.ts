export const DEFAULT_RUNTIME_NAMESPACE = 'default'

export interface RuntimeNamespaceContext {
  runtimeNamespace?: string
}

export function getRuntimeNamespace(context?: RuntimeNamespaceContext): string {
  return context?.runtimeNamespace || DEFAULT_RUNTIME_NAMESPACE
}
