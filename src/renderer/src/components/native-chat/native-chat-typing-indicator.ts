import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export function shouldShowNativeChatTypingIndicator(args: {
  messages: readonly NativeChatMessage[]
  isWorking: boolean
}): boolean {
  // Keep one fixed-height status row for the entire turn. Established agent
  // chats leave that status beside streamed prose and tool activity; removing
  // a placeholder when the first assistant chunk arrives makes the transcript
  // visibly jump.
  return args.isWorking
}
