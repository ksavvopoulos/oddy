import type { ChatMessage } from '../types';

/** Runtime facts, not a model inference from conversation history or a failed request. */
export function withToolAvailability(
  messages: ChatMessage[],
  enabledTools: string[],
  unavailableReason?: string
): ChatMessage[] {
  const instruction =
    `Extension tool availability (authoritative for THIS request): ${JSON.stringify({ enabledTools, unavailableReason })}. ` +
    'Only the listed tools are enabled. This current manifest supersedes earlier assistant claims about availability. ' +
    'A failed tool call is an execution/validation error, NOT evidence that tools disappeared. Report the specific error and affected target; never infer that unrelated solutions are invalid. ' +
    'When no Dataverse tools are enabled, explain the supplied reason, not that schema creation is unsupported in general. ' +
    'Retain the user’s already confirmed solution display name, table name, ownership, fields, and defaults from conversation context; ask only unresolved questions. Never silently replace lookup GUID references with text or date-time instants with date-only fields.';
  const copy = messages.map((message) => ({ ...message }));
  if (copy[0]?.role === 'system') copy[0].content += '\n\n' + instruction;
  else copy.unshift({ role: 'system', content: instruction });
  return copy;
}
