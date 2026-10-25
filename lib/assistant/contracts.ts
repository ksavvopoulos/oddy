import type { DataversePrimitiveResult } from '../dataverse-primitives';
import type { NavigationResult } from '../browser/navigation';
import type { OddySkill, PreparedOddySkillChange } from '../types';

export interface OddySkillToolResult {
  ok: boolean;
  action: 'list_skills' | 'get_skill' | 'prepare_skill_change';
  skills?: Array<Pick<OddySkill, 'id' | 'name' | 'description' | 'version' | 'enabled'>>;
  skill?: OddySkill;
  revision?: string;
  change?: PreparedOddySkillChange;
  error?: string;
}

export type AssistantToolResult = DataversePrimitiveResult | NavigationResult | OddySkillToolResult;
