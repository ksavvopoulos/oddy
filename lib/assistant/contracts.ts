import type { DataversePrimitiveResult } from '../dataverse-primitives';
import type { NavigationResult } from '../browser/navigation';
import type { OddySkill, PreparedOddySkillChange } from '../types';
import type { BulkJobSummary, BulkDatasetSummary } from '../bulk/contracts';

export interface BulkToolResult {
  ok: boolean;
  action: 'prepare_bulk_job' | 'prepare_bulk_job_remaining' | 'get_bulk_job' | 'list_bulk_datasets';
  job?: BulkJobSummary;
  datasets?: BulkDatasetSummary[];
  error?: string;
}

export interface OddySkillToolResult {
  ok: boolean;
  action: 'list_skills' | 'get_skill' | 'prepare_skill_change';
  skills?: Array<Pick<OddySkill, 'id' | 'name' | 'description' | 'version' | 'enabled'>>;
  skill?: OddySkill;
  revision?: string;
  change?: PreparedOddySkillChange;
  error?: string;
}

export type AssistantToolResult =
  DataversePrimitiveResult | NavigationResult | OddySkillToolResult | BulkToolResult;
