import { renderIssueCommandTemplate } from '@/lib/new-workspace'

export function buildFullCreationIssueCommand(args: {
  enabled: boolean
  trustDecision: 'run' | 'skip'
  template: string
  issueNumber: number | null | undefined
  artifactUrl: string | null | undefined
}): { command: string } | undefined {
  if (!args.enabled || args.trustDecision !== 'run') {
    return undefined
  }
  return {
    command: renderIssueCommandTemplate(args.template, {
      issueNumber: args.issueNumber ?? null,
      artifactUrl: args.artifactUrl ?? null
    })
  }
}
